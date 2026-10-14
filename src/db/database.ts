import "../pkgNativeShim"; // must load before better-sqlite3 (packaged-exe native addon hook)
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { env } from "../config";
import { resolveAppRoot } from "../config/configManager";
import { ensureDataDir } from "../utils/paths";
import { migrateSwarmTriageColumns } from "./swarmTriageMigrations";

/**
 * THE DEEP BRAIN — local SQLite knowledge store.
 *
 * Master-only: satellites are stateless and never touch this file.
 * The database lives in the node's LOCAL data directory — `data\\` beside the
 * executable (see `utils/paths.ts`) — which the OTA updater never touches: it
 * replaces the .exe file in place and leaves the folder around it alone.
 */

const DB_FILENAME = "local_knowledge.db";

/**
 * Resolved lazily, NOT at module load: `initializeDeepBrain()` runs long after
 * boot has migrated any legacy database across, so a module-level constant
 * would freeze the pre-migration location.
 */
function resolveDbPath(): string {
  const dir = ensureDataDir();
  try {
    fs.mkdirSync(path.dirname(path.join(dir, DB_FILENAME)), { recursive: true });
  } catch {
    /* ensureDataDir already created it; a failure here surfaces on open */
  }
  return path.join(resolveAppRoot(), DB_FILENAME);
}

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

  -- THE CRAWL COOLDOWN — "this URL was read recently and yielded nothing".
  --
  -- Kept in the database rather than an in-memory map on purpose: the spin this
  -- fixes (one zero-candidate page re-crawled on every pass) must stay fixed
  -- across restarts, and a memory map would forget the verdict at 3am and start
  -- hammering again on the next boot. The "until" column is an ISO timestamp
  -- compared against the clock at read time, so an expired row simply stops
  -- matching — no timer needs to fire for the cooldown to lapse.
  CREATE TABLE IF NOT EXISTS crawl_cooldowns (
    url        TEXT PRIMARY KEY,
    until      TEXT NOT NULL,
    reason     TEXT,
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

  // Explicit absolute path into the persistent data directory — SQLite will
  // not create the file's parent folder on its own, so it must already exist.
  const dbPath = resolveDbPath();
  instance = new Database(dbPath);
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


   // Swarm Triage migration: add confidence_score, ai_auto_published, consensus_status.
   migrateSwarmTriageColumns(instance);

  instance.exec(INDEXES_SQL);

  console.log(`[Deep Brain] Initialized at ${dbPath}`);
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

// ---------------------------------------------------------------------------
// AUTONOMOUS FORAGING TARGETS (the idle tier's work queue)
// ---------------------------------------------------------------------------

/**
 * WHY THREE KINDS. "The node is never idle" needs a question the database can
 * actually answer, and "what should I learn next?" has exactly three answers
 * once the Mothership queue is empty:
 *
 *   OUTDATED   — a mirrored place whose live page has not been re-read in long
 *                (or ever). The mirror is a snapshot; it decays.
 *   UNVERIFIED — text already scraped into `raw_lore` that never became a
 *                verified fact. The cheapest possible win: the bytes are ALREADY
 *                on disk, so the forager pays only for extraction.
 *   INCOMPLETE — a mirrored place with no summary or description. Nothing in the
 *                node can answer questions about it yet.
 *
 * Three tables with three failure modes, so they stay three SELECTs. The
 * interleaving further down is what turns them into one queue.
 */

/** Which kind of gap a forage target fills. */
export type ForageTargetKind = "stale_place" | "unverified_lore" | "incomplete_place";

/** One unit of idle work, normalised across the three kinds above. */
export interface ForageTargetRow {
  kind: ForageTargetKind;
  /** The page to re-read. Null only for targets that carry their own text. */
  url: string | null;
  /** Human-readable identity for the log and the upstream payload. */
  label: string;
  /** The mirrored place this belongs to, when it belongs to one. */
  place_id: string | null;
  /** The `raw_lore` row this belongs to, when it belongs to one. */
  lore_id: number | null;
  /** ISO timestamp of the last live check, or NULL when never checked. */
  last_verified: string | null;
  /**
   * Text already on disk (unverified-lore targets). When present the forager
   * SKIPS the scrape entirely — re-fetching a page to re-read text we already
   * own would spend a network round-trip to learn nothing new.
   */
  raw_text: string | null;
}

/** Mirrored places that exist in the brain but carry no usable prose. */
export function selectIncompletePlaces(limit: number): ForageTargetRow[] {
  return getDeepBrain()
    .prepare(
      `SELECT 'incomplete_place' AS kind,
              source_url         AS url,
              name               AS label,
              id                 AS place_id,
              NULL               AS lore_id,
              last_verified      AS last_verified,
              NULL               AS raw_text
         FROM brain_places
        WHERE source_url IS NOT NULL AND source_url <> ''
          AND (summary IS NULL OR TRIM(summary) = ''
               OR description IS NULL OR TRIM(description) = '')
        ORDER BY last_verified ASC
        LIMIT ?`,
    )
    .all(limit) as ForageTargetRow[];
}

/**
 * Scraped text that was never promoted to a verified fact.
 *
 * `status IN ('pending','unverified')` covers both ways a row can stall: the
 * process died between the scrape and the extraction, or the model returned
 * something below the confidence gate. Either way the text is on disk and the
 * extraction can be retried without a single HTTP request.
 *
 * The text is truncated in SQL rather than in the caller. A 200 kB page is
 * 200 kB copied into this process's heap for every candidate examined, and the
 * extraction prompt cannot use past the first slice anyway.
 */
export function selectUnverifiedLore(limit: number): ForageTargetRow[] {
  return getDeepBrain()
    .prepare(
      `SELECT 'unverified_lore'            AS kind,
              source_url                 AS url,
              'raw_lore #' || id         AS label,
              NULL                       AS place_id,
              id                         AS lore_id,
              NULL                       AS last_verified,
              SUBSTR(raw_text, 1, 20000) AS raw_text
         FROM raw_lore
        WHERE status IN ('pending', 'unverified')
          AND source_url IS NOT NULL AND source_url <> ''
        ORDER BY created_at ASC
        LIMIT ?`,
    )
    .all(limit) as ForageTargetRow[];
}

/** Turns the stale-place rows into the shared forage shape. */
function stalePlaceTargets(rows: StalePlaceRow[]): ForageTargetRow[] {
  return rows.map((row) => ({
    kind: "stale_place" as const,
    url: row.source_url,
    label: row.name,
    place_id: row.id,
    lore_id: null,
    last_verified: row.last_verified,
    raw_text: null,
  }));
}

/**
 * THE IDLE TIER'S WORK QUEUE — one ordered, de-duplicated list of everything
 * the node could usefully learn next.
 *
 * INTERLEAVED, NOT APPENDED. Concatenating the three lists would let one kind
 * starve the others indefinitely: a mirror with 10 000 stale places would never
 * reach the unverified-lore backlog, so a single extraction failure would sit
 * unretried forever. Round-robin across the three sources fixes that — each
 * pass touches all three, so no category can be crowded out by the size of
 * another. Within a category the existing starvation-free ordering is kept
 * (never-verified first, then stalest).
 *
 * AND DE-DUPLICATED BY WHAT THE ROW IS, NOT BY WHICH LIST FOUND IT. A place
 * that is both overdue and missing a description is ONE piece of work found
 * twice, and spending two passes on it would be slower than doing either. When
 * that happens the row is PROMOTED to `incomplete_place`: it is the more
 * specific gap, and it is the one whose fix (attaching a chunk to the place)
 * the stale check would not perform.
 */
export function selectForageTargets(limit: number): ForageTargetRow[] {
  const perKind = Math.max(1, Math.ceil(limit / 3));
  const queues: ForageTargetRow[][] = [
    stalePlaceTargets(selectStalePlaces(perKind)),
    selectUnverifiedLore(perKind),
    selectIncompletePlaces(perKind),
  ];

  const merged: ForageTargetRow[] = [];
  // Identity -> its position in `merged`, so a later kind can upgrade an
  // earlier one instead of appending a duplicate.
  const positions = new Map<string, number>();

  for (let index = 0; merged.length < limit; index += 1) {
    let addedThisRound = 0;
    for (const queue of queues) {
      const row = queue[index];
      if (!row) continue;
      addedThisRound += 1;

      const key = String(row.place_id ?? row.lore_id ?? row.url ?? row.label);
      const existing = positions.get(key);
      if (existing !== undefined) {
        // Same row, second sighting: keep the more specific kind.
        if (row.kind === "incomplete_place") merged[existing].kind = "incomplete_place";
        continue;
      }
      positions.set(key, merged.length);
      merged.push(row);
      if (merged.length >= limit) break;
    }
    if (addedThisRound === 0) break; // every queue exhausted
  }
  return merged;
}

// ---------------------------------------------------------------------------
// CRAWL COOLDOWNS — the queue's "do not re-read this yet" list
// ---------------------------------------------------------------------------

/**
 * ARMS (OR RE-ARMS) A COOLDOWN ON `url`.
 *
 * This is the stop-the-spin half of the zero-yield fix: a page that returned
 * HTTP 200 and extracted cleanly but yielded NOTHING is recorded here so
 * `selectForageTargets` can skip it for the next `cooldownMs` instead of the
 * queue handing the same URL back on every pass.
 *
 * Written as an upsert keyed on the URL, so a second visit inside the window
 * extends rather than duplicates, and expired rows are purged on the write path
 * — the table is tiny either way, but "housekeeping happens somewhere" is better
 * than "housekeeping happens never".
 *
 * Master-only (throws on satellites / before `initializeDeepBrain`), like every
 * other helper in this file.
 */
export function recordCrawlCooldown(url: string, cooldownMs: number, reason: string): void {
  if (!url) return;
  const db = getDeepBrain();
  const now = Date.now();
  db.prepare("DELETE FROM crawl_cooldowns WHERE until <= ?").run(new Date(now).toISOString());
  db.prepare(
    `INSERT INTO crawl_cooldowns (url, until, reason) VALUES (?, ?, ?)
       ON CONFLICT(url) DO UPDATE SET until    = excluded.until,
                                      reason   = excluded.reason,
                                      updated_at = datetime('now')`,
  ).run(url, new Date(now + cooldownMs).toISOString(), reason);
}

/**
 * EVERY URL WHOSE COOLDOWN IS STILL LIVE — what the forager consults before it
 * picks a target. Expired rows never appear (compared against the caller's
 * `nowIso`, defaulting to this instant), so no timer has to fire for a cooldown
 * to lapse: it simply stops being returned.
 */
export function selectActiveCrawlCooldowns(nowIso = new Date().toISOString()): string[] {
  const rows = getDeepBrain()
    .prepare("SELECT url FROM crawl_cooldowns WHERE until > ?")
    .all(nowIso) as Array<{ url: string }>;
  return rows.map((row) => row.url);
}

/**
 * Links a newly learned fact to a mirrored place as a brain chunk.
 *
 * This is what closes the INCOMPLETE gap: a place with no prose gains prose,
 * and the knowledge is attached to the place rather than floating free in
 * `verified_knowledge` with no way to find it again. Returns the chunk id.
 */
export function insertBrainChunk(chunk: {
  id?: string;
  placeId: string | null;
  category: string | null;
  text: string;
  sourceUrl: string | null;
  confidence: number;
}): number {
  const result = getDeepBrain()
    .prepare(
      `INSERT INTO brain_chunks (id, place_id, category, text, source_url, confidence)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      chunk.id ??
        `kc_forage_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      chunk.placeId,
      chunk.category,
      chunk.text,
      chunk.sourceUrl,
      chunk.confidence,
    );
  return Number(result.lastInsertRowid);
}

/**
 * True when this node has a usable local brain.
 *
 * The forager asks this before every pass instead of relying on NODE_ROLE
 * alone: a Master whose database failed to open would otherwise throw out of
 * `getDeepBrain()` on the first query, and an idle-time crash must never be
 * able to take down the priority loop.
 */
export function isDeepBrainReady(): boolean {
  return instance !== null;
}
