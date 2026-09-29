import crypto from "node:crypto";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import os from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import { z } from "zod";
import { env, reloadEnv } from "./config";
import { APP_VERSION } from "./version";
import {
  DEFAULT_DASHBOARD_PIN,
  applyConfigToEnv,
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
 * main dashboard view. Setup can proceed unauthenticated until the first
 * `config.json` exists; afterwards the LAN passkey is required.
 */
export function requireDashboardAuth(req: Request, res: Response, next: NextFunction): void {
  // First-run setup stays open so the operator can create config.json + PIN.
  if (!readConfigLenient()) {
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

/** Builds the Express app (separated from listen() for testability). */
export function createApp(): Express {
  const app = express();
  app.use(express.json());

  // Liveness probe for the Mothership / local monitoring.
  app.get("/health", (_req: Request, res: Response) => {
    res.json({
      success: true,
      node: env.NODE_NAME,
      role: env.NODE_ROLE,
      status: "online",
      version: APP_VERSION,
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
    // First-run (no config.json yet): accept the default PIN so setup can start.
    if (!readConfigLenient()) {
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

  // GET /api/system/config — current config.json state (API key + PIN masked).
  app.get("/api/system/config", requireDashboardAuth, (_req: Request, res: Response) => {
    const stored = readConfigLenient() ?? normalizeConfig({});
    const apiKey = stored.NODE_API_KEY ?? "";
    res.json({
      success: true,
      configured: isConfigComplete(readConfig()),
      authenticated: hasDashboardSession(_req),
      config: {
        node_role: stored.NODE_ROLE,
        NODE_ROLE: stored.NODE_ROLE,
        master_node_url: stored.MASTER_LOCAL_URL,
        MASTER_LOCAL_URL: stored.MASTER_LOCAL_URL,
        mothership_url: stored.MOTHERSHIP_URL,
        MOTHERSHIP_URL: stored.MOTHERSHIP_URL,
        node_name: stored.NODE_NAME,
        NODE_NAME: stored.NODE_NAME,
        NODE_API_KEY: "",
        apiKeyConfigured: apiKey.trim().length >= 8,
        dashboard_pin: "",
        pinConfigured: (stored.DASHBOARD_PIN ?? "").trim().length >= 4,
        ollama_url: stored.OLLAMA_URL,
        OLLAMA_URL: stored.OLLAMA_URL,
        port: stored.PORT,
        PORT: stored.PORT,
      },
    });
  });

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
        config: {
          node_role: validated.config.NODE_ROLE,
          master_node_url: validated.config.MASTER_LOCAL_URL,
          NODE_NAME: validated.config.NODE_NAME,
          PORT: validated.config.PORT,
        },
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

  // Local Web GUI — static Settings UI from public/.
  const publicDir = resolvePublicDir();
  if (publicDir) {
    app.use(express.static(publicDir));
    app.get("/", (_req: Request, res: Response) => {
      res.sendFile(path.join(publicDir, "index.html"));
    });
    console.log(`[API] Serving Local Web GUI from ${publicDir}`);
  } else {
    app.get("/", (_req: Request, res: Response) => {
      res.status(503).json({
        success: false,
        message: "Web GUI assets (public/) not found in this build.",
      });
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
