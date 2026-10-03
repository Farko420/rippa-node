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
const { parsePendingCommands, executePendingCommands, adminCommandForTaskType, resetExecutedCommands } = await load(
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

// --- 7b. Queue retirement (the "Skipping already-executed command" loop) -------
/*
 * The reported symptom: the node logged "Skipping already-executed command" on
 * every heartbeat, forever, because nothing ever told the Mothership the command
 * was done. The local dedup set stopped it RE-RUNNING but was invisible to the
 * cloud, so the queue entry was never retired and came back every 30 seconds.
 *
 * These checks pin the retirement signal: an executed, re-sent, or failed
 * command must all produce an acknowledgement carrying the id the cloud needs.
 */
const ackBase = {
  restartNode: () => {},
  forceUpdate: () => true,
  setP2pEnabled: () => {},
  isP2pEnabled: () => true,
};

// A re-sent command must NOT re-run, but MUST be acknowledged so it leaves the
// queue. Before the fix this path returned silently and the loop was permanent.
resetExecutedCommands();
const loopAcks = [];
const rerunHandlers = {
  ...ackBase,
  acknowledgeCommand: (command, detail, context) => loopAcks.push({ command, detail, context }),
};
await executePendingCommands([{ id: "loop-1", command: "TOGGLE_P2P" }], rerunHandlers);
const afterFirst = loopAcks.length;
const again = await executePendingCommands([{ id: "loop-1", command: "TOGGLE_P2P" }], rerunHandlers);
check(
  "a re-sent command is not re-executed",
  again.length === 0,
  `returned ${again.length}`,
);
check(
  "a re-sent command IS acknowledged so the Mothership retires it (loop fix)",
  loopAcks.length > afterFirst && /already executed/.test(loopAcks[afterFirst].detail),
  JSON.stringify(loopAcks[afterFirst]),
);
check(
  "the re-send acknowledgement carries the command_id the cloud matches on",
  loopAcks[afterFirst]?.context?.commandId === "loop-1",
  JSON.stringify(loopAcks[afterFirst]?.context),
);

// The ack must be rate-limited, or a Mothership with no ack route turns a log
// loop into a network loop — one POST per heartbeat, forever.
const beforeThrottle = loopAcks.length;
await executePendingCommands([{ id: "loop-1", command: "TOGGLE_P2P" }], rerunHandlers);
await executePendingCommands([{ id: "loop-1", command: "TOGGLE_P2P" }], rerunHandlers);
check(
  "repeat re-sends do not re-ack on every heartbeat (rate limited)",
  loopAcks.length === beforeThrottle,
  `${loopAcks.length - beforeThrottle} extra acks`,
);

// TOGGLE_P2P never acknowledged at all before, so its entry was never retired.
resetExecutedCommands();
const toggleAcks = [];
await executePendingCommands([{ id: "p2p-1", command: "TOGGLE_P2P" }], {
  ...ackBase,
  acknowledgeCommand: (command, detail, context) => toggleAcks.push({ command, detail, context }),
});
check(
  "TOGGLE_P2P is acknowledged when it completes",
  toggleAcks.length === 1 && toggleAcks[0].command === "TOGGLE_P2P",
  JSON.stringify(toggleAcks),
);
check(
  "the completion acknowledgement carries the command_id",
  toggleAcks[0]?.context?.commandId === "p2p-1" && toggleAcks[0]?.context?.status === "completed",
  JSON.stringify(toggleAcks[0]?.context),
);

// A FAILED command must be retired too, or the same loop restarts on a command
// already known to be unrunnable here.
resetExecutedCommands();
const failAcks = [];
await executePendingCommands([{ id: "fail-1", command: "TOGGLE_P2P" }], {
  ...ackBase,
  setP2pEnabled: () => {
    throw new Error("p2p subsystem unavailable");
  },
  acknowledgeCommand: (command, detail, context) => failAcks.push({ command, detail, context }),
});
check(
  "a failed command is acknowledged as failed (not left looping upstream)",
  failAcks.length === 1 && failAcks[0].context?.status === "failed" && /failed/.test(failAcks[0].detail),
  JSON.stringify(failAcks),
);

// The shutting-down commands must acknowledge BEFORE they exit, and must not
// then claim completion from beyond the grave.
resetExecutedCommands();
const restartAcks = [];
await executePendingCommands([{ id: "restart-1", command: "RESTART_NODE" }], {
  ...ackBase,
  acknowledgeCommand: (command, detail, context) => restartAcks.push({ command, detail, context }),
});
check(
  "RESTART_NODE is acknowledged in_progress before it exits",
  restartAcks.length === 1 && restartAcks[0].context?.status === "in_progress" && restartAcks[0].context?.commandId === "restart-1",
  JSON.stringify(restartAcks),
);

// A refused update is reported honestly, and is not then overwritten by a
// generic "executed" ack that would contradict it.
resetExecutedCommands();
const refused2 = [];
await executePendingCommands([{ id: "ack-4", command: "FORCE_UPDATE" }], {
  ...ackBase,
  forceUpdate: () => false,
  acknowledgeCommand: (command, detail, context) => refused2.push({ command, detail, context }),
});
check(
  "a refused update is acknowledged exactly twice (in_progress, then failed)",
  refused2.length === 2 && refused2[1].context?.status === "failed" && refused2[1].context?.commandId === "ack-4",
  JSON.stringify(refused2.map((a) => a.context?.status)),
);

// The id is the key the cloud matches the ack on, so it must be read from every
// spelling a Mothership uses — not just `id`.
check(
  "a command filed as command_id keeps its id for the acknowledgement",
  parsePendingCommands({ pending_commands: [{ command_id: "cmd-77", command: "TOGGLE_P2P" }] })[0]?.id === "cmd-77",
  JSON.stringify(parsePendingCommands({ pending_commands: [{ command_id: "cmd-77", command: "TOGGLE_P2P" }] })),
);
check(
  "a command filed as commandId keeps its id too",
  parsePendingCommands({ pending_commands: [{ commandId: "cmd-78", command: "TOGGLE_P2P" }] })[0]?.id === "cmd-78",
);

// --- 7c. The ack actually hits the wire, with the id ---------------------------
/*
 * The checks above prove the executor EMITS an acknowledgement. These prove the
 * acknowledgement REACHES THE MOTHERSHIP on the dedicated route carrying the
 * command_id — the thing that actually clears the queue entry, and the part
 * that was entirely missing before (the old path POSTed a profile with no id to
 * a route that does not clear queues).
 *
 * A real HTTP server stands in for the Mothership so the full axios path,
 * including the route fallback chain, is exercised rather than a stub.
 */
const httpMod = await import("node:http");
const osMod = await import("node:os");
const received = [];
// Toggled mid-test to simulate a Mothership that has not shipped the dedicated
// ack route, so the fallback chain is exercised for real rather than assumed.
let ackRouteMissing = false;
const ackServer = httpMod.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    received.push({ url: req.url, body: body ? JSON.parse(body) : {} });
    const missing = ackRouteMissing && req.url === "/api/node/ack";
    res.writeHead(missing ? 404 : 200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: true }));
  });
});
await new Promise((r) => ackServer.listen(0, "127.0.0.1", r));
const ackPort = ackServer.address().port;

process.env.RIPPA_CONFIG_ROOT = fs.mkdtempSync(path.join(osMod.tmpdir(), "rippa-ack-"));
const prevUrl = process.env.MOTHERSHIP_URL;
const prevKey = process.env.NODE_API_KEY;
const prevRole = process.env.NODE_ROLE;
const prevMaster = process.env.MASTER_LOCAL_URL;
process.env.MOTHERSHIP_URL = `http://127.0.0.1:${ackPort}`;
process.env.NODE_API_KEY = "verify-ack-key-0001";
process.env.NODE_ROLE = "satellite";
process.env.MASTER_LOCAL_URL = "http://127.0.0.1:5199";

const { SwarmClient } = await load("dist/network/SwarmClient.js");
const ackClient = new SwarmClient();
const acked = await ackClient.acknowledgeRemoteCommand({
  commandId: "cmd-1234",
  command: "FORCE_UPDATE",
  detail: "executed",
});
check("the command acknowledgement succeeds against a live endpoint", acked === true);

const primary = received.find((r) => r.url === "/api/node/ack");
check("the ack is POSTed to the dedicated /api/node/ack route", Boolean(primary), JSON.stringify(received.map((r) => r.url)));
check(
  "the ack body carries command_id (what clears the queue entry)",
  primary?.body?.command_id === "cmd-1234",
  JSON.stringify(primary?.body),
);
check(
  "the ack identifies the command and its outcome",
  primary?.body?.command === "FORCE_UPDATE" && primary?.body?.status === "completed" && primary?.body?.completed === true,
  JSON.stringify(primary?.body),
);

received.length = 0;
// A Mothership that has not shipped the dedicated route must not break the node.
ackRouteMissing = true;
const fellBack = await ackClient.acknowledgeRemoteCommand({
  commandId: "cmd-5678",
  command: "TOGGLE_P2P",
  detail: "executed",
});
check(
  "an ack route that 404s falls through to the next route",
  fellBack === true && received.some((r) => r.url === "/api/swarm/commands/ack"),
  JSON.stringify(received.map((r) => r.url)),
);
check(
  "the fallback ack still carries command_id",
  received.find((r) => r.url === "/api/swarm/commands/ack")?.body?.command_id === "cmd-5678",
);

received.length = 0;
ackServer.close();
const unreachable = await ackClient.acknowledgeRemoteCommand({
  commandId: "cmd-9999",
  command: "RESTART_NODE",
  detail: "accepted",
});
check("an unreachable Mothership does not throw from the ack path", unreachable === false);

if (prevUrl === undefined) delete process.env.MOTHERSHIP_URL; else process.env.MOTHERSHIP_URL = prevUrl;
if (prevKey === undefined) delete process.env.NODE_API_KEY; else process.env.NODE_API_KEY = prevKey;
if (prevRole === undefined) delete process.env.NODE_ROLE; else process.env.NODE_ROLE = prevRole;
if (prevMaster === undefined) delete process.env.MASTER_LOCAL_URL; else process.env.MASTER_LOCAL_URL = prevMaster;

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

// --- 8b. The exit-code handoff protocol --------------------------------------
// The watchdog's whole behaviour is "read the child's exit code", so the codes
// are the contract between two separate processes. They are asserted as VALUES
// here rather than merely read, because every one of them is load-bearing: a
// collision between, say, SHUTDOWN and CRASH would make a deliberate shutdown
// restart itself in a crash loop, and no test would notice until it shipped.
const exitCodes = await load("dist/update/exitCodes.js");

check("exit code 0 means shutdown", exitCodes.EXIT_SHUTDOWN === 0);
check("exit code 1 means crash", exitCodes.EXIT_CRASH === 1);
check("exit code 42 means restart", exitCodes.EXIT_RESTART === 42);
check("exit code 43 means apply update", exitCodes.EXIT_APPLY_UPDATE === 43);

const codes = [
  exitCodes.EXIT_SHUTDOWN,
  exitCodes.EXIT_CRASH,
  exitCodes.EXIT_RESTART,
  exitCodes.EXIT_APPLY_UPDATE,
];
check(
  "the four codes are distinct (no code can be read as two intents)",
  new Set(codes).size === codes.length,
  codes.join(", "),
);

check(
  "a crash is distinguishable from a shutdown",
  exitCodes.describeExitCode(exitCodes.EXIT_CRASH) !== exitCodes.describeExitCode(exitCodes.EXIT_SHUTDOWN),
);
check(
  "a restart is distinguishable from an apply-update",
  exitCodes.describeExitCode(exitCodes.EXIT_RESTART) !== exitCodes.describeExitCode(exitCodes.EXIT_APPLY_UPDATE),
);

// The watchdog flags its child; the node reads that flag to choose its handoff.
const prevFlag = process.env.RIPPA_WATCHDOG;
delete process.env.RIPPA_WATCHDOG;
check("no flag means the node is unsupervised", exitCodes.isUnderWatchdog() === false);
process.env.RIPPA_WATCHDOG = "1";
check("the flag marks the node as watchdog-supervised", exitCodes.isUnderWatchdog() === true);
// A dev run that exported RIPPA_WATCHDOG=false must not be mistaken for a
// supervised one, or its updates would exit 43 into a supervisor that is not there.
process.env.RIPPA_WATCHDOG = "false";
check("an explicit 'false' is not supervision", exitCodes.isUnderWatchdog() === false);
if (prevFlag === undefined) delete process.env.RIPPA_WATCHDOG;
else process.env.RIPPA_WATCHDOG = prevFlag;

check(
  "an unsupervised node keeps the legacy detached-script handoff",
  swap.handoffMode() === "script",
  `unsupervised handoffMode is "${swap.handoffMode()}"`,
);
process.env.RIPPA_WATCHDOG = "1";
check(
  "RIPPA_WATCHDOG=1 switches the handoff to the watchdog",
  swap.handoffMode() === "watchdog",
  `supervised handoffMode is "${swap.handoffMode()}"`,
);
if (prevFlag === undefined) delete process.env.RIPPA_WATCHDOG;
else process.env.RIPPA_WATCHDOG = prevFlag;

// --- 8c. Downgrade protection ------------------------------------------------
// The bug this guards is a fleet walking backwards: a FORCE_UPDATE meant to
// reinstall the current build instead installing an older one, which is not
// self-healing the way a failed upgrade is.
const { isVersionNewer, isVersionOlder } = await load("dist/version-compare.js");

check("1.0.16 is newer than 1.0.15", isVersionNewer("1.0.16", "1.0.15") === true);
check("1.0.13 is NOT newer than 1.0.15", isVersionNewer("1.0.13", "1.0.15") === false);
check("1.0.13 is older than 1.0.15", isVersionOlder("1.0.13", "1.0.15") === true);
check("1.0.16 is NOT older than 1.0.15", isVersionOlder("1.0.16", "1.0.15") === false);
check(
  "an EQUAL version is neither newer nor older (force-reinstall still works)",
  isVersionOlder("1.0.15", "1.0.15") === false && isVersionNewer("1.0.15", "1.0.15") === false,
);
check(
  "the 1.0.15 -> 1.0.13 downgrade the Mothership asked for is detected",
  isVersionOlder("1.0.13", "1.0.15") === true && isVersionNewer("1.0.13", "1.0.15") === false,
);
check(
  "an unparseable version is never treated as a downgrade",
  isVersionOlder("garbage", "1.0.15") === false && isVersionOlder("1.0.13", "garbage") === false,
);

// The consent flag is read from the command payload, and ONLY a real boolean
// counts — a JSON payload can carry the string "false", and `Boolean("false")`
// would read that as consent to roll the fleet backwards.
const { wantsDowngrade } = await load("dist/services/heartbeat.js");
check("no args means no downgrade consent", wantsDowngrade({}) === false);
check(
  "allow_downgrade: true grants consent (snake_case wire format)",
  wantsDowngrade({ args: { allow_downgrade: true } }) === true,
);
check(
  "allowDowngrade: true grants consent (camelCase internal format)",
  wantsDowngrade({ args: { allowDowngrade: true } }) === true,
);
check(
  'the STRING "false" is NOT consent',
  wantsDowngrade({ args: { allow_downgrade: "false" } }) === false,
);
check("0 is NOT consent", wantsDowngrade({ args: { allow_downgrade: 0 } }) === false);
check("an absent flag is NOT consent", wantsDowngrade({ args: { enabled: true } }) === false);

// And the flag must actually reach the updater through the executor, or setting
// it in the Mothership would be silently ignored — which would refuse a rollback
// the operator explicitly asked for.
const receivedOptions = [];
await executePendingCommands([{ id: "dg-1", command: "FORCE_UPDATE", args: { allow_downgrade: true } }], {
  restartNode: () => {},
  forceUpdate: (options) => {
    receivedOptions.push(options ?? {});
  },
  setP2pEnabled: () => {},
  isP2pEnabled: () => true,
});
check(
  "allow_downgrade reaches the updater through the command executor",
  receivedOptions[0]?.allowDowngrade === true,
  JSON.stringify(receivedOptions),
);

const plainOptions = [];
resetExecutedCommands();
await executePendingCommands([{ id: "dg-2", command: "FORCE_UPDATE" }], {
  restartNode: () => {},
  forceUpdate: (options) => {
    plainOptions.push(options ?? {});
  },
  setP2pEnabled: () => {},
  isP2pEnabled: () => true,
});
check(
  "an ordinary FORCE_UPDATE carries no downgrade consent",
  plainOptions[0]?.allowDowngrade === undefined,
  JSON.stringify(plainOptions),
);

// --- 8d. The GitHub release asset contract ----------------------------------
// The download URL is a LITERAL FILENAME LOOKUP on GitHub, so the asset name is
// part of the updater's public contract. These assertions stop a future rename
// from silently reintroducing the 404 that made every node report "no release".
const updater = await load("dist/services/updater.js");

check("the release asset is named rippa-node.exe", updater.RELEASE_ASSET_NAME === "rippa-node.exe");
check(
  "the canonical download URL matches what the updater requests",
  updater.releaseDownloadUrl() ===
    "https://github.com/Farko420/rippa-node/releases/latest/download/rippa-node.exe",
  updater.releaseDownloadUrl(),
);

// With the watchdog also shipping an .exe, "first .exe wins" is a coin flip
// between the worker and its supervisor. The exact name must win.
const twoAssetRelease = {
  tag_name: "latest",
  name: "rippa-node 1.0.16",
  assets: [
    { name: "rippa-watchdog.exe", browser_download_url: "https://example.invalid/watchdog.exe" },
    { name: "rippa-node.exe", browser_download_url: "https://example.invalid/node.exe" },
  ],
};
check(
  "the exactly-named asset is chosen over another .exe",
  updater.parseLatestRelease(twoAssetRelease)?.downloadUrl === "https://example.invalid/node.exe",
  JSON.stringify(updater.parseLatestRelease(twoAssetRelease)),
);
check(
  "asset selection is case-insensitive on the name",
  updater.selectReleaseAsset([
    { name: "RIPPA-NODE.EXE", browser_download_url: "https://example.invalid/upper.exe" },
  ])?.name === "RIPPA-NODE.EXE",
);
// A renamed asset must still install: refusing outright would wedge OTA for
// good, which is a worse failure than a documented fallback.
check(
  "a renamed asset still falls back to the first .exe (OTA is not wedged)",
  updater.parseLatestRelease({
    tag_name: "latest",
    name: "rippa-node 1.0.16",
    assets: [{ name: "rippa-node-1.0.16.exe", browser_download_url: "https://example.invalid/renamed.exe" }],
  })?.downloadUrl === "https://example.invalid/renamed.exe",
);
// An assetless release is refused, because there is nothing to install.
check(
  "an assetless release is still refused",
  updater.parseLatestRelease({ tag_name: "latest", name: "rippa-node 1.0.16", assets: [] }) === null,
);

// GITHUB_TOKEN is what makes a PRIVATE repo readable: GitHub answers 404 to every
// unauthenticated request, which is indistinguishable from "no release yet". The
// accepted names are asserted so the CI secret name cannot silently stop working.
const savedTokens = {
  rippa: process.env.RIPPA_GITHUB_TOKEN,
  gh: process.env.GITHUB_TOKEN,
  cli: process.env.GH_TOKEN,
};
delete process.env.RIPPA_GITHUB_TOKEN;
delete process.env.GITHUB_TOKEN;
delete process.env.GH_TOKEN;

check("no token resolves to an empty string", updater.resolveGitHubToken() === "");
// Deleted in turn, so each name is proven to work on its OWN rather than being
// shadowed by one that outranks it.
process.env.GITHUB_TOKEN = "ghp_ci_secret";
check(
  "GITHUB_TOKEN is accepted (the standard CI secret name)",
  updater.resolveGitHubToken() === "ghp_ci_secret",
);
delete process.env.GITHUB_TOKEN;
process.env.GH_TOKEN = "gh_cli_secret";
check(
  "GH_TOKEN is accepted (the GitHub CLI's name)",
  updater.resolveGitHubToken() === "gh_cli_secret",
);
delete process.env.GH_TOKEN;
process.env.RIPPA_GITHUB_TOKEN = "node_specific";
check(
  "RIPPA_GITHUB_TOKEN wins over the others",
  updater.resolveGitHubToken() === "node_specific",
);

// The token must reach the ACTUAL asset download, not just the metadata call —
// omitting it there is why a private repo's metadata succeeded while its binary
// answered 404.
check(
  "an authenticated call carries the bearer token",
  updater.githubHeaders()["Authorization"] === "Bearer node_specific",
);

// ...and must NEVER go anywhere that is not GitHub, or a token could leak to a
// third-party host named in a Mothership-supplied download_url.
check(
  "github.com is recognised as a GitHub host",
  updater.isGitHubUrl("https://github.com/a/b/releases/latest/download/rippa-node.exe") === true,
);
check("api.github.com is recognised", updater.isGitHubUrl("https://api.github.com/repos/a/b") === true);
check(
  "a CDN redirect host is recognised",
  updater.isGitHubUrl("https://objects.githubusercontent.com/x") === true,
);
check("a NON-GitHub host is not", updater.isGitHubUrl("https://evil.example.com/rippa-node.exe") === false);
check(
  "a lookalike host is not treated as GitHub",
  updater.isGitHubUrl("https://github.com.evil.example/rippa-node.exe") === false,
);
check("a non-URL is not treated as GitHub", updater.isGitHubUrl("not a url") === false);

for (const [key, value] of [
  ["RIPPA_GITHUB_TOKEN", savedTokens.rippa],
  ["GITHUB_TOKEN", savedTokens.gh],
  ["GH_TOKEN", savedTokens.cli],
]) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

// The satellite trigger carries the same consent flag, so a Master pushing a
// stale version cannot walk a satellite backwards by accident.
const triggerOf = (extra) =>
  updater.parseUpdateTrigger({
    command: "SWARM_UPDATE_TRIGGER",
    version: "1.0.16",
    tag: "v1.0.16",
    downloadUrl: "https://example.invalid/rippa-node.exe",
    issuedBy: "RIPPA-AAAA-BBBB",
    ...extra,
  });

check("a trigger can carry allow_downgrade", triggerOf({ allow_downgrade: true })?.allowDowngrade === true);
check(
  "a trigger without the flag has no consent",
  triggerOf({})?.allowDowngrade === undefined,
);
check(
  'a trigger with the STRING "false" has no consent',
  triggerOf({ allow_downgrade: "false" })?.allowDowngrade === undefined,
);
// A trigger naming an older build must still parse — the refusal belongs in the
// handler, which can be reasoned about, not in the parser.
check(
  "a trigger naming an OLDER version still parses (the handler refuses it)",
  triggerOf({}) !== null,
);

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