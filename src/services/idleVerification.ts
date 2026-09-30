import { env } from "../config";
import {
  insertRawLore,
  insertVerifiedKnowledge,
  markPlaceVerified,
  selectStalePlaces,
  setRawLoreStatus,
  type StalePlaceRow,
} from "../db/database";
import type { OllamaClient } from "../agent/OllamaClient";
import type { ScraperService } from "../agent/Scraper";

/**
 * IDLE VERIFICATION ENGINE — "Verify & Update", 24/7, with nobody watching.
 *
 * THE PROBLEM IT SOLVES. A mirrored brain is a snapshot. The cloud ships a place
 * record saying "open 8am-5pm, campground, cafe", and the node believes it
 * forever. Real places close, hours change, amenities get built. A node that only
 * ever ingests and never re-checks is confidently wrong, which is worse than
 * empty.
 *
 * So when the task queue is empty the Master does not sit idle: it asks the
 * mirror which places have gone longest without a live check, re-scrapes them,
 * and re-verifies the operational facts (hours / amenities / status).
 *
 * WHAT "OLDEST" MEANS. `selectStalePlaces` orders by `last_verified` ascending,
 * and never-verified places carry NULL, which sorts first in SQLite. That gives
 * a starvation-free rotation for free: a new bundle's places are checked before
 * the ones checked yesterday, and nothing starves behind a popular row.
 *
 * THE CURSOR IS ONLY MOVED ON SUCCESS. A place whose scrape 404s, times out, or
 * fails extraction keeps its old `last_verified`, so it comes back next round.
 * Stamping it regardless would silently retire a broken URL and the node would
 * never retry it — a placeholder that can never be filled.
 *
 * COST DISCIPLINE. One place per idle run, not ten. Ten Playwright page loads
 * back-to-back on a small box is how an "autonomous" node becomes a laptop fan.
 * The batch limit is the ceiling on candidates, not the per-run quota.
 */

/** Places examined per run. Ceiling on candidates, not a promise to do them all. */
const STALE_BATCH_LIMIT = 10;
/** How long one place's scrape may take before the place is left for later. */
const VERIFY_TIMEOUT_MS = 90_000;
/** A place checked more recently than this is not worth a scrape slot. */
const RECENTLY_VERIFIED_MS = 6 * 60 * 60_000; // 6 hours

/** What one idle verification run did. */
export interface IdleVerificationResult {
  /** True when a place was re-checked and its cursor advanced. */
  checked: boolean;
  /** Human-readable outcome for the log. */
  message: string;
  /** The place that was examined, when there was one. */
  place?: { id: string; name: string; sourceUrl: string };
}

/** True when this place was checked inside the recency window. */
function recentEnough(place: StalePlaceRow): boolean {
  if (!place.last_verified) return false;
  const at = Date.parse(place.last_verified);
  if (!Number.isFinite(at)) return false; // unparseable = treat as never checked
  return Date.now() - at < RECENTLY_VERIFIED_MS;
}

/** Rejects with a clear message if `promise` has not settled in `ms`. */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} exceeded ${Math.round(ms / 1000)}s`)),
      ms,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Re-verifies the single most overdue place in the mirror.
 *
 * Never throws: an idle-time task must not be able to take down the loop that
 * would have recovered from it. Returns a result describing what happened.
 */
export async function runIdleVerification(
  scraper: ScraperService,
  ollama: OllamaClient,
): Promise<IdleVerificationResult> {
  // Satellites are stateless — they have no mirror to verify against.
  if (env.NODE_ROLE !== "master") {
    return { checked: false, message: "satellite — no local brain to verify." };
  }

  let candidates: StalePlaceRow[];
  try {
    candidates = selectStalePlaces(STALE_BATCH_LIMIT);
  } catch (error) {
    return {
      checked: false,
      message: `brain unavailable — ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (candidates.length === 0) {
    return { checked: false, message: "no verifiable places in the mirror yet." };
  }

  // First candidate not checked in the last few hours wins. The recency guard
  // matters because a bundle of 50 fresh places would otherwise have the node
  // re-scraping the same URL every idle tick for the next hour.
  const place = candidates.find((candidate) => !recentEnough(candidate));
  if (!place) {
    return {
      checked: false,
      message: `${candidates.length} place(s) checked recently — nothing overdue.`,
    };
  }

  const sourceUrl = String(place.source_url);
  const identity = { id: place.id, name: place.name, sourceUrl };

  try {
    const { text } = await withTimeout(
      scraper.scrape(sourceUrl),
      VERIFY_TIMEOUT_MS,
      `scrape of ${sourceUrl}`,
    );

    const loreId = insertRawLore("verify", text, sourceUrl);

    // Re-extract against the live page. Comparing that against what the mirror
    // already claims is the operator's job in the Control Center; the node's
    // part is to produce the fresh evidence and record that it looked.
    const fact = await ollama.extractFacts(text);
    if (fact) {
      insertVerifiedKnowledge(fact);
    }

    // Only now does the place stop being overdue.
    markPlaceVerified(place.id);
    setRawLoreStatus(loreId, "extracted");

    return {
      checked: true,
      place: identity,
      message:
        `re-verified "${place.name}"` +
        (fact ? ` — [${fact.category}] ${fact.fact_summary}` : " — no structured fact extracted"),
    };
  } catch (error) {
    // Deliberately NOT stamping last_verified: a failed check must stay overdue
    // so the next idle run retries it.
    return {
      checked: false,
      place: identity,
      message: `verification of "${place.name}" failed — ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}
