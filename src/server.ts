import crypto from "node:crypto";
import fs from "node:fs";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import os from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import axios from "axios";
import { z } from "zod";
import { env, reloadEnv } from "./config";
import { APP_VERSION } from "./version";
import { describeRuntime, runtimeCapabilities } from "./platform";
import { scanForMasters } from "./network/discovery";
import {
  ensureNodeIdentity,
  getPairing,
  isValidNodeCode,
  normalizeNodeCode,
  regenerateNodeCode,
  setNodeCode,
  type PeerEndpoint,
} from "./config/nodeAuth";
import { SwarmDispatcher, type LoadClass, type TaskOutcome } from "./services/swarmDispatcher";
import {
  forwardToMaster,
  isRemoteProxyRequest,
} from "./services/remoteProxy";
import { verifyMeshKey } from "./config/nodeAuth";
import { getBrainCounts, getSyncCursor, ingestBrainBundle } from "./services/brainIngest";
import { latestNodeEvent, publishNodeEvent, subscribeNodeEvents } from "./services/nodeEvents";
import { getDeepBrain } from "./db/database";
import { ollamaManager } from "./services/ollamaManager";
import {
  getAiEndpointSettings,
  saveAiEndpointSettings,
  validateAiEndpointSettings,
} from "./services/aiEndpointSettings";
import {
  RELEASE_ASSET_NAME,
  SwarmUpdater,
  handleUpdateTrigger,
  isPackagedExe,
  parseUpdateTrigger,
  releaseDownloadUrl,
} from "./services/updater";
import { isVersionNewer } from "./version";
import { EXIT_APPLY_UPDATE, EXIT_RESTART, EXIT_SHUTDOWN, isUnderWatchdog } from "./update/exitCodes";
import {
  DEFAULT_DASHBOARD_PIN,
  applyConfigToEnv,
  configFileExists,
  configFilePath,
  describeConfigGaps,
  isConfigComplete,
  normalizeConfig,
  readConfig,
  readConfigLenient,
  resolveAppRoot,
  resolvePublicDir,
  validateConfigInput,
  writeConfig,
} from "./config/configManager";
// Type-only: used to type the object handed to writeConfig below. Kept out of the
// value import list because it is erased at compile time and must not become a
// runtime dependency in the pkg snapshot.
import type { RippaNodeConfig } from "./config/configManager";
import {
  backlog,
  publishHealth,
  subscribeTelemetry,
} from "./services/engineTelemetry";
import { runEngineCommand } from "./services/engineCli";
import {
  appendMessage,
  CommandBatchProcessor,
  deleteBatch,
  ensureCommandCenterSchema,
  ensureThread,
  findBatchFolder,
  getBatch,
  listMessages,
  listRecentBatches,
  postAssistantMessage,
  stageIntake,
  sweepOrphanBatchFolders,
  walkBatchFiles,
} from "./services/commandCenter";
import { registerSwarmTriageRoutes } from "./api/swarmTriageRoutes";
import {
  completeRemoteTask,
  createRemoteTask,
  ensureRemoteTaskSchema,
  failRemoteTask,
  getRemoteTask,
  listRemoteTasks,
  updateRemoteTask,
} from "./services/remoteTasks";
import { sanitizeFilename, parseMultipart } from "./services/multipartParser";
import { dataFilePath } from "./utils/paths";

/**
 * THE INTERROGATION ENDPOINT — where the cloud-based Rippa AI pings the
 * Master Node for deep context.
 */

export const interrogateSchema = z.object({
  query: z.string().min(1, "query must be a non-empty string"),
});

export const authSchema = z.object({
  pin: z.string().min(1, "pin is required").optional(),
  passkey: z.string().min(1).optional(),
  dashboard_pin: z.string().min(1).optional(),
});

/** Cookie + localStorage key holding the dashboard session token. */
export const AUTH_COOKIE_NAME = "rippa_dashboard_auth";
const AUTH_TOKEN_TTL_MS = 1000 * 60 * 60 * 12; // 12 hours

/** In-memory dashboard session tokens: token -> expiry timestamp. */
const dashboardSessions = new Map<string, number>();

function expectedDashboardPin(): string {
  const stored = readConfigLenient();
  const pin =
    stored?.DASHBOARD_PIN?.trim() ||
    process.env.DASHBOARD_PIN?.trim() ||
    (env as { DASHBOARD_PIN?: string }).DASHBOARD_PIN?.trim() ||
    DEFAULT_DASHBOARD_PIN;
  return pin || DEFAULT_DASHBOARD_PIN;
}

/** Optional hook invoked after POST /api/system/config saves new settings. */
export type ConfigChangeHandler = () => void | Promise<void>;

let configChangeHandler: ConfigChangeHandler | null = null;

/**
 * The Rippa Node AI instance backing the mesh endpoints.
 *
 * Owned by the server (not index.ts) so the API routes and the boot sequence
 * share one registry. index.ts drives start()/stop() through the exported
 * accessors below rather than constructing a second dispatcher.
 */
const dispatcher = new SwarmDispatcher();

/** The shared dispatcher used by the mesh API routes. */
export function getDispatcher(): SwarmDispatcher {
  return dispatcher;
}

/**
 * The live Orchestrator instance, registered by index.ts once built. Nullable
 * because the orchestrator only exists once the node is fully configured —
 * the self-heal route below degrades gracefully when it is absent.
 */
interface OrchestratorScraperRef {
  getScraper: () => {
    selfHeal: () => Promise<{ healed: boolean; message: string }>;
    isBrowserBacked: () => boolean;
  };
  getOllama: () => {
    extractFacts: (text: string) => Promise<{ fact_summary: string; category: string } | null>;
  };
}

let orchestratorRef: OrchestratorScraperRef | null = null;

/** Registers the live Orchestrator so API routes can reach its scraper. */
export function setOrchestratorRef(orchestrator: OrchestratorScraperRef | null): void {
  orchestratorRef = orchestrator;
  // The Command Center processor's model comes from the same registration —
  // no second ref, no second lifecycle to keep in sync with stop/start.
  setOrchestratorLlmRef(
    orchestrator ? { extractFacts: (text: string) => orchestrator.getOllama().extractFacts(text) } : null,
  );
}

/**
 * The narrow view of BrainDeltaSync that the status route needs. Declared as an
 * interface rather than importing the class so the route can be exercised in
 * isolation, exactly as `OrchestratorScraperRef` above does for the scraper.
 */
interface BrainSyncRef {
  isRunning: () => boolean;
  syncNow: () => Promise<{
    ok: boolean;
    facts: number;
    places: number;
    cursor: string | null;
    message: string;
  }>;
}

let brainSyncRef: BrainSyncRef | null = null;

/** Registers the live trickle-sync so the Control Center can see and force it. */
export function setBrainSyncRef(sync: BrainSyncRef | null): void {
  brainSyncRef = sync;
}

/**
 * Narrow view of the live Orchestrator's Ollama client, so the Command Center
 * routes can reach local inference without importing the agent graph.
 *
 * Declared as an interface (not the class) for the same reason as
 * `OrchestratorScraperRef` above: routes stay exercisable in isolation, and
 * the processor's structural `extractFacts` dep means the server never needs
 * the concrete type here.
 */
interface OrchestratorLlmRef {
  extractFacts: (text: string) => Promise<{ fact_summary: string; category: string } | null>;
}

let orchestratorLlmRef: OrchestratorLlmRef | null = null;

/** Registers the live local model for Command Center batch analysis. */
export function setOrchestratorLlmRef(llm: OrchestratorLlmRef | null): void {
  orchestratorLlmRef = llm;
}

/**
 * The Command Center batch processor — one per server, started for the
 * Master's boot path and fed the live model through `setOrchestratorLlmRef`.
 * Satellites never start it (their route handlers refuse first anyway).
 */
const commandBatchProcessor = new CommandBatchProcessor({
  isModelWired: () => orchestratorLlmRef !== null,
  extractFacts: async (text: string) => {
    if (!orchestratorLlmRef) return null;
    try {
      const fact = await orchestratorLlmRef.extractFacts(text);
      if (!fact || typeof fact.fact_summary !== "string") return null;
      return { fact_summary: fact.fact_summary, category: String(fact.category ?? "description") };
    } catch {
      return null;
    }
  },
});

/** Starts the Command Center queue consumer (Master-only; called by boot). */
export function startCommandCenter(): void {
  try {
    ensureCommandCenterSchema();
  } catch {
    return; // satellite / pre-init — the routes degrade to clean 400s.
  }
  sweepOrphanBatchFolders();
  commandBatchProcessor.start();
}

/** Stops the Command Center queue consumer (shutdown path). */
export function stopCommandCenter(): void {
  commandBatchProcessor.stop();
}

/**
 * The GitHub OTA updater for this node.
 *
 * Owned by the server so the `/api/mesh/update-trigger` route and the boot
 * sequence drive the SAME instance — two updaters would mean two competing
 * download/swap attempts and a double `process.exit(0)`.
 */
const swarmUpdater = new SwarmUpdater(dispatcher);

/** The shared OTA updater used by the mesh routes and by index.ts. */
export function getSwarmUpdater(): SwarmUpdater {
  return swarmUpdater;
}

/** Registers the re-initializer run after a GUI config save. */
export function onConfigChange(handler: ConfigChangeHandler | null): void {
  configChangeHandler = handler;
}

/**
 * THE NODE'S LIFECYCLE ACTIONS, registered by index.ts.
 *
 * The Express app lives here but the graceful-teardown sequence lives in the boot
 * sequence, because it owns the service handles that have to be stopped. So the
 * routes below cannot call `shutdown` directly; the boot sequence registers it,
 * exactly as it does for `onConfigChange`.
 *
 * Both handlers end in `process.exit`, with a code the Rippa Watchdog reads:
 * restart is 42 and shutdown is 0 (see `src/update/exitCodes.ts`). That is the
 * whole reason a remote restart is no longer a remote shutdown — there is a
 * process on the other end of the exit code whose job is to bring the node back.
 */
export interface NodeLifecycleHandlers {
  /** Stop every service cleanly and exit 42 so the watchdog relaunches us. */
  restart: () => Promise<void> | void;
  /** Stop every service cleanly and exit 0, leaving the machine dark. */
  shutdown: () => Promise<void> | void;
}

let lifecycle: NodeLifecycleHandlers | null = null;

export function setNodeLifecycle(handlers: NodeLifecycleHandlers | null): void {
  lifecycle = handlers;
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(value);
    } catch {
      out[key] = value;
    }
  }
  return out;
}

function createDashboardSession(): { token: string; expiresAt: number } {
  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = Date.now() + AUTH_TOKEN_TTL_MS;
  dashboardSessions.set(token, expiresAt);
  // Opportunistic cleanup so the map can't grow without bound.
  if (dashboardSessions.size > 500) {
    const now = Date.now();
    for (const [key, expiry] of dashboardSessions) {
      if (expiry <= now) dashboardSessions.delete(key);
    }
  }
  return { token, expiresAt };
}

/** True when the request carries a live dashboard session token. */
export function hasDashboardSession(req: Request): boolean {
  const cookies = parseCookies(req.headers.cookie);
  const fromCookie = cookies[AUTH_COOKIE_NAME];
  const authHeader = req.headers.authorization;
  const fromHeader =
    typeof authHeader === "string" && authHeader.toLowerCase().startsWith("bearer ")
      ? authHeader.slice(7).trim()
      : "";
  const token = (fromCookie || fromHeader || "").trim();
  if (!token) return false;
  const expiry = dashboardSessions.get(token);
  if (!expiry) return false;
  if (expiry <= Date.now()) {
    dashboardSessions.delete(token);
    return false;
  }
  return true;
}

/**
 * Reads the caller's mesh credential from X-Mesh-Key or Bearer.
 * Shared by the mesh node-to-node routes AND the Satellite remote-proxy
 * bridge below (both already spoke "either header" before this epic).
 */
function meshKeyOfRequest(req: Request): string {
  const dedicated = String((req.headers["x-mesh-key"] as string | undefined) ?? "").trim();
  if (dedicated) return dedicated;
  const auth = String((req.headers["authorization"] as string | undefined) ?? "").trim();
  const bearer = /^Bearer\s+(.+)$/i.exec(auth);
  return bearer ? bearer[1].trim() : "";
}

/**
 * True when this request is a Satellite remote-control forward that the
 * Master should honour WITHOUT the operator's dashboard PIN.
 *
 * DEFENCE IN DEPTH: the Satellite marker header must be present AND the
 * presented mesh key must verify against this Master's persisted key.
 * Local-only routes are never honoured via mesh key, even with the marker.
 */
function isSatelliteRemoteProxy(req: Request, proxyablePath: string): boolean {
  if (!isRemoteProxyRequest(req as unknown as { headers?: Record<string, unknown> })) return false;
  const clean = String(proxyablePath || "").split("?")[0];
  // Local-only routes are never honoured via mesh key, even with the marker.
  if (
    clean === "/api/system/config" ||
    clean.startsWith("/api/system/config/") ||
    clean === "/api/config" ||
    clean.startsWith("/api/config/") ||
    clean === "/api/mesh/pair-with-master" ||
    clean === "/api/mesh/identity" ||
    clean === "/api/mesh/self-heal" ||
    clean === "/api/node/restart" ||
    clean === "/api/node/shutdown"
  ) {
    return false;
  }
  const key = meshKeyOfRequest(req);
  if (!key) return false;
  return verifyMeshKey(key);
}

/**
 * PIN gate for `/api/system/*` (except the auth + status probes below) and the
 * main dashboard view. Setup can proceed unauthenticated until the node has a
 * complete config.json; afterwards the LAN passkey is required.
 */
export function requireDashboardAuth(req: Request, res: Response, next: NextFunction): void {
  // First-run setup stays open so the operator can create config.json + PIN.
  //
  // CRITICAL: this MUST use the same predicate as the `configured` field of
  // GET /api/system/auth/status (`isConfigComplete`). The two previously
  // disagreed — this gate keyed off "config.json exists" while `configured`
  // keyed off "config.json is complete" — so a partially written config.json
  // made the GUI show the Setup Screen and then receive a 401, bouncing the
  // user to the Lock Screen mid-boot. One predicate, no bounce.
  if (!isConfigComplete(readConfig())) {
    next();
    return;
  }
  if (hasDashboardSession(req)) {
    next();
    return;
  }
  // SATELLITE REMOTE-CONTROL BRIDGE: a paired Satellite forwards its
  // operator's dashboard calls with the mesh key + proxy marker. The Master
  // honours those WITHOUT the operator's PIN (the Satellite already checked
  // it) — but ONLY for allow-listed Master-owned paths. Everything else
  // still 401s.
  try {
    const proxyPath = String((req.originalUrl || req.url || "").split("?")[0] || req.path || "");
    if (isSatelliteRemoteProxy(req, proxyPath)) {
      next();
      return;
    }
  } catch {
    /* fall through to the 401 below */
  }
  res.status(401).json({
    success: false,
    authenticated: false,
    message: "Dashboard locked — enter the passkey to continue.",
  });
}

function setAuthCookie(res: Response, token: string, expiresAt: number): void {
  const parts = [
    `${AUTH_COOKIE_NAME}=${encodeURIComponent(token)}`,
    "Path=/",
    `Expires=${new Date(expiresAt).toUTCString()}`,
    "SameSite=Lax",
  ];
  // Secure only helps on https; keep LAN http logins working.
  const existing = res.getHeader("Set-Cookie");
  if (Array.isArray(existing)) {
    res.setHeader("Set-Cookie", [...existing, parts.join("; ")]);
  } else if (typeof existing === "string") {
    res.setHeader("Set-Cookie", [existing, parts.join("; ")]);
  } else {
    res.setHeader("Set-Cookie", parts.join("; "));
  }
}

function clearAuthCookie(res: Response): void {
  res.setHeader(
    "Set-Cookie",
    `${AUTH_COOKIE_NAME}=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; SameSite=Lax`,
  );
}

/** Local IPv4 addresses (for the LAN-access log line on boot). */
export function getLanAddresses(): string[] {
  const out: string[] = [];
  try {
    const nets = os.networkInterfaces();
    for (const addrs of Object.values(nets)) {
      for (const addr of addrs ?? []) {
        if (addr.family === "IPv4" && !addr.internal) out.push(addr.address);
      }
    }
  } catch {
    /* best effort — boot log only */
  }
  return out;
}

/**
 * THE CONFIG PAYLOAD — the single source of truth for what config.json holds.
 *
 * Read fresh from disk on every call (no module-level cache), because the GUI
 * reads it immediately after a save and a cached copy is precisely what leaves
 * an operator staring at a stale Setup Screen after a successful write.
 *
 * `configured` is computed with the SAME predicate the auth gate and the
 * `/api/system/auth/status` probe use, so the three can never disagree.
 * `missing` names the fields still blocking it, which turns an unexplained
 * "setup required" into an actionable instruction.
 *
 * The API key and passkey are NEVER returned — only whether they are set, and
 * only once they pass a minimum length. This payload is what the dashboard
 * renders, so a real secret must never appear in a browser-visible response.
 */
function buildConfigPayload(authenticated: boolean): Record<string, unknown> {
  const stored = readConfigLenient() ?? normalizeConfig({});
  const complete = isConfigComplete(readConfig());
  const apiKey = (stored.NODE_API_KEY ?? "").trim();
  const pin = (stored.DASHBOARD_PIN ?? "").trim();
  return {
    success: true,
    configured: complete,
    authenticated,
    // Diagnostics: separates "no config.json on disk" from "config.json present
    // but incomplete", and names the exact fields still required.
    configPresent: configFileExists(),
    configPath: configFilePath(),
    missing: complete ? [] : describeConfigGaps(readConfig()),
    /*
      THE NODE CODE, AT THE TOP LEVEL OF THE PAYLOAD.

      The Setup screen shows this next to the "Regenerate Code" button, and the
      response to a regeneration has to carry the new value so the UI can repaint
      from the response it already has rather than racing a second fetch. The
      dashboard reads the same code from /api/mesh/snapshot; exposing it here too
      means the settings page never shows a stale or missing code.
    */
    nodeCode: stored.NODE_CODE || "",
    nodeCodeCreatedAt: stored.NODE_CREATED_AT || "",
    config: {
      node_role: stored.NODE_ROLE,
      NODE_ROLE: stored.NODE_ROLE,
      master_node_url: stored.MASTER_LOCAL_URL,
      MASTER_LOCAL_URL: stored.MASTER_LOCAL_URL,
      mothership_url: stored.MOTHERSHIP_URL,
      MOTHERSHIP_URL: stored.MOTHERSHIP_URL,
      node_name: stored.NODE_NAME,
      NODE_NAME: stored.NODE_NAME,
      // Masked: the real values are write-only from the browser's point of view.
      NODE_API_KEY: "",
      apiKeyConfigured: apiKey.length >= 8,
      dashboard_pin: "",
      pinConfigured: pin.length >= 4,
      cloud_link_code: stored.cloud_link_code ?? "",
      ollama_url: stored.OLLAMA_URL,
      OLLAMA_URL: stored.OLLAMA_URL,
      port: stored.PORT,
      PORT: stored.PORT,
    },
  };
}

/** Builds the Express app (separated from listen() for testability). */
export function createApp(): Express {
  const app = express();

  /*
    CROSS-ORIGIN ACCESS FOR THE MESH API — AND ONLY FOR IT.

    A Capacitor WebView's origin is `http://localhost` (Android) or
    `capacitor://localhost` (iOS). Neither matches a Master Node reached by LAN IP
    or hostname, so EVERY request a phone satellite makes is cross-origin and is
    refused by the browser's same-origin policy before it reaches a route. Without
    this block the satellite feature cannot work at all, and the symptom is an
    opaque network error in the phone's console rather than anything on the node.

    SCOPED TO `/api/mesh/*` DELIBERATELY, and that scope is the security decision.
    The node also serves the dashboard PIN, `POST /api/system/config` (which writes
    the node's configuration) and the static GUI. None of those may be reachable
    from a browser on the LAN that merely happens to be on the same subnet, and a
    blanket `Access-Control-Allow-Origin: *` would put all of them in reach. The
    mesh API is the one surface a satellite genuinely needs cross-origin, and it is
    guarded by the mesh key — so this widens WHO can ask, not WHAT they can do.

    `Vary: Origin` is present because these responses are per-origin, and without
    it a shared cache could serve one origin's CORS headers to another.

    The mesh routes themselves authenticate independently: `/api/mesh/result` and
    `/api/mesh/peer-outcome` require a valid mesh key, and the dashboard
    (`/api/system/*`, `/dashboard`) is PIN-gated and not in this scope.
  */
  app.use("/api/mesh", (req: Request, res: Response, next: NextFunction) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Mesh-Key, Authorization");
    res.setHeader("Access-Control-Max-Age", "600");
    res.setHeader("Vary", "Origin");
    // A preflight must be ANSWERED, not passed to the router — there is no
    // OPTIONS handler below, so without this the preflight would 404 and the real
    // request would never be sent.
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
  });

  /*
    THE BRAIN BUNDLE PARSER, REGISTERED BEFORE THE GLOBAL ONE.

    `express.json()`'s DEFAULT LIMIT IS 100 kB, and a brain bundle is orders of
    magnitude larger than that — 50,000 places with summaries is tens of megabytes.
    Express matches middleware in registration order, so the global parser below
    would answer 413 "Payload Too Large" before the brain route's handler ever ran,
    and the feature would look broken in a way that is very hard to diagnose from
    the client: the browser would report "upload failed" and the server log would
    show a 413 from a middleware nobody remembers registering.

    So the large-limit parser is registered FIRST and scoped to this one path. Every
    other route keeps the 100 kB default, which is a real protection against a
    malicious client parking megabytes of JSON in the node's heap on a Raspberry
    Pi — widening it globally for the convenience of one route would remove that
    from every other endpoint on the LAN.
  */
  app.use(
    "/api/brain",
    express.json({ limit: "256mb", type: ["application/json", "application/*+json"] }),
  );
  // Raw multipart bodies must be captured BEFORE express.json() runs: the
  // global JSON parser would otherwise consume (and reject) the file bytes,
  // leaving req.body empty so there is nothing left to forward to the Master.
  // Scoped to the intake + swarm-ingest upload paths; every other route keeps
  // the JSON parser.
  app.use("/api/command-center/intake", express.raw({ limit: "2gb", type: "multipart/*" }));
  app.use("/api/storage/upload", express.raw({ limit: "70mb", type: "*/*" }));
  app.use(express.json());

  /*
    SATELLITE REMOTE-PROXY MIDDLEWARE — the Satellite-as-Remote-Control epic.

    When THIS node runs as a `satellite`, Master-owned dashboard routes must
    NOT execute locally (there is no Deep Brain, no fleet registry, no triage
    tables here). Instead the request is forwarded to the paired Master and
    the Master's response is relayed back, so the Satellite UI feels local
    while the Master takes the compute load.

    PLACEMENT IS LOAD-BEARING:
    - AFTER express.json() (and the early intake express.raw) so req.body is
      parsed and re-sendable — JSON rides as JSON, multipart rides as a Buffer.
    - BEFORE every /api/admin, /api/mesh/snapshot, /api/brain and
      /api/command-center route below, so no Master-only guard runs first.

    forwardToMaster is a closed allow-list: local-only routes (config writes,
    pairing, identity, self-heal, restart/shutdown) fall through and keep
    running against THIS node.
  */
  app.use(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const handled = await forwardToMaster(
        req as unknown as Parameters<typeof forwardToMaster>[0],
        res as unknown as Parameters<typeof forwardToMaster>[1],
      );
      if (handled) return;
    } catch (error) {
      res.status(502).json({
        success: false,
        remoteMode: true,
        message: `Remote proxy failed — ${error instanceof Error ? error.message : String(error)}`,
      });
      return;
    }
    next();
  });

  // Liveness probe for the Mothership / local monitoring.
  app.get("/health", (_req: Request, res: Response) => {
    res.json({
      success: true,
      node: env.NODE_NAME,
      role: env.NODE_ROLE,
      status: "online",
      version: APP_VERSION,
      // What THIS build can actually do. Essential on a tablet: it is the only
      // way to confirm from the LAN that the APK really took the lightweight
      // scraping path, rather than inferring it from a log nobody can reach.
      runtime: runtimeCapabilities(),
    });
  });

  // POST /interrogate — deep-context lookup for the cloud Rippa AI.
  app.post("/interrogate", (req: Request, res: Response) => {
    const parsed = interrogateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        errors: parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      });
      return;
    }

    const { query } = parsed.data;
    console.log(`[API] Interrogate received: "${query}"`);

    // TODO: query the Deep Brain (raw_lore / verified_knowledge) once
    // knowledge ingestion is live — for now every response is a mock.
    res.json({
      success: true,
      context: "Node is active but knowledge base is empty.",
    });
  });

  // ---- Dashboard passkey auth (public — issues the LAN session) ----

  // GET /api/system/auth/status — lock-screen probe (role + bridge URL only).
  app.get("/api/system/auth/status", (_req: Request, res: Response) => {
    const stored = readConfigLenient();
    const configured = isConfigComplete(readConfig());
    res.json({
      success: true,
      authenticated: _req ? hasDashboardSession(_req) : false,
      configured,
      // Diagnostic only: separates "no config.json on disk" from "config.json
      // present but incomplete". Both yield configured:false, but the GUI uses
      // this to show the right guidance, and it makes a mis-placed config.json
      // obvious in the network tab when troubleshooting the .exe.
      configPresent: configFileExists(),
      configPath: configFilePath(),
      node_role: stored?.NODE_ROLE ?? env.NODE_ROLE,
      master_node_url: stored?.MASTER_LOCAL_URL ?? env.MASTER_LOCAL_URL,
      pinConfigured: Boolean((stored?.DASHBOARD_PIN ?? "").trim()),
    });
  });

  // POST /api/system/auth — verifies the PIN against config.json, sets session.
  app.post("/api/system/auth", (req: Request, res: Response) => {
    const parsed = authSchema.safeParse(req.body ?? {});
    const supplied = (
      parsed.success
        ? (parsed.data.pin || parsed.data.passkey || parsed.data.dashboard_pin || "")
        : String(
            ((req.body as Record<string, unknown> | null)?.["pin"] ??
              (req.body as Record<string, unknown> | null)?.["passkey"] ??
              (req.body as Record<string, unknown> | null)?.["dashboard_pin"] ??
              "") as string,
          )
    )
      .toString()
      .trim();
    if (!supplied) {
      res.status(400).json({ success: false, authenticated: false, message: "Passkey is required." });
      return;
    }
    // First-run (no usable config.json yet): accept the default PIN so setup can
    // start. Uses the same isConfigComplete() predicate as requireDashboardAuth
    // and the `configured` flag, so a partially written config.json cannot
    // lock the operator out of the screen that repairs it.
    if (!isConfigComplete(readConfig())) {
      if (supplied !== DEFAULT_DASHBOARD_PIN) {
        res.status(401).json({ success: false, authenticated: false, message: "Incorrect passkey." });
        return;
      }
    } else if (supplied !== expectedDashboardPin()) {
      console.log("[API] Failed dashboard login attempt.");
      res.status(401).json({ success: false, authenticated: false, message: "Incorrect passkey." });
      return;
    }
    const { token, expiresAt } = createDashboardSession();
    setAuthCookie(res, token, expiresAt);
    console.log("[API] Dashboard unlocked (passkey accepted).");
    res.json({ success: true, authenticated: true, token, expiresAt });
  });

  // POST /api/system/auth/logout — clears the dashboard session.
  app.post("/api/system/auth/logout", (req: Request, res: Response) => {
    const cookies = parseCookies(req.headers.cookie);
    const token = (cookies[AUTH_COOKIE_NAME] || "").trim();
    if (token) dashboardSessions.delete(token);
    clearAuthCookie(res);
    res.json({ success: true, authenticated: false });
  });

  /*
    GET /api/system/events — the node's Server-Sent Events stream.

    WHAT THIS CARRIES. Two kinds of thing the dashboard cannot learn by asking:

      - `admin_command`: a Force OTA Update or Restart Node Service arrived on the
        heartbeat. The operator needs to see it the moment it happens.
      - `brain_sync`: progress through a bundle load, so the Master Brain Parity
        panel shows a moving bar instead of appearing frozen for 30 seconds.

    WHY SSE AND NOT A POLL. The progress signal is high-frequency and the admin
    signal is rare but latency-sensitive. A poll would either hammer the CPU while
    a bundle loads or make a restart take seconds to appear; a stream costs one
    open connection and delivers both immediately.

    THE HEARTBEAT FRAME IS NOT OPTIONAL. Proxies and browsers close an idle
    connection, and a dashboard sitting untouched during a 126 MB download would
    otherwise be disconnected exactly when it needs to keep listening.

    REPLAYED STATE ON CONNECT. A dashboard opened AFTER an admin command arrived
    must still see it — that is the normal case, since the operator usually opens
    the dashboard after sending the command. The retained "blocking" event is
    replayed first, which is what puts the overlay up.
  */
  app.get("/api/system/events", requireDashboardAuth, (req: Request, res: Response) => {
    res.status(200).set({
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Disables response buffering in nginx-style reverse proxies, which would
      // otherwise hold every frame until the connection closed.
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders?.();

    // Replay the retained admin command (if any) so a late-joining dashboard
    // still gets the overlay, then the last brain-sync state for the same reason.
    const replay = latestNodeEvent("admin_command");
    if (replay?.blocking) res.write(`data: ${JSON.stringify(replay)}\n\n`);
    const brain = latestNodeEvent("brain_sync");
    if (brain) res.write(`data: ${JSON.stringify(brain)}\n\n`);
    // The Command Center thread follows the same rule: a late-joining chat
    // view replays the latest analysis post rather than opening on silence.
    const ccLatest = latestNodeEvent("command_center");
    if (ccLatest) res.write(`data: ${JSON.stringify(ccLatest)}\n\n`);

    const unsubscribe = subscribeNodeEvents((event) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    });

    const heartbeat = setInterval(() => {
      // A comment frame keeps intermediaries from reaping an idle stream.
      res.write(": keep-alive\n\n");
    }, 20_000);

    // `close` fires for both a clean client disconnect and an aborted request, so
    // this single handler is enough to release the listener and the timer.
    const cleanup = (): void => {
      clearInterval(heartbeat);
      unsubscribe();
    };
    req.on("close", cleanup);
    req.on("error", cleanup);
    res.on("error", cleanup);
  });

  // GET /api/system/config — current config.json state (API key + PIN masked).
  app.get("/api/system/config", requireDashboardAuth, (req: Request, res: Response) => {
    res.json(buildConfigPayload(hasDashboardSession(req)));
  });

  /*
    GET /api/config — the short alias the Control Center boots from.

    Same handler, same payload, same auth gate as /api/system/config. It exists
    so the dashboard has ONE canonical "what is saved right now" endpoint to
    read on load and immediately after a save, rather than inferring state from
    the auth probe. Auth-gated exactly like its twin: the payload reveals the
    node's name, role and Mothership URL, which is not LAN-public information.
  */
  app.get("/api/config", requireDashboardAuth, (req: Request, res: Response) => {
    res.json(buildConfigPayload(hasDashboardSession(req)));
  });

  // GET /api/system/network/scan — LAN auto-discovery for satellite setup.
  // Listens for Master beacons on the UDP discovery port and returns every
  // Master heard, so the GUI can offer a one-click Master selection instead of
  // a hand-typed IP. Always succeeds with (possibly empty) results: a blocked
  // firewall or a network that forbids broadcast is not an error.
  app.get(
    "/api/system/network/scan",
    requireDashboardAuth,
    async (_req: Request, res: Response) => {
      try {
        const masters = await scanForMasters();
        res.json({ success: true, count: masters.length, masters });
      } catch (error) {
        // scanForMasters resolves rather than rejects, so this is a last-resort
        // net — the UI must still fall back to manual entry rather than hang.
        console.warn(`[Discovery] Scan failed — ${error instanceof Error ? error.message : error}`);
        res.json({ success: true, count: 0, masters: [] });
      }
    },
  );

  // POST /api/system/config — validate, save, re-init node services.
  app.post("/api/system/config", requireDashboardAuth, (req: Request, res: Response) => {
    // Leaving the API key field blank keeps the already-saved key.
    const body =
      req.body && typeof req.body === "object" ? { ...(req.body as Record<string, unknown>) } : {};
    if (
      (body["NODE_API_KEY"] === undefined || body["NODE_API_KEY"] === "") &&
      (body["node_api_key"] === undefined || body["node_api_key"] === "")
    ) {
      const existing = readConfigLenient();
      if (existing && existing.NODE_API_KEY) {
        body["NODE_API_KEY"] = existing.NODE_API_KEY;
      }
    }
    // Leaving the passkey blank keeps the already-saved PIN.
    if (
      (body["DASHBOARD_PIN"] === undefined || body["DASHBOARD_PIN"] === "") &&
      (body["dashboard_pin"] === undefined || body["dashboard_pin"] === "")
    ) {
      const existing = readConfigLenient();
      body["DASHBOARD_PIN"] = existing?.DASHBOARD_PIN || DEFAULT_DASHBOARD_PIN;
    }
    const validated = validateConfigInput(body);
    if (!validated.ok) {
      res.status(400).json({ success: false, errors: validated.errors });
      return;
    }
    try {
      const root = resolveAppRoot();
      const savedTo = writeConfig(root, validated.config);
      applyConfigToEnv(validated.config, true);
      reloadEnv();
      console.log(`[API] Configuration saved to ${savedTo} — re-initializing services...`);
      const handler = configChangeHandler;
      if (handler) {
        void Promise.resolve()
          .then(() => handler())
          .catch((error) => {
            console.error(
              "[API] Re-init after config save failed:",
              error instanceof Error ? error.message : error,
            );
          });
      }
      res.json({
        success: true,
        message:
          "Configuration saved. Node services re-initializing with new parameters.",
        restartRequired: false,
        // The freshly-read payload, so the GUI can transition on THIS response
        // instead of racing a second fetch. `configured` is what the frontend
        // keys its setup -> dashboard switch off, so it must be computed from
        // disk after the write, not assumed from a 200.
        ...buildConfigPayload(true),
      });
    } catch (error) {
      console.error("[API] Failed to save configuration:", error);
      res.status(500).json({
        success: false,
        errors: [
          {
            path: "(root)",
            message: error instanceof Error ? error.message : String(error),
          },
        ],
      });
    }
  });

  /*
    POST /api/config/regenerate-code — MINT A NEW NODE IDENTITY.

    WHY THIS EXISTS. The node code was documented as permanent with no recovery
    path, so a node that lost its config.json — or one deliberately re-homed onto
    another machine — had exactly one remedy: delete files and reinstall. That is
    a terrible answer to "my code is wrong", and it is the reason this endpoint
    is PIN-gated rather than open: regenerating an identity is a real,
    mesh-visible action, and it belongs to whoever holds the dashboard passkey,
    not to anything that merely reaches the node on the LAN.

    Registered under BOTH prefixes to match the file's existing convention —
    `/api/config` is the short alias `/api/system/config` is served under, and a
    UI that hard-codes the wrong one would fail with a confusing 404.

    BEHAVIOUR:
      - Mints a fresh cryptographically random RIPPA-XXXX-XXXX code.
      - Writes it straight to config.json in the persistent data directory
        (%LOCALAPPDATA%\RippaNode), so it survives restarts and OTA updates.
      - Clears every mesh/satellite association made under the old code and
        resets the live dispatcher, so the node genuinely re-pairs.
      - Returns the new code in the response body so the UI updates immediately
        with no restart.
    NOTHING ELSE IS TOUCHED. Name, API key, passkey, role, Mothership URL, port
    and Ollama URL are all left exactly as they were; a code change must never
    cost the operator their configuration.

    An explicit `nodeCode` in the body adopts that value instead of minting one
    (the manual-entry path), validated by the same normaliser the mesh uses.
  */
  const regenerateCodeHandler = (req: Request, res: Response): void => {
    const body =
      req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>) : {};
    const requested = typeof body["nodeCode"] === "string" ? body["nodeCode"].trim() : "";
    try {
      const identity = requested ? setNodeCode(requested) : regenerateNodeCode();
      // The persisted half is done; now drop the in-memory half so the running
      // process stops advertising the retired identity immediately.
      dispatcher.resetIdentity();
      console.log(`[API] Node code changed to ${identity.code}.`);
      res.json({
        success: true,
        nodeCode: identity.code,
        nodeCodeCreatedAt: identity.createdAt,
        message: requested
          ? `Node code set to ${identity.code}. Satellites must pair with the new code.`
          : `New node code: ${identity.code}. Satellites must pair with the new code.`,
        // Spreads the freshly-read config payload, so the GUI repaints the code
        // and every other setting from this one response.
        ...buildConfigPayload(true),
      });
    } catch (error) {
      // Only `setNodeCode` throws, and only for a malformed manual code. Report
      // it as a 400 with the reason rather than a 500: nothing was written.
      res.status(400).json({
        success: false,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };
  app.post("/api/config/regenerate-code", requireDashboardAuth, regenerateCodeHandler);
  app.post("/api/system/config/regenerate-code", requireDashboardAuth, regenerateCodeHandler);

  // ---- Zero-config mesh API (Master ⇄ Satellite) -----------------------------
  //
  // Split by trust level:
  //  - /api/mesh/pair, /api/mesh/heartbeat and /api/mesh/assign are the
  //    node-to-node channels and authenticate with the mesh key.
  //  - the /api/mesh/* dashboard routes sit behind requireDashboardAuth so the
  //    LAN passkey still protects the Control Center.

  /*
    READS THE MESH KEY FROM EITHER HEADER.

    `X-Mesh-Key` is the historical, dedicated channel and stays first so an
    existing satellite is never affected. `Authorization: Bearer <key>` is
    accepted as an EQUIVALENT because it is the credential every other Rippa
    surface already speaks — the Mothership client, the mobile WebView, the
    desktop dashboard — and a satellite presenting only the standard header was
    being 401'd despite holding a perfectly valid key. That mismatch is exactly
    the reported "401 on mesh poll": the caller authenticated correctly by the
    app's own conventions and this route disagreed.

    An empty string is still a failed authentication; this only widens WHERE a
    valid key may arrive from, never WHO may present one.
  */
  const meshKeyOf = (req: Request): string => {
    const dedicated = String((req.headers["x-mesh-key"] as string | undefined) ?? "").trim();
    if (dedicated) return dedicated;

    const auth = String((req.headers["authorization"] as string | undefined) ?? "").trim();
    const bearer = /^Bearer\s+(.+)$/i.exec(auth);
    return bearer ? bearer[1].trim() : "";
  };

  // POST /api/mesh/pair — the ONE-TIME Satellite → Master handshake.
  app.post("/api/mesh/pair", (req: Request, res: Response) => {
    if (env.NODE_ROLE !== "master") {
      res.status(400).json({ success: false, message: "This node is not a Master." });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const nodeCode = normalizeNodeCode(body["nodeCode"]);
    if (!isValidNodeCode(nodeCode)) {
      res.status(400).json({
        success: false,
        message: "A valid rippa_node_code is required (format RIPPA-XXXX-XXXX).",
      });
      return;
    }
    try {
      const { meshKey, masterEndpoint } = dispatcher.registerSatellite({
        nodeCode,
        nodeName: String(body["nodeName"] ?? nodeCode),
        ipAddress: String(body["ipAddress"] ?? ""),
        port: Number(body["port"] ?? 0),
        cloudLinkUrl: String(body["cloudLinkUrl"] ?? ""),
      });
      res.json({
        success: true,
        message: `Paired. ${env.NODE_NAME} now manages your networking.`,
        // Returned under both keys: `masterCode` is what the Satellite stores as
        // its pairing identity, `nodeCode` is the conventional field name.
        masterCode: dispatcher.nodeCode,
        nodeCode: dispatcher.nodeCode,
        meshKey,
        master: masterEndpoint,
      });
    } catch (error) {
      res.status(400).json({
        success: false,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // POST /api/mesh/heartbeat — Satellite reports in, Master returns its work.
  app.post("/api/mesh/heartbeat", (req: Request, res: Response) => {
    if (env.NODE_ROLE !== "master") {
      res.status(400).json({ success: false, message: "This node is not a Master." });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    /*
      A REFUSED HEARTBEAT CARRIES ITS OWN RECOVERY INSTRUCTIONS.

      The response used to be a bare `401 {success:false}`, which told a
      satellite nothing it could act on. It retried the same dead credential
      every 10 seconds, forever, and the fleet view showed a permanently red node
      whose only remedy was an operator editing config.json by hand. The
      dispatcher now classifies the key and returns a `syncReset` the satellite
      can act on immediately — and, for a node it recognises as holding the
      recently-rotated key, the current key so it rejoins with no operator step
      at all.

      The status stays 401: the request genuinely was not authenticated, and the
      body is advice, not an authorisation. Nothing here is a workaround for
      authentication — `syncReset` is only ever read by the caller on a response
      it was refused by.
    */
    const auth = dispatcher.authenticateOrReset(
      meshKeyOf(req),
      String(body["nodeCode"] ?? ""),
    );
    if (!auth.ok) {
      res.status(401).json({
        success: false,
        message: "Invalid or missing mesh key.",
        syncReset: auth.reset,
      });
      return;
    }
    try {
      const result = dispatcher.handleHeartbeat({
        nodeCode: String(body["nodeCode"] ?? ""),
        nodeName: String(body["nodeName"] ?? ""),
        ipAddress: String(body["ipAddress"] ?? ""),
        port: Number(body["port"] ?? 0),
        cloudLinkUrl: String(body["cloudLinkUrl"] ?? ""),
        metrics: (body["metrics"] ?? undefined) as never,
        p2pEnabled: body["p2pEnabled"] !== false,
        // Role flags ride the heartbeat. Passed straight through rather than
        // reconstructed here: the Master has no way to tell an AI brain from a
        // phone except what the node says about itself.
        capabilities: (body["capabilities"] ?? undefined) as never,
      });
      res.json({ success: true, ...result });
    } catch (error) {
      res.status(400).json({
        success: false,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // POST /api/mesh/assign — Master pushes the auto-provisioning payload to a
  // Satellite: its task plus every sibling's IP, port and Cloud Link URLs.
  app.post("/api/mesh/assign", (req: Request, res: Response) => {
    if (!dispatcher.authenticate(meshKeyOf(req))) {
      res.status(401).json({ success: false, message: "Invalid or missing mesh key." });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const task = (body["task"] ?? null) as Record<string, unknown> | null;
    const siblings = Array.isArray(body["siblings"]) ? (body["siblings"] as PeerEndpoint[]) : [];
    const allowP2p = body["p2pEnabled"] !== false;

    if (task && typeof task["id"] === "string") {
      dispatcher.applyIncomingAssignment({
        id: String(task["id"]),
        label: String(task["label"] ?? "Shared task"),
        load: String(task["load"] ?? "normal") as LoadClass,
        assignees: Array.isArray(task["assignees"]) ? (task["assignees"] as string[]) : [],
        p2p: task["p2p"] !== false,
        createdAt: String(task["createdAt"] ?? new Date().toISOString()),
      });
    }

    // AUTO-FILL: the sibling endpoints land in this node's settings with zero
    // operator input. A revoked node receives an empty list, so peers it
    // previously learned are actively cleared rather than left lingering.
    const stored = dispatcher.applyIncomingSiblings(allowP2p ? siblings : []);
    res.json({
      success: true,
      p2pEnabled: allowP2p,
      peers: stored,
      peersCleared: !allowP2p,
      message: allowP2p
        ? `Auto-provisioned ${stored.length} sibling endpoint(s).`
        : "P2P revoked — report to the Master only.",
    });
  });

  // POST /api/mesh/key-sync — Master pushes a rotated key to a Satellite.
  //
  // AUTHENTICATED WITH THE NEW KEY, not the old one. That is deliberate: the
  // whole point of the push is to get the new key onto nodes, so the request that
  // carries it must be provable as coming from the Master that issued it. A node
  // still on the old key cannot accept this call directly — it reaches the new
  // key through the `syncReset` reply on its next heartbeat instead, which is
  // what keeps this endpoint from being a way to push a key to anything that can
  // reach the port.
  app.post("/api/mesh/key-sync", (req: Request, res: Response) => {
    if (env.NODE_ROLE === "master") {
      res.status(400).json({ success: false, message: "This node is a Master and issues keys." });
      return;
    }
    if (!dispatcher.authenticate(meshKeyOf(req))) {
      // A satellite being pushed a key it has already adopted is idempotent, so
      // a duplicate delivery is harmless — but it still has to be the Master.
      res.status(401).json({ success: false, message: "Invalid or missing mesh key." });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const updated = dispatcher.applyKeySync({
      meshKey: String(body["meshKey"] ?? ""),
      issuedBy: String(body["issuedBy"] ?? ""),
    });
    res.json({
      success: true,
      updated,
      message: updated
        ? "Mesh key updated — this node stays in lockstep with the Master."
        : "Mesh key already current.",
    });
  });

// POST /api/mesh/purge — operator-triggered cleanup of stale fleet entries.
  //
  // Dashboard-authenticated, and master-only: it deletes registry rows. The
  // automatic prunes (revoked nodes, nodes silent for six hours) need no
  // operator involvement, but an operator who has just decommissioned a machine
  // and wants the Swarm Grid to reflect that now should not have to wait for a
  // timer or restart the node.
  app.post("/api/mesh/purge", requireDashboardAuth, (req: Request, res: Response) => {
    if (env.NODE_ROLE !== "master") {
      res.status(400).json({ success: false, message: "Only a Master holds the fleet registry." });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const requested = Array.isArray(body["nodeCodes"])
      ? (body["nodeCodes"] as string[])
      : [];
    const purged = dispatcher.purgeNodes(
      requested.length > 0 ? requested : dispatcher.pruneForgottenNodes(),
      requested.length > 0 ? "removed by the operator" : "no contact for 6 hours",
    );
    res.json({
      success: true,
      purged,
      message:
        purged.length > 0
          ? `Removed ${purged.length} unregistered node(s): ${purged.join(", ")}`
          : "No unregistered nodes to purge.",
    });
  });

// POST /api/mesh/result — Satellite reports a finished task.
  app.post("/api/mesh/result", (req: Request, res: Response) => {
    if (!dispatcher.authenticate(meshKeyOf(req))) {
      res.status(401).json({ success: false, message: "Invalid or missing mesh key." });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    dispatcher.completeTask(
      normalizeNodeCode(body["nodeCode"]),
      String(body["taskId"] ?? ""),
      String(body["outcome"] ?? "success") as TaskOutcome,
    );
    res.json({ success: true });
  });

  // POST /api/mesh/peer-outcome — Satellite reports a sibling exchange result.
  // Feeds the adaptive fallback (a high failure ratio revokes P2P).
  app.post("/api/mesh/peer-outcome", (req: Request, res: Response) => {
    if (!dispatcher.authenticate(meshKeyOf(req))) {
      res.status(401).json({ success: false, message: "Invalid or missing mesh key." });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    dispatcher.reportPeerOutcome(
      normalizeNodeCode(body["nodeCode"]),
      String(body["outcome"] ?? "failure") as TaskOutcome,
    );
    res.json({ success: true });
  });

  // POST /api/mesh/pair-with-master — Satellite-side one-time pairing action.
  app.post("/api/mesh/pair-with-master", requireDashboardAuth, async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const target = String(body["masterUrl"] ?? "").trim();
    if (!target) {
      res.status(400).json({ success: false, message: "masterUrl is required." });
      return;
    }
    try {
      const result = await dispatcher.pairWithMaster(target);
      res.json({
        success: true,
        message: `Paired with Master ${result.masterCode}. Networking is now managed automatically.`,
        masterCode: result.masterCode,
      });
    } catch (error) {
      res.status(400).json({
        success: false,
        message: `Pairing failed — ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  });

  // GET /api/mesh/snapshot — everything the Control Center renders.
  app.get("/api/mesh/snapshot", requireDashboardAuth, (_req: Request, res: Response) => {
    res.json({ success: true, ...dispatcher.getSnapshot() });
  });

  // GET /api/mesh/remote-status — Remote Mode probe for Satellite dashboards.
  //
  // The Satellite UI calls this on boot to decide whether to paint the
  // "Remote Mode — connected to Master <code>" banner and to enable the
  // Remote Command section. Local-only (never proxied): a Satellite answers
  // from its own pairing record; a Master reports remoteMode:false.
  app.get("/api/mesh/remote-status", requireDashboardAuth, (_req: Request, res: Response) => {
    const pairing = getPairing();
    const role = env.NODE_ROLE;
    if (role !== "satellite") {
      res.json({ success: true, remoteMode: false, role });
      return;
    }
    res.json({
      success: true,
      remoteMode: true,
      role,
      masterCode: pairing?.masterCode ?? "",
      masterUrl: pairing?.masterUrl ?? env.MASTER_LOCAL_URL ?? "",
      paired: Boolean(pairing),
      message: pairing
        ? `Remote Mode — connected to Master ${pairing.masterCode}.`
        : "Remote Mode — not paired yet. Set the Master Node URL in Setup.",
    });
  });

  // ── MASTER BRAIN PARITY ──────────────────────────────────────────────────

  /*
    GET /api/brain/status — what the node currently knows.

    Dashboard-authed like every other mutating-adjacent route, and deliberately
    NOT open: the counts and the sync cursor are a map of what this machine knows
    about Australia, which on a node that has been paired to a real Mothership is
    a non-trivial slice of the production catalogue. It is not member data, but it
    is not nothing either, and the LAN is not a trusted place.
  */
  app.get("/api/brain/status", requireDashboardAuth, (_req: Request, res: Response) => {
    try {
      res.json({
        success: true,
        lastSync: getSyncCursor(),
        counts: getBrainCounts(),
        // Whether the trickle loop is armed, so the dashboard can distinguish
        // "synced and up to date" from "never ran" — the two looked identical
        // before, which is the entire Epic 1 failure from an operator's view.
        trickleSync: brainSyncRef
          ? { running: brainSyncRef.isRunning() }
          : { running: false, reason: "not registered (master-only, or setup incomplete)" },
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        message: `Could not read the brain: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  });

  /*
    POST /api/brain/sync-now — force one trickle-sync cycle, on demand.

    THE OPERATIONAL POINT OF EPIC 1. When the sync was broken there was no way to
    ask the node "did you try, and what happened?" — the answer lived only in a
    12-hourly log line nobody was watching, which is exactly how a node stayed
    1,900 facts behind the cloud and reported itself healthy. This route runs one
    cycle synchronously and returns what it did, so an operator can prove the
    loop works without waiting for the timer or reading a terminal.

    Fails soft: an unreachable Mothership is a normal condition here, and is
    reported as `ok: false` with the reason rather than a 500.
  */
  app.post(
    "/api/brain/sync-now",
    requireDashboardAuth,
    async (_req: Request, res: Response) => {
      if (!brainSyncRef) {
        res.status(503).json({
          success: false,
          message: "Brain trickle-sync is not running on this node (master-only, and requires setup).",
        });
        return;
      }
      try {
        res.json({ success: true, ...(await brainSyncRef.syncNow()) });
      } catch (error) {
        res.status(500).json({
          success: false,
          message: `Sync failed: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    },
  );

  /*
    POST /api/brain/upload-backup — load a RIPPA_BRAIN_BUNDLE_V1 file.

    THREE GUARDS, and each is a decision about a different kind of wrong input:

      requireDashboardAuth  the body is the place catalogue. An unauthenticated
                            POST here would let anything on the LAN overwrite this
                            node's knowledge — including with an empty file.
      validateBundle        the file may not be a bundle at all. It arrived by
                            drag-and-drop from a human's Downloads folder, and
                            nothing about that path makes it trustworthy.
      force (optional)      an explicitly older bundle is allowed, but only on
                            request. The default is to refuse a rollback the
                            operator did not ask for.

    SATELLITES GET A CLEAN 400 RATHER THAN A CRASH. `getDeepBrain()` throws on a
    non-master node, and the Deep Brain is master-only by design. A satellite
    receiving this POST should be told so plainly, not handed a stack trace.
  */
  app.post(
    "/api/brain/upload-backup",
    requireDashboardAuth,
    async (req: Request, res: Response) => {
    let deepBrain: unknown;
    try {
      deepBrain = getDeepBrain();
    } catch {
      res.status(400).json({
        success: false,
        message:
          "This node has no local brain (satellites are stateless). Run this on the Master node.",
      });
      return;
    }
    void deepBrain;

    const body = req.body as unknown;
    if (body === undefined || body === null) {
      res.status(400).json({ success: false, message: "No file contents were received." });
      return;
    }

    // `force` is a query flag rather than body content on purpose: the body is the
    // bundle, and letting a flag ride inside the document would mean the thing we
    // are being asked to trust is also the thing that relaxes the check on it.
    const force = String(req.query["force"] ?? "") === "true";

    try {
      const result = await ingestBrainBundle(body, {
        force,
        /*
          PROGRESS IS PUBLISHED, NOT POLLED FOR. The dashboard opens
          /api/system/events once and listens; this callback is the producer. The
          load can take tens of seconds for a real bundle, so a UI that only
          learned the outcome at the end would look frozen for the entire time.
        */
        onProgress: (progress) => {
          publishNodeEvent({
            kind: "brain_sync",
            phase: progress.phase,
            percent: progress.percent,
            title: progress.detail,
            detail:
              progress.total > 0
                ? `${progress.written.toLocaleString()} of ${progress.total.toLocaleString()} rows`
                : undefined,
            blocking: progress.phase !== "done" && progress.phase !== "failed",
          });
        },
      });
      // A REFUSAL IS 400, NOT 500. Nothing is broken — the file was understood and
      // deliberately not applied — and the dashboard renders `message` either way,
      // so the operator reads the same sentence in both cases.
      res.status(result.ok ? 200 : 400).json({
        success: result.ok,
        message: result.message,
        lastSync: result.lastSync,
        counts: result.counts,
        warnings: result.warnings,
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        message: `Upload failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
    },
  );

  // GET /api/mesh/satellite/:code — detail payload for the modal.
  app.get("/api/mesh/satellite/:code", requireDashboardAuth, (req: Request, res: Response) => {
    const detail = dispatcher.getSatellite(String(req.params["code"] ?? ""));
    if (!detail) {
      res.status(404).json({ success: false, message: "Unknown satellite." });
      return;
    }
    res.json({ success: true, satellite: detail });
  });

  /*
    THE COMMAND CENTER ROUTES — the Master's conversational intake workspace.

    All six are PIN-gated and master-only. The PIN gate is the same session
    gate every other dashboard route uses (LAN strangers stay out); the
    master-only guard is about MEANING, not secrecy — a satellite has no Deep
    Brain and no batch folders, so every one of these would throw. The guard
    turns that into a clean 400 naming the Master node.

    TWO BODY SHAPES, not one. The thread endpoints speak JSON (the global
    parser already handles that). The INTAKE endpoint speaks raw multipart
    bytes — captured by the early express.raw middleware above (before the
    remote proxy, so Satellites forward file bytes to the Master intact).
  */
  /** Master-only guard shared by every Command Center route below. */
  const requireMasterBrain = (res: Response): boolean => {
    try {
      getDeepBrain();
      ensureCommandCenterSchema();
      return true;
    } catch {
      res.status(400).json({
        success: false,
        message:
          "This node has no local brain (satellites are stateless). Run the Command Center on the Master node.",
      });
      return false;
    }
  };

  // GET /api/command-center/thread?threadId=… — open a thread + its messages.
  app.get("/api/command-center/thread", requireDashboardAuth, (req: Request, res: Response) => {
    if (!requireMasterBrain(res)) return;
    const threadId = ensureThread(String(req.query["threadId"] ?? ""), "Command Center");
    res.json({ success: true, threadId, messages: listMessages(threadId), batches: listRecentBatches(10) });
  });

  // POST /api/command-center/message — a plain-text user turn (no files).
  app.post("/api/command-center/message", requireDashboardAuth, (req: Request, res: Response) => {
    if (!requireMasterBrain(res)) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const text = String(body["text"] ?? "").trim().slice(0, 4000);
    if (!text) {
      res.status(400).json({ success: false, message: "No message text was received." });
      return;
    }
    const threadId = ensureThread(String(body["threadId"] ?? ""), text.slice(0, 80) || "Command Center");
    appendMessage(threadId, "user", text);
    const reply = postAssistantMessage(
      threadId,
      "Noted — I'll keep that with this thread. Drop photos, a folder, tracks or a ZIP here and I'll stage it as a batch for Master analysis.",
    );
    res.json({ success: true, threadId, reply });
  });

  // POST /api/command-center/intake — multipart prompt + files → PENDING batch.
  app.post("/api/command-center/intake", requireDashboardAuth, async (req: Request, res: Response) => {
    if (!requireMasterBrain(res)) return;
    const contentType = String(req.headers["content-type"] ?? "");
    if (!/^multipart\/form-data/i.test(contentType)) {
      res.status(400).json({ success: false, message: "Expected a multipart/form-data upload." });
      return;
    }
    const rawBody = req.body as unknown;
    if (!Buffer.isBuffer(rawBody) || rawBody.length === 0) {
      res.status(400).json({ success: false, message: "No file contents were received." });
      return;
    }
    try {
      const staged = await stageIntake(contentType, rawBody, String(req.query["threadId"] ?? ""));
      if (!staged.batchId) {
        // NOTHING KEPT is a 422, not a 500: the upload worked, the CONTENT
        // was all system litter or unsupported types. The ignored list says so.
        res.status(422).json({
          success: false,
          threadId: staged.threadId,
          message:
            staged.ignored.length > 0
              ? `Nothing to ingest — ${staged.ignored.length} file(s) were system files or unsupported types. Try JPG/PNG/WEBP photos, GPX/KML tracks, TXT/MD/PDF documents, or a ZIP of those.`
              : "Nothing to ingest — no files were attached.",
          ignored: staged.ignored.map((file) => file.filename),
        });
        return;
      }
      const reply = postAssistantMessage(
        staged.threadId,
        `📦 **Batch staged: ${staged.kept.length} file${staged.kept.length === 1 ? "" : "s"}**` +
          `${staged.zipExpanded ? " (ZIP expanded)" : ""}` +
          `${staged.ignored.length > 0 ? ` — ${staged.ignored.length} skipped (system/unsupported)` : ""}\n` +
          `Status: \`PENDING_MASTER_ANALYSIS\`. I'll post the EXIF/GPS + vision analysis back here when the Master works through the queue.`,
        staged.batchId,
      );
      res.json({
        success: true,
        threadId: staged.threadId,
        batchId: staged.batchId,
        kept: staged.kept,
        ignored: staged.ignored.map((file) => file.filename),
        zipExpanded: staged.zipExpanded,
        reply,
      });
    } catch (error) {
      res.status(400).json({
        success: false,
        message: `Intake failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  });

  // GET /api/command-center/batches — recent batches, newest first.
  app.get("/api/command-center/batches", requireDashboardAuth, (_req: Request, res: Response) => {
    if (!requireMasterBrain(res)) return;
    res.json({ success: true, batches: listRecentBatches(20) });
  });

  // GET /api/command-center/batch/:id — one batch + its staged file list.
  app.get("/api/command-center/batch/:id", requireDashboardAuth, (req: Request, res: Response) => {
    if (!requireMasterBrain(res)) return;
    const batch = getBatch(String(req.params["id"] ?? ""));
    if (!batch) {
      res.status(404).json({ success: false, message: "Unknown batch." });
      return;
    }
    const folder = findBatchFolder(batch.id);
    const files = folder
      ? walkBatchFiles(folder).map((entry) => ({ name: entry.rel, size: entry.size }))
      : [];
    res.json({ success: true, batch, files });
  });

  // DELETE /api/command-center/batch/:id — drop a batch (bytes + row).
  app.delete("/api/command-center/batch/:id", requireDashboardAuth, (req: Request, res: Response) => {
    if (!requireMasterBrain(res)) return;
    const id = String(req.params["id"] ?? "");
    if (!deleteBatch(id)) {
      res.status(404).json({ success: false, message: "Unknown batch." });
      return;
    }
    res.json({ success: true, message: "Batch deleted." });
  });

  // ── AI FALLBACK PROVIDER SETTINGS ───────────────────────────────────────────

  /*
    THE MODAL THAT HAD NO ENDPOINT. "AI Endpoint Settings" was a client-only form
    with nothing behind it, which is why clearing the URL could not be saved: the
    client validated the blank as an error and there was no server-side path that
    would have accepted it anyway.

    These two routes are that path, and they encode the asymmetry that fixes the
    bug — validation is applied ONLY when the fallback is being turned ON. When
    it is being turned OFF, a blank submission is the whole point and is stored
    as NULL (see services/aiEndpointSettings.ts).
  */

  app.get("/api/ai/endpoint", requireDashboardAuth, (_req: Request, res: Response) => {
    res.json({ success: true, settings: getAiEndpointSettings() });
  });

  app.post("/api/ai/endpoint", requireDashboardAuth, (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const enabled = body["ai_enabled"] === true;

    /*
      VALIDATION IS CONDITIONAL, AND THE CONDITION IS THE WHOLE FIX.

      The client already skips validation when the toggle is off, but the server
      cannot trust that: it is the only place that can guarantee a blank
      submission is never rejected, whatever the client does or a future
      revision forgets to do. Enabling still demands a real endpoint and model,
      because a fallback provider with no endpoint is a node that will be routed
      inference and fail every request.
    */
    if (enabled) {
      const problem = validateAiEndpointSettings(body);
      if (problem) {
        res.status(400).json({ success: false, message: problem });
        return;
      }
    }

    /*
      Values arrive as `unknown` from an untyped JSON body, so they are cast at
      the boundary rather than asserted upstream. `saveAiEndpointSettings` takes
      `unknown` for exactly this reason and re-validates each one — a cast here
      would only move the unsoundness, not remove it.
    */
    const saved = saveAiEndpointSettings({
      ai_enabled: enabled,
      ai_endpoint: body["ai_endpoint"] as string | null,
      active_model: body["active_model"] as string | null,
      ai_model: body["ai_model"] as string | null,
    });

    publishNodeEvent({
      kind: "info",
      title: enabled ? "AI Fallback Provider Enabled" : "AI Fallback Provider Disabled",
      detail: enabled
        ? `Serving inference at ${saved.ai_endpoint} using ${saved.active_model}.`
        : "Endpoint and model fields cleared.",
    });

    res.json({
      success: true,
      settings: saved,
      message: enabled
        ? "Fallback provider saved."
        : "Fallback provider disabled. The endpoint and model fields have been cleared.",
    });
  });

  // POST /api/mesh/task — Master assigns a shared task (auto-provisions P2P).
  //
  // SATELLITE REMOTE-CONTROL NOTE: satellites never reach this handler — the
  // remote-proxy middleware above forwards their POST to the paired Master.
  // Heavy work triggered from a Satellite UI ("Build Profile for X") therefore
  // lands here on the MASTER, which takes the compute load.
  app.post("/api/mesh/task", requireDashboardAuth, async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const load = String(body["load"] ?? "normal") as LoadClass;
    if (!["heavy", "normal", "lite"].includes(load)) {
      res.status(400).json({ success: false, message: "load must be heavy, normal or lite." });
      return;
    }
    const assignees = Array.isArray(body["assignees"]) ? (body["assignees"] as string[]) : undefined;
    // Tier marker: Satellite-offloaded work is Tier 0 / high-priority. The
    // label prefix survives into the swarm registry + UI so an operator can
    // see the task was remote-triggered rather than locally created.
    const remoteTier = String(body["tier"] ?? body["priority"] ?? "").trim();
    const requestedLabel = String(body["label"] ?? "Shared swarm task");
    const label =
      isRemoteProxyRequest(req as unknown as { headers?: Record<string, unknown> }) &&
      !/^\[(tier 0|remote)\]/i.test(requestedLabel)
        ? `[Tier 0/Remote] ${requestedLabel}`
        : requestedLabel;
    void remoteTier;
    try {
      const task = await dispatcher.assignSharedTask({
        label,
        load,
        ...(assignees ? { assignees } : {}),
      });
      res.json({ success: true, task, remoteOffload: true });
    } catch (error) {
      res.status(400).json({
        success: false,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // POST /api/mesh/offload — explicit heavy-task offload endpoint.
  //
  // This is the Tier 0 path the Satellite "Remote Command" UI calls when the
  // operator triggers heavy processing ("Build Profile for X", manual scrape).
  // On a Satellite the remote-proxy middleware forwards it to the Master;
  // on the Master it lands here and is dispatched as a high-priority (heavy)
  // shared swarm task, so the Master takes the compute load while the
  // Satellite acts purely as the controller.
  //
  // Every dispatch is ALSO recorded in the persistent remote_tasks ledger so
  // the Task Tray can track it concurrently with the swarm assignment.
  app.post("/api/mesh/offload", requireDashboardAuth, async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const labelRaw = String(body["label"] ?? body["placeName"] ?? body["target"] ?? "").trim();
    if (!labelRaw) {
      res.status(400).json({ success: false, message: "label (or placeName/target) is required." });
      return;
    }
    const load = String(body["load"] ?? "heavy") as LoadClass;
    if (!["heavy", "normal", "lite"].includes(load)) {
      res.status(400).json({ success: false, message: "load must be heavy, normal or lite." });
      return;
    }
    const offloadAssignees = Array.isArray(body["assignees"]) ? (body["assignees"] as string[]) : undefined;
    const offloadLabel = /^\[(tier 0|remote)\]/i.test(labelRaw) ? labelRaw : `[Tier 0/Remote] ${labelRaw}`;
    let trayTask: ReturnType<typeof createRemoteTask> | null = null;
    try {
      const looksUrl = /^https?:\/\//i.test(labelRaw) || /^https?:\/\//i.test(String(body["url"] ?? ""));
      trayTask = createRemoteTask({ target: labelRaw, kind: looksUrl ? "url" : "place", tier: 0, load });
    } catch {
      trayTask = null;
    }
    try {
      const task = await dispatcher.assignSharedTask({
        label: offloadLabel,
        load,
        ...(offloadAssignees ? { assignees: offloadAssignees } : {}),
      });
      if (trayTask) {
        updateRemoteTask(trayTask.id, { swarmTaskId: task.id, status: task.assignees.length > 0 ? "processing" : "queued" });
        trayTask = getRemoteTask(trayTask.id) ?? trayTask;
      }
      res.json({
        success: true,
        task,
        remoteTask: trayTask,
        tier: 0,
        offloaded: true,
        message: `Offloaded "${labelRaw}" to the Master as a Tier 0 (${load}) swarm task.`,
      });
    } catch (error) {
      if (trayTask) failRemoteTask(trayTask.id, error instanceof Error ? error.message : String(error));
      res.status(400).json({
        success: false,
        remoteTask: trayTask ? getRemoteTask(trayTask.id) : null,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // POST /api/mesh/satellite/:code/restore-p2p — undo an adaptive revocation.
  app.post("/api/mesh/satellite/:code/restore-p2p", requireDashboardAuth, (req: Request, res: Response) => {
    dispatcher.restoreP2p(String(req.params["code"] ?? ""));
    res.json({ success: true });
  });

  // --- REMOTE COMMAND TASK TRAY (Master Control Center) ---------------------
  //
  // The Task Tray polls GET /api/mesh/remote-tasks for every dispatched task
  // with its live lifecycle status + structured summary. Each row merges the
  // persistent remote_tasks ledger (queued/processing/completed/failed +
  // summary) with the live swarm assignment status when one is linked, so a
  // task dispatched with zero satellites online still shows honestly.
  app.get("/api/mesh/remote-tasks", requireDashboardAuth, (req: Request, res: Response) => {
    if (!requireMasterBrain(res)) return;
    try {
      ensureRemoteTaskSchema();
    } catch { /* ledger degrades to in-memory; still answer */ }
    const limit = Math.max(1, Math.min(50, Number(req.query["limit"] ?? 25) || 25));
    const tasks = listRemoteTasks(limit).map((entry) => {
      let liveStatus: string | null = null;
      let liveSummary: { places_found: string[]; places_created: number; notes: string } | null = null;
      if (entry.swarmTaskId) {
        try {
          liveStatus = dispatcher.getAssignmentStatus(entry.swarmTaskId);
          const recent = dispatcher.getRecentTasks(50).find((t) => t.id === entry.swarmTaskId);
          if (recent?.summary) liveSummary = recent.summary;
        } catch { /* snapshot is best-effort */ }
      }
      let status = entry.status;
      if ((status === "queued" || status === "processing") && (liveStatus === "processing" || liveStatus === "queued")) {
        status = liveStatus;
        if (status !== entry.status) {
          try { updateRemoteTask(entry.id, { status }); } catch { /* best effort */ }
        }
      }
      if ((status === "queued" || status === "processing") && liveStatus === "completed") {
        try { completeRemoteTask(entry.id, liveSummary ?? { notes: "Swarm task finished." }); } catch { /* best effort */ }
        return getRemoteTask(entry.id) ?? { ...entry, status: "completed" as const };
      }
      if ((status === "queued" || status === "processing") && liveStatus === "failed") {
        try { failRemoteTask(entry.id, liveSummary?.notes || "Swarm task failed."); } catch { /* best effort */ }
        return getRemoteTask(entry.id) ?? { ...entry, status: "failed" as const };
      }
      return status === entry.status ? entry : { ...entry, status };
    });
    res.json({ success: true, tasks });
  });

  // POST /api/mesh/remote-tasks/:id/complete — Master Node completion sync.
  // Writes the structured { places_found, places_created, notes } summary the
  // Task Tray renders in the expandable drawer. Local equivalent of the
  // epic's "update swarm_tasks in D1 upon completion" step.
  app.post("/api/mesh/remote-tasks/:id/complete", requireDashboardAuth, (req: Request, res: Response) => {
    if (!requireMasterBrain(res)) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const summary = (body["summary"] ?? body) as Record<string, unknown>;
    const placesFound = Array.isArray(summary["places_found"])
      ? (summary["places_found"] as unknown[]).map(String).slice(0, 100)
      : [];
    const placesCreated = Number(summary["places_created"] ?? 0) || 0;
    const notes = String(summary["notes"] ?? "").slice(0, 4000);
    const done = completeRemoteTask(String(req.params["id"] ?? ""), { places_found: placesFound, places_created: placesCreated, notes });
    if (!done) {
      res.status(404).json({ success: false, message: "Remote task not found." });
      return;
    }
    publishNodeEvent({ kind: "command_center", command: "REMOTE_TASK_COMPLETED", title: "Remote task completed", detail: done.target });
    res.json({ success: true, task: done });
  });

  // POST /api/storage/upload — direct file staging for Swarm scraping.
  //
  // The epic names R2 (`command-center/` / `swarm-ingest/` prefixes); this repo
  // stages to the SAME prefixed folder under the persistent data dir instead.
  // Accepts multipart (paperclip/dropzone) AND raw bodies. On success the file
  // is dispatched as a Tier 0 swarm task AND recorded in the Task Tray ledger.
  app.post("/api/storage/upload", requireDashboardAuth, async (req: Request, res: Response) => {
    if (!requireMasterBrain(res)) return;
    const allowedExts = new Set([".pdf", ".docx", ".doc", ".gpx", ".kml", ".txt", ".md", ".csv"]);
    try {
      const contentType = String(req.headers["content-type"] ?? "");
      let filename = String(req.query["filename"] ?? req.headers["x-filename"] ?? "");
      let bytes: Buffer | null = null;
      if (/multipart\/form-data/i.test(contentType) && Buffer.isBuffer(req.body)) {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-upload-"));
        try {
          // Static import at the top (pkg snapshot cannot resolve dynamic imports).
          const parsed = parseMultipart(req.body, contentType, tmpDir);
          const first = parsed.files[0];
          if (!first) {
            res.status(400).json({ success: false, message: "No file part found in the upload." });
            return;
          }
          filename = first.filename;
          bytes = fs.readFileSync(first.filePath);
        } finally {
          try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
        }
      } else if (Buffer.isBuffer(req.body)) {
        bytes = req.body;
      }
      if (!bytes) {
        res.status(400).json({ success: false, message: "No file bytes received." });
        return;
      }
      const safe = sanitizeFilename(filename || "upload");
      const ext = safe.includes(".") ? safe.slice(safe.lastIndexOf(".")).toLowerCase() : "";
      if (!allowedExts.has(ext)) {
        res.status(400).json({ success: false, message: `Unsupported file type — accepted: .pdf, .docx, .doc, .gpx, .kml, .txt, .md, .csv.` });
        return;
      }
      if (bytes.length === 0 || bytes.length > 64 * 1024 * 1024) {
        res.status(400).json({ success: false, message: "File must be non-empty and under 64 MB." });
        return;
      }
      const ingestDir = dataFilePath("swarm-ingest");
      fs.mkdirSync(ingestDir, { recursive: true });
      let target = path.join(ingestDir, safe);
      if (fs.existsSync(target)) {
        const stem = safe.slice(0, safe.length - ext.length) || "upload";
        let n = 2;
        do {
          target = path.join(ingestDir, `${stem} (${n})${ext}`);
          n += 1;
        } while (fs.existsSync(target) && n < 10_000);
      }
      fs.writeFileSync(target, bytes);
      const stagedName = path.basename(target);
      const relKey = `swarm-ingest/${stagedName}`;
      const trayTask = createRemoteTask({ target: stagedName, kind: "file", tier: 0, load: "heavy", fileName: stagedName, stagedPath: target });
      try {
        const task = await dispatcher.assignSharedTask({ label: `[Tier 0/Remote] Swarm file: ${stagedName} (${relKey})`, load: "heavy" });
        updateRemoteTask(trayTask.id, { swarmTaskId: task.id, status: task.assignees.length > 0 ? "processing" : "queued" });
      } catch (error) {
        failRemoteTask(trayTask.id, error instanceof Error ? error.message : String(error));
      }
      const done = getRemoteTask(trayTask.id) ?? trayTask;
      publishNodeEvent({ kind: "command_center", command: "REMOTE_TASK_QUEUED", title: "Swarm file staged", detail: stagedName });
      res.json({ success: true, key: relKey, fileName: stagedName, stagedPath: target, task: done, remoteTask: done });
    } catch (error) {
      res.status(400).json({ success: false, message: error instanceof Error ? error.message : String(error) });
    }
  });

  // GET /api/mesh/identity — this node's permanent code (shown in the UI).
  app.get("/api/mesh/identity", requireDashboardAuth, (_req: Request, res: Response) => {
    const identity = ensureNodeIdentity();
    res.json({
      success: true,
      nodeCode: identity.code,
      createdAt: identity.createdAt,
      nodeName: env.NODE_NAME,
      role: env.NODE_ROLE,
      pairing: getPairing(),
    });
  });

  // POST /api/mesh/update-trigger — the Master tells this Satellite to update.
  //
  // This is the most security-sensitive mesh route: it ends with the node
  // replacing its own binary. It is therefore guarded by the mesh key AND by
  // strict payload validation (command, semver, http(s) URL only), so neither a
  // spoofed body nor a compromised peer can make a node swap its executable.
  app.post("/api/mesh/update-trigger", async (req: Request, res: Response) => {
    if (!dispatcher.authenticate(meshKeyOf(req))) {
      res.status(401).json({ success: false, message: "Invalid or missing mesh key." });
      return;
    }
    const trigger = parseUpdateTrigger(req.body);
    if (!trigger) {
      res.status(400).json({
        success: false,
        message: "Malformed SWARM_UPDATE_TRIGGER payload — ignoring.",
      });
      return;
    }

    const outcome = await handleUpdateTrigger(swarmUpdater, trigger);
    res.status(outcome.accepted ? 202 : 409).json({
      success: outcome.accepted,
      version: trigger.version,
      message: outcome.message,
    });
  });
   // POST /api/mesh/process-chunk — Satellite processes a chunk from a Dispatcher.
   app.post("/api/mesh/process-chunk", async (req: Request, res: Response) => {
     if (!dispatcher.authenticate(meshKeyOf(req))) {
       res.status(401).json({ success: false, message: "Invalid or missing mesh key." });
       return;
     }
     // TODO: Implement chunk processing (calls local Ollama, returns ChunkResult).
     res.status(202).json({
       success: true,
       message: "Chunk processing queued. Implementation pending.",
     });
   });

   // POST /api/mesh/consensus-check — Satellite runs consensus verification.
   app.post("/api/mesh/consensus-check", async (req: Request, res: Response) => {
     if (!dispatcher.authenticate(meshKeyOf(req))) {
       res.status(401).json({ success: false, message: "Invalid or missing mesh key." });
       return;
     }
     // TODO: Implement consensus checking (calls local Ollama on same source data).
     res.status(202).json({
       success: true,
       message: "Consensus check queued. Implementation pending.",
     });
   });



  /*
    OLLAMA CONTROL PANEL API.

    Locked by default — the node and Rippa AI retain 100% autonomic control
    over the server and model selection. Unlocking the padlock (dashboard-PIN
    gated, same as every other mutating route here) permits a manual override:
    switching model, changing the port, or restarting the server by hand.
  */
  app.get("/api/ollama/status", requireDashboardAuth, (_req: Request, res: Response) => {
    const activeTask = require("./services/heartbeat").getCurrentProcess() as
      | { task: string }
      | null;
    let watchdog: Record<string, unknown> | null = null;
    try {
      const { getZeroTouchPlan, findHostOllamaBinary } =
        require("./services/ollamaWatchdog") as typeof import("./services/ollamaWatchdog");
      const plan = getZeroTouchPlan();
      watchdog = {
        hostBinary: plan?.hostBinary ?? findHostOllamaBinary(),
        usingBundledRuntime: plan?.usingBundledRuntime ?? true,
        port: plan?.port ?? ollamaManager.getPort(),
        model: plan?.model ?? ollamaManager.getModel(),
      };
    } catch {
      watchdog = null;
    }
    res.json({
      success: true,
      ...ollamaManager.getStatus(activeTask?.task ?? null),
      watchdog,
    });
  });

  app.post("/api/ollama/unlock", requireDashboardAuth, (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const unlocked = body["unlocked"] !== false; // default: unlock
    ollamaManager.setUnlocked(Boolean(unlocked));
    res.json({
      success: true,
      unlocked: ollamaManager.isUnlocked(),
      message: ollamaManager.isUnlocked()
        ? "Unlocked — manual overrides are now permitted."
        : "Locked — the node and Rippa AI have full autonomic control again.",
    });
  });

  app.post("/api/ollama/managed", requireDashboardAuth, (req: Request, res: Response) => {
    if (!ollamaManager.isUnlocked()) {
      res.status(403).json({ success: false, message: "Unlock the padlock before changing this." });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const managed = Boolean(body["managed"]);
    ollamaManager.setManaged(managed);

    /*
      PERSIST IT. This used to mutate `ollamaManager`'s private field and stop
      there, which made the Control Panel's switch a lie: the node came back from
      the next restart — and the Watchdog restarts it after every OTA swap —
      unmanaged, on the 11434 default, logging "No usable local model found". The
      operator had no way to tell a setting that never saved from one that did.

      The write goes through the SAME `writeConfig` + `applyConfigToEnv` +
      `reloadEnv` sequence as the main settings save, and `normalizeConfig`
      carries `OLLAMA_MANAGED` through, so an unrelated GUI save cannot delete it
      either.
    */
    const root = resolveAppRoot();
    try {
      const current = readConfigLenient(root) ?? readConfig(root);
      const saved = writeConfig(root, {
        ...(current ?? {}),
        OLLAMA_MANAGED: managed,
      } as RippaNodeConfig);
      applyConfigToEnv(readConfigLenient() ?? {}, true);
      reloadEnv();
      console.log(`[API] Ollama supervision set to managed=${managed} (saved to ${saved}).`);
    } catch (error) {
      /*
        A failed write must NOT be reported as success, and must NOT take the
        running engine down: `setManaged` has already applied the change in memory
        and the operator gets a truthful warning that it will not survive a
        reboot. Silently swallowing this is how the original bug survived so long.
      */
      console.warn(
        `[API] Ollama supervision changed for this session but could NOT be saved: ${
          error instanceof Error ? error.message : String(error)
        }. It will be lost on the next restart.`,
      );
      res.status(200).json({
        success: false,
        managed: ollamaManager.isManaged(),
        persisted: false,
        message:
          "Applied for this session only — the setting could not be written to disk, " +
          "so it will be lost when the node restarts.",
      });
      return;
    }

    res.json({ success: true, managed: ollamaManager.isManaged(), persisted: true });
  });

  app.post("/api/ollama/override", requireDashboardAuth, (req: Request, res: Response) => {
    if (!ollamaManager.isUnlocked()) {
      res.status(403).json({
        success: false,
        message: "Unlock the padlock before overriding the model or port.",
      });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const model = typeof body["model"] === "string" ? body["model"].trim() : "";
    const port = Number(body["port"]);
    if (model) ollamaManager.setModel(model);
    if (Number.isFinite(port) && port > 0 && port <= 65535) {
      const current = readConfigLenient() ?? normalizeConfig({});
      const validated = validateConfigInput({
        ...current,
        OLLAMA_URL: `http://127.0.0.1:${port}`,
      });
      if (validated.ok) {
        writeConfig(resolveAppRoot(), validated.config);
        applyConfigToEnv(validated.config, true);
        reloadEnv();
      }
    }
    res.json({
      success: true,
      model: ollamaManager.getModel(),
      message: "Override applied. Restart the server for a port change to take effect.",
    });
  });

  app.post("/api/ollama/restart", requireDashboardAuth, async (_req: Request, res: Response) => {
    try {
      await ollamaManager.restart();
      res.json({ success: true, message: "Ollama server restart requested." });
    } catch (error) {
      res.status(500).json({
        success: false,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  /*
    SELF-HEAL ROUTES — one per sub-feature panel. Each runs a programmatic
    repair routine (kill stuck processes, clear caches, restart local
    servers) and reports whether the feature is back to 100% functionality.
  */
  /*
    THE OLLAMA ONE RETURNS 202 AND DOES NOT WAIT — this is the fix for the
    reported "repair throws a timeout error".

    It used to `await ollamaManager.selfHeal()`. That call awaits `start()`,
    which can download the ~1.4 GB bundled runtime and then kick off a ~4.6 GB
    model pull, so the HTTP request stayed open for minutes while the repair was
    in fact succeeding. The browser gave up first and the operator saw a timeout
    for work that was genuinely in progress.

    `startRepair()` returns immediately and the work runs in the background;
    `repairing`/`repairMessage` on GET /api/ollama/status carry the outcome, and
    the dashboard polls that. 409 means a repair is already running (a
    double-click), which is a conflict rather than an acceptance.
  */
  app.post("/api/ollama/self-heal", requireDashboardAuth, (_req: Request, res: Response) => {
    const outcome = ollamaManager.startRepair();
    res.status(outcome.accepted ? 202 : 409).json({
      success: outcome.accepted,
      message: outcome.message,
      repairing: outcome.accepted,
    });
  });

  /*
    RETRY FOR THE EMBEDDING MODEL TILE — the action behind "failed (click to
    retry)".

    NO PADLOCK, DELIBERATELY. The pull is the same autonomic operation the node
    already performs on its own at boot; the tile only offers a retry AFTER that
    operation failed, so gating it behind the unlock would make the button
    decorative on a node in full autonomic control (the same reasoning as the
    generation-model route below).

    The response returns immediately either way: an already-installed model is
    reconciled against `/api/tags` synchronously (fast), while a real pull runs
    in the background, streaming progress into the Live Engine Terminal — the
    panel's own 5s poll then picks up the pulling → ready/failed transition.
  */
  app.post("/api/ollama/embedding-pull", requireDashboardAuth, async (_req: Request, res: Response) => {
    if (await ollamaManager.reconcileEmbedding()) {
      res.json({ success: true, message: "The embedding model is already installed — ready." });
      return;
    }
    void ollamaManager.pullEmbeddingModel();
    res.json({
      success: true,
      message: "Pulling the embedding model — progress streams into the Live Engine Terminal.",
    });
  });

  /*
    RETRY FOR THE GENERATION MODEL TILE — the same action for the ~4.6 GB pull.

    This is the route an operator reaches after the reported failure, so it has to
    carry the two guarantees the old synchronous path could not:

      1. IT RETURNS `202 Accepted` IMMEDIATELY. Only the "already installed?" check
         is awaited, and that is a single fast `/api/tags` round-trip. The pull
         itself is fire-and-forget, so a repair click can never turn into a browser
         timeout on a multi-gigabyte download.
      2. IT IS NOT PADLOCKED. Same reasoning as the embedding route: this is the
         autonomic operation the node already performs at boot, offered again after
         it failed. Gating it would make the button decorative on a node in full
         autonomic control.

    The Model tile and its progress read from `modelStatus` / `modelPullPercent` on
    GET /api/ollama/status, so the operator watches the transfer instead of a
    spinner.
  */
  app.post("/api/ollama/model-pull", requireDashboardAuth, async (_req: Request, res: Response) => {
    if (await ollamaManager.reconcileGeneration()) {
      res.status(200).json({
        success: true,
        message: "The model is already installed — ready.",
        alreadyInstalled: true,
      });
      return;
    }
    void ollamaManager.pullGenerationModel();
    res.status(202).json({
      success: true,
      message: "Downloading Model… — progress streams into the Live Engine Terminal.",
    });
  });

  app.post("/api/scraper/self-heal", requireDashboardAuth, async (_req: Request, res: Response) => {
    if (!orchestratorRef) {
      res.status(409).json({
        success: false,
        message: "Scraper is not running yet — the node is still starting up.",
      });
      return;
    }
    try {
      const result = await orchestratorRef.getScraper().selfHeal();
      res.status(result.healed ? 200 : 500).json({ success: result.healed, message: result.message });
    } catch (error) {
      res.status(500).json({
        success: false,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  /*
    GET /api/engine/stream — live terminal, health badge and scraper viewport.

    A SECOND SSE STREAM rather than more kinds on /api/system/events, deliberately.
    That endpoint retains the latest event per KIND, which is exactly right for an
    overlay ("the restart you missed") and exactly wrong for a terminal: scrollback
    where only the last line survives is not a terminal. Splitting them keeps the
    overlay channel's replay semantics clean and keeps log spam out of it.

    THE BACKLOG FRAME IS SENT FIRST. A dashboard that opens mid-session (the normal
    case) must paint the last 300 log lines, the recent crawl events and the current
    Chromium frame immediately, rather than sitting blank until the next thing
    happens. `hasSubscribers()` — which gates screenshot capture — therefore becomes
    true the moment this endpoint connects, which is the correct and intended signal.
  */
  app.get("/api/engine/stream", requireDashboardAuth, (req: Request, res: Response) => {
    res.status(200).set({
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders?.();

    const write = (frame: unknown): void => {
      res.write(`data: ${JSON.stringify(frame)}\n\n`);
    };
    write(backlog());

    const unsubscribe = subscribeTelemetry(write);

    // Same keep-alive reasoning as the other stream: a terminal is idle most of the
    // time, and an intermediary that reaps idle connections would kill it during
    // exactly the quiet period it is meant to be showing.
    const heartbeat = setInterval(() => res.write(": keep-alive\n\n"), 20_000);

    const cleanup = (): void => {
      clearInterval(heartbeat);
      unsubscribe();
    };
    req.on("close", cleanup);
    req.on("error", cleanup);
    res.on("error", cleanup);
  });

  /*
    GET /api/engine/health — the 5-second readiness probe behind the status dot.

    Polled rather than pushed on purpose: the badge must be able to say OFFLINE, and
    a pushed stream cannot report the absence of its own events. A 5s interval is the
    spec's cadence and is also gentle — this is a loopback HTTP GET against a local
    server that already serves every inference request.
  */
  app.get("/api/engine/health", requireDashboardAuth, async (_req: Request, res: Response) => {
    const reading = await ollamaManager.probeHealth();
    publishHealth(reading);
    res.json({ success: true, ...reading });
  });

  /*
    POST /api/engine/exec — runs one line from the terminal's `$` prompt.

    THE ROUTE IS DELIBERATELY THIN. All of the parsing, validation and the padlock
    live in `engineCli.ts` so the allow-list is unit-testable without an HTTP server,
    and so this handler cannot accidentally grow its own parsing. It reads `command`
    as a string and hands it over; there is no code path here that interprets it.

    Dashboard-authenticated like every mutating route, and the padlock check happens
    inside the CLI for `ollama pull` / `ollama restart` (see the note there).
  */
  app.post("/api/engine/exec", requireDashboardAuth, async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const command = typeof body["command"] === "string" ? String(body["command"]) : "";
    if (!command.trim()) {
      res.status(400).json({ success: false, message: "No command supplied." });
      return;
    }
    // A 200 even for a refused command: the refusal is reported IN the terminal,
    // which is the surface the operator is using. The HTTP status only distinguishes
    // "the node could not run your command" from "your command failed".
    const result = await runEngineCommand(command, {
      origin: `http://127.0.0.1:${ollamaManager.getPort()}`,
      isUnlocked: () => ollamaManager.isUnlocked(),
      restart: () => ollamaManager.restart(),
      pull: (model: string) => ollamaManager.pullModelStreaming(model),
    });
    res.json({ success: result.ok, message: result.message });
  });

  // GET /api/scraper/status — status panel for the Playwright Scraper feature.
  app.get("/api/scraper/status", requireDashboardAuth, (_req: Request, res: Response) => {
    const browserBacked = orchestratorRef ? orchestratorRef.getScraper().isBrowserBacked() : false;
    res.json({
      success: true,
      state: orchestratorRef ? (browserBacked ? "active" : "idle") : "stopped",
      browserBacked,
      runtime: describeRuntime(),
    });
  });

  // POST /api/mesh/self-heal — the Mesh Network panel's repair routine.
  app.post("/api/mesh/self-heal", requireDashboardAuth, async (_req: Request, res: Response) => {
    try {
      const purged = dispatcher.pruneForgottenNodes();
      await dispatcher.ensurePairedWithMaster();
      res.json({
        success: true,
        message:
          purged.length > 0
            ? `Mesh self-heal complete — cleared ${purged.length} stale node(s) and re-paired.`
            : "Mesh self-heal complete — re-verified pairing.",
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  /*
    NATIVE OPENAI API PROXY ROUTES.

    Lets the Mothership (or any OpenAI-SDK client) talk to this node's local
    Ollama instance with zero knowledge of Ollama's own API shape. Every
    outbound request has `keep_alive` injected so VRAM is released promptly —
    this node also runs Playwright scrapers and cannot hog the GPU.
  */
  app.post("/v1/chat/completions", async (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const model = typeof body["model"] === "string" && body["model"] ? body["model"] : ollamaManager.getModel();
      const messages = Array.isArray(body["messages"]) ? body["messages"] : [];
      const stream = Boolean(body["stream"]);
      const base = (env.OLLAMA_URL ?? "http://127.0.0.1:11434").replace(/\/+$/, "");
      const upstream = await axios.post(
        `${base}/api/chat`,
        {
          model,
          messages,
          stream: false,
          keep_alive: "60s",
          options: {
            temperature: typeof body["temperature"] === "number" ? body["temperature"] : undefined,
          },
        },
        { timeout: 180_000, proxy: false },
      );
      const content = String(upstream.data?.message?.content ?? "");
      const created = Math.floor(Date.now() / 1000);
      res.json({
        id: `chatcmpl-${created}`,
        object: stream ? "chat.completion.chunk" : "chat.completion",
        created,
        model,
        choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      });
    } catch (error) {
      res.status(502).json({
        success: false,
        message: `Upstream Ollama error — ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  });

  app.post("/v1/embeddings", async (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const model =
        typeof body["model"] === "string" && body["model"]
          ? body["model"]
          : (require("./agent/OllamaClient") as typeof import("./agent/OllamaClient")).EMBEDDING_MODEL;
      const rawInput = body["input"];
      const inputs = Array.isArray(rawInput) ? rawInput.map(String) : [String(rawInput ?? "")];
      const base = (env.OLLAMA_URL ?? "http://127.0.0.1:11434").replace(/\/+$/, "");
      const data = await Promise.all(
        inputs.map(async (text, index) => {
          const upstream = await axios.post(
            `${base}/api/embeddings`,
            { model, prompt: text, keep_alive: "60s" },
            { timeout: 60_000, proxy: false },
          );
          return { object: "embedding", index, embedding: upstream.data?.embedding ?? [] };
        }),
      );
      res.json({ object: "list", data, model, usage: { prompt_tokens: 0, total_tokens: 0 } });
    } catch (error) {
      res.status(502).json({
        success: false,
        message: `Upstream Ollama error — ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  });

// POST /api/node/restart — the operator-facing restart, and the exit-code handoff.
  //
  // WHY THIS ENDS IN AN EXIT CODE AND NOT A SCRIPT. This node cannot relaunch
  // itself: Windows keeps a running .exe mapped, and even if it could, a process
  // that spawns a replacement has nothing left to notice the replacement dying.
  // The old implementation therefore treated "restart" as "shut down and hope",
  // which is exactly why a remote restart acted like a remote shutdown. The
  // restart is now performed by `rippa-watchdog.exe`, which is told what to do
  // by the code this handler exits with.
  //
  // The response is written BEFORE the exit is scheduled, so the operator's
  // browser gets a definite answer rather than a dropped connection — and the
  // delay gives the SSE stream a moment to deliver the "Restarting…" overlay, so
  // the dashboard explains itself instead of just going blank.
  app.post("/api/node/restart", requireDashboardAuth, (_req: Request, res: Response) => {
    if (!lifecycle) {
      res.status(503).json({
        success: false,
        message: "The node's lifecycle handlers are not registered yet — try again in a moment.",
      });
      return;
    }

    const supervised = isUnderWatchdog();
    publishNodeEvent({
      kind: "admin_command",
      command: "RESTART_NODE",
      title: "Restarting Node…",
      detail: supervised
        ? `The Rippa Watchdog will relaunch this node immediately (exit ${EXIT_RESTART}).`
        : "No watchdog is supervising this node, so it will not come back automatically.",
      blocking: true,
    });

    res.json({
      success: true,
      action: "restart",
      exitCode: EXIT_RESTART,
      supervised,
      message: supervised
        ? `Restarting — the watchdog will relaunch rippa-node.exe (exit ${EXIT_RESTART}).`
        : `Restarting — but no watchdog is running, so this node will stay down (exit ${EXIT_RESTART}). Run "rippa-watchdog.exe --install" and start it to supervise.`,
    });

    setTimeout(() => void lifecycle?.restart(), 250);
  });

  // POST /api/node/shutdown — the operator-facing shutdown.
  //
  // Exit 0 is the code that tells the watchdog "this was deliberate, do not
  // restart it". That is the whole distinction between this route and the one
  // above, and it is why a genuine shutdown leaves the machine dark on purpose
  // instead of the watchdog fighting the operator's decision on every poll.
  app.post("/api/node/shutdown", requireDashboardAuth, (_req: Request, res: Response) => {
    if (!lifecycle) {
      res.status(503).json({
        success: false,
        message: "The node's lifecycle handlers are not registered yet — try again in a moment.",
      });
      return;
    }

    const supervised = isUnderWatchdog();
    publishNodeEvent({
      kind: "admin_command",
      command: "SHUTDOWN_NODE",
      title: "Shutting Down…",
      detail: "The operator asked this node to stop. The watchdog will not restart it.",
      blocking: true,
    });

    res.json({
      success: true,
      action: "shutdown",
      exitCode: EXIT_SHUTDOWN,
      supervised,
      message: supervised
        ? `Shutting down — the watchdog will exit and leave the node down (exit ${EXIT_SHUTDOWN}).`
        : "Shutting down.",
    });

    setTimeout(() => void lifecycle?.shutdown(), 250);
  });

// GET /api/mesh/updater — OTA status for the dashboard.
  app.get("/api/mesh/updater", requireDashboardAuth, (_req: Request, res: Response) => {
    const latest = swarmUpdater.getLatest();
    res.json({
      success: true,
      currentVersion: APP_VERSION,
      latest,
      updateAvailable: latest ? isVersionNewer(latest.version) : false,
      selfReplaceable: isPackagedExe(),
      /*
        PUBLISHED ASSET CONTRACT. The download URL is a literal filename lookup on
        GitHub, so the exact asset name is part of the updater's public contract —
        not an implementation detail. Surfacing it lets an operator confirm, from
        the dashboard, that the release their node will fetch is the one the URL
        in the Mothership payload actually names.
      */
      releaseAsset: RELEASE_ASSET_NAME,
      releaseDownloadUrl: releaseDownloadUrl(),
      // Whether a watchdog will bring this node back after a restart, a crash or
      // an update. Without it, "restart" and "shutdown" look identical.
      watchdog: {
        supervised: isUnderWatchdog(),
        // Exit codes this process will use to talk to the watchdog, spelled out so
        // an operator reading the log can match it against the watchdog's own.
        exitCodes: { shutdown: EXIT_SHUTDOWN, restart: EXIT_RESTART, update: EXIT_APPLY_UPDATE },
      },
      onlineSatellites: dispatcher.listOnlineSatellites().length,
    });
  });

  // POST /api/mesh/broadcast-update — Master pushes the known release now.
  app.post("/api/mesh/broadcast-update", requireDashboardAuth, async (_req: Request, res: Response) => {
    const latest = swarmUpdater.getLatest();
    if (!latest) {
      res.status(409).json({
        success: false,
        message: "No release has been detected yet — waiting for the first GitHub check.",
      });
      return;
    }
    const delivered = await swarmUpdater.broadcast(latest);
    res.json({ success: true, delivered, version: latest.version });
  });

// Local Web GUI — static Settings UI from public/.
  const publicDir = resolvePublicDir();
  if (publicDir) {
    app.use(express.static(publicDir));
    app.get("/", (_req: Request, res: Response) => {
      res.sendFile(path.join(publicDir, "index.html"));
    });
    // The Master Control Center is a dedicated view; the setup/lock screens in
    // index.html stay exactly as they were. A missing file falls through to the
    // Setup screen rather than a hard 404.
    app.get("/dashboard", (_req: Request, res: Response) => {
      const dashboardFile = path.join(publicDir, "dashboard.html");
      if (fs.existsSync(dashboardFile)) {
        res.sendFile(dashboardFile);
        return;
      }
      res.redirect("/");
    });
    // The Command Center is a dedicated conversational view; same deal — the
    // PIN gate lives on the API routes (and the page degrades to a locked
    // notice), so serving the file itself is safe. A missing file falls back
    // to the dashboard rather than a hard 404.
    app.get("/admin/command-center", (_req: Request, res: Response) => {
      const ccFile = path.join(publicDir, "command-center.html");
      if (fs.existsSync(ccFile)) {
        res.sendFile(ccFile);
        return;
      }
      res.redirect("/dashboard");
    });

    // Swarm Triage UI Routes (Phase 2 Frontend)
    app.get("/admin/node-fleet-command", (_req: Request, res: Response) => {
      const file = path.join(publicDir, "node-fleet-command.html");
      if (fs.existsSync(file)) {
        res.sendFile(file);
        return;
      }
      res.redirect("/dashboard");
    });

    app.get("/admin/ai-auto-published", (_req: Request, res: Response) => {
      const file = path.join(publicDir, "ai-auto-published.html");
      if (fs.existsSync(file)) {
        res.sendFile(file);
        return;
      }
      res.redirect("/dashboard");
    });

    app.get("/admin/review-queue", (_req: Request, res: Response) => {
      const file = path.join(publicDir, "review-queue.html");
      if (fs.existsSync(file)) {
        res.sendFile(file);
        return;
      }
      res.redirect("/dashboard");
    });

    console.log(`[API] Serving Local Web GUI from ${publicDir}`);
  } else {
    // Nothing found anywhere, packaged or not. Name the likely cause instead of
    // leaving the operator staring at a bare 503: on a released .exe this means
    // the recursive `public/` pkg asset was missing from the build, which is a
    // packaging bug, not something the user can fix on their PC.
    console.warn(
      `[API] No Web GUI assets found. Searched: installDir/public, __dirname/../../public ` +
        "(the pkg snapshot), __dirname/../public and cwd/public.",
    );
    app.get("/", (_req: Request, res: Response) => {
      res.status(503).json({
        success: false,
        message: "Web GUI assets (public/) not found in this build.",
      });
    });
    // Everything else falls through to the JSON 404 handler, but the SPA-ish
    // entry points deserve the same explicit answer rather than a bare 404 that
    // looks like a routing bug.
    app.get("/dashboard", (_req: Request, res: Response) => {
      res.redirect("/");
    });
  }

  // Register Swarm Triage routes (admin API for fleet command UI).
  registerSwarmTriageRoutes(app, requireDashboardAuth);


  return app;
}

/** Starts the local API + Web GUI on PORT (LAN: binds 0.0.0.0). Always runs (master + satellite). */
export function startServer(): Server {
  const app = createApp();
  const server = app.listen(env.PORT, "0.0.0.0", () => {
    console.log(`[API] Local dashboard + API listening on http://localhost:${env.PORT}`);
    const lans = getLanAddresses();
    if (lans.length > 0) {
      for (const ip of lans) console.log(`[API] LAN access: http://${ip}:${env.PORT}`);
    } else {
      console.log(`[API] LAN access: http://<this-host-ip>:${env.PORT}`);
    }
  });
  return server;
}

/** Restarts the listener (used when the GUI save changes PORT). */
export function restartServer(): Server {
  return startServer();
}
