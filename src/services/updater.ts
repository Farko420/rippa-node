import axios from "axios";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { APP_VERSION, isVersionNewer, isVersionOlder } from "../version";
import { ensureNodeIdentity } from "../config/nodeAuth";
import type { PeerEndpoint } from "../config/nodeAuth";
import type { SwarmDispatcher } from "./swarmDispatcher";
import {
  HANDOFF_STAMP,
  PARTIAL_SUFFIX,
  TEMP_UPDATE_FILE,
  claimHandoffSlot,
  completeHandoff,
  currentExecutable,
  installDir,
  isPackagedExe,
  releaseHandoffClaim,
  stagingDir,
} from "../update/swapHandoff";

export { claimHandoffSlot, releaseHandoffClaim, isPackagedExe, installDir };

/**
 * AUTONOMOUS OTA SWARM UPDATER.
 *
 * The GitHub half of the zero-touch update loop, and the layer that rolls the
 * whole fleet rather than just one machine.
 *
 * Flow:
 *   1. BUILD     — `.github/workflows/build-node.yml` compiles `rippa-node.exe`
 *                  on every push to `main` and publishes it to the rolling
 *                  `latest` GitHub Release.
 *   2. POLL      — every 60 minutes the Master asks GitHub for the latest
 *                  release and compares its tag against the local version.
 *   3. SELF      — on a newer build the Master downloads `temp_update.exe` into
 *                  the persistent data directory.
 *   4. BROADCAST — the Master walks every ONLINE satellite in the swarm registry
 *                  and sends it a `SWARM_UPDATE_TRIGGER` carrying the release
 *                  version and the download URL.
 *   5. SWAP      — each satellite downloads and verifies the build, then hands
 *                  off: under the Watchdog it exits 43 and the watchdog swaps
 *                  the binary and boots it; a standalone install keeps the
 *                  detached `update.bat` path.
 *
 * WHY THE HANDOFF IS A SUPERVISOR DECISION: Windows keeps a running .exe mapped
 * and locked, so a Node process cannot replace its own binary. The Watchdog is a
 * second process that is not locked against the executable, so it can. The
 * legacy batch script remains for installs with no watchdog; the choice between
 * the two is made once, in `update/swapHandoff`, and both OTA paths call it, so
 * they cannot drift apart again.
 *
 * SECURITY: only a mesh-key authenticated Master can trigger an update on a
 * satellite, so no peer node can force a binary swap on another node.
 *
 * NOTE: the Mothership-driven `OtaUpdater` is a separate, older path. This
 * module is the GitHub + fleet path, and both share the on-disk handoff guard
 * so they can never both exit the process mid-swap.
 */

/**
 * GitHub repository publishing the fleet releases ("owner/name"), the canonical
 * asset name, and the token/header helpers.
 *
 * WHY THESE ARE RE-EXPORTS RATHER THAN DEFINITIONS. `Farko420/rippa-node` is a
 * PRIVATE repository, so the anonymous rules here are load-bearing rather than
 * incidental: `api.github.com` answers 404 for it (deliberately — a private
 * repo's existence is not disclosed), which is indistinguishable from "no
 * releases published", and the node then does nothing forever. The real
 * repository is `Farko420/rippa-node`; the default used to point at
 * `rippaadventures/rippa-node`, which does not exist.
 *
 * The definitions live in `update/githubAsset` so the Mothership-driven
 * `update/OtaUpdater` can authenticate a download without importing this
 * module — which would be a cycle, since this module already imports from
 * `update/`. Re-exported here so both updaters keep one implementation and the
 * existing call sites and tests are unchanged.
 */
export {
  GITHUB_REPO,
  RELEASE_ASSET_NAME,
  currentReleaseAssetName,
  githubHeaders,
  isGitHubUrl,
  releaseDownloadUrl,
  resolveGitHubToken,
} from "../update/githubAsset";

import {
  GITHUB_REPO,
  RELEASE_ASSET_NAME,
  currentReleaseAssetName,
  githubHeaders,
  releaseDownloadUrl,
  resolveGitHubAssetDownload,
  resolveGitHubToken,
} from "../update/githubAsset";

/** How often the Master polls GitHub for a newer release. */
const CHECK_INTERVAL_MS = 60 * 60_000; // hourly
/** Delay before the first check, so boot finishes before a large exe download. */
const FIRST_CHECK_DELAY_MS = 45_000;
/** Streaming timeout — the exe is ~126 MB and links can be slow. */
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
/** An in-flight download is never promoted unless it is at least this large. */
const MIN_UPDATE_BYTES = 1024 * 1024;
/** Sanity ceiling: the exe is ~126 MB, not gigabytes. */
const MAX_UPDATE_BYTES = 1024 * 1024 * 1024;

/** A published GitHub release, reduced to what the fleet actually needs. */
export interface ReleaseInfo {
  /** Release tag, e.g. "v1.0.4". */
  tag: string;
  /** Concrete version parsed from the tag, e.g. "1.0.4". */
  version: string;
  /** Direct download URL for the compiled Windows exe. */
  downloadUrl: string;
  /** Optional hex SHA-256, verified when present. */
  sha256?: string;
  notes?: string;
}

/** Wire command the Master sends to each satellite. */
export const SWARM_UPDATE_TRIGGER = "SWARM_UPDATE_TRIGGER" as const;

/** Minimal shape of a GitHub release asset. */
interface ReleaseAsset {
  name?: string;
  browser_download_url?: string;
  size?: number;
}

/** Reads a version out of a semver-looking string, or null. */
function extractVersion(text: string): string | null {
  const match = /v?(\d+\.\d+\.\d+)/.exec(text);
  return match ? match[1] : null;
}

/**
 * Picks the release asset to download.
 *
 * EXACT NAME FIRST. A release carries every binary this project publishes, and
 * the updater must not simply take whichever `.exe` happens to sort first —
 * `rippa-node.exe` and `rippa-watchdog.exe` are both `.exe`, and picking the
 * wrong one either 404s on download or, worse, installs the supervisor over the
 * worker. So {@link RELEASE_ASSET_NAME} is matched case-insensitively, and only
 * if nothing matches do we fall back to "first `.exe`" — which keeps a
 * hand-renamed asset installable instead of bricking OTA entirely.
 *
 * Exported so the workflow's own verification and the unit tests assert against
 * the same rule the updater runs, rather than a re-implementation of it.
 */
export function selectReleaseAsset(assets: readonly ReleaseAsset[] | undefined): ReleaseAsset | null {
  const list = assets ?? [];
  const usable = list.filter(
    (candidate) =>
      typeof candidate.name === "string" &&
      typeof candidate.browser_download_url === "string" &&
      candidate.browser_download_url,
  );

  const exact = usable.find(
    (candidate) => candidate.name!.toLowerCase() === RELEASE_ASSET_NAME.toLowerCase(),
  );
  if (exact) return exact;

  return usable.find((candidate) => candidate.name!.toLowerCase().endsWith(".exe")) ?? null;
}

/**
 * Parses the GitHub releases payload into the one release we care about.
 *
 * Returns null when the payload has no usable Windows exe, so a half-published
 * or mis-tagged release can never trigger a fleet-wide swap.
 */
export function parseLatestRelease(payload: unknown): ReleaseInfo | null {
  if (!payload || typeof payload !== "object") return null;
  const release = payload as GithubRelease;
  const tag = typeof release.tag_name === "string" ? release.tag_name.trim() : "";
  if (!tag) return null;

  // The workflow publishes to a ROLLING tag ("latest"), which is a moving pointer
  // rather than a version, so the tag alone cannot drive the comparison. Fall
  // back to the version the build stamped into the release name/body. Without this
  // fallback every release is rejected and the fleet never updates.
  const body = typeof release.body === "string" ? release.body : "";
  const version =
    extractVersion(tag) ??
    extractVersion(typeof release.name === "string" ? release.name : "") ??
    extractVersion(body);
  if (!version) {
    console.warn(`[Updater] Release "${tag}" carries no version — ignoring.`);
    return null;
  }

  const asset = selectReleaseAsset(release.assets);
  if (!asset?.browser_download_url) {
    console.warn(
      `[Updater] Release ${tag} has no "${RELEASE_ASSET_NAME}" asset — ignoring. ` +
        "A release must publish that exact filename: " +
        releaseDownloadUrl() +
        " is a literal name lookup and 404s on any other spelling.",
    );
    return null;
  }

  // The workflow publishes the SHA-256 in the release body. Honouring it here is
  // what turns the download-time integrity check from dead code into a real one.
  const sha256 = /sha-?256:\s*`?([0-9a-f]{64})`?/i.exec(body)?.[1];

  return {
    tag,
    version,
    downloadUrl: asset.browser_download_url,
    ...(sha256 ? { sha256: sha256.toLowerCase() } : {}),
    ...(body.trim() ? { notes: body.trim().slice(0, 500) } : {}),
  };
}

/**
 * Fetches the latest release from GitHub.
 *
 * Unauthenticated requests are capped by GitHub at 60/hour, which matches the
 * hourly poll exactly. A token is used when supplied to raise that ceiling and
 * to read a private repo — see {@link resolveGitHubToken} for why the private
 * case is not optional.
 */
export async function fetchLatestRelease(repo = GITHUB_REPO): Promise<ReleaseInfo | null> {
  const headers = githubHeaders();

  /*
    A 404 IS THE NORMAL, EXPECTED ANSWER until the first release is published —
    GitHub says "no such resource", not "something is wrong". But axios rejects
    it as an error, and an unhandled rejection here used to print a raw error
    stack on every poll, which buried the real log output.

    So: swallow the 404 quietly, say so once in plain language, and let every
    OTHER failure (401 rate limit, 5xx, DNS, timeout) keep propagating to the
    caller's catch, which still logs it as a warning.

    The 404 message now also names the two causes that are NOT "wait for the
    first release" — a private repository with no token, and a misspelled
    RIPPA_GITHUB_REPO — because from the node's side those two are
    indistinguishable from an empty release list, and an operator who is told
    only "no releases yet" will never find them.
  */
  let response;
  try {
    response = await axios.get(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers,
      timeout: 20_000,
      // Treat 404 as a value rather than an exception at the HTTP layer too,
      // so axios can never reject this response in the first place.
      validateStatus: (status) => (status === 404 ? true : status >= 200 && status < 300),
    });
  } catch (error) {
    if (axios.isAxiosError(error) && error.response?.status === 404) {
      logNoReleases(repo);
      return null;
    }
    throw error;
  }

  if (response.status === 404) {
    logNoReleases(repo);
    return null;
  }

  return parseLatestRelease(response.data);
}

/** Explains a 404 in terms an operator can act on, rather than "nothing yet". */
function logNoReleases(repo: string): void {
  const token = resolveGitHubToken();
  const privateRepoGuess = token
    ? ""
    : " (no GITHUB_TOKEN / RIPPA_GITHUB_TOKEN is set — a PRIVATE repository 404s every anonymous request)";
  console.log(
    `[Updater] No published releases found for ${repo}${privateRepoGuess}. ` +
      `Expected asset: ${RELEASE_ASSET_NAME} at ${releaseDownloadUrl(repo)}.`,
  );
}

/** Reads the first `count` bytes of a file. */
async function readFirstBytes(filePath: string, count: number): Promise<Buffer> {
  const handle = await fs.promises.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(count);
    const { bytesRead } = await handle.read(buffer, 0, count, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

function describeError(error: unknown): string {
  if (axios.isAxiosError(error)) {
    const status = error.response?.status;
    return status ? `HTTP ${status} — ${error.message}` : error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

/** Minimal shape of the GitHub releases API response. */
interface GithubRelease {
  tag_name?: string;
  name?: string;
  body?: string;
  assets?: ReleaseAsset[];
}

/**
 * AUTONOMOUS OTA SWARM UPDATER (Master poller + fleet broadcaster + self-swap).
 */
export class SwarmUpdater {
  private timer: NodeJS.Timeout | null = null;
  private firstCheck: NodeJS.Timeout | null = null;
  private running = false;
  private updating = false;
  /** Last version attempted, so a broken build is not retried every hour. */
  private lastAttempted: string | null = null;
  /** Latest known release, surfaced to the dashboard. */
  private latest: ReleaseInfo | null = null;

  constructor(private readonly dispatcher: SwarmDispatcher) {}

  /** Starts the hourly poll loop (idempotent). */
  start(): void {
    if (this.running) return;
    this.running = true;
    // A stamp left behind by a crashed attempt must not wedge the node forever.
    // It is cleared HERE, on the boot of the freshly-swapped build — which is
    // precisely when the previous attempt is known to have finished.
    releaseHandoffClaim(path.join(stagingDir(), HANDOFF_STAMP));

    this.firstCheck = setTimeout(() => {
      this.firstCheck = null;
      void this.checkNow();
    }, FIRST_CHECK_DELAY_MS);

    this.timer = setInterval(() => void this.checkNow(), CHECK_INTERVAL_MS);
    this.timer.unref?.();
    console.log(
      `[Updater] GitHub OTA active for ${GITHUB_REPO} — polling every ${CHECK_INTERVAL_MS / 60000} min.`,
    );
  }

  /** Stops the poll loop. Safe to call repeatedly. */
  stop(): void {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.firstCheck) {
      clearTimeout(this.firstCheck);
      this.firstCheck = null;
    }
  }

  /** The release this node most recently saw, for the dashboard. */
  getLatest(): ReleaseInfo | null {
    return this.latest;
  }

  /** Only the Master leads the fleet (satellites are told, they do not poll). */
  private get isLeader(): boolean {
    return this.dispatcher.isMaster;
  }

  /**
   * One full cycle: poll GitHub, and on a newer release update this node and
   * broadcast to every online satellite. Never throws — a failed check must
   * leave the node running its normal tasks.
   *
   * @param force when true, a release that is NOT newer is applied anyway. This
   *   is what an operator's "Force OTA Update" means: repair a node stuck on a
   *   bad build. The unattended path leaves `force` off, so a routine hourly
   *   check can never reinstall the version already running.
   *
   * @param options.allowDowngrade permits installing a release OLDER than the
   *   running build. Never implied by `force` — see the downgrade guard below.
   *
   * @returns true when this node's own swap is committed and the process is
   *          about to exit. False for every other outcome — including "nothing
   *          to do", "already in flight" and "GitHub unreachable" — so a caller
   *          reporting to the fleet never claims a restart that will not happen.
   */
  async checkNow(
    force = false,
    options: { allowDowngrade?: boolean } = {},
  ): Promise<boolean> {
    if (this.updating) {
      console.log("[Updater] An update is already in flight — standing down.");
      return false;
    }
    if (process.env.OTA_ENABLED === "false") {
      console.log("[Updater] Idle — disabled via OTA_ENABLED=false.");
      return false;
    }

    let release: ReleaseInfo | null = null;
    try {
      release = await fetchLatestRelease();
    } catch (error) {
      // 404 is handled inside fetchLatestRelease and returns null, so anything
      // reaching here is a genuine fault (rate limit, 5xx, DNS, timeout) and is
      // still worth a warning line.
      console.warn(`[Updater] GitHub check failed — ${describeError(error)}`);
      return false;
    }
    if (!release) {
      // THE MOST IMPORTANT LOG LINE IN THIS MODULE. A wrong RIPPA_GITHUB_REPO
      // surfaces here as "no releases" rather than as an error, and a node that
      // silently finds nothing is indistinguishable from one ignoring the
      // command. Name the repo so the cause is one glance away.
      console.log(
        `[Updater] No release asset found for ${GITHUB_REPO} — ` +
          "nothing to update. Check RIPPA_GITHUB_REPO if this node was told to update.",
      );
      return false;
    }
    this.latest = release;

    /*
      THE DOWNGRADE GUARD, BEFORE THE VERSION GATE.

      `force` means "install this exact release even though it is the one I am
      already running" — the repair for a corrupt or half-swapped install. It does
      NOT mean "install anything the cloud points at": without this check, a
      `FORCE_UPDATE` on a v1.0.15 node would happily install an advertised
      v1.0.13 and walk the whole swarm backwards. Rolling back is not
      self-repairing the way a failed upgrade is, so it takes an explicit
      `allow_downgrade: true`.

      The comparison is a strict "older than", so re-installing the SAME version
      — the actual point of a forced update — still works.
    */
    const allowDowngrade = options.allowDowngrade === true;
    if (!allowDowngrade && isVersionOlder(release.version, APP_VERSION)) {
      console.warn(
        `[Updater] Refusing to downgrade: the latest release is v${release.version} but this ` +
          `node runs v${APP_VERSION}. Pass allow_downgrade to force it if that is intended.`,
      );
      return false;
    }

    if (!force && !isVersionNewer(release.version)) {
      console.log(`[Updater] Fleet is up to date (v${APP_VERSION}).`);
      return false;
    }
    if (!force && release.version === this.lastAttempted) {
      console.warn(
        `[Updater] v${release.version} already attempted and did not complete — ` +
          "waiting for a newer build.",
      );
      return false;
    }

    this.updating = true;
    this.lastAttempted = release.version;
    try {
      // Update this node first. On success the process exits inside
      // applyToSelf(), so the broadcast below only runs when the local swap was
      // NOT performed (dev mode / already up to date after a partial update).
      const swapped = await this.applyToSelf(release);
      if (swapped) {
        await this.broadcast(release);
      }
      return swapped;
    } finally {
      this.updating = false;
    }
  }

  /**
   * FORCES the update pipeline: fetch the latest release, swap this node's
   * executable, and restart.
   *
   * The distinction from {@link checkNow} matters. `checkNow` is the unattended
   * hourly poll and deliberately refuses to reinstall the running build; an
   * operator's "Force OTA Update" is a repair action and must run even when
   * GitHub is already at this node's version — that is precisely the case where
   * a node is stuck on a corrupt or half-swapped build and the only fix is to
   * put the same good bytes back down.
   *
   * @param options.allowDowngrade permits installing a release OLDER than the
   *          running build. Forcing alone never does; see the guard in
   *          {@link checkNow}.
   *
   * @returns true when a swap is committed. The process exits inside
   *          `applyToSelf`, so in practice this returns only on the refused /
   *          aborted paths; it exists so the caller knows the difference.
   */
  async forceUpdate(options: { allowDowngrade?: boolean } = {}): Promise<boolean> {
    console.log("[Updater] FORCE UPDATE requested by the fleet controller.");
    return this.checkNow(true, options);
  }

  /**
   * MASTER: sends `SWARM_UPDATE_TRIGGER` to every ONLINE satellite.
   *
   * Offline nodes are skipped — they pick up the new release themselves on
   * their next boot, so nothing is lost by not pushing to a machine that is
   * currently unreachable.
   */
  async broadcast(release: ReleaseInfo): Promise<number> {
    if (!this.isLeader) return 0;
    const targets = this.dispatcher.listOnlineSatellites();
    if (targets.length === 0) {
      console.log("[Updater] No online satellites to broadcast to.");
      return 0;
    }

    const meshKey = this.dispatcher.getMeshKeyOrEmpty();
    const results = await Promise.allSettled(
      targets.map((target) => this.postTrigger(target, release, meshKey)),
    );

    let delivered = 0;
    for (const entry of results) {
      if (entry.status === "rejected") {
        console.warn(`[Updater] Broadcast failed — ${describeError(entry.reason)}`);
        continue;
      }
      const { ok, reason, name } = entry.value;
      if (ok) {
        delivered += 1;
        console.log(`[Updater] ${SWARM_UPDATE_TRIGGER} → ${name} v${release.version}`);
      } else {
        console.warn(`[Updater] ${name} did not accept the update (${reason}).`);
      }
    }
    console.log(
      `[Updater] Broadcast complete — ${delivered}/${targets.length} satellite(s) triggered.`,
    );
    return delivered;
  }

  /** POSTs the trigger to one satellite, trying LAN first then Cloud Link. */
  private async postTrigger(
    target: { nodeName: string; endpoint: PeerEndpoint },
    release: ReleaseInfo,
    meshKey: string,
  ): Promise<{ ok: boolean; reason: string; name: string }> {
    const urls = [target.endpoint.lanUrl, target.endpoint.cloudLinkUrl].filter(
      (url) => typeof url === "string" && url.length > 0,
    );
    let reason = "no reachable endpoint";
    for (const base of urls) {
      try {
        const response = await axios.post(
          `${base.replace(/\/+$/, "")}/api/mesh/update-trigger`,
          {
            command: SWARM_UPDATE_TRIGGER,
            version: release.version,
            tag: release.tag,
            downloadUrl: release.downloadUrl,
            sha256: release.sha256,
            issuedBy: this.dispatcher.nodeCode,
            issuedAt: new Date().toISOString(),
          },
          {
            timeout: 10_000,
            headers: { "Content-Type": "application/json", "X-Mesh-Key": meshKey },
          },
        );
        const data = (response.data ?? {}) as Record<string, unknown>;
        if (response.status < 300 && data.success !== false) {
          return { ok: true, reason: "", name: target.nodeName };
        }
        reason = String(data.message || `HTTP ${response.status}`);
      } catch (error) {
        reason = describeError(error);
      }
    }
    return { ok: false, reason, name: target.nodeName };
  }
/**
   * Downloads, verifies and hands off to the shared `update.bat`.
   *
   * @returns true when the process is committed to exiting (a swap is about to
   *          happen), false when the update was skipped or aborted.
   */
  async applyToSelf(release: ReleaseInfo): Promise<boolean> {
    if (!isPackagedExe()) {
      console.warn(
        `[Updater] v${release.version} is available but this is a dev run — ` +
          "the Node runtime cannot be self-replaced. Skipping local swap.",
      );
      return false;
    }

    const stage = stagingDir();
    const stampPath = path.join(stage, HANDOFF_STAMP);
    if (!claimHandoffSlot(stampPath)) {
      console.log("[Updater] Another updater already owns this handoff — standing down.");
      return false;
    }

    const updatePath = path.join(stage, TEMP_UPDATE_FILE);
    const partialPath = `${updatePath}${PARTIAL_SUFFIX}`;

    try {
      console.log(`[Updater] Downloading v${release.version} (from v${APP_VERSION})...`);
      console.log(`[Updater] Staging to ${updatePath}`);
      await this.download(release, partialPath);

      // Only a fully written, verified file is promoted to its real name.
      fs.rmSync(updatePath, { force: true });
      fs.renameSync(partialPath, updatePath);
      const { size } = fs.statSync(updatePath);
      console.log(`[Updater] Verified download — ${TEMP_UPDATE_FILE} (${formatMb(size)}).`);

      const targetExe = currentExecutable();
      /*
        THE HANDOFF IS A SUPERVISOR DECISION. Under the Watchdog this exits 43
        and the watchdog puts the new build in place and boots it; a standalone
        install keeps the detached `update.bat` path. `completeHandoff` chooses
        between them and never returns.
      */
      console.log("[Updater] Handoff complete — restarting into the new build...");
      completeHandoff(updatePath, targetExe);
      return true; // unreachable: completeHandoff always exits
    } catch (error) {
      // Abort cleanly: no half-written update, no restart, node carries on.
      console.warn(`[Updater] Update to v${release.version} aborted — ${describeError(error)}`);
      this.cleanup(partialPath, updatePath, stampPath);
      return false;
    }
  }
/**
   * Streams the release exe to `partialPath`, verifying size, PE magic and
   * (when published) SHA-256 before it can ever be promoted.
   *
   * A GitHub-hosted URL goes through {@link resolveGitHubAssetDownload} first, for
   * exactly the reason the Mothership updater does the same thing: this repository
   * is PRIVATE, so `.../releases/latest/download/rippa-node.exe` answers 404 to
   * every anonymous request — a response byte-identical to "no asset by that
   * name". Attaching a token to that shortcut URL is not enough; the URL itself
   * has to become the authenticated API asset endpoint, which is what that helper
   * resolves it to. Its log lines are collected into `cause` so a failure here
   * reports WHY the 404 happened rather than only that it did.
   *
   * A non-GitHub URL keeps the bare octet-stream request, so a signed CDN link
   * never receives this node's repo token or API key.
   */
  private async download(release: ReleaseInfo, partialPath: string): Promise<void> {
    const headers: Record<string, string> = { Accept: "application/octet-stream" };
    let downloadUrl = release.downloadUrl;

    const diagnostics: string[] = [];
    const authenticated = await resolveGitHubAssetDownload(release.downloadUrl, {
      logPrefix: "[Updater]",
      diagnostics,
      allowPrerelease: process.env.RIPPA_GITHUB_ALLOW_PRERELEASE === "true",
    });
    if (authenticated) {
      downloadUrl = authenticated.url;
      Object.assign(headers, authenticated.headers);
    } else {
      headers["User-Agent"] = "rippa-node-updater";
    }
    const cause = (): string => (diagnostics.length ? ` ${diagnostics.join(" ")}` : "");

    let response;
    try {
      response = await axios.get(downloadUrl, {
        responseType: "stream",
        timeout: DOWNLOAD_TIMEOUT_MS,
        headers,
        // 404 is the private-repo-without-a-token signature, so it is surfaced
        // as a named cause rather than as a generic HTTP failure.
        validateStatus: (status) => status >= 200 && status < 300,
      });
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 404) {
        throw new Error(
          `HTTP 404 downloading ${downloadUrl} — the asset "${currentReleaseAssetName()}" ` +
            "does not exist under that exact name on the latest release, or the " +
            `repository is private and no GITHUB_TOKEN is configured.${cause()}`,
        );
      }
      if (
        axios.isAxiosError(error) &&
        (error.response?.status === 401 || error.response?.status === 403)
      ) {
        throw new Error(
          `HTTP ${error.response?.status} downloading ${downloadUrl} — GitHub rejected the ` +
            `configured token (expired, revoked, or no access to this repository).${cause()}`,
        );
      }
      throw error;
    }

    const hash = createHash("sha256");
    let bytes = 0;
    await pipeline(
      response.data,
      async function* (source: AsyncIterable<Buffer>) {
        for await (const chunk of source) {
          bytes += chunk.length;
          if (bytes > MAX_UPDATE_BYTES) {
            throw new Error("download exceeded the maximum plausible exe size");
          }
          hash.update(chunk);
          yield chunk;
        }
      },
      fs.createWriteStream(partialPath),
    );

    if (bytes < MIN_UPDATE_BYTES) {
      throw new Error(
        `download is only ${bytes} bytes — expected at least ${formatMb(MIN_UPDATE_BYTES)}`,
      );
    }

    // Must be a real PE executable, not an HTML error page that returned 200.
    const header = await readFirstBytes(partialPath, 2);
    if (header.toString("latin1") !== "MZ") {
      throw new Error("downloaded file is not a Windows executable (missing MZ header)");
    }

    if (release.sha256) {
      const digest = hash.digest("hex");
      if (digest.toLowerCase() !== release.sha256.toLowerCase()) {
        throw new Error(`checksum mismatch (expected ${release.sha256}, got ${digest})`);
      }
      console.log("[Updater] SHA-256 verified.");
    } else {
      console.log("[Updater] No checksum published — relying on size and PE magic checks.");
    }
  }

  /** Removes artefacts of a failed attempt. Best-effort, never throws. */
  private cleanup(...paths: string[]): void {
    for (const target of paths) {
      try {
        fs.rmSync(target, { force: true });
      } catch {
        /* a file we cannot delete is harmless — the next run overwrites it */
      }
    }
  }
}

function formatMb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Body the Master sends in a `SWARM_UPDATE_TRIGGER`. */
export interface UpdateTriggerBody {
  command: string;
  version: string;
  tag: string;
  downloadUrl: string;
  sha256?: string;
  /**
   * Set only by a Master that means it. Without it, a trigger naming a version
   * OLDER than the running build is refused — the Master pushing a stale
   * advertisement must not be able to walk a satellite backwards.
   */
  allowDowngrade?: boolean;
  issuedBy: string;
  issuedAt: string;
}

/**
 * Validates an inbound trigger before any destructive step is considered.
 *
 * Rejects anything that is not a well-formed `SWARM_UPDATE_TRIGGER` over http(s),
 * because this endpoint ends with the node replacing its own binary. A malformed
 * or spoofed payload must never reach the downloader.
 */
export function parseUpdateTrigger(body: unknown): UpdateTriggerBody | null {
  if (!body || typeof body !== "object") return null;
  const raw = body as Record<string, unknown>;
  if (raw["command"] !== SWARM_UPDATE_TRIGGER) return null;

  const version = String(raw["version"] ?? "").trim();
  const downloadUrl = String(raw["downloadUrl"] ?? "").trim();
  if (!/^\d+\.\d+\.\d+/.test(version)) return null;
  try {
    const parsed = new URL(downloadUrl);
    // Plain http(s) only — no file:, data: or other local-access schemes.
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  } catch {
    return null;
  }

  const sha256 = String(raw["sha256"] ?? "").trim();
  // Strictly `=== true`: a truthy string like "false" must not be read as consent
  // to walk a node backwards, so only a real boolean opts in.
  const allowDowngrade = raw["allowDowngrade"] === true || raw["allow_downgrade"] === true;
  return {
    command: SWARM_UPDATE_TRIGGER,
    version,
    tag: String(raw["tag"] ?? `v${version}`),
    downloadUrl,
    ...(sha256 ? { sha256 } : {}),
    ...(allowDowngrade ? { allowDowngrade: true } : {}),
    issuedBy: String(raw["issuedBy"] ?? "unknown"),
    issuedAt: String(raw["issuedAt"] ?? new Date().toISOString()),
  };
}

/**
 * SATELLITE: handles a `SWARM_UPDATE_TRIGGER` from the Master.
 *
 * Returns immediately after kicking off the update so the HTTP response is not
 * held open for the length of a 126 MB download. The process exits from inside
 * `applyToSelf()` once the swap is committed.
 */
export async function handleUpdateTrigger(
  updater: SwarmUpdater,
  trigger: UpdateTriggerBody,
): Promise<{ accepted: boolean; message: string }> {
  /*
    THE DOWNGRADE GUARD.

    A Master pushing an OLDER version is the one push that is not self-healing:
    a failed upgrade leaves the node on the old build and the next poll retries,
    while a downgrade is adopted, reported as a successful update, and then
    blocks every future upgrade until someone notices. So it needs an explicit
    `allowDowngrade: true` on the trigger, and `issuedBy === self` — which
    previously bypassed the version check entirely — no longer does.

    `allow_downgrade` is accepted as well as `allowDowngrade` because the
    Mothership's other command surface is snake_case, and an operator who sets
    the flag in one place must not silently fail to set it in another.
  */
  if (isVersionOlder(trigger.version, APP_VERSION) && !trigger.allowDowngrade) {
    return {
      accepted: false,
      message:
        `v${trigger.version} is OLDER than the running v${APP_VERSION} — refusing to ` +
        "downgrade. Re-send with allow_downgrade: true if that is intended.",
    };
  }

  if (
    trigger.issuedBy !== ensureNodeIdentity().code &&
    !isVersionNewer(trigger.version) &&
    !trigger.allowDowngrade
  ) {
    return {
      accepted: false,
      message: `v${trigger.version} is not newer than the running build — ignoring.`,
    };
  }

  console.log(
    `[Updater] ${SWARM_UPDATE_TRIGGER} from Master ${trigger.issuedBy}: ` +
      `v${trigger.version} (${trigger.tag})`,
  );

  // Fire and forget: respond now, swap in the background.
  void updater
    .applyToSelf({
      tag: trigger.tag,
      version: trigger.version,
      downloadUrl: trigger.downloadUrl,
      ...(trigger.sha256 ? { sha256: trigger.sha256 } : {}),
    })
    .catch((error) => {
      console.warn(`[Updater] Triggered update failed — ${describeError(error)}`);
    });

  return {
    accepted: true,
    message: `Update to v${trigger.version} accepted — the node will restart to apply it.`,
  };
}
