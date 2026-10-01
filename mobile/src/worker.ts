/**
 * MOBILE WORKER — the background agent that runs inside the Capacitor WebView.
 *
 * WHAT THIS IS. A spare Android tablet left on a desk overnight, acting as a
 * Rippa satellite: heartbeat to the Mothership, claim queued tasks, scrape with
 * `fetch`, report results, and poll its Master for mesh assignments.
 *
 * WHY IT DOES NOT IMPORT THE NODE'S OWN TASK MODULES. The desktop node reaches
 * for `better-sqlite3` (a native addon), `node:fs`, `node:cron` and Playwright,
 * which reads `process.versions` at import time. None exist in a WebView, so
 * importing the real `TaskEngine`/`Orchestrator` throws on load. Two modules ARE
 * shared, because they were written to be dependency-free for exactly this:
 *
 *     src/platform.ts             runtime capability detection
 *     src/agent/MobileScraper.ts  the fetch-based scraping engine
 *
 * Everything below re-implements the satellite protocol against `fetch`. It is
 * small enough to reason about, and it speaks the same wire format the desktop
 * node already uses (`/api/swarm/heartbeat`, `/api/swarm/tasks`, `/api/mesh/heartbeat`).
 *
 * THE PLATFORM BRIDGE. `globalThis.RippaNodePlugin` is the custom Capacitor
 * plugin in `android-overlay/`. It owns the FOREGROUND SERVICE, the WAKE_LOCK and
 * the persistent notification — the things that keep this alive with the screen off.
 */

import { describeRuntime, runtimeCapabilities, supportsBrowserScraping } from "../../src/platform";
import { scrapeMobile } from "../../src/agent/MobileScraper";

/** How often the Mothership heartbeat is sent (matches the desktop 30s). */
const HEARTBEAT_MS = 30_000;
/** How often queued Mothership tasks are polled (matches the desktop 15s). */
const TASK_POLL_MS = 15_000;
/** How often the Master mesh is polled for assignments (matches desktop 10s). */
const MESH_POLL_MS = 10_000;
/** One task at a time: a tablet's battery is the scarce resource. */
const MAX_CONCURRENT_TASKS = 1;

/** Where mobile config is persisted. WebView storage survives app restarts. */
const CONFIG_KEY = "rippa_node_mobile_config";

interface MobileConfig {
  nodeName: string;
  nodeCode: string;
  apiKey: string;
  mothershipUrl: string;
  masterUrl: string;
  dashboardPin: string;
}

const DEFAULT_CONFIG: MobileConfig = {
  nodeName: "Android Satellite",
  nodeCode: "",
  apiKey: "",
  mothershipUrl: "https://rippaadventures.com",
  masterUrl: "",
  dashboardPin: "12031994",
};

let config: MobileConfig = { ...DEFAULT_CONFIG };
/** Node codes learned from the Master's sibling list. */
let connectedSatellites: string[] = [];
/** Counters for the dashboard tile, so an overnight run is auditable. */
const counters = {
  heartbeats: 0,
  tasksClaimed: 0,
  tasksCompleted: 0,
  tasksFailed: 0,
  meshHeartbeats: 0,
  lastError: "",
  lastRunAt: "",
};

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function log(message: string): void {
  const line = `[mobile ${new Date().toISOString()}] ${message}`;
  console.log(line);
  publish({ type: "log", message: line });
}

// --- DASHBOARD PLUMBING -----------------------------------------------------

type WorkerEvent = { type: string; [key: string]: unknown };
type Listener = (event: WorkerEvent) => void;
const listeners = new Set<Listener>();

/** Subscribes to worker events. Returns an unsubscribe function. */
export function onWorkerEvent(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function publish(event: WorkerEvent): void {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch {
      // A broken UI listener must never stop the worker.
    }
  }
}
// --- CONFIG -----------------------------------------------------------------

export function loadConfig(): MobileConfig {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    if (raw) config = { ...DEFAULT_CONFIG, ...(JSON.parse(raw) as Partial<MobileConfig>) };
  } catch {
    // Corrupt storage must not stop the node; defaults are always safe to run.
    config = { ...DEFAULT_CONFIG };
  }
  return config;
}

export function saveConfig(next: Partial<MobileConfig>): MobileConfig {
  config = { ...config, ...next };
  try {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
  } catch {
    // Private mode / quota: keep running on in-memory config rather than
    // refusing to work at all.
  }
  return config;
}

// --- NATIVE BRIDGE ----------------------------------------------------------

interface NativePlugin {
  startForegroundService(options?: { title?: string; message?: string }): Promise<void>;
  stopForegroundService(): Promise<void>;
  isForegroundServiceRunning(): Promise<{ running: boolean }>;
}

function native(): NativePlugin | null {
  const plugin = (globalThis as { RippaNodePlugin?: NativePlugin }).RippaNodePlugin;
  return plugin && typeof plugin.startForegroundService === "function" ? plugin : null;
}

/**
 * Starts the Android foreground service and its wake lock.
 *
 * CRITICAL FOR AN OVERNIGHT RUN. Without this Android freezes or kills the
 * process the moment the screen goes off, and a "24/7 node" that stops at 11pm
 * is not one. The SERVICE — not this JavaScript — holds the lock, so the node
 * also survives the WebView itself being backgrounded or reclaimed.
 */
async function ensureBackgroundService(): Promise<boolean> {
  const plugin = native();
  if (!plugin) {
    log("Native bridge unavailable — running without a foreground service.");
    return false;
  }
  try {
    await plugin.startForegroundService({
      title: "Rippa Node — satellite",
      message: "Foraging for the swarm. The screen may be off.",
    });
    const state = await plugin.isForegroundServiceRunning();
    log(`Foreground service running=${state?.running === true}.`);
    return state?.running === true;
  } catch (error) {
    // Never fatal: in a desktop browser preview there is no plugin at all, and
    // the worker should still run.
    log(`Could not start the foreground service: ${describe(error)}`);
    return false;
  }
}

// --- SWARM PROTOCOL ---------------------------------------------------------

/** Headers every Mothership call carries. */
function authHeaders(): Record<string, string> {
  return {
    "Content-Type": "application/json",
    ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
  };
}

function base(url: string): string {
  return String(url || "").replace(/\/+$/, "");
}

/** Sends the Mothership heartbeat, carrying this node's live status. */
async function sendHeartbeat(): Promise<void> {
  if (!base(config.mothershipUrl) || !config.apiKey) return;
  try {
    await fetch(`${base(config.mothershipUrl)}/api/swarm/heartbeat`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        nodeName: config.nodeName,
        nodeCode: config.nodeCode,
        role: "satellite",
        status: "idle",
        timestamp: new Date().toISOString(),
        // The cloud expects a telemetry block. A tablet reports what it can and
        // omits what it cannot, rather than sending fabricated figures.
        cpu_usage: 0,
        ram_usage: 0,
        connected_satellites: connectedSatellites,
      }),
    });
    counters.heartbeats += 1;
  } catch (error) {
    counters.lastError = describe(error);
  }
}
/** Claims a task with the Mothership, tolerating a cloud with no claim route. */
async function claimTask(taskId: string): Promise<boolean> {
  try {
    const response = await fetch(`${base(config.mothershipUrl)}/api/swarm/tasks/claim`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        taskId,
        nodeCode: config.nodeCode,
        nodeName: config.nodeName,
        claimedAt: new Date().toISOString(),
      }),
    });
    return response.ok;
  } catch {
    // Fails open on purpose — mirrors SwarmClient.claimTask on the desktop.
    return false;
  }
}

/** Reports a finished task back to the Mothership. */
async function reportTask(
  task: { id: string; type: string },
  status: "success" | "failure" | "skipped",
  detail: string,
): Promise<void> {
  try {
    await fetch(`${base(config.mothershipUrl)}/api/swarm/submit`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        kind: "task_result",
        taskId: task.id,
        type: task.type,
        status,
        detail,
        durationMs: 0,
      }),
    });
  } catch (error) {
    counters.lastError = describe(error);
  }
}

/** Extracts the task list from whatever envelope the Mothership returns. */
function parseTasks(
  payload: unknown,
): Array<{ id: string; type: string; payload?: Record<string, unknown> }> {
  if (!payload || typeof payload !== "object") return [];
  const root = payload as Record<string, unknown>;
  const raw = Array.isArray(root) ? root : (root["tasks"] ?? root["pending_tasks"] ?? root["queue"]);
  if (!Array.isArray(raw)) return [];
  const out: Array<{ id: string; type: string; payload?: Record<string, unknown> }> = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const id = [record["id"], record["taskId"], record["task_id"]]
      .map((v) => (typeof v === "string" ? v.trim() : ""))
      .find(Boolean);
    if (!id) continue;
    // Only claimable states; a retired or in-flight task is not our work.
    const status = String(record["status"] ?? "pending").toLowerCase();
    if (!["pending", "queued", "ready", "assigned", "unclaimed", "new"].includes(status)) continue;
    const type = String(record["type"] ?? record["taskType"] ?? record["task_type"] ?? "unknown");
    const body = (record["payload"] ?? record["input"] ?? record["data"]) as
      | Record<string, unknown>
      | undefined;
    out.push({ id, type, ...(body && typeof body === "object" ? { payload: body } : {}) });
  }
  return out;
}
/**
 * Executes one Mothership task on a phone.
 *
 * Only what a tablet can genuinely do is attempted. Anything else is reported
 * `skipped` rather than silently dropped — which is what lets an operator tell
 * "no capability" apart from "the node is ignoring the queue", the exact ambiguity
 * that made the original task-claiming bug so hard to diagnose.
 */
async function executeTask(
  task: { id: string; type: string; payload?: Record<string, unknown> },
): Promise<"success" | "failure" | "skipped"> {
  const url = String(task.payload?.["url"] ?? "");
  if (!/^https?:\/\//i.test(url)) {
    await reportTask(task, "skipped", "mobile node has no handler for this task shape");
    return "skipped";
  }

  try {
    const result = await scrapeMobile(url);
    await reportTask(
      task,
      "success",
      `scraped ${result.title} — ${result.text.length} chars via the mobile fetch scraper`,
    );
    publish({
      type: "task",
      taskId: task.id,
      status: "success",
      title: result.title,
      chars: result.text.length,
    });
    return "success";
  } catch (error) {
    await reportTask(task, "failure", describe(error));
    return "failure";
  }
}

/** One poll of the Mothership queue: claim, run, report. */
async function pollForTasks(): Promise<void> {
  if (!base(config.mothershipUrl) || !config.apiKey) return;
  try {
    const response = await fetch(`${base(config.mothershipUrl)}/api/swarm/tasks`, {
      method: "GET",
      headers: authHeaders(),
    });
    if (!response.ok) return;
    const tasks = parseTasks(await response.json());
    if (tasks.length === 0) return;

    // ONE at a time, always the first: draining a queue in parallel on a tablet
    // would trade battery for throughput the swarm does not need.
    const task = tasks[0];
    await claimTask(task.id);
    counters.tasksClaimed += 1;
    publish({ type: "task_claimed", taskId: task.id, taskType: task.type });

    const outcome = await executeTask(task);
    if (outcome === "success") counters.tasksCompleted += 1;
    else if (outcome === "failure") counters.tasksFailed += 1;
    counters.lastRunAt = new Date().toISOString();
  } catch (error) {
    counters.lastError = describe(error);
  }
}

/** Polls the Master mesh so this node appears in its Swarm Grid. */
async function pollMaster(): Promise<void> {
  if (!base(config.masterUrl)) return;
  try {
    const response = await fetch(`${base(config.masterUrl)}/api/mesh/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        nodeCode: config.nodeCode,
        nodeName: config.nodeName,
        ipAddress: "",
        port: 0,
        p2pEnabled: false,
        metrics: {},
      }),
    });
    if (!response.ok) return;
    const data = (await response.json()) as Record<string, unknown>;
    const siblings = Array.isArray(data["siblings"])
      ? (data["siblings"] as Array<{ nodeCode?: string }>)
      : [];
    connectedSatellites = siblings
      .map((s) => s?.nodeCode)
      .filter((code): code is string => typeof code === "string" && code.length > 0);
    counters.meshHeartbeats += 1;
    publish({ type: "mesh", connected: connectedSatellites.length });
  } catch {
    // The Master may simply be offline; the Mothership loop is unaffected.
  }
}

// --- LIFECYCLE --------------------------------------------------------------

let timers: number[] = [];

/** Boots the worker and every recurring loop. Safe to call once. */
export async function startWorker(): Promise<void> {
  loadConfig();
  await ensureBackgroundService();

  await sendHeartbeat();
  await pollMaster();
  await pollForTasks();

  timers = [
    window.setInterval(() => void sendHeartbeat(), HEARTBEAT_MS),
    window.setInterval(() => void pollForTasks(), TASK_POLL_MS),
    window.setInterval(() => void pollMaster(), MESH_POLL_MS),
  ];

  log(
    `Worker started. runtime=${describeRuntime()} ` +
      `scraping=${supportsBrowserScraping() ? "chromium" : "fetch"} ` +
      `concurrency=${MAX_CONCURRENT_TASKS}`,
  );
  publish({ type: "started", capabilities: runtimeCapabilities() });
}

/** Stops every loop. The foreground service is left alone on purpose. */
export function stopWorker(): void {
  for (const timer of timers) window.clearInterval(timer);
  timers = [];
  publish({ type: "stopped" });
}

/** Snapshot for the dashboard tile, so an overnight run is auditable. */
export function workerStatus(): Record<string, unknown> {
  return {
    ...counters,
    config: { ...config },
    capabilities: runtimeCapabilities(),
    running: timers.length > 0,
    maxConcurrentTasks: MAX_CONCURRENT_TASKS,
  };
}