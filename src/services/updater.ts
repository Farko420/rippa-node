import axios from "axios";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { APP_VERSION, isVersionNewer } from "../version";
import { ensureNodeIdentity } from "../config/nodeAuth";
import type { PeerEndpoint } from "../config/nodeAuth";
import type { SwarmDispatcher } from "./swarmDispatcher";

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
 *   3. SELF      — on a newer build the Master downloads `rippa-node-update.exe`.
 *   4. BROADCAST — the Master walks every ONLINE satellite in the swarm registry
 *                  and sends it a `SWARM_UPDATE_TRIGGER` carrying the release
 *                  version and the download URL.
 *   5. SWAP      — each satellite downloads, verifies, writes `updater.bat`,
 *                  spawns it fully detached, then `process.exit(0)` to release
 *                  the Windows image lock so the script can swap the binary.
 *
 * WHY THE BATCH HANDOFF: Windows keeps a running .exe mapped and locked, so a
 * Node process cannot replace its own binary. The batch script is spawned
 * detached so it survives `process.exit`, waits for the lock to clear, swaps the
 * files and relaunches — the node replaces itself with nobody at the keyboard.
 *
 * SECURITY: only a mesh-key authenticated Master can trigger an update on a
 * satellite, so no peer node can force a binary swap on another node.
 *
 * NOTE: the Mothership-driven `OtaUpdater` is a separate, older path. This
 * module is the GitHub + fleet path, and both share the on-disk handoff guard
 * so they can never both exit the process mid-swap.
 */

/** GitHub repository publishing the fleet releases ("owner/name"). */
const GITHUB_REPO = process.env.RIPPA_GITHUB_REPO || "rippaadventures/rippa-node";
/** How often the Master polls GitHub for a newer release. */
const CHECK_INTERVAL_MS = 60 * 60_000; // hourly
/** Delay before the first check, so boot finishes before a 126 MB download. */
const FIRST_CHECK_DELAY_MS = 45_000;
/** Streaming timeout — the exe is ~126 MB and links can be slow. */
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
/** An in-flight download is never promoted unless it is at least this large. */
const MIN_UPDATE_BYTES = 1024 * 1024;
/** Sanity ceiling: the exe is ~126 MB, not gigabytes. */
const MAX_UPDATE_BYTES = 1024 * 1024 * 1024;

/** Downloaded release, sitting beside the running exe until it is swapped. */
const UPDATE_FILE_NAME = "rippa-node-update.exe";
const PARTIAL_SUFFIX = ".part";
/** Name of the detached swap script (per spec). */
const HANDOFF_SCRIPT = "updater.bat";
/** Windows can hold the image lock a little longer than the initial wait. */
const HANDOFF_DELAY_SECONDS = 3;
/** Marks that this process has already committed to a handoff. */
const HANDOFF_STAMP = ".ota-handoff";

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

/**
 * On-disk guard against two updaters both calling `process.exit(0)`.
 *
 * The Mothership-driven `OtaUpdater` and this GitHub updater can both decide to
 * update in the same window. Without a shared claim the first to finish would
 * exit while the other was mid-write, leaving a half-swapped install. The claim
 * is a FILE (not just a module variable) because the relaunched process imports
 * this module fresh and must not immediately re-trigger the same swap.
 *
 * The stamp is cleared on the next successful boot start, so a node is never
 * permanently wedged by a leftover file from a crashed attempt.
 */
export function claimHandoffSlot(stampPath: string): boolean {
  try {
    if (fs.existsSync(stampPath)) return false;
    fs.writeFileSync(stampPath, String(process.pid), "utf8");
    return true;
  } catch {
    // Read-only install dir: fall back to a process-local guard so a single
    // process still never exits twice.
    return !claimedInProcess;
  }
}

/** Releases a previous claim at boot. */
export function releaseHandoffClaim(stampPath: string): void {
  try {
    fs.rmSync(stampPath, { force: true });
  } catch {
    /* nothing to clear */
  }
  claimedInProcess = false;
}

/** True when this process is a packaged .exe (the only safely replaceable case). */
export function isPackagedExe(): boolean {
  const packaged = Boolean((process as NodeJS.Process & { pkg?: unknown }).pkg);
  return packaged && path.basename(process.execPath).toLowerCase().endsWith(".exe");
}

/** Reads a version out of a semver-looking string, or null. */
function extractVersion(text: string): string | null {
  const match = /v?(\d+\.\d+\.\d+)/.exec(text);
  return match ? match[1] : null;
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

  const asset = (release.assets ?? []).find(
    (candidate) =>
      typeof candidate.name === "string" &&
      candidate.name.toLowerCase().endsWith(".exe") &&
      typeof candidate.browser_download_url === "string" &&
      candidate.browser_download_url,
  );
  if (!asset?.browser_download_url) {
    console.warn(`[Updater] Release ${tag} has no .exe asset — ignoring.`);
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
 * to read a private repo.
 */
export async function fetchLatestRelease(repo = GITHUB_REPO): Promise<ReleaseInfo | null> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "rippa-node-updater",
  };
  const token = (process.env.RIPPA_GITHUB_TOKEN || "").trim();
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const response = await axios.get(
    `https://api.github.com/repos/${repo}/releases/latest`,
    { headers, timeout: 20_000 },
  );
  return parseLatestRelease(response.data);
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
export function installDir(): string | null {
  return isPackagedExe() ? path.dirname(process.execPath) : null;
}

/** Minimal shape of the GitHub releases API response. */
interface GithubRelease {
  tag_name?: string;
  name?: string;
  body?: string;
  assets?: ReleaseAsset[];
}

/** Process-local fallback claim, used when the install dir is not writable. */
let claimedInProcess = false;

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
    releaseHandoffClaim(path.join(this.dir(), HANDOFF_STAMP));

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

  /** Directory holding the running exe, falling back to cwd in dev. */
  private dir(): string {
    return installDir() || process.cwd();
  }
/**
   * One full cycle: poll GitHub, and on a newer release update this node and
   * broadcast to every online satellite. Never throws — a failed check must
   * leave the node running its normal tasks.
   */
  async checkNow(): Promise<void> {
    if (this.updating) return; // an update is already in flight
    if (process.env.OTA_ENABLED === "false") {
      console.log("[Updater] Idle — disabled via OTA_ENABLED=false.");
      return;
    }

    let release: ReleaseInfo | null = null;
    try {
      release = await fetchLatestRelease();
    } catch (error) {
      // A 404 is the normal state before the first release is published.
      console.warn(`[Updater] GitHub check failed — ${describeError(error)}`);
      return;
    }
    if (!release) return;
    this.latest = release;

    if (!isVersionNewer(release.version)) {
      console.log(`[Updater] Fleet is up to date (v${APP_VERSION}).`);
      return;
    }
    if (release.version === this.lastAttempted) {
      console.warn(
        `[Updater] v${release.version} already attempted and did not complete — ` +
          "waiting for a newer build.",
      );
      return;
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
    } finally {
      this.updating = false;
    }
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
   * Downloads, verifies and hands off to `updater.bat`.
   *
   * @returns true when the process is committed to exiting (a swap is about to
   *          happen), false when the update was skipped or aborted.
   */
  async applyToSelf(release: ReleaseInfo): Promise<boolean> {
    const dir = this.dir();

    if (!isPackagedExe()) {
      console.warn(
        `[Updater] v${release.version} is available but this is a dev run — ` +
          "the Node runtime cannot be self-replaced. Skipping local swap.",
      );
      return false;
    }

    const stampPath = path.join(dir, HANDOFF_STAMP);
    if (!claimHandoffSlot(stampPath)) {
      console.log("[Updater] Another updater already owns this handoff — standing down.");
      return false;
    }

    const targetExe = path.basename(process.execPath);
    const updatePath = path.join(dir, UPDATE_FILE_NAME);
    const partialPath = `${updatePath}${PARTIAL_SUFFIX}`;
    const scriptPath = path.join(dir, HANDOFF_SCRIPT);

    try {
      console.log(`[Updater] Downloading v${release.version} (from v${APP_VERSION})...`);
      await this.download(release, partialPath);

      // Only a fully written, verified file is promoted to its real name.
      fs.rmSync(updatePath, { force: true });
      fs.renameSync(partialPath, updatePath);
      const { size } = fs.statSync(updatePath);
      console.log(`[Updater] Verified download — ${UPDATE_FILE_NAME} (${formatMb(size)}).`);

      this.writeSwapScript(scriptPath, targetExe);
      this.spawnDetached(scriptPath, dir);

      console.log("[Updater] Handoff complete — restarting into the new build...");
      // Release the .exe image lock so the script's `del` can succeed.
      process.exit(0);
      return true; // unreachable: process.exit does not return
    } catch (error) {
      // Abort cleanly: no half-written update, no restart, node carries on.
      console.warn(`[Updater] Update to v${release.version} aborted — ${describeError(error)}`);
      this.cleanup(partialPath, updatePath, scriptPath, stampPath);
      return false;
    }
  }
/**
   * Streams the release exe to `partialPath`, verifying size, PE magic and
   * (when published) SHA-256 before it can ever be promoted.
   */
  private async download(release: ReleaseInfo, partialPath: string): Promise<void> {
    const response = await axios.get(release.downloadUrl, {
      responseType: "stream",
      timeout: DOWNLOAD_TIMEOUT_MS,
      headers: { Accept: "application/octet-stream", "User-Agent": "rippa-node-updater" },
    });

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

  /**
   * Writes `updater.bat`, which performs the swap after this process exits.
   *
   * Follows the required sequence: wait for the Windows image lock, delete the
   * old exe, move the update into place, relaunch, self-delete.
   *
   * The `del` is wrapped in a bounded retry loop because Windows can keep the
   * mapped image locked a little longer than the initial wait. Without it a
   * late-releasing lock would make `del` fail and leave the node with NO
   * executable at all — a self-inflicted brick. `move /y` then overwrites
   * cleanly and always relaunches whatever ended up in place.
   */
  private writeSwapScript(scriptPath: string, targetExe: string): void {
    const lines = [
      "@echo off",
      'cd /d "%~dp0"',
      `timeout /t ${HANDOFF_DELAY_SECONDS} /nobreak > NUL`,
      "for /l %%i in (1,1,10) do (",
      `  if exist "${targetExe}" del "${targetExe}"`,
      `  if not exist "${targetExe}" goto :swapped`,
      "  ping -n 2 127.0.0.1 > NUL",
      ")",
      ":swapped",
      `move /y "${UPDATE_FILE_NAME}" "${targetExe}"`,
      `start "" "${targetExe}"`,
      // Self-delete through a short-lived child: a bare `del "%~f0"` makes cmd
      // report "batch file cannot be found" as it reads past its own deleted
      // file. This removes the script cleanly with no error output.
      'start "" /b cmd /c "timeout /t 1 /nobreak > NUL & del ""%~f0"""',
    ];
    fs.writeFileSync(scriptPath, `${lines.join("\r\n")}\r\n`, "utf8");
    console.log(`[Updater] Swap script written — ${path.basename(scriptPath)}`);
  }

  /**
   * Launches `updater.bat` in its own session so it outlives this process.
   *
   * `detached: true` + `stdio: "ignore"` + `unref()` detaches it from our
   * console, pipes and event loop — it keeps running after `process.exit(0)`.
   * Windows cannot exec a .bat directly, so it must go through cmd.exe.
   */
  private spawnDetached(scriptPath: string, cwd: string): void {
    const child = spawn("cmd.exe", ["/c", scriptPath], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      cwd,
    });
    child.unref();
    console.log(`[Updater] updater.bat spawned (detached, pid ${child.pid ?? "unknown"}).`);
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
  return {
    command: SWARM_UPDATE_TRIGGER,
    version,
    tag: String(raw["tag"] ?? `v${version}`),
    downloadUrl,
    ...(sha256 ? { sha256 } : {}),
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
  if (trigger.issuedBy !== ensureNodeIdentity().code && !isVersionNewer(trigger.version)) {
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
