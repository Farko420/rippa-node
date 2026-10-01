import { env } from "../config";
import { currentNodeIdentity } from "../config/nodeAuth";
import {
  insertBrainChunk,
  insertRawLore,
  insertVerifiedKnowledge,
  isDeepBrainReady,
  markKnowledgeSynced,
  markPlaceVerified,
  selectForageTargets,
  selectScrapedSourceUrls,
  setRawLoreStatus,
  type ForageTargetRow,
} from "../db/database";
import type { OllamaClient, VerifiedFact } from "../agent/OllamaClient";
import type { ScraperService } from "../agent/Scraper";
import type { SwarmClient } from "../network/SwarmClient";

/**
 * THE IDLE TIER — AUTONOMOUS FORAGER.
 *
 * "A node must never be idle" is only meaningful if there is always something
 * worth doing, and on a synced node the answer is always the same question: the
 * mirror is a snapshot, so what in it has quietly gone out of date?
 *
 * A PASS IS FOUR STAGES, AND THE STAGES ARE THE POINT:
 *
 *     acquire -> extract -> persist -> feed
 *
 *   acquire — get the evidence. Scrapes the page, UNLESS the target already
 *             carries its text on disk (an unverified `raw_lore` row), in which
 *             case this stage is free and the whole pass costs no bandwidth.
 *   extract — run it through the local model and get one scored fact back.
 *   persist — write the fact locally: `verified_knowledge`, a `brain_chunks` row
 *             attached to the place, and the staleness cursor.
 *   feed    — push the discovery upstream to quarantine immediately.
 *
 * Splitting the pass into stages is what makes PREEMPTION honest. The engine
 * hands this module a {@link PreemptionProbe}, and the probe is checked between
 * stages, so a Mothership task arriving mid-pass is honoured at the next stage
 * boundary with a saved cursor rather than by abandoning a half-written row.
 *
 * WHY THE CURSOR IS NOT A RESTART. The session object survives the yield. A
 * pass interrupted after `acquire` resumes at `extract` with the scraped text
 * already in hand; it does not re-fetch the page. The only stage ever redone is
 * one whose work was thrown away — an in-flight scrape, which Chromium cannot
 * cancel mid-navigation.
 *
 * WHY EVERY DISCOVERY IS FED UPSTREAM. A node that learns something and keeps
 * it to itself has not contributed to the fleet it is part of. `feed` runs for
 * every pass, including ones whose confidence fell below the gate — a
 * below-gate fact is exactly what quarantine is for.
 */

/** Facts below this never reach `verified_knowledge` locally. */
const CONFIDENCE_THRESHOLD = 0.7;
/** Hard ceiling on one page load before the target is left for a later pass. */
const SCRAPE_TIMEOUT_MS = 90_000;
/** Candidates examined per pass. A ceiling on choices, not work promised. */
const TARGET_BATCH_LIMIT = 9;
/** A place checked this recently is not worth a scrape slot. */
const RECENTLY_VERIFIED_MS = 6 * 60 * 60_000;
/** How long a target that just failed is left alone. Grows with each failure. */
const FAILURE_BACKOFF_MS = [0, 5 * 60_000, 30 * 60_000, 6 * 60 * 60_000];
/** Seed sources used only when the brain has nothing to forage yet. */
const SEED_URLS: readonly string[] = [
  "https://parks.desi.qld.gov.au/parks/lamington",
  "https://parks.desi.qld.gov.au/parks/blackdown-tabletop",
  "https://parks.desi.qld.gov.au/parks/conondale",
  "https://www.patrol4x4.com/forums/",
];

/** The four stages of a pass, in order. See the header. */
type ForageStage = "acquire" | "extract" | "persist" | "feed";

/** The stage order, so a resumed session is validated against the real thing. */
const STAGES: readonly ForageStage[] = ["acquire", "extract", "persist", "feed"];

/**
 * THE PAUSE CONTRACT WITH THE ENGINE.
 *
 * Deliberately three methods rather than a boolean. `shouldYield` is for the
 * checkpoints between stages; `waitForInterrupt` is for abandoning a long await
 * the node is not going to need anyway; `waitForResume` is for parking between
 * passes, so an idle node sleeps on the priority queue instead of hammering the
 * database for work it is not allowed to start.
 */
export interface PreemptionProbe {
  /** True the moment the Mothership hands this node a task. */
  shouldYield(): boolean;
  /** Resolves when preemption is first requested; never rejects. */
  waitForInterrupt(): Promise<void>;
  /** Resolves when the priority queue has drained and foraging may continue. */
  waitForResume(): Promise<void>;
}

/** What the engine hands the forager so it can reach the outside world. */
export interface ForagerDeps {
  scraper: ScraperService;
  ollama: OllamaClient;
  swarm: SwarmClient;
}

/** The outcome of exactly one pass. */
export interface ForageOutcome {
  status: "learned" | "preempted" | "empty" | "skipped" | "failed";
  message: string;
  target?: ForageTargetRow;
  /** True when the discovery reached the Mothership. */
  fed: boolean;
}

/** A pass in progress. Survives a yield, which is the whole point. */
interface ForageSession {
  target: ForageTargetRow;
  /** The next stage to run, so a resumed pass picks up where it stopped. */
  stage: ForageStage;
  text: string | null;
  loreId: number | null;
  fact: VerifiedFact | null;
  knowledgeId: number | null;
  promoted: boolean;
}

export class AutonomousForager {
  /** The pass currently in flight, or null. Survives preemption by design. */
  private session: ForageSession | null = null;
  /** Target key -> consecutive failure count, and when it may be retried. */
  private readonly backoffCount = new Map<string, number>();
  private readonly backoffUntil = new Map<string, number>();
  /** Round-robin position over {@link SEED_URLS}. */
  private seedCursor = 0;
  /** Lifetime counters, surfaced in the operator's resume message. */
  private learned = 0;
  private fed = 0;
  private preemptions = 0;

  constructor(private readonly deps: ForagerDeps) {}

  /** Counters for the operator-facing resume message. */
  stats(): { learned: number; fed: number; preemptions: number } {
    return { learned: this.learned, fed: this.fed, preemptions: this.preemptions };
  }

  /**
   * RUNS ONE PASS.
   *
   * Resumes a saved session when there is one, otherwise picks a fresh target.
   * Never throws: an idle-time failure must not be able to take down the
   * priority loop that would otherwise recover from it.
   */
  async runPass(probe: PreemptionProbe): Promise<ForageOutcome> {
    // Satellites are stateless, and a Master whose brain failed to open would
    // otherwise throw straight out of `getDeepBrain()` below.
    if (env.NODE_ROLE !== "master" || !isDeepBrainReady()) {
      return { status: "skipped", message: "no local brain on this node.", fed: false };
    }

    if (probe.shouldYield()) {
      return this.yielded();
    }

    try {
      const session = this.session ?? this.openSession();
      if (!session) {
        return {
          status: "empty",
          message: "local database has no outdated, unverified or incomplete targets.",
          fed: false,
        };
      }

      /*
        THE STAGE LOOP. Exactly one stage per iteration, then an interrupt
        check — so preemption is honoured between stages and `session.stage`
        always names the work that is still owed rather than work half done.
      */
      while (session.stage !== "feed") {
        if (probe.shouldYield()) {
          return this.yielded(session);
        }
        await this.advance(session, probe);
      }

      /*
        `feed` runs OUTSIDE the loop on purpose. An upstream push is the whole
        point of a discovery, so a pass that learned something always finishes
        delivering it — even one interrupted moments earlier. Holding it back
        would mean learning something and then losing it.
      */
      const outcome = await this.feed(session);
      this.session = null;
      this.forget(session.target);
      this.learned += 1;
      if (outcome.fed) this.fed += 1;
      return outcome;
    } catch (error) {
      const session = this.session;

      /*
        PREEMPTION IS NOT A FAILURE. Nothing was wrong with this target — the
        Mothership simply decided the node was needed for something else — so it
        must not burn one of the target's failure credits, and the cursor must
        survive so the pass resumes rather than restarts.
      */
      if (error instanceof PreemptedError) {
        return this.yielded(session ?? undefined);
      }

      // The cursor is dropped deliberately: the stage that threw did NOT
      // complete, so re-entering it would be correct, but the target is backed
      // off so a permanently broken URL cannot monopolise every future pass.
      this.session = null;
      if (session) this.deferFailure(session.target);
      return {
        status: "failed",
        message: `${session ? `${session.target.kind} "${session.target.label}" — ` : ""}${
          error instanceof Error ? error.message : String(error)
        }`,
        ...(session ? { target: session.target } : {}),
        fed: false,
      };
    }
  }

  /** Builds the outcome used whenever a pass hands control back to the engine. */
  private yielded(session?: ForageSession): ForageOutcome {
    this.preemptions += 1;
    const where = session
      ? `${session.target.kind} "${session.target.label}" at stage '${session.stage}'`
      : "between targets";
    console.log(`[Swarm] Idle foraging paused ${where} — Mothership task owns the node.`);
    return {
      status: "preempted",
      message: `paused ${where}.`,
      ...(session ? { target: session.target } : {}),
      fed: false,
    };
  }

  /** Opens a session for the next target, or returns null when there is none. */
  private openSession(): ForageSession | null {
    const target = this.nextTarget();
    if (!target) return null;
    this.session = {
      target,
      stage: "acquire",
      text: null,
      // An unverified-lore target already HAS its row id; anything else needs a
      // fresh `raw_lore` row written during `acquire`.
      loreId: target.lore_id,
      fact: null,
      knowledgeId: null,
      promoted: false,
    };
    return this.session;
  }

  /**
   * THE CHOICE, in priority order:
   *
   *   1. whatever `selectForageTargets` reports as most overdue;
   *   2. a seed source, but only once the brain's own backlog is clear.
   *
   * Resuming is handled before this point — `runPass` only calls it when there
   * is no saved session, so a resumed pass can never be talked out of its
   * cursor by a newer, more interesting target.
   */
  private nextTarget(): ForageTargetRow | null {
    const now = Date.now();
    for (const candidate of selectForageTargets(TARGET_BATCH_LIMIT)) {
      const key = targetKey(candidate);
      // A target still cooling off after a failure is skipped, not re-attempted.
      if ((this.backoffUntil.get(key) ?? 0) > now) continue;
      // A place checked in the last few hours does not need re-reading. Without
      // this, a fresh bundle of 50 places would eat 50 consecutive passes
      // re-reading pages that were correct when they arrived.
      if (candidate.kind !== "unverified_lore" && recentlyVerified(candidate, now)) continue;
      return candidate;
    }
    return this.nextSeed();
  }

  /**
   * THE COLD-START PATH. A brand-new node has an empty mirror, so the database
   * genuinely has nothing to offer and "never idle" would mean nothing at all.
   * Seeds fill that gap until the first bundle lands — and are skipped entirely
   * afterwards, because once the mirror is populated the mirror is the better
   * question to be asking.
   */
  private nextSeed(): ForageTargetRow | null {
    const scraped = new Set(selectScrapedSourceUrls());
    const pending = SEED_URLS.filter((url) => !scraped.has(url));
    if (pending.length === 0) return null;
    const url = pending[this.seedCursor % pending.length];
    this.seedCursor += 1;
    return {
      kind: "incomplete_place",
      url,
      label: new URL(url).hostname,
      place_id: null,
      lore_id: null,
      last_verified: null,
      raw_text: null,
    };
  }

  /** Runs exactly one stage, then moves the cursor to the next one. */
  private async advance(session: ForageSession, probe: PreemptionProbe): Promise<void> {
    const stage = session.stage;
    switch (stage) {
      case "acquire":
        await this.acquire(session, probe);
        break;
      case "extract":
        await this.extract(session);
        break;
      case "persist":
        this.persist(session);
        break;
      case "feed":
        break;
    }
    session.stage = STAGES[STAGES.indexOf(stage) + 1] ?? "feed";
  }

  /**
   * STAGE 1 — ACQUIRE THE EVIDENCE.
   *
   * Two paths. A target that already carries its text (`unverified_lore`) skips
   * the network entirely: the node owns those bytes already, and re-fetching
   * the page would spend a round-trip to learn nothing new. Everything else
   * gets one headless page load, written to `raw_lore` immediately so a crash
   * later in the pass still leaves the evidence on disk.
   *
   * THE INTERRUPT RACE. A Playwright navigation cannot be cancelled — the only
   * way out is to abandon the await and let the page finish on its own. Racing
   * the scrape against the interrupt signal is what makes "instant preemption"
   * true rather than aspirational: a priority task no longer waits out a 30s
   * navigation it was going to interrupt anyway. The cost is honest and stated
   * here — that stage's work is discarded and re-run on resume.
   */
  private async acquire(session: ForageSession, probe: PreemptionProbe): Promise<void> {
    const { target } = session;

    if (target.raw_text && target.raw_text.trim()) {
      session.text = target.raw_text;
      return;
    }
    if (!target.url) {
      throw new Error(`target "${target.label}" has neither a source URL nor stored text`);
    }

    const scrape = withTimeout(
      this.deps.scraper.scrape(target.url).then((result) => result.text),
      SCRAPE_TIMEOUT_MS,
      `scrape of ${target.url}`,
    );
    // The abandoned load keeps running in Chromium after we stop awaiting it,
    // so its rejection must be swallowed or it surfaces as an unhandled
    // rejection and takes the process down on Node's default policy.
    scrape.catch(() => undefined);

    const interrupted = await Promise.race([
      scrape,
      probe.waitForInterrupt().then(() => null),
    ]);
    if (interrupted === null) {
      throw new PreemptedError(`scrape of ${target.url}`);
    }

    session.text = interrupted;
    if (!session.loreId) {
      session.loreId = insertRawLore("forage", interrupted, target.url);
    }
  }

  /**
   * STAGE 2 — EXTRACT ONE SCORED FACT.
   *
   * A null result is a normal outcome, not an error: the model was unreachable
   * or returned something unparseable. The evidence stays in `raw_lore` and the
   * row keeps its `unverified` status, so the very next pass retries it for
   * free.
   */
  private async extract(session: ForageSession): Promise<void> {
    session.fact = await this.deps.ollama.extractFacts(session.text ?? "");
  }

  /**
   * STAGE 3 — PERSIST LOCALLY. Synchronous, so a preempt can never tear it.
   *
   * THE CURSOR IS ONLY MOVED ON SUCCESS, and this is the single most important
   * line in the file. A place whose scrape 404s, times out, or fails extraction
   * must keep its old `last_verified`, or the node silently retires a broken
   * URL and never looks at it again — a placeholder that can never be filled.
   */
  private persist(session: ForageSession): void {
    const { target, fact } = session;

    // No usable fact: the evidence is still kept, and the row stays eligible.
    if (!fact) {
      if (session.loreId) setRawLoreStatus(session.loreId, "unverified");
      console.log(`[Swarm] No fact extracted from "${target.label}" — evidence kept for retry.`);
      return;
    }

    if (fact.confidence_score > CONFIDENCE_THRESHOLD) {
      session.knowledgeId = insertVerifiedKnowledge(fact);
      session.promoted = true;
      if (session.loreId) setRawLoreStatus(session.loreId, "extracted");
      console.log(
        `[Swarm] Learned [${fact.category}] from "${target.label}" ` +
          `(confidence ${fact.confidence_score.toFixed(2)}): ${fact.fact_summary}`,
      );
    } else {
      if (session.loreId) setRawLoreStatus(session.loreId, "unverified");
      console.log(
        `[Swarm] Below the confidence gate for "${target.label}" ` +
          `(${fact.confidence_score.toFixed(2)} ≤ ${CONFIDENCE_THRESHOLD}) — filing to quarantine only.`,
      );
    }

    /*
      THE INCOMPLETE GAP. A place with no prose gains prose, and the fact is
      attached to THAT place rather than floating free in `verified_knowledge`
      with no way to find it again.

      ONLY for an incomplete place. A stale place already HAS a description, so
      writing another chunk on every re-verification would duplicate a fact the
      mirror already holds, and re-verification happens forever — the growth
      would be unbounded and entirely useless. `selectForageTargets` promotes a
      place that is both stale and incomplete to the `incomplete_place` kind, so
      the two cases never overlap here.
    */
    if (target.place_id && target.kind === "incomplete_place") {
      insertBrainChunk({
        placeId: target.place_id,
        category: fact.category,
        text: fact.fact_summary,
        sourceUrl: target.url,
        confidence: fact.confidence_score,
      });
    }
    // Stamped for every place target, and only here: reaching this line means
    // the evidence was actually in hand. See the header on why a failure must
    // never advance this cursor.
    if (target.place_id) {
      markPlaceVerified(target.place_id);
    }
  }

  /**
   * STAGE 4 — FEED THE DISCOVERY UPSTREAM.
   *
   * Runs for EVERY pass that produced a fact, including ones that failed the
   * confidence gate locally — an unverified discovery is precisely what
   * quarantine exists for, and suppressing it would throw away the evidence the
   * cloud is best placed to judge.
   *
   * WHEN THE ROW IS MARKED SYNCED. Only after the Mothership has actually
   * accepted it. The 10-minute trickle in SyncManager drains the same
   * `synced = 0` backlog, so marking on acceptance is what stops the fleet
   * receiving every foraging discovery a second time ten minutes later.
   */
  private async feed(session: ForageSession): Promise<ForageOutcome> {
    const { target, fact } = session;
    if (!fact) {
      return {
        status: "learned",
        message: `no fact extracted from "${target.label}" — nothing to file upstream.`,
        target,
        fed: false,
      };
    }

    const fed = await this.deps.swarm.pushForageDiscovery({
      nodeCode: currentNodeIdentity()?.code ?? env.NODE_NAME,
      discoveredAt: new Date().toISOString(),
      targetKind: target.kind,
      targetLabel: target.label,
      sourceUrl: target.url,
      placeId: target.place_id,
      loreId: session.loreId,
      category: fact.category,
      factSummary: fact.fact_summary,
      confidence: fact.confidence_score,
      coordinates: fact.coordinates,
      promoted: session.promoted,
    });

    if (fed && session.knowledgeId !== null) {
      markKnowledgeSynced([session.knowledgeId]);
    }

    /*
      STOPPING THE SAME EVIDENCE BEING FILED TWICE. An unverified-lore target is
      selected by exactly the status `persist` just left behind, so without this
      line the very next pass would re-extract the same text and push the same
      fact upstream again — forever, on a loop the operator never started.
      `quarantined` is a terminal state meaning "filed for review"; `extracted`
      already means the same thing for a promoted fact.
    */
    if (fed && target.kind === "unverified_lore" && session.loreId !== null) {
      setRawLoreStatus(session.loreId, "quarantined");
    }

    return {
      status: "learned",
      message: fed
        ? `${target.kind} "${target.label}" → [${fact.category}] ${fact.fact_summary}`
        : `${target.kind} "${target.label}" learned locally but NOT fed upstream — will not be retried.`,
      target,
      fed,
    };
  }

  /**
   * Backs a failed target off, with the delay growing per consecutive failure.
   *
   * A 404 or a timeout is usually permanent, and a target that keeps failing
   * would otherwise be re-picked by every single pass and starve everything
   * behind it. The counter is cleared by any success — see {@link forget}.
   */
  private deferFailure(target: ForageTargetRow): void {
    const key = targetKey(target);
    const failures = (this.backoffCount.get(key) ?? 0) + 1;
    this.backoffCount.set(key, failures);
    const delay =
      FAILURE_BACKOFF_MS[Math.min(failures, FAILURE_BACKOFF_MS.length - 1)] ??
      FAILURE_BACKOFF_MS[FAILURE_BACKOFF_MS.length - 1];
    this.backoffUntil.set(key, Date.now() + delay);
    console.log(
      `[Swarm] Forage target "${target.label}" backing off for ` +
        `${Math.round(delay / 60_000)} min after failure #${failures}.`,
    );
  }

  /** Clears the failure history for a target that worked. */
  private forget(target: ForageTargetRow): void {
    const key = targetKey(target);
    this.backoffCount.delete(key);
    this.backoffUntil.delete(key);
  }
}

/**
 * Raised when a stage was abandoned because the Mothership claimed the node.
 *
 * A dedicated type rather than a string comparison, because this one specific
 * failure must NOT count against the target: nothing was wrong with the target,
 * the node was simply doing something more important. It is the reason
 * `runPass` re-raises instead of backing the target off.
 */
export class PreemptedError extends Error {
  constructor(stage: string) {
    super(`preempted during ${stage}`);
    this.name = "PreemptedError";
  }
}

/** Stable identity for a target across passes, used for backoff bookkeeping. */
function targetKey(target: ForageTargetRow): string {
  return `${target.kind}:${target.place_id ?? target.lore_id ?? target.url ?? target.label}`;
}

/** True when this place was checked inside the recency window. */
function recentlyVerified(target: ForageTargetRow, now: number): boolean {
  if (!target.last_verified) return false;
  const at = Date.parse(target.last_verified);
  if (!Number.isFinite(at)) return false; // unparseable = treat as never checked
  return now - at < RECENTLY_VERIFIED_MS;
}

/** Rejects with a clear message if `promise` has not settled in `ms`. */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
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

