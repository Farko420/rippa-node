import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  EXIT_APPLY_UPDATE,
  EXIT_CRASH,
  EXIT_RESTART,
  EXIT_SHUTDOWN,
  GHOST_MODE_ON_SHUTDOWN,
  WATCHDOG_ENV_FLAG,
  describeExitCode,
  ghostPollIntervalMs,
} from "./update/exitCodes";
import { type GhostConfig, waitForStartCommand } from "./update/ghostMode";
import {
  HANDOFF_STAMP,
  TEMP_UPDATE_FILE,
  releaseHandoffClaim,
  stagingDir,
} from "./update/swapHandoff";
import { recordUpdateApplied } from "./update/updateStamp";

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
 * The watchdog is a background appliance: it must be invisible on the desktop
 * (the per-user Startup folder holds a SILENT `.vbs` wrapper that launches it
 * with window style 0, never a bare `.exe` or a `.cmd` that flashes a console),
 * and it must start itself at boot without an operator having to install it.
 * `--install` performs an explicit registration (HKCU Run key plus the Startup
 * wrapper); every NORMAL start then self-heals that registration, so deleting
 * the entry by hand only lasts until the next run instead of forever:
 *
 *   1. check whether the Startup folder holds a `.vbs` pointing at this exe;
 *   2. if not, write it (this is the "auto-registration on initialization");
 *   3. claim the singleton lock and supervise.
 *
 * Both writes are idempotent and best-effort: a roaming profile where the
 * Startup folder is unreachable still gets a supervised node for this session,
 * it just will not auto-start next time.
 *
 * STARTUP REGISTRATION. `--install` adds the watchdog to the per-user Windows
 * Run key (`HKCU`, not `HKLM`, so no elevation prompt and no admin rights are
 * required) and writes the silent `.vbs` wrapper into the user's Startup
 * folder. Both are removed by `--uninstall`. The Run key alone is enough on a
 * normal profile; the Startup-folder wrapper is the belt-and-braces path for
 * machines where group policy rewrites or blocks Run entries, and the SILENT
 * one — no console window, ever — rather than the legacy `.cmd` launcher,
 * which could only flash a prompt and leave it on the desktop.
 *
 * SINGLE INSTANCE. A watchdog started twice would produce two supervisors for
 * one node, fighting over the same executable during an update swap — and with
 * auto-start on, a stray double-click is a matter of time, not intent. Two
 * independent guards cover it, in order:
 *   1. the lock FILE in the data directory, carrying the owning pid (a stale
 *      lock left by a dead owner is taken over, not honoured — a daemon that
 *      refused to start after a power cut would defeat its own purpose);
 *   2. an OS-level PROCESS SCAN: even when the lock file is missing (deleted,
 *      or sitting on a path this copy cannot see), a second
 *      `rippa-watchdog.exe` in the process table still stands the newcomer
 *      down. A duplicate exits cleanly and immediately, with a log line saying
 *      why.
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
/** Silent background launcher dropped into the per-user Startup folder. */
const BG_LAUNCHER_FILE_NAME = "rippa-watchdog-bg.vbs";
/**
 * Test override for the per-user Startup folder, resolved through an env var
 * so the verification harness can assert on the generated launcher without
 * touching the operator's real logon entries.
 */
const STARTUP_DIR_OVERRIDE_ENV = "RIPPA_WATCHDOG_STARTUP_DIR";

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

/**
 * Lists this user's processes as `pid,image` rows, via the built-in
 * `tasklist.exe`. No dependency, no elevation, no WMI query — just the stock
 * CSV the OS already ships. Returns an empty list (never throws) when the scan
 * cannot run, so callers treat "could not scan" as "found nothing".
 */
function listOwnProcesses(): Array<{ pid: number; image: string }> {
  if (process.platform !== "win32") return [];
  try {
    const out = spawnSync("tasklist.exe", ["/FO", "CSV", "/NH"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 10_000,
    });
    if (out.status !== 0 || !out.stdout) return [];
    const rows: Array<{ pid: number; image: string }> = [];
    for (const line of String(out.stdout).split(/\r?\n/)) {
      // `"Image Name","PID","Session Name","Session#","Mem Usage"`
      const cells = line.split('","').map((cell) => cell.replace(/^"|"$/g, "").trim());
      if (cells.length < 2) continue;
      const image = String(cells[0] ?? "");
      const pid = Number.parseInt(String(cells[1] ?? ""), 10);
      if (!image || !Number.isInteger(pid) || pid <= 0) continue;
      rows.push({ pid, image });
    }
    return rows;
  } catch {
    return [];
  }
}

/**
 * True when another copy of THIS watchdog image is already running.
 *
 * THE SECOND HALF OF SINGLETON. The lock file is the primary guard, but it is
 * a file — deletable, or invisible when two copies disagree about the data
 * directory (a portable override, a roaming profile mid-sync). The process
 * table has no such disagreement: if a `rippa-watchdog.exe` (or whatever this
 * copy is named) is alive under a different pid, the newcomer stands down.
 *
 * Matching is on this copy's own file name (`path.basename(process.execPath)`),
 * case-insensitively, and ONLY inside a packaged build: a dev run is `node.exe`,
 * and matching `node.exe` would stand the watchdog down against some unrelated
 * editor helper. Outside a `pkg` snapshot the lock file is the guard (see the
 * gate below). Under `RIPPA_WATCHDOG_SKIP_PROCESS_SCAN` the scan is bypassed
 * entirely — the escape hatch the test harness and portable multi-instance
 * setups use to opt out.
 */
export function isDuplicateWatchdogProcess(): boolean {
  if (process.platform !== "win32") return false;
  if ((process.env.RIPPA_WATCHDOG_SKIP_PROCESS_SCAN ?? "").trim() === "1") return false;
  /*
    PACKAGED BUILDS ONLY. A dev run is `node.exe`, and `node.exe` is on every
    developer's box (the IDE, a test runner, the verify harness itself) —
    matching on it would make a `tsx src/watchdog.ts` stand down immediately
    against an unrelated process. The lock file is the correct and sufficient
    guard outside a `pkg` snapshot; the scan exists for the packaged
    `rippa-watchdog.exe`, where a stray double-click is the real double.
  */
  if (typeof (process as NodeJS.Process & { pkg?: unknown }).pkg === "undefined") return false;
  const self = path.basename(process.execPath).toLowerCase();
  if (!self.endsWith(".exe")) return false;
  return listOwnProcesses().some(
    (row) => row.pid !== process.pid && row.image.toLowerCase() === self,
  );
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
  const override = (process.env[STARTUP_DIR_OVERRIDE_ENV] ?? "").trim();
  if (override) return path.resolve(override);
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
 * Builds the silent-launcher script that starts the watchdog with no console.
 *
 * `WScript.Shell.Run ... , 0` is the standard invisible-launch idiom: the
 * second argument is the window style, and 0 means hidden. `chr(34)` wraps the
 * executable path in quotes, so an install under `C:\Program Files\...` (or any
 * folder with spaces) is parsed as one path rather than split at the first
 * space.
 *
 * The path is resolved HERE, at registration time, not when the script fires:
 * if the executable is later moved, the entry is stale by construction (exactly
 * like the Run-key value), and re-running `--install` fixes it.
 */
export function buildSilentLauncherScript(watchdogExe: string): string {
  return [
    "Set WshShell = CreateObject(\"WScript.Shell\")",
    `WshShell.Run chr(34) & "${watchdogExe}" & Chr(34), 0`,
    "Set WshShell = Nothing",
    "",
  ].join("\r\n");
}

/** Absolute path of the silent-launcher script in the Startup folder. */
export function silentLauncherPath(): string {
  return path.join(startupDir(), BG_LAUNCHER_FILE_NAME);
}

/**
 * True when the Startup folder holds a launcher that points at THIS watchdog.
 *
 * Checked on every normal start so the daemon heals a deleted or edited entry
 * by itself — an appliance that silently stops booting after the user tidies
 * their Startup folder is worse than one that re-creates a single file.
 */
export function isSilentLauncherRegistered(): boolean {
  if (process.platform !== "win32") return false;
  try {
    return fs.readFileSync(silentLauncherPath(), "utf8") === buildSilentLauncherScript(watchdogExecutable());
  } catch {
    return false;
  }
}

/**
 * Self-heals the boot registration and reports whether the machine is armed.
 *
 * This is the "auto-registration on initialization": a normal start calls it
 * BEFORE touching the singleton lock, so the single manual run the operator
 * performs is the one that arms every reboot after it. Returns true when the
 * Startup folder holds a launcher pointing at this executable — whether it was
 * already there (the idempotent no-op path) or was just written. Returns false
 * only when neither is the case, which on Windows means the write failed and
 * was logged; off Windows it always returns false (nothing to do) by way of
 * `isSilentLauncherRegistered` / `ensureSilentLauncher`.
 */
export function ensureAutoStart(): boolean {
  if (isSilentLauncherRegistered()) return true;
  return ensureSilentLauncher() !== null;
}

/**
 * Writes (or rewrites) the silent launcher. Returns the path written, or null
 * when there is nothing to do / nothing could be done.
 */
function ensureSilentLauncher(): string | null {
  if (process.platform !== "win32") return null;
  try {
    fs.mkdirSync(startupDir(), { recursive: true });
    const launcher = silentLauncherPath();
    fs.writeFileSync(launcher, buildSilentLauncherScript(watchdogExecutable()), "utf8");
    log(`registered at startup: Startup folder (silent) -> ${launcher}`);
    return launcher;
  } catch (error) {
    log(`could not write the silent Startup launcher (${describeError(error)}).`);
    return null;
  }
}

/**
 * Removes a leftover legacy `.cmd` launcher. The silent `.vbs` wrapper replaces
 * it: a `.cmd` can only flash-and-hide a console, while the VBS launches with
 * window style 0, leaving no prompt window on the desktop at all.
 */
function removeLegacyCmdLauncher(): void {
  try {
    const legacy = path.join(startupDir(), `${RUN_ENTRY_NAME}.cmd`);
    if (fs.existsSync(legacy)) {
      fs.rmSync(legacy, { force: true });
      log("removed the legacy Startup-folder .cmd launcher (replaced by the silent .vbs).");
    }
  } catch (error) {
    log(`could not remove the legacy Startup-folder launcher (${describeError(error)}).`);
  }
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
    Second, independent mechanism: the per-user Startup folder — as a SILENT
    `.vbs` wrapper, not a `.cmd`. A `.cmd` launcher can only flash-and-hide a
    console window, while `WshShell.Run ..., 0` starts the watchdog with no
    window at all, so the machine boots into a clean desktop instead of a
    leftover prompt. Machines whose Run key is managed by group policy (or
    rewritten by an endpoint agent) still honour this folder, so a node on such
    a machine is not silently never-started.
  */
  ensureSilentLauncher();
  removeLegacyCmdLauncher();
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

  // The silent `.vbs` wrapper, plus any legacy `.cmd` launcher it replaced.
  try {
    fs.rmSync(silentLauncherPath(), { force: true });
    log("removed the silent Startup-folder launcher.");
  } catch (error) {
    log(`could not remove the silent Startup-folder launcher (${describeError(error)}).`);
  }
  removeLegacyCmdLauncher();
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
      // Success: the previous build has served its purpose. Windows can keep
      // `.old` locked for a moment after the rename above (AV scan, lingering
      // handle, indexing service), and that lock throwing EPERM/EBUSY here must
      // NOT be mistaken for a failed swap — the new binary is already in place
      // and about to boot. Swallow the cleanup failure, log a warning, and leave
      // the stray `.old` file for the NEXT successful swap's `rmSync(backup, ..)`
      // (same call, next time around) to clear instead.
      if (renamed) {
        try {
          fs.rmSync(backup, { force: true });
        } catch (cleanupError) {
          log(
            `could not remove ${backup} (${describeError(cleanupError)}) — ` +
              "leaving it on disk and continuing; the swap itself succeeded.",
          );
        }
      }
      log(`applied the staged update to ${targetExe}.`);

      /*
        STAMP THE SUCCESSFUL INSTALL.

        This is the only place in the whole pipeline that KNOWS the swap worked
        — the node that requested it is already exiting, and the script path may
        not survive either. The watchdog's own `version.ts` reads the same
        package.json the swapped binary was built from, so it stamps the version
        the node is about to boot, and the new binary finds a stamp that matches
        the `APP_VERSION` it reports on its first heartbeat.
      */
      recordUpdateApplied();
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
 * THE SUPERVISION LOOP, PLUS GHOST MODE.
 *
 * Normal running is a plain `spawn -> wait -> read the exit code -> act` cycle.
 * The one addition is what a deliberate STOP does: instead of ending, the
 * watchdog drops into Ghost Mode and keeps listening for a remote `start`, which
 * is the only way that command can ever reach a machine that is not polling.
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

  /*
    THE CREDENTIALS FOR GHOST MODE ARE RESOLVED ONCE, LAZILY.

    Not because they are expensive, but because reading config can fail and this
    function must start supervising regardless. A watchdog that refused to launch
    a node because `config.json` was malformed would turn a recoverable config
    problem into a dark machine; resolving on first use means the worst case is
    that a *stopped* node cannot be started remotely, which is exactly the state
    it is already in.
  */
  let ghostConfig: GhostConfig | null = null;

  /*
    A DOWNLOADED-BUT-UNAPPLIED UPDATE IS FINISHED BEFORE THE FIRST BOOT.

    `temp_update.exe` in the staging directory means a previous run downloaded and
    verified a build, then the machine went down — or was killed — before the
    watchdog got to swap it in. Booting without looking would start the OLD
    binary and then let the node's own startup OTA check re-download a build that
    is already sitting on disk, which is both slow and wasteful.

    ONLY ONCE, before the loop, and only when something is actually staged. This
    is deliberately NOT a per-boot-into-the-loop check: after the first swap there
    is nothing left to apply, and re-checking on every restart would add a
    filesystem probe to the crash-restart path for no benefit.
  */
  await applyPendingStagedUpdate(nodeExe);

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

    if (code === EXIT_SHUTDOWN && GHOST_MODE_ON_SHUTDOWN) {
      /*
        GHOST MODE.

        The node was stopped ON PURPOSE, so restarting it would be the watchdog
        ignoring its operator. But exiting here is what made remote Start
        impossible: a stopped node does not poll, so the one command that could
        bring it back had no way to arrive.

        So the watchdog stays alive and becomes the listener instead. Every other
        exit code below still behaves exactly as before — a crash is still
        restarted automatically, and only a deliberate stop waits for somebody.

        A SIGNAL STILL WINS. `stopping` is checked before entering Ghost Mode as
        well as inside its loop, so `--uninstall` and Ctrl-C exit immediately
        rather than after the next poll.
      */
      if (stopping) break;
      if (!ghostConfig) ghostConfig = loadGhostConfig();
      if (!ghostConfig) {
        /*
          NO CREDENTIALS, SO GHOST MODE IS NOT POSSIBLE. Exiting is then the only
          honest outcome: staying alive and polling a URL we cannot authenticate
          against would be a watchdog that looks like it is waiting for a Start
          and is not.
        */
        log(
          "the node was stopped, and no Mothership credentials are available to wait for a " +
            "`start` — the watchdog is exiting. Restart rippa-watchdog.exe by hand to bring it back.",
        );
        break;
      }

      // The interval is READ, not hardcoded, so the log always describes the cadence
      // this process is actually running. An operator who overrode it to 5s must
      // not read "every 30s" out of the only log that explains the behaviour.
      const ghostIntervalMs = ghostPollIntervalMs();
      log(
        `ghost mode: ${path.basename(nodeExe)} is stopped. Polling for a \`start\` command every ` +
          `${Math.round(ghostIntervalMs / 1000)}s — the node will NOT come back on its own.`,
      );
      const started = await waitForStartCommand(ghostConfig, () => !stopping, ghostIntervalMs);
      if (!started) {
        if (stopping) {
          log("signalled while ghosted — the watchdog is exiting.");
          break;
        }
        // `waitForStartCommand` only returns false when told to stop, but treat
        // anything else as a stop too rather than risk a hot restart loop.
        log("ghost mode ended without a `start` — exiting.");
        break;
      }
      log("`start` received — leaving ghost mode and booting the node.");
      /*
        THE COMMAND IS SETTLED ONLY AFTER THE NODE IS BACK, not here.

        Reporting it as done at the moment the watchdog decides to boot would mean a
        crash in the seconds between this line and the node's first heartbeat had
        consumed the command with nothing to show for it — the Start button would
        appear to have worked and the machine would still be stopped. So the row is
        left outstanding, and the node settles it on its own acknowledgement channel
        once it is genuinely running again.
      */
      continue; // fall through to the top of the loop and launch it
    }

    if (code === EXIT_SHUTDOWN) {
      // Standalone install (no watchdog semantics) or Ghost Mode disabled.
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

/**
 * Finishes an update that was downloaded but never applied, before the first boot.
 *
 * THE INTERRUPTED-UPDATE CASE. The node stages `temp_update.exe` and then exits
 * 43 for the watchdog to swap it in. If the machine reboots, or the watchdog is
 * killed, in the window between those two steps, the download is sitting on disk
 * with nothing left to finish the job — and the next boot would start the OLD
 * binary and let the node's own startup OTA check re-download a build that is
 * already present.
 *
 * IT REUSES {@link applyStagedUpdate}, deliberately, rather than reimplementing a
 * second swap. That function is already the careful one — it renames the old
 * binary aside instead of deleting it, moves the new one into place, and restores
 * the backup if every attempt fails — and a second, simpler copy of it is exactly
 * how a swap ends up bricking a machine instead of updating it.
 *
 * SILENT WHEN THERE IS NOTHING TO DO. A normal boot must not log an OTA line it
 * has to explain, so the existence probe happens before anything is written.
 */
async function applyPendingStagedUpdate(targetExe: string): Promise<void> {
  const staged = path.join(stagingDir(), TEMP_UPDATE_FILE);
  if (!fs.existsSync(staged)) return;

  log(
    `${TEMP_UPDATE_FILE} is present — a previous update was downloaded but never applied. ` +
      `Swapping it in before booting.`,
  );
  const applied = await applyStagedUpdate(targetExe);
  if (applied) {
    /*
      The handoff stamp is released here for the same reason it is after a
      code-43 exit: it exists to stop two updaters racing for one binary, and a
      stamp left behind by a boot that never completed would wedge every future
      OTA update on this machine.
    */
    releaseHandoffClaim(path.join(stagingDir(), HANDOFF_STAMP));
  }
}

/**
 * The credentials Ghost Mode needs, or null when they cannot be determined.
 *
 * READ WITHOUT THE CONFIG SCHEMA, deliberately. `config.ts` validates with zod
 * and throws on an incomplete config, and this runs on the supervisor's start
 * path — so a partial config would take down a watchdog that has a perfectly good
 * `NODE_API_KEY` sitting in it. `config.json` is read as plain JSON and each field
 * is taken only if it is a usable string; the environment is the fallback because
 * a packaged install launched from the Startup folder inherits it.
 */
function loadGhostConfig(): GhostConfig | null {
  const fromFile = readConfigFileValues();
  const mothershipUrl = (fromFile.MOTHERSHIP_URL ?? process.env.MOTHERSHIP_URL ?? "").trim();
  const apiKey = (fromFile.NODE_API_KEY ?? process.env.NODE_API_KEY ?? "").trim();

  if (!mothershipUrl || !apiKey) {
    log(
      "ghost mode unavailable: MOTHERSHIP_URL and NODE_API_KEY are both required " +
        "(checked config.json, then the environment).",
    );
    return null;
  }
  return { mothershipUrl, apiKey };
}

/**
 * The subset of `config.json` Ghost Mode needs, read leniently.
 *
 * NEVER THROWS, and returns an empty object for a missing or malformed file: a
 * corrupt config must not be able to prevent the node from booting normally, and
 * the caller falls back to the environment when this comes back empty.
 */
function readConfigFileValues(): Record<string, string> {
  const candidates = [
    path.join(stagingDir(), "config.json"),
    path.join(process.cwd(), "config.json"),
  ];
  for (const candidate of candidates) {
    try {
      if (!fs.existsSync(candidate)) continue;
      const parsed: unknown = JSON.parse(fs.readFileSync(candidate, "utf8"));
      if (!parsed || typeof parsed !== "object") continue;
      const source = parsed as Record<string, unknown>;
      const out: Record<string, string> = {};
      for (const key of ["MOTHERSHIP_URL", "NODE_API_KEY"]) {
        const value = source[key];
        if (typeof value === "string" && value.trim()) out[key] = value.trim();
      }
      return out;
    } catch {
      // Unreadable or not JSON — try the next location, then the environment.
    }
  }
  return {};
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
    const launcherRegistered = isSilentLauncherRegistered();
    const launcher = silentLauncherPath();
    console.log(
      query.status === 0
        ? "startup:   registered (HKCU Run)"
        : "startup:   not registered — run rippa-watchdog.exe --install",
    );
    console.log(
      launcherRegistered
        ? `launcher:  silent Startup wrapper present -> ${launcher}`
        : `launcher:  no silent Startup wrapper (expected at ${launcher})`,
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

  /*
    AUTO-REGISTRATION ON INITIALIZATION. A normal start first ensures the
    silent Startup wrapper points at this executable, THEN supervises. This is
    what makes the single manual run the operator performs the one that arms
    every reboot after it: they never have to remember `--install`, and a
    tidied/deleted Startup entry heals itself on the next launch. Registration
    is idempotent, so a machine that is already registered pays one file
    comparison and nothing else.
  */
  ensureAutoStart();

  /*
    STRICT SINGLETON, IN ORDER: lock file first (cheap, precise), then the
    OS process scan (the backstop for a missing or invisible lock file). A
    duplicate exits CLEANLY and IMMEDIATELY — no supervision, no restart loop,
    no second supervisor fighting the first over the executable during a swap.
    The owning supervisor keeps running; only the newcomer stands down.
  */
  if (isDuplicateWatchdogProcess()) {
    log("another watchdog process is already running (process scan) — standing down.");
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
