import fs from "node:fs";
import path from "node:path";
import { resolveDataDir, resolveInstallDir } from "../utils/paths";
import {
  applyConfigToEnv,
  readConfigLenient,
  resolveAppRoot,
  writeConfig,
} from "../config/configManager";

/**
 * UI-DRIVEN STORAGE CONFIGURATION — the node half of "Storage & Capacity".
 *
 * WHY THIS EXISTS. Configuring the node's storage drive used to mean
 * hand-editing `.env` and moving Windows folders by hand. The Mothership can now
 * queue a `system_update_storage` command, delivered on the next heartbeat, and
 * this module carries it out:
 *
 *   1. WRITE: persist `dataDirectory`/`RIPPA_DATA_DIR`,
 *      `SCRATCH_DRIVE_CAPACITY_GB` and `SAFE_VAULT_CAPACITY_GB` in both
 *      `config.json` and the `.env` beside the executable.
 *   2. MIGRATE: copy persistent data from the old directory to the new one.
 *   3. VERIFY: compare every destination file against its source before the
 *      caller restarts.
 *   4. TELEMETRY: broadcast capacity and measured usage to the Mothership.
 *
 * THE NODE'S OWN CONFIGURATION ALWAYS WINS. The default data folder is hardcoded
 * locally (`utils/paths.defaultDataDir` → `<install dir>/data`), and the local
 * dashboard can change it at any time. A Mothership request that carries no
 * usable directory and no capacity is therefore NOT an error and NOT a failure:
 * it is a no-op that the node acknowledges as completed (see
 * {@link isEmptyStorageRequest} and the UPDATE_STORAGE handler in
 * `services/heartbeat.ts`). A cloud bug must never be able to report the node as
 * broken, and a node whose storage is already configured must never be told it
 * is not.
 *
 * Existing destination files are never overwritten, and a verification
 * failure throws instead of triggering a reboot into a partial copy.
 */

/** Subdirectory of the data dir used as the Scratch Drive's working area. */
export const SCRATCH_DIR_NAME = "scratch";

/** Directories never migrated: reinstallable runtime or transient scratch. */
const EPHEMERAL_DIRS = new Set([SCRATCH_DIR_NAME, "bin", ".bin-staging", "swarm-ingest"]);

/** File suffixes that mark runtime artefacts rather than persistent data. */
const EPHEMERAL_SUFFIX_RE = /\.(log|pid|sock|tmp|lock|legacy_backup)$/i;

/** Smallest capacity an operator may set, in GB. */
const MIN_CAPACITY_GB = 0.1;
/** Largest plausible capacity in GB, mirroring the Mothership normaliseGb ceiling. */
const MAX_CAPACITY_GB = 1024 * 1024;
/** Longest directory path accepted from the Mothership. */
const MAX_DATA_DIR_LENGTH = 260;

/** How often the background usage sampler refreshes its measurements. */
const USAGE_SAMPLE_INTERVAL_MS = 5 * 60_000;

/** One parsed SYSTEM_UPDATE_STORAGE payload. All fields optional. */
export interface StorageConfigRequest {
  /** Absolute target directory, e.g. D:\RippaNode. Absent = keep current. */
  dataDir?: string;
  /** Scratch Drive quota in GB. */
  scratchCapacityGb?: number;
  /** Safe Vault quota in GB. */
  safeVaultCapacityGb?: number;
}

/** What one applyStorageConfig run did. */
export interface StorageConfigReport {
  /**
   * True when the request was actionable and its configuration was persisted.
   * FALSE for a no-op ({@link StorageConfigReport.noop}), which is a successful
   * outcome, not a failure: nothing needed doing.
   */
  applied: boolean;
  /**
   * True when the request carried nothing actionable — no directory and no
   * capacity — so the node's existing (local) configuration stands. Callers must
   * treat this as SUCCESS: acknowledge it as completed, log that the local
   * configuration takes precedence, and carry on.
   */
  noop: boolean;
  /** True when the data directory MOVED, meaning the caller must restart. */
  changed: boolean;
  /** Directory the data lived in before this run. */
  from: string;
  /** Directory the data now lives in. */
  to: string;
  /** Top-level entries copied across on this run. */
  migrated: string[];
  /** Configured Scratch Drive quota in GB, or null when unset. */
  scratchCapacityGb: number | null;
  /** Configured Safe Vault quota in GB, or null when unset. */
  safeVaultCapacityGb: number | null;
}
/** Reads a capacity figure from the environment, or null when absent. */
export function capacityFromEnv(
  key: string,
  env: NodeJS.ProcessEnv = process.env,
): number | null {
  const raw = (env[key] ?? "").trim();
  if (!raw) return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < MIN_CAPACITY_GB || value > MAX_CAPACITY_GB) {
    return null;
  }
  return Math.round(value * 100) / 100;
}

/** The storage settings currently in force, read from the environment. */
export function readStorageSettings(
  env: NodeJS.ProcessEnv = process.env,
): {
  dataDir: string | null;
  scratchCapacityGb: number | null;
  safeVaultCapacityGb: number | null;
} {
  let dataDir: string | null = null;
  try {
    dataDir = resolveDataDir();
  } catch {
    // Unreachable in practice (resolveDataDir no longer throws), but the env
    // spelling is still the right degradation: report what was configured rather
    // than nothing at all.
    dataDir = (env["RIPPA_DATA_DIR"] ?? "").trim() || null;
  }
  return {
    dataDir,
    scratchCapacityGb: capacityFromEnv("SCRATCH_DRIVE_CAPACITY_GB", env),
    safeVaultCapacityGb: capacityFromEnv("SAFE_VAULT_CAPACITY_GB", env),
  };
}

function pickString(args: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

/**
 * TRUE WHEN A STORAGE REQUEST CARRIES NOTHING THE NODE CAN ACT ON.
 *
 * This is the defusing rule for the whole feature, so it is deliberately
 * generous about what counts as "empty". A Mothership may express "no change"
 * as a missing payload, `{}`, `{data_dir: ""}`, `{data_dir: null,
 * scratch_capacity_gb: null}`, whitespace, or a zero. Every one of those is a
 * request the node cannot use, and every one of them must be a NO-OP:
 *
 *   - it must NOT throw (a thrown handler is reported to `/api/node/ack` as
 *     `failed`, which marks a healthy node broken in the fleet view);
 *   - it must NOT touch the node's storage configuration (the local
 *     configuration — `config.json` / the dashboard — takes precedence);
 *   - it must be acknowledged as completed so the queue entry retires instead of
 *     being re-delivered on every heartbeat forever.
 *
 * A blank `data_dir` counts as absent rather than as "move to the empty path",
 * and a non-positive capacity counts as unspecified, because the Mothership's own
 * `normaliseGb` drops those too — so the two ends agree on what "not set" means.
 *
 * NEVER THROWS. A value that is present but OUT OF RANGE (0.05 GB) is still
 * actionable, so this returns false and {@link parseStorageConfigRequest} refuses
 * it loudly: a real, wrong quota deserves an honest rejection, whereas a missing
 * one deserves silence.
 */
export function isEmptyStorageRequest(args: unknown): boolean {
  if (!args || typeof args !== "object" || Array.isArray(args)) return true;
  const record = args as Record<string, unknown>;
  const hasText = (...keys: string[]): boolean =>
    keys.some((key) => typeof record[key] === "string" && (record[key] as string).trim().length > 0);
  /*
    Capacities arrive as numbers OR as numeric strings — the same tolerance
    `pickCapacity` applies, and the reason this is not a `typeof === "number"`
    test: treating "128" as "not specified" would silently drop a real quota.
  */
  const hasPositiveNumber = (...keys: string[]): boolean =>
    keys.some((key) => {
      const value = record[key];
      if (typeof value === "number") return Number.isFinite(value) && value > 0;
      if (typeof value === "string" && value.trim()) {
        const parsed = Number(value);
        return Number.isFinite(parsed) && parsed > 0;
      }
      return false;
    });

  if (hasText("data_dir", "dataDir", "data_directory", "ripa_data_dir")) return false;
  if (hasPositiveNumber("scratch_capacity_gb", "scratchCapacityGb")) return false;
  if (
    hasPositiveNumber(
      "safe_vault_capacity_gb",
      "vault_capacity_gb",
      "vaultCapacityGb",
      "safeVaultCapacityGb",
    )
  ) {
    return false;
  }
  return true;
}

function pickCapacity(args: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = args[key];
    if (value === undefined || value === null || value === "") continue;
    const num = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(num)) {
      throw new Error(`${key} must be a number of gigabytes.`);
    }
    if (num < MIN_CAPACITY_GB || num > MAX_CAPACITY_GB) {
      throw new Error(`${key} must be between ${MIN_CAPACITY_GB} and ${MAX_CAPACITY_GB} GB.`);
    }
    return Math.round(num * 100) / 100;
  }
  return undefined;
}

/** True when any character is a control code. Paths are single lines of text. */
function hasControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    if (value.charCodeAt(i) < 32) return true;
  }
  return false;
}

/**
 * Validates a Mothership payload. Throws with a human-readable message on
 * anything unsafe, because that message reaches the admin screen through the
 * command failure note. The path must be absolute and must not be a
 * filesystem root.
 *
 * AN EMPTY PAYLOAD IS NOT AN ERROR. It used to throw ("The storage update
 * carried no payload."), which the heartbeat executor reported back to
 * `/api/node/ack` as `failed` — marking a perfectly healthy node broken because
 * the cloud sent nothing to do. It now parses to an empty request, and
 * {@link applyStorageConfig} turns that into an explicit no-op that the caller
 * acknowledges as completed. See {@link isEmptyStorageRequest}.
 *
 * INVALID VALUES ARE STILL REFUSED. Only the absence of a payload is tolerated;
 * a relative path, a control character, an over-long path, a filesystem root or
 * an out-of-range quota still throws, so a genuinely broken request is reported
 * honestly instead of being silently swallowed.
 */
export function parseStorageConfigRequest(args: Record<string, unknown>): StorageConfigRequest {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return {};
  }
  const request: StorageConfigRequest = {};

  const rawDir = pickString(args, "data_dir", "dataDir", "data_directory", "ripa_data_dir");
  if (rawDir !== undefined) {
    if (rawDir.length > MAX_DATA_DIR_LENGTH) {
      throw new Error(`The target directory path is longer than ${MAX_DATA_DIR_LENGTH} characters.`);
    }
    if (hasControlChars(rawDir)) {
      throw new Error("The target directory contains control characters.");
    }
    if (!path.isAbsolute(rawDir)) {
      throw new Error(`The target directory must be an absolute path, got "${rawDir}".`);
    }
    const resolved = path.resolve(rawDir);
    if (path.parse(resolved).root === resolved) {
      throw new Error(`Refusing to use a filesystem root ("${resolved}") as the data directory.`);
    }
    request.dataDir = resolved;
  }

  const scratch = pickCapacity(args, "scratch_capacity_gb", "scratchCapacityGb");
  if (scratch !== undefined) request.scratchCapacityGb = scratch;
  const vault = pickCapacity(
    args,
    "safe_vault_capacity_gb",
    "vault_capacity_gb",
    "vaultCapacityGb",
    "safeVaultCapacityGb",
  );
  if (vault !== undefined) request.safeVaultCapacityGb = vault;

  /*
    A REQUEST WITH NOTHING IN IT IS RETURNED AS AN EMPTY REQUEST, NOT THROWN.

    This used to `throw new Error("The storage update carried no directory and no
    capacities.")`, and that single line is what marked healthy nodes broken: the
    heartbeat executor catches a throw and reports the command to `/api/node/ack`
    as `failed`. Storage belongs to the node — the folder is hardcoded locally and
    editable from the node's own dashboard — so "the cloud asked for nothing" must
    be a no-op. `applyStorageConfig` turns this empty request into an explicit
    no-op report, and `isEmptyStorageRequest` is what the dispatcher checks first.
  */
  return request;
}
/**
 * True when one path sits inside another. Such pairs are unusable as migration
 * source and destination because the copy would recurse into itself.
 */
function isNested(a: string, b: string): boolean {
  const relAtoB = path.relative(a, b);
  const relBtoA = path.relative(b, a);
  return (
    (relAtoB !== "" && !relAtoB.startsWith("..") && !path.isAbsolute(relAtoB)) ||
    (relBtoA !== "" && !relBtoA.startsWith("..") && !path.isAbsolute(relBtoA))
  );
}

/** True when a directory entry holds persistent data worth migrating. */
function isPersistentEntry(name: string): boolean {
  if (EPHEMERAL_DIRS.has(name)) return false;
  return !EPHEMERAL_SUFFIX_RE.test(name);
}

/**
 * Copies the persistent tree from one directory to another, then verifies
 * every copied file by size. Never overwrites existing destination files.
 * Throws on any verification mismatch.
 */
function migrateDataDir(from: string, to: string): string[] {
  fs.mkdirSync(to, { recursive: true });

  const filter = (src: string): boolean => isPersistentEntry(path.basename(src));
  fs.cpSync(from, to, { recursive: true, force: false, errorOnExist: false, filter });

  const problems: string[] = [];
  let verified = 0;
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!isPersistentEntry(entry.name)) continue;
      const srcPath = path.join(dir, entry.name);
      const destPath = path.join(to, path.relative(from, srcPath));
      if (entry.isDirectory()) {
        if (!fs.existsSync(destPath)) {
          problems.push(`missing directory ${path.relative(from, srcPath)}`);
          continue;
        }
        walk(srcPath);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!fs.existsSync(destPath)) {
        problems.push(`missing file ${path.relative(from, srcPath)}`);
        continue;
      }
      const srcSize = fs.statSync(srcPath).size;
      const destSize = fs.statSync(destPath).size;
      if (srcSize !== destSize) {
        problems.push(`size mismatch for ${path.relative(from, srcPath)}`);
        continue;
      }
      verified += 1;
    }
  };
  walk(from);

  if (problems.length > 0) {
    throw new Error(
      `Migration verification failed, keeping ${from}: ` + problems.slice(0, 5).join("; "),
    );
  }
  console.log(`[Storage] Verified ${verified} migrated file(s) in ${to}.`);
  return fs
    .readdirSync(from, { withFileTypes: true })
    .filter((entry) => isPersistentEntry(entry.name))
    .map((entry) => entry.name)
    .sort();
}

/**
 * Upserts KEY=value lines in a .env file, preserving every other line.
 * Best-effort: a read-only install folder must not fail the migration,
 * because config.json still carries the same values.
 */
function upsertEnvFile(file: string, entries: Record<string, string>): void {
  let lines: string[] = [];
  try {
    if (fs.existsSync(file)) {
      lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
    }
  } catch (error) {
    console.warn(`[Storage] Could not read ${file}, rewriting it.`);
    lines = [];
  }

  const remaining = new Map(Object.entries(entries));
  const next = lines.map((line) => {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (!match) return line;
    const key = match[1];
    const value = remaining.get(key);
    if (value === undefined) return line;
    remaining.delete(key);
    return `${key}="${value}"`;
  });
  for (const [key, value] of remaining) {
    next.push(`${key}="${value}"`);
  }

  const tmp = `${file}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, next.join("\n").replace(/\n*$/, "\n"), "utf8");
  fs.renameSync(tmp, file);
}

/**
 * Applies a validated storage request: persist, migrate, verify.
 * Throws on anything that would leave the node worse than it found it.
 *
 * AN EMPTY REQUEST IS A SUCCESSFUL NO-OP. Nothing is written, nothing is copied
 * and nothing is restarted: the node's local storage configuration stands, which
 * is the whole point of the feature. The report says so explicitly via `noop`, so
 * every caller can acknowledge the command as completed rather than failed.
 */
export function applyStorageConfig(args: Record<string, unknown>): StorageConfigReport {
  const from = resolveDataDir();
  const settings = readStorageSettings();

  if (isEmptyStorageRequest(args)) {
    console.log(
      "[Storage] The storage request carried no usable directory or capacity — " +
        "keeping this node's local storage configuration " +
        `(${from}). Nothing to do.`,
    );
    return {
      applied: false,
      noop: true,
      changed: false,
      from,
      to: from,
      migrated: [],
      scratchCapacityGb: settings.scratchCapacityGb,
      safeVaultCapacityGb: settings.safeVaultCapacityGb,
    };
  }

  const request = parseStorageConfigRequest(args);
  const to = request.dataDir ?? from;
  const dirChanging = path.resolve(from) !== path.resolve(to);

  if (dirChanging && isNested(from, to)) {
    throw new Error(`The target directory "${to}" overlaps "${from}". Pick a directory on its own.`);
  }

  const scratchCapacityGb =
    request.scratchCapacityGb ?? capacityFromEnv("SCRATCH_DRIVE_CAPACITY_GB");
  const safeVaultCapacityGb =
    request.safeVaultCapacityGb ?? capacityFromEnv("SAFE_VAULT_CAPACITY_GB");

  // WRITE: config.json first so the file that gets migrated already carries
  // the new values, then the boot-level .env, then the live process env.
  const configRoot = resolveAppRoot();
  const current = readConfigLenient(configRoot) ?? ({} as Record<string, unknown>);
  /*
    BOTH SPELLINGS ARE WRITTEN, AND THAT IS LOAD-BEARING.

    `current` is a normalised config, so it already holds `dataDirectory` (the
    readable property) alongside `RIPPA_DATA_DIR` (the environment spelling).
    Setting only the env key would leave the stale `dataDirectory` to win inside
    `normalizeConfig`, and the migration self-check below would then find a
    config.json that names the OLD folder — aborting a migration that had already
    copied the data. Writing both keeps the file self-describing and the two
    spellings in agreement.
  */
  const merged: Record<string, unknown> = {
    ...(current as Record<string, unknown>),
    ...(request.dataDir
      ? {
          dataDirectory: request.dataDir,
          storageDirectory: request.dataDir,
          RIPPA_DATA_DIR: request.dataDir,
        }
      : {}),
    ...(request.scratchCapacityGb !== undefined
      ? { SCRATCH_DRIVE_CAPACITY_GB: request.scratchCapacityGb }
      : {}),
    ...(request.safeVaultCapacityGb !== undefined
      ? { SAFE_VAULT_CAPACITY_GB: request.safeVaultCapacityGb }
      : {}),
  };
  writeConfig(configRoot, merged as Parameters<typeof writeConfig>[1]);
  applyConfigToEnv(merged as Parameters<typeof applyConfigToEnv>[0], true);

  const envEntries: Record<string, string> = {};
  if (request.dataDir) envEntries["RIPPA_DATA_DIR"] = request.dataDir;
  if (request.scratchCapacityGb !== undefined) {
    envEntries["SCRATCH_DRIVE_CAPACITY_GB"] = String(request.scratchCapacityGb);
  }
  if (request.safeVaultCapacityGb !== undefined) {
    envEntries["SAFE_VAULT_CAPACITY_GB"] = String(request.safeVaultCapacityGb);
  }
  if (Object.keys(envEntries).length > 0) {
    const envFile = path.join(resolveInstallDir(), ".env");
    try {
      upsertEnvFile(envFile, envEntries);
      console.log(`[Storage] Injected ${Object.keys(envEntries).join(", ")} into ${envFile}.`);
    } catch (error) {
      console.warn(`[Storage] Could not update ${envFile}; config.json still carries the values.`);
    }
  }

  // MIGRATE and VERIFY.
  let migrated: string[] = [];
  if (dirChanging) {
    console.log(`[Storage] Migrating persistent data ${from} to ${to}.`);
    migrated = migrateDataDir(from, to);
    const check = readMigratedConfig(to);
    if (!check) {
      throw new Error(`The migrated config.json in ${to} could not be read, aborting.`);
    }
    if (request.dataDir && (check.RIPPA_DATA_DIR ?? "").trim() !== to) {
      throw new Error(`The migrated config.json in ${to} does not name ${to}, aborting.`);
    }
    console.log(`[Storage] Migration complete. ${from} is left in place as a backup.`);
  } else {
    console.log("[Storage] Data directory unchanged; capacities refreshed in place.");
  }

  return {
    applied: true,
    noop: false,
    changed: dirChanging,
    from,
    to,
    migrated,
    scratchCapacityGb,
    safeVaultCapacityGb,
  };
}

/**
 * Reads the freshly-migrated `config.json`, retrying briefly before giving up.
 *
 * WHY THE RETRY. The file was written moments ago by `fs.cpSync`, and on Windows
 * a just-copied file can be momentarily unreadable — the copy's handles are
 * closed, but a virus scanner or the search indexer can still hold it open, which
 * surfaces as EPERM/EBUSY for a few milliseconds. `readConfigLenient` reports
 * that as "no usable config", and without this retry the migration self-check
 * would ABORT a migration that had in fact succeeded perfectly — the node would
 * stay on its old drive and the command would be reported upstream as failed.
 *
 * Bounded (5 attempts, ~0.6s worst case) and synchronous, because
 * `applyStorageConfig` is synchronous and this runs during a deliberate,
 * operator-initiated migration where a fraction of a second is irrelevant.
 */
function readMigratedConfig(root: string): ReturnType<typeof readConfigLenient> {
  const attempts = 5;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const config = readConfigLenient(root);
    if (config) return config;
    if (attempt < attempts - 1) sleepSync(120);
  }
  return null;
}

/**
 * A bounded synchronous pause, without spinning the CPU.
 *
 * `Atomics.wait` on a throwaway buffer is the one portable way to block a thread
 * in JavaScript without a busy loop, and it is available in every Node build this
 * project targets. If a runtime ever refuses it, the loop simply returns early —
 * the retry then costs one extra read attempt, never a hang.
 */
function sleepSync(ms: number): void {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    /* unsupported: fall through immediately */
  }
}

interface UsageSample {
  at: number;
  scratchUsedGb: number | null;
  vaultUsedGb: number | null;
}

let usageSample: UsageSample = { at: 0, scratchUsedGb: null, vaultUsedGb: null };
let usageSampler: NodeJS.Timeout | null = null;

/** Recursively sums file sizes under a directory. Best-effort, never throws. */
async function directorySizeBytes(dir: string): Promise<number | null> {
  let total = 0;
  const walk = async (current: string): Promise<void> => {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!isPersistentEntry(entry.name)) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        try {
          total += (await fs.promises.stat(full)).size;
        } catch {
          // Raced with a writer; skip this file.
        }
      }
    }
  };
  try {
    await walk(dir);
    return total;
  } catch {
    return null;
  }
}

const BYTES_PER_GIB = 1024 * 1024 * 1024;

async function sampleUsage(): Promise<void> {
  let dataDir: string;
  try {
    dataDir = resolveDataDir();
  } catch {
    return;
  }
  const scratchBytes = await directorySizeBytes(path.join(dataDir, SCRATCH_DIR_NAME));
  const vaultBytes = await directorySizeBytes(dataDir);
  const round2 = (bytes: number | null): number | null =>
    bytes === null ? null : Math.round((bytes / BYTES_PER_GIB) * 100) / 100;
  usageSample = {
    at: Date.now(),
    scratchUsedGb: round2(scratchBytes),
    vaultUsedGb:
      vaultBytes === null
        ? null
        : round2(scratchBytes === null ? vaultBytes : vaultBytes - scratchBytes),
  };
}

/**
 * Starts the background usage sampler. Idempotent and never holds the process
 * open. The first sample is taken asynchronously so a large models folder can
 * never block boot; telemetry reports null until it lands.
 */
export function startStorageUsageSampler(intervalMs = USAGE_SAMPLE_INTERVAL_MS): void {
  if (usageSampler) return;
  void sampleUsage();
  usageSampler = setInterval(() => void sampleUsage(), intervalMs);
  usageSampler.unref?.();
}

/** Stops the sampler. Used by tests. */
export function stopStorageUsageSampler(): void {
  if (usageSampler) {
    clearInterval(usageSampler);
    usageSampler = null;
  }
}

/**
 * The storage block broadcast on every heartbeat, at the payload root, using
 * the exact keys the Mothership normaliseHeartbeat reads. Null means
 * did-not-report and leaves stored columns untouched.
 */
export function buildStorageTelemetry(): {
  storage_data_dir: string | null;
  scratch_used_gb: number | null;
  scratch_capacity_gb: number | null;
  vault_used_gb: number | null;
  vault_capacity_gb: number | null;
} {
  const settings = readStorageSettings();
  return {
    storage_data_dir: settings.dataDir,
    scratch_used_gb: usageSample.scratchUsedGb,
    scratch_capacity_gb: settings.scratchCapacityGb,
    vault_used_gb: usageSample.vaultUsedGb,
    vault_capacity_gb: settings.safeVaultCapacityGb,
  };
}

/**
 * THE STATIC STORAGE HALF OF THE NODE'S HARDWARE PROFILE.
 *
 * Sent once at boot, inside the `POST /api/swarm/submit` node profile, so the
 * Mothership knows this node's storage is ALREADY RESOLVED and never has a
 * reason to queue a `system_update_storage` for it. The heartbeat's
 * {@link buildStorageTelemetry} block keeps the live numbers fresh afterwards;
 * this one is the declaration of intent, and it is deliberately explicit:
 *
 *   - `storage_configured` / `storage_resolved` are `true` as constants, because
 *     the node ALWAYS has a data directory — either the folder the operator
 *     chose or the hardcoded local default. There is no "unconfigured" state to
 *     report, and saying so is what stops the cloud from treating a perfectly
 *     good node as one that needs provisioning.
 *   - the directory travels under several names (`storage_data_dir`,
 *     `storage_directory`, `data_dir`, `data_directory`) because the fleet board
 *     reads whichever spelling its deployment was built against, and a node that
 *     reports the truth in only one of them looks silent in the others.
 *
 * `resolved` is stated as an absolute path so the cloud never has to guess
 * whether a relative value was resolved against the exe's folder or the CWD.
 */
export function buildStorageProfile(): {
  storage_configured: true;
  storage_resolved: true;
  storage_data_dir: string;
  storage_directory: string;
  data_directory: string;
  data_dir: string;
  scratch_capacity_gb: number | null;
  vault_capacity_gb: number | null;
  safe_vault_capacity_gb: number | null;
  storage_capacities_resolved: boolean;
} {
  const settings = readStorageSettings();
  // resolveDataDir() cannot throw any more, but a null still degrades to "" so
  // the profile is always sendable — a telemetry failure must never cost the
  // node its boot.
  const dir = settings.dataDir ?? "";
  return {
    storage_configured: true,
    storage_resolved: true,
    storage_data_dir: dir,
    storage_directory: dir,
    data_directory: dir,
    data_dir: dir,
    scratch_capacity_gb: settings.scratchCapacityGb,
    vault_capacity_gb: settings.safeVaultCapacityGb,
    safe_vault_capacity_gb: settings.safeVaultCapacityGb,
    // Capacities are optional on the node (a quota nobody set is reported as
    // null), so this says whether the two figures above are real.
    storage_capacities_resolved:
      settings.scratchCapacityGb !== null || settings.safeVaultCapacityGb !== null,
  };
}
