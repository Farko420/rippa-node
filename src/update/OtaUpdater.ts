import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import axios from "axios";
import { env } from "../config";
import { APP_VERSION, APP_VERSION_RESOLVED, isVersionNewer } from "../version";
import type { LatestVersionInfo, SwarmClient } from "../network/SwarmClient";

/**
 * OVER-THE-AIR SWARM AUTO-UPDATER.
 *
 * Keeps every running node on the newest published build without a human ever
 * touching the machine:
 *
 *   1. CHECK    — on a 60-minute cron, or the moment the Mothership advertises
 *                 a version on the heartbeat reply, compare the remote version
 *                 against the local `package.json` version.
 *   2. DOWNLOAD — stream the new executable to `rippa-node-update.exe` beside
 *                 the running one, via a `.part` file so a partial transfer can
 *                 never be mistaken for a complete one.
 *   3. VERIFY   — optional SHA-256 from the Mothership, plus a PE ("MZ") magic
 *                 check and a sane size floor. Any mismatch aborts the update.
 *   4. HANDOFF  — write `apply_update.bat` (or `.sh`), spawn it fully detached,
 *                 then `process.exit(0)` to release the file lock so the script
 *                 can delete, rename and relaunch the executable.
 *
 * SAFETY: steps 2-4 only run for a PACKAGED executable. Under `tsx` or
 * `node dist/index.js` the "current executable" is `node.exe` itself — deleting
 * and replacing that would destroy the Node installation. In that case the
 * updater reports the available version and idles.
 */

const DOWNLOAD_TIMEOUT_MS = 10 * 60_000; // a large exe over a slow link
const UPDATE_FILE_NAME = "rippa-node-update.exe";
const HANDOFF_SCRIPT = "apply_update.bat";
const HANDOFF_SCRIPT_POSIX = "apply_update.sh";
const PARTIAL_SUFFIX = ".part";
/** Windows keeps the mapped image locked briefly; the script waits 3s. */
const HANDOFF_DELAY_SECONDS = 3;
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

    this.updating = true;
    this.lastAttemptedVersion = latest.version;

    const updatePath = path.join(target.dir, UPDATE_FILE_NAME);
    const partialPath = `${updatePath}${PARTIAL_SUFFIX}`;
    const handoffPath = path.join(target.dir, this.handoffScriptName());

    try {
      console.log("[OTA] New version detected. Downloading...");
      console.log(`[OTA] v${APP_VERSION} → v${latest.version}`);

      await this.download(latest, partialPath, target.updateFileName);

      // Only ever promote a fully written, verified file to its real name.
      fs.rmSync(updatePath, { force: true });
      fs.renameSync(partialPath, updatePath);
      const { size } = fs.statSync(updatePath);
      console.log(`[OTA] Download complete — ${UPDATE_FILE_NAME} (${formatMb(size)}).`);

      this.writeHandoffScript(handoffPath, target.updateFileName);
      this.spawnDetached(handoffPath, target.dir);

      console.log("[OTA] Handoff complete. Restarting node for update...");
      // Release the .exe lock so the script's `del` can succeed.
      process.exit(0);
    } catch (error) {
      // Abort cleanly: no half-written update, no restart, node carries on.
      console.warn(`[OTA] Update to v${latest.version} aborted — ${describeError(error)}`);
      console.warn("[OTA] Staying on the current build; normal node tasks resume.");
      this.cleanup(partialPath, updatePath, handoffPath);
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

  /**
   * Writes the script that performs the swap once this process has exited.
   *
   * Windows follows the OTA spec exactly: wait for the file lock to clear,
   * delete the old executable, rename the update into place, relaunch, then
   * delete the script itself. A bounded retry loop wraps the `del` because
   * Windows can hold the image lock a little longer than the initial wait, and
   * a failed delete would otherwise leave the node with no executable at all.
   */
  private writeHandoffScript(scriptPath: string, updateFileName: string): void {
    const lines = this.isWindows()
      ? [
          "@echo off",
          'cd /d "%~dp0"',
          `timeout /t ${HANDOFF_DELAY_SECONDS} /nobreak > NUL`,
          "for /l %%i in (1,1,10) do (",
          `  if exist "${updateFileName}" del "${updateFileName}"`,
          `  if not exist "${updateFileName}" goto :swapped`,
          "  ping -n 2 127.0.0.1 > NUL",
          ")",
          ":swapped",
          `ren "${UPDATE_FILE_NAME}" "${updateFileName}"`,
          `start "" "${updateFileName}"`,
          // Self-delete via a short-lived child: `del "%~f0"` alone makes cmd
          // report "The batch file cannot be found" as it reads past its own
          // deleted file. Verified to remove the script without that error.
          'start "" /b cmd /c "timeout /t 1 /nobreak > NUL & del ""%~f0"""',
        ]
      : [
          "#!/bin/sh",
          'cd "$(dirname "$0")" || exit 1',
          `sleep ${HANDOFF_DELAY_SECONDS}`,
          `rm -f "${updateFileName}"`,
          `mv -f "${UPDATE_FILE_NAME}" "${updateFileName}"`,
          `chmod +x "${updateFileName}"`,
          `nohup "./${updateFileName}" >/dev/null 2>&1 &`,
          'rm -f "$0"',
        ];

    fs.writeFileSync(scriptPath, `${lines.join("\r\n")}\r\n`, "utf8");
    if (!this.isWindows()) {
      fs.chmodSync(scriptPath, 0o755);
    }
    console.log(`[OTA] Handoff script written — ${path.basename(scriptPath)}`);
  }

  /**
   * Launches the handoff script in its own session so it outlives this process.
   * `detached` + `stdio: "ignore"` + `unref()` detaches it from our console,
   * pipes and event loop — it keeps running after `process.exit(0)`.
   */
  private spawnDetached(scriptPath: string, cwd: string): void {
    // Windows cannot exec a .bat directly; it must go through cmd.exe.
    const child = this.isWindows()
      ? spawn("cmd.exe", ["/c", scriptPath], {
          detached: true,
          stdio: "ignore",
          windowsHide: true,
          cwd,
        })
      : spawn("/bin/sh", [scriptPath], { detached: true, stdio: "ignore", cwd });

    child.unref();
    console.log(`[OTA] Handoff script spawned (detached, pid ${child.pid ?? "unknown"}).`);
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
    const packaged = Boolean((process as NodeJS.Process & { pkg?: unknown }).pkg);
    return packaged && path.basename(process.execPath).toLowerCase().endsWith(".exe");
  }

  private handoffScriptName(): string {
    return this.isWindows() ? HANDOFF_SCRIPT : HANDOFF_SCRIPT_POSIX;
  }

  private isWindows(): boolean {
    return process.platform === "win32";
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
