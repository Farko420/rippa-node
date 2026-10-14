import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * LOCAL DATA DIRECTORY — HARDCODED, NODE-OWNED, NEVER DICTATED BY THE CLOUD.
 *
 * WHY THIS EXISTS. Rippa Node ships as a single `rippa-node.exe` that replaces
 * ITSELF over the air (see `src/update/swapHandoff.ts`): a new build is streamed
 * in, verified, and swapped over the running executable. The swap only rewrites
 * the EXE FILE, so a `data/` folder beside it is untouched — which is exactly
 * why the node's storage now lives there, under the node's own control:
 *
 *   - Default  <install dir>/data   (the folder containing the exe; the project
 *              root when running from source, i.e. `./data`)
 *   - Override `RIPPA_DATA_DIR`     (the node's OWN local setting: `.env` beside
 *              the exe, `dataDirectory` in config.json, or the local dashboard)
 *
 * THE MOTHERSHIP HAS NO SAY IN THIS. It used to be that the node's data folder
 * could only be moved by a queued `UPDATE_STORAGE` command from the cloud, and a
 * payload the node could not use would fail the command and leave the operator
 * with no local remedy. Storage is a property of THIS machine, so it is
 * configured locally and merely *reported* upstream (see
 * `services/storageConfig.ts` and `services/nodeProfile.ts`).
 *
 * LEGACY LOCATIONS ARE MIGRATION SOURCES, NOT DEFAULTS. Older builds used the
 * OS per-user app-data folder (`%LOCALAPPDATA%\RippaNode` on Windows,
 * `~/.rippa-node` elsewhere). A node upgrading from one of those finds its
 * config, node code, mesh key and Deep Brain COPIED into the local `data/`
 * folder on first boot — see {@link migrateLegacyData} — so nothing an operator
 * had is lost by the change of default.
 */

/** Folder name of the hardcoded local default, relative to the install dir. */
export const DEFAULT_DATA_DIR_NAME = "data";

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
 * THE NODE'S LOCAL DATA DIRECTORY — the hardcoded default, derived from where
 * the node actually lives.
 *
 * `<install dir>/data`, i.e. `./data` when running from source and
 * `<folder of rippa-node.exe>\data` when packaged. Deliberately NOT the OS
 * app-data folder any more: the operator installs the node into a folder they
 * chose, and the node keeps its database, models and config beside itself where
 * they can see it, back it up and move it with the executable.
 *
 * A `data/` subfolder is used rather than the install folder itself so the OTA
 * swap (which overwrites the exe in place) and a manual "replace the exe" can
 * never collide with the node's own files.
 */
export function defaultDataDir(): string {
  return path.resolve(resolveInstallDir(), DEFAULT_DATA_DIR_NAME);
}

/**
 * The OS per-user app-data folder older builds used, or null when this platform
 * has none.
 *
 * KEPT ONLY AS A MIGRATION SOURCE. It is no longer the default, but a node
 * upgrading from a pre-`./data` build has its config, node code, mesh key and
 * Deep Brain database here, and {@link migrateLegacyData} copies them across so
 * the upgrade does not look like a factory reset.
 *
 * Returns null instead of throwing when `LOCALAPPDATA` is unset: a missing
 * environment variable can no longer break a boot, because the default no
 * longer depends on it.
 */
export function legacyDataDir(): string | null {
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA;
    if (!localAppData || !localAppData.trim()) return null;
    return path.join(localAppData.trim(), WINDOWS_DIR_NAME);
  }
  try {
    // os.homedir() based; no XDG lookup is done on purpose — the APK ships a
    // plain node runtime and a relative `~/.rippa-node` is predictable on both.
    return path.join(os.homedir(), POSIX_DIR_NAME);
  } catch {
    return null;
  }
}

/**
 * The absolute data directory in force for this process.
 *
 * Resolution order — both branches are LOCAL settings, neither is remote:
 *   1. `RIPPA_DATA_DIR` — explicit override from the node's own `.env` beside
 *      the exe, from `dataDirectory` in config.json, or from the local
 *      dashboard's Storage panel.
 *   2. {@link defaultDataDir} — the hardcoded local default, `./data`.
 *
 * Never throws. `LOCALAPPDATA` missing, a read-only home directory or any other
 * environment surprise can no longer stop the node from booting, because
 * nothing in the chain depends on the environment being sane.
 */
export function resolveDataDir(): string {
  const override = process.env.RIPPA_DATA_DIR;
  if (override && override.trim()) {
    return path.resolve(override.trim());
  }
  return defaultDataDir();
}

/** Creates the data directory (recursively) and returns it. */
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
 * packaged). Used for `public/` lookups, for the boot-level `.env`, and as the
 * PARENT of the default data directory ({@link defaultDataDir}, `<install>/data`)
 * — never as the data directory itself.
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
  /** Data directory the node is now using. */
  dir: string;
  /** Primary legacy directory that was searched for stranded files. */
  legacyDir: string | null;
  /** Every directory that was searched, in order. */
  sources: string[];
  /** Files copied across on this boot. */
  migrated: string[];
}

/**
 * ONE-TIME MIGRATION of data written somewhere else into the node's data
 * directory. Must run BEFORE config.json is read and before SQLite opens, or
 * the node would boot empty against the new path and then write a fresh,
 * overwrite-everything config on the first GUI save.
 *
 * TWO SOURCES ARE SEARCHED, because the default data directory has moved:
 *   1. The install folder (beside the exe) — files a pre-`data/` build left
 *      there. This is the historical case, and the source file is RENAMED to
 *      `*.legacy_backup` after a successful copy, because that folder is the
 *      one the OTA swap owns.
 *   2. The OS per-user app-data folder (`legacyDataDir()`) — where builds that
 *      predate the local `./data` default kept everything. Copied ONLY, never
 *      renamed: that directory may still belong to an older installed build, and
 *      renaming files out of it would break a rollback.
 *
 * Rules that make this safe to run on every boot:
 *   - An existing destination file is NEVER overwritten (the live copy is
 *     authoritative from the second boot onward).
 *   - Files are only renamed (source 1) after a successful copy, so a crash
 *     mid-migration re-runs instead of losing the data.
 *   - Every step is best-effort: a read-only source folder (Program Files, a
 *     mounted share) must not stop the node from booting.
 */
export function migrateLegacyData(legacyDir?: string): MigrationReport {
  const dir = resolveDataDir();
  fs.mkdirSync(dir, { recursive: true });

  /*
    AN EXPLICIT SOURCE MEANS THE CALLER KNOWS BEST.

    `legacyDir` is passed by tests and by callers pointing at one specific
    folder. In that case only that folder is searched — auto-adding the machine's
    real app-data directory would make a hermetic test depend on whatever
    happens to be installed on the machine running it.
  */
  const explicit = legacyDir !== undefined;
  const candidates: Array<{ source: string; renameSource: boolean }> = [];

  // An explicit config root means this process was pointed at a specific folder
  // by its launcher (tests, a portable override). Migrating anything out of the
  // install folder would rename files out from under that launcher.
  const installSource = explicit
    ? String(legacyDir ?? "").trim()
    : process.env.RIPPA_CONFIG_ROOT
      ? ""
      : resolveInstallDir().trim();
  if (installSource) candidates.push({ source: installSource, renameSource: true });

  if (!explicit) {
    const legacy = legacyDataDir();
    if (legacy) candidates.push({ source: legacy, renameSource: false });
  }

  // Nothing to do when a source IS the data directory (e.g. a test that points
  // RIPPA_DATA_DIR at its own config root).
  const sources = candidates
    .map((candidate) => ({ ...candidate, source: path.resolve(candidate.source) }))
    .filter((candidate) => candidate.source !== path.resolve(dir));

  const report: MigrationReport = {
    dir,
    legacyDir: sources[0]?.source ?? null,
    sources: sources.map((source) => source.source),
    migrated: [],
  };
  if (sources.length === 0) return report;

  for (const { source, renameSource } of sources) {
    for (const name of LEGACY_DATA_FILES) {
      const from = path.join(source, name);
      const to = path.join(dir, name);
      try {
        if (!fs.existsSync(from) || fs.existsSync(to)) continue;
        fs.copyFileSync(from, to);
        if (renameSource) fs.renameSync(from, `${from}${LEGACY_BACKUP_SUFFIX}`);
        report.migrated.push(name);
        console.log(
          `[Paths] Migrated ${name} → ${to}` +
            (renameSource ? "" : ` (copied from ${source}; the original is left in place)`),
        );
      } catch (error) {
        console.warn(
          `[Paths] Could not migrate ${name} from ${from}:`,
          error instanceof Error ? error.message : error,
        );
      }
    }
  }

  if (report.migrated.length > 0) {
    console.log(
      `[Paths] Brought ${report.migrated.length} file(s) into ${dir} from ` +
        `${report.sources.join(", ")}.`,
    );
  }
  return report;
}