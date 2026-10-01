/**
 * MESH KEY SYNC — reading Rippa AI's key-rotation directive.
 *
 * WHY A SEPARATE MODULE. The Mothership heartbeat reply is already parsed for
 * three different things (an update advertisement, a pending-command queue and
 * a pushed task batch). Key rotation is a fourth, and it is the only one that
 * mutates persisted authentication state, so it gets its own file and its own
 * parser rather than another branch in the middle of `sendHeartbeat`.
 *
 * THE SHAPE IS NOT FIXED. The Mothership is a separate deployment that will
 * evolve its own field names, and this node ships to tablets and machines it
 * does not control. So the parser accepts every reasonable spelling the directive
 * has plausibly taken, unwraps the common envelopes, and — critically — returns
 * null rather than guessing. A parser that "helpfully" picked a key out of an
 * unrecognised payload would be able to rotate the whole fleet's credential off
 * a field name it invented.
 */

/**
 * A rotation instruction from Rippa AI.
 *
 * Only `meshKey` is an instruction to change credential. The other fields are
 * corrections to the fleet's membership, and each is applied independently: a
 * reply that revokes peers without rotating the key is just as meaningful as
 * one that does both.
 */
export interface MeshKeySyncDirective {
  /** The new active swarm connection key. */
  meshKey: string;
  /** Node code of the issuer, recorded for diagnostics. */
  issuedBy?: string;
  /** Keys the cloud has withdrawn; never auto-upgraded. */
  revokedKeys: string[];
  /** Node codes the cloud says are no longer members of the swarm. */
  revokedNodes: string[];
}

/** Envelope keys that commonly wrap the real directive. */
const DIRECTIVE_ENVELOPES = [
  "mesh_key_sync",
  "meshKeySync",
  "mesh_sync",
  "meshSync",
  "key_sync",
  "keySync",
  "mesh",
  "swarm",
  "fleet",
  "auth",
  "data",
] as const;

/** Field names the active key has plausibly travelled under. */
const KEY_FIELDS = [
  "meshKey",
  "mesh_key",
  "swarmKey",
  "swarm_key",
  "connectionKey",
  "connection_key",
  "key",
] as const;

/** Field names for the list of withdrawn keys. */
const REVOKED_KEY_FIELDS = [
  "revokedKeys",
  "revoked_keys",
  "withdrawnKeys",
  "withdrawn_keys",
  "invalidKeys",
  "invalid_keys",
] as const;

/** Field names for the list of node codes the cloud no longer recognises. */
const REVOKED_NODE_FIELDS = [
  "revokedNodes",
  "revoked_nodes",
  "unregisteredNodes",
  "unregistered_nodes",
  "removedNodes",
  "removed_nodes",
  "staleNodes",
  "stale_nodes",
] as const;
/**
 * Reads a string field, tolerating the `{value: ...}` wrapper some deployments
 * use for scalars. Returns "" when absent or not a usable string.
 */
function readString(source: Record<string, unknown>, fields: readonly string[]): string {
  for (const field of fields) {
    const raw = source[field];
    if (typeof raw === "string" && raw.trim().length > 0) return raw.trim();
    // `key: { value: "…" }` — a scalar modelled as an object.
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      const nested = (raw as Record<string, unknown>)["value"];
      if (typeof nested === "string" && nested.trim().length > 0) return nested.trim();
    }
  }
  return "";
}

/**
 * Collects strings from a field that may be a list, a single string, or a list
 * of `{nodeCode}` / `{code}` objects.
 *
 * Objects are accepted because a revoked-node list is far more useful to the
 * cloud as records than as bare strings — it wants to say WHICH node and WHY —
 * and this node only needs the code.
 */
function readStringList(source: Record<string, unknown>, fields: readonly string[]): string[] {
  for (const field of fields) {
    const raw = source[field];
    if (typeof raw === "string" && raw.trim().length > 0) return [raw.trim()];
    if (!Array.isArray(raw)) continue;

    const collected: string[] = [];
    for (const entry of raw) {
      if (typeof entry === "string" && entry.trim().length > 0) {
        collected.push(entry.trim());
        continue;
      }
      if (entry && typeof entry === "object") {
        const record = entry as Record<string, unknown>;
        const code = readString(record, ["nodeCode", "node_code", "code", "node"]);
        if (code) collected.push(code);
      }
    }
    if (collected.length > 0) return collected;
  }
  return [];
}

/**
 * Finds the object that actually holds the directive.
 *
 * Checks the payload itself first, then each known envelope. Returns null when
 * nothing recognisable is present, which is the normal case — most heartbeats
 * carry no rotation instruction at all, and that must stay a no-op.
 */
function findDirectiveContainer(payload: unknown): Record<string, unknown> | null {
  if (!payload || typeof payload !== "object") return null;
  const root = payload as Record<string, unknown>;

  const hasField =
    KEY_FIELDS.some((field) => root[field] !== undefined) ||
    REVOKED_KEY_FIELDS.some((field) => root[field] !== undefined) ||
    REVOKED_NODE_FIELDS.some((field) => root[field] !== undefined);

  // The directive may sit at the top level.
  if (hasField) return root;

  for (const envelope of DIRECTIVE_ENVELOPES) {
    const nested = root[envelope];
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      return nested as Record<string, unknown>;
    }
  }
  return null;
}

/**
 * Extracts a key-rotation directive from a Mothership heartbeat reply.
 *
 * Returns null for the overwhelmingly common case of "no instruction here",
 * including when a `key`-named field holds something that is obviously not a
 * credential (a status word, a boolean, a nested object with no string inside).
 * Callers therefore treat null as "change nothing", which is the safe default:
 * a parser that could not understand the payload must never be able to rotate
 * the fleet's authentication key.
 */
export function parseMeshKeySync(payload: unknown): MeshKeySyncDirective | null {
  const container = findDirectiveContainer(payload);
  if (!container) return null;

  const meshKey = readString(container, KEY_FIELDS);
  const revokedKeys = readStringList(container, REVOKED_KEY_FIELDS);
  const revokedNodes = readStringList(container, REVOKED_NODE_FIELDS);

  if (!meshKey && revokedKeys.length === 0 && revokedNodes.length === 0) return null;

  const issuedBy = readString(container, [
    "issuedBy",
    "issued_by",
    "masterCode",
    "master_code",
    "issuer",
  ]);
  return {
    meshKey,
    ...(issuedBy ? { issuedBy } : {}),
    revokedKeys,
    revokedNodes,
  };
}