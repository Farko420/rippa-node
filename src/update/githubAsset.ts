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
 * Resolves a GitHub token from the environment.
 *
 * Three names are accepted, in priority order:
 *   `RIPPA_GITHUB_TOKEN`  node-specific, so a repo token is not shadowed
 *   `GITHUB_TOKEN`        the conventional CI/secret-injection name
 *   `GH_TOKEN`            the GitHub CLI's name, honoured for existing setups
 *
 * Never logged, and never sent to a non-GitHub host — see {@link githubHeaders}.
 */
export function resolveGitHubToken(): string {
  const candidates = [
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

/** The releases API endpoint holding the asset list. */
export function githubReleaseApiUrl(repo = GITHUB_REPO): string {
  return `https://api.github.com/repos/${repo}/releases/latest`;
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
}

/** Minimal shape of one asset in the releases payload. */
interface GithubAsset {
  id?: number;
  name?: string;
  url?: string;
  browser_download_url?: string;
}

/** Picks the asset to install: exact contract name first, then any `.exe`. */
export function selectAssetForDownload(
  assets: unknown,
  preferredNames: readonly string[],
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
  // Never wedge OTA over a rename: fall back to the first real executable.
  return usable.find((candidate) => candidate.name!.toLowerCase().endsWith(".exe")) ?? null;
}

/** Metadata lookup timeout. A node polls hourly; this must not hang a check. */
const ASSET_LOOKUP_TIMEOUT_MS = 20_000;

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
 */
export async function resolveGitHubAssetDownload(
  url: string,
): Promise<GitHubAssetDownload | null> {
  if (!isGitHubUrl(url)) return null;

  const token = resolveGitHubToken();
  // No token: a public repo still works unauthenticated, so leave it alone and
  // let the caller surface a 404 that names the missing token as a cause.
  if (!token) return null;

  const trimmed = url.trim();

  // Already an API asset endpoint — just attach the octet-stream Accept.
  const assetEndpoint =
    /^https?:\/\/api\.github\.com\/repos\/[^/]+\/[^/]+\/releases\/assets\/\d+/i.test(trimmed);
  if (assetEndpoint) {
    return {
      url: trimmed,
      headers: githubHeaders({ Accept: "application/octet-stream" }),
    };
  }

  const repo = repoFromGitHubUrl(trimmed);
  if (!repo) return null; // a CDN redirect URL: not ours to rewrite.

  // Prefer the name the URL itself asked for, then the contract name. Both
  // candidates may be null (a URL with no filename), and the selector skips
  // blanks rather than treating "" as a name to match.
  const preferred = [assetNameFromDownloadUrl(trimmed) ?? "", RELEASE_ASSET_NAME];

  let payload: unknown;
  try {
    const response = await fetch(githubReleaseApiUrl(repo), {
      headers: githubHeaders(),
      signal: AbortSignal.timeout(ASSET_LOOKUP_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    payload = await response.json();
  } catch {
    // DNS, TLS, timeout, or malformed JSON. Falling back to the plain URL keeps
    // a public repo — and any authenticated redirect that still works — alive.
    return null;
  }

  const assets = (payload as { assets?: unknown } | null)?.assets;
  const asset = selectAssetForDownload(assets, preferred);
  if (!asset || typeof asset.url !== "string") return null;

  return {
    // GitHub's own asset `url` is the API endpoint; `browser_download_url` is the
    // anonymous shortcut that 404s here. Use the former, with octet-stream.
    url: asset.url,
    headers: githubHeaders({ Accept: "application/octet-stream" }),
  };
}