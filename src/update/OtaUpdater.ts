import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import axios from "axios";
import { env } from "../config";
import { APP_VERSION, APP_VERSION_RESOLVED, isVersionNewer } from "../version";
import type { LatestVersionInfo, SwarmClient } from "../network/SwarmClient";
import {
  HANDOFF_STAMP,
  PARTIAL_SUFFIX,
  TEMP_UPDATE_FILE,
  claimHandoffSlot,
  currentExecutable,
  isPackagedExe,
  spawnDetached,
  stagingDir,
  writeSwapScript,
} from "./swapHandoff";

/**
 * OVER-THE-AIR SWARM AUTO-UPDATER.
 *
 * Keeps every running node on the newest published build without a human ever
 * touching the machine:
 *
 *   1. CHECK    — on a 60-minute cron, or the moment the Mothership advertises
 *                 a version on the heartbeat reply, compare the remote version
 *                 against the local `package.json` version.
 *   2. DOWNLOAD — stream the new executable to `temp_update.exe` in the
 *                 persistent data directory, via a `.part` file so a partial
 *                 transfer can never be mistaken for a complete one.
 *   3. VERIFY   — optional SHA-256 from the Mothership, plus a PE ("MZ") magic
 *                 check and a sane size floor. Any mismatch aborts the update.
 *   4. HANDOFF  — write `update.bat` (or `.sh`) via `update/swapHandoff`, spawn
 *                 it fully detached, then `process.exit(0)` to release the file
 *                 lock so the script can overwrite and relaunch the executable.
 *
 * SAFETY: steps 2-4 only run for a PACKAGED executable. Under `tsx` or
 * `node dist/index.js` the "current executable" is `node.exe` itself — deleting
 * and replacing that would destroy the Node installation. In that case the
 * updater reports the available version and idles.
 */

const DOWNLOAD_TIMEOUT_MS = 10 * 60_000; // a large exe over a slow link
/** Anything smaller is a truncated transfer or an HTML error page. */
const MIN_UPDATE_BYTES = 1024 * 1024;
/** Sanity ceiling — rippa-node.exe is tens of MB, not gigabytes. */
const MAX_UPDATE_BYTES = 1024 * 1024 * 1024;

/** Where the running executable lives, and what it is called. */
interface InstallTarget {
  dir: string;
  updateFileName: string;
}

export class OtaUpdater {
  private updating = false;
  private disabledReason: string | null = null;
  /** Last version attempted, so a broken build is not retried every hour. */
  private lastAttemptedVersion: string | null = null;

  constructor(private readonly swarm: SwarmClient) {}

  /**
   * Handles an update advertised on the heartbeat reply. Fire-and-forget and
   * never throws back into the SwarmClient's heartbeat path.
   */
  onUpdateSignal(info: LatestVersionInfo): void {
    try {
      void this.applyIfNewer(info);
    } catch (error) {
      console.warn(`[OTA] Update signal failed — ${describeError(error)}`);
    }
  }

  /**
   * One full check cycle: fetch the latest version and update when it is newer.
   * Never throws — a failed check must leave the node running its normal tasks.
   */
  async checkForUpdate(): Promise<void> {
    if (this.updating) {
      return; // an update is already in flight
    }

    const blocked = this.selfUpdateBlockReason();
    if (blocked) {
      if (this.disabledReason !== blocked) {
        this.disabledReason = blocked;
        console.log(`[OTA] Idle — ${blocked}`);
      }
      return;
    }

    let latest: LatestVersionInfo | null = null;
    try {
      latest = await this.swarm.fetchLatestVersion();
    } catch (error) {
      console.warn(`[OTA] Version check failed — ${describeError(error)}`);
      return;
    }

    if (!latest) {
      return; // unreachable or unusable payload — stay on the current build
    }
    if (!isVersionNewer(latest.version)) {
      console.log(`[OTA] Up to date (v${APP_VERSION}).`);
      return;
    }
    if (latest.version === this.lastAttemptedVersion) {
      console.warn(
        `[OTA] v${latest.version} was already attempted and did not complete — ` +
          "skipping until a newer build is published.",
      );
      return;
    }

    await this.applyIfNewer(latest);
  }

  /** Downloads, verifies and hands off to the replacement script. */
  private async applyIfNewer(latest: LatestVersionInfo): Promise<void> {
    if (this.updating || !isVersionNewer(latest.version)) {
      return;
    }

    const target = this.installTarget();
    if (!target) {
      return; // not self-replaceable (dev mode) — already reported
    }

    /*
      SHARED HANDOFF CLAIM. The Mothership path and the GitHub path can both
      decide to update in the same window; without one claim they would both call
      process.exit(0) and leave a half-swapped install. The stamp sits in the
      staging dir (writable) rather than beside the exe (possibly not).
    */
    const stage = stagingDir();
    const stampPath = path.join(stage, HANDOFF_STAMP);
    if (!claimHandoffSlot(stampPath)) {
      console.log("[OTA] Another updater already owns this handoff — standing down.");
      return;
    }

    this.updating = true;
    this.lastAttemptedVersion = latest.version;

    const updatePath = path.join(stage, TEMP_UPDATE_FILE);
    const partialPath = `${updatePath}${PARTIAL_SUFFIX}`;

    try {
      console.log("[OTA] New version detected. Downloading...");
      console.log(`[OTA] v${APP_VERSION} → v${latest.version}`);
      console.log(`[OTA] Staging to ${updatePath}`);

      await this.download(latest, partialPath, target.updateFileName);

      // Only ever promote a fully written, verified file to its real name.
      fs.rmSync(updatePath, { force: true });
      fs.renameSync(partialPath, updatePath);
      const { size } = fs.statSync(updatePath);
      console.log(`[OTA] Download complete — ${TEMP_UPDATE_FILE} (${formatMb(size)}).`);

      const scriptPath = writeSwapScript(updatePath, currentExecutable());
      const pid = spawnDetached(scriptPath, target.dir);
      console.log(`[OTA] Handoff script spawned (detached, pid ${pid ?? "unknown"}).`);

      console.log("[OTA] Handoff complete. Restarting node for update...");
      // Release the .exe lock so the script's overwrite can succeed.
      process.exit(0);
    } catch (error) {
      // Abort cleanly: no half-written update, no restart, node carries on.
      console.warn(`[OTA] Update to v${latest.version} aborted — ${describeError(error)}`);
      console.warn("[OTA] Staying on the current build; normal node tasks resume.");
      this.cleanup(partialPath, updatePath, stampPath);
    } finally {
      this.updating = false;
    }
  }

  /**
   * Streams the new executable to `partialPath`.
   *
   * The Mothership's Authorization header is only replayed for same-origin
   * URLs, so a signed CDN link never receives this node's API key.
   */
  private async download(
    latest: LatestVersionInfo,
    partialPath: string,
    updateFileName: string,
  ): Promise<void> {
    const headers: Record<string, string> = { Accept: "application/octet-stream" };
    if (this.isSameOrigin(latest.downloadUrl)) {
      headers["Authorization"] = `Bearer ${env.NODE_API_KEY}`;
    }

    const response = await axios.get(latest.downloadUrl, {
      responseType: "stream",
      timeout: DOWNLOAD_TIMEOUT_MS,
      headers,
    });

    const hash = createHash("sha256");
    let bytes = 0;

    await pipeline(
      response.data as AsyncIterable<Buffer>,
      async function* (source: AsyncIterable<Buffer>) {
        for await (const chunk of source) {
          bytes += chunk.length;
          if (bytes > MAX_UPDATE_BYTES) {
            throw new Error(`download exceeded the ${formatMb(MAX_UPDATE_BYTES)} sanity limit`);
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

    // Windows only: the payload must be a real PE executable, not an HTML
    // error page or a JSON body that happened to return HTTP 200.
    if (updateFileName.toLowerCase().endsWith(".exe")) {
      const header = await readFirstBytes(partialPath, 2);
      if (header.toString("latin1") !== "MZ") {
        throw new Error("downloaded file is not a Windows executable (missing MZ header)");
      }
    }

    if (latest.sha256) {
      const digest = hash.digest("hex");
      if (digest.toLowerCase() !== latest.sha256.toLowerCase()) {
        throw new Error(`checksum mismatch (expected ${latest.sha256}, got ${digest})`);
      }
      console.log("[OTA] Checksum verified.");
    } else {
      console.log("[OTA] No checksum published — relying on size and signature checks.");
    }
  }

  /** Removes every artefact of a failed attempt. Best-effort, never throws. */
  private cleanup(...paths: string[]): void {
    for (const target of paths) {
      try {
        fs.rmSync(target, { force: true });
      } catch {
        // A file we cannot delete is harmless — the next run overwrites it.
      }
    }
  }

  /**
   * Why self-replacing is unsafe right now, or `null` when it is safe.
   * Gates the destructive steps against dev runs and unresolvable versions.
   */
  private selfUpdateBlockReason(): string | null {
    if (process.env.OTA_ENABLED === "false") {
      return "disabled via OTA_ENABLED=false";
    }
    if (!APP_VERSION_RESOLVED) {
      return "the local app version could not be read from package.json";
    }
    if (!this.isPackagedExe()) {
      return "not running as a packaged rippa-node.exe (dev mode) — nothing to replace";
    }
    return null;
  }

  /**
   * Resolves the installed executable's directory and file name, or `null`
   * outside a packaged build — see the SAFETY note at the top of this file.
   */
  private installTarget(): InstallTarget | null {
    if (!this.isPackagedExe()) {
      console.log(
        "[OTA] Dev mode detected — the running file is the Node runtime, not " +
          "rippa-node.exe. An update is available but will not be self-applied.",
      );
      return null;
    }
    return { dir: path.dirname(process.execPath), updateFileName: path.basename(process.execPath) };
  }

  /** True only for the `pkg`-built rippa-node.exe. */
  private isPackagedExe(): boolean {
    return isPackagedExe();
  }

  /** True when `url` points at the configured Mothership host. */
  private isSameOrigin(url: string): boolean {
    try {
      return new URL(url).origin === new URL(env.MOTHERSHIP_URL).origin;
    } catch {
      return false;
    }
  }
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

function formatMb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function describeError(error: unknown): string {
  if (axios.isAxiosError(error)) {
    const status = error.response?.status;
    return status ? `HTTP ${status} — ${error.message}` : error.message;
  }
  return error instanceof Error ? error.message : String(error);
}
