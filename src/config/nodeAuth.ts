import crypto from "node:crypto";
import { env } from "../config";
import { isHttpUrl, readConfigLenient, resolveAppRoot, writeConfig } from "./configManager";
// The code FORMAT itself lives in ./nodeCode so configManager can validate the
// operator's Cloud Link input against the same rules without a require cycle.
import {
  generateNodeCode,
  isValidNodeCode,
  normalizeCloudLinkCode,
  normalizeNodeCode,
} from "./nodeCode";

// Re-exported rather than re-declared: these are the names the rest of the app
// (server.ts, swarmDispatcher.ts) has always imported from here, and keeping
// them stable means the extraction into ./nodeCode changed no call sites.
export { NODE_CODE_PREFIX, generateNodeCode, isValidNodeCode, normalizeNodeCode } from "./nodeCode";

/**
 * ZERO-CONFIG NODE CODES & PAIRING IDENTITY.
 *
 * Every Rippa Node has a unique `rippa_node_code` in the RIPPA-XXXX-XXXX form,
 * persisted in `config.json` in the OS app-data directory. The code IS the node's
 * identity on the mesh — it survives restarts, IP changes and OTA updates.
 *
 * It is no longer immutable. `regenerateNodeCode()` / `setNodeCode()` below let
 * the operator mint a new identity from the Setup screen, which is the supported
 * recovery path when a config is lost or a node is deliberately re-homed. The code
 * FORMAT is defined once in ./nodeCode; this module owns the PERSISTENCE and the
 * pairing rules around it.
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
 * Everything is persisted through `configManager.writeConfig`, so a pkg build
 * always writes to the real app-data directory, never the read-only snapshot.
 */

/** Default relay base used to build a Cloud Link URL from a link code. */
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

/**
 * Builds the internet relay URL for a Cloud Link code.
 *
 * ACCEPTS BOTH FORMS, because the Remote / Cloud Link field accepts both: the
 * classic 6-digit tunnel code and a full `RIPPA-XXXX-XXXX` node code. Returns ""
 * when no usable code is present (LAN-only sibling).
 */
export function buildCloudLinkUrl(code: string | undefined | null, base?: string): string {
  const link = normalizeCloudLinkCode(code);
  if (!link) return "";
  const root = (base || DEFAULT_CLOUD_LINK_BASE).replace(/\/+$/, "");
  return `${root}/${link}`;
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

/**
 * Identity fields that are CLEARED whenever the code changes.
 *
 * Every one of these is an association created *under the old code*. Leaving
 * them behind is what made a code change silently broken: a satellite would keep
 * authenticating with a mesh key the new Master never issued, and a Master would
 * keep advertising a registry full of nodes that pair against the old identity.
 * Clearing them forces a genuine re-pairing, which is the entire point of
 * regenerating an identity.
 *
 * The operator's own settings (name, API key, passkey, Mothership URL, port,
 * Ollama URL) are deliberately NOT in this list — regenerating a code must never
 * cost the operator their configuration.
 */
const IDENTITY_ASSOCIATIONS: Record<string, unknown> = {
  PAIRED_MASTER_CODE: "",
  PAIRED_MASTER_URL: "",
  PAIRED_MASTER_CLOUD_URL: "",
  PAIRED_MASTER_AT: "",
  MESH_KEY: "",
  MESH_KEY_ISSUER: "",
  PEER_MESH: [],
  SATELLITE_REGISTRY: [],
  P2P_ENABLED: true,
};

/**
 * Mints a fresh node code and clears every association made under the old one.
 *
 * THIS IS THE "UNLOCK THE NODE CODE" PATH. The code was originally documented as
 * permanent with no recovery, which meant a node whose config.json was lost — or
 * one deliberately re-homed onto another machine — was stuck: the only way to get
 * a new identity was to delete files and reinstall. This is the supported way to
 * do it from the UI, with no restart and no file surgery.
 *
 * The in-memory mesh state (the dispatcher's registry, tasks and mesh key) is
 * NOT touched here; the caller resets that via `SwarmDispatcher.resetIdentity()`
 * so the two concerns stay in their own layer.
 */
export function regenerateNodeCode(): NodeIdentity {
  const identity: NodeIdentity = {
    code: generateNodeCode(),
    createdAt: new Date().toISOString(),
  };
  persist({
    NODE_CODE: identity.code,
    NODE_CREATED_AT: identity.createdAt,
    ...IDENTITY_ASSOCIATIONS,
  });
  console.log(`[NodeCode] Regenerated node code: ${identity.code} (mesh associations cleared)`);
  return identity;
}

/**
 * Adopts an operator-chosen code, clearing associations exactly as
 * {@link regenerateNodeCode} does.
 *
 * Throws when the value is not a well-formed code rather than silently minting a
 * different one: the operator typed something specific, and quietly substituting
 * a random code would leave them reading a code that is not the one they set.
 */
export function setNodeCode(value: string): NodeIdentity {
  const code = normalizeNodeCode(value);
  if (!code) {
    throw new Error(
      `"${String(value ?? "").trim()}" is not a valid node code. Use the RIPPA-XXXX-XXXX form.`,
    );
  }
  const createdAt = new Date().toISOString();
  persist({
    NODE_CODE: code,
    NODE_CREATED_AT: createdAt,
    ...IDENTITY_ASSOCIATIONS,
  });
  console.log(`[NodeCode] Node code set to ${code} (mesh associations cleared)`);
  return { code, createdAt };
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

/**
 * Replaces the active mesh key with one supplied by Rippa AI.
 *
 * THE OLD KEY IS RETAINED, not discarded. A rotation is almost never atomic
 * across a fleet: satellites are polling on a 10s interval, so between the
 * Master's key changing and each satellite's next heartbeat there is a window
 * in which nodes are holding a key this node no longer accepts. Keeping the
 * predecessor lets {@link classifyMeshKey} recognise those nodes as "stale"
 * instead of "stranger" and hand them the new key, which is what turns a
 * rotation from a fleet-wide outage into a silent, self-healing update.
 *
 * @returns true when the active key actually changed (a no-op rotation is not
 *          re-broadcast, so the fleet is not woken for nothing).
 */
export function rotateMeshKey(key: string, issuedBy: string): boolean {
  const next = key.trim();
  const current = getMeshKey();
  if (!next || next === current) return false;
  persist({
    MESH_KEY: next,
    MESH_KEY_ISSUER: issuedBy,
    MESH_KEY_PREVIOUS: current,
    MESH_KEY_ROTATED_AT: new Date().toISOString(),
  });
  return true;
}

/** Keys Rippa AI has explicitly withdrawn. */
export function getRevokedMeshKeys(): string[] {
  const raw = read()?.MESH_KEY_REVOKED;
  return Array.isArray(raw) ? raw.filter((key): key is string => typeof key === "string") : [];
}

/**
 * Records keys the cloud withdrew, so a node presenting one is never silently
 * upgraded to the active key.
 *
 * A revoked key is a deliberate decision by Rippa AI that a credential should
 * stop working. Quietly repairing it would override that decision, so the
 * revoked list is treated as terminal — see {@link classifyMeshKey}.
 */
export function revokeMeshKeys(keys: string[]): string[] {
  const cleaned = keys.map((key) => key.trim()).filter((key) => key.length > 0);
  if (cleaned.length === 0) return getRevokedMeshKeys();
  const merged = [...new Set([...getRevokedMeshKeys(), ...cleaned])];
  persist({ MESH_KEY_REVOKED: merged });
  return merged;
}

/** How the Master classified a key a satellite presented. */
export type MeshKeyStatus =
  /** The key is the active one. */
  | "valid"
  /** The key was rotated out but is still inside the grace window. */
  | "stale"
  /** Rippa AI withdrew this key; the node must re-authenticate, not upgrade. */
  | "revoked"
  /** Nothing about this key is recognised. */
  | "unknown"
  /** No key was presented at all. */
  | "missing";

/**
 * How long a rotated-out key keeps identifying its holder.
 *
 * Long enough to cover several missed poll cycles on a flaky LAN link, short
 * enough that the predecessor is not a permanent second valid credential. The
 * key is only ever used to RECOGNISE a returning node and hand it the new key —
 * it never authorises a request on its own, so this window carries no extra
 * access.
 */
export const MESH_KEY_GRACE_MS = 30 * 60_000;

/**
 * Classifies a presented mesh key.
 *
 * THE POINT OF THE DISTINCTION. Before this existed the Master could only answer
 * "valid" or "not valid", so every satellite holding a rotated-out key looked
 * identical to a stranger probing the port, and both got the same silent 401.
 * Separating `stale` from `unknown` is what lets the mesh heal a legitimate node
 * automatically while still refusing to hand the fleet key to anyone who cannot
 * show they ever held one.
 */
export function classifyMeshKey(candidate: string | undefined): MeshKeyStatus {
  const presented = String(candidate ?? "").trim();
  if (!presented) return "missing";
  if (verifyMeshKey(presented)) return "valid";

  if (getRevokedMeshKeys().includes(presented)) return "revoked";

  const stored = read();
  const previous = (stored?.MESH_KEY_PREVIOUS || "").trim();
  if (previous && previous === presented) {
    const rotatedAt = Date.parse(stored?.MESH_KEY_ROTATED_AT || "") || 0;
    // A previous key with no rotation timestamp is not trusted: without the age
    // there is no way to know it is still inside the grace window.
    if (rotatedAt > 0 && Date.now() - rotatedAt <= MESH_KEY_GRACE_MS) return "stale";
  }
  return "unknown";
}

/**
 * Drops sibling endpoints for node codes that are no longer part of the mesh.
 *
 * WHY PURGE RATHER THAN MARK. A revoked or stale peer left in PEER_MESH keeps
 * appearing in the dashboard's peer list and in every provisioning payload,
 * which is how a fleet ends up showing nodes that were removed weeks ago. The
 * Master is the sole authority on fleet membership, so when it says a code is
 * gone, the endpoint is removed outright rather than flagged.
 *
 * @returns the codes that were actually removed, for logging and the UI.
 */
export function purgePeerMesh(nodeCodes: Iterable<string>): string[] {
  const drop = new Set<string>();
  for (const raw of nodeCodes) {
    const code = normalizeNodeCode(raw);
    if (code) drop.add(code);
  }
  if (drop.size === 0) return [];

  const self = currentNodeIdentity()?.code ?? "";
  const kept = listPeers().filter(
    (peer) => !drop.has(peer.nodeCode) && peer.nodeCode !== self,
  );
  const removed = [...drop].filter((code) => code !== self);
  persist({ PEER_MESH: kept });
  return removed;
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
 * MASTER-SIDE REGISTRY PERSISTENCE.
 *
 * The satellite registry (codes, names, endpoints, metrics) lived only in the
 * dispatcher's memory, so every Master restart erased the Swarm Grid and
 * emptied the `connected_satellites` list reported to the Mothership — the cloud
 * then saw a healthy Master with no fleet, which is indistinguishable from one
 * that never had any. It is written alongside the mesh key in config.json so the
 * fleet survives a restart and a crash alike.
 */

/** One persisted satellite. Deliberately minimal — see the caller's docblock. */
export interface PersistedSatelliteRecord {
  nodeCode: string;
  nodeName: string;
  endpoint: PeerEndpoint;
  p2pEnabled: boolean;
  completedTaskIds: string[];
  metrics: Record<string, unknown>;
}

/** Writes the registry, preserving every other config field (see `persist`). */
export function saveRegistry(records: PersistedSatelliteRecord[]): void {
  persist({ SATELLITE_REGISTRY: records });
}

/** Reads the persisted registry, dropping any entry with an invalid code. */
export function loadRegistry(): PersistedSatelliteRecord[] {
  const raw = read()?.SATELLITE_REGISTRY;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (entry): entry is PersistedSatelliteRecord =>
      Boolean(entry) && typeof entry === "object" && isValidNodeCode((entry as PersistedSatelliteRecord).nodeCode),
  );
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