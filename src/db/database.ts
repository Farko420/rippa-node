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

  -- ---------------------------------------------------------------------------
  -- THE MASTER BRAIN MIRROR (migration target: RIPPA_BRAIN_BUNDLE_V1)
  -- ---------------------------------------------------------------------------
  -- A node's own scraped knowledge lives in raw_lore / verified_knowledge above.
  -- These four tables are something different and deliberately separate: they hold
  -- a COPY of what the Mothership already knows, so a freshly-built node can
  -- answer offline questions instead of starting empty.
  --
  -- SEPARATE TABLES, NOT EXTRA COLUMNS ON verified_knowledge. The two have
  -- opposite lifecycles and opposite owners. verified_knowledge is written by this
  -- node's LLM and trickles UP to the cloud; brain_places is written wholesale by
  -- the cloud and never trickles anywhere. Merging them would mean every bundle
  -- load had to decide which side owns a row that both believe they own, and the
  -- first upload that got it wrong would either duplicate places or delete the
  -- node's own findings.
  --
  -- EVERY ID IS THE CLOUD'S ID, and that is what makes the mirror a mirror: the
  -- primary key is the same locations.id, so a second upload replaces rather
  -- than accumulates, and "1:1 parity" is a fact that can be checked rather than
  -- an impression.
  CREATE TABLE IF NOT EXISTS brain_places (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    slug          TEXT,
    summary       TEXT,
    description   TEXT,
    town          TEXT,
    region        TEXT,
    state         TEXT,
    lat           REAL,
    lng           REAL,
    category_ids  TEXT,   -- JSON array, as the cloud stores it
    source_url    TEXT,
    synced_at     TEXT NOT NULL DEFAULT (datetime('now')),
    -- NULL means "this node has never verified this place against the live
    -- site". That is deliberately NOT the same as synced_at above, which only
    -- records that the cloud's copy arrived. The idle verification engine orders
    -- by this column so never-checked and long-stale places surface first, and
    -- NULLs sort first under ORDER BY last_verified ASC.
    last_verified TEXT
  );

  CREATE TABLE IF NOT EXISTS brain_categories (
    id        TEXT PRIMARY KEY,
    label     TEXT,
    synced_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- A tag and its members are ONE ROW, not a tag table plus a join table. The
  -- bundle carries membership as an array on the tag, and mirroring that shape
  -- avoids a second table plus N inserts for what is read as a single unit.
  CREATE TABLE IF NOT EXISTS brain_tags (
    id         TEXT PRIMARY KEY,
    label      TEXT NOT NULL,
    place_ids  TEXT,   -- JSON array
    synced_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS brain_chunks (
    id          TEXT PRIMARY KEY,
    place_id    TEXT,   -- nullable: a learned fact need not belong to a place
    category    TEXT,
    text        TEXT NOT NULL,
    source_url  TEXT,
    confidence  REAL,
    synced_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS brain_road_features (
    id        TEXT PRIMARY KEY,
    name      TEXT,
    kind      TEXT,
    lat       REAL,
    lng       REAL,
    synced_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- THE SYNC CURSOR, in its own table rather than a file beside the database.
  --
  -- A sidecar JSON file was the obvious first choice and it is the wrong one: the
  -- database is the thing being written, so a cursor kept outside it can claim a
  -- sync that a crashed transaction never committed. Inside the same transaction
  -- as the rows, "the cursor says 12:04" and "the rows are as of 12:04" cannot
  -- disagree — which is the entire point of storing it at all.
  CREATE TABLE IF NOT EXISTS brain_sync_state (
    key        TEXT PRIMARY KEY,
    value      TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`;

// Indexes are created separately so column migrations can run in between
// (CREATE TABLE IF NOT EXISTS will not add columns to a pre-existing table).
const INDEXES_SQL = `
  CREATE INDEX IF NOT EXISTS idx_raw_lore_status   ON raw_lore(status);
  CREATE INDEX IF NOT EXISTS idx_raw_lore_category ON raw_lore(category);
  CREATE INDEX IF NOT EXISTS idx_verified_knowledge_category ON verified_knowledge(category);
  CREATE INDEX IF NOT EXISTS idx_verified_knowledge_synced   ON verified_knowledge(synced);

  -- The mirror's hot paths. Place lookup by name is the one that matters: a node
  -- answering "is there a waterfall near X" is doing a LIKE over this table, and
  -- without an index that scan is the entire cost of the feature.
  CREATE INDEX IF NOT EXISTS idx_brain_places_name   ON brain_places(name COLLATE NOCASE);
  CREATE INDEX IF NOT EXISTS idx_brain_places_town   ON brain_places(town COLLATE NOCASE);
  CREATE INDEX IF NOT EXISTS idx_brain_places_state  ON brain_places(state COLLATE NOCASE);
  CREATE INDEX IF NOT EXISTS idx_brain_chunks_place  ON brain_chunks(place_id);
  CREATE INDEX IF NOT EXISTS idx_brain_chunks_cat    ON brain_chunks(category COLLATE NOCASE);
  CREATE INDEX IF NOT EXISTS idx_brain_roads_kind    ON brain_road_features(kind);
  -- The idle verification engine's hot path: oldest-verified-first.
  CREATE INDEX IF NOT EXISTS idx_brain_places_stale   ON brain_places(last_verified);
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

  // Same for the idle verification engine's staleness marker. CREATE TABLE IF
  // NOT EXISTS silently leaves an existing table alone, so an already-deployed
  // node needs the ALTER or the engine would fail on a missing column forever.
  const placeColumns = instance.pragma("table_info(brain_places)") as Array<{ name: string }>;
  if (!placeColumns.some((column) => column.name === "last_verified")) {
    instance.exec("ALTER TABLE brain_places ADD COLUMN last_verified TEXT");
    console.log("[Deep Brain] Migrated brain_places: added 'last_verified' column.");
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

/** A mirrored place, reduced to what a verification task needs. */
export interface StalePlaceRow {
  id: string;
  name: string;
  /** The live page to re-check. Null when the cloud never recorded a source. */
  source_url: string | null;
  town: string | null;
  state: string | null;
  summary: string | null;
  last_verified: string | null;
}

/**
 * THE IDLE VERIFICATION QUERY.
 *
 * Returns the places whose facts have gone longest without a check —
 * never-verified ones first (NULL sorts first in SQLite), then the stalest.
 *
 * `synced_at` is deliberately NOT used here: it records when the cloud's copy
 * ARRIVED, which says nothing about whether the underlying page still says what
 * the mirror claims. A place can be freshly synced and still months out of date.
 *
 * Places with no `source_url` are excluded — there is no page to re-check, so
 * scheduling a "verify" task for one would burn a scrape slot to re-fetch
 * nothing, forever.
 */
export function selectStalePlaces(limit: number): StalePlaceRow[] {
  return getDeepBrain()
    .prepare(
      `SELECT id, name, source_url, town, state, summary, last_verified
         FROM brain_places
        WHERE source_url IS NOT NULL AND source_url <> ''
        ORDER BY last_verified ASC
        LIMIT ?`,
    )
    .all(limit) as StalePlaceRow[];
}

/** Stamps a place as freshly verified, so the engine stops re-checking it. */
export function markPlaceVerified(id: string, at = new Date().toISOString()): void {
  getDeepBrain()
    .prepare("UPDATE brain_places SET last_verified = ? WHERE id = ?")
    .run(at, id);
}
