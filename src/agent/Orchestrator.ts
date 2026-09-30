import { SwarmClient, type SwarmTask } from "../network/SwarmClient";
import { env } from "../config";
import {
  insertRawLore,
  insertVerifiedKnowledge,
  selectScrapedSourceUrls,
  setRawLoreStatus,
} from "../db/database";
import { ScraperService } from "./Scraper";
import { OllamaClient } from "./OllamaClient";
import { OtaUpdater } from "../update/OtaUpdater";
import { APP_VERSION } from "../version";
import { schedule, type ScheduledTask } from "node-cron";
import { clearCurrentProcess, setCurrentProcess } from "../services/heartbeat";

/**
 * AUTONOMOUS AGENT ORCHESTRATOR.
 *
 * Continuous loop: fetch tasks from the Mothership → handle them;
 * if the queue is empty, fall through to discovery mode — autonomous
 * self-education via Playwright (scrape) + Ollama (structured extraction)
 * into the Deep Brain (raw_lore → verified_knowledge).
 *
 * Alongside that loop it owns the OTA self-update task, so a new build pushed
 * to the Mothership is downloaded and applied without human intervention.
 */

const TICK_INTERVAL_MS = 15_000; // how often the agent polls the Mothership
const DISCOVERY_INTERVAL_MS = 5 * 60_000; // throttle autonomous scraping to 1 source / 5 min
const DISCOVERY_RETRY_MS = 60_000; // after a failed scrape, try the next seed in 1 min
const CONFIDENCE_THRESHOLD = 0.7; // facts below this never reach verified_knowledge
const OTA_CHECK_CRON = "0 */60 * * * *"; // background version check every 60 minutes
const OTA_FIRST_CHECK_DELAY_MS = 30_000; // let boot settle before the first check


/**
 * Seed sources for autonomous discovery — curated Queensland Parks pages plus
 * a 4x4 forum. Extended/replaced as the knowledge base grows.
 */
const SEED_URLS: string[] = [
  "https://parks.desi.qld.gov.au/parks/lamington",
  "https://parks.desi.qld.gov.au/parks/blackdown-tabletop",
  "https://parks.desi.qld.gov.au/parks/conondale",
  "https://www.patrol4x4.com/forums/",
];

export class Orchestrator {
  private running = false;
  private loopPromise: Promise<void> | null = null;
  private readonly scraper = new ScraperService();
  private readonly ollama = new OllamaClient();
  private seedCursor = 0;
  private lastDiscoveryAt = 0;
  private seedsExhaustedLogged = false;
  private readonly ota: OtaUpdater;
  private otaTask: ScheduledTask | null = null;
  private otaFirstCheck: NodeJS.Timeout | null = null;

  constructor(private readonly swarm: SwarmClient) {
    this.ota = new OtaUpdater(swarm);
    // A version advertised on the heartbeat reply triggers an immediate
    // update attempt instead of waiting for the next scheduled check.
    this.swarm.setUpdateSignalHandler((info) => this.ota.onUpdateSignal(info));
  }

  /** Starts the background loop (idempotent). Does not block the caller. */
  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.loopPromise = this.runLoop();
    console.log(`[Orchestrator] Autonomous loop started (tick every ${TICK_INTERVAL_MS / 1000}s)`);
    this.startOtaUpdates();
  }

  /** Stops the loop after allowing the in-flight tick to settle. */
  async stop(): Promise<void> {
    this.running = false;
    this.stopOtaUpdates();
    if (this.loopPromise) {
      await this.loopPromise;
      this.loopPromise = null;
    }
    await this.scraper.close();
    console.log("[Orchestrator] Autonomous loop stopped.");
  }

  isRunning(): boolean {
    return this.running;
  }

  /**
   * OTA SELF-UPDATE TASK — periodic version check (idempotent).
   *
   * Runs once shortly after boot so a node that was offline during a release
   * catches up immediately, then hourly. Checks are also triggered on demand
   * by the heartbeat update signal (wired in the constructor).
   */
  private startOtaUpdates(): void {
    if (this.otaTask) {
      return;
    }

    this.otaTask = schedule(
      OTA_CHECK_CRON,
      () => {
        void this.ota.checkForUpdate();
      },
      { name: "ota-version-check" },
    );

    this.otaFirstCheck = setTimeout(() => {
      this.otaFirstCheck = null;
      void this.ota.checkForUpdate();
    }, OTA_FIRST_CHECK_DELAY_MS);

    console.log(`[Orchestrator] OTA self-update task started — ${OTA_CHECK_CRON} (running v${APP_VERSION})`);
  }

  /** Stops the OTA cron and any pending first check. */
  private stopOtaUpdates(): void {
    if (this.otaTask) {
      this.otaTask.stop();
      this.otaTask = null;
    }
    if (this.otaFirstCheck) {
      clearTimeout(this.otaFirstCheck);
      this.otaFirstCheck = null;
    }
  }

  private async runLoop(): Promise<void> {
    while (this.running) {
      try {
        await this.tick();
      } catch (error) {
        console.error("[Orchestrator] Tick failed:", error instanceof Error ? error.message : error);
      }
      await sleep(TICK_INTERVAL_MS);
    }
  }

  private async tick(): Promise<void> {
    const tasks = await this.swarm.fetchTasks();

    if (tasks.length === 0) {
      await this.runDiscoveryMode();
      return;
    }

    console.log(`[Orchestrator] ${tasks.length} task(s) received from the Mothership`);
    for (const task of tasks) {
      if (!this.running) {
        break;
      }
      await this.handleTask(task);
    }
  }

  private async handleTask(task: SwarmTask): Promise<void> {
    this.swarm.setStatus("busy");
    // Mirrored into the heartbeat so the Mothership sees the live task in Task
    // Manager terms, not just a busy/idle flag.
    setCurrentProcess(task.type || task.id || "task");
    try {
      switch (task.type) {
        // TODO: wire real handlers as they are built, e.g.:
        //   case "scrape":   → Playwright headless scrape
        //   case "extract":  → Ollama structured extraction
        //   case "verify":   → confidence scoring → verified_knowledge
        default:
          console.warn(`[Orchestrator] Unhandled task type "${task.type}" (id=${task.id}) — skipping.`);
          break;
      }
    } finally {
      this.swarm.setStatus("idle");
      clearCurrentProcess();
    }
  }

  /**
   * DISCOVERY MODE — autonomous learning when there is no queued work.
   *
   *   1. Round-robin the seed URLs, skipping anything already in `raw_lore`.
   *   2. Scrape the next source headlessly (Playwright) → `raw_lore`.
   *   3. Extract a structured fact with Ollama.
   *   4. Persist to `verified_knowledge` only when confidence > 0.7.
   *
   * Master-only (satellites are stateless) and throttled to one source
   * every DISCOVERY_INTERVAL_MS.
   */
  private async runDiscoveryMode(): Promise<void> {
    if (env.NODE_ROLE !== "master") {
      return; // satellites have no Deep Brain to write to
    }

    const now = Date.now();
    if (now - this.lastDiscoveryAt < DISCOVERY_INTERVAL_MS) {
      return; // throttle autonomous scraping
    }
    this.lastDiscoveryAt = now;

    // Pick the next not-yet-scraped seed (round-robin over the pending set).
    const scraped = new Set(selectScrapedSourceUrls());
    const pending = SEED_URLS.filter((url) => !scraped.has(url));
    if (pending.length === 0) {
      if (!this.seedsExhaustedLogged) {
        console.log("[Orchestrator] Discovery: all seed sources ingested — standing by.");
        this.seedsExhaustedLogged = true;
      }
      return;
    }

    const url = pending[this.seedCursor % pending.length];
    this.seedCursor += 1;

    this.swarm.setStatus("busy");
    setCurrentProcess(`discovery:${new URL(url).hostname}`);
    try {
      console.log(`[Orchestrator] Discovery: scraping ${url}`);
      const { text } = await this.scraper.scrape(url);

      // 1. Raw page → raw_lore (always kept, even if extraction later fails).
      const loreId = insertRawLore("discovery", text, url);
      console.log(`[Orchestrator] raw_lore #${loreId} saved (${text.length} chars) from ${url}`);

      // 2. Raw text → structured fact via the local LLM.
      const fact = await this.ollama.extractFacts(text);

      // 3. Gate on confidence before promoting to verified knowledge.
      if (fact && fact.confidence_score > CONFIDENCE_THRESHOLD) {
        const factId = insertVerifiedKnowledge(fact);
        setRawLoreStatus(loreId, "extracted");
        console.log(
          `[Orchestrator] verified_knowledge #${factId} saved [${fact.category}] ` +
            `(confidence ${fact.confidence_score.toFixed(2)}): ${fact.fact_summary}`,
        );
      } else {
        setRawLoreStatus(loreId, "unverified");
        const reason = fact
          ? `confidence ${fact.confidence_score.toFixed(2)} ≤ ${CONFIDENCE_THRESHOLD}`
          : "no valid JSON from Ollama";
        console.log(`[Orchestrator] Not verified (${reason}) — raw lore kept as 'unverified'.`);
      }
    } catch (error) {
      console.warn(
        `[Orchestrator] Discovery failed for ${url}: ${error instanceof Error ? error.message : String(error)}`,
      );
      // Don't make a dead seed cost the full throttle window — retry the
      // next pending source after DISCOVERY_RETRY_MS instead.
      this.lastDiscoveryAt = Date.now() - (DISCOVERY_INTERVAL_MS - DISCOVERY_RETRY_MS);
    } finally {
      this.swarm.setStatus("idle");
      clearCurrentProcess();
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
