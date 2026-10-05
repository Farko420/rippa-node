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
import { IngestionEngine } from "../services/ingestionEngine";
import { TaskEngine, type TaskOutcome } from "../services/taskEngine";
import { ResourceGovernor, DEFAULT_POWER_CONFIG, type PowerConfig } from "../services/resourceGovernor";
import {
  adminCommandForTaskType,
  executePendingCommands,
  type RemoteCommandName,
} from "../services/heartbeat";

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

/**
 * Hooks the fleet controller supplies so an ADMIN task can actually be carried
 * out. Kept as a constructor option rather than reaching for module state, so the
 * orchestrator stays testable and the boot sequence in index.ts owns the wiring.
 */
export interface AdminCommandDeps {
  /**
   * Gracefully stop every service and exit with the RESTART exit code.
   *
   * The exit code is the whole handoff: the Rippa Watchdog reads it and relaunches
   * the node. The previous contract ("stop so something else relaunches me") had
   * nothing on the other end for an ordinary restart, which is why a remote
   * restart behaved exactly like a shutdown.
   */
  restartNode: () => Promise<void> | void;
  /**
   * Stop every service and exit with the STOP exit code (0) — a deliberate stop.
   *
   * Separate from {@link restartNode} for the same reason it is separate in
   * `CommandHandlers`: the exit code is the entire handoff. Restart exits 42 and
   * the watchdog relaunches at once; stop exits 0 and the watchdog waits in Ghost
   * Mode for a `start`. Sharing one handler would make the dashboard's Stop button
   * reboot the node it was asked to stop.
   */
  stopNode: () => Promise<void> | void;
  /**
   * Fetch, verify and swap to the latest published release.
   *
   * @param options.allowDowngrade permits installing a build OLDER than the one
   *          running. Off unless the task payload carries `allow_downgrade: true`.
   *
   * @returns true when a swap is committed (the process is about to exit). The
   *          boolean is only observable on paths that do NOT exit, but it is
   *          what lets the caller report a refused update honestly instead of
   *          claiming a restart that never happened.
   */
  forceUpdate: (options?: { allowDowngrade?: boolean }) => Promise<boolean | "rejected_downgrade"> | boolean | "rejected_downgrade" | void;
  /** Reports whether mesh routing is currently enabled on this node. */
  isP2pEnabled: () => boolean;
  /** Enables or disables mesh routing. */
  setP2pEnabled: (enabled: boolean) => Promise<void> | void;
  /**
   * Reports an admin command back to the Mothership so its queue entry is
   * retired. Optional so a host with no uplink can omit it entirely.
   *
   * The `context` argument is the same shape the heartbeat executor supplies —
   * notably the command id, without which the cloud cannot clear the entry.
   */
  acknowledgeCommand?: (
    command: RemoteCommandName,
    detail: string,
    context?: { commandId?: string; status?: "completed" | "failed" | "in_progress" | "rejected_downgrade" },
  ) => Promise<void> | void;
}

export class Orchestrator {
  private running = false;
  private readonly scraper = new ScraperService();
  private readonly ollama = new OllamaClient();
  /** The idle tier. */
  private readonly forager: AutonomousForager;
  /** The dual-tier scheduler that owns both queues. */
  private readonly engine: TaskEngine;
  /** The fleet research ingestion pipeline (payload GC lives inside it). */
  private readonly ingestion: IngestionEngine;
  private readonly ota: OtaUpdater;
  private otaTask: ScheduledTask | null = null;
  private otaFirstCheck: NodeJS.Timeout | null = null;
  /** Latest local-AI capability, consumed by the self-healing loop. */
  private localAiStatus: LocalAiStatus | null = null;
  /** Cancels the periodic local-AI probe. */
   /** Resource Governor — manages CPU/RAM/concurrency limits. */
   private readonly governor: ResourceGovernor;

  private stopLocalAi: (() => void) | null = null;

  constructor(
    private readonly swarm: SwarmClient,
    private readonly admin: AdminCommandDeps,
    /*
      INJECTABLE, NOT ALWAYS CONSTRUCTED HERE.

      The `FORCE_UPDATE` command handler is owned by the boot sequence (it also
      has to reach the node event stream and the acknowledgement route), so it
      needs an OtaUpdater of its own. If this class quietly built a second one,
      the hourly poll and the forced command would each keep their own in-flight
      flag and "already attempted" memory — so both could decide to download the
      same release in the same window, and the shared handoff stamp would make
      one of them fail for no visible reason. Passing the instance in keeps a
      single source of truth; the fallback keeps this class constructible on its
      own.
    */
    ota?: OtaUpdater,
  ) {

    // Initialize the Resource Governor with default config (will be updated by heartbeat)
    this.governor = new ResourceGovernor(DEFAULT_POWER_CONFIG);
    // Wire the Governor into the Ollama client so thread limits are applied to all requests
    this.ollama.setGovernor(this.governor);
    // Wire it into the scraper so Playwright contexts and memory use are bounded too.
    this.scraper.setGovernor(this.governor);

    this.ota = ota ?? new OtaUpdater(swarm);

    this.forager = new AutonomousForager({
      scraper: this.scraper,
      ollama: this.ollama,
      swarm,
    });
    this.engine = new TaskEngine({
      swarm,
      forager: this.forager,
      // The Governor caps how many priority tasks run concurrently (see drain).
      governor: this.governor,
      handlePriorityTask: (task) => this.handleTask(task),
    });
    // The heavy-research queue. Its temp workspaces (downloaded ZIPs, extracted
    // photos, PDFs) are wiped on success, on failure, and swept after a crash —
    // see services/ingestionEngine for the three-layer guarantee.
    this.ingestion = new IngestionEngine({ swarm, ollama: this.ollama });

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
    this.ingestion.start();
    console.log(
      "[Orchestrator] Dual-tier engine started — Mothership tasks preempt autonomous foraging.",
    );
    this.startOtaUpdates();
  }

  /** Stops both tiers, allowing in-flight work to settle. */
  async stop(): Promise<void> {
    this.running = false;
    this.stopOtaUpdates();
    this.ingestion.stop();
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

  /**
   * Returns the active Resource Governor instance.
   * Allows external code to query current resource limits.
   */
  getGovernor(): ResourceGovernor {
    return this.governor;
  }

  /**
   * Updates the power configuration from the Mothership.
   * Called whenever the heartbeat carries a new power_config directive.
   */
  setPowerConfig(config: PowerConfig): void {
    this.governor.updateConfig(config);
    console.log(`[Orchestrator] ${this.governor.describe()}`);
  }

  /** The scraper service — exposed for the dashboard's self-heal action. */
  getScraper(): ScraperService {
    return this.scraper;
  }

  /** The local-model client — exposed for Command Center batch analysis. */
  getOllama(): OllamaClient {
    return this.ollama;
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
    /*
      ADMIN COMMANDS ARE INTERCEPTED FIRST, BEFORE THE `switch` BELOW.

      This is the fix for "Force OTA Update and Restart Node Service are received
      but ignored". The Mothership sends those as ORDINARY QUEUE TASKS whose
      `type` is `FORCE_OTA_UPDATE` / `RESTART_NODE_SERVICE`. Falling through to
      the `default:` branch produced a logged "no handler for type" and a
      `skipped` result — the command was seen and then thrown away, every time.

      Routing them through the same executor the heartbeat's `pending_commands`
      use means one allowlist governs every admin action, one code path runs it,
      and the dashboard overlay is published from the same place in both cases.
    */
    const adminCommand = adminCommandForTaskType(task.type);
    if (adminCommand) {
      return this.handleAdminTask(task, adminCommand);
    }

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
   * Carries out one admin task (force update / restart / toggle P2P).
   *
   * Delegates to the SAME executor the heartbeat's `pending_commands` path uses,
   * which is what guarantees the behaviours that matter are identical either way:
   * the allowlist gate, the once-per-id de-duplication, the operator kill-switch
   * (`RIPPA_REMOTE_COMMANDS=false`), the dashboard overlay published before the
   * handler runs, and the acknowledgement sent before the node exits.
   *
   * WHY `reported` IS NOT SET HERE ANY MORE. The old comment claimed
   * `executePendingCommands` reported its own progress, and used that to suppress
   * the engine's `task_result`. It did not: it only logs and publishes a local
   * overlay, so nothing ever reached the Mothership. Combined with the handler
   * ending in `process.exit(0)`, every forced update produced NO result record at
   * all — the command vanished from the fleet view exactly when it was being
   * acted on, which is the "received but ignored" symptom from the other side.
   *
   * The engine now files the `task_result` on every path that does not exit, and
   * the executor sends its own pre-shutdown acknowledgement on the paths that do.
   * A `restart` or `update` that succeeds never reaches this return; it exists for
   * the refused/suppressed cases, where the outcome must still be truthful.
   */
  private async handleAdminTask(
    task: SwarmTask,
    command: RemoteCommandName,
  ): Promise<TaskOutcome> {
    const args = (task.payload ?? {}) as Record<string, unknown>;
    const requested = args["enabled"];
    /*
      BOTH CONSENT FLAGS ARE FORWARDED, NOT JUST `enabled`.

      An admin task's payload can carry `TOGGLE_P2P`'s `enabled` and
      `FORCE_UPDATE`'s `allow_downgrade`. Forwarding only the first meant a
      rollback task arrived at the executor indistinguishable from a plain force
      update — and so silently lost the consent it needed, which is a safe
      failure but still a wrong one. Both are copied verbatim; the executor
      decides which applies to which command.
    */
    const payloadArgs: Record<string, unknown> = {};
    if (typeof requested === "boolean") payloadArgs["enabled"] = requested;
    if (args["allow_downgrade"] === true) payloadArgs["allow_downgrade"] = true;
    if (args["allowDowngrade"] === true) payloadArgs["allowDowngrade"] = true;

    const executed = await executePendingCommands(
      [
        {
          id: `task:${task.id}`,
          // The raw task id, NOT the namespaced dedup key above. That key is
          // correct locally but would be meaningless upstream: the Mothership
          // filed this entry as `task.id`, so acknowledging `task:<id>` would
          // match nothing and the admin task would be re-dispatched forever.
          ackId: task.id,
          command,
          ...(Object.keys(payloadArgs).length > 0 ? { args: payloadArgs } : {}),
        },
      ],
      {
        restartNode: () => this.admin.restartNode(),
        stopNode: () => this.admin.stopNode(),
        forceUpdate: (options) => this.admin.forceUpdate(options),
        setP2pEnabled: (enabled) => this.admin.setP2pEnabled(enabled),
        isP2pEnabled: () => this.admin.isP2pEnabled(),
        // Routed through so the queue-task channel is acknowledged to the
        // Mothership on exactly the same terms as the heartbeat channel.
        ...(this.admin.acknowledgeCommand
          ? { acknowledgeCommand: this.admin.acknowledgeCommand }
          : {}),
      },
    );

    console.log(
      `[Orchestrator] Admin task ${task.id} (${task.type}) -> ${executed.join(", ") || "not executed"}.`,
    );

    // "not executed" means the allowlist refused it, remote commands are off via
    // the operator kill-switch, or this exact id already ran. Reported as a
    // failure so the Mothership's queue reflects that nothing happened rather
    // than leaving the command pending forever.
    return {
      status: executed.length > 0 ? "success" : "failure",
      detail:
        executed.length > 0
          ? `admin command ${command} executed`
          : `admin command ${command} was not executed (disabled or already run)`,
    };
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
