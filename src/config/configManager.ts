import { exec } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { config as loadDotenv } from "dotenv";
import { ensureDataDir, resolveInstallDir } from "../utils/paths";
// TYPE-ONLY import: erased at compile time, so this creates no runtime cycle
// even though `nodeAuth` imports this module for its fs/validation helpers.
import type { PeerEndpoint } from "./nodeAuth";
// VALUE import, and the reason ./nodeCode exists: nodeAuth depends on this
// module, so pulling the code FORMAT back out of nodeAuth would be a cycle. This
// leaf module has no dependencies of its own and both sides import it safely.
import { normalizeCloudLinkCode as normalizeLinkCode } from "./nodeCode";
import type { PowerConfig } from "../services/resourceGovernor";

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
  /**
   * GitHub token the OTA updater authenticates release downloads with.
   *
   * CARRIED THROUGH `normalizeConfig` FOR THE SAME REASON `MESH_KEY` IS:
   * `writeConfig` writes whatever `normalizeConfig` returns — it is NOT a merge.
   * Any field this function does not name is DELETED on the next GUI save, so an
   * operator who pasted their token into the Setup form and then changed an
   * unrelated setting would silently lose it, and OTA would go back to 404ing
   * against the private repository on the very next hourly poll.
   */
  GITHUB_OTA_TOKEN?: string;
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
  /*
    MESH KEY ROTATION STATE.

    These three fields are what make a key rotation survivable. The Master keeps
    the key it replaced in MESH_KEY_PREVIOUS for a grace period, so a Satellite
    that is mid-heartbeat when the rotation lands still recognises itself and can
    be handed the new key instead of being 401'd into silence. MESH_KEY_REVOKED
    holds keys the cloud explicitly withdrew; a node presenting one is never
    silently upgraded, because a withdrawn key means the cloud has decided that
    node's access should end rather than be repaired.

    Do NOT add rotation state to IDENTITY_ASSOCIATIONS in ./nodeAuth — a key
    rotation is not an identity change, and clearing these on regenerate would
    re-open exactly the lock-out they exist to prevent.
  */
  /** Key replaced by the most recent rotation, kept for the grace window. */
  MESH_KEY_PREVIOUS?: string;
  /** ISO timestamp the previous key stopped being authoritative. */
  MESH_KEY_ROTATED_AT?: string;
  /** Keys explicitly withdrawn by Rippa AI (never auto-upgraded). */
  MESH_KEY_REVOKED?: string[];
  /** False when the Master revoked P2P and forces master-relay reporting. */
  P2P_ENABLED?: boolean;
  /** Sibling endpoints auto-filled by the Master (never typed by a user). */
  PEER_MESH?: PeerEndpoint[];
  /**
   * Master-side satellite registry, persisted so the Swarm Grid and the
   * `connected_satellites` heartbeat survive a restart. Written by the
   * dispatcher alone — never by the setup form, which must not be able to forge
   * fleet membership.
   */
  SATELLITE_REGISTRY?: unknown;
  /*
    AI FALLBACK PROVIDER SETTINGS.

    Carried through `normalizeConfig` for exactly the reason SATELLITE_REGISTRY
    is: `writeConfig` writes whatever this function returns and is NOT a merge,
    so any field not named here is DELETED on the next GUI save. An operator who
    enabled the fallback provider, then changed an unrelated setting in Setup,
    would silently lose the endpoint — and the mesh panel would go back to
    reporting the node as a non-provider with no obvious cause.

    The value types are nullable by DESIGN, not by accident. `null` means "not
    configured" and is the ONLY correct representation of a cleared field; see
    src/services/aiEndpointSettings.ts for why "" is a bug rather than a synonym.
  */
  ai_enabled?: boolean;
  ai_endpoint?: string | null;
  active_model?: string | null;
   /**
    * RESOURCE GOVERNOR CONFIGURATION.
    *
    * Defines the power mode (auto/low/medium/high/custom) and any time-based
    * overrides. Pushed by the Mothership via the heartbeat response and stored
    * locally so the node can manage its resource usage without constant uplink
    * polling. Updated whenever the Mothership detects a configuration change.
    */
   power_config?: PowerConfig;
   /**
    * THE STAMP OF THE POWER CONFIG THIS NODE APPLIED (0079 shadow echo).
    *
    * Echoed from the Mothership's `power_config_updated_at` and reported back on
    * every heartbeat; the cloud keeps re-sending the desired config until this
    * matches. OPAQUE — never parsed or compared for order, only equality, so the
    * node needs no clock agreement with the cloud.
    */
   power_config_updated_at?: string;

  ai_model?: string | null;
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
 * ROOT DIRECTORY THAT HOLDS `config.json`.
 *
 * This is the OS PERSISTENT data directory, NOT the executable's folder. It used
 * to be `path.dirname(process.execPath)`, which meant an OTA update — the node
 * replaces its own .exe in place — wiped the operator's config, node code, mesh
 * key, pairing record and dashboard passkey on every single deploy. The folder
 * beside the exe is now used only for read-only bundled assets (`public/`) and
 * as the migration source in `utils/paths.migrateLegacyData`.
 *
 * Resolution order:
 *   1. `RIPPA_CONFIG_ROOT` — explicit override (tests / custom deployments).
 *   2. `RIPPA_DATA_DIR`     — explicit persistent-dir override.
 *   3. `%LOCALAPPDATA%\RippaNode` on Windows, `~/.rippa-node` elsewhere.
 *
 * The directory is created here (recursively) on every call, so a first boot
 * on a clean machine has somewhere to write before anything else runs.
 */
export function resolveAppRoot(): string {
  const override = process.env.RIPPA_CONFIG_ROOT;
  if (override && override.trim()) {
    const dir = path.resolve(override.trim());
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }
  return ensureDataDir();
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
  // Accepts a 6-digit tunnel code OR a RIPPA-XXXX-XXXX node code, canonicalised
  // on the way in. See normalizeCloudLinkCode in ./nodeCode.
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
    // See the interface note: dropped by a GUI save if not carried through here,
    // which would break OTA against the private release repository.
    GITHUB_OTA_TOKEN: pickString(record, "GITHUB_OTA_TOKEN", "github_ota_token") || undefined,
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
    /*
      ROTATION STATE IS CARRIED THROUGH HERE, for the same reason SATELLITE_REGISTRY
      is: `writeConfig` normalises and writes what this function returns — it does
      not merge. A rotation that lost MESH_KEY_PREVIOUS on the next save would
      strand every satellite that was still holding the old key, which is the
      exact failure this state exists to prevent.
    */
    MESH_KEY_PREVIOUS: pickString(record, "MESH_KEY_PREVIOUS") || undefined,
    MESH_KEY_ROTATED_AT: pickString(record, "MESH_KEY_ROTATED_AT") || undefined,
    MESH_KEY_REVOKED: Array.isArray(record["MESH_KEY_REVOKED"])
      ? (record["MESH_KEY_REVOKED"] as unknown[]).filter(
          (key): key is string => typeof key === "string" && key.trim().length > 0,
        )
      : [],
    P2P_ENABLED: record["P2P_ENABLED"] === false ? false : true,
    PEER_MESH: normalizePeers(record["PEER_MESH"]),
    /*
      SATELLITE_REGISTRY MUST be carried through here, exactly like PEER_MESH.

      `writeConfig` runs `normalizeConfig` and writes whatever that returns — it
      is not a merge. Any field this function does not name is silently DELETED
      on the next save, and a Master that lost its registry would show "0
      satellites" again after an operator touched Setup.
    */
    SATELLITE_REGISTRY: Array.isArray(record["SATELLITE_REGISTRY"])
      ? record["SATELLITE_REGISTRY"]
      : [],
    /*
      AI FALLBACK PROVIDER — see the interface note. Normalised to null rather
      than "" so a cleared field survives a round-trip through config.json as the
      absence of a value.

      `pickString` is deliberately NOT used for the URL: it returns "" for a
      missing key, and "" is precisely the value this feature must never store.
    */
    ai_enabled: record["ai_enabled"] === true,
    ai_endpoint: nullableString(record["ai_endpoint"]),
    active_model: nullableString(record["active_model"]),
    ai_model: nullableString(record["ai_model"]),
    /*
      RESOURCE GOVERNOR CONFIG — see the interface note on `power_config`.
      Carried through like SATELLITE_REGISTRY: a GUI save rebuilds the object
      from this function WITHOUT merging, so a config the Mothership pushed onto
      the node would otherwise be wiped the next time an operator clicked Save,
      silently reverting the machine to its default power mode.
    */
    power_config: normalizePowerConfig(record["power_config"]),
    /*
      THE SHADOW ECHO STAMP, carried through for the same reason `power_config`
      is: `writeConfig` normalises and writes what this function returns WITHOUT
      merging, so a field not named here is silently DELETED on the next GUI
      save. Losing it would make the node re-report "nothing applied" and the
      Mothership would re-push the same config on every heartbeat forever.
    */
    power_config_updated_at: pickString(record, "power_config_updated_at") || undefined,
  };
}

/**
 * A config string field that is either a non-empty string or null.
 *
 * Whitespace-only collapses to null: a field of spaces is what a half-cleared
 * value looks like after a hand edit, and preserving it would produce a URL
 * that is present but unusable.
 */
function nullableString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Keeps only a well-formed `power_config` when normalising config.json.
 *
 * Returns `undefined` (NOT `{}`) when there is nothing usable, so an unset
 * config round-trips as the absence of a value — the same rule the AI fallback
 * fields follow. An unrecognised mode is DROPPED rather than coerced to a
 * default: silently rewriting an operator's typo ('turbo') to 'medium' would
 * hide the mistake and change the machine's behaviour without saying so.
 */
function normalizePowerConfig(value: unknown): PowerConfig | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;

  const allowed = ["auto", "low", "medium", "high", "custom"] as const;
  const mode = record["mode"];
  if (typeof mode !== "string" || !(allowed as readonly string[]).includes(mode)) {
    return undefined;
  }

  // Schedule windows are validated on the way in; a malformed HH:MM is dropped
  // rather than stored, because the Governor would silently ignore it anyway.
  const schedule: NonNullable<PowerConfig["schedule"]> = Array.isArray(record["schedule"])
    ? (record["schedule"] as unknown[])
        .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object")
        .map((entry) => ({
          start: typeof entry["start"] === "string" ? entry["start"] : "",
          end: typeof entry["end"] === "string" ? entry["end"] : "",
          mode: (typeof entry["mode"] === "string" ? entry["mode"] : "low") as "low" | "medium" | "high",
        }))
        .filter((entry) => /^\d{1,2}:\d{2}$/.test(entry.start) && /^\d{1,2}:\d{2}$/.test(entry.end))
    : [];

  const threads = Number(record["custom_cpu_threads"]);
  const ram = Number(record["custom_ram_gb"]);

  return {
    mode: mode as PowerConfig["mode"],
    ...(Number.isFinite(threads) && threads > 0 ? { custom_cpu_threads: Math.floor(threads) } : {}),
    ...(Number.isFinite(ram) && ram > 0 ? { custom_ram_gb: Math.floor(ram) } : {}),
    ...(schedule.length > 0 ? { schedule } : {}),
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
 * DELEGATES to `normalizeCloudLinkCode` in ./nodeCode, which accepts BOTH a
 * 6-digit tunnel code (`123456`) and a full node code (`RIPPA-D2N6-6VZV`). The
 * node code is the modern identifier for a node, so refusing it here is what
 * made the Remote / Cloud Link box reject a perfectly valid pasted code.
 *
 * Like the digit-only rule it replaces, it deliberately does NOT truncate an
 * over-long value: quietly turning a 7-digit entry into a 6-digit one would
 * point the satellite at the wrong tunnel. Validation surfaces the error
 * instead, so a typo is visible rather than silently "fixed".
 */
export function normalizeCloudLinkCode(value: string): string {
  return normalizeLinkCode(value);
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
  /*
    GITHUB_OTA_TOKEN IS PUSHED ONLY WHEN PRESENT, deliberately. `put` would
    otherwise write an empty string on every boot for a node that keeps its token
    in `.env` (or has none), and `resolveGitHubToken` skips blanks — so the two
    readings are equivalent ONLY while blanks stay skipped. Writing "" here
    would additionally shadow the documented `.env` route on any future change
    that stopped treating blanks as absent, so the guard is kept explicit.
  */
  if (config.GITHUB_OTA_TOKEN) {
    put("GITHUB_OTA_TOKEN", config.GITHUB_OTA_TOKEN);
  }
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
 * Fields that belong to the MESH, not to the operator's settings form.
 *
 * WHY THIS LIST EXISTS. `writeConfig` normalises and writes whatever it is
 * given — it is NOT a merge — so any field the incoming payload does not name is
 * DELETED. The Setup / Settings form has inputs for the role, name, API key,
 * Master URL, Cloud Link, port and Ollama URL, and nothing else. It therefore
 * posts a payload in which every key below is absent, and saving any setting
 * silently destroyed the node's identity, its mesh key and its pairing.
 *
 * THAT WAS THE SECOND HALF OF THE "NEW NODE CODE ON EVERY RESTART" BUG. With the
 * code wiped by a settings save, the next boot found no `NODE_CODE`, minted a
 * fresh one, and reported a different identity to the Mothership — so the fleet
 * database accumulated a duplicate "ghost node" for every save/restart cycle, and
 * any Cloud Link tunnel keyed to the old code pointed nowhere.
 *
 * These fields are machine-owned: written by the pairing handshake, the Master's
 * provisioning push and `nodeAuth`, and NEVER edited by the operator. Carrying
 * them forward on every save is therefore correct by construction, and it means a
 * future field added to the mesh layer is protected by default instead of being
 * silently destroyed until someone notices.
 */
const MESH_OWNED_FIELDS = [
  "NODE_CODE",
  "NODE_CREATED_AT",
  "PAIRED_MASTER_CODE",
  "PAIRED_MASTER_URL",
  "PAIRED_MASTER_CLOUD_URL",
  "PAIRED_MASTER_AT",
  "MESH_KEY",
  "MESH_KEY_ISSUER",
  "MESH_KEY_PREVIOUS",
  "MESH_KEY_ROTATED_AT",
  "MESH_KEY_REVOKED",
  "P2P_ENABLED",
  "PEER_MESH",
  "SATELLITE_REGISTRY",
  "GITHUB_OTA_TOKEN",
] as const;

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
  // An empty code is fine (LAN-only). A non-empty one must be a 6-digit tunnel
  // code OR a RIPPA-XXXX-XXXX node code. The message names BOTH accepted forms:
  // the old "exactly 6 digits" wording is what made an operator who pasted
  // `RIPPA-D2N6-6VZV` believe their code was corrupt rather than told the truth.
  if (cloudLink && !normalizeCloudLinkCode(cloudLink)) {
    errors.push({
      path: "cloud_link_code",
      message: "Remote / Cloud Link must be a 6-digit code (123456) or a node code (RIPPA-XXXX-XXXX)",
    });
  }
  if (errors.length > 0) return { ok: false, errors };

  /*
    CARRY THE MESH-OWNED STATE FORWARD.

    `record` is the operator's settings form, which contains no mesh fields, and
    `writeConfig` REPLACES the file rather than merging into it. Merging here —
    at the single point every config write passes through — is what stops a
    settings save from deleting the node code, the mesh key and the pairing.

    An existing value is only applied to a key the payload did NOT mention, so a
    caller that genuinely intends to change one (the pairing handshake and mesh
    key rotation both write through `nodeAuth`) still wins.
  */
  const merged: Record<string, unknown> = { ...record };
  const stored = readConfigLenient();
  if (stored) {
    const existing = stored as unknown as Record<string, unknown>;
    for (const field of MESH_OWNED_FIELDS) {
      if (record[field] === undefined && existing[field] !== undefined) {
        merged[field] = existing[field];
      }
    }
  }
  const config = normalizeConfig({ ...merged, NODE_ROLE: role, node_role: role });
  return { ok: true, config };
}

/**
 * Resolves the `public/` web GUI directory (dev, dist, and pkg snapshot).
 *
 * WHY THE `__dirname` CANDIDATES ARE NOT PACKAGE-AWARE ANY MORE. They used to be
 * skipped when `process.pkg` was set, on the assumption that inside an exe
 * `__dirname` points at a virtual filesystem no real `fs` call could read. That
 * assumption is simply wrong: `pkg` patches `fs`, so `/snapshot/...` paths read
 * perfectly well. Skipping them meant a released exe — which ships as a BARE
 * `rippa-node.exe`, because the OTA updater replaces only that one file — had no
 * `public/` beside it and no snapshot lookup either, so the dashboard answered
 * `503 Web GUI assets (public/) not found in this build`.
 *
 * Order is unchanged in spirit and still deliberate:
 *   1. `installDir()/public` — a `public/` folder the operator dropped beside the
 *      exe always wins, so the dashboard can be patched without a rebuild.
 *   2. `__dirname` candidates — the pkg snapshot (and dev/dist). This is what
 *      makes the single-file exe self-sufficient.
 *   3. `process.cwd()/public` — last-resort convenience for odd launch folders.
 *
 * Caveat on (1): an OTA update replaces the .exe only, so a hand-supplied folder
 * beside it survives the update and will shadow the newer bundled GUI until it is
 * removed. That is the intended "I know what I'm doing" escape hatch.
 */
export function resolvePublicDir(): string | null {
  const candidates: string[] = [];
  try {
    // Read-only bundled assets still belong beside the EXECUTABLE (that is
    // where packaging stages the fallback copy), so this deliberately uses the
    // install dir rather than the persistent data dir.
    candidates.push(path.join(resolveInstallDir(), "public"));
  } catch {
    /* ignore */
  }
  // THE PKG SNAPSHOT. `__dirname` is `/snapshot/<name>/dist/config` in the exe
  // (configManager compiles to `dist/config/`), so `../..` lands on
  // `/snapshot/<name>/public` — exactly where the recursive `public/` glob in
  // `pkg.assets` puts the files. In dev (`src/config/`) and dist (`dist/config/`)
  // `../..` lands on the project root, which is the same folder.
  candidates.push(path.join(__dirname, "..", "..", "public"));
  candidates.push(path.join(__dirname, "..", "public"));
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
  // The caller already answers 503, but say WHERE it looked — a silent miss in
  // an exe is otherwise near-impossible to diagnose from the user's side.
  if (isPackaged()) {
    console.warn(
      `[Config] Web GUI not found. Searched: ${candidates.join(", ")}. ` +
        "This exe is missing its `public/**/*` pkg assets — rebuild it with `npm run package`.",
    );
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





