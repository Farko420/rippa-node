import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { ensureDataDir } from "../utils/paths";
import { EXIT_APPLY_UPDATE, isUnderWatchdog } from "./exitCodes";

/**
 * SELF-REPLACEMENT HANDOFF — the one place a running node swaps its own binary.
 *
 * WHY THIS IS A SHARED MODULE. The node has two independent reasons to update:
 * the Mothership can advertise a build on the heartbeat (`OtaUpdater`), and the
 * Master can push a GitHub release to the fleet (`SwarmUpdater`). When those two
 * each owned their own batch script they drifted — different file names, different
 * staging locations, and only one of them preserved the operator's command line.
 * A node that restarts without its original arguments comes back misconfigured,
 * so the script generation lives here and both callers get identical behaviour.
 *
 * THE SEQUENCE (Windows), and why each step is what it is:
 *   1. Wait for the image lock to clear. Windows keeps a running .exe mapped, and
 *      the lock can outlive `process.exit(0)` by a moment, so the wait is 3s and
 *      the copy is then retried rather than trusted to the first attempt.
 *   2. `copy /y` OVER the running executable — never `del` then `move`. A delete
 *      that succeeds and a move that then fails leaves the node with NO binary at
 *      all, which is an unrecoverable brick requiring a reinstall. Overwriting in
 *      place means a failed copy leaves the previous, working build untouched and
 *      still launchable in the fallback below.
 *   3. Relaunch with the ORIGINAL arguments, so a node started as
 *      `rippa-node.exe --config D:\fleet\config.json` comes back the same way.
 *   4. Remove the staged download and the script itself, so a node that updates
 *      repeatedly does not accumulate a 126 MB file per release.
 *
 * STAGING LOCATION. The download is staged in the persistent data directory
 * (`%LOCALAPPDATA%\RippaNode` on Windows), not beside the executable. Beside the
 * exe is wrong twice over: an install under Program Files is read-only for a
 * standard user, and `utils/paths.ts` already exists precisely because files
 * written next to the executable are not a safe place to keep anything.
 */

/** Staged download, awaiting the swap. */
export const TEMP_UPDATE_FILE = "temp_update.exe";
/** Suffix for an in-progress download, promoted to the real name only on success. */
export const PARTIAL_SUFFIX = ".part";
/** The detached swap script (per the OTA spec). */
export const HANDOFF_SCRIPT = "update.bat";
/** POSIX equivalent, for the non-Windows build. */
export const HANDOFF_SCRIPT_POSIX = "update.sh";
/** Marks that this process has already committed to a handoff. */
export const HANDOFF_STAMP = ".ota-handoff";
/**
 * The watchdog's singleton lock, holding the supervising PID.
 *
 * Shared as a constant because the node reads it to decide whether its supervisor
 * is still alive ({@link watchdogIsAlive}) and the watchdog writes it. Two literals
 * that must agree are two ways to silently disagree.
 */
export const WATCHDOG_LOCK_FILE = "watchdog.lock";
/** Windows keeps the mapped image locked briefly; the script waits this long. */
export const HANDOFF_DELAY_SECONDS = 3;
/**
 * Bounded retries for the overwrite, in case the lock outlives the first wait.
 *
 * Exported because the handoff verification harness has to size its external
 * file lock to outlast the WHOLE retry budget — a lock that releases halfway
 * through would let a later attempt succeed and quietly turn the "locked target"
 * scenario into the happy path, proving nothing.
 */
export const HANDOFF_COPY_ATTEMPTS = 10;

/** True when this process is a packaged .exe — the only self-replaceable case. */
export function isPackagedExe(): boolean {
  const packaged = Boolean((process as NodeJS.Process & { pkg?: unknown }).pkg);
  return packaged && path.basename(process.execPath).toLowerCase().endsWith(".exe");
}

/** Directory holding the running exe, or `null` outside a packaged build. */
export function installDir(): string | null {
  return isPackagedExe() ? path.dirname(process.execPath) : null;
}

/**
 * The command line to relaunch with, verbatim.
 *
 * `process.argv[0]` is the executable itself; everything after it was supplied by
 * whoever (or whatever) started the node. Under a `pkg` build the snapshot entry
 * point sits at argv[1], but the operator's own flags are still the tail of the
 * array, and dropping them is how a node comes back pointed at the wrong config.
 */
export function relaunchArgs(): string[] {
  return process.argv.slice(1).map((value) => String(value));
}

/**
 * Directory used to stage the download and the swap script.
 *
 * Falls back to the install directory (and then the cwd) because a data dir that
 * cannot be created must not disable OTA entirely — the swap itself only ever
 * writes to the executable's own folder.
 */
export function stagingDir(): string {
  try {
    return ensureDataDir();
  } catch {
    return installDir() || process.cwd();
  }
}

/** Process-local fallback claim, used when the stamp file is not writable. */
let claimedInProcess = false;


/**
 * On-disk guard against two updaters both calling `process.exit(0)`.
 *
 * The Mothership-driven `OtaUpdater` and the GitHub-driven `SwarmUpdater` can
 * both decide to update in the same window. Without a shared claim the first to
 * finish would exit while the other was mid-write, leaving a half-swapped
 * install. The claim is a FILE rather than a module variable because the
 * relaunched process imports this module fresh and must not immediately
 * re-trigger the same swap; it is released again on the next successful boot so
 * a node is never permanently wedged by a crash mid-update.
 */
export function claimHandoffSlot(stampPath: string): boolean {
  try {
    if (fs.existsSync(stampPath)) return false;
    fs.writeFileSync(stampPath, String(process.pid), "utf8");
    claimedInProcess = true;
    return true;
  } catch {
    // Read-only staging dir: fall back to a process-local guard so a single
    // process still never exits twice.
    return !claimedInProcess;
  }
}

/** Releases a previous claim at boot. */
export function releaseHandoffClaim(stampPath: string): void {
  try {
    fs.rmSync(stampPath, { force: true });
  } catch {
    /* nothing to clear */
  }
  claimedInProcess = false;
}

/**
 * Makes one argument safe to paste into a generated batch file.
 *
 * Batch re-parses its own line, so `%`, `&`, `|`, `<`, `>`, `^` and newlines are
 * all metacharacters. `%` is dropped rather than escaped because it cannot be
 * escaped inside a quoted argument, and an operator flag containing one is
 * malformed anyway. Quotes are dropped for the same reason: they cannot survive
 * the round trip, and leaving one in would let an argument break out of its
 * quoting and inject batch commands.
 */
function sanitizeBatchArg(value: string): string {
  return value
    .replace(/[\r\n]+/g, " ")
    .replace(/["%]/g, "")
    .replace(/[&|<>^()!]/g, "^$&")
    .trim();
}

/**
 * Generates the Windows swap script.
 *
 * THE COPY IS GATED ON ITS EXIT CODE, NOT ON `if exist`. This is the whole fix
 * for "the node freezes on the update screen until someone restarts it by hand".
 *
 * The previous version decided the copy had worked with `if exist "<exe>"` —
 * but the target executable ALWAYS exists: it is the build currently running,
 * which is precisely the file we are trying to replace. So that test answered
 * "yes" whether the `copy` succeeded or was refused with "Access is denied"
 * (sharing violation against the mapped image), which made the retry loop
 * unreachable dead code. The consequences were both fatal:
 *
 *   - the copy was attempted exactly ONCE, ~3s after exit, which is often
 *     before Windows has released the image lock, so the update silently never
 *     applied and the node came straight back up on the old build; and
 *   - the script then fell through to cleanup and DELETED the staged download,
 *     so the watchdog's `applyPendingStagedUpdate` recovery path had nothing
 *     left to find. The update was gone and the operator had nothing to retry.
 *
 * `copy` returns 0 on success and non-zero on failure, so `if not errorlevel 1`
 * is the only test that can actually tell the two apart. Success is now gated
 * on that, the loop really retries while the lock is held, and a total failure
 * keeps the staged file for the watchdog to apply on the next boot.
 *
 * The failure path matters as much as the success path: if every copy attempt is
 * refused (a stubborn lock, a read-only install folder) the ORIGINAL executable
 * is still sitting there untouched, so the script relaunches that rather than
 * exiting into a dead machine.
 */
function buildWindowsScript(updatePath: string, targetExe: string): string {
  const exe = sanitizeBatchArg(targetExe);
  const update = sanitizeBatchArg(updatePath);
  const suffix = relaunchSuffix();

  return [
    "@echo off",
    "rem Generated by Rippa Node. Waits for the image lock, overwrites the",
    "rem executable in place, then relaunches it with the original arguments.",
    "setlocal",
    `cd /d "${sanitizeBatchArg(process.cwd())}"`,
    /*
      `ping -n N 127.0.0.1` rather than `timeout /t N`.

      `timeout` refuses to run when its input is redirected and answers "ERROR:
      Input redirection is not supported" instead of waiting — and this script is
      launched with `stdio: "ignore"`, so its stdin is not a console. Depending on
      the host that makes the intended settle-time a no-op. A loopback ping is the
      conventional, dependency-free way to burn exactly N-1 seconds with no
      console attached, and it is already used for the inter-attempt delay below.
    */
    `ping -n ${HANDOFF_DELAY_SECONDS + 1} 127.0.0.1 > NUL`,
    "set /a RIPPA_ATTEMPT=0",
    "set /a RIPPA_SWAPPED=0",
    ":rippa_copy",
    "set /a RIPPA_ATTEMPT+=1",
    // In-place overwrite. The previous build survives a failure untouched.
    `copy /y "${update}" "${exe}" > NUL 2>&1`,
    // THE SUCCESS GATE — see the note above on why this must be `errorlevel`.
    "if not errorlevel 1 goto :rippa_done",
    `if %RIPPA_ATTEMPT% GEQ ${HANDOFF_COPY_ATTEMPTS} goto :rippa_launch`,
    // Hold the loop for ~1s between attempts while Windows releases the lock.
    "ping -n 2 127.0.0.1 > NUL",
    "goto :rippa_copy",
    ":rippa_done",
    "set /a RIPPA_SWAPPED=1",
    ":rippa_launch",
    // Reached on success AND on total failure; in the latter case this simply
    // brings the previous, still-working build back up.
    `start "" "${exe}"${suffix}`,
    ":rippa_cleanup",
    /*
      Only discard the staged download when the swap actually landed.

      Deleting it after a failed copy threw away the only copy of the update and
      left the watchdog's interrupted-update recovery with nothing to apply — the
      node silently reverted to the old build and the operator was told to restart
      it by hand. If RIPPA_SWAPPED is still 0 the file stays exactly where it is,
      and `applyPendingStagedUpdate` finishes the job before the next boot.
    */
    `if %RIPPA_SWAPPED% EQU 1 del /f /q "${update}" > NUL 2>&1`,
    // Self-delete through a short-lived child: a bare `del "%~f0"` makes cmd
    // report "batch file cannot be found" as it reads past its own deleted file.
    'start "" /b cmd /c "timeout /t 1 /nobreak > NUL & del ""%~f0"""',
    "endlocal",
  ].join("\r\n");
}

/** Generates the POSIX equivalent of the swap script. */
function buildPosixScript(updatePath: string, targetExe: string): string {
  const dir = path.dirname(targetExe);
  return [
    "#!/bin/sh",
    "# Generated by Rippa Node. Overwrites the executable in place and relaunches",
    "# it with the original arguments.",
    `cd "${dir}" || exit 1`,
    `sleep ${HANDOFF_DELAY_SECONDS}`,
    /*
      `cp` over the target rather than `mv`: a failed overwrite must leave the
      working build in place, matching the Windows behaviour above.

      THE RETRY LOOP mirrors the Windows one for the same reason — the image lock
      can outlive the exit, and a single attempt at a fixed delay is a race that
      silently loses the update. It is bounded so a permanently unwritable target
      cannot spin forever.

      ON TOTAL FAILURE THE PREVIOUS BUILD IS STILL LAUNCHED. Bailing out instead
      would leave a machine with no node at all, and the staged download is left
      in place so the next boot can finish the job.
    */
    "attempt=0",
    "while [ \"$attempt\" -lt " + String(HANDOFF_COPY_ATTEMPTS) + " ]; do",
    "  attempt=$((attempt + 1))",
    `  if cp -f "${updatePath}" "${targetExe}"; then`,
    "    swapped=1",
    "    break",
    "  fi",
    "  sleep 1",
    "done",
    `chmod +x "${targetExe}" 2>/dev/null`,
    `nohup "${targetExe}"${relaunchSuffix()} >/dev/null 2>&1 &`,
    // Discard the staged download only when the swap actually landed.
    'if [ "$swapped" = "1" ]; then rm -f "${updatePath}"; fi',
    'rm -f "$0"',
  ].join("\n");
}

/**
/**
 * True when a Rippa Watchdog is genuinely supervising this machine.
 *
 * WHY THE ENV VAR ALONE IS NOT ENOUGH — THIS IS THE "NODE FREEZES UNTIL SOMEONE
 * RESTARTS IT BY HAND" BUG. {@link isUnderWatchdog} only asks whether
 * `RIPPA_WATCHDOG=1` is in the environment, and that flag is set by the watchdog
 * when it spawns its child. It says nothing about whether that watchdog is STILL
 * ALIVE now, minutes or hours later, when the update finally happens.
 *
 * So every failure mode that kills the supervisor — the watchdog crashed, the
 * machine's antivirus quarantined it, an operator ended the task, a scheduled
 * task was disabled — left `RIPPA_WATCHDOG=1` set on a node that would then exit
 * 43 into a machine with nothing left to read that code. Nothing swapped the
 * binary, nothing rebooted, and the operator's only remedy was a manual restart.
 * That is precisely the reported symptom.
 *
 * The fix is to verify the claim instead of trusting it. The watchdog owns a
 * lock file containing its PID, and the same liveness probe it uses on itself
 * (`process.kill(pid, 0)`) decides whether that PID still exists. Only a
 * confirmed-live supervisor justifies handing the swap to it; anything else falls
 * back to the standalone detached-script path, which can always bring the node
 * back because it does not depend on a supervisor being alive.
 *
 * FAILING CLOSED TOWARDS THE SCRIPT. An unreadable lock, a garbage PID, or a
 * probe error all report `false`, and `false` selects the script. That is the
 * safe direction: the script needs no supervisor and always relaunches, whereas
 * a wrongly-trusted flag is exactly how the node ends up dead.
 */
export function watchdogIsAlive(): boolean {
  let owner: number;
  try {
    const raw = fs.readFileSync(path.join(stagingDir(), WATCHDOG_LOCK_FILE), "utf8").trim();
    owner = Number.parseInt(raw, 10);
  } catch {
    return false; // no lock file, or unreadable — nothing to trust
  }
  if (!Number.isInteger(owner) || owner <= 0 || owner === process.pid) return false;

  try {
    process.kill(owner, 0); // signal 0: existence only, delivers nothing
    return true;
  } catch (error) {
    // EPERM means the process EXISTS but belongs to another user, which on
    // Windows does not happen for a same-user watchdog — treat it as gone.
    return (error as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

/**
 * Whether the running process will be replaced by a SUPERVISOR rather than by
 * its own detached script.
 *
 * THE DECISION, AND WHY IT IS IN ONE PLACE. Both OTA paths end the same way, and
 * they used to end it two different ways: each wrote `update.bat`, spawned it
 * detached, and called `process.exit(0)`. That worked for a binary swap and
 * nothing else — there was no process left to notice the replacement dying, so a
 * Writes the swap script and returns its path.
 *
 * @param updatePath  the verified, staged download
 * @param targetExe   absolute path of the executable to overwrite and relaunch
 */
export function writeSwapScript(updatePath: string, targetExe: string): string {
  const windows = process.platform === "win32";
  const scriptPath = path.join(stagingDir(), windows ? HANDOFF_SCRIPT : HANDOFF_SCRIPT_POSIX);
  const body = windows
    ? buildWindowsScript(updatePath, targetExe)
    : buildPosixScript(updatePath, targetExe);

  fs.writeFileSync(scriptPath, `${body}\r\n`, "utf8");
  if (!windows) fs.chmodSync(scriptPath, 0o755);
  return scriptPath;
}

/**
 * Launches the swap script in its own session so it outlives this process.
 *
 * `detached` + `stdio: "ignore"` + `unref()` detaches it from our console, pipes
 * and event loop — it keeps running after `process.exit(0)`. Windows cannot exec
 * a .bat directly, so it must go through cmd.exe.
 */
export function spawnDetached(scriptPath: string, cwd: string): number | undefined {
  const child =
    process.platform === "win32"
      ? spawn("cmd.exe", ["/c", scriptPath], {
          detached: true,
          stdio: "ignore",
          windowsHide: true,
          cwd,
        })
      // `windowsHide` is meaningless on POSIX (Node ignores it there) but is kept
      // so the two branches state the same intent: the swap must relaunch the
      // exe silently, never over the top of whatever the user is doing.
      : spawn("/bin/sh", [scriptPath], {
          detached: true,
          stdio: "ignore",
          windowsHide: true,
          cwd,
        });

  child.unref();
  return child.pid;
}

/**
 * Whether the running process will be replaced by a SUPERVISOR rather than by
 * its own detached script.
 *
 * THE DECISION, AND WHY IT IS IN ONE PLACE. Both OTA paths end the same way, and
 * they used to end it two different ways: each wrote `update.bat`, spawned it
 * detached, and called `process.exit(0)`. That worked for a binary swap and
 * nothing else — there was no process left to notice the replacement dying, so a
 * restart could never come back.
 *
 * Under the Watchdog the script is not just unnecessary, it is actively harmful:
 * it would race the watchdog for the same executable, and it relaunches the node
 * directly, so the newly-booted process would not be a watchdog child and would
 * have no supervisor. So exactly one of the two paths runs, chosen here, and both
 * updaters call the same function to choose it.
 *
 * THE SUPERVISOR IS VERIFIED, NOT ASSUMED. `isUnderWatchdog()` alone only proves
 * the env flag was set at launch; it does not prove a watchdog is still running
 * now (see {@link watchdogIsAlive}). Exiting 43 into a machine whose watchdog has
 * since died is the freeze-until-manual-restart bug, so the flag is combined with
 * a live PID probe. A node that cannot confirm its supervisor takes the script
 * path, which needs no supervisor and always relaunches the node.
 *
 * @returns "watchdog" when a LIVE Watchdog owns this process and must be told to
 *          swap via {@link EXIT_APPLY_UPDATE}; "script" otherwise.
 */
export function handoffMode(): "watchdog" | "script" {
  return isUnderWatchdog() && watchdogIsAlive() ? "watchdog" : "script";
}

/**
 * Completes a handoff once a verified build is staged.
 *
 * The staging directory already holds `temp_update.exe`, verified by the caller
 * (size floor, PE magic, and SHA-256 when published), so the remaining work is
 * only the file replacement — which a running process cannot do to itself.
 *
 * Under the Watchdog, exiting with 43 hands the job to a process that is not
 * locked against the executable. Without one, the legacy detached script is
 * spawned first and the process exits 0 so the image lock is released before the
 * script's `copy /y`.
 *
 * NEVER RETURNS under either mode: both paths end in `process.exit`.
 */
export function completeHandoff(stagedUpdatePath: string, targetExe: string): never {
  if (handoffMode() === "watchdog") {
    console.log(
      `[OTA] Staged build ready — exiting ${EXIT_APPLY_UPDATE} so rippa-watchdog.exe ` +
        "can swap the executable and boot the new version.",
    );
    process.exit(EXIT_APPLY_UPDATE);
  }

  const scriptPath = writeSwapScript(stagedUpdatePath, targetExe);
  const pid = spawnDetached(scriptPath, path.dirname(targetExe));
  console.log(`[OTA] Handoff script spawned (detached, pid ${pid ?? "unknown"}).`);
  // Release the .exe lock so the script's overwrite can succeed. Exit code 0 is
  // the "I am finished" signal in the standalone path; with no watchdog present
  // there is nothing to misread it.
  process.exit(0);
}

/** Absolute path of the running executable — the thing being replaced. */
export function currentExecutable(): string {
  return process.execPath;
}

/** The `start "" "<exe>" <args>` tail of the relaunch line. */
function relaunchSuffix(): string {
  const args = relaunchArgs().map(sanitizeBatchArg).filter(Boolean);
  return args.length > 0 ? ` ${args.join(" ")}` : "";
}
