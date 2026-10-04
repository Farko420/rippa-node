import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * PERSISTENT DATA DIRECTORY.
 *
 * WHY THIS EXISTS. Rippa Node ships as a single `rippa-node.exe` that replaces
 * ITSELF over the air (see `src/update/swapHandoff.ts`): a new build is streamed
 * in, verified, and swapped over the running executable in the same folder.
 * Anything the node wrote *beside that executable* is therefore destroyed by
 * every OTA update — the operator's config.json, node code, mesh key, pairing
 * record and the entire Deep Brain database all vanished on each deploy, and
 * the node silently booted back to the first-run Setup screen.
 *
 * The fix is the standard per-user application-data location the OS already
 * reserves for exactly this, and which no updater is allowed to touch:
 *
 *   - Windows        %LOCALAPPDATA%\RippaNode
 *   - Linux / Android ~/.rippa-node   (os.homedir() based; no XDG lookup is
 *                     done on purpose — the APK ships a plain node runtime and
 *                     a relative `~/.rippa-node` is predictable on both)
 *
 * `RIPPA_DATA_DIR` overrides the whole thing (tests, portable-USB deployments).
 */

const WINDOWS_DIR_NAME = "RippaNode";
const POSIX_DIR_NAME = ".rippa-node";

/** Suffix appended to a legacy file after it has been copied across. */
export const LEGACY_BACKUP_SUFFIX = ".legacy_backup";

/**
 * SUFFIXES FOR THE CONFIG FILE'S DURABILITY ARTEFACTS.
 *
 * WHY THEY LIVE HERE AND NOT IN configManager. `config.json` is written by the
 * config layer, but it is also READ by the watchdog — which deliberately
 * imports no config code, because it must boot and supervise even when the
 * config is unreadable. This module is a leaf (node builtins only), so both
 * sides can share the names without the watchdog dragging in dotenv.
 *
 * `.bak` — the last config known to be VALID. It is what makes a torn write
 *          recoverable instead of permanent.
 * `.tmp` — where a write is assembled before it is promoted into place.
 */
export const CONFIG_BACKUP_SUFFIX = ".bak";
export const CONFIG_TEMP_SUFFIX = ".tmp";

/**
 * Files that used to live next to the executable and are now copied into the
 * persistent directory. SQLite's `-wal` / `-shm` sidecars are listed because a
 * WAL-mode database copied without them silently loses every write that had not
 * yet been checkpointed — i.e. most of a node's recent knowledge.
 */
export const LEGACY_DATA_FILES: readonly string[] = [
  "config.json",
  "local_knowledge.db",
  "local_knowledge.db-wal",
  "local_knowledge.db-shm",
];

/**
 * The absolute persistent data directory for this platform.
 *
 * Resolution order:
 *   1. `RIPPA_DATA_DIR` — explicit override.
 *   2. Windows         — `%LOCALAPPDATA%\RippaNode`.
 *   3. Everything else — `<os.homedir()>\.rippa-node`.
 *
 * Throws when `LOCALAPPDATA` is missing on Windows rather than silently falling
 * back to a temp directory: a data dir that vanishes with the machine is the
 * exact failure this module exists to prevent.
 */
export function resolveDataDir(): string {
  const override = process.env.RIPPA_DATA_DIR;
  if (override && override.trim()) {
    return path.resolve(override.trim());
  }

  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA;
    if (!localAppData || !localAppData.trim()) {
      throw new Error(
        "LOCALAPPDATA is not set — cannot resolve a persistent Rippa Node data directory. " +
          "Set RIPPA_DATA_DIR to an explicit path to override.",
      );
    }
    return path.join(localAppData.trim(), WINDOWS_DIR_NAME);
  }

  return path.join(os.homedir(), POSIX_DIR_NAME);
}

/** Creates the persistent directory (recursively) and returns it. */
export function ensureDataDir(): string {
  const dir = resolveDataDir();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Absolute path of a file inside the persistent directory. */
export function dataFilePath(...segments: string[]): string {
  return path.join(resolveDataDir(), ...segments);
}

/**
 * The directory the executable lives in (the dev project root when not
 * packaged). Used for `public/` lookups and as the migration source — never for
 * writable user data.
 *
 * `RIPPA_CONFIG_ROOT` is deliberately NOT honoured here. That override points a
 * whole node at someone else's directory (the verification harness uses a temp
 * folder), and treating it as "the old folder beside the exe" would make boot
 * copy — and then rename — files the operator never asked us to touch.
 */
export function resolveInstallDir(): string {
  if (typeof (process as NodeJS.Process & { pkg?: unknown }).pkg !== "undefined") {
    return path.dirname(process.execPath);
  }
  return process.cwd();
}

export interface MigrationReport {
  /** Persistent directory the data now lives in. */
  dir: string;
  /** Legacy directory that was searched for stranded files. */
  legacyDir: string | null;
  /** Files copied across on this boot. */
  migrated: string[];
}

/**
 * ONE-TIME MIGRATION of data written beside the executable into the persistent
 * directory. Must run BEFORE config.json is read and before SQLite opens, or
 * the node would boot empty against the new path and then write a fresh,
 * overwrite-everything config on the first GUI save.
 *
 * Rules that make this safe to run on every boot:
 *   - An existing destination file is NEVER overwritten (the persistent copy is
 *     authoritative from the second boot onward).
 *   - The legacy file is only renamed to `*.legacy_backup` after a successful
 *     copy, so a crash mid-migration re-runs instead of losing the data.
 *   - Every step is best-effort: a read-only legacy folder (Program Files, a
 *     mounted share) must not stop the node from booting.
 */
export function migrateLegacyData(legacyDir?: string): MigrationReport {
  const dir = resolveDataDir();
  fs.mkdirSync(dir, { recursive: true });

  // An explicit config root means this process was pointed at a specific folder
  // by its launcher (tests, a portable override). Migrating anything there would
  // rename files out from under that launcher, so do nothing.
  const source = legacyDir ?? (process.env.RIPPA_CONFIG_ROOT ? "" : resolveInstallDir()).trim();
  const report: MigrationReport = { dir, legacyDir: source || null, migrated: [] };

  // Nothing to do when the legacy folder IS the persistent folder (e.g. a test
  // that points RIPPA_DATA_DIR at its own config root).
  if (!source || path.resolve(source) === path.resolve(dir)) return report;

  for (const name of LEGACY_DATA_FILES) {
    const from = path.join(source, name);
    const to = path.join(dir, name);
    try {
      if (!fs.existsSync(from) || fs.existsSync(to)) continue;
      fs.copyFileSync(from, to);
      fs.renameSync(from, `${from}${LEGACY_BACKUP_SUFFIX}`);
      report.migrated.push(name);
      console.log(`[Paths] Migrated ${name} → ${to}`);
    } catch (error) {
      console.warn(
        `[Paths] Could not migrate ${name} from ${from}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  if (report.migrated.length > 0) {
    console.log(
      `[Paths] Moved ${report.migrated.length} legacy file(s) out of the executable folder into ${dir}. ` +
        "They are now safe from OTA updates.",
    );
  }
  return report;
}