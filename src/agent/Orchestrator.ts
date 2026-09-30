import { SwarmClient, type SwarmTask } from "../network/SwarmClient";
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
import { executeSkill } from "../services/skillExecutor";
import { healTask } from "../services/taskManager";
import { startLocalAiDiscovery, type LocalAiStatus } from "../services/localAi";
import { runIdleVerification } from "../services/idleVerification";

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

/** The new dynamic-skill task type, and the failure signals that trigger healing. */
const DYNAMIC_SKILL = "DYNAMIC_SKILL";

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
  /** Latest local-AI capability, consumed by the self-healing loop. */
  private localAiStatus: LocalAiStatus | null = null;
  /** Cancels the periodic local-AI probe. */
  private stopLocalAi: (() => void) | null = null;

  constructor(private readonly swarm: SwarmClient) {
    this.ota = new OtaUpdater(swarm);
    // A version advertised on the heartbeat reply triggers an immediate
    // update attempt instead of waiting for the next scheduled check.
    this.swarm.setUpdateSignalHandler((info) => this.ota.onUpdateSignal(info));
    // Watch for a local Ollama server continuously: the node may boot before the
    // model server, or a model may be pulled later. The callback only fires on a
    // real change, so the Mothership is re-registered exactly once per change.
    this.stopLocalAi = startLocalAiDiscovery((status) => {
      this.localAiStatus = status;
      void this.swarm.registerAiCapability({
        aiCapable: status.capable,
        url: status.url,
        models: status.capableModels,
        preferredModel: status.preferredModel,
      });
    });
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
    // Stop probing for a local AI server alongside everything else.
    if (this.stopLocalAi) {
      this.stopLocalAi();
      this.stopLocalAi = null;
    }
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
      await this.runIdleMode();
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
        // AI-generated JavaScript from the Mothership, run in the skill sandbox.
        case DYNAMIC_SKILL:
          await this.handleDynamicSkill(task);
          break;
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
   * DYNAMIC_SKILL — executes AI-generated code in the isolated sandbox.
   *
   * On failure the orchestrator does NOT give up: it feeds the real error and
   * input sample to the local model (falling back to the cloud), has it write a
   * patched function, sandbox-tests the patch, and re-runs the task. A patch
   * that works is submitted back to the Mothership so the whole fleet inherits
   * the fix.
   */
  private async handleDynamicSkill(task: SwarmTask): Promise<void> {
    const code = String(task.payload?.["code"] ?? "");
    const input = task.payload?.["input"];
    if (!code.trim()) {
      console.warn(`[Orchestrator] ${DYNAMIC_SKILL} task ${task.id} had no code — skipping.`);
      return;
    }

    const result = await executeSkill({
      id: task.id,
      code,
      input,
      timeoutMs: numberOr(task.payload?.["timeoutMs"], 5_000),
      memoryMb: numberOr(task.payload?.["memoryMb"], 128),
    });

    if (result.ok) {
      console.log(`[Orchestrator] ${DYNAMIC_SKILL} ${task.id} completed in ${result.durationMs}ms.`);
      await this.swarm.submitProfile({
        kind: "skill_result",
        taskId: task.id,
        status: "success",
        output: result.output,
        durationMs: result.durationMs,
      });
      return;
    }

    console.warn(`[Orchestrator] ${DYNAMIC_SKILL} ${task.id} failed — ${result.error.split("\n")[0]}`);

    // SELF-HEAL: ask the model for a patch and retry.
    const outcome = await healTask(
      {
        taskId: task.id,
        taskType: task.type,
        message: result.error.split("\n")[0] ?? "skill failed",
        stack: result.error,
        code,
        inputSample: input,
      },
      {
        ollama: this.ollama,
        localStatus: () => this.localAiStatus,
        swarm: this.swarm,
        rerun: async (patchedCode) => {
          const retried = await executeSkill({ id: task.id, code: patchedCode, input });
          if (!retried.ok) throw new Error(retried.error.split("\n")[0]);
        },
        submitPatch: (payload) => this.swarm.submitProfile({ kind: "skill_patch", ...payload }),
      },
    );

    for (const line of outcome.log) console.log(`[Heal] ${line}`);
    await this.swarm.submitProfile({
      kind: "skill_result",
      taskId: task.id,
      status: outcome.healed ? "healed" : "failed",
      attempts: outcome.attempts,
      error: outcome.healed ? "" : result.error.split("\n")[0],
    });
  }

  /**
   * IDLE MODE — what the node does with an empty queue.
   *
   * Two autonomous sources of work, in priority order:
   *
   *   1. RE-VERIFY the mirror's most overdue place (the idle engine). This runs
   *      FIRST because it is the work with a real expiry: a place record that
   *      was true when it synced is slowly becoming false, and re-checking the
   *      backlog beats discovering somewhere new when there is already stale
   *      knowledge on disk.
   *   2. DISCOVER a new seed source, the existing scrape-and-extract loop.
   *
   * The discovery throttle is shared between them, so a run that just re-verified
   * does not immediately follow up with a discovery scrape as well.
   */
  private async runIdleMode(): Promise<void> {
    const now = Date.now();
    if (now - this.lastDiscoveryAt < DISCOVERY_INTERVAL_MS) {
      return; // throttle autonomous work
    }
    this.lastDiscoveryAt = now;

    const verification = await runIdleVerification(this.scraper, this.ollama);
    if (verification.checked) {
      this.swarm.setStatus("busy");
      setCurrentProcess(`verify:${verification.place?.name ?? "place"}`);
      try {
        console.log(`[Orchestrator] Idle verify: ${verification.message}`);
      } finally {
        this.swarm.setStatus("idle");
        clearCurrentProcess();
      }
      return; // one page load per idle window; discovery gets the next slot
    }
    console.log(`[Orchestrator] Idle verify: ${verification.message}`);

    await this.runDiscoveryPass();
  }

  /**
   * DISCOVERY PASS — autonomous learning when the mirror is up to date.
   *
   *   1. Round-robin the seed URLs, skipping anything already in `raw_lore`.
   *   2. Scrape the next source headlessly (Playwright) -> `raw_lore`.
   *   3. Extract a structured fact with Ollama.
   *   4. Persist to `verified_knowledge` only when confidence > 0.7.
   *
   * Master-only (satellites are stateless). The throttling and the "no Deep
   * Brain" guard live in {@link runIdleMode}, which is the only caller.
   */
  private async runDiscoveryPass(): Promise<void> {
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

/** Reads a finite number from an untrusted task payload, else uses `fallback`. */
function numberOr(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
