import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LEGACY_BACKUP_SUFFIX, migrateLegacyData, resolveDataDir } from "../src/utils/paths";

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
process.env.RIPPA_DATA_DIR = fresh;
migrateLegacyData(path.join(base, "does-not-exist"));
check("persistent dir created recursively on first boot", fs.existsSync(fresh), fresh);

fs.rmSync(base, { recursive: true, force: true, maxRetries: 5 });