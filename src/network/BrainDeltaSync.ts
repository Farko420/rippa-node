import { env } from "../config";
import { BRAIN_BUNDLE_FORMAT, getSyncCursor, ingestBrainBundle } from "../services/brainIngest";
import type { BrainDeltaPayload, SwarmClient } from "./SwarmClient";

/**
 * BRAIN TRICKLE-SYNC — the pull half of 1:1 brain parity, master-only.
 *
 * THE OUTBOUND HALF IS NOT THIS. `SyncManager` pushes this node's own
 * verified_knowledge up to the cloud. This service does the opposite: it keeps
 * the node's MIRROR of the cloud's knowledge current, so a place edited in the
 * admin console reaches the nodes that will be asked about it.
 *
 * WHY A DELTA AND NOT ANOTHER FULL BUNDLE. A full `RIPPA_BRAIN_BUNDLE_V1` upload
 * is the operator's cold-start path — one file, dragged in once. Re-pulling that
 * on a timer to pick up a handful of edited rows would rewrite the whole mirror
 * (tens of thousands of INSERT OR REPLACEs) to deliver a few changes, and would
 * collide with the local idle-verification engine's writes the whole time. The
 * delta asks for "what changed since my cursor" and applies only that.
 *
 * THE CURSOR IS ADVANCED BY THE INGEST, NOT BY THE FETCH. This is the whole
 * safety property. `ingestBrainBundle` writes the rows and sets
 * `last_sync_timestamp` inside a single BEGIN IMMEDIATE ... COMMIT, so a fetch
 * that succeeds but a write that fails leaves the cursor where it was, and the
 * same changes are simply requested again next run. There is no window in which
 * the node believes it is up to date while its rows are not. Advancing the
 * cursor here, in this service, would reintroduce exactly that gap.
 *
 * WHY `setInterval` AND NOT A CRON SCHEDULE. This used to be a `node-cron`
 * expression — "0 minute, every 12th hour", i.e. twice a day at fixed wall-clock
 * boundaries. A cron schedule only fires on those boundaries, so a node that
 * started at 11:59 waited eleven hours for its first real run, and a machine
 * asleep at midnight simply skipped the tick until it woke — which is precisely
 * how the node came to sit at 14,784 facts while the cloud sat at 16,695,
 * reporting "Idle", with no error anywhere. A plain timer counted from boot
 * cannot skip a beat: it fires every interval for as long as the process lives,
 * and `unref()` keeps it from holding the event loop open.
 *
 * EVERY RUN IS INDIVIDUALLY CONTAINED. A background worker that throws inside
 * a timer callback takes the process with it; one that merely logs keeps the
 * node serving chat and heartbeating. See `syncNow`.
 */

/** How often the Master asks the cloud for changes. */
export const DELTA_INTERVAL_MS = 10 * 60_000; // every 10 minutes
/** First run delay after boot — let the HTTP server finish coming up first. */
export const DELTA_FIRST_RUN_DELAY_MS = 120_000;

/**
 * WHAT THE SYNC ACTUALLY PULLED, as reported to the operator and to the Control
 * Center. `facts` is the headline number because it is the one the fleet is
 * measured in (the cloud's "16,695 facts" is a knowledge-chunk count).
 */
export interface BrainSyncReport {
  ok: boolean;
  /** New knowledge chunks applied. */
  facts: number;
  /** Places added or updated. */
  places: number;
  /** The cursor now stored, or null when nothing was applied. */
  cursor: string | null;
  /** Safe to render. */
  message: string;
}

/**
 * CONVERTS A DELTA INTO A BUNDLE THE INGESTER ACCEPTS.
 *
 * THIS FUNCTION IS THE REPAIR, and it exists because the two sides were written
 * against different contracts. `/api/swarm/brain-delta` answers
 * `{ ok, delta }` and names its knowledge collection `knowledge`; the node's
 * ingester expects a top-level `RIPPA_BRAIN_BUNDLE_V1` object with
 * `knowledge_chunks`. Handing one to the other produced three failures in
 * sequence: the 404 below, then "no cloud changes" (the collections were
 * nested), then "Unrecognised bundle format" (no `format` tag). Normalising
 * HERE means the delta's shape is a transport detail that stops at the network
 * boundary, and the ingester keeps its single, stricter validation.
 *
 * `exported_at` IS THE DELTA'S `cursor` — deliberately the value the CLOUD
 * computed, never `Date.now()`. The delta window is half-open `(since, cursor]`,
 * so a locally-derived "now" would silently skip every row written in the gap
 * between the cloud's read and this write. See `buildBrainDelta`.
 */
export function deltaToBundle(delta: BrainDeltaPayload): Record<string, unknown> {
  return {
    format: BRAIN_BUNDLE_FORMAT,
    exported_at: delta.cursor,
    places: delta.places,
    categories: delta.categories,
    // Always empty in practice — there is no place/tag relation the cloud can
    // honestly send. Carried through as [] so the key exists for any reader.
    tags: delta.tags,
    // The rename, and the single most important line in this function.
    knowledge_chunks: delta.knowledge,
    road_features: [],
  };
}

/** Total rows a bundle would write, for the "Pulled X new facts" line. */
function countRecords(payload: Record<string, unknown>, key: string): number {
  const value = payload[key];
  return Array.isArray(value) ? value.length : 0;
}

export class BrainDeltaSync {
  private timer: ReturnType<typeof setInterval> | null = null;
  private firstRun: ReturnType<typeof setTimeout> | null = null;
  private syncing = false;
  /**
   * Consecutive "nothing to do yet" cycles (no cursor, or an unreadable
   * endpoint). Used ONLY to report a persistent condition once instead of every
   * ten minutes forever. Reset by any successful pull.
   */
  private idleCycles = 0;

  constructor(private readonly swarm: SwarmClient) {}

  /** Starts the trickle-sync loop (master only, idempotent). */
  start(): void {
    if (env.NODE_ROLE !== "master") {
      console.log("[Brain Sync] Skipped — brain delta sync is master-only.");
      return;
    }
    if (this.timer) {
      return;
    }

    // One shortly after boot rather than immediately: the very first run on a
    // node that has never synced wants a full operator upload, and racing that
    // would apply a partial delta over a mirror that is about to be replaced.
    this.firstRun = setTimeout(() => {
      this.firstRun = null;
      void this.syncNow();
    }, DELTA_FIRST_RUN_DELAY_MS);
    this.firstRun.unref?.();

    // `.unref()` so this timer can never be the reason the process refuses to
    // exit on a shutdown signal — the same treatment every other background
    // timer in this app already gets.
    this.timer = setInterval(() => void this.syncNow(), DELTA_INTERVAL_MS);
    this.timer.unref?.();

    console.log(
      `[Brain Sync] Trickle-sync started — pulling brain deltas every ` +
        `${Math.round(DELTA_INTERVAL_MS / 60_000)} min, first run in ` +
        `${Math.round(DELTA_FIRST_RUN_DELAY_MS / 1000)}s.`,
    );
  }

  /** Stops the loop. Safe to call repeatedly or on a satellite. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.firstRun) {
      clearTimeout(this.firstRun);
      this.firstRun = null;
    }
  }

  /** True while the loop is armed — reported by the Control Center. */
  isRunning(): boolean {
    return this.timer !== null;
  }

  /**
   * One delta cycle: fetch changes since the local cursor and apply them.
   *
   * NEVER THROWS. This is the property that matters most in this file: the
   * method runs from a timer callback, and an exception escaping one of those
   * is an unhandled rejection that terminates the process — taking the node's
   * chat API, its heartbeat and its OTA updates down with a background sync that
   * was never important enough to justify that. Every exit below is either a
   * return value or a caught-and-logged error.
   *
   * Exported so the Control Center can force a pull on demand.
   */
  async syncNow(): Promise<BrainSyncReport> {
    const skip = (message: string): BrainSyncReport => ({
      ok: false,
      facts: 0,
      places: 0,
      cursor: null,
      message,
    });

    if (env.NODE_ROLE !== "master" || this.syncing) {
      return skip("not applicable on this node");
    }

    this.syncing = true;
    const startedAt = Date.now();
    try {
      /*
        A node that has never loaded a bundle has no mirror to patch, and a
        delta applied to an empty brain would be a partial brain that reports
        itself as synced. Wait for the operator's full upload.

        NOTE THIS IS NOT AN ERROR STATE. It is the correct, expected state of a
        node whose operator has not uploaded yet, so it is reported ONCE and
        then remembered, rather than every ten minutes for the life of the
        process.
      */
      const cursor = getSyncCursor();
      if (!cursor) {
        this.idleCycles += 1;
        if (this.idleCycles === 1) {
          console.log(
            "[Brain Sync] No sync cursor yet — load rippa-brain-master.json once to begin. " +
              "Standing by (this notice is not repeated).",
          );
        }
        return skip("no sync cursor — awaiting first brain bundle upload");
      }

      const delta = await this.swarm.fetchBrainDelta(cursor);
      if (!delta) {
        // The transport already explained itself (404/401/transport, each
        // logged distinctly by SwarmClient). Repeating the reason here would
        // double every failure line, so this stays a single quiet message.
        this.idleCycles += 1;
        return skip("the Mothership's brain-delta endpoint could not be read");
      }

      const bundle = deltaToBundle(delta);
      const newFacts = countRecords(bundle, "knowledge_chunks");
      const newPlaces = countRecords(bundle, "places");

      // "Nothing changed" is a legitimate, cheap answer, and it is the ONLY case
      // in which the cursor advances without rows being written. Handling it here
      // also keeps the much noisier "applied 0 rows" line off the terminal for
      // the ordinary case of an already-current node.
      if (newFacts === 0 && newPlaces === 0) {
        this.idleCycles = 0;
        console.log("[Brain Sync] Success: Pulled 0 new facts — already up to date.");
        return {
          ok: true,
          facts: 0,
          places: 0,
          cursor: delta.cursor,
          message: "Already up to date.",
        };
      }

      /*
        `allowPlaceLess` is REQUIRED, and it was the fourth thing that was broken.

        `ingestBrainBundle` refuses a payload with no places, and that refusal is
        correct for a BUNDLE — a bundle with zero places means "erase everything",
        which must never happen by accident. But a DELTA is an increment, and the
        overwhelmingly common increment is "facts, no places": the cloud learned
        something new about a place this node already has. Without this flag every
        knowledge-only delta was refused as a wipe, and the node stayed frozen
        while the cloud grew. The flag cannot itself cause a wipe, because every
        write it permits is an `INSERT OR REPLACE` upsert — nothing here deletes.
      */
      const result = await ingestBrainBundle(bundle, {
        force: true,
        allowPlaceLess: true,
      });
      if (!result.ok) {
        this.idleCycles += 1;
        console.warn(`[Brain Sync] Not applied — ${result.message} Cursor unchanged.`);
        return { ok: false, facts: 0, places: 0, cursor: null, message: result.message };
      }

      this.idleCycles = 0;
      const elapsed = Date.now() - startedAt;
      const suffix = delta.truncated
        ? " (page truncated — the next tick pulls the remainder)"
        : "";
      console.log(
        `[Brain Sync] Success: Pulled ${newFacts} new fact(s) and ${newPlaces} place(s) ` +
          `in ${elapsed}ms; cursor now ${result.lastSync}.${suffix}`,
      );

      // A truncated page means more is waiting behind this one. The next tick
      // would fetch it correctly, but the data is already known to exist and the
      // cost is one request, so nudge the loop rather than waiting it out.
      if (delta.truncated) {
        const followUp = setTimeout(() => void this.syncNow(), 2_000);
        followUp.unref?.();
      }

      return {
        ok: true,
        facts: newFacts,
        places: newPlaces,
        cursor: result.lastSync,
        message: `Pulled ${newFacts} new fact(s) and ${newPlaces} place(s).`,
      };
    } catch (error) {
      // The last line of defence. Anything reaching here is a bug rather than an
      // expected condition, so it is logged loudly — but still caught, because a
      // crash here would take the whole node down.
      this.idleCycles += 1;
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[Brain Sync] Cycle failed — ${message}`);
      return { ok: false, facts: 0, places: 0, cursor: null, message };
    } finally {
      this.syncing = false;
    }
  }
}
