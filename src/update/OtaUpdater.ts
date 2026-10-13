import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import axios from "axios";
import extract from "extract-zip";
import { env } from "../config";
import { APP_VERSION, APP_VERSION_RESOLVED, isVersionNewer, isVersionOlder } from "../version";
import {
  OTA_404_HINT,
  currentReleaseAssetName,
  resolveGitHubAssetDownload,
} from "./githubAsset";
import { findWorkflowExe, resolveActionsRunDownload } from "./actionsArtifact";
import type { LatestVersionInfo, SwarmClient } from "../network/SwarmClient";
import {
  HANDOFF_STAMP,
  PARTIAL_SUFFIX,
  TEMP_UPDATE_FILE,
  claimHandoffSlot,
  completeHandoff,
  currentExecutable,
  isPackagedExe,
  stagingDir,
} from "./swapHandoff";
import { recordUpdateApplied } from "./updateStamp";

/**
 * OVER-THE-AIR SWARM AUTO-UPDATER.
 *
 * The Mothership-driven half of the update loop, and the module that answers a
 * `FORCE_UPDATE` command. Keeps every running node on the newest build without a
 * human ever touching the machine:
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
 * WHY THERE IS NO GITHUB CALL HERE. The Mothership's `/api/node/latest-version`
 * endpoint returns a FULLY RESOLVED `download_url`. Re-deriving that URL locally
 * meant a second request to `api.github.com/repos/.../releases/latest`, which
 * fails on a private repo or before the first release exists — and a 404 there
 * is indistinguishable from "nothing published", so the node logged "no
 * releases" and did nothing forever. The payload the Mothership already sent is
 * the single source of truth; this module consumes it and nothing else.
 *
 * SAFETY: steps 2-4 only run for a PACKAGED executable. Under `tsx` or
 * `node dist/index.js` the "current executable" is `node.exe` itself — deleting
 * and replacing that would destroy the Node installation. Rather than aborting
 * the whole pipeline there, {@link OtaUpdater.forceUpdate} reports the update as
 * handled (a "dev mode mock") so the Mothership retires the command instead of
 * waiting on a node that is physically incapable of swapping itself.
 */

const DOWNLOAD_TIMEOUT_MS = 10 * 60_000; // a large exe over a slow link
/** Anything smaller is a truncated transfer or an HTML error page. */
const MIN_UPDATE_BYTES = 1024 * 1024;
/** Sanity ceiling — rippa-node.exe is tens of MB, not gigabytes. */
const MAX_UPDATE_BYTES = 1024 * 1024 * 1024;

/**
 * THE DEV-MODE LINE. Exact wording is load-bearing: operators and the support
 * runbook grep for it, and it is the single line that explains why a
 * `FORCE_UPDATE` "succeeded" without a restart.
 */
const DEV_MODE_BYPASS_LOG =
  "[Updater] Development mode detected. Bypassing physical binary swap.";

/**
 * Validates a Mothership-supplied `download_url` before anything destructive is
 * considered. Returns the reason it is unusable, or `null` when it is fine.
 *
 * The pipeline ends in the node replacing its own executable, so an empty or
 * non-http(s) URL is refused here — before any download — rather than being
 * handed to axios. An absent URL is the expected shape when the Mothership has
 * a version recorded but no artifact attached yet, and it must abort cleanly
 * with a failed acknowledgement instead of crashing the node.
 */
export function unusableDownloadUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return "the Mothership supplied no download_url";
  }
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    return `the Mothership supplied a malformed download_url (${raw.trim()})`;
  }
  // Plain http(s) only — never file:, data: or another local-access scheme.
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return `the Mothership supplied a non-http(s) download_url (${parsed.protocol}//…)`;
  }
  return null;
}

/** Where the running executable lives, and what it is called. */
interface InstallTarget {
  dir: string;
  updateFileName: string;
}

/**
 * How an update attempt should be judged.
 *
 * `force` exists for the operator's "Force OTA Update" button. The unattended
 * hourly poll deliberately refuses to act on a version this node is already on,
 * because reinstalling it every hour is pointless churn. A forced command is a
 * REPAIR action: a node stuck on a corrupt or half-swapped build reports the
 * right version number and still needs the good bytes put back down, so the
 * version gate and the "already attempted" backoff are both bypassed.
 */
interface ApplyOptions {
  force?: boolean;
  /**
   * Permits installing a build OLDER than the one running.
   *
   * Off by default, and `force` does NOT turn it on. Those are separate
   * decisions: `force` means "install this exact version even though it is the one
   * I am already running" (a repair of a corrupt install), while a downgrade
   * means "install a version older than the one I am running". Conflating them is
   * what turned `FORCE_UPDATE` into a downgrade vector — the operator's "Force
   * Update" button on a v1.0.15 node would happily install whatever the
   * Mothership happened to be advertising, including v1.0.13.
   */
  allowDowngrade?: boolean;
}

/**
 * OTA download/installation status exposed to telemetry and the dashboard.
 */
export interface OtaStatus {
  state: "downloading" | "staged" | "restarting" | "completed" | "error";
  progress: number;
  targetVersion?: string;
  errorMessage?: string;
}

const IDLE_OTA_STATUS: OtaStatus = { state: "completed", progress: 0 };

export class OtaUpdater {
  private updating = false;
  private disabledReason: string | null = null;
  /** Last version attempted, so a broken build is not retried every hour. */
  private lastAttemptedVersion: string | null = null;
  /** Current OTA status for telemetry. */
  private otaStatus: OtaStatus = { ...IDLE_OTA_STATUS };

  constructor(private readonly swarm: SwarmClient) {}

  /** Returns the current OTA status for telemetry. */
  getOtaStatus(): OtaStatus {
    return { ...this.otaStatus };
  }

  /**
   * Handles an update advertised on the heartbeat reply. Fire-and-forget and
   * never throws back into the SwarmClient's heartbeat path.
   */
  onUpdateSignal(info: LatestVersionInfo): void {
    try {
      void this.applyIfNewer(info).catch((error: unknown) => {
        console.warn(`[OTA] Update signal failed — ${describeError(error)}`);
      });
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

    // The version gate and the "already attempted" backoff both live in
    // applyIfNewer now, so the unattended poll and the forced command cannot
    // drift apart on what counts as "newer".
    await this.applyIfNewer(latest);
  }

  /**
   * Answers a `FORCE_UPDATE` command from the Mothership.
   *
   * WHY THIS DOES NOT ASK GITHUB. The Mothership's `/api/node/latest-version`
   * endpoint now returns a fully resolved `download_url`. This method consumes
   * that URL verbatim and makes no request to `api.github.com` at all — which is
   * what made the command a no-op before: a private repo, or a repo with no
   * published release yet, answers 404, the 404 was swallowed as "nothing to
   * update", and the command sat in the queue indefinitely.
   *
   * @returns true when the command should be treated as APPLIED — either a swap
   *          was committed (the process exits inside `applyIfNewer`, so this only
   *          returns on the non-exiting paths) or the dev-mode mock stood in for
   *          one. false means genuinely not applied: an unusable payload, a
   *          refused handoff, a failed download, or "rejected_downgrade" for a refused downgrade. Never throws — a throwing
   *          updater would leave the Mothership waiting with no outcome at all.
   */
  async forceUpdate(options: { allowDowngrade?: boolean } = {}): Promise<boolean | "rejected_downgrade"> {
    console.log("[Updater] FORCE_UPDATE received — resolving the Mothership payload.");

    if (this.updating) {
      console.log("[Updater] An update is already in flight — standing down.");
      return false;
    }
    if (process.env.OTA_ENABLED === "false") {
      console.log("[Updater] FORCE_UPDATE refused — disabled via OTA_ENABLED=false.");
      return false;
    }

    let latest: LatestVersionInfo | null = null;
    try {
      latest = await this.swarm.fetchLatestVersion();
    } catch (error) {
      console.warn(`[Updater] FORCE_UPDATE aborted — ${describeError(error)}`);
      return false;
    }

    if (!latest) {
      console.warn(
        "[Updater] FORCE_UPDATE aborted — the Mothership returned no usable version payload.",
      );
      return false;
    }

    // Validated BEFORE any destructive step. A version with no artifact is the
    // expected shape while a release is still being published, so it must fail
    // cleanly and be reported as failed — never crash the node, never download
    // an empty string.
    const unusable = unusableDownloadUrl(latest.downloadUrl);
    if (unusable) {
      console.warn(
        `[Updater] FORCE_UPDATE aborted — ${unusable} for v${latest.version}. ` +
          "Staying on the current build.",
      );
      return false;
    }

    console.log(`[Updater] Mothership supplied v${latest.version} — ${latest.downloadUrl}`);
    return this.applyIfNewer(latest, {
      force: true,
      ...(options.allowDowngrade ? { allowDowngrade: true } : {}),
    });
  }

  /**
   * Downloads, verifies and hands off to the replacement script.
   *
   * Returns `"rejected_downgrade"` (rather than `false`) when the downgrade
   * guard refused the advertised build, so the caller can tell "this node is
   * already newer — retire the command" apart from a transient failure the
   * Mothership may legitimately want to retry.
   */
  private async applyIfNewer(
    latest: LatestVersionInfo,
    options: ApplyOptions = {},
  ): Promise<boolean | "rejected_downgrade"> {
    const force = options.force === true;
    const allowDowngrade = options.allowDowngrade === true;

    if (this.updating) {
      return false; // an update is already in flight
    }

    /*
      THE DOWNGRADE GUARD, CHECKED BEFORE THE VERSION GATE.

      A forced update bypasses "is this newer than what I am running?" entirely,
      which is correct for its actual purpose (reinstalling the SAME build to
      repair a corrupt one). But it also meant a `FORCE_UPDATE` would install
      whatever the Mothership advertised — including a build OLDER than the one
      running, e.g. rolling a v1.0.15 node back to v1.0.13.

      That is refused unless the payload explicitly carries `allow_downgrade:
      true`. The check is a strict "older than", not "not newer than", so the
      ordinary force-reinstall of the current version still works: equal versions
      are not downgrades.
    */
    if (!allowDowngrade && isVersionOlder(latest.version, APP_VERSION)) {
      console.warn(
        `[OTA] Refusing to downgrade: the Mothership offered v${latest.version} but this ` +
          `node is running v${APP_VERSION}. Re-send the command with ` +
          `allow_downgrade: true if that is really intended.`,
      );
      // A refusal is terminal, not transient: the node is already newer than
      // the target, so reporting `false` here left the Mothership's queue entry
      // outstanding and it re-dispatched the same command on every heartbeat.
      return "rejected_downgrade";
    }

    /*
      A FORCED UPDATE IGNORES THE VERSION GATE. That is the whole point of the
      button: a node reporting the correct version can still be running corrupt
      bytes, and reinstalling the same build is the repair. The `lastAttempted`
      backoff is bypassed for the same reason — it exists to stop a broken build
      being retried every hour, but an operator explicitly asking again must not
      be second-guessed by a backoff set on a previous, unrelated failure.
    */
    if (!force && !isVersionNewer(latest.version)) {
      console.log(`[OTA] Up to date (v${APP_VERSION}).`);
      return false;
    }
    if (!force && latest.version === this.lastAttemptedVersion) {
      console.warn(
        `[OTA] v${latest.version} was already attempted and did not complete — ` +
          "skipping until a newer build is published.",
      );
      return false;
    }

    /*
      DEV MODE MOCK — THE CRITICAL PATH FOR A `FORCE_UPDATE`.

      Under `tsx src/index.ts` or `node dist/index.js` the running file is the
      Node runtime itself, not rippa-node.exe. Physically swapping it would
      destroy the Node installation, so the swap is correctly refused — but the
      old behaviour then returned "not applied", which reported a FAILED ack and
      left the command in the Mothership's queue forever, re-dispatched on every
      heartbeat. The node was not ignoring the command; it simply cannot perform
      this one.

      So a dev run acknowledges SUCCESS. The command clears, the fleet stops
      waiting, and the swap is skipped for the only reason it ever legitimately
      is. A real packaged node never reaches this branch.
    */
    const target = this.installTarget();
    if (!target) {
      console.log(DEV_MODE_BYPASS_LOG);
      return true;
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
      return false;
    }

    this.updating = true;
    this.lastAttemptedVersion = latest.version;

    const updatePath = path.join(stage, TEMP_UPDATE_FILE);
    const partialPath = `${updatePath}${PARTIAL_SUFFIX}`;

       this.otaStatus = { state: "downloading", progress: 0, targetVersion: latest.version };

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

      /*
        STAMP THE INSTALL BEFORE HANDING OFF.

        Recorded with the INCOMING version, not the running one: after the swap
        the new binary reads this file as "stamped by me" (see
        `getLastUpdatedAt`), so writing v1.0.22 here for a v1.0.23 install would
        make every heartbeat fall through to the mtime fallback.

        This is an INTENT stamp, not proof — the watchdog re-stamps on the
        successful rename, and boot reconciliation catches anything this misses.
        Writing it here at all matters for the standalone (no-watchdog) path,
        where nothing else survives to do it.
      */
      recordUpdateApplied(latest.version);

      /*
        THE HANDOFF IS NOW A SUPERVISOR DECISION, NOT A LOCAL ONE.

        Under the Watchdog this exits 43 and the watchdog swaps the executable and
        boots the new build; a standalone install keeps the detached `update.bat`
        path. Both are chosen by `completeHandoff`, which never returns.
      */
      completeHandoff(updatePath, currentExecutable());
      return true; // unreachable: completeHandoff always exits
    } catch (error) {
      // Abort cleanly: no half-written update, no restart, node carries on.
      // This is the "unreachable download_url" path — a dead link, an expired
      // signed URL, a 5xx — reported honestly so the Mothership records a FAILED
      // FORCE_UPDATE rather than leaving the node in limbo.
      console.warn(`[OTA] Update to v${latest.version} aborted — ${describeError(error)}`);
      console.warn("[OTA] Staying on the current build; normal node tasks resume.");
      this.cleanup(partialPath, updatePath, stampPath);
      return false;
    } finally {
      this.updating = false;
    }
  }

  /**
   * Stages the new build into `partialPath`, from whichever payload the
   * Mothership advertised.
   *
   * THREE PAYLOAD SHAPES, ONE VERIFICATION. The URL in `latest.download_url`
   * can be:
   *
   *   1. a GITHUB ACTIONS RUN (`.../actions/runs/<id>`) — resolved to that run's
   *      artifact ZIP and unpacked ({@link downloadArtifactZip});
   *   2. a GitHub RELEASE asset — resolved to the authenticated API endpoint by
   *      {@link resolveGitHubAssetDownload}. That is what fixes the private-repo
   *      404: `.../releases/latest/download/rippa-node.exe` answers 404 to ANY
   *      anonymous request when the repository is private — indistinguishable
   *      from "the asset does not exist" — so the node fetched a correct URL,
   *      with a correct asset name, and could never succeed;
   *   3. anything else (a Mothership-signed CDN link), streamed as-is. The
   *      Mothership's Authorization header is replayed ONLY for same-origin
   *      URLs, so a third-party link never receives this node's API key.
   *
   * All three end in {@link verifyStagedFile}: size floor, PE ("MZ") magic and,
   * when the Mothership published one, SHA-256. Nothing is promoted to the real
   * `temp_update.exe` name until that passes.
   *
   * WHY THE RESOLUTION'S LOG LINES ARE COLLECTED AND RE-THROWN. The resolvers
   * already print each failure they survive (401 vs 404 vs no asset vs no
   * token). This method hands them a shared `diagnostics` sink, which the
   * streaming step appends to the error it throws — so the single line the
   * Mothership records as a FAILED update carries the actual cause instead of a
   * bare "HTTP 404" that four different faults all produce.
   */
  private async download(
    latest: LatestVersionInfo,
    partialPath: string,
    updateFileName: string,
  ): Promise<void> {
    const headers: Record<string, string> = { Accept: "application/octet-stream" };
    let downloadUrl = latest.downloadUrl;

    const diagnostics: string[] = [];

    /*
      THE GITHUB ACTIONS RUN URL IS TRIED FIRST — it is the shape a FORCE_UPDATE
      actually carries, and it is NOT a release asset. `resolveGitHubAssetDownload`
      below would ask `/releases/latest` for an asset list that has nothing to do
      with the run and then stream the run PAGE, which answers HTTP 404: the
      reported symptom. `resolveActionsRunDownload` returns null for anything
      that is not a run URL, so the release path is untouched.
    */
    const actionsTarget = await resolveActionsRunDownload(latest.downloadUrl, {
      logPrefix: "[OTA]",
      diagnostics,
    });
    if (actionsTarget) {
      downloadUrl = actionsTarget.url;
      Object.assign(headers, actionsTarget.headers);
      console.log(
        `[OTA] GitHub Actions run ${actionsTarget.runId} → artifact ` +
          `"${actionsTarget.artifactName}" (unpacking the ZIP to find ` +
          `${currentReleaseAssetName()}).`,
      );
      const archiveDigest = await this.downloadArtifactZip(
        downloadUrl,
        headers,
        partialPath,
        actionsTarget.artifactName,
      );
      await this.verifyStagedFile(latest, partialPath, updateFileName, archiveDigest);
      return;
    }

    const authenticated = await resolveGitHubAssetDownload(latest.downloadUrl, {
      logPrefix: "[OTA]",
      diagnostics,
      allowPrerelease: process.env.RIPPA_GITHUB_ALLOW_PRERELEASE === "true",
    });
    if (authenticated) {
      downloadUrl = authenticated.url;
      Object.assign(headers, authenticated.headers);
    } else if (this.isSameOrigin(latest.downloadUrl)) {
      headers["Authorization"] = `Bearer ${env.NODE_API_KEY}`;
    }

    const streamedDigest = await this.streamTo(downloadUrl, headers, partialPath, diagnostics);
    await this.verifyStagedFile(latest, partialPath, updateFileName, streamedDigest);
  }

  /**
   * Streams an Actions artifact ZIP and extracts the compiled node from it.
   *
   * `actions/artifacts/{id}/zip` ALWAYS serves an archive, never a bare exe, so
   * staging it verbatim would hand the swap a ZIP named `temp_update.exe` — which
   * fails the PE check, and would brick the node outright if that check ever
   * moved. The archive goes to a scratch file, is unpacked, and the exe inside is
   * COPIED to `partialPath`, after which size/PE/checksum verification runs
   * unchanged, on the real executable.
   *
   * COPY, NOT MOVE: the staging directory and its scratch child can sit on
   * different volumes, where `renameSync` throws EXDEV — which reads as a
   * mysterious "update aborted" on exactly the machines that need the update.
   *
   * @returns the SHA-256 of the ARCHIVE. The Mothership may have published that
   *          digest rather than the binary's, and {@link verifyStagedFile}
   *          accepts either.
   */
  private async downloadArtifactZip(
    url: string,
    headers: Record<string, string>,
    partialPath: string,
    artifactName: string,
  ): Promise<string> {
    const scratch = path.join(path.dirname(partialPath), "artifact");
    const zipPath = `${partialPath}.zip`;
    const unpackDir = path.join(scratch, "unpacked");

    fs.rmSync(scratch, { recursive: true, force: true });
    fs.mkdirSync(unpackDir, { recursive: true });
    try {
      const archiveDigest = await this.streamTo(url, headers, zipPath);
      await extract(zipPath, { dir: unpackDir });
      const exe = findWorkflowExe(unpackDir);
      if (!exe) {
        throw new Error(
          `the GitHub Actions artifact "${artifactName}" published no ` +
            `${currentReleaseAssetName()} — it contained: ${describeEntries(unpackDir)}`,
        );
      }
      fs.copyFileSync(exe, partialPath);
      console.log(`[OTA] Unpacked ${path.basename(exe)} from the GitHub Actions artifact.`);
      return archiveDigest;
    } finally {
      // Pure intermediate state: leaving ~126 MB of it behind on every failed
      // attempt is how the persistent data directory fills up.
      fs.rmSync(scratch, { recursive: true, force: true });
      fs.rmSync(zipPath, { force: true });
    }
  }

  /**
   * Streams `url` to `target`, returning the SHA-256 of what was written.
   *
   * Shared by both routes so an artifact download and a release-asset download
   * report identically — an operator debugging a stalled update should not have
   * to know which one fed it.
   *
   * NO SIZE OR SIGNATURE CHECK HAPPENS HERE. On the artifact route the file
   * streamed is a ZIP, so the MZ magic and the `MIN_UPDATE_BYTES` floor only make
   * sense on the exe inside it — those live in {@link verifyStagedFile}, which
   * both routes end in.
   */
  private async streamTo(
    url: string,
    headers: Record<string, string>,
    target: string,
    diagnostics: string[] = [],
  ): Promise<string> {
    // One line, however many the resolution produced, appended to any failure so
    // the log never shows a 404 without the reason it was a 404.
    const cause = (): string => (diagnostics.length ? ` ${diagnostics.join(" ")}` : "");

    let response;
    try {
      response = await axios.get(url, {
        responseType: "stream",
        timeout: DOWNLOAD_TIMEOUT_MS,
        headers,
        validateStatus: (status) => status >= 200 && status < 300,
      });
    } catch (error) {
      /*
        A 404 here has THREE indistinguishable causes, and the operator can only
        act on the real one, so name all of them rather than "download failed":
        the asset was renamed, the repository is private and no token is
        configured, or the Mothership is advertising a stale URL.
      */
      if (axios.isAxiosError(error) && error.response?.status === 404) {
        throw new Error(
          `HTTP 404 downloading ${url} — either no release asset named ` +
            `"${currentReleaseAssetName()}" exists on the latest release, or the repository ` +
            `is PRIVATE and no GITHUB_OTA_TOKEN is configured (a private repo 404s every ` +
            `anonymous request). ${OTA_404_HINT}${cause()}`,
        );
      }
      // 401/403 from the ASSET endpoint are just as opaque as the 404 above, and
      // a rejected token is the single most likely misconfiguration here.
      if (axios.isAxiosError(error) && (error.response?.status === 401 || error.response?.status === 403)) {
        throw new Error(
          `HTTP ${error.response?.status} downloading ${url} — GitHub rejected the ` +
            `configured token: ${statusExplanation(error.response?.status ?? 0)}${cause()}`,
        );
      }
      throw error;
    }

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
      fs.createWriteStream(target),
    );

    return hash.digest("hex");
  }

  /**
   * Confirms what was staged is a REAL Windows executable of a plausible size
   * and — when the Mothership published one — matches the expected SHA-256.
   *
   * This is what makes the zip route trustworthy: the artifact endpoint could
   * return a 200 with an HTML error page, a truncated archive, or a superseded
   * binary, and the only thing standing between any of those and a bricked node
   * is the MZ magic read here.
   *
   * EITHER DIGEST IS ACCEPTED, and the reason is the artifact route. There the
   * streamed bytes are the ARCHIVE while the staged file is the exe extracted
   * from it, so a checksum describing either one is a valid integrity check —
   * and a checksum that matches NEITHER is refused.
   */
  private async verifyStagedFile(
    latest: LatestVersionInfo,
    partialPath: string,
    updateFileName: string,
    streamedDigest?: string,
  ): Promise<void> {
    const { size } = fs.statSync(partialPath);
    if (size < MIN_UPDATE_BYTES) {
      throw new Error(
        `download is only ${formatMb(size)} — expected at least ${formatMb(MIN_UPDATE_BYTES)}`,
      );
    }

    // Windows only: the payload must be a real PE executable, not an HTML error
    // page or a JSON body that happened to return HTTP 200.
    if (updateFileName.toLowerCase().endsWith(".exe")) {
      const header = await readFirstBytes(partialPath, 2);
      if (header.toString("latin1") !== "MZ") {
        throw new Error("downloaded file is not a Windows executable (missing MZ header)");
      }
    }

    if (latest.sha256) {
      const expected = latest.sha256.trim().toLowerCase();
      let matched = streamedDigest?.toLowerCase() === expected;
      if (!matched) matched = (await sha256OfFile(partialPath)).toLowerCase() === expected;
      if (!matched) {
        throw new Error(
          `checksum mismatch (expected ${latest.sha256}, got ${streamedDigest ?? "no digest"})`,
        );
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
   *
   * Deliberately silent: the caller owns the dev-mode messaging, because only
   * the caller knows whether this is a routine poll (worth a quiet note) or a
   * `FORCE_UPDATE` that must still be acknowledged (worth the exact bypass line
   * operators grep for).
   */
  private installTarget(): InstallTarget | null {
    if (!this.isPackagedExe()) {
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

/**
 * Streams a file through SHA-256 and returns the hex digest.
 *
 * A separate pass rather than a hash fed by the download stream, because the
 * artifact route hashes the EXTRACTED EXE — a file that never passed through the
 * download stream at all. Only reached when the Mothership published a checksum
 * that the streamed bytes did not already match.
 */
async function sha256OfFile(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of fs.createReadStream(filePath)) {
    hash.update(chunk as Buffer);
  }
  return hash.digest("hex");
}

/**
 * Names inside a directory, for an error message. Never throws.
 *
 * Why it exists at all: "the artifact published no rippa-node.exe" is
 * unactionable without knowing what it DID publish — a renamed exe, a nested
 * folder, or an empty archive are three different fixes.
 */
function describeEntries(dir: string): string {
  try {
    const names: string[] = [];
    const walk = (current: string, depth: number): void => {
      if (depth > 4) return;
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        names.push(entry.name);
        if (entry.isDirectory()) walk(path.join(current, entry.name), depth + 1);
      }
    };
    walk(dir, 0);
    return names.length ? names.slice(0, 20).join(", ") : "(nothing)";
  } catch {
    return "(could not be listed)";
  }
}

/**
 * Names the likely cause of a rejected GitHub credential.
 *
 * A 401/403 from the asset endpoint means the token itself is wrong — expired,
 * revoked, or scoped without access to this repository — and that is a
 * completely different operator task from "the asset is missing". Without this,
 * both surface as an anonymous HTTP status with no actionable content.
 */
function statusExplanation(status: number): string {
  if (status === 401) {
    return "the token is missing, expired or malformed. Set GITHUB_OTA_TOKEN in the " +
      "node's .env with read access to the release repository. " + OTA_404_HINT;
  }
  if (status === 403) {
    return "the token lacks access to this repository, or the GitHub API rate limit " +
      "for it has been exhausted.";
  }
  return "GitHub rejected the request.";
}

function describeError(error: unknown): string {
  if (axios.isAxiosError(error)) {
    const status = error.response?.status;
    return status ? `HTTP ${status} — ${error.message}` : error.message;
  }
  return error instanceof Error ? error.message : String(error);
}
