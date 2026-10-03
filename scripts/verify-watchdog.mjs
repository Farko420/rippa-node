import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { ROOT, check, results } from "./verify-harness.mjs";

/**
 * RIPPA WATCHDOG — behaviour tests against the COMPILED `dist/watchdog.js`.
 *
 * WHY THIS IS SEPARATE FROM verify-units.mjs
 *
 * The watchdog is the only component whose correctness is a property of its
 * behaviour over TIME rather than of a function's return value. Getting the
 * exit-code constants right proves nothing about what happens when a child exits
 * with 42 rather than 1. So this file mocks nothing: it builds a tiny fake
 * `rippa-node.exe` that exits with whatever the test scripts, points the real
 * watchdog at it via RIPPA_NODE_EXE, and asserts on what the watchdog DOES.
 *
 * That is the only way to catch the failure that matters most here — a watchdog
 * that treats a deliberate shutdown as a crash and restarts the node in a loop,
 * or that fails to bring a crashed node back — and neither is visible in a unit
 * test of a pure function.
 *
 * EVERY TEST RUNS AGAINST A TEMP DATA DIRECTORY. The watchdog writes a lock file
 * and a log into the per-user data directory unless RIPPA_DATA_DIR overrides it,
 * and these tests must not take that lock away from a developer's own running
 * node, nor leave one behind that blocks it afterwards.
 *
 * Run with: npm run test:watchdog
 */
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rippa-watchdog-"));
process.env.RIPPA_DATA_DIR = dataDir;

const load = (rel) => import(`file://${path.join(ROOT, rel).replace(/\\/g, "/")}`);
const watchdog = await load("dist/watchdog.js");
const exitCodes = await load("dist/update/exitCodes.js");

const fakeNode = path.join(dataDir, "fake-rippa-node.js");
const queueFile = path.join(dataDir, "codes.json");
const ranFile = path.join(dataDir, "runs.log");

fs.writeFileSync(
  fakeNode,
  [
    // Exits with the next code the test scripted, and records that it ran. The
    // queued codes are consumed one per launch, so a test can drive a SEQUENCE of
    // exits (42 then 1, say) against a single watchdog process.
    "const fs = require('node:fs');",
    `const queueFile = ${JSON.stringify(queueFile)};`,
    `const ranFile = ${JSON.stringify(ranFile)};`,
    "const codes = JSON.parse(fs.readFileSync(queueFile, 'utf8'));",
    "const next = codes.length > 1 ? codes.shift() : codes[0];",
    "fs.writeFileSync(queueFile, JSON.stringify(codes));",
    "fs.appendFileSync(ranFile, String(process.argv[2] ?? 'no-arg') + '\\n');",
    "process.exit(Number(next));",
  ].join("\n"),
  "utf8",
);

/**
 * Runs the compiled watchdog as a child process against the fake worker.
 *
 * THE FAKE WORKER IS `node.exe` PLUS A SCRIPT, NOT A `.cmd` SHIM. Node refuses to
 * spawn a `.cmd` without `shell: true` (EINVAL since the CVE-2024-27980 fix), so
 * a batch shim would test the watchdog's error handling rather than its
 * supervision. `RIPPA_NODE_EXE` therefore points at the real Node binary and the
 * fake worker script is passed as a FORWARDED ARGUMENT — which doubles as proof
 * that the watchdog relays its own arguments to the worker, since a node started
 * with `--config <path>` must come back with it.
 *
 * `codes` is a queue: each child exit consumes one entry, so one watchdog process
 * can be made to live through several restarts. `stdio: "pipe"` is what lets
 * these tests read the watchdog's log lines, which are the only observable
 * evidence of which branch it took.
 */
function runWatchdog(codes, { nodeArgs = [], timeoutMs = 30_000 } = {}) {
  return new Promise((resolve) => {
    fs.writeFileSync(queueFile, JSON.stringify([...codes]), "utf8");
    fs.rmSync(ranFile, { force: true });

    const child = spawn(
      process.execPath,
      [path.join(ROOT, "dist", "watchdog.js"), fakeNode, ...nodeArgs],
      {
        env: {
          ...process.env,
          RIPPA_NODE_EXE: process.execPath,
          RIPPA_DATA_DIR: dataDir,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    let output = "";
    child.stdout.on("data", (c) => {
      output += c;
    });
    child.stderr.on("data", (c) => {
      output += c;
    });

    // Kill the watchdog however this case ends. A supervisor test that left a
    // process tree running would hold the singleton lock and make every LATER
    // test fail for the wrong reason.
    const killer = setTimeout(() => child.kill(), timeoutMs);
    child.on("exit", (code) => {
      clearTimeout(killer);
      const runs = fs.existsSync(ranFile)
        ? fs.readFileSync(ranFile, "utf8").trim().split(/\r?\n/).filter(Boolean)
        : [];
      resolve({ code, output, runs });
    });
  });
}
// --- 1. The protocol constants ----------------------------------------------
check(
  "a crash waits 5 seconds before restarting",
  watchdog.CRASH_BACKOFF_MS === 5_000,
  `${watchdog.CRASH_BACKOFF_MS}ms`,
);
check(
  "the swap waits for the image lock to clear",
  watchdog.SWAP_LOCK_GRACE_MS >= 1_000,
  `${watchdog.SWAP_LOCK_GRACE_MS}ms`,
);
check("the worker is named rippa-node.exe", watchdog.NODE_EXE_NAME === "rippa-node.exe");
check("the manager is named rippa-watchdog.exe", watchdog.WATCHDOG_EXE_NAME === "rippa-watchdog.exe");

// --- 2. Exit 0 — Shutdown means the watchdog stops --------------------------
// THE MOST IMPORTANT TEST IN THIS FILE. If a deliberate shutdown were treated as
// a crash, the watchdog would relaunch the node and the operator would be unable
// to stop a machine at all.
const shutdownRun = await runWatchdog([exitCodes.EXIT_SHUTDOWN]);
check(
  "exit 0 stops the watchdog entirely (it does not respawn the node)",
  shutdownRun.runs.length === 1,
  `the node ran ${shutdownRun.runs.length} time(s)`,
);
check(
  "the watchdog itself exits 0 on a shutdown",
  shutdownRun.code === 0,
  `watchdog exited ${shutdownRun.code}`,
);
check(
  "the shutdown is logged as deliberate, not as a crash",
  /admin asked for a shutdown/i.test(shutdownRun.output),
);
check(
  "no crash backoff is waited on a deliberate shutdown",
  !/restarting in/i.test(shutdownRun.output),
);

// --- 3. Exit 42 — Restart means relaunch immediately ------------------------
const restartRun = await runWatchdog([exitCodes.EXIT_RESTART, exitCodes.EXIT_SHUTDOWN]);
check(
  "exit 42 relaunches the node",
  restartRun.runs.length === 2,
  `the node ran ${restartRun.runs.length} time(s)`,
);
check(
  "exit 42 is logged as an admin restart",
  /restart requested by admin \(42\)/i.test(restartRun.output),
);
check(
  "a requested restart waits for NO backoff",
  !/restarting in/i.test(restartRun.output),
);
// 42 must be instant where 1 is not: that difference is the entire reason a
// distinct code exists rather than reusing "crash" for both.
check(
  "a requested restart is not logged as a crash",
  !/crash \(1\)/i.test(restartRun.output),
);

// --- 4. Exit 1 — a crash is restarted after the backoff ----------------------
// The scripted queue is [1, 0]: the node crashes once, the watchdog waits, then
// the restarted node is told to shut down so the test terminates. The timeout
// covers the 5s backoff plus start-up, which is why this case is the slow one.
const crashRun = await runWatchdog([exitCodes.EXIT_CRASH, exitCodes.EXIT_SHUTDOWN]);
check(
  "exit 1 restarts the node",
  crashRun.runs.length === 2,
  `the node ran ${crashRun.runs.length} time(s)`,
);
check(
  "a crash is logged as a crash, with its 5s backoff",
  /restarting in 5s/i.test(crashRun.output),
);

// --- 5. Exit 43 — Apply Update swaps the binary -----------------------------
// THE OTA CASE. The watchdog must put the staged build in place and boot it. The
// "executable" it replaces is a marker file whose contents are asserted
// afterwards, so the swap is verified by RESULT rather than by a log claiming it.
const swapDir = fs.mkdtempSync(path.join(os.tmpdir(), "rippa-swap-target-"));
const targetExe = path.join(swapDir, "rippa-node.exe");
const ORIGINAL = "ORIGINAL BUILD v1";
const UPDATED = "UPDATED BUILD v2";
fs.writeFileSync(targetExe, ORIGINAL, "utf8");
fs.writeFileSync(path.join(dataDir, "temp_update.exe"), UPDATED, "utf8");

const swapped = await watchdog.applyStagedUpdate(targetExe);
check("applyStagedUpdate reports success", swapped === true);
check(
  "the staged build replaces the old executable",
  fs.readFileSync(targetExe, "utf8") === UPDATED,
  fs.readFileSync(targetExe, "utf8"),
);
check(
  "the old executable is removed after a successful swap (no litter)",
  !fs.existsSync(`${targetExe}.old`),
);
check(
  "the staged download is consumed",
  !fs.existsSync(path.join(dataDir, "temp_update.exe")),
);

// A missing staged file is the "the node exited 43 but the download never
// finished" case. It must NOT touch the working build — the node still has to
// come up on something.
const missingDir = fs.mkdtempSync(path.join(os.tmpdir(), "rippa-swap-missing-"));
const untouchedExe = path.join(missingDir, "rippa-node.exe");
fs.writeFileSync(untouchedExe, ORIGINAL, "utf8");
const noStaged = await watchdog.applyStagedUpdate(untouchedExe);
check("a missing staged file reports failure", noStaged === false);
check(
  "a missing staged file leaves the working executable untouched",
  fs.readFileSync(untouchedExe, "utf8") === ORIGINAL,
);
check(
  "a missing staged file does not delete the executable (no brick path)",
  fs.existsSync(untouchedExe),
);

// --- 6. An unknown exit code is treated as a crash --------------------------
// Windows reports signals and aborts as assorted non-zero codes. A watchdog that
// only understood the four documented codes would leave the machine dead on any
// other fault, so anything unrecognised must restart rather than give up.
const unknownRun = await runWatchdog([99, exitCodes.EXIT_SHUTDOWN]);
check(
  "an unrecognised exit code restarts the node rather than leaving it down",
  unknownRun.runs.length === 2,
  `the node ran ${unknownRun.runs.length} time(s)`,
);
check(
  "an unrecognised code is logged as unexpected",
  /unexpected exit \(99\)/i.test(unknownRun.output),
);

// --- 7. Arguments are forwarded to the worker -------------------------------
// A node started with `--config D:\fleet\node.json` must come back the same way,
// or it returns pointed at the wrong config and the fleet silently fragments.
const argRun = await runWatchdog([exitCodes.EXIT_SHUTDOWN], { nodeArgs: ["--config", "D:/fleet/node.json"] });
check(
  "the worker is launched with the arguments the watchdog was given",
  argRun.runs.length === 1 && argRun.runs[0] === "--config",
  JSON.stringify(argRun.runs),
);

// --- 8. Single instance ------------------------------------------------------
// Two supervisors for one node would fight over the same executable during a
// swap, so a second copy must stand down. A LOCK LEFT BEHIND is the more
// dangerous half of this: it would block every future start of the watchdog,
// which is precisely the daemon failing to return after the incident it exists
// to survive.
const lockFile = path.join(dataDir, "watchdog.lock");
check(
  "the watchdog releases its lock when it stops (a later run can start)",
  !fs.existsSync(lockFile),
  "a leftover lock would block every future start",
);

// --- 9. The CLI surface -----------------------------------------------------
// `--install` / `--uninstall` are how the watchdog becomes a background service,
// so the flags must be recognised WITHOUT starting a supervision loop.
const helpRun = await new Promise((resolve) => {
  const child = spawn(process.execPath, [path.join(ROOT, "dist", "watchdog.js"), "--help"], {
    env: { ...process.env, RIPPA_DATA_DIR: dataDir, RIPPA_NODE_EXE: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (c) => {
    output += c;
  });
  child.on("exit", (code) => resolve({ code, output }));
});
check("--help exits without starting a supervision loop", helpRun.code === 0);
check(
  "--help documents the exit-code protocol",
  /0 shutdown/.test(helpRun.output) && /42 restart/.test(helpRun.output) && /43 apply/.test(helpRun.output),
);
check(
  "--help documents --install, which is how it becomes a background service",
  /--install/.test(helpRun.output) && /--uninstall/.test(helpRun.output),
);
check("--help documents RIPPA_NODE_EXE", /RIPPA_NODE_EXE/.test(helpRun.output));
check("--help leaves no singleton lock behind", !fs.existsSync(lockFile));

// --- Cleanup -----------------------------------------------------------------
// The temp data directory holds the lock and log these tests produced. Removing
// it means a later run starts clean rather than inheriting a previous run's
// artefacts — including, critically, a lock that would silently skip every test.
fs.rmSync(dataDir, { recursive: true, force: true });
fs.rmSync(swapDir, { recursive: true, force: true });
fs.rmSync(missingDir, { recursive: true, force: true });

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} watchdog checks passed.`);
if (failed.length) {
  for (const f of failed) console.log(`  FAIL ${f.name}${f.detail ? ` — ${f.detail}` : ""}`);
}
process.exit(failed.length ? 1 : 0);
