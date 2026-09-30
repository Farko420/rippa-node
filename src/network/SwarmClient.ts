import axios, { type AxiosInstance } from "axios";
import { schedule, type ScheduledTask } from "node-cron";
import { env } from "../config";
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

export type NodeStatus = "idle" | "busy";

/** Snake_case field names are part of the Mothership's wire contract. */
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
    } catch (error) {
      console.warn(`[Swarm] Heartbeat failed â€” ${describeError(error)}`);
    }
  }

  /** Registers the handler fired when a newer version is advertised. */
  setUpdateSignalHandler(handler: UpdateSignalHandler | null): void {
    this.updateSignal = handler;
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
      return Array.isArray(data?.tasks) ? (data.tasks as SwarmTask[]) : [];
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
