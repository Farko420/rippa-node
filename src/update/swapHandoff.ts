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
/** Windows keeps the mapped image locked briefly; the script waits this long. */
export const HANDOFF_DELAY_SECONDS = 3;
/** Bounded retries for the overwrite, in case the lock outlives the first wait. */
const HANDOFF_COPY_ATTEMPTS = 10;

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
    `timeout /t ${HANDOFF_DELAY_SECONDS} /nobreak > NUL`,
    "set /a RIPPA_ATTEMPT=0",
    ":rippa_copy",
    "set /a RIPPA_ATTEMPT+=1",
    // In-place overwrite. The previous build survives a failure untouched.
    `copy /y "${update}" "${exe}" > NUL 2>&1`,
    `if exist "${exe}" goto :rippa_launch`,
    `if %RIPPA_ATTEMPT% GEQ ${HANDOFF_COPY_ATTEMPTS} goto :rippa_cleanup`,
    "ping -n 2 127.0.0.1 > NUL",
    "goto :rippa_copy",
    ":rippa_launch",
    // Reached on success AND on total failure; in the latter case this simply
    // brings the previous, still-working build back up.
    `start "" "${exe}"${suffix}`,
    ":rippa_cleanup",
    `del /f /q "${update}" > NUL 2>&1`,
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
    // `cp` over the target rather than `mv`: a failed overwrite must leave the
    // working build in place, matching the Windows behaviour above.
    `cp -f "${updatePath}" "${targetExe}" || exit 1`,
    `chmod +x "${targetExe}"`,
    `nohup "${targetExe}"${relaunchSuffix()} >/dev/null 2>&1 &`,
    `rm -f "${updatePath}"`,
    'rm -f "$0"',
  ].join("\n");
}

/**
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
 * @returns "watchdog" when the running process is a Watchdog child and must exit
 *          with {@link EXIT_APPLY_UPDATE}; "script" for a standalone install that
 *          still has to hand itself off.
 */
export function handoffMode(): "watchdog" | "script" {
  return isUnderWatchdog() ? "watchdog" : "script";
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
