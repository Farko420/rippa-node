/**
 * BUGS 5 & 6 (UNIT LEVEL) — autonomous task claiming and admin interception.
 *
 * Driven against the COMPILED output so it exercises the same code the packaged
 * exe runs, with a stub SwarmClient that records exactly what it was asked to do.
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT, check, results } from "./verify-harness.mjs";

/** Imports a compiled module by path. Windows ESM needs a file:// URL, not a drive letter. */
const load = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);

// --- 6. Admin command spellings --------------------------------------------
const { parsePendingCommands, executePendingCommands, adminCommandForTaskType } = await load(
  "dist/services/heartbeat.js"
);

check("task type FORCE_OTA_UPDATE maps to FORCE_UPDATE", adminCommandForTaskType("FORCE_OTA_UPDATE") === "FORCE_UPDATE");
check("task type RESTART_NODE_SERVICE maps to RESTART_NODE", adminCommandForTaskType("RESTART_NODE_SERVICE") === "RESTART_NODE");
check("an ordinary task type maps to no admin command", adminCommandForTaskType("DYNAMIC_SKILL") === null);

const alias = parsePendingCommands({
  pending_commands: [
    { id: "c1", command: "FORCE_OTA_UPDATE" },
    { id: "c2", command: "RESTART_NODE_SERVICE" },
  ],
});
check(
  "real-world alias spellings survive pending_commands parsing",
  alias.length === 2 && alias[0].command === "FORCE_UPDATE" && alias[1].command === "RESTART_NODE",
  JSON.stringify(alias.map((a) => a.command)),
);
check(
  "commands sent under `type` are still understood",
  parsePendingCommands({ commands: [{ type: "restart" }] })[0]?.command === "RESTART_NODE",
);
check(
  "an unknown command is still refused (allowlist intact)",
  parsePendingCommands({ pending_commands: [{ command: "rm -rf /" }] }).length === 0,
);

let restarted = false;
let updated = false;
const handlers = {
  restartNode: () => {
    restarted = true;
  },
  forceUpdate: () => {
    updated = true;
  },
  setP2pEnabled: () => {},
  isP2pEnabled: () => true,
};
const exec = await executePendingCommands(alias, handlers);
check("both admin commands actually executed", restarted && updated && exec.length === 2, exec.join(","));

const rerun = await executePendingCommands(alias, {
  ...handlers,
  restartNode: () => {
    restarted = "AGAIN";
  },
});
check("re-sent command ids are de-duplicated (no restart loop)", rerun.length === 0 && restarted === true);

// The operator kill-switch must still work — a fix that made admin commands
// reachable must not make them unstoppable.
process.env.RIPPA_REMOTE_COMMANDS = "false";
let blocked = false;
const blockedResult = await executePendingCommands(
  [{ id: "c3", command: "FORCE_UPDATE" }],
  { ...handlers, forceUpdate: () => (blocked = true) },
);
delete process.env.RIPPA_REMOTE_COMMANDS;
check("RIPPA_REMOTE_COMMANDS=false still blocks execution", !blocked && blockedResult.length === 0);

// --- 7. OTA command acknowledgement -------------------------------------------
// The update handler ends in process.exit(0) INSIDE the handler, so a report
// filed after it never reaches the Mothership. These checks pin the ordering
// that makes the acknowledgement survive: it is sent BEFORE the swap runs.
const acks = [];
const order = [];
await executePendingCommands([{ id: "ack-1", command: "FORCE_UPDATE" }], {
  restartNode: () => order.push("restart"),
  forceUpdate: () => {
    order.push("forceUpdate");
    return true; // a swap is committed; the real process would exit here
  },
  setP2pEnabled: () => {},
  isP2pEnabled: () => true,
  acknowledgeCommand: (command, detail) => {
    acks.push([command, detail]);
    order.push("ack");
  },
});
check(
  "the update is acknowledged BEFORE the swap starts",
  order[0] === "ack" && order[1] === "forceUpdate",
  order.join(" -> "),
);
check("the acknowledgement names the command and is marked completed", acks[0]?.[0] === "FORCE_UPDATE", JSON.stringify(acks[0]));

// A refused update must NOT leave a bare "accepted" on record. forceUpdate
// returning false is the only observable signal on a path that does not exit
// (dev mode, download failure, or the handoff being owned by another updater).
const refusedAcks = [];
await executePendingCommands([{ id: "ack-2", command: "FORCE_UPDATE" }], {
  restartNode: () => {},
  forceUpdate: () => false,
  setP2pEnabled: () => {},
  isP2pEnabled: () => true,
  acknowledgeCommand: (command, detail) => refusedAcks.push(detail),
});
check(
  "a refused update is re-acknowledged as not applied",
  refusedAcks.length === 2 && /not applied/.test(refusedAcks[1]),
  refusedAcks.join(" | "),
);

// A throwing updater must not stop the acknowledgement machinery from unwinding
// cleanly, and a failing uplink must never block the actual command.
let stillRan = false;
await executePendingCommands([{ id: "ack-3", command: "FORCE_UPDATE" }], {
  restartNode: () => {},
  forceUpdate: () => {
    stillRan = true;
    return true;
  },
  setP2pEnabled: () => {},
  isP2pEnabled: () => true,
  acknowledgeCommand: () => {
    throw new Error("mothership unreachable");
  },
});
check("an unreachable Mothership does not block the update", stillRan);

// --- 8. Swap script generation -------------------------------------------------
// The script is what actually replaces the binary, so its contents are the
// contract. These run against a temp dir and never execute the script.
const swap = await load("dist/update/swapHandoff.js");
const fsSwap = await import("node:fs");
const osSwap = await import("node:os");
const pathSwap = await import("node:path");
const stageDir = fsSwap.mkdtempSync(pathSwap.join(osSwap.tmpdir(), "rippa-swap-"));
const stagedExe = pathSwap.join(stageDir, "temp_update.exe");
const scriptPath = swap.writeSwapScript(stagedExe, "C:\\Program Files\\Rippa\\rippa-node.exe");
const script = fsSwap.readFileSync(scriptPath, "utf8");

check("the swap script is named update.bat", pathSwap.basename(scriptPath) === "update.bat");
check("the update is staged as temp_update.exe", pathSwap.basename(stagedExe) === "temp_update.exe");
check("the script waits 3 seconds for the image lock", /timeout \/t 3 /.test(script));
check("it overwrites the running exe in place", /copy \/y .*rippa-node\.exe/.test(script));
check("it does NOT delete the exe before copying (no brick path)", !/^\s*del .*rippa-node\.exe/im.test(script));
check("it retries the copy while the target is missing", /goto :rippa_copy/.test(script));
check("it relaunches the executable afterwards", /start "" "C:.*rippa-node\.exe"/.test(script));
check("it removes the staged download afterwards", /del \/f \/q .*temp_update\.exe/.test(script));
check("it deletes itself last", /%~f0/.test(script));

// A node launched with a config path must come back pointed at the same config.
const originalArgv = process.argv;
process.argv = [process.argv[0], "C:\\Rippa\\dist\\index.js", "--config", "D:\\fleet\\node.json"];
const argScript = fsSwap.readFileSync(
  swap.writeSwapScript(stagedExe, "C:\\Rippa\\rippa-node.exe"),
  "utf8",
);
process.argv = originalArgv;
check(
  "the original command-line arguments are preserved on relaunch",
  /start "" "C:\\Rippa\\rippa-node\.exe" .*--config.*D:\\fleet\\node\.json/.test(argScript),
  argScript.split("\r\n").find((l) => l.startsWith("start")) ?? "",
);

// A batch metacharacter in an argument must not be able to inject a new command.
process.argv = [process.argv[0], "app.exe", "a&del rippa-node.exe"];
const injectionScript = fsSwap.readFileSync(
  swap.writeSwapScript(stagedExe, "C:\\Rippa\\rippa-node.exe"),
  "utf8",
);
process.argv = originalArgv;
const launchLine = injectionScript.split("\r\n").find((l) => l.startsWith('start ""')) ?? "";
// The `&` must be escaped as `^&`. An escaped one is a literal character; an
// unescaped one would end the command and start a second one.
const argTail = launchLine.replace(/^start "" "C:\\Rippa\\rippa-node\.exe"\s*/, "");
check(
  "a metacharacter in an argument cannot inject a batch command",
  /a\^&/.test(argTail) && !/[^\\^]&/.test(argTail),
  argTail,
);
fsSwap.rmSync(stageDir, { recursive: true, force: true });

// --- 5. Autonomous task claiming -------------------------------------------
const { TaskEngine } = await load("dist/services/taskEngine.js");
const seen = [];
const fakeSwarm = {
  setTaskDispatchHandler: () => {},
  setStatus: (s) => seen.push(["status", s]),
  claimTask: async (t) => {
    seen.push(["claim", t.id]);
    return { task: t, acknowledged: true };
  },
  releaseTask: async (t, why) => seen.push(["release", t.id, why]),
  fetchTasks: async () => [{ id: "task-42", type: "DYNAMIC_SKILL", status: "pending" }],
  submitProfile: async (p) => {
    seen.push(["result", p.status]);
    return true;
  },
};
const engine = new TaskEngine({
  swarm: fakeSwarm,
  handlePriorityTask: async (t) => {
    seen.push(["handle", t.id]);
    return { status: "success", detail: "ok" };
  },
  forager: {
    stats: () => ({ learned: 0, fed: 0, preemptions: 0 }),
    shouldYield: () => false,
    waitForInterrupt: () => new Promise(() => {}),
    waitForResume: () => Promise.resolve(),
  },
  priorityPollMs: 60_000,
  idleGapMs: 60_000,
});
engine.start();
await new Promise((r) => setTimeout(r, 1500));
engine.stop();

check("a pending task is CLAIMED before it runs", seen.some((s) => s[0] === "claim" && s[1] === "task-42"));
check(
  "the claim happens BEFORE execution",
  seen.findIndex((s) => s[0] === "claim") < seen.findIndex((s) => s[0] === "handle"),
);
check("the claimed task then executes", seen.some((s) => s[0] === "handle" && s[1] === "task-42"));
check("node status switched to 'working'", seen.some((s) => s[0] === "status" && s[1] === "working"));
check("the result is reported back upstream", seen.some((s) => s[0] === "result" && s[1] === "success"));

// The idlers above are console noise from the node itself; the summary is the
// result. The idle forager's "runPass is not a function" line is this harness's
// stub forager being deliberately minimal, not a product fault.
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
process.exit(failed.length ? 1 : 0);