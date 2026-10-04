import axios, { type AxiosInstance } from "axios";
import { schedule, type ScheduledTask } from "node-cron";
import { env } from "../config";
import { currentNodeIdentity, ensureNodeIdentity } from "../config/nodeAuth";
import {
  buildHeartbeatTelemetry,
  executePendingCommands,
  parsePendingCommands,
  type CommandHandlers,
  type EfficiencyInput,
  type OllamaTelemetry,
} from "../services/heartbeat";
import { parseMeshKeySync, type MeshKeySyncDirective } from "../services/meshKeySync";
import { parsePowerConfig, type PowerConfigHandler } from "../services/powerConfigSync";
import { APP_VERSION } from "../version";

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
  /**
   * This node's permanent identity, e.g. "RIPPA-QJ9T-25WL".
   *
   * WHY IT IS IN THE HEARTBEAT, and why it is the identity and not `nodeName`:
   * the Mothership keys its fleet table on the node code, and every other message
   * this node sends identifies itself that way — the claim, the result, the
   * forage push. The heartbeat was the one POST in that set carrying no code at
   * all, so the fleet's view of this node could not be matched to the row the rest
   * of its traffic updates, and the cloud had nothing durable to correlate on.
   *
   * `nodeName` is operator-editable and NOT unique, so it can only ever be a
   * display label. Two nodes both called "Desktop" is normal and must not merge
   * into one fleet entry; the node code is what makes the row stable across
   * renames, IP changes and OTA updates.
   */
  nodeCode: string;
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
  /**
   * The build this node is RUNNING, e.g. "1.0.19".
   *
   * Sent so the Mothership can refuse to queue a `FORCE_UPDATE` the node would
   * only answer "Refusing to downgrade" to. Without it the cloud's only evidence
   * of a node's version is a capability report that fires rarely (or never), so
   * it cannot tell "already current" from "needs updating" and re-dispatches the
   * command on every heartbeat.
   */
  version: string;
  /**
   * Granular version tracking for the Mothership's Swarm Grid, which renders a
   * per-node version column. Sourced by the same `buildHeartbeatTelemetry()`
   * spread that fills the CPU/RAM/uptime fields, and typed off it rather than
   * restated, so the interface cannot drift from what is actually sent.
   */
  current_version: ReturnType<typeof buildHeartbeatTelemetry>["current_version"];
  /** ISO-8601 install instant for the running build, or null when unknowable. */
  last_updated_at: ReturnType<typeof buildHeartbeatTelemetry>["last_updated_at"];
  /** Embedded Ollama AI status — server state, model, port, active task. */
  ollama: OllamaTelemetry;
  /**
   * THE POWER-CONFIG STAMP THIS NODE LAST APPLIED, or null when it never has.
   *
   * THE DEVICE-SHADOW ECHO. The Mothership holds the DESIRED stamp it last
   * wrote; this is the node echoing back the one it actually applied, verbatim
   * and unparsed. While the two differ the heartbeat reply re-sends the desired
   * config; the moment they agree the cloud goes quiet. Equality, never
   * ordering — so a node whose clock is wrong cannot wedge the sync.
   */
  power_config_applied_at: string | null;
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
 * Fired when the Mothership's heartbeat reply carries a mesh-key rotation
 * instruction. Owned by the swarm dispatcher, which owns the registry and the
 * credential. Master-only in practice — a satellite has nothing to rotate.
 *
 * The handler is invoked fire-and-forget: a rotation can involve network calls
 * to the whole fleet, and a rejection here must never turn a successful
 * heartbeat into a reported failure.
 */

/**
 * Fired when the Mothership sends a power configuration update (mode, schedule,
 * limits). Wired by index.ts to the Orchestrator and configManager.
 *
 * Re-exported from ./powerConfigSync, where the parser lives, so callers that
 * reach for `SwarmClient`'s type keep working unchanged.
 */
export type { PowerConfigHandler };

export type MeshKeySyncHandler = (directive: MeshKeySyncDirective) => void;

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
 * COMMAND ACKNOWLEDGEMENT ROUTES, most specific first.
 *
 * WHY A DEDICATED ROUTE EXISTS AT ALL. Until now an executed command was only
 * remembered in this process's `executedCommandIds` set, so a Mothership that
 * re-sent its queue made the node log "Skipping already-executed command" on
 * every single heartbeat, forever — the command was never retired upstream.
 * The only feedback path was a generic profile submission that carried no
 * `command_id`, so the cloud had no key to match the queue entry against even
 * when it was sent. Retiring the entry needs the id, and the id has to go to a
 * route that acts on it.
 *
 * THE FALLBACKS ARE LOAD-BEARING. A node must not be bricked by a Mothership
 * that has not shipped the dedicated route yet, so each 404/405/501 falls
 * through to the next. The last resort is {@link FORAGE_FALLBACK_PATH}, which
 * every deployment already accepts — the command is at least recorded, and the
 * downgrade is remembered so the missing routes are not re-probed forever.
 */
export const COMMAND_ACK_PATH = "/api/node/ack";
export const COMMAND_ACK_FALLBACK_PATH = "/api/swarm/commands/ack";

/**
 * CAPABILITY REGISTRATION ROUTES, most specific first.
 *
 * WHY A CHAIN. `/api/swarm/capabilities` is the swarm-scoped spelling and is
 * what this node has always posted to, but a Mothership that has not shipped
 * that route answers 404 — and a 404 here meant this node silently stayed a
 * plain "standard node" forever, with the cloud routing heavy AI work elsewhere
 * and this node's GPU sitting idle. The node was not broken; it was just
 * talking to a door that does not exist in this deployment.
 *
 * `/api/node/capabilities` is the node-scoped equivalent the same API uses for
 * `/api/node/ack` and `/api/node/latest-version`, so it is tried second. The
 * chain mirrors {@link COMMAND_ACK_ROUTES} deliberately: a node must not be
 * wedged by a cloud that has not shipped the preferred route yet, and the
 * working route must be remembered so the missing one is not re-probed on
 * every capability change.
 */
export const CAPABILITY_PATH = "/api/swarm/capabilities";
export const CAPABILITY_FALLBACK_PATH = "/api/node/capabilities";

/**
 * The routes tried, in order, by {@link SwarmClient.registerAiCapability}.
 *
 * Ordered as a const so the fallback chain is stated in exactly one place,
 * mirroring {@link COMMAND_ACK_ROUTES}.
 */
const CAPABILITY_ROUTES: readonly string[] = [CAPABILITY_PATH, CAPABILITY_FALLBACK_PATH];

/**
 * The routes tried, in order, by {@link SwarmClient.acknowledgeRemoteCommand}.
 *
 * The dedicated `/api/node/ack` is the intended endpoint. The `/api/swarm/*`
 * route is tried second because the swarm API surface is the one guaranteed to
 * be deployed alongside this node. Ordered as a const so the fallback chain is
 * stated in exactly one place.
 */
const COMMAND_ACK_ROUTES: readonly string[] = [COMMAND_ACK_PATH, COMMAND_ACK_FALLBACK_PATH];

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

/**
 * The brain-delta routes, tried in order.
 *
 * WHY A CHAIN. This node originally called `/api/brain/delta`, which no
 * deployment of the Mothership has ever served — the live route is
 * `/api/swarm/brain-delta`, inside the authenticated swarm namespace. The result
 * was a 404 the old code treated as "endpoint not shipped yet, stay quiet", so a
 * node with a good key and a good cursor silently never synced, and the only
 * symptom was a fact count drifting further behind the cloud's every day. A
 * second spelling costs one request, once; being wrong about a path costs the
 * feature entirely.
 *
 * The swarm route is tried FIRST because it is the one known to exist.
 */
const BRAIN_DELTA_ROUTES: readonly string[] = ["/api/swarm/brain-delta", "/api/brain/delta"];

/**
 * A normalised brain delta, exactly as the cloud means it.
 *
 * Every field is guaranteed to be an array and `cursor` a usable ISO string, so
 * no caller has to defend against a missing collection or a bare envelope. This
 * is the contract `BrainDeltaSync` consumes.
 */
export interface BrainDeltaPayload {
  /** What to send as `since` next time. Never re-derive it locally. */
  cursor: string;
  /** Echo of the `since` this page was built from. */
  since: string;
  places: Record<string, unknown>[];
  categories: Record<string, unknown>[];
  tags: Record<string, unknown>[];
  /** Learned facts. The cloud's own name for these; `knowledge` stays `knowledge`. */
  knowledge: Record<string, unknown>[];
  /** True when a ceiling was hit and more is waiting behind this page. */
  truncated: boolean;
}

/**
 * Unwraps and validates a raw delta response.
 *
 * THE ENVELOPE UNWRAP IS THE POINT. The Mothership answers
 * `{ ok: true, delta: { … } }`. The caller used to receive that whole object and
 * then look for `places` and `knowledge_chunks` at the TOP LEVEL, found neither
 * (they are one level down, and the latter is called `knowledge`), and concluded
 * "no cloud changes" — on every poll, forever. Both the nested and the bare
 * shapes are accepted so a proxy that unwraps the envelope for us still works.
 */
function parseBrainDelta(raw: unknown): BrainDeltaPayload | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const root = raw as Record<string, unknown>;

  // A `delta` sub-object wins when present; otherwise the payload is the body.
  const source =
    root["delta"] && typeof root["delta"] === "object" && !Array.isArray(root["delta"])
      ? (root["delta"] as Record<string, unknown>)
      : root;

  const rows = (value: unknown): Record<string, unknown>[] =>
    Array.isArray(value)
      ? value.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object")
      : [];

  /*
    THE CURSOR IS REQUIRED, and refusing to invent one is deliberate. The delta
    window is half-open `(since, cursor]`; storing a locally-computed "now"
    instead of the cloud's value would silently skip every row written between the
    cloud's read and this write. A response without a usable cursor cannot be
    applied safely, so it is rejected rather than half-applied.
  */
  const cursorRaw = source["cursor"];
  if (typeof cursorRaw !== "string" || !Number.isFinite(Date.parse(cursorRaw))) {
    return null;
  }

  return {
    cursor: cursorRaw,
    since: typeof source["since"] === "string" ? source["since"] : "",
    places: rows(source["places"]),
    categories: rows(source["categories"]),
    tags: rows(source["tags"]),
    // Accepts either spelling: the cloud sends `knowledge`, a normalised
    // payload or a proxy might send the ingester's own `knowledge_chunks`.
    knowledge: rows(source["knowledge"] ?? source["knowledge_chunks"]),
    truncated: source["truncated"] === true,
  };
}

/**
 * THE FLEET RESEARCH TASK QUEUE — Epic 2.
 *
 * A SEPARATE NAMESPACE FROM `/api/swarm/tasks`, and that separation is the whole
 * design. `/api/swarm/*` is the control plane: admin commands, OTA, fleet
 * telemetry, and light `scrape`/`llm_query` work. This is the DATA plane — heavy,
 * offline-friendly research (parse a 200-page PDF of park rules, work through a
 * dense Wikipedia page on local flora) that is far too slow and expensive to run
 * against a paid cloud API key, and that a node's idle CPU and local
 * `qwen2.5-coder:7b` can do for free.
 *
 * Keeping them apart means a burst of heavy research can never delay a
 * FORCE_UPDATE, and a stalled research task can never make the fleet look busy
 * to the control plane.
 */

/**
 * Where an idle node asks for research work. The `fleet` spelling is deliberate:
 * it reads as "the fleet's shared backlog", and it is what the Mothership serves.
 */
export const FLEET_TASKS_PATH = "/api/fleet/tasks";

/**
 * Where learned facts are pushed back.
 *
 * A FALLBACK CHAIN, for the same reason as every other chain in this file: a node
 * must not be bricked by a Mothership that has not shipped a route yet. The
 * primary is the brain-ingestion route the swarm namespace already authenticates;
 * the fallback is the quarantine intake every deployment already accepts, so
 * facts learned on a newer node are still recorded — filed for review — against
 * an older cloud, rather than dropped on the floor.
 */
export const BRAIN_INGEST_PATH = "/api/brain/ingest";
export const BRAIN_INGEST_FALLBACK_PATH = FORAGE_QUARANTINE_PATH;

/** The routes tried, in order, by {@link SwarmClient.ingestBrainFacts}. */
const BRAIN_INGEST_ROUTES: readonly string[] = [BRAIN_INGEST_PATH, BRAIN_INGEST_FALLBACK_PATH];

/** One unit of heavy research work handed to an idle node. */
export interface FleetTask {
  id: string;
  /** `pdf_extract` | `deep_crawl` | `page_digest`. */
  kind: string;
  /** What to work on: a URL, plus kind-specific hints. */
  url: string;
  /** Optional focus, e.g. "QLD National Park rules, camping + fire bans". */
  focus: string;
  /** Ceiling on how many facts to return, so one document cannot flood the brain. */
  maxFacts: number;
  /** How many times this task has been handed out (1 on a first dispatch). */
  attempts: number;
}

/** The outcome of one research task, as reported back to the Mothership. */
export interface FleetTaskResult {
  taskId: string;
  ok: boolean;
  facts: number;
  /** Safe to log and store; never rendered as HTML. */
  detail: string;
  durationMs: number;
}

export class SwarmClient {
  private readonly client: AxiosInstance;
  private heartbeatTask: ScheduledTask | null = null;
  private status: NodeStatus = "idle";
  private updateSignal: UpdateSignalHandler | null = null;
  /** Fired when the Mothership pushes work down the heartbeat channel. */
  private taskDispatch: TaskDispatchHandler | null = null;
  /** Fired when the heartbeat reply carries a mesh-key rotation instruction. */
   /** Fired when the heartbeat reply carries a power configuration update. */
   private powerConfigSync: PowerConfigHandler | null = null;

  private meshKeySync: MeshKeySyncHandler | null = null;
  /**
   * Set once the Mothership has answered 404/405 on the quarantine route, after
   * which discoveries go straight to {@link FORAGE_FALLBACK_PATH}. See
   * {@link SwarmClient.pushForageDiscovery}.
   */
  private quarantineUnsupported = false;
  /**
   * Index into {@link CAPABILITY_ROUTES} of the route that last worked, so a
   * Mothership lacking the preferred one is probed once rather than on every
   * capability change. Starts at 0 (the swarm-scoped spelling).
   */
  private capabilityRouteIndex = 0;

  /**
   * Node codes currently linked peer-to-peer, reported as `connected_satellites`.
   * Supplied by the host (the swarm registry owns the truth).
   */
  private connectedSatellites: () => string[] = () => [];
  /** The host's own task counters, reported as `efficiency_score`. */
  private efficiency: () => EfficiencyInput = () => ({ succeeded: 0, total: 0 });
  /**
   * The power-config stamp this node last applied, or null.
   *
   * Supplied by the host because the authoritative record is the persisted
   * `config.json`, not anything this client keeps. Defaults to null so a node
   * that has never been governed reports "nothing applied" rather than holding
   * the cloud in a permanent re-send loop over a stamp it never received.
   */
  private powerConfigApplied: () => string | null = () => null;
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
    /** The power-config stamp this node last applied (the shadow echo). */
    powerConfigApplied?: () => string | null;
  }): void {
    if (sources.connectedSatellites) this.connectedSatellites = sources.connectedSatellites;
    if (sources.efficiency) this.efficiency = sources.efficiency;
    if (sources.commandHandlers) this.commandHandlers = sources.commandHandlers;
    if (sources.powerConfigApplied) this.powerConfigApplied = sources.powerConfigApplied;
  }

  /**
   * Reads the applied power-config stamp, tolerating a provider that throws.
   *
   * A heartbeat must never fail because a telemetry provider misbehaved — the
   * same rule the CPU/RAM providers follow — so a throwing provider degrades to
   * null ("the node did not say"), which at worst costs one redundant config
   * re-send and never a missing heartbeat.
   */
  private readPowerConfigApplied(): string | null {
    try {
      const stamp = this.powerConfigApplied();
      return typeof stamp === "string" && stamp.trim() ? stamp.trim() : null;
    } catch {
      return null;
    }
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

    /*
      THE NODE CODE COMES FROM THE PERSISTED IDENTITY.

      `ensureNodeIdentity()` rather than `currentNodeIdentity()` so the very first
      heartbeat of a first boot MINTS AND PERSISTS a code, instead of putting "" on
      the wire and leaving the cloud to invent an identity it could never match
      again. After that it is a plain config.json read, so the value is identical
      on every ping for the life of the install - which is the whole point: the
      Mothership upserts one fleet row per code, and a value that changed between
      pings is exactly what created a ghost row per restart.
    */
    const nodeCode = ensureNodeIdentity().code;

    const payload: HeartbeatPayload = {
      nodeName: env.NODE_NAME,
      nodeCode,
      role: env.NODE_ROLE,
      status: this.status,
      timestamp: new Date().toISOString(),
      // The build, so the Mothership can pre-check `force_ota_update` instead of
      // queueing a command this node would only refuse as a downgrade.
      version: APP_VERSION,
      ...buildHeartbeatTelemetry(connectedSatellites, efficiency),
      // THE SHADOW ECHO. Snapshotted inside the try below would be too late —
      // this is read synchronously with the rest of the payload, so a value the
      // host updates concurrently cannot end up half-applied.
      power_config_applied_at: this.readPowerConfigApplied(),
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

      /*
        MESH KEY ROTATION, read off the same reply.

        Checked early — before commands and tasks — because a rotation is the
        instruction that changes what every subsequent request is allowed to
        present. Acting on it late would mean one more heartbeat sent with a key
        the fleet had already moved on from.

        `parseMeshKeySync` returns null for the normal case of a reply carrying
        no instruction at all, so this is a no-op on essentially every heartbeat.
        The handler is dispatched fire-and-forget: rotating involves pushing to
        the fleet, and a slow or throwing handler must not mark a healthy
        heartbeat as failed.
      */
      const directive = parseMeshKeySync(data);
      if (directive) {
        console.log(
          `[Swarm] Mesh key sync directive received from Rippa AI` +
            (directive.meshKey ? " (new key issued)." : " (fleet membership corrected)."),
        );
        if (this.meshKeySync) {
          try {
            this.meshKeySync(directive);
          } catch (error) {
            console.warn(`[Swarm] Mesh key sync failed — ${describeError(error)}`);
          }
        } else {
          console.warn(
            "[Swarm] Rippa AI sent a mesh key directive but no handler is wired — ignoring.",
          );
        }
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
         POWER CONFIGURATION UPDATE. Checked after commands so governor updates
         reach the node promptly, dispatched fire-and-forget so a handler that
         throws cannot retroactively mark this heartbeat as failed.
       */
       const powerConfig = parsePowerConfig(data);
       if (powerConfig && this.powerConfigSync) {
         console.log(`[Swarm] Power config update received (mode: ${powerConfig.config.mode}).`);
         try {
           this.powerConfigSync(powerConfig);
         } catch (error) {
           console.warn(`[Swarm] Power config sync handler failed — ${describeError(error)}`);
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
   * Registers the handler fired when the Mothership rotates the mesh key.
   *
   * Wired by index.ts to the swarm dispatcher, which is the only component that
   * owns the credential and the registry. Kept as a setter rather than a
   * constructor argument so `SwarmClient` stays constructible in isolation by
   * the verification harness, which drives it with a stub dispatcher.
   */
  setMeshKeySyncHandler(handler: MeshKeySyncHandler | null): void {
    this.meshKeySync = handler;
  }

  /**
   * Registers the handler fired when the Mothership sends a power configuration update.
   *
   * Wired by index.ts to persist the new power config to the local config.json.
   * The handler is dispatched fire-and-forget: a throwing handler must not turn a
   * successful heartbeat into a reported failure.
   */
  setPowerConfigHandler(handler: PowerConfigHandler | null): void {
    this.powerConfigSync = handler;
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

  /**
   * TELLS THE MOTHERSHIP A COMMAND IS DONE, SO IT LEAVES THE QUEUE.
   *
   * THE MISSING HALF OF THE LOOP. `executePendingCommands` keeps a local
   * `executedCommandIds` set, but that memory dies with the process and is
   * invisible to the cloud. Nothing about it told the Mothership the command
   * had been dealt with, so the entry stayed queued and was re-sent on every
   * heartbeat — producing "Skipping already-executed command" on a 30-second
   * loop, indefinitely, for a command that had already run. This call is what
   * retires the entry upstream.
   *
   * WHY THE ID IS SENT IN EVERY SPELLING. The node does not control the cloud's
   * schema, and the field this endpoint reads may reasonably be named any of
   * these. Sending all of them costs a few bytes and makes the ack work against
   * whichever convention the deployment settled on, instead of silently matching
   * nothing when it guessed wrong — the exact failure mode this whole call
   * exists to remove.
   *
   * NEVER THROWS. An unreachable Mothership must not stop a node from executing
   * the next command, and must never turn a successful command into a crash.
   * Callers treat the return value as advisory.
   */
  async acknowledgeRemoteCommand(input: {
    /** Queue entry id, when the Mothership supplied one. */
    commandId?: string | undefined;
    /** Canonical command name, e.g. "RESTART_NODE". */
    command: string;
    /** Human-readable outcome, shown on the fleet dashboard. */
    detail: string;
    /** Set to "failed" when the command did not complete. */
    status?: "completed" | "failed" | "in_progress" | "rejected_downgrade";
  }): Promise<boolean> {
    const status = input.status ?? "completed";
    const commandId = input.commandId?.trim() ?? "";
    const nodeCode = currentNodeIdentity()?.code ?? env.NODE_NAME;

    const body = {
      // Every plausible spelling of the id, so the ack binds to the queue entry
      // regardless of which name this deployment's handler reads.
      ...(commandId
        ? { command_id: commandId, commandId, task_id: commandId, taskId: commandId, id: commandId }
        : {}),
      command: input.command,
      commandName: input.command,
      status,
      detail: input.detail,
      nodeName: env.NODE_NAME,
      nodeCode,
      role: env.NODE_ROLE,
      // Lets the cloud distinguish "node is still working on it" from "node has
      // permanently retired it" without inferring from the status string.
      completed: status !== "in_progress",
      acknowledgedAt: new Date().toISOString(),
    };

    for (const route of COMMAND_ACK_ROUTES) {
      try {
        await this.client.post(route, body);
        console.log(
          `[Swarm] Acknowledged ${input.command}${commandId ? ` (${commandId})` : ""} ` +
            `via ${route} — ${input.detail}`,
        );
        return true;
      } catch (error) {
        const status_ = axios.isAxiosError(error) ? error.response?.status : undefined;
        // A route that does not exist on this deployment is a downgrade
        // trigger, not a failure — try the next one rather than giving up.
        if (status_ === 404 || status_ === 405 || status_ === 501) {
          continue;
        }
        console.warn(
          `[Swarm] Acknowledgement of ${input.command} failed — ${describeError(error)}`,
        );
        return false;
      }
    }

    /*
      EVERY ACK ROUTE IS ABSENT.

      Recorded as a profile submission so the fleet dashboard still shows the
      command was received and acted on. This does NOT clear the cloud queue —
      a Mothership with no ack route at all has no way to be told — but it keeps
      the record honest and stops the request being re-probed on every command.
    */
    console.warn(
      `[Swarm] Mothership exposes no command-ack route — recording ` +
        `${input.command} as a profile instead. The queue entry may persist.`,
    );
    return this.submitProfile({
      kind: "admin_command_result",
      command: input.command,
      command_id: commandId || null,
      status,
      nodeName: env.NODE_NAME,
      role: env.NODE_ROLE,
      detail: input.detail,
      reportedAt: new Date().toISOString(),
    });
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
 * Index into {@link BRAIN_DELTA_ROUTES} of the route that last worked, so a
 * deployment lacking the preferred spelling is probed once rather than on every
 * ten-minute cycle forever.
 */
  private brainDeltaRouteIndex = 0;

  /**
   * Set once the Mothership has answered 404 on the fleet task queue, after which
   * the poll stops logging. See {@link SwarmClient.fetchFleetTask}.
   */
  private fleetTasksUnsupported = false;

  /**
   * Index into {@link BRAIN_INGEST_ROUTES} of the route that last worked, so a
   * fallback is not re-probed on every ingest.
   */
  private brainIngestRouteIndex = 0;

  /**
   * ASKS THE MOTHERSHIP FOR THE NEXT PIECE OF HEAVY RESEARCH WORK.
   *
   * Returns `null` — not an error — when there is nothing queued, which is the
   * normal state of an idle fleet and must never produce a log line. A transport
   * failure is also `null`, but it is logged with its cause, so the two are
   * distinguishable in the terminal even though both mean "do nothing now".
   *
   * NEVER THROWS. This is called from a background poll, and an escaping
   * rejection there is an unhandled error that can end the process.
   */
  async fetchFleetTask(): Promise<FleetTask | null> {
    try {
      const { data } = await this.client.get(FLEET_TASKS_PATH, { timeout: 20_000 });
      return parseFleetTask(data);
    } catch (error) {
      const status = axios.isAxiosError(error) ? error.response?.status : undefined;
      // 404 means this Mothership has not shipped the queue. That is a permanent
      // property of the deployment, not a blip, so it is said once and
      // remembered rather than repeated every poll for the life of the process.
      if (status === 404 || status === 405 || status === 501) {
        if (!this.fleetTasksUnsupported) {
          this.fleetTasksUnsupported = true;
          console.log(
            "[Fleet] This Mothership serves no /api/fleet/tasks queue. " +
              "Continuing with local foraging only (this notice is not repeated).",
          );
        }
        return null;
      }
      console.warn(`[Fleet] Task poll failed — ${describeError(error)}`);
      return null;
    }
  }

  /**
   * PUSHES FACTS LEARNED FROM A RESEARCH TASK BACK TO THE CENTRAL BRAIN.
   *
   * The facts travel in the local model's own `verified_knowledge` shape, which is
   * the shape the cloud already understands, so nothing has to be re-described on
   * the way in. Every fact carries the task id and the source URL it came from,
   * which is what lets a human audit a claim back to the document it came from
   * rather than taking the node's word for it.
   */
  async ingestBrainFacts(payload: {
    taskId: string;
    sourceUrl: string;
    facts: Array<{
      category: string;
      fact_summary: string;
      confidence_score: number;
      coordinates: string | null;
    }>;
  }): Promise<boolean> {
    const body = {
      ...payload,
      nodeCode: currentNodeIdentity()?.code ?? env.NODE_NAME,
      nodeName: env.NODE_NAME,
      discoveredAt: new Date().toISOString(),
    };

    /*
      START AT THE ROUTE THAT LAST WORKED.

      `brainIngestRouteIndex` was previously written on success and never read,
      so every ingest re-probed a 404ing fallback before reaching the live
      route. Rotating the start offset by the remembered attempt makes the field
      do what its own comment claims, and mirrors `fetchBrainDelta`, which
      already walks `BRAIN_DELTA_ROUTES` from its remembered index. At the
      default of 0 the order is unchanged, so nothing behaves differently until
      a route has actually been found missing.
    */
    for (let attempt = 0; attempt < BRAIN_INGEST_ROUTES.length; attempt += 1) {
      const index = (this.brainIngestRouteIndex + attempt) % BRAIN_INGEST_ROUTES.length;
      const route = BRAIN_INGEST_ROUTES[index];
      try {
        await this.client.post(route, body, { timeout: 30_000 });
        this.brainIngestRouteIndex = index;
        console.log(`[Fleet] Ingested ${payload.facts.length} fact(s) to ${route}.`);
        return true;
      } catch (error) {
        const status = axios.isAxiosError(error) ? error.response?.status : undefined;
        if (status === 404 || status === 405 || status === 501) {
          console.log(`[Fleet] No ingest route at ${route}; trying the fallback.`);
          continue;
        }
        console.warn(
          `[Fleet] Fact ingest failed on ${route} — ${describeError(error)} ` +
            `Mothership said: ${describeResponseBody(error) || "(no body)"}`,
        );
        return false;
      }
    }
    console.warn("[Fleet] No brain-ingest route available; learned facts were NOT uploaded.");
    return false;
  }

  /**
   * REPORTS A RESEARCH TASK'S OUTCOME, so the queue can retire it or re-queue it.
   *
   * Reported for SUCCESS AND FAILURE ALIKE. A task that is never acknowledged sits
   * claimed forever, and a node that silently drops work is indistinguishable
   * from a node that is ignoring the queue — which is the exact ambiguity that
   * made the original "nodes ignore tasks" bug so hard to diagnose.
   */
  async completeFleetTask(result: FleetTaskResult): Promise<boolean> {
    try {
      await this.client.post(
        `${FLEET_TASKS_PATH}/${encodeURIComponent(result.taskId)}/complete`,
        { ok: result.ok, facts: result.facts, detail: result.detail },
        { timeout: 20_000 },
      );
      return true;
    } catch (error) {
      const status = axios.isAxiosError(error) ? error.response?.status : undefined;
      if (status === 404 || status === 405 || status === 501) {
        return false; // no completion route — the facts are already ingested anyway
      }
      console.warn(`[Fleet] Task completion report failed — ${describeError(error)}`);
      return false;
    }
  }

  /**
   * Asks the Mothership for brain records changed since `since`.
   *
   * Returns a NORMALISED delta, or `null` when no route answered. The payload is
   * unwrapped from its `{ ok, delta }` envelope and its collections are
   * normalised here, at the network boundary, so no caller ever has to know that
   * the cloud calls its knowledge array `knowledge` while the local ingester calls
   * it `knowledge_chunks`. See `deltaToBundle` for the other half of that mapping.
   *
   * RETURNS `null` ONLY FOR A GENUINE FAILURE. "Nothing changed" is a successful
   * empty delta, not a failure — the distinction is what lets the caller log a
   * heartbeat either way, and conflating the two is what made this failure
   * invisible in the first place.
   */
  async fetchBrainDelta(since: string | null): Promise<BrainDeltaPayload | null> {
    let lastError: unknown = null;

    for (let attempt = 0; attempt < BRAIN_DELTA_ROUTES.length; attempt += 1) {
      const index = (this.brainDeltaRouteIndex + attempt) % BRAIN_DELTA_ROUTES.length;
      const route = BRAIN_DELTA_ROUTES[index];
      try {
        const { data } = await this.client.get(route, {
          params: since ? { since } : {},
        });
        const delta = parseBrainDelta(data);
        if (!delta) {
          console.warn(
            `[Brain Sync] ${route} answered, but not with a usable delta — ` +
              "leaving the mirror untouched and the cursor unchanged.",
          );
          return null;
        }
        this.brainDeltaRouteIndex = index; // remember the working route
        return delta;
      } catch (error) {
        lastError = error;
        const status = axios.isAxiosError(error) ? error.response?.status : undefined;
        if (status === 404 || status === 405 || status === 501) {
          // Route genuinely absent on this deployment — try the next spelling.
          console.log(`[Brain Sync] No delta route at ${route}; trying the fallback.`);
          continue;
        }
        /*
          EVERYTHING ELSE IS REPORTED WITH ITS CAUSE, and this is the Epic-1
          logging fix. A 401/403 in particular is the one failure an operator can
          act on immediately — the Fleet API Key is wrong or revoked — and the old
          code collapsed it into the same "delta fetch failed" line as a DNS
          error, so nobody knew the key was the problem. The body is included
          because the Mothership's 401 carries an actionable hint.
        */
        if (status === 401 || status === 403) {
          console.warn(
            `[Brain Sync] AUTH FAILED (HTTP ${status}) on ${route} — the Fleet API Key was ` +
              `rejected. Re-check NODE_API_KEY in the node's config. ` +
              `Mothership said: ${describeResponseBody(error) || "(no body)"}`,
          );
          return null;
        }
        console.warn(`[Brain Sync] Delta fetch failed on ${route} — ${describeError(error)}`);
        return null;
      }
    }

    console.warn(
      "[Brain Sync] No brain-delta route on this Mothership (tried " +
        `${BRAIN_DELTA_ROUTES.join(", ")}` +
        (lastError ? `; last error: ${describeError(lastError)}` : "") +
        "). Brain parity is unavailable — the manual bundle upload still works.",
    );
    return null;
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
    let lastError: unknown = null;

    /*
      THE FALLBACK CHAIN. Each route is tried from the one remembered as working,
      and a 404/405/501 (route genuinely absent) advances to the next while any
      other failure — a 401, a 500, a transport error — is a real failure and is
      returned immediately rather than being papered over by a second request.

      The index is remembered on success, so a Mothership without
      `/api/swarm/capabilities` costs exactly one 404 for the life of the
      process rather than one per capability change.
    */
    for (let attempt = 0; attempt < CAPABILITY_ROUTES.length; attempt += 1) {
      const index = (this.capabilityRouteIndex + attempt) % CAPABILITY_ROUTES.length;
      const route = CAPABILITY_ROUTES[index];
      try {
        await this.client.post(route, payload);
        this.capabilityRouteIndex = index;
        console.log(
          `[Swarm] Registered as ${payload.aiCapable ? "AI_CAPABLE_NODE" : "standard node"}` +
            (payload.preferredModel ? ` (${payload.preferredModel})` : "") +
            (index > 0 ? ` via ${route}` : ""),
        );
        return true;
      } catch (error) {
        lastError = error;
        const status = axios.isAxiosError(error) ? error.response?.status : undefined;
        if (status === 404 || status === 405 || status === 501) {
          // Route absent on this deployment — try the next spelling.
          console.log(`[Swarm] No capability route at ${route}; trying the fallback.`);
          continue;
        }
        console.warn(`[Swarm] Capability registration failed — ${describeError(error)}`);
        return false;
      }
    }

    // A Mothership with neither route is fine — the node just stays a standard
    // worker. Logged once, with the reason, so it is diagnosable rather than silent.
    console.warn(
      `[Swarm] Capability registration failed — this Mothership exposes neither ` +
        `${CAPABILITY_PATH} nor ${CAPABILITY_FALLBACK_PATH}` +
        (lastError ? ` (${describeError(lastError)})` : "") +
        ". Staying a standard node.",
    );
    return false;
  }
}

// --- fleet task parsing (moved out of the class body; see git history) ---
  /**
 * EXTRACTS ONE TASK FROM A `/api/fleet/tasks` RESPONSE.
 *
 * Returns `null` for "nothing queued" AND for "the response made no sense", which
 * are treated alike on purpose: in both cases the correct action is to do nothing
 * and try again, and neither is worth an operator's attention. Anything WITH a
 * usable id and URL is real work, whatever else is missing — `focus` and
 * `maxFacts` are conveniences with honest defaults, because a task dispatched
 * without them is still worth doing.
 *
 * `maxFacts` is CLAMPED rather than trusted. It arrives over the network from a
 * queue an admin fills in, and an unbounded value would let one document push
 * thousands of facts into the central brain in a single push.
 */
function parseFleetTask(raw: unknown): FleetTask | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const root = raw as Record<string, unknown>;

  // Accept a bare task, or an envelope under `task` / `data`.
  const candidate =
    root["task"] && typeof root["task"] === "object"
      ? (root["task"] as Record<string, unknown>)
      : Array.isArray(root["tasks"])
        ? (root["tasks"] as unknown[])[0]
        : root;
  if (!candidate || typeof candidate !== "object") return null;

  const record = candidate as Record<string, unknown>;
  const id = firstString(record, ["id", "taskId", "task_id"]);
  const url = firstString(record, ["url", "target", "source_url"]);
  if (!id || !url) return null;

  const requestedMax = Number(record["maxFacts"] ?? record["max_facts"]);
  const maxFacts = Number.isFinite(requestedMax) && requestedMax > 0
    ? Math.min(Math.floor(requestedMax), MAX_FACTS_PER_TASK)
    : DEFAULT_MAX_FACTS_PER_TASK;

  return {
    id,
    kind: firstString(record, ["kind", "type", "taskType", "task_type"]) ?? "page_digest",
    url,
    focus: firstString(record, ["focus", "instruction", "subject", "goal"]) ?? "",
    maxFacts,
    attempts: Number(record["attempts"]) > 0 ? Number(record["attempts"]) : 1,
  };
}

/** Ceiling on facts per research task — see `parseFleetTask`. */
const MAX_FACTS_PER_TASK = 25;
/** Used when the queue does not say. Deliberately modest for a first run. */
const DEFAULT_MAX_FACTS_PER_TASK = 8;

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
