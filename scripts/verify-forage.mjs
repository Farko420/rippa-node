/**
 * AUTONOMOUS FORAGING & PREEMPTIBLE TASK ENGINE — verification.
 *
 * Exercises the SHIPPED compiled output (dist/). Four promises:
 *   1. THE INTERRUPT — a PRIORITY task aborts the in-flight IDLE_FORAGE pass.
 *   2. THE FORAGER — Mothership `forage_target` first, local queue fallback.
 *   3. THE LEARNING LOOP — `/api/swarm/learn` first, downgrade remembered.
 *   4. THERMAL PACING — IDLE_THROTTLE 10–30s clamp.
 *
 * Not part of the shipped app. See verify-harness.mjs for shared helpers.
 */
import { pathToFileURL } from "node:url";
import path from "node:path";
import { ROOT, check, results } from "./verify-harness.mjs";

/** Imports a compiled module by path. Windows ESM needs a file:// URL. */
const load = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);

// --- 1. THE INTERRUPT -------------------------------------------------------
const { TaskEngine, resolveIdleThrottleMs } = await load("dist/services/taskEngine.js");
const { AutonomousForager, PreemptedError } = await load("dist/services/autonomousForager.js");

check("PreemptedError carries the interrupted stage", new PreemptedError("scrape").message.includes("scrape"));

// A forager pass parked in a long scrape must abort the instant a priority
// task lands — the engine fires its controller, the scrape's signal fires,
// and the pass yields with its cursor intact.
{
  let scrapeSignal = null;
  let scrapeAborted = false;
  const fakeSwarm = {
    setTaskDispatchHandler: () => {},
    setStatus: () => {},
    claimTask: async (task) => ({ task, acknowledged: true }),
    releaseTask: async () => {},
    fetchTasks: async () => [],
    submitProfile: async () => true,
    pushForageDiscovery: async () => true,
    requestForageTarget: async () => null,
  };
  const fakeScraper = {
    scrape: (url, signal) =>
      new Promise((resolve, reject) => {
        scrapeSignal = signal ?? null;
        if (signal) {
          if (signal.aborted) {
            scrapeAborted = true;
            reject(signal.reason instanceof Error ? signal.reason : new Error("Aborted"));
            return;
          }
          signal.addEventListener(
            "abort",
            () => {
              scrapeAborted = true;
              reject(signal.reason instanceof Error ? signal.reason : new Error("Aborted"));
            },
            { once: true },
          );
        }
      }),
  };
  const forager = new AutonomousForager({
    scraper: fakeScraper,
    ollama: { extractFacts: async () => null },
    swarm: fakeSwarm,
  });
  forager.forceEligibleForTests = true;
  forager.testHooks = {
    selectActiveCrawlCooldowns: () => [],
    selectForageTargets: () => [],
    selectScrapedSourceUrls: () => [],
    insertRawLore: () => 1,
    setRawLoreStatus: () => {},
    insertVerifiedKnowledge: () => 1,
    insertBrainChunk: () => 1,
    markKnowledgeSynced: () => {},
    markPlaceVerified: () => {},
    recordCrawlCooldown: () => {},
  };
  const handled = [];
  const engine = new TaskEngine({
    swarm: fakeSwarm,
    handlePriorityTask: async (task) => {
      handled.push(task.id);
      return { status: "success", detail: "priority first" };
    },
    forager,
    priorityPollMs: 3_600_000,
    idleGapMs: 3_600_000,
  });
  engine.start();
  await new Promise((r) => setTimeout(r, 400));
  check("the idle pass arms an AbortSignal for its scrape", scrapeSignal instanceof AbortSignal);
  engine.dispatch([{ id: "urgent-1", type: "chat", status: "pending" }]);
  await new Promise((r) => setTimeout(r, 800));
  check("the in-flight scrape was aborted mid-flight", scrapeAborted === true);
  check("the priority task ran while the forage yielded", handled.includes("urgent-1"));
  const stats = forager.stats();
  check("the preemption was counted, not swallowed", stats.preemptions >= 1, String(stats.preemptions));
  await engine.stop();
}



// --- 2. THE FORAGER: remote target first, local fallback --------------------
{
  const seen = [];
  const fakeSwarm = {
    pushForageDiscovery: async (payload) => {
      seen.push(payload);
      return true;
    },
    requestForageTarget: async () => ({
      label: "Lamington National Park",
      url: "https://example.test/lamington",
      placeId: "place-1",
      confidenceScore: 0.31,
      lastVerified: null,
      kind: "stale_place",
      reason: "confidence 0.31",
    }),
  };
  const forager = new AutonomousForager({
    scraper: {
      scrape: async () => ({ url: "x", title: "Lamington", text: "Lamington track open." }),
    },
    ollama: {
      extractFacts: async () => ({
        category: "description",
        fact_summary: "Beauty, the track is open and the 457 metre climb is a ripper.",
        confidence_score: 0.9,
        coordinates: null,
      }),
    },
    swarm: fakeSwarm,
  });
  forager.forceEligibleForTests = true;
  forager.testHooks = {
    selectActiveCrawlCooldowns: () => [],
    selectForageTargets: () => [],
    selectScrapedSourceUrls: () => [],
    insertRawLore: () => 1,
    setRawLoreStatus: () => {},
    insertVerifiedKnowledge: () => 1,
    insertBrainChunk: () => 1,
    markKnowledgeSynced: () => {},
    markPlaceVerified: () => {},
    recordCrawlCooldown: () => {},
  };
  const probe = {
    shouldYield: () => false,
    waitForInterrupt: () => new Promise(() => {}),
    waitForResume: () => Promise.resolve(),
  };
  const outcome = await forager.runPass(probe);
  check(
    "a Mothership forage_target is preferred over the local queue",
    outcome.target?.label === "Lamington National Park",
    outcome.target?.label ?? outcome.status,
  );
  check("the learned fact is fed upstream (learning loop)", outcome.fed === true);
  check(
    "the feed carries the discovery kind for learn routing",
    seen.length === 1 && seen[0].targetKind === "incomplete_place",
    JSON.stringify(seen[0]?.targetKind ?? null),
  );
}

// --- 3. THE LEARNING LOOP: /api/swarm/learn first, downgrade remembered ----
{
  const posted = [];
  const { SwarmClient, SWARM_LEARN_PATH } = await load("dist/network/SwarmClient.js");
  check("the learn route is /api/swarm/learn", SWARM_LEARN_PATH === "/api/swarm/learn", SWARM_LEARN_PATH);
  const client = Object.create(SwarmClient.prototype);
  client.quarantineUnsupported = false;
  client.learnUnsupported = false;
  client.client = {
    post: async (url) => {
      posted.push(url);
      if (url === "/api/swarm/learn") {
        const error = new Error("Not Found");
        error.isAxiosError = true;
        error.response = { status: 404 };
        throw error;
      }
      return { data: {} };
    },
  };
  const fed = await client.pushForageDiscovery({
    nodeCode: "TEST",
    targetKind: "stale_place",
    targetLabel: "Test Peak",
    fact: "Test fact.",
    confidence: 0.9,
    discoveredAt: new Date().toISOString(),
  });
  check("a missing learn route falls through to quarantine", fed === true && posted[0] === "/api/swarm/learn", posted.join(","));
  check("the learn downgrade is remembered (no re-probe)", client.learnUnsupported === true);
}

// --- 4. THERMAL PACING: IDLE_THROTTLE 10-30s clamp ---------------------------
check("unset IDLE_THROTTLE means engine default", resolveIdleThrottleMs({}) === undefined);
check("seconds are honoured (20 -> 20s)", resolveIdleThrottleMs({ IDLE_THROTTLE: "20" }) === 20_000);
check("milliseconds pass through (15000 -> 15s)", resolveIdleThrottleMs({ IDLE_THROTTLE: "15000" }) === 15_000);
check("below the floor clamps to 10s", resolveIdleThrottleMs({ IDLE_THROTTLE: "2" }) === 10_000);
check("above the ceiling clamps to 30s", resolveIdleThrottleMs({ IDLE_THROTTLE: "300" }) === 30_000);
check("garbage means engine default", resolveIdleThrottleMs({ IDLE_THROTTLE: "banana" }) === undefined);
{
  const engine = new TaskEngine({
    swarm: {
      setTaskDispatchHandler: () => {},
      setStatus: () => {},
      claimTask: async (t) => ({ task: t, acknowledged: true }),
      fetchTasks: async () => [],
      submitProfile: async () => true,
    },
    handlePriorityTask: async () => ({ status: "success", detail: "ok" }),
    forager: { stats: () => ({ learned: 0, fed: 0, preemptions: 0 }) },
    priorityPollMs: 3_600_000,
    idleGapMs: 12_000,
  });
  check(
    "the engine surfaces its PRIORITY vs IDLE_FORAGE pacing",
    engine.describeTiers().idleThrottleMs === 12_000 && engine.describeTiers().tier === "idle",
    JSON.stringify(engine.describeTiers()),
  );
  await engine.stop();
}

const failed = results.filter((r) => !r.pass).length;
console.log("");
console.log(failed === 0 ? `All ${results.length} forage checks passed.` : `${failed} of ${results.length} FAILED.`);
process.exit(failed === 0 ? 0 : 1);

