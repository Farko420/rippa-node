/**
 * SWARM COMPILER — collect and merge chunk results.
 */

import type { ChunkResult } from "./swarmChunker";

export interface CompilationConfig {
  totalTimeoutMs: number;
  toleratePartialFailure: boolean;
  onChunkResult?: (result: ChunkResult<unknown>) => void;
}

export interface CompilationOutcome<T> {
  success: boolean;
  result?: T;
  message: string;
  chunksReceived: number;
  chunksExpected: number;
  durationMs: number;
  detailedResults: ChunkResult<unknown>[];
}

export async function awaitChunkResults<R>(
  resultsMap: Map<string, Promise<ChunkResult<R> | null>>,
  expectedChunkCount: number,
  totalTimeoutMs: number = 120_000,
  onChunkResult?: (result: ChunkResult<R>) => void,
): Promise<(ChunkResult<R> | null)[]> {
  const startTime = Date.now();
  const collected: (ChunkResult<R> | null)[] = new Array(expectedChunkCount).fill(null);
  const received = new Set<string>();

  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(
      () => reject(new Error(`Compilation timeout after ${totalTimeoutMs}ms`)),
      totalTimeoutMs,
    );
  });

  try {
    const promises = Array.from(resultsMap.entries()).map(async ([chunkId, resultPromise]) => {
      try {
        const result = await resultPromise;
        if (result) {
          received.add(chunkId);
          if (onChunkResult) onChunkResult(result);
          if (result.sequenceNumber >= 0 && result.sequenceNumber < collected.length) {
            collected[result.sequenceNumber] = result;
          }
        }
      } catch (error) {
        console.warn(`[Compiler] Chunk ${chunkId} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    });

    await Promise.race([Promise.all(promises), timeoutPromise]);
  } catch (error) {
    console.warn(`[Compiler] ${error instanceof Error ? error.message : String(error)}`);
  }

  console.log(`[Compiler] Received ${received.size}/${expectedChunkCount} chunks in ${Date.now() - startTime}ms.`);

  return collected;
}

export function mergeResults<T>(
  chunks: (ChunkResult<T> | null)[],
  strategy: "concatenate" | "merge-objects" | "first-only" = "concatenate",
): T | null {
  const successful = chunks.filter((c): c is ChunkResult<T> => c !== null && c.success);

  if (successful.length === 0) {
    console.warn("[Compiler] No successful chunks to merge.");
    return null;
  }

  if (strategy === "first-only") {
    return successful[0]?.result ?? null;
  }

  if (strategy === "concatenate") {
    const merged: unknown[] = [];
    for (const chunk of successful) {
      if (Array.isArray(chunk.result)) {
        merged.push(...chunk.result);
      }
    }
    return merged as T;
  }

  if (strategy === "merge-objects") {
    const merged: Record<string, unknown> = {};
    for (const chunk of successful) {
      if (typeof chunk.result === "object" && chunk.result !== null && !Array.isArray(chunk.result)) {
        Object.assign(merged, chunk.result);
      }
    }
    return merged as T;
  }

  return null;
}

export function deduplicateByKey<T>(
  items: T[],
  keyFn: (item: T) => string,
): T[] {
  const seen = new Set<string>();
  const result: T[] = [];

  for (const item of items) {
    const key = keyFn(item);
    if (!seen.has(key)) {
      seen.add(key);
      result.push(item);
    }
  }

  return result;
}

export async function compileChunks<R>(
  resultsMap: Map<string, Promise<ChunkResult<R> | null>>,
  expectedChunkCount: number,
  strategy: "concatenate" | "merge-objects" | "first-only" = "concatenate",
  config: Partial<CompilationConfig> = {},
): Promise<CompilationOutcome<R>> {
  const startTime = Date.now();
  const { totalTimeoutMs = 120_000, toleratePartialFailure = true, onChunkResult } = config;

  const collected = await awaitChunkResults(
    resultsMap,
    expectedChunkCount,
    totalTimeoutMs,
    onChunkResult,
  );

  const successful = collected.filter((c): c is ChunkResult<R> => c !== null && c.success);
  const failed = collected.filter((c) => c !== null && !c.success);

  const hasEnough = toleratePartialFailure
    ? successful.length > 0
    : successful.length === expectedChunkCount;

  if (!hasEnough) {
    return {
      success: false,
      message: `Only ${successful.length}/${expectedChunkCount} chunks succeeded; ${failed.length} failed.`,
      chunksReceived: successful.length,
      chunksExpected: expectedChunkCount,
      durationMs: Date.now() - startTime,
      detailedResults: collected.filter((c): c is ChunkResult<R> => c !== null),
    };
  }

  const merged = mergeResults(successful, strategy);

  return {
    success: true,
    result: merged || undefined,
    message: `Compilation succeeded: ${successful.length}/${expectedChunkCount} chunks merged.` +
      (failed.length > 0 ? ` (${failed.length} failed; partial result.)` : ""),
    chunksReceived: successful.length,
    chunksExpected: expectedChunkCount,
    durationMs: Date.now() - startTime,
    detailedResults: successful,
  };
}
