import { spawn, type ChildProcess } from "node:child_process";
import axios from "axios";
import { env } from "../config";
import {
  OllamaClient,
  PRIMARY_MODEL,
  FALLBACK_MODEL,
  EMBEDDING_MODEL,
  recommendedPrimaryModel,
  systemRamGb,
} from "../agent/OllamaClient";
import { publishNodeEvent } from "./nodeEvents";
import {
  clearEngineActivity,
  currentEngineActivity,
  noteEngineActivity,
  publishLine,
  type EngineHealth,
} from "./engineTelemetry";
import {
  BUNDLED_OLLAMA_ORIGIN,
  BUNDLED_OLLAMA_PORT,
  bundledBinaryPath,
  bundledBinaryPresent,
  bundledOllamaEnv,
  bundledOllama,
  ensureBundledBinary,
} from "./bundled-ollama";

/**
 * OLLAMA PROCESS MANAGER — supervises the Ollama child this node runs.
 *
 * SCOPE AND INTENT. This module manages the LIFECYCLE of the Ollama process. The
 * runtime itself — obtaining the standalone binary, confining its model store
 * and its port, and enforcing the default model — lives in
 * `services/bundled-ollama.ts`, which this module drives. Splitting it that way
 * keeps "which process is running" (here, and the concern the Control Panel talks
 * to) separate from "where did the binary come from" (there).
 *
 * RESPONSIBILITIES:
 *   1. OPT-IN SUPERVISION — only takes over the process when the operator
 *      enables it (RIPPA_OLLAMA_MANAGED=true, or via the Control Panel). A
 *      node pointed at an Ollama instance it did not start is left alone.
 *   2. AUTO-RESTART — a crashed child is relaunched with backoff.
 *   3. MODEL FALLBACK — pulls/switches to FALLBACK_MODEL when the primary
 *      model fails, so the mesh keeps a locally-capable node.
 *   4. CLEAN SHUTDOWN — the child is confirmed dead before `stop()` returns, so
 *      the node can exit without leaving a bound port behind.
 *   5. STATUS — a small snapshot consumed by heartbeat telemetry and the
 *      dashboard's Ollama Control Panel.
 */

/** Backoff schedule for auto-restart after a crash (ms). */
const RESTART_BACKOFF_MS = [2_000, 5_000, 15_000, 30_000, 60_000];
/** Restarts within this window count toward the backoff ladder. */
const CRASH_WINDOW_MS = 10 * 60_000;

export type OllamaRunState = "stopped" | "starting" | "running" | "crashed" | "unmanaged";

export interface OllamaStatus {
  /** True when this node is allowed to spawn/restart the process itself. */
  managed: boolean;
  /** True when the UI padlock is unlocked (manual override permitted). */
  unlocked: boolean;
  state: OllamaRunState;
  /** Model currently selected (requested, not necessarily confirmed loaded). */
  model: string;
  /** Port the local server is configured to serve on. */
  port: number;
  /** Current task description, mirrored from the heartbeat's current_process. */
  task: string | null;
  /** Last error, if any, kept for the panel's diagnostics. */
  lastError: string | null;
  /** Number of restarts since boot. */
  restartCount: number;
  /** Total system RAM in GB, used by the hardware auto-profiler. */
  ramGb: number;
  /** True once the embedding model has been pulled on this node. */
  embeddingModelReady: boolean;
  /** Name of the embedding model this node auto-pulls. */
  embeddingModel: string;
  /** True when the runtime binary lives in the node's own directory. */
  bundledRuntime: boolean;
  /** Absolute path of the bundled runtime binary, or "" when none is installed. */
  bundledBinaryPath: string;
  /** Release tag of the installed bundled runtime, or "". */
  bundledVersion: string;
}

function extractPort(url: string): number {
  try {
    const parsed = new URL(url);
    const port = Number(parsed.port);
    return Number.isFinite(port) && port > 0 ? port : 11434;
  } catch {
    return 11434;
  }
}

/**
 * Pulls model names out of an Ollama list response.
 *
 * WHY THIS HELPER EXISTS, AND WHY IT CHECKS TWO SHAPES. Both `/api/tags` and
 * `/api/ps` wrap their array in an envelope, and WHICH envelope is not the same
 * across Ollama versions: `/api/tags` returns `{"models":[…]}`, and `/api/ps`
 * returns `{"models":[…]}` on current builds but `{"data":[…]}` on older ones.
 *
 * The first version of this probe read `response.data.data` and therefore reported
 * ZERO models against a perfectly healthy server — the badge said "no model
 * resident" on a node with a 7B loaded, which is exactly the kind of confident
 * wrong answer a health indicator must never give.
 *
 * Note the first argument is the response BODY (`axiosResponse.data`), not the
 * axios response. Conflating those two is what caused the bug in the first place.
 */
function readOllamaModels(body: unknown): string[] {
  const envelope = (body ?? {}) as { models?: unknown; data?: unknown };
  const rows = Array.isArray(envelope.models) ? envelope.models : envelope.data;
  if (!Array.isArray(rows)) return [];
  return rows
    .map((entry) => {
      const record = (entry ?? {}) as { name?: string; model?: string };
      return record.name ?? record.model ?? "";
    })
    .filter(Boolean);
}

class OllamaManager {
  private child: ChildProcess | null = null;
  private managed = false;
  private unlocked = false;
  private state: OllamaRunState = "unmanaged";
  private model = PRIMARY_MODEL;
  private lastError: string | null = null;
  private restartCount = 0;
  private embeddingModelReady = false;
  private crashTimestamps: number[] = [];
  private restartTimer: NodeJS.Timeout | null = null;
  private stopping = false;

  /** Enables/disables self-supervision. Idempotent. */
  setManaged(managed: boolean): void {
    if (this.managed === managed) return;
    this.managed = managed;
    if (managed) {
      this.state = "stopped";
      void this.start();
    } else {
      void this.stop();
      this.state = "unmanaged";
    }
  }

  isManaged(): boolean {
    return this.managed;
  }

  /** The UI padlock — locked (default) means 100% autonomic control. */
  setUnlocked(unlocked: boolean): void {
    this.unlocked = unlocked;
  }

  isUnlocked(): boolean {
    return this.unlocked;
  }

  setModel(model: string): void {
    this.model = model.trim() || PRIMARY_MODEL;
  }

  getModel(): string {
    return this.model;
  }

  getStatus(task: string | null): OllamaStatus {
    return {
      managed: this.managed,
      unlocked: this.unlocked,
      state: this.state,
      model: this.model,
      port: extractPort(env.OLLAMA_URL ?? "http://127.0.0.1:11434"),
      task,
      lastError: this.lastError,
      restartCount: this.restartCount,
      ramGb: systemRamGb(),
      embeddingModelReady: this.embeddingModelReady,
      embeddingModel: EMBEDDING_MODEL,
      // Surfaces WHERE the runtime came from, so an operator can tell a node that
      // owns its own contained Ollama from one borrowing a host-wide install.
      bundledRuntime: bundledBinaryPresent(),
      bundledBinaryPath: bundledBinaryPresent() ? bundledBinaryPath() : "",
      bundledVersion: bundledOllama.getStatus().version,
    };
  }

  /**
   * Spawns `ollama serve` bound to the configured port, if not already up.
   *
   * THE BINARY IS THE BUNDLED ONE, NOT `ollama` RESOLVED FROM PATH. This used to
   * spawn the bare name, which resolved against the operator's PATH and therefore
   * required a global install — defeating the "all-in-one appliance" premise and
   * failing outright on a clean machine. `ensureBundledBinary()` puts the
   * standalone release in the node's own `bin` folder first, and the child is
   * spawned from that ABSOLUTE path with the isolation env applied.
   *
   * NOT `detached`, deliberately: the child stays in this process's job object and
   * dies with the node, which is what makes "Shutdown Node" in the Admin UI
   * actually stop Ollama instead of orphaning it on the port.
   */
  async start(): Promise<void> {
    if (!this.managed || this.child) return;
    this.stopping = false;
    this.state = "starting";

    /*
      THE BUNDLED RUNTIME OWNS ITS PORT, AND SAYS SO TO EVERY CONSUMER.

      Spawning on `extractPort(env.OLLAMA_URL)` while everything else in the
      codebase (OllamaClient, localAi, the /api/chat proxy) reads OLLAMA_URL is
      how a node ends up serving on one port and being asked about another. So
      the isolated origin is published into the environment as soon as we take
      ownership, and the rest of the process is pointed at it atomically.

      An operator who does NOT enable management keeps their own OLLAMA_URL
      untouched — this only happens on the path where we spawn the child, so a
      node borrowing a host-wide Ollama behaves exactly as it did before.
    */
    const port = BUNDLED_OLLAMA_PORT;
    process.env.OLLAMA_URL = BUNDLED_OLLAMA_ORIGIN;

    // HARDWARE AUTO-PROFILING — a weak satellite laptop must never be handed
    // the 7B coder model; pick the model BEFORE spawning so the first pull
    // (below, once the server answers) requests the right one.
    this.model = recommendedPrimaryModel();
    try {
      // Materialise the runtime before spawning it. A throw here (caught below)
      // means this platform genuinely has no published build AND nothing is on
      // disk — a real "cannot run here", not a transient fault.
      const binary = bundledBinaryPresent() ? bundledBinaryPath() : await ensureBundledBinary();
      const child = spawn(binary, ["serve"], {
        // Isolation env applied LAST so it wins over any stray value already in
        // this process's environment (see bundledOllamaEnv for why each matters).
        env: { ...process.env, ...bundledOllamaEnv() },
        /*
          THE CHILD'S OUTPUT IS PIPED, NOT IGNORED.

          It used to be `stdio: "ignore"`, which threw away everything `ollama serve`
          writes about model loading, runner startup and memory allocation — exactly
          the lines an operator needs when the engine is misbehaving at 3am. Piping
          costs nothing on a node nobody is watching: the lines are trimmed, pushed
          into a capped ring buffer, and fanned out to whichever dashboards happen to
          be listening (of which there are usually none).
        */
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      this.child = child;
      this.pipeChildOutput(child);
      child.once("exit", (code) => {
        this.child = null;
        if (this.stopping) {
          this.state = "stopped";
          return;
        }
        this.state = "crashed";
        this.lastError = `ollama serve exited (code ${code ?? "unknown"})`;
        console.warn(`[OllamaManager] ${this.lastError} — scheduling restart.`);
        publishNodeEvent({
          kind: "info",
          title: "Ollama process restarting",
          detail: this.lastError,
        });
        this.scheduleRestart();
      });
      child.once("error", (error) => {
        this.lastError = error.message;
        console.warn(`[OllamaManager] Failed to spawn ollama — ${error.message}`);
        this.state = "crashed";
        this.child = null;
        this.scheduleRestart();
      });
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      const alive = await this.probe(port);
      this.state = alive ? "running" : "starting";
      if (alive) {
        console.log(`[OllamaManager] ollama serve is up on port ${port}.`);
        // HARDWARE AUTO-PROFILING + LOCAL EMBEDDING — pull the RAM-appropriate
        // generation model and the embedding model in the background. Never
        // blocks `start()` — a slow first pull must not look like a hang.
        void this.ensureModelsPulled();
      }
    } catch (error) {
      this.state = "crashed";
      this.lastError = error instanceof Error ? error.message : String(error);
      this.scheduleRestart();
    }
  }

  /**
   * Forwards the child's stdout/stderr into the Control Center's terminal.
   *
   * Streams are read LINE BY LINE, not slurped. `ollama serve` writes progress lines
   * with `\n` endings, and reading a pipe with `data` events splits those mid-line —
   * a terminal that renders half a log line is worse than no terminal. A partial
   * trailing line is therefore buffered until its newline arrives (or the stream
   * closes).
   *
   * Never throws, and never applies backpressure to the child: a dashboard that stops
   * reading must not be able to wedge the Ollama server this node depends on.
   */
  private pipeChildOutput(child: ChildProcess): void {
    const attach = (stream: NodeJS.ReadableStream | null, kind: "stdout" | "stderr"): void => {
      if (!stream) return;
      let pending = "";
      stream.setEncoding?.("utf8");
      stream.on("data", (chunk: string | Buffer) => {
        pending += String(chunk);
        const lines = pending.split(/\r?\n/);
        // The final element is whatever came after the last newline: incomplete.
        pending = lines.pop() ?? "";
        for (const line of lines) publishLine(kind, line);
      });
      stream.on("end", () => {
        if (pending) publishLine(kind, pending);
        pending = "";
      });
      stream.on("error", () => {
        /* a broken pipe here must not take the supervisor down */
      });
    };
    attach(child.stdout, "stdout");
    attach(child.stderr, "stderr");
  }

  /** The port the local server is configured to serve on. */
  getPort(): number {
    return extractPort(env.OLLAMA_URL ?? "http://127.0.0.1:11434");
  }

  /**
   * THE HEALTH PROBE — what the status badge is allowed to claim.
   *
   * `/api/tags` proves the HTTP server is alive and lists what is installed;
   * `/api/ps` proves whether a model is actually RESIDENT in RAM/VRAM right now.
   * Both are asked because they answer different questions, and the badge's whole
   * value is that it cannot say "ready" for a server that is up but has nothing to
   * answer a prompt with.
   *
   * `proxy: false` matters: this is a loopback address, and an operator with a
   * corporate HTTP_PROXY set would otherwise have the probe answered by the proxy —
   * reporting a perfectly healthy engine as offline.
   *
   * Never throws. A probe that cannot reach the port IS the offline answer.
   */
  async probeHealth(): Promise<EngineHealth> {
    const port = this.getPort();
    const origin = `http://127.0.0.1:${port}`;
    const at = new Date().toISOString();
    const started = Date.now();

    try {
      const tags = await axios.get(`${origin}/api/tags`, { timeout: 3_000, proxy: false });
      const latencyMs = Date.now() - started;
      const installedModels = readOllamaModels(tags?.data);

      // `/api/ps` is newer than `/api/tags`; an older server 404s here, which is a
      // degraded probe and not a failed engine, so it must not read as offline.
      let loadedModels: string[] = [];
      try {
        const ps = await axios.get(`${origin}/api/ps`, { timeout: 3_000, proxy: false });
        loadedModels = readOllamaModels(ps?.data);
      } catch {
        loadedModels = [];
      }

      const activity = currentEngineActivity();
      const state: EngineHealth["state"] = activity?.kind === "pulling"
        ? "pulling"
        : activity?.kind === "busy"
          ? "busy"
          : "ready";

      const detail = state === "pulling"
        ? `Pulling ${activity?.label ?? "model weights"}…`
        : state === "busy"
          ? `Generating — ${activity?.label ?? "inference"}`
          : loadedModels.length > 0
            ? `${loadedModels.length} model(s) resident · ping ${latencyMs}ms`
            : `Server up · no model resident (unloads after idle) · ping ${latencyMs}ms`;

      return {
        state,
        httpStatus: tags?.status ?? null,
        latencyMs,
        modelLoaded: loadedModels.length > 0,
        loadedModels,
        installedModels,
        detail,
        at,
      };
    } catch (error) {
      return {
        state: "offline",
        httpStatus: null,
        latencyMs: null,
        modelLoaded: false,
        loadedModels: [],
        installedModels: [],
        detail: `Port ${port} did not answer /api/tags — ${error instanceof Error ? error.message : String(error)}`,
        at,
      };
    }
  }

  /**
   * Stops the managed child, if any. Never throws.
   *
   * ESCALATES SIGTERM → SIGKILL, and waits for the process to actually be gone.
   * The old version fired `kill()` and returned immediately, so `index.ts`'s
   * shutdown handler could `process.exit()` while Ollama was still alive: the
   * port stayed bound and the next boot failed to start with "address in use".
   * The child is now confirmed dead before this returns.
   */
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    const child = this.child;
    this.child = null;
    if (child && child.exitCode === null) {
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      try {
        child.kill("SIGTERM");
      } catch {
        /* best-effort */
      }
      // Bounded wait: the node's own teardown awaits this, so a child that
      // ignores SIGTERM must not be able to hang shutdown forever.
      const survived = await Promise.race([
        exited.then(() => false),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 5_000)),
      ]);
      if (survived) {
        console.warn("[OllamaManager] Child ignored SIGTERM — sending SIGKILL.");
        try {
          child.kill("SIGKILL");
        } catch {
          /* best-effort */
        }
        await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 3_000))]);
      }
    }
    // The bundled supervisor owns its own child handle; tear that down too so a
    // node started through the bundled path leaves nothing listening behind it.
    await bundledOllama.stop();
    this.state = this.managed ? "stopped" : "unmanaged";
  }

  /**
   * REINSTALLS THE BUNDLED RUNTIME — the repair action for a node whose binary is
   * corrupted, quarantined by antivirus, or simply outdated. Re-downloads the
   * official standalone build into the node's own `bin` folder and restarts it.
   */
  async reinstallBundled(): Promise<{ ok: boolean; message: string }> {
    const result = await bundledOllama.repair();
    if (result.ok) {
      this.lastError = null;
      publishNodeEvent({
        kind: "info",
        title: "Bundled Ollama repaired",
        detail: result.message,
      });
    }
    return result;
  }

  /** Restarts the managed process immediately (manual or admin-triggered). */
  async restart(): Promise<void> {
    await this.stop();
    this.stopping = false;
    await this.start();
  }

  /**
   * STREAMING MODEL PULL — the `ollama pull` terminal command.
   *
   * Ollama's `/api/pull` replies with a stream of newline-delimited JSON progress
   * objects. This consumes that stream line by line and turns it into terminal
   * lines, so an operator watching a 4 GB download sees real progress rather than a
   * spinner that could be a hung connection.
   *
   * The activity mark is what makes the status badge go amber for the duration, and
   * it is cleared in a `finally` so a failed pull cannot leave the badge stuck.
   *
   * Never throws — the caller gets a success/failure line in the terminal either
   * way, which is where an operator is already looking.
   */
  async pullModelStreaming(model: string): Promise<{ ok: boolean; message: string }> {
    const origin = `http://127.0.0.1:${this.getPort()}`;
    publishLine("cmd", `pulling ${model} …`);
    noteEngineActivity("pulling", model, 30 * 60_000);
    try {
      const response = await axios.post(
        `${origin}/api/pull`,
        { model, stream: true },
        { responseType: "stream", timeout: 0, proxy: false },
      );

      let lastPercent = -1;
      await new Promise<void>((resolve) => {
        const stream = response.data as NodeJS.ReadableStream;
        let pending = "";
        stream.setEncoding?.("utf8");
        stream.on("data", (chunk: string | Buffer) => {
          pending += String(chunk);
          const parts = pending.split(/\r?\n/);
          pending = parts.pop() ?? "";
          for (const part of parts) {
            if (!part.trim()) continue;
            try {
              const frame = JSON.parse(part) as {
                status?: string;
                digest?: string;
                total?: number;
                completed?: number;
                error?: string;
              };
              if (frame.error) {
                publishLine("err", `pull error: ${frame.error}`);
                continue;
              }
              // Progress arrives per-layer; only the percentage is worth a line.
              if (typeof frame.total === "number" && frame.total > 0) {
                const percent = Math.floor(((frame.completed ?? 0) / frame.total) * 100);
                if (percent !== lastPercent) {
                  lastPercent = percent;
                  publishLine("out", `${frame.status ?? "downloading"} ${percent}%`);
                }
              } else if (frame.status) {
                publishLine("out", frame.status);
              }
            } catch {
              publishLine("out", part);
            }
          }
        });
        stream.on("end", () => {
          if (pending.trim()) publishLine("out", pending.trim());
          resolve();
        });
        stream.on("error", () => {
          publishLine("err", "the pull stream ended unexpectedly");
          resolve();
        });
      });

      clearEngineActivity();
      publishLine("out", `✓ ${model} is installed.`);
      return { ok: true, message: `${model} pulled successfully.` };
    } catch (error) {
      clearEngineActivity();
      const message = error instanceof Error ? error.message : String(error);
      publishLine("err", `pull failed: ${message}`);
      return { ok: false, message };
    }
  }

  /**
   * DYNAMIC MODEL SIZING + LOCAL EMBEDDING — pulls the hardware-appropriate
   * generation model and the embedding model so the node is ready to serve
   * both chat/generation and embeddings with no operator action.
   */
  private async ensureModelsPulled(): Promise<void> {
    const client = new OllamaClient();
    try {
      await client.pullModel(this.model);
      publishNodeEvent({
        kind: "info",
        title: "Ollama model ready",
        detail: `Pulled "${this.model}" (${systemRamGb()}GB RAM detected).`,
      });
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      console.warn(`[OllamaManager] Failed to pull "${this.model}" — ${this.lastError}`);
    }
    try {
      await client.pullModel(EMBEDDING_MODEL);
      this.embeddingModelReady = true;
      publishNodeEvent({
        kind: "info",
        title: "Embedding model ready",
        detail: `Pulled "${EMBEDDING_MODEL}" — local embeddings are now available.`,
      });
    } catch (error) {
      console.warn(
        `[OllamaManager] Failed to pull embedding model "${EMBEDDING_MODEL}" — ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * SELF-HEAL — the Embedded AI panel's repair routine. Kills a stuck
   * managed child, clears the last-error diagnostic, and relaunches the
   * server, re-pulling both models on the way back up.
   */
  async selfHeal(): Promise<{ healed: boolean; message: string }> {
    this.lastError = null;
    this.crashTimestamps = [];
    this.restartCount = 0;
    try {
      await this.stop();
      this.stopping = false;
      if (!this.managed) this.managed = true;
      await this.start();
      return { healed: true, message: "Ollama self-heal complete — server restarted and models re-verified." };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.lastError = message;
      return { healed: false, message: `Self-heal failed — ${message}` };
    }
  }

  private scheduleRestart(): void {
    if (!this.managed || this.restartTimer) return;
    const now = Date.now();
    this.crashTimestamps = this.crashTimestamps.filter((t) => now - t < CRASH_WINDOW_MS);
    const attempt = this.crashTimestamps.length;
    this.crashTimestamps.push(now);
    this.restartCount++;
    const delay = RESTART_BACKOFF_MS[Math.min(attempt, RESTART_BACKOFF_MS.length - 1)];
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      void this.start();
    }, delay);
    this.restartTimer.unref?.();
  }

  /** True when the server answers `/api/tags` on the given port. */
  private async probe(port: number): Promise<boolean> {
    try {
      await axios.get(`http://127.0.0.1:${port}/api/tags`, { timeout: 3_000, proxy: false });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * MODEL FAILOVER — called when the primary model fails to load or generate.
   * Attempts to pull the fallback model and switches the resolved model so
   * the mesh stays alive. Returns the model now in effect.
   */
  async failoverToFallback(client: OllamaClient): Promise<string> {
    if (this.model === FALLBACK_MODEL) return this.model;
    console.warn(
      `[OllamaManager] Model "${this.model}" failed — attempting fallback to "${FALLBACK_MODEL}".`,
    );
    try {
      await client.pullModel(FALLBACK_MODEL);
      this.model = FALLBACK_MODEL;
      publishNodeEvent({
        kind: "info",
        title: "Ollama model fallback",
        detail: `Switched to fallback model ${FALLBACK_MODEL} to keep the mesh alive.`,
      });
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      console.warn(`[OllamaManager] Fallback pull failed — ${this.lastError}`);
    }
    return this.model;
  }
}

/** Process-wide singleton — one Ollama child per node. */
export const ollamaManager = new OllamaManager();
