/**
 * MOTHERSHIP GATEWAY — direct injection of verified data.
 *
 * Once the Swarm has compiled and verified data via consensus, the Master Node
 * uses its secure API key to POST the payload directly to the Mothership's
 * `/api/admin/places/import` endpoint.
 *
 * Because the Master has verified the data (confidence >= 90), the payload
 * automatically exceeds the threshold for Auto-Publish on the live map.
 */

import axios from "axios";
import type { VerifiedFact } from "../agent/OllamaClient";

/**
 * A verified payload ready for injection into the Mothership.
 *
 * This is what the Swarm Commander assembles after chunking, compiling,
 * and consensus verification.
 */
export interface MothershipPayload {
  /** Source URL (where the data came from). */
  sourceUrl: string;
  /** The facts extracted and verified by the Swarm. */
  facts: VerifiedFact[];
  /** Overall confidence in this batch (95 for consensus, 60 for degraded). */
  confidence_score: number;
  /** How this batch was processed (e.g., "chunked across 3 satellites"). */
  processingMethod: string;
  /** Batch ID for tracing. */
  batchId?: string;
}

/**
 * Response from the Mothership after accepting an import.
 */
export interface MothershipResponse {
  success: boolean;
  message: string;
  importId?: string;
  autoPublished?: boolean;
  detailedErrors?: string[];
}

/**
 * Posts a verified payload directly to the Mothership.
 *
 * The Mothership's `/api/admin/places/import` endpoint auto-publishes when:
 *   - API key is valid (authenticated as Master Node).
 *   - Confidence score >= 90.
 *
 * Below that threshold, the import goes to Admin review queue.
 *
 * @param payload The verified facts and metadata.
 * @param mothershipsBaseUrl The Mothership's base URL (e.g., "https://api.rippa.io").
 * @param apiKey The Master Node's API key for authentication.
 * @returns MothershipResponse with success flag and import ID.
 */
export async function injectIntoMothership(
  payload: MothershipPayload,
  mothershipsBaseUrl: string = "https://api.rippa.io",
  apiKey: string = "",
): Promise<MothershipResponse> {
  if (!apiKey) {
    console.warn("[Gateway] No MOTHERSHIP_API_KEY configured. Injection skipped.");
    return {
      success: false,
      message: "No API key configured for Mothership injection.",
    };
  }

  try {
    const url = `${mothershipsBaseUrl}/api/admin/places/import`;

    const response = await axios.post<MothershipResponse>(url, payload, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      timeout: 30_000,
    });

    console.log(
      `[Gateway] Mothership import accepted. ID: ${response.data.importId || "none"}. ` +
        `Auto-publish: ${response.data.autoPublished ? "YES" : "NO"}.`,
    );

    return response.data;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`[Gateway] Mothership injection failed: ${msg}`);

    return {
      success: false,
      message: `Mothership injection failed: ${msg}`,
    };
  }
}

/**
 * Determines if a payload is eligible for auto-publish based on confidence.
 *
 * @param confidenceScore The overall confidence (0-100).
 * @returns True if the payload should be auto-published.
 */
export function isEligibleForAutoPublish(confidenceScore: number): boolean {
  return confidenceScore >= 90;
}

/**
 * Builds a Mothership payload from compiled and verified facts.
 *
 * This is a helper that formats the output of the consensus engine into
 * the shape the Mothership expects.
 *
 * @param facts The verified facts.
 * @param sourceUrl Where the facts came from.
 * @param confidenceScore Overall confidence (from consensus).
 * @param processingMethod How the facts were processed (e.g., "chunked").
 * @param batchId Optional batch ID for tracing.
 * @returns MothershipPayload ready for injection.
 */
export function buildMothershipPayload(
  facts: VerifiedFact[],
  sourceUrl: string,
  confidenceScore: number,
  processingMethod: string = "consensus-verified",
  batchId?: string,
): MothershipPayload {
  return {
    sourceUrl,
    facts,
    confidence_score: Math.min(100, Math.max(0, confidenceScore)),
    processingMethod,
    batchId,
  };
}
