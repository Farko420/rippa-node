import { env } from "../config";
import { currentNodeIdentity } from "../config/nodeAuth";
import {
  insertBrainChunk,
  insertRawLore,
  insertVerifiedKnowledge,
  isDeepBrainReady,
  markKnowledgeSynced,
  markPlaceVerified,
  recordCrawlCooldown,
  selectActiveCrawlCooldowns,
  selectForageTargets,
  selectScrapedSourceUrls,
  setRawLoreStatus,
  type ForageTargetRow,
} from "../db/database";
import type { OllamaClient, VerifiedFact } from "../agent/OllamaClient";
import { countPlaceCandidates, type ScraperService } from "../agent/Scraper";
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
/**
 * HOW LONG A ZERO-YIELD URL STAYS OUT OF THE QUEUE.
 *
 * A page that returns HTTP 200, extracts cleanly, and yields ZERO place
 * candidates was the reported spin: `last_verified` never advanced (no fact to
 * stamp it for), so `selectForageTargets` handed the SAME URL back on every
 * pass and the scraper re-crawled it forever while every other target starved.
 * Seven days says "this was read recently and had nothing — believe it", and
 * it is PERSISTED (see `crawl_cooldowns` in db/database.ts) so a restart at
 * 3am does not resurrect the hammering.
 */
const ZERO_YIELD_COOLDOWN_MS = 7 * 24 * 60 * 60_000;
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
 *
 * `signal` is the live AbortController signal for the CURRENT pass. The stage
 * checkpoints consult `shouldYield()`; the work INSIDE a stage (the Playwright
 * navigation, the Ollama HTTP body) races `signal` — so a PRIORITY task
 * arriving mid-scrape or mid-inference aborts the in-flight I/O at once
 * instead of waiting for the next boundary. The signal is optional so older
 * probes (and the verification harness stubs) keep working: without it the
 * forager degrades to pure stage-boundary preemption.
 */
export interface PreemptionProbe {
  /** True the moment the Mothership hands this node a task. */
  shouldYield(): boolean;
  /** Resolves when preemption is first requested; never rejects. */
  waitForInterrupt(): Promise<void>;
  /** Resolves when the priority queue has drained and foraging may continue. */
  waitForResume(): Promise<void>;
  /** Live abort signal for the current pass, or undefined when unarmed. */
  signal?: AbortSignal;
}

/** What the engine hands the forager so it can reach the outside world. */
export interface ForagerDeps {
  scraper: ScraperService;
  ollama: OllamaClient;
  /**
   * The Mothership link. Typed structurally (not as `SwarmClient`) so the
   * idle tier depends on the two methods it actually uses — `pushForageDiscovery`
   * for the learning loop, `requestForageTarget` for cloud-directed intake —
   * and the verification harness can stub them without a full client.
   */
  swarm: Pick<SwarmClient, "pushForageDiscovery" | "requestForageTarget">;
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
  /** Place-candidate count of the acquired text — 0 arms the crawl cooldown. */
  candidates: number;
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
  /**
   * TEST SEAM — forces `runPass` past the master/brain gate.
   *
   * Production never sets this: the gate (`NODE_ROLE === "master"` plus a
   * ready Deep Brain) is what stops satellites and brainless nodes foraging.
   * The verification harness sets it so the interrupt + remote-target paths
   * can be exercised without a SQLite brain on disk.
   */
  forceEligibleForTests = false;
  /**
   * TEST SEAMS — persistence callbacks the harness injects.
   *
   * Production leaves every one `undefined` and the stages talk to SQLite
   * directly. The harness supplies no-op callbacks so `persist` / `feed`
   * bookkeeping (cooldowns, `markPlaceVerified`, `insertBrainChunk`) can run
   * without a database file. Each is optional individually: set the ones the
   * exercised path touches, leave the rest on the real implementation.
   */
  testHooks: {
    recordCrawlCooldown?: (url: string, ms: number, reason: string) => void;
    selectActiveCrawlCooldowns?: () => string[];
    selectForageTargets?: (limit: number) => ForageTargetRow[];
    selectScrapedSourceUrls?: () => string[];
    insertRawLore?: (kind: string, text: string, url: string | null) => number;
    setRawLoreStatus?: (id: number, status: string) => void;
    insertVerifiedKnowledge?: (fact: unknown, sourceUrl: string | null) => number;
    insertBrainChunk?: (chunk: unknown) => number;
    markKnowledgeSynced?: (ids: number[]) => void;
    markPlaceVerified?: (placeId: string | null, confidence?: number) => void;
  } = {};

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
   *
   * `forcedTarget` pins the pass to a Mothership-directed target (the
   * heartbeat's `forage_target`, wrapped as a FORAGE task). When present it
   * wins over the usual Mothership-first/local-fallback choice — the cloud
   * told this node exactly what to verify, so asking the cloud again would
   * only risk being handed something else.
   */
  async runPass(probe: PreemptionProbe, forcedTarget?: ForageTargetRow): Promise<ForageOutcome> {
    // Satellites are stateless, and a Master whose brain failed to open would
    // otherwise throw straight out of `getDeepBrain()` below.
    if (!this.forceEligibleForTests && (env.NODE_ROLE !== "master" || !isDeepBrainReady())) {
      return { status: "skipped", message: "no local brain on this node.", fed: false };
    }

    if (probe.shouldYield()) {
      return this.yielded();
    }

    try {
      const session = this.session ?? (await this.openSession(probe, forcedTarget));
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
  private async openSession(probe: PreemptionProbe, forcedTarget?: ForageTargetRow): Promise<ForageSession | null> {
    const target = forcedTarget ?? (await this.nextTarget(probe));
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
      candidates: 0,
    };
    return this.session;
  }

  /**
   * THE CHOICE, in priority order:
   *
   *   1. a `forage_target` from the Mothership — a map location with a low
   *      `confidence_score`, or a place unverified for months — when the cloud
   *      has a forage queue to answer from;
   *   2. whatever `selectForageTargets` reports as most overdue locally;
   *   3. a seed source, but only once the brain's own backlog is clear.
   *
   * The Mothership is asked FIRST so cloud-directed verification wins over
   * local staleness: the fleet learns what the map needs, not just what this
   * mirror noticed. An older cloud (or an unreachable one) answers null and
   * the node forages locally — identical behaviour to before, no log spam.
   *
   * Resuming is handled before this point — `runPass` only calls it when there
   * is no saved session, so a resumed pass can never be talked out of its
   * cursor by a newer, more interesting target.
   */
  private async nextTarget(probe: PreemptionProbe): Promise<ForageTargetRow | null> {
    const remote = await this.nextRemoteTarget(probe);
    if (remote) return remote;
    const now = Date.now();
    // Read fresh on every pick, so a cooldown armed mid-pass takes effect on
    // the NEXT selection — this is the explicit "queue advances past the
    // zero-yield URL" step, not a side effect of anything else.
    const cooled = this.cooledDownUrls();
    for (const candidate of this.localTargets()) {
      const key = targetKey(candidate);
      // A URL still under its zero-yield cooldown is skipped outright — it was
      // read, it yielded nothing, and re-reading it sooner adds no knowledge.
      if (candidate.url && cooled.has(candidate.url)) continue;
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
   * THE MOTHERSHIP'S PICK — a cloud-directed `forage_target`.
   *
   * Returns null (forage locally) when the cloud has no forage queue, has
   * nothing queued right now, or cannot be reached — all three are normal on
   * an idle node and none is worth a log line. A yielded probe also returns
   * null: a PRIORITY task arrived while the request was in flight, and the
   * pass must hand control back rather than start work it cannot finish.
   *
   * Cooldowns and backoff are honoured for remote targets too: a URL the node
   * already knows yielded nothing is not re-scraped just because the cloud
   * suggested it again.
   */
  private async nextRemoteTarget(probe: PreemptionProbe): Promise<ForageTargetRow | null> {
    let remote: import("../network/SwarmClient").ForageTarget | null = null;
    try {
      remote = await this.deps.swarm.requestForageTarget(probe.signal);
    } catch {
      return null;
    }
    if (!remote || probe.shouldYield() || probe.signal?.aborted) return null;
    const now = Date.now();
    if (remote.url) {
      if (this.cooledDownUrls().has(remote.url)) return null;
      if ((this.backoffUntil.get(`remote:${remote.url}`) ?? 0) > now) return null;
    }
    if (remote.lastVerified && !remote.url && recentlyVerified(remote as never, now)) return null;
    console.log(
      `[Swarm] Foraging Mothership target "${remote.label}" — ` +
        "fresh trail conditions, access rules and history.",
    );
    return {
      kind: "incomplete_place",
      url: remote.url,
      label: remote.label,
      place_id: remote.placeId ?? null,
      lore_id: null,
      last_verified: remote.lastVerified ?? null,
      raw_text: null,
    };
  }

  /**
   * LOCAL QUEUE — the mirror's own backlog. Reads through the test seam when
   * the harness injects one, so verification runs without a SQLite file.
   */
  private localTargets(): ForageTargetRow[] {
    try {
      const hook = this.testHooks.selectForageTargets;
      if (hook) return hook(TARGET_BATCH_LIMIT);
      return selectForageTargets(TARGET_BATCH_LIMIT);
    } catch {
      return [];
    }
  }

  /**
   * THE QUEUE'S "DO NOT RE-READ" SET — every URL currently under a zero-yield
   * cooldown. Guarded because a database hiccup must never take down the idle
   * loop: an empty set merely forgets the cooldown for one pass (recoverable),
   * a crash here would be the exact class of bug this work is fixing.
   */
  private cooledDownUrls(): Set<string> {
    try {
      const hook = this.testHooks.selectActiveCrawlCooldowns;
      if (hook) return new Set(hook());
      return new Set(selectActiveCrawlCooldowns());
    } catch {
      return new Set();
    }
  }

  /**
   * THE COLD-START PATH. A brand-new node has an empty mirror, so the database
   * genuinely has nothing to offer and "never idle" would mean nothing at all.
   * Seeds fill that gap until the first bundle lands — and are skipped entirely
   * afterwards, because once the mirror is populated the mirror is the better
   * question to be asking.
   */
  private nextSeed(): ForageTargetRow | null {
    let scraped: Set<string>;
    try {
      const hook = this.testHooks.selectScrapedSourceUrls;
      scraped = new Set(hook ? hook() : selectScrapedSourceUrls());
    } catch {
      scraped = new Set();
    }
    const cooled = this.cooledDownUrls();
    // Seeds obey the same cooldown as every other URL — a seed that yielded
    // nothing is no more worth a second visit than a mirrored place is.
    const pending = SEED_URLS.filter((url) => !scraped.has(url) && !cooled.has(url));
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
        await this.extract(session, probe);
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
   * THE INTERRUPT RACE. Playwright navigation honours the engine's
   * AbortController directly (see ScraperService.scrape), so a PRIORITY task
   * arriving mid-page-load cancels the navigation at once instead of waiting
   * out a 30s load it was going to interrupt anyway. The race against the
   * interrupt signal below stays as the second tripwire: an abort that lands
   * between stages — or on a path with no signal — still yields at once.
   */
  private async acquire(session: ForageSession, probe: PreemptionProbe): Promise<void> {
    const { target } = session;

    if (probe.signal?.aborted) {
      throw new PreemptedError("scrape abandoned before it began");
    }
    if (target.raw_text && target.raw_text.trim()) {
      session.text = target.raw_text;
      // Same yield accounting as the network path — a zero-candidate text is
      // pointless to re-select whether or not it cost a crawl to obtain.
      this.noteYield(session);
      return;
    }
    if (!target.url) {
      throw new Error(`target "${target.label}" has neither a source URL nor stored text`);
    }

    const scrape = withTimeout(
      this.deps.scraper.scrape(target.url, probe.signal).then((result) => result.text),
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
    if (interrupted === null || probe.signal?.aborted) {
      // THE INTERRUPT: the engine fired its AbortController, which already
      // cancelled the Playwright navigation / fetch inside `scrape()`. The
      // deck is clear — throw so the pass yields with its cursor intact.
      throw new PreemptedError(`scrape of ${target.url}`);
    }

    session.text = interrupted;
    if (!session.loreId) {
      session.loreId = this.hookableInsertRawLore("forage", interrupted, target.url);
    }
    this.noteYield(session);
  }

  /**
   * RECORDS WHAT THE ACQUIRED TEXT YIELDED — and arms the zero-yield cooldown.
   *
   * A successful read (HTTP 200 + extractable body) that produced ZERO place
   * candidates is the reported spin case: the page is fine, it simply has
   * nothing the extractor wants, and without this the same URL would be handed
   * back by `selectForageTargets` on the next pass, and the one after that.
   *
   * Armed HERE — right after the crawl, before the extract stage runs — rather
   * than in `persist`, so even a thrown model call (which never reaches
   * `persist`) cannot leave the URL in the active queue. This is the cooldown
   * half of the fix; the visited/completed stamping lives in `persist`, where
   * the extraction result is known.
   */
  private noteYield(session: ForageSession): void {
    session.candidates = countPlaceCandidates(session.text ?? "");
    if (session.candidates > 0) return;
    const url = session.target.url;
    if (!url) return;
    const hook = this.testHooks.recordCrawlCooldown;
    if (hook) {
      hook(url, ZERO_YIELD_COOLDOWN_MS, "0 place candidates");
    } else {
      recordCrawlCooldown(url, ZERO_YIELD_COOLDOWN_MS, "0 place candidates");
    }
    console.log(
      `[Swarm] 0 place candidates from "${session.target.label}" — ` +
        `URL marked completed, cooled down for 7 days.`,
    );
  }

  /**
   * STAGE 2 — EXTRACT ONE SCORED FACT.
   *
   * A null result is a normal outcome, not an error: the model was unreachable,
   * returned something unparseable, OR was preempted mid-generation (the
   * engine's AbortController cancels the Ollama HTTP body and `extractFacts`
   * resolves null). The evidence stays in `raw_lore` and the row keeps its
   * `unverified` status, so the very next pass retries it for free.
   */
  private async extract(session: ForageSession, probe: PreemptionProbe): Promise<void> {
    session.fact = await this.deps.ollama.extractFacts(session.text ?? "", probe.signal);
    if (session.fact === null && probe.signal?.aborted) {
      // Preempted mid-inference: the GPU run is already dead. Yield with the
      // scraped text intact so resume continues at `persist`, not `acquire`.
      throw new PreemptedError("inference aborted mid-generation");
    }
  }

  /**
   * STAGE 3 — PERSIST LOCALLY. Synchronous, so a preempt can never tear it.
   *
   * THE CURSOR MOVES WHEN THE CRAWL COMPLETED — INCLUDING A ZERO-YIELD CRAWL.
   * This is a deliberate change from "only when a fact was learned". A page
   * that returns 200 and yields 0 place candidates used to leave
   * `last_verified` untouched, so `selectForageTargets` handed the SAME URL
   * back on every pass: the scraper hammered one page (the reported
   * Bluff-Knoll spin) while every other target starved. The crawl succeeded —
   * recording it as visited is what advances the queue pointer.
   *
   * WHAT IS STILL PROTECTED. Failures — a 404, a timeout, a thrown extraction
   * — never reach this method (they throw in `acquire`/`extract` and are backed
   * off by `deferFailure`), so a genuinely broken URL still keeps its old
   * `last_verified` and is retried later. And nothing is lost by stamping a
   * completed crawl: the evidence stays in `raw_lore` and is re-extracted for
   * free from the stored text, without spending another crawl slot.
   *
   * ZERO-YIELD ROWS ARE TERMINAL (`completed`, not `unverified`): text with no
   * candidates has nothing worth re-extracting, so leaving the row in the
   * retry queue would spin local model calls instead of crawls — the same bug,
   * one layer down. The 7-day URL cooldown itself was already armed in
   * `acquire` (see {@link noteYield}).
   */
  private persist(session: ForageSession): void {
    const { target, fact } = session;
    const zeroYield = session.candidates === 0;
    const hooks = this.testHooks;

    // No usable fact — but extraction COMPLETED, so the crawl succeeded.
    if (!fact) {
      // COMPLETED/VISITED, even though 0 candidates were extracted.
      if (target.place_id) this.hookableMarkPlaceVerified(target.place_id);
      if (session.loreId) this.hookableSetRawLoreStatus(session.loreId, zeroYield ? "completed" : "unverified");
      console.log(
        zeroYield
          ? `[Swarm] 0 place candidates from "${target.label}" — marked completed; URL cools down for 7 days.`
          : `[Swarm] No fact extracted from "${target.label}" — evidence kept for retry${target.place_id ? "; crawl recorded as visited" : ""}.`,
      );
      return;
    }

    if (fact.confidence_score > CONFIDENCE_THRESHOLD) {
      session.knowledgeId = hooks.insertVerifiedKnowledge
        ? hooks.insertVerifiedKnowledge(fact, target.url)
        : insertVerifiedKnowledge(fact);
      session.promoted = true;
      if (session.loreId) this.hookableSetRawLoreStatus(session.loreId, "extracted");
      console.log(
        `[Swarm] Learned [${fact.category}] from "${target.label}" ` +
          `(confidence ${fact.confidence_score.toFixed(2)}): ${fact.fact_summary}`,
      );
    } else {
      if (session.loreId) this.hookableSetRawLoreStatus(session.loreId, "unverified");
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
      const chunk = {
        placeId: target.place_id,
        category: fact.category,
        text: fact.fact_summary,
        sourceUrl: target.url,
        confidence: fact.confidence_score,
      };
      if (hooks.insertBrainChunk) hooks.insertBrainChunk(chunk);
      else insertBrainChunk(chunk);
    }
    // Stamped for every place target, and only here: reaching this line means
    // the evidence was actually in hand. See the header on why a failure must
    // never advance this cursor.
    if (target.place_id) {
      this.hookableMarkPlaceVerified(target.place_id);
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
        message:
          session.candidates === 0
            ? `0 place candidates from "${target.label}" — marked completed, cooling the URL down for 7 days.`
            : `no fact extracted from "${target.label}" — nothing to file upstream.`,
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
      const hook = this.testHooks.markKnowledgeSynced;
      if (hook) hook([session.knowledgeId]);
      else markKnowledgeSynced([session.knowledgeId]);
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
      this.hookableSetRawLoreStatus(session.loreId, "quarantined");
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

  /**
   * Persistence through the test seam when the harness injects one.
   *
   * Three tiny wrappers (not one generic "db" object) so each call site keeps
   * its own signature and production reads exactly as before — the hook check
   * is the only new line on each path.
   */
  private hookableInsertRawLore(kind: string, text: string, url: string | null): number {
    const hook = this.testHooks.insertRawLore;
    if (hook) return hook(kind, text, url);
    return insertRawLore(kind, text, url);
  }

  private hookableSetRawLoreStatus(id: number, status: string): void {
    const hook = this.testHooks.setRawLoreStatus;
    if (hook) {
      hook(id, status);
      return;
    }
    setRawLoreStatus(id, status);
  }

  private hookableMarkPlaceVerified(placeId: string | null, confidence?: number): void {
    const hook = this.testHooks.markPlaceVerified;
    if (hook) {
      hook(placeId, confidence);
      return;
    }
    // Confidence is upstream metadata (fed to /api/swarm/learn); the local
    // stamp is just "visited now". Null place (a seed URL with no mirror row)
    // has nothing to stamp, so skip rather than crash the pass.
    if (!placeId) return;
    markPlaceVerified(placeId);
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

