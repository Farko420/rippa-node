/**
 * REMOTE COMMAND TASKS — persistent task tray for the Master Control Center.
 *
 * WHY THIS EXISTS. The Satellite "Remote Command" UI offloads heavy work to
 * the Master (`POST /api/mesh/offload`), but the old UI showed only a single
 * transient status line — queuing a second URL erased the first, and there was
 * no completion summary (places found / profiles created / notes).
 *
 * This module is the Master-side ledger: every offload + every directly
 * uploaded swarm file lands here as ONE row, moves queued -> processing ->
 * completed/failed, and carries a structured `summary` object the Task Tray
 * polls and renders. Backed by Deep Brain SQLite when available (survives
 * restarts), with an in-memory fallback so Satellites degrade gracefully.
 *
 * Epic scope note: the request names R2 (`/api/storage/upload`) and D1
 * (`swarm_tasks`). This repo has neither — storage is local disk under the
 * persistent data dir and the ledger is SQLite. The endpoint below is served
 * at the SAME `/api/storage/upload` path and this table is the local
 * equivalent of `swarm_tasks`, so the frontend contract matches the epic.
 */

import { getDeepBrain } from "../db/database";

export type RemoteTaskStatus = "queued" | "processing" | "completed" | "failed";

/** Structured completion report rendered in the Task Tray drawer. */
export interface RemoteTaskSummary {
  places_found: string[];
  places_created: number;
  notes: string;
}

export interface RemoteTask {
  id: string;
  target: string;
  kind: "url" | "file" | "place";
  tier: number;
  load: string;
  status: RemoteTaskStatus;
  summary: RemoteTaskSummary | null;
  fileName: string | null;
  stagedPath: string | null;
  error: string | null;
  swarmTaskId: string | null;
  createdAt: string;
  updatedAt: string;
}

const TASK_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS remote_tasks (
    id           TEXT PRIMARY KEY,
    target       TEXT NOT NULL,
    kind         TEXT NOT NULL DEFAULT 'place',
    tier         INTEGER NOT NULL DEFAULT 0,
    load         TEXT NOT NULL DEFAULT 'heavy',
    status       TEXT NOT NULL DEFAULT 'queued',
    summary      TEXT,
    file_name    TEXT,
    staged_path  TEXT,
    error        TEXT,
    swarm_task_id TEXT,
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );
`;

export function emptySummary(): RemoteTaskSummary {
  return { places_found: [], places_created: 0, notes: "" };
}

/** In-memory fallback when the Deep Brain is unavailable (satellite/pre-init). */
const memoryTasks = new Map<string, RemoteTask>();

function dbOrNull(): { exec: (sql: string) => void; prepare: (sql: string) => any } | null {
  try {
    return getDeepBrain() as unknown as { exec: (sql: string) => void; prepare: (sql: string) => any };
  } catch {
    return null;
  }
}

export function ensureRemoteTaskSchema(): void {
  const db = dbOrNull();
  if (!db) return;
  db.exec(TASK_TABLE_SQL);
  try {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_remote_tasks_updated ON remote_tasks(updated_at DESC)`);
  } catch { /* index is a nicety, not a requirement */ }
}

function rowToTask(row: Record<string, any>): RemoteTask {
  let summary: RemoteTaskSummary | null = null;
  if (row["summary"]) {
    try {
      const parsed = JSON.parse(String(row["summary"]));
      summary = {
        places_found: Array.isArray(parsed.places_found) ? parsed.places_found.map(String) : [],
        places_created: Number(parsed.places_created) || 0,
        notes: String(parsed.notes ?? ""),
      };
    } catch {
      summary = { ...emptySummary(), notes: String(row["summary"]) };
    }
  }
  return {
    id: String(row["id"]),
    target: String(row["target"] ?? ""),
    kind: (row["kind"] as RemoteTask["kind"]) ?? "place",
    tier: Number(row["tier"] ?? 0),
    load: String(row["load"] ?? "heavy"),
    status: (row["status"] as RemoteTaskStatus) ?? "queued",
    summary,
    fileName: row["file_name"] != null ? String(row["file_name"]) : null,
    stagedPath: row["staged_path"] != null ? String(row["staged_path"]) : null,
    error: row["error"] != null ? String(row["error"]) : null,
    swarmTaskId: row["swarm_task_id"] != null ? String(row["swarm_task_id"]) : null,
    createdAt: String(row["created_at"] ?? new Date().toISOString()),
    updatedAt: String(row["updated_at"] ?? new Date().toISOString()),
  };
}

export function createRemoteTask(input: {
  target: string;
  kind?: RemoteTask["kind"];
  tier?: number;
  load?: string;
  fileName?: string | null;
  stagedPath?: string | null;
  swarmTaskId?: string | null;
}): RemoteTask {
  const now = new Date().toISOString();
  const task: RemoteTask = {
    id: `rt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    target: input.target,
    kind: input.kind ?? "place",
    tier: input.tier ?? 0,
    load: input.load ?? "heavy",
    status: "queued",
    summary: null,
    fileName: input.fileName ?? null,
    stagedPath: input.stagedPath ?? null,
    error: null,
    swarmTaskId: input.swarmTaskId ?? null,
    createdAt: now,
    updatedAt: now,
  };
  const db = dbOrNull();
  if (db) {
    try {
      ensureRemoteTaskSchema();
      db.prepare(
        `INSERT INTO remote_tasks (id, target, kind, tier, load, status, summary, file_name, staged_path, error, swarm_task_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL, ?, ?, ?)`,
      ).run(task.id, task.target, task.kind, task.tier, task.load, task.status,
        task.fileName, task.stagedPath, task.swarmTaskId, task.createdAt, task.updatedAt);
      return task;
    } catch { /* fall through to memory */ }
  }
  memoryTasks.set(task.id, task);
  return task;
}

export function listRemoteTasks(limit = 25): RemoteTask[] {
  const db = dbOrNull();
  if (db) {
    try {
      ensureRemoteTaskSchema();
      const rows = db.prepare(`SELECT * FROM remote_tasks ORDER BY updated_at DESC LIMIT ?`).all(limit) as Array<Record<string, any>>;
      if (rows.length > 0 || memoryTasks.size === 0) return rows.map(rowToTask);
    } catch { /* fall through to memory */ }
  }
  return [...memoryTasks.values()].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)).slice(0, limit);
}

export function getRemoteTask(id: string): RemoteTask | null {
  const db = dbOrNull();
  if (db) {
    try {
      ensureRemoteTaskSchema();
      const row = db.prepare(`SELECT * FROM remote_tasks WHERE id = ?`).get(id) as Record<string, any> | undefined;
      if (row) return rowToTask(row);
    } catch { /* fall through */ }
  }
  return memoryTasks.get(id) ?? null;
}

export function updateRemoteTask(
  id: string,
  patch: Partial<Pick<RemoteTask, "status" | "error" | "swarmTaskId" | "stagedPath">> & { summary?: RemoteTaskSummary | null },
): RemoteTask | null {
  const existing = getRemoteTask(id);
  if (!existing) return null;
  const next: RemoteTask = {
    ...existing, ...patch,
    summary: patch.summary !== undefined ? patch.summary : existing.summary,
    updatedAt: new Date().toISOString(),
  };
  const db = dbOrNull();
  if (db) {
    try {
      ensureRemoteTaskSchema();
      db.prepare(`UPDATE remote_tasks SET status=?, summary=?, error=?, swarm_task_id=?, staged_path=?, updated_at=? WHERE id=?`).run(
        next.status, next.summary ? JSON.stringify(next.summary) : null,
        next.error, next.swarmTaskId, next.stagedPath, next.updatedAt, id);
      return next;
    } catch { /* fall through */ }
  }
  memoryTasks.set(id, next);
  return next;
}

/** Marks a task completed with a structured summary (backend sync point). */
export function completeRemoteTask(id: string, summary: Partial<RemoteTaskSummary>): RemoteTask | null {
  return updateRemoteTask(id, {
    status: "completed",
    error: null,
    summary: {
      places_found: Array.isArray(summary.places_found) ? summary.places_found.map(String) : [],
      places_created: Number(summary.places_created) || 0,
      notes: String(summary.notes ?? ""),
    },
  });
}

/** Marks a task failed with an error note (still surfaced in the tray). */
export function failRemoteTask(id: string, error: string): RemoteTask | null {
  return updateRemoteTask(id, { status: "failed", error: String(error || "unknown error").slice(0, 2000) });
}

