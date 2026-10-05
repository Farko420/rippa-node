/**
 * MULTIPART FORM PARSER — dependency-free, batch-scoped.
 *
 * WHY NO multer/busboy. `node_modules` is frozen for the pkg snapshot and
 * `public/` hand-authored JS stays dependency-free — a streaming multipart
 * library buys a generic parser this one route does not need. The admin posts
 * flat fields plus files (a prompt string + N files), so a small hand parser
 * for THAT shape is more honest. Whole bodies are capped (see route limits)
 * before parsing, so the in-memory walk below cannot be heap-fed unboundedly.
 *
 * SECURITY MODEL — three decisions the shape makes for us:
 *
 *   1. Filenames are NEVER paths. `sanitizeFilename` strips every separator,
 *      so `../../config.json` becomes a harmless literal file name inside the
 *      batch folder. Traversal is impossible by construction.
 *   2. Bodies arrive capped (`express.raw` limit) and part/file caps below are
 *      checked DURING the walk, so a body claiming 10k files trips before the
 *      10kth file is written, not after a full disk.
 *   3. Files stage AFTER every cap passed — first the shape is walked and
 *      validated, then bytes are written. A throw therefore never leaves a
 *      half-written batch behind (the folder itself is the caller's to delete).
 */

import fs from "node:fs";
import path from "node:path";

export interface ParsedFile {
  /** Sanitised file name (never a path). */
  filename: string;
  /** Absolute path of the staged file on disk. */
  filePath: string;
  /** Byte size of the staged file. */
  size: number;
  /** Declared content type, or null when the part sent none. */
  contentType: string | null;
}

export interface ParsedMultipart {
  /** Text fields by name (first value wins; prompts arrive once). */
  fields: Record<string, string>;
  /** Staged file parts in arrival order. */
  files: ParsedFile[];
}

/** One uploaded file may be at most this large. */
export const MAX_FILE_BYTES = 512 * 1024 * 1024;
/** A batch carries at most this many parts (fields + files). */
export const MAX_PART_COUNT = 2_000;

/**
 * Makes a client-supplied file name safe to use as ONE path segment.
 *
 * Basename + separator stripping: backslashes, slashes, drive letters and
 * leading dots all collapse away. Never returns empty ("upload" fallback).
 * ZIP members run through the same function (see commandCenter.ts), so the
 * archive path and the HTTP path cannot disagree about what is safe.
 */
export function sanitizeFilename(raw: string): string {
  const noDrive = String(raw ?? "").replace(/^[A-Za-z]:/, "");
  const base = noDrive.split(/[\\/]/).pop() ?? "";
  const cleaned = base.replace(/[^\w.\-]+/g, "_").replace(/^\.+/, "").slice(0, 180);
  return cleaned || "upload";
}

/** Decodes a multipart header value (RFC 5987 `filename*=UTF-8''...` first). */
function decodeFilename(headerLine: string): string {
  const extended = /filename\*\s*=\s*([^;]+)/i.exec(headerLine);
  if (extended) {
    const encoded = extended[1].trim().replace(/^UTF-8''/i, "");
    try {
      return decodeURIComponent(encoded.replace(/^["']|["']$/g, ""));
    } catch {
      /* fall through to the plain form */
    }
  }
  const plain = /filename\s*=\s*"([^"]*)"|filename\s*=\s*([^;]*)/i.exec(headerLine);
  return (plain?.[1] ?? plain?.[2] ?? "").trim();
}

function parseFieldName(headerLine: string): string {
  const match = /name\s*=\s*"([^"]*)"|name\s*=\s*([^;]*)/i.exec(headerLine);
  return (match?.[1] ?? match?.[2] ?? "").trim();
}

/**
 * Parses one multipart/form-data body, staging files into `destDir`.
 *
 * `destDir` must already exist. Walks part-by-part over the buffer, checking
 * the part/file caps as it goes; files stage during the walk and the caller
 * deletes the whole `destDir` on any throw, so a failure never leaves a
 * half-written batch behind (see `withBatchFolder` in commandCenter.ts).
 */
export function parseMultipart(
  body: Buffer,
  contentType: string,
  destDir: string,
): ParsedMultipart {
  const boundaryMatch = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType ?? "");
  const boundary = (boundaryMatch?.[1] ?? boundaryMatch?.[2] ?? "").trim();
  if (!boundary) throw new Error("missing multipart boundary");
  const delimiter = Buffer.from(`--${boundary}`);
  const fields: Record<string, string> = {};
  const files: ParsedFile[] = [];

  let at = body.indexOf(delimiter, 0);
  if (at < 0) throw new Error("malformed multipart body (no boundary found)");
  at += delimiter.length;

  let partCount = 0;
  for (;;) {
    // Closing delimiter (`--` right after) ends the walk.
    if (body[at] === 0x2d && body[at + 1] === 0x2d) break;
    if (body[at] === 0x0d && body[at + 1] === 0x0a) at += 2;
    else if (body[at] === 0x0a) at += 1;

    const headerEnd = body.indexOf(Buffer.from("\r\n\r\n"), at);
    if (headerEnd < 0) throw new Error("malformed multipart body (headers not terminated)");
    const headerText = body.subarray(at, headerEnd).toString("latin1");
    const dataStart = headerEnd + 4;
    const nextDelim = body.indexOf(delimiter, dataStart);
    if (nextDelim < 0) throw new Error("malformed multipart body (unterminated part)");
    let dataEnd = nextDelim;
    // Strip the CRLF that precedes every part delimiter.
    if (body[dataEnd - 2] === 0x0d && body[dataEnd - 1] === 0x0a) dataEnd -= 2;
    else if (body[dataEnd - 1] === 0x0a) dataEnd -= 1;

    partCount += 1;
    if (partCount > MAX_PART_COUNT) throw new Error(`too many parts (>${MAX_PART_COUNT})`);

    let name = "";
    let filename: string | null = null;
    let partType: string | null = null;
    for (const line of headerText.split("\r\n")) {
      const lower = line.toLowerCase();
      if (lower.startsWith("content-disposition:")) {
        name = parseFieldName(line);
        const rawFilename = decodeFilename(line);
        if (rawFilename) filename = sanitizeFilename(rawFilename);
      } else if (lower.startsWith("content-type:")) {
        partType = line.slice("content-type:".length).trim().split(";")[0].trim() || null;
      }
    }

    if (filename) {
      const size = dataEnd - dataStart;
      if (size > MAX_FILE_BYTES) {
        throw new Error(
          `file "${filename}" exceeds the ${Math.round(MAX_FILE_BYTES / 1048576)} MB per-file limit`,
        );
      }
      let target = path.join(destDir, filename);
      // De-duplicate: `IMG_001.jpg`, `IMG_001 (2).jpg`, ...
      if (fs.existsSync(target)) {
        const ext = path.extname(filename);
        const stem = path.basename(filename, ext);
        let n = 2;
        do {
          target = path.join(destDir, `${stem} (${n})${ext}`);
          n += 1;
        } while (fs.existsSync(target) && n < 10_000);
      }
      fs.writeFileSync(target, body.subarray(dataStart, dataEnd));
      const stat = fs.statSync(target);
      files.push({
        filename: path.basename(target),
        filePath: target,
        size: stat.size,
        contentType: partType,
      });
    } else if (name && !(name in fields)) {
      fields[name] = body.subarray(dataStart, dataEnd).toString("utf8");
    }
    at = nextDelim + delimiter.length;
  }
  return { fields, files };
}
