/**
 * THE EXIT-CODE HANDOFF PROTOCOL — the contract between `rippa-node.exe` and
 * `rippa-watchdog.exe`.
 *
 * WHY THIS EXISTS. Rippa Node used to be a single executable that had to be able
 * to restart itself, and that is precisely what Windows refuses to allow: a
 * running .exe is mapped and locked, so the process cannot replace or relaunch
 * its own image. The old answer was a detached `update.bat`, which worked for
 * the binary swap but turned an ordinary "restart" into a shutdown — there was
 * no supervisor left to bring the node back, so a remote restart acted exactly
 * like a remote shutdown and the machine went dark until a human intervened.
 *
 * The fix is to split the process in two (see `src/watchdog.ts`):
 *
 *     rippa-watchdog.exe   long-lived parent. Spawns the node, waits for it to
 *                          exit, and acts on the exit CODE.
 *     rippa-node.exe       the actual worker. Never restarts itself; it just
 *                          says what it wants done and exits.
 *
 * That makes the exit code the entire API between them:
 *
 *     0   Admin pressed "Shutdown".      -> watchdog EXITS. Nothing restarts.
 *     1   The node crashed.              -> watchdog waits 5s, restarts.
 *     42  Admin pressed "Restart".       -> watchdog restarts IMMEDIATELY.
 *     43  Admin pressed "Apply Update".  -> watchdog swaps the binary, boots it.
 *
 * Codes 42 and 43 are the two that used to be impossible. The distinction
 * between "restart" and "apply update" has to be drawn by the node (only it
 * knows whether a verified download is sitting in the staging directory) and it
 * is carried by the exit code rather than by a side-channel file, because a
 * running process cannot reliably update a file another process is about to
 * read.
 *
 * EVERY OTHER CODE IS TREATED AS A CRASH (code 1) by the watchdog. Windows
 * reports signals as non-zero codes, an unhandled exception is 1, and a
 * supervisor that only understood the four codes above would leave the fleet
 * dark after any other fault.
 */

/** Admin pressed "Shutdown": the watchdog must exit and leave the node down. */
export const EXIT_SHUTDOWN = 0;

/** The node crashed. The watchdog backs off 5s and restarts it. */
export const EXIT_CRASH = 1;

/** Admin pressed "Restart": the watchdog relaunches immediately, no delay. */
export const EXIT_RESTART = 42;

/**
 * Admin pressed "Apply Update": a verified build is staged in the data
 * directory and the watchdog must put it in place before booting.
 */
export const EXIT_APPLY_UPDATE = 43;

/**
 * Environment marker the watchdog sets on the child it spawns.
 *
 * The node reads this to decide how to hand off. Under a watchdog it must NOT
 * spawn `update.bat` or relaunch itself — the watchdog does the swap and the
 * relaunch — so the presence of this variable is what switches `OtaUpdater`
 * and `SwarmUpdater` from the legacy detached-script path to `exit(43)`.
 *
 * Without it the node keeps the old behaviour, so a single-executable install
 * that has no watchdog still updates itself exactly as it always did.
 */
export const WATCHDOG_ENV_FLAG = "RIPPA_WATCHDOG";

/** True when this process was started by the Rippa Watchdog. */
export function isUnderWatchdog(): boolean {
  const value = (process.env[WATCHDOG_ENV_FLAG] ?? "").trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

/**
 * A human-readable name for an exit code, for watchdog logs and operator
 * runbooks. Kept here so the node and the watchdog can never disagree about
 * what a code means.
 */
export function describeExitCode(code: number | null, signal?: string | null): string {
  if (signal) return `signal ${signal}`;
  switch (code) {
    case EXIT_SHUTDOWN:
      return "shutdown requested by admin (0)";
    case EXIT_CRASH:
      return "crash (1)";
    case EXIT_RESTART:
      return "restart requested by admin (42)";
    case EXIT_APPLY_UPDATE:
      return "apply update requested by admin (43)";
    default:
      return `unexpected exit (${code ?? "unknown"})`;
  }
}
