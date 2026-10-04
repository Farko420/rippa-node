import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CONFIG_BACKUP_SUFFIX, CONFIG_TEMP_SUFFIX, LEGACY_BACKUP_SUFFIX, migrateLegacyData, resolveDataDir } from "../src/utils/paths";
import {
  readConfig,
  readConfigLenient,
  writeConfig,
} from "../src/config/configManager";

const base = fs.mkdtempSync(path.join(os.tmpdir(), "rippa-paths-"));
const legacy = path.join(base, "install");
const data = path.join(base, "appdata");
fs.mkdirSync(legacy, { recursive: true });
fs.mkdirSync(data, { recursive: true });
process.env.RIPPA_DATA_DIR = data;

const check = (name: string, pass: boolean, detail = ""): void => {
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
  if (!pass) process.exitCode = 1;
};

check("resolves the overridden persistent dir", resolveDataDir() === data, resolveDataDir());

// Simulate a pre-fix install: config + WAL database sitting beside the exe.
fs.writeFileSync(path.join(legacy, "config.json"), '{"NODE_API_KEY":"legacy-key-123456"}');
fs.writeFileSync(path.join(legacy, "local_knowledge.db"), "sqlite-bytes");
fs.writeFileSync(path.join(legacy, "local_knowledge.db-wal"), "wal-bytes");

const first = migrateLegacyData(legacy);
check("migrates config.json + db + wal", first.migrated.length === 3, first.migrated.join(","));
check("config copied into appdata", fs.existsSync(path.join(data, "config.json")));
check("wal copied (no silent data loss)", fs.existsSync(path.join(data, "local_knowledge.db-wal")));
check(
  "legacy files renamed to .legacy_backup",
  fs.existsSync(path.join(legacy, `config.json${LEGACY_BACKUP_SUFFIX}`)) &&
    !fs.existsSync(path.join(legacy, "config.json")),
);
check(
  "backup content is intact",
  fs.readFileSync(path.join(data, "config.json"), "utf8").includes("legacy-key-123456"),
);

// Idempotent + non-destructive: a re-run must not clobber the live config.
fs.writeFileSync(path.join(data, "config.json"), '{"NODE_API_KEY":"NEWER-key-999999"}');
const second = migrateLegacyData(legacy);
check("second run migrates nothing", second.migrated.length === 0);
check(
  "existing persistent config is never overwritten",
  fs.readFileSync(path.join(data, "config.json"), "utf8").includes("NEWER-key-999999"),
);

// A same-dir legacy source must be a harmless no-op.
const same = migrateLegacyData(data);
check("legacy dir === data dir is a no-op", same.migrated.length === 0);

// Automatic directory creation on a brand-new machine.
const fresh = path.join(base, "nested", "deeper", "RippaNode");

/* ---------------------------------------------------------------------------
 * CONFIG DURABILITY — THE "PC RESTART ERASES MY SETTINGS" REGRESSION.
 *
 * Reproduces the reported bug exactly: a config saved on a running node is
 * destroyed by an unclean shutdown, and the node must NOT come back with
 * defaults and a freshly minted node code.
 * ------------------------------------------------------------------------ */
const durable = fs.mkdtempSync(path.join(os.tmpdir(), "rippa-durable-"));
process.env.RIPPA_DATA_DIR = durable;
const configFile = path.join(durable, "config.json");

// A real, fully-configured operator setup.
const operatorConfig = {
  NODE_ROLE: "master",
  NODE_NAME: "Main Server PC",
  NODE_API_KEY: "sk-live-abcdef0123456789",
  MOTHERSHIP_URL: "https://mothership.example.com",
  DASHBOARD_PIN: "99001122",
  NODE_CODE: "RIPPA-TEST-0001",
};
writeConfig(durable, operatorConfig);
check(
  "a written config reads back intact",
  readConfig(durable)?.NODE_API_KEY === operatorConfig.NODE_API_KEY,
);
check("no temp file is left behind after a clean write", !fs.existsSync(configFile + CONFIG_TEMP_SUFFIX));

// A SECOND write must preserve the first as a recovery backup.
writeConfig(durable, { ...operatorConfig, DASHBOARD_PIN: "11223344" });
check(
  "the previous good config is retained as a backup",
  fs.existsSync(configFile + CONFIG_BACKUP_SUFFIX),
);

// THE BUG. Simulate a power cut during the write: the live file is truncated to
// a torn prefix, exactly as `fs.writeFileSync` leaves it mid-stream.
fs.writeFileSync(configFile, '{\n  "NODE_ROLE": "mas');

const recovered = readConfig(durable);
check(
  "a torn config.json is RECOVERED, not reported as a fresh machine",
  recovered?.NODE_API_KEY === operatorConfig.NODE_API_KEY,
  `api key = ${JSON.stringify(recovered?.NODE_API_KEY)}`,
);
check(
  "recovery restores the custom Mothership URL",
  recovered?.MOTHERSHIP_URL === "https://mothership.example.com",
  recovered?.MOTHERSHIP_URL,
);
check(
  "recovery preserves the operator's node code (no ghost identity)",
  recovered?.NODE_CODE === "RIPPA-TEST-0001",
  recovered?.NODE_CODE,
);
check(
  "the live config.json is self-healed on disk",
  readConfigLenient(durable)?.NODE_API_KEY === operatorConfig.NODE_API_KEY,
);

// The destructive follow-up: nodeAuth.persist() writes from whatever it reads.
// With recovery in place it must merge onto the real config, not onto defaults.
const persisted = readConfigLenient(durable) as Record<string, unknown> | null;
writeConfig(durable, { ...(persisted ?? {}), NODE_CREATED_AT: "2026-10-04T08:25:04.234Z" });
const afterPersist = readConfig(durable);
check(
  "a subsequent persist does NOT reset the API key to blank",
  afterPersist?.NODE_API_KEY === operatorConfig.NODE_API_KEY,
  `api key = ${JSON.stringify(afterPersist?.NODE_API_KEY)}`,
);
check(
  "a subsequent persist does NOT reset the node name to 'Unnamed Rippa Node'",
  afterPersist?.NODE_NAME === "Main Server PC",
  afterPersist?.NODE_NAME,
);

// An empty (0-byte) file is the other shape a torn write takes.
fs.writeFileSync(configFile, "");
check(
  "an emptied config.json is recovered from the backup too",
  readConfig(durable)?.NODE_API_KEY === operatorConfig.NODE_API_KEY,
);

// A genuinely fresh machine must still report "no config" — the backup must not

// A machine ALREADY in the wiped state must not promote that damage to "known
// good". Its first real save has to establish the backup, not inherit the void.
const wiped = fs.mkdtempSync(path.join(os.tmpdir(), "rippa-wiped-"));
fs.writeFileSync(
  path.join(wiped, "config.json"),
  JSON.stringify({
    NODE_ROLE: "master",
    NODE_NAME: "Unnamed Rippa Node",
    NODE_API_KEY: "",
    MOTHERSHIP_URL: "https://rippaadventures.com",
    DASHBOARD_PIN: "12031994",
  }),
);
writeConfig(wiped, { ...operatorConfig });
check(
  "an already-wiped config is NOT promoted as the recovery backup",
  !fs.existsSync(path.join(wiped, "config.json" + CONFIG_BACKUP_SUFFIX)),
);
writeConfig(wiped, { ...operatorConfig });
fs.writeFileSync(path.join(wiped, "config.json"), "");
check(
  "recovery after an already-wiped boot returns the operator's real settings",
  readConfig(wiped)?.NODE_API_KEY === operatorConfig.NODE_API_KEY,
);
fs.rmSync(wiped, { recursive: true, force: true, maxRetries: 5 });
// conjure settings that were never saved.
const virgin = fs.mkdtempSync(path.join(os.tmpdir(), "rippa-virgin-"));
check("a fresh machine with no config still reports null", readConfig(virgin) === null);
check("a fresh machine has no backup to recover from", readConfigLenient(virgin) === null);

// An unparseable backup must not be promoted as if it were good.
const broken = fs.mkdtempSync(path.join(os.tmpdir(), "rippa-broken-"));
fs.writeFileSync(path.join(broken, "config.json"), "{{{");
fs.writeFileSync(path.join(broken, "config.json" + CONFIG_BACKUP_SUFFIX), "not json at all");
check("a corrupt backup is not treated as a recovery source", readConfigLenient(broken) === null);

fs.rmSync(durable, { recursive: true, force: true, maxRetries: 5 });
fs.rmSync(virgin, { recursive: true, force: true, maxRetries: 5 });
fs.rmSync(broken, { recursive: true, force: true, maxRetries: 5 });
process.env.RIPPA_DATA_DIR = fresh;
migrateLegacyData(path.join(base, "does-not-exist"));
check("persistent dir created recursively on first boot", fs.existsSync(fresh), fresh);

fs.rmSync(base, { recursive: true, force: true, maxRetries: 5 });