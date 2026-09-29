import "../pkgNativeShim"; // must load before better-sqlite3 (packaged-exe native addon hook)
import Database from "better-sqlite3";
import path from "node:path";
import { env } from "../config";
import { resolveAppRoot } from "../config/configManager";

/**
 * THE DEEP BRAIN — local SQLite knowledge store.
 *
 * Master-only: satellites are stateless and never touch this file.
 * The database lives at `<app-root>/local_knowledge.db` — the project folder
 * in dev, or next to `rippa-node.exe` when packaged (the exe's virtual
 * filesystem is read-only, so it must never be created inside the snapshot).
 */

const DB_FILENAME = "local_knowledge.db";
const DB_PATH = path.join(resolveAppRoot(), DB_FILENAME);

export interface RawLoreRow {
  id: number;
  category: string;
  raw_text: string;
  source_url: string | null;
  status: string;
  created_at: string;
}

export interface VerifiedKnowledgeRow {
  id: number;
  category: string;
  fact_summary: string;
  confidence_score: number;
  coordinates: string | null;
  synced: number;
  created_at: string;
}

/** Input shape for inserting a verified fact (matches the LLM output schema). */
export interface VerifiedKnowledgeInput {
  category: string;
  fact_summary: string;
  confidence_score: number;
  coordinates: string | null;
}

const TABLES_SQL = `
  CREATE TABLE IF NOT EXISTS raw_lore (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    category    TEXT    NOT NULL,
    raw_text    TEXT    NOT NULL,
    source_url  TEXT,
    status      TEXT    NOT NULL DEFAULT 'pending',
    created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS verified_knowledge (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    category         TEXT    NOT NULL,
    fact_summary     TEXT    NOT NULL,
    confidence_score REAL    NOT NULL DEFAULT 0,
    coordinates      TEXT,
    synced           INTEGER NOT NULL DEFAULT 0,
    created_at       TEXT    NOT NULL DEFAULT (datetime('now'))
  );
`;

// Indexes are created separately so column migrations can run in between
// (CREATE TABLE IF NOT EXISTS will not add columns to a pre-existing table).
const INDEXES_SQL = `
  CREATE INDEX IF NOT EXISTS idx_raw_lore_status   ON raw_lore(status);
  CREATE INDEX IF NOT EXISTS idx_raw_lore_category ON raw_lore(category);
  CREATE INDEX IF NOT EXISTS idx_verified_knowledge_category ON verified_knowledge(category);
  CREATE INDEX IF NOT EXISTS idx_verified_knowledge_synced   ON verified_knowledge(synced);
`;

let instance: Database.Database | null = null;

/**
 * Initializes the Deep Brain database and creates the schema if missing.
 * Returns `null` on satellites (stateless nodes).
 */
export function initializeDeepBrain(): Database.Database | null {
  if (env.NODE_ROLE !== "master") {
    console.log("[Deep Brain] Skipped — satellites are stateless (NODE_ROLE !== 'master').");
    return null;
  }

  if (instance) {
    return instance;
  }

  instance = new Database(DB_PATH);
  instance.pragma("journal_mode = WAL");
  instance.exec(TABLES_SQL);

  // Migrate databases created before trickle-sync existed.
  const verifiedColumns = instance.pragma("table_info(verified_knowledge)") as Array<{ name: string }>;
  if (!verifiedColumns.some((column) => column.name === "synced")) {
    instance.exec("ALTER TABLE verified_knowledge ADD COLUMN synced INTEGER NOT NULL DEFAULT 0");
    console.log("[Deep Brain] Migrated verified_knowledge: added 'synced' column.");
  }

  instance.exec(INDEXES_SQL);

  console.log(`[Deep Brain] Initialized at ${DB_PATH}`);
  return instance;
}

/** Returns the initialized Deep Brain. Throws if called on a satellite / before init. */
export function getDeepBrain(): Database.Database {
  if (!instance) {
    throw new Error("Deep Brain is not initialized (master-only). Call initializeDeepBrain() first.");
  }
  return instance;
}

/** Closes the Deep Brain if it is open. Safe to call multiple times. */
export function closeDeepBrain(): void {
  if (instance) {
    instance.close();
    instance = null;
    console.log("[Deep Brain] Database connection closed.");
  }
}

// ---------------------------------------------------------------------------
// QUERY HELPERS — keeps SQL out of the agent/network layers.
// All helpers are master-only: they throw on satellites (getDeepBrain guard).
// ---------------------------------------------------------------------------

/** Inserts a scraped page into `raw_lore` with status `pending`. Returns the row id. */
export function insertRawLore(category: string, rawText: string, sourceUrl: string | null): number {
  const result = getDeepBrain()
    .prepare("INSERT INTO raw_lore (category, raw_text, source_url, status) VALUES (?, ?, ?, 'pending')")
    .run(category, rawText, sourceUrl);
  return Number(result.lastInsertRowid);
}

/** Updates the processing status of a `raw_lore` row (e.g. `extracted`, `unverified`, `failed`). */
export function setRawLoreStatus(id: number, status: string): void {
  getDeepBrain().prepare("UPDATE raw_lore SET status = ? WHERE id = ?").run(status, id);
}

/** Source URLs already captured in `raw_lore` — discovery uses this to avoid re-scraping. */
export function selectScrapedSourceUrls(): string[] {
  const rows = getDeepBrain()
    .prepare("SELECT DISTINCT source_url FROM raw_lore WHERE source_url IS NOT NULL")
    .all() as Array<{ source_url: string }>;
  return rows.map((row) => row.source_url);
}

/** Inserts a verified fact into `verified_knowledge` (starts unsynced). Returns the row id. */
export function insertVerifiedKnowledge(fact: VerifiedKnowledgeInput): number {
  const result = getDeepBrain()
    .prepare(
      "INSERT INTO verified_knowledge (category, fact_summary, confidence_score, coordinates) VALUES (?, ?, ?, ?)",
    )
    .run(fact.category, fact.fact_summary, fact.confidence_score, fact.coordinates);
  return Number(result.lastInsertRowid);
}

/** Returns up to `limit` verified facts not yet pushed to the Mothership (oldest first). */
export function selectUnsyncedKnowledge(limit: number): VerifiedKnowledgeRow[] {
  return getDeepBrain()
    .prepare("SELECT * FROM verified_knowledge WHERE synced = 0 ORDER BY id ASC LIMIT ?")
    .all(limit) as VerifiedKnowledgeRow[];
}

/** Marks the given `verified_knowledge` rows as synced to the Mothership. */
export function markKnowledgeSynced(ids: number[]): void {
  if (ids.length === 0) {
    return;
  }
  const placeholders = ids.map(() => "?").join(", ");
  getDeepBrain()
    .prepare(`UPDATE verified_knowledge SET synced = 1 WHERE id IN (${placeholders})`)
    .run(...ids);
}
