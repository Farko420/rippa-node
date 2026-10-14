/**
 * GITHUB RELEASE ACCESS — how a node reaches a release asset, authenticated.
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM `services/updater.ts`.
 *
 * Two independent updaters need to talk to GitHub — `services/updater.ts` (the
 * Master poller that broadcasts to the fleet) and `update/OtaUpdater.ts` (the
 * Mothership `FORCE_UPDATE` path) — and neither may reimplement the private-repo
 * rules. It also keeps them importable in either direction without a cycle:
 * `services/updater.ts` already imports the handoff helpers from `update/`, so
 * putting this pure module beside them means `update/` never has to reach back
 * into `services/`.
 *
 * THE PROBLEM THIS SOLVES — THE 404 THAT IS NOT A MISSING ASSET.
 *
 * `https://github.com/<repo>/releases/latest/download/rippa-node.exe` is a
 * literal filename lookup that works only for a PUBLIC repository. A PRIVATE
 * repository answers **404** to every anonymous request — deliberately, so the
 * repo's existence is not disclosed — and that 404 is identical to "no asset by
 * that name". A node with a perfectly correct `download_url` and a perfectly
 * correct asset name therefore fails in a way that looks like a packaging bug,
 * and no amount of fixing the filename makes it work.
 *
 * The only fix is to AUTHENTICATE, and GitHub's authenticated asset download is
 * the API rather than the `/releases/latest/download/` shortcut:
 *
 *   1. `GET /repos/{repo}/releases/latest` (JSON) to list the release's assets.
 *   2. `GET /repos/{repo}/releases/assets/{id}` with
 *      `Accept: application/octet-stream` and `Authorization: Bearer <token>`,
 *      which streams the binary itself.
 *
 * So {@link resolveGitHubAssetDownload} turns the public shortcut URL into that
 * API call. It degrades gracefully: with no token it returns `null` and the
 * caller uses the URL unchanged, which is exactly right for a public repo and
 * leaves the 404 message to explain itself if the repo is private and
 * unconfigured.
 */

/** GitHub repository publishing the fleet releases ("owner/name"). */
export const GITHUB_REPO = process.env.RIPPA_GITHUB_REPO || "Farko420/rippa-node";

/**
 * The release asset name, EXACTLY.
 *
 * `/releases/latest/download/<asset>` is a literal filename lookup, so this string
 * is part of the updater's public contract rather than a packaging detail.
 * `RIPPA_GITHUB_ASSET` overrides it for a fork that publishes under its own name.
 */
export const RELEASE_ASSET_NAME = process.env.RIPPA_GITHUB_ASSET || "rippa-node.exe";

/**
 * THE ANDROID RELEASE ASSET, in preference order.
 *
 * WHY A LIST RATHER THAN ONE NAME. The desktop artefact has exactly one
 * contract name (`rippa-node.exe`) because `scripts/package.mjs` and the OTA
 * updater both hardcode it. The Android artefact does NOT: the release workflow
 * renames Gradle's output to `rippa-satellite.apk` at the workspace root, while
 * an operator hand-publishing a build, or a future packaging change, will
 * naturally reach for `rippa-node.apk` or the raw Gradle name
 * `app-release.apk`. Naming only one of the three would turn a cosmetic rename
 * into "the provisioning endpoint cannot see the Android build", which is
 * exactly the failure mode the desktop fallback below already guards against.
 *
 * ORDER MATTERS ONLY WHEN SEVERAL EXIST, which should never happen: the first
 * match wins, so the most likely names are tried first.
 */
export const ANDROID_RELEASE_ASSET_NAMES: readonly string[] = [
  "rippa-node.apk",
  "app-release.apk",
  "rippa-satellite.apk",
];

/**
 * The OS a provisioning bundle is being generated for.
 *
 * Deliberately NOT `process.platform`'s vocabulary: this is the TARGET the
 * operator is provisioning, not the host doing the provisioning, so `win32`
 * and `darwin` would be actively misleading. `windows` is the desktop build
 * (`pkg` targets `node22-win-x64`); `android` is the Capacitor APK.
 */
export type ProvisionPlatform = "windows" | "android";

/** Every platform {@link releaseAssetNamesForPlatform} understands. */
export const PROVISION_PLATFORMS: readonly ProvisionPlatform[] = ["windows", "android"];

/** The preferred asset names per platform. */
export const PLATFORM_RELEASE_ASSET_NAMES: Record<ProvisionPlatform, readonly string[]> = {
  windows: [RELEASE_ASSET_NAME],
  android: ANDROID_RELEASE_ASSET_NAMES,
};

/**
 * The fallback extension per platform — what "any real artefact" means when no
 * preferred name matches.
 *
 * This is the safety net that stops a rename from wedging a whole platform, so
 * it must be the extension the target can actually execute: `.exe` for the
 * desktop build, `.apk` for Android. Falling back to `.exe` on Android would
 * resolve a Windows binary into an APK-shaped bundle and only fail on the
 * tablet.
 */
export const PLATFORM_RELEASE_EXTENSIONS: Record<ProvisionPlatform, readonly string[]> = {
  windows: [".exe"],
  android: [".apk"],
};

/**
 * The asset names to try for a platform, most-preferred first.
 *
 * `RIPPA_GITHUB_ASSET` is honoured for `windows` ONLY, because that variable
 * exists to repoint the fleet's own OTA at a differently-named desktop build —
 * the Android artefact has no such single contract name to override, and
 * letting a desktop override leak into an APK lookup would resolve the wrong
 * file.
 */
export function releaseAssetNamesForPlatform(platform: ProvisionPlatform): readonly string[] {
  if (platform === "windows") {
    const override = (process.env.RIPPA_GITHUB_ASSET || "").trim();
    if (override) return [override, ...PLATFORM_RELEASE_ASSET_NAMES.windows];
  }
  return PLATFORM_RELEASE_ASSET_NAMES[platform];
}

/** The fallback extensions to try for a platform (see the note above). */
export function releaseAssetExtensionsForPlatform(
  platform: ProvisionPlatform,
): readonly string[] {
  return PLATFORM_RELEASE_EXTENSIONS[platform];
}

/**
 * Resolves a GitHub token from the environment.
 *
 * FOUR names are accepted, in priority order:
 *   `GITHUB_OTA_TOKEN`    the OTA-specific name, and the one this fleet documents
 *   `RIPPA_GITHUB_TOKEN`  node-specific, so a repo token is not shadowed
 *   `GITHUB_TOKEN`        the conventional CI/secret-injection name
 *   `GH_TOKEN`            the GitHub CLI's name, honoured for existing setups
 *
 * `GITHUB_OTA_TOKEN` LEADS because it is the only one of the four that exists
 * solely to authenticate release downloads. `GITHUB_TOKEN` and `GH_TOKEN` are
 * routinely present on a build agent or developer machine for unrelated reasons
 * (Actions checkout, `gh` CLI), so ranking it first would let a CI credential
 * that has no access to a PRIVATE repository outrank the token the operator
 * actually configured for OTA — and the download would 404 with no explanation.
 *
 * Never logged, and never sent to a non-GitHub host — see {@link githubHeaders}.
 */
export function resolveGitHubToken(): string {
  const candidates = [
    process.env.GITHUB_OTA_TOKEN,
    process.env.RIPPA_GITHUB_TOKEN,
    process.env.GITHUB_TOKEN,
    process.env.GH_TOKEN,
  ];
  for (const candidate of candidates) {
    const value = (candidate ?? "").trim();
    if (value) return value;
  }
  return "";
}

/**
 * True when `url` is served by GitHub (the web host, the API, or its CDN).
 *
 * This is a security predicate, not a convenience: it is the only thing standing
 * between a configured repo token and a third-party host named in a
 * Mothership-supplied `download_url`.
 */
export function isGitHubUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return (
      host === "github.com" ||
      host === "www.github.com" ||
      host === "api.github.com" ||
      host.endsWith(".githubusercontent.com")
    );
  } catch {
    return false;
  }
}

/**
 * Headers for a GitHub API call, carrying the token when one is configured.
 *
 * The `Authorization` header is attached ONLY for GitHub hosts. Sending a repo
 * token anywhere else — in particular to whatever URL a compromised Mothership
 * put in `download_url` — would leak it, so the guard is {@link isGitHubUrl} and
 * not merely "a token happens to exist".
 */
export function githubHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "rippa-node-updater",
    ...extra,
  };
  const token = resolveGitHubToken();
  if (token) headers["Authorization"] = `Bearer ${token}`;
  return headers;
}

/** The canonical public download URL for {@link RELEASE_ASSET_NAME}. */
export function releaseDownloadUrl(repo = GITHUB_REPO, asset = RELEASE_ASSET_NAME): string {
  return `https://github.com/${repo}/releases/latest/download/${asset}`;
}

/**
 * The download URL for one asset, built from the EXACT release tag.
 *
 * WHY THE URL IS REBUILT RATHER THAN TRUSTED.
 *
 * GitHub bakes a tag segment into `browser_download_url` at asset-upload time,
 * and the advertised string can carry a segment the release no longer answers
 * to — this fleet's rolling release literally advertises
 * `.../releases/download/latest/rippa-node.exe` while operators talk about the
 * build by its version tag (`v1.0.37`). GitHub's download route requires
 * `.../releases/download/<TAG>/<asset>` with the release's EXACT current tag;
 * any other segment is a hard 404 on the fetch.
 *
 * The tag therefore comes from `release.tag_name` — the same field the version
 * comparison used — so the URL and the advertised version can never disagree,
 * and a hardcoded or stale `"latest"` can never reach the fleet.
 *
 * ONLY GITHUB'S OWN DOWNLOAD URLS ARE REWRITTEN. A CDN link, a test fixture or
 * a Mothership-supplied URL is returned byte-for-byte unchanged: its path shape
 * is not ours to reinterpret. Tags are encoded per `/`-separated segment, so a
 * slash inside a tag stays a path separator (as GitHub serves it) while every
 * other character is percent-encoded.
 */
export function releaseAssetDownloadUrl(
  tag: string,
  assetName: string,
  browserDownloadUrl: string,
): string {
  const source = (browserDownloadUrl ?? "").trim();
  const exactTag = (tag ?? "").trim();
  const name = (assetName ?? "").trim();
  if (!source || !exactTag || !name) return source;

  let parsed: URL;
  try {
    parsed = new URL(source);
  } catch {
    return source;
  }

  const host = parsed.hostname.toLowerCase();
  if (host !== "github.com" && host !== "www.github.com") return source;

  // `<owner>/<repo>/releases/(latest/)download/<name>` — and nothing else
  // under `/releases/` (a tag page, a compare URL) names an asset.
  const segments = parsed.pathname.split("/").filter(Boolean);
  if (segments.length < 4 || segments[2] !== "releases") return source;
  const isDownloadPath =
    segments[3] === "download" || (segments[3] === "latest" && segments[4] === "download");
  if (!isDownloadPath) return source;

  const encode = (value: string): string =>
    value
      .split("/")
      .map((segment) => encodeURIComponent(segment))
      .join("/");
  return (
    `https://github.com/${segments[0]}/${segments[1]}/releases/` +
    `download/${encode(exactTag)}/${encode(name)}`
  );
}

/**
 * The asset name, read from the environment at CALL time.
 *
 * {@link RELEASE_ASSET_NAME} captures the environment when this module is first
 * evaluated, which is only guaranteed to happen after `dotenv` has run if some
 * earlier import happened to pull it in. A node started from a folder where the
 * `.env` load happens later would therefore silently resolve the DEFAULT asset
 * name instead of the operator's override, and the resulting 404 would name the
 * wrong file. Reading it lazily removes that import-ordering dependency.
 */
export function currentReleaseAssetName(): string {
  return (process.env.RIPPA_GITHUB_ASSET || "").trim() || RELEASE_ASSET_NAME;
}

/** The releases API endpoint holding the asset list. */
export function githubReleaseApiUrl(repo = GITHUB_REPO): string {
  return `https://api.github.com/repos/${repo}/releases/latest`;
}

/**
 * The releases LIST endpoint — the only one that includes pre-releases.
 *
 * `per_page` is small on purpose: this is read at most once per update attempt,
 * not polled, and a long list would only slow the failure path down.
 */
export function githubReleasesApiUrl(repo = GITHUB_REPO): string {
  return `https://api.github.com/repos/${repo}/releases?per_page=10`;
}

/** The API endpoint that streams one asset's bytes. */
export function githubAssetApiUrl(repo: string, assetId: number | string): string {
  return `https://api.github.com/repos/${repo}/releases/assets/${assetId}`;
}
/** Matches `/<owner>/<repo>/releases/...` and returns "owner/repo", or null. */
export function repoFromGitHubUrl(url: string): string | null {
  try {
    const match = /^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+)\/releases(?:\/|$)/i.exec(
      url.trim(),
    );
    return match ? `${match[1]}/${match[2]}` : null;
  } catch {
    return null;
  }
}

/** The filename a `/releases/.../download/<name>` URL asks for, or null. */
export function assetNameFromDownloadUrl(url: string): string | null {
  try {
    const segments = new URL(url).pathname.split("/").filter(Boolean);
    // Only a DOWNLOAD URL names a file. `.../releases/tag/v1.0.16` names a tag —
    // and a tag contains dots too, so the path is what separates the two. Without
    // this, a tag URL would be treated as an asset request and never match.
    const downloadAt = segments.lastIndexOf("download");
    if (downloadAt === -1 || downloadAt === segments.length - 1) return null;
    const decoded = decodeURIComponent(segments[segments.length - 1]);
    // A path segment with no extension is not a filename either (an asset id, or
    // a stray trailing slash), so only accept something that looks like one.
    return decoded.includes(".") ? decoded : null;
  } catch {
    return null;
  }
}

/** A fully-authenticated download target. */
export interface GitHubAssetDownload {
  /** The URL to actually GET. */
  url: string;
  /** Headers for that GET, including `Accept: application/octet-stream`. */
  headers: Record<string, string>;
  /**
   * The asset's own `name`, exactly as the release publishes it.
   *
   * Optional because it is additive: the updaters only ever need the URL, and a
   * caller that resolved an ALREADY-API-shaped asset endpoint (see the early
   * return below) never learns a name. The provisioning endpoint DOES need it —
   * the member inside the bundle must carry the real filename, not a guess, or
   * an operator unzipping `app-release.apk` would find it named
   * `rippa-satellite.apk` and reasonably conclude the wrong build shipped.
   */
  assetName?: string;
  /**
   * Every diagnostic line this resolution emitted, in order.
   *
   * The caller re-throws these with its own failure message, so the reason the
   * authenticated path was chosen (or skipped) survives into the node log and
   * on to the Mothership's FAILED acknowledgement.
   */
  notes?: string[];
}

/**
 * Knobs for {@link resolveGitHubAssetDownload}.
 *
 * Every option has a default that keeps the pre-existing call sites — and their
 * tests — unchanged, because this helper sits on the critical path of a fleet
 * wide self-update and must never surprise a caller that only wants a URL back.
 */
export interface GitHubAssetResolveOptions {
  /**
   * Prefix for emitted log lines. The two updaters label their own output
   * differently (`[OTA]` vs `[Updater]`) and this keeps that convention.
   */
  logPrefix?: string;
  /**
   * A sink that ALSO receives every emitted line.
   *
   * `console.warn` alone is not enough for the failure path: the interesting
   * detail has to be attached to the thrown error so the caller's own log line
   * carries the cause, and the process may exit before a flush.
   */
  diagnostics?: string[];
  /**
   * Consult the releases LIST (which includes pre-releases) when
   * `/releases/latest` has nothing to offer.
   *
   * Off by default, deliberately. `GET /releases/latest` skips pre-releases and
   * answers 404 when the newest published release is one, so a repo shipping
   * only an RC looks exactly like a repo that has published nothing — but a
   * node that silently starts installing release candidates because the stable
   * feed went quiet is a worse failure than one that waits. Opt in per node
   * with `RIPPA_GITHUB_ALLOW_PRERELEASE=true`.
   */
  allowPrerelease?: boolean;
  /**
   * The asset names to prefer, in order, REPLACING the desktop default.
   *
   * Omitted (the updaters' case) the candidates are the name the URL asked for
   * and then {@link currentReleaseAssetName} — the pre-existing behaviour,
   * unchanged. Supplied (the provisioning endpoint's case) the platform's own
   * names are used instead, so an Android lookup is never offered
   * `rippa-node.exe` as a candidate.
   */
  assetNames?: readonly string[];
  /**
   * The extensions that count as "a real artefact" when no preferred name
   * matches. Defaults to `[".exe"]`.
   *
   * It also decides the wording of the failure line below, which is why it is
   * threaded through rather than hardcoded: an operator provisioning Android
   * must not be told the release has no `.exe`.
   */
  assetExtensions?: readonly string[];
}

/** Minimal shape of one asset in the releases payload. */
interface GithubAsset {
  id?: number;
  name?: string;
  url?: string;
  browser_download_url?: string;
}

/** Minimal shape of one release in the releases payload. */
interface GithubRelease {
  tag_name?: string;
  draft?: boolean;
  prerelease?: boolean;
  assets?: unknown;
}

/**
 * Picks the asset to install: an exact contract name first, then the first
 * asset with one of the fallback extensions.
 *
 * `fallbackExtensions` defaults to `[".exe"]`, which is the desktop contract and
 * keeps every existing caller — the updaters and their tests — byte-identical.
 * Android passes `[".apk"]`; see {@link releaseAssetExtensionsForPlatform} for
 * why the extension has to travel with the platform rather than be inferred.
 */
export function selectAssetForDownload(
  assets: unknown,
  preferredNames: readonly string[],
  fallbackExtensions: readonly string[] = [".exe"],
): GithubAsset | null {
  if (!Array.isArray(assets)) return null;
  const usable = assets.filter(
    (candidate): candidate is GithubAsset =>
      !!candidate &&
      typeof candidate === "object" &&
      typeof (candidate as GithubAsset).id === "number" &&
      typeof (candidate as { name?: unknown }).name === "string",
  );
  if (!usable.length) return null;

  for (const preferred of preferredNames) {
    if (!preferred) continue;
    const exact = usable.find(
      (candidate) => candidate.name!.toLowerCase() === preferred.toLowerCase(),
    );
    if (exact) return exact;
  }
  // Never wedge an update over a rename: fall back to the first real artefact
  // with an extension the target can actually run.
  for (const extension of fallbackExtensions) {
    const suffix = extension.trim().toLowerCase();
    if (!suffix) continue;
    const match = usable.find((candidate) => candidate.name!.toLowerCase().endsWith(suffix));
    if (match) return match;
  }
  return null;
}

/**
 * Renders a release payload's asset list for a human-readable log line.
 *
 * Used ONLY for diagnostics. The selection itself is {@link selectAssetForDownload}.
 */
export function describeAssets(assets: unknown): string {
  if (!Array.isArray(assets)) return "(the payload had no assets array)";
  if (assets.length === 0) return "(the release publishes no assets at all)";
  const names = assets
    .map((candidate) => (candidate as GithubAsset)?.name)
    .filter((name): name is string => typeof name === "string" && name.length > 0);
  return names.length ? names.join(", ") : "(assets present but none were named)";
}

/** Metadata lookup timeout. A node polls hourly; this must not hang a check. */
const ASSET_LOOKUP_TIMEOUT_MS = 20_000;

/** How much of a GitHub error body to echo into the log. */
const MAX_BODY_SNIPPET = 400;

/**
 * Reads a failed response's body without letting the read itself throw.
 *
 * The body is the single most useful thing GitHub gives us here — `401` says
 * "Bad credentials", `404` says "Not Found", and `403` says which rate limit or
 * permission was hit — and it is exactly what the previous silent `return null`
 * threw away. A body that cannot be read is reported as such rather than
 * silently omitted, because "no body" and "not attempted" are different bugs.
 */
async function readBodySnippet(response: Response): Promise<string> {
  try {
    const text = await response.text();
    const trimmed = text.trim();
    if (!trimmed) return "(empty body)";
    return trimmed.length > MAX_BODY_SNIPPET
      ? `${trimmed.slice(0, MAX_BODY_SNIPPET)}… (truncated)`
      : trimmed;
  } catch (error) {
    return `(body could not be read: ${error instanceof Error ? error.message : String(error)})`;
  }
}

/**
 * THE ONE-LINE DIAGNOSIS for a 404/401 on the release download.
 *
 * Exported because it is an OPERATOR-FACING CONTRACT, not an implementation
 * detail: it is the single sentence that separates the three indistinguishable
 * causes — a bad token, an inaccessible repo, a release with no `.exe` — from
 * the anonymous 404 they all produce. Kept byte-stable so the support runbook
 * and `verify-units.mjs` can both match on it.
 */
export const OTA_404_HINT =
  "404 Not Found. Ensure GITHUB_OTA_TOKEN is valid, the repo is accessible, " +
  "and the release contains an .exe asset.";

/**
 * Names the likely cause of a GitHub status, so the log says something an
 * operator can act on rather than just the number.
 *
 * 404 and 401 both append {@link OTA_404_HINT} verbatim. Those two statuses are
 * the ones an operator can actually FIX, and the fix is spelled out by name in
 * the hint rather than left to be inferred from a bare status code.
 */
function explainStatus(status: number): string {
  if (status === 401) {
    return (
      "401 Unauthorized — the token is missing, expired, or malformed. " +
      `Check GITHUB_OTA_TOKEN first. ${OTA_404_HINT}`
    );
  }
  if (status === 403) {
    return "403 Forbidden — the token lacks access to this repository, or the " +
      "GitHub API rate limit for it has been exhausted.";
  }
  if (status === 404) {
    return (
      "404 Not Found — GitHub returns this for a PRIVATE repository to " +
      "anonymous callers (deliberately, so its existence is not disclosed), for a " +
      "repo name that does not exist, AND for a repo with no published releases. " +
      `They are indistinguishable from outside; a token is what separates them. ${OTA_404_HINT}`
    );
  }
  if (status === 422) {
    return "422 Unprocessable Entity — GitHub could not find a release for this " +
      "request; often a repo with no non-draft releases at all.";
  }
  return `HTTP ${status}`;
}

/**
 * Fetches one GitHub releases endpoint as JSON, logging every failure loudly.
 *
 * Returns `null` for ANY failure so the caller can fall back to the plain public
 * URL — but it always leaves a diagnostic line explaining itself first. A silent
 * fallback is what turned a private repo, a bad token and a renamed asset into
 * one indistinguishable "HTTP 404" at the download.
 */
async function fetchReleaseJson(
  url: string,
  headers: Record<string, string>,
  emit: (line: string) => void,
): Promise<unknown | null> {
  let response: Response;
  try {
    response = await fetch(url, { headers, signal: AbortSignal.timeout(ASSET_LOOKUP_TIMEOUT_MS) });
  } catch (error) {
    // DNS, TLS, timeout, or a malformed body — never an HTTP status at all.
    emit(
      `[OTA] Could not reach ${url} — ${error instanceof Error ? error.message : String(error)}. ` +
        "This is a network or DNS failure, not a GitHub response.",
    );
    return null;
  }

  if (!response.ok) {
    const body = await readBodySnippet(response);
    emit(`[OTA] ${explainStatus(response.status)} from ${url}. Response body: ${body}`);
    return null;
  }

  try {
    return (await response.json()) as unknown;
  } catch (error) {
    emit(
      `[OTA] ${url} answered ${response.status} with a body that is not JSON — ` +
        `${error instanceof Error ? error.message : String(error)}.`,
    );
    return null;
  }
}

/** The `tag_name` of a release payload, for log lines. */
function tagOf(release: unknown): string {
  const tag = (release as GithubRelease | null)?.tag_name;
  return typeof tag === "string" && tag ? tag : "(untagged)";
}

/**
 * Picks the newest usable release out of a `GET /releases` LIST payload.
 *
 * Drafts are skipped: they are not published to anybody and a node must never
 * install one. Pre-releases are kept — reaching this function at all is the
 * explicit `allowPrerelease` opt-in, and the newest usable entry is what the
 * operator asked for by enabling it.
 */
export function pickNewestRelease(list: unknown): GithubRelease | null {
  if (!Array.isArray(list)) return null;
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    if ((entry as GithubRelease).draft === true) continue;
    return entry as GithubRelease;
  }
  return null;
}

/**
 * Turns a GitHub download URL into an AUTHENTICATED API download when that is
 * possible, or returns `null` to mean "fetch it exactly as given".
 *
 * `null` is returned — never a throw — when the URL is not a GitHub URL, when no
 * token is configured (a public repo needs none), when the URL is already an API
 * asset endpoint, or when the asset lookup fails. Every one of those cases is
 * strictly better served by the caller's original request than by a refusal:
 * this helper improves the private-repo case without ever making the public one
 * worse, and never throws on a path that must not.
 *
 * WHY IT IS NOW LOUD. The original version returned `null` from every failure
 * branch and said nothing, so all three real causes of the 404 — no token, a
 * private repo, a renamed asset — collapsed into the caller's single opaque
 * "HTTP 404" line, and there was no way to tell an expired token from a
 * mistyped repo. Every branch below now emits a line naming the endpoint, the
 * HTTP status, the response body and the assets actually published, and returns
 * those lines on `notes` so the caller can attach them to its thrown error.
 *
 * THE RESOLUTION ORDER, matching the documented download pipeline:
 *   1. `GET /repos/{repo}/releases/latest`  — the stable release.
 *   2. `GET /repos/{repo}/releases`         — only with `allowPrerelease`, and
 *      only when step 1 found nothing; `releases/latest` deliberately SKIPS
 *      pre-releases, so a repo whose newest release is an RC 404s there.
 *   3. Pick the asset whose `name` matches exactly, else the first `.exe`.
 *   4. Use its `url` (the API endpoint) with `Accept: application/octet-stream`.
 */
export async function resolveGitHubAssetDownload(
  url: string,
  options: GitHubAssetResolveOptions = {},
): Promise<GitHubAssetDownload | null> {
  const prefix = options.logPrefix ?? "[OTA]";
  const notes: string[] = [];
  /** Logs one line and mirrors it into the caller's sink. */
  const emit = (line: string): void => {
    notes.push(line);
    console.warn(line);
    options.diagnostics?.push(line);
  };

  if (!isGitHubUrl(url)) return null;

  const token = resolveGitHubToken();
  /*
    NO TOKEN. A public repo still downloads fine unauthenticated, so the URL is
    left exactly as advertised — but this is THE most common cause of the 404 on
    a private repo, and it used to pass in complete silence. Say it, name the
    consequence, and name the two env vars that fix it.
  */
  if (!token) {
    emit(
      `${prefix} No GITHUB_TOKEN provided. Attempting public unauthenticated download, ` +
        "which will fail if the repo is private.",
    );
    emit(
      `${prefix} To fix: set GITHUB_OTA_TOKEN (or RIPPA_GITHUB_TOKEN / GITHUB_TOKEN) ` +
        "in the node's .env, with read access to the release repository " +
        "(a fine-grained token with Contents: Read).",
    );
    return null;
  }

  const trimmed = url.trim();

  // Already an API asset endpoint — just attach the octet-stream Accept.
  const assetEndpoint =
    /^https?:\/\/api\.github\.com\/repos\/[^/]+\/[^/]+\/releases\/assets\/\d+/i.test(trimmed);
  if (assetEndpoint) {
    return {
      url: trimmed,
      headers: githubHeaders({ Accept: "application/octet-stream" }),
      notes,
    };
  }

  const repo = repoFromGitHubUrl(trimmed);
  if (!repo) return null; // a CDN redirect URL: not ours to rewrite.

  // Prefer the name the URL itself asked for, then the platform's contract
  // names — or, when no platform was named, the desktop contract name. Every
  // candidate may be empty (a URL with no filename), and the selector skips
  // blanks rather than treating "" as a name to match.
  const preferred = options.assetNames?.length
    ? [assetNameFromDownloadUrl(trimmed) ?? "", ...options.assetNames]
    : [assetNameFromDownloadUrl(trimmed) ?? "", currentReleaseAssetName()];
  const extensions = options.assetExtensions?.length ? options.assetExtensions : [".exe"];
  const headers = githubHeaders();

  // 1. The stable release.
  let payload = await fetchReleaseJson(githubReleaseApiUrl(repo), headers, emit);

  // 2. Pre-releases, only on explicit opt-in and only when step 1 found nothing.
  if (!payload && options.allowPrerelease) {
    emit(
      `${prefix} No release from /releases/latest for ${repo}; falling back to the ` +
        "releases list because pre-releases are enabled (RIPPA_GITHUB_ALLOW_PRERELEASE).",
    );
    const list = await fetchReleaseJson(githubReleasesApiUrl(repo), headers, emit);
    payload = pickNewestRelease(list);
    if (!payload) {
      emit(`${prefix} The releases list for ${repo} contained no usable (non-draft) release.`);
    }
  }

  if (!payload) return null;

  // 3. Pick the asset, and say so when there is nothing to pick.
  const assets = (payload as GithubRelease | null)?.assets;
  const asset = selectAssetForDownload(assets, preferred, extensions);
  if (!asset || typeof asset.url !== "string") {
    emit(
      `${prefix} Failed to find ${extensions.join("/")} asset in release ` +
        `${tagOf(payload)} payload. Available assets: ${describeAssets(assets)}.`,
    );
    return null;
  }

  emit(
    `${prefix} Resolved "${asset.name}" in release ${tagOf(payload)} to the authenticated ` +
      `asset endpoint ${asset.url} (Accept: application/octet-stream).`,
  );

  return {
    // GitHub's own asset `url` is the API endpoint; `browser_download_url` is the
    // anonymous shortcut that 404s here. Use the former, with octet-stream.
    url: asset.url,
    headers: githubHeaders({ Accept: "application/octet-stream" }),
    assetName: asset.name,
    notes,
  };
}