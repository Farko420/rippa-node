import axios, { type AxiosInstance } from "axios";
import { schedule, type ScheduledTask } from "node-cron";
import { env } from "../config";
import { currentNodeIdentity } from "../config/nodeAuth";
import {
  buildHeartbeatTelemetry,
  executePendingCommands,
  parsePendingCommands,
  type CommandHandlers,
  type EfficiencyInput,
} from "../services/heartbeat";

/**
 * SWARM CLIENT â€” secure connection between this node and the Cloudflare Mothership.
 * Every request carries `NODE_API_KEY` as a Bearer token.
 */

export type NodeStatus = "idle" | "busy" | "working";

/**
 * Snake_case field names are part of the Mothership's wire contract.
 *
 * `status` is deliberately three-valued. "busy" is a coarse "something is
 * happening"; "working" means a specific claimed task is in flight, and it is
 * what tells the Mothership's queue that this node has ACCEPTED a task rather
 * than merely being reachable. Without a distinct claimed state the cloud cannot
 * tell "still deciding" from "never saw it", which is precisely why pending tasks
 * used to sit unclaimed.
 */
export interface HeartbeatPayload {
  nodeName: string;
  role: "master" | "satellite";
  status: NodeStatus;
  timestamp: string;
  /** CPU load 0-100 across all cores. */
  cpu_usage: number;
  /** Physical memory in use, 0-100. */
  ram_usage: number;
  /** Free physical memory in bytes. */
  ram_free_bytes: number;
  /** Total physical memory in bytes. */
  ram_total_bytes: number;
  /** Host uptime in seconds. */
  system_uptime_seconds: number;
  /** Logical CPU core count. */
  cpu_cores: number;
  /** This process's RSS in bytes (what Task Manager shows). */
  process_memory_bytes: number;
  /** The task in flight, or null when idle. */
  current_process: ReturnType<typeof buildHeartbeatTelemetry>["current_process"];
  /** 0-100 from successful/total task attempts. */
  efficiency_score: number;
  /** Node codes currently linked peer-to-peer. */
  connected_satellites: string[];
}

export interface SwarmTask {
  id: string;
  type: string;
  payload?: Record<string, unknown>;
  /**
   * Queue state from the Mothership, when it sends one. Only "pending"-shaped
   * tasks are claimable; a task the cloud has already retired is not work.
   */
  status?: string;
}

/** A claimed task, plus whether the Mothership acknowledged the claim. */
export interface ClaimedTask {
  task: SwarmTask;
  /** True when the cloud confirmed the claim, or sent no claim route at all. */
  acknowledged: boolean;
}

/** What `/api/node/latest-version` reports back to the swarm. */
export interface LatestVersionInfo {
  version: string;
  downloadUrl: string;
  /** Optional hex SHA-256 of the executable; verified when present. */
  sha256?: string;
  notes?: string;
}

/**
 * Invoked when the Mothership advertises a newer build â€” either through the
 * heartbeat response or {@link SwarmClient.fetchLatestVersion}. Owned by the
 * OtaUpdater, which performs the actual update.
 */
export type UpdateSignalHandler = (info: LatestVersionInfo) => void;

/**
 * Invoked the moment the Mothership hands this node work, on whichever channel
 * delivered it first (the 15s poll or a heartbeat reply). Owned by the task
 * engine, which uses it to preempt the idle forager.
 */
export type TaskDispatchHandler = (tasks: SwarmTask[]) => void;

/**
 * THE QUARANTINE INGESTION ROUTE — where an autonomous discovery is filed for
 * review by the Mothership rather than trusted into `verified_knowledge`.
 */
export const FORAGE_QUARANTINE_PATH = "/api/brain/quarantine";

/**
 * Where discoveries go once the Mothership has answered 404 on the route above.
 * Every deployment already accepts `/api/swarm/submit`, so this is a floor that
 * keeps a newer node useful against an older cloud rather than a silent loss.
 */
export const FORAGE_FALLBACK_PATH = "/api/swarm/submit";

/**
 * One autonomous discovery, shaped for the Mothership's quarantine intake.
 *
 * Field names are snake_case because this crosses the wire — see the note on
 * {@link HeartbeatPayload}.
 */
export interface ForageDiscoveryPayload {
  /** Stable `RIPPA-XXXX-XXXX` identity, so the cloud can attribute the find. */
  nodeCode: string;
  /** ISO timestamp the fact was learned. */
  discoveredAt: string;
  /** Which gap this closed: `stale_place` | `unverified_lore` | `incomplete_place`. */
  targetKind: string;
  /** Human-readable name of the thing that was learned about. */
  targetLabel: string;
  /** The page the evidence came from, when there was one. */
  sourceUrl: string | null;
  /** The mirrored place this updates, when it updates one. */
  placeId: string | null;
  /** Local `raw_lore` row holding the scraped evidence. */
  loreId: number | null;
  /** `location` | `rule` | `hazard` | `description`. */
  category: string;
  /** The extracted sentence. */
  factSummary: string;
  /** 0-1, exactly as the local model scored it. */
  confidence: number;
  /** "lat, lon" when the page identifies a place, else null. */
  coordinates: string | null;
  /** True when this passed the confidence gate locally. */
  promoted: boolean;
}

/**
 * Backoff for a failing task endpoint.
 *
 * The orchestrator polls `/api/swarm/tasks` every 15s. A Mothership that
 * answers 500 therefore produced four error lines a minute, indefinitely, which
 * buried the rest of the log while also hammering an already-struggling server.
 * The first 5xx arms a 60s cooldown, and each consecutive failure doubles it up
 * to {@link TASK_FETCH_BACKOFF_MAX_MS}.
 */
/** Cooldown after the first consecutive 5xx. */
const TASK_FETCH_BACKOFF_BASE_MS = 60_000;
/** Ceiling for the doubling backoff â€” beyond this it just stays put. */
const TASK_FETCH_BACKOFF_MAX_MS = 15 * 60_000;

export class SwarmClient {
  private readonly client: AxiosInstance;
  private heartbeatTask: ScheduledTask | null = null;
  private status: NodeStatus = "idle";
  private updateSignal: UpdateSignalHandler | null = null;
  /** Fired when the Mothership pushes work down the heartbeat channel. */
  private taskDispatch: TaskDispatchHandler | null = null;
  /**
   * Set once the Mothership has answered 404/405 on the quarantine route, after
   * which discoveries go straight to {@link FORAGE_FALLBACK_PATH}. See
   * {@link SwarmClient.pushForageDiscovery}.
   */
  private quarantineUnsupported = false;

  /**
   * Node codes currently linked peer-to-peer, reported as `connected_satellites`.
   * Supplied by the host (the swarm registry owns the truth).
   */
  private connectedSatellites: () => string[] = () => [];
  /** The host's own task counters, reported as `efficiency_score`. */
  private efficiency: () => EfficiencyInput = () => ({ succeeded: 0, total: 0 });
  /** Remote-command executor hooks, supplied by the host. */
  private commandHandlers: CommandHandlers | null = null;

  /*
    TASK-FETCH BACKOFF STATE (see fetchTasks).

    `taskFetchBlockedUntil` is an absolute timestamp, not a timer handle: a
    sleeping laptop must still honour the cooldown when it wakes, and an
    in-memory setTimeout would have silently expired across the sleep.
  */
  /** Timestamp before which fetchTasks() short-circuits without a request. */
  private taskFetchBlockedUntil = 0;
  /** Consecutive 5xx responses â€” drives the doubling backoff. */
  private taskFetchBackoffAttempts = 0;
  /** Last logged failure signature, so identical repeats stay quiet. */
  private logTaskFetchFailure = "";

  constructor() {
    this.client = axios.create({
      baseURL: env.MOTHERSHIP_URL,
      timeout: 10_000,
      headers: {
        "Content-Type": "application/json",
        "X-Node-Name": env.NODE_NAME,
      },
    });

    // Securely attach the node's API key to every outgoing request.
    this.client.interceptors.request.use((config) => {
      config.headers.Authorization = `Bearer ${env.NODE_API_KEY}`;
      return config;
    });
  }

  getStatus(): NodeStatus {
    return this.status;
  }

  setStatus(status: NodeStatus): void {
    this.status = status;
  }

  /** POSTs the node's status to the Mothership every 30 seconds. */
  startHeartbeat(): void {
    if (this.heartbeatTask) {
      return;
    }

    this.heartbeatTask = schedule(
      "*/30 * * * * *", // every 30 seconds (6-field expression with seconds)
      () => {
        void this.sendHeartbeat();
      },
      { name: "mothership-heartbeat" },
    );

    // Send one immediately so the Mothership sees this node right away.
    void this.sendHeartbeat();
    console.log("[Swarm] Heartbeat started â€” POST /api/swarm/heartbeat every 30s");
  }

  stopHeartbeat(): void {
    if (this.heartbeatTask) {
      this.heartbeatTask.stop();
      this.heartbeatTask = null;
      console.log("[Swarm] Heartbeat stopped.");
    }
  }

  /**
   * Supplies the telemetry sources the heartbeat payload needs.
   *
   * Wired by index.ts once the dispatcher is up, so `SwarmClient` stays free of
   * any dependency on the swarm registry.
   */
  setTelemetrySources(sources: {
    connectedSatellites?: () => string[];
    efficiency?: () => EfficiencyInput;
    commandHandlers?: CommandHandlers;
  }): void {
    if (sources.connectedSatellites) this.connectedSatellites = sources.connectedSatellites;
    if (sources.efficiency) this.efficiency = sources.efficiency;
    if (sources.commandHandlers) this.commandHandlers = sources.commandHandlers;
  }

  async sendHeartbeat(): Promise<void> {
    // Snapshot every provider before awaiting, so a provider that throws cannot
    // prevent the heartbeat from being sent at all.
    let connectedSatellites: string[] = [];
    let efficiency: EfficiencyInput = { succeeded: 0, total: 0 };
    try {
      connectedSatellites = this.connectedSatellites() ?? [];
    } catch {
      /* provider unavailable â€” report an empty list */
    }
    try {
      efficiency = this.efficiency() ?? { succeeded: 0, total: 0 };
    } catch {
      /* provider unavailable â€” fall back to the neutral default */
    }

    const payload: HeartbeatPayload = {
      nodeName: env.NODE_NAME,
      role: env.NODE_ROLE,
      status: this.status,
      timestamp: new Date().toISOString(),
      ...buildHeartbeatTelemetry(connectedSatellites, efficiency),
    };

    try {
      const { data } = await this.client.post("/api/swarm/heartbeat", payload);
      console.log(
        `[Swarm] Heartbeat sent (status: ${this.status}, cpu ${payload.cpu_usage}%, ` +
          `ram ${payload.ram_usage}%, efficiency ${payload.efficiency_score}%)`,
      );
      // The Mothership can piggyback an update notice on the heartbeat reply,
      // which is how a pushed release reaches the swarm within seconds.
      const advertised = parseLatestVersion(data);
      if (advertised) {
        console.log(`[Swarm] Mothership advertises version ${advertised.version}.`);
        this.updateSignal?.(advertised);
      }

      // Remote command queue. Executed AFTER the update signal so an advertised
      // release and a FORCE_UPDATE cannot both start two competing downloads.
      const commands = parsePendingCommands(data);
      if (commands.length > 0) {
        if (!this.commandHandlers) {
          console.warn(
            "[Swarm] Mothership sent pending commands but no handler is wired â€” ignoring.",
          );
        } else {
          const executed = await executePendingCommands(commands, this.commandHandlers);
          if (executed.length > 0) {
            console.log(`[Swarm] Executed remote command(s): ${executed.join(", ")}.`);
          }
        }
      }

      /*
        WORK PUSHED DOWN THE HEARTBEAT. Checked last so a release advertisement
        and a forced update are never delayed behind a task dispatch, and
        dispatched fire-and-forget so a handler that throws cannot retroactively
        mark this heartbeat as failed.
      */
      const pushed = parseTaskPayload(data);
      if (pushed.length > 0 && this.taskDispatch) {
        console.log(`[Swarm] Heartbeat carried ${pushed.length} task(s) — dispatching now.`);
        try {
          this.taskDispatch(pushed);
        } catch (error) {
          console.warn(`[Swarm] Task dispatch handler failed — ${describeError(error)}`);
        }
      }
    } catch (error) {
      console.warn(`[Swarm] Heartbeat failed â€” ${describeError(error)}`);
    }
  }

  /** Registers the handler fired when a newer version is advertised. */
  setUpdateSignalHandler(handler: UpdateSignalHandler | null): void {
    this.updateSignal = handler;
  }

  /**
   * Registers the handler fired when a heartbeat reply carries queued work.
   *
   * WHY THIS EXISTS ALONGSIDE `fetchTasks`. The 15-second task poll is the
   * guaranteed floor on latency, but a heartbeat fires on its own schedule and
   * a Mothership that pushes a task down the same socket deserves to have it
   * noticed on the heartbeat rather than up to 15 seconds later. That is the
   * difference between "instantly preempts" and "eventually preempts".
   *
   * The handler is only ever handed ALREADY-VALIDATED task shapes, and the
   * dispatch itself is fire-and-forget: a throwing handler must not turn a
   * successful heartbeat into a reported failure.
   */
  setTaskDispatchHandler(handler: TaskDispatchHandler | null): void {
    this.taskDispatch = handler;
  }

  /**
   * Asks the Mothership for the newest published build. Returns `null` when
   * the endpoint is unreachable or the payload is unusable â€” the caller then
   * simply stays on the current version.
   */
  async fetchLatestVersion(): Promise<LatestVersionInfo | null> {
    try {
      const { data } = await this.client.get("/api/node/latest-version");
      const info = parseLatestVersion(data);
      if (!info) {
        console.warn("[Swarm] /api/node/latest-version returned an unusable payload.");
      }
      return info;
    } catch (error) {
      console.warn(`[Swarm] Version check failed â€” ${describeError(error)}`);
      return null;
    }
  }

  /**
   * CLAIMS a task with the Mothership and flips this node to "working".
   *
   * WHY AN EXPLICIT CLAIM. Fetching a task and executing it is not enough: while
   * the node was deciding what to do, the cloud still considered the task
   * unassigned and could hand the same work to every other node in the fleet.
   * The claim is what makes the queue single-owner, and it is what flips the
   * heartbeat `status` to "working" so the cloud can see the node took it.
   *
   * FAILS OPEN, ON PURPOSE. A Mothership with no claim route answers 404, and a
   * node that treated that as a hard error would refuse to run any task at all —
   * exactly the "nodes are ignoring the queue" symptom this replaces. So an
   * absent claim endpoint is reported as `acknowledged: false` and the task still
   * executes; only a genuine transport failure on a route that DOES exist is
   * surfaced. The work is never withheld over bookkeeping.
   */
  async claimTask(task: SwarmTask): Promise<ClaimedTask> {
    this.setStatus("working");
    if (!task?.id) return { task, acknowledged: false };

    try {
      await this.client.post("/api/swarm/tasks/claim", {
        taskId: task.id,
        nodeCode: currentNodeIdentity()?.code ?? env.NODE_NAME,
        nodeName: env.NODE_NAME,
        claimedAt: new Date().toISOString(),
      });
      console.log(`[Swarm] Claimed task ${task.id} (${task.type}).`);
      return { task, acknowledged: true };
    } catch (error) {
      const status = axios.isAxiosError(error) ? error.response?.status : undefined;
      if (status === 404 || status === 405 || status === 501) {
        // No claim route on this deployment — older cloud, not a failure.
        console.log(
          `[Swarm] Mothership has no task-claim route; executing ${task.id} unclaimed.`,
        );
        return { task, acknowledged: false };
      }
      console.warn(
        `[Swarm] Claim for task ${task.id} failed — ${describeError(error)} ` +
          "(executing anyway; the task will be reported on completion)",
      );
      return { task, acknowledged: false };
    }
  }

  /**
   * Releases a claim without reporting a result.
   *
   * Used when a claimed task turns out to be unrunnable on this node, so the
   * cloud can re-queue it immediately instead of waiting for a result that will
   * never arrive.
   */
  async releaseTask(task: SwarmTask, reason: string): Promise<void> {
    try {
      await this.client.post(`/api/swarm/tasks/${encodeURIComponent(task.id)}/release`, {
        nodeName: env.NODE_NAME,
        reason,
      });
      console.log(`[Swarm] Released task ${task.id} — ${reason}`);
    } catch (error) {
      // Best-effort: a cloud without a release route simply re-queues on its own
      // timeout, so this must never block the node's next task.
      console.warn(`[Swarm] Release of task ${task.id} failed — ${describeError(error)}`);
    }
  }

  /** Fetches pending tasks from the Mothership. Returns `[]` when unreachable. */
  async fetchTasks(): Promise<SwarmTask[]> {
    // BACKOFF GATE â€” see TASK_FETCH_BACKOFF_BASE_MS. A 5xx arms a cooldown and
    // every call inside it returns immediately WITHOUT touching the network,
    // which is what actually stops the spam (logging alone would not).
    if (this.taskFetchBlockedUntil > Date.now()) {
      return [];
    }

    try {
      const { data } = await this.client.get("/api/swarm/tasks");
      // A success clears the penalty, so one blip never leaves a node throttled
      // for the rest of the process's life.
      this.taskFetchBlockedUntil = 0;
      this.taskFetchBackoffAttempts = 0;
      this.logTaskFetchFailure = "";
      if (Array.isArray(data)) {
        return data as SwarmTask[];
      }
      // Same envelope-tolerance as the heartbeat path. This used to read only
      // `data.tasks`, so a Mothership answering `{ pending_tasks: [...] }` or
      // `{ data: { tasks: [...] } }` produced an empty list and the node looked
      // idle while the queue was full — the reported "nodes ignore tasks" bug.
      return parseTaskPayload(data);
    } catch (error) {
      this.reportTaskFetchFailure(error);
      return [];
    }
  }

  /**
   * Records and reports a failed task fetch.
   *
   * The response BODY is the whole point: a 500 from the Mothership almost
   * always carries a reason ("Database connection refused", a missing table, an
   * auth rejection) that the bare axios message ("Request failed with status
   * code 500") discards. Without it the terminal showed only THAT a 500
   * happened, never why — which is what made these failures undiagnosable from
   * the node.
   *
   * WHAT ARMS THE BACKOFF: 5xx responses AND transport failures (connection
   * refused, DNS, timeout — anything with no HTTP status at all). Both are
   * retry-idempotent and both keep failing for as long as the Mothership is
   * down, so both would otherwise log a line every 15s indefinitely.
   *
   * 4xx deliberately does NOT: a rejected key or a wrong route is a permanent
   * misconfiguration that waiting cannot fix, and burying it behind a 15-minute
   * silence would hide a real error the operator must act on.
   */
  private reportTaskFetchFailure(error: unknown): void {
    const status = axios.isAxiosError(error) ? error.response?.status : undefined;
    const retryable = status === undefined || status >= 500;

    if (retryable) {
      this.taskFetchBackoffAttempts += 1;
      const waitMs = Math.min(
        TASK_FETCH_BACKOFF_BASE_MS * 2 ** (this.taskFetchBackoffAttempts - 1),
        TASK_FETCH_BACKOFF_MAX_MS,
      );
      this.taskFetchBlockedUntil = Date.now() + waitMs;

      // Log only when the failure CHANGES. Identical consecutive failures are
      // precisely the spam this mechanism exists to stop, so they are collapsed
      // to a single line; the countdown below reports the state instead.
      const detail = describeResponseBody(error);
      const label = status === undefined ? "no response" : `HTTP ${status}`;
      const signature = `${label}:${detail}`;
      if (signature !== this.logTaskFetchFailure) {
        this.logTaskFetchFailure = signature;
        console.warn(
          `[Swarm] Failed to fetch tasks — ${label}` +
            (detail ? ` — Mothership said: ${detail}` : "") +
            `. Backing off ${Math.round(waitMs / 1000)}s.`,
        );
      } else {
        console.log(
          `[Swarm] Task fetch still backing off — retry in ` +
            `${Math.ceil((this.taskFetchBlockedUntil - Date.now()) / 1000)}s.`,
        );
      }
      return;
    }

    console.warn(`[Swarm] Failed to fetch tasks — ${describeError(error)}`);
  }

  /** Submits a completed JSON profile back to the Mothership. */
  async submitProfile(profile: Record<string, unknown>): Promise<boolean> {
    try {
      await this.client.post("/api/swarm/submit", profile);
      console.log("[Swarm] Profile submitted to /api/swarm/submit");
      return true;
    } catch (error) {
      console.warn(`[Swarm] Profile submission failed â€” ${describeError(error)}`);
      return false;
    }
  }

  /**
   * PUSHES AN AUTONOMOUS DISCOVERY UPSTREAM — the idle tier's feedback line.
   *
   * WHY IMMEDIATE RATHER THAN QUEUED. A discovery is only worth anything to the
   * fleet while it is still new; the 10-minute trickle in SyncManager exists to
   * make cloud costs predictable, which is the right trade for routine verified
   * facts and the wrong one for "this page says the creek is closed and nobody
   * else knows yet". Foraging therefore pushes the moment it learns something.
   *
   * WHY A FALLBACK. The quarantine route is the intended home, but a Mothership
   * that has not shipped it answers 404/405, and a forager that only logged a
   * warning would drop every discovery it ever made. On the first such answer
   * the client permanently switches to `/api/swarm/submit`, which every
   * deployment already accepts — and records that it did so, so a missing
   * endpoint cannot become one failed request per discovery, forever.
   *
   * The node's id and api key travel in the body as well as the Authorization
   * header, because the Mothership attributes a quarantine record to the node
   * that found it.
   */
  async pushForageDiscovery(payload: ForageDiscoveryPayload): Promise<boolean> {
    const body = {
      ...payload,
      nodeId: env.NODE_NAME,
      role: env.NODE_ROLE,
      apiKey: env.NODE_API_KEY,
      mothershipUrl: env.MOTHERSHIP_URL,
    };
    const route = this.quarantineUnsupported ? FORAGE_FALLBACK_PATH : FORAGE_QUARANTINE_PATH;

    try {
      await this.client.post(route, body);
      console.log(
        `[Swarm] Discovery fed upstream via ${route} — ` +
          `${payload.targetKind} "${payload.targetLabel}".`,
      );
      return true;
    } catch (error) {
      const status = axios.isAxiosError(error) ? error.response?.status : undefined;
      if (route === FORAGE_QUARANTINE_PATH && (status === 404 || status === 405)) {
        // Remember the downgrade so the next discovery goes straight to the
        // endpoint that works instead of re-probing one that does not exist.
        this.quarantineUnsupported = true;
        console.warn(
          `[Swarm] Mothership has no ${FORAGE_QUARANTINE_PATH} (HTTP ${status}) — ` +
            `feeding discoveries to ${FORAGE_FALLBACK_PATH} instead.`,
        );
        return this.pushForageDiscovery(payload);
      }
      console.warn(`[Swarm] Discovery feed failed — ${describeError(error)}`);
      return false;
    }
  }

  /**
   * Asks the Mothership to generate a patch, used when the node has no usable
   * local model. Returns "" when the endpoint is absent or fails â€” the caller
   * then reports the original failure rather than stalling.
   */
  async requestSkillPatch(systemPrompt: string, userPrompt: string): Promise<string> {
    try {
      const { data } = await this.client.post("/api/skills/patch", {
        systemPrompt,
        userPrompt,
      });
      const body = (data ?? {}) as { patch?: string; code?: string; result?: string };
      return String(body.patch ?? body.code ?? body.result ?? "");
    } catch (error) {
      console.warn(`[Swarm] Cloud patch request failed â€” ${describeError(error)}`);
      return "";
    }
  }

  /**
   * Asks the Mothership for brain records changed since `since`.
   *
   * Returns the delta payload unchanged, or `null` when the endpoint is absent,
   * errors, or answers with something that is not an object. `null` is
   * deliberately indistinguishable from "nothing changed" at the call site in
   * most cases â€” a delta-sync service that has never run and one that just found
   * no changes should both simply do nothing, and neither should ever be able to
   * damage the local mirror. The cursor is only advanced by a successful apply.
   */
  async fetchBrainDelta(since: string | null): Promise<Record<string, unknown> | null> {
    try {
      const { data } = await this.client.get("/api/brain/delta", {
        params: since ? { since } : {},
      });
      if (!data || typeof data !== "object" || Array.isArray(data)) {
        console.warn("[Swarm] /api/brain/delta returned an unusable payload.");
        return null;
      }
      return data as Record<string, unknown>;
    } catch (error) {
      // 404 is the normal state until the Mothership ships the endpoint; it
      // must not spam the log every 12 hours as an error.
      console.warn(`[Swarm] Brain delta fetch failed â€” ${describeError(error)}`);
      return null;
    }
  }

  /**
   * Registers this node as an `AI_CAPABLE_NODE` with the Mothership.
   *
   * Sent when local-model discovery changes state, so the cloud can route heavy
   * work (HTMLâ†’JSON structuring, review summarising) to this node's GPU
   * instead of spending API credits.
   */
  async registerAiCapability(payload: {
    aiCapable: boolean;
    url?: string;
    models?: string[];
    preferredModel?: string;
  }): Promise<boolean> {
    try {
      await this.client.post("/api/swarm/capabilities", payload);
      console.log(
        `[Swarm] Registered as ${payload.aiCapable ? "AI_CAPABLE_NODE" : "standard node"}` +
          (payload.preferredModel ? ` (${payload.preferredModel})` : ""),
      );
      return true;
    } catch (error) {
      // A Mothership without this endpoint is fine â€” the node just stays a
      // standard worker.
      console.warn(`[Swarm] Capability registration failed â€” ${describeError(error)}`);
      return false;
    }
  }
}

function describeError(error: unknown): string {
  if (axios.isAxiosError(error)) {
    const status = error.response?.status;
    return status ? `HTTP ${status} â€” ${error.message}` : error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * Pulls the human-readable reason out of a failed HTTP response body.
 *
 * WHY THIS EXISTS: axios's `error.message` is always the same unhelpful
 * "Request failed with status code 500" regardless of cause, so every 500 from
 * the Mothership looked identical in the log. `error.response.data` is where the
 * actual explanation lives â€” a JSON `{ error }` / `{ message }` envelope, or a
 * plain-text stack from a crashed handler.
 *
 * Handles the three shapes an Express upstream realistically returns (JSON
 * object, JSON string, raw text) and truncates the result, because a returned
 * HTML error page or a full stack trace would otherwise flood the terminal
 * just as badly as the repeating 500 line did.
 */
function describeResponseBody(error: unknown, maxChars = 300): string {
  if (!axios.isAxiosError(error)) return "";
  const data = error.response?.data as unknown;
  if (typeof data === "string") return data.trim().slice(0, maxChars);
  if (data && typeof data === "object") {
    const record = data as Record<string, unknown>;
    // Prefer a named reason over a raw dump, in the order an Express error
    // handler is most likely to have used.
    for (const key of ["message", "error", "detail", "reason"]) {
      const value = record[key];
      if (typeof value === "string" && value.trim()) return value.trim().slice(0, maxChars);
    }
    try {
      return JSON.stringify(record).slice(0, maxChars);
    } catch {
      /* a circular or exotic payload â€” nothing useful to print */
    }
  }
  return "";
}

/** First non-empty string found under any of `keys` in `source`. */
function firstString(source: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

/**
 * Extracts queued work from a heartbeat reply.
 *
 * Tolerates the shapes a Mothership may realistically use: a bare array, or an
 * envelope under `tasks` / `pending_tasks` / `queue`. Entries without an `id`
 * are dropped — a task the node cannot report a result against is a task it
 * cannot acknowledge, and acknowledging it would corrupt the fleet's view of
 * what is still outstanding.
 *
 * STATUS IS CARRIED, AND TERMINAL STATES ARE FILTERED. The cloud may hand back
 * the whole queue including work that is already done, in flight elsewhere, or
 * failed. Executing one of those re-does work for free at best and corrupts the
 * fleet's counts at worst, so only tasks that are pending (or that carry no
 * status at all, which is what an older deployment sends) reach the engine.
 */
function parseTaskPayload(payload: unknown): SwarmTask[] {
  if (!payload || typeof payload !== "object") return [];
  const root = payload as Record<string, unknown>;
  const raw = Array.isArray(root) ? root : (root["tasks"] ?? root["pending_tasks"] ?? root["queue"]);
  if (!Array.isArray(raw)) return [];

  const tasks: SwarmTask[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const id = firstString(record, ["id", "taskId", "task_id"]);
    if (!id) continue;

    // Terminal states are not work. An absent status is treated as pending
    // because that is what a deployment with no queue states sends.
    const status = firstString(record, ["status", "state"])?.toLowerCase() ?? "pending";
    if (!CLAIMABLE_TASK_STATES.has(status)) continue;

    const payloadField = record["payload"] ?? record["input"] ?? record["data"];
    tasks.push({
      id,
      type: firstString(record, ["type", "taskType", "task_type"]) ?? "unknown",
      ...(payloadField && typeof payloadField === "object"
        ? { payload: payloadField as Record<string, unknown> }
        : {}),
      status,
    });
  }
  return tasks;
}

/** Task states this node will accept work from. See `parseTaskPayload`. */
const CLAIMABLE_TASK_STATES: ReadonlySet<string> = new Set([
  "pending",
  "queued",
  "ready",
  "assigned",
  "unclaimed",
  "new",
]);

/**
 * Normalises a Mothership update payload into {@link LatestVersionInfo}.
 *
 * Tolerates the shapes the swarm may send: a bare object, a `{ success, ... }`
 * envelope, or an `update`/`latestVersion` sub-object. Returns `null` unless
 * BOTH a version and a download URL are present â€” a version without a URL is
 * not actionable, and guessing would be worse than waiting for the next poll.
 */
function parseLatestVersion(payload: unknown): LatestVersionInfo | null {
  if (typeof payload !== "object" || payload === null) return null;
  const root = payload as Record<string, unknown>;

  // Unwrap `{ update: {...} }` / `{ latestVersion: {...} }` when present.
  const nested = root.update ?? root.latestVersion;
  const source =
    typeof nested === "object" && nested !== null ? (nested as Record<string, unknown>) : root;

  const version = firstString(source, ["version", "latestVersion", "latest_version", "tag"]);
  const downloadUrl = firstString(source, ["downloadUrl", "download_url", "url", "href"]);
  if (!version || !downloadUrl) return null;

  const sha256 = firstString(source, ["sha256", "sha_256", "checksum", "hash"]);
  const notes = firstString(source, ["notes", "releaseNotes", "release_notes", "changelog"]);

  return { version, downloadUrl, ...(sha256 ? { sha256 } : {}), ...(notes ? { notes } : {}) };
}
