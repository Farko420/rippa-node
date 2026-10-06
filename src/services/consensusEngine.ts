/**
 * AI CONSENSUS ENGINE — verify data accuracy via multi-node consensus.
 *
 * For critical data points, the Master sends the same prompt to two nodes
 * (Master + Satellite) and compares outputs:
 *   - Match → confidence_score: 95+ (auto-publish)
 *   - Conflict → confidence_score: 40 (Admin review queue)
 */

import axios from "axios";
import type { VerifiedFact } from "../agent/OllamaClient";
import type { PeerEndpoint } from "../config/nodeAuth";

export interface ConsensusCheckRequest {
  checkId: string;
  prompt: string;
  sourceData: string;
  category?: "location" | "rule" | "hazard" | "description";
  maxFacts?: number;
  meshKey?: string;
}

export interface ConsensusCheckResponse {
  checkId: string;
  facts: VerifiedFact[];
  nodeCode?: string;
  durationMs: number;
  error?: string;
}

export interface ConsensusResult {
  consensus: boolean;
  confidence_score: number;
  masterFacts: VerifiedFact[];
  satelliteFacts: VerifiedFact[];
  message: string;
  durationMs: number;
}

export async function sendConsensusCheckToSatellite(
  peer: PeerEndpoint,
  request: ConsensusCheckRequest,
  timeoutMs: number = 30_000,
): Promise<ConsensusCheckResponse | null> {
  try {
    const url = peer.ipAddress && peer.port
      ? `http://${peer.ipAddress}:${peer.port}/api/mesh/consensus-check`
      : peer.cloudLinkUrl
        ? `${peer.cloudLinkUrl}/api/mesh/consensus-check`
        : null;

    if (!url) {
      console.warn(`[Consensus] No reachable endpoint for peer ${peer.nodeCode || "unknown"}`);
      return null;
    }

    const response = await axios.post<ConsensusCheckResponse>(url, request, {
      headers: {
        "Mesh-Key": request.meshKey || "",
        "Content-Type": "application/json",
      },
      timeout: timeoutMs,
    });

    return response.data;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.warn(`[Consensus] Failed to reach satellite ${peer.nodeCode || "unknown"}: ${msg}`);
    return null;
  }
}

export function factsAreSimilar(fact1: VerifiedFact, fact2: VerifiedFact): boolean {
  if (fact1.category === fact2.category) {
    const words1 = fact1.fact_summary.toLowerCase().split(/\s+/).sort();
    const words2 = fact2.fact_summary.toLowerCase().split(/\s+/).sort();
    const set1 = new Set(words1);
    const set2 = new Set(words2);
    const intersection = [...set1].filter((w) => set2.has(w)).length;
    const union = new Set([...set1, ...set2]).size;
    const similarity = union === 0 ? 0 : intersection / union;
    return similarity >= 0.6;
  }
  return false;
}

export function compareConsensusOutputs(
  masterFacts: VerifiedFact[],
  satelliteFacts: VerifiedFact[],
): Omit<ConsensusResult, "durationMs"> {
  if (masterFacts.length === 0 && satelliteFacts.length === 0) {
    return {
      consensus: true,
      confidence_score: 95,
      masterFacts,
      satelliteFacts,
      message: "Both nodes extracted no facts. Consensus: EMPTY DATA.",
    };
  }

  if ((masterFacts.length === 0) !== (satelliteFacts.length === 0)) {
    return {
      consensus: false,
      confidence_score: 40,
      masterFacts,
      satelliteFacts,
      message: `Divergence: Master ${masterFacts.length} fact(s), Satellite ${satelliteFacts.length}. Review queue.`,
    };
  }

  let matched = 0;
  for (const masterFact of masterFacts) {
    for (const satelliteFact of satelliteFacts) {
      if (factsAreSimilar(masterFact, satelliteFact)) {
        matched++;
        break;
      }
    }
  }

  const matchRatio = masterFacts.length > 0 ? matched / masterFacts.length : 0;

  if (matchRatio >= 0.7) {
    return {
      consensus: true,
      confidence_score: 95,
      masterFacts,
      satelliteFacts,
      message: `Verified: ${matched}/${masterFacts.length} matched (${(matchRatio * 100).toFixed(0)}%)`,
    };
  }

  return {
    consensus: false,
    confidence_score: 40,
    masterFacts,
    satelliteFacts,
    message: `FAILED: only ${matched}/${masterFacts.length} matched (${(matchRatio * 100).toFixed(0)}%)`,
  };
}

export async function runConsensusCheck(
  masterFacts: VerifiedFact[],
  satellitePeer: PeerEndpoint,
  request: ConsensusCheckRequest,
  timeoutMs: number = 30_000,
): Promise<ConsensusResult> {
  const startTime = Date.now();
  const satelliteResponse = await sendConsensusCheckToSatellite(satellitePeer, request, timeoutMs);

  if (!satelliteResponse || satelliteResponse.error) {
    const error = satelliteResponse?.error || "satellite unreachable";
    console.warn(`[Consensus] Satellite check failed: ${error}. Degrading to medium confidence.`);
    return {
      consensus: false,
      confidence_score: 60,
      masterFacts,
      satelliteFacts: [],
      message: `Satellite unavailable (${error}). Medium confidence.`,
      durationMs: Date.now() - startTime,
    };
  }

  const comparison = compareConsensusOutputs(masterFacts, satelliteResponse.facts);

  return {
    ...comparison,
    durationMs: Date.now() - startTime,
  };
}
