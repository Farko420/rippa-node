import crypto from "node:crypto";
import { env } from "../config";
import {
  DEFAULT_DASHBOARD_PIN,
  DEFAULT_MOTHERSHIP_URL,
  DEFAULT_OLLAMA_URL,
  DEFAULT_PORT,
  normalizeConfig,
  type NodeRole,
  type RippaNodeConfig,
} from "../config/configManager";
import { currentNodeIdentity, getMeshKey } from "../config/nodeAuth";
import { generateNodeCode, normalizeNodeCode } from "../config/nodeCode";
import {
  GITHUB_REPO,
  PROVISION_PLATFORMS,
  releaseAssetExtensionsForPlatform,
  releaseAssetNamesForPlatform,
  releaseDownloadUrl,
  resolveGitHubAssetDownload,
  type ProvisionPlatform,
} from "../update/githubAsset";
import { createZipArchive } from "../utils/zipArchive";

/**
 * NODE PROVISIONING BUNDLE — one downloadable .zip that turns a blank machine
 * into a joined member of the fleet.
 *
 * WHAT IT PRODUCES, and why both halves are needed:
 *
 *   1. the platform's RELEASE ARTEFACT, fetched from the same GitHub release the
 *      fleet's own OTA already installs from — `rippa-node.exe` for Windows,
 *      the signed APK for Android;
 *   2. a generated `config.json` carrying the identity, the mesh credential and
 *      the Master's address, so the new node boots CONFIGURED instead of
 *      dropping the operator on the Setup screen.
 *
 * THE FLOW IS IDENTICAL FOR EVERY PLATFORM, which is the whole point of this
 * module existing rather than a second code path bolted into the endpoint:
 * resolve asset → download bytes → verify the bytes are what they claim to be →
 * generate config → zip. Only two things vary per platform, and both are
 * declared as data in `update/githubAsset.ts` (the asset names to prefer and
 * the extension that counts as a real artefact). Adding a third target is a
 * one-line change there, not a new branch here.
 *
 * WHY THE DOWNLOAD GOES THROUGH THE ASSET RESOLVER. A node's release repository
 * is private, and `.../releases/latest/download/<name>` answers 404 to every
 * anonymous request on a private repo — indistinguishable from a missing asset.
 * {@link resolveGitHubAssetDownload} upgrades that shortcut to GitHub's
 * authenticated asset API when a token is configured, and degrades to the
 * public URL when one is not, which is exactly right for a public repo.
 */

/** Every platform the endpoint accepts. Re-exported for the route layer. */
export const SUPPORTED_PROVISION_PLATFORMS: readonly ProvisionPlatform[] = PROVISION_PLATFORMS;

/**
 * Normalises whatever the caller called the platform into a supported value.
 *
 * ALIASES ARE ACCEPTED BECAUSE OPERATORS USE THE HOST'S VOCABULARY. `win32` is
 * what `process.platform` reports, `apk` is what the artefact is called, and
 * `android`/`windows` are what the docs say — all four mean the same target, and
 * rejecting `win32` with "unsupported platform" would be pedantry that costs an
 * operator a support round-trip. Anything genuinely unknown returns `null` so
 * the route can name the supported set in its error rather than guess.
 */
export function normalizeProvisionPlatform(value: unknown): ProvisionPlatform | null {
  const raw = String(value ?? "")
    .trim()
    .toLowerCase();
  if (!raw) return null;
  if (raw === "win32" || raw === "win" || raw === "windows" || raw === "exe") return "windows";
  if (raw === "android" || raw === "apk") return "android";
  return null;
}

/** True when `value` names a supported provisioning platform. */
export function isProvisionPlatform(value: unknown): value is ProvisionPlatform {
  return normalizeProvisionPlatform(value) !== null;
}

/** Everything the caller may override when generating a bundle. */
export interface ProvisionNodeInput {
  /** Target platform. Already normalised by {@link normalizeProvisionPlatform}. */
  platform: ProvisionPlatform;
  /** Display name for the new node. Defaults to a platform-appropriate label. */
  nodeName?: string;
  /** Pre-allocated node code. Minted when absent or malformed. */
  nodeCode?: string;
  /** Role for the new node. Defaults to `satellite`. */
  role?: NodeRole;
  /** Base URL of the Master the new node should report to. */
  masterUrl?: string;
  /** Mothership base URL. Defaults to this node's own. */
  mothershipUrl?: string;
  /** LAN dashboard passkey for the new node. */
  dashboardPin?: string;
  /** Explicit mesh key to seed. Defaults to this Master's current key. */
  meshKey?: string;
  /** Seed the pairing record so the new node joins without a handshake. */
  pairWithMaster?: boolean;
  /** This Master's node code, recorded as the mesh key issuer. */
  masterCode?: string;
}

/** A finished bundle, ready to be written to an HTTP response. */
export interface ProvisionNodeBundle {
  /** Platform this bundle targets. */
  platform: ProvisionPlatform;
  /** The release asset's real filename, as published on GitHub. */
  assetName: string;
  /** The URL the bytes were fetched from (authenticated when possible). */
  sourceUrl: string;
  /** Suggested download filename for the zip. */
  filename: string;
  /** The generated node configuration, exactly as it is written into the zip. */
  config: RippaNodeConfig;
  /** The archive itself. */
  bytes: Buffer;
}

/**
 * Magic-byte checks per platform, mirroring the OTA updater's PE guard.
 *
 * A release can answer 200 with an HTML error page, a JSON rate-limit body or a
 * redirect body, and any of those would be happily zipped and handed to an
 * operator as "the node". Checking the first bytes turns that from a mystery
 * failure on the target machine into a named one here.
 */
const ARTEFACT_MAGIC: Record<ProvisionPlatform, { magic: number[]; label: string }> = {
  // "MZ" — the DOS header every Windows PE starts with.
  windows: { magic: [0x4d, 0x5a], label: "a Windows executable (MZ)" },
  // "PK\x03\x04" — an APK is a zip, so this is what a real one starts with.
  android: { magic: [0x50, 0x4b, 0x03, 0x04], label: "an APK (PK zip header)" },
};

/** True when `bytes` starts with the platform's expected magic number. */
export function looksLikePlatformArtefact(platform: ProvisionPlatform, bytes: Buffer): boolean {
  const { magic } = ARTEFACT_MAGIC[platform];
  if (bytes.length < magic.length) return false;
  return magic.every((byte, index) => bytes[index] === byte);
}

/** Download timeout. An asset is tens of megabytes; this is generous, not idle. */
const DOWNLOAD_TIMEOUT_MS = 5 * 60_000;

/**
 * The `config.json` a freshly provisioned node should boot with.
 *
 * WHY IT IS BUILT THROUGH `normalizeConfig` RATHER THAN ASSEMBLED BY HAND.
 * `normalizeConfig` is the single definition of what a valid config file is, and
 * `writeConfig` (what the node itself uses) writes exactly its output. Hand-
 * building the JSON here would create a second, drifting definition — the first
 * field added to the real config would be missing from every provisioned node,
 * and the symptom would be "new nodes behave differently to old ones" with no
 * obvious cause. Building through the normaliser means a provisioned file is
 * byte-compatible with one the Setup screen wrote.
 */
export function buildProvisionConfig(input: ProvisionNodeInput): {
  config: RippaNodeConfig;
  nodeCode: string;
} {
  const role: NodeRole = input.role === "master" ? "master" : "satellite";
  const nodeCode = normalizeNodeCode(input.nodeCode) || generateNodeCode();
  const now = new Date().toISOString();

  // A satellite is useless without somewhere to report, so the Master URL is
  // taken from the request first and only then from this node's own setting —
  // which is correct when this IS the Master, and a documented limitation when
  // it is not (see the endpoint's docs).
  const masterUrl =
    (input.masterUrl || "").trim() || env.MASTER_LOCAL_URL || `http://127.0.0.1:${DEFAULT_PORT}`;

  // The mesh key is what makes the node trusted on arrival. `pairWithMaster:
  // false` deliberately leaves it blank so the new node goes through the normal
  // one-time handshake instead of being pre-authorised — the difference between
  // "shipped ready to join" and "shipped ready to ask".
  const wantsPairing = input.pairWithMaster !== false;
  const masterCode = normalizeNodeCode(input.masterCode) || currentNodeIdentity()?.code || "";
  const meshKey = wantsPairing ? (input.meshKey || "").trim() || getMeshKey() : "";

  const config = normalizeConfig({
    NODE_ROLE: role,
    NODE_NAME: (input.nodeName || "").trim() || `Rippa ${role === "master" ? "Master" : "Satellite"}`,
    // A per-node API key, minted here rather than copied from this node: two
    // nodes sharing a credential would make every fleet-wide revocation a
    // fleet-wide outage.
    NODE_API_KEY: crypto.randomBytes(32).toString("hex"),
    MOTHERSHIP_URL: (input.mothershipUrl || "").trim() || env.MOTHERSHIP_URL || DEFAULT_MOTHERSHIP_URL,
    MASTER_LOCAL_URL: masterUrl,
    OLLAMA_URL: DEFAULT_OLLAMA_URL,
    PORT: DEFAULT_PORT,
    DASHBOARD_PIN: (input.dashboardPin || "").trim() || DEFAULT_DASHBOARD_PIN,
    NODE_CODE: nodeCode,
    NODE_CREATED_AT: now,
    ...(meshKey ? { MESH_KEY: meshKey } : {}),
    ...(meshKey && masterCode ? { MESH_KEY_ISSUER: masterCode } : {}),
    ...(wantsPairing && masterCode
      ? {
          PAIRED_MASTER_CODE: masterCode,
          PAIRED_MASTER_URL: masterUrl,
          PAIRED_MASTER_AT: now,
        }
      : {}),
  });

  return { config, nodeCode };
}

/**
 * The plain-text install notes shipped beside the artefact.
 *
 * WHY NOTES AND NOT JUST THE TWO FILES. The Android half of this bundle is not
 * double-clickable: an APK has to be sideloaded, and the operator has to have
 * enabled installation from unknown sources for it to take. A zip containing
 * `config.json` and an `.apk` with no instructions is a support ticket, so the
 * exact steps — and where the config has to end up, which differs per platform —
 * travel with the bundle.
 */
export function installNotes(
  platform: ProvisionPlatform,
  assetName: string,
  nodeCode: string,
): string {
  const common = [
    "RIPPA NODE — PROVISIONING BUNDLE",
    "",
    `Node code : ${nodeCode}`,
    `Platform  : ${platform}`,
    `Artefact  : ${assetName}`,
    `Generated : ${new Date().toISOString()}`,
    "",
    "The config.json in this archive already carries this node's identity, mesh",
    "credential and Master address. Install it BEFORE the first launch — a node",
    "that boots without it will open its own Setup screen instead.",
    "",
  ];

  const perPlatform: Record<ProvisionPlatform, string[]> = {
    windows: [
      "WINDOWS",
      "",
      "  1. Put the .exe and config.json in the SAME folder.",
      "  2. Run the .exe once by hand to confirm it reports Online.",
      "  3. Optional: install the watchdog to start it automatically at logon.",
      "",
      "  The node keeps its data in a `data` folder BESIDE THE EXE, and reads",
      "  config.json from there. On first boot it copies the config.json shipped",
      "  in this bundle into that folder; from then on `data\\config.json` is the",
      "  one it uses. Keep the whole folder together when you move or back it up.",
      "",
      "  This is a local setting: the node owns it, and it can be changed any time",
      "  from the dashboard's Local Storage panel.",
      "",
    ],
    android: [
      "ANDROID",
      "",
      "  1. Copy the .apk to the device (USB, adb push, or a shared folder).",
      "  2. Enable installing from unknown sources for the app doing the install.",
      "  3. Sideload it:",
      "",
      `       adb install -r ${assetName}`,
      "",
      "  4. Place config.json in the app's data directory before first launch:",
      "",
      "       /sdcard/Android/data/com.rippaadventures.node/files/config.json",
      "",
      "     or push it directly:",
      "",
      "       adb push config.json /sdcard/Android/data/com.rippaadventures.node/files/",
      "",
      "  On first boot the app copies that file into ~/.rippa-node, the persistent",
      "  location every OTA update leaves untouched.",
      "",
    ],
  };

  return [...common, ...perPlatform[platform]].join("\n");
}

/**
 * Resolves, downloads and bundles one node for `input.platform`.
 *
 * The four steps are the same for every platform (see the module header); the
 * only per-platform inputs are the asset names and the extension fallback, both
 * of which come from `update/githubAsset`.
 *
 * Throws with an operator-readable message on every failure path — a missing
 * asset, a transport failure, a non-artefact body — because the route turns that
 * message straight into the JSON error an operator reads.
 */
export async function buildNodeProvisionBundle(
  input: ProvisionNodeInput,
): Promise<ProvisionNodeBundle> {
  const platform = input.platform;
  const assetNames = releaseAssetNamesForPlatform(platform);
  const assetExtensions = releaseAssetExtensionsForPlatform(platform);

  // 1. RESOLVE. The public shortcut URL is the starting point; the resolver
  //    upgrades it to GitHub's authenticated asset API when a token exists, and
  //    leaves it alone when it does not (correct for a public repo).
  const shortcut = releaseDownloadUrl(GITHUB_REPO, assetNames[0]);
  const diagnostics: string[] = [];
  const authenticated = await resolveGitHubAssetDownload(shortcut, {
    logPrefix: "[Provision]",
    diagnostics,
    assetNames,
    assetExtensions,
  });
  const target = authenticated ?? { url: shortcut, headers: {} as Record<string, string> };
  const sourceUrl = target.url;

  // 2. DOWNLOAD. `redirect: "follow"` is required: GitHub answers the asset API
  //    with a 302 to a signed CDN URL, and the bytes only exist at the far end.
  let bytes: Buffer;
  try {
    const response = await fetch(sourceUrl, {
      redirect: "follow",
      headers: {
        // A browser-ish UA rather than the API Accept header: this request may
        // land on github.com or on the CDN the API redirected to, and only the
        // API endpoint understands `application/vnd.github+json`.
        "User-Agent": "rippa-node-provisioner",
        Accept: "application/octet-stream",
        ...target.headers,
      },
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(
        `GitHub answered HTTP ${response.status} ${response.statusText} for ${sourceUrl}. ` +
          diagnostics.join(" "),
      );
    }
    bytes = Buffer.from(await response.arrayBuffer());
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Could not download the ${platform} release artefact ` +
        `(${assetNames.join(", ")}): ${reason}`,
    );
  }

  // 3. VERIFY. A 200 is not proof of an artefact — see ARTEFACT_MAGIC.
  if (!looksLikePlatformArtefact(platform, bytes)) {
    throw new Error(
      `The download for ${platform} is not ${ARTEFACT_MAGIC[platform].label} ` +
        `(${bytes.length} bytes from ${sourceUrl}). The release may have published an ` +
        "error page, or the asset name may point at a different platform's build.",
    );
  }

  // 4. GENERATE + ZIP, through the exact same flow for both platforms.
  const { config, nodeCode } = buildProvisionConfig(input);
  const assetName = authenticated?.assetName || assetNames[0];
  const when = new Date();

  const archive = createZipArchive(
    [
      // The binary is already a compressed artefact, so it is STORED: deflating
      // 100 MB of it would cost seconds of a synchronous request for nothing.
      { name: assetName, data: bytes },
      {
        name: "config.json",
        data: `${JSON.stringify(config, null, 2)}\n`,
        compress: true,
      },
      {
        name: "PROVISION.txt",
        data: installNotes(platform, assetName, nodeCode),
        compress: true,
      },
    ],
    { when },
  );

  return {
    platform,
    assetName,
    sourceUrl,
    filename: `rippa-node-${platform}-${nodeCode}.zip`,
    config,
    bytes: archive,
  };
}

