import axios from "axios";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import zlib from "node:zlib";
import extract from "extract-zip";
import type { OllamaClient, VerifiedFact } from "../agent/OllamaClient";
import type { FleetTask, FleetTaskResult, SwarmClient } from "../network/SwarmClient";

/**
 * THE INGESTION ENGINE — heavy fleet research, and a temp workspace that is
 * guaranteed to die with its task.
 *
 * WHAT IT DOES. Pulls one `FleetTask` at a time from `/api/fleet/tasks`
 * (`pdf_extract` | `deep_crawl` | `page_digest`), downloads the payload — an R2
 * ZIP of photos, an external PDF map, or a web page — into an ISOLATED
 * sub-folder of the OS temp directory, runs the local Ollama model over the
 * extracted text, POSTs the completed draft JSON of facts back to the
 * Mothership (`/api/brain/ingest`), reports the outcome to the queue, and wipes
 * the workspace.
 *
 * WHY THE WORKSPACE IS THE POINT. These payloads are big — a photo ZIP plus a
 * 200-page park-rules PDF is hundreds of megabytes — and a node that keeps them
 * "just in case" fills the host's disk within days. This module therefore makes
 * a hard promise with THREE overlapping layers, because each one alone has a
 * hole:
 *
 *   1. SUCCESS STATE — the exact moment the draft POST is accepted by the
 *      Mothership, the workspace is deleted. Nothing else runs first; the ZIPs,
 *      extracted photos and PDFs are gone before the completion report leaves
 *      the process.
 *   2. FAILURE STATE (`try/finally`) — a local-Ollama crash, a Mothership POST
 *      failure, a truncated download, a corrupt archive: whatever throws, the
 *      `finally` inside {@link withTaskWorkspace} deletes the workspace on the
 *      way out. A failed task never leaves an orphan behind.
 *   3. CRASH STATE ({@link sweepStaleWorkspaces}) — `finally` cannot run when
 *      the process is KILLED: power loss, a watchdog restart, an OTA swap
 *      mid-download. So every poll also sweeps `rippa-ingest-*` workspaces
 *      older than a generous age ceiling. Layer 2 keeps normal failures clean;
 *      layer 3 is the backstop that makes "permanently hoarding disk space"
 *      impossible even for the failures nobody survives.
 *
 * Every heavy byte lands under {@link taskWorkspaceDir} — never beside the
 * executable, never in the data directory, never in the current working
 * directory. The isolation is what makes the deletion surgical: wiping a
 * task-scoped temp folder can never touch anything the node still needs.
 */

/** Prefix marking every directory this engine owns inside `os.tmpdir()`. */
export const INGEST_WORKSPACE_PREFIX = "rippa-ingest-";

/** Cadence of the queue poll — heavy work, so deliberately unhurried. */
const POLL_INTERVAL_MS = 5 * 60_000;
/** Let boot finish (DB, watchdog, scraper) before the first heavy task. */
const FIRST_POLL_DELAY_MS = 90_000;
/**
 * Age past which a workspace is treated as a crash orphan and swept.
 *
 * Deliberately hours, not minutes: a legitimate task downloads for up to
 * {@link DOWNLOAD_TIMEOUT_MS} and then waits on local inference, so the live
 * workspace's mtime stays old for its whole life. The ceiling must clear the
 * worst-case task by a wide margin — sweeping a LIVE workspace would delete
 * files out from under an extraction that is still reading them.
 */
const STALE_WORKSPACE_MAX_AGE_MS = 2 * 60 * 60_000;
/** One payload download may take at most this long end to end. */
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
/** Hard ceiling on a downloaded payload — a ZIP bomb must not fill the disk. */
const MAX_PAYLOAD_BYTES = 256 * 1024 * 1024;
/**
 * Total text handed to the model across all chunks of one task.
 *
 * `OllamaClient.extractFacts` caps each call at 16k chars and returns ONE fact
 * per call, so the engine walks this text in {@link AI_CHUNK_CHARS} slices and
 * stops at `task.maxFacts` — the cap bounds both the prompt budget and how
 * many model round-trips a single task can cost.
 */
const MAX_TEXT_CHARS = 48_000;
/** Size of one model call's slice of the collected text. */
const AI_CHUNK_CHARS = 4_000;
/** Largest single text member read out of an extracted archive. */
const MAX_TEXT_FILE_BYTES = 1024 * 1024;
/** Walk ceiling so a pathological archive cannot pin the process in readdir. */
const MAX_WALK_FILES = 4_000;
/** Archive members whose contents are collected as text. */
const TEXT_EXTS = new Set([".txt", ".md", ".csv", ".json", ".html", ".htm"]);

/**
 * What the engine needs from the host.
 *
 * Structural (`Pick`-style) rather than concrete classes so verification
 * scripts can drive the engine with recording stubs — the cleanup guarantees
 * are proven against fakes for the network and the model, and against the real
 * filesystem for the bytes on disk.
 */
export interface IngestionDeps {
  /** The Mothership: queue in, draft + completion out. */
  swarm: Pick<SwarmClient, "fetchFleetTask" | "ingestBrainFacts" | "completeFleetTask">;
  /** The local model used for fact extraction. */
  ollama: Pick<OllamaClient, "extractFacts">;
  /**
   * Replaces the download/extract stage (tests). Must return the text to run
   * the model over and may write whatever it likes INSIDE `workspaceDir` — the
   * engine guarantees the directory is deleted afterwards either way.
   */
  collectText?: (task: FleetTask, workspaceDir: string) => Promise<string>;
}

/**
 * THE ISOLATED WORKSPACE for one task: `<os.tmpdir()>/rippa-ingest-<id>-<rnd>`.
 *
 * The task id is the human-readable half (sanitised to `[A-Za-z0-9_-]` — no
 * dots, so `..` can never survive; no separators, so no traversal), and a
 * random suffix is the unique half: two nodes installed on the SAME machine
 * must never share a directory for the same task id, or one process's cleanup
 * would delete the other's half-extracted payload mid-read. Pure string
 * arithmetic — no mkdir — so callers can compute the path before committing to
 * creating it.
 */
export function taskWorkspaceDir(taskId: string): string {
  const safe =
    (taskId ?? "")
      .replace(/[^A-Za-z0-9_-]+/g, "_")
      .replace(/_{3,}/g, "_")
      .slice(0, 64)
      .replace(/^[-_]+/, "") || "unknown";
  return path.join(
    os.tmpdir(),
    `${INGEST_WORKSPACE_PREFIX}${safe}-${randomBytes(3).toString("hex")}`,
  );
}

/**
 * Recursively deletes one workspace. BEST-EFFORT AND NEVER THROWING.
 *
 * `force: true` makes a missing directory a success (the success-path cleanup
 * and the `finally` routinely race each other — the second call is a no-op).
 * A genuine failure (Windows EBUSY while an antivirus scans the file) is
 * logged with the exact path rather than thrown: throwing here would mask the
 * ORIGINAL error the `finally` is protecting, and the stale sweep will retry
 * the same directory on a later poll anyway.
 */
export async function cleanupWorkspace(dir: string): Promise<void> {
  try {
    await fs.promises.rm(dir, { recursive: true, force: true });
  } catch (error) {
    console.warn(
      `[Ingest] Could not remove workspace ${dir} (${
        error instanceof Error ? error.message : String(error)
      }) — the stale sweep will retry it.`,
    );
  }
}

/**
 * THE FAILURE-STATE GUARANTEE. Runs `fn` inside a fresh workspace and deletes
 * it in `finally` — after a successful draft POST the engine will already have
 * called {@link cleanupWorkspace} itself (the success state), and this second,
 * idempotent call is the net that catches every throw between download and
 * upload. The directory exists for the duration of `fn` and for no longer.
 */
export async function withTaskWorkspace<T>(
  taskId: string,
  fn: (workspaceDir: string) => Promise<T>,
): Promise<T> {
  const dir = taskWorkspaceDir(taskId);
  await fs.promises.mkdir(dir, { recursive: true });
  try {
    return await fn(dir);
  } finally {
    await cleanupWorkspace(dir);
  }
}

/**
 * THE CRASH-STATE BACKSTOP: deletes `rippa-ingest-*` workspaces older than
 * `maxAgeMs`.
 *
 * The only layer that runs without the process that created the directory —
 * `finally` never executes when the node is killed mid-download, and without
 * this sweep those bytes stayed on the host forever. Directories inside the
 * age ceiling are left strictly alone: the live task's own workspace is
 * indistinguishable from an orphan by name, and only its age separates them.
 *
 * @returns how many orphaned workspaces were removed.
 */
export async function sweepStaleWorkspaces(
  maxAgeMs: number = STALE_WORKSPACE_MAX_AGE_MS,
): Promise<number> {
  let removed = 0;
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(os.tmpdir(), { withFileTypes: true });
  } catch {
    return 0; // an unreadable temp dir is not this engine's problem to surface
  }
  const cutoff = Date.now() - maxAgeMs;
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(INGEST_WORKSPACE_PREFIX)) continue;
    const dir = path.join(os.tmpdir(), entry.name);
    try {
      const stat = await fs.promises.stat(dir);
      if (stat.mtimeMs >= cutoff) continue;
      await cleanupWorkspace(dir);
      removed += 1;
      console.log(`[Ingest] Swept orphaned workspace ${entry.name} (left by a killed run).`);
    } catch {
      /* a workspace we cannot even stat is reported by cleanupWorkspace if rm runs */
    }
  }
  return removed;
}

/**
 * BEST-EFFORT PDF TEXT EXTRACTION — no library, so no dependency.
 *
 * The repo deliberately ships no PDF parser (adding one for one pipeline stage
 * is a heavy price), and this engine only needs the text a simple `Tj`/`TJ`
 * content stream carries. So: walk every `stream…endstream` block, try
 * `inflateSync` then `inflateRawSync` (PDF's two standard filters) and fall
 * back to the raw bytes (uncompressed streams), then collect the parenthesised
 * strings of the text operators in order and decode their escapes.
 *
 * KNOWN LIMITS, ACCEPTED ON PURPOSE: kerned `TJ` arrays lose their intra-array
 * spacing (tokens are joined with a space, which can insert a space inside a
 * kerned word), and scanned/image-only PDFs yield nothing — the engine then
 * fails the task with "no extractable text" rather than POSTing an empty
 * draft. Corrupt or unknown-filter blocks are skipped, never fatal: one bad
 * stream must not cost the text of the other 199 pages.
 */
export function extractPdfText(buffer: Buffer): string {
  const pieces: string[] = [];
  let cursor = 0;
  while (cursor < buffer.length) {
    const start = buffer.indexOf("stream", cursor);
    if (start === -1) break;
    const end = buffer.indexOf("endstream", start);
    if (end === -1) break;
    cursor = end + "endstream".length;

    // Skip the EOL that follows the `stream` keyword before the raw bytes.
    let from = start + "stream".length;
    if (buffer[from] === 0x0d) from += 1;
    if (buffer[from] === 0x0a) from += 1;
    let raw = buffer.subarray(from, end);
    while (raw.length > 0 && (raw[raw.length - 1] === 0x0a || raw[raw.length - 1] === 0x0d)) {
      raw = raw.subarray(0, raw.length - 1);
    }
    if (raw.length === 0) continue;

    let decoded: string;
    try {
      decoded = zlib.inflateSync(raw).toString("latin1");
    } catch {
      try {
        decoded = zlib.inflateRawSync(raw).toString("latin1");
      } catch {
        // Uncompressed content stream: the operators are already plain bytes.
        decoded = raw.toString("latin1");
      }
    }
    if (!/\bT[jJ]\b|\)\s*T[Jj]/.test(decoded)) continue; // not a text stream (fonts, images)
    for (const token of decoded.match(/\((?:\\[\s\S]|[^\\()])*\)/g) ?? []) {
      pieces.push(decodePdfString(token.slice(1, -1)));
    }
  }
  return pieces.join(" ").replace(/\s+/g, " ").trim().slice(0, MAX_TEXT_CHARS);
}

/** Decodes the escapes legal inside a PDF literal string. */
function decodePdfString(raw: string): string {
  return raw.replace(/\\(n|r|t|b|f|\(|\)|\\|[0-7]{1,3})/g, (_match, group: string) => {
    switch (group) {
      case "n":
        return "\n";
      case "r":
        return "\r";
      case "t":
        return "\t";
      case "b":
        return "\b";
      case "f":
        return "\f";
      default:
        if (/^[0-7]+$/.test(group)) return String.fromCharCode(parseInt(group, 8));
        return group; // \( \) \\ and anything else arrive literally
    }
  });
}

/** Strips markup down to readable text, for HTML payloads and members. */
export function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}

/** Splits collected text into non-overlapping model-sized slices. */
function chunkText(text: string, size: number): string[] {
  const chunks: string[] = [];
  for (let at = 0; at < text.length && chunks.length * size < MAX_TEXT_CHARS; at += size) {
    chunks.push(text.slice(at, at + size));
  }
  return chunks;
}

// --- THE DEFAULT DOWNLOAD/EXTRACT STAGE -------------------------------------

/** How the payload's bytes will be handled, before a single one is written. */
type PayloadKind = "zip" | "pdf" | "html" | "text" | "unknown";

function classifyPayload(ext: string, contentType: string): PayloadKind {
  if (ext === ".zip" || contentType.includes("zip")) return "zip";
  if (ext === ".pdf" || contentType.includes("pdf")) return "pdf";
  if (contentType.startsWith("text/html") || ext === ".html" || ext === ".htm") return "html";
  if (contentType.startsWith("text/") || [".txt", ".md", ".csv", ".json"].includes(ext)) {
    return "text";
  }
  // R2 loves `application/octet-stream` with no extension at all — the magic
  // bytes decide once the file is on disk (see sniffPayload).
  return "unknown";
}

/** Sniffs `PK\x03\x04` / `%PDF` off the first bytes of a downloaded file. */
function sniffPayload(head: Buffer): PayloadKind | null {
  if (
    head.length >= 4 &&
    head[0] === 0x50 &&
    head[1] === 0x4b &&
    head[2] === 0x03 &&
    head[3] === 0x04
  ) {
    return "zip";
  }
  if (head.subarray(0, 4).toString("latin1") === "%PDF") return "pdf";
  return null;
}

/**
 * Downloads ONE payload into `workspaceDir` and returns the text to extract
 * facts from. Everything heavy — the archive, its extracted members, the PDF —
 * is written ONLY inside the workspace, so the caller's cleanup deletes every
 * byte it produced without knowing anything about formats.
 *
 * Bounds enforced on the way in: a declared `Content-Length` over
 * {@link MAX_PAYLOAD_BYTES} is refused before streaming, a lying server is
 * stopped mid-stream by the same ceiling, and each download has a wall-clock
 * budget — an unbounded download is how a temp folder becomes permanent.
 */
export async function collectTaskText(task: FleetTask, workspaceDir: string): Promise<string> {
  const response = await axios.get(task.url, {
    responseType: "stream",
    timeout: DOWNLOAD_TIMEOUT_MS,
    maxRedirects: 5,
    validateStatus: (status) => status >= 200 && status < 300,
  });

  const contentType = String(response.headers["content-type"] ?? "").toLowerCase();
  const ext = path.extname(new URL(task.url).pathname).toLowerCase();
  const declared = Number(response.headers["content-length"] ?? 0);
  if (declared > MAX_PAYLOAD_BYTES) {
    response.data?.destroy?.();
    throw new Error(`payload declares ${declared} bytes — over the ${MAX_PAYLOAD_BYTES} ceiling`);
  }

  let kind = classifyPayload(ext, contentType);

  // Text-shaped payloads never touch the disk at all: they are capped in
  // memory, which is kinder than writing a file whose only purpose is being
  // deleted a minute later. The workspace exists for the heavy bytes.
  if (kind === "html" || kind === "text") {
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of response.data as AsyncIterable<Buffer>) {
      bytes += chunk.length;
      if (bytes > MAX_TEXT_FILE_BYTES) break;
      chunks.push(chunk);
    }
    const body = Buffer.concat(chunks).toString("utf8");
    return (kind === "html" ? stripHtml(body) : body).slice(0, MAX_TEXT_CHARS);
  }

  const urlName = decodeURIComponent(path.basename(new URL(task.url).pathname));
  const fileName =
    kind === "zip"
      ? "payload.zip"
      : kind === "pdf"
        ? "payload.pdf"
        : urlName || "payload.bin";
  const safeName = fileName.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 120) || "payload.bin";
  const target = path.join(workspaceDir, safeName);

  let bytes = 0;
  try {
    await pipeline(
      response.data,
      async function* (source: AsyncIterable<Buffer>) {
        for await (const chunk of source) {
          bytes += chunk.length;
          if (bytes > MAX_PAYLOAD_BYTES) {
            throw new Error(`payload exceeded the ${MAX_PAYLOAD_BYTES} byte ceiling mid-stream`);
          }
          yield chunk;
        }
      },
      fs.createWriteStream(target),
    );
  } catch (error) {
    await fs.promises.rm(target, { force: true }); // a partial file is still disk hoarding
    throw error instanceof Error ? error : new Error(String(error));
  }

  if (kind === "unknown") {
    // Four bytes, read positionally — never `readFile` on a 256 MB payload.
    let head = Buffer.alloc(0);
    try {
      const handle = await fs.promises.open(target, "r");
      try {
        head = Buffer.alloc(4);
        const { bytesRead } = await handle.read(head, 0, 4, 0);
        head = head.subarray(0, bytesRead);
      } finally {
        await handle.close();
      }
    } catch {
      head = Buffer.alloc(0);
    }
    const sniffed = sniffPayload(head);
    if (!sniffed) {
      throw new Error(
        `unsupported payload (content-type "${contentType || "unknown"}", no zip/PDF magic)`,
      );
    }
    kind = sniffed;
  }

  if (kind === "pdf") {
    const text = extractPdfText(await fs.promises.readFile(target));
    await fs.promises.rm(target, { force: true }); // dead weight once parsed
    return text;
  }

  // ZIP: unpack, then delete the ARCHIVE immediately — the extracted tree is
  // what the rest of the stage reads, and the archive is the single biggest
  // file in the workspace. Freeing it early halves the peak footprint.
  const unpackDir = path.join(workspaceDir, "extracted");
  await fs.promises.mkdir(unpackDir, { recursive: true });
  await extract(target, { dir: unpackDir });
  await fs.promises.rm(target, { force: true });
  return collectTextFromTree(unpackDir);
}

/** Reads every text-bearing member of an extracted archive, within budget. */
async function collectTextFromTree(root: string): Promise<string> {
  const parts: string[] = [];
  let budget = MAX_TEXT_CHARS;
  let seen = 0;

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 6 || budget <= 0 || seen > MAX_WALK_FILES) return;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (budget <= 0 || seen > MAX_WALK_FILES) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full, depth + 1);
        continue;
      }
      seen += 1;
      const ext = path.extname(entry.name).toLowerCase();
      try {
        if (ext === ".pdf") {
          const text = extractPdfText(await fs.promises.readFile(full));
          if (text) {
            parts.push(text.slice(0, budget));
            budget -= text.length;
          }
        } else if (TEXT_EXTS.has(ext)) {
          const stat = await fs.promises.stat(full);
          if (stat.size > MAX_TEXT_FILE_BYTES) continue;
          const raw = await fs.promises.readFile(full, "utf8");
          const text = ext === ".html" || ext === ".htm" ? stripHtml(raw) : raw;
          parts.push(text.slice(0, budget));
          budget -= text.length;
        }
      } catch {
        /* one unreadable member must not cost the text of the others */
      }
    }
  };

  await walk(root, 0);
  return parts.join(" ").replace(/\s+/g, " ").trim().slice(0, MAX_TEXT_CHARS);
}

// --- THE ENGINE -----------------------------------------------------------------

/** One engine outcome, before the queue report adds taskId/durationMs. */
interface IngestOutcome {
  ok: boolean;
  facts: number;
  detail: string;
}

/** Axios-aware error description, matching the other services' log style. */
function describeError(error: unknown): string {
  if (axios.isAxiosError(error)) {
    const status = error.response?.status;
    return status ? `HTTP ${status} — ${error.message}` : error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * Executes fleet research tasks with the three-layer cleanup promise from the
 * file header. One task at a time (`busy` gate): this is idle-tier work on a
 * machine that is also scraping and serving inference, and parallel payloads
 * would fight the local model for RAM anyway.
 */
export class IngestionEngine {
  private timer: NodeJS.Timeout | null = null;
  private firstPoll: NodeJS.Timeout | null = null;
  private busy = false;
  private running = false;
  private readonly collect: (task: FleetTask, workspaceDir: string) => Promise<string>;

  constructor(private readonly deps: IngestionDeps) {
    this.collect = deps.collectText ?? collectTaskText;
  }

  /** Starts the poll loop (idempotent) and sweeps crash orphans first. */
  start(): void {
    if (this.running) return;
    this.running = true;
    void sweepStaleWorkspaces(); // layer 3, before any new work is claimed
    this.firstPoll = setTimeout(() => {
      this.firstPoll = null;
      void this.runOnce();
    }, FIRST_POLL_DELAY_MS);
    this.firstPoll.unref?.();
    this.timer = setInterval(() => void this.runOnce(), POLL_INTERVAL_MS);
    this.timer.unref?.();
    console.log(
      `[Ingest] Fleet ingestion active — polling every ${POLL_INTERVAL_MS / 60000} min; ` +
        `workspaces live in ${os.tmpdir()} under "${INGEST_WORKSPACE_PREFIX}*" and are ` +
        "wiped on success, on failure, and swept after a crash.",
    );
  }

  /** Stops the poll loop. In-flight work finishes and cleans up normally. */
  stop(): void {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.firstPoll) {
      clearTimeout(this.firstPoll);
      this.firstPoll = null;
    }
  }

  /**
   * One queue poll: sweep orphans, ask for work, run at most one task.
   *
   * The sweep runs on every tick so workspaces orphaned by a killed process
   * die without waiting for a reboot. `busy` gates the whole body — overlapping
   * polls would double-claim work the Mothership thinks is in progress.
   */
  async runOnce(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      await sweepStaleWorkspaces();
      const task = await this.deps.swarm.fetchFleetTask();
      if (!task) return; // an idle fleet is the normal state — no log needed
      await this.runTask(task);
    } finally {
      this.busy = false;
    }
  }

  /**
   * Runs ONE task end to end and ALWAYS reports it to the queue — success or
   * failure. A task that is never acknowledged sits claimed forever, so the
   * completion POST lives outside the pipeline's own error handling: even a
   * payload the engine could not parse is answered with `ok: false` and a
   * detail a human can act on.
   */
  async runTask(task: FleetTask): Promise<FleetTaskResult> {
    const started = Date.now();
    let outcome: IngestOutcome;
    try {
      outcome = await this.ingest(task);
    } catch (error) {
      const detail = describeError(error);
      console.warn(`[Ingest] Task ${task.id} (${task.kind}) failed — ${detail}`);
      outcome = { ok: false, facts: 0, detail };
    }
    const result: FleetTaskResult = {
      taskId: task.id,
      ...outcome,
      durationMs: Date.now() - started,
    };
    await this.deps.swarm.completeFleetTask(result);
    return result;
  }

  /**
   * THE PIPELINE: download → extract → AI → draft POST, inside a workspace
   * that dies on success (step 4) and on ANY throw (the `finally` inside
   * {@link withTaskWorkspace}).
   *
   * Everything between download and upload — including the local Ollama call
   * and the Mothership POST — lives inside that `try/finally`, which is the
   * requirement in one sentence: no outcome of any stage can leave the ZIPs,
   * extracted photos or PDFs on the host.
   */
  private async ingest(task: FleetTask): Promise<IngestOutcome> {
    return withTaskWorkspace(task.id, async (dir) => {
      // 1. DOWNLOAD/EXTRACT — every heavy byte lands in `dir`, nowhere else.
      const text = (await this.collect(task, dir)).trim();
      if (!text) {
        throw new Error("payload yielded no extractable text (a scanned PDF or an empty archive)");
      }

      // 2. AI EXTRACTION — a model crash surfaces as a throw (or as every
      //    chunk returning null, i.e. zero facts) and falls through to finally.
      const facts = await this.extract(text, task);
      if (facts.length === 0) {
        throw new Error("the local AI produced no facts from the payload");
      }

      // 3. POST THE COMPLETED DRAFT JSON to the Mothership.
      const posted = await this.deps.swarm.ingestBrainFacts({
        taskId: task.id,
        sourceUrl: task.url,
        facts,
      });
      if (!posted) {
        throw new Error("the Mothership did not accept the draft POST");
      }

      // 4. SUCCESS-STATE GC — the exact moment the draft lands: wipe the
      //    workspace before anything else runs. The `finally` below repeats
      //    this idempotently; keeping BOTH is what makes the guarantee hold
      //    whether the pipeline ends here or throws on the way out.
      await cleanupWorkspace(dir);
      console.log(`[Ingest] Task ${task.id}: ${facts.length} fact(s) POSTed — workspace wiped.`);
      return {
        ok: true,
        facts: facts.length,
        detail: `ingested ${facts.length} fact(s) from ${task.kind}`,
      };
    });
  }

  /**
   * Chunked fact extraction, bounded by `task.maxFacts` and deduplicated by
   * summary so two near-identical chunks cannot POST the same sentence twice.
   *
   * `extractFacts` returning `null` means the model was unreachable or replied
   * with unparseable output — whatever facts were already collected are kept
   * (partial success is still a POST), and zero facts overall becomes the
   * throw that fails the task. No retry loop here on purpose: the queue
   * re-dispatches failed tasks with its own backoff.
   */
  private async extract(text: string, task: FleetTask): Promise<VerifiedFact[]> {
    const limit = Math.max(1, task.maxFacts);
    const facts: VerifiedFact[] = [];
    const seen = new Set<string>();
    for (const chunk of chunkText(text, AI_CHUNK_CHARS)) {
      if (facts.length >= limit) break;
      const fact = await this.deps.ollama.extractFacts(chunk);
      if (!fact) break;
      const key = fact.fact_summary.trim().toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      facts.push(fact);
    }
    return facts;
  }
}

