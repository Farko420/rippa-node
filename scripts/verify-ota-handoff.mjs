/**
 * END-TO-END PROOF OF THE DESKTOP OTA HANDOFF, BY ACTUALLY RUNNING THE GENERATED
 * BATCH SCRIPT AGAINST A LOCKED EXECUTABLE.
 *
 * The reported bug was "the .exe node freezes on the update screen until someone
 * restarts it by hand", and the root cause was a swap script that decided the
 * copy had worked with `if exist "<exe>"`. The target always exists (it is the
 * running build), so that test could never fail, the retry loop was dead code,
 * and the script then deleted the staged download even though the overwrite had
 * been refused.
 *
 * A unit assertion on the generated text cannot catch that, because the text
 * looks plausible. This harness therefore EXECUTES the script for real, holding
 * the target open with a Windows exclusive file handle to reproduce the sharing
 * violation exactly, and checks the outcomes that matter.
 *
 * Run: node scripts/verify-ota-handoff.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const swap = require("../dist/update/swapHandoff.js");

let passed = 0;
let failed = 0;
function check(name, condition, detail = "") {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const OLD_BUILD = "OLD BUILD v1";
const NEW_BUILD = "NEW BUILD v2 (definitely longer than the old one)";

/** Runs the generated script to completion, detached exactly as the node does. */
function runScript(scriptPath) {
  return spawnSync("cmd.exe", ["/c", scriptPath], {
    encoding: "utf8",
    // stdin stays ignored — exactly what the node passes — because the script
    // must not depend on a console. stdout/stderr are piped only so a crash shows.
    stdio: ["ignore", "pipe", "pipe"],
    // windowsHide: background verification must never flash a console over the
    // operator's screen or steal OS focus on Windows.
    windowsHide: true,
    timeout: 120_000,
  });
}

/** Builds a sandbox holding a staged update and a target executable. */
function makeSandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rippa-handoff-"));
  const target = path.join(dir, "rippa-node.exe");
  const staged = path.join(dir, "temp_update.exe");
  fs.writeFileSync(target, OLD_BUILD, "utf8");
  fs.writeFileSync(staged, NEW_BUILD, "utf8");
  return { dir, target, staged };
}

/**
 * Starts a process holding an EXCLUSIVE handle on `file` for `seconds`.
 *
 * Node's `fs.openSync` shares reads and writes by default and exposes no "deny
 * all sharing" flag, so a deny-write lock — the one a running mapped image
 * produces — cannot be expressed from Node directly. PowerShell's FileStream can.
 *
 * RETURNED, NOT SPAWNED SYNCHRONOUSLY, ON PURPOSE. `spawnSync` would block until
 * the holder finished, releasing the lock before the swap script ever ran, so the
 * "locked" scenario would silently degrade into the happy path and prove nothing.
 * The caller awaits `child` only to reap it at the end.
 */
function holdExclusive(file, seconds) {
  return spawn(
    "powershell.exe",
    [
      "-NoProfile",
      "-Command",
      `$f=[System.IO.File]::Open('${file.replace(/'/g, "''")}','Open','ReadWrite','None');` +
        `Start-Sleep -Seconds ${seconds}; $f.Close()`,
    ],
    { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
  );
}

console.log("\n[HANDOFF] 1. The generated script gates success on the copy's exit code");
{
  const { dir, target, staged } = makeSandbox();
  const script = swap.writeSwapScript(staged, target);
  const lines = fs.readFileSync(script, "utf8").split("\r\n");

  check(
    "success is decided by `errorlevel`, not by `if exist`",
    /if not errorlevel 1/.test(lines.join("\n")) &&
      !/if exist ".*rippa-node\.exe" goto/.test(lines.join("\n")),
  );
  check("the script retries the copy on failure", /goto :rippa_copy/.test(lines.join("\n")));
  check(
    "the staged download is deleted only after a successful swap",
    /RIPPA_SWAPPED% EQU 1 del/.test(lines.join("\n")),
  );
  /*
    The settle-time is the line that must survive `stdio: "ignore"`. `timeout`
    refuses to run without a console input, so a `timeout /t 3` here is a no-op
    on a detached spawn and the copy races the image lock instead of waiting it
    out. A loopback ping always burns the delay.
  */
  check(
    "the settle-time waits on a loopback ping, not `timeout`",
    lines.some((l) => /^ping -n \d+ 127\.0\.0\.1 > NUL$/.test(l.trim())),
  );
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log("\n[HANDOFF] 2. A locked target keeps the staged update and still relaunches");
{
  const { dir, target, staged } = makeSandbox();
  /*
    The holder outlives the script's ENTIRE retry budget (10 attempts at ~1s plus
    the 3s settle), so the lock is guaranteed to still be held for the last copy
    attempt. That is the case that used to lose the update: every copy refused,
    the old `if exist` test still reporting success, and cleanup deleting the
    staged file.
  */
  const attempts = Number(swap.HANDOFF_COPY_ATTEMPTS ?? 10);
  const holder = holdExclusive(target, attempts + 15);
  await new Promise((resolve) => setTimeout(resolve, 800)); // let the lock land

  const script = swap.writeSwapScript(staged, target);
  const result = runScript(script);

  check("the script ran to completion", result.status === 0, `status ${result.status}`);
  /*
    The target cannot be READ while the exclusive handle is held, which is itself
    proof the lock was real. So the staged file is asserted immediately (that is
    the regression that matters) and the old build is verified once the lock is
    released.
  */
  check(
    "the staged update SURVIVED for the watchdog to apply on the next boot",
    fs.existsSync(staged),
    "a failed swap deleted the only copy of the update",
  );

  await new Promise((resolve) => holder.on("exit", resolve));
  check(
    "once unlocked, the old build is intact and was never half-written",
    fs.readFileSync(target, "utf8") === OLD_BUILD,
    `target reads "${fs.readFileSync(target, "utf8")}"`,
  );
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log("\n[HANDOFF] 3. An unlocked target swaps, relaunches and cleans up");
{
  const { dir, target, staged } = makeSandbox();
  const script = swap.writeSwapScript(staged, target);
  const result = runScript(script);

  check("the script ran to completion", result.status === 0, `status ${result.status}`);
  check(
    "the new build replaced the old one",
    fs.readFileSync(target, "utf8") === NEW_BUILD,
    `target still reads "${fs.readFileSync(target, "utf8")}"`,
  );
  check("the staged download was cleaned up after a successful swap", !fs.existsSync(staged));
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log("\n[HANDOFF] 4. The supervisor is verified, not assumed");
{
  /*
    `watchdogIsAlive` reads the lock out of the REAL staging directory, because
    `stagingDir()` is called internally and cannot be injected by patching the
    module export. So this drives the real data dir directly, and the cases that
    matter are the ones where a watchdog is claimed but is not provably alive.
  */
  const lock = path.join(swap.stagingDir(), swap.WATCHDOG_LOCK_FILE);
  const existed = fs.existsSync(lock);
  const previous = existed ? fs.readFileSync(lock, "utf8") : null;

  const savedFlag = process.env.RIPPA_WATCHDOG;
  process.env.RIPPA_WATCHDOG = "1";

  const setLock = (value) => {
    if (value === null) fs.rmSync(lock, { force: true });
    else fs.writeFileSync(lock, value, "utf8");
  };

  setLock(null);
  check(
    "env flag set but no lock file: an unverifiable supervisor is NOT trusted",
    swap.handoffMode() === "script",
    "must fall back to the relaunching script, or the node exits into a dead machine",
  );

  setLock("not-a-pid");
  check("a corrupt lock file is not trusted", swap.handoffMode() === "script");

  setLock(String(process.pid));
  check("this process's own PID is not accepted as the supervisor", swap.handoffMode() === "script");

  // A PID that cannot exist: the highest legal PID, far above any real process.
  setLock("2147483646");
  check(
    "a dead supervisor's PID is not trusted (the freeze-until-restart bug)",
    swap.handoffMode() === "script",
  );

  const sleeper = spawn("cmd.exe", ["/c", "ping -n 6 127.0.0.1 > NUL"], {
    stdio: "ignore",
    windowsHide: true,
  });
  await new Promise((resolve) => setTimeout(resolve, 400));
  setLock(String(sleeper.pid));
  check(
    "a genuinely LIVE supervisor IS still trusted (exit-43 path preserved)",
    swap.handoffMode() === "watchdog",
    "discarding supervision here would reintroduce the dead-machine bug",
  );
  sleeper.kill();

  process.env.RIPPA_WATCHDOG = "";
  if (savedFlag === undefined) delete process.env.RIPPA_WATCHDOG;
  else process.env.RIPPA_WATCHDOG = savedFlag;
  setLock(previous);
}

console.log(`\n[HANDOFF] ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);