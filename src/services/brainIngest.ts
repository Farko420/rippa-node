/**
 * MASTER BRAIN INGESTION — loads a `RIPPA_BRAIN_BUNDLE_V1` into the node's mirror.
 *
 * THE THREE JOBS, in the order they matter.
 *
 *   1. REFUSE anything that is not a bundle. This file arrives by drag-and-drop
 *      from a human's Downloads folder, so "it came from our own export" is an
 *      assumption with no evidence behind it. The format tag is checked exactly,
 *      and a file that is not a bundle never reaches SQLite.
 *
 *   2. WRITE IT ALL OR NONE OF IT. Every insert runs inside one
 *      `BEGIN IMMEDIATE … COMMIT`. This is the part that makes "1:1 parity" a
 *      claim the operator can rely on: a load that dies half-way — power cut,
 *      disk full, a malformed row 40,000 rows in — leaves the node exactly as it
 *      was, still answering from the previous bundle, rather than half-updated and
 *      confidently reporting success. The cursor moves inside the same
 *      transaction for the same reason.
 *
 *   3. REPORT HONESTLY. The returned counts are what was actually written, not
 *      what the file claimed. A badge that says "1:1 parity" has to be checkable.
 *
 * WHY `BEGIN IMMEDIATE` AND NOT `BEGIN`. A deferred transaction takes its write
 * lock lazily, at the first write, so two concurrent loads can both read, then
 * both try to upgrade, and SQLite resolves the loser with SQLITE_BUSY — after it
 * has already done the reading. `IMMEDIATE` takes the write lock up front, so a
 * second load waits (bounded by `busy_timeout`) and then sees the committed
 * result. On a dashboard with a double-click in it, that is the difference between
 * "the second click was a no-op" and an error dialog.
 *
 * WHAT THIS DOES NOT DO. It does not touch `raw_lore` or `verified_knowledge` —
 * this node's OWN scraped knowledge. The mirror and the node's findings are
 * separate tables (see db/database.ts) with separate lifecycles, and a bundle
 * upload must never be able to delete something this machine worked out itself.
 */
import { getDeepBrain } from "../db/database";

/** The format tag, checked exactly. See the header on why "exact". */
export const BRAIN_BUNDLE_FORMAT = "RIPPA_BRAIN_BUNDLE_V1";

/** The sync-cursor key. Named, not positional, so a future cursor can coexist. */
export const LAST_SYNC_KEY = "last_sync_timestamp";

/**
 * HOW LONG A WRITE LOCK IS WAITED FOR, in milliseconds.
 *
 * Set on the connection inside the transaction and restored after, because it is
 * the one setting that must NOT leak into the node's steady-state scraping: a
 * long busy timeout on the scraper's own writes would turn a concurrent bundle
 * load into a ten-second stall on every insert it tried meanwhile.
 */
const BUSY_TIMEOUT_MS = 10_000;

/** The largest upload this endpoint will accept, in bytes (~256 MB). */
export const MAX_BUNDLE_BYTES = 256 * 1024 * 1024;

/** What a load reports back to the dashboard. */
export interface BrainIngestResult {
  ok: boolean;
  /** Human-readable and safe to render. On failure it says what was wrong. */
  message: string;
  /** The bundle's `exported_at`, now the node's sync cursor. */
  lastSync: string | null;
  counts: {
    places: number;
    categories: number;
    tags: number;
    knowledge_chunks: number;
    road_features: number;
  };
  /** Non-fatal notes: rows skipped, an older bundle, and so on. */
  warnings: string[];
}

/** Coerces to a bounded string, or null. Never returns a number or an object. */
function str(value: unknown, max = 4000): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

/** Coerces to a finite number, or null. `Number(null)` being 0 is the trap. */
function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * ONE PROGRESS TICK FROM THE INGESTION ENGINE.
 *
 * The operator is watching a bar for a load that can take tens of seconds, and a
 * bar that only ever shows "100%" at the end is indistinguishable from a frozen
 * page. These are the four numbers the UI needs and nothing else.
 */
export interface BrainIngestProgress {
  /** Coarse phase name, e.g. "places", "knowledge_chunks". */
  phase: string;
  /** Human sentence for the status label, e.g. "Syncing chunks…". */
  detail: string;
  /** 0-100 across the whole load. */
  percent: number;
  /** Rows written so far across every collection. */
  written: number;
  /** Rows the bundle is expected to carry, for the `written/total` readout. */
  total: number;
}

/** Called as the load advances. May be sync or async; awaited either way. */
export type BrainIngestProgressListener = (
  progress: BrainIngestProgress,
) => void | Promise<void>;

/**
 * Rows written between progress reports.
 *
 * Deliberately not 1. Reporting every row would mean 50,000 SSE frames for a
 * bundle that finishes in a few seconds — the flood would cost more than the
 * work it describes. This keeps updates frequent enough to look continuous while
 * the insert loop is the only thing running.
 */
const PROGRESS_CHUNK_ROWS = 250;

/**
 * Yields to the event loop so queued SSE frames actually reach the browser.
 *
 * better-sqlite3 is synchronous, so without this the whole ingestion runs inside
 * one uninterrupted tick: every progress event is published, but none of them is
 * ever *written* until the last row lands, and the operator sees a bar that
 * jumps 0 -> 100. One `setImmediate` per chunk is enough to drain the socket.
 */
function yieldToEventLoop(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

/** Keeps only strings, capped, so an array cannot smuggle objects into a JSON column. */
function strArray(value: unknown, maxItems: number): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const item = entry.trim().slice(0, 64);
    if (item) out.push(item);
    if (out.length >= maxItems) break;
  }
  return out;
}

/**
 * Checks a parsed JSON value is a brain bundle this node can load.
 *
 * Mirrors the Mothership's validator, deliberately, because the two are written
 * against one contract: a bundle the cloud considers valid must be one this node
 * considers valid. Where they could disagree the NODE is the stricter side, since
 * this is the side that writes to disk.
 *
 * A MISSING collection is tolerated — a bundle may legitimately carry none, and
 * the writer treats absent and empty identically. A collection of the wrong
 * TYPE is refused, because every reader downstream assumes an array and would
 * otherwise iterate a string's characters.
 */
export function validateBundle(
  raw: unknown,
): { ok: true; bundle: Record<string, unknown> } | { ok: false; error: string } {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "That file is not a JSON object — is it really a Rippa brain bundle?" };
  }
  const input = raw as Record<string, unknown>;
  if (input["format"] !== BRAIN_BUNDLE_FORMAT) {
    return {
      ok: false,
      error: `Unrecognised bundle format (found ${JSON.stringify(input["format"] ?? null)}, expected "${BRAIN_BUNDLE_FORMAT}").`,
    };
  }
  const exportedAt = input["exported_at"];
  if (typeof exportedAt !== "string" || !Number.isFinite(Date.parse(exportedAt))) {
    return { ok: false, error: 'The bundle has no usable "exported_at" timestamp.' };
  }
  for (const key of ["places", "categories", "tags", "knowledge_chunks", "road_features"]) {
    const value = input[key];
    if (value !== undefined && value !== null && !Array.isArray(value)) {
      return { ok: false, error: `"${key}" must be an array.` };
    }
  }
  return { ok: true, bundle: input };
}

/** Reads one value out of `brain_sync_state`, or null. Never throws. */
export function getSyncCursor(): string | null {
  try {
    const row = getDeepBrain()
      .prepare("SELECT value FROM brain_sync_state WHERE key = ?")
      .get(LAST_SYNC_KEY) as { value?: string } | undefined;
    return typeof row?.value === "string" ? row.value : null;
  } catch {
    return null;
  }
}

/** Row counts of the mirror, for the dashboard's status tile. */
export function getBrainCounts(): BrainIngestResult["counts"] {
  const db = getDeepBrain();
  const count = (table: string): number => {
    try {
      const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n?: number };
      return typeof row?.n === "number" ? row.n : 0;
    } catch {
      return 0;
    }
  };
  return {
    places: count("brain_places"),
    categories: count("brain_categories"),
    tags: count("brain_tags"),
    knowledge_chunks: count("brain_chunks"),
    road_features: count("brain_road_features"),
  };
}

/** Row count of any bundle collection, tolerating a missing or wrong-typed one. */
function countRows(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

/**
 * LOADS A BUNDLE, ALL AT ONCE OR NOT AT ALL.
 *
 * The whole write is one explicit `BEGIN IMMEDIATE … COMMIT`. Nothing is prepared
 * outside it and nothing is committed inside it piecemeal, so a failure anywhere —
 * a constraint, a full disk, a bad row at position 40,000 — reaches the `catch`,
 * issues `ROLLBACK`, and leaves the node's previous brain exactly as it was. There
 * is deliberately NO "partial import" mode: a half-loaded brain is worse than a
 * stale one, because the operator cannot tell which half is real.
 *
 * `INSERT OR REPLACE`, not `INSERT`. The primary keys are the cloud's ids, so
 * re-uploading the same bundle twice is a no-op rather than a duplicate-key error,
 * and uploading a NEWER bundle updates the rows that changed instead of appending
 * a second version of every place. `OR REPLACE` is also why these tables must not
 * carry a local `AUTOINCREMENT` surrogate — the cloud id IS the identity.
 *
 * THE STALE-BUNDLE GUARD. A bundle whose `exported_at` is OLDER than the node's
 * current cursor is refused unless `force` is set. An operator with two Downloads
 * windows open can otherwise upload last Tuesday's file over this morning's, and
 * the node would silently roll back to older knowledge while reporting a cheerful
 * success. The override is explicit because "yes, really load the older one" is a
 * legitimate thing to want after a bad export.
 *
 * THE COUNTS COME FROM COUNTING, not from the file. The bundle's own `counts`
 * block is untrusted input and is never used for the badge — a truncated or
 * hand-edited file claiming 5,000 places while carrying 400 must not produce a
 * "1:1 parity locked" message over 400 rows.
 *
 * `allowPlaceLess` RELAXES THE EMPTY-PLACES REFUSAL, and only for callers that
 * know they are feeding an INCREMENT rather than a whole-brain bundle. The
 * refusal below is right for an operator drag-and-drop — a full export with no
 * places really does mean "erase everything" — but wrong for a trickle-sync
 * delta, whose most common shape is "new facts about places you already have".
 * Off by default, so the upload path keeps its protection; see the second guard
 * for the condition that still applies even when the flag is on.
 */
export async function ingestBrainBundle(
  raw: unknown,
  options: { force?: boolean; allowPlaceLess?: boolean; onProgress?: BrainIngestProgressListener } = {},
): Promise<BrainIngestResult> {
  const onProgress = options.onProgress;
  /** Total rows the bundle claims to carry, for the progress denominator. */
  const rowTotal = (key: string): number =>
    Array.isArray((raw as Record<string, unknown> | null)?.[key])
      ? ((raw as Record<string, unknown>)[key] as unknown[]).length
      : 0;
  const totalRows =
    rowTotal("places") +
    rowTotal("categories") +
    rowTotal("tags") +
    rowTotal("knowledge_chunks") +
    rowTotal("road_features");

  /**
   * Publishes one tick and yields so the frame is actually flushed.
   *
   * The yield is what makes this honest: without it the whole load runs in one
   * tick, the frames queue up on the socket, and the bar jumps 0 -> 100 the
   * instant the last row lands. See `yieldToEventLoop`.
   */
  const report = async (phase: string, detail: string, written: number): Promise<void> => {
    if (!onProgress) return;
    await onProgress({
      phase,
      detail,
      percent: totalRows > 0 ? Math.min(100, Math.round((written / totalRows) * 100)) : 0,
      written,
      total: totalRows,
    });
    await yieldToEventLoop();
  };

  const empty: BrainIngestResult["counts"] = {
    places: 0,
    categories: 0,
    tags: 0,
    knowledge_chunks: 0,
    road_features: 0,
  };
  const fail = (message: string, warnings: string[] = []): BrainIngestResult => ({
    ok: false,
    message,
    lastSync: null,
    counts: empty,
    warnings,
  });

  const checked = validateBundle(raw);
  if (!checked.ok) return fail(checked.error);
  const bundle = checked.bundle;
  const warnings: string[] = [];

  const exportedAt = String(bundle["exported_at"]).trim();
  const previous = getSyncCursor();
  if (
    !options.force &&
    previous &&
    Number.isFinite(Date.parse(exportedAt)) &&
    Date.parse(exportedAt) < Date.parse(previous)
  ) {
    return fail(
      `This bundle is OLDER than what is already loaded (bundle ${exportedAt}, node ${previous}). ` +
        "Re-upload with force if you really want to roll the node back.",
    );
  }

  /*
    AN EMPTY BUNDLE IS REFUSED OUTRIGHT, and this is the one guard that is about
    protecting the operator rather than the file.

    A bundle with zero places is structurally VALID — a brand-new Mothership
    legitimately exports nothing. But loading it would DELETE every place this node
    knows, and the dashboard would then report "1:1 parity locked" over an empty
    database. The node cannot tell an intentional wipe from a mistake, and by the
    time the operator sees the badge the knowledge is already gone, so the refusal
    has to happen here.
  */
  const placeRows = Array.isArray(bundle["places"])
    ? (bundle["places"] as Record<string, unknown>[])
    : [];
  if (placeRows.length === 0 && !options.allowPlaceLess) {
    return fail(
      "That bundle contains no places. Refusing to load it, because it would erase what this node " +
        "already knows. Export from the Mothership once it has verified places.",
    );
  }

  /*
    A PLACE-LESS PAYLOAD THAT IS ENTIRELY EMPTY IS STILL REFUSED, even with
    `allowPlaceLess`. The flag exists for the knowledge-only INCREMENT (facts,
    no places) and this guard is what stops it being used to smuggle a no-op
    through: an empty payload would advance the cursor past changes the node
    never actually stored, which is the exact silent-data-loss failure the cursor
    design exists to prevent. `BrainDeltaSync` already short-circuits the empty
    case before calling, so this only fires on a malformed delta.
  */
  if (placeRows.length === 0 && options.allowPlaceLess) {
    const totalNonPlaceRows =
      countRows(bundle["categories"]) +
      countRows(bundle["tags"]) +
      countRows(bundle["knowledge_chunks"]) +
      countRows(bundle["road_features"]);
    if (totalNonPlaceRows === 0) {
      return fail(
        "That payload contains neither places nor any other records, so applying it would advance " +
          "the sync cursor without storing anything. Refusing.",
      );
    }
  }

  const db = getDeepBrain();
  const stamp = new Date().toISOString();

  /*
    STATEMENTS PREPARED ONCE, OUTSIDE THE ROW LOOP, and reused for every row.
    Re-preparing per row is the single biggest avoidable cost in a 50,000-row load
    — better-sqlite3 compiles the SQL each time. They are prepared before the
    transaction opens because preparing is a read, and holding five compiled
    statements across a 50,000-row transaction is exactly the kind of thing that
    should be set up once rather than 50,000 times.
  */
  const upsertPlace = db.prepare(
    `INSERT OR REPLACE INTO brain_places
       (id, name, slug, summary, description, town, region, state, lat, lng, category_ids, source_url, synced_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const upsertCategory = db.prepare(
    `INSERT OR REPLACE INTO brain_categories (id, label, synced_at) VALUES (?, ?, ?)`,
  );
  const upsertTag = db.prepare(
    `INSERT OR REPLACE INTO brain_tags (id, label, place_ids, synced_at) VALUES (?, ?, ?, ?)`,
  );
  const upsertChunk = db.prepare(
    `INSERT OR REPLACE INTO brain_chunks
       (id, place_id, category, text, source_url, confidence, synced_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const upsertRoad = db.prepare(
    `INSERT OR REPLACE INTO brain_road_features (id, name, kind, lat, lng, synced_at) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const setCursor = db.prepare(
    `INSERT OR REPLACE INTO brain_sync_state (key, value, updated_at) VALUES (?, ?, ?)`,
  );

  let places = 0;
  let categories = 0;
  let tags = 0;
  let chunks = 0;
  let roads = 0;
  let written = 0;
  const seenPlaceIds = new Set<string>();
  const started = Date.now();

  await report("starting", "Opening transaction…", 0);

  db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
  db.exec("BEGIN IMMEDIATE TRANSACTION");
  try {
    for (const row of placeRows) {
      const id = str(row?.["id"], 64);
      const name = str(row?.["name"], 200);
      /*
        A ROW WITH NO ID OR NO NAME IS SKIPPED, not fatal. It cannot be a place and
        it cannot be replaced by a later upload, so aborting a 50,000-row load over
        one bad row would trade a complete brain for a perfect one. The warning is
        what keeps that decision visible rather than silent.
      */
      if (!id || !name) {
        warnings.push("Skipped a place with no id or no name.");
        continue;
      }
      if (seenPlaceIds.has(id)) {
        warnings.push(`Duplicate place id "${id}" — kept the first.`);
        continue;
      }
      seenPlaceIds.add(id);
      upsertPlace.run(
        id,
        name,
        str(row?.["slug"], 200),
        str(row?.["summary"], 1000),
        str(row?.["description"], 8000),
        str(row?.["town"], 120),
        str(row?.["region"], 120),
        str(row?.["state"], 80),
        num(row?.["lat"]),
        num(row?.["lng"]),
        JSON.stringify(strArray(row?.["category_ids"], 32)),
        str(row?.["source_url"], 500),
        stamp,
      );
      places += 1;
      written += 1;
      // Reported every chunk rather than every row — see PROGRESS_CHUNK_ROWS.
      if (written % PROGRESS_CHUNK_ROWS === 0) {
        await report("places", `Syncing places… ${places} of ${placeRows.length}`, written);
      }
    }

    for (const row of (Array.isArray(bundle["categories"]) ? bundle["categories"] : []) as Record<
      string,
      unknown
    >[]) {
      const id = str(row?.["id"], 64);
      if (!id) continue;
      upsertCategory.run(id, str(row?.["label"], 160), stamp);
      categories += 1;
      written += 1;
    }
    await report("categories", `Linking categories… ${categories} written`, written);

    for (const row of (Array.isArray(bundle["tags"]) ? bundle["tags"] : []) as Record<
      string,
      unknown
    >[]) {
      const id = str(row?.["id"], 64);
      const label = str(row?.["label"], 120);
      if (!id || !label) continue;
      /*
        MEMBERSHIP IS INTERSECTED WITH THE PLACES JUST WRITTEN, inside the same
        transaction. A tag pointing at a place this bundle did not carry would be a
        permanent dangling reference the node can never resolve, and the operator's
        parity count would include a row that renders nothing.
      */
      const members = strArray(row?.["place_ids"], 50000).filter((pid) => seenPlaceIds.has(pid));
      upsertTag.run(id, label, JSON.stringify(members), stamp);
      tags += 1;
      written += 1;
    }
    await report("tags", `Linking tags… ${tags} written`, written);

    for (const row of (Array.isArray(bundle["knowledge_chunks"])
      ? bundle["knowledge_chunks"]
      : []) as Record<string, unknown>[]) {
      const text = str(row?.["text"], 4000);
      if (!text) continue;
      const placeId = str(row?.["place_id"], 64);
      upsertChunk.run(
        str(row?.["id"], 64) ?? `kc_${chunks}`,
        placeId && seenPlaceIds.has(placeId) ? placeId : null,
        str(row?.["category"], 80),
        text,
        str(row?.["source_url"], 500),
        num(row?.["confidence"]),
        stamp,
      );
      chunks += 1;
      written += 1;
      if (written % PROGRESS_CHUNK_ROWS === 0) {
        await report("knowledge_chunks", `Syncing chunks… ${chunks} written`, written);
      }
    }
    await report(
      "knowledge_chunks",
      `Syncing chunks… ${chunks} written`,
      written,
    );

    for (const row of (Array.isArray(bundle["road_features"]) ? bundle["road_features"] : []) as Record<
      string,
      unknown
    >[]) {
      const id = str(row?.["id"], 64);
      if (!id) continue;
      upsertRoad.run(
        id,
        str(row?.["name"], 200),
        str(row?.["kind"], 60),
        num(row?.["lat"]),
        num(row?.["lng"]),
        stamp,
      );
      roads += 1;
      written += 1;
    }
    await report("road_features", `Writing road features… ${roads} written`, written);

    /*
      THE CURSOR MOVES LAST AND INSIDE THE TRANSACTION, so it can only ever
      describe rows that are already committed. A cursor written outside would be
      able to claim a sync that a rollback undid — which is precisely the failure
      that would make the stale-bundle guard above skip a good bundle forever.
    */
    setCursor.run(LAST_SYNC_KEY, exportedAt, stamp);

    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // A rollback that itself fails means SQLite had already aborted the
      // transaction; there is nothing left to undo and the original error — the
      // one that actually explains what happened — is the one worth reporting.
    }
    await report(
      "failed",
      `Load failed: ${error instanceof Error ? error.message : String(error)}`,
      written,
    ).catch(() => undefined);
    return fail(
      `The bundle could not be loaded and nothing was changed: ${
        error instanceof Error ? error.message : String(error)
      }`,
      warnings,
    );
  } finally {
    // Restored unconditionally, on success and on failure — see BUSY_TIMEOUT_MS.
    db.pragma("busy_timeout = 0");
  }

  const elapsed = Date.now() - started;
  console.log(
    `[Brain] Loaded bundle ${exportedAt}: ${places} place(s), ${categories} categor(ies), ` +
      `${tags} tag(s), ${chunks} chunk(s), ${roads} road feature(s) in ${elapsed}ms.`,
  );

  // Terminal tick. Published AFTER the COMMIT, so "Parity Achieved" can never be
  // displayed over rows that a rollback subsequently undid.
  await report("done", "Parity Achieved", totalRows > 0 ? totalRows : written).catch(
    () => undefined,
  );

  return {
    ok: true,
    message: `1:1 Brain Parity Locked — ${places} places, ${chunks} knowledge chunks.`,
    lastSync: exportedAt,
    // COUNTED, not copied from the file — see the header.
    counts: { places, categories, tags, knowledge_chunks: chunks, road_features: roads },
    warnings,
  };
}
