import { getDeepBrain } from "../db/database";

export interface SwarmTriageItem {
  id: string;
  name: string;
  summary: string | null;
  confidence_score: number;
  consensus_status: string;
  ai_auto_published: number;
  source_url: string | null;
  category_ids: string | null;
}

export function getAutoPublishedPlaces(limit: number = 50, offset: number = 0): SwarmTriageItem[] {
  return getDeepBrain()
    .prepare(
      `SELECT id, name, summary, confidence_score, consensus_status, ai_auto_published, source_url, category_ids
         FROM brain_places WHERE confidence_score >= 90 AND ai_auto_published = 1
         ORDER BY confidence_score DESC LIMIT ? OFFSET ?`,
    )
    .all(limit, offset) as SwarmTriageItem[];
}

export function getReviewQueuePlaces(limit: number = 50, offset: number = 0): SwarmTriageItem[] {
  return getDeepBrain()
    .prepare(
      `SELECT id, name, summary, confidence_score, consensus_status, ai_auto_published, source_url, category_ids
         FROM brain_places WHERE confidence_score < 90 ORDER BY confidence_score ASC LIMIT ? OFFSET ?`,
    )
    .all(limit, offset) as SwarmTriageItem[];
}

export function getReviewQueueCount(): number {
  const r = getDeepBrain()
    .prepare("SELECT COUNT(*) AS c FROM brain_places WHERE confidence_score < 90")
    .get() as { c: number };
  return r.c;
}

export function getAutoPublishedCount(): number {
  const r = getDeepBrain()
    .prepare(
      "SELECT COUNT(*) AS c FROM brain_places WHERE confidence_score >= 90 AND ai_auto_published = 1",
    )
    .get() as { c: number };
  return r.c;
}

export function getConsensusStats(): {
  verified_count: number;
  conflict_count: number;
  degraded_count: number;
  pending_count: number;
  consensus_match_rate: number;
  total_processed: number;
} {
  const s = getDeepBrain()
    .prepare(
      `SELECT SUM(CASE WHEN consensus_status = 'verified' THEN 1 ELSE 0 END) AS vc,
              SUM(CASE WHEN consensus_status = 'conflict' THEN 1 ELSE 0 END) AS cc,
              SUM(CASE WHEN consensus_status = 'degraded' THEN 1 ELSE 0 END) AS dc,
              SUM(CASE WHEN consensus_status = 'pending' THEN 1 ELSE 0 END) AS pc,
              COUNT(*) AS tc FROM brain_places WHERE confidence_score > 0`,
    )
    .get() as {
      vc: number | null;
      cc: number | null;
      dc: number | null;
      pc: number | null;
      tc: number;
    };

  const v = s.vc || 0;
  const t = s.tc || 1;
  return {
    verified_count: v,
    conflict_count: s.cc || 0,
    degraded_count: s.dc || 0,
    pending_count: s.pc || 0,
    consensus_match_rate: t > 0 ? Math.round((v / t) * 100) : 0,
    total_processed: t,
  };
}

export function approveAndPublishPlace(id: string): boolean {
  try {
    getDeepBrain()
      .prepare(
        `UPDATE brain_places SET ai_auto_published=1, confidence_score=MAX(confidence_score,95), consensus_status='verified' WHERE id=?`,
      )
      .run(id);
    return true;
  } catch {
    return false;
  }
}

export function rejectAndDeletePlace(id: string): boolean {
  try {
    getDeepBrain()
      .prepare(
        `UPDATE brain_places SET ai_auto_published=0, confidence_score=0, consensus_status='pending' WHERE id=?`,
      )
      .run(id);
    return true;
  } catch {
    return false;
  }
}

export function sendPlaceBackToSwarm(id: string): boolean {
  try {
    getDeepBrain()
      .prepare(
        `UPDATE brain_places SET confidence_score=0, consensus_status='pending', ai_auto_published=0 WHERE id=?`,
      )
      .run(id);
    return true;
  } catch {
    return false;
  }
}

export function getPlaceById(id: string): SwarmTriageItem | null {
  const r = getDeepBrain()
    .prepare(
      `SELECT id, name, summary, confidence_score, consensus_status, ai_auto_published, source_url, category_ids
         FROM brain_places WHERE id=?`,
    )
    .get(id) as SwarmTriageItem | undefined;
  return r || null;
}

export function getPlaceChunks(
  placeId: string,
): Array<{ id: string; category: string | null; text: string; confidence: number }> {
  return getDeepBrain()
    .prepare(
      `SELECT id, category, text, confidence FROM brain_chunks WHERE place_id=? ORDER BY confidence DESC`,
    )
    .all(placeId) as Array<{ id: string; category: string | null; text: string; confidence: number }>;
}
