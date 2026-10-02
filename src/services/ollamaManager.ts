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

/**
 * OLLAMA PROCESS MANAGER — supervises a locally-spawned `ollama serve` child.
 *
 * SCOPE AND INTENT. This module manages the LIFECYCLE of an Ollama process
 * this node already has installed; it never downloads or executes an Ollama
 * binary it fetched itself. That is a deliberate boundary — auto-downloading
 * and running third-party executables is a different, higher-risk feature
 * that needs its own explicit sign-off (see OtaUpdater/SwarmUpdater for the
 * existing, carefully-gated self-update path this project already has).
 *
 * RESPONSIBILITIES:
 *   1. OPT-IN SUPERVISION — only takes over the process when the operator
 *      enables it (RIPPA_OLLAMA_MANAGED=true, or via the Control Panel). A
 *      node pointed at an Ollama instance it did not start is left alone.
 *   2. AUTO-RESTART — a crashed child is relaunched with backoff.
 *   3. MODEL FALLBACK — pulls/switches to FALLBACK_MODEL when the primary
 *      model fails, so the mesh keeps a locally-capable node.
 *   4. STATUS — a small snapshot consumed by heartbeat telemetry and the
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
    };
  }

  /** Spawns `ollama serve` bound to the configured port, if not already up. */
  async start(): Promise<void> {
    if (!this.managed || this.child) return;
    this.stopping = false;
    this.state = "starting";
    const port = extractPort(env.OLLAMA_URL ?? "http://127.0.0.1:11434");
    // HARDWARE AUTO-PROFILING — a weak satellite laptop must never be handed
    // the 7B coder model; pick the model BEFORE spawning so the first pull
    // (below, once the server answers) requests the right one.
    this.model = recommendedPrimaryModel();
    try {
      const child = spawn("ollama", ["serve"], {
        env: { ...process.env, OLLAMA_HOST: `127.0.0.1:${port}` },
        stdio: "ignore",
        windowsHide: true,
      });
      this.child = child;
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

  /** Stops the managed child, if any. Never throws. */
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (this.child) {
      try {
        this.child.kill();
      } catch {
        /* best-effort */
      }
      this.child = null;
    }
    this.state = this.managed ? "stopped" : "unmanaged";
  }

  /** Restarts the managed process immediately (manual or admin-triggered). */
  async restart(): Promise<void> {
    await this.stop();
    this.stopping = false;
    await this.start();
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
