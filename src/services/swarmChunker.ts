/**
 * PARALLEL WORKLOAD CHUNKING — split massive tasks across the Swarm.
 *
 * When the Master Node receives a heavy workload (e.g., a large PDF scrape,
 * a list of 50 URLs, or a `PENDING_MASTER_ANALYSIS` batch), this module
 * divides the payload into manageable chunks, dispatches them via HTTP POST
 * to available Satellite Nodes, and keeps one chunk for the Master's local
 * Ollama instance to process.
 *
 * The Compiler then awaits responses and stitches them back together into
 * a unified result payload.
 */

import axios from "axios";
import { type PeerEndpoint } from "../config/nodeAuth";

/**
 * A single unit of work dispatched to a node (Master or Satellite).
 *
 * Generic over the payload type so the same infrastructure works for
 * PDF extraction, URL lists, photo batches, etc.
 */
export interface ChunkPayload<T> {
  /** Unique identifier for this chunk. Master tracks these to await results. */
  chunkId: string;
  /** The task that spawned this chunk (e.g., the parent task ID). */
  parentTaskId: string;
  /** Sequence number: 0, 1, 2, ... N-1. Used for reassembly. */
  sequenceNumber: number;
  /** Total number of chunks in this dispatch (needed to know when we're done). */
  totalChunks: number;
  /** The actual work payload. */
  data: T;
  /** Optional metadata about the chunk's source or requirements. */
  metadata?: Record<string, unknown>;
}

/**
 * The response a satellite returns after processing a chunk.
 *
 * Generic over the result type. Results are collected and merged by the Compiler.
 */
export interface ChunkResult<R> {
  /** Echo back the chunkId so the Master can track which chunk this answers. */
  chunkId: string;
  /** The sequence number, for correct reassembly ordering. */
  sequenceNumber: number;
  /** True if the chunk was processed successfully. */
  success: boolean;
  /** The processed result (e.g., extracted facts, a filtered list). */
  result?: R;
  /** Human-readable error message on failure. */
  error?: string;
  /** How long the chunk took to process, in milliseconds. */
  durationMs: number;
  /** Which node processed this (for tracing and auditing). */
  nodeCode?: string;
}

/**
 * Configuration for chunking behavior.
 */
export interface ChunkingConfig {
  /** How many items (or bytes) per chunk. Default: 100 items or 100KB. */
  chunkSize: number;
  /** How long to wait for each satellite to respond, in milliseconds. Default: 30s. */
  chunkTimeoutMs: number;
  /** If a satellite fails, continue with other nodes? Default: true. */
  toleratePartialFailure: boolean;
}

// --- DEFAULTS ---

const DEFAULT_CHUNKING_CONFIG: ChunkingConfig = {
  chunkSize: 100,
  chunkTimeoutMs: 30_000,
  toleratePartialFailure: true,
};

/**
 * Splits an array-like payload into smaller chunks.
 *
 * Each chunk is tagged with metadata (chunkId, sequence number, total count)
 * so the Compiler can reassemble them later.
 *
 * @param items The array of items to chunk (e.g., URLs, PDF pages, photos).
 * @param parentTaskId The ID of the parent task (for tracing).
 * @param config Chunking configuration (sizes, timeouts, etc.).
 * @returns An array of ChunkPayload objects, ready to dispatch.
 */
export function chunkPayload<T>(
  items: T[],
  parentTaskId: string,
  config: Partial<ChunkingConfig> = {},
): ChunkPayload<T[]>[] {
  const { chunkSize, ...rest } = { ...DEFAULT_CHUNKING_CONFIG, ...config };
  const chunks: ChunkPayload<T[]>[] = [];

  for (let i = 0; i < items.length; i += chunkSize) {
    const data = items.slice(i, i + chunkSize);
    const sequenceNumber = Math.floor(i / chunkSize);
    const totalChunks = Math.ceil(items.length / chunkSize);

    chunks.push({
      chunkId: `chunk-${parentTaskId}-${sequenceNumber}-${Date.now()}`,
      parentTaskId,
      sequenceNumber,
      totalChunks,
      data,
      metadata: rest,
    });
  }

  return chunks;
}

/**
 * Splits a payload by byte size instead of item count.
 *
 * Useful for when you have a large string (PDF text, HTML content) that needs
 * to be divided by size rather than by logical units.
 *
 * @param text The text content to chunk.
 * @param parentTaskId The ID of the parent task.
 * @param byteSizePerChunk Target bytes per chunk (e.g., 100KB).
 * @param config Chunking configuration.
 * @returns An array of ChunkPayload objects.
 */
export function chunkBySize(
  text: string,
  parentTaskId: string,
  byteSizePerChunk: number = 102_400, // 100KB default
  config: Partial<ChunkingConfig> = {},
): ChunkPayload<string>[] {
  const chunks: ChunkPayload<string>[] = [];
  const buffer = Buffer.from(text, "utf8");
  let offset = 0;
  let sequenceNumber = 0;

  // Count total chunks first (need for totalChunks field).
  const totalChunks = Math.ceil(buffer.length / byteSizePerChunk);

  while (offset < buffer.length) {
    const chunk = buffer.slice(offset, offset + byteSizePerChunk).toString("utf8");
    chunks.push({
      chunkId: `chunk-${parentTaskId}-${sequenceNumber}-${Date.now()}`,
      parentTaskId,
      sequenceNumber,
      totalChunks,
      data: chunk,
      metadata: config,
    });
    offset += byteSizePerChunk;
    sequenceNumber++;
  }

  return chunks;
}


// --- DISPATCHER: send chunks to nodes ---

/**
 * Sends a chunk to a specific node (Satellite or Master).
 *
 * The endpoint is inferred from the PeerEndpoint. This uses the node's
 * local IP and port for LAN communication, or Cloud Link for remote nodes.
 *
 * POST /api/mesh/process-chunk
 *
 * @param peer The target node's endpoint (IP, port, cloud link URL).
 * @param chunk The chunk payload to send.
 * @param meshKey Authentication key for P2P calls.
 * @param timeoutMs How long to wait for a response.
 * @returns The ChunkResult, or null if the dispatch failed.
 */
export async function dispatchChunkToPeer<T, R>(
  peer: PeerEndpoint,
  chunk: ChunkPayload<T>,
  meshKey: string,
  timeoutMs: number = 30_000,
): Promise<ChunkResult<R> | null> {
  try {
    // Prefer local IP if available, otherwise use cloud link.
    const url = peer.ipAddress && peer.port
      ? `http://${peer.ipAddress}:${peer.port}/api/mesh/process-chunk`
      : peer.cloudLinkUrl
        ? `${peer.cloudLinkUrl}/api/mesh/process-chunk`
        : null;

    if (!url) {
      console.warn(`[Chunker] No reachable endpoint for peer ${peer.nodeCode || "unknown"}`);
      return null;
    }

    const response = await axios.post<ChunkResult<R>>(url, chunk, {
      headers: {
        "Mesh-Key": meshKey,
        "Content-Type": "application/json",
      },
      timeout: timeoutMs,
    });

    return response.data;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.warn(`[Chunker] Failed to dispatch chunk ${chunk.chunkId} to peer: ${msg}`);
    return null;
  }
}

/**
 * Dispatches all chunks of a task to available Satellites + Master.
 *
 * The Master processes one chunk locally (to stay busy and avoid
 * being a pure orchestrator). All other chunks go to available Satellites
 * via HTTP POST.
 *
 * Returns immediately; the Compiler awaits the results separately.
 *
 * @param chunks The chunks to dispatch (from chunkPayload()).
 * @param satellites Available satellite endpoints from the registry.
 * @param meshKey The mesh key for P2P authentication.
 * @param timeoutMs Per-chunk dispatch timeout.
 * @returns A map of chunkId -> response promise (or undefined if dispatch failed).
 */
export function dispatchAllChunks<T, R>(
  chunks: ChunkPayload<T>[],
  satellites: PeerEndpoint[],
  meshKey: string,
  timeoutMs: number = 30_000,
): Map<string, Promise<ChunkResult<R> | null>> {
  const results = new Map<string, Promise<ChunkResult<R> | null>>();

  // Distribute chunks round-robin across satellites.
  // The first chunk stays with the Master (it will process it locally).
  // All others go to satellites.

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];

    if (i === 0) {
      // First chunk: Master processes this locally. Return a resolved promise
      // that the Compiler expects to collect.
      // (The actual processing happens in swarmCompiler, which calls
      // the local Ollama client instead of dispatching.)
      results.set(chunk.chunkId, Promise.resolve(null)); // Placeholder; Compiler handles Master work.
    } else {
      // Round-robin to satellites.
      const satelliteIndex = (i - 1) % satellites.length;
      const peer = satellites[satelliteIndex];
      const promise = dispatchChunkToPeer<T, R>(peer, chunk, meshKey, timeoutMs);
      results.set(chunk.chunkId, promise);
    }
  }

  return results;
}
