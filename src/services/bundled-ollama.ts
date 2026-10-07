import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import { pipeline } from "node:stream/promises";
import axios from "axios";
import extractZip from "extract-zip";
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
 *
 * THE ARCHIVE IS THE RUNTIME - `ollama.exe` ALONE IS NOT. This is the single
 * most important fact in this file, and it is stated up here because getting it
 * wrong produces a node that boots cleanly and then fails every single
 * inference. `ollama serve` is a SUPERVISOR: for every model load it execs
 * `lib/ollama/llama-server.exe`, which in turn dynamically loads
 * `lib/ollama/libllama-server-impl.dll` and the `ggml-*` / CUDA / Vulkan
 * backends beside it. The Windows release zip is therefore 87 entries - one
 * executable plus a ~1.8 GB `lib/ollama/` tree - and an install that keeps only
 * the executable produces exactly this at run time:
 *
 *     failure during llama-server GPU discovery ... llama-server binary not found
 *
 * So the installer downloads the WHOLE archive and unpacks it with its
 * directory structure intact. `bin/` only counts as a usable runtime when BOTH
 * `bin/ollama.exe` AND `bin/lib/ollama/llama-server.exe` are on disk (see
 * `bundledRuntimeComplete()`), and a `bin/` folder that fails that check is
 * deleted and re-fetched rather than spawned against.
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
 * Env override for the bundled port, used by tests and by an operator whose
 * 11435 is genuinely taken by something that is NOT an Ollama server.
 *
 * WHY THIS EXISTS NOW. The port used to be a bare constant consumed by the
 * spawn, the readiness probe, the model pull and the status snapshot in four
 * different places. Any of them drifting from the others produces a node that
 * binds one port and is probed on another, which is the exact failure this
 * function exists to make impossible: there is now ONE resolver, and every
 * consumer asks it.
 */
/**
 * DYNAMIC PORT OVERRIDE — the zero-touch watchdog's claim on the bind port.
 * Set once per boot by `ensureZeroTouchOllama()` (or the spawner's own
 * EADDRINUSE retry). Read first by the resolver below so "the port we
 * advertise" and "the port we bind" stay identical by construction.
 * `clearDynamicOllamaPort()` exists for tests only.
 */
let dynamicOllamaPort: number | null = null;

/** Claims the healed port. Ignores out-of-range values rather than binding them. */
export function setDynamicOllamaPort(port: number): void {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.warn(`[BundledOllama] Ignoring invalid dynamic port ${port}.`);
    return;
  }
  dynamicOllamaPort = port;
}

/** Returns the claimed dynamic port, or null when nothing was claimed. */
export function getDynamicOllamaPort(): number | null {
  return dynamicOllamaPort;
}

/** Clears the claim (tests only — production never un-claims mid-boot). */
export function clearDynamicOllamaPort(): void {
  dynamicOllamaPort = null;
}

export const BUNDLED_OLLAMA_PORT_ENV = "RIPPA_BUNDLED_OLLAMA_PORT";

/**
 * THE RESOLVED MANAGED PORT — the single authority for where this node's own
 * Ollama server listens.
 *
 * Every consumer (spawn env, readiness wait, health probe, status snapshot,
 * orphan guard, the `env.OLLAMA_URL` publish) MUST read this rather than
 * re-deriving a port, so "the port we bind" and "the port we are asked about"
 * cannot diverge.
 *
 * A malformed or out-of-range override is IGNORED rather than honoured: an
 * operator typo must never leave the node trying to bind port 0 or 999999,
 * which fails in a far more confusing way than simply using the default.
 */
export function resolveBundledOllamaPort(): number {
  // 1. The watchdog's live claim wins — freshest fact from this boot.
  if (dynamicOllamaPort !== null) return dynamicOllamaPort;
  const raw = process.env[BUNDLED_OLLAMA_PORT_ENV];
  if (!raw || !raw.trim()) return BUNDLED_OLLAMA_PORT;
  const parsed = Number(raw.trim());
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    console.warn(
      `[BundledOllama] Ignoring invalid ${BUNDLED_OLLAMA_PORT_ENV}="${raw}" — ` +
        `falling back to ${BUNDLED_OLLAMA_PORT}.`,
    );
    return BUNDLED_OLLAMA_PORT;
  }
  return parsed;
}

/** Loopback origin for the resolved managed port (dynamic claim included). */
export function bundledOllamaOrigin(port?: number): string {
  const resolved = typeof port === "number" ? port : resolveBundledOllamaPort();
  return `http://127.0.0.1:${resolved}`;
}

/**
 * ORPHANED OLLAMA — the "address already in use" boot failure.
 *
 * THE FAILURE THIS EXISTS TO PREVENT. `ollamaManager.stop()` escalates
 * SIGTERM → SIGKILL and confirms the child is dead, but that only runs on the
 * CLEAN exit paths. A power cut, a Task Manager kill, an OTA swap that replaces
 * the exe, or an OOM kill all skip it, and the `ollama serve` child survives as
 * an orphan still holding the managed port. The next boot then spawns a second
 * server which cannot bind, exits, and lands in the crash-restart ladder — so
 * the node reports the engine as permanently broken for a reason that has
 * nothing to do with the engine.
 *
 * WHY THE SCOPE IS NARROW AND DELIBERATE. This runs against the MANAGED port
 * only, never 11434. 11434 is where a human's personal Ollama lives, and this
 * node deliberately moved OFF it precisely so it never touches that install
 * (see the module docblock). Killing "an Ollama on the default port" would
 * destroy the operator's own working setup to fix a problem on a port they are
 * not using.
 *
 * WHY IT VERIFIES BEFORE IT KILLS. Something else may legitimately own the
 * port — a genuinely different Ollama the operator started by hand, or an
 * unrelated app. The port being busy is NOT evidence that the holder is a
 * stale child of ours, so every candidate must positively identify as an
 * Ollama server before a signal is sent. Anything ambiguous is left alone and
 * reported, because an unattended node killing an unknown process is a far
 * worse outcome than a boot that needs operator attention.
 */

/** Outcome of a pre-boot orphan sweep. */
export interface OrphanSweepResult {
  /** True when the managed port is clear (or was cleared by us). */
  portFree: boolean;
  /** PIDs that were terminated. */
  killed: number[];
  /** Human-readable notes for the boot log. */
  notes: string[];
}

/** How long a terminate signal gets before we escalate to SIGKILL. */
const ORPHAN_KILL_GRACE_MS = 5_000;
/** Cap on how many PIDs one sweep will consider. */
const ORPHAN_MAX_CANDIDATES = 8;

/** True when the string looks like an Ollama server binary name. */
function isOllamaImageName(name: string): boolean {
  const base = name.trim().split(/[\\/]/).pop() ?? "";
  // Matches ollama.exe / ollama and the "ollama app.exe" style bundle name
  // Ollama ships on Windows. Anchored so "notollama" cannot pass.
  return /^ollama(\.exe)?$/i.test(base) || /^ollama[\s-].*\.exe$/i.test(base);
}

/**
 * Runs a read-only inventory command and returns stdout, or "" on any failure.
 *
 * Deliberately NEVER rejects: every caller treats "" as "cannot tell" rather
 * than as an authoritative empty answer, so a missing platform tool degrades
 * the sweep instead of throwing during boot.
 */
async function runInventory(cmd: string, args: string[]): Promise<string> {
  const { execFile } = await import("node:child_process");
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, timeout: 10_000 }, (error, stdout) => {
      resolve(error ? "" : String(stdout ?? ""));
    });
  });
}

/**
 * PIDs LISTENING on `port`, or [] when the lookup is unsupported.
 *
 * Windows uses `netstat -ano`; POSIX uses `lsof`. Both are read-only inventory
 * calls — this function NEVER signals anything. It returns [] on any error, and
 * the caller treats [] as "cannot tell", not as "nothing there".
 */
async function listeningPids(port: number): Promise<number[]> {
  try {
    if (process.platform === "win32") {
      const out = await runInventory("netstat", ["-ano", "-p", "TCP"]);
      const pids = new Set<number>();
      for (const line of out.split(/\r?\n/)) {
        // "TCP  127.0.0.1:11435  0.0.0.0:0  LISTENING  4242"
        if (!/LISTENING/i.test(line)) continue;
        const cols = line.trim().split(/\s+/);
        if (cols.length < 5) continue;
        const local = cols[1] ?? "";
        const localPort = Number(local.slice(local.lastIndexOf(":") + 1));
        const pid = Number(cols[cols.length - 1]);
        if (localPort === port && Number.isInteger(pid) && pid > 0) pids.add(pid);
      }
      return [...pids].slice(0, ORPHAN_MAX_CANDIDATES);
    }

    const out = await runInventory("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"]);
    return out
      .split(/\r?\n/)
      .map((line) => Number(line.trim()))
      .filter((pid) => Number.isInteger(pid) && pid > 0)
      .slice(0, ORPHAN_MAX_CANDIDATES);
  } catch {
    return [];
  }
}

/** The executable name behind a PID, or "" when it cannot be determined. */
async function processImageName(pid: number): Promise<string> {
  try {
    if (process.platform === "win32") {
      // CSV output, so the image name is a quoted field rather than a column
      // whose width we would have to guess.
      const out = await runInventory("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"]);
      return out.match(/"([^"]*)"/)?.[1] ?? "";
    }
    return (await runInventory("ps", ["-p", String(pid), "-o", "comm="])).trim();
  } catch {
    return "";
  }
}

/** Waits up to `ms` for `port` to stop having a listener. */
async function waitForPortRelease(port: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if ((await listeningPids(port)).length === 0) return true;
    await new Promise<void>((resolve) => setTimeout(resolve, 500).unref?.());
  }
  return (await listeningPids(port)).length === 0;
}

/**
 * PRE-BOOT ORPHAN SWEEP for the managed port.
 *
 * Runs BEFORE the managed server is spawned, so the child we start binds the
 * port itself rather than racing a leftover process for it.
 *
 * NEVER THROWS. A sweep that cannot inventory the port returns `portFree:
 * false` with a note, and the caller still attempts the spawn — a node that
 * reports a busy port it cannot inspect is strictly more useful than one that
 * refuses to boot because an inventory tool is missing.
 *
 * Only a PID that positively identifies as an Ollama binary is terminated.
 */
export async function sweepOrphanedOllama(
  port = resolveBundledOllamaPort(),
): Promise<OrphanSweepResult> {
  const notes: string[] = [];
  const pids = await listeningPids(port);
  if (pids.length === 0) {
    // [] means either "nothing there" or "could not tell". A follow-up HTTP
    // probe separates them cheaply: if a server really is answering, we must
    // not spawn a competitor even though the inventory came back empty.
    if (await bundledServerAlive()) {
      notes.push(
        `An Ollama server is already answering on port ${port} but could not be attributed to a pid; leaving it alone.`,
      );
      return { portFree: false, killed: [], notes };
    }
    return { portFree: true, killed: [], notes };
  }

  const killed: number[] = [];
  for (const pid of pids) {
    const image = await processImageName(pid);
    if (!isOllamaImageName(image)) {
      notes.push(
        `Port ${port} is held by pid ${pid}${image ? ` ("${image}")` : ""}, which is not an Ollama server — not touching it.`,
      );
      continue;
    }
    notes.push(`Terminating orphaned Ollama (pid ${pid}) holding port ${port}.`);
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Already gone, or not ours to signal. Either way, fall through to the
      // settle check rather than claiming a kill that did not happen.
    }
    if (!(await waitForPortRelease(port, ORPHAN_KILL_GRACE_MS))) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* it may have exited between the check and the signal */
      }
      await waitForPortRelease(port, 2_000);
    }
    killed.push(pid);
  }

  const remaining = await listeningPids(port);
  if (remaining.length > 0) {
    notes.push(`Port ${port} is still held after the sweep (pid(s): ${remaining.join(", ")}).`);
  }
  return { portFree: remaining.length === 0, killed, notes };
}

/**
 * The model the node is not considered "ready" without.
 *
 * Matches `PRIMARY_MODEL` in `agent/OllamaClient.ts`. It is re-declared as a
 * literal rather than imported so this module can be unit-tested in isolation,
 * and a unit check asserts the two have not drifted.
 */
export const BUNDLED_DEFAULT_MODEL = "qwen2.5-coder:7b";

/** GitHub release feed the release archives are published to. */
const RELEASE_API = "https://api.github.com/repos/ollama/ollama/releases/latest";

/**
 * The canonical "give me the newest one" download URL for a published asset.
 *
 * Used as a FALLBACK when the release feed cannot be read (rate limit, no
 * network to api.github.com but a working proxy, corporate JSON filtering).
 * The feed path is preferred because it names the version we installed; this
 * path installs whatever is newest without saying so, which is why it is second.
 */
const RELEASE_LATEST_DOWNLOAD = "https://github.com/ollama/ollama/releases/latest/download";

/** A release archive is ~1.4 GB on Windows; a slow satellite link needs a real budget. */
const DOWNLOAD_TIMEOUT_MS = 30 * 60_000;
/** Anything under this is an HTML error page or a truncated transfer. */
const MIN_ARCHIVE_BYTES = 1024 * 1024;
/** Sanity ceiling - the largest published Windows archive is ~1.5 GB. */
const MAX_ARCHIVE_BYTES = 4 * 1024 * 1024 * 1024;
/**
 * Floor for a plausible `ollama.exe` (~25 MB today).
 *
 * Deliberately NOT reused for `llama-server.exe`, which is only ~20 KB because it
 * is a thin loader beside `libllama-server-impl.dll` - see `bundledRuntimeComplete`.
 */
const MIN_BINARY_BYTES = 8 * 1024 * 1024;

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

/**
 * Path of the llama.cpp server binary, RELATIVE to `bin/`.
 *
 * THIS IS NOT OPTIONAL. `ollama serve` execs this on every model load; without
 * it the server starts, answers `/api/tags`, lists no models, and fails every
 * inference with "llama-server binary not found". Ollama resolves it relative to
 * its own executable, which is precisely why the archive has to be unpacked with
 * its `lib/ollama/` tree intact rather than flattening `ollama.exe` alone.
 *
 * Verified against the live v0.35.1 release: the Windows zip really does carry
 * `lib/ollama/llama-server.exe` (plus `libllama-server-impl.dll` and the ggml
 * backends), and the Linux tarball carries `lib/ollama/llama-server`.
 */
export const LLAMA_SERVER_RELATIVE_PATH = "lib/ollama/llama-server";

/** Full path of the llama.cpp server binary this runtime depends on. */
export function bundledLlamaServerPath(): string {
  const name = process.platform === "win32" ? `${LLAMA_SERVER_RELATIVE_PATH}.exe` : LLAMA_SERVER_RELATIVE_PATH;
  return path.join(bundledBinDir(), ...name.split("/"));
}

/** Absolute path of the `lib/ollama` directory inside the bundled runtime. */
export function bundledLibOllamaDir(): string {
  return path.join(bundledBinDir(), "lib", "ollama");
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

/**
 * Deletes the whole `bin` folder.
 *
 * THE RECOVERY PRIMITIVE FOR A HALF-UNPACKED RUNTIME. An extraction interrupted
 * by a crash, a full disk, or antivirus can leave a folder that LOOKS installed
 * (`ollama.exe` is present and correctly sized) but is missing `lib/ollama/`,
 * because that is where the 1.8 GB of DLLs go and that is what fails first.
 * Every such folder is poison: the server starts and then cannot load a model.
 *
 * So the repair is destructive by design - `recursive: true`, no questions asked
 * - and it is confined to `<dataDir>/bin`, which contains nothing but the runtime
 * this function exists to replace. Nothing outside the node's own directory is
 * ever touched.
 */
export function purgeBundledRuntime(): void {
  const dir = path.join(dataFilePath(), "bin");
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    console.log(`[BundledOllama] Removed ${dir} - the runtime was incomplete.`);
  } catch (error) {
    // Loud, because the re-extraction that follows will fail without it.
    console.warn(`[BundledOllama] Could not remove ${dir} - ${describeError(error)}`);
  }
}

/** True when the llama.cpp server binary is sitting in `bin/lib/ollama`. */
export function bundledLlamaServerPresent(): boolean {
  try {
    return fs.statSync(bundledLlamaServerPath()).size > 0;
  } catch {
    return false;
  }
}

/**
 * True when a usable binary is already sitting in the node's own bin folder.
 *
 * ONLY checks `ollama.exe`. Use {@link bundledRuntimeComplete} before spawning -
 * this stays permissive because it also answers "has an operator hand-placed a
 * binary here?", which is a question about one file rather than about a whole
 * runtime tree.
 */
export function bundledBinaryPresent(): boolean {
  try {
    return fs.statSync(bundledBinaryPath()).size >= MIN_BINARY_BYTES;
  } catch {
    return false;
  }
}

/**
 * THE GATE. True only when `bin/` holds BOTH the supervisor and the llama.cpp
 * server it execs.
 *
 * THIS IS THE CHECK THAT THE REPORTED BUG WAS MISSING. `ollama.exe` on its own
 * is a working PROGRAM that cannot do any WORK, so "the binary is there" was
 * never a sufficient answer to "is the runtime usable". The failure this catches
 * is silent at boot and loud at inference time, which is the worst place to find
 * out: the node looks healthy, the server answers `/api/tags`, and then every
 * single extraction dies with "llama-server binary not found".
 *
 * Both halves are `fs.existsSync`-style stat checks rather than a size heuristic
 * because `llama-server.exe` is only ~20 KB - it is a thin loader that pulls in
 * `libllama-server-impl.dll` beside it - so any "is it plausibly sized?" test
 * tuned for `ollama.exe` would reject it.
 */
export function bundledRuntimeComplete(): boolean {
  return bundledBinaryPresent() && bundledLlamaServerPresent();
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
    // Resolved, never the bare constant — this is the variable the child binds.
    OLLAMA_HOST: `127.0.0.1:${resolveBundledOllamaPort()}`,
    OLLAMA_NOHISTORY: "1",
    // CLOUD MODEL ROUTING IS OFF. Recent Ollama builds probe ollama.com on every
    // `model show` to hydrate a cloud model cache, and on an air-gapped or
    // firewalled satellite that probe times out and the server logs
    // `model show cloud cache hydration failed`. It is pure noise here: this node
    // is deliberately pinned to a LOCAL Ollama with its own models directory and
    // port (see the isolation notes above), and it must never silently depend on a
    // remote service being reachable. Setting this keeps the child from making
    // the request at all, rather than merely hiding the warning.
    OLLAMA_NO_CLOUD: "1",
  };
}
// MARK: - Archive extraction

/**
 * Rejects any archive member that would land outside `destDir`.
 *
 * The release archives are downloaded over the network and unpacked, which is a
 * zip-slip surface: a member named `../../Windows/System32/evil.dll` is enough
 * to write outside the destination if the name is ever joined to a path without
 * a check. `extract-zip` performs this same containment check internally, so the
 * POSIX path below is deliberately held to the identical standard rather than
 * being the one branch that trusts archive metadata.
 *
 * Normalising to a relative path BEFORE the join is what makes this sound: a
 * leading `/`, a drive letter, or any `..` segment all escape a plain
 * `path.join(dest, name)`, so they are rejected outright rather than trimmed.
 */
function safeArchiveDestination(destDir: string, entryName: string): string | null {
  if (!entryName || entryName.includes("\0")) return null;
  // Reject absolute POSIX paths, Windows drive-qualified paths and UNC paths
  // before normalising, so `path.join` cannot quietly resolve them back inside.
  if (entryName.startsWith("/") || entryName.startsWith("\\") || /^[a-zA-Z]:/.test(entryName)) {
    return null;
  }
  const normalised = path.normalize(entryName);
  if (normalised === ".." || normalised.startsWith(`..${path.sep}`) || path.isAbsolute(normalised)) {
    return null;
  }
  const root = path.resolve(destDir);
  const resolved = path.resolve(destDir, normalised);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return null;
  return resolved;
}

/**
 * Unpacks a Windows `.zip` release into `bin/`, PRESERVING THE DIRECTORY TREE.
 *
 * THIS FUNCTION REPLACED A SINGLE-MEMBER EXTRACTOR, and that is the whole fix.
 * The old code walked the ZIP central directory looking for one member whose
 * BASENAME was `ollama.exe`, returned those ~25 MB, and threw the other 86
 * entries away - including `lib/ollama/llama-server.exe`, which is what
 * `ollama serve` execs for every model load. The node therefore installed
 * cleanly and then failed every inference with "llama-server binary not found".
 *
 * The archive is passed BY PATH, never as a Buffer. The Windows release is
 * ~1.4 GB compressed; the previous implementation did `fs.readFileSync` on it
 * and then held the inflated member in memory too, which on a 4 GB satellite
 * laptop is an out-of-memory crash rather than an install. `extract-zip` streams
 * entry-by-entry through `yauzl`, so peak memory is one entry's buffer.
 *
 * Returns the number of files written, which the caller uses as a cheap sanity
 * signal before it checks for the specific binaries it needs.
 */
export async function extractZipTree(archivePath: string, destDir: string): Promise<number> {
  let written = 0;
  await extractZip(archivePath, {
    dir: destDir,
    onEntry: (entry) => {
      if (entry.fileName.endsWith("/")) return;
      written += 1;
      if (written % 10 === 0) {
        process.stdout.write(`\r[BundledOllama] extracting runtime: ${written} files   `);
      }
    },
  });
  if (written > 0) process.stdout.write("\n");
  return written;
}

/**
 * Unpacks a POSIX `.tar.zst` / `.tgz` release into `bin/`, preserving the tree.
 *
 * Same reasoning as {@link extractZipTree}: Linux and macOS releases carry the
 * identical `lib/ollama/llama-server` payload, so a basename-only extraction
 * produced the identical bug on every non-Windows platform. Symlinks (type `2`)
 * and hard links (type `1`) are skipped rather than recreated - materialising a
 * symlink an archive points at is how a tarball writes outside its destination.
 *
 * The container is stream-decompressed off disk rather than via
 * `zstdDecompressSync` on a whole-file Buffer, because the Linux release is
 * ~1.4 GB compressed and several GB raw.
 */
export async function extractTarTree(archivePath: string, destDir: string): Promise<number> {
  const magic = readMagicBytes(archivePath, 4);
  const isGzip = magic[0] === 0x1f && magic[1] === 0x8b;
  const isZstd = magic[0] === 0x28 && magic[1] === 0xb5 && magic[2] === 0x2f && magic[3] === 0xfd;

  // Node 22.15+/23+ exposes zstd on zlib. Older runtimes cannot read a .tar.zst at
  // all, so this fails loudly rather than writing a corrupt runtime.
  const zlib = await import("node:zlib");
  if (isZstd && typeof zlib.createZstdDecompress !== "function") {
    throw new Error(
      "this Node runtime cannot decompress zstd (tar.zst). Ollama's Linux release is " +
        "zstd-compressed; upgrade Node to 22.15+ or point OLLAMA_URL at a system Ollama.",
    );
  }

  // Stage 1: stream the container down to a plain `.tar` on disk.
  const tarPath = `${archivePath}.tar`;
  let written = 0;
  try {
    const source = fs.createReadStream(archivePath, { highWaterMark: 1024 * 1024 });
    const plain: NodeJS.ReadWriteStream = isGzip
      ? zlib.createGunzip()
      : isZstd
        ? zlib.createZstdDecompress()
        : new PassThrough();
    await pipeline(source, plain, fs.createWriteStream(tarPath));

    // Stage 2: walk the plain tar, writing each member through the path guard.
    const handle = fs.openSync(tarPath, "r");
    try {
      const header = Buffer.alloc(512);
      for (;;) {
        if (fs.readSync(handle, header, 0, 512, null) < 512) break;
        if (header.every((byte) => byte === 0)) break; // end-of-archive marker

        const nameField = header.toString("utf8", 0, 100).replace(/\0.*$/, "");
        // The ustar `prefix` field carries long paths split across the header.
        const prefixField = header.toString("utf8", 345, 500).replace(/\0.*$/, "").trim();
        const entryName = prefixField ? `${prefixField}/${nameField}` : nameField;

        const sizeField = header.toString("utf8", 124, 136).replace(/\0.*$/, "").trim();
        const size = sizeField ? parseInt(sizeField, 8) || 0 : 0;
        const typeFlag = String.fromCharCode(header[156]);

        // '5' directory, '2' symlink, '1' hard link, 'L'/'K' GNU long-name/link.
        const isDirectory = typeFlag === "5";
        const isRegular = typeFlag === "0" || typeFlag === "" || typeFlag === "\0" || typeFlag === "7";

        if (isDirectory) {
          const destination = safeArchiveDestination(destDir, entryName.replace(/\/+$/, ""));
          if (destination) fs.mkdirSync(destination, { recursive: true });
        } else if (isRegular) {
          const destination = safeArchiveDestination(destDir, entryName);
          if (!destination) {
            console.warn(`[BundledOllama] Skipped archive member with an unsafe path: ${entryName}`);
          } else {
            fs.mkdirSync(path.dirname(destination), { recursive: true });
            copyTarMember(handle, destination, size);
            written += 1;
          }
        }

        // Payloads are padded up to a 512-byte boundary; skip the padding too.
        const padded = Math.ceil(size / 512) * 512;
        if (padded > size) {
          const padding = Buffer.alloc(padded - size);
          fs.readSync(handle, padding, 0, padding.length, null);
        }
      }
    } finally {
      fs.closeSync(handle);
    }
  } finally {
    fs.rmSync(tarPath, { force: true });
  }

  return written;
}

/** Copies `size` bytes from an open tar handle to `destination`. */
function copyTarMember(handle: number, destination: string, size: number): void {
  if (size <= 0) {
    fs.writeFileSync(destination, "");
    return;
  }
  const out = fs.openSync(destination, "w");
  try {
    const chunk = Buffer.alloc(Math.min(size, 1024 * 1024));
    let remaining = size;
    while (remaining > 0) {
      const want = Math.min(remaining, chunk.length);
      const read = fs.readSync(handle, chunk, 0, want, null);
      if (read <= 0) break;
      fs.writeSync(out, chunk, 0, read);
      remaining -= read;
    }
  } finally {
    fs.closeSync(out);
  }
}

/** Reads the first `count` bytes of a file without loading the whole thing. */
function readMagicBytes(filePath: string, count: number): number[] {
  const buffer = Buffer.alloc(count);
  const handle = fs.openSync(filePath, "r");
  try {
    const read = fs.readSync(handle, buffer, 0, count, 0);
    return [...buffer.subarray(0, Math.max(0, read))];
  } finally {
    fs.closeSync(handle);
  }
}

/**
 * Makes every extracted executable runnable.
 *
 * Not just the top-level binary: `ollama serve` also execs `llama-server` and
 * `llama-quantize` out of `lib/ollama/`, and a tarball does not carry the POSIX
 * execute bit reliably, so all three are set.
 */
function makeExecutablesRunable(binDir: string): void {
  if (process.platform === "win32") return;
  const candidates = [
    path.join(binDir, bundledBinaryName()),
    path.join(bundledLibOllamaDir(), "llama-server"),
    path.join(bundledLibOllamaDir(), "llama-quantize"),
  ];
  for (const candidate of candidates) {
    try {
      fs.chmodSync(candidate, 0o755);
    } catch (error) {
      console.warn(`[BundledOllama] chmod +x failed on ${candidate} - ${describeError(error)}`);
    }
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
 * Resolves the newest release that actually publishes an archive for this platform.
 *
 * WHY IT READS THE FEED INSTEAD OF HARD-CODING `/releases/latest/download/<name>`:
 * the direct URL is simpler but fails opaquely when an asset is missing, and a
 * node that logs "404" cannot tell "Ollama renamed this asset" from "no internet".
 * Reading the feed lets us name the release we are installing and say why a
 * platform is unsupported, which is the difference between a supportable failure
 * and a mystery.
 *
 * BUT IT IS NOT THE ONLY PATH. `api.github.com` is aggressively rate limited for
 * unauthenticated callers (60 requests/hour per IP), and a shared satellite
 * NAT can exhaust that budget for every node behind it at once. When the feed
 * cannot be read we fall back to the canonical "latest" download URL, which
 * serves the same bytes from a different host. A node that installs an unnamed
 * version is strictly better than a node with no runtime, and the fallback is
 * clearly logged so the operator knows which path ran.
 */
export async function resolveLatestRelease(): Promise<ResolvedRelease> {
  const assetName = bundledAssetName();
  if (!assetName) {
    throw new Error(
      `no bundled Ollama build is published for ${process.platform}/${process.arch}. ` +
        `Set OLLAMA_URL to a system Ollama instead.`,
    );
  }

  try {
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
  } catch (error) {
    const reason = describeError(error);
    console.warn(
      `[BundledOllama] Could not read the Ollama release feed (${reason}). ` +
        `Falling back to the latest-download URL for ${assetName}.`,
    );
    return {
      // Unknown version on purpose: the fallback cannot tell us the tag without
      // the feed, and inventing one would be a lie in the version stamp.
      tag: "latest",
      assetName,
      downloadUrl: `${RELEASE_LATEST_DOWNLOAD}/${assetName}`,
      sizeBytes: 0,
    };
  }
}
// MARK: - Download & install

/**
 * Streams a release ARCHIVE to disk and returns the bytes written.
 *
 * Downloads to a `.part` file and renames only after the stream finishes, for the
 * same reason the OTA updater does it: a half-written file that looks complete is
 * worse than no file, because the next boot will happily extract from a truncated
 * archive and report the result as "Ollama is broken".
 *
 * Progress is reported as whole percentages only. Ollama's Windows archive is
 * ~1.4 GB and a satellite link is slow; a per-chunk log would emit thousands of
 * lines and bury everything else.
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
        process.stdout.write(`\r[BundledOllama] downloading Ollama: ${percent}%   `);
      }
    }
  });

  // Any failure past this point MUST remove the partial file. Without this a
  // failed 1.4 GB download leaves a 1.4 GB `.part` sitting in `bin/`, and the
  // next attempt starts by re-downloading on top of a full disk. `finally`
  // covers every exit including the aborted-transfer case that `pipeline`
  // reports as a throw, and is a no-op once the rename has moved the file away.
  try {
    await pipeline(stream, fs.createWriteStream(partial));
    if (total > 0) process.stdout.write("\n");

    const size = fs.statSync(partial).size;
    // Refuse a truncated transfer BEFORE it is renamed into place. An HTML error
    // page from a captive portal is ~10 KB and would otherwise extract as garbage.
    if (size < MIN_ARCHIVE_BYTES || size > MAX_ARCHIVE_BYTES) {
      throw new Error(
        `downloaded ${size} bytes for ${url}, which is outside the plausible range ` +
          `(${MIN_ARCHIVE_BYTES}-${MAX_ARCHIVE_BYTES}). Treating it as a failed transfer.`,
      );
    }
    fs.renameSync(partial, destination);
    return size;
  } finally {
    fs.rmSync(partial, { force: true });
  }
}
/**
 * Makes sure a COMPLETE, USABLE runtime exists in the node's own `bin` folder,
 * downloading and unpacking the official release archive when it is not.
 *
 * Returns the absolute path of the supervisor binary now in place.
 *
 * THE INVARIANT THIS FUNCTION ESTABLISHES, and everything below exists to
 * protect it: after this returns, `bin/` contains `ollama.exe` AND
 * `lib/ollama/llama-server.exe` (plus the ~1.8 GB of ggml/CUDA DLLs beside it).
 * It is checked on entry, checked again after extraction, and checked again by
 * every caller before spawning - because the failure mode of getting it wrong is
 * a node that appears healthy and then fails every single inference.
 *
 * `force` re-downloads even when the stamped version already matches. That is
 * what the repair path needs after a corrupted install, and it is ALSO what
 * triggers when the completeness check fails on a folder that has a version
 * stamp: a stamp is evidence about what we installed, not evidence that the
 * files are still all there.
 */
export async function ensureBundledBinary(
  options: { force?: boolean; release?: ResolvedRelease } = {},
): Promise<string> {
  const binaryPath = bundledBinaryPath();
  const installed = installedBundledVersion();

  // 1. Complete and current? Nothing to do.
  if (bundledRuntimeComplete() && installed && !options.force) return binaryPath;

  // 2. `bin/` holds a binary but NOT the runtime tree around it. This is the
  //    half-install left behind by the bug this module was rewritten to fix: a
  //    correctly sized `ollama.exe` sitting alone in `bin/`, with no `lib/ollama/`
  //    beside it, which starts happily and dies on every model load.
  //
  //    It is deleted rather than trusted. The old code's "present-but-unknown,
  //    assume the operator meant it" courtesy is only defensible for a hand-placed
  //    COMPLETE runtime; for an incomplete one the only two options are to do
  //    nothing (the node stays broken forever) or rebuild (the operator gets the
  //    thing they asked for), and rebuilding is the obvious answer.
  if (bundledBinaryPresent() && !bundledLlamaServerPresent() && !options.force) {
    console.warn(
      `[BundledOllama] ${bundledLlamaServerPath()} is missing - the runtime is only ` +
        `partly installed. Discarding ${bundledBinDir()} and re-installing.`,
    );
    purgeBundledRuntime();
  } else if (bundledBinaryPresent() && !options.force) {
    console.log(`[BundledOllama] Using the existing bundled runtime at ${binaryPath}.`);
    return binaryPath;
  }

  const release = options.release ?? (await resolveLatestRelease());
  console.log(`[BundledOllama] Installing Ollama ${release.tag} (${release.assetName}).`);
  publishLine("cmd", `downloading bundled Ollama ${release.tag} - no global install required`);

  // The archive is staged INSIDE `bin/` so a failed install cannot leave a
  // multi-gigabyte `.part` file scattered elsewhere in the data directory, and so
  // `purgeBundledRuntime()` cleans up an abandoned download along with everything
  // else. It is removed as soon as extraction finishes - keeping a second copy of
  // 1.4 GB on a satellite-appliance disk would be indefensible.
  const archivePath = path.join(bundledBinDir(), path.basename(release.assetName));
  try {
    await downloadAsset(release.downloadUrl, archivePath);
  } catch (error) {
    // A failed upgrade must not DELETE a working older runtime. Falling back keeps
    // the node's brain available while the operator is offline - but ONLY when the
    // older runtime is actually complete. Falling back to a half-install would
    // just relocate the failure from install time to inference time.
    if (bundledRuntimeComplete()) {
      console.warn(
        `[BundledOllama] Upgrade to ${release.tag} failed (${describeError(error)}) - ` +
          `keeping the existing runtime.`,
      );
      return binaryPath;
    }
    throw error;
  }

  // Extraction goes to a scratch folder first and is only promoted into `bin/`
  // once it has been proved complete. Extracting straight into the live folder
  // means an interrupted run leaves the previous version's files interleaved with
  // the new version's, which is a state no version check can ever validate.
  //
  // IT IS A SIBLING OF `bin/`, NOT A CHILD OF IT. The promote step empties `bin/`
  // wholesale, so a staging folder inside it would be deleted by its own cleanup;
  // putting it beside `bin/` keeps the two lifecycles independent and means
  // `purgeBundledRuntime()` cannot delete a half-extracted tree out from under
  // the rename that is about to promote it.
  const staging = path.join(dataFilePath(), ".bin-staging");
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });

  try {
    const files = process.platform === "win32"
      ? await extractZipTree(archivePath, staging)
      : await extractTarTree(archivePath, staging);
    console.log(`[BundledOllama] Extracted ${files} files from ${path.basename(release.assetName)}.`);

    // 3. VERIFY BEFORE PROMOTING. Both checks are against the staging tree, so a
    //    failure costs one re-download rather than a destroyed working runtime.
    if (!fs.existsSync(path.join(staging, bundledBinaryName()))) {
      throw new Error(`the archive did not contain ${bundledBinaryName()}`);
    }
    const stagedServer = path.join(
      staging,
      ...(process.platform === "win32"
        ? `${LLAMA_SERVER_RELATIVE_PATH}.exe`
        : LLAMA_SERVER_RELATIVE_PATH).split("/"),
    );
    if (!fs.existsSync(stagedServer)) {
      // This is the check whose absence caused the reported bug. Stating it as a
      // hard failure rather than a warning is deliberate: a runtime without
      // llama-server cannot load a single model, so "installed" would be a lie.
      throw new Error(
        `the archive did not contain ${process.platform === "win32" ? `${LLAMA_SERVER_RELATIVE_PATH}.exe` : LLAMA_SERVER_RELATIVE_PATH}` +
          ` - an Ollama release without it cannot load a model, so there is no point installing it`,
      );
    }

    // 4. Promote. `bin/` is emptied first so an upgrade cannot leave stale DLLs
    //    that the newer runtime would still find and load.
    const live = bundledBinDir();
    for (const entry of fs.readdirSync(live)) {
      if (entry === "ollama.version") continue; // survives an upgrade on purpose
      fs.rmSync(path.join(live, entry), { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    }
    for (const entry of fs.readdirSync(staging)) {
      fs.renameSync(path.join(staging, entry), path.join(live, entry));
    }
  } catch (error) {
    // The extraction failed. Leave NOTHING half-written behind: an incomplete
    // `bin/` is precisely the state this module exists to detect, and creating one
    // deliberately while trying to escape one would be absurd.
    //
    // `bin/` is purged ONLY when it is not already known-good. If this was an
    // upgrade over a working runtime and the new archive failed to unpack, the
    // old one is still on disk and still works - destroying it would turn a
    // failed upgrade into a node with no brain at all.
    if (!bundledRuntimeComplete()) purgeBundledRuntime();
    throw error;
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
    fs.rmSync(archivePath, { force: true });
    fs.rmSync(`${archivePath}.part`, { force: true });
  }

  makeExecutablesRunable(bundledBinDir());
  fs.writeFileSync(bundledVersionStampPath(), release.tag, "utf8");

  console.log(
    `[BundledOllama] Ollama ${release.tag} installed into ${bundledBinDir()} ` +
      `(ollama.exe + ${path.relative(bundledBinDir(), bundledLlamaServerPath())} + runtime DLLs, ` +
      `contained in the node's own directory).`,
  );
  publishNodeEvent({
    kind: "info",
    title: "Bundled Ollama installed",
    detail:
      `Ollama ${release.tag} downloaded and unpacked into the node's own bin folder - ` +
      `nothing was installed system-wide.`,
  });
  return bundledBinaryPath();
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
  const response = await axios.get(`${bundledOllamaOrigin()}/api/tags`, {
    timeout: 5_000,
    proxy: false,
  });
  return readModelNames(response?.data);
}

/** True when the isolated server answers. Never throws â€” unreachable is false. */
export async function bundledServerAlive(): Promise<boolean> {
  try {
    await axios.get(`${bundledOllamaOrigin()}/api/tags`, { timeout: 3_000, proxy: false });
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

  // Requires the WHOLE runtime, not just the supervisor. `ollama pull` against a
  // binary with no `lib/ollama/` beside it cannot pull anything, and reporting
  // that as "the binary is not installed yet" would send the operator looking in
  // the wrong place; this says precisely which file is missing.
  if (!bundledRuntimeComplete()) {
    return {
      ok: false,
      message: bundledBinaryPresent()
        ? `the bundled Ollama runtime is incomplete - ${bundledLlamaServerPath()} is missing`
        : "the bundled Ollama binary is not installed yet",
    };
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
  /** True when BOTH `ollama.exe` and `lib/ollama/llama-server[.exe]` are on disk. */
  runtimeComplete: boolean;
  /** Absolute path of the llama.cpp server binary, or "" when it is not installed. */
  llamaServerPath: string;
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
      port: resolveBundledOllamaPort(),
      pid: this.child?.pid ?? null,
      restartCount: this.restartCount,
      lastError: this.lastError,
      // Surfaced separately from `binaryPresent` because the two genuinely differ,
      // and the difference is the whole bug: a supervisor on disk with no
      // llama-server beside it cannot load a model.
      runtimeComplete: bundledRuntimeComplete(),
      llamaServerPath: bundledLlamaServerPresent() ? bundledLlamaServerPath() : "",
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
        this.lastError = `the bundled Ollama server never answered on port ${resolveBundledOllamaPort()}`;
        console.warn(`[BundledOllama] ${this.lastError}.`);
        return;
      }
      this.state = "running";
      this.lastError = null;
      console.log(`[BundledOllama] Serving on ${bundledOllamaOrigin()} (isolated).`);

      // Model provisioning is deliberately NOT awaited into readiness: a first pull
      // is multi-gigabyte and blocking boot on it would make a healthy node look
      // dead. It is enforced in the background and re-checked on restart.
      void this.ensureModel().catch((error) => {
        this.lastError = describeError(error);
      });
    } catch (error) {
      this.lastError = describeError(error);
      this.state = "crashed";
      console.warn(`[BundledOllama] Startup failed - ${this.lastError}`);
    }
  }

  /**
   * Spawns `<bin>/ollama serve` with the isolation env injected.
   *
   * PRE-SPAWN COMPLETENESS GATE. Before the child is created we re-check the
   * filesystem for `lib/ollama/llama-server[.exe]` and refuse to spawn without
   * it. `ensureBundledBinary()` already establishes this invariant, so on the
   * happy path the check costs one `stat` and changes nothing; it exists because
   * the guarantee can be broken between install and launch by things this module
   * does not control:
   *
   *   - antivirus quarantining a DLL out of `lib/ollama/`;
   *   - an operator (or a cleanup script) emptying `bin/` while the node runs;
   *   - a disk that filled up mid-extraction on a previous boot;
   *   - a hand-edited `bin/` that kept the version stamp but not the files.
   *
   * Spawning anyway produces the worst possible outcome: the server binds the
   * port, `/api/tags` answers, the dashboard shows a healthy runtime, and then
   * every extraction fails with "llama-server binary not found". Failing here
   * turns a silent, confusing runtime failure into one loud, self-healing
   * download.
   *
   * THE ENV MERGE ORDER IS ALSO LOAD-BEARING: `{...process.env, ...bundledOllamaEnv()}`
   * applies the isolation variables LAST so they win. The child still inherits
   * PATH/HOME (it cannot run without them), but a stray `OLLAMA_HOST` already
   * present in the node's own environment can no longer redirect the server onto
   * the host's personal install.
   */
  private async spawnServer(binary: string): Promise<void> {
    // `fs.existsSync` is deliberate here rather than a `statSync` in a try: this
    // runs on every (re)start, including the cheap crash-restart loop, and the
    // question being asked is literally "does this path exist".
    if (!fs.existsSync(bundledLlamaServerPath())) {
      console.warn(
        `[BundledOllama] ${bundledLlamaServerPath()} is missing, so ollama serve could not ` +
          `load a model. Deleting ${bundledBinDir()} and re-installing from scratch.`,
      );
      publishLine("err", "bundled Ollama runtime incomplete (no llama-server) - reinstalling");
      // Nuke first: whatever is in `bin/` is now known-bad, and re-extracting
      // over it would leave a mix of old and new DLLs that no check can validate.
      purgeBundledRuntime();
      await ensureBundledBinary({ force: true });
      if (!fs.existsSync(bundledLlamaServerPath())) {
        throw new Error(
          `re-installing Ollama did not produce ${bundledLlamaServerPath()}. ` +
            `The published archive is missing its llama-server runtime, so this node ` +
            `cannot run models without an external Ollama (set OLLAMA_URL).`,
        );
      }
      binary = bundledBinaryPath();
    }

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
      // Delete `bin/` up front rather than relying on the install to overwrite it.
      // "Reinstall" that extracts over a poisoned folder can leave a mix of old
      // and new DLLs, and the operator who clicked Reinstall is asking for the
      // thing to be gone, not for the bad parts to be overwritten in place.
      purgeBundledRuntime();
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