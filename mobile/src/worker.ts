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
 * THE PLATFORM BRIDGE. `Capacitor.Plugins.RippaNode` is the custom Capacitor
 * plugin in `android-overlay/`. It owns the FOREGROUND SERVICE, the WAKE_LOCK and
 * the persistent notification — the things that keep this alive with the screen
 * off. The plugin's id is fixed by its `@CapacitorPlugin(name = ...)` annotation
 * and matched by `NATIVE_PLUGIN_ID` below; see the note there for why looking up
 * the wrong global is what produced "Native bridge unavailable" on every device.
 */

import { describeRuntime, runtimeCapabilities, supportsBrowserScraping } from "../../src/platform";
import { isVersionNewer } from "../../src/version-compare";
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
import {
  DataUsageTracker,
  DEFAULT_NETWORK_POLICY,
  evaluateNetwork,
  formatBytes,
  normaliseNetworkPolicy,
  readNetworkSnapshot,
  type DataUsage,
  type NetworkKind,
  type NetworkPolicy,
  type NetworkSnapshot,
} from "../../src/agent/DeviceNetwork";

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

/**
 * How often the network policy is re-evaluated.
 *
 * FASTER THAN THE POWER CHECK, and that is not an oversight. The thing being
 * detected here — walking out of Wi-Fi range — happens in the time it takes to
 * walk past a doorway, whereas a battery drains over hours. At the 20s power
 * cadence a node could start a scrape on cellular and keep it running for most
 * of a minute, which is exactly the spend the operator asked to avoid. 5s is
 * cheap: it reads one cached property and touches no network.
 */
const NETWORK_CHECK_MS = 5_000;

interface MobileConfig {
  nodeName: string;
  nodeCode: string;
  apiKey: string;
  mothershipUrl: string;
  masterUrl: string;
  dashboardPin: string;
  /** Operator-set battery/power limits. Absent => defaults. */
  powerLimits?: PowerLimits;
  /**
   * Operator-set network policy. Absent => defaults (cellular allowed).
   *
   * Separate from `powerLimits` on purpose: a flat battery is a hard stop and a
   * cellular link is a cost stop, and an operator who paused for the second does
   * not want the node to look dead. See src/agent/DeviceNetwork.ts.
   */
  networkPolicy?: NetworkPolicy;
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

/*
  NETWORK STATE — the current transport, the operator's policy, and the rolling
  data accounting shown on the telemetry dashboard.

  Same caching rationale as the power snapshot above: the UI polls
  `workerStatus()` every two seconds, and each of these would otherwise cost a
  bridge call or a Resource Timing walk per poll.

  `networkSuspended` is tracked SEPARATELY from `powerSuspended` even though both
  pause the same loops, because the two reasons are not interchangeable to an
  operator: one means "flat battery", the other means "I told you not to use my
  data". Collapsing them into one boolean is how a tablet that is merely on
  cellular ends up reported as having a battery problem.
*/
let networkSnapshot: NetworkSnapshot = {
  kind: "unknown",
  metered: false,
  downlinkMbps: null,
  source: "unavailable",
};
let networkSuspended = false;
let networkReason = "";
let dataUsage: DataUsage = { sent1h: 0, received1h: 0, sent24h: 0, received24h: 0 };
/** Rolling transfer accounting. Module state, like the other telemetry. */
const usageTracker = new DataUsageTracker();

/**
 * Recent finished tasks, newest first, for the dashboard's history feed.
 *
 * Capped because this is an unattended 24/7 device: an unbounded feed would grow
 * in localStorage forever and eventually fail to save config at all. 25 entries
 * is roughly a full day of a busy node, which is what an operator scrolling back
 * actually reads.
 */
const MAX_TASK_HISTORY = 25;
let taskHistory: TaskHistoryEntry[] = [];

/** One completed task, as rendered in the dashboard feed. */
interface TaskHistoryEntry {
  /** ISO timestamp of completion. */
  at: string;
  /** Short human description, e.g. "12 POI extractions". */
  label: string;
  /** Outcome, mirroring TaskResult's statuses. */
  status: "success" | "failed" | "timeout";
}

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
 * Persists the operator's network policy and re-evaluates immediately.
 *
 * Mirrors `setPowerLimits`: re-evaluating on save is what makes ticking
 * "Wi-Fi Only" visibly pause a node that is already on cellular, instead of up
 * to one check-interval later.
 *
 * Always returns the NORMALISED policy, so the UI renders exactly what will be
 * enforced rather than what was selected.
 */
export function setNetworkPolicy(next: unknown): NetworkPolicy {
  const policy = normaliseNetworkPolicy(next);
  config = saveConfig({ networkPolicy: policy });
  void checkNetwork();
  publish({ type: "network_policy", policy, network: networkStatus() });
  return policy;
}

/** The live transport plus the policy in force, for the settings panel. */
export function networkStatus(): Record<string, unknown> {
  const policy = normaliseNetworkPolicy(config.networkPolicy ?? DEFAULT_NETWORK_POLICY);
  return {
    kind: networkSnapshot.kind,
    metered: networkSnapshot.metered,
    source: networkSnapshot.source,
    downlinkMbps: networkSnapshot.downlinkMbps,
    wifiOnly: policy.wifiOnly,
    suspended: networkSuspended,
    reason: networkReason,
    data: {
      ...dataUsage,
      // Pre-formatted alongside the raw bytes so the UI does not carry a second
      // copy of this formatting logic that can drift from it.
      sent1hLabel: formatBytes(dataUsage.sent1h),
      received1hLabel: formatBytes(dataUsage.received1h),
      sent24hLabel: formatBytes(dataUsage.sent24h),
      received24hLabel: formatBytes(dataUsage.received24h),
    },
  };
}

/**
 * Re-reads the transport and applies the operator's network policy.
 *
 * THE CELLULAR GATE. Like `checkPower`, this is the one place a suspension can
 * originate, and it never throws out (see the note there) — it is called during
 * boot before any poller starts.
 *
 * IT PAUSES INGESTION, NOT JUST EXECUTION. That is the part that matters for a
 * mesh node: a Wi-Fi-only node that kept polling would keep claiming tasks off
 * the Mothership queue and then refuse to run them, holding work that another
 * node could have finished. Refusing to take the task is the whole point.
 */
export async function checkNetwork(): Promise<void> {
  try {
    const policy = normaliseNetworkPolicy(config.networkPolicy ?? DEFAULT_NETWORK_POLICY);
    networkSnapshot = await readNetworkSnapshot();
    dataUsage = usageTracker.record(Date.now(), ...transferTotals());
    const verdict = evaluateNetwork(networkSnapshot, policy);

    if (!verdict.allowed) {
      const wasSuspended = networkSuspended;
      networkSuspended = true;
      networkReason = verdict.reason;
      if (!wasSuspended) {
        for (const timer of timers) window.clearInterval(timer);
        timers = [];
        satelliteWorker.setSuspended(true);
        log(`Worker paused. ${verdict.reason}`);
      }
      publish({ type: "network", suspended: true, reason: networkReason, network: networkStatus() });
      return;
    }

    if (networkSuspended) {
      networkSuspended = false;
      networkReason = "";
      // Only resume if power is ALSO happy. The two gates are independent, and
      // resuming here on a flat battery would leave the node suspended for power
      // reasons while reporting that it had resumed for network reasons.
      if (!powerSuspended) {
        satelliteWorker.setSuspended(false);
        log("Network policy satisfied — resuming.");
      }
    }
    publish({ type: "network", suspended: false, reason: "", network: networkStatus() });
  } catch (error) {
    // Fail open, exactly as checkPower does: a network probe failure must degrade
    // to "no policy enforced", never to "no node".
    void error;
  }
}

/**
 * Cumulative bytes sent/received this session, from Resource Timing.
 *
 * Returns [sent, received]. Zeros when the API is absent, which is the desktop
 * case — and zeros are the correct answer there, not a fabricated figure.
 */
function transferTotals(): [number, number] {
  try {
    const perf = (globalThis as {
      performance?: { getEntriesByType?: (type: string) => Array<{ transferSize?: number }> };
    }).performance;
    const entries = perf?.getEntriesByType?.("resource");
    if (!Array.isArray(entries)) return [0, 0];
    let received = 0;
    for (const entry of entries) {
      if (typeof entry.transferSize === "number" && entry.transferSize > 0) {
        received += entry.transferSize;
      }
    }
    // `sent` is not separable from `received` in Resource Timing (transferSize is
    // the sum of both). Reporting the same figure for sent would overstate what
    // the node sent, so only the received side is measured and sent stays 0 —
    // an honest zero rather than a confident wrong number.
    return [0, received];
  } catch {
    return [0, 0];
  }
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
  isForegroundServiceRunning(): Promise<{ running: boolean; available?: boolean }>;
}

/**
 * THE PLUGIN ID, WHICH MUST MATCH `@CapacitorPlugin(name = ...)` IN
 * mobile/android-overlay/RippaNodePlugin.java.
 *
 * Capacitor derives the JavaScript global from that annotation and publishes the
 * plugin's methods at `window.Capacitor.Plugins.<id>`. The worker used to look for
 * `globalThis.RippaNodePlugin` instead — a global that no part of Capacitor ever
 * creates — so the bridge was unreachable on every device and every node logged
 * "Native bridge unavailable". The id and the annotation are one contract and must
 * be changed together; the build asserts the two agree (see package-apk.mjs).
 */
const NATIVE_PLUGIN_ID = "RippaNode";

/**
 * Resolves the native plugin, or null when there is no native shell.
 *
 * CHECKED IN THREE PLACES, IN ORDER, because each covers a real deployment:
 *
 *   1. `globalThis.RippaNodePlugin` — an explicit handle, if anything ever sets
 *      one. Probed first so a future native-side alias keeps working.
 *   2. `Capacitor.Plugins.RippaNode` — where Capacitor ACTUALLY puts it.
 *   3. `Capacitor.Plugins.RippaNodePlugin` — the id Capacitor would derive from
 *      the class name if the annotation were ever dropped.
 *
 * Every candidate is validated by requiring a real function, NOT merely a
 * truthy object. `registerPlugin` returns a Proxy whose property access yields a
 * wrapper function for ANY name, including ones the native side does not
 * implement — so a truthiness test passes against a plugin that cannot start
 * anything, and the failure then surfaces as a rejected promise instead of the
 * honest "no bridge here" this function is meant to express.
 */
function native(): NativePlugin | null {
  try {
    const scope = globalThis as {
      RippaNodePlugin?: NativePlugin;
      Capacitor?: { Plugins?: Record<string, unknown> };
    };
    const direct = scope.RippaNodePlugin;
    if (direct && typeof direct.startForegroundService === "function") return direct;

    const plugins = scope.Capacitor?.Plugins;
    if (!plugins) return null;
    for (const id of [NATIVE_PLUGIN_ID, `${NATIVE_PLUGIN_ID}Plugin`]) {
      const candidate = plugins[id] as NativePlugin | undefined;
      if (candidate && typeof candidate.startForegroundService === "function") {
        return candidate;
      }
    }
    return null;
  } catch {
    // A probe that throws must not take the worker down with it.
    return null;
  }
}

/**
 * True when this build is running inside a shell that can protect the process.
 *
 * Separate from `native()` so the dashboard can say "this build cannot do that"
 * as a stated fact, rather than leaving the operator to infer it from a switch
 * that silently does nothing.
 */
export function isBackgroundServiceSupported(): boolean {
  return native() !== null;
}

/** What the dashboard renders for the background toggle and the status row. */
let backgroundService: { running: boolean; available: boolean; supported: boolean } = {
  running: false,
  available: false,
  supported: false,
};

/** The background-service block for the UI. */
export function backgroundServiceStatus(): Record<string, unknown> {
  return { ...backgroundService };
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
    // The single most important line in this log: it means this device is
    // running UNPROTECTED and will be reclaimed when the screen goes off.
    log("Native bridge unavailable — running without a foreground service.");
    backgroundService = { running: false, available: false, supported: false };
    return false;
  }
  try {
    await plugin.startForegroundService({
      title: "Rippa Node is running",
      message: "Foraging for the swarm. The screen may be off.",
    });
    const state = await plugin.isForegroundServiceRunning();
    backgroundService = {
      running: state?.running === true,
      // `available` is absent on builds predating the field; a missing key must
      // not read as "this build is broken", or the toggle would warn on a
      // perfectly good APK.
      available: state?.available !== false,
      supported: true,
    };
    log(`Foreground service running=${backgroundService.running}.`);
    return backgroundService.running;
  } catch (error) {
    // Never fatal: in a desktop browser preview there is no plugin at all, and
    // the worker should still run.
    log(`Could not start the foreground service: ${describe(error)}`);
    backgroundService = { running: false, available: false, supported: true };
    return false;
  }
}

/**
 * Stops the foreground service, clearing the notification and releasing the wake
 * lock.
 *
 * This is what the "Run as Background Service" switch calls when unticked. The
 * OS is then free to freeze and reclaim the app normally, which is the documented
 * meaning of turning it off: the node keeps working while it is in the
 * foreground, but sleeps when the tablet does.
 */
export async function stopBackgroundService(): Promise<boolean> {
  const plugin = native();
  if (!plugin) {
    backgroundService = { running: false, available: false, supported: false };
    return false;
  }
  try {
    await plugin.stopForegroundService();
    backgroundService = { running: false, available: true, supported: true };
    log("Foreground service stopped — the node now sleeps with the screen.");
    publish({ type: "background_service", backgroundService: backgroundServiceStatus() });
    return true;
  } catch (error) {
    log(`Could not stop the foreground service: ${describe(error)}`);
    return false;
  }
}

/**
 * Applies the operator's background-service choice.
 *
 * The single entry point behind the UI toggle, so ON and OFF cannot drift apart:
 * both go through the same native calls the boot path uses, and both report the
 * state the native side ACTUALLY returned rather than the state that was asked
 * for. That distinction is the whole point — a toggle that claims success while
 * the service failed to start is the bug that made this feature untrustworthy.
 */
export async function setBackgroundService(enabled: boolean): Promise<boolean> {
  if (!enabled) return stopBackgroundService();
  const started = await ensureBackgroundService();
  if (!started) {
    log("Background service was requested but Android did not start it.");
  }
  publish({ type: "background_service", backgroundService: backgroundServiceStatus() });
  return started;
}

/**
 * Re-reads the live service state without trying to change it.
 *
 * Used by the dashboard's poll so the switch reflects reality after Android
 * restarts or kills the service on its own — which it will, under memory
 * pressure, and which the operator needs to SEE rather than discover overnight.
 */
export async function refreshBackgroundService(): Promise<boolean> {
  const plugin = native();
  if (!plugin) {
    backgroundService = { running: false, available: false, supported: false };
    return false;
  }
  try {
    const state = await plugin.isForegroundServiceRunning();
    const next = {
      running: state?.running === true,
      available: state?.available !== false,
      supported: true,
    };
    const changed = next.running !== backgroundService.running;
    backgroundService = next;
    if (changed) publish({ type: "background_service", backgroundService: backgroundServiceStatus() });
    return backgroundService.running;
  } catch (error) {
    log(`Could not read the foreground service state: ${describe(error)}`);
    return backgroundService.running;
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

  /*
    THE CELLULAR GATE, AT INGESTION.

    Checked here, before the queue is even fetched, so a Wi-Fi-only node on
    cellular does not pull the task list at all. Checking after the fetch would
    still leave the node claiming tasks it must then abandon, which holds work
    that another node in the swarm could have finished.

    `networkSuspended` is the value the timer gate maintains; reading it directly
    keeps the two paths consistent with the timers that were torn down.
  */
  if (networkSuspended) return;

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

    // Feed the dashboard's history tile. Recorded from the REAL completion path
    // (not synthesised from a counter) so an entry always corresponds to a task
    // that genuinely ran and reported, with the payload status it reported.
    recordTaskCompletion(
      describeTaskForHistory(task),
      outcome === "success" ? "success" : outcome === "failure" ? "failed" : "timeout",
    );
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
    window.setInterval(() => void checkNetwork(), NETWORK_CHECK_MS),
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
  // BOTH gates are evaluated before any poller starts, in the same spirit as the
  // note above: a node that is on cellular with Wi-Fi-only set must not send one
  // heartbeat before it notices.
  await checkPower();
  await checkNetwork();

  if (!powerSuspended && !networkSuspended) {
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
    network: networkStatus(),
    // Live task telemetry for the dashboard (Epic 5). `activeTask` is null when
    // the node is idle, and the UI renders that as an explicit idle state rather
    // than a blank row — "Idle - Waiting for swarm sweep" is information, an
    // empty box is not.
    activeTask: currentTaskLabel(),
    taskHistory,
    // The setup card's badge, the telemetry row and the tests all read it from
    // here, so there is exactly one definition of "is this node paired".
    connection: connectionStatus(),
    /*
      Whether Android is currently protecting this process.

      Rendered by the dashboard's "Run as Background Service" switch and the
      matching status row. It is in workerStatus() rather than read directly from
      the plugin by the page because the page polls this object every two seconds
      and a bridge call per poll is exactly the cost this node is trying to
      avoid.
    */
    backgroundService: backgroundServiceStatus(),
  };
}

/**
 * A short description of what the node is doing right now.
 *
 * Returns the assignment label when there is one and an explicit idle string
 * when there is not. Deliberately never an empty string: the dashboard's whole
 * job here is to distinguish "working" from "waiting", and blank renders as a
 * failed read rather than as an idle node.
 */
function currentTaskLabel(): string {
  const active = satelliteWorker.getStatus()["currentTask"] as
    | { label?: string; type?: string }
    | null;
  if (!active) return "Idle \u2014 Waiting for swarm sweep";
  const label = String(active.label ?? "").trim();
  if (label) return label;
  const type = String(active.type ?? "").trim();
  return type ? `Executing ${type}` : "Executing a dispatched task";
}

/** Records a finished task into the capped history feed, newest first. */
function recordTaskCompletion(label: string, status: TaskHistoryEntry["status"]): void {
  taskHistory = [
    { at: new Date().toISOString(), label, status },
    ...taskHistory,
  ].slice(0, MAX_TASK_HISTORY);
}

/**
 * A one-line description of a completed task, for the history feed.
 *
 * Prefers a real target from the payload — the URL for a scrape, the count for a
 * batch — because "Completed scrape_data" is not something an operator scanning a
 * feed can learn anything from. Falls back to the task type only when the
 * payload genuinely carried nothing usable.
 */
function describeTaskForHistory(task: { type: string; payload?: Record<string, unknown> }): string {
  const payload = task.payload ?? {};
  const url = typeof payload["url"] === "string" ? payload["url"].trim() : "";
  if (url) {
    // Trimmed to the path: a full scraped URL carries query strings that wrap
    // onto three lines in a narrow phone feed.
    try {
      const parsed = new URL(url);
      return `Completed fetch: ${parsed.pathname || "/"}`;
    } catch {
      return `Completed fetch: ${url.slice(0, 40)}`;
    }
  }
  const count = Number(payload["count"] ?? payload["items"] ?? payload["total"]);
  if (Number.isFinite(count) && count > 0) {
    return `Completed ${count} ${String(task.type).replace(/_/g, " ")}`;
  }
  return `Completed ${String(task.type).replace(/_/g, " ")}`;
}

// --- IN-APP APK UPDATE CHECK -------------------------------------------------

/**
 * The build's version, for runtimes with no native bridge.
 *
 * INSIDE THE APK THIS IS NEVER USED: MobileBridge.getAppVersion() reports
 * BuildConfig.VERSION_NAME, which scripts/package-apk.mjs derives from the root
 * package.json, so the native answer is always the real one. This constant only
 * matters when the same dashboard is opened in a plain desktop browser, where
 * `window.mobileBridge` does not exist.
 *
 * IT IS INJECTED AT BUILD TIME, NOT HARD-CODED. `scripts/build-mobile-worker.mjs`
 * reads the root package.json and passes the version to esbuild as the
 * `__RIPPA_FALLBACK_APK_VERSION__` define, so this value is replaced with the real
 * version during bundling. It used to be a hand-maintained string literal that had
 * to be edited by hand on every release, and that is precisely why the APK job
 * failed in CI: the Bump-version step raises package.json on every push, so a
 * literal was stale from the moment of the bump. Worse, the literal drifted
 * silently until the next APK build failed on the version assertion below — a
 * reminder that arrives as a red build rather than as the one-line fix.
 *
 * The fallback below is only for a `tsx`-style run of this file with no bundler
 * (a browser preview straight from source); the APK build always substitutes the
 * injected value. `scripts/package-apk.mjs` asserts the value baked into the
 * emitted bundle matches package.json, so drift is still caught — but now at the
 * point where it is actually fixable.
 */
declare const __RIPPA_FALLBACK_APK_VERSION__: string | undefined;

const FALLBACK_APK_VERSION: string =
  typeof __RIPPA_FALLBACK_APK_VERSION__ === "string"
    ? __RIPPA_FALLBACK_APK_VERSION__
    : "0.0.0-dev";

/**
 * The Mothership routes this is tried against, in order.
 *
 * THREE PATHS, AND THE FIRST ONE IS THE POINT.
 *
 * `/api/node/latest-apk` is the route that actually breaks the `1.0.19`
 * fallback deadlock. It is served straight from the deployment's APK variables,
 * makes no GitHub call, and reports its version purely as a label — so a forced
 * check can install the published APK even when the advertised number is behind
 * the device. It is tried first for exactly that reason.
 *
 * The other two are the historical spellings of the release feed. They resolve
 * through GitHub, and on a private repo that lookup 404s on every poll and the
 * hard-coded fallback answers instead — which is how the fleet came to believe
 * `1.0.19` was current. They are kept only as a fallback for a Mothership that
 * has not shipped the APK route yet.
 *
 * A 404 falls through to the next, and the first route that answers wins. Once
 * a route has answered it is remembered for the life of the process, so every
 * later check costs one request rather than three.
 */
const UPDATE_ENDPOINTS = [
  "/api/node/latest-apk",
  "/api/node/latest-version",
  "/api/node/apk-version",
];

/** What the dashboard renders. `state` is the only field it branches on. */
export interface UpdateCheck {
  /** "available" (offer the update), "current", "unavailable" or "error". */
  state: "available" | "current" | "unavailable" | "error";
  /** Version this device is running, e.g. "1.0.14". */
  currentVersion: string;
  /** Version the Mothership publishes, when it answered. */
  remoteVersion: string;
  /** Absolute https URL of the .apk. Empty unless `state` is "available". */
  downloadUrl: string;
  /** Optional lowercase hex SHA-256, passed straight through to the bridge. */
  sha256: string;
  /** Release notes, or "". Rendered as text, never as HTML. */
  notes: string;
  /** ISO timestamp, so a stale banner can be explained later. */
  checkedAt: string;
}

/** In-flight check, so a manual re-check cannot stack on top of the timer. */
let updateCheckInFlight: Promise<UpdateCheck> | null = null;
/**
 * Whether that in-flight check was a FORCED one.
 *
 * Kept beside the promise so a forced caller is never handed a conservative
 * background answer (and vice versa) — see the note in `checkForUpdate`.
 */
let updateCheckInFlightForce = false;
/** The route that answered last time, so we stop paying for a 404 every 15 minutes. */
let updateEndpoint: string | null = null;

/**
 * The version this device is actually running.
 *
 * The native bridge is authoritative and is asked first: it reports
 * BuildConfig.VERSION_NAME, which is the real, installed value. The fallback
 * constant covers a desktop browser preview, where there is no bridge at all.
 */
function installedVersion(): string {
  try {
    const bridge = (globalThis as { mobileBridge?: { getAppVersion?: () => string } })
      .mobileBridge;
    const version = bridge?.getAppVersion?.();
    if (typeof version === "string" && version.trim().length > 0) {
      return version.trim();
    }
  } catch (error) {
    // A bridge that throws must not take the dashboard down with it; the fallback
    // is always better than an exception out of a render path.
    log(`Could not read the installed version from the bridge: ${describe(error)}`);
  }
  return FALLBACK_APK_VERSION;
}
/** First non-empty string among `keys`, or "". Tolerates the shapes Motherships use. */
function firstString(fields: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = fields[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return "";
}

/**
 * Normalises a release payload.
 *
 * DELIBERATELY LIBERAL about field names. This payload is written by a service
 * that is not in this repository, and a rename there must not silently disable
 * updates on every tablet in the fleet — so `version`/`tag_name`,
 * `download_url`/`url` and `notes`/`body` are all accepted, and an optional
 * one-level `{latest: …}` wrapper is unwrapped. Returns null when there is no
 * usable version AND no usable URL, which is the only case where offering an
 * update is impossible.
 */
function readRelease(
  payload: unknown,
): { version: string; downloadUrl: string; sha256: string; notes: string } | null {
  if (!payload || typeof payload !== "object") return null;
  const top = payload as Record<string, unknown>;
  const wrapped = ["latest", "release", "data", "apk"]
    .map((key) => top[key])
    .find((value) => value && typeof value === "object");
  const fields: Record<string, unknown> = wrapped
    ? { ...top, ...(wrapped as Record<string, unknown>) }
    : top;

  const version = firstString(fields, [
    "version",
    "latest_version",
    "latestVersion",
    "tag_name",
    "tag",
  ]);
  const downloadUrl = firstString(fields, [
    "download_url",
    "downloadUrl",
    "apk_url",
    "apkUrl",
    "browser_download_url",
    "url",
  ]);
  if (!version || !downloadUrl) return null;

  return {
    version,
    downloadUrl,
    sha256: firstString(fields, ["sha256", "sha256_checksum", "checksum"]),
    notes: firstString(fields, ["notes", "release_notes", "releaseNotes", "body", "changelog"]),
  };
}

/** Absolute-ises a download URL. A Mothership will often return a relative path. */
function resolveDownloadUrl(url: string): string {
  if (/^https?:\/\//i.test(url)) return url;
  const origin = base(config.mothershipUrl);
  if (!origin) return url;
  return `${origin}/${url.replace(/^\/+/, "")}`;
}
/**
 * Asks the Mothership what the newest satellite build is, and compares it with the
 * build actually installed on this device.
 *
 * NEVER THROWS. The dashboard calls this on a timer, and a rejected promise with no
 * handler would surface as an unhandled rejection in the WebView — so every failure
 * comes back as a state the page can render. That matters more than usual here:
 * this node is meant to run unattended for a week, and an exception that killed
 * the page's timer would also stop the update prompt, permanently and silently.
 *
 * NOT GATED ON PAIRING. Only a Mothership URL is required. The version route is
 * normally public, and a node whose key was revoked should still be told there is
 * a build that fixes the problem, rather than being left on the broken one.
 */
export async function checkForUpdate(options: { force?: boolean } = {}): Promise<UpdateCheck> {
  /*
    THE IN-FLIGHT GUARD IS KEYED ON `force`, NOT JUST SHARED.

    Two callers with different intent must not share one answer. The 15-minute
    background poll wants the conservative "is there genuinely a newer build?"
    verdict, while a manual "Check for Updates" tap wants "give me the APK the
    Mothership publishes". Sharing a single promise meant a manual tap landing
    while the background poll was in flight silently inherited the poll's
    conservative result — and that is exactly how the 1.0.19 fallback kept
    telling a 1.0.27 tablet "you are on the latest build".
  */
  const force = options.force === true;
  if (updateCheckInFlight && updateCheckInFlightForce === force) return updateCheckInFlight;
  updateCheckInFlightForce = force;
  updateCheckInFlight = runUpdateCheck(force).finally(() => {
    updateCheckInFlight = null;
    updateCheckInFlightForce = false;
  });
  return updateCheckInFlight;
}

/** The body of {@link checkForUpdate}, split out so the in-flight guard stays readable. */
async function runUpdateCheck(force: boolean): Promise<UpdateCheck> {
  /*
    LOAD THE STORED CONFIG FIRST, EVERY TIME.

    `config` is seeded from DEFAULT_CONFIG at module load and only replaced from
    localStorage inside startWorker(). Reading it without this call means an update
    check that runs before (or instead of) the worker booting queries the DEFAULT
    Mothership — https://rippaadventures.com — rather than the one this operator
    actually paired with. On a LAN deployment that is a request to the wrong
    server, and it silently never finds the update it was asked to find.

    loadConfig() is idempotent (localStorage read + merge) and this runs at most
    once every fifteen minutes, so the repetition costs nothing.
  */
  loadConfig();

  const currentVersion = installedVersion();
  const checkedAt = new Date().toISOString();
  const blank: UpdateCheck = {
    state: "unavailable",
    currentVersion,
    remoteVersion: "",
    downloadUrl: "",
    sha256: "",
    notes: "",
    checkedAt,
  };

  const origin = base(config.mothershipUrl);
  if (!origin) {
    // No Mothership configured yet. Not an error — the dashboard asks again right
    // after the operator saves the pairing form.
    return blank;
  }

  const routes = updateEndpoint ? [updateEndpoint] : UPDATE_ENDPOINTS;
  for (const route of routes) {
    try {
      const response = await fetch(`${origin}${route}`, { headers: authHeaders() });
      if (response.status === 404) continue; // try the next spelling of the route
      if (!response.ok) {
        log(`Version check on ${route} answered ${response.status}.`);
        return { ...blank, state: "error" };
      }

      const release = readRelease(await response.json());
      if (!release) {
        // A 200 with nothing usable in it. Worth saying out loud: this is what a
        // mis-typed route or a renamed field looks like, and it is otherwise
        // indistinguishable from "no update available".
        log(`Version check on ${route} returned no recognisable release payload.`);
        return { ...blank, state: "error" };
      }

      updateEndpoint = route; // stop paying for the 404 on every future check

      /*
        THE `1.0.19` FALLBACK TRAP, AND WHY A FORCED CHECK BYPASSES THIS GATE.

        The Mothership's release endpoint falls back to a hard-coded version when
        its GitHub lookup fails, and the release repo is PRIVATE — so the lookup
        fails on every poll and the fallback became the normal production answer.
        Left behind at 1.0.19 while the fleet ran 1.0.27, that constant meant a
        tablet asked "is 1.0.19 newer than 1.0.27?" is told no, and reported
        "This device is on the latest build (v1.0.19)" — a statement that is
        self-contradictory on its face and left the operator unable to update.

        The conservative comparison below stays CORRECT for the background poll:
        it is what stops a stale fallback from forcing a reinstall every 15
        minutes. But an explicit human tap on "Check for Updates" is a different
        instruction. The operator is not asking "is there newer?" — they are
        asking "show me the build you publish", and the Mothership's download URL
        is authoritative regardless of the version number attached to it. So a
        forced check offers the APK whenever a usable URL came back, and the
        `state: "current"` branch is only reached when there is nothing to offer.
      */
      if (!force && !isVersionNewer(release.version, currentVersion)) {
        return { ...blank, state: "current", remoteVersion: release.version, notes: release.notes };
      }

      return {
        state: "available",
        currentVersion,
        remoteVersion: release.version,
        downloadUrl: resolveDownloadUrl(release.downloadUrl),
        sha256: release.sha256,
        notes: release.notes,
        checkedAt,
      };
    } catch (error) {
      log(`Version check on ${route} failed: ${describe(error)}`);
      return { ...blank, state: "error" };
    }
  }

  log("Neither /api/node/latest-version nor /api/node/apk-version exists on the Mothership.");
  return blank;
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