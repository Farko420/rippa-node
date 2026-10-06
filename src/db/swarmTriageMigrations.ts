/**
 * SWARM TRIAGE MIGRATIONS — add consensus and auto-publish fields to brain_places.
 *
 * This migration adds three columns to the brain_places table to support
 * the Swarm Triage & Fleet Command UI:
 *   - confidence_score: REAL (0.0-100.0) for consensus verification confidence
 *   - ai_auto_published: INTEGER (0/1) for auto-published flag
 *   - consensus_status: TEXT for detailed status (pending/verified/conflict/degraded)
 *
 * The migration runs idempotently on startup via initializeDeepBrain(),
 * so existing databases are upgraded transparently.
 */

import type Database from "better-sqlite3";

/**
 * Executes the Swarm Triage migration on the database.
 *
 * Safe to call multiple times: checks for existence before adding columns.
 * Logs progress to console for debugging.
 *
 * @param db The better-sqlite3 database instance
 * @returns true if migration succeeded, false if it failed
 */
export function migrateSwarmTriageColumns(db: Database.Database): boolean {
  try {
    const placeColumns = db.pragma("table_info(brain_places)") as Array<{ name: string }>;
    const columnNames = new Set(placeColumns.map((col) => col.name));

    // Migration 1: confidence_score (REAL, default 0.0)
    if (!columnNames.has("confidence_score")) {
      db.exec("ALTER TABLE brain_places ADD COLUMN confidence_score REAL DEFAULT 0.0");
      console.log("[Deep Brain] Migrated brain_places: added 'confidence_score' column.");
    }

    // Migration 2: ai_auto_published (INTEGER, default 0)
    if (!columnNames.has("ai_auto_published")) {
      db.exec("ALTER TABLE brain_places ADD COLUMN ai_auto_published INTEGER DEFAULT 0");
      console.log("[Deep Brain] Migrated brain_places: added 'ai_auto_published' column.");
    }

    // Migration 3: consensus_status (TEXT, default 'pending')
    if (!columnNames.has("consensus_status")) {
      db.exec(
        "ALTER TABLE brain_places ADD COLUMN consensus_status TEXT DEFAULT 'pending'"
      );
      console.log("[Deep Brain] Migrated brain_places: added 'consensus_status' column.");
    }

    return true;
  } catch (error) {
    console.error(
      `[Deep Brain] Failed to migrate Swarm Triage columns: ${error instanceof Error ? error.message : String(error)}`
    );
    return false;
  }
}

/**
 * Verifies that all Swarm Triage columns exist in brain_places.
 *
 * Used for health checks or diagnostics.
 *
 * @param db The better-sqlite3 database instance
 * @returns true if all required columns are present
 */
export function verifySwarmTriageColumns(db: Database.Database): boolean {
  try {
    const placeColumns = db.pragma("table_info(brain_places)") as Array<{ name: string }>;
    const columnNames = new Set(placeColumns.map((col) => col.name));

    const requiredColumns = ["confidence_score", "ai_auto_published", "consensus_status"];
    const missing = requiredColumns.filter((col) => !columnNames.has(col));

    if (missing.length > 0) {
      console.warn(`[Deep Brain] Missing Swarm Triage columns: ${missing.join(", ")}`);
      return false;
    }

    return true;
  } catch (error) {
    console.error(
      `[Deep Brain] Failed to verify Swarm Triage columns: ${error instanceof Error ? error.message : String(error)}`
    );
    return false;
  }
}
