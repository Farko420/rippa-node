import { APP_VERSION } from "../version";
import { getSystemVitals } from "./telemetry";
import { buildStorageProfile } from "./storageConfig";
import { describeCapabilities } from "./nodeCapabilities";
import { runtimeCapabilities, supportsBrowserScraping } from "../platform";
import { ensureNodeIdentity } from "../config/nodeAuth";
import { env } from "../config";

/**
 * THE NODE'S STATIC HARDWARE / STORAGE PROFILE — what this machine IS.
 *
 * WHY THIS EXISTS. The heartbeat is a live pulse: CPU, RAM, the task in flight,
 * the storage it is *currently* using. Nothing in it says "this machine's storage
 * question is settled", so a Mothership looking at a healthy node had no way to
 * tell it apart from one whose drive had never been chosen — and the remedy it
 * reached for was to queue a `system_update_storage`. On a node that had no
 * usable payload to hand it, that command came back as a failure and the fleet
 * board showed a broken node that was in fact perfectly fine.
 *
 * This profile is the answer, sent ONCE at boot via
 * `POST /api/swarm/submit`: a declaration of the machine's fixed properties,
 * including the data directory the node has already chosen for itself
 * (`buildStorageProfile` → `storage_configured: true`, `storage_resolved: true`).
 * Storage is reported as RESOLVED because it always is: the node either has an
 * operator-chosen folder or falls back to its hardcoded local `./data`.
 *
 * DELIBERATELY STATIC. Everything here is either immutable for the life of the
 * process (platform, cores, total RAM) or read fresh from disk at call time
 * (identity, storage configuration). It is a snapshot, not a telemetry stream —
 * the heartbeat already carries the live numbers, and duplicating them here would
 * just create two sources of truth that can disagree.
 *
 * A FAILURE HERE IS NEVER FATAL. `SwarmClient.submitProfile` resolves to false
 * on any transport error, and the caller logs and continues: an unreachable
 * Mothership must not cost the node its boot.
 */
export interface NodeProfile {
  /** Discriminator, so the cloud can route this record by kind. */
  kind: "node_profile";
  /** Stable `RIPPA-XXXX-XXXX` identity, minted and persisted on first boot. */
  nodeCode: string;
  nodeName: string;
  role: string;
  /** The build this node is running. */
  version: string;
  /** ISO timestamp this profile was assembled. */
  reportedAt: string;
  /** Coarse runtime family: `node`, `restricted` or `webview`. */
  runtime: string;
  platform: string;
  /** True when the build can drive headless Chromium. */
  browserScraping: boolean;
  /** Static machine properties the Mothership can plan work against. */
  hardware: {
    cpu_cores: number;
    ram_total_bytes: number;
    platform: string;
    runtime: string;
  };
  /**
   * The capability block the AI mesh reads (`aiEnabled` tri-state, models,
   * scraping mode). Same shape as `POST /api/swarm/capabilities`, repeated here
   * so one boot-time record describes the whole node.
   */
  capabilities: Record<string, unknown>;
  /** THE STORAGE DECLARATION — see `storageConfig.buildStorageProfile`. */
  storage_configured: true;
  storage_resolved: true;
  storage_data_dir: string;
  storage_directory: string;
  data_directory: string;
  data_dir: string;
  scratch_capacity_gb: number | null;
  vault_capacity_gb: number | null;
  safe_vault_capacity_gb: number | null;
  storage_capacities_resolved: boolean;
}

/**
 * Assembles this node's static profile. Never throws: every source degrades to a
 * safe value so a misbehaving provider cannot cost the node its boot handshake.
 */
export function buildNodeProfile(): NodeProfile {
  const caps = runtimeCapabilities();
  let vitals: { cpu_cores: number; ram_total_bytes: number } = {
    cpu_cores: 0,
    ram_total_bytes: 0,
  };
  try {
    const sample = getSystemVitals();
    vitals = { cpu_cores: sample.cpu_cores, ram_total_bytes: sample.ram_total_bytes };
  } catch {
    /* a vitals failure must not stop the profile being sent */
  }

  let nodeCode = "";
  try {
    nodeCode = ensureNodeIdentity().code;
  } catch {
    /* an identity failure is reported by the heartbeat path instead */
  }

  let capabilities: Record<string, unknown> = {};
  try {
    capabilities = { ...describeCapabilities() } as Record<string, unknown>;
  } catch {
    /* capabilities are also registered separately via /api/swarm/capabilities */
  }

  return {
    kind: "node_profile",
    nodeCode,
    nodeName: env.NODE_NAME,
    role: env.NODE_ROLE,
    version: APP_VERSION,
    reportedAt: new Date().toISOString(),
    runtime: caps.description,
    platform: caps.platform,
    browserScraping: supportsBrowserScraping(),
    hardware: {
      cpu_cores: vitals.cpu_cores,
      ram_total_bytes: vitals.ram_total_bytes,
      platform: caps.platform,
      runtime: caps.description,
    },
    capabilities,
    ...buildStorageProfile(),
  };
}
