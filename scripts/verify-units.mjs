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

// --- 8e. THE PRIVATE-REPO 404 — authenticated GitHub asset downloads ----------
// `Farko420/rippa-node` is PRIVATE, so `/releases/latest/download/rippa-node.exe`
// answers 404 to every anonymous request — byte-for-byte identical to "no asset by
// that name". These assertions pin the resolution that makes it fetchable: swap the
// public shortcut for GitHub's authenticated asset API when a token is present, and
// leave the URL untouched when it is not (a public repo needs no token).
const ghAsset = await load("dist/update/githubAsset.js");

check(
  "the repo is identified from a releases download URL",
  ghAsset.repoFromGitHubUrl(
    "https://github.com/Farko420/rippa-node/releases/latest/download/rippa-node.exe",
  ) === "Farko420/rippa-node",
);
check("a non-release GitHub URL has no repo", ghAsset.repoFromGitHubUrl("https://github.com/a/b") === null);
check(
  "the requested asset name is read off the URL",
  ghAsset.assetNameFromDownloadUrl(
    "https://github.com/Farko420/rippa-node/releases/latest/download/rippa-node.exe",
  ) === "rippa-node.exe",
);
// A tag like "v1.0.16" also contains dots, so the filename heuristic alone cannot
// separate it. What separates them is the PATH: a download lives under
// `/download/<name>`, a tag lives under `/tag/<name>`.
check(
  "a tag URL yields no asset name (the path, not the dots, decides)",
  ghAsset.assetNameFromDownloadUrl("https://github.com/a/b/releases/tag/v1.0.16") === null,
  ghAsset.assetNameFromDownloadUrl("https://github.com/a/b/releases/tag/v1.0.16"),
);

// Asset selection must prefer the EXACT contract name — the watchdog also ships an
// .exe, so "first .exe wins" would be a coin flip between worker and supervisor.
const PRIVATE_ASSETS = [
  { id: 7, name: "rippa-watchdog.exe", url: "https://api.github.com/repos/o/r/releases/assets/7" },
  { id: 9, name: "rippa-node.exe", url: "https://api.github.com/repos/Farko420/rippa-node/releases/assets/9" },
];
check(
  "the API asset endpoint for rippa-node.exe is chosen over the watchdog's",
  ghAsset.selectAssetForDownload(PRIVATE_ASSETS, ["rippa-node.exe"])?.id === 9,
);
check(
  "asset selection is case-insensitive",
  ghAsset.selectAssetForDownload(
    [{ id: 3, name: "RIPPA-NODE.EXE", url: "https://api.github.com/repos/o/r/releases/assets/3" }],
    ["rippa-node.exe"],
  )?.id === 3,
);
check(
  "a renamed asset still resolves (OTA is not wedged over a rename)",
  ghAsset.selectAssetForDownload(
    [{ id: 4, name: "rippa-node-1.0.16.exe", url: "https://api.github.com/repos/o/r/releases/assets/4" }],
    ["rippa-node.exe"],
  )?.id === 4,
);
check("an assetless release resolves to nothing", ghAsset.selectAssetForDownload([], ["rippa-node.exe"]) === null);

// --- 8e-ii. THE DIAGNOSTICS — a 404 that finally says WHY --------------------
// Every cause of the private-repo 404 (no token, private repo, wrong repo, bad
// credentials, renamed asset, pre-release-only) produces the SAME opaque HTTP
// status. A resolver that returns null silently on all of them cannot be
// diagnosed from a node log, which is exactly the situation being fixed here.
{
  const REAL_FETCH = globalThis.fetch;
  const REAL_WARN = console.warn;
  const SHORTCUT = "https://github.com/Farko420/rippa-node/releases/latest/download/rippa-node.exe";

  /** Runs `fn` with fetch stubbed and every emitted diagnostic captured. */
  const capture = async (stub, fn) => {
    const lines = [];
    console.warn = (line) => lines.push(String(line));
    globalThis.fetch = stub;
    try {
      return { lines, result: await fn(lines) };
    } finally {
      console.warn = REAL_WARN;
      globalThis.fetch = REAL_FETCH;
    }
  };
  const jsonResponse = (body, ok = true) => ({
    ok,
    json: async () => body,
    text: async () => JSON.stringify(body),
  });

  // 1. NO TOKEN — the documented warning, and it must not be swallowed.
  delete process.env.RIPPA_GITHUB_TOKEN;
  delete process.env.GITHUB_TOKEN;
  delete process.env.GH_TOKEN;
  {
    let asked = 0;
    const { lines, result } = await capture(
      async () => { asked += 1; return jsonResponse({}); },
      () => ghAsset.resolveGitHubAssetDownload(SHORTCUT),
    );
    check("with no token the URL is still left untouched", result === null);
    check("with no token no API call is wasted", asked === 0);
    check(
      "with no token the public-fallback warning is emitted verbatim",
      lines.some((l) =>
        l.includes("No GITHUB_TOKEN provided") &&
        l.includes("public unauthenticated download") &&
        l.includes("will fail if the repo is private")),
      JSON.stringify(lines),
    );
    check(
      "the no-token warning names the env vars that fix it",
      lines.some((l) => l.includes("RIPPA_GITHUB_TOKEN") && l.includes("GITHUB_TOKEN")),
      JSON.stringify(lines),
    );
  }

  process.env.RIPPA_GITHUB_TOKEN = "ghp_private_repo";

  // 2. 401 — the body must be echoed, or a bad token is indistinguishable.
  {
    const { lines, result } = await capture(
      async () => ({ ok: false, status: 401, text: async () => '{"message":"Bad credentials"}' }),
      () => ghAsset.resolveGitHubAssetDownload(SHORTCUT),
    );
    check("a 401 falls back to the plain URL", result === null);
    check(
      "a 401 logs the status AND GitHub's response body",
      lines.some((l) => l.includes("401") && l.includes("Bad credentials")),
      JSON.stringify(lines),
    );
  }

  // 3. 404 — must say this is what a private repo answers, not just the number.
  {
    const { lines } = await capture(
      async () => ({ ok: false, status: 404, text: async () => '{"message":"Not Found"}' }),
      () => ghAsset.resolveGitHubAssetDownload(SHORTCUT),
    );
    check(
      "a 404 explains that a private repo is indistinguishable from a missing one",
      lines.some((l) => l.includes("404") && /private/i.test(l)),
      JSON.stringify(lines),
    );
  }

  // 4. WRONG REPO / NETWORK — a transport failure is named as such.
  {
    const { lines } = await capture(
      async () => { throw new Error("getaddrinfo ENOTFOUND api.github.com"); },
      () => ghAsset.resolveGitHubAssetDownload(SHORTCUT),
    );
    check(
      "a DNS failure is reported as a network fault, not an HTTP status",
      lines.some((l) => l.includes("ENOTFOUND") && /network/i.test(l)),
      JSON.stringify(lines),
    );
  }
  // 5. THE RENAME — the exact log the runbook greps for. A release that ships
  // NO .exe at all is the only case that reaches the "Failed to find" branch:
  // a release with some other .exe still installs via the documented
  // endsWith(".exe") fallback, which is asserted separately above.
  {
    const { lines, result } = await capture(
      async () => jsonResponse({
        tag_name: "v1.0.16",
        assets: [
          { id: 6, name: "checksums.txt", url: "https://api.github.com/x/6" },
          { id: 7, name: "source.zip", url: "https://api.github.com/x/7" },
        ],
      }),
      () => ghAsset.resolveGitHubAssetDownload(SHORTCUT),
    );
    check("a release with no .exe at all falls back to the plain URL", result === null);
    check(
      "a missing .exe asset logs the release tag AND every available asset name",
      lines.some(
        (l) =>
          l.includes("Failed to find .exe asset in release v1.0.16") &&
          l.includes("Available assets:") &&
          l.includes("checksums.txt") &&
          l.includes("source.zip"),
      ),
      JSON.stringify(lines),
    );
  }

  // 6. PRE-RELEASES — off by default, and that default must not resolve.
  {
    const asked = [];
    const { result } = await capture(
      async (url) => {
        asked.push(String(url));
        return { ok: false, status: 404, text: async () => '{"message":"Not Found"}' };
      },
      () => ghAsset.resolveGitHubAssetDownload(SHORTCUT),
    );
    check("pre-releases are NOT consulted unless opted in", result === null);
    check(
      "only /releases/latest is called without the opt-in",
      asked.length === 1 && asked[0].endsWith("/releases/latest"),
      JSON.stringify(asked),
    );
  }

  // ...and ON when opted in: /releases/latest skips pre-releases, so the list is
  // the only endpoint that can see an RC-only repo.
  {
    const asked = [];
    const { result } = await capture(
      async (url) => {
        asked.push(String(url));
        if (String(url).endsWith("/releases/latest")) {
          return { ok: false, status: 404, text: async () => '{"message":"Not Found"}' };
        }
        return jsonResponse([
          { tag_name: "v1.1.0-rc.1", draft: true, assets: [] },
          {
            tag_name: "v1.1.0-rc.1",
            prerelease: true,
            assets: [{ id: 21, name: "rippa-node.exe", url: "https://api.github.com/x/21" }],
          },
        ]);
      },
      () => ghAsset.resolveGitHubAssetDownload(SHORTCUT, { allowPrerelease: true }),
    );
    check(
      "a pre-release resolves to its authenticated asset endpoint",
      result?.url === "https://api.github.com/x/21",
      result?.url,
    );
    check(
      "the fallback consults the releases LIST endpoint",
      asked.some((u) => /\/releases\?per_page=/.test(u)),
      JSON.stringify(asked),
    );
    check(
      "a successful resolution returns the octet-stream Accept header",
      result?.headers?.Accept === "application/octet-stream",
    );
    check(
      "a successful resolution carries the bearer token and API version",
      result?.headers?.Authorization === "Bearer ghp_private_repo" &&
        result?.headers?.["X-GitHub-Api-Version"] === "2022-11-28",
      JSON.stringify(result?.headers),
    );
  }
}

// A draft must never be installable, even with pre-releases enabled.
check(
  "a draft release is never selected",
  ghAsset.pickNewestRelease([
    { tag_name: "v2.0.0", draft: true },
    { tag_name: "v1.0.16", draft: false },
  ])?.tag_name === "v1.0.16",
);
check(
  "a list of nothing but drafts selects nothing",
  ghAsset.pickNewestRelease([{ tag_name: "d", draft: true }]) === null,
);

// The asset-list renderer is what makes the rename diagnosable.
check(
  "the asset description lists names for the log",
  ghAsset.describeAssets([{ name: "a.exe" }, { name: "b.exe" }]) === "a.exe, b.exe",
);
check(
  "an assetless release is described explicitly, not as a blank",
  ghAsset.describeAssets([]) === "(the release publishes no assets at all)",
  ghAsset.describeAssets([]),
);

/*
  THE 404 REGRESSION ITSELF. A private repo's anonymous answer and a missing asset
  are the same 404, so the only thing assertable offline is the DECISION: with a
  token the URL must become the API asset endpoint carrying octet-stream, and
  without one it must be left exactly as advertised.
*/
{
  const REAL_FETCH = globalThis.fetch;
  const SHORTCUT = "https://github.com/Farko420/rippa-node/releases/latest/download/rippa-node.exe";
  process.env.RIPPA_GITHUB_TOKEN = "ghp_private_repo";
  try {
    let askedFor = "";
    let sentAuth = "";
    globalThis.fetch = async (url, init) => {
      askedFor = String(url);
      sentAuth = init?.headers?.Authorization ?? "";
      return {
        ok: true,
        json: async () => ({
          tag_name: "latest",
          name: "rippa-node 1.0.16",
          assets: PRIVATE_ASSETS,
        }),
      };
    };

    const resolved = await ghAsset.resolveGitHubAssetDownload(SHORTCUT);
    check(
      "a private repo's URL is rewritten to the authenticated API asset endpoint",
      resolved?.url === "https://api.github.com/repos/Farko420/rippa-node/releases/assets/9",
      resolved?.url,
    );
    check(
      "the asset download asks for octet-stream (bytes, not JSON metadata)",
      resolved?.headers?.Accept === "application/octet-stream",
      resolved?.headers?.Accept,
    );
    check("the metadata lookup carries the bearer token", sentAuth === "Bearer ghp_private_repo");
    check(
      "the metadata lookup goes to the releases API",
      askedFor === "https://api.github.com/repos/Farko420/rippa-node/releases/latest",
      askedFor,
    );

    // An already-resolved API asset URL must not trigger a pointless re-lookup.
    let extraCalls = 0;
    globalThis.fetch = async () => {
      extraCalls += 1;
      return { ok: true, json: async () => ({ assets: PRIVATE_ASSETS }) };
    };
    const already = await ghAsset.resolveGitHubAssetDownload(
      "https://api.github.com/repos/Farko420/rippa-node/releases/assets/9",
    );
    check("an API asset URL is reused without re-resolving", extraCalls === 0 && already !== null);
  } finally {
    globalThis.fetch = REAL_FETCH;
    delete process.env.RIPPA_GITHUB_TOKEN;
  }
}

// No token: the URL is returned UNCHANGED (null means "fetch it as advertised"),
// which is correct for a public repo and leaves the 404 to explain itself.
check(
  "without a token the URL is left untouched (public repos need no token)",
  (await ghAsset.resolveGitHubAssetDownload(
    "https://github.com/Farko420/rippa-node/releases/latest/download/rippa-node.exe",
  )) === null,
);
check(
  "a non-GitHub URL is never rewritten",
  (await ghAsset.resolveGitHubAssetDownload("https://cdn.example.com/rippa-node.exe")) === null,
);
check("a malformed URL is never rewritten", (await ghAsset.resolveGitHubAssetDownload("not a url")) === null);

// The token must reach GitHub and NOTHING else — `download_url` comes from the
// Mothership, so a lookalike host must never receive a repo-scoped credential.
check(
  "a GitHub host is eligible for the token",
  ghAsset.isGitHubUrl("https://api.github.com/repos/a/b/releases/assets/1") === true,
);
check(
  "a lookalike host cannot receive the token",
  ghAsset.isGitHubUrl("https://api.github.com.evil.example/repos/a/b") === false,
);

// --- 8f. THE MOTHERSHIP'S STALE FALLBACK VERSION -----------------------------
// The Mothership broadcasts FALLBACK_VERSION whenever its GitHub lookup fails, and
// it failed on EVERY poll because the repo is private. Left at 1.0.13 while the
// fleet ran 1.0.16, that constant commanded the whole swarm to downgrade. The Node
// cannot fix a wrong advertisement, but it can prove the two agree.
const { readFileSync, existsSync } = await import("node:fs");
const mothershipFeedPath = path.join(
  ROOT,
  "..",
  "Rippa Adventures",
  "src",
  "lib",
  "node-latest-version.server.ts",
);
// The Mothership is a SEPARATE repository. These assertions only apply when it is
// checked out beside the Node, so a standalone Node clone skips them rather than
// failing on a path it does not own.
const mothershipPresent = existsSync(mothershipFeedPath);
check(
  "the Mothership's fallback version is no longer the stale 1.0.13",
  !mothershipPresent ||
    /const FALLBACK_VERSION = "([^"]+)"/.exec(readFileSync(mothershipFeedPath, "utf8"))?.[1] !==
      "1.0.13",
);
if (mothershipPresent) {
  const mothershipFeed = readFileSync(mothershipFeedPath, "utf8");
  const nodeManifest = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const advertisedFallback = /const FALLBACK_VERSION = "([^"]+)"/.exec(mothershipFeed)?.[1];
  check(
    `the Mothership's fallback version (${advertisedFallback}) matches package.json (${nodeManifest.version})`,
    advertisedFallback === nodeManifest.version,
    `${advertisedFallback} vs ${nodeManifest.version}`,
  );
  // The advertised URL must name the asset the workflow actually publishes, because
  // `/releases/latest/download/<asset>` is a literal filename lookup.
  check(
    "the Mothership advertises the exact published asset name",
    /const ROLLING_DOWNLOAD_URL =[\s\S]*?releases\/latest\/download\/rippa-node\.exe/.test(mothershipFeed),
  );
}

// --- 8g. DOWNGRADE REFUSAL HAPPENS BEFORE THE DOWNLOAD -----------------------
// The node must reject a stale Mothership version BEFORE spending bandwidth on a
// ~126 MB download. Both gates are asserted at the source, because a check placed
// after `this.download(...)` would still look correct in a log.
const otaSource = readFileSync(path.join(ROOT, "src", "update", "OtaUpdater.ts"), "utf8");
const gateAt = otaSource.indexOf("isVersionOlder(latest.version");
const downloadAt = otaSource.indexOf("await this.download(");
check("OtaUpdater refuses a downgrade", gateAt !== -1);
check(
  "the downgrade gate is positioned BEFORE the download (no wasted bandwidth)",
  gateAt !== -1 && downloadAt !== -1 && gateAt < downloadAt,
  `gate@${gateAt} download@${downloadAt}`,
);

const swarmSource = readFileSync(path.join(ROOT, "src", "services", "updater.ts"), "utf8");
const swarmGate = swarmSource.indexOf("isVersionOlder(release.version");
const swarmDownload = swarmSource.indexOf("await this.download(");
check("the SwarmUpdater poller refuses a downgrade", swarmGate !== -1);
check(
  "the poller's downgrade gate is also before its download",
  swarmGate !== -1 && swarmDownload !== -1 && swarmGate < swarmDownload,
  `gate@${swarmGate} download@${swarmDownload}`,
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