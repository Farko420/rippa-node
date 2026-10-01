import { schedule, type ScheduledTask } from "node-cron";
import { env } from "../config";
import { getSyncCursor, ingestBrainBundle } from "../services/brainIngest";
import type { SwarmClient } from "./SwarmClient";

/**
 * BRAIN DELTA SYNC — the pull half of 1:1 brain parity, master-only.
 *
 * THE OUTBOUND HALF IS NOT THIS. `SyncManager` pushes this node's own
 * verified_knowledge up to the cloud. This service does the opposite: it keeps
 * the node's MIRROR of the cloud's knowledge current, so a place edited in the
 * admin console reaches the nodes that will be asked about it.
 *
 * WHY A DELTA AND NOT ANOTHER FULL BUNDLE. A full `RIPPA_BRAIN_BUNDLE_V1` upload
 * is the operator's cold-start path — one file, dragged in once, 1:1 with the
 * cloud. Re-pulling that every 12 hours to pick up a handful of edited rows would
 * rewrite the whole mirror (tens of thousands of INSERT OR REPLACEs) twice a day
 * to deliver a few changes, and would collide with the local idle-verification
 * engine's writes the whole time. The delta asks for "what changed since my
 * cursor" and applies only that.
 *
 * THE CURSOR IS ADVANCED BY THE INGEST, NOT BY THE FETCH. This is the whole
 * safety property. `ingestBrainBundle` writes the rows and sets
 * `last_sync_timestamp` inside a single BEGIN IMMEDIATE ... COMMIT, so a fetch
 * that succeeds but a write that fails leaves the cursor where it was, and the
 * same changes are simply requested again next run. There is no window in which
 * the node believes it is up to date while its rows are not. Advancing the
 * cursor here, in this service, would reintroduce exactly that gap.
 *
 * IF THE CLOUD HAS NO DELTA ENDPOINT, nothing happens, quietly and forever. A
 * node that cannot reach `/api/brain/delta` keeps the brain it got from the
 * operator's bundle upload, and the idle-verification engine keeps it honest.
 * Missing parity is a degraded mode, not a failure.
 */

/** How often the Master asks the cloud for changes. */
const DELTA_CRON = "0 */12 * * *"; // every 12 hours
/** First run delay after boot — let the HTTP server finish coming up first. */
const DELTA_FIRST_RUN_DELAY_MS = 120_000;

/** True when a delta payload carries at least one record in any collection. */
function hasAnyRecords(payload: Record<string, unknown>): boolean {
  const collections = ["places", "categories", "tags", "knowledge_chunks", "road_features"];
  return collections.some((key) => {
    const value = payload[key];
    return Array.isArray(value) && value.length > 0;
  });
}

export class BrainDeltaSync {
  private task: ScheduledTask | null = null;
  private firstRun: NodeJS.Timeout | null = null;
  private syncing = false;

  constructor(private readonly swarm: SwarmClient) {}

  /** Starts the 12-hourly delta pull (master only, idempotent). */
  start(): void {
    if (env.NODE_ROLE !== "master") {
      console.log("[Delta] Skipped — brain delta sync is master-only.");
      return;
    }
    if (this.task) {
      return;
    }

    this.task = schedule(DELTA_CRON, () => void this.syncNow(), {
      name: "brain-delta-sync",
    });

    // One shortly after boot rather than immediately: the very first run on a
    // node that has never synced wants a full operator upload, and racing that
    // would apply a partial delta over a mirror that is about to be replaced.
    this.firstRun = setTimeout(() => {
      this.firstRun = null;
      void this.syncNow();
    }, DELTA_FIRST_RUN_DELAY_MS);

    console.log(`[Delta] Brain delta sync started — ${DELTA_CRON}.`);
  }

  /** Stops the schedule. Safe to call repeatedly or on a satellite. */
  stop(): void {
    if (this.task) {
      this.task.stop();
      this.task = null;
    }
    if (this.firstRun) {
      clearTimeout(this.firstRun);
      this.firstRun = null;
    }
  }

  /**
   * One delta cycle: fetch changes since the local cursor and apply them.
   *
   * Never throws. Exported so the Control Center can force a pull on demand.
   * Returns true only when rows were actually written.
   */
  async syncNow(): Promise<boolean> {
    if (env.NODE_ROLE !== "master" || this.syncing) {
      return false;
    }

    this.syncing = true;
    try {
      // A node that has never loaded a bundle has no mirror to patch, and a
      // delta applied to an empty brain would be a partial brain that reports
      // itself as synced. Wait for the operator's full upload.
      const cursor = getSyncCursor();
      if (!cursor) {
        console.log("[Delta] No sync cursor — load a full brain bundle first.");
        return false;
      }

      const payload = await this.swarm.fetchBrainDelta(cursor);
      if (!payload) {
        return false; // endpoint absent or unreachable — stay quiet, retry later
      }

      // "Nothing changed" is a legitimate, cheap answer. Recognised here so an
      // empty delta never reaches the ingester: ingestBrainBundle deliberately
      // REFUSES a bundle with no places (that is a wipe, not an update), so
      // forwarding an empty delta would log a scary warning every 12 hours.
      if (!hasAnyRecords(payload)) {
        console.log("[Delta] No cloud changes since last sync.");
        return false;
      }

      // Force: the delta is newer than the cursor by construction, but the
      // ingest's staleness guard compares exported_at, and a cloud clock that
      // disagrees with ours would otherwise silently discard real changes.
      const result = await ingestBrainBundle(payload, { force: true });
      if (!result.ok) {
        console.warn(`[Delta] Not applied — ${result.message} Cursor unchanged.`);
        return false;
      }

      console.log(
        `[Delta] Applied cloud changes — ${result.counts.places} place(s), ` +
          `${result.counts.knowledge_chunks} chunk(s); cursor now ${result.lastSync}.`,
      );
      return true;
    } catch (error) {
      console.warn(
        `[Delta] Sync run failed — ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    } finally {
      this.syncing = false;
    }
  }
}
