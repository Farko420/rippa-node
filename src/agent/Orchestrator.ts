import { SwarmClient, type SwarmTask } from "../network/SwarmClient";
import { ScraperService } from "./Scraper";
import { OllamaClient } from "./OllamaClient";
import { OtaUpdater } from "../update/OtaUpdater";
import { APP_VERSION } from "../version";
import { schedule, type ScheduledTask } from "node-cron";
import { executeSkill } from "../services/skillExecutor";
import { healTask } from "../services/taskManager";
import { startLocalAiDiscovery, type LocalAiStatus } from "../services/localAi";
import { AutonomousForager } from "../services/autonomousForager";
import { TaskEngine, type TaskOutcome } from "../services/taskEngine";

/**
 * AUTONOMOUS AGENT ORCHESTRATOR — the composition root for the dual-tier engine.
 *
 * The scheduling itself lives in `TaskEngine` (priority vs. idle, preemption and
 * resume) and the learning itself lives in `AutonomousForager` (scrape, extract,
 * persist, feed). This class is what those two need from the host: a scraper, a
 * local model, and a way to execute whatever the Mothership asks for. Keeping it
 * thin is the point — the preemption contract is only trustworthy if exactly one
 * component owns it.
 *
 * Alongside the engine it owns the OTA self-update task, so a new build pushed
 * to the Mothership is downloaded and applied without human intervention.
 */

const OTA_CHECK_CRON = "0 */60 * * * *"; // background version check every 60 minutes
const OTA_FIRST_CHECK_DELAY_MS = 30_000; // let boot settle before the first check

/** The new dynamic-skill task type, and the failure signals that trigger healing. */
const DYNAMIC_SKILL = "DYNAMIC_SKILL";

export class Orchestrator {
  private running = false;
  private readonly scraper = new ScraperService();
  private readonly ollama = new OllamaClient();
  /** The idle tier. */
  private readonly forager: AutonomousForager;
  /** The dual-tier scheduler that owns both queues. */
  private readonly engine: TaskEngine;
  private readonly ota: OtaUpdater;
  private otaTask: ScheduledTask | null = null;
  private otaFirstCheck: NodeJS.Timeout | null = null;
  /** Latest local-AI capability, consumed by the self-healing loop. */
  private localAiStatus: LocalAiStatus | null = null;
  /** Cancels the periodic local-AI probe. */
  private stopLocalAi: (() => void) | null = null;

  constructor(private readonly swarm: SwarmClient) {
    this.ota = new OtaUpdater(swarm);

    this.forager = new AutonomousForager({
      scraper: this.scraper,
      ollama: this.ollama,
      swarm,
    });
    this.engine = new TaskEngine({
      swarm,
      forager: this.forager,
      handlePriorityTask: (task) => this.handleTask(task),
    });

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

  /**
   * Starts both tiers of the engine (idempotent). Does not block the caller.
   *
   * Starting the idle tier at all is the behavioural change: the node now does
   * something with itself when the Mothership has nothing for it, instead of
   * waiting for the next assignment.
   */
  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.engine.start();
    console.log(
      "[Orchestrator] Dual-tier engine started — Mothership tasks preempt autonomous foraging.",
    );
    this.startOtaUpdates();
  }

  /** Stops both tiers, allowing in-flight work to settle. */
  async stop(): Promise<void> {
    this.running = false;
    this.stopOtaUpdates();
    // Stop probing for a local AI server alongside everything else.
    if (this.stopLocalAi) {
      this.stopLocalAi();
      this.stopLocalAi = null;
    }
    await this.engine.stop();
    await this.scraper.close();
    console.log("[Orchestrator] Dual-tier engine stopped.");
  }

  isRunning(): boolean {
    return this.running;
  }

  /** The tier the node is in right now — "priority" or "idle". */
  currentTier(): "priority" | "idle" {
    return this.engine.currentTier();
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

  /**
   * EXECUTES ONE MOTHERSHIP TASK — the priority tier's only real work.
   *
   * Returns an outcome rather than throwing, because the engine reports success
   * and failure to the Mothership on this node's behalf and a thrown error
   * would leave the task unacknowledged in the cloud's queue.
   *
   * Status telemetry (`setStatus` / `setCurrentProcess`) belongs to the engine
   * now — it owns the tier flag, and two components writing "busy" would race
   * each other during exactly the handoff this engine exists to make clean.
   */
  private async handleTask(task: SwarmTask): Promise<TaskOutcome> {
    switch (task.type) {
      // AI-generated JavaScript from the Mothership, run in the skill sandbox.
      case DYNAMIC_SKILL:
        return this.handleDynamicSkill(task);
      // TODO: wire real handlers as they are built, e.g.:
      //   case "scrape":   → Playwright headless scrape
      //   case "extract":  → Ollama structured extraction
      //   case "verify":   → confidence scoring → verified_knowledge
      default:
        console.warn(`[Orchestrator] Unhandled task type "${task.type}" (id=${task.id}) — skipping.`);
        // Reported upstream by the engine: an unacknowledged task would sit in
        // the Mothership's queue forever, which is indistinguishable from a node
        // that is ignoring its assignments.
        return { status: "skipped", detail: `no handler for type "${task.type}"` };
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
   *
   * Every return here sets `reported: true`, because this handler already files
   * its own richer result with the Mothership and a second generic record would
   * contradict it.
   */
  private async handleDynamicSkill(task: SwarmTask): Promise<TaskOutcome> {
    const code = String(task.payload?.["code"] ?? "");
    const input = task.payload?.["input"];
    if (!code.trim()) {
      console.warn(`[Orchestrator] ${DYNAMIC_SKILL} task ${task.id} had no code — skipping.`);
      return { status: "skipped", detail: "task carried no code", reported: true };
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
      return { status: "success", detail: `ran in ${result.durationMs}ms`, reported: true };
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

    return {
      status: outcome.healed ? "success" : "failure",
      detail: outcome.healed
        ? `self-healed after ${outcome.attempts} attempt(s)`
        : result.error.split("\n")[0] ?? "skill failed",
      reported: true,
    };
  }
}

/** Reads a finite number from an untrusted task payload, else uses `fallback`. */
function numberOr(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
