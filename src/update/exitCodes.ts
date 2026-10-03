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
 *     0   Admin pressed "Stop".           -> watchdog goes GHOST (waits for START).
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

/**
 * Admin pressed "Stop": under a watchdog the node is left down and awaited.
 *
 * WHY A ZERO NO LONGER ENDS THE WATCHDOG. The fleet dashboard has a "Start
 * node" button, and a stopped node cannot poll — so it can never receive that
 * command. Under the old contract (a zero exit killed the supervisor too) the
 * Start button could not work on any machine, ever: the process that would have
 * delivered it was the process that had just exited. Ghost Mode
 * ({@link GHOST_MODE_ON_SHUTDOWN}) is what makes remote start reachable at all.
 *
 * IT IS A STOP, NOT A CRASH, and that distinction is the whole reason a stop is
 * recoverable. A crashed node comes back by itself after 5s; a stopped node stays
 * stopped until somebody asks for it, which is exactly what an admin pressing
 * "Stop" meant.
 *
 * WITHOUT A WATCHDOG this code still means "the process ends and nothing restarts
 * it", which is the original and correct meaning for a standalone install.
 */
export const EXIT_SHUTDOWN = 0;

/**
 * Whether a deliberate stop leaves the watchdog alive, waiting for a `start`.
 *
 * A CONSTANT RATHER THAN A BEHAVIOUR, so the contract is assertable from a literal
 * and can be switched off in one place if a deployment wants the old
 * stop-kills-the-supervisor semantics. Under the watchdog it is what turns
 * `exit 0` from "the machine is gone" into "the machine is asleep".
 */
export const GHOST_MODE_ON_SHUTDOWN = true;

/**
 * HOW OFTEN A GHOSTED WATCHDOG ASKS THE MOTHERSHIP FOR A `start`.
 *
 * THIRTY SECONDS, AND THE NUMBER IS A FLOOR ON HOW FAST A STOP FEELS BROKEN
 * RATHER THAN AN OPTIMISM. A command queued while the node was still running is
 * already waiting and is picked up on the very first poll after the watchdog goes
 * quiet. 30s only matters when the command arrives AFTER the node stopped — an
 * admin pressing Start on a machine that is already down — and that is the case
 * where a minute of delay is indistinguishable from "it did not work".
 *
 * THE FLOOR IS ON THE POLL, NOT ON THE CLOUD. Nothing here rate-limits the other
 * way: one HTTP round trip every 30s per ghosted machine is negligible against a
 * Worker, and it stops the moment the node boots.
 *
 * OVERRIDABLE VIA `RIPPA_WATCHDOG_GHOST_POLL_MS`, for the verification harness and
 * for an operator who would rather trade cloud requests for a faster Start. The
 * value is CLAMPED, not trusted: an operator who sets it to 1 does not get a
 * request per millisecond against the Mothership, because a mistyped or hostile
 * value here is a self-inflicted denial of service on the one endpoint every
 * ghosted machine talks to.
 */
export const GHOST_POLL_INTERVAL_MS = 30_000;

/** The shortest poll interval any override may request. */
export const GHOST_POLL_INTERVAL_FLOOR_MS = 1_000;

/**
 * The interval this process should actually use: the override when it is a usable
 * number at or above the floor, and the default otherwise.
 *
 * TOTAL AND NON-THROWING. It sits on the watchdog's start path, and a bad
 * environment variable must not be able to prevent a machine being supervised —
 * falling back to the default is the safe direction, since it is also the value
 * the fleet was tested against.
 */
export function ghostPollIntervalMs(): number {
  const raw = (process.env.RIPPA_WATCHDOG_GHOST_POLL_MS ?? "").trim();
  if (!raw) return GHOST_POLL_INTERVAL_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < GHOST_POLL_INTERVAL_FLOOR_MS) {
    return GHOST_POLL_INTERVAL_MS;
  }
  return Math.floor(parsed);
}

/**
 * THE ONE COMMAND A GHOSTED WATCHDOG WILL ACT ON.
 *
 * CLOSED SET, DELIBERATELY, AND IT IS A SUBSET OF THE NODE'S OWN ALLOWLIST. A
 * ghosted watchdog has no node process behind it, so anything it honours is
 * something it does with no application, no config parse and no database open.
 * `start` is the only one of those that makes sense: every other admin command
 * needs a running node to execute it, and the node is precisely what is absent.
 *
 * Matching a command string against this set — rather than trusting whatever the
 * response contains — is what keeps a compromised or malfunctioning Mothership
 * from turning the supervisor into a remote execution surface. The watchdog's
 * entire vocabulary is one word, and the cloud applies a matching filter on its
 * side of the wire.
 */
export const GHOST_COMMANDS = ["start"] as const;

/** The command that brings a ghosted node back. Lowercase, to match NODE_COMMANDS. */
export const GHOST_START_COMMAND = "start";

/** True when `command` is one the ghosted watchdog will act on. */
export function isGhostActionable(command: string): boolean {
  return (GHOST_COMMANDS as readonly string[]).includes(
    String(command ?? "")
      .trim()
      .toLowerCase(),
  );
}

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
