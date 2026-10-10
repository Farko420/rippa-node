/**
 * STORAGE CONFIGURATION - UNIT & INTEGRATION SUITE for the node-side
 * write -> migrate -> verify -> exit-42 chain (SYSTEM_UPDATE_STORAGE).
 *
 * Run: npm run build && node scripts/verify-storage.mjs
 *
 * Layout. The chain is written for the PRODUCTION layout, where the config
 * root IS the persistent data directory (RIPPA_CONFIG_ROOT unset):
 *   - RIPPA_DATA_DIR       -> data-A  (the old drive; the module samples from
 *                                 `resolveAppRoot()` == ensureDataDir() == data-A)
 *   - data-A/config.json   -> the file the migration copies, pre-migration
 *   - data-B               -> the new drive; the module writes config.json
 *                              VIA the config root, then migrates data-A -> data-B,
 *                              so the copied config.json ALREADY points at data-B
 *                              and the migration self-check passes.
 *   - cwd/node.env         -> the boot-level .env next to the executable, where
 *                              the module injects the three keys.
 *
 * Failures: exit 1. Results: PASS/FAIL lines.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { ROOT, check, results } from "./verify-harness.mjs";

const { parseStorageConfigRequest, applyStorageConfig, capacityFromEnv,
  readStorageSettings, buildStorageTelemetry } =
  await import(pathToFileURL(path.join(ROOT, "dist", "services", "storageConfig.js")).href);

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rippa-storage-"));
const dataDirA = path.resolve(tmpRoot, "data-A");
const dataDirB = path.resolve(tmpRoot, "data-B");

// The persistent tree the migration must copy, exactly the set applyStorageConfig
// considers persistent (no scratch/, bin/, .log / .sock suffixes).
fs.mkdirSync(dataDirA, { recursive: true });
fs.writeFileSync(path.join(dataDirA, "config.json"), JSON.stringify({
  RIPPA_DATA_DIR: dataDirA,
}, null, 2));
fs.writeFileSync(path.join(dataDirA, "local_knowledge.db"), "sqlite-database");
fs.mkdirSync(path.join(dataDirA, "models"), { recursive: true });
fs.writeFileSync(path.join(dataDirA, "models", "deepmodel.bin"), "model-weights");
fs.mkdirSync(path.join(dataDirA, "scratch"), { recursive: true });
fs.writeFileSync(path.join(dataDirA, "scratch", "token.bin"), "scratch-data");
fs.writeFileSync(path.join(dataDirA, "runtime.log"), "transient");
fs.writeFileSync(path.join(dataDirA, "run.pid.sock"), "transient");

// A pre-existing boot-level .env next to the executable: the module must
// inject the three keys while preserving every other line. Seeded at the
// harness's own CWD because resolveInstallDir() = process.cwd() in dev.
if (path.resolve(process.cwd()) === path.resolve(ROOT)) {
  console.error("Run this suite from a SCRATCH directory - it writes a boot-level .env into CWD.");
  process.exit(1);
}
fs.writeFileSync(path.join(process.cwd(), '.env'),
  "OLLAMA_URL=http://127.0.0.1:11434" + String.fromCharCode(10) +
  "PORT=5191" + String.fromCharCode(10));

// The module's own env overrides - everything else stays untouched.
process.env.RIPPA_DATA_DIR = dataDirA;
// =========================== parseStorageConfigRequest ============================

check(
  "parseStorageConfigRequest accepts a bare absolute data dir",
  (() => {
    const r = parseStorageConfigRequest({ data_dir: dataDirB });
    return r.dataDir === path.resolve(dataDirB) &&
      r.scratchCapacityGb === undefined &&
      r.safeVaultCapacityGb === undefined;
  })(),
  JSON.stringify(parseStorageConfigRequest({ data_dir: dataDirB })),
);


check(
  "parseStorageConfigRequest accepts the full snake_case payload",
  (() => {
    const r = parseStorageConfigRequest({
      data_dir: dataDirB,
      scratch_capacity_gb: 128,
      safe_vault_capacity_gb: 4096,
    });
    return r.dataDir === path.resolve(dataDirB) &&
      r.scratchCapacityGb === 128 &&
      r.safeVaultCapacityGb === 4096;
  })(),
  JSON.stringify(parseStorageConfigRequest({ data_dir: dataDirB, scratch_capacity_gb: 128, safe_vault_capacity_gb: 4096 })),
);

check(
  "parseStorageConfigRequest accepts camelCase aliases (internal wire format)",
  (() => {
    const r = parseStorageConfigRequest({
      dataDir: dataDirB,
      scratchCapacityGb: 128,
      safeVaultCapacityGb: 4096,
    });
    return r.dataDir === path.resolve(dataDirB) &&
      r.scratchCapacityGb === 128 &&
      r.safeVaultCapacityGb === 4096;
  })(),
  JSON.stringify(parseStorageConfigRequest({ dataDir: dataDirB, scratchCapacityGb: 128, safeVaultCapacityGb: 4096 })),
);

check(
  "parseStorageConfigRequest prefers snake_case over camelCase keys",
  (() => {
    const r = parseStorageConfigRequest({ data_dir: dataDirB, dataDir: path.resolve(tmpRoot) });
    return r.dataDir === path.resolve(dataDirB);
  })(),
  JSON.stringify(parseStorageConfigRequest({ data_dir: dataDirB, dataDir: path.resolve(tmpRoot) })),
);

check(
  "parseStorageConfigRequest rejects a relative path",
  (() => {
    try { parseStorageConfigRequest({ data_dir: "RippaNode" }); return false; } catch { return true; }
  })(),
  "relative paths are refused, not resolved against CWD",
);

check(
  "parseStorageConfigRequest rejects control characters",
  (() => {
    try { parseStorageConfigRequest({ data_dir: dataDirB + String.fromCharCode(0) }); return false; } catch { return true; }
  })(),
  "control characters are refused before they reach the file layer",
);

check(
  "parseStorageConfigRequest rejects a path over 260 chars",
  (() => {
    try { parseStorageConfigRequest({ data_dir: "A".repeat(261) }); return false; } catch { return true; }
  })(),
  "MAX_DATA_DIR_LENGTH is enforced",
);

check(
  "parseStorageConfigRequest rejects a filesystem root",
  (() => {
    try { parseStorageConfigRequest({ data_dir: "C:" + String.fromCharCode(92) }); return false; } catch { return true; }
  })(),
  "a root cannot become the data directory",
);

check(
  "parseStorageConfigRequest rejects a capacity below the floor",
  (() => {
    try { parseStorageConfigRequest({ scratch_capacity_gb: 0.05 }); return false; } catch { return true; }
  })(),
  "MIN_CAPACITY_GB is enforced",
);

check(
  "parseStorageConfigRequest rejects a capacity above the ceiling",
  (() => {
    try { parseStorageConfigRequest({ safe_vault_capacity_gb: 1024 * 1024 * 2 }); return false; } catch { return true; }
  })(),
  "MAX_CAPACITY_GB is enforced",
);

check(
  "parseStorageConfigRequest accepts numeric strings and rounds to 2dp",
  (() => {
    const r = parseStorageConfigRequest({ scratch_capacity_gb: "12.345" });
    return r.scratchCapacityGb === 12.35;
  })(),
  JSON.stringify(parseStorageConfigRequest({ scratch_capacity_gb: "12.345" })),
);

check(
  "parseStorageConfigRequest requires a directory or a capacity",
  (() => {
    try { parseStorageConfigRequest({}); return false; } catch { return true; }
  })(),
  "an empty payload is a broken command, not a no-op",
);

// Telemetry sanity checks: buildStorageTelemetry must expose the exact wire keys
// the Mothership normalises, and must report the currently configured quotas.

check(
  'buildStorageTelemetry exposes the Mothership wire keys before any apply',
  (() => {
    const t = buildStorageTelemetry();
    return t.storage_data_dir === dataDirA &&
      t.scratch_capacity_gb === null &&
      t.vault_capacity_gb === null &&
      t.scratch_used_gb === null &&
      t.vault_used_gb === null;
  })(),
  JSON.stringify(buildStorageTelemetry()),
);


// ========================== applyStorageConfig (real chain) ==========================

check(
  "applyStorageConfig copies the persistent tree and verifies it",
  (() => {
    const report = applyStorageConfig({ data_dir: dataDirB });
    const expected = [
      "config.json",
      "local_knowledge.db",
      "models",
    ];
    const got = fs.readdirSync(dataDirB).filter((n) => n !== "scratch").sort();
    const ok =
      report.applied === true &&
      report.changed === true &&
      report.from === dataDirA &&
      report.to === dataDirB &&
      Array.isArray(report.migrated) &&
      report.migrated.length === 3 &&
      report.migrated.every((m) => expected.includes(m)) &&
      got.length === expected.length &&
      got.every((m, i) => m === expected[i]) &&
      fs.existsSync(path.join(dataDirB, "config.json")) &&
      JSON.parse(fs.readFileSync(path.join(dataDirB, "config.json"), "utf8")).RIPPA_DATA_DIR === dataDirB &&
      fs.existsSync(path.join(dataDirA, "config.json"));
    return ok;
  })(),
  (() => {
    const report = applyStorageConfig({ data_dir: dataDirB });
    return report && report.migrated ? report.migrated.join(",") : "none";
  })(),
);

check(
  "applyStorageConfig leaves the legacy directory as a backup, not the destination",
  (() => {
    return fs.existsSync(path.join(dataDirA, 'config.json')) &&
      !fs.existsSync(path.join(dataDirB, 'runtime.log'));
  })(),
  "",
);

check(
  "capacity-only apply keeps the configured data directory and updates the quotas in place",
  (() => {
    const before = process.env.RIPPA_DATA_DIR;
    const report = applyStorageConfig({ scratch_capacity_gb: 128, safe_vault_capacity_gb: 2048 });
    return report.applied === true && report.changed === false &&
      report.scratchCapacityGb === 128 && report.safeVaultCapacityGb === 2048 &&
      report.migrated.length === 0 &&
      process.env.RIPPA_DATA_DIR === before;
  })(),
  JSON.stringify(applyStorageConfig({ scratch_capacity_gb: 128, safe_vault_capacity_gb: 2048 })),
);

check(
  "applyStorageConfig injects the three keys into the boot-level .env and keeps OLLAMA_URL",
  (() => {
    const text = fs.readFileSync(path.join(process.cwd(), '.env'), 'utf8');
    const lines = text.split(/\r?\n/);
    const map = Object.fromEntries(lines.map((l) => l.split('=', 2)));
    const unq = (s) => (s ?? '').replace(/^"(.*)"$/, '$1');
    return (
      unq(map['RIPPA_DATA_DIR']) === dataDirB &&
      unq(map['SCRATCH_DRIVE_CAPACITY_GB']) === '128' &&
      unq(map['SAFE_VAULT_CAPACITY_GB']) === '2048' &&
      unq(map['OLLAMA_URL']) === 'http://127.0.0.1:11434'
    );
  })(),
  fs.readFileSync(path.join(process.cwd(), '.env'), 'utf8').slice(0, 300),
);

check(
  "re-applying the identical configuration is a no-op (no second migration, no second restart signal)",
  (() => {
    const before = process.env.RIPPA_DATA_DIR;
    const beforeConfig = fs.readFileSync(path.join(dataDirA, 'config.json'), 'utf8');
    const report = applyStorageConfig({ data_dir: dataDirB });
    const afterConfig = fs.readFileSync(path.join(dataDirA, 'config.json'), 'utf8');
    return report.applied === true && report.changed === false &&
      report.migrated.length === 0 &&
      process.env.RIPPA_DATA_DIR === before &&
      afterConfig === beforeConfig;
  })(),
  JSON.stringify(applyStorageConfig({ data_dir: dataDirB })),
);

check(
  "applyStorageConfig refuses a nested (overlapping) target",
  (() => {
    try { applyStorageConfig({ data_dir: path.join(dataDirB, 'models') });
      return false; } catch { return true; }
  })(),
  "overlapping source/destination is refused",
);

check(
  "applyStorageConfig refuses an out-of-range capacity",
  (() => {
    try { applyStorageConfig({ scratch_capacity_gb: 0.05 }); return false; } catch { return true; }
  })(),
  "MIN_CAPACITY_GB is enforced on apply",
);

check(
  "applyStorageConfig refuses a control-character directory",
  (() => {
    try { applyStorageConfig({ data_dir: dataDirB + String.fromCharCode(0) }); return false; } catch { return true; }
  })(),
  "control characters are refused on apply",
);


// =============================== contract pins (exit 42) ===============================

// The `UPDATE_STORAGE` command handler in `src/index.ts` is the app entry point
// (module top-level `startNodeServices()`), so it cannot be imported by this
// harness. Its exit-42 contract is pinned here at the source level: the wrapper
// in `src/index.ts` passes `EXIT_RESTART` (42) when a directory change happens,
// and `src/update/exitCodes.ts` documents EXIT_RESTART = 42 ('admin pressed
// Restart', the watchdog relaunches immediately). These asserts only verify that
// the two files agree on the protocol.

const srcIndex = fs.readFileSync(path.join(ROOT, 'src', 'index.ts'), 'utf8');
const srcExitCodes = fs.readFileSync(path.join(ROOT, 'src', 'update', 'exitCodes.ts'), 'utf8');
check(
  'wrapper drives a directory change to exit code 42 (STORAGE_MIGRATION + EXIT_RESTART)',
  srcIndex.includes('STORAGE_MIGRATION') && srcIndex.includes('EXIT_RESTART') &&
    srcExitCodes.includes('export const EXIT_RESTART = 42'),
  'src/index.ts drives a directory change to exit 42; exitCodes.ts maps 42 to restart',
);

// buildStorageTelemetry must carry the exact keys the Mothership normalises,
// and after the full apply chain it reports the applied directory and quotas.
check(
  'buildStorageTelemetry reports the applied directory and the configured quotas',
  (() => {
    const t = buildStorageTelemetry();
    return t.storage_data_dir === dataDirB &&
      t.scratch_capacity_gb === 128 &&
      t.vault_capacity_gb === 2048 &&
      t.vault_used_gb === null &&
      t.scratch_used_gb === null;
  })(),
  JSON.stringify(buildStorageTelemetry()),
);

// capacityFromEnv honours the same floor and ceiling as the parser.
check(
  'capacityFromEnv floors and ceilings at the same bounds as the parser',
  capacityFromEnv('X', { X: '0.05' }) === null &&
    capacityFromEnv('X', { X: '12.345' }) === 12.35 &&
    capacityFromEnv('X', { X: String(2 ** 21) }) === null,
  JSON.stringify([capacityFromEnv('X', { X: '0.05' }), capacityFromEnv('X', { X: '12.345' }), capacityFromEnv('X', { X: String(2 ** 21) })]),
);

// ============================ teardown & summary ============================

fs.rmSync(tmpRoot, { recursive: true, force: true });

console.log('');
console.log('STORAGE SUITE: ' + results.filter((r) => !r.pass).length + ' failing, ' + results.length + ' total');
process.exit(results.some((r) => !r.pass) ? 1 : 0);

