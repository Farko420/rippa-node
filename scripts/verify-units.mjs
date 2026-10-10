/**
 * BUGS 5 & 6 (UNIT LEVEL) — autonomous task claiming and admin interception.
 *
 * Driven against the COMPILED output so it exercises the same code the packaged
 * exe runs, with a stub SwarmClient that records exactly what it was asked to do.
 */
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { pathToFileURL, fileURLToPath } from "node:url";
import { ROOT, check, warn, results } from "./verify-harness.mjs";

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

/*
  THE OVERRIDE ABOVE IS INERT UNTIL THIS CALL — AND THAT IS THE WHOLE POINT.

  `dist/config.js` snapshots the environment ONCE at module load
  (`export const env = parsed.data`). `dist/services/heartbeat.js` pulls that
  module in at the top of this file, so by the time the four assignments above
  run, `env.MOTHERSHIP_URL` has already been frozen to whatever `.env` says —
  in practice the LIVE `https://rippaadventures.com`.

  Without `reloadEnv()`, `new SwarmClient()` reads that stale snapshot as its
  axios `baseURL` and every assertion below "passes" or fails against the REAL
  Mothership: the local server records nothing (`received` stays `[]`), the
  assertions that inspect recorded bodies fail for the wrong reason, and the
  suite silently depends on another company's uptime and network. A green run
  would prove nothing about this code.

  `reloadEnv()` re-reads `process.env` into the live `env` object, so the
  client below is pointed at the throwaway server on the line above.
*/
const configModule = await load("dist/config.js");
configModule.reloadEnv();

const { SwarmClient } = await load("dist/network/SwarmClient.js");
const ackClient = new SwarmClient();

/*
  HERMETICITY GUARD. Every assertion below is only meaningful if the client is
  talking to the throwaway server. Without this check a regression of the
  snapshot above would not surface as a failure — it would quietly restore the
  suite to hitting the live Mothership and reporting whatever it said. This is
  the assertion that makes "the tests passed" mean "the tests ran against the
  code", so it is deliberately the FIRST thing proved.
*/
check(
  "the ack client is pointed at the LOCAL mock, not the live Mothership",
  String(ackClient.client?.defaults?.baseURL ?? "").startsWith(`http://127.0.0.1:${ackPort}`),
  String(ackClient.client?.defaults?.baseURL ?? "(unknown)"),
);

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

/*
  UNDO THE OVERRIDE IN THE SNAPSHOT TOO, not just in `process.env`.

  `reloadEnv()` copied the throwaway URL into the shared `env` object, which
  every later module in this process reads. Restoring `process.env` alone would
  leave `env.MOTHERSHIP_URL` pointing at a port that is now CLOSED, so every
  remaining check that touches the Mothership would fail for a reason that has
  nothing to do with what it is testing. One more `reloadEnv()` re-derives the
  live values from the just-restored environment.
*/
configModule.reloadEnv();

// --- 7d. STORAGE and CAPACITY (SYSTEM_UPDATE_STORAGE) --------------------------
// UI-DRIVEN NODE STORAGE: the Apply and Migrate flow. The Mothership queues
// `system_update_storage`; the node parses it, applies config, copies and
// verifies persistent data, and (on a real change) exits 42. These checks pin
// the wire spelling, the ack ordering, validation, and migrate/verify on
// throwaway directories.
check(
  "task type SYSTEM_UPDATE_STORAGE maps to UPDATE_STORAGE",
  adminCommandForTaskType("SYSTEM_UPDATE_STORAGE") === "UPDATE_STORAGE",
);
check(
  "the bare UPDATE_STORAGE spelling is accepted too",
  adminCommandForTaskType("UPDATE_STORAGE") === "UPDATE_STORAGE",
);
const storageAlias = parsePendingCommands({
  pending_commands: [{ id: "stor-1", command: "system_update_storage" }],
});
check(
  "the lowercase spelling survives pending_commands parsing",
  storageAlias.length === 1 && storageAlias[0].command === "UPDATE_STORAGE",
  JSON.stringify(storageAlias.map((a) => a.command)),
);

// The command is acknowledged in_progress BEFORE the handler runs, and the
// payload reaches the handler verbatim — matching RESTART_NODE ordering.
resetExecutedCommands();
const storageAcks = [];
const storageArgsSeen = [];
await executePendingCommands(
  [{ id: "stor-2", command: "UPDATE_STORAGE", args: { data_dir: "D:\\RippaNode" } }],
  {
    ...ackBase,
    updateStorage: (args) => {
      storageArgsSeen.push(args);
      return true;
    },
    acknowledgeCommand: (command, detail, context) =>
      storageAcks.push({ command, detail, context }),
  },
);
check(
  "UPDATE_STORAGE is acknowledged in_progress before it runs",
  storageAcks.length >= 1 &&
    storageAcks[0].command === "UPDATE_STORAGE" &&
    storageAcks[0].context?.status === "in_progress",
  JSON.stringify(storageAcks.map((a) => a.context?.status)),
);
check(
  "the storage payload reaches the handler with its data_dir",
  storageArgsSeen[0]?.data_dir === "D:\\RippaNode",
  JSON.stringify(storageArgsSeen[0]),
);

// A refusing handler is reported honestly, exactly like a refused update.
resetExecutedCommands();
const storageRefused = [];
await executePendingCommands([{ id: "stor-3", command: "UPDATE_STORAGE" }], {
  ...ackBase,
  updateStorage: () => false,
  acknowledgeCommand: (command, detail, context) =>
    storageRefused.push({ command, detail, context }),
});
check(
  "a refused storage apply is acknowledged twice (in_progress, then failed)",
  storageRefused.length === 2 &&
    storageRefused[1].context?.status === "failed" &&
    storageRefused[1].context?.commandId === "stor-3",
  JSON.stringify(storageRefused.map((a) => a.context?.status)),
);

// Payload validation: relative paths, filesystem roots, and garbage
// capacities are refused with a message the admin screen can show.
const {
  parseStorageConfigRequest,
  applyStorageConfig,
  buildStorageTelemetry,
} = await load("dist/services/storageConfig.js");
for (const [name, payload] of [
  ["a relative path", { data_dir: "RippaNode" }],
  ["a filesystem root", { data_dir: "C:\\" }],
  ["an empty payload", {}],
  ["a garbage capacity", { scratch_capacity_gb: "lots" }],
  ["a negative capacity", { scratch_capacity_gb: -4 }],
]) {
  let refused = "";
  try {
    parseStorageConfigRequest(payload);
  } catch (error) {
    refused = error instanceof Error ? error.message : String(error);
  }
  check(`an unsafe storage request is refused (${name})`, refused.length > 0, refused);
}
check(
  "a capacity-only request parses without a directory",
  parseStorageConfigRequest({ scratch_capacity_gb: 50, safe_vault_capacity_gb: 200 })
    .scratchCapacityGb === 50,
);

// --- 8e-iii. MIGRATION ON THROWAWAY DIRECTORIES --------------------------------
// Config is written, persistent data is copied with runtime state left behind,
// verification passes, and the migrated config names the new directory.
// RIPPA_CONFIG_ROOT pins writeConfig to the sandbox; a chdir pins the .env
// upsert there too, so the developer's real config is never touched.
const prevStorageConfigRoot = process.env.RIPPA_CONFIG_ROOT;
const prevStorageDataDir = process.env.RIPPA_DATA_DIR;
const prevStorageScratch = process.env.SCRATCH_DRIVE_CAPACITY_GB;
const prevStorageVault = process.env.SAFE_VAULT_CAPACITY_GB;
const prevStorageCwd = process.cwd();
const storageSandbox = fs.mkdtempSync(path.join(osMod.tmpdir(), "rippa-storage-"));
const storageOld = path.join(storageSandbox, "old-store");
const storageNew = path.join(storageSandbox, "new-store");
fs.mkdirSync(storageOld, { recursive: true });
fs.writeFileSync(path.join(storageOld, "local_knowledge.db"), "x".repeat(4096));
fs.writeFileSync(path.join(storageOld, "local_knowledge.db-wal"), "w".repeat(128));
fs.writeFileSync(
  path.join(storageOld, "config.json"),
  JSON.stringify({ NODE_NAME: "storage-verify", NODE_API_KEY: "verify-key-00000001" }),
);
fs.mkdirSync(path.join(storageOld, "models"), { recursive: true });
fs.writeFileSync(path.join(storageOld, "models", "m.gguf"), "y".repeat(2048));
fs.mkdirSync(path.join(storageOld, "bin"), { recursive: true });
fs.writeFileSync(path.join(storageOld, "bin", "runtime.exe"), "z".repeat(16));
fs.writeFileSync(path.join(storageOld, "node.log"), "noise");
process.env.RIPPA_CONFIG_ROOT = storageOld;
process.env.RIPPA_DATA_DIR = storageOld;
process.chdir(storageSandbox);
let storageReport = null;
let storageApplyError = "";
try {
  storageReport = applyStorageConfig({
    data_dir: storageNew,
    scratch_capacity_gb: 25,
    safe_vault_capacity_gb: 100,
  });
} catch (error) {
  storageApplyError = error instanceof Error ? error.message : String(error);
}
check("a directory change applies without throwing", storageReport !== null, storageApplyError);
check(
  "the report names the move that happened",
  storageReport !== null && storageReport.changed === true && storageReport.to === storageNew,
  JSON.stringify(storageReport && { from: storageReport.from, changed: storageReport.changed }),
);
check(
  "persistent files landed in the new directory",
  fs.existsSync(path.join(storageNew, "local_knowledge.db")) &&
    fs.existsSync(path.join(storageNew, "models", "m.gguf")) &&
    fs.existsSync(path.join(storageNew, "config.json")),
);
check(
  "the migrated bytes match the sources",
  fs.statSync(path.join(storageNew, "local_knowledge.db")).size === 4096 &&
    fs.statSync(path.join(storageNew, "models", "m.gguf")).size === 2048,
);
check(
  "runtime state is NOT migrated (bin folder and logs stay behind)",
  !fs.existsSync(path.join(storageNew, "bin")) && !fs.existsSync(path.join(storageNew, "node.log")),
);
const migratedCfg = JSON.parse(fs.readFileSync(path.join(storageNew, "config.json"), "utf8"));
check(
  "the migrated config names the new directory and capacities",
  migratedCfg.RIPPA_DATA_DIR === storageNew &&
    migratedCfg.SCRATCH_DRIVE_CAPACITY_GB === 25 &&
    migratedCfg.SAFE_VAULT_CAPACITY_GB === 100,
  JSON.stringify({
    RIPPA_DATA_DIR: migratedCfg.RIPPA_DATA_DIR,
    SCRATCH_DRIVE_CAPACITY_GB: migratedCfg.SCRATCH_DRIVE_CAPACITY_GB,
  }),
);
check(
  "the source directory survives as a backup (copy, never move)",
  fs.existsSync(path.join(storageOld, "local_knowledge.db")),
);

// A capacity-only re-apply against the SAME directory reports changed=false,
// so an at-least-once redelivery can never become a restart loop.
process.env.RIPPA_CONFIG_ROOT = storageNew;
process.env.RIPPA_DATA_DIR = storageNew;
let noopReport = null;
try {
  noopReport = applyStorageConfig({ data_dir: storageNew, scratch_capacity_gb: 25 });
} catch (error) {
  noopReport = null;
}
check(
  "re-applying the same directory reports changed=false (no restart needed)",
  noopReport !== null && noopReport.changed === false,
  JSON.stringify(noopReport && { changed: noopReport.changed }),
);

// A nested target (new dir inside the old one) must be refused, or the copy
// would recurse into itself.
process.env.RIPPA_DATA_DIR = storageOld;
let nestedRefused = "";
try {
  applyStorageConfig({ data_dir: path.join(storageOld, "nested-inside") });
} catch (error) {
  nestedRefused = error instanceof Error ? error.message : String(error);
}
check("a nested target directory is refused", nestedRefused.length > 0, nestedRefused);

// The heartbeat telemetry carries the storage block at the payload root,
// spelled exactly as the Mothership normaliseHeartbeat reads it.
process.env.RIPPA_DATA_DIR = storageNew;
process.env.SCRATCH_DRIVE_CAPACITY_GB = "25";
process.env.SAFE_VAULT_CAPACITY_GB = "100";
const storageBeat = buildStorageTelemetry();
check(
  "the heartbeat telemetry carries the configured capacities",
  storageBeat.scratch_capacity_gb === 25 && storageBeat.vault_capacity_gb === 100,
  JSON.stringify(storageBeat),
);
check(
  "the heartbeat telemetry names the active data directory",
  storageBeat.storage_data_dir === storageNew,
  String(storageBeat.storage_data_dir),
);

// Restore the developer environment and remove the sandbox.
process.chdir(prevStorageCwd);
if (prevStorageConfigRoot === undefined) delete process.env.RIPPA_CONFIG_ROOT;
else process.env.RIPPA_CONFIG_ROOT = prevStorageConfigRoot;
if (prevStorageDataDir === undefined) delete process.env.RIPPA_DATA_DIR;
else process.env.RIPPA_DATA_DIR = prevStorageDataDir;
if (prevStorageScratch === undefined) delete process.env.SCRATCH_DRIVE_CAPACITY_GB;
else process.env.SCRATCH_DRIVE_CAPACITY_GB = prevStorageScratch;
if (prevStorageVault === undefined) delete process.env.SAFE_VAULT_CAPACITY_GB;
else process.env.SAFE_VAULT_CAPACITY_GB = prevStorageVault;
fs.rmSync(storageSandbox, { recursive: true, force: true });
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
/*
  The settle-time must work with `stdio: "ignore"`, which is how the node spawns
  it. `timeout` refuses to run when its input is redirected and answers "ERROR:
  Input redirection is not supported" rather than waiting, so the intended delay
  silently became a no-op and the copy raced the image lock. A loopback ping
  always burns the delay, and it is what the script uses.
*/
check("the script waits 3 seconds for the image lock", /ping -n 4 127\.0\.0\.1/.test(script));
check("it overwrites the running exe in place", /copy \/y .*rippa-node\.exe/.test(script));
check("it does NOT delete the exe before copying (no brick path)", !/^\s*del .*rippa-node\.exe/im.test(script));
check("it retries the copy while the target is missing", /goto :rippa_copy/.test(script));
check("it relaunches the executable afterwards", /start "" "C:.*rippa-node\.exe"/.test(script));
check("it removes the staged download afterwards", /del \/f \/q .*temp_update\.exe/.test(script));
check("it deletes itself last", /%~f0/.test(script));

/*
  THE TWO BUGS THAT MADE A .EXE NODE FREEZE ON THE UPDATE SCREEN. Both are
  asserted on the generated text; `scripts/verify-ota-handoff.mjs` then proves the
  behaviour by EXECUTING the script against a genuinely locked executable.
*/
check(
  "the copy is judged by its exit code, not by `if exist` (which is always true)",
  /if not errorlevel 1/.test(script) && !/if exist ".*rippa-node\.exe"/.test(script),
);
check(
  "a failed swap keeps the staged download for the watchdog",
  /RIPPA_SWAPPED% EQU 1 del/.test(script),
);

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

/*
  THE FLASHING CONSOLE — "a cmd window pops up on the operator's screen".

  This is asserted on the LAUNCHER TEXT rather than by watching the screen,
  because the bug is a property of the generated file: spawning cmd.exe directly
  cannot be both detached and windowless on Windows, and the only way to know the
  fix is still in place after a refactor is to read what we now generate.

  The two properties that together make it work, and that must not be traded
  against each other:
    - window style 0  -> the script runs with NO console allocated at all
    - False (3rd arg) -> the launcher does not block, so the node can exit(0)
*/
const launcher = swap.buildSilentLauncherScript(scriptPath);
check(
  "the silent launcher starts the swap script with window style 0 (no console)",
  /S\.Run\s+"cmd\.exe \/c\s+""[^"]+""",\s*0,\s*False/.test(launcher),
  launcher.split("\r\n").find((l) => l.startsWith("S.Run")) ?? launcher,
);
check(
  "the silent launcher does not block (the node exits immediately after spawning it)",
  /,\s*0,\s*False\s*$/.test(launcher.trimEnd()),
);
check(
  "the silent launcher wraps the script path in VBScript-doubled quotes",
  /""[A-Za-z]:\\[^"]*update\.bat"""/.test(launcher),
  launcher,
);
// The regression itself: cmd.exe must NOT be the directly-spawned process, and
// the launcher must be a .vbs, because that is what removes the window.
check(
  "the launcher is a .vbs, which has no console to hide in the first place",
  swap.HANDOFF_LAUNCHER.endsWith(".vbs"),
  swap.HANDOFF_LAUNCHER,
);
{
  const source = fsSwap.readFileSync(
    pathSwap.join(ROOT, "src", "update", "swapHandoff.ts"),
    "utf8",
  );
  const spawnBody = /export function spawnDetached[\s\S]*?\n}/.exec(source)?.[0] ?? "";
  check(
    "spawnDetached no longer spawns cmd.exe directly on the non-error path",
    !/spawn\("cmd\.exe"/.test(spawnBody.replace(/child\.on\("error"[\s\S]*?\n {6}\}\);/, "")),
    "a direct cmd.exe spawn would flash a console on every update",
  );
}
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

/*
  THE TEST ROT — WHY THESE EXIST.

  CI rewrites package.json on every push ("chore: bump version to X") and commits it
  back. The suite used to assert that the Mothership's two hardcoded fallback
  versions were EXACTLY EQUAL to package.json, so every single bump turned the suite
  red until somebody hand-edited a file in a different repository. That is the rot.

  Equality was not the only thing tried, and neither replacement worked as a hard
  gate, which is why these tests exist to stop the wrong fixes coming back:
    - "not behind"      still fails on the next bump (the Node moves first);
    - "not behind by N"  fails anyway once the gap grows past N, and the gap grows
                         without bound because only CI edits package.json.
  The cross-repo drift is therefore reported with `warn()`, never `check()`.

  What is asserted HARD here is what this repository actually controls.
*/
{
  const { parseVersion } = await load("dist/version-compare.js");
  /** Mirrors the `lagBehind` helper used against the Mothership above. */
  const lagBehind = (advertised, current) => {
    const a = parseVersion(advertised);
    const c = parseVersion(current);
    if (!a || !c) return null;
    return c[2] - a[2];
  };
  // The exact scenario that used to fail, now with a LARGE gap to prove no fixed
  // tolerance is needed: the Node is 7 releases ahead of the advertised fallback.
  check(
    "the cross-repo fallback drift is MEASURED, never gated on a fixed tolerance",
    lagBehind("1.0.34", "1.0.41") === 7,
    "7 releases of drift is reported, not failed",
  );
  check(
    "an equal version reports zero lag (and is reported as a PASS, not a warning)",
    lagBehind("1.0.35", "1.0.35") === 0,
  );
  check(
    "a fallback AHEAD of this build reports a negative lag and is never 'behind'",
    lagBehind("1.0.36", "1.0.35") === -1,
  );
  check(
    "an unparseable advertised fallback is reported as not-comparable, never guessed",
    lagBehind("unknown", "1.0.35") === null,
  );
  /*
    AND THE REASON THE DRIFT IS HARMLESS: a lagging advertisement cannot actually walk
    the fleet backwards, because the updater refuses an older version outright. This
    is what makes turning the drift into a warning SAFE rather than merely convenient,
    so it is asserted rather than assumed.
  */
  const { APP_VERSION } = await load("dist/version.js");
  // `readFileSync` is destructured from node:fs much further down this file, so
  // reading package.json here would hit the temporal dead zone. `fsSwap` is
  // already in scope from the swap-script block above.
  const manifestVersion = JSON.parse(
    fsSwap.readFileSync(path.join(ROOT, "package.json"), "utf8"),
  ).version;
  check(
    "the running build's version is read from package.json dynamically, not a literal",
    APP_VERSION === manifestVersion,
    `${APP_VERSION} vs ${manifestVersion}`,
  );
  check(
    "a downgrade is still refused outright, which is what makes the drift safe",
    isVersionOlder("1.0.34", "1.0.41") === true,
  );
}
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

// THE EXACT TAG IS INTERPOLATED INTO THE DOWNLOAD URL.
// `browser_download_url` bakes in whatever tag segment was current at upload
// time — the rolling release literally advertises
// `.../releases/download/latest/rippa-node.exe` — but GitHub's download route
// requires the release's EXACT tag in the path. A payload whose `tag_name`
// says `v1.0.37` must never ship a `latest` (or any stale) URL to the fleet.
const staleTagRelease = updater.parseLatestRelease({
  tag_name: "v1.0.37",
  name: "rippa-node 1.0.37",
  assets: [
    {
      name: "rippa-node.exe",
      browser_download_url:
        "https://github.com/Farko420/rippa-node/releases/download/latest/rippa-node.exe",
    },
  ],
});
check(
  "the download URL is rebuilt from the exact release tag, not the stale segment",
  staleTagRelease?.downloadUrl ===
    "https://github.com/Farko420/rippa-node/releases/download/v1.0.37/rippa-node.exe",
  staleTagRelease?.downloadUrl,
);
check(
  "the /releases/latest/download/ shortcut is rebuilt onto the exact tag too",
  updater.releaseAssetDownloadUrl(
    "v1.0.37",
    "rippa-node.exe",
    "https://github.com/o/r/releases/latest/download/rippa-node.exe",
  ) === "https://github.com/o/r/releases/download/v1.0.37/rippa-node.exe",
);
check(
  "a tag containing a slash keeps its path separators (encoded per segment)",
  updater.releaseAssetDownloadUrl(
    "release/1.0.37",
    "rippa-node.exe",
    "https://github.com/o/r/releases/download/latest/rippa-node.exe",
  ) === "https://github.com/o/r/releases/download/release/1.0.37/rippa-node.exe",
);
check(
  "a non-GitHub download URL is passed through byte-for-byte",
  updater.releaseAssetDownloadUrl(
    "v1.0.37",
    "rippa-node.exe",
    "https://example.invalid/node.exe",
  ) === "https://example.invalid/node.exe",
);
// The filename the parsed release advertises is the one the rebuilt URL must
// name — the tag is interpolated, the asset name is preserved (a renamed asset
// like `rippa-node-1.0.16.exe` must still be fetched by ITS OWN name).
const renamedTagRelease = updater.parseLatestRelease({
  tag_name: "v1.0.37",
  name: "rippa-node 1.0.37",
  assets: [
    {
      name: "rippa-node-1.0.16.exe",
      browser_download_url:
        "https://github.com/Farko420/rippa-node/releases/download/latest/rippa-node-1.0.16.exe",
    },
  ],
});
check(
  "a renamed asset keeps its own filename under the exact tag",
  renamedTagRelease?.downloadUrl ===
    "https://github.com/Farko420/rippa-node/releases/download/v1.0.37/rippa-node-1.0.16.exe",
  renamedTagRelease?.downloadUrl,
);
// The SATELLITE side: a trigger whose URL still names a stale tag (an old
// Master passing browser_download_url verbatim) must upgrade by the same rule,
// or mixed-version fleets keep 404ing on exactly this path.
{
  const seen = [];
  const fakeUpdater = {
    applyToSelf: async (release) => {
      seen.push(release);
      return false; // stand down before any destructive step
    },
  };
  const parsed = updater.parseUpdateTrigger({
    command: "SWARM_UPDATE_TRIGGER",
    // NEWER than any version under test: the accept path is what hands a
    // downloadUrl to applyToSelf, and a trigger for the RUNNING build is
    // correctly refused by the downgrade guard instead.
    version: "9.9.9",
    tag: "v9.9.9",
    downloadUrl:
      "https://github.com/Farko420/rippa-node/releases/download/latest/rippa-node.exe",
    issuedBy: "master",
    issuedAt: new Date().toISOString(),
  });
  const verdict = await updater.handleUpdateTrigger(fakeUpdater, parsed);
  check(
    "a stale-tagged trigger is accepted for the newer version",
    verdict.accepted === true,
    JSON.stringify(verdict),
  );
  check(
    "a stale-tagged trigger is rebuilt onto the trigger's exact tag",
    seen[0]?.downloadUrl ===
      "https://github.com/Farko420/rippa-node/releases/download/v9.9.9/rippa-node.exe",
    seen[0]?.downloadUrl,
  );
}

// GITHUB_TOKEN is what makes a PRIVATE repo readable: GitHub answers 404 to every
// unauthenticated request, which is indistinguishable from "no release yet". The
// accepted names are asserted so the CI secret name cannot silently stop working.
const savedTokens = {
  ota: process.env.GITHUB_OTA_TOKEN,
  rippa: process.env.RIPPA_GITHUB_TOKEN,
  gh: process.env.GITHUB_TOKEN,
  cli: process.env.GH_TOKEN,
};
delete process.env.GITHUB_OTA_TOKEN;
delete process.env.RIPPA_GITHUB_TOKEN;
delete process.env.GITHUB_TOKEN;
delete process.env.GH_TOKEN;

check("no token resolves to an empty string", updater.resolveGitHubToken() === "");
// Deleted in turn, so each name is proven to work on its OWN rather than being
// shadowed by one that outranks it.
process.env.GITHUB_OTA_TOKEN = "ghp_ota_specific";
check(
  "GITHUB_OTA_TOKEN is accepted (the documented OTA name)",
  updater.resolveGitHubToken() === "ghp_ota_specific",
);
delete process.env.GITHUB_OTA_TOKEN;
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
  "RIPPA_GITHUB_TOKEN is accepted",
  updater.resolveGitHubToken() === "node_specific",
);

// THE PRIORITY ORDER IS LOAD-BEARING. `GITHUB_TOKEN`/`GH_TOKEN` are routinely set
// on build agents and dev machines for reasons that have nothing to do with OTA,
// so GITHUB_OTA_TOKEN — the one name that exists solely to authenticate release
// downloads — must outrank them, or a CI credential without access to this
// PRIVATE repository would win and the download would 404 with no explanation.
process.env.GITHUB_OTA_TOKEN = "ghp_ota_wins";
check(
  "GITHUB_OTA_TOKEN wins over RIPPA_GITHUB_TOKEN / GITHUB_TOKEN / GH_TOKEN",
  updater.resolveGitHubToken() === "ghp_ota_wins",
);
delete process.env.GITHUB_OTA_TOKEN;
delete process.env.RIPPA_GITHUB_TOKEN;
process.env.RIPPA_GITHUB_TOKEN = "node_specific";
check(
  "RIPPA_GITHUB_TOKEN wins over GITHUB_TOKEN / GH_TOKEN",
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
  ["GITHUB_OTA_TOKEN", savedTokens.ota],
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
  delete process.env.GITHUB_OTA_TOKEN;
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
      lines.some(
        (l) =>
          l.includes("GITHUB_OTA_TOKEN") &&
          l.includes("RIPPA_GITHUB_TOKEN") &&
          l.includes("GITHUB_TOKEN"),
      ),
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
    // The strict, named diagnosis. Without it a 401 is just a number, and the
    // operator has to guess WHICH env var the node is actually reading.
    check(
      "a 401 emits the strict GITHUB_OTA_TOKEN hint",
      lines.some((l) => l.includes(ghAsset.OTA_404_HINT)),
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
    check(
      "a 404 emits the strict GITHUB_OTA_TOKEN hint verbatim",
      lines.some((l) => l.includes(ghAsset.OTA_404_HINT)),
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
  // THE DOCUMENTED NAME, deliberately. This block is the end-to-end proof for the
  // token operators are told to set, so using a secondary alias here would leave
  // the documented name unproven precisely where the 404 was being reported.
  process.env.GITHUB_OTA_TOKEN = "ghp_private_repo";
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
    // The two headers GitHub requires on an asset-by-ID download. Omitting the
    // API version is the quiet failure mode: GitHub answers 200 with JSON
    // metadata instead of bytes, and the node rejects it as "not an executable".
    check(
      "the asset download pins the GitHub API version",
      resolved?.headers?.["X-GitHub-Api-Version"] === "2022-11-28",
      JSON.stringify(resolved?.headers),
    );
    check(
      "the asset download carries the bearer token",
      resolved?.headers?.["Authorization"] === "Bearer ghp_private_repo",
      JSON.stringify(resolved?.headers),
    );
    check("the metadata lookup carries the bearer token", sentAuth === "Bearer ghp_private_repo");
    check(
      "the metadata lookup goes to the releases API",
      askedFor === "https://api.github.com/repos/Farko420/rippa-node/releases/latest",
      askedFor,
    );

    // THE UPDATER HALF OF THE SAME 404. `resolveGitHubAssetDownload` was
    // already resolving this endpoint and logging it — but SwarmUpdater kept
    // only the HEADERS and streamed the ORIGINAL github.com URL, which 404s
    // on a private repo even WITH the token attached. The resolved URL must
    // reach the stream, so it is returned together with the headers.
    const swarm = Object.create(updater.SwarmUpdater.prototype);
    const target = await swarm.resolveReleaseDownload({ downloadUrl: SHORTCUT });
    check(
      "the swarm updater streams the resolved API asset endpoint, not the original URL",
      target.url === "https://api.github.com/repos/Farko420/rippa-node/releases/assets/9",
      target.url,
    );
    check(
      "the swarm updater's request carries octet-stream and the bearer token",
      target.headers.Accept === "application/octet-stream" &&
        target.headers.Authorization === "Bearer ghp_private_repo",
      JSON.stringify(target.headers),
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
    // RESTORED, not blindly deleted: the ambient token may be the operator's real
    // one, and the "without a token" assertions immediately below only hold when
    // all four names really are absent.
    delete process.env.GITHUB_OTA_TOKEN;
    delete process.env.RIPPA_GITHUB_TOKEN;
    if (savedTokens.ota !== undefined) process.env.GITHUB_OTA_TOKEN = savedTokens.ota;
    if (savedTokens.rippa !== undefined) process.env.RIPPA_GITHUB_TOKEN = savedTokens.rippa;
  }
}

// The next assertions are about the NO-token branch, so every alias must be gone.
for (const key of [
  "GITHUB_OTA_TOKEN",
  "RIPPA_GITHUB_TOKEN",
  "GITHUB_TOKEN",
  "GH_TOKEN",
]) {
  delete process.env[key];
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
/*
  THE CONFIG-MANAGER HALF. `resolveGitHubToken` reading the environment is only
  half the fix: a packaged node's token can live in `config.json` instead of
  `.env`, and `writeConfig` normalises and writes whatever `normalizeConfig`
  returns — it is NOT a merge. A field missing from that function is DELETED on
  the next GUI save, so an operator who set the token and then changed an
  unrelated setting would silently lose it and OTA would 404 again an hour later.
*/
{
  const cfgMod = await load("dist/config/configManager.js");
  const osMod = await import("node:os");
  const nodeFs = await import("node:fs");
  const dir = nodeFs.mkdtempSync(path.join(osMod.tmpdir(), "rippa-ota-token-"));
  try {
    cfgMod.writeConfig(dir, {
      NODE_ROLE: "master",
      NODE_NAME: "Token Master",
      NODE_API_KEY: "verify-master-key-0001",
      MOTHERSHIP_URL: "https://rippaadventures.com",
      GITHUB_OTA_TOKEN: "ghp_survives_a_save",
    });
    check(
      "GITHUB_OTA_TOKEN is persisted to config.json",
      cfgMod.readConfig(dir)?.GITHUB_OTA_TOKEN === "ghp_survives_a_save",
      cfgMod.readConfig(dir)?.GITHUB_OTA_TOKEN,
    );
    // The round trip that actually matters: rewrite what is on disk, exactly as a
    // GUI save does, and confirm the token is still there afterwards.
    cfgMod.writeConfig(dir, { ...cfgMod.readConfig(dir) });
    check(
      "GITHUB_OTA_TOKEN survives a full config rewrite (a GUI save cannot drop it)",
      cfgMod.readConfig(dir)?.GITHUB_OTA_TOKEN === "ghp_survives_a_save",
      cfgMod.readConfig(dir)?.GITHUB_OTA_TOKEN,
    );
    check(
      "applyConfigToEnv publishes the token to process.env so the updater can read it",
      (() => {
        delete process.env.GITHUB_OTA_TOKEN;
        cfgMod.applyConfigToEnv(cfgMod.readConfig(dir), true);
        return process.env.GITHUB_OTA_TOKEN === "ghp_survives_a_save";
      })(),
      process.env.GITHUB_OTA_TOKEN,
    );
  } finally {
    delete process.env.GITHUB_OTA_TOKEN;
    nodeFs.rmSync(dir, { recursive: true, force: true });
  }
}

/*
  THE MANAGED-OLLAMA FLAG MUST SURVIVE A RESTART — the reported regression.

  Symptom: after the Watchdog restarted the node (e.g. following an OTA swap) it
  came back unmanaged, logged `Ollama: http://127.0.0.1:11434` and then "No usable
  local model found — staying a standard node".

  There were TWO independent causes, and only fixing one leaves the bug alive:

    1. The Control Panel's "managed" toggle only mutated an in-memory field.
       Nothing was ever written, so no restart could preserve it.
    2. Even once written, `normalizeConfig` REBUILDS the config object and is not a
       merge — so any field it does not name is DELETED on the next GUI save. A
       flag persisted without being carried through here survives exactly until
       the operator changes an unrelated setting, which is far harder to notice.

  These assertions pin the persistence contract end to end. The Watchdog's `cwd`
  fix (which is what made `.env` invisible) is asserted separately in
  verify-watchdog.mjs, because it is a different file and a different failure.
*/
{
  const cfgMod = await load("dist/config/configManager.js");
  const osMod = await import("node:os");
  const nodeFs = await import("node:fs");
  const dir = nodeFs.mkdtempSync(path.join(osMod.tmpdir(), "rippa-managed-flag-"));
  const prevEnvFlag = process.env.RIPPA_OLLAMA_MANAGED;
  try {
    delete process.env.RIPPA_OLLAMA_MANAGED;
    cfgMod.writeConfig(dir, {
      NODE_ROLE: "master",
      NODE_NAME: "Managed Flag Node",
      NODE_API_KEY: "verify-master-key-0001",
      MOTHERSHIP_URL: "https://rippaadventures.com",
      DASHBOARD_PIN: "4242",
      PORT: 4000,
      OLLAMA_MANAGED: true,
    });
    check(
      "the managed-Ollama flag is written to config.json",
      cfgMod.readConfig(dir)?.OLLAMA_MANAGED === true,
    );

    // The `normalizeConfig` half — the one that silently deletes on a GUI save.
    const renamed = cfgMod.normalizeConfig({ ...cfgMod.readConfig(dir), NODE_NAME: "Renamed" });
    check(
      "normalizeConfig CARRIES OLLAMA_MANAGED through (an unrelated GUI save cannot delete it)",
      renamed.OLLAMA_MANAGED === true,
      `NODE_NAME was changed in the same save; OLLAMA_MANAGED=${renamed.OLLAMA_MANAGED}`,
    );
    cfgMod.writeConfig(dir, renamed);
    check(
      "the flag survives a full write after an unrelated save",
      cfgMod.readConfig(dir)?.OLLAMA_MANAGED === true,
    );

    // A restart is a fresh read from disk with NO environment variable at all —
    // exactly the state the Watchdog produced after an OTA swap.
    delete process.env.RIPPA_OLLAMA_MANAGED;
    const afterRestart = cfgMod.readConfig(dir);
    check(
      "the flag survives a restart with no env var set (the post-OTA-swap case)",
      afterRestart?.OLLAMA_MANAGED === true,
      "config.json alone must be able to restore supervision",
    );

    // A hand-edited string must not read as enabled, or a corrupt config would
    // silently start spawning servers nobody asked for.
    check(
      'the string "false" does NOT read as managed',
      cfgMod.normalizeConfig({ ...afterRestart, OLLAMA_MANAGED: "false" }).OLLAMA_MANAGED === false,
    );
    check(
      "an absent flag defaults to unmanaged (the safe direction)",
      cfgMod.normalizeConfig({ ...afterRestart, OLLAMA_MANAGED: undefined }).OLLAMA_MANAGED === false,
    );
  } finally {
    if (prevEnvFlag === undefined) delete process.env.RIPPA_OLLAMA_MANAGED;
    else process.env.RIPPA_OLLAMA_MANAGED = prevEnvFlag;
    nodeFs.rmSync(dir, { recursive: true, force: true });
  }
}

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

  /*
    THE CROSS-REPO FALLBACKS ARE ADVISORY, NOT A GATE. THIS IS THE ACTUAL FIX FOR
    THE TEST ROT, and it took three attempts to get right, so the reasoning matters.

    Attempt 1 — assert EQUALITY. Unsatisfiable: CI rewrites package.json on every
    push, the constant lives in a sibling repo, so the build went red every release.

    Attempt 2 — assert "NOT BEHIND". Also unsatisfiable, for the same reason: the
    Node always moves first, so any directional check fails on the next bump. This
    one only *relocated* the rot. Verified by simulating a bump to 1.0.41.

    Attempt 3 — assert "not behind by more than N". Better, but STILL unsatisfiable
    in the limit: because the Node auto-bumps on every push and the constant only
    moves when a human edits it, the gap grows without bound. Any fixed N is a
    countdown to the same red build, which is the reported symptom wearing a new hat.

    THE REAL INSIGHT: this assertion is about a file in a DIFFERENT repository that
    this build cannot change. There is no code fix that makes it satisfiable, and no
    tolerance that stays satisfied. So it must not be a gate — an operator cannot
    fix it from this repo, and a gate they cannot fix trains them to ignore the
    whole suite, taking every load-bearing check with it.

    What is genuinely load-bearing, and is still asserted HARD below:
      - the advertised asset name (a rename really would break every download);
      - this repo reading its own version dynamically from package.json;
      - the exact 1.0.13 regression, which is still refused outright.
    The drift is still REPORTED, as a WARN, so it stays visible and actionable.
  */
  const { parseVersion } = await load("dist/version-compare.js");
  const advertisedFallback = /const FALLBACK_VERSION = "([^"]+)"/.exec(mothershipFeed)?.[1] ?? "";
  // The APK route has its OWN last-resort label, and it is the one a tablet
  // actually reads: `/api/node/latest-apk` is the FIRST route the mobile worker
  // tries. When `LATEST_APK_VERSION` is unpinned this constant is the number an
  // operator sees next to a working download URL.
  const advertisedApkFallback =
    /const FALLBACK_APK_VERSION = "([^"]+)"/.exec(mothershipFeed)?.[1] ?? "";
  const nodeVersion = String(nodeManifest.version ?? "");

  /** How far the advertised fallback has drifted behind this build. */
  const lagBehind = (advertised, current) => {
    const a = parseVersion(advertised);
    const c = parseVersion(current);
    if (!a || !c) return null; // not comparable — say nothing rather than guess
    return c[2] - a[2];
  };

  for (const [label, advertised] of [
    ["FALLBACK_VERSION", advertisedFallback],
    ["FALLBACK_APK_VERSION", advertisedApkFallback],
  ]) {
    const lag = lagBehind(advertised, nodeVersion);
    if (lag === null) {
      warn(`the Mothership's ${label} (${advertised}) could not be compared to ${nodeVersion}`);
    } else if (lag > 0) {
      warn(
        `the Mothership's ${label} (${advertised}) is ${lag} release(s) behind this build (${nodeVersion})`,
        "informational only — it lives in the Mothership repo and is overridden by " +
          "LATEST_NODE_VERSION/LATEST_APK_VERSION. Harmless: the updater refuses " +
          "downgrades. Update it in the Mothership repo if the number is user-visible.",
      );
    } else {
      check(
        `the Mothership's ${label} (${advertised}) is not behind package.json (${nodeVersion})`,
        true,
      );
    }
  }
  // The advertised URL must name the asset the workflow actually publishes, because
  // `/releases/latest/download/<asset>` is a literal filename lookup.
  check(
    "the Mothership advertises the exact published asset name",
    /const ROLLING_DOWNLOAD_URL =[\s\S]*?releases\/latest\/download\/rippa-node\.exe/.test(mothershipFeed),
  );
}

// --- THE APK's OWN PACKAGE ID, PINNED --------------------------------------
/*
 * `MobileBridge.assertItIsThisApp()` REFUSES any APK whose package name is not
 * this app's, and reports it as "Refusing to install <other>: this updater only
 * installs com.rippaadventures.node". That message is the guard WORKING: the
 * running app is ours, and the file it downloaded was built under someone else's
 * ID. Android also refuses such an install outright (a different ID is a
 * different app, and an update must keep the ID), so the refusal is correct and
 * must stay.
 *
 * What this pins is the OTHER half: that nothing in the build config reintroduces
 * the foreign ID in the first place. A stray `com.rippaadventures.app` (the
 * consumer app ID that caused the "Refusing to install" OTA outage) or a legacy
 * `com.codelink.app` in an applicationId or a capacitor appId would build an APK
 * that this very gate then refuses to install — a self-inflicted, entirely
 * silent update outage.
 */
{
  const gradle = readFileSync(path.join(ROOT, "mobile", "android", "app", "build.gradle"), "utf8");
  const capacitor = readFileSync(path.join(ROOT, "mobile", "capacitor.config.json"), "utf8");

  check(
    "the APK's applicationId and namespace are com.rippaadventures.node",
    gradle.includes('applicationId "com.rippaadventures.node"') &&
      gradle.includes('namespace "com.rippaadventures.node"'),
  );
  check("the capacitor appId is com.rippaadventures.node", /"appId"\s*:\s*"com\.rippaadventures\.node"/.test(capacitor));

  // The negative case, over every text file in the repo, because the ID can leak
  // in through a file nothing else here reads.
  const tracked = execSync(
    "git ls-files",
    { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, windowsHide: true },
  )
    .split(/\r?\n/)
    .filter(Boolean);
  const offenders = tracked.filter((file) => {
    if (!/\.(ts|js|mjs|json|xml|gradle|html|java|kt|yml|yaml|md|properties)$/i.test(file)) return false;
    // This file necessarily CONTAINS the pattern it searches for, so it would
    // otherwise report itself as the offender on every run.
    if (path.resolve(ROOT, file) === path.resolve(fileURLToPath(import.meta.url))) return false;
    try {
      const text = readFileSync(path.join(ROOT, file), "utf8");
      // `com.rippaadventures.app` is a prefix of nothing expected here, but it IS
      // a substring trap for `com.rippaadventures.appX` future IDs — so match on
      // a boundary (quote, whitespace, end) rather than a bare substring. The
      // scripts/package-apk.mjs allow-list (constants + error copy) is exempted
      // by filename below.
      if (/com\.rippaadventures\.app(?=["'\s]|$)/.test(text)) {
        if (path.resolve(ROOT, file) === path.join(ROOT, "scripts", "package-apk.mjs")) return false;
        return true;
      }
      return /com\.codelink\.app/.test(text);
    } catch {
      return false;
    }
  });
  check(
    "no source file reintroduces a foreign package (com.rippaadventures.app / com.codelink.app)",
    offenders.length === 0,
    offenders.join(", "),
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

// --- 8h. THE REFUSED DOWNGRADE MUST BE RETIRED, NOT RETRIED -------------------
/*
 * The reported loop: the Mothership advertised v1.0.16 to a node running
 * v1.0.19. The node refused correctly, but the refusal was reported as a bare
 * `false` — and the queue entry it belonged to stayed outstanding, so
 * `drainNodeCommands` handed the same FORCE_UPDATE back on every heartbeat,
 * forever. These checks pin the three things that break that loop:
 *
 *   1. the updater returns a DISTINCT signal for "refused because I am newer",
 *      so the executor can tell it apart from a transient download failure;
 *   2. the executor turns that signal into a terminal acknowledgement carrying
 *      the command id — the only thing that clears the cloud's row;
 *   3. the Mothership's pre-check stops the NEXT command being written at all.
 *
 * (1) is asserted at the source because the guard sits inside a private method
 * behind a network call, and (2)/(3) are exercised for real.
 */
check(
  "OtaUpdater's downgrade guard returns the distinct rejected_downgrade signal",
  /return\s+"rejected_downgrade"/.test(otaSource),
);
check(
  "forceUpdate and applyIfNewer both declare the rejected_downgrade return",
  (otaSource.match(/Promise<boolean \| "rejected_downgrade">/g) ?? []).length >= 2,
  `${(otaSource.match(/Promise<boolean \| "rejected_downgrade">/g) ?? []).length} declaration(s)`,
);

resetExecutedCommands();
const downgradeAcks = [];
await executePendingCommands([{ id: "dg-ack-1", command: "FORCE_UPDATE" }], {
  ...ackBase,
  forceUpdate: () => "rejected_downgrade",
  acknowledgeCommand: (command, detail, context) => downgradeAcks.push({ command, detail, context }),
});
check(
  "a refused downgrade is acknowledged with a terminal rejected_downgrade status",
  downgradeAcks.length === 2 && downgradeAcks[1].context?.status === "rejected_downgrade",
  JSON.stringify(downgradeAcks.map((a) => a.context?.status)),
);
check(
  "the downgrade acknowledgement still carries the command id (what clears the row)",
  downgradeAcks[1]?.context?.commandId === "dg-ack-1",
  JSON.stringify(downgradeAcks[1]?.context),
);
check(
  "the downgrade acknowledgement is NOT filed as a generic failure the cloud may retry",
  downgradeAcks[1]?.context?.status !== "failed",
  downgradeAcks[1]?.context?.status,
);

// --- 8i. THE MESH POLL TIMEOUT IS 15s AND NAMES ITS TARGET --------------------
/*
 * The reported symptom was `[Swarm] Mesh poll failed — timeout of 8000ms
 * exceeded` with no URL, which made it impossible to tell a slow Mothership
 * (serverless cold start) from a dead local peer. Both halves are asserted at
 * the source: the constant, and the log line that interpolates the target.
 */
const dispatcherSource = readFileSync(
  path.join(ROOT, "src", "services", "swarmDispatcher.ts"),
  "utf8",
);
check(
  "the mesh poll timeout is raised to 15s for serverless cold starts",
  /const MESH_HTTP_TIMEOUT_MS = 15_000;/.test(dispatcherSource),
  /const MESH_HTTP_TIMEOUT_MS = \S+;/.exec(dispatcherSource)?.[0],
);
check(
  "the mesh poll failure log names the target URL",
  dispatcherSource.includes("`[Swarm] Mesh poll to ${targetUrl} failed — timeout of 15000ms exceeded`"),
);
check(
  "no 8000ms mesh poll timeout remains in the dispatcher",
  !/timeout: 8000/.test(dispatcherSource),
);

const mobileWorkerSource = readFileSync(
  path.join(ROOT, "src", "satellite", "mobile-worker.ts"),
  "utf8",
);
check(
  "the mobile satellite's Master poll uses the same 15s timeout",
  /timeout: 15000/.test(mobileWorkerSource) && !/timeout: 8000/.test(mobileWorkerSource),
);

// --- 8j. THE MOTHERSHIP'S TWO HALVES OF THE LOOP FIX --------------------------
/*
 * Both live in the sibling "Rippa Adventures" repository, so these are skipped
 * on a standalone Node clone (the same rule section 8f uses) rather than failing
 * on a path this repository does not own.
 *
 * WHAT IS BEING GUARDED. The node's `rejected_downgrade` ack settles the row
 * that already exists; the pre-check stops a NEW one being written. Ship the
 * node half without the cloud half and the loop simply moves one heartbeat
 * later, which is why both are asserted here rather than only in the Node.
 */
if (mothershipPresent) {
  const mothershipSwarm = readFileSync(
    path.join(ROOT, "..", "Rippa Adventures", "src", "lib", "swarm.ts"),
    "utf8",
  );
  const mothershipAdmin = readFileSync(
    path.join(ROOT, "..", "Rippa Adventures", "src", "lib", "swarm-admin.functions.ts"),
    "utf8",
  );
  const mothershipServer = readFileSync(
    path.join(ROOT, "..", "Rippa Adventures", "src", "lib", "swarm.server.ts"),
    "utf8",
  );
  const mothershipFeed = readFileSync(mothershipFeedPath, "utf8");

  check(
    "the Mothership settles a rejected_downgrade ack instead of leaving it outstanding",
    mothershipSwarm.includes('status === "rejected_downgrade"'),
  );
  check(
    "the Mothership pre-checks the node's reported version before queueing a force_ota_update",
    /*
      ASSERTED AGAINST `swarm.server.ts`, NOT `swarm-admin.functions.ts`.

      This check used to read the admin handler, and it failed there for a
      legitimate reason: the pre-check was DELIBERATELY removed from the admin
      button's own path so a human pressing "Force" is never told "already
      current" by a stale constant (see the long note in `swarm-admin.functions.ts`
      above `enqueueNodeCommand`).

      The gate still exists — it just moved down one layer into
      `shouldQueueOtaUpdate` in `swarm.server.ts`, where it runs for every
      unattended caller and at redelivery. Pinning the check to the file the
      gate actually lives in keeps the real guarantee (an unattended OTA command
      is not queued to a node that is already current) without asserting a
      behaviour the Mothership chose to remove on purpose.
    */
    mothershipServer.includes('command !== "force_ota_update"') &&
      mothershipServer.includes("readNodeReportedVersion") &&
      /compareVersions\(reported, target\)/.test(mothershipServer),
  );
  check(
    "the heartbeat carries the node's version so the pre-check has something to read",
    mothershipServer.includes("capability_version = COALESCE(?, capability_version)") &&
      mothershipSwarm.includes("version: normaliseShortText(source.version"),
  );
  check(
    "the Mothership exposes the same target-version answer to the pre-check",
    /*
      ACCEPTS BOTH SIGNATURES. The sibling repo shipped this resolver as a plain
      `function … : string` when the check was written and later made it async
      (`Promise<string | null>` — a DB-backed read). The guarantee being pinned
      is that the ANSWER is exported for the pre-check, not its arity, so a
      signature change there must not read as a missing export here.
    */
    /export (?:async )?function resolveTargetNodeVersion\(/.test(mothershipFeed),
  );
}

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

// ===========================================================================
// ARTIFACT-DRIVEN OTA — the latest SUCCESSFUL BUILD, not the latest tag.
//
// This is the behaviour that replaces the old "wait for a SemVer release" rule:
// every push to main publishes a workflow artifact, and the fleet installs the
// newest successful one by comparing monotonic RUN IDs.
// ===========================================================================
const actions = await load("dist/update/actionsArtifact.js");

check(
  "the runs query targets main and asks only for successful runs",
  actions.workflowRunsApiUrl("Farko420/rippa-node", "main") ===
    "https://api.github.com/repos/Farko420/rippa-node/actions/runs?branch=main&status=success&per_page=10",
  actions.workflowRunsApiUrl("Farko420/rippa-node", "main"),
);

check(
  "the artifact list endpoint is built from the run id",
  actions.workflowRunArtifactsApiUrl("o/r", 4242) ===
    "https://api.github.com/repos/o/r/actions/runs/4242/artifacts",
);

check(
  "the download endpoint is the artifact zip (always an archive)",
  actions.workflowArtifactZipApiUrl("o/r", 99) ===
    "https://api.github.com/repos/o/r/actions/artifacts/99/zip",
);

// THE CORE REGRESSION GUARD: the newest SUCCESSFUL run wins even when a newer
// run exists that failed. Installing a failed build's partial artifact is
// exactly the failure this ordering exists to prevent.
const RUNS = {
  workflow_runs: [
    { id: 30, status: "completed", conclusion: "failure", head_sha: "aaa" },
    { id: 29, status: "completed", conclusion: "success", head_sha: "bbb", display_title: "fix: scraper" },
    { id: 28, status: "in_progress", conclusion: null, head_sha: "ccc" },
    { id: 20, status: "completed", conclusion: "success", head_sha: "ddd" },
  ],
};
check(
  "the newest SUCCESSFUL run wins, skipping newer failed/in-flight runs",
  actions.pickNewestSuccessfulRun(RUNS)?.id === 29,
  JSON.stringify(actions.pickNewestSuccessfulRun(RUNS)),
);
check(
  "an empty or malformed runs payload yields no run (not a crash)",
  actions.pickNewestSuccessfulRun({ workflow_runs: [] }) === null &&
    actions.pickNewestSuccessfulRun(null) === null &&
    actions.pickNewestSuccessfulRun({}) === null,
);

// The workflow uploads SEVERAL artifacts; picking the APK over the worker, or
// the watchdog over the worker, is a silent total failure.
const ARTIFACTS = {
  artifacts: [
    { id: 1, name: "rippa-satellite-apk" },
    { id: 2, name: "rippa-node-windows", size_in_bytes: 5 },
  ],
};
check(
  "the exact windows artifact is chosen over the APK",
  actions.selectWorkflowArtifact(ARTIFACTS)?.id === 2,
  JSON.stringify(actions.selectWorkflowArtifact(ARTIFACTS)),
);
check(
  "an EXPIRED artifact is skipped (GitHub lists it but 410s the download)",
  actions.selectWorkflowArtifact({
    artifacts: [{ id: 5, name: "rippa-node-windows", expired: true }],
  }) === null,
);
check(
  "a renamed artifact still resolves via the .zip/.exe fallbacks",
  actions.selectWorkflowArtifact({ artifacts: [{ id: 6, name: "build.zip" }] })?.id === 6,
);

// THE FRESHNESS RULE. Run IDs decide when both sides have one — this is the
// whole point, because two CI builds routinely share a package.json version.
const dep = (runId, version) => ({ tag: "t", version, downloadUrl: "https://x/y.zip", runId });
check(
  "a newer run id installs even when the VERSION is identical",
  updater.isDeploymentNewer(dep(31, "1.0.24"), 30) === true,
);
check(
  "the same run id is not an update (no restart loop)",
  updater.isDeploymentNewer(dep(30, "1.0.24"), 30) === false,
);
check(
  "an OLDER run id is refused even when the version looks newer",
  updater.isDeploymentNewer(dep(29, "9.9.9"), 30) === false,
);
const version = await load("dist/version.js");
check(
  "with no local run id it falls back to SemVer (never a blind install)",
  updater.isDeploymentNewer(dep(null, "9.9.9"), 30) === true &&
    updater.isDeploymentNewer({ tag: "t", version: "1.0.24", downloadUrl: "https://x" }, null) ===
      version.isVersionNewer("1.0.24"),
);

// --- 8k. THE RESOURCE GOVERNOR'S TWO HALVES OF THE DEVICE SHADOW -------------
/*
 * THE NODE HALF IS ASSERTED FOR REAL in verify-governor.mjs (presets, schedules,
 * the pushed-config parser, and the engine's concurrency ceiling). This section
 * pins the CLOUD half, which lives in the sibling "Rippa Adventures"
 * repository and is therefore skipped on a standalone Node clone — the same
 * rule 8f and 8j follow.
 *
 * WHY BOTH HALVES ARE ASSERTED TOGETHER. The node can apply a config perfectly
 * and still have the fleet screen show it as un-applied if the cloud never
 * reads the echo, and the cloud can hold a perfect desired config that no node
 * ever receives if the heartbeat reply forgets to carry it. Shipping one half
 * looks like a working feature that silently does nothing, which is why the
 * pairing is checked rather than each side alone.
 */
if (mothershipPresent) {
  const mothershipNodePower = readFileSync(
    path.join(ROOT, "..", "Rippa Adventures", "src", "lib", "node-power.ts"),
    "utf8",
  );
  const mothershipServer = readFileSync(
    path.join(ROOT, "..", "Rippa Adventures", "src", "lib", "swarm.server.ts"),
    "utf8",
  );
  const mothershipMigrate = readFileSync(
    path.join(ROOT, "..", "Rippa Adventures", "src", "lib", "d1-ensure.server.ts"),
    "utf8",
  );
  const nodeHeartbeat = readFileSync(path.join(ROOT, "src", "network", "SwarmClient.ts"), "utf8");
  const nodeSync = readFileSync(path.join(ROOT, "src", "services", "powerConfigSync.ts"), "utf8");

  check(
    "the Mothership owns the same closed set of power modes",
    /POWER_MODES = \["auto", "low", "medium", "high", "custom"\]/.test(mothershipNodePower),
  );
  check(
    "the cloud echoes the desired config ONLY while the node is out of sync",
    mothershipServer.includes("isPowerConfigInSync(desiredStamp, powerConfigAppliedAt)") &&
      mothershipServer.includes("power_config: desiredConfig"),
  );
  check(
    "the cloud records the node's applied stamp with COALESCE (old firmware cannot blank it)",
    mothershipServer.includes("power_config_applied_at = COALESCE(?, power_config_applied_at)"),
  );
  check(
    "the boot chain adds the three shadow columns behind a PRAGMA guard",
    mothershipMigrate.includes('addColumnIfMissing("power_config", "power_config TEXT")') &&
      mothershipMigrate.includes('addColumnIfMissing("power_config_updated_at"') &&
      mothershipMigrate.includes('addColumnIfMissing("power_config_applied_at"'),
  );
  check(
    "the node echoes the stamp it applied on every heartbeat",
    nodeHeartbeat.includes("power_config_applied_at: this.readPowerConfigApplied()"),
  );
  check(
    "the node reads the stamp WITHOUT parsing it (opaque token, no clock coupling)",
    nodeSync.includes("power_config_updated_at") && !/Date\.parse\(\s*rawStamp/.test(nodeSync),
  );
}

// The idlers above are console noise from the node itself; the summary is the
// result. The idle forager's "runPass is not a function" line is this harness's
// stub forager being deliberately minimal, not a product fault.
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
process.exit(failed.length ? 1 : 0);