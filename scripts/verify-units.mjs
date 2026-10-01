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