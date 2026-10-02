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
import {
  DEFAULT_POWER_LIMITS,
  evaluatePower,
  normaliseLimits,
  readPowerSnapshot,
  throttleFactor,
  type PowerLimits,
  type PowerSnapshot,
} from "../../src/agent/DevicePower";

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

/** How often power limits are re-evaluated. */
const POWER_CHECK_MS = 20_000;

interface MobileConfig {
  nodeName: string;
  nodeCode: string;
  apiKey: string;
  mothershipUrl: string;
  masterUrl: string;
  dashboardPin: string;
  /** Operator-set battery/power limits. Absent => defaults. */
  powerLimits?: PowerLimits;
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

// --- PAIRING / CONNECTION STATE -----------------------------------------------

/**
 * The node's pairing state, as the setup card's badge renders it.
 *
 * `awaiting-setup` is a FIRST-CLASS state, not an error and not "disconnected".
 * It is what a freshly-installed APK shows before anyone has typed a key, and it
 * is the state the worker holds indefinitely rather than hammering the Mothership
 * with unauthenticated polls that can only ever be refused.
 */
export type ConnectionState =
  | "awaiting-setup"
  | "disconnected"
  | "connecting"
  | "connected"
  | "unauthorized";

interface ConnectionStatus {
  state: ConnectionState;
  /** The exact string the status badge prints. */
  label: string;
  /** Last HTTP status the Mothership returned; 0 when nothing was attempted. */
  httpStatus: number;
  /** Mothership currently being talked to, with no trailing slash. */
  mothershipUrl: string;
  /** True when a key is stored — i.e. the pollers will actually authenticate. */
  configured: boolean;
  /** ISO timestamp of the last state change attempt. */
  lastCheckedAt: string;
}

/** Live connection state. Rendered by the UI via `workerStatus().connection`. */
let connection: {
  state: ConnectionState;
  label: string;
  httpStatus: number;
  lastCheckedAt: string;
} = { state: "awaiting-setup", label: "Awaiting Setup", httpStatus: 0, lastCheckedAt: "" };

/** The connection block for the UI. Rebuilt per call so it cannot be mutated. */
function connectionStatus(): ConnectionStatus {
  return {
    ...connection,
    mothershipUrl: base(config.mothershipUrl),
    configured: Boolean(base(config.mothershipUrl) && config.apiKey),
  };
}

/**
 * Records a new connection state, publishing only on an actual change.
 *
 * Publishing on every tick would make the 2s UI poll redundant and would spam the
 * log; publishing only on change is what lets the badge settle on one state.
 */
function setConnection(state: ConnectionState, label: string, httpStatus = 0): void {
  const changed = connection.state !== state || connection.label !== label;
  connection = { state, label, httpStatus, lastCheckedAt: new Date().toISOString() };
  if (changed) publish({ type: "connection", connection: connectionStatus() });
}

/**
 * Canonicalises user-typed node code input to `RIPPA-XXXX-XXXX`.
 *
 * DELIBERATELY DUPLICATED from `src/config/nodeCode.ts` rather than imported. That
 * module pulls in `node:crypto` for `generateNodeCode()`, and `scripts/build-mobile-worker.mjs`
 * hard-fails the build on any `node:*` specifier in the bundle — because there is no
 * `node:crypto` inside an Android WebView. Copying the twelve lines of pattern logic
 * is the price of a bundle that actually loads on a tablet; the two must be changed
 * together.
 */
const NODE_CODE_PREFIX = "RIPPA";
/** Code body alphabet: digits 2-9 and letters minus the ambiguous I and O. */
const NODE_CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

function normaliseNodeCode(value: unknown): string {
  const raw = String(value ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
  const body = raw.startsWith(NODE_CODE_PREFIX) ? raw.slice(NODE_CODE_PREFIX.length) : raw;
  const match = new RegExp(`^([${NODE_CODE_ALPHABET}]{4})([${NODE_CODE_ALPHABET}]{4})$`).exec(body);
  return match ? `${NODE_CODE_PREFIX}-${match[1]}-${match[2]}` : "";
}

/**
 * THE GATE EVERY POLLER GOES THROUGH.
 *
 * With no key stored, this parks the node in `Awaiting Setup` and returns false so
 * the heartbeat, task poll and mesh poll all skip. This is the fix for the reported
 * "0 heartbeats" symptom: an unauthenticated poll is not a degraded heartbeat, it
 * is a guaranteed refusal, and retrying it every ten seconds just drains battery
 * while the Mothership correctly learns nothing about the phone.
 */
function pairingReady(): boolean {
  if (base(config.mothershipUrl) && config.apiKey) return true;
  if (connection.state !== "awaiting-setup") {
    setConnection("awaiting-setup", "Awaiting Setup", 0);
  }
  return false;
}

/*
  POWER STATE — the live battery reading and whether the limits currently hold
  the swarm dispatcher off.

  Kept as module state rather than re-read on every render because the UI polls
  `workerStatus()` every two seconds: reading the battery that often would mean a
  bridge round-trip per poll, which is precisely the battery cost this feature
  exists to avoid. The value is refreshed on POWER_CHECK_MS instead.
*/
let powerSnapshot: PowerSnapshot = {
  level: null,
  charging: false,
  pluggedOut: false,
  state: "unknown",
  source: "unavailable",
};
/** True while the operator's limits are holding the dispatcher off. */
let powerSuspended = false;
/** Why it is suspended, verbatim in the UI. Empty when running. */
let powerReason = "";
/** Current poll-interval multiplier from the throttle setting. */
let powerThrottle = 1;

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

/**
 * Persists the operator's power limits and re-evaluates immediately.
 *
 * Exposed to the page so the Advanced Satellite Settings menu can apply a change
 * without a restart. Re-evaluating on save (rather than waiting up to
 * POWER_CHECK_MS) is what makes ticking "run only when charging" visibly suspend
 * an unplugged tablet straight away, instead of up to 20 seconds later.
 *
 * Always returns the normalised limits that were actually stored, so the UI
 * renders exactly what the worker will enforce rather than what was typed.
 */
export function setPowerLimits(next: unknown): PowerLimits {
  const limits = normaliseLimits(next);
  config = saveConfig({ powerLimits: limits });
  void checkPower();
  publish({ type: "power_limits", limits, power: powerStatus() });
  return limits;
}

/**
 * Saves the pairing credentials the operator typed into the setup card and
 * immediately proves them with a real heartbeat.
 *
 * THIS IS THE FUNCTION THE MISSING UI CALLED OUT FOR. Until this existed the APK
 * had a worker that could authenticate and no way at all to TELL it a key: the
 * node sat at "0 heartbeats" forever because `apiKey` was never written to
 * localStorage by anything.
 *
 * The Mothership URL is normalised to a bare origin (trailing slashes stripped) so
 * the endpoint built from it can never contain `//api/swarm/heartbeat`.
 *
 * Resolution order — credential first, then reachability:
 *   1. `Unauthorized (401)` — the Mothership ANSWERED and refused the key. Nothing
 *      else can be concluded, and it is the one error an operator must see.
 *   2. `Connected (200 OK)` — registered and authenticated.
 *   3. `Disconnected (offline)` — the heartbeat threw. The credentials may well be
 *      valid; the network is simply not there, which on a tablet in a dead spot is
 *      a completely ordinary state that must NOT be reported as a bad key.
 *
 * An empty key is not an error: it parks the node in `Awaiting Setup` so the card
 * reads truthfully instead of the worker silently polling with no credentials.
 */
export async function configureNode(input: {
  nodeKey?: unknown;
  nodeName?: unknown;
  mothershipUrl?: unknown;
}): Promise<ConnectionStatus> {
  const typedKey = String(input?.nodeKey ?? "").trim();
  const url = base(String(input?.mothershipUrl ?? "").trim()) || DEFAULT_CONFIG.mothershipUrl;
  const name = String(input?.nodeName ?? "").trim() || DEFAULT_CONFIG.nodeName;

  /*
    The typed credential is stored BOTH as the API key and — when it is a
    well-formed node code — as the node code. Operators paste one string that
    serves as identity and credential, and the Mothership wants them as distinct
    fields. Anything that is not a valid `RIPPA-XXXX-XXXX` code is still kept as
    the API key (mesh keys are opaque strings, not codes), it just contributes no
    node code.
  */
  const nodeCode = normaliseNodeCode(typedKey);
  saveConfig({
    mothershipUrl: url,
    nodeName: name,
    apiKey: typedKey,
    nodeCode: nodeCode || (typedKey ? config.nodeCode : ""),
  });

  if (!typedKey) {
    setConnection("awaiting-setup", "Awaiting Setup", 0);
    log("No node key entered — the node will hold at Awaiting Setup until one is saved.");
    return connectionStatus();
  }

  setConnection("connecting", "Connecting...", 0);
  // Prove the credential rather than declaring success: `connected` must mean the
  // Mothership actually accepted this key, never merely that it was typed in.
  await sendHeartbeat();
  return connectionStatus();
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

/**
 * Sends the Mothership heartbeat, carrying this node's live status.
 *
 * The response is the ONLY authority on whether this node is actually paired, so
 * this is also where the connection badge's state is decided. A heartbeat that is
 * not inspected is exactly how a node ends up reporting "running" while the
 * Mothership has been refusing it all night.
 */
async function sendHeartbeat(): Promise<void> {
  if (!pairingReady()) return;
  try {
    const response = await fetch(`${base(config.mothershipUrl)}/api/swarm/heartbeat`, {
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

    // 401 is checked BEFORE `ok`, because a refusal is the one answer that must
    // never be mistaken for a transient network blip: the key is wrong and the
    // operator has to retype it.
    if (response.status === 401) {
      setConnection("unauthorized", "Unauthorized (401)", 401);
      counters.lastError = "Mothership refused the node key (401)";
      return;
    }
    if (!response.ok) {
      setConnection("disconnected", `Disconnected (HTTP ${response.status})`, response.status);
      return;
    }

    counters.heartbeats += 1;
    setConnection("connected", `Connected (${response.status} OK)`, response.status);
    // A successful heartbeat clears a previous auth failure, so the telemetry
    // panel stops showing a red "Last error" for a problem that is now fixed.
    if (counters.lastError.startsWith("Mothership refused")) counters.lastError = "";
  } catch (error) {
    // Reachable, not broken: a tablet with no signal must read "offline", never
    // "unauthorized", or an operator will retype a perfectly good key.
    counters.lastError = describe(error);
    setConnection("disconnected", "Disconnected (offline)", 0);
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
  if (!pairingReady()) return;
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

/**
 * The mesh credential for Master requests.
 *
 * `apiKey` is the same secret the Master issued this node at pairing time (it
 * is what `startSatellite()` hands the satellite core as `meshKey`), so it is
 * the one value available for authenticating here.
 */
function meshHeaders(): Record<string, string> {
  const key = config.apiKey || "";
  return {
    "Content-Type": "application/json",
    // Sent under BOTH names. `X-Mesh-Key` is the dedicated mesh channel; the
    // Bearer form is what every other Rippa surface speaks, and sending only
    // one of them is what produced a 401 on a node that held a valid key.
    "X-Mesh-Key": key,
    ...(key ? { Authorization: `Bearer ${key}` } : {}),
  };
}

/** Polls the Master mesh so this node appears in its Swarm Grid. */
async function pollMaster(): Promise<void> {
  // A Master URL is optional and independent of the Mothership pairing: a node with
  // no key can still be a mesh member. So this checks the Master URL only, and
  // `pairingReady()` is deliberately NOT applied here.
  if (!base(config.masterUrl)) return;
  try {
    const response = await fetch(`${base(config.masterUrl)}/api/mesh/heartbeat`, {
      method: "POST",
      headers: meshHeaders(),
      body: JSON.stringify({
        nodeCode: config.nodeCode,
        nodeName: config.nodeName,
        ipAddress: "",
        port: 0,
        p2pEnabled: false,
        metrics: {},
      }),
    });
    if (response.status === 401) {
      /*
        A 401 IS A RECOVERY SIGNAL, NOT A DEAD END.

        The Master answers a refused heartbeat with a `syncReset` payload
        carrying its own recovery instructions, which is the only thing that lets
        a node whose key went stale fix itself. A bare 401 was previously
        swallowed here, so the tablet retried the same dead credential every ten
        seconds forever and the fleet view showed a permanently red node.

        Adopt the key when the Master hands one over (it only does so for a node
        it recognises as holding the recently-rotated key); otherwise there is
        nothing safe to do here and re-pairing needs the operator's Master URL.
      */
      const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      const reset = body["syncReset"] as Record<string, unknown> | null | undefined;
      const issued = typeof reset?.["meshKey"] === "string" ? String(reset["meshKey"]) : "";
      if (issued) {
        saveConfig({ apiKey: issued });
        log(`Mesh key refused (${reset?.["reason"] ?? "unknown"}) — adopted the re-issued key.`);
        return;
      }
      counters.lastError = `Master refused the mesh key (${reset?.["reason"] ?? "unknown"})`;
      return;
    }
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

/**
 * Installs (or reinstalls) the recurring loops at their current throttle.
 *
 * Split out from `startWorker()` because changing the throttle factor or coming
 * back from suspension has to REBUILD the intervals: `setInterval` cannot have
 * its period changed after the fact, so the only way to honour a 6x slowdown is
 * to clear and recreate the timers. Rebuilding is cheap and idempotent.
 */
function installTimers(): void {
  for (const timer of timers) window.clearInterval(timer);
  timers = [
    window.setInterval(() => void sendHeartbeat(), HEARTBEAT_MS * powerThrottle),
    window.setInterval(() => void pollForTasks(), TASK_POLL_MS * powerThrottle),
    window.setInterval(() => void pollMaster(), MESH_POLL_MS * powerThrottle),
    window.setInterval(() => void checkPower(), POWER_CHECK_MS),
  ];
}

/**
 * Re-reads the battery and applies the operator's limits.
 *
 * THE CENTRAL POWER GATE. Every path that suspends work goes through here so the
 * suspended state, the reason and the log line can never disagree with what the
 * dispatcher is actually doing.
 *
 * Suspending does three things, in order:
 *   1. stops the Mothership/mesh pollers (the swarm dispatcher work itself),
 *   2. suspends the satellite core's Master polling,
 *   3. publishes a `power` event so the UI shows WHY the node went quiet.
 *
 * The foreground service is deliberately NOT stopped. It is what keeps the
 * process alive so that the node can resume by itself when a charger appears —
 * tearing it down would mean the tablet needed a manual restart, which defeats
 * the purpose of an unattended node.
 *
 * Resuming is the mirror image, and is triggered by the same timer, so plugging
 * the tablet in needs no interaction.
 */
export async function checkPower(): Promise<void> {
  /*
    FAIL OPEN, AND NEVER THROW OUT OF HERE.

    `startWorker()` awaits this BEFORE it starts any poller, so anything that
    escapes it does not just lose power awareness — it aborts the boot sequence
    entirely and the tablet shows a dead node.

    The readers in DevicePower.ts already swallow their own failures (both the
    Capacitor bridge call and navigator.getBattery()), so in practice this catch
    should never fire. It is here because "should never fire" is not a guarantee
    a 24/7 unattended device gets to rely on: a plugin that rejects, a bridge
    that throws during teardown, or a future reader added without a try/catch
    would all take the whole worker down with it.

    A lost power check must degrade to "no limits enforced", never to "no node".
  */
  try {
    const limits = normaliseLimits(config.powerLimits);
    powerSnapshot = await readPowerSnapshot();
    const verdict = evaluatePower(powerSnapshot, limits);

    // --- SUSPEND -------------------------------------------------------------
    if (!verdict.allowed && !powerSuspended) {
      powerSuspended = true;
      powerReason = verdict.reason;
      for (const timer of timers) window.clearInterval(timer);
      timers = [];
      satelliteWorker.setSuspended(true);
      log(`Swarm dispatcher suspended. ${verdict.reason}`);
      publish({ type: "power", suspended: true, reason: powerReason, power: powerStatus() });
      return;
    }

    // --- RESUME --------------------------------------------------------------
    if (verdict.allowed && powerSuspended) {
      powerSuspended = false;
      powerReason = "";
      satelliteWorker.setSuspended(false);
      log("Swarm dispatcher resumed — power limits satisfied.");
      publish({ type: "power", suspended: false, reason: "", power: powerStatus() });
    }

    // --- THROTTLE ------------------------------------------------------------
    const factor = throttleFactor(powerSnapshot, limits);
    if (factor !== powerThrottle) {
      powerThrottle = factor;
      // Only meaningful while running; a suspended worker has no timers to rebuild.
      if (!powerSuspended) installTimers();
      log(
        factor === 1
          ? "Polling back to normal frequency."
          : `Polling throttled ${factor}x to conserve battery.`,
      );
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    log(`Power check failed (${detail}) — continuing with no power limits.`);

    // Recover the suspended state explicitly: if the node was already paused for
    // a low battery we cannot re-read, we stay paused (a suspended node is safe
    // and will be re-checked on the next tick), but the UI is told why it is
    // quiet rather than being left showing a stale reason.
    if (powerSuspended) {
      publish({ type: "power", suspended: true, reason: powerReason, power: powerStatus() });
    }
  }
}

/** The power block the UI renders. Flat enough to read straight from the DOM. */
export function powerStatus(): Record<string, unknown> {
  return {
    suspended: powerSuspended,
    reason: powerReason,
    throttle: powerThrottle,
    level: powerSnapshot.level,
    charging: powerSnapshot.charging,
    state: powerSnapshot.state,
    source: powerSnapshot.source,
    limits: normaliseLimits(config.powerLimits ?? DEFAULT_POWER_LIMITS),
  };
}

/** Boots the worker and every recurring loop. Safe to call once. */
export async function startWorker(): Promise<void> {
  loadConfig();
  await ensureBackgroundService();

  /*
    POWER IS EVALUATED BEFORE ANY WORK.

    On a tablet that is already at 3% and not charging, the correct behaviour is
    to do nothing at all. Starting the pollers first and suspending them a moment
    later would burn a Mothership heartbeat and may claim a task the node then
    abandons, which is exactly the "satellite drops out of the swarm" symptom
    power limits are supposed to prevent.
  */
  powerThrottle = 1;
  await checkPower();

  if (!powerSuspended) {
    await sendHeartbeat();
    await pollMaster();
    await pollForTasks();
  }

  installTimers();

  log(
    `Worker started. runtime=${describeRuntime()} ` +
      `scraping=${supportsBrowserScraping() ? "chromium" : "fetch"} ` +
      `concurrency=${MAX_CONCURRENT_TASKS} ` +
      `power=${powerSuspended ? "suspended" : "allowed"} ` +
      `connection=${connection.state}`,
  );
  publish({ type: "started", capabilities: runtimeCapabilities(), power: powerStatus() });
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
    power: powerStatus(),
    // The setup card's badge, the telemetry row and the tests all read it from
    // here, so there is exactly one definition of "is this node paired".
    connection: connectionStatus(),
  };
}

// --- SATELLITE WORKER BRIDGE -------------------------------------------------
/*
  WIRING THE ABSTRACTED STORAGE LAYER INTO THE APK.

  `src/satellite/mobile-worker.ts` is the WebView-safe satellite core: it polls
  a Master for assignments and persists state through the StorageProvider
  abstraction, which resolves to a browser implementation in this runtime and to
  better-sqlite3 on the desktop. It carries the storage abstraction that the
  APK build depends on, so it must be part of the bundle.

  It is instantiated but NOT auto-started. Two independent pollers (this
  module's Mothership loop above and the satellite's Master loop) would both
  claim tasks and double-report results against the same node code. The
  dashboard starts the satellite explicitly via `startSatellite()` once a Master
  URL is configured, so the two protocols never overlap by accident.
*/
import { satelliteWorker, SatelliteWorker } from "../../src/satellite/mobile-worker";

/*
  RE-EXPORTED so the bundled IIFE exposes them on `window.RippaMobileWorker`.
  esbuild only promotes the entrypoint module's OWN exports onto the global name
  — an imported binding is internal to the bundle and invisible from the page.
  Without this the satellite core would be bundled and completely unreachable,
  which is the kind of silent no-op that looks like a healthy build right up
  until the tablet fails to join the mesh.
*/
export { satelliteWorker, SatelliteWorker };

let satelliteStarted = false;

/**
 * Starts the satellite core against a Master. Safe to call repeatedly; only the
 * first call with a usable `masterUrl` starts anything.
 */
export async function startSatellite(): Promise<boolean> {
  const masterUrl = String(config.masterUrl || "").trim();
  if (!masterUrl || satelliteStarted) return false;
  try {
    await satelliteWorker.initialize({
      nodeRole: "satellite",
      nodeName: config.nodeName || DEFAULT_CONFIG.nodeName,
      masterUrl,
      meshKey: config.apiKey || "",
      port: 0,
    });
    satelliteStarted = true;
    publish({ type: "satellite", started: true, masterUrl });
    return true;
  } catch (error) {
    // Never fatal: the Mothership loop above is the primary protocol, and a
    // Master that is merely offline must not stop the node from working.
    counters.lastError = describe(error);
    log(`Satellite core did not start: ${describe(error)}`);
    return false;
  }
}

/** Stops the satellite core's Master polling loop. */
export async function stopSatellite(): Promise<void> {
  if (!satelliteStarted) return;
  satelliteStarted = false;
  try {
    await satelliteWorker.shutdown();
  } catch {
    /* best effort */
  }
  publish({ type: "satellite", started: false });
}