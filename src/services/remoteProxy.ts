/**
 * SATELLITE -> MASTER REMOTE PROXY - Satellite as a Master Remote Control.
 *
 * Satellites are stateless (no Deep Brain, no fleet registry), so every
 * Master-only dashboard route answered 400 "Not a Master" on a Satellite.
 * This module forwards those requests to the paired Master and relays the
 * Master's response back, so the Satellite UI feels local while the Master
 * takes the compute load.
 *
 * AUTH (two hops): operator -> Satellite via dashboard PIN session, then
 * Satellite -> Master via the mesh key + X-Rippa-Remote-Proxy marker.
 */
import axios from "axios";
import { env } from "../config";
import { getMeshKey, getPairing } from "../config/nodeAuth";
import { readConfigLenient } from "../config/configManager";

/** Marker header set on every Satellite -> Master forwarded request. */
export const REMOTE_PROXY_HEADER = "x-rippa-remote-proxy";

/** Value carried by REMOTE_PROXY_HEADER (any non-empty value counts). */
export const REMOTE_PROXY_VALUE = "satellite-remote";

/** Timeout for one forwarded admin call (LAN Masters answer in ms). */
export const REMOTE_PROXY_TIMEOUT_MS = 20_000;

/** True when this node runs as a Satellite (the only role that proxies). */
export function isSatelliteRole(): boolean {
  return env.NODE_ROLE === "satellite";
}

/** True when the request already arrived via the remote proxy. */
export function isRemoteProxyRequest(req: { headers?: Record<string, unknown> }): boolean {
  const raw = req.headers?.[REMOTE_PROXY_HEADER] ?? req.headers?.["x-rippa-remote-proxy"];
  return String(raw ?? "").trim().length > 0;
}

/**
 * Base URL of the paired Master (no trailing slash), or "" when unpaired.
 * Pairing record wins, then live env, then the lenient config read.
 */
export function getMasterBaseUrl(): string {
  const fromPairing = (getPairing()?.masterUrl || "").trim();
  const fromEnv = (env.MASTER_LOCAL_URL || "").trim();
  let fromDisk = "";
  try {
    fromDisk = (readConfigLenient()?.MASTER_LOCAL_URL || "").trim();
  } catch {
    fromDisk = "";
  }
  const picked = fromPairing || fromEnv || fromDisk;
  if (!/^https?:\/\//i.test(picked)) return "";
  return picked.replace(/\/+$/, "");
}

/** Mesh key this Satellite presents to its Master ("" when never paired). */
export function getSatelliteMeshKey(): string {
  try {
    return (getMeshKey() || "").trim();
  } catch {
    return "";
  }
}

/**
 * Whether a dashboard path is Master-owned and therefore proxyable.
 * Closed allow-list: local-only routes (config writes, pairing, identity,
 * self-heal, ollama/scraper/engine panels, restart/shutdown) stay local.
 */
export function isProxyableAdminPath(path: string): boolean {
  const p = String(path || "");
  if (p === "/api/mesh/snapshot") return true;
  if (p === "/api/mesh/task") return true;
  if (p === "/api/mesh/offload") return true;
  if (p === "/api/mesh/updater") return true;
  if (p === "/api/mesh/broadcast-update") return true;
  if (p === "/api/mesh/purge") return true;
  if (p.startsWith("/api/mesh/satellite/")) return true;
  if (p.startsWith("/api/admin/")) return true;
  if (p.startsWith("/api/command-center/")) return true;
  if (p === "/api/brain/status") return true;
  if (p === "/api/brain/sync-now") return true;
  if (p === "/api/brain/upload-backup") return true;
  return false;
}
export interface ProxyReq {
  method?: string;
  originalUrl?: string;
  url?: string;
  headers?: Record<string, string | string[] | undefined>;
  body?: unknown;
}

export interface ProxyRes {
  status: (code: number) => { json: (body: unknown) => void };
}

/**
 * Forwards the dashboard request to the paired Master and relays the
 * Master's status + body back. Returns true when a response was sent,
 * false when the caller should continue handling locally.
 */
export async function forwardToMaster(req: ProxyReq, res: ProxyRes): Promise<boolean> {
  if (!isSatelliteRole()) return false;
  if (isRemoteProxyRequest({ headers: req.headers as Record<string, unknown> })) return false;
  const targetPath = String(req.originalUrl || req.url || "");
  const cleanPath = targetPath.split("?")[0];
  if (!isProxyableAdminPath(cleanPath)) return false;
  const base = getMasterBaseUrl();
  if (!base) {
    res.status(502).json({
      success: false,
      remoteMode: true,
      message: "Satellite is not paired with a Master yet - set the Master Node URL in Setup, then retry.",
    });
    return true;
  }
  const meshKey = getSatelliteMeshKey();
  const url = `${base}${targetPath}`;
  const method = String(req.method || "GET").toLowerCase();
  const ct = Array.isArray(req.headers?.["content-type"])
    ? req.headers?.["content-type"]?.[0]
    : (req.headers?.["content-type"] as string | undefined);
  // Buffer bodies are multipart intake bytes: forward byte-identical with the
  // ORIGINAL content-type (boundary included). Re-serialising as JSON would
  // corrupt the upload.
  const isBufferBody = typeof Buffer !== "undefined" && Buffer.isBuffer(req.body);
  try {
    const response = await axios.request({
      url,
      method: method as "request",
      timeout: REMOTE_PROXY_TIMEOUT_MS,
      // A bundle/intake body can be tens of MB; the per-route parsers already
      // cap sizes, so don't add a second, smaller axios ceiling here.
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      validateStatus: () => true,
      headers: {
        ...(isBufferBody && ct ? { "Content-Type": ct } : { "Content-Type": ct || "application/json" }),
        ...(meshKey ? { "X-Mesh-Key": meshKey, Authorization: `Bearer ${meshKey}` } : {}),
        [REMOTE_PROXY_HEADER]: REMOTE_PROXY_VALUE,
      },
      data: req.method === "GET" || req.method === "HEAD" ? undefined : (req.body as unknown),
    });
    const payload = response.data !== undefined && response.data !== null
      ? response.data
      : { success: response.status >= 200 && response.status < 300 };
    res.status(response.status).json(payload);
    return true;
  } catch (error) {
    res.status(502).json({
      success: false,
      remoteMode: true,
      masterUrl: base,
      message: `Could not reach the Master at ${base} - ${error instanceof Error ? error.message : String(error)}`,
    });
    return true;
  }
}

