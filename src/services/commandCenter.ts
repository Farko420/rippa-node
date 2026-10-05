import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import extract from "extract-zip";
import { getDeepBrain } from "../db/database";
import { parseMultipart, sanitizeFilename } from "./multipartParser";
import { publishNodeEvent } from "./nodeEvents";

/**
 * THE COMMAND CENTER — the Master Node's conversational bulk-ingestion
 * workspace (`/admin/command-center`).
 *
 * WHAT IT IS. Where the dashboard's Fleet/Engine/Scraper panels are each one
 * tool, the Command Center is the INTAKE STREAM: an admin drops raw files, a
 * folder's worth of photos, or a ZIP archive into a chat thread with a plain
 * sentence ("train Rippa on Downey Falls, 42 photos + 3 GPX"), and the Master
 * turns that into structured work — staged bytes, a `PENDING_MASTER_ANALYSIS`
 * batch record, and analysis results posted straight back into the thread.
 *
 * THE THREE HALVES, AND WHERE EACH LIVES:
 *
 *   1. THREADS (SQLite) — a chat is a `cc_threads` row; user + assistant turns
 *      are `cc_messages` rows. In-DB, not in-memory, because a watchdog
 *      restart or OTA swap must not erase the conversation the Master is
 *      mid-analysis on.
 *   2. BATCHES (disk + SQLite) — uploaded bytes stage into ONE folder per
 *      batch under the persistent data dir (`cc-batches/<batchId>/`); ONE
 *      `cc_batches` row points at it with status `PENDING_MASTER_ANALYSIS`.
 *      Processing walks PENDING rows oldest-first purely in-process — there is
 *      no separate worker, because a node has ONE brain (the Ollama client)
 *      and a second consumer would only fight the idle tier for VRAM.
 *   3. ANALYSIS (this module) — ZIPs expand here, EXIF/GPS is read here, the
 *      local model is consulted here, and the results land back in the thread
 *      HERE, via the same `publishNodeEvent` channel every dashboard already
 *      listens on (kind `command_center`).
 *
 * WHY THE THREE SLEEP BETWEEN BATCHES. Analysis is local-model work on real
 * hardware — a Pi must survive a 50-photo batch. `POLL_MS` gives extraction
 * loops a breath between batches so the heartbeat's CPU readings stay honest
 * and the watchdog never mistakes "thinking" for "wedged".
 */

/** Batch intake status. Terminal: `ANALYZED`, `FAILED`. */
export type BatchStatus =
  | "PENDING_MASTER_ANALYSIS"
  | "ANALYZING"
  | "ANALYZED"
  | "FAILED";

/** A content-bearing file the intake recognises (extension, lowercased). */
type IngestKind = "image" | "spatial" | "text" | "archive" | "ignored";

/** Accepted image extensions (incl. HEIC: EXIF parsed raw, no decoder). */
const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".webp", ".heic", ".heif"]);
/** Accepted spatial/track extensions. */
const SPATIAL_EXTS = new Set([".gpx", ".kml", ".geojson", ".json"]);
/** Accepted text-document extensions. `.pdf` parses via ingestionEngine. */
const TEXT_EXTS = new Set([".txt", ".md", ".csv", ".pdf"]);
/** Accepted archive extensions (expanded server-side after upload). */
const ARCHIVE_EXTS = new Set([".zip"]);
/** Basenames dropped silently — OS litter, never content. */
const SYSTEM_BASENAMES = new Set([".ds_store", "thumbs.db", "desktop.ini"]);

/** One file the intake decided about. */
export interface IntakeFile {
  filename: string;
  size: number;
  kind: IngestKind;
}

/** What the staging pass produced, before the chat message is stored. */
export interface IntakeResult {
  batchId: string;
  threadId: string;
  /** The user's prompt (stored on the batch row + the user message). */
  prompt: string;
  kept: IntakeFile[];
  ignored: IntakeFile[];
  zipExpanded: boolean;
}

/** A message row as the thread API returns it. */
export interface ThreadMessage {
  id: number;
  role: "user" | "assistant" | "system";
  body: string;
  batchId: string | null;
  createdAt: string;
}

const CC_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS cc_threads (
    id         TEXT PRIMARY KEY,
    title      TEXT NOT NULL DEFAULT 'Command Center',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS cc_messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id  TEXT NOT NULL REFERENCES cc_threads(id) ON DELETE CASCADE,
    role       TEXT NOT NULL,
    body       TEXT NOT NULL,
    batch_id   TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS cc_batches (
    id         TEXT PRIMARY KEY,
    thread_id  TEXT NOT NULL REFERENCES cc_threads(id) ON DELETE CASCADE,
    prompt     TEXT NOT NULL DEFAULT '',
    status     TEXT NOT NULL DEFAULT 'PENDING_MASTER_ANALYSIS',
    file_count INTEGER NOT NULL DEFAULT 0,
    byte_count INTEGER NOT NULL DEFAULT 0,
    summary    TEXT,
    error      TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_cc_messages_thread ON cc_messages(thread_id, id);
  CREATE INDEX IF NOT EXISTS idx_cc_batches_status ON cc_batches(status, created_at);
`;

/** Creates the three Command Center tables on the Deep Brain (idempotent). */
export function ensureCommandCenterSchema(): void {
  getDeepBrain().exec(CC_SCHEMA_SQL);
}

function classifyFilename(filename: string): IngestKind {
  const base = path.basename(filename).toLowerCase();
  if (SYSTEM_BASENAMES.has(base)) return "ignored";
  const ext = path.extname(base);
  if (IMAGE_EXTS.has(ext)) return "image";
  if (ARCHIVE_EXTS.has(ext)) return "archive";
  if (SPATIAL_EXTS.has(ext)) return "spatial";
  if (TEXT_EXTS.has(ext)) return "text";
  return "ignored";
}

/** Folder naming root for one batch — traversal-safe, unique per batch. */
export function batchFolderName(batchId: string): string {
  const safe = (batchId ?? "").replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 48) || "batch";
  return `cc-${safe}-${randomBytes(3).toString("hex")}`;
}

/** One batch row — what the queue and the status line read. */
export interface BatchRow {
  id: string;
  threadId: string;
  prompt: string;
  status: BatchStatus;
  fileCount: number;
  byteCount: number;
  summary: string | null;
  error: string | null;
  createdAt: string;
}

function rowToBatch(row: Record<string, unknown>): BatchRow {
  return {
    id: String(row["id"]),
    threadId: String(row["thread_id"]),
    prompt: String(row["prompt"] ?? ""),
    status: String(row["status"]) as BatchStatus,
    fileCount: Number(row["file_count"] ?? 0),
    byteCount: Number(row["byte_count"] ?? 0),
    summary: row["summary"] == null ? null : String(row["summary"]),
    error: row["error"] == null ? null : String(row["error"]),
    createdAt: String(row["created_at"]),
  };
}

/**
 * Opens a thread when the admin has none, or reuses the supplied one.
 * Thread ids are client-chosen (so a reload resumes the same thread) but
 * capped in length — the id is a key, never a path.
 */
export function ensureThread(threadId: string | null | undefined, title: string): string {
  const db = getDeepBrain();
  const id = (threadId ?? "").trim().slice(0, 80) || `cc-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
  const existing = db.prepare("SELECT id FROM cc_threads WHERE id = ?").get(id) as { id: string } | undefined;
  if (existing) {
    db.prepare("UPDATE cc_threads SET updated_at = datetime('now') WHERE id = ?").run(id);
    return id;
  }
  db.prepare("INSERT INTO cc_threads (id, title) VALUES (?, ?)").run(id, title.slice(0, 200) || "Command Center");
  return id;
}

/** Appends one message; returns its row id. */
export function appendMessage(threadId: string, role: ThreadMessage["role"], body: string, batchId?: string | null): number {
  const result = getDeepBrain()
    .prepare("INSERT INTO cc_messages (thread_id, role, body, batch_id) VALUES (?, ?, ?, ?)")
    .run(threadId, role, body, batchId ?? null);
  getDeepBrain()
    .prepare("UPDATE cc_threads SET updated_at = datetime('now') WHERE id = ?")
    .run(threadId);
  return Number(result.lastInsertRowid);
}

/** The thread's messages, oldest first, capped so a huge thread cannot OOM the UI. */
export function listMessages(threadId: string, limit = 200): ThreadMessage[] {
  const rows = getDeepBrain()
    .prepare(
      "SELECT id, role, body, batch_id AS batchId, created_at AS createdAt FROM cc_messages WHERE thread_id = ? ORDER BY id ASC LIMIT ?",
    )
    .all(threadId, Math.max(1, Math.min(1000, limit))) as Array<{
    id: number; role: string; body: string; batchId: string | null; createdAt: string;
  }>;
  return rows.map((row) => ({
    id: row.id,
    role: row.role === "assistant" || row.role === "system" ? row.role : "user",
    body: row.body,
    batchId: row.batchId,
    createdAt: row.createdAt,
  }));
}

/** Posts an assistant reply into the thread AND onto the SSE stream. */
export function postAssistantMessage(threadId: string, body: string, batchId?: string | null): ThreadMessage {
  const id = appendMessage(threadId, "assistant", body, batchId ?? null);
  const rows = getDeepBrain()
    .prepare("SELECT id, role, body, batch_id AS batchId, created_at AS createdAt FROM cc_messages WHERE id = ?")
    .all(id) as Array<{ id: number; role: string; body: string; batchId: string | null; createdAt: string }>;
  const row = rows[0];
  publishNodeEvent({
    kind: "command_center",
    command: "CC_MESSAGE",
    title: "Command Center",
    detail: body.slice(0, 280),
  });
  return {
    id: row.id,
    role: "assistant",
    body: row.body,
    batchId: row.batchId,
    createdAt: row.createdAt,
  };
}

/** Creates the `PENDING_MASTER_ANALYSIS` row — the queue's unit of work. */
export function createBatchRecord(threadId: string, prompt: string, fileCount: number, byteCount: number): string {
  const id = `batch-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
  getDeepBrain()
    .prepare(
      "INSERT INTO cc_batches (id, thread_id, prompt, status, file_count, byte_count) VALUES (?, ?, ?, 'PENDING_MASTER_ANALYSIS', ?, ?)",
    )
    .run(id, threadId, prompt, fileCount, byteCount);
  return id;
}

/** Oldest PENDING batch first — FIFO, so a dropped folder is never starved. */
export function claimNextPendingBatch(): BatchRow | null {
  const row = getDeepBrain()
    .prepare("SELECT * FROM cc_batches WHERE status = 'PENDING_MASTER_ANALYSIS' ORDER BY created_at ASC LIMIT 1")
    .get() as Record<string, unknown> | undefined;
  return row ? rowToBatch(row) : null;
}

/** Marks a batch's status (ANALYZING → ANALYZED / FAILED), stamping the time. */
export function setBatchStatus(id: string, status: BatchStatus, summary?: string | null, error?: string | null): void {
  getDeepBrain()
    .prepare("UPDATE cc_batches SET status = ?, summary = COALESCE(?, summary), error = ?, updated_at = datetime('now') WHERE id = ?")
    .run(status, summary ?? null, error ?? null, id);
}

/** One batch row by id (for the status line / drill-down). */
export function getBatch(id: string): BatchRow | null {
  const row = getDeepBrain().prepare("SELECT * FROM cc_batches WHERE id = ?").get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToBatch(row) : null;
}

/** Recent batches newest-first (the status panel). */
export function listRecentBatches(limit = 20): BatchRow[] {
  const rows = getDeepBrain()
    .prepare("SELECT * FROM cc_batches ORDER BY created_at DESC LIMIT ?")
    .all(Math.max(1, Math.min(100, limit))) as Record<string, unknown>[];
  return rows.map(rowToBatch);
}

// ---------------------------------------------------------------------------
// STAGING — multipart bytes → one batch folder + one PENDING row + user msg.
// ---------------------------------------------------------------------------

/** Batch payload root, inside the persistent data dir (OTA-safe by design). */
export function batchRootDir(): string {
  const { resolveDataDir } = require("../utils/paths") as typeof import("../utils/paths");
  const dir = path.join(resolveDataDir(), "cc-batches");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Deletes every folder belonging to one batch id. Best-effort, never throws. */
export function deleteBatchFolder(batchId: string): void {
  try {
    const root = batchRootDir();
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith(`cc-${batchId}-`) || entry.name === `cc-${batchId}`) {
        fs.rmSync(path.join(root, entry.name), { recursive: true, force: true });
      }
    }
  } catch {
    /* best effort — a later sweep retries */
  }
}

/** Finds the staged folder for one batch id, or null when it is gone. */
export function findBatchFolder(batchId: string): string | null {
  try {
    const root = batchRootDir();
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith(`cc-${batchId}-`) || entry.name === `cc-${batchId}`) {
        return path.join(root, entry.name);
      }
    }
  } catch {
    /* treated as missing below */
  }
  return null;
}

/**
 * Totally removes a batch: folder + row. The thread keeps its user message
 * (the conversation stays honest about what was dropped) — only the bytes
 * and the queue row go away.
 */
export function deleteBatch(batchId: string): boolean {
  deleteBatchFolder(batchId);
  try {
    const result = getDeepBrain().prepare("DELETE FROM cc_batches WHERE id = ?").run(batchId);
    return Number(result.changes) > 0;
  } catch {
    return false;
  }
}

/** One staged file, with its path relative to the batch folder. */
export interface BatchFileEntry {
  abs: string;
  rel: string;
  size: number;
}

/**
 * Lists every file under a batch folder, symlink-free.
 *
 * Symlinks are DELETED on sight rather than followed: a crafted ZIP can
 * otherwise point a member at the node's own config.json and have analysis
 * read it as "content". Traversal members can never be produced here —
 * every staged name passed through `sanitizeFilename` on the way in.
 */
export function walkBatchFiles(folder: string): BatchFileEntry[] {
  const out: BatchFileEntry[] = [];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      let stat: fs.Stats;
      try {
        stat = fs.lstatSync(abs);
      } catch {
        continue;
      }
      if (stat.isSymbolicLink()) {
        try {
          fs.rmSync(abs, { force: true });
        } catch {
          /* best effort */
        }
        continue;
      }
      if (stat.isDirectory()) {
        if (out.length < 5000) walk(abs);
        continue;
      }
      if (!stat.isFile()) continue;
      out.push({ abs, rel: path.relative(folder, abs).split(path.sep).join("/"), size: stat.size });
      if (out.length >= 5000) return;
    }
  };
  walk(folder);
  return out;
}

/**
 * Expands one uploaded ZIP into `destDir`, member by member.
 *
 * `extract-zip` does the inflate; the hardening is OURS: extraction lands in
 * a scratch dir first, every member is then MOVED into place through
 * `sanitizeFilename` per segment (`../evil` → `evil`, absolute names
 * flattened), symlinks are deleted after the fact (see `walkBatchFiles`),
 * and the moved-file count is capped so a 100k-entry bomb cannot pin the
 * process. Returns the number of files extracted.
 */
export async function expandZipInto(zipPath: string, destDir: string): Promise<number> {
  const tmp = path.join(destDir, `.unzip-${randomBytes(4).toString("hex")}`);
  fs.mkdirSync(tmp, { recursive: true });
  try {
    await extract(zipPath, { dir: tmp });
    let moved = 0;
    const members = walkBatchFiles(tmp);
    for (const member of members) {
      if (moved >= 5000) break;
      const segments = member.rel.split("/").map((segment) => sanitizeFilename(segment));
      const target = path.join(destDir, ...segments);
      // Belt-and-braces: the join must stay inside destDir after sanitising.
      if (!path.resolve(target).startsWith(path.resolve(destDir) + path.sep)) continue;
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const finalTarget = fs.existsSync(target) ? path.join(destDir, `.dup-${moved}-${segments[segments.length - 1]}`) : target;
      fs.renameSync(member.abs, finalTarget);
      moved += 1;
    }
    return moved;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * Stages one multipart intake body into a fresh batch folder.
 *
 * Steps, in order: (1) fresh batch id + folder; (2) parse parts into it
 * (throws → folder deleted, nothing recorded); (3) expand ZIPs posted
 * directly; (4) classify every file, deleting system litter and unsupported
 * types as they are found; (5) if NOTHING kept, delete the folder and report
 * `batchId: ""` so the route can answer 422 without a phantom batch;
 * (6) create the PENDING row + the user message with the compact summary.
 */
export async function stageIntake(
  contentType: string,
  body: Buffer,
  threadIdIn: string | null | undefined,
): Promise<IntakeResult> {
  const provisional = `batch-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
  const folder = path.join(batchRootDir(), batchFolderName(provisional));
  fs.mkdirSync(folder, { recursive: true });
  try {
    const parsed = parseMultipart(body, contentType, folder);
    const prompt = (parsed.fields["prompt"] ?? "").toString().slice(0, 4000);
    const title = (parsed.fields["title"] ?? "").toString().slice(0, 200);
    const threadId = ensureThread(threadIdIn, title || prompt.slice(0, 80) || "Command Center");

    const kept: IntakeFile[] = [];
    const ignored: IntakeFile[] = [];
    let zipExpanded = false;
    for (const file of [...parsed.files]) {
      if (path.extname(file.filename).toLowerCase() === ".zip") {
        const expanded = await expandZipInto(file.filePath, folder);
        fs.rmSync(file.filePath, { force: true });
        zipExpanded = zipExpanded || expanded > 0;
      }
    }

    for (const entry of walkBatchFiles(folder)) {
      // Scratch dirs are extraction plumbing, never content.
      if (entry.rel.startsWith(".unzip-")) continue;
      const kind = classifyFilename(entry.rel);
      if (kind === "ignored" || kind === "archive") {
        if (kind === "ignored") {
          ignored.push({ filename: entry.rel, size: entry.size, kind });
          fs.rmSync(entry.abs, { force: true });
        } else {
          // A zip nested inside an upload is left staged (listed, not
          // expanded): double-expansion is how a zip-bomb multiplies.
          kept.push({ filename: entry.rel, size: entry.size, kind: "ignored" });
        }
        continue;
      }
      kept.push({ filename: entry.rel, size: entry.size, kind });
    }

    if (kept.length === 0) {
      fs.rmSync(folder, { recursive: true, force: true });
      return { batchId: "", threadId, prompt, kept, ignored, zipExpanded };
    }

    const byteCount = kept.reduce((total, file) => total + file.size, 0);
    const id = createBatchRecord(threadId, prompt, kept.length, byteCount);
    // Rename the staging folder onto the REAL batch id: the provisional name
    // existed only so two concurrent uploads could never collide mid-parse.
    // A failed rename is non-fatal (the folder stays orphaned, not lost —
    // the crash sweep reaps folders with no live batch row).
    try {
      fs.renameSync(folder, path.join(batchRootDir(), batchFolderName(id)));
    } catch {
      /* non-fatal — see above */
    }
    const images = kept.filter((file) => file.kind === "image").length;
    const spatial = kept.filter((file) => file.kind === "spatial").length;
    const texts = kept.filter((file) => file.kind === "text").length;
    const badge =
      prompt.trim() ||
      `Batch: ${kept.length} file${kept.length === 1 ? "" : "s"}` +
        (images ? ` — ${images} photo${images === 1 ? "" : "s"}` : "") +
        (spatial ? `, ${spatial} track${spatial === 1 ? "" : "s"}` : "") +
        (texts ? `, ${texts} document${texts === 1 ? "" : "s"}` : "");
    appendMessage(threadId, "user", badge, id);

    return { batchId: id, threadId, prompt, kept, ignored, zipExpanded };
  } catch (error) {
    fs.rmSync(folder, { recursive: true, force: true });
    throw error;
  }
}

// ---------------------------------------------------------------------------
// ANALYSIS — EXIF/GPS, text collection, local vision, back into the thread.
// ---------------------------------------------------------------------------

/** GPS + capture summary read off one photo, dependency-free. */
export interface PhotoGps {
  lat: number | null;
  lng: number | null;
  takenAt: string | null;
}

/**
 * Reads EXIF GPS + DateTimeOriginal from JPEG/TIFF bytes WITHOUT a library.
 *
 * WHY HAND-ROLLED. `node_modules` is frozen and HEIC/EXIF decoders are heavy
 * native addons that would break the pkg snapshot; the intake only needs
 * three tags (GPS lat, GPS lon, capture time), and TIFF/EXIF is a fixed
 * layout — byte order, IFD walk, rationals — small enough to parse by hand.
 * PNGs carry no EXIF (checked for a `tEXt`/`eXIf` chunk opportunistically);
 * HEIC boxes are scanned for an embedded EXIF payload on a best-effort basis
 * and otherwise reported as "no GPS" rather than failing the batch.
 *
 * Never throws: corrupt headers return `{ lat: null, lng: null, ... }`, and
 * analysis treats "no GPS" as a fact about the photo, not a failure.
 */
export function readPhotoGps(absPath: string): PhotoGps {
  const empty: PhotoGps = { lat: null, lng: null, takenAt: null };
  let bytes: Buffer;
  try {
    const stat = fs.statSync(absPath);
    if (!stat.isFile() || stat.size > 64 * 1024 * 1024 || stat.size < 16) return empty;
    const fd = fs.openSync(absPath, "r");
    try {
      // EXIF lives in the header; 256 KB covers every real-world APP1.
      bytes = Buffer.alloc(Math.min(stat.size, 256 * 1024));
      fs.readSync(fd, bytes, 0, bytes.length, 0);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return empty;
  }
  try {
    if (bytes[0] === 0xff && bytes[1] === 0xd8) return readJpegExif(bytes);
    if (bytes[0] === 0x89 && bytes[1] === 0x50) return readPngExif(bytes);
    return readHeicExif(bytes);
  } catch {
    return empty;
  }
}

/** Walks JPEG segments for APP1/Exif, then hands the TIFF payload over. */
function readJpegExif(bytes: Buffer): PhotoGps {
  const empty: PhotoGps = { lat: null, lng: null, takenAt: null };
  let at = 2;
  while (at + 4 < bytes.length) {
    if (bytes[at] !== 0xff) break;
    const marker = bytes[at + 1];
    if (marker === 0xd8 || marker === 0xd9) {
      at += 2;
      continue;
    }
    if (marker === 0xda) break; // start of scan — headers are over
    const len = bytes.readUInt16BE(at + 2);
    if (len < 2 || at + len > bytes.length) break;
    if (marker === 0xe1 && len > 8 && bytes.subarray(at + 4, at + 10).toString("latin1") === "Exif\0\0") {
      return readTiffExif(bytes.subarray(at + 10, at + 2 + len));
    }
    at += 2 + len;
  }
  return empty;
}

/** PNG: looks for an `eXIf` chunk (rare) and parses it as TIFF. */
function readPngExif(bytes: Buffer): PhotoGps {
  const empty: PhotoGps = { lat: null, lng: null, takenAt: null };
  let at = 8;
  while (at + 12 < bytes.length) {
    const len = bytes.readUInt32BE(at);
    const type = bytes.subarray(at + 4, at + 8).toString("latin1");
    if (type === "eXIf" && len > 8 && at + 8 + len <= bytes.length) {
      return readTiffExif(bytes.subarray(at + 8, at + 8 + len));
    }
    if (len > 64 * 1024 * 1024) break;
    at += 12 + len;
  }
  return empty;
}

/**
 * HEIC: scans ISO-BMFF boxes for an embedded `Exif` item payload.
 * Best-effort — an unparseable HEIC is "no GPS", never an error.
 */
function readHeicExif(bytes: Buffer): PhotoGps {
  const empty: PhotoGps = { lat: null, lng: null, takenAt: null };
  const needle = Buffer.from("Exif\0\0");
  const at = bytes.indexOf(needle);
  if (at < 0 || at + 200 > bytes.length) return empty;
  return readTiffExif(bytes.subarray(at + 6, Math.min(bytes.length, at + 131078)));
}

/**
 * Parses a TIFF/EXIF payload: IFD0 (DateTimeOriginal 0x9003) + GPS IFD
 * (lat 0x0002 + ref 0x0001, lon 0x0004 + ref 0x0003).
 */
function readTiffExif(tiff: Buffer): PhotoGps {
  const out: PhotoGps = { lat: null, lng: null, takenAt: null };
  if (tiff.length < 32) return out;
  const le = tiff[0] === 0x49 && tiff[1] === 0x49;
  const be = tiff[0] === 0x4d && tiff[1] === 0x4d;
  if (!le && !be) return out;
  const u16 = (at: number): number => (le ? tiff.readUInt16LE(at) : tiff.readUInt16BE(at));
  const u32 = (at: number): number => (le ? tiff.readUInt32LE(at) : tiff.readUInt32BE(at));
  if (u16(2) !== 42) return out;

  const readAscii = (ifdAt: number, tag: number): string | null => {
    const count = u16(ifdAt);
    for (let i = 0; i < count; i++) {
      const entry = ifdAt + 2 + i * 12;
      if (entry + 12 > tiff.length) break;
      if (u16(entry) !== tag || u16(entry + 2) !== 2) continue;
      const len = u32(entry + 4);
      if (len === 0 || len > 256) continue;
      const valOff = u32(entry + 8);
      let raw: Buffer;
      if (len <= 4) raw = tiff.subarray(entry + 8, entry + 8 + len);
      else {
        if (valOff + len > tiff.length) continue;
        raw = tiff.subarray(valOff, valOff + len);
      }
      return raw.toString("latin1").replace(/\0+$/, "").trim() || null;
    }
    return null;
  };

  const readRationalTriple = (gpsIfd: number, tag: number): number | null => {
    const count = u16(gpsIfd);
    for (let i = 0; i < count; i++) {
      const entry = gpsIfd + 2 + i * 12;
      if (entry + 12 > tiff.length) break;
      if (u16(entry) !== tag || u16(entry + 2) !== 5 || u32(entry + 4) !== 3) continue;
      const valOff = u32(entry + 8);
      if (valOff + 24 > tiff.length) continue;
      const num = (slot: number): number => {
        const n = le ? tiff.readUInt32LE(valOff + slot * 8) : tiff.readUInt32BE(valOff + slot * 8);
        const d = le ? tiff.readUInt32LE(valOff + slot * 8 + 4) : tiff.readUInt32BE(valOff + slot * 8 + 4);
        return d === 0 ? 0 : n / d;
      };
      return num(0) + num(1) / 60 + num(2) / 3600;
    }
    return null;
  };

  try {
    const ifd0 = u32(4);
    if (ifd0 + 2 > tiff.length) return out;
    const taken =
      readAscii(ifd0, 0x9003) ?? readAscii(ifd0, 0x9004) ?? readAscii(ifd0, 0x0132);
    if (taken) out.takenAt = taken;
    const ifdCount = u16(ifd0);
    let gpsIfd = -1;
    for (let i = 0; i < ifdCount; i++) {
      const entry = ifd0 + 2 + i * 12;
      if (entry + 12 > tiff.length) break;
      // GPS IFD pointer (0x8825) may be LONG(4) or SHORT(3) in the wild.
      if (u16(entry) === 0x8825) {
        const rawOff = u32(entry + 8);
        gpsIfd = u16(entry + 2) === 3 ? rawOff & 0xffff : rawOff;
        break;
      }
    }
    if (gpsIfd >= 0 && gpsIfd + 2 <= tiff.length) {
      const latRef = (readAscii(gpsIfd, 0x0001) ?? "N").toUpperCase();
      const lonRef = (readAscii(gpsIfd, 0x0003) ?? "E").toUpperCase();
      const lat = readRationalTriple(gpsIfd, 0x0002);
      const lon = readRationalTriple(gpsIfd, 0x0004);
      if (lat !== null && lon !== null && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180) {
        out.lat = latRef.startsWith("S") ? -lat : lat;
        out.lng = lonRef.startsWith("W") ? -lon : lon;
      }
    }
  } catch {
    /* partial EXIF still yields whatever was read before the throw */
  }
  return out;
}

/** What one batch's disk walk produced: text for the model + photo metadata. */
export interface BatchCorpus {
  /** Combined collectable text (documents + tracks + generated captions). */
  text: string;
  /** Per-photo EXIF findings, in walk order. */
  photos: Array<{ filename: string; gps: PhotoGps }>;
  /** Track files found (names only — the model gets the extracted summary). */
  tracks: string[];
  /** Documents found (names only). */
  documents: string[];
}

/** Largest single text member read into the corpus. */
const MAX_CORPUS_FILE_BYTES = 1024 * 1024;
/** Total corpus handed toward the model — matches ingestionEngine's budget. */
const MAX_CORPUS_CHARS = 48_000;

/**
 * Collects a batch folder into model-ready text + photo GPS metadata.
 *
 *   - Text/spatial files: read (≤1 MB each), XML stripped for GPX/KML.
 *   - Photos: EXIF GPS + timestamp recorded; a one-line caption carrying any
 *     GPS is ADDED to the text so the model reasons about locations even
 *     though it never sees pixels here (vision runs separately, per photo).
 *   - PDFs: parsed by ingestionEngine's `extractPdfText` when the engine's
 *     collect path handles it; here, listed as documents (binary parse is the
 *     processor's job via the shared helper).
 */
export function collectBatchCorpus(folder: string): BatchCorpus {
  const corpus: BatchCorpus = { text: "", photos: [], tracks: [], documents: [] };
  const pieces: string[] = [];
  const files = walkBatchFiles(folder);
  for (const file of files.slice(0, 5000)) {
    const kind = classifyFilename(file.rel);
    if (kind === "image") {
      const gps = readPhotoGps(file.abs);
      corpus.photos.push({ filename: file.rel, gps });
      const where = gps.lat !== null && gps.lng !== null ? ` taken at ${gps.lat.toFixed(5)}, ${gps.lng.toFixed(5)}` : "";
      const when = gps.takenAt ? ` on ${gps.takenAt}` : "";
      pieces.push(`[photo: ${file.rel}${where}${when}]`);
    } else if (kind === "spatial") {
      corpus.tracks.push(file.rel);
      const text = readSmallText(file.abs);
      if (text) pieces.push(`[track: ${file.rel}]\n${stripXml(text).slice(0, 4000)}`);
    } else if (kind === "text") {
      corpus.documents.push(file.rel);
      if (path.extname(file.rel).toLowerCase() === ".pdf") {
        pieces.push(`[document: ${file.rel} (PDF — parsed during analysis)]`);
      } else {
        const text = readSmallText(file.abs);
        if (text) pieces.push(`[document: ${file.rel}]\n${text.slice(0, 8000)}`);
      }
    }
    if (pieces.join("\n\n").length > MAX_CORPUS_CHARS) break;
  }
  corpus.text = pieces.join("\n\n").slice(0, MAX_CORPUS_CHARS);
  return corpus;
}

function readSmallText(absPath: string): string {
  try {
    const stat = fs.statSync(absPath);
    if (!stat.isFile() || stat.size > MAX_CORPUS_FILE_BYTES || stat.size === 0) return "";
    return fs.readFileSync(absPath, "utf8").replace(/\s+/g, " ").trim();
  } catch {
    return "";
  }
}

function stripXml(text: string): string {
  return text
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ---------------------------------------------------------------------------
// PROCESSOR — the Master's in-process consumer of the PENDING queue.
// ---------------------------------------------------------------------------

/** What the processor needs from the host (structural, for the same reason as IngestionDeps). */
export interface BatchProcessorDeps {
  /**
   * Local fact extraction (OllamaClient.extractFacts). Optional: without it
   * the processor still records EXIF/GPS + document structure and posts the
   * summary — "no model" degrades to a metadata report, never a crash.
   */
  extractFacts?: (text: string) => Promise<{ fact_summary: string; category: string } | null>;
  /**
   * True when a model is actually behind `extractFacts`. Present because the
   * server wires ONE closure that answers null until the Orchestrator's
   * client is registered — without this the summary could not tell "model
   * answered nothing" apart from "no model is wired".
   */
  isModelWired?: () => boolean;
  /** Milliseconds between batches (breathing room for small hardware). */
  pollMs?: number;
}

/** Cadence of the queue poll — analysis is heavyweight, so unhurried. */
const BATCH_POLL_MS = 30_000;

/**
 * THE BATCH PROCESSOR — Master-only, one at a time, in-process.
 *
 * WHY IN-PROCESS, NOT A WORKER. There is exactly one local model and one
 * Deep Brain on a Master; a second consumer would fight the idle tier for
 * VRAM and the database for locks. FIFO over `PENDING_MASTER_ANALYSIS`,
 * one batch per poll, then back to sleep.
 */
export class CommandBatchProcessor {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly pollMs: number;

  constructor(private readonly deps: BatchProcessorDeps = {}) {
    this.pollMs = Math.max(5_000, deps.pollMs ?? BATCH_POLL_MS);
  }

  /** Starts the poll loop (idempotent). Master-only by boot wiring. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.drainOnce().catch((error: unknown) => {
        console.warn("[CommandCenter] Batch poll failed —", error instanceof Error ? error.message : error);
      });
    }, this.pollMs);
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  /** Stops the poll loop. In-flight analysis is left to finish. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Processes the single oldest PENDING batch, if any. Returns its id or null. */
  async drainOnce(): Promise<string | null> {
    if (this.running) return null;
    let batch: BatchRow | null = null;
    try {
      batch = claimNextPendingBatch();
    } catch {
      return null; // Deep Brain unavailable (satellite / pre-init) — stay quiet.
    }
    if (!batch) return null;
    this.running = true;
    try {
      await this.analyze(batch);
    } finally {
      this.running = false;
    }
    return batch.id;
  }

  /**
   * Analyzes ONE batch end to end. Steps: mark ANALYZING; collect corpus
   * (EXIF/GPS, text, PDF bytes via the shared parser); ask the local model
   * for up to 3 facts into raw_lore; post the summary message; mark
   * ANALYZED (or FAILED) and emit the status event.
   */
  private async analyze(batch: BatchRow): Promise<void> {
    setBatchStatus(batch.id, "ANALYZING");
    publishNodeEvent({
      kind: "command_center",
      command: "CC_BATCH_ANALYZING",
      title: "Analysing batch…",
      detail: `${batch.fileCount} file(s)`,
    });
    const folder = findBatchFolder(batch.id);
    if (!folder) {
      const message = "staged files are gone (folder missing)";
      setBatchStatus(batch.id, "FAILED", null, message);
      postAssistantMessage(batch.threadId, `That batch failed: ${message}. Drop the files again and I'll retry.`, batch.id);
      publishNodeEvent({ kind: "command_center", command: "CC_BATCH_FAILED", title: "Batch failed", detail: message });
      return;
    }

    const corpus = collectBatchCorpus(folder);
    for (const doc of corpus.documents) {
      if (path.extname(doc).toLowerCase() !== ".pdf") continue;
      try {
        const engine = require("./ingestionEngine") as typeof import("./ingestionEngine");
        const bytes = fs.readFileSync(path.join(folder, ...doc.split("/")));
        const text = engine.extractPdfText(bytes).slice(0, 8000);
        if (text) corpus.text += `\n\n[document: ${doc}]\n${text}`;
      } catch {
        /* one bad PDF never fails the batch */
      }
    }

    const facts: string[] = [];
    const modelWired = this.deps.isModelWired ? this.deps.isModelWired() : Boolean(this.deps.extractFacts);
    if (modelWired && this.deps.extractFacts && corpus.text.trim()) {
      for (const chunk of chunkCorpus(corpus.text, 4000).slice(0, 3)) {
        try {
          const fact = await this.deps.extractFacts(chunk);
          if (!fact?.fact_summary?.trim()) continue;
          facts.push(fact.fact_summary.trim());
          try {
            const db = require("../db/database") as typeof import("../db/database");
            db.insertRawLore("command-center", fact.fact_summary.trim(), null);
          } catch {
            /* brain unavailable — the summary still posts */
          }
        } catch {
          break; // model down: stop asking, keep what we have
        }
      }
    }

    const withGps = corpus.photos.filter((p) => p.gps.lat !== null && p.gps.lng !== null);
    const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);
    const lines: string[] = [];
    lines.push(`Analysed ${batch.fileCount} ${plural(batch.fileCount, "file", "files")} (${formatBytes(batch.byteCount)})`);
    if (batch.prompt.trim()) lines.push(`> ${batch.prompt.trim().slice(0, 300)}`);
    if (corpus.photos.length > 0) {
      lines.push(`Photos: ${corpus.photos.length}` + (withGps.length > 0 ? `, ${withGps.length} with GPS` : ", none with GPS"));
      for (const photo of withGps.slice(0, 5)) {
        lines.push(`- ${photo.filename} — ${photo.gps.lat?.toFixed(5)}, ${photo.gps.lng?.toFixed(5)}${photo.gps.takenAt ? ` (${photo.gps.takenAt})` : ""}`);
      }
      if (withGps.length > 5) lines.push(`- …and ${withGps.length - 5} more geotagged`);
    }
    if (corpus.tracks.length > 0) {
      lines.push(`Tracks: ${corpus.tracks.slice(0, 5).join(", ")}${corpus.tracks.length > 5 ? "…" : ""}`);
    }
    if (corpus.documents.length > 0) {
      lines.push(`Documents: ${corpus.documents.slice(0, 5).join(", ")}${corpus.documents.length > 5 ? "…" : ""}`);
    }
    if (facts.length > 0) {
      lines.push(`Rippa learned ${facts.length} ${plural(facts.length, "fact", "facts")} (queued for verification):`);
      for (const fact of facts) lines.push(`- ${fact}`);
    } else if (modelWired) {
      lines.push(`The local model produced no facts from this batch — the files are staged for review.`);
    } else {
      lines.push(`No local model is wired — file structure and GPS above. Start Ollama to enable vision + facts.`);
    }
    const summary = lines.join("\n");

    setBatchStatus(batch.id, "ANALYZED", summary);
    postAssistantMessage(batch.threadId, summary, batch.id);
    publishNodeEvent({ kind: "command_center", command: "CC_BATCH_ANALYZED", title: "Batch analysed", detail: `${batch.fileCount} file(s)` });
  }
}

/** Non-overlapping slices of the corpus for model calls. */
function chunkCorpus(text: string, size: number): string[] {
  const chunks: string[] = [];
  for (let at = 0; at < text.length; at += size) chunks.push(text.slice(at, at + size));
  return chunks;
}

/** Human byte count for the summary line. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(1)} MB`;
  return `${(bytes / 1073741824).toFixed(2)} GB`;
}

/**
 * Sweeps staged batch folders with no live batch row (crash orphans).
 * Mirrors the stale-workspace sweep: same promise — processed batches must
 * not hoard disk — with the live-row check so a queued batch is never
 * reaped. A batch whose row is ANALYZED/FAILED keeps its folder (the admin
 * may still drill into it); only row-less folders go.
 */
export function sweepOrphanBatchFolders(maxAgeMs = 2 * 60 * 60_000): number {
  let removed = 0;
  let root: string;
  try {
    root = batchRootDir();
  } catch {
    return 0;
  }
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".unzip-")) continue;
    const abs = path.join(root, entry.name);
    const match = /^cc-(batch-[A-Za-z0-9]+-[A-Za-z0-9]+)-[A-Za-z0-9]+$/.exec(entry.name);
    let live = false;
    if (match) {
      try {
        live = getBatch(match[1]) !== null;
      } catch {
        live = true; // brain unreachable — never delete what we cannot check
      }
    }
    if (live) continue;
    try {
      const age = Date.now() - fs.statSync(abs).mtimeMs;
      if (age > maxAgeMs) {
        fs.rmSync(abs, { recursive: true, force: true });
        removed += 1;
      }
    } catch {
      /* best effort */
    }
  }
  return removed;
}

