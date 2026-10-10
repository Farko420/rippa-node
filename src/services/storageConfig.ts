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
 * hand-editing `.env` and moving Windows folders by hand. The Mothership now
 * queues a `system_update_storage` command, delivered on the next heartbeat,
 * and this module carries it out:
 *
 *   1. WRITE: persist `RIPPA_DATA_DIR`, `SCRATCH_DRIVE_CAPACITY_GB`, and
 *      `SAFE_VAULT_CAPACITY_GB` in both `config.json` and the `.env` beside
 *      the executable.
 *   2. MIGRATE: copy persistent data from the old directory to the new one.
 *   3. VERIFY: compare every destination file against its source before the
 *      caller restarts.
 *   4. TELEMETRY: broadcast capacity and measured usage to the Mothership.
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
  /** True when the config was persisted. */
  applied: boolean;
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
    // LOCALAPPDATA missing and no override; the boot path reports that.
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
 */
export function parseStorageConfigRequest(args: Record<string, unknown>): StorageConfigRequest {
  if (!args || typeof args !== "object") {
    throw new Error("The storage update carried no payload.");
  }
  const request: StorageConfigRequest = {};

  const rawDir = pickString(args, "data_dir", "dataDir", "ripa_data_dir");
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

  if (
    request.dataDir === undefined &&
    request.scratchCapacityGb === undefined &&
    request.safeVaultCapacityGb === undefined
  ) {
    throw new Error("The storage update carried no directory and no capacities.");
  }
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
 */
export function applyStorageConfig(args: Record<string, unknown>): StorageConfigReport {
  const request = parseStorageConfigRequest(args);
  const from = resolveDataDir();
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
  const merged: Record<string, unknown> = {
    ...(current as Record<string, unknown>),
    ...(request.dataDir ? { RIPPA_DATA_DIR: request.dataDir } : {}),
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
    const check = readConfigLenient(to);
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
    changed: dirChanging,
    from,
    to,
    migrated,
    scratchCapacityGb,
    safeVaultCapacityGb,
  };
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
