import { schedule, type ScheduledTask } from "node-cron";
import { env } from "../config";
import { markKnowledgeSynced, selectUnsyncedKnowledge } from "../db/database";
import type { SwarmClient } from "./SwarmClient";

/**
 * CLOUD TRICKLE-SYNC — master-only.
 *
 * Every 10 minutes, drains a small batch (5) of unsynced `verified_knowledge`
 * rows and POSTs them to the Mothership at `/api/swarm/submit`, then marks
 * them as synced locally. A slow "trickle" keeps cloud costs predictable.
 */

const SYNC_CRON = "*/10 * * * *"; // every 10 minutes
const SYNC_BATCH_SIZE = 5;

export class SyncManager {
  private syncTask: ScheduledTask | null = null;
  private syncing = false;

  constructor(private readonly swarm: SwarmClient) {}

  /** Starts the cron job (master only, idempotent). Runs one sync immediately, like the heartbeat. */
  start(): void {
    if (env.NODE_ROLE !== "master") {
      console.log("[Sync] Skipped — trickle-sync is master-only (NODE_ROLE !== 'master').");
      return;
    }
    if (this.syncTask) {
      return;
    }

    this.syncTask = schedule(
      SYNC_CRON,
      () => {
        void this.syncNow();
      },
      { name: "verified-knowledge-trickle-sync" },
    );

    // One immediately so freshly ingested knowledge ships without waiting 10 minutes.
    void this.syncNow();
    console.log(`[Sync] Trickle-sync started — ${SYNC_CRON} (${SYNC_BATCH_SIZE} records/run)`);
  }

  /** Stops the cron job. Safe to call when not running or on a satellite. */
  stop(): void {
    if (this.syncTask) {
      this.syncTask.stop();
      this.syncTask = null;
      console.log("[Sync] Trickle-sync stopped.");
    }
  }

  /** Pushes one batch of unsynced records to the Mothership. */
  async syncNow(): Promise<void> {
    if (env.NODE_ROLE !== "master" || this.syncing) {
      return;
    }

    this.syncing = true;
    try {
      const rows = selectUnsyncedKnowledge(SYNC_BATCH_SIZE);
      if (rows.length === 0) {
        return; // nothing to ship yet — stay quiet
      }

      const payload = {
        kind: "verified_knowledge_batch",
        nodeName: env.NODE_NAME,
        role: env.NODE_ROLE,
        timestamp: new Date().toISOString(),
        records: rows.map((row) => ({
          localId: row.id,
          category: row.category,
          fact_summary: row.fact_summary,
          confidence_score: row.confidence_score,
          coordinates: row.coordinates,
          created_at: row.created_at,
        })),
      };

      const accepted = await this.swarm.submitProfile(payload);
      if (!accepted) {
        console.warn(`[Sync] Batch of ${rows.length} record(s) NOT synced — will retry next run.`);
        return;
      }

      markKnowledgeSynced(rows.map((row) => row.id));
      console.log(`[Sync] Trickle-synced ${rows.length} verified fact(s) to the Mothership.`);
    } catch (error) {
      console.warn(`[Sync] Sync run failed — ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.syncing = false;
    }
  }
}
