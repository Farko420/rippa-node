import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  EXIT_APPLY_UPDATE,
  EXIT_CRASH,
  EXIT_RESTART,
  EXIT_SHUTDOWN,
  WATCHDOG_ENV_FLAG,
  describeExitCode,
} from "./update/exitCodes";
import {
  HANDOFF_STAMP,
  TEMP_UPDATE_FILE,
  releaseHandoffClaim,
  stagingDir,
} from "./update/swapHandoff";

/**
 * RIPPA WATCHDOG — the background manager that owns the node's lifetime.
 *
 * WHY A SECOND PROCESS. Every attempt to make `rippa-node.exe` restart itself
 * runs into the same wall: Windows keeps a running executable mapped and
 * locked, so the process cannot replace its own image, and a process that
 * spawns a replacement and then exits leaves nothing behind to notice when that
 * replacement dies. That is why a remote "Restart" used to behave identically
 * to a remote "Shutdown" — the node exited, and with it the only thing that
 * could ever have brought it back.
 *
 * So supervision moves to a process that is not the thing being supervised.
 * This file is that process, and it is deliberately tiny: it imports nothing
 * but `node:` builtins and the exit-code contract, it opens no sockets, it
 * loads no config, and it cannot itself fail in interesting ways. Its entire
 * job is `spawn` -> `wait` -> look at the exit code -> act.
 *
 * THE PROTOCOL (see `src/update/exitCodes.ts` for the full contract):
 *
 *     node exited 0   -> admin said Shutdown      -> the watchdog exits too
 *     node exited 1   -> crash                    -> wait 5s, restart
 *     node exited 42  -> admin said Restart       -> restart immediately
 *     node exited 43  -> admin said Apply Update  -> swap the binary, then boot
 *     anything else   -> treated as a crash       -> wait 5s, restart
 *
 * WHY "ANYTHING ELSE IS A CRASH" IS THE SAFE DEFAULT. Windows surfaces signals
 * and aborts as assorted non-zero codes, so a watchdog that only understood the
 * four codes above would silently leave the machine dead on any other fault.
 * Restarting is recoverable; staying down is not.
 *
 * STARTUP REGISTRATION. `--install` adds the watchdog to the per-user Windows
 * Run key (`HKCU`, not `HKLM`, so no elevation prompt and no admin rights are
 * required) and additionally drops a `.cmd` launcher into the user's Startup
 * folder. Both are removed by `--uninstall`. The Run key alone is enough on a
 * normal profile; the Startup-folder copy is the belt-and-braces path for
 * machines where group policy rewrites or blocks Run entries.
 *
 * SINGLE INSTANCE. A watchdog started twice would produce two supervisors for
 * one node, fighting over the same executable during an update swap. A lock
 * file in the data directory — carrying the owning pid — makes the second copy
 * exit immediately instead.
 *
 * LOGGING. The watchdog is a background service with no console, so every
 * decision goes to `watchdog.log` in the persistent data directory (rotated at
 * 1 MB). Without it, "the node went down at 3am" is undiagnosable, because by
 * the time anyone looks the process table has already been recycled.
 */

/** Canonical file name of the managed worker. */
export const NODE_EXE_NAME = "rippa-node.exe";
/** Canonical file name of this manager. */
export const WATCHDOG_EXE_NAME = "rippa-watchdog.exe";

/** How long the watchdog waits before restarting a crashed node. */
export const CRASH_BACKOFF_MS = 5_000;

/**
 * How long the watchdog waits after the node exits before touching the
 * executable. Windows can hold the mapped image for a moment past `exit()`.
 */
export const SWAP_LOCK_GRACE_MS = 3_000;

/** Attempts at the swap before giving up and booting whatever is on disk. */
const SWAP_ATTEMPTS = 10;

/** Rotate the watchdog log once it passes this size. */
const LOG_MAX_BYTES = 1024 * 1024;

/** Registry value / startup-folder entry name. */
const RUN_ENTRY_NAME = "RippaWatchdog";

/** Path to the worker. Overridable so a dev run can supervise `dist/index.js`. */
function resolveNodeExecutable(): string {
  const override = (process.env.RIPPA_NODE_EXE ?? "").trim();
  if (override) return path.resolve(override);
  return path.join(path.dirname(process.execPath), NODE_EXE_NAME);
}

/** Absolute path of this watchdog's own executable. */
function watchdogExecutable(): string {
  return process.execPath;
}

function log(message: string): void {
  console.log(`[Watchdog] ${message}`);
  try {
    const file = path.join(stagingDir(), "watchdog.log");
    // Rotated by size only. Renaming rather than truncating keeps the previous
    // run's tail available when a crash loop fills the file in minutes.
    try {
      if (fs.existsSync(file) && fs.statSync(file).size > LOG_MAX_BYTES) {
        fs.renameSync(file, `${file}.1`);
      }
    } catch {
      /* rotation is best-effort; never let logging break supervision */
    }
    fs.appendFileSync(file, `${new Date().toISOString()} ${message}\r\n`, "utf8");
  } catch {
    /* an unwritable data dir must not stop the watchdog from supervising */
  }
}

/**
 * Claims exclusive ownership, or reports that another watchdog already has it.
 *
 * The pid inside the lock file is what makes a STALE lock recoverable: a
 * watchdog killed with the machine (power loss) leaves the file behind, and a
 * watchdog that refused to start because of a stale lock would never come back
 * after the next reboot — the exact failure this daemon exists to prevent.
 */
function acquireSingletonLock(): boolean {
  const lockFile = path.join(stagingDir(), "watchdog.lock");
  try {
    if (fs.existsSync(lockFile)) {
      const owner = Number.parseInt(fs.readFileSync(lockFile, "utf8").trim(), 10);
      if (Number.isInteger(owner) && owner > 0 && owner !== process.pid) {
        // Signal 0 tests for existence without delivering anything.
        try {
          process.kill(owner, 0);
          log(`another watchdog (pid ${owner}) is already supervising — standing down.`);
          return false;
        } catch {
          /* the owner is gone: the lock is stale and may be taken over */
          log(`clearing a stale watchdog lock left by pid ${owner}.`);
        }
      }
    }
    fs.writeFileSync(lockFile, String(process.pid), "utf8");
    return true;
  } catch (error) {
    // An unwritable data directory must not disable supervision entirely.
    log(`could not take the singleton lock (${describeError(error)}) — supervising anyway.`);
    return true;
  }
}

function releaseSingletonLock(): void {
  try {
    fs.rmSync(path.join(stagingDir(), "watchdog.lock"), { force: true });
  } catch {
    /* nothing to clean up */
  }
}

/** True when `pid` names a live process this user can see. */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Resolves the per-user Startup folder, where Windows places logon entries. */
function startupDir(): string {
  return path.join(
    process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"),
    "Microsoft",
    "Windows",
    "Start Menu",
    "Programs",
    "Startup",
  );
}

/**
 * Installs the watchdog as a per-user startup entry.
 *
 * `HKCU\...\Run` is chosen over `HKLM` deliberately: it needs no elevation, so
 * the command succeeds on a locked-down workstation instead of failing on a
 * UAC prompt nobody is there to answer.
 */
export function installStartupEntry(): void {
  if (process.platform !== "win32") {
    log("startup registration is only implemented for Windows — nothing to do.");
    return;
  }

  const exe = watchdogExecutable();
  const runKey = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
  const reg = spawnSync(
    "reg.exe",
    ["ADD", runKey, "/v", RUN_ENTRY_NAME, "/t", "REG_SZ", "/d", `"${exe}"`, "/f"],
    { stdio: "ignore", windowsHide: true },
  );
  if (reg.status === 0) {
    log(`registered at startup: HKCU Run -> ${exe}`);
  } else {
    log(`could not write the HKCU Run entry (reg.exe exited ${reg.status ?? "with an error"}).`);
  }

  /*
    Second, independent mechanism: the per-user Startup folder. Machines whose
    Run key is managed by group policy (or rewritten by an endpoint agent) still
    honour this one, so a node on such a machine is not silently never-started.
  */
  try {
    fs.mkdirSync(startupDir(), { recursive: true });
    const launcher = path.join(startupDir(), `${RUN_ENTRY_NAME}.cmd`);
    // `@echo off` keeps a console window from flashing on every logon.
    fs.writeFileSync(launcher, `@echo off\r\nstart "" "${exe}"\r\n`, "utf8");
    log(`registered at startup: Startup folder -> ${launcher}`);
  } catch (error) {
    log(`could not write the Startup-folder launcher (${describeError(error)}).`);
  }
}

/** Removes both startup entries. Best-effort; safe to run when none exist. */
export function uninstallStartupEntry(): void {
  if (process.platform !== "win32") {
    log("startup deregistration is only implemented for Windows — nothing to do.");
    return;
  }
  const runKey = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
  const reg = spawnSync("reg.exe", ["DELETE", runKey, "/v", RUN_ENTRY_NAME, "/f"], {
    stdio: "ignore",
    windowsHide: true,
  });
  log(reg.status === 0 ? "removed the HKCU Run entry." : "no HKCU Run entry to remove.");

  try {
    fs.rmSync(path.join(startupDir(), `${RUN_ENTRY_NAME}.cmd`), { force: true });
    log("removed the Startup-folder launcher.");
  } catch (error) {
    log(`could not remove the Startup-folder launcher (${describeError(error)}).`);
  }
}

/**
 * Puts the staged build in place of the running one.
 *
 * The staged download (`temp_update.exe`) was written and verified by the node
 * before it exited with 43, so by the time this runs the only work left is the
 * file replacement itself — which is precisely the work the node could not do,
 * because it was the locked process.
 *
 * THE ORDER MATTERS, and it is the opposite of the obvious one. The old binary
 * is RENAMED aside rather than deleted, the new one is moved into place, and
 * only then is the old one deleted. A `del` followed by a `move` that fails
 * leaves the machine with no executable at all — an unrecoverable brick that
 * needs a reinstall — whereas this sequence can always fall back to the
 * previous, working build. If every attempt is refused (a stubborn lock, a
 * read-only folder) the rename-back restores what was there and the node still
 * boots.
 *
 * @returns true when the new build is in place.
 */
export async function applyStagedUpdate(targetExe: string): Promise<boolean> {
  const stage = stagingDir();
  const staged = path.join(stage, TEMP_UPDATE_FILE);
  if (!fs.existsSync(staged)) {
    log(`apply-update requested but ${TEMP_UPDATE_FILE} is not in ${stage} — booting the current build.`);
    return false;
  }

  // Windows can hold the mapped image briefly after the process exits.
  await sleep(SWAP_LOCK_GRACE_MS);

  const backup = `${targetExe}.old`;
  let renamed = false;
  for (let attempt = 1; attempt <= SWAP_ATTEMPTS; attempt += 1) {
    try {
      if (fs.existsSync(targetExe)) {
        fs.rmSync(backup, { force: true });
        fs.renameSync(targetExe, backup);
        renamed = true;
      }
      fs.renameSync(staged, targetExe);
      // Success: the previous build has served its purpose.
      if (renamed) fs.rmSync(backup, { force: true });
      log(`applied the staged update to ${targetExe}.`);
      return true;
    } catch (error) {
      // Put the working binary back before trying again, so a failure part-way
      // through can never leave the install without one.
      if (renamed && !fs.existsSync(targetExe) && fs.existsSync(backup)) {
        try {
          fs.renameSync(backup, targetExe);
          renamed = false;
        } catch {
          /* keep retrying; the next attempt sees whichever state is on disk */
        }
      }
      if (attempt === SWAP_ATTEMPTS) {
        log(`swap failed after ${SWAP_ATTEMPTS} attempts (${describeError(error)}).`);
      }
      await sleep(500);
    }
  }
  return false;
}

/**
 * Boots the worker and resolves once it has exited.
 *
 * Arguments are forwarded verbatim so a node launched as
 * `rippa-node.exe --config D:\fleet\config.json` comes back the same way. The
 * watchdog also marks the child with {@link WATCHDOG_ENV_FLAG}, which is how
 * the node knows not to spawn its own detached swap script.
 */
function launchNode(nodeExe: string, args: string[]): ChildProcess {
  log(`starting ${nodeExe} ${args.join(" ")}`.trim());
  const child = spawn(nodeExe, args, {
    stdio: "inherit",
    windowsHide: false,
    env: { ...process.env, [WATCHDOG_ENV_FLAG]: "1" },
  });
  child.on("error", (error) => log(`could not start ${nodeExe}: ${describeError(error)}`));
  return child;
}

/**
 * The supervision loop.
 *
 * Runs until the node asks to be shut down (exit 0) or the watchdog is
 * signalled to stop. Every other outcome restarts it, which is the entire
 * reason this process exists: a node that dies on its own comes back with
 * nobody having to be at the keyboard.
 */
async function supervise(nodeExe: string, args: string[]): Promise<void> {
  if (!fs.existsSync(nodeExe)) {
    log(`${nodeExe} does not exist. Place it beside the watchdog, or set RIPPA_NODE_EXE.`);
  }

  let stopping = false;
  const stop = (signal: NodeJS.Signals) => {
    stopping = true;
    log(`${signal} received — the watchdog will exit after the node stops.`);
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));

  while (!stopping) {
    const startedAt = Date.now();
    const child = launchNode(nodeExe, args);

    const outcome = await new Promise<{ code: number | null; signal: string | null }>((resolve) => {
      child.once("error", () => resolve({ code: EXIT_CRASH, signal: null }));
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });

    const code = outcome.code;
    const label = describeExitCode(code, outcome.signal);
    const uptime = Math.round((Date.now() - startedAt) / 1000);
    log(`${path.basename(nodeExe)} exited after ${uptime}s — ${label}.`);

    if (code === EXIT_SHUTDOWN) {
      log("the admin asked for a shutdown — the watchdog is exiting and will not restart the node.");
      break;
    }

    if (code === EXIT_APPLY_UPDATE) {
      await applyStagedUpdate(nodeExe);
      /*
        Clearing the handoff stamp after the swap is what makes the NEXT update
        possible. The stamp is written by the node to stop two updaters racing,
        and it is only released on a successful boot; if the new build ever dies
        before it gets that far, a stale stamp would wedge OTA permanently.
      */
      releaseHandoffClaim(path.join(stagingDir(), HANDOFF_STAMP));
      continue; // boot the new build with no delay
    }

    if (code === EXIT_RESTART) {
      continue; // requested restart: relaunch at once
    }

    // Everything else — code 1, a signal, or any unknown code — is a crash.
    log(`restarting in ${CRASH_BACKOFF_MS / 1000}s.`);
    await sleep(CRASH_BACKOFF_MS);
  }
}

/** Resolves after `ms`, used for the crash backoff and the swap grace period. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function usage(): string {
  return [
    "Rippa Watchdog — supervises rippa-node.exe.",
    "",
    "Usage:",
    "  rippa-watchdog.exe              supervise rippa-node.exe (the default)",
    "  rippa-watchdog.exe --install    register the watchdog to run at Windows startup",
    "  rippa-watchdog.exe --uninstall  remove both startup entries",
    "  rippa-watchdog.exe --status     report what is installed and whether a node is running",
    "",
    "Environment:",
    "  RIPPA_NODE_EXE   absolute path of the worker to supervise",
    "                   (default: rippa-node.exe beside this executable)",
    "",
    "Exit-code protocol (set by rippa-node.exe):",
    "  0 shutdown   1 crash (5s backoff)   42 restart   43 apply staged update",
  ].join("\n");
}

/** Reports the installed startup entries and any live worker. */
function reportStatus(nodeExe: string): void {
  console.log(`watchdog:  ${watchdogExecutable()}`);
  console.log(`node:      ${nodeExe}${fs.existsSync(nodeExe) ? "" : "  (MISSING)"}`);

  if (process.platform === "win32") {
    const query = spawnSync(
      "reg.exe",
      ["QUERY", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run", "/v", RUN_ENTRY_NAME],
      { encoding: "utf8", windowsHide: true },
    );
    console.log(
      query.status === 0
        ? "startup:   registered (HKCU Run)"
        : "startup:   not registered — run rippa-watchdog.exe --install",
    );
  }

  const stage = stagingDir();
  try {
    const owner = Number.parseInt(
      fs.readFileSync(path.join(stage, "watchdog.lock"), "utf8").trim(),
      10,
    );
    console.log(
      `running:   ${Number.isInteger(owner) && isProcessAlive(owner) ? `yes (pid ${owner})` : "no"}`,
    );
  } catch {
    console.log("running:   no");
  }
  console.log(`lock file: ${path.join(stage, "watchdog.lock")}`);
  console.log(`log:       ${path.join(stage, "watchdog.log")}`);
}

/** Entry point. Returns the process exit code. */
export async function main(argv: string[]): Promise<number> {
  const nodeExe = resolveNodeExecutable();
  const args = argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    console.log(usage());
    return EXIT_SHUTDOWN;
  }
  if (args.includes("--install")) {
    installStartupEntry();
    return EXIT_SHUTDOWN;
  }
  if (args.includes("--uninstall")) {
    uninstallStartupEntry();
    return EXIT_SHUTDOWN;
  }
  if (args.includes("--status")) {
    reportStatus(nodeExe);
    return EXIT_SHUTDOWN;
  }

  if (!acquireSingletonLock()) return EXIT_SHUTDOWN;
  log(`watchdog starting — supervising ${path.basename(nodeExe)}.`);
  try {
    await supervise(nodeExe, args);
  } catch (error) {
    log(`supervision failed (${describeError(error)}) — exiting.`);
    return EXIT_CRASH;
  } finally {
    releaseSingletonLock();
  }
  log("watchdog stopped.");
  return EXIT_SHUTDOWN;
}

// Only self-executes when run directly, so the module stays importable by the
// verification scripts without starting a supervision loop.
if (require.main === module) {
  main(process.argv)
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error("[Watchdog] fatal:", error);
      process.exit(EXIT_CRASH);
    });
}
