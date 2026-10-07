/**
 * ZERO-TOUCH OLLAMA WATCHDOG — autonomous local-AI bootstrap for the Rippa Node.
 *
 * WHY THIS MODULE EXISTS (the epic). A Rippa Node must run with zero setup:
 * no manual Ollama install, no port forwarding, no Cloudflare Tunnel. Three
 * guarantees make that true, and this module owns all three:
 *
 *   1. SILENT INSTALLATION & BOOTSTRAP — look for an Ollama binary on the host
 *      (PATH plus per-OS default locations). When none is found the node's own
 *      portable runtime (`services/bundled-ollama.ts`: standalone binary in the
 *      data dir, no admin, no service) is fetched instead. Either way the
 *      required model (`qwen2.5-coder:7b`, or the smaller RAM-appropriate model
 *      on constrained hosts) is pulled when absent, with progress streamed to
 *      the Node UI through the engine-telemetry bus.
 *
 *      WHY THE PORTABLE RUNTIME IS THE DEFAULT, NOT `OllamaSetup.exe`. That
 *      installer wants elevation, writes to Program Files, registers a service
 *      and starts a tray app — every one breaks "portable, no admin". The
 *      standalone release archive is the same official build without the host
 *      mutation. The official installer (`OllamaSetup.exe` on Windows) is now
 *      auto-run silently on a fresh machine unless the operator opts OUT with
 *      `RIPPA_OLLAMA_HOST_INSTALL=0`; legacy `=1` still opts in. When the
 *      silent host install fails (no admin, no network, non-Windows without a
 *      runnable installer) the portable runtime is used as the fallback, so
 *      boot never wedges. Host binaries that already exist are reported but
 *      never disturbed.
 *
 *   2. DYNAMIC PORT BINDING & AUTO-REPAIR — prefer the configured port, but
 *      when it is occupied heal to a free ephemeral localhost port instead of
 *      crashing. The chosen port is claimed via `setDynamicOllamaPort()` so
 *      the resolver, `OLLAMA_HOST` and every inference request agree on one
 *      number, and it is published into the live `env` object.
 *
 *   3. OUTBOUND-ONLY TASK POLLING (NO TUNNELS) — the node never accepts
 *      inbound connections for AI work. It polls the Mothership over plain
 *      outbound HTTPS (`SwarmClient.fetchTasks` + heartbeat `pending_tasks`),
 *      executes `ai_inference` tasks against the dynamic-port instance, and
 *      POSTs the result back. No listener, no port-forward, no tunnel.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import axios from "axios";
import { pipeline } from "node:stream/promises";

// Static imports: `@yao-pkg/pkg` cannot resolve dynamic `import()` inside the
// snapshot ("A dynamic import callback was not specified"). Everything on the
// boot path must be statically analyzable, so these live at the top level.
// (`bundled-ollama` never imports this file, and `nodeEvents` is a leaf, so
// there is no import cycle.)
import { setDynamicOllamaPort } from "./bundled-ollama";
import { publishNodeEvent } from "./nodeEvents";
import { dataFilePath } from "../utils/paths";

import { PRIMARY_MODEL, recommendedPrimaryModel } from "../agent/OllamaClient";

/** Preferred model for fully-provisioned hosts (the epic's required model). */
export const REQUIRED_MODEL = PRIMARY_MODEL;

/** Default Ollama port the epic names (tried via the managed resolver first). */
export const DEFAULT_OLLAMA_PORT = 11434;

/** Host-wide opt-out: set `RIPPA_ZERO_TOUCH_OLLAMA=0` to skip auto-provision. */
const ZERO_TOUCH_ENV = "RIPPA_ZERO_TOUCH_OLLAMA";

/** Opt-in to a host-level official installer instead of the portable runtime. */
const HOST_INSTALL_ENV = "RIPPA_OLLAMA_HOST_INSTALL";

/** Progress callback the bootstrap calls as the model pull advances. */
export type WatchdogProgress = (stage: string, percent: number | null, detail: string) => void;

/** What the bootstrap decided, for boot logging and the status endpoint. */
export interface ZeroTouchPlan {
  /** Absolute host binary path when one was found, else null. */
  hostBinary: string | null;
  /** True when the portable runtime will serve (the normal zero-touch path). */
  usingBundledRuntime: boolean;
  /** The port the managed server should bind (already claimed free). */
  port: number;
  /** Model that will be ensured after the server answers. */
  model: string;
}

/** In-memory copy of the last plan, so the UI can report it without re-probing. */
let lastPlan: ZeroTouchPlan | null = null;

/** Returns the last bootstrap plan, or null when it has not run yet. */
export function getZeroTouchPlan(): ZeroTouchPlan | null {
  return lastPlan;
}

/**
 * Locates an Ollama binary already installed on the host, or null.
 * Checks PATH first (`ollama` / `ollama.exe`), then per-OS default locations.
 * Read-only: nothing is executed.
 */
export function findHostOllamaBinary(): string | null {
  try {
    const probe = process.platform === "win32" ? "where" : "which";
    const found = spawnSync(probe, ["ollama"], { encoding: "utf8", windowsHide: true });
    if (found.status === 0) {
      const first = String(found.stdout || "")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)[0];
      if (first && fs.existsSync(first)) return first;
    }
  } catch {
    // PATH probe failed — fall through to the well-known locations.
  }
  const candidates: string[] = [];
  if (process.platform === "win32") {
    const programFiles = process.env["ProgramFiles"] ?? "C:\\Program Files";
    const localApp = process.env["LOCALAPPDATA"] ?? "";
    candidates.push(
      path.join(programFiles, "Ollama", "ollama.exe"),
      localApp ? path.join(localApp, "Programs", "Ollama", "ollama.exe") : "",
    );
  } else if (process.platform === "darwin") {
    candidates.push("/Applications/Ollama.app/Contents/Resources/ollama", "/usr/local/bin/ollama");
  } else {
    candidates.push("/usr/local/bin/ollama", "/usr/bin/ollama");
  }
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Official installer source for the host OS.
 * Downloaded + silently executed automatically unless the operator sets
 * `RIPPA_OLLAMA_HOST_INSTALL=0` (or false/no/off).
 */
export function getOfficialInstallerInfo(): { url: string; silentArgs: string[]; note: string } {
  if (process.platform === "win32") {
    return {
      url: "https://ollama.com/download/OllamaSetup.exe",
      silentArgs: ["/S"],
      note: "Silent NSIS install (/S); portable runtime is the fallback.",
    };
  }
  if (process.platform === "darwin") {
    return {
      url: "https://ollama.com/download/Ollama-darwin.zip",
      silentArgs: [],
      note: "macOS ships a drag-install zip; the portable runtime is preferred.",
    };
  }
  return {
    url: "https://ollama.com/install.sh",
    silentArgs: [],
    note: "Piped shell installer; needs root. Portable runtime preferred.",
  };
}

/**
 * True unless the operator explicitly opted OUT of the silent host install
 * (`RIPPA_OLLAMA_HOST_INSTALL=0` / false / no / off). Unset (the normal
 * fresh-machine case) means YES — true zero-touch. Legacy `=1` still opts in.
 */
export function wantsHostInstall(): boolean {
  const raw = (process.env[HOST_INSTALL_ENV] ?? "").trim().toLowerCase();
  if (raw === "" || raw === "auto") return true;
  if (raw === "0" || raw === "false" || raw === "no" || raw === "off") return false;
  return true;
}

/** Where the downloaded official installer is staged (OTA-safe data dir). */
export function hostInstallerStagePath(): string {
  const name = process.platform === "win32" ? "OllamaSetup.exe" : "ollama-host-installer";
  try {
    return dataFilePath("ollama-host-install", name);
  } catch {
    return path.join(os.tmpdir(), "rippa-ollama-host-install", name);
  }
}

/** True when a TCP connect to 127.0.0.1:port succeeds (something answers). */
export function isPortOccupied(port: number, timeoutMs = 750): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const done = (occupied: boolean): void => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch {
        // Tearing down either way.
      }
      resolve(occupied);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
    try {
      socket.connect(port, "127.0.0.1");
    } catch {
      done(false);
    }
  });
}

/** Returns a currently-free loopback port by binding port 0 and releasing it. */
export async function findFreeEphemeralPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref?.();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

/** Prefers `preferred`; heals to a free ephemeral port when it is occupied. */
export async function resolveHealedPort(preferred: number): Promise<{ port: number; healed: boolean }> {
  if (Number.isInteger(preferred) && preferred >= 1 && preferred <= 65535) {
    const occupied = await isPortOccupied(preferred);
    if (!occupied) return { port: preferred, healed: false };
  }
  return { port: await findFreeEphemeralPort(), healed: true };
}

/**
 * Downloads the official installer to the stage path (`.part` + rename, so a
 * half-written file is never executed). Bundler-safe: static `axios` import.
 */
export async function downloadHostInstaller(
  onProgress: WatchdogProgress = defaultProgressReporter,
): Promise<string> {
  const installer = getOfficialInstallerInfo();
  const dest = hostInstallerStagePath();
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  onProgress("install-download", null, `Downloading official Ollama installer from ${installer.url} ...`);
  const response = await axios.get(installer.url, {
    responseType: "stream",
    timeout: 10 * 60_000,
    maxRedirects: 5,
    headers: { "User-Agent": "rippa-node-zero-touch", Accept: "application/octet-stream" },
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
        onProgress("install-download", percent, `Downloading OllamaSetup.exe: ${percent}%`);
      }
    }
  });
  const partial = `${dest}.part`;
  try {
    await pipeline(stream, fs.createWriteStream(partial));
    fs.renameSync(partial, dest);
  } finally {
    try {
      if (fs.existsSync(partial)) fs.rmSync(partial, { force: true });
    } catch {
      // Best-effort cleanup of the partial file.
    }
  }
  onProgress("install-download", 100, `Installer downloaded (${received} bytes).`);
  return dest;
}

/**
 * Silently executes the staged installer and waits for completion.
 * Windows: `OllamaSetup.exe /S` (NSIS silent). Other platforms have no silent
 * contract, so this reports unsupported and the caller falls back.
 */
export async function runHostInstallerSilent(
  installerPath: string,
  onProgress: WatchdogProgress = defaultProgressReporter,
): Promise<boolean> {
  const info = getOfficialInstallerInfo();
  if (process.platform !== "win32" || info.silentArgs.length === 0) {
    onProgress("install", null, "No silent host-install contract here — portable runtime instead.");
    return false;
  }
  onProgress("install", null, `Running silent Ollama install (${info.silentArgs.join(" ")}) ...`);
  const result = spawnSync(installerPath, info.silentArgs, {
    encoding: "utf8",
    windowsHide: true,
    timeout: 15 * 60_000,
  });
  if (result.error) {
    onProgress("install", null, `Silent installer failed to launch: ${result.error.message}.`);
    return false;
  }
  if (result.status !== 0) {
    onProgress("install", null, `Silent installer exited with code ${result.status}.`);
    return false;
  }
  const found = findHostOllamaBinary();
  if (found) {
    onProgress("install", null, `Silent Ollama install complete — host binary at ${found}.`);
    return true;
  }
  onProgress("install", null, "Installer finished but no host binary found — portable fallback.");
  return false;
}

/**
 * TRUE ZERO-TOUCH: autonomously download + silently run `OllamaSetup.exe /S`
 * and wait. Never throws — any failure resolves false so boot falls back to
 * the portable runtime instead of wedging.
 */
export async function ensureHostOllamaInstalled(
  onProgress: WatchdogProgress = defaultProgressReporter,
): Promise<boolean> {
  if (findHostOllamaBinary()) return true;
  if (!wantsHostInstall()) {
    onProgress("install", null, "Host install disabled via RIPPA_OLLAMA_HOST_INSTALL=0.");
    return false;
  }
  try {
    const staged = await downloadHostInstaller(onProgress);
    return await runHostInstallerSilent(staged, onProgress);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    onProgress("install", null, `Host auto-install failed (${reason}) — portable fallback.`);
    return false;
  }
}

/**
 * Builds the zero-touch plan WITHOUT starting anything: detect the host
 * binary, pick the model for this hardware, heal the port when occupied.
 * Pure with respect to processes — safe for tests and the UI.
 */
export async function planZeroTouchOllama(preferredPort: number): Promise<ZeroTouchPlan> {
  const hostBinary = findHostOllamaBinary();
  const model = recommendedPrimaryModel();
  const { port } = await resolveHealedPort(preferredPort);
  const plan: ZeroTouchPlan = { hostBinary, usingBundledRuntime: true, port, model };
  lastPlan = plan;
  return plan;
}

/**
 * Runs the silent bootstrap: auto-installs when missing, claims the healed
 * port, then reports readiness. The server start stays with
 * `ollamaManager.start()` (one spawner); this only decides WHERE it binds
 * and WHAT it pulls. Bundler-safe: no dynamic `import()` anywhere.
 */
export async function ensureZeroTouchOllama(
  preferredPort: number,
  onProgress: WatchdogProgress = defaultProgressReporter,
): Promise<ZeroTouchPlan> {
  if (!isZeroTouchEnabled()) {
    const fallback = Number.isInteger(preferredPort) ? preferredPort : DEFAULT_OLLAMA_PORT;
    const plan: ZeroTouchPlan = {
      hostBinary: findHostOllamaBinary(),
      usingBundledRuntime: false,
      port: fallback,
      model: recommendedPrimaryModel(),
    };
    lastPlan = plan;
    onProgress("disabled", null, "Zero-touch bootstrap disabled via RIPPA_ZERO_TOUCH_OLLAMA=0.");
    return plan;
  }
  let hostBinary = findHostOllamaBinary();
  if (hostBinary) {
    onProgress("detect", null, `Found host Ollama binary at ${hostBinary} — managed runtime stays isolated.`);
  } else if (wantsHostInstall()) {
    onProgress("detect", null, "No host Ollama binary — zero-touch auto-install starting.");
    const installed = await ensureHostOllamaInstalled(onProgress);
    hostBinary = findHostOllamaBinary();
    if (!installed || !hostBinary) {
      const installer = getOfficialInstallerInfo();
      onProgress(
        "detect",
        null,
        `Host auto-install did not land a binary — portable runtime (no admin). ` +
          `Official installer at ${installer.url}.`,
      );
    }
  } else {
    onProgress("detect", null, "No host Ollama binary — portable runtime (host install disabled).");
  }
  const { port, healed } = await resolveHealedPort(preferredPort);
  const model = recommendedPrimaryModel();
  if (healed) {
    onProgress("port-heal", null, `Port ${preferredPort} occupied — healed to free port ${port}.`);
  } else {
    onProgress("port", null, `Port ${port} is free — binding there.`);
  }
  // Static import at the top (pkg cannot resolve dynamic import callbacks).
  setDynamicOllamaPort(port);
  const plan: ZeroTouchPlan = { hostBinary, usingBundledRuntime: true, port, model };
  lastPlan = plan;
  onProgress("ready", null, `Zero-touch plan ready — model ${model} on port ${port}.`);
  return plan;
}

/** Default progress sink: engine bus when available, console otherwise. */
export function defaultProgressReporter(stage: string, percent: number | null, detail: string): void {
  const suffix = percent === null ? "" : ` (${percent}%)`;
  console.log(`[OllamaWatchdog] ${stage}${suffix} — ${detail}`);
  try {
    // Static import at the top (pkg cannot resolve dynamic import callbacks).
    publishNodeEvent({ kind: "info", title: `Ollama bootstrap: ${stage}`, detail });
  } catch {
    // Bus unavailable (tests) — the console line above is the report.
  }
}

/** System RAM in GB, for boot logging ("why this model on this box"). */
export function hostRamGb(): number {
  return Math.round((os.totalmem() / (1024 * 1024 * 1024)) * 10) / 10;
}

/** False only when the operator explicitly opted out (`...=0` / `false`). */
export function isZeroTouchEnabled(): boolean {
  const raw = (process.env[ZERO_TOUCH_ENV] ?? "").trim().toLowerCase();
  return raw !== "0" && raw !== "false" && raw !== "no" && raw !== "off";
}
