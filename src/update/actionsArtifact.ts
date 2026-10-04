import { githubHeaders, resolveGitHubToken, GITHUB_REPO } from "./githubAsset";

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