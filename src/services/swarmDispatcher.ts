import crypto from "node:crypto";

import axios from "axios";
import { env } from "../config";
import { localIPv4 } from "../network/discovery";
import { getSystemVitals } from "./telemetry";
import {
  applyPeerProvision,
  classifyMeshKey,
  ensureNodeIdentity,
  getMeshKey,
  getPairing,
  getRevokedMeshKeys,
  isValidNodeCode,
  listPeers,
  loadRegistry,
  normalizeNodeCode,
  p2pEnabled,
  peerCandidateUrls,
  purgePeerMesh,
  revokeMeshKeys,
  rotateMeshKey,
  saveMeshKey,
  savePairing,
  saveRegistry,
  selfEndpoint,
  setP2pEnabled,
  verifyMeshKey,
  type MeshKeyStatus,
  type PeerEndpoint,
  type PersistedSatelliteRecord,
} from "../config/nodeAuth";
import { publishNodeEvent } from "./nodeEvents";
import {
  describeAiCapabilities,
  describeCapabilities,
  emptyCapabilities,
  mergeCapabilities,
  normaliseAiEnabled,
  type NodeCapabilities,
} from "./nodeCapabilities";
import type { MeshKeySyncDirective } from "./meshKeySync";

/**
 * RIPPA NODE AI — AUTO-PROVISIONING & P2P ROUTING.
 *
 * This is the brain that makes the mesh "zero-config": once a Satellite has
 * been paired (one time), the Master is solely responsible for telling it what
 * to do and who else is on the job.
 *
 * Responsibilities:
 *  1. REGISTRATION — accept a Satellite's pairing handshake, issue the mesh
 *     key, and remember the node (code, name, IP, port, cloud link URLs).
 *  2. AUTO-PROVISIONING — when a shared task is assigned to N Satellites, push
 *     a network payload to each one containing every SIBLING's IP, port and
 *     Cloud Link URLs. Satellites auto-fill this into their own settings, so
 *     they form a direct LAN/internet mesh with no operator input.
 *  3. ADAPTIVE FALLBACK — the Master watches real P2P collaboration results.
 *     When the error/timeout rate between siblings crosses a threshold it
 *     REVOKES the P2P flag and forces those nodes to report exclusively back
 *     to the Master, so a flaky peer link degrades instead of stalling.
 *  4. TELEMETRY — per-node performance metrics backing the Master Control
 *     Center UI (efficiency, load handling, problem-solving rate).
 *
 * Roles:
 *  - MASTER    owns the registry, assigns tasks, monitors P2P health.
 *  - SATELLITE polls the Master for assignments, executes them, reports back.
 *
 * The dispatcher speaks plain HTTP+JSON over sibling `/api/mesh/*` endpoints,
 * so it works identically on the LAN and over the internet via Cloud Link.
 */

// --- TUNING KNOBS -----------------------------------------------------------

/** How often a Satellite polls its Master for new assignments. */
const POLL_INTERVAL_MS = 10_000;
/** How often the Master re-checks satellite liveness. */
const MONITOR_INTERVAL_MS = 15_000;
/** Per-request timeout when talking to a sibling or the Master. */
const MESH_HTTP_TIMEOUT_MS = 15_000;
/** A satellite silent for this long is marked offline in the UI. */
const SATELLITE_OFFLINE_AFTER_MS = 45_000;

/**
 * How long a satellite stays in the registry after it was last seen.
 *
 * DISTINCT FROM `SATELLITE_OFFLINE_AFTER_MS` ON PURPOSE. "Offline" is a live
 * state — a laptop that is asleep must still appear in the Swarm Grid, because
 * it is still paired and the cloud's `connected_satellites` is about peering,
 * not reachability. But a node that has not been heard from in hours is
 * different: it is a decommissioned or re-homed machine whose code nobody
 * claimed, and those are exactly the entries that accumulate into a fleet view
 * full of permanent "not a registered node" warnings.
 *
 * Deliberately long (6 hours) so a node merely powered off overnight survives,
 * and pruning only removes what is genuinely abandoned.
 */
const SATELLITE_FORGET_AFTER_MS = 6 * 60 * 60_000;

/**
 * How long to wait before repeating an identical authentication complaint.
 *
 * A satellite presenting a stale key retries every 10 seconds. Logging each one
 * turns a single stale credential into 360 identical lines an hour, which buries
 * every other message in the console and in the dashboard's warning strip. The
 * first failure is always reported; subsequent identical ones are counted and
 * summarised, so the condition stays visible without being a firehose.
 */
const AUTH_WARNING_THROTTLE_MS = 5 * 60_000;

/**
 * Adaptive fallback thresholds. When the failure ratio of a node's recent P2P
 * exchanges exceeds P2P_FAILURE_RATIO_LIMIT, the Master revokes its P2P flag.
 */
const P2P_WINDOW_SIZE = 20;
/** Fraction (0-1) of failed/timeout P2P exchanges that triggers revocation. */
const P2P_FAILURE_RATIO_LIMIT = 0.4;
/** Never revoke below this sample count (prevents noise-driven flapping). */
const P2P_MIN_SAMPLES = 4;
/** Finished tasks retained for history before the oldest are pruned. */
const MAX_RETAINED_TASKS = 50;

/** Efficiency score weights (must total 1). */
const W_UPTIME = 0.4;
const W_SUCCESS = 0.6;

/** Load buckets reported per satellite. */
export type LoadClass = "heavy" | "normal" | "lite";

/** Outcome of a single task attempt as reported by a node. */
export type TaskOutcome = "success" | "failure" | "timeout";

/** A task the Master hands to one or more Satellites. */
export interface SwarmAssignment {
  id: string;
  label: string;
  load: LoadClass;
  /** Node codes participating in this shared task. */
  assignees: string[];
  /** True while the nodes may collaborate directly; false after revocation. */
  p2p: boolean;
  createdAt: string;
  /** ISO timestamp when the Master revoked P2P for this task. */
  p2pRevokedAt?: string;
  /** Human-readable reason recorded when P2P was revoked. */
  p2pRevokeReason?: string;
}

/** Rolling P2P health between the Master and one satellite. */
export interface P2pHealth {
  attempts: number;
  failures: number;
  timeouts: number;
  /** True once the Master revoked P2P for this node. */
  revoked: boolean;
  revokedReason?: string;
}

/** Performance counters for one node, as shown in the detail modal. */
export interface NodeMetrics {
  tasksSucceeded: number;
  tasksFailed: number;
  tasksTimedOut: number;
  /** Successes per load bucket. */
  loadSuccess: Record<LoadClass, number>;
  /** Attempts per load bucket (success rate derives from these). */
  loadAttempts: Record<LoadClass, number>;
  /** Challenges (captcha / retry loop) encountered. */
  challenges: number;
  /** Challenges resolved without human help. */
  challengesResolved: number;
  /** Uptime in seconds, accumulated between heartbeats. */
  uptimeSeconds: number;
  /** Host uptime in seconds, reported by the node itself. */
  systemUptimeSeconds?: number;
  /** CPU load 0-100 across all cores, sampled on the node. */
  cpuUsage?: number;
  /** Physical memory in use, 0-100, sampled on the node. */
  ramUsage?: number;
  /** Logical CPU core count, reported by the node. */
  cpuCores?: number;
  lastStatus: "idle" | "busy";
  lastSeenAt: string;
  registeredAt: string;
  /**
   * What this node says it can do — AI or scraper, and on what runtime.
   *
   * Optional because an older build never sends it, and its ABSENCE is itself
   * meaningful: a node that reports nothing is `aiEnabled: null` ("unknown"),
   * which the UI must not render as a confirmed scraper. See
   * ./nodeCapabilities.ts for the tri-state rules.
   */
  capabilities?: NodeCapabilities;
}

/** A satellite as known by the Master. */
export interface SatelliteRecord {
  nodeCode: string;
  nodeName: string;
  endpoint: PeerEndpoint;
  /** Whether the Master currently allows direct P2P with this node. */
  p2pEnabled: boolean;
  /** Task currently executing (null when idle). */
  currentTask: SwarmAssignment | null;
  /** Task ids completed since registration. */
  completedTaskIds: string[];
  p2pHealth: P2pHealth;
  metrics: NodeMetrics;
}

/**
 * The subset of a SatelliteRecord that survives a Master restart.
 *
 * WHY THE REGISTRY IS PERSISTED AT ALL. The registry is the only thing standing
 * between "the Satellite paired" and "the Swarm Grid shows it", and it lived
 * purely in memory. Every Master restart therefore wiped the fleet view back to
 * "0 satellites" and the `connected_satellites` array the Mothership heartbeat
 * reports went empty with it — indistinguishable, from the cloud's side, from
 * having no satellites at all.
 *
 * Deliberately NOT persisted: `currentTask` and `p2pHealth`. A task that was
 * running when the Master died is not running now, and resurrecting stale health
 * counters would let a revoked node look legitimately provisioned. Endpoints
 * and metrics are the facts that stay true on their own.
 *
 * The shape itself is `PersistedSatelliteRecord`, imported from `config/nodeAuth`
 * so the on-disk contract has exactly one definition next to the code that
 * reads and writes it.
 */

/** Result of the Satellite's one-time pairing handshake. */
export interface PairingResult {
  /** Mesh key issued by the Master and persisted by the Satellite. */
  meshKey: string;
  /** The Master's endpoint (IP/port/Cloud Link) for later heartbeats. */
  masterEndpoint: PeerEndpoint;
  /** The Master's permanent node code. */
  masterCode: string;
}

/**
 * What happened when a Rippa AI key-sync directive was applied.
 *
 * Returned rather than logged-and-discarded so the caller (and the verification
 * harness) can assert on the outcome: a rotation that silently failed to reach
 * the fleet looks identical from the outside to one that worked.
 */
export interface MeshKeySyncResult {
  /** True when the active mesh key was replaced. */
  rotated: boolean;
  /** True when revoked keys were recorded (even if they were already known). */
  revokedKeysApplied: boolean;
  /** Node codes removed from the registry and peer list. */
  purgedNodes: string[];
  /** Satellites successfully pushed the new key to. */
  notified: number;
  /** Satellites the push did not reach (offline, or blocked). */
  failed: number;
}

/**
 * The reply a Master sends to a satellite it could not authenticate.
 *
 * WHY NOT JUST A 401. A bare 401 tells a satellite nothing except "no", so it
 * retries the same dead credential forever and the operator sees a permanently
 * red node. `syncReset` gives the satellite an actionable recovery path and
 * tells it explicitly not to treat this as fatal.
 *
 * `meshKey` is deliberately OPTIONAL and is only ever populated for a caller
 * that proved it once held a current key (see {@link SwarmDispatcher.authenticateOrReset}).
 * An unauthenticated caller gets `reauthRequired` and must go through the
 * pairing handshake — otherwise any process that can reach the port could
 * simply ask for the fleet credential.
 */
export interface SyncResetPayload {
  /** Machine-readable reason, e.g. "stale-key" | "revoked-key" | "unknown-key". */
  reason: string;
  /** True when the satellite should re-run the pairing handshake. */
  reauthRequired: boolean;
  /**
   * The active mesh key. Present ONLY when the caller proved prior membership by
   * presenting a recently-rotated (not revoked) key.
   */
  meshKey?: string;
  /** The Master's node code, so the satellite can confirm it reached the right node. */
  masterCode: string;
  /** Human-readable explanation, safe to log on the satellite. */
  message: string;
}
// --- METRICS MATH -----------------------------------------------------------

/** Safe ratio helper: returns 0 (not NaN) when the denominator is 0. */
function ratio(part: number, whole: number): number {
  return whole > 0 ? part / whole : 0;
}

/** Clamp helper — keeps NaN out of every score. */
function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** Fresh, zeroed metrics for a newly registered node. */
export function emptyMetrics(): NodeMetrics {
  return {
    tasksSucceeded: 0,
    tasksFailed: 0,
    tasksTimedOut: 0,
    loadSuccess: { heavy: 0, normal: 0, lite: 0 },
    loadAttempts: { heavy: 0, normal: 0, lite: 0 },
    challenges: 0,
    challengesResolved: 0,
    uptimeSeconds: 0,
    lastStatus: "idle",
    lastSeenAt: new Date().toISOString(),
    registeredAt: new Date().toISOString(),
  };
}

/**
 * EFFICIENCY SCORE (0-100).
 *
 * Weighted blend of two measurable signals:
 *  - uptime share (heartbeat coverage since registration), weight 0.4
 *  - task success rate (successes / all attempts), weight 0.6
 *
 * A node that has never completed a task still scores on uptime alone, so a
 * freshly paired satellite is not shown as 0 and flagged "broken".
 */
export function efficiencyScore(metrics: NodeMetrics): number {
  const now = Date.now();
  const registered = Date.parse(metrics.registeredAt) || now;
  const lastSeen = Date.parse(metrics.lastSeenAt) || now;
  const elapsedSeconds = Math.max(1, (lastSeen - registered) / 1000);
  const uptimeShare = clamp01(ratio(metrics.uptimeSeconds, elapsedSeconds));
  const attempts = metrics.tasksSucceeded + metrics.tasksFailed + metrics.tasksTimedOut;
  const successShare = ratio(metrics.tasksSucceeded, attempts);
  const score = 100 * (W_UPTIME * uptimeShare + W_SUCCESS * successShare);
  return Math.round(clamp01(score / 100) * 100);
}

/**
 * PROBLEM SOLVING RATE (0-100).
 *
 * How often a node clears a captcha / retry loop on its own rather than failing
 * the task. With no challenges recorded the answer is 100 ("nothing to solve
 * yet") rather than a division error.
 */
export function problemSolvingRate(metrics: NodeMetrics): number {
  if (metrics.challenges <= 0) return 100;
  return Math.round(clamp01(ratio(metrics.challengesResolved, metrics.challenges)) * 100);
}

/** LOAD HANDLING — combined success rate across all load buckets (0-100). */
export function loadHandlingScore(metrics: NodeMetrics): number {
  const classes: LoadClass[] = ["heavy", "normal", "lite"];
  const attempted = classes.reduce((sum, key) => sum + metrics.loadAttempts[key], 0);
  if (attempted <= 0) return 100;
  const succeeded = classes.reduce((sum, key) => sum + metrics.loadSuccess[key], 0);
  return Math.round(clamp01(ratio(succeeded, attempted)) * 100);
}

// --- HTTP HELPER ------------------------------------------------------------

/** Uniform result of one mesh HTTP call, so P2P health can be scored. */
type MeshCallResult =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; timedOut: boolean; reason: string };

/**
 * POSTs `body` to `<base><path>` with the mesh key attached, trying each URL in
 * `urls` in order (LAN first, then Cloud Link) and returning the first success.
 *
 * Failure on every candidate is reported as ONE result, so the Master's
 * adaptive monitor sees one message per logical peer exchange rather than one
 * per route attempted.
 */
export async function meshPost(
  urls: string[],
  path: string,
  body: Record<string, unknown>,
  meshKey: string,
  timeoutMs = MESH_HTTP_TIMEOUT_MS,
): Promise<MeshCallResult> {
  let lastReason = "no reachable endpoint";
  let lastTimedOut = false;
  for (const base of urls) {
    if (!base) continue;
    try {
      const response = await axios.post(`${base.replace(/\/+$/, "")}${path}`, body, {
        timeout: timeoutMs,
        headers: { "Content-Type": "application/json", "X-Mesh-Key": meshKey },
      });
      const data = (response.data ?? {}) as Record<string, unknown>;
      if (data.success === false) {
        lastReason = String(data.message || "peer rejected the payload");
        continue;
      }
      return { ok: true, data };
    } catch (error) {
      lastTimedOut =
        axios.isAxiosError(error) &&
        (error.code === "ECONNABORTED" || /timeout/i.test(error.message));
      lastReason = error instanceof Error ? error.message : String(error);
    }
  }
  return { ok: false, timedOut: lastTimedOut, reason: lastReason };
}

// --- DISPATCHER -------------------------------------------------------------

/**
 * In-process registry + task engine for the mesh.
 *
 * The Master keeps the authoritative {@link SatelliteRecord} map in memory
 * (rebuilt from Satellite heartbeats after a restart). Satellites own a single
 * assignment slot and a peer list, both filled automatically by the Master.
 */
export class SwarmDispatcher {
  /** Master-only: nodeCode -> record. */
  private readonly registry = new Map<string, SatelliteRecord>();
  /** Master-only: taskId -> assignment. */
  private readonly tasks = new Map<string, SwarmAssignment>();
  /** Master-only: the mesh key issued to every paired Satellite. */
  private meshKey = "";
  /** Master-only: the self endpoint advertised to satellites. */
  private masterEndpoint: PeerEndpoint | null = null;

  /** Any role: the single assignment this node is currently executing. */
  private activeAssignment: SwarmAssignment | null = null;
  /** Any role: how the active assignment is actually being executed. */
  private reportingMode: "p2p" | "master-relay" = "p2p";
  /** Any role: metrics this node reports about its own work. */
  private localMetrics: NodeMetrics = emptyMetrics();
  /** Any role: last instant a heartbeat landed. */
  private lastHeartbeatAt = 0;
  /** Satellite: guards the one-time pairing handshake against a retry storm. */
  private pairingInFlight = false;
  /** Master-only: debounce timer for registry writes to config.json. */
  private persistTimer: NodeJS.Timeout | null = null;
  /**
   * Master-only: throttles repeated "stale credential" log lines.
   *
   * Keyed by `nodeCode + status` so two different nodes failing for different
   * reasons are never collapsed into one suppressed message — throttling must
   * reduce repetition, not hide distinct problems.
   */
  private readonly authWarnings = new Map<string, { at: number; count: number }>();

  private monitorTimer: NodeJS.Timeout | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private running = false;

  /** The permanent code identifying this node on the mesh. */
  get nodeCode(): string {
    return ensureNodeIdentity().code;
  }

  /** True when this instance is running as the Master. */
  get isMaster(): boolean {
    return env.NODE_ROLE === "master";
  }

  /** The assignment this node is currently running (null when idle). */
  getActiveAssignment(): SwarmAssignment | null {
    return this.activeAssignment;
  }

  /** How this node is reporting its current work ("p2p" | "master-relay"). */
  getReportingMode(): "p2p" | "master-relay" {
    return this.reportingMode;
  }

  /** Metrics for THIS node, as it reports them upward. */
  getLocalMetrics(): NodeMetrics {
    return this.localMetrics;
  }

  /** Starts the loop appropriate to this node's role (idempotent). */
  start(): void {
    if (this.running) return;
    this.running = true;
    ensureNodeIdentity();

    if (this.isMaster) {
      // The mesh key is minted once and handed to every Satellite at pairing
      // time; it authenticates all sibling traffic afterwards.
      /*
        READ THE PERSISTED KEY FIRST — this line was `if (!this.meshKey) this.meshKey = mint`,
        which is a latent lock-out bug this comment already describes.

        `this.meshKey` starts as "" on every process start, so the guard was
        ALWAYS true and the Master minted a brand-new key on every single boot.
        The very next line then persisted that new key, so the two halves of the
        comment below were true in the worst possible way: each restart
        invalidated the credential every paired satellite was still holding. The
        symptom is precisely the one being chased here — satellites suddenly
        failing authentication, tasks idle, and a fleet view full of nodes that
        appear registered but cannot check in.

        Reading from config.json before minting is what the comment has always
        said happens; this makes the code match it. `applyMothershipSync` remains
        the only sanctioned way for the ACTIVE key to change.
      */
      this.meshKey = getMeshKey() || `mesh-${crypto.randomUUID()}`;
      /*
        PERSISTED, NOT REGENERATED PER BOOT — this was the "Master shows 0
        satellites" bug. The key used to be a fresh random string on every
        start, so each Satellite was still holding the PREVIOUS boot's key,
        every /api/mesh/heartbeat was rejected 401, `registerSatellite` was
        never reached, and the Master's registry stayed permanently empty.
        It is long-lived shared state, exactly like the node code beside it,
        so it is read from config.json first and only minted when absent.
      */
      if (getMeshKey() !== this.meshKey) {
        // Written so the NEXT boot reuses this key rather than minting another.
        saveMeshKey(this.meshKey, this.nodeCode);
      }
      this.restoreRegistry();
      this.masterEndpoint = selfEndpoint(localIPv4());
      this.monitorTimer = setInterval(() => void this.runMonitorCycle(), MONITOR_INTERVAL_MS);
      this.monitorTimer.unref?.();
      console.log(
        `[Swarm] Rippa Node AI active (MASTER) — monitoring every ${MONITOR_INTERVAL_MS / 1000}s.`,
      );
    } else {
      this.pollTimer = setInterval(() => void this.runSatelliteCycle(), POLL_INTERVAL_MS);
      this.pollTimer.unref?.();
      console.log(
        `[Swarm] Rippa Node AI active (SATELLITE) — polling Master every ${POLL_INTERVAL_MS / 1000}s.`,
      );
      /*
        PAIR ON ARRIVAL, NOT ONLY WHEN ASKED.

        A Satellite with a Master URL that has never completed the handshake
        would otherwise idle forever: the poll cycle returns early when there
        is no pairing record, and nothing else ever called `pairWithMaster`, so
        the Master never learned the node existed. Retrying here is what turns
        "configured to point at a Master" into "actually in the Swarm Grid".
      */
      void this.ensurePaired();
    }
  }

  /**
   * Satellite: performs the one-time handshake if it has never paired.
   *
   * A no-op once paired, and guarded against overlapping attempts so an
   * unreachable Master cannot stack up a request per poll interval.
   */
  private async ensurePaired(): Promise<void> {
    if (this.isMaster || this.pairingInFlight) return;
    if (getPairing()) return;
    // Mid-setup with no Master URL saved yet — the config-change handler calls
    // this again as soon as one exists.
    const masterUrl = (env.MASTER_LOCAL_URL || "").trim();
    if (!/^https?:\/\//i.test(masterUrl)) return;

    this.pairingInFlight = true;
    try {
      await this.pairWithMaster(masterUrl);
    } catch (error) {
      // Expected while the Master is still booting or the LAN is not up yet;
      // the next poll cycle tries again.
      console.warn(
        `[Swarm] Pairing with ${masterUrl} failed — ${
          error instanceof Error ? error.message : String(error)
        } (will retry)`,
      );
    } finally {
      this.pairingInFlight = false;
    }
  }

  /**
   * Public entry point for `ensurePaired`, so a config save that introduces a
   * Master URL triggers the handshake at once instead of a poll interval later.
   */
  async ensurePairedWithMaster(): Promise<void> {
    await this.ensurePaired();
  }

  /**
   * DISCARDS ALL IN-MEMORY MESH STATE so this node can start again under a new
   * identity.
   *
   * Called right after `regenerateNodeCode()` / `setNodeCode()`. Those functions
   * clear the PERSISTED associations in config.json; this clears the ones held
   * in this process. Both halves are required, and missing either is a real bug:
   *
   *  - Config only  -> a Master would keep serving the OLD registry, so the
   *    Swarm Grid still listed every satellite paired to the previous code, and
   *    the old mesh key would still authenticate their heartbeats.
   *  - Memory only  -> the new code would be written to disk but the live
   *    process would keep advertising the old one until the next restart, so the
   *    UI would show a code the node was not actually using.
   *
   * Deliberately does NOT touch the operator's settings or restart the poll /
   * monitor intervals: this is an identity change, not a reconfiguration, and
   * the node keeps working throughout.
   */
  resetIdentity(): void {
    this.registry.clear();
    this.tasks.clear();
    this.activeAssignment = null;
    this.reportingMode = "p2p";
    this.lastHeartbeatAt = 0;
    // A pairing attempt in flight belongs to the old identity; letting it finish
    // would re-write the pairing record we just cleared.
    this.pairingInFlight = false;
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    if (this.isMaster) {
      // The Master owns the mesh key it issues, and the cleared MESH_KEY means a
      // fresh one is minted here and persisted — otherwise every Satellite would
      // present a key this node no longer recognises and be 401'd forever.
      this.meshKey = `mesh-${crypto.randomUUID()}`;
      saveMeshKey(this.meshKey, this.nodeCode);
      this.masterEndpoint = selfEndpoint(localIPv4());
      saveRegistry([]);
      console.log("[Swarm] Identity reset — new mesh key issued, registry cleared.");
    } else {
      this.meshKey = "";
      this.masterEndpoint = null;
      // Re-pair immediately rather than waiting for the next poll tick, so the
      // node is a good swarm citizen again within seconds of the change.
      void this.ensurePaired();
      console.log("[Swarm] Identity reset — re-pairing with the Master.");
    }
  }

  /** Stops the background loop. Safe to call repeatedly. */
  stop(): void {
    this.running = false;
    if (this.monitorTimer) {
      clearInterval(this.monitorTimer);
      this.monitorTimer = null;
    }
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  /** The mesh key used for node-to-node calls (Master: issues it). */
  getMeshKeyOrEmpty(): string {
    return this.meshKey || getMeshKey();
  }

  /** True when the presented key matches this node's mesh key. */
  authenticate(candidate: string | undefined): boolean {
    return this.isMaster
      ? Boolean(this.meshKey) && this.meshKey === candidate
      : verifyMeshKey(candidate);
  }

  /**
   * MASTER: classifies a key a satellite presented.
   *
   * The Master's in-memory key is authoritative, so `valid` is decided against
   * it rather than against config.json. The `stale` / `revoked` / `unknown`
   * verdicts come from the persisted rotation state, which is written by
   * {@link applyMothershipSync}.
   */
  classifyPresentedKey(candidate: string | undefined): MeshKeyStatus {
    if (!this.isMaster) return verifyMeshKey(candidate) ? "valid" : "unknown";
    const presented = String(candidate ?? "").trim();
    if (!presented) return "missing";
    if (this.meshKey && this.meshKey === presented) return "valid";
    if (getRevokedMeshKeys().includes(presented)) return "revoked";

    // `classifyMeshKey` reads the persisted key; on the Master the in-memory
    // value is the live one, so only the stale/revoked branches are delegated.
    const status = classifyMeshKey(presented);
    return status === "valid" ? "unknown" : status;
  }

  /**
   * MASTER: authenticates a satellite, and on failure explains how to recover.
   *
   * THE SECURITY CONTRACT, and it is the important part of this change.
   *
   * A `stale` key — one this node rotated out within the grace window — is
   * PROOF that the caller was recently authenticated. It is therefore safe, and
   * correct, to hand that caller the active key in the reply: it is exactly the
   * satellite the rotation was meant to re-provision, and the alternative is that
   * it stays locked out until an operator touches it by hand.
   *
   * An `unknown` or `missing` key proves nothing. Those callers get the same
   * machine-readable reset so their client can re-pair automatically, but NOT
   * the key itself — otherwise anything that can reach the port could read the
   * fleet credential out of a rejected request and then use it.
   *
   * A `revoked` key is never upgraded, in either direction. Rippa AI withdrew
   * that credential deliberately, and quietly restoring it would override a
   * decision the operator's own control panel made.
   */
  authenticateOrReset(
    candidate: string | undefined,
    nodeCode = "",
  ): { ok: true } | { ok: false; status: MeshKeyStatus; reset: SyncResetPayload } {
    const status = this.classifyPresentedKey(candidate);
    if (status === "valid") return { ok: true };

    const code = normalizeNodeCode(nodeCode) || nodeCode || "unknown node";
    const reset = this.buildSyncReset(code, status);
    this.logAuthWarning(code, status, reset.message);
    return { ok: false, status, reset };
  }

  /**
   * Builds the recovery payload for an unauthenticated satellite.
   *
   * Split out from {@link authenticateOrReset} so the same shape can be produced
   * for a node that has vanished from the registry (see
   * {@link applyMothershipSync}) without going through a failed authentication.
   */
  buildSyncReset(nodeCode: string, status: MeshKeyStatus): SyncResetPayload {
    const masterCode = this.nodeCode;
    const base = { masterCode, reauthRequired: true };

    if (status === "stale") {
      // Prior membership proven — hand over the current key so the satellite can
      // rejoin on its next poll with no operator involvement.
      return {
        ...base,
        reason: "stale-key",
        meshKey: this.getMeshKeyOrEmpty(),
        message:
          `Mesh key rotated by Rippa AI. ${nodeCode} presented the previous key and has ` +
          `been issued the active one automatically — no reconfiguration needed.`,
      };
    }
    if (status === "revoked") {
      return {
        ...base,
        reason: "revoked-key",
        message:
          `The key presented by ${nodeCode} was revoked by Rippa AI and cannot be renewed. ` +
          `Re-pair to join the swarm under the current identity.`,
      };
    }
    if (status === "missing") {
      return {
        ...base,
        reason: "missing-key",
        message: `${nodeCode} sent no mesh key. Re-pair to join the swarm.`,
      };
    }
    return {
      ...base,
      reason: "unknown-key",
      message:
        `${nodeCode} presented a key this Master does not recognise — it is not a registered ` +
        `node. Re-pair to be issued the active mesh key.`,
    };
  }

  /**
   * Logs an authentication problem at most once per throttle window.
   *
   * The suppressed count is reported when the window reopens, so a node that has
   * been failing for an hour reads as "N suppressed attempts" rather than as a
   * single isolated event — the count is the diagnostic, and dropping it would
   * make a permanently broken node look like a momentary blip.
   */
  private logAuthWarning(nodeCode: string, status: MeshKeyStatus, message: string): void {
    const key = `${nodeCode}:${status}`;
    const now = Date.now();
    const previous = this.authWarnings.get(key);

    if (previous && now - previous.at < AUTH_WARNING_THROTTLE_MS) {
      previous.count += 1;
      return;
    }

    const suppressed = previous?.count ?? 0;
    this.authWarnings.set(key, { at: now, count: 0 });
    console.warn(
      `[Swarm] ${message}` +
        (suppressed > 0 ? ` (${suppressed} further attempt(s) suppressed)` : ""),
    );
  }

  /** The endpoint this node advertises to its peers. */
  getSelfEndpoint(): PeerEndpoint {
    return selfEndpoint(localIPv4());
  }

  /** The Master's own endpoint (falls back to the live LAN address). */
  private selfEndpoint(): PeerEndpoint {
    return this.masterEndpoint ?? selfEndpoint(localIPv4());
  }
// =========================================================================
  // MASTER — REGISTRATION (the one-time pairing handshake)
  // =========================================================================

  /**
   * MASTER: registers (or refreshes) a Satellite and returns the mesh key plus
   * the Master's own endpoint.
   *
   * This is the ONLY interaction an operator ever performs. The Satellite sends
   * its permanent node code and address once; everything after this — routing,
   * P2P provisioning, monitoring — is driven by the Master.
   */
  registerSatellite(input: {
    nodeCode: string;
    nodeName: string;
    ipAddress?: string;
    port?: number;
    cloudLinkUrl?: string;
  }): { record: SatelliteRecord; meshKey: string; masterEndpoint: PeerEndpoint } {
    const nodeCode = normalizeNodeCode(input.nodeCode);
    if (!isValidNodeCode(nodeCode)) {
      throw new Error("A valid rippa_node_code is required to pair (format RIPPA-XXXX-XXXX).");
    }
    if (!this.isMaster) throw new Error("Only a Master node can register satellites.");
    if (!this.meshKey) {
      // Same boot-order safety net as `start()`: the key must be stable across
      // restarts, so fall back to the persisted one before minting.
      this.meshKey = getMeshKey() || `mesh-${crypto.randomUUID()}`;
      saveMeshKey(this.meshKey, this.nodeCode);
    }

    const ip = (input.ipAddress || "").trim();
    const port = Number(input.port) || env.PORT;
    const endpoint: PeerEndpoint = {
      nodeCode,
      nodeName: (input.nodeName || nodeCode).slice(0, 60),
      ipAddress: ip,
      port,
      lanUrl: `http://${ip || "127.0.0.1"}:${port}`,
      cloudLinkUrl: (input.cloudLinkUrl || "").trim(),
      lastProvisionedAt: new Date().toISOString(),
    };

    const existing = this.registry.get(nodeCode);
    if (existing) {
      existing.nodeName = endpoint.nodeName;
      existing.endpoint = endpoint;
      existing.metrics.lastSeenAt = new Date().toISOString();
      console.log(`[Swarm] Satellite ${nodeCode} (${endpoint.nodeName}) re-registered.`);
      return { record: existing, meshKey: this.meshKey, masterEndpoint: this.selfEndpoint() };
    }

    const record: SatelliteRecord = {
      nodeCode,
      nodeName: endpoint.nodeName,
      endpoint,
      p2pEnabled: true,
      currentTask: null,
      completedTaskIds: [],
      p2pHealth: { attempts: 0, failures: 0, timeouts: 0, revoked: false },
      metrics: emptyMetrics(),
    };
    this.registry.set(nodeCode, record);
    console.log(`[Swarm] SATELLITE PAIRED: ${endpoint.nodeName} (${nodeCode}) at ${endpoint.lanUrl}`);
    this.schedulePersist();
    return { record, meshKey: this.meshKey, masterEndpoint: this.selfEndpoint() };
  }

  /**
   * MASTER: writes the registry to config.json, debounced.
   *
   * Debounced because the registry changes on every satellite heartbeat (10s
   * each) and `writeConfig` is a synchronous full-file rewrite — doing that per
   * heartbeat would put disk I/O on the hot path of the poll loop for no benefit.
   * One second of coalescing turns a burst of N heartbeats into one write while
   * still persisting promptly enough that a hard kill loses at most a heartbeat.
   */
  private schedulePersist(): void {
    if (!this.isMaster || this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.persistRegistry();
    }, 1_000);
    this.persistTimer.unref?.();
  }

  /** Writes the survivable part of the registry to config.json. Best effort. */
  private persistRegistry(): void {
    if (!this.isMaster) return;
    const payload: PersistedSatelliteRecord[] = [...this.registry.values()].map((record) => ({
      nodeCode: record.nodeCode,
      nodeName: record.nodeName,
      endpoint: record.endpoint,
      p2pEnabled: record.p2pEnabled,
      completedTaskIds: record.completedTaskIds.slice(-20),
      // Widened to a plain record because the persisted shape is untyped JSON on
      // the way back in — see the cast in `restoreRegistry`.
      metrics: { ...record.metrics } as Record<string, unknown>,
    }));
    try {
      saveRegistry(payload);
    } catch (error) {
      // Losing the fleet view across a restart is recoverable; killing the
      // heartbeat loop over a write failure is not.
      console.warn(
        `[Swarm] Could not persist the satellite registry — ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * MASTER: restores the registry saved by a previous run.
   *
   * Called at boot, before any satellite can heartbeat in. Restored nodes start
   * as OFFLINE (their `lastSeenAt` is in the past) and flip to online on their
   * next poll, so a node that never comes back is visibly greyed out rather
   * than silently reported as healthy.
   */
  private restoreRegistry(): void {
    if (!this.isMaster) return;
    const saved = loadRegistry();
    if (saved.length === 0) return;
    for (const entry of saved) {
      if (this.registry.has(entry.nodeCode)) continue;
      const metrics = (entry.metrics ?? {}) as Partial<NodeMetrics>;
      this.registry.set(entry.nodeCode, {
        nodeCode: entry.nodeCode,
        nodeName: entry.nodeName,
        endpoint: entry.endpoint,
        p2pEnabled: entry.p2pEnabled !== false,
        // Never resurrected: a task from a previous boot is not running now.
        currentTask: null,
        completedTaskIds: Array.isArray(entry.completedTaskIds) ? entry.completedTaskIds : [],
        p2pHealth: { attempts: 0, failures: 0, timeouts: 0, revoked: false },
        // The persisted `lastSeenAt` is deliberately KEPT rather than reset to
        // now: it is what makes a restored node render as offline until its
        // first poll, instead of appearing healthy before it has been heard from.
        metrics: { ...emptyMetrics(), ...metrics, lastSeenAt: metrics.lastSeenAt ?? "" },
      });
    }
    console.log(`[Swarm] Restored ${this.registry.size} satellite(s) from the previous run.`);
  }

  /**
   * MASTER: the peer payload pushed to each assignee of a shared task.
   *
   * This is the "auto-fill" payload: for a task with N assignees, every
   * assignee receives the IP, port and Cloud Link URLs of the other N-1 nodes.
   * Satellites apply it automatically and never ask the user for an address.
   */
  private buildSiblingPayload(task: SwarmAssignment, forNode: string): PeerEndpoint[] {
    return task.assignees
      .filter((code) => code !== forNode)
      .map((code) => this.registry.get(code)?.endpoint)
      .filter((endpoint): endpoint is PeerEndpoint => Boolean(endpoint));
  }

  /**
   * MASTER: records a Satellite heartbeat and returns its current work.
   *
   * One request does everything the Satellite needs each cycle: register (or
   * refresh), report metrics, receive the assignment, and receive the sibling
   * endpoints required for P2P collaboration.
   */
  handleHeartbeat(input: {
    nodeCode: string;
    nodeName: string;
    ipAddress?: string;
    port?: number;
    cloudLinkUrl?: string;
    metrics?: Partial<NodeMetrics>;
    p2pEnabled?: boolean;
    /**
     * Role flags from the node itself. The Master never infers these: an AI
     * brain and a Galaxy S26 scraper arrive as the same protocol message, and
     * only the node knows which it is.
     */
    capabilities?: NodeCapabilities;
  }): { task: SwarmAssignment | null; siblings: PeerEndpoint[]; p2pEnabled: boolean; meshKey: string } {
    const { record, meshKey } = this.registerSatellite(input);
    if (input.metrics) {
      // Trust the node's own counters, but keep the ORIGINAL registration
      // timestamp so the efficiency score always measures uptime from pairing.
      record.metrics = {
        ...record.metrics,
        ...input.metrics,
        registeredAt: record.metrics.registeredAt,
        lastSeenAt: new Date().toISOString(),
      };
    }
    /*
      CAPABILITIES ARE MERGED, NOT OVERWRITTEN.

      A heartbeat that omits the block (an older satellite build still paired to
      a new Master) must NOT clear what a previous heartbeat established —
      otherwise every poll from a pre-Epic-1 node would flip the whole fleet
      back to "AI unknown" ten seconds after it was correctly identified.

      The converse also matters: when the toggle is turned OFF on the node, the
      node sends `aiEnabled: false`, which is an explicit `false` and so DOES
      overwrite a previously-true value. `??` on a boolean only falls through on
      null/undefined, so `false` is preserved correctly.
    */
    if (input.capabilities) {
      record.metrics.capabilities = mergeCapabilities(
        record.metrics.capabilities ?? emptyCapabilities(),
        input.capabilities,
      );
    }
    const task = record.currentTask;
    // CRITICAL: siblings must NOT be returned once P2P is revoked. The satellite
    // re-applies whatever it is handed on every poll, so leaking the peer list
    // here would silently undo an adaptive-fallback revocation ~10s later.
    const allowP2p = record.p2pEnabled && Boolean(task?.p2p);
    return {
      task,
      siblings: task && allowP2p ? this.buildSiblingPayload(task, record.nodeCode) : [],
      p2pEnabled: allowP2p,
      meshKey,
    };
  }
// =========================================================================
  // MASTER — AUTO-PROVISIONING (shared tasks + sibling payload push)
  // =========================================================================

  /**
   * MASTER: creates a shared task and pushes the network payload to every
   * assignee so they auto-connect to each other.
   *
   * With no explicit `assignees`, the Master picks the least-busy satellites,
   * so a single call is enough to put idle capacity to work.
   */
  async assignSharedTask(input: {
    label: string;
    load: LoadClass;
    assignees?: string[];
  }): Promise<SwarmAssignment> {
    if (!this.isMaster) throw new Error("Only a Master node can assign shared tasks.");

    const explicit = (input.assignees ?? []).map(normalizeNodeCode).filter(isValidNodeCode);
    const assignees = explicit.filter((code) => this.registry.has(code));
    const task: SwarmAssignment = {
      id: `task-${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`,
      label: input.label,
      load: input.load,
      assignees: assignees.length > 0 ? assignees : this.selectIdleNodes(2),
      p2p: true,
      createdAt: new Date().toISOString(),
    };
    this.tasks.set(task.id, task);

    for (const code of task.assignees) {
      const record = this.registry.get(code);
      if (record) record.currentTask = task;
    }

    // Push the auto-provisioning payload to each assignee in parallel.
    await Promise.all(task.assignees.map((code) => this.provisionToNode(code, task)));

    console.log(
      `[Swarm] Task "${task.label}" (${task.load}) assigned to ${task.assignees.length} node(s); sibling payloads pushed.`,
    );
    return task;
  }

  /** Picks up to `count` idle satellites, preferring the highest efficiency. */
  private selectIdleNodes(count: number): string[] {
    return [...this.registry.values()]
      .filter((record) => !record.currentTask && record.p2pEnabled)
      .sort((a, b) => efficiencyScore(b.metrics) - efficiencyScore(a.metrics))
      .slice(0, count)
      .map((record) => record.nodeCode);
  }

  /**
   * Pushes one node its assignment plus the sibling endpoints it needs.
   *
   * The body carries everything required to form a direct mesh with the
   * co-workers: the task, the sibling IP/port/Cloud Link URLs, the Master
   * endpoint, and whether P2P is currently allowed.
   */
  private async provisionToNode(nodeCode: string, task: SwarmAssignment): Promise<void> {
    const record = this.registry.get(nodeCode);
    if (!record) return;
    // A node whose P2P was revoked receives NO siblings at all — the payload is
    // emptied so the Satellite physically cannot route around the Master.
    const siblings = record.p2pEnabled && task.p2p ? this.buildSiblingPayload(task, nodeCode) : [];
    const result = await meshPost(
      peerCandidateUrls(record.endpoint),
      "/api/mesh/assign",
      {
        kind: "mesh_assignment",
        task,
        siblings,
        master: this.selfEndpoint(),
        p2pEnabled: record.p2pEnabled && task.p2p,
      },
      this.meshKey,
    );
    record.p2pHealth.attempts += 1;
    if (!result.ok) {
      record.p2pHealth.failures += 1;
      if (result.timedOut) record.p2pHealth.timeouts += 1;
      console.warn(`[Swarm] Provisioning push to ${nodeCode} failed — ${result.reason}`);
    }
    // NOTE: a successful push must NOT clear `revoked`. The revocation is a
    // deliberate routing decision; only restoreP2p() lifts it. Reaching a node
    // proves nothing about whether its peers are usable.
  }
// =========================================================================
  // MASTER — ADAPTIVE FALLBACK
  // =========================================================================

  /**
   * MASTER: records one peer-exchange outcome reported by a Satellite and
   * re-evaluates whether P2P should stay enabled for it.
   *
   * @param nodeCode the reporting Satellite
   * @param outcome  "success" | "failure" | "timeout" for a sibling exchange
   */
  reportPeerOutcome(nodeCode: string, outcome: TaskOutcome): void {
    const record = this.registry.get(normalizeNodeCode(nodeCode));
    if (!record) return;
    record.p2pHealth.attempts += 1;
    if (outcome === "failure") record.p2pHealth.failures += 1;
    if (outcome === "timeout") {
      record.p2pHealth.failures += 1;
      record.p2pHealth.timeouts += 1;
    }
    this.evaluateP2pHealth(record);
  }

  /**
   * ADAPTIVE FALLBACK: revokes P2P once the failure ratio breaches the limit,
   * forcing the affected nodes to report exclusively back to the Master.
   *
   * Two guards prevent flapping:
   *  - at least P2P_MIN_SAMPLES exchanges must have happened, so a single
   *    unlucky timeout on a brand-new link cannot revoke P2P;
   *  - once revoked for a running task the Master stays in relay mode until
   *    that task finishes, so the fleet cannot oscillate mid-run.
   */
  private evaluateP2pHealth(record: SatelliteRecord): void {
    const { attempts, failures } = record.p2pHealth;
    if (attempts < P2P_MIN_SAMPLES || attempts > P2P_WINDOW_SIZE) return;
    const failureRatio = ratio(failures, attempts);
    if (failureRatio < P2P_FAILURE_RATIO_LIMIT) return;
    if (record.p2pHealth.revoked) return; // already revoked for this task

    record.p2pEnabled = false;
    record.p2pHealth.revoked = true;
    record.p2pHealth.revokedReason =
      `P2P failure ratio ${(failureRatio * 100).toFixed(0)}% over ${attempts} exchanges ` +
      `(limit ${(P2P_FAILURE_RATIO_LIMIT * 100).toFixed(0)}%) — revoked, node now reports to the Master only.`;

    const task = record.currentTask;
    if (task) {
      task.p2p = false;
      task.p2pRevokedAt = new Date().toISOString();
      task.p2pRevokeReason = record.p2pHealth.revokedReason;
      // Re-provision every assignee of this task into master-relay mode.
      // Siblings must have their OWN p2pEnabled cleared, not just the flag
      // marked revoked — otherwise the UI would show a node as still able to
      // reach its peers while it has in fact been emptied of them.
      for (const code of task.assignees) {
        const peer = this.registry.get(code);
        if (peer) {
          peer.p2pEnabled = false;
          peer.p2pHealth.revoked = true;
          peer.p2pHealth.revokedReason = record.p2pHealth.revokedReason;
        }
        void this.provisionToNode(code, task);
      }
    }

    console.warn(`[Swarm] P2P REVOKED for ${record.nodeCode} — ${record.p2pHealth.revokedReason}`);
  }

  /** MASTER: manually re-enables P2P for a node and clears the revocation. */
  restoreP2p(nodeCode: string): void {
    const record = this.registry.get(normalizeNodeCode(nodeCode));
    if (!record) return;
    record.p2pEnabled = true;
    record.p2pHealth.revoked = false;
    record.p2pHealth.revokedReason = undefined;
    record.p2pHealth.failures = 0;
    record.p2pHealth.timeouts = 0;
    const task = record.currentTask;
    if (task) {
      task.p2p = true;
      task.p2pRevokedAt = undefined;
      task.p2pRevokeReason = undefined;
      void this.provisionToNode(record.nodeCode, task);
    }
    console.log(`[Swarm] P2P restored for ${record.nodeCode}.`);
  }

  /**
   * MASTER: a Satellite finished a task — records the outcome, clears the
   * active slot, and re-arms P2P health for the node's next assignment.
   */
  completeTask(nodeCode: string, taskId: string, outcome: TaskOutcome): void {
    const record = this.registry.get(normalizeNodeCode(nodeCode));
    if (!record) return;
    const task = record.currentTask;
    if (!task || task.id !== taskId) return;

    record.metrics.loadAttempts[task.load] += 1;
    if (outcome === "success") {
      record.metrics.tasksSucceeded += 1;
      record.metrics.loadSuccess[task.load] += 1;
    } else if (outcome === "timeout") {
      record.metrics.tasksTimedOut += 1;
    } else {
      record.metrics.tasksFailed += 1;
    }

    record.completedTaskIds.push(task.id);
    record.currentTask = null;
    record.metrics.lastStatus = "idle";
    record.metrics.lastSeenAt = new Date().toISOString();

    // Rolling window: reset the counters once the window is exceeded so the
    // failure ratio always reflects recent behaviour, not all-time history.
    if (record.p2pHealth.attempts > P2P_WINDOW_SIZE) {
      record.p2pHealth.attempts = P2P_MIN_SAMPLES;
      record.p2pHealth.failures = 0;
      record.p2pHealth.timeouts = 0;
    }

    this.pruneTasks();
  }

  /**
   * Drops the oldest finished tasks once the retention cap is exceeded.
   * A task is kept while ANY assignee is still running it, so this can never
   * evict live work from the Master's Active Processes view.
   */
  private pruneTasks(): void {
    if (this.tasks.size <= MAX_RETAINED_TASKS) return;
    const live = new Set(
      [...this.registry.values()].map((r) => r.currentTask?.id).filter((id): id is string => Boolean(id)),
    );
    for (const [id, task] of this.tasks) {
      if (this.tasks.size <= MAX_RETAINED_TASKS) break;
      if (live.has(id)) continue;
      // No assignee is still on this task, so it is safe to forget.
      if (!task.assignees.some((code) => this.registry.get(code)?.currentTask?.id === id)) {
        this.tasks.delete(id);
      }
    }
  }
// =========================================================================
  // MASTER — MONITORING & UI SNAPSHOT
  // =========================================================================

  /**
   * Periodic Master housekeeping: re-evaluates P2P health for every node, so
   * the adaptive fallback still reacts when a node has stopped reporting.
   */
  private async runMonitorCycle(): Promise<void> {
    if (!this.isMaster || !this.running) return;
    for (const record of this.registry.values()) {
      this.evaluateP2pHealth(record);
    }

    /*
      PRUNE NODES THAT HAVE GONE AWAY FOR GOOD.

      Runs here rather than on a separate timer so it shares the monitor's
      cadence and stops whenever the dispatcher stops. `pruneForgottenNodes` only
      acts on nodes silent for six hours, so a sleeping machine is untouched —
      this exists to clear decommissioned and re-homed nodes that would otherwise
      sit in the Swarm Grid permanently generating "not a registered node"
      warnings with nothing left to authenticate against.
    */
    this.pruneForgottenNodes();
  }

  /** True when the node has been silent long enough to count as offline. */
  isOffline(record: SatelliteRecord): boolean {
    return Date.now() - (Date.parse(record.metrics.lastSeenAt) || 0) > SATELLITE_OFFLINE_AFTER_MS;
  }

  /**
   * Applies a key-sync directive received from Rippa AI on the heartbeat.
   *
   * MASTER-ONLY, and deliberately so. A satellite's credential belongs to the
   * Master that issued it; taking a new one from the cloud would let the cloud
   * silently promote itself to the authority for a peer-to-peer mesh it is not
   * part of. Only the Master rotates, and it then propagates the change to its
   * own satellites over the authenticated channel.
   *
   * ORDER MATTERS HERE:
   *   1. revocations first, so a key the cloud withdrew is never briefly active;
   *   2. rotate + persist, so config.json and memory agree before anything is sent;
   *   3. purge stale nodes, so removed machines leave the fleet view;
   *   4. broadcast last, and only when something actually changed — waking the
   *      fleet to re-provision an identical key would be pure noise.
   */
  async applyMothershipSync(directive: MeshKeySyncDirective): Promise<MeshKeySyncResult> {
    const result: MeshKeySyncResult = {
      rotated: false,
      revokedKeysApplied: false,
      purgedNodes: [],
      notified: 0,
      failed: 0,
    };

    if (!this.isMaster) {
      // Not an error — just inapplicable. Returned quietly so a satellite's
      // heartbeat log never shows a failure it cannot act on.
      return result;
    }

    if (directive.revokedKeys.length > 0) {
      const known = new Set(getRevokedMeshKeys());
      revokeMeshKeys(directive.revokedKeys);
      result.revokedKeysApplied = true;
      const fresh = directive.revokedKeys.filter((key) => !known.has(key));
      if (fresh.length > 0) {
        console.warn(
          `[Swarm] Rippa AI revoked ${fresh.length} mesh key(s); nodes holding them must re-pair.`,
        );
      }
    }

    if (directive.meshKey) {
      const previous = this.meshKey;
      // `rotateMeshKey` persists the predecessor, which is what lets a satellite
      // still on the old key be recognised as `stale` rather than as a stranger.
      if (rotateMeshKey(directive.meshKey, directive.issuedBy || this.nodeCode)) {
        this.meshKey = directive.meshKey.trim();
        result.rotated = true;
        console.log(
          `[Swarm] Mesh key synchronised from Rippa AI (${this.nodeCode}); ` +
            `the previous key stays valid for the grace window so the fleet can rejoin.`,
        );

        // The push is sent with the NEW key, which only nodes that adopt it can
        // authenticate — so this is what makes the rotation converge even when a
        // satellite missed the grace window entirely.
        const push = await this.broadcastMeshKey(this.meshKey, previous);
        result.notified = push.notified;
        result.failed = push.failed;

        // Surfaced to the dashboard so the operator sees the fleet re-keying
        // rather than discovering it later as "why did everything re-pair?".
        publishNodeEvent({
          kind: "info",
          command: "MESH_KEY_SYNCED",
          title: "Swarm Key Synchronised",
          detail:
            `Rippa AI issued a new mesh key. ${push.notified} satellite(s) updated` +
            (push.failed > 0 ? `, ${push.failed} will pick it up on their next poll.` : "."),
        });
      }
    }

    if (directive.revokedNodes.length > 0) {
      result.purgedNodes = this.purgeNodes(directive.revokedNodes, "revoked by Rippa AI");
    }

    return result;
  }

  /**
   * Pushes the active mesh key to every reachable satellite.
   *
   * Uses the same `meshPost` helper as task provisioning, so LAN-then-Cloud-Link
   * fallback and P2P-health scoring come for free, and a node that is genuinely
   * unreachable is counted rather than thrown at the caller.
   */
  private async broadcastMeshKey(
    meshKey: string,
    previousKey: string,
  ): Promise<{ notified: number; failed: number }> {
    const targets = this.listOnlineSatellites();
    if (targets.length === 0) return { notified: 0, failed: 0 };

    const outcomes = await Promise.allSettled(
      targets.map((target) =>
        meshPost(
          peerCandidateUrls(target.endpoint),
          "/api/mesh/key-sync",
          {
            nodeCode: target.nodeCode,
            meshKey,
            // Sent so a satellite can tell a rotation from a re-provision and
            // log the transition instead of silently changing credential.
            previousKey: previousKey || null,
            issuedBy: this.nodeCode,
          },
          meshKey,
        ),
      ),
    );

    let notified = 0;
    let failed = 0;
    for (const outcome of outcomes) {
      if (outcome.status === "fulfilled" && outcome.value.ok) notified += 1;
      else failed += 1;
    }
    if (failed > 0) {
      // Expected for anything mid-sleep; the next poll re-syncs it.
      console.log(
        `[Swarm] ${failed}/${targets.length} satellite(s) did not take the new key directly; ` +
          `they will be issued it on their next heartbeat.`,
      );
    }
    return { notified, failed };
  }

  /**
   * Removes node codes from the registry and the persisted peer list.
   *
   * Called for nodes Rippa AI reports as unregistered, and by
   * {@link pruneForgottenNodes} for nodes that have been silent for hours. Both
   * are cases where the entry is noise: it can no longer authenticate, it can no
   * longer be reached, and leaving it in place is what produces a fleet view
   * permanently reporting nodes that do not exist.
   */
  purgeNodes(nodeCodes: Iterable<string>, reason: string): string[] {
    const removed: string[] = [];
    for (const raw of nodeCodes) {
      const code = normalizeNodeCode(raw);
      if (!code || code === this.nodeCode) continue;
      if (this.registry.delete(code)) {
        removed.push(code);
        this.dropTasksFor(code);
      }
    }
    if (removed.length === 0) return [];

    // Peers are the satellite's own view of its siblings; clearing the revoked
    // ones here stops the removed machines continuing to appear in provisioning
    // payloads on every other node.
    purgePeerMesh(removed);
    this.persistRegistry();
    console.log(`[Swarm] Purged ${removed.length} node(s) (${reason}): ${removed.join(", ")}`);
    return removed;
  }

  /** Releases any task held by a purged node so it is not stuck "running". */
  private dropTasksFor(nodeCode: string): void {
    for (const [taskId, task] of this.tasks) {
      if (!task.assignees.includes(nodeCode)) continue;
      task.assignees = task.assignees.filter((code) => code !== nodeCode);
      if (task.assignees.length === 0) this.tasks.delete(taskId);
    }
  }

  /**
   * MASTER: forgets nodes that have been silent for a long time.
   *
   * DISTINCT FROM `runMonitorCycle`, which only marks nodes offline. This one
   * actually deletes them, and only after six hours of silence, so a sleeping
   * tablet keeps its place in the Swarm Grid while a decommissioned machine
   * stops generating warnings forever.
   *
   * @returns the codes that were purged, so the caller can report them.
   */
  pruneForgottenNodes(): string[] {
    if (!this.isMaster) return [];
    const cutoff = Date.now() - SATELLITE_FORGET_AFTER_MS;
    const abandoned = [...this.registry.values()]
      .filter((record) => (Date.parse(record.metrics.lastSeenAt) || 0) < cutoff)
      .map((record) => record.nodeCode);
    return this.purgeNodes(abandoned, "no contact for 6 hours");
  }

  /**
   * MASTER CONTROL CENTER SNAPSHOT — everything the topology grid, the active
   * process list and the satellite detail modal render from.
   */
  getSnapshot(): Record<string, unknown> {
    const satellites = [...this.registry.values()].map((record) => {
      // Per-bucket success rates; a bucket with no attempts reports 100 so an
      // unused "heavy" slot never drags the average down.
      const loadRates: Record<LoadClass, number> = { heavy: 100, normal: 100, lite: 100 };
      (Object.keys(loadRates) as LoadClass[]).forEach((key) => {
        const attempts = record.metrics.loadAttempts[key];
        loadRates[key] =
          attempts > 0 ? Math.round((record.metrics.loadSuccess[key] / attempts) * 100) : 100;
      });
      const attempts = record.p2pHealth.attempts;
      return {
        nodeCode: record.nodeCode,
        nodeName: record.nodeName,
        endpoint: record.endpoint,
        online: !this.isOffline(record),
        p2pEnabled: record.p2pEnabled,
        p2pRevoked: record.p2pHealth.revoked,
        p2pRevokeReason: record.p2pHealth.revokedReason ?? null,
        p2pFailureRate: attempts > 0 ? Math.round((record.p2pHealth.failures / attempts) * 100) : 0,
        currentTask: record.currentTask,
        completedTasks: record.completedTaskIds.length,
        efficiency: efficiencyScore(record.metrics),
        problemSolvingRate: problemSolvingRate(record.metrics),
        loadHandling: loadHandlingScore(record.metrics),
        loadRates,
        metrics: record.metrics,
        // Flattened system vitals so the Control Center can paint per-node
        // CPU / RAM / uptime bars straight off the snapshot, without having to
        // reach into `metrics` (or make one request per node) to do it.
        cpuUsage: record.metrics.cpuUsage ?? null,
        ramUsage: record.metrics.ramUsage ?? null,
        cpuCores: record.metrics.cpuCores ?? null,
        // Host uptime is what the operator recognises ("up 3 days"); the
        // accumulated `uptimeSeconds` is swarm bookkeeping and is shown as
        // efficiency in its own right, so both are kept distinct here.
        uptimeSeconds: record.metrics.systemUptimeSeconds ?? null,
        swarmUptimeSeconds: record.metrics.uptimeSeconds ?? 0,
        /*
          ROLE FLAGS, FLATTENED FOR THE UI (see ./nodeCapabilities.ts).

          `aiEnabled` is tri-state and is passed through UNCHANGED. It is
          deliberately not collapsed with `Boolean(...)`, which would turn
          "this node has not told us yet" into "this node has no AI" — the exact
          misreading Epic 2 asks us to avoid. Consumers test `=== true` before
          offering any inference action.

          The runtime/scraping fields are the replacement for the empty model
          slot: a scraper node fills those with what it actually does
          ("Runtime: Android WebView", "Scraping: Lightweight Fetch") instead of
          leaving a blank where a model name would go.
        */
        aiEnabled: normaliseAiEnabled(record.metrics.capabilities?.aiEnabled),
        aiModels: record.metrics.capabilities?.aiModels ?? [],
        runtime: record.metrics.capabilities?.runtime ?? "",
        scrapingMode: record.metrics.capabilities?.scrapingMode ?? "",
      };
    });

    const tasks = [...this.tasks.values()].map((task) => ({
      ...task,
      // The UI links collaborating nodes with these names, so resolve the
      // codes to display names here rather than in the browser.
      assignees: task.assignees.map((code) => {
        const record = this.registry.get(code);
        return {
          nodeCode: code,
          nodeName: record?.nodeName ?? code,
          p2pEnabled: record?.p2pEnabled ?? false,
        };
      }),
    }));

    const online = satellites.filter((s) => s.online).length;
    const avgEfficiency =
      satellites.length > 0
        ? Math.round(
            satellites.reduce((sum, s) => sum + s.efficiency, 0) / satellites.length,
          )
        : 100;

    return {
      nodeCode: this.nodeCode,
      nodeName: env.NODE_NAME,
      role: env.NODE_ROLE,
      // The Master never exposes its own mesh key over the dashboard.
      meshKey: this.isMaster ? "" : this.getMeshKeyOrEmpty(),
      pairable: this.isMaster,
      paired: !this.isMaster && Boolean(getPairing()),
      masterUrl: getPairing()?.masterUrl ?? "",
      peers: listPeers(),
      satellites,
      tasks,
      summary: {
        total: satellites.length,
        online,
        busy: satellites.filter((s) => s.currentTask).length,
        p2pRevoked: satellites.filter((s) => s.p2pRevoked).length,
        avgEfficiency,
        /*
          AI vs scraper split, for the "AI Mesh Health" panel header.

          Counted from an EXPLICIT `true`/`false`, and the unknown bucket is
          surfaced rather than hidden: a node that has never reported its role is
          not the same as a node that reported "not an AI brain", and folding the
          two together would make the panel quietly under-report the fleet.
        */
        aiNodes: satellites.filter((s) => s.aiEnabled === true).length,
        scraperNodes: satellites.filter((s) => s.aiEnabled === false).length,
        unknownRoleNodes: satellites.filter((s) => s.aiEnabled === null).length,
      },
    };
  }

  /**
   * Every satellite this node is MESHED WITH, online or not.
   *
   * Feeds the `connected_satellites` field on the Mothership heartbeat.
   * Deliberately NOT `listOnlineSatellites()`: that filters to currently-reachable
   * nodes, so one missed poll would drop a paired satellite from the cloud's view
   * of the fleet. Peering is a fact about the mesh, not about the last 45 seconds
   * — an offline node is still paired, and the Control Center already renders its
   * `online` flag separately.
   */
  listConnectedSatelliteCodes(): string[] {
    return [...this.registry.values()].map((record) => record.nodeCode);
  }

  /** A single satellite's detail record, or null when the code is unknown. */
  getSatellite(nodeCode: string): Record<string, unknown> | null {
    const satellites = this.getSnapshot()["satellites"] as Array<Record<string, unknown>>;
    return satellites.find((entry) => entry["nodeCode"] === normalizeNodeCode(nodeCode)) ?? null;
  }

  /**
   * Every satellite that is currently reachable, for fleet-wide operations such
   * as an OTA broadcast.
   *
   * Offline nodes are deliberately excluded: pushing an update to a machine that
   * cannot answer would burn the timeout and delay the nodes that CAN be
   * updated. An offline node picks the new release up on its next boot.
   */
  listOnlineSatellites(): Array<{ nodeCode: string; nodeName: string; endpoint: PeerEndpoint }> {
    return [...this.registry.values()]
      .filter((record) => !this.isOffline(record))
      .map((record) => ({
        nodeCode: record.nodeCode,
        nodeName: record.nodeName,
        endpoint: record.endpoint,
      }));
  }
// =========================================================================
  // SATELLITE — PAIRING, POLLING & REPORTING
  // =========================================================================

  /**
   * SATELLITE: performs the ONE-TIME handshake with the Master.
   *
   * Sends this node's permanent code and address, receives the mesh key plus
   * the Master's endpoint, and persists the pairing locally. After this call
   * the operator never touches networking settings again.
   */
  async pairWithMaster(masterUrl: string): Promise<PairingResult> {
    if (this.isMaster) throw new Error("This node is already a Master.");
    const base = masterUrl.replace(/\/+$/, "");
    const self = selfEndpoint(localIPv4());

    const response = await axios.post(
      `${base}/api/mesh/pair`,
      {
        nodeCode: this.nodeCode,
        nodeName: env.NODE_NAME,
        ipAddress: self.ipAddress,
        port: self.port,
        cloudLinkUrl: self.cloudLinkUrl,
      },
      { timeout: MESH_HTTP_TIMEOUT_MS },
    );

    const data = (response.data ?? {}) as Record<string, unknown>;
    const meshKey = String(data["meshKey"] ?? "");
    const masterEndpoint = (data["master"] ?? {}) as PeerEndpoint;
    // The Master returns its code under `masterCode` (and `nodeCode` for
    // convention); fall back to the advertised endpoint if neither is present.
    const masterCode =
      normalizeNodeCode(data["masterCode"]) ||
      normalizeNodeCode(data["nodeCode"]) ||
      normalizeNodeCode(masterEndpoint.nodeCode);

    savePairing({
      masterCode: normalizeNodeCode(masterCode) || normalizeNodeCode(masterEndpoint.nodeCode),
      masterUrl: base,
      cloudLinkUrl: masterEndpoint.cloudLinkUrl ?? "",
      pairedAt: new Date().toISOString(),
      p2pEnabled: true,
    });
    if (meshKey) saveMeshKey(meshKey, masterCode);
    setP2pEnabled(true);

    console.log(`[Swarm] Paired with Master at ${base} — zero-config networking is now managed remotely.`);
    return { meshKey, masterEndpoint, masterCode };
  }

  /**
   * SATELLITE: what this node reports about itself on each heartbeat.
   *
   * AI IS CLAIMED ONLY WHEN THE RUNTIME IS ACTUALLY COMPLETE. This checks
   * `bundledRuntimeComplete` rather than merely "Ollama is installed", because a
   * half-install boots, binds the port, answers `/api/tags`, and then fails every
   * single inference with "llama-server binary not found". A node that claimed
   * "AI Brain" in that state would be sent real inference work and would fail
   * every request — strictly worse than the phone that honestly reports it is a
   * scraper.
   *
   * The Ollama manager is reached through a lazily-required reference so that
   * this file stays importable from the WebView bundle, which must not pull in
   * `node:child_process` (see scripts/build-mobile-worker.mjs).
   */
  private localCapabilities(): NodeCapabilities {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const manager = require("./ollamaManager") as {
        ollamaManager?: { getStatus(task: null): { bundledRuntimeComplete: boolean; model: string } };
      };
      const status = manager.ollamaManager?.getStatus(null);
      if (status?.bundledRuntimeComplete) {
        return describeAiCapabilities([status.model]);
      }
    } catch {
      // No Ollama manager in this runtime (the WebView case). Fall through to
      // the scraper payload — which is the truth for a tablet.
    }
    return describeCapabilities();
  }

  /** Satellite cycle: poll the Master for work and report local activity. */
  private async runSatelliteCycle(): Promise<void> {
    if (this.isMaster || !this.running) return;
    const pairing = getPairing();
    // Resolved BEFORE the try so the catch can name the target: without it a
    // timeout against the Mothership and one against a dead local peer look
    // identical in the log.
    const targetUrl = pairing ? `${pairing.masterUrl.replace(/\/+$/, "")}/api/mesh/heartbeat` : "unknown";
    try {
      // Never paired yet — the operator must pair once before this node joins.
      if (!pairing) return;
      await this.pollMaster(pairing);
    } catch {
      // Fixed timeout text (not the raw axios message) so operators can grep
      // for one stable line; the target above is what distinguishes Mothership
      // from local-peer timeouts.
      console.warn(`[Swarm] Mesh poll to ${targetUrl} failed — timeout of 15000ms exceeded`);
    }
  }

  /**
 * SATELLITE: adopts a mesh key pushed by the Master.
 *
 * Called from `POST /api/mesh/key-sync`. The zero-config promise is that the
 * operator never re-enters a key after a rotation, so this has to persist the
 * new credential and stay online without a restart — which is exactly why it
 * calls `rotateMeshKey` (keeping the old one for the grace window) rather than
 * overwriting the field and orphaning the in-flight request.
 *
 * A no-op when the key is unchanged, so a repeated broadcast costs nothing.
 *
 * @returns true when the local credential actually changed.
 */
applyKeySync(payload: { meshKey?: string; issuedBy?: string }): boolean {
  const next = String(payload?.meshKey ?? "").trim();
  if (!next || !rotateMeshKey(next, payload?.issuedBy || this.nodeCode)) return false;

  console.log(
    `[Swarm] Mesh key updated by ${payload?.issuedBy || "the Master"} — the fleet is back in lockstep.`,
  );
  // Peer endpoints learned under the old key may include nodes the Master has
  // since dropped, so they are re-derived from the next heartbeat rather than
  // trusted to still be current.
  publishNodeEvent({
    kind: "info",
    command: "MESH_KEY_UPDATED",
    title: "Swarm Key Updated",
    detail: `This node adopted the new mesh key from ${payload?.issuedBy || "the Master"}.`,
  });
  return true;
}

/**
 * SATELLITE: applies a `syncReset` sent by the Master when our key was refused.
 *
 * THE RECOVERY LOOP. Previously a rejected heartbeat was a bare 401, so the
 * satellite could do nothing but retry the same dead credential every 10 seconds
 * and the dashboard showed a permanently red node with no way out but an
 * operator's manual intervention. There are now two automatic exits:
 *
 *   - the Master included the current key (it recognised us as holding the
 *     recently-rotated one) — adopt it and carry straight on;
 *   - it did not, and asked us to re-authenticate — run the pairing handshake,
 *     which is the one route that is allowed to issue a credential to a node
 *     that no longer holds a valid one.
 *
 * @returns true when the node ended up with a usable key.
 */
async recoverFromSyncReset(
  reset: SyncResetPayload | null | undefined,
  pairing = getPairing(),
): Promise<boolean> {
  if (!reset) return false;
  const masterCode = reset.masterCode || pairing?.masterCode || "";

  if (reset.meshKey && rotateMeshKey(reset.meshKey, masterCode || "mothership")) {
    console.log(`[Swarm] Master re-issued the mesh key — re-authenticated (${reset.reason}).`);
    return true;
  }

  // No key was handed over, so the credential has to be re-acquired from the
  // Master through the pairing handshake. Guarded with the same in-flight latch
  // `ensurePaired` uses, so a Master that keeps sending resets cannot turn into
  // a re-pair attempt on every poll.
  if (!pairing || this.pairingInFlight) return false;
  this.pairingInFlight = true;
  try {
    console.warn(`[Swarm] Re-authenticating with the Master (${reset.reason}): ${reset.message}`);
    await this.pairWithMaster(pairing.masterUrl);
    return true;
  } catch (error) {
    console.warn(
      `[Swarm] Re-authentication failed — ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return false;
  } finally {
    this.pairingInFlight = false;
  }
}

/**
   * SATELLITE: asks the Master for work and posts a heartbeat in one request.
   *
   * The Master's reply carries the assignment plus any sibling endpoints, so
   * the Control Center stays live without a second channel. Uptime is
   * accumulated from the gap between polls rather than a wall clock, so a
   * sleeping node does not claim uptime it never had.
   */
  async pollMaster(pairing = getPairing()): Promise<void> {
    if (!pairing) return;
    const self = selfEndpoint(localIPv4());
    const now = Date.now();
    this.localMetrics.uptimeSeconds += Math.max(
      0,
      Math.round((now - (this.lastHeartbeatAt || now)) / 1000),
    );
    this.lastHeartbeatAt = now;
    this.localMetrics.lastSeenAt = new Date(now).toISOString();

    /*
      SYSTEM VITALS.

      Sampled here rather than only for the Mothership heartbeat so the Master
      Control Center's per-node CPU / RAM / uptime bars show the satellite's
      REAL load. Without it the dashboard could only display swarm bookkeeping
      counters, which say how well a node is doing its job but nothing about
      whether the machine underneath it is healthy or thrashing.

      `getSystemVitals()` is already wrapped to degrade to safe numbers, so a
      telemetry failure can never break the pairing cycle below.
    */
    const vitals = getSystemVitals();
    this.localMetrics.cpuUsage = vitals.cpu_usage;
    this.localMetrics.ramUsage = vitals.ram_usage;
    this.localMetrics.cpuCores = vitals.cpu_cores;
    this.localMetrics.systemUptimeSeconds = vitals.system_uptime_seconds;

    let response;
    try {
      /*
        THE MESH KEY IS PRESENTED UNDER BOTH HEADER NAMES.

        `X-Mesh-Key` is the dedicated mesh channel; `Authorization: Bearer` is
        what every other Rippa surface already speaks. A Master authenticating
        the standard way refused this poll with a 401 even though the node held
        a valid key, which is the reported mesh-poll failure. Sending both is
        backward compatible with any Master that only reads the dedicated one.
      */
      const meshKey = getMeshKey();
      response = await axios.post(
        `${pairing.masterUrl.replace(/\/+$/, "")}/api/mesh/heartbeat`,
        {
          nodeCode: this.nodeCode,
          nodeName: env.NODE_NAME,
          ipAddress: self.ipAddress,
          port: self.port,
          cloudLinkUrl: self.cloudLinkUrl,
          metrics: this.localMetrics,
          p2pEnabled: p2pEnabled(),
          capabilities: this.localCapabilities(),
        },
        {
          timeout: MESH_HTTP_TIMEOUT_MS,
          headers: {
            "X-Mesh-Key": meshKey,
            ...(meshKey ? { Authorization: `Bearer ${meshKey}` } : {}),
          },
        },
      );
    } catch (error) {
      /*
        A REFUSED HEARTBEAT IS NOW A RECOVERY SIGNAL, NOT A DEAD END.

        The Master answers a stale or unknown key with a `syncReset` payload
        instead of a bare 401, which is the only thing that lets a satellite
        whose credential went stale recover by itself. Axios throws on the 4xx,
        so the body is read off the error here rather than the response.

        Recovering succeeds without restarting the poll cycle, so the node is
        working again on its very next tick. A Master that merely happens to be
        offline throws a network error with no response body, and is ignored —
        that case is genuinely transient and the next cycle handles it.
      */
      const body = axios.isAxiosError(error)
        ? ((error.response?.data ?? {}) as Record<string, unknown>)
        : {};
      const reset = (body["syncReset"] ?? null) as SyncResetPayload | null;
      if (reset) {
        await this.recoverFromSyncReset(reset, pairing);
        return;
      }

      /*
        A BARE 401 STILL TRIGGERS A KEY-SYNC.

        A Master that predates the `syncReset` contract answers with nothing but
        a status code, and the old code rethrew here — so such a node retried a
        dead credential every ten seconds indefinitely and never once attempted
        the recovery its situation called for.

        Synthesising a reset from the status code is the correct move: it is
        exactly the information a bare 401 conveys ("that key is not valid, go
        and fix it"), and `recoverFromSyncReset` is already latched and safe —
        it either adopts a re-issued key or re-runs the pairing handshake. Any
        OTHER 4xx (or a transport error from an offline Master) is genuinely
        transient and still propagates for the caller to log.
      */
      const status = axios.isAxiosError(error) ? error.response?.status : undefined;
      if (status === 401) {
        console.warn(
          "[Swarm] Master refused the mesh key (no syncReset guidance) — " +
            "re-authenticating automatically.",
        );
        await this.recoverFromSyncReset(
          {
            reason: "unknown-key",
            reauthRequired: true,
            masterCode: pairing?.masterCode ?? "",
            message: "Master refused the mesh key without recovery guidance.",
          },
          pairing,
        );
        return;
      }

      throw error;
    }

    const data = (response.data ?? {}) as Record<string, unknown>;
    const task = (data["task"] ?? null) as SwarmAssignment | null;
    const siblings = (data["siblings"] ?? []) as PeerEndpoint[];
    const allowP2p = data["p2pEnabled"] === true;

    // AUTO-FILL: persist the sibling endpoints the Master just handed over.
    // An empty list is meaningful — the Master sends one when P2P has been
    // revoked, which actively clears previously-learned peers rather than
    // leaving a node able to route around its Master.
    if (siblings.length > 0 || !allowP2p) {
      this.applyIncomingSiblings(siblings);
    }

    // The Master may revoke P2P at any time — honour it immediately.
    if (p2pEnabled() !== allowP2p) setP2pEnabled(allowP2p);

    if (task && task.id !== this.activeAssignment?.id) {
      this.activeAssignment = task;
      this.reportingMode = task.p2p && allowP2p ? "p2p" : "master-relay";
      this.localMetrics.lastStatus = "busy";
      console.log(`[Swarm] Assignment received: "${task.label}" (${task.load}) via ${this.reportingMode}.`);
    } else if (!task && this.activeAssignment) {
      this.activeAssignment = null;
      this.reportingMode = "p2p";
      this.localMetrics.lastStatus = "idle";
    }
  }

  /**
   * SATELLITE: records an assignment pushed by the Master.
   *
   * Local-only bookkeeping — the task the node is executing and how it is
   * reporting. Kept separate from the Master's registry so a Satellite holds
   * exactly one active task and never mistakes peer data for its own.
   */
  applyIncomingAssignment(task: SwarmAssignment): SwarmAssignment {
    this.activeAssignment = task;
    this.localMetrics.lastStatus = "busy";
    console.log(
      `[Swarm] Assignment "${task.label}" (${task.load}) accepted; reporting via ${this.reportingMode}.`,
    );
    return task;
  }

  /**
   * SATELLITE: AUTO-FILLS the sibling endpoints the Master pushed.
   *
   * No operator input is involved — this is the zero-config guarantee. Passing
   * an empty list (which the Master does after revoking P2P) actively clears
   * previously learned peers so the node can no longer route around the Master.
   *
   * NOTE: the reporting mode follows the P2P FLAG, not the sibling count. A
   * task with a single assignee legitimately has no siblings while P2P is
   * perfectly healthy, so an empty list alone must not demote the node.
   */
  applyIncomingSiblings(siblings: PeerEndpoint[]): PeerEndpoint[] {
    const stored = applyPeerProvision(siblings);
    this.reportingMode = p2pEnabled() && stored.length > 0 ? "p2p" : "master-relay";
    return stored;
  }

  /**
   * SATELLITE: records the result of local work.
   *
   * Feeds the same counters the Master keeps, so the Control Center reflects
   * real outcomes rather than optimistic placeholders.
   *
   * @param challengeResolved true when the node cleared a captcha / retry loop
   *        on its own instead of failing the task.
   */
  reportLocalTaskResult(task: SwarmAssignment, outcome: TaskOutcome, challengeResolved = false): void {
    this.localMetrics.loadAttempts[task.load] += 1;
    if (outcome === "success") {
      this.localMetrics.tasksSucceeded += 1;
      this.localMetrics.loadSuccess[task.load] += 1;
    } else if (outcome === "timeout") {
      this.localMetrics.tasksTimedOut += 1;
    } else {
      this.localMetrics.tasksFailed += 1;
    }
    if (challengeResolved) {
      this.localMetrics.challenges += 1;
      this.localMetrics.challengesResolved += 1;
    }
    this.localMetrics.lastStatus = this.activeAssignment ? "busy" : "idle";
    this.localMetrics.lastSeenAt = new Date().toISOString();
  }
}