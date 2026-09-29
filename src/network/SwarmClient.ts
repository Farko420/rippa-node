import axios, { type AxiosInstance } from "axios";
import { schedule, type ScheduledTask } from "node-cron";
import { env } from "../config";

/**
 * SWARM CLIENT — secure connection between this node and the Cloudflare Mothership.
 * Every request carries `NODE_API_KEY` as a Bearer token.
 */

export type NodeStatus = "idle" | "busy";

export interface HeartbeatPayload {
  nodeName: string;
  role: "master" | "satellite";
  status: NodeStatus;
  timestamp: string;
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
 * Invoked when the Mothership advertises a newer build — either through the
 * heartbeat response or {@link SwarmClient.fetchLatestVersion}. Owned by the
 * OtaUpdater, which performs the actual update.
 */
export type UpdateSignalHandler = (info: LatestVersionInfo) => void;

export class SwarmClient {
  private readonly client: AxiosInstance;
  private heartbeatTask: ScheduledTask | null = null;
  private status: NodeStatus = "idle";
  private updateSignal: UpdateSignalHandler | null = null;

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
    console.log("[Swarm] Heartbeat started — POST /api/swarm/heartbeat every 30s");
  }

  stopHeartbeat(): void {
    if (this.heartbeatTask) {
      this.heartbeatTask.stop();
      this.heartbeatTask = null;
      console.log("[Swarm] Heartbeat stopped.");
    }
  }

  async sendHeartbeat(): Promise<void> {
    const payload: HeartbeatPayload = {
      nodeName: env.NODE_NAME,
      role: env.NODE_ROLE,
      status: this.status,
      timestamp: new Date().toISOString(),
    };

    try {
      const { data } = await this.client.post("/api/swarm/heartbeat", payload);
      console.log(`[Swarm] Heartbeat sent (status: ${this.status})`);
      // The Mothership can piggyback an update notice on the heartbeat reply,
      // which is how a pushed release reaches the swarm within seconds.
      const advertised = parseLatestVersion(data);
      if (advertised) {
        console.log(`[Swarm] Mothership advertises version ${advertised.version}.`);
        this.updateSignal?.(advertised);
      }
    } catch (error) {
      console.warn(`[Swarm] Heartbeat failed — ${describeError(error)}`);
    }
  }

  /** Registers the handler fired when a newer version is advertised. */
  setUpdateSignalHandler(handler: UpdateSignalHandler | null): void {
    this.updateSignal = handler;
  }

  /**
   * Asks the Mothership for the newest published build. Returns `null` when
   * the endpoint is unreachable or the payload is unusable — the caller then
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
      console.warn(`[Swarm] Version check failed — ${describeError(error)}`);
      return null;
    }
  }

  /** Fetches pending tasks from the Mothership. Returns `[]` when unreachable. */
  async fetchTasks(): Promise<SwarmTask[]> {
    try {
      const { data } = await this.client.get("/api/swarm/tasks");
      if (Array.isArray(data)) {
        return data as SwarmTask[];
      }
      return Array.isArray(data?.tasks) ? (data.tasks as SwarmTask[]) : [];
    } catch (error) {
      console.warn(`[Swarm] Failed to fetch tasks — ${describeError(error)}`);
      return [];
    }
  }

  /** Submits a completed JSON profile back to the Mothership. */
  async submitProfile(profile: Record<string, unknown>): Promise<boolean> {
    try {
      await this.client.post("/api/swarm/submit", profile);
      console.log("[Swarm] Profile submitted to /api/swarm/submit");
      return true;
    } catch (error) {
      console.warn(`[Swarm] Profile submission failed — ${describeError(error)}`);
      return false;
    }
  }
}

function describeError(error: unknown): string {
  if (axios.isAxiosError(error)) {
    const status = error.response?.status;
    return status ? `HTTP ${status} — ${error.message}` : error.message;
  }
  return error instanceof Error ? error.message : String(error);
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
 * BOTH a version and a download URL are present — a version without a URL is
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
