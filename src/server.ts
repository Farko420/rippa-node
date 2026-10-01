import crypto from "node:crypto";
import fs from "node:fs";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import os from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import { z } from "zod";
import { env, reloadEnv } from "./config";
import { APP_VERSION } from "./version";
import { runtimeCapabilities } from "./platform";
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
import { getBrainCounts, getSyncCursor, ingestBrainBundle } from "./services/brainIngest";
import { latestNodeEvent, publishNodeEvent, subscribeNodeEvents } from "./services/nodeEvents";
import { getDeepBrain } from "./db/database";
import {
  SwarmUpdater,
  handleUpdateTrigger,
  isPackagedExe,
  parseUpdateTrigger,
} from "./services/updater";
import { isVersionNewer } from "./version";
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
  app.use(express.json());

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
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        message: `Could not read the brain: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  });

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

  // POST /api/mesh/task — Master assigns a shared task (auto-provisions P2P).
  app.post("/api/mesh/task", requireDashboardAuth, async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const load = String(body["load"] ?? "normal") as LoadClass;
    if (!["heavy", "normal", "lite"].includes(load)) {
      res.status(400).json({ success: false, message: "load must be heavy, normal or lite." });
      return;
    }
    const assignees = Array.isArray(body["assignees"]) ? (body["assignees"] as string[]) : undefined;
    try {
      const task = await dispatcher.assignSharedTask({
        label: String(body["label"] ?? "Shared swarm task"),
        load,
        ...(assignees ? { assignees } : {}),
      });
      res.json({ success: true, task });
    } catch (error) {
      res.status(400).json({
        success: false,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // POST /api/mesh/satellite/:code/restore-p2p — undo an adaptive revocation.
  app.post("/api/mesh/satellite/:code/restore-p2p", requireDashboardAuth, (req: Request, res: Response) => {
    dispatcher.restoreP2p(String(req.params["code"] ?? ""));
    res.json({ success: true });
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

// GET /api/mesh/updater — OTA status for the dashboard.
  app.get("/api/mesh/updater", requireDashboardAuth, (_req: Request, res: Response) => {
    const latest = swarmUpdater.getLatest();
    res.json({
      success: true,
      currentVersion: APP_VERSION,
      latest,
      updateAvailable: latest ? isVersionNewer(latest.version) : false,
      selfReplaceable: isPackagedExe(),
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
