import crypto from "node:crypto";
import { env } from "../config";
import { isHttpUrl, readConfigLenient, resolveAppRoot, writeConfig } from "./configManager";

/**
 * ZERO-CONFIG NODE CODES & PAIRING IDENTITY.
 *
 * Every Rippa Node has a permanent, unique `rippa_node_code` minted once on
 * first boot (RIPPA-XXXX-XXXX) and persisted in `config.json` next to the
 * executable. The code IS the node's identity on the mesh — it survives
 * restarts, IP changes and reinstalling the folder on another PC.
 *
 * The pairing philosophy is deliberately narrow:
 *
 *   - The operator enters the Master's code/IP on a new Satellite ONCE.
 *   - From that moment the Master owns the Satellite's networking: it registers
 *     the node, issues the mesh key, and pushes sibling endpoints (IP, port,
 *     Cloud Link URLs) whenever a shared task is created.
 *   - A Satellite stores those endpoints automatically — the operator never
 *     types a peer IP again.
 *
 * Everything is persisted through `configManager.writeConfig` so a pkg build
 * always writes beside the real .exe, never into the read-only snapshot.
 */

/** Human-readable prefix shown on every Node screen and pairing dialog. */
export const NODE_CODE_PREFIX = "RIPPA";

/** Default relay base used to build a Cloud Link URL from a 6-digit code. */
export const DEFAULT_CLOUD_LINK_BASE = "https://rippaadventures.com/link";

/** The permanent identity of this node. */
export interface NodeIdentity {
  /** Permanent, unique, user-visible code, e.g. "RIPPA-7Q4M-2XKD". */
  code: string;
  /** ISO timestamp of first mint. */
  createdAt: string;
}

/** A sibling endpoint auto-filled by the Master so nodes can talk P2P. */
export interface PeerEndpoint {
  nodeCode: string;
  nodeName: string;
  ipAddress: string;
  port: number;
  /** Ready-to-use LAN base URL, e.g. "http://192.168.0.221:4000". */
  lanUrl: string;
  /** Internet relay URL (empty when the sibling has no Cloud Link code). */
  cloudLinkUrl: string;
  lastProvisionedAt: string;
}

/** Result of the one-time Satellite to Master handshake. */
export interface PairingRecord {
  masterCode: string;
  masterUrl: string;
  cloudLinkUrl: string;
  pairedAt: string;
  /** False once the Master's adaptive monitor revokes P2P for this node. */
  p2pEnabled: boolean;
}

/** Cryptographically random uppercase code body (8 chars, no ambiguous glyphs). */
function randomCodeBody(): string {
  const alphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
  const bytes = crypto.randomBytes(8);
  let out = "";
  for (const byte of bytes) out += alphabet[byte % alphabet.length];
  return `${out.slice(0, 4)}-${out.slice(4, 8)}`;
}

/** Mints a brand-new permanent node code. */
export function generateNodeCode(): string {
  return `${NODE_CODE_PREFIX}-${randomCodeBody()}`;
}

/**
 * Normalises user input into canonical code form (`RIPPA-XXXX-XXXX`).
 * Returns "" for anything that cannot be a valid code, so callers can treat
 * an empty string as "not a code" and fall back to URL/IP entry.
 */
export function normalizeNodeCode(value: unknown): string {
  const raw = String(value ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
  const body = raw.startsWith(NODE_CODE_PREFIX) ? raw.slice(NODE_CODE_PREFIX.length) : raw;
  const match = /^([2-9A-HJ-NP-Z]{4})([2-9A-HJ-NP-Z]{4})$/.exec(body);
  return match ? `${NODE_CODE_PREFIX}-${match[1]}-${match[2]}` : "";
}

/** True when `value` is (or normalises to) a well-formed node code. */
export function isValidNodeCode(value: unknown): boolean {
  return normalizeNodeCode(value).length > 0;
}

/**
 * Builds the internet relay URL for a 6-digit Cloud Link code.
 * Returns "" when no usable code is present (LAN-only sibling).
 */
export function buildCloudLinkUrl(code: string | undefined | null, base?: string): string {
  const digits = String(code ?? "").replace(/\D+/g, "");
  if (!/^\d{6}$/.test(digits)) return "";
  const root = (base || DEFAULT_CLOUD_LINK_BASE).replace(/\/+$/, "");
  return `${root}/${digits}`;
}

/**
 * P2P reachability order for a sibling: LAN first (fast, no relay hop), then
 * the Cloud Link URL. Falls back to the LAN URL alone when no relay exists.
 */
export function peerCandidateUrls(peer: Pick<PeerEndpoint, "lanUrl" | "cloudLinkUrl">): string[] {
  const urls: string[] = [];
  if (isHttpUrl(peer.lanUrl)) urls.push(peer.lanUrl);
  if (isHttpUrl(peer.cloudLinkUrl) && !urls.includes(peer.cloudLinkUrl)) urls.push(peer.cloudLinkUrl);
  return urls;
}

/** Reads `config.json` leniently (null on a fresh machine is expected). */
function read(): ReturnType<typeof readConfigLenient> {
  return readConfigLenient();
}

/**
 * Merges `patch` into `config.json`, preserving every existing field.
 *
 * This is the only write path for mesh state, which guarantees a GUI save
 * (which round-trips through normalizeConfig) can never erase a node code, a
 * completed pairing handshake, or Master-provisioned sibling endpoints.
 */
function persist(patch: Record<string, unknown>): void {
  const stored = read();
  if (!stored) return;
  writeConfig(resolveAppRoot(), {
    ...(JSON.parse(JSON.stringify(stored)) as Record<string, unknown>),
    ...patch,
  } as never);
}

/**
 * Returns this node's permanent identity, minting and persisting one on first
 * call. Safe to call repeatedly: an existing code is never regenerated, so the
 * identity stays stable for the life of the install.
 */
export function ensureNodeIdentity(): NodeIdentity {
  const stored = read();
  const existing = normalizeNodeCode(stored?.NODE_CODE);
  if (existing) {
    const createdAt = stored?.NODE_CREATED_AT || "";
    if (!createdAt) persist({ NODE_CREATED_AT: new Date().toISOString() });
    return { code: existing, createdAt };
  }
  const identity: NodeIdentity = {
    code: generateNodeCode(),
    createdAt: new Date().toISOString(),
  };
  persist({ NODE_CODE: identity.code, NODE_CREATED_AT: identity.createdAt });
  console.log(`[NodeCode] Minted permanent node code: ${identity.code}`);
  return identity;
}

/** Current identity without minting (for read-only API responses). */
export function currentNodeIdentity(): NodeIdentity | null {
  const stored = read();
  const code = normalizeNodeCode(stored?.NODE_CODE);
  return code ? { code, createdAt: stored?.NODE_CREATED_AT || "" } : null;
}

/** The one-time Satellite to Master pairing, or null when never paired. */
export function getPairing(): PairingRecord | null {
  const stored = read();
  const masterCode = normalizeNodeCode(stored?.PAIRED_MASTER_CODE);
  const masterUrl = (stored?.PAIRED_MASTER_URL || "").trim();
  if (!masterCode || !isHttpUrl(masterUrl)) return null;
  return {
    masterCode,
    masterUrl,
    cloudLinkUrl: (stored?.PAIRED_MASTER_CLOUD_URL || "").trim(),
    pairedAt: stored?.PAIRED_MASTER_AT || "",
    p2pEnabled: stored?.P2P_ENABLED !== false,
  };
}

/** Persists the pairing handshake result (Satellite side). */
export function savePairing(record: PairingRecord): void {
  persist({
    NODE_ROLE: "satellite",
    MASTER_LOCAL_URL: record.masterUrl,
    PAIRED_MASTER_CODE: record.masterCode,
    PAIRED_MASTER_URL: record.masterUrl,
    PAIRED_MASTER_CLOUD_URL: record.cloudLinkUrl,
    PAIRED_MASTER_AT: record.pairedAt,
    P2P_ENABLED: record.p2pEnabled,
  });
  console.log(`[NodeCode] Paired with Master ${record.masterCode} at ${record.masterUrl}`);
}

/** True when this node has completed its one and only pairing handshake. */
export function isPaired(): boolean {
  return getPairing() !== null;
}

/** The mesh key issued by the Master ("" when not yet issued). */
export function getMeshKey(): string {
  return (read()?.MESH_KEY || "").trim();
}

/** Stores the mesh key issued by the Master. */
export function saveMeshKey(key: string, issuedBy: string): void {
  persist({ MESH_KEY: key.trim(), MESH_KEY_ISSUER: issuedBy });
}

/** Constant-time comparison of a presented mesh key against the stored one. */
export function verifyMeshKey(candidate: string | undefined): boolean {
  const expected = getMeshKey();
  if (!expected || !candidate) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(String(candidate));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * AUTO-FILL: installs the sibling endpoints pushed by the Master.
 *
 * Called on a Satellite with zero operator input — the whole point of the
 * zero-config mesh. Replaces the stored peer set wholesale so a revoked or
 * removed sibling disappears immediately instead of lingering.
 */
export function applyPeerProvision(peers: PeerEndpoint[]): PeerEndpoint[] {
  const selfCode = ensureNodeIdentity().code;
  const clean = (Array.isArray(peers) ? peers : [])
    .filter((peer): peer is PeerEndpoint => Boolean(peer) && isValidNodeCode(peer.nodeCode))
    .filter((peer) => normalizeNodeCode(peer.nodeCode) !== selfCode)
    .map((peer) => ({
      nodeCode: normalizeNodeCode(peer.nodeCode),
      nodeName: (peer.nodeName || peer.nodeCode).slice(0, 60),
      ipAddress: (peer.ipAddress || "").trim(),
      port: Number(peer.port) || 0,
      lanUrl: (peer.lanUrl || "").trim(),
      cloudLinkUrl: (peer.cloudLinkUrl || "").trim(),
      lastProvisionedAt: peer.lastProvisionedAt || new Date().toISOString(),
    }));
  persist({ PEER_MESH: clean });
  console.log(`[NodeCode] Auto-filled ${clean.length} sibling endpoint(s) from the Master.`);
  return clean;
}

/** Sibling endpoints currently provisioned by the Master. */
export function listPeers(): PeerEndpoint[] {
  const raw = read()?.PEER_MESH;
  if (!Array.isArray(raw)) return [];
  return raw.filter((peer): peer is PeerEndpoint => Boolean(peer) && isValidNodeCode(peer.nodeCode));
}

/**
 * Sets the local P2P mode flag. When the Master's adaptive monitor revokes P2P
 * this flips the node into master-relay-only mode without a restart.
 */
export function setP2pEnabled(enabled: boolean): void {
  persist({ P2P_ENABLED: enabled });
}

/** Current P2P mode flag (defaults to enabled). */
export function p2pEnabled(): boolean {
  return read()?.P2P_ENABLED !== false;
}

/**
 * The endpoint other nodes should use to reach THIS node, derived from its
 * current LAN address and Cloud Link code. Handed to siblings on task
 * assignment and to the Master during the pairing handshake.
 */
export function selfEndpoint(lanIp: string): PeerEndpoint {
  const identity = ensureNodeIdentity();
  const stored = read();
  return {
    nodeCode: identity.code,
    nodeName: env.NODE_NAME,
    ipAddress: lanIp,
    port: env.PORT,
    lanUrl: `http://${lanIp}:${env.PORT}`,
    cloudLinkUrl: buildCloudLinkUrl(stored?.cloud_link_code),
    lastProvisionedAt: new Date().toISOString(),
  };
}