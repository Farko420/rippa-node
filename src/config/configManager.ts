import { exec } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { config as loadDotenv } from "dotenv";
// TYPE-ONLY import: erased at compile time, so this creates no runtime cycle
// even though `nodeAuth` imports this module for its fs/validation helpers.
import type { PeerEndpoint } from "./nodeAuth";

/**
 * FIRST-RUN SETUP / CONFIGURATION MANAGER.
 *
 * Rippa Node ships as a portable app, so configuration lives in a local
 * `config.json` in the application root instead of a hand-edited `.env`:
 *
 *  - Packaged exe (`rippa-node.exe`): root = the folder containing the exe.
 *  - Dev / `node dist/index.js`:      root = the project folder (walked up
 *                                     from this file until package.json).
 *  - `RIPPA_CONFIG_ROOT`:             explicit override (useful for tests).
 *
 * Configuration is managed through the Local Web GUI
 * (`http://localhost:4000/`). `ensureConfiguration()` is non-blocking: it
 * loads `config.json` silently when present, otherwise falls back to
 * `.env`/defaults so the config API + GUI can boot and collect settings.
 */

/** Shape persisted to `config.json`. Mirrors the validated env schema. */
export interface RippaNodeConfig {
  MOTHERSHIP_URL: string;
  NODE_API_KEY: string;
  NODE_NAME: string;
  MASTER_LOCAL_URL: string;
  NODE_ROLE: "master" | "satellite";
  PORT: number;
  OLLAMA_URL: string;
  /** LAN dashboard passkey (compared by POST /api/system/auth). */
  DASHBOARD_PIN: string;
  /** Alias of NODE_ROLE used by the Web GUI (`master` | `satellite`). */
  node_role?: "master" | "satellite";
  /** Alias of MASTER_LOCAL_URL used by the Web GUI when role is satellite. */
  master_node_url?: string;
  /** Alias of DASHBOARD_PIN used by the Web GUI. */
  dashboard_pin?: string;
  /**
   * Optional 6-digit Cloudflare relay code (satellites only). Lets a Satellite
   * reach its Master over the internet when a VPN or a segmented network
   * isolates the two devices. Blank/unset means LAN-only linking.
   */
  cloud_link_code?: string;
  /** Permanent, unique node code minted on first boot (zero-config identity). */
  NODE_CODE?: string;
  /** ISO timestamp of when NODE_CODE was minted. */
  NODE_CREATED_AT?: string;
  /** Master node code this Satellite is paired with (set by the one-time handshake). */
  PAIRED_MASTER_CODE?: string;
  /** Base URL of the Master this Satellite is paired with. */
  PAIRED_MASTER_URL?: string;
  /** Cloud Link URL of the Master, when one was advertised during pairing. */
  PAIRED_MASTER_CLOUD_URL?: string;
  /** ISO timestamp of the completed pairing handshake. */
  PAIRED_MASTER_AT?: string;
  /** Shared secret issued by the Master; authenticates node-to-node traffic. */
  MESH_KEY?: string;
  /** Node code of the Master that issued MESH_KEY (diagnostic only). */
  MESH_KEY_ISSUER?: string;
  /** False when the Master revoked P2P and forces master-relay reporting. */
  P2P_ENABLED?: boolean;
  /** Sibling endpoints auto-filled by the Master (never typed by a user). */
  PEER_MESH?: PeerEndpoint[];
}

export type NodeRole = "master" | "satellite";

export const DEFAULT_MOTHERSHIP_URL = "https://rippaadventures.com";
export const DEFAULT_PORT = 4000;
export const DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434";
/** Default LAN dashboard passkey (user-configurable during initial setup). */
export const DEFAULT_DASHBOARD_PIN = "12031994";
const CONFIG_FILENAME = "config.json";

/**
 * Keys present in the REAL process environment before dotenv/config.json were
 * loaded. GUI saves (POST /api/system/config) pass `force` to override these,
 * since a Save click is explicit operator intent.
 */
const PRESET_ENV_KEYS = new Set(Object.keys(process.env));

/**
 * True when running from a `pkg`-built executable (rippa-node.exe).
 *
 * Uses the literal `typeof … !== "undefined"` form rather than a truthiness
 * check: `process.pkg` is injected by the pkg bootstrap and is genuinely
 * absent from a normal `node`/`tsx` process, so the typeof test is the
 * canonical way to detect the snapshot runtime.
 */
function isPackaged(): boolean {
  return typeof (process as NodeJS.Process & { pkg?: unknown }).pkg !== "undefined";
}

/**
 * Walks up from `start` looking for the project root (the folder holding
 * package.json). Bounded to 8 levels so a symlinked/odd layout can never loop
 * forever. Returns "" when nothing is found.
 */
function findProjectRoot(start: string): string {
  let dir = start;
  for (let i = 0; i < 8; i += 1) {
    try {
      if (fs.existsSync(path.join(dir, "package.json"))) return dir;
    } catch {
      /* unreadable dir — keep walking up */
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return "";
}

/**
 * ROOT DIRECTORY THAT HOLDS `config.json`.
 *
 * CRITICAL (pkg): `__dirname` is NOT usable to locate a writable config file
 * inside a `pkg` executable — it points into the read-only virtual snapshot
 * filesystem bundled into the exe, so reads/writes there either fail or land
 * somewhere that vanishes on the next build. The packaged path is therefore
 * derived from `process.execPath` (the real .exe on disk) so `config.json` is
 * always written right next to `rippa-node.exe`, which is the only location
 * that survives an app update and is the folder the user copies between PCs.
 *
 * Resolution order:
 *   1. `RIPPA_CONFIG_ROOT` — explicit override (tests / custom deployments).
 *   2. pkg executable       — `path.dirname(process.execPath)`.
 *   3. dev / `node dist/…`  — `process.cwd()`, refined by walking up to the
 *      folder containing package.json so `node dist/index.js` still finds the
 *      project config when launched from a subdirectory.
 */
export function resolveAppRoot(): string {
  const override = process.env.RIPPA_CONFIG_ROOT;
  if (override && override.trim()) {
    return path.resolve(override.trim());
  }

  const isPkg = isPackaged();
  const basePath = isPkg ? path.dirname(process.execPath) : process.cwd();

  if (isPkg) {
    // Already correct for the portable-app layout: config.json lives beside
    // the .exe. No further walking — a parent folder would be wrong.
    return basePath;
  }

  // Dev: prefer the project root so config.json is not duplicated per folder.
  // If cwd already is the project root, findProjectRoot returns it unchanged.
  return findProjectRoot(basePath) || basePath;
}

/** Absolute path of `config.json` for the given (or resolved) root. */
export function configFilePath(root: string = resolveAppRoot()): string {
  return path.join(root, CONFIG_FILENAME);
}

/** True when a `config.json` file physically exists at the resolved path. */
export function configFileExists(root: string = resolveAppRoot()): boolean {
  try {
    return fs.existsSync(configFilePath(root));
  } catch {
    return false;
  }
}

/** Loose input accepted from config.json, .env, or the Web GUI form. */
export type ConfigInput = Partial<
  Record<string, string | number | boolean | null | undefined>
>;

/** Picks the first non-empty string from a list of candidate keys. */
function pickString(input: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return "";
}

/** Fills optional/legacy fields with boot-safe defaults so zod always passes. */
export function normalizeConfig(cfg: ConfigInput): RippaNodeConfig {
  const record = (cfg ?? {}) as Record<string, unknown>;
  const rawPort = pickString(record, "PORT", "port");
  const portNum = Number(rawPort);
  const port =
    Number.isFinite(portNum) && portNum > 0 && portNum <= 65535
      ? Math.floor(portNum)
      : DEFAULT_PORT;
  const roleRaw = pickString(record, "node_role", "NODE_ROLE").toLowerCase();
  const role: NodeRole = roleRaw === "satellite" ? "satellite" : "master";
  const masterLocal =
    pickString(record, "master_node_url", "MASTER_LOCAL_URL", "masterNodeUrl") ||
    `http://127.0.0.1:${port}`;
  const pin =
    pickString(record, "DASHBOARD_PIN", "dashboard_pin", "dashboardPin", "pin", "passkey") ||
    DEFAULT_DASHBOARD_PIN;
  // Digits only: the relay code is typed into a numeric UI field and used in a
  // tunnel URL, so anything else is stripped rather than persisted.
  const cloudLinkCode = normalizeCloudLinkCode(
    pickString(record, "cloud_link_code", "CLOUD_LINK_CODE", "cloudLinkCode"),
  );
  return {
    NODE_ROLE: role,
    NODE_NAME: pickString(record, "NODE_NAME", "node_name") || "Unnamed Rippa Node",
    NODE_API_KEY: pickString(record, "NODE_API_KEY", "node_api_key"),
    MOTHERSHIP_URL: pickString(record, "MOTHERSHIP_URL", "mothership_url") || DEFAULT_MOTHERSHIP_URL,
    MASTER_LOCAL_URL: masterLocal,
    OLLAMA_URL: pickString(record, "OLLAMA_URL", "ollama_url") || DEFAULT_OLLAMA_URL,
    PORT: port,
    DASHBOARD_PIN: pin,
    node_role: role,
    master_node_url: masterLocal,
    dashboard_pin: pin,
    cloud_link_code: cloudLinkCode,
    // Zero-config mesh state. Carried through verbatim so a GUI save (which
    // rebuilds the object from this function) can never wipe a node code, a
    // completed pairing handshake, or Master-provisioned sibling endpoints.
    NODE_CODE: pickString(record, "NODE_CODE") || undefined,
    NODE_CREATED_AT: pickString(record, "NODE_CREATED_AT") || undefined,
    PAIRED_MASTER_CODE: pickString(record, "PAIRED_MASTER_CODE") || undefined,
    PAIRED_MASTER_URL: pickString(record, "PAIRED_MASTER_URL") || undefined,
    PAIRED_MASTER_CLOUD_URL: pickString(record, "PAIRED_MASTER_CLOUD_URL") || undefined,
    PAIRED_MASTER_AT: pickString(record, "PAIRED_MASTER_AT") || undefined,
    MESH_KEY: pickString(record, "MESH_KEY") || undefined,
    MESH_KEY_ISSUER: pickString(record, "MESH_KEY_ISSUER") || undefined,
    P2P_ENABLED: record["P2P_ENABLED"] === false ? false : true,
    PEER_MESH: normalizePeers(record["PEER_MESH"]),
  };
}

/** Keeps only well-formed peer entries when normalising config.json. */
function normalizePeers(value: unknown): PeerEndpoint[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((peer): peer is PeerEndpoint => Boolean(peer) && typeof peer === "object")
    .map((peer) => ({
      nodeCode: pickString(peer as unknown as Record<string, unknown>, "nodeCode"),
      nodeName: pickString(peer as unknown as Record<string, unknown>, "nodeName"),
      ipAddress: pickString(peer as unknown as Record<string, unknown>, "ipAddress"),
      port: Number(pickString(peer as unknown as Record<string, unknown>, "port")) || 0,
      lanUrl: pickString(peer as unknown as Record<string, unknown>, "lanUrl"),
      cloudLinkUrl: pickString(peer as unknown as Record<string, unknown>, "cloudLinkUrl"),
      lastProvisionedAt: pickString(peer as unknown as Record<string, unknown>, "lastProvisionedAt"),
    }))
    .filter((peer) => Boolean(peer.nodeCode));
}

/**
 * Normalises a Cloud Link relay code.
 *
 * Strips non-digits, then requires EXACTLY 6 digits — anything else yields ""
 * (LAN-only linking). It deliberately does NOT truncate an over-long code:
 * silently turning a 7-digit value into a wrong 6-digit code would connect
 * the satellite to the wrong tunnel. Validation surfaces the error instead.
 */
export function normalizeCloudLinkCode(value: string): string {
  const digits = String(value ?? "").replace(/\D+/g, "");
  return /^\d{6}$/.test(digits) ? digits : "";
}

/**
 * Reads `config.json` silently.
 * Returns null when the file is missing, corrupt, or has no usable NODE_API_KEY
 * (the GUI treats each of those as "not set up yet").
 */
export function readConfig(root: string = resolveAppRoot()): RippaNodeConfig | null {
  try {
    const raw = fs.readFileSync(configFilePath(root), "utf8");
    const parsed = JSON.parse(raw) as ConfigInput | null;
    if (!parsed || typeof parsed !== "object") return null;
    const normalized = normalizeConfig(parsed);
    if (normalized.NODE_API_KEY.length < 8) return null;
    return normalized;
  } catch {
    return null;
  }
}

/** Reads `config.json` even when incomplete (for prefilling the GUI form). */
export function readConfigLenient(root: string = resolveAppRoot()): RippaNodeConfig | null {
  try {
    const raw = fs.readFileSync(configFilePath(root), "utf8");
    const parsed = JSON.parse(raw) as ConfigInput | null;
    if (!parsed || typeof parsed !== "object") return null;
    return normalizeConfig(parsed);
  } catch {
    return null;
  }
}

/** True when the config has the minimum fields needed to run node services. */
export function isConfigComplete(cfg: RippaNodeConfig | null | undefined): boolean {
  if (!cfg) return false;
  if (!cfg.NODE_API_KEY || cfg.NODE_API_KEY.trim().length < 8) return false;
  if (!cfg.NODE_NAME || !cfg.NODE_NAME.trim()) return false;
  if (cfg.NODE_ROLE === "satellite") {
    return isHttpUrl(cfg.MASTER_LOCAL_URL);
  }
  return isHttpUrl(cfg.MOTHERSHIP_URL);
}

/**
 * Names of the fields still blocking `isConfigComplete`, in form order.
 *
 * WHY THIS EXISTS: `isConfigComplete` is a boolean, so a node that saved a
 * config.json which is still missing (say) a valid Mothership URL answers
 * `configured: false` with no reason attached. The GUI then shows the Setup
 * Screen forever and the operator has no idea which field to fix — which is
 * exactly the "stuck on the setup screen" trap this list exists to remove.
 *
 * Deliberately derives from the SAME predicates as {@link isConfigComplete} so
 * the two can never disagree about what is missing.
 */
export function describeConfigGaps(cfg: RippaNodeConfig | null | undefined): string[] {
  if (!cfg) return ["config.json"];
  const gaps: string[] = [];
  if (!cfg.NODE_API_KEY || cfg.NODE_API_KEY.trim().length < 8) gaps.push("Node API Key");
  if (!cfg.NODE_NAME || !cfg.NODE_NAME.trim()) gaps.push("Node Name");
  if (cfg.NODE_ROLE === "satellite") {
    if (!isHttpUrl(cfg.MASTER_LOCAL_URL)) gaps.push("Master Node URL");
  } else if (!isHttpUrl(cfg.MOTHERSHIP_URL)) {
    gaps.push("Mothership URL");
  }
  return gaps;
}

/**
 * Applies config.json values to `process.env` so the zod schema in `./config`
 * sees them. Keys already present in the true OS environment are left alone
 * unless `force` is set (GUI save = explicit operator intent to override).
 */
export function applyConfigToEnv(cfg: ConfigInput | RippaNodeConfig | null, force = false): void {
  if (!cfg) return;
  const config = normalizeConfig(cfg as ConfigInput);
  const put = (key: string, value: string): void => {
    if (force || !PRESET_ENV_KEYS.has(key)) process.env[key] = value;
  };
  put("MOTHERSHIP_URL", config.MOTHERSHIP_URL);
  put("NODE_API_KEY", config.NODE_API_KEY);
  put("NODE_NAME", config.NODE_NAME);
  put("MASTER_LOCAL_URL", config.MASTER_LOCAL_URL);
  put("NODE_ROLE", config.NODE_ROLE);
  put("PORT", String(config.PORT));
  put("OLLAMA_URL", config.OLLAMA_URL);
  put("DASHBOARD_PIN", config.DASHBOARD_PIN);
  put("node_role", config.NODE_ROLE);
  put("master_node_url", config.MASTER_LOCAL_URL);
  put("dashboard_pin", config.DASHBOARD_PIN);
  if (config.cloud_link_code) {
    put("CLOUD_LINK_CODE", config.cloud_link_code);
  }
}

/** Writes config.json (0600 permissions on POSIX; best effort on Windows). */
export function writeConfig(root: string, cfg: ConfigInput | RippaNodeConfig): string {
  const file = configFilePath(root);
  const normalized = normalizeConfig(cfg as ConfigInput);
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(normalized, null, 2) + "\n", {
    encoding: "utf8",
    mode: 0o600,
  });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* Windows / restricted FS — the file was still written. */
  }
  return file;
}

/**
 * Non-blocking boot config: loads config.json when usable, otherwise seeds
 * process.env from .env/defaults so the Local Web GUI can boot on port 4000
 * and collect settings via POST /api/system/config.
 */
export async function ensureConfiguration(
  options: { rootDir?: string } = {},
): Promise<{ configured: boolean; config: RippaNodeConfig | null; root: string }> {
  const root = options.rootDir ?? resolveAppRoot();
  // Log the exact config.json location at boot. When a user reports "my
  // settings vanished" this line is the first thing to check: it proves which
  // directory the process is actually reading and writing.
  console.log(`[Config] Root: ${root}`);
  console.log(
    `[Config] File: ${configFilePath(root)} (${configFileExists(root) ? "found" : "not found"})`,
  );
  const existing = readConfig(root);
  if (existing) {
    applyConfigToEnv(existing);
    return { configured: isConfigComplete(existing), config: existing, root };
  }
  loadDotenv();
  const lenient = readConfigLenient(root);
  if (lenient) {
    applyConfigToEnv(lenient);
  } else {
    if (!process.env.PORT) process.env.PORT = String(DEFAULT_PORT);
    if (!process.env.OLLAMA_URL) process.env.OLLAMA_URL = DEFAULT_OLLAMA_URL;
    if (!process.env.MOTHERSHIP_URL) process.env.MOTHERSHIP_URL = DEFAULT_MOTHERSHIP_URL;
    if (!process.env.NODE_ROLE) process.env.NODE_ROLE = "master";
    if (!process.env.NODE_NAME) process.env.NODE_NAME = "Unnamed Rippa Node";
    if (!process.env.DASHBOARD_PIN) process.env.DASHBOARD_PIN = DEFAULT_DASHBOARD_PIN;
  }
  console.log("══════════════════════════════════════════════");
  console.log(" Rippa Node — configuration required");
  console.log(` No usable ${CONFIG_FILENAME} found in ${root}`);
  console.log(" Open the Local Configuration Dashboard to finish setup.");
  console.log("══════════════════════════════════════════════");
  return { configured: false, config: lenient, root };
}

export function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export interface ConfigValidationSuccess {
  ok: true;
  config: RippaNodeConfig;
}

export interface ConfigValidationFailure {
  ok: false;
  errors: Array<{ path: string; message: string }>;
}

/**
 * Validates GUI/API input for POST /api/system/config.
 * Accepts both UPPER_SNAKE and lowercase node_role / master_node_url keys.
 */
export function validateConfigInput(
  input: unknown,
): ConfigValidationSuccess | ConfigValidationFailure {
  const record =
    input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const errors: Array<{ path: string; message: string }> = [];
  const roleRaw = pickString(record, "node_role", "NODE_ROLE").toLowerCase();
  if (roleRaw !== "master" && roleRaw !== "satellite") {
    errors.push({ path: "node_role", message: 'node_role must be "master" or "satellite"' });
  }
  const role = (roleRaw === "satellite" ? "satellite" : "master") as NodeRole;
  const nodeName = pickString(record, "NODE_NAME", "node_name");
  if (!nodeName) errors.push({ path: "node_name", message: "Node name is required" });
  const apiKey = pickString(record, "NODE_API_KEY", "node_api_key");
  if (!apiKey) {
    errors.push({ path: "node_api_key", message: "Node API key is required" });
  } else if (apiKey.length < 8) {
    errors.push({ path: "node_api_key", message: "NODE_API_KEY must be at least 8 characters" });
  }
  const mothership = pickString(record, "MOTHERSHIP_URL", "mothership_url");
  const masterNodeUrl = pickString(record, "master_node_url", "MASTER_LOCAL_URL", "masterNodeUrl");
  if (role === "master") {
    if (!mothership) {
      errors.push({ path: "mothership_url", message: "Mothership URL is required for master nodes" });
    } else if (!isHttpUrl(mothership)) {
      errors.push({ path: "mothership_url", message: "Mothership URL must be a valid http(s) URL" });
    }
  } else if (mothership && !isHttpUrl(mothership)) {
    errors.push({ path: "mothership_url", message: "Mothership URL must be a valid http(s) URL" });
  }
  if (role === "satellite") {
    if (!masterNodeUrl) {
      errors.push({ path: "master_node_url", message: "Master Node URL is required for satellite nodes" });
    } else if (!isHttpUrl(masterNodeUrl)) {
      errors.push({ path: "master_node_url", message: "Master Node URL must be a valid http(s) URL" });
    }
  } else if (masterNodeUrl && !isHttpUrl(masterNodeUrl)) {
    errors.push({ path: "master_node_url", message: "Master Node URL must be a valid http(s) URL" });
  }
  const portRaw = pickString(record, "PORT", "port");
  if (portRaw) {
    const n = Number(portRaw);
    if (!Number.isInteger(n) || n < 1 || n > 65535) {
      errors.push({ path: "port", message: "Port must be an integer 1-65535" });
    }
  }
  const ollama = pickString(record, "OLLAMA_URL", "ollama_url");
  if (ollama && !isHttpUrl(ollama)) {
    errors.push({ path: "ollama_url", message: "Ollama URL must be a valid http(s) URL" });
  }
  const pin = pickString(record, "DASHBOARD_PIN", "dashboard_pin", "dashboardPin", "pin", "passkey");
  if (pin && pin.length < 4) {
    errors.push({ path: "dashboard_pin", message: "Dashboard passkey must be at least 4 characters" });
  }
  const cloudLink = pickString(record, "cloud_link_code", "CLOUD_LINK_CODE", "cloudLinkCode");
  // An empty code is fine (LAN-only). A non-empty one must be exactly 6 digits,
  // so a typo surfaces as a clear message instead of a silently dropped value.
  if (cloudLink && !normalizeCloudLinkCode(cloudLink)) {
    errors.push({ path: "cloud_link_code", message: "Cloud Link code must be exactly 6 digits" });
  }
  if (errors.length > 0) return { ok: false, errors };
  const config = normalizeConfig({ ...record, NODE_ROLE: role, node_role: role });
  return { ok: true, config };
}

/**
 * Resolves the `public/` web GUI directory (dev, dist, and pkg snapshot).
 *
 * The app root (folder beside the .exe when packaged) is checked FIRST so a
 * user-supplied `public/` next to the exe always wins over the bundled
 * snapshot. The `__dirname` candidates remain for dev/dist only.
 */
export function resolvePublicDir(): string | null {
  const candidates: string[] = [];
  try {
    candidates.push(path.join(resolveAppRoot(), "public"));
  } catch {
    /* ignore */
  }
  if (!isPackaged()) {
    // Inside a pkg exe __dirname points at the virtual snapshot; only the
    // staged/bundled asset is valid there, so skip these in the packaged case.
    candidates.push(path.join(__dirname, "..", "..", "public"));
    candidates.push(path.join(__dirname, "..", "public"));
  }
  candidates.push(path.join(process.cwd(), "public"));
  for (const dir of candidates) {
    try {
      if (fs.existsSync(dir) && fs.existsSync(path.join(dir, "index.html"))) return dir;
    } catch {
      /* try next */
    }
  }
  for (const dir of candidates) {
    try {
      if (fs.existsSync(dir)) return dir;
    } catch {
      /* try next */
    }
  }
  return null;
}

/**
 * Launches the user's default browser at `url` via Node's native
 * `child_process.exec` with a cross-platform shell command.
 *
 * NOTE: Do NOT reintroduce the `open` NPM package here — its dynamic ESM
 * import breaks inside the `pkg` bundle (rippa-node.exe).
 */
export async function openDashboard(url: string): Promise<void> {
  const startCommand =
    process.platform === "win32" ? "start" : process.platform === "darwin" ? "open" : "xdg-open";
  const cmd =
    process.platform === "win32" ? `${startCommand} "" "${url}"` : `${startCommand} "${url}"`;
  return new Promise<void>((resolve) => {
    try {
      exec(cmd, (error) => {
        if (error) {
          console.warn(`[Boot] Could not auto-launch browser — ${error.message}`);
          console.warn(`[Boot] Open this URL manually: ${url}`);
        }
        resolve();
      });
    } catch (error) {
      console.warn(
        `[Boot] Could not auto-launch browser — ${error instanceof Error ? error.message : String(error)}`,
      );
      console.warn(`[Boot] Open this URL manually: ${url}`);
      resolve();
    }
  });
}





