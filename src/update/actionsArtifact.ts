import fs from "node:fs";
import path from "node:path";
import {
  currentReleaseAssetName,
  githubHeaders,
  resolveGitHubToken,
  GITHUB_REPO,
} from "./githubAsset";

/**
 * CI/CD ARTIFACT-BASED OTA — the latest SUCCESSFUL BUILD, not the latest tag.
 *
 * WHY THIS EXISTS. The updater historically polled `/releases/latest`, which
 * means the fleet only ever moved when a human published a SemVer-tagged
 * release. Every push to `main` compiled a new binary, and every node sat on the
 * old one: the "I pushed a fix and the node still has the bug" failure.
 *
 * The build workflow already uploads `rippa-node-windows` on EVERY run. That
 * artifact IS the deployment unit, and GitHub Actions answers "what is deployed
 * right now?" far more directly than Releases does:
 *
 *   1. `GET /repos/{repo}/actions/runs?branch=main&status=success`
 *   2. take the most recent successful run's `id` (and `head_sha`);
 *   3. `GET /repos/{repo}/actions/runs/{run_id}/artifacts`
 *   4. pick the compiled `.exe` / `.zip`;
 *   5. `GET /repos/{repo}/actions/artifacts/{artifact_id}/zip` — which is ALWAYS a
 *      zip, so the binary is extracted from it rather than streamed straight to
 *      disk.
 *
 * THE RUN ID IS THE VERSION. Releases gave a node something monotonically
 * comparable; run IDs are strictly increasing integers, so "is the remote newer
 * than what I am running" is a numeric comparison that needs no SemVer parsing
 * and cannot be defeated by two builds sharing a version string. The locally
 * installed run ID is persisted by `updateStamp` and compared against this one.
 *
 * The Releases path is NOT removed — it remains the fallback, so a node whose
 * Actions API access is denied still updates exactly as it did before.
 */

/** The workflow artifact holding the compiled Windows node. */
export const WORKFLOW_ARTIFACT_NAME =
  process.env.RIPPA_GITHUB_ARTIFACT || "rippa-node-windows";

/** The branch whose successful runs are treated as deployments. */
export const WORKFLOW_BRANCH = process.env.RIPPA_GITHUB_BRANCH || "main";

/** The `.exe` inside the artifact zip, once extracted. */
export const WORKFLOW_EXE_NAME = process.env.RIPPA_GITHUB_ASSET || "rippa-node.exe";

/** A deployed build, resolved from one successful workflow run. */
export interface ArtifactBuild {
  /** Monotonic run id — the primary "is this newer" signal. */
  runId: number;
  /** Run number, purely for the log line. */
  runNumber?: number;
  /** Commit the run built. */
  headSha: string;
  /** Version parsed out of the run's display title, when it carries one. */
  version?: string;
  /** Authenticated download endpoint for the artifact zip. */
  zipUrl: string;
  /** Size GitHub reports for the zip, in bytes. */
  sizeInBytes?: number;
  /** Artifact name that was selected. */
  artifactName: string;
  /** ISO instant the run completed. */
  createdAt?: string;
}

/** Minimal shape of a workflow run in the API payload. */
export interface WorkflowRun {
  id?: number;
  run_number?: number;
  head_sha?: string;
  status?: string;
  conclusion?: string;
  head_branch?: string;
  created_at?: string;
  display_title?: string;
  name?: string;
}

/** Minimal shape of an artifact in the API payload. */
export interface WorkflowArtifact {
  id?: number;
  name?: string;
  size_in_bytes?: number;
  expired?: boolean;
}

/** The workflow-run list endpoint, newest first. */
export function workflowRunsApiUrl(repo = GITHUB_REPO, branch = WORKFLOW_BRANCH): string {
  const safeBranch = encodeURIComponent(branch);
  return (
    `https://api.github.com/repos/${repo}/actions/runs` +
    `?branch=${safeBranch}&status=success&per_page=10`
  );
}

/** One run's artifact list. */
export function workflowRunArtifactsApiUrl(repo: string, runId: number | string): string {
  return `https://api.github.com/repos/${repo}/actions/runs/${runId}/artifacts`;
}

/** The authenticated zip endpoint for one artifact. */
export function workflowArtifactZipApiUrl(repo: string, artifactId: number | string): string {
  return `https://api.github.com/repos/${repo}/actions/artifacts/${artifactId}/zip`;
}

/**
 * Picks the newest COMPLETED, SUCCESSFUL run out of the list payload.
 *
 * `status=success` is already a query filter, but the filter is applied again
 * here rather than trusted: an API that answers 200 with a run that is still
 * `in_progress` would otherwise have the node install an artifact from a build
 * that has not finished — and `actions/upload-artifact` runs at the END of the
 * job, so a mid-flight run has no artifact at all and the download 404s.
 */
export function pickNewestSuccessfulRun(payload: unknown): WorkflowRun | null {
  if (!payload || typeof payload !== "object") return null;
  const runs = (payload as { workflow_runs?: unknown }).workflow_runs;
  if (!Array.isArray(runs)) return null;

  const usable = runs
    .filter((run): run is WorkflowRun => !!run && typeof run === "object")
    .filter((run) => run.status === "completed" && run.conclusion === "success")
    .filter((run) => typeof run.id === "number")
    .sort((a, b) => (b.id ?? 0) - (a.id ?? 0));

  return usable[0] ?? null;
}

/**
 * Picks the artifact holding the compiled node.
 *
 * EXACT NAME FIRST, then any `.zip`, then any `.exe`. The workflow uploads
 * several artifacts (`rippa-node-windows`, `rippa-satellite-apk`) and picking
 * the wrong one either 404s or installs an APK over a worker. An expired
 * artifact is skipped outright: GitHub reports those as present but answers
 * 410 on download, which used to surface as an unexplained OTA abort.
 */
export function selectWorkflowArtifact(
  payload: unknown,
  preferred: string = WORKFLOW_ARTIFACT_NAME,
): WorkflowArtifact | null {
  if (!payload || typeof payload !== "object") return null;
  const artifacts = (payload as { artifacts?: unknown }).artifacts;
  if (!Array.isArray(artifacts)) return null;

  const usable = artifacts
    .filter((entry): entry is WorkflowArtifact => !!entry && typeof entry === "object")
    .filter((entry) => typeof entry.id === "number" && typeof entry.name === "string")
    .filter((entry) => entry.expired !== true);

  const exact = usable.find((entry) => entry.name!.toLowerCase() === preferred.toLowerCase());
  if (exact) return exact;

  return (
    usable.find((entry) => entry.name!.toLowerCase().endsWith(".zip")) ??
    usable.find((entry) => entry.name!.toLowerCase().endsWith(".exe")) ??
    null
  );
}

/** Pulls `[major, minor, patch]` out of a run title, or null. */
function versionFromRun(run: WorkflowRun): string | undefined {
  for (const field of [run.display_title, run.name]) {
    const match = /v?(\d+\.\d+\.\d+)/.exec(typeof field === "string" ? field : "");
    if (match) return match[1];
  }
  return undefined;
}

/** Headers for the artifact zip download — the token is mandatory here. */
export function workflowZipHeaders(): Record<string, string> {
  return githubHeaders({ Accept: "application/vnd.github+json" });
}

/**
 * Resolves the newest successful deployment, or `null` when GitHub offers none.
 *
 * A token is REQUIRED, not optional: `actions/*` endpoints are never readable
 * anonymously on a private repository, and this module has no meaningful
 * anonymous mode — there is no anonymous fallback to degrade into.
 */
export async function fetchLatestArtifactBuild(
  options: { repo?: string; branch?: string } = {},
): Promise<ArtifactBuild | null> {
  const repo = options.repo ?? GITHUB_REPO;
  if (!resolveGitHubToken()) {
    console.log(
      `[Updater] Actions-artifact OTA needs a GitHub token (GITHUB_OTA_TOKEN) — ` +
        "falling back to the rolling release feed.",
    );
    return null;
  }

  const headers = githubHeaders();
  let runsPayload: unknown;
  try {
    const response = await fetch(workflowRunsApiUrl(repo, options.branch ?? WORKFLOW_BRANCH), {
      headers,
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      console.warn(
        `[Updater] Workflow runs query returned HTTP ${response.status} — ` +
          "falling back to the rolling release feed.",
      );
      return null;
    }
    runsPayload = await response.json();
  } catch (error) {
    console.warn(
      `[Updater] Could not reach the Actions runs API — ${
        error instanceof Error ? error.message : String(error)
      }. Falling back to the rolling release feed.`,
    );
    return null;
  }

  const run = pickNewestSuccessfulRun(runsPayload);
  if (!run) {
    console.log(
      `[Updater] No successful ${options.branch ?? WORKFLOW_BRANCH} workflow run has published ` +
        "an artifact yet.",
    );
    return null;
  }

  let artifactsPayload: unknown;
  try {
    const response = await fetch(workflowRunArtifactsApiUrl(repo, run.id!), {
      headers,
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      console.warn(`[Updater] Artifact list for run ${run.id} returned HTTP ${response.status}.`);
      return null;
    }
    artifactsPayload = await response.json();
  } catch (error) {
    console.warn(
      `[Updater] Could not list artifacts for run ${run.id} — ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return null;
  }

  const artifact = selectWorkflowArtifact(artifactsPayload);
  if (!artifact) {
    console.log(`[Updater] Workflow run ${run.id} published no installable artifact.`);
    return null;
  }

  return {
    runId: run.id!,
    ...(run.run_number ? { runNumber: run.run_number } : {}),
    headSha: run.head_sha ?? "",
    ...(versionFromRun(run) ? { version: versionFromRun(run) } : {}),
    zipUrl: workflowArtifactZipApiUrl(repo, artifact.id!),
    ...(artifact.size_in_bytes ? { sizeInBytes: artifact.size_in_bytes } : {}),
    artifactName: artifact.name!,
    ...(run.created_at ? { createdAt: run.created_at } : {}),
  };
}

/* ===========================================================================
   THE GITHUB ACTIONS RUN URL — the shape a `FORCE_UPDATE` actually carries.

   WHAT WAS BROKEN. The Mothership's FORCE_UPDATE arrives with a `download_url`
   that names a CI RUN:

       https://github.com/Farko420/rippa-node/actions/runs/1234567890

   That is an HTML page, not an asset. The OTA pipeline fed it to the RELEASE
   resolver, which asked `/repos/{repo}/releases/latest` for an asset list — a
   release that has nothing to do with the run — and then streamed the run URL
   itself, which answers HTTP 404 to a GET. The node logged
   "HTTP 404 downloading …" and stayed on the old build, which is exactly the
   reported symptom. Nothing was wrong with the token or the repo: the URL was
   being asked for the wrong thing entirely.

   WHAT THE RUN URL ACTUALLY POINTS AT. A run's `actions/upload-artifact` output
   IS the deployment unit, and it is reachable through the API:

       GET /repos/{repo}/actions/runs/{run_id}/artifacts  → pick the artifact
       GET /repos/{repo}/actions/artifacts/{id}/zip       → the bytes (ALWAYS a
                                                            zip, never a bare exe)

   Both endpoints require authentication on a private repository, so
   {@link resolveActionsRunDownload} refuses to pretend: without a token it
   reports exactly which env var is missing instead of letting the anonymous 404
   speak for itself. The zip is unpacked by the caller (see
   `OtaUpdater.downloadArtifactZip`), because staging an archive named
   `temp_update.exe` fails the PE check and would brick the node if that check
   ever moved.
   =========================================================================== */

/** A run page on github.com: `/<owner>/<repo>/actions/runs/<id>`. */
const ACTIONS_RUN_PAGE_PATTERN =
  /^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+)\/actions\/runs\/(\d+)/i;

/** The same run through the API: `/repos/<owner>/<repo>/actions/runs/<id>`. */
const ACTIONS_RUN_API_PATTERN =
  /^https?:\/\/api\.github\.com\/repos\/([^/]+)\/([^/]+)\/actions\/runs\/(\d+)/i;

/**
 * Matches either URL form, capturing `[owner, repo, runId]`.
 *
 * A trailing path (`/attempts/2`) is deliberately tolerated: GitHub's UI links
 * a re-run as `.../actions/runs/<id>/attempts/<n>`, and the artifact list is
 * keyed on the RUN, so the attempt number is not part of what we ask for.
 */
function actionsRunMatch(url: string): RegExpExecArray | null {
  const trimmed = (url ?? "").trim();
  return ACTIONS_RUN_PAGE_PATTERN.exec(trimmed) ?? ACTIONS_RUN_API_PATTERN.exec(trimmed);
}

/** True when `url` names a GitHub Actions RUN rather than a release asset. */
export function isActionsRunUrl(url: string): boolean {
  return actionsRunMatch(url) !== null;
}

/** The `owner/name` a run URL belongs to, or null when it is not a run URL. */
export function repoFromActionsUrl(url: string): string | null {
  const match = actionsRunMatch(url);
  return match ? `${match[1]}/${match[2]}` : null;
}

/**
 * The monotonic run id a run URL names, or null.
 *
 * Guarded rather than `Number(match[3])` bare: a truncated URL
 * (`.../actions/runs/`) matches nothing at all, and a value that is not a safe
 * integer would be interpolated into an API path and 404 there instead of being
 * reported as the malformed URL it is.
 */
export function actionsRunIdFromUrl(url: string): number | null {
  const match = actionsRunMatch(url);
  if (!match) return null;
  const id = Number(match[3]);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/** A resolved, authenticated Actions-artifact download. */
export interface ActionsRunDownload {
  /** `api.github.com` artifact zip endpoint — ALWAYS an archive. */
  url: string;
  /** Headers for that GET, carrying the Bearer token. */
  headers: Record<string, string>;
  /** The run the artifact came from — the monotonic deployment id. */
  runId: number;
  /** Artifact name that was selected, for the log line. */
  artifactName: string;
  /** Version parsed out of the run's title, when it carries one. */
  version?: string;
}

/** Knobs for {@link resolveActionsRunDownload}; both have safe defaults. */
export interface ActionsRunResolveOptions {
  /** Prefix for emitted log lines (`[OTA]` vs `[Updater]`). */
  logPrefix?: string;
  /** Sink the caller re-throws into its own failure message. */
  diagnostics?: string[];
}

/**
 * Resolves ONE specific run's artifact build — the run the Mothership named.
 *
 * Distinct from {@link fetchLatestArtifactBuild}, which asks "what is the newest
 * successful run?" This one is TOLD which run to install, so it must not fall
 * back to a newer one: an operator re-sending a FORCE_UPDATE for a known-good
 * build has to get THAT build, not whatever CI happened to finish since.
 *
 * Never throws: every failure is logged (and pushed into `diagnostics`) and
 * answered with `null`, so the caller reports a truthful FAILED update instead
 * of crashing the node mid-command.
 */
export async function fetchRunArtifactBuild(
  repo: string,
  runId: number,
  options: { logPrefix?: string; diagnostics?: string[] } = {},
): Promise<ArtifactBuild | null> {
  const prefix = options.logPrefix ?? "[Updater]";
  const emit = (line: string): void => {
    console.warn(line);
    options.diagnostics?.push(line);
  };

  let payload: unknown;
  try {
    const response = await fetch(workflowRunArtifactsApiUrl(repo, runId), {
      headers: githubHeaders(),
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      emit(
        `${prefix} Artifact list for GitHub Actions run ${runId} returned HTTP ${response.status}` +
          (response.status === 404
            ? " — the run does not exist, or the configured token cannot see this private repository"
            : "") +
          ".",
      );
      return null;
    }
    payload = await response.json();
  } catch (error) {
    emit(
      `${prefix} Could not list the artifacts for GitHub Actions run ${runId} — ` +
        `${error instanceof Error ? error.message : String(error)}.`,
    );
    return null;
  }

  const artifact = selectWorkflowArtifact(payload);
  if (!artifact || typeof artifact.id !== "number" || typeof artifact.name !== "string") {
    emit(
      `${prefix} GitHub Actions run ${runId} published no installable artifact ` +
        `(expected "${WORKFLOW_ARTIFACT_NAME}", or any non-expired .zip/.exe).`,
    );
    return null;
  }

  return {
    runId,
    headSha: "",
    zipUrl: workflowArtifactZipApiUrl(repo, artifact.id),
    artifactName: artifact.name,
    ...(artifact.size_in_bytes ? { sizeInBytes: artifact.size_in_bytes } : {}),
  };
}

/**
 * Turns a GitHub Actions RUN URL into an authenticated artifact download.
 *
 * Returns `null` when `url` is not a run URL at all (the caller keeps its
 * existing release-asset path), and also when the run cannot be resolved — in
 * which case the diagnostics say why, so the 404 that follows is explained
 * rather than mysterious.
 */
export async function resolveActionsRunDownload(
  url: string,
  options: ActionsRunResolveOptions = {},
): Promise<ActionsRunDownload | null> {
  const prefix = options.logPrefix ?? "[Updater]";
  const emit = (line: string): void => {
    console.warn(line);
    options.diagnostics?.push(line);
  };

  if (!isActionsRunUrl(url)) return null;

  const repo = repoFromActionsUrl(url);
  const runId = actionsRunIdFromUrl(url);
  if (!repo || runId === null) {
    emit(
      `${prefix} The advertised GitHub Actions URL is malformed (${url.trim()}) — expected ` +
        "https://github.com/<owner>/<repo>/actions/runs/<id>.",
    );
    return null;
  }

  /*
    THE TOKEN IS MANDATORY HERE, NOT OPTIONAL.

    `actions/*` endpoints are never readable anonymously, on a public OR a
    private repository, so there is no anonymous mode to degrade into. Naming the
    missing variable is the whole point: an operator staring at
    "HTTP 404 downloading .../actions/runs/123" has no way to know the fix is one
    `.env` line.
  */
  if (!resolveGitHubToken()) {
    emit(
      `${prefix} Downloading GitHub Actions run ${runId} requires a token — set ` +
        "GITHUB_OTA_TOKEN (or RIPPA_GITHUB_TOKEN / GITHUB_TOKEN) in the node's .env " +
        "or config.json. Actions artifacts are never readable anonymously.",
    );
    return null;
  }

  const build = await fetchRunArtifactBuild(repo, runId, {
    logPrefix: prefix,
    ...(options.diagnostics ? { diagnostics: options.diagnostics } : {}),
  });
  if (!build) return null;

  emit(
    `${prefix} Resolved GitHub Actions run ${runId} to artifact "${build.artifactName}" — ` +
      `${build.zipUrl} (the payload is a ZIP and will be unpacked).`,
  );

  return {
    url: build.zipUrl,
    /*
      The artifact endpoint ALWAYS serves an archive, so `application/octet-stream`
      would describe the wrong thing; the GitHub JSON accept plus the Bearer token
      is what this API expects (and what the fleet updater already uses for the
      very same endpoint).
    */
    headers: workflowZipHeaders(),
    runId: build.runId,
    artifactName: build.artifactName,
    ...(build.version ? { version: build.version } : {}),
  };
}

/**
 * Finds the compiled node inside an unpacked workflow artifact.
 *
 * EXACT NAME FIRST, then any `.exe` EXCLUDING the watchdog. Installing the
 * supervisor over the worker is a silent, total failure — the machine comes back
 * running a watchdog that spawns no node and reports the host offline — so the
 * watchdog is never a candidate, not even as a last resort.
 *
 * Shared by both updaters so a change to the artifact layout (a new subfolder, a
 * renamed exe) cannot be fixed in one and missed in the other.
 */
export function findWorkflowExe(
  dir: string,
  preferred: string = currentReleaseAssetName(),
): string | null {
  const files: string[] = [];
  const walk = (current: string, depth: number): void => {
    if (depth > 4) return;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else files.push(full);
    }
  };
  walk(dir, 0);

  const exes = files.filter((file) => file.toLowerCase().endsWith(".exe"));
  const exact = exes.find(
    (file) => path.basename(file).toLowerCase() === preferred.toLowerCase(),
  );
  if (exact) return exact;
  return exes.find((file) => !/watchdog/i.test(path.basename(file))) ?? null;
}