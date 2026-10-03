import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { gunzipSync, inflateRawSync, zstdDecompressSync } from "node:zlib";
import axios from "axios";
import { dataFilePath } from "../utils/paths";
import { clearEngineActivity, noteEngineActivity, publishLine } from "./engineTelemetry";
import { publishNodeEvent } from "./nodeEvents";

/**
 * BUNDLED OLLAMA â€” the self-contained AI runtime this node ships with.
 *
 * WHY THIS EXISTS. The appliance used to assume Ollama was already on the host:
 * `spawn("ollama", ["serve"])` relied on a global install, which means the node
 * is only as portable as the machine it was copied to, needs admin/root to
 * install, and stores gigabytes of model weights in a per-user directory that
 * no part of the node manages. A node that is supposed to be "all-in-one" was
 * in fact only all-in-one on the developer's laptop.
 *
 * This module removes that host dependency entirely. It downloads the STANDALONE
 * compiled binary from Ollama's official GitHub releases into the node's own
 * directory, runs it with environment variables that confine its models and its
 * listening port to this node, enforces that the default model is present, and
 * supervises the child process for the rest of the node's life.
 *
 * WHAT IS DELIBERATELY NOT USED:
 *
 *   - `OllamaSetup.exe`. It is an MSI-wrapped installer that wants elevation,
 *     writes to Program Files, registers a service, and starts a tray app. Every
 *     one of those is exactly what "portable, no admin, contained" rules out.
 *   - The `curl https://ollama.com/install.sh | sh` one-liner. Same reason, plus
 *     it installs a systemd unit and a global binary â€” again host mutation.
 *
 * ISOLATION â€” THE THREE THINGS THAT MAKE THIS CONTAINED:
 *
 *   1. PATH.      `<dataDir>/bin/ollama[.exe]` â€” inside the persistent data dir,
 *                 never Program Files, never the user's global PATH. This is also
 *                 why the binary survives an OTA update of rippa-node.exe, which
 *                 replaces only the executable (see `update/swapHandoff.ts`).
 *   2. MODELS.    `OLLAMA_MODELS=<dataDir>/models`. Without this, a spawned
 *                 `ollama serve` reaps the HOST's `~/.ollama/models`, and two
 *                 nodes on one machine silently share (and evict) one set of
 *                 weights.
 *   3. PORT.      `OLLAMA_HOST=127.0.0.1:11435`, not the default 11434. An
 *                 operator who happens to run their own personal Ollama on 11434
 *                 would otherwise have this node either bind-fail at boot or,
 *                 worse, silently talk to the personal server and report another
 *                 machine's models as its own.
 *
 * SUPERVISION. The child pid is tracked, `exit` triggers a restart, and a
 * deliberate stop is distinguished from a crash by a `stopping` latch so
 * "Restart Node" / "Shutdown Node" in the Admin UI cannot race a relaunch on the
 * way out. `index.ts` already awaits `ollamaManager.stop()` on every exit path,
 * which is what tears the child down cleanly.
 */

/**
 * The isolated port for the bundled server.
 *
 * DELIBERATELY NOT 11434. 11434 is Ollama's default and is very likely already
 * taken by a human's own install on the same PC. Sharing it would mean this node
 * either cannot start at all, or points `OLLAMA_URL` at a server it did not start
 * and inherits that server's models and configuration.
 */
export const BUNDLED_OLLAMA_PORT = 11435;

/** Loopback origin of the bundled server. */
export const BUNDLED_OLLAMA_ORIGIN = `http://127.0.0.1:${BUNDLED_OLLAMA_PORT}`;

/**
 * The model the node is not considered "ready" without.
 *
 * Matches `PRIMARY_MODEL` in `agent/OllamaClient.ts`. It is re-declared as a
 * literal rather than imported so this module can be unit-tested in isolation,
 * and a unit check asserts the two have not drifted.
 */
export const BUNDLED_DEFAULT_MODEL = "qwen2.5-coder:7b";

/** GitHub release feed the standalone binaries are published to. */
const RELEASE_API = "https://api.github.com/repos/ollama/ollama/releases/latest";

/** A release binary is tens of MB; a slow satellite link needs a real budget. */
const DOWNLOAD_TIMEOUT_MS = 15 * 60_000;
/** Anything under this is an HTML error page or a truncated transfer. */
const MIN_BINARY_BYTES = 1024 * 1024;
/** Sanity ceiling â€” no Ollama binary is gigabytes. */
const MAX_BINARY_BYTES = 2 * 1024 * 1024 * 1024;

/** How long to wait for the freshly-spawned server to answer `/api/tags`. */
const SERVER_READY_TIMEOUT_MS = 60_000;
/** Backoff ladder for an unexpected child exit (ms). */
const RESTART_BACKOFF_MS = [1_000, 3_000, 10_000, 30_000, 60_000];

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
// MARK: - Paths

/**
 * Absolute path of the bundled binary for this platform.
 *
 * `ollama.exe` on Windows, bare `ollama` elsewhere. The name is deliberately NOT
 * `ollama` on Windows: a bare `ollama.exe` beside the node would be picked up by
 * a `PATH` entry and could shadow the operator's real install.
 */
export function bundledBinaryName(): string {
  return process.platform === "win32" ? "ollama.exe" : "ollama";
}

/** `<dataDir>/bin`, created on demand. Holds the runtime, not user data. */
export function bundledBinDir(): string {
  const dir = dataFilePath("bin");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Absolute path of the bundled binary (whether or not it exists yet). */
export function bundledBinaryPath(): string {
  return path.join(bundledBinDir(), bundledBinaryName());
}

/**
 * Absolute path of the isolated model store.
 *
 * Lives under the data dir rather than beside the executable for the same reason
 * the whole of `utils/paths.ts` exists: an OTA update replaces the executable in
 * place, and gigabytes of weights must not be collateral damage.
 */
export function bundledModelsDir(): string {
  const dir = dataFilePath("models");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Records which release is installed, so a boot does not re-download it. */
export function bundledVersionStampPath(): string {
  return dataFilePath("bin", "ollama.version");
}

/** The release tag recorded by the last successful install, or "". */
export function installedBundledVersion(): string {
  try {
    return fs.readFileSync(bundledVersionStampPath(), "utf8").trim();
  } catch {
    return "";
  }
}

/** True when a usable binary is already sitting in the node's own bin folder. */
export function bundledBinaryPresent(): boolean {
  try {
    return fs.statSync(bundledBinaryPath()).size >= MIN_BINARY_BYTES;
  } catch {
    return false;
  }
}

// MARK: - Environment isolation

/**
 * THE ENV CONTRACT â€” the variables that make the child self-contained.
 *
 * This is the load-bearing part of the whole feature and is exported separately
 * so it can be asserted directly rather than inferred from a spawn call.
 *
 * `OLLAMA_MODELS` is what stops this node from reading and evicting the host
 * user's weights. `OLLAMA_HOST` is what stops it colliding with (or silently
 * proxying to) a personal install. Both are absolute, so they behave the same
 * regardless of the working directory the child happens to inherit.
 *
 * `OLLAMA_NOHISTORY` is pinned for the same reason: Ollama's history is per-run
 * bookkeeping with no value to a headless server this node supervises, and not
 * writing it is one less thing the child owns that it should not.
 */
export function bundledOllamaEnv(): NodeJS.ProcessEnv {
  return {
    OLLAMA_MODELS: bundledModelsDir(),
    OLLAMA_HOST: `127.0.0.1:${BUNDLED_OLLAMA_PORT}`,
    OLLAMA_NOHISTORY: "1",
  };
}
// MARK: - Archive extraction

/**
 * ZIP member headers. Windows ships `ollama-windows-amd64.zip`, so one reader is
 * genuinely required rather than hypothetical.
 *
 * WHY NO LIBRARY. This project is frozen into a single `pkg` exe with no runtime
 * install step, so every dependency is bytes in the binary and a native module
 * must ship prebuilt for each target. A ZIP central-directory walk plus
 * `zlib.inflateRawSync` is ~100 lines and adds nothing to the bundle.
 */
const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;

/** Pulls the End Of Central Directory record out of a ZIP buffer. */
function findEocd(buf: Buffer): number {
  // The EOCD is at the very end but may be followed by up to 64 KB of comment.
  const start = Math.max(0, buf.length - 0xffff - 22);
  for (let i = buf.length - 22; i >= start; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIGNATURE) return i;
  }
  return -1;
}

/**
 * Extracts one named member from a ZIP archive held in memory.
 *
 * Returns the inflated bytes, or null when the member is absent.
 *
 * THE SECURITY-RELEVANT DETAIL is that the member NAME IS NEVER USED AS A PATH.
 * A malicious or corrupt archive could carry `../../autorun.exe` as a member name,
 * and any "extract everything" implementation would happily write outside the
 * destination. Here the caller names the exact file it wants and we only ever hand
 * back bytes, so a path-traversal member name has nothing to act on. Stored
 * (uncompressed) members are supported as well as deflated ones.
 */
export function extractZipMember(archive: Buffer, wantedName: string): Buffer | null {
  const eocd = findEocd(archive);
  if (eocd < 0) throw new Error("not a ZIP archive (no end-of-central-directory record)");

  const entryCount = archive.readUInt16LE(eocd + 10);
  let offset = archive.readUInt32LE(eocd + 16);

  for (let i = 0; i < entryCount; i++) {
    if (archive.readUInt32LE(offset) !== CENTRAL_SIGNATURE) break;
    const method = archive.readUInt16LE(offset + 10);
    const compressedSize = archive.readUInt32LE(offset + 20);
    const nameLen = archive.readUInt16LE(offset + 28);
    const extraLen = archive.readUInt16LE(offset + 30);
    const commentLen = archive.readUInt16LE(offset + 32);
    const localOffset = archive.readUInt32LE(offset + 42);
    const name = archive.toString("utf8", offset + 46, offset + 46 + nameLen);
    offset += 46 + nameLen + extraLen + commentLen;

    // Compare on the BASENAME only: release archives wrap payloads in a version
    // directory (`ollama-0.5.7/ollama.exe`), and hard-coding a full path would
    // pin us to one publish layout that Ollama is free to change.
    if (path.basename(name) !== wantedName) continue;

    // Re-read the LOCAL header: its name/extra lengths are what actually position
    // the payload, and they may differ from the central directory's.
    const localNameLen = archive.readUInt16LE(localOffset + 26);
    const localExtraLen = archive.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const raw = archive.subarray(dataStart, dataStart + compressedSize);

    if (method === 0) return Buffer.from(raw);
    if (method === 8) return inflateRawSync(raw);
    throw new Error(`unsupported ZIP compression method ${method} for "${name}"`);
  }
  return null;
}
/**
 * Extracts the bundled binary from a POSIX `.tar.zst` / `.tgz` release.
 *
 * Ollama publishes Linux and macOS as compressed tarballs rather than a loose
 * binary, so the "save it and chmod +x" shortcut in the original design does not
 * match what the releases actually contain. This walks the tar header chain and
 * returns the single member we want. Same path-traversal posture as
 * {@link extractZipMember}: the caller picks the member by basename.
 */
export function extractTarMember(archive: Buffer, wantedName: string): Buffer | null {
  let offset = 0;
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    // A block of NULs is the end-of-archive marker.
    if (header.every((byte) => byte === 0)) break;

    const nameField = header.toString("utf8", 0, 100).replace(/\0.*$/, "");
    const sizeField = header.toString("utf8", 124, 136).replace(/\0.*$/, "").trim();
    const size = sizeField ? parseInt(sizeField, 8) || 0 : 0;
    const typeFlag = String.fromCharCode(header[156]);
    const dataStart = offset + 512;

    // Regular files only. A directory entry has type '5', a symlink '2'; neither
    // is the binary, and following a symlink out of the archive is exactly the
    // kind of thing this reader refuses to do.
    if ((typeFlag === "0" || typeFlag === "") && path.basename(nameField) === wantedName) {
      return Buffer.from(archive.subarray(dataStart, dataStart + size));
    }
    // Payloads are padded up to a 512-byte boundary.
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  return null;
}

/**
 * Decompresses a downloaded release asset into a plain archive buffer.
 *
 * Windows zips need nothing; the POSIX assets are `.tar.zst` (Linux) or `.tgz`
 * (macOS). Detection is by magic bytes rather than by filename so a redirect that
 * renames the file still lands correctly.
 */
export function decompressReleaseAsset(archive: Buffer): Buffer {
  // gzip magic: 1f 8b
  if (archive[0] === 0x1f && archive[1] === 0x8b) return gunzipSync(archive);
  // zstd magic: 28 b5 2f fd
  if (archive[0] === 0x28 && archive[1] === 0xb5 && archive[2] === 0x2f && archive[3] === 0xfd) {
    // Node 22.15+/23+ exposes zstd on zlib. Older runtimes cannot read a .tar.zst
    // at all, so this fails loudly rather than writing a corrupt binary.
    if (typeof zstdDecompressSync !== "function") {
      throw new Error(
        "this Node runtime cannot decompress zstd (tar.zst). Ollama's Linux release is " +
          "zstd-compressed; upgrade Node to 22.15+ or point OLLAMA_URL at a system Ollama.",
      );
    }
    return zstdDecompressSync(archive);
  }
  return archive; // already a plain zip
}

/** Makes the extracted binary runnable. A no-op on Windows. */
function makeExecutable(binaryPath: string): void {
  if (process.platform === "win32") return;
  try {
    fs.chmodSync(binaryPath, 0o755);
  } catch (error) {
    console.warn(`[BundledOllama] chmod +x failed on ${binaryPath} â€” ${describeError(error)}`);
  }
}
// MARK: - Release resolution

/**
 * The asset name to pull for this platform/arch, or null when unsupported.
 *
 * These are the REAL asset names published by Ollama's release workflow,
 * confirmed against the live `releases/latest` feed. The original design assumed
 * a loose `ollama-linux-amd64` file existed; it does not â€” Linux ships
 * `ollama-linux-amd64.tar.zst` and macOS ships `ollama-darwin.tgz`, so the POSIX
 * branch has to walk an archive rather than write a single file.
 *
 * The `-rocm`/`-mlx` variants are deliberately NOT selected: they are GPU-specific
 * and would be wrong on a CPU-only satellite, so a node lands on the generic CPU
 * build and runs everywhere.
 */
export function bundledAssetName(
  platform: string = process.platform,
  arch: string = process.arch,
): string | null {
  if (platform === "win32") {
    if (arch === "x64") return "ollama-windows-amd64.zip";
    if (arch === "arm64") return "ollama-windows-arm64.zip";
    return null;
  }
  if (platform === "linux") {
    if (arch === "x64") return "ollama-linux-amd64.tar.zst";
    if (arch === "arm64") return "ollama-linux-arm64.tar.zst";
    return null;
  }
  if (platform === "darwin") {
    // The darwin tarball is a universal binary covering both Apple Silicon and
    // Intel, so there is only one asset to resolve.
    if (arch === "x64" || arch === "arm64") return "ollama-darwin.tgz";
    return null;
  }
  return null;
}

/** What a resolved release gives the installer. */
export interface ResolvedRelease {
  tag: string;
  assetName: string;
  downloadUrl: string;
  sizeBytes: number;
}

/**
 * Resolves the newest release that actually publishes an asset for this platform.
 *
 * WHY IT READS THE FEED INSTEAD OF HARD-CODING `/releases/latest/download/<name>`:
 * the direct URL is simpler but fails opaquely when an asset is missing, and a
 * node that logs "404" cannot tell "Ollama renamed this asset" from "no internet".
 * Reading the feed lets us name the release we are installing and say why a
 * platform is unsupported, which is the difference between a supportable failure
 * and a mystery.
 */
export async function resolveLatestRelease(): Promise<ResolvedRelease> {
  const assetName = bundledAssetName();
  if (!assetName) {
    throw new Error(
      `no bundled Ollama build is published for ${process.platform}/${process.arch}. ` +
        `Set OLLAMA_URL to a system Ollama instead.`,
    );
  }

  const response = await axios.get<{
    tag_name?: string;
    assets?: { name?: string; browser_download_url?: string; size?: number }[];
  }>(RELEASE_API, {
    timeout: 30_000,
    headers: {
      Accept: "application/vnd.github+json",
      // GitHub rejects API requests that carry no user agent.
      "User-Agent": "rippa-node-bundled-ollama",
    },
  });
  const tag = String(response.data?.tag_name ?? "").trim();
  const assets = Array.isArray(response.data?.assets) ? response.data.assets : [];
  const match = assets.find((asset) => asset?.name === assetName);
  if (!tag || !match?.browser_download_url) {
    throw new Error(
      `Ollama ${tag || "(unknown)"} does not publish ${assetName} for ` +
        `${process.platform}/${process.arch}.`,
    );
  }
  return {
    tag,
    assetName,
    downloadUrl: match.browser_download_url,
    sizeBytes: Number(match.size ?? 0),
  };
}
// MARK: - Download & install

/**
 * Streams an asset to disk and returns the bytes written.
 *
 * Downloads to a `.part` file and renames only after the stream finishes, for the
 * same reason the OTA updater does it: a half-written executable that looks
 * complete is worse than no executable, because the next boot will happily spawn
 * a truncated file and report the crash as "Ollama is broken".
 *
 * Progress is reported as whole percentages only. Ollama's Windows asset is
 * hundreds of MB and a satellite link is slow; a per-chunk log would emit
 * thousands of lines and bury everything else.
 */
async function downloadAsset(url: string, destination: string): Promise<number> {
  const partial = `${destination}.part`;
  const response = await axios.get(url, {
    responseType: "stream",
    timeout: DOWNLOAD_TIMEOUT_MS,
    maxRedirects: 5,
    headers: { "User-Agent": "rippa-node-bundled-ollama", Accept: "application/octet-stream" },
  });

  const total = Number(response.headers?.["content-length"] ?? 0);
  let received = 0;
  let lastPercent = -1;
  const stream = response.data as NodeJS.ReadableStream;
  stream.on("data", (chunk: Buffer) => {
    received += chunk.length;
    if (total > 0) {
      const percent = Math.floor((received / total) * 100);
      if (percent !== lastPercent) {
        lastPercent = percent;
        process.stdout.write(`\r[BundledOllama] downloading Ollamaâ€¦ ${percent}%   `);
      }
    }
  });

  await pipeline(stream, fs.createWriteStream(partial));
  if (total > 0) process.stdout.write("\n");

  const size = fs.statSync(partial).size;
  // Refuse a truncated transfer BEFORE it is renamed into place.
  if (size < MIN_BINARY_BYTES || size > MAX_BINARY_BYTES) {
    fs.rmSync(partial, { force: true });
    throw new Error(
      `downloaded ${size} bytes for ${url}, which is outside the plausible range ` +
        `(${MIN_BINARY_BYTES}â€“${MAX_BINARY_BYTES}). Treating it as a failed transfer.`,
    );
  }
  fs.renameSync(partial, destination);
  return size;
}
/**
 * Makes sure a usable binary exists in the node's own `bin` folder, downloading
 * the official standalone build when it is missing.
 *
 * `force` re-downloads even when the stamped version already matches, which is
 * what the repair path needs after a corrupted install. Returns the absolute path
 * of the binary now in place.
 */
export async function ensureBundledBinary(
  options: { force?: boolean; release?: ResolvedRelease } = {},
): Promise<string> {
  const binaryPath = bundledBinaryPath();
  const installed = installedBundledVersion();

  if (bundledBinaryPresent() && installed && !options.force) return binaryPath;

  // A binary with no stamp is treated as present-but-unknown rather than as a
  // reason to re-download: the operator may have placed it there deliberately,
  // and silently replacing someone's hand-provisioned binary is worse than
  // leaving it alone.
  if (bundledBinaryPresent() && !options.force) {
    console.log(`[BundledOllama] Using the existing bundled runtime at ${binaryPath}.`);
    return binaryPath;
  }

  const release = options.release ?? (await resolveLatestRelease());
  console.log(`[BundledOllama] Installing Ollama ${release.tag} (${release.assetName})â€¦`);
  publishLine("cmd", `downloading bundled Ollama ${release.tag} â€” no global install required`);

  const archivePath = path.join(bundledBinDir(), path.basename(release.assetName));
  try {
    await downloadAsset(release.downloadUrl, archivePath);
  } catch (error) {
    // A failed upgrade must not DELETE a working older runtime. Falling back keeps
    // the node's brain available while the operator is offline.
    if (bundledBinaryPresent()) {
      console.warn(
        `[BundledOllama] Upgrade to ${release.tag} failed (${describeError(error)}) â€” ` +
          `keeping the existing runtime.`,
      );
      return binaryPath;
    }
    throw error;
  }

  const archive = fs.readFileSync(archivePath);
  const payload =
    process.platform === "win32"
      ? extractZipMember(archive, bundledBinaryName())
      : extractTarMember(decompressReleaseAsset(archive), bundledBinaryName());

  fs.rmSync(archivePath, { force: true });
  if (!payload || payload.length < MIN_BINARY_BYTES) {
    throw new Error(
      `${release.assetName} did not contain a usable ${bundledBinaryName()} ` +
        `(got ${payload ? payload.length : 0} bytes).`,
    );
  }

  fs.writeFileSync(binaryPath, payload);
  makeExecutable(binaryPath);
  fs.writeFileSync(bundledVersionStampPath(), release.tag, "utf8");

  console.log(
    `[BundledOllama] Ollama ${release.tag} installed â†’ ${binaryPath} ` +
      `(${(payload.length / (1024 * 1024)).toFixed(1)} MB, contained in the node's own directory).`,
  );
  publishNodeEvent({
    kind: "info",
    title: "Bundled Ollama installed",
    detail:
      `Ollama ${release.tag} downloaded into the node's own bin folder â€” ` +
      `nothing was installed system-wide.`,
  });
  return binaryPath;
}
// MARK: - Isolated server probe

/**
 * Reads model names out of an `/api/tags` body.
 *
 * Checks both envelope shapes on purpose: `/api/tags` returns `{"models":[â€¦]}`
 * but older builds used `{"data":[â€¦]}`, and a probe that only understands one of
 * them reports "no models" against a perfectly healthy server â€” a confident wrong
 * answer from a health indicator, which is the worst kind.
 */
function readModelNames(body: unknown): string[] {
  const envelope = (body ?? {}) as { models?: unknown; data?: unknown };
  const rows = Array.isArray(envelope.models) ? envelope.models : envelope.data;
  if (!Array.isArray(rows)) return [];
  return rows
    .map((row) => {
      const record = (row ?? {}) as { name?: string; model?: string };
      return String(record.name ?? record.model ?? "");
    })
    .filter(Boolean);
}

/** True when `name` is `target`, or the same model without its `:tag` suffix. */
function matchesModel(names: string[], target: string): boolean {
  const bare = target.split(":")[0];
  return names.some((name) => name === target || name.split(":")[0] === bare);
}

/**
 * Asks the ISOLATED server which models it has.
 *
 * `proxy: false` is load-bearing: this is a loopback address, and an operator with
 * a corporate `HTTP_PROXY` set would otherwise have the probe answered by the
 * proxy â€” reporting a healthy engine as offline, or worse, asking a remote server
 * what models "this node" has.
 */
export async function fetchBundledModels(): Promise<string[]> {
  const response = await axios.get(`${BUNDLED_OLLAMA_ORIGIN}/api/tags`, {
    timeout: 5_000,
    proxy: false,
  });
  return readModelNames(response?.data);
}

/** True when the isolated server answers. Never throws â€” unreachable is false. */
export async function bundledServerAlive(): Promise<boolean> {
  try {
    await axios.get(`${BUNDLED_OLLAMA_ORIGIN}/api/tags`, { timeout: 3_000, proxy: false });
    return true;
  } catch {
    return false;
  }
}

/** Polls until the isolated server answers, or the budget runs out. */
async function waitForServer(timeoutMs = SERVER_READY_TIMEOUT_MS): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await bundledServerAlive()) return true;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  return false;
}
// MARK: - Model provisioning

/**
 * Pulls a model into the ISOLATED store, streaming progress to the console.
 *
 * This runs the BUNDLED binary (`<bin>/ollama pull <model>`) rather than whatever
 * `ollama` happens to resolve to on PATH, and it passes the isolation env so the
 * weights land in this node's own `models` folder. A pull through a host-installed
 * Ollama would put the blobs in the wrong directory and then look like a failure
 * to the probe above.
 *
 * Ollama redraws its progress bar with `\r`, so the output is split on both and
 * only genuine lines are printed.
 *
 * Never throws â€” a failed model pull must not take the node's HTTP surface down
 * with it. The caller gets a boolean and an error line in the terminal, which is
 * where an operator is already looking.
 */
export async function pullBundledModel(
  model: string,
  onProgress?: (line: string) => void,
): Promise<{ ok: boolean; message: string }> {
  const say = onProgress ?? ((line: string) => publishLine("out", line));

  if (!bundledBinaryPresent()) {
    return { ok: false, message: "the bundled Ollama binary is not installed yet" };
  }

  say(`pulling ${model} into ${bundledModelsDir()} â€¦`);
  noteEngineActivity("pulling", model, 60 * 60_000);

  return new Promise<{ ok: boolean; message: string }>((resolve) => {
    let settled = false;
    const finish = (result: { ok: boolean; message: string }): void => {
      if (settled) return;
      settled = true;
      clearEngineActivity();
      resolve(result);
    };

    let child: ChildProcess;
    try {
      child = spawn(bundledBinaryPath(), ["pull", model], {
        env: { ...process.env, ...bundledOllamaEnv() },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      finish({ ok: false, message: describeError(error) });
      return;
    }

    const attach = (stream: NodeJS.ReadableStream | null): void => {
      if (!stream) return;
      let pending = "";
      stream.setEncoding?.("utf8");
      stream.on("data", (chunk: string | Buffer) => {
        pending += String(chunk);
        const parts = pending.split(/[\r\n]+/);
        pending = parts.pop() ?? "";
        for (const part of parts) {
          const line = part.trim();
          if (line) say(line);
        }
      });
      stream.on("end", () => {
        if (pending.trim()) say(pending.trim());
      });
      // A broken pipe must not reject the promise: the exit handler below is the
      // single place that decides success, so both streams settling is enough.
      stream.on("error", () => {
        /* the exit code is the authority */
      });
    };
    attach(child.stdout);
    attach(child.stderr);

    child.on("error", (error) => finish({ ok: false, message: describeError(error) }));
    child.on("exit", (code) => {
      if (code === 0) {
        say(`âœ“ ${model} is installed.`);
        finish({ ok: true, message: `${model} pulled successfully.` });
      } else {
        const message = `pulling ${model} failed (exit ${code ?? "unknown"})`;
        say(message);
        finish({ ok: false, message });
      }
    });
  });
}
/**
 * Ensures the default model is present in the isolated store, pulling it when it
 * is not.
 *
 * ENFORCEMENT, NOT SUGGESTION. The whole point of provisioning the runtime is that
 * a freshly-cloned node on a laptop with no pre-existing AI still has a brain on
 * first boot. If the model is missing we pull it â€” and we do it against the
 * ISOLATED server, so "present" means present *for this node*.
 */
export async function ensureDefaultModel(
  model: string = BUNDLED_DEFAULT_MODEL,
): Promise<{ ok: boolean; message: string }> {
  try {
    const installed = await fetchBundledModels();
    if (matchesModel(installed, model)) {
      console.log(`[BundledOllama] "${model}" is already present in the isolated store.`);
      return { ok: true, message: `${model} is already installed.` };
    }
  } catch (error) {
    // Falling through to the pull is right here: the probe failing usually means
    // the server is still coming up, and `ollama pull` will report the real
    // problem better than a guess here.
    console.warn(`[BundledOllama] Could not list installed models â€” ${describeError(error)}`);
  }

  const result = await pullBundledModel(model);
  if (result.ok) {
    publishNodeEvent({
      kind: "info",
      title: "Default model ready",
      detail: `"${model}" is installed in the node's own model store.`,
    });
  }
  return result;
}

// MARK: - Lifecycle

export type BundledRunState = "stopped" | "installing" | "starting" | "running" | "crashed";

export interface BundledStatus {
  state: BundledRunState;
  /** Absolute path of the runtime binary this node owns. */
  binaryPath: string;
  /** Absolute path of the isolated model store. */
  modelsDir: string;
  /** Release tag currently installed, or "" when not yet determined. */
  version: string;
  /** True when a usable binary is present on disk. */
  binaryPresent: boolean;
  /** Port the isolated server is bound to. */
  port: number;
  /** pid of the supervised child, or null when not running. */
  pid: number | null;
  restartCount: number;
  lastError: string | null;
}
/**
 * THE SUPERVISOR â€” owns the bundled child's whole life.
 *
 * WHY A CLASS AND NOT THREE LOOSE FUNCTIONS. The restart latch, the `stopping`
 * flag, the child handle and the crash history have to agree with each other at
 * all times, and that is exactly the state a caller passing them around by hand
 * gets wrong. `stop()` racing a crashed `exit` handler is the classic case:
 * without a latch the node tears down on "Shutdown Node" and the crash handler
 * resurrects the child on the way out.
 */
export class BundledOllamaManager {
  private child: ChildProcess | null = null;
  private state: BundledRunState = "stopped";
  private restartTimer: NodeJS.Timeout | null = null;
  private crashTimes: number[] = [];
  private stopping = false;
  private enabled = false;
  private lastError: string | null = null;
  private restartCount = 0;
  /** De-duplicates concurrent start() calls racing each other at boot. */
  private starting: Promise<void> | null = null;

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (enabled) void this.start();
    else void this.stop();
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  getStatus(): BundledStatus {
    return {
      state: this.state,
      binaryPath: bundledBinaryPath(),
      modelsDir: bundledModelsDir(),
      version: installedBundledVersion(),
      binaryPresent: bundledBinaryPresent(),
      port: BUNDLED_OLLAMA_PORT,
      pid: this.child?.pid ?? null,
      restartCount: this.restartCount,
      lastError: this.lastError,
    };
  }

  /**
   * Brings the whole runtime up: binary, then server, then the default model.
   *
   * The stages are ordered by dependency â€” there is no point pulling a model into
   * a store no server will read, and no point spawning a server before the binary
   * that backs it exists.
   */
  async start(): Promise<void> {
    if (!this.enabled || this.child) return;
    // Collapse concurrent callers onto one in-flight startup.
    if (this.starting) return this.starting;
    this.starting = this.doStart().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async doStart(): Promise<void> {
    this.stopping = false;
    try {
      this.state = "installing";
      const binary = await ensureBundledBinary();
      if (this.stopping) return;

      this.state = "starting";
      await this.spawnServer(binary);
      if (this.stopping) return;

      if (!(await waitForServer())) {
        this.lastError = `the bundled Ollama server never answered on port ${BUNDLED_OLLAMA_PORT}`;
        console.warn(`[BundledOllama] ${this.lastError}.`);
        return;
      }
      this.state = "running";
      this.lastError = null;
      console.log(`[BundledOllama] Serving on ${BUNDLED_OLLAMA_ORIGIN} (isolated).`);

      // Model provisioning is deliberately NOT awaited into readiness: a first pull
      // is multi-gigabyte and blocking boot on it would make a healthy node look
      // dead. It is enforced in the background and re-checked on restart.
      void this.ensureModel().catch((error) => {
        this.lastError = describeError(error);
      });
    } catch (error) {
      this.lastError = describeError(error);
      this.state = "crashed";
      console.warn(`[BundledOllama] Startup failed â€” ${this.lastError}`);
    }
  }
/**
   * Spawns `<bin>/ollama serve` with the isolation env injected.
   *
   * THE ENV MERGE ORDER IS LOAD-BEARING: `{...process.env, ...bundledOllamaEnv()}`
   * applies the isolation variables LAST so they win. The child still inherits
   * PATH/HOME (it cannot run without them), but a stray `OLLAMA_HOST` already
   * present in the node's own environment can no longer redirect the server onto
   * the host's personal install â€” exactly the bug this isolation exists to stop.
   */
  private async spawnServer(binary: string): Promise<void> {
    const child = spawn(binary, ["serve"], {
      env: { ...process.env, ...bundledOllamaEnv() },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child = child;

    // The child's output carries the model-loading and runner lines an operator
    // needs at 3am, so it is forwarded to the terminal rather than discarded.
    const attach = (stream: NodeJS.ReadableStream | null, kind: "stdout" | "stderr"): void => {
      if (!stream) return;
      let pending = "";
      stream.setEncoding?.("utf8");
      stream.on("data", (chunk: string | Buffer) => {
        pending += String(chunk);
        const parts = pending.split(/\r?\n/);
        pending = parts.pop() ?? "";
        for (const line of parts) publishLine(kind, line);
      });
      stream.on("end", () => {
        if (pending) publishLine(kind, pending);
      });
      stream.on("error", () => {
        /* a broken pipe must not take the supervisor down */
      });
    };
    attach(child.stdout, "stdout");
    attach(child.stderr, "stderr");

    child.once("exit", (code) => {
      this.child = null;
      // The `stopping` latch is what stops a deliberate shutdown from being read
      // as a crash and immediately relaunched.
      if (this.stopping || !this.enabled) {
        this.state = "stopped";
        return;
      }
      this.state = "crashed";
      this.lastError = `bundled ollama exited (code ${code ?? "unknown"})`;
      console.warn(`[BundledOllama] ${this.lastError} â€” restarting.`);
      // "info" is the only non-command event kind the overlay accepts; the wording
      // in the title/detail carries the severity instead of a kind the UI ignores.
      publishNodeEvent({
        kind: "info",
        title: "Bundled Ollama restarting",
        detail: this.lastError,
      });
      this.scheduleRestart();
    });

    child.once("error", (error) => {
      this.child = null;
      this.lastError = describeError(error);
      console.warn(`[BundledOllama] Failed to spawn ${binary} â€” ${this.lastError}`);
      this.state = "crashed";
      this.scheduleRestart();
    });
  }

  /** Re-provisions the model after a crash-restart, so it is always enforced. */
  private async ensureModel(): Promise<void> {
    const result = await ensureDefaultModel();
    if (!result.ok) console.warn(`[BundledOllama] ${result.message}`);
  }

  /**
   * THE SELF-HEALING LOOP.
   *
   * Backoff grows with consecutive crashes so a binary that cannot start (wrong
   * arch, blocked by antivirus) does not spin the CPU, but the ladder resets
   * because `crashTimes` is pruned BY AGE: a node that ran fine for a week and
   * then crashes once gets the shortest delay, not the longest.
   */
  private scheduleRestart(): void {
    if (!this.enabled || this.restartTimer) return;
    const now = Date.now();
    this.crashTimes = this.crashTimes.filter((t) => now - t < 10 * 60_000);
    const attempt = this.crashTimes.length;
    this.crashTimes.push(now);
    this.restartCount++;
    const delay = RESTART_BACKOFF_MS[Math.min(attempt, RESTART_BACKOFF_MS.length - 1)];
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      void this.start();
    }, delay);
    this.restartTimer.unref?.();
  }
/**
   * Tears the child down cleanly.
   *
   * ESCALATES SIGTERM â†’ SIGKILL because `ollama serve` spawns runner subprocesses
   * for loaded models and has been observed to ignore SIGTERM while a model file
   * is being written. On Windows `SIGKILL` maps to TerminateProcess, so this
   * behaves identically on both platforms with no `taskkill` shell-out (which
   * would need a shell we deliberately do not spawn).
   *
   * Every wait here is bounded: the node's own shutdown path awaits this, and an
   * unbounded wait would turn a stubborn child into a node that never exits.
   */
  async stop(): Promise<void> {
    this.stopping = true;
    this.enabled = false;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    const child = this.child;
    this.child = null;
    if (!child || child.exitCode !== null) {
      this.state = "stopped";
      return;
    }

    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    try {
      child.kill("SIGTERM");
    } catch {
      /* already gone */
    }

    const stillRunning = await Promise.race([
      exited.then(() => false),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 5_000)),
    ]);
    if (stillRunning) {
      console.warn("[BundledOllama] Child ignored SIGTERM â€” sending SIGKILL.");
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 3_000))]);
    }
    this.state = "stopped";
    console.log("[BundledOllama] Bundled server stopped.");
  }

  /**
   * Forces a re-download of the runtime and a clean restart.
   *
   * This is the repair action for a node whose bundled binary has been corrupted,
   * quarantined by antivirus, or is simply older than the operator wants. The
   * reinstall is still confined to the node's own folder.
   */
  async repair(): Promise<{ ok: boolean; message: string }> {
    await this.stop();
    this.crashTimes = [];
    this.restartCount = 0;
    this.lastError = null;
    try {
      const release = await resolveLatestRelease();
      await ensureBundledBinary({ force: true, release });
      this.enabled = true;
      await this.start();
      return {
        ok: true,
        message:
          `Bundled Ollama ${release.tag} reinstalled and restarted â€” ` +
          `nothing outside the node's own folder was modified.`,
      };
    } catch (error) {
      this.lastError = describeError(error);
      return { ok: false, message: `Reinstall failed â€” ${this.lastError}` };
    }
  }
}

/** Process-wide singleton â€” exactly one bundled Ollama child per node. */
export const bundledOllama = new BundledOllamaManager();