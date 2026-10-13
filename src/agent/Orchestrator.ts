import { SwarmClient, type SwarmTask } from "../network/SwarmClient";
import { ScraperService, countPlaceCandidates } from "./Scraper";
import { OllamaClient } from "./OllamaClient";
import { OtaUpdater } from "../update/OtaUpdater";
import { APP_VERSION } from "../version";
import { schedule, type ScheduledTask } from "node-cron";
import { executeSkill } from "../services/skillExecutor";
import { runLocalInference } from "../services/ollamaManager";
import { healTask } from "../services/taskManager";
import { startLocalAiDiscovery, type LocalAiStatus } from "../services/localAi";
import { AutonomousForager, type PreemptionProbe } from "../services/autonomousForager";
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
 * The `ai_inference` task type — the epic's outbound-only AI work.
 *
 * The Mothership assigns `{ prompt, model?, system?, options? }` in
 * `task.payload`; the node runs it against its LOCAL dynamic-port Ollama
 * instance and POSTs the text back via `submitProfile` (kind
 * `ai_inference_result`). Accepted alongside `AI_INFERENCE`/`INFER` spellings
 * because the cloud and the queue do not always agree on case.
 */
const AI_INFERENCE = "AI_INFERENCE";

/**
 * The `scrape` task type — the Mothership's directed web-scraping work.
 *
 * The Mothership assigns `{ url }` (with `target` / `sourceUrl` accepted as
 * aliases, because the cloud and the queue have never fully agreed on a key) in
 * `task.payload`; the node fetches that page with the SAME engine the idle
 * forager uses and POSTs the sanitized body text back via `submitProfile` (kind
 * `scrape_result`).
 *
 * WHY THE MOTHERSHIP NEEDS THIS AT ALL: the page text is the payload it cannot
 * fetch itself — JS-rendered pages, per-IP content, geo-fenced pages. A node
 * running headless Chromium on a residential connection is the only thing in the
 * fleet that can see it.
 *
 * Normalised like every other task type, so `scrape`, `SCRAPE` and `Scrape` all
 * land on the same handler instead of two of the three being silently skipped.
 */
const SCRAPE = "SCRAPE";

/**
 * The `llm_query` task type — the Mothership's local-LLM fallback.
 *
 * The Mothership assigns `{ prompt, model?, system?, temperature?, maxTokens? }`
 * and the node answers with its LOCAL model (the reconciled generation model,
 * `qwen2.5-coder:7b` on a machine with enough RAM), filed back as a
 * `llm_query_result`. This is the "the cloud's own model is unavailable or the
 * prompt must not leave the node" path, so it deliberately never touches an
 * external API.
 *
 * Same payload and same engine as `AI_INFERENCE`; only the report kind and the
 * log label differ, which is why both are served by one implementation
 * ({@link Orchestrator.runLocalModelTask}).
 */
const LLM_QUERY = "LLM_QUERY";

/**
 * The `deep_research` task type — the Mothership's retrieval-augmented research
 * work, and the one kind every research dispatcher in the fleet shares.
 *
 * The Mothership queues it from the member chat (`deep-research.server.ts`), the
 * Admin Co-Pilot's shadow dispatch, the mass place scrub
 * (`place-scrub.server.ts`) and the RI ripple sweeper — all under this single
 * kind, told apart by the `task_marker` in the payload rather than by a kind of
 * their own. The node's job is identical in every case: fetch what the web says
 * about the subject, run the LOCAL model over it, and file atomic source-grounded
 * facts back as a `research_result`.
 *
 * Normalised like every other task type, so `deep_research`, `DEEP_RESEARCH` and
 * `Deep_Research` all land on the same handler instead of two of the three being
 * silently skipped.
 */
const DEEP_RESEARCH = "DEEP_RESEARCH";

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
   * Applies a Mothership-queued storage configuration (`SYSTEM_UPDATE_STORAGE`).
   *
   * Shares the same contract as `CommandHandlers.updateStorage`: a real
   * directory change exits 42 from inside the handler, and `false` on a
   * non-exit path means the request was refused or failed. Wired to the SAME
   * implementation the heartbeat channel uses (see index.ts) so the two
   * channels cannot drift.
   */
  updateStorage: (args: Record<string, unknown>) => Promise<boolean | void> | boolean | void;
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

    // Normalised once: the cloud sends `ai_inference`, `AI_INFERENCE` and
    // `AI_INFERENCE_TASK` for the same work, and an exact-match switch would
    // silently skip two of the three. Admin types already normalise the same
    // way (see adminCommandForTaskType); task types get the same treatment.
    const taskKind = String(task.type ?? "").trim().toUpperCase();
    switch (taskKind) {
      // AI-generated JavaScript from the Mothership, run in the skill sandbox.
      case DYNAMIC_SKILL:
        return this.handleDynamicSkill(task);
      // Outbound-only local inference: prompt in, text out, no inbound socket.
      case AI_INFERENCE:
      case "AI_INFERENCE_TASK":
      case "INFER":
      case "INFERENCE":
        return this.handleAiInference(task);
      /*
        THE TWO HANDLERS THAT WERE MISSING — the reported
        `Unhandled task type "scrape"` / `"llm_query"` skip.

        Both types are named in the Mothership's contract and both arrived at the
        `default:` branch below, which logged a warning and answered `skipped`.
        The task then sat in the cloud's queue looking assigned-but-undone, which
        is indistinguishable from a node ignoring its work. Neither needs new
        machinery: `scrape` drives the scraper the forager already uses, and
        `llm_query` drives the local model the `ai_inference` path already uses.
      */
      case SCRAPE:
        return this.handleScrapeTask(task);
      case LLM_QUERY:
        return this.handleLlmQuery(task);
      /*
        THE THIRD MISSING HANDLER — the reported
        `Unhandled task type "deep_research"` skip.

        `deep_research` has been in the Mothership's `SWARM_TASK_KINDS` since the
        swarm shipped, and it is the kind four separate dispatchers queue: the
        member chat's mid-conversation research, the Admin Co-Pilot's shadow
        dispatch, the mass place scrub, and the RI ripple sweeper. The node had no
        branch for it, so every one of those fell to `default:`, was logged as
        unhandled and answered `skipped` — leaving the row claimed-but-undone in
        the cloud, which is indistinguishable from a node ignoring its work.

        Unlike `scrape` and `llm_query` this one is not a single existing call:
        it is the RAG path, and it is composed from machinery this class already
        owns — the Playwright scraper fetches the sources, the local Ollama model
        synthesises them — rather than a second copy of either.
      */
      case DEEP_RESEARCH:
      case "DEEP_RESEARCH_TASK":
        return this.handleDeepResearch(task);
      /*
        HEARTBEAT-PULLED FORAGE TARGETS (epic §2): the heartbeat may hand the
        node a `forage_target` wrapped as a FORAGE task (see parseTaskPayload).
        It runs as a priority pass — scrape via Playwright, extract via local
        Ollama — and Pushes the learned fact via submitProfile/learn, exactly
        like any other priority task. Runs through the forager's single-pass
        path so evidence handling stays in one place.
      */
      case "FORAGE":
      case "FORAGE_TARGET":
        return this.handleForageTask(task);
      // TODO: wire real handlers as they are built, e.g.:
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
    /*
      STORAGE KEYS ARE FORWARDED VERBATIM TOO — a SYSTEM_UPDATE_STORAGE task
      that arrives on the queue-task channel carries its directory and
      capacities in the payload, and dropping them would queue a migration for
      "nowhere in particular", which the node refuses and reports as failed.
      Strings and finite numbers only: anything else stays out of the payload
      the daemon acts on.
    */
    for (const key of [
      "data_dir",
      "dataDir",
      "scratch_capacity_gb",
      "scratchCapacityGb",
      "safe_vault_capacity_gb",
      "vault_capacity_gb",
      "vaultCapacityGb",
      "safeVaultCapacityGb",
    ]) {
      const value = args[key];
      if (typeof value === "string" && value.trim()) payloadArgs[key] = value.trim();
      else if (typeof value === "number" && Number.isFinite(value)) payloadArgs[key] = value;
    }

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
        updateStorage: (storageArgs) => this.admin.updateStorage(storageArgs),
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

  /**
   * AI_INFERENCE — runs a Mothership prompt against the LOCAL dynamic-port
   * Ollama instance and POSTs the text back. Strictly outbound: the prompt
   * arrived over the poll loop, the result leaves over `submitProfile`.
   *
   * Payload shape (all optional except `prompt`):
   * `{ prompt, model?, system?, temperature?, maxTokens? }`.
   * `reported: true` on every path, because this handler files its own
   * `ai_inference_result` and the engine's generic `task_result` would double
   * -report the same task.
   */
  private async handleAiInference(task: SwarmTask): Promise<TaskOutcome> {
    return this.runLocalModelTask(task, AI_INFERENCE, "ai_inference_result");
  }

  /**
   * LLM_QUERY — the Mothership's local-LLM fallback, served by the SAME engine
   * as `ai_inference`.
   *
   * Payload shape (all optional except `prompt`):
   * `{ prompt, model?, system?, temperature?, maxTokens? }`.
   *
   * The ONLY differences from `ai_inference` are the log label and the reported
   * kind (`llm_query_result`), which is exactly why the work itself is not
   * duplicated: two copies of "prompt in, model text out" would drift, and the
   * one that drifted would be the one nobody was looking at.
   *
   * `reported: true` on every path — this handler files its own result and the
   * engine's generic `task_result` would double-report the same task.
   */
  private async handleLlmQuery(task: SwarmTask): Promise<TaskOutcome> {
    return this.runLocalModelTask(task, LLM_QUERY, "llm_query_result");
  }

  /**
   * THE ONE IMPLEMENTATION behind `ai_inference` and `llm_query`.
   *
   * `label` is what the log line calls the task; `reportKind` is the `kind` the
   * result is filed under. Everything else — prompt extraction, the local
   * inference call, the success/failure reporting — is shared, so a fix to one
   * task type is a fix to both.
   */
  private async runLocalModelTask(
    task: SwarmTask,
    label: string,
    reportKind: string,
  ): Promise<TaskOutcome> {
    const payload = task.payload ?? {};
    const prompt = String(payload["prompt"] ?? payload["input"] ?? payload["query"] ?? "").trim();
    if (!prompt) {
      console.warn(`[Orchestrator] ${label} task ${task.id} had no prompt — skipping.`);
      await this.swarm.submitProfile({
        kind: reportKind,
        taskId: task.id,
        status: "skipped",
        error: "task carried no prompt",
      });
      return { status: "skipped", detail: "task carried no prompt", reported: true };
    }
    const startedAt = Date.now();
    try {
      // Static import at the top (pkg snapshot cannot resolve dynamic imports).
      /*
        `model` is LEFT UNDEFINED when the task carries none, and that is what
        makes `runLocalInference` use the node's OWN reconciled generation model
        (`qwen2.5-coder:7b` on a machine with the RAM for it). Pinning a model
        here would ignore a fleet-wide model change, and on a low-RAM satellite
        would ask for weights that were deliberately never pulled.
      */
      const result = await runLocalInference({
        prompt,
        model: typeof payload["model"] === "string" ? payload["model"] : undefined,
        system: typeof payload["system"] === "string" ? payload["system"] : undefined,
        temperature: typeof payload["temperature"] === "number" ? payload["temperature"] : undefined,
        // `max_tokens` accepted too: the queue has always sent the snake_case key.
        maxTokens: numberOr(payload["maxTokens"] ?? payload["max_tokens"], 0) || undefined,
      });
      const durationMs = Date.now() - startedAt;
      await this.swarm.submitProfile({
        kind: reportKind,
        taskId: task.id,
        status: "success",
        output: result.text,
        model: result.model,
        durationMs,
      });
      console.log(`[Orchestrator] ${label} ${task.id} completed in ${durationMs}ms (${result.model}).`);
      return { status: "success", detail: `inferred in ${durationMs}ms`, reported: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.swarm.submitProfile({
        kind: reportKind,
        taskId: task.id,
        status: "failed",
        error: message.split("\n")[0] ?? "inference failed",
        durationMs: Date.now() - startedAt,
      });
      console.warn(`[Orchestrator] ${label} ${task.id} failed — ${message.split("\n")[0]}`);
      return { status: "failure", detail: message.split("\n")[0] ?? "inference failed", reported: true };
    }
  }

  /**
   * SCRAPE — a Mothership-directed headless scrape.
   *
   * Payload shape: `{ url }`, with `target` / `sourceUrl` accepted as aliases.
   *
   * The URL is fetched with the SAME engine the idle forager uses: Playwright /
   * headless Chromium on a desktop node, and the lightweight `fetch` scraper on a
   * runtime that has no Chromium (the APK). That routing already lives inside
   * {@link ScraperService.scrape}, so a scrape task behaves identically however
   * this node is deployed — including the Chromium bootstrap, the governor's
   * browser-slot cap, and the 20k-character payload cap.
   *
   * The sanitized body text is filed back as a `scrape_result`: that text IS the
   * payload the Mothership cannot fetch itself (JS-rendered, geo-fenced or
   * per-IP pages), so it is sent whole rather than summarised here. The local
   * model is deliberately NOT consulted — extraction is the `extract` task's job,
   * and spending GPU time on every scrape would make this node a bottleneck
   * rather than a sensor.
   *
   * `reported: true` on every path, because this handler files its own result and
   * the engine's generic `task_result` would double-report the same task.
   */
  private async handleScrapeTask(task: SwarmTask): Promise<TaskOutcome> {
    const payload = (task.payload ?? {}) as Record<string, unknown>;
    const url = String(payload["url"] ?? payload["target"] ?? payload["sourceUrl"] ?? "").trim();
    if (!url) {
      console.warn(`[Orchestrator] ${SCRAPE} task ${task.id} had no url — skipping.`);
      await this.swarm.submitProfile({
        kind: "scrape_result",
        taskId: task.id,
        status: "skipped",
        error: "task carried no url",
      });
      return { status: "skipped", detail: "task carried no url", reported: true };
    }

    const startedAt = Date.now();
    try {
      const result = await this.scraper.scrape(url);
      const durationMs = Date.now() - startedAt;
      await this.swarm.submitProfile({
        kind: "scrape_result",
        taskId: task.id,
        status: "success",
        url: result.url,
        title: result.title,
        text: result.text,
        chars: result.text.length,
        /*
          A cheap yield hint, not a verdict: how many lines look like a named
          place or carry coordinates. The Mothership can use it to decide whether
          the page is worth an `extract` task without downloading the text first.
        */
        placeCandidates: countPlaceCandidates(result.text),
        durationMs,
      });
      console.log(
        `[Orchestrator] ${SCRAPE} ${task.id} completed in ${durationMs}ms (${result.text.length} chars).`,
      );
      return {
        status: "success",
        detail: `scraped ${result.text.length} chars in ${durationMs}ms`,
        reported: true,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.swarm.submitProfile({
        kind: "scrape_result",
        taskId: task.id,
        status: "failed",
        url,
        error: message.split("\n")[0] ?? "scrape failed",
        durationMs: Date.now() - startedAt,
      });
      console.warn(`[Orchestrator] ${SCRAPE} ${task.id} failed — ${message.split("\n")[0]}`);
      return { status: "failure", detail: message.split("\n")[0] ?? "scrape failed", reported: true };
    }
  }

  /**
   * FORAGE — a heartbeat-pulled `forage_target` executed as priority work.
   *
   * THE PUSH HALF OF THE HANDSHAKE (epic §2): scrape with Playwright, extract
   * with local Ollama, then Push the learned fact back via `submitProfile`
   * (`/api/swarm/submit`) — and the forager's own learn path
   * (`/api/swarm/learn`) when the pass produces a discovery. `reported: true`
   * because this handler files its own result; the engine's generic
   * `task_result` would double-report the same task.
   *
   * Runs one forager pass with the Mothership's target pinned: when the
   * payload carries `forageTarget` (the heartbeat wrapper) it is forced as
   * the pass target; otherwise the forager picks its usual
   * Mothership-first/local-fallback target. The `swarm` dep the forager
   * already holds does the actual Push, so this handler only reports the
   * task-level outcome.
   */
  private async handleForageTask(task: SwarmTask): Promise<TaskOutcome> {
    const startedAt = Date.now();
    const payload = (task.payload ?? {}) as Record<string, unknown>;
    const pinned =
      payload["forageTarget"] && typeof payload["forageTarget"] === "object"
        ? (payload["forageTarget"] as Record<string, unknown>)
        : null;
    try {
      // A pinned target arrives as the raw Mothership object; normalise it
      // into the ForageTargetRow shape the pass expects (snake_case, one of
      // the three forage kinds — a directed verification is a stale place).
      const forcedTarget = pinned
        ? {
            kind: "stale_place" as const,
            url: String(pinned["url"] ?? pinned["sourceUrl"] ?? pinned["link"] ?? "") || null,
            label: String(pinned["label"] ?? pinned["name"] ?? pinned["title"] ?? task.id),
            place_id: typeof pinned["placeId"] === "string" ? (pinned["placeId"] as string) : typeof pinned["place_id"] === "string" ? (pinned["place_id"] as string) : null,
            lore_id: null,
            last_verified: null,
            raw_text: typeof pinned["text"] === "string" ? (pinned["text"] as string) : null,
          }
        : undefined;
      const outcome = await this.forager.runPass(this.buildPriorityProbe(), forcedTarget);
      const durationMs = Date.now() - startedAt;
      if (outcome.status === "preempted") {
        return { status: "skipped", detail: "preempted by newer priority work", reported: false };
      }
      if (outcome.status === "learned") {
        await this.swarm.submitProfile({
          kind: "forage_result",
          taskId: task.id,
          status: "success",
          target: outcome.target?.label ?? task.id,
          fed: outcome.fed,
          durationMs,
        });
        return { status: "success", detail: `foraged ${outcome.target?.label ?? task.id}`, reported: true };
      }
      // "skipped" (nothing to learn) still Pushes — the Mothership must see
      // the target was visited, or it hands it out again next heartbeat.
      await this.swarm.submitProfile({
        kind: "forage_result",
        taskId: task.id,
        status: "skipped",
        target: outcome.target?.label ?? task.id,
        detail: outcome.status,
        durationMs,
      });
      return { status: "skipped", detail: `forage pass ${outcome.status}`, reported: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.swarm.submitProfile({
        kind: "forage_result",
        taskId: task.id,
        status: "failed",
        error: message.split("\n")[0] ?? "forage failed",
        durationMs: Date.now() - startedAt,
      });
      console.warn(`[Orchestrator] FORAGE ${task.id} failed — ${message.split("\n")[0]}`);
      return { status: "failure", detail: message.split("\n")[0] ?? "forage failed", reported: true };
    }
  }

  /**
   * A never-yielding probe for priority FORAGE passes.
   *
   * The engine's own probe reports `shouldYield: true` while a priority task
   * is in flight — which is exactly when THIS handler runs. Reusing it would
   * make the pass instantly "preempt" itself. Priority work never yields to
   * itself, so the probe answers false and never interrupts; the abort signal
   * is omitted for the same reason.
   */
  /**
   * DEEP_RESEARCH — the Mothership's RAG task: fetch the sources, synthesise
   * them with the LOCAL model, file the answer as a `research_result`.
   *
   * WHY THIS IS A COMPOSITION AND NOT A NEW ENGINE. Both halves already exist and
   * are already governed: {@link ScraperService.scrape} is the same Playwright
   * path `scrape` and the idle forager use (Chromium bootstrap, Governor
   * browser-slot cap, 20k-character page cap), and `runLocalInference` is the
   * same dynamic-port Ollama call `ai_inference` and `llm_query` use. Deep
   * research is the RETRIEVE-then-GENERATE step that was missing between them, so
   * it is written as exactly that and nothing more.
   *
   * PAYLOAD SHAPES IT ACCEPTS. The Mothership queues this kind from four places
   * and they do not agree on keys, so the handler reads the union rather than one
   * caller's spelling:
   *
   *   member chat    `{ entity, entity_key, instruction, requestedBy }`
   *   place scrub    `{ name, place_id, instruction, system_prompt, context }`
   *   ripple/forage  `{ entity, instruction }`
   *   direct ask     `{ query | topic, url | urls[], prompt }`
   *
   * THE ANSWER'S SHAPE IS THE MOTHERSHIP'S, NOT OURS: `{ subject, facts: [{ fact,
   * category, confidence, sourceUrl }] }`, which is the return shape both the
   * member-chat instruction and the scrub's `return_shape` spell out. The prose
   * the model wrote travels beside it as `summary`, because the scrub's
   * deliverable IS prose and dropping it would make this handler useless to the
   * one caller that asked for text.
   *
   * AN EMPTY ANSWER IS A REAL ANSWER. A node that cannot ground a fact returns an
   * empty list instead of guessing, and that is filed as a success — the contract
   * the dispatch instruction states, and the reason this handler never
   * manufactures a fact to look productive.
   *
   * `reported: true` on every path: this handler files its own result and the
   * engine's generic `task_result` would double-report the same task.
   */
  private async handleDeepResearch(task: SwarmTask): Promise<TaskOutcome> {
    const payload = (task.payload ?? {}) as Record<string, unknown>;
    const subject =
      firstString(payload, ["entity", "subject", "name", "place", "query", "topic", "title"]) ?? task.id;
    const instruction = firstString(payload, ["instruction", "prompt", "task", "question"]);
    const systemPrompt = firstString(payload, ["system_prompt", "systemPrompt"]);
    const urls = collectResearchUrls(payload);
    const knownContext = collectResearchContext(payload);
    const startedAt = Date.now();

    /*
      NOTHING TO RESEARCH IS A SKIP, NOT A FAILURE. A payload that lost its
      subject, its instruction and its URLs is one this node cannot act on, and
      `skipped` retires it upstream instead of leaving it claimed. An id-only
      subject is the tell: no dispatcher sends a research task without naming what
      to research.
    */
    if (!instruction && urls.length === 0 && !knownContext.trim() && subject === task.id) {
      console.warn(
        `[Orchestrator] ${DEEP_RESEARCH} task ${task.id} carried no subject, instruction or url — skipping.`,
      );
      await this.swarm.submitProfile({
        kind: "research_result",
        taskId: task.id,
        status: "skipped",
        error: "task carried no subject, instruction or url",
      });
      return { status: "skipped", detail: "task carried no subject, instruction or url", reported: true };
    }

    try {
      /*
        RETRIEVE. Scrape failures are collected rather than thrown: a task with
        three URLs where one is dead still has two sources, and failing the whole
        job on the dead one would throw away work already done. The list travels
        upstream, so the Mothership can see which of ITS sources a node could not
        reach — the half it cannot observe any other way.
      */
      const sources: Array<{ url: string; title: string }> = [];
      const sourceBlocks: string[] = [];
      const failed: string[] = [];
      for (const url of urls) {
        try {
          const page = await this.scraper.scrape(url);
          sources.push({ url: page.url, title: page.title });
          sourceBlocks.push(`SOURCE: ${page.url}\n${page.title}\n${page.text}`);
        } catch (error) {
          failed.push(`${url} (${firstLineOf(error)})`);
        }
      }
      if (urls.length > 0 && sources.length === 0) {
        throw new Error(`every source failed to fetch: ${failed.join("; ")}`);
      }
      const sourcesText = sourceBlocks.join("\n\n").slice(0, MAX_RESEARCH_CORPUS_CHARS);

      // GENERATE — against the LOCAL model, over the pages this node just
      // fetched. The Mothership's own instruction wins when it sent one; the
      // model is never asked to invent its own brief.
      const inference = await runLocalInference({
        prompt: buildResearchPrompt({ subject, instruction, knownContext, sources: sourcesText }),
        system: systemPrompt ?? RESEARCH_SYSTEM_PROMPT,
      });
      const parsed = parseResearchOutput(inference.text, subject);

      /*
        THE EXTRACTION FALLBACK, for a model that answered in prose. Prose alone
        is not what the brain ingests, and `extractFacts` is this node's existing
        schema-validated `verified_knowledge` path (the forager and the ingestion
        engine both file through it), so ONE call over the sources recovers at
        least one groundable fact. It runs ONLY when the reply was not structured:
        a valid answer with an empty facts array is the model saying "nothing
        verifiable", and re-asking would be the node arguing with its own model.
      */
      let facts = parsed.facts;
      if (!parsed.structured && facts.length === 0 && sourcesText.trim()) {
        const extracted = await this.ollama.extractFacts(sourcesText);
        if (extracted) {
          facts = [
            {
              fact: extracted.fact_summary,
              category: extracted.category,
              confidence: extracted.confidence_score,
              sourceUrl: sources[0]?.url ?? null,
            },
          ];
        }
      }

      const durationMs = Date.now() - startedAt;
      await this.swarm.submitProfile({
        kind: "research_result",
        taskId: task.id,
        status: "success",
        subject: parsed.subject,
        facts,
        summary: parsed.summary,
        sources,
        // Omitted entirely when every source answered — an empty array would read
        // as "some source failed" to a human skimming the fleet log.
        ...(failed.length > 0 ? { failedSources: failed } : {}),
        model: inference.model,
        durationMs,
      });
      console.log(
        `[Orchestrator] ${DEEP_RESEARCH} ${task.id} completed in ${durationMs}ms — ` +
          `${facts.length} fact(s) from ${sources.length} source(s).`,
      );
      return {
        status: "success",
        detail: `researched ${parsed.subject} — ${facts.length} fact(s) from ${sources.length} source(s)`,
        reported: true,
      };
    } catch (error) {
      const detail = firstLineOf(error);
      await this.swarm.submitProfile({
        kind: "research_result",
        taskId: task.id,
        status: "failed",
        subject,
        error: detail || "deep research failed",
        durationMs: Date.now() - startedAt,
      });
      console.warn(`[Orchestrator] ${DEEP_RESEARCH} ${task.id} failed — ${detail}`);
      return { status: "failure", detail: detail || "deep research failed", reported: true };
    }
  }

  private buildPriorityProbe(): PreemptionProbe {
    return {
      shouldYield: () => false,
      waitForInterrupt: () => new Promise<void>(() => { /* never interrupts */ }),
      waitForResume: () => Promise.resolve(),
    };
  }
}

/*
  ── THE DEEP-RESEARCH HELPERS ────────────────────────────────────────────────

  Module-level and pure, so `handleDeepResearch` reads as a sequence of steps
  (resolve the subject, fetch, generate, file) rather than a nest of parsing.
  Nothing here touches the network, the model or the database.
*/

/**
 * HOW MANY SOURCE PAGES ONE RESEARCH TASK MAY FETCH.
 *
 * Three. Every scrape holds the Governor's browser slot for the length of a full
 * navigation and this node has exactly one browser, so a task that walked an
 * unbounded URL list would starve the `scrape` tasks the Mothership is waiting
 * on. Three is enough for a place (an official page, a forum thread, a mapping
 * site) and bounded enough to stay a sensor rather than a crawler.
 */
const MAX_RESEARCH_SOURCES = 3;

/** Ceiling on the fetched source text handed to the model, in characters. */
const MAX_RESEARCH_CORPUS_CHARS = 12_000;

/**
 * Ceiling on the context the Mothership already sent (a scrub's `known_facts`),
 * in characters. Smaller than the source budget on purpose: those facts are
 * already in the corpus upstream, and the model's job is to ADD to them.
 */
const MAX_RESEARCH_CONTEXT_CHARS = 4_000;

/**
 * Ceiling on facts per answer, matching the Mothership's own
 * `MAX_FACTS_PER_TASK`: the cloud truncates at 25, so anything past it would be
 * uploaded only to be discarded.
 */
const MAX_RESEARCH_FACTS = 25;

/** Ceiling on the prose half of an answer, so one rambling reply cannot bloat a profile. */
const MAX_RESEARCH_SUMMARY_CHARS = 8_000;

/**
 * ONE FACT, in the shape the Mothership's `deep_research` contract asks for.
 *
 * `fact` / `category` / `confidence` are the member-chat and scrub return shape
 * (`member-research.ts`, `place-scrub.ts`); `sourceUrl` is the scrub's extra
 * field, forwarded when the model cites one and otherwise filled from the page
 * the fact came out of. Both dispatchers are served by one answer, because the
 * node does not get to decide which of them is reading.
 */
export interface ResearchFact {
  fact: string;
  category: string;
  confidence: number;
  sourceUrl: string | null;
}

/**
 * THE SYSTEM PROMPT FOR A RESEARCH TASK.
 *
 * Both rules are about the one failure this handler could cause: an invented
 * fact landing in the corpus every member's answers are drawn from. So the model
 * is told to answer ONLY in the Mothership's JSON shape, to ground every fact in
 * a source it was handed, and that an EMPTY list is a valid answer — the same
 * three rules `buildDeepResearchInstruction` states on the dispatch side,
 * restated here because a node must not depend on the cloud's wording to stay
 * honest.
 */
const RESEARCH_SYSTEM_PROMPT =
  "You are Rippa AI, the research arm of the Rippa Adventures swarm. " +
  "You are given a subject and, usually, the text of source pages that were just fetched for you. " +
  "Return atomic, source-grounded facts about the subject. " +
  "Reply with ONLY a JSON object, no prose and no markdown fence: " +
  '{"subject": string, "facts": [{"fact": string, "category": string, "confidence": number, "sourceUrl": string|null}]}. ' +
  "Every fact MUST be stated in a source you were given, and `sourceUrl` must name it. " +
  "Never invent coordinates, elevations, access notes, hazards or place names, and never use your own general knowledge. " +
  "An empty facts array is a valid, honest answer when the sources do not support a fact.";

/** The first non-empty string among `keys`, trimmed, or null. */
function firstString(source: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

/**
 * EVERY SOURCE URL a research payload points at, deduped and capped.
 *
 * `url` / `sourceUrl` / `source_url` / `target` are the spellings the four
 * dispatchers use for one page, and `urls` is the list form a direct ask may
 * carry. `context.place` is deliberately NOT mined for a URL: a scrub names a
 * place rather than a page, and turning a name into a URL would be the node
 * guessing at a source. http(s) only — the scraper drives a browser, and a
 * `file:` or `data:` URL from a task payload is a request this node will not
 * honour.
 */
function collectResearchUrls(payload: Record<string, unknown>): string[] {
  const candidates: unknown[] = [
    payload["url"],
    payload["sourceUrl"],
    payload["source_url"],
    payload["target"],
    ...(Array.isArray(payload["urls"]) ? (payload["urls"] as unknown[]) : []),
  ];
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const url = candidate.trim();
    if (!url || seen.has(url) || !/^https?:\/\//i.test(url)) continue;
    seen.add(url);
    urls.push(url);
    if (urls.length >= MAX_RESEARCH_SOURCES) break;
  }
  return urls;
}

/**
 * The text a research payload ALREADY carries, as one labelled block.
 *
 * A scrub hands the node `context.known_facts` — what the mesh already verified —
 * and a direct ask may inline `text` / `raw_text` for a page the Mothership
 * fetched itself. Both are labelled, because the instruction tells the model not
 * to re-derive what it was handed.
 */
function collectResearchContext(payload: Record<string, unknown>): string {
  const blocks: string[] = [];
  const rawContext = payload["context"];
  const context =
    rawContext && typeof rawContext === "object" ? (rawContext as Record<string, unknown>) : null;
  const known = Array.isArray(context?.["known_facts"]) ? (context["known_facts"] as unknown[]) : [];
  const facts = known
    .filter((fact): fact is string => typeof fact === "string" && !!fact.trim())
    .map((fact) => `  - ${fact.trim()}`);
  if (facts.length > 0) blocks.push(`FACTS THE MESH ALREADY HOLDS:\n${facts.join("\n")}`);
  for (const key of ["text", "raw_text", "rawText", "content"]) {
    const value = payload[key];
    if (typeof value === "string" && value.trim()) blocks.push(value.trim());
  }
  return blocks.join("\n\n").slice(0, MAX_RESEARCH_CONTEXT_CHARS);
}

/** Best-effort extraction of the first balanced JSON object in a string. */
function extractJsonObject(content: string): string | null {
  const unfenced = content.replace(/```(?:json)?/gi, "").trim();
  const start = unfenced.indexOf("{");
  const end = unfenced.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  return unfenced.slice(start, end + 1);
}

/**
 * ONE fact from the model, normalised — or null when the entry says nothing.
 *
 * Both dispatchers' field names are accepted (`fact` from the member chat and the
 * scrub, `fact_summary` from this node's own `verified_knowledge` shape, which is
 * what the extraction fallback returns), and confidence is normalised to 0–1
 * exactly as `parseFactPayload` does: a model that answers `85` means eighty-five
 * percent. A missing confidence becomes the neutral 0.5 rather than dropping an
 * otherwise grounded fact — the field is required upstream, and a fact with no
 * number is still a fact the model read in a source.
 */
function normaliseResearchFact(candidate: unknown, sourceUrl: string | null): ResearchFact | null {
  if (!candidate || typeof candidate !== "object") return null;
  const row = candidate as Record<string, unknown>;
  const text = firstString(row, ["fact", "fact_summary", "summary", "text", "statement"]);
  if (!text) return null;
  const raw = row["confidence"] ?? row["confidence_score"] ?? row["score"];
  let confidence = typeof raw === "number" && Number.isFinite(raw) ? raw : 0.5;
  if (confidence > 1 && confidence <= 100) confidence /= 100;
  const cited = firstString(row, ["sourceUrl", "source_url", "url"]);
  return {
    fact: text.slice(0, 1_000),
    category: (firstString(row, ["category", "type", "kind"]) ?? "description").slice(0, 80),
    confidence: Math.max(0, Math.min(1, confidence)),
    sourceUrl: cited && /^https?:\/\//i.test(cited) ? cited : sourceUrl,
  };
}

/**
 * PARSES THE MODEL'S ANSWER into the Mothership's return shape.
 *
 * TOLERANT, because a local 7B model returns JSON most of the time, JSON wrapped
 * in commentary some of the time, and plain prose the rest. The first JSON object
 * in the reply is tried; unusable fact entries are dropped rather than failing the
 * whole answer; and a reply with no JSON at all comes back as `structured: false`
 * with the prose as `summary`, which is the signal the caller uses to reach for
 * the strict extraction path. Nothing here invents a fact to fill an empty array —
 * an empty answer is a valid one.
 */
function parseResearchOutput(
  content: string,
  fallbackSubject: string,
): { subject: string; facts: ResearchFact[]; summary: string; structured: boolean } {
  const candidate = extractJsonObject(content);
  if (candidate) {
    try {
      const decoded = JSON.parse(candidate) as unknown;
      const record: Record<string, unknown> | null = Array.isArray(decoded)
        ? { facts: decoded }
        : decoded && typeof decoded === "object"
          ? (decoded as Record<string, unknown>)
          : null;
      if (record) {
        const rows = Array.isArray(record["facts"]) ? (record["facts"] as unknown[]) : [];
        const facts: ResearchFact[] = [];
        const seen = new Set<string>();
        for (const row of rows) {
          const fact = normaliseResearchFact(row, null);
          if (!fact) continue;
          const key = fact.fact.toLowerCase();
          if (seen.has(key)) continue;
          seen.add(key);
          facts.push(fact);
          if (facts.length >= MAX_RESEARCH_FACTS) break;
        }
        return {
          subject: firstString(record, ["subject", "entity", "name", "title"]) ?? fallbackSubject,
          facts,
          summary: (firstString(record, ["description", "summary", "prose", "answer"]) ?? "").slice(
            0,
            MAX_RESEARCH_SUMMARY_CHARS,
          ),
          structured: true,
        };
      }
    } catch {
      // The reply was not JSON. The prose reading below is the honest one.
    }
  }
  return {
    subject: fallbackSubject,
    facts: [],
    summary: content.trim().slice(0, MAX_RESEARCH_SUMMARY_CHARS),
    structured: false,
  };
}

/**
 * THE RESEARCH PROMPT — the Mothership's brief when it sent one, plus the material
 * the node actually has.
 *
 * The instruction is used VERBATIM when present: it carries the caller's rules
 * (the scrub's metric-and-travel-time contract, the member chat's
 * atomic-facts-only rule), and paraphrasing it here would silently drop whichever
 * rule the node's author did not know about. With no instruction the fallback
 * restates the dispatch contract rather than leaving the model to guess what
 * "deep research" means.
 *
 * The NO SOURCE branch is the important one: a task with no fetched page is told
 * plainly that it has nothing to ground a fact in, because the alternative — an
 * empty source block the model fills from memory — is exactly how an invented
 * location reaches the corpus.
 */
function buildResearchPrompt(input: {
  subject: string;
  instruction: string | null;
  knownContext: string;
  sources: string;
}): string {
  const brief =
    input.instruction ??
    `Research the Australian outdoor location "${input.subject}" (official park and water-authority ` +
      `pages, trail and 4WD forums, mapping sites) and return atomic, source-grounded facts. ` +
      `Coordinates, elevation, access notes and hazards must be stated in a source you actually read — ` +
      `never invented. If the location cannot be verified, return an empty facts list rather than guessing.`;
  const parts = [brief, "", `SUBJECT: ${input.subject}`];
  if (input.knownContext.trim()) parts.push("", input.knownContext.trim());
  if (input.sources.trim()) {
    parts.push(
      "",
      "SOURCE PAGES FETCHED FOR THIS TASK (every fact must be stated in one of these):",
      input.sources.trim(),
    );
  } else {
    parts.push(
      "",
      "NO SOURCE PAGE WAS FETCHED FOR THIS TASK. You have nothing to ground a fact in: return an empty facts list.",
    );
  }
  return parts.join("\n");
}

/** The first line of an error — a stack trace is not something to file upstream. */
function firstLineOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split("\n")[0] ?? "";
}

/** Reads a finite number from an untrusted task payload, else uses `fallback`. */
function numberOr(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
