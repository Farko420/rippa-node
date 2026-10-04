import { spawn, type ChildProcess } from "node:child_process";
import axios from "axios";
import { env, reloadEnv } from "../config";
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
  bundledBinaryPath,
  bundledBinaryPresent,
  bundledOllamaOrigin,
  bundledRuntimeComplete,
  bundledOllamaEnv,
  bundledOllama,
  ensureBundledBinary,
  resolveBundledOllamaPort,
  sweepOrphanedOllama,
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

/**
 * EMBEDDING MODEL PULL — the bounds on a download nobody is watching.
 *
 * The tile used to sit on "pulling…" forever when `/api/pull` hung or died
 * silently, so every path through `pullEmbeddingModel()` is now bounded: the
 * fetch is aborted after EMBEDDING_PULL_TIMEOUT_MS, and the reconciler keeps
 * asking `/api/tags` whether the model actually landed in the meantime.
 */
/** Hard ceiling on one embedding-model pull before its AbortController fires. */
const EMBEDDING_PULL_TIMEOUT_MS = 10 * 60_000;
/** `/api/tags` reconcile cadence while a pull is actively streaming. */
const EMBEDDING_RECONCILE_FAST_MS = 15_000;
/** Reconcile cadence while idle or after a failed pull — it keeps looking. */
const EMBEDDING_RECONCILE_SLOW_MS = 60_000;

/**
 * GENERATION MODEL PULL — the same bounded, streaming discipline as the embedding
 * pull, sized for the fact that this download is tens of times larger.
 *
 * WHY IT IS SEPARATE FROM `EMBEDDING_PULL_TIMEOUT_MS` AND NOT REUSED. The
 * embedding model is ~100 MB; the generation model the auto-profiler selects is
 * ~4.6 GB (Ollama's own log line: `downloading ... in 16 292 MB part(s)`). Giving
 * both the same 10-minute budget is what produced the reported symptom: a pull
 * that was demonstrably progressing was killed and reported as a failure. So this
 * ceiling is sized for a large transfer on a slow link, and — more importantly —
 * the pull that uses it is ASYNCHRONOUS and streaming, so an operator watching
 * the dashboard sees "Downloading Model…" rather than a request that appears to
 * hang and then errors.
 */
const MODEL_PULL_TIMEOUT_MS = 120 * 60_000;
/** Reconcile cadence while the generation pull is actively streaming. */
const MODEL_RECONCILE_FAST_MS = 20_000;

export type OllamaRunState = "stopped" | "starting" | "running" | "crashed" | "unmanaged";

/**
 * WHAT THE EMBEDDING MODEL TILE IS ALLOWED TO SAY.
 *
 * `pulling` while the NDJSON stream downloads, `ready` once `/api/tags` (or the
 * stream's own success frame) confirms the model is installed, `failed` after a
 * timeout or error — with `idle` covering the moment before the first attempt.
 * The point of the union is that "pulling…" is now a *claim with an end*: a pull
 * that times out or dies transitions to `failed (click to retry)` instead of
 * leaving a badge frozen on a state the work no longer holds.
 */
export type EmbeddingModelStatus = "idle" | "pulling" | "ready" | "failed";

/**
 * WHAT THE GENERATION MODEL TILE IS ALLOWED TO SAY.
 *
 * The same union as the embedding tile, for the same reason: `pulling` is a claim
 * with an end. Without it, a ~4.6 GB download has no representation on the status
 * endpoint at all, so the only thing the dashboard could do was show an error when
 * the request eventually timed out — the exact failure this state machine exists
 * to make honest.
 */
export type ModelStatus = "idle" | "pulling" | "ready" | "failed";

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
  /** True once the embedding model is installed on this node. */
  embeddingModelReady: boolean;
  /** Machine state behind the Embedding Model tile — see {@link EmbeddingModelStatus}. */
  embeddingModelStatus: EmbeddingModelStatus;
  /** Why the last embedding pull failed; null unless the status is `failed`. */
  embeddingModelError: string | null;
  /** Name of the embedding model this node auto-pulls. */
  embeddingModel: string;
  /** True when the runtime binary lives in the node's own directory. */
  bundledRuntime: boolean;
  /** Absolute path of the bundled runtime binary, or "" when none is installed. */
  bundledBinaryPath: string;
  /**
   * True only when the bundled runtime is COMPLETE - both `ollama.exe` and
   * `lib/ollama/llama-server[.exe]` are present.
   *
   * `bundledRuntime` stays true for a half-install, and the difference matters:
   * a supervisor with no llama-server beside it boots, binds the port and answers
   * `/api/tags`, then fails every single inference. A panel that only showed
   * "binary present" would call that state healthy.
   */
  bundledRuntimeComplete: boolean;
  /** Release tag of the installed bundled runtime, or "". */
  bundledVersion: string;
  /** True once the GENERATION model is installed on this node. */
  modelReady: boolean;
  /**
   * Machine state behind the generation-model tile — see {@link ModelStatus}.
   *
   * `pulling` is what the dashboard renders as "Downloading Model…". It is the
   * difference between an operator watching a 4.6 GB transfer proceed and an
   * operator staring at a spinner that will eventually become an error.
   */
  modelStatus: ModelStatus;
  /** Why the last generation pull failed; null unless the status is `failed`. */
  modelError: string | null;
  /** 0-100 while a generation pull is streaming; null when no pull is running. */
  modelPullPercent: number | null;
  /** Bytes transferred so far on the current pull, as Ollama reports it. */
  modelPullCompleted: number | null;
  /** Total bytes for the current pull, as Ollama reports it. */
  modelPullTotal: number | null;
  /**
   * True while a repair (self-heal) is running in the BACKGROUND.
   *
   * Self-heal used to be awaited by its HTTP route, which meant the request stayed
   * open across a server restart AND a multi-gigabyte model download. The route now
   * returns `202 Accepted` immediately and the operator polls this flag, so the
   * button can show progress instead of the browser sitting on a dead socket.
   */
  repairing: boolean;
  /** Last repair outcome message, shown by the dashboard after a 202. */
  repairMessage: string | null;
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

/**
 * True when an installed-model list contains `target`, tolerating the `:latest`
 * suffix Ollama adds by default: target "nomic-embed-text" matches the installed
 * "nomic-embed-text:latest", and vice versa. Same rule as OllamaClient's
 * `matchesModel`, duplicated only because that copy is module-private.
 */
function installedModelMatches(installed: string[], target: string): boolean {
  const bare = target.split(":")[0];
  return installed.some((name) => name === target || name.split(":")[0] === bare);
}

/**
 * TRUE FOR LOG LINES THAT ARE ABOUT REACHING OLLAMA.COM RATHER THAN ABOUT THIS
 * NODE'S HEALTH.
 *
 * Recent Ollama builds probe `ollama.com` to hydrate a cloud model cache. On a
 * satellite behind a firewall that probe times out and the server logs
 * `model show cloud cache hydration failed`. `bundledOllamaEnv()` sets
 * `OLLAMA_NO_CLOUD=1` so a current build never makes the request, but an already
 * running child (or a build that predates the flag) still emits it, and an
 * operator reading it reasonably concludes the node is broken when the engine is
 * in fact serving.
 *
 * WHY IT IS SAFE TO DROP. Local reachability is established authoritatively by
 * `/api/tags` returning 200 — that is the entire basis of {@link probeHealth} and
 * of the status dot. A failed attempt to warm a REMOTE cache says nothing about
 * whether the local server is answering, so dropping the line cannot hide a real
 * fault. It is deliberately narrow: anything mentioning a pull, a load, an OOM or
 * a bind failure still reaches the terminal.
 *
 * EXPORTED FOR THE SAME REASON AS `publishManagedOllamaOrigin`: a filter that is
 * only reachable by spawning a real Ollama child cannot be regression-tested, and
 * a suppression filter that silently stops matching would put the noise back
 * without anything noticing.
 */
export function isExternalNetworkNoise(line: string): boolean {
  return /\bcloud cache hydration\b|\bmodel show cloud\b|cloud model cache/i.test(line);
}

/** One newline-delimited JSON progress frame from `POST /api/pull`. */
interface PullFrame {
  status?: string;
  total?: number;
  completed?: number;
  error?: string;
}

/**
 * PUBLISHES THE MANAGED ORIGIN TO EVERY OTHER MODULE IN THIS PROCESS.
 *
 * WHY THIS IS A FUNCTION AND NOT AN INLINE ASSIGNMENT. The obvious fix at the
 * call site is `process.env.OLLAMA_URL = origin`, and that is the bug that made
 * the engine look dead on a node that was serving perfectly. `env` in
 * `src/config.ts` is NOT a view of `process.env` — it is a plain object zod
 * produced once at module load and exported as a const. Every importer holds
 * that same object reference, so mutating `process.env` afterwards is invisible
 * to all of them.
 *
 * `reloadEnv()` is what makes the write take effect: it re-reads `process.env`
 * INTO that exported object, in place, so the ~8 modules that do `env.OLLAMA_URL`
 * at call time start resolving the managed port without a process restart. That
 * in-place mutation is also why the value must be read as `env.X` rather than
 * destructured at module scope by importers — a destructured copy is a snapshot
 * and would keep the stale port forever.
 *
 * WHY IT IS SAFE TO CALL REPEATEDLY. `start()` runs again on every managed
 * restart, so this must be idempotent: it is a no-op once the managed origin is
 * already published, and it never resets an operator's own `OLLAMA_URL` on a node
 * that never enabled supervision (this only ever runs on the managed path).
 *
 * WHY THE ORIGIN COMES FROM `bundledOllamaOrigin()`. That helper resolves the
 * SAME port the child is about to be bound to, so the port we advertise cannot
 * drift from the port we bind. The bare `BUNDLED_OLLAMA_PORT`/`BUNDLED_OLLAMA_ORIGIN`
 * constants are deliberately NOT used here: they are the un-overridden defaults
 * and would ignore `RIPPA_BUNDLED_OLLAMA_PORT`, reintroducing the exact
 * "binds one port, is asked about another" split this resolver exists to prevent.
 * `port` is the already-resolved value from the call site and is asserted against
 * the origin rather than re-derived, so a divergence is logged instead of hidden.
 * EXPORTED, NOT MERELY `function`. The whole point of this function is a
 * property of MODULE-LOAD-TIME state — that writing `process.env` and calling
 * `reloadEnv()` reaches the long-lived `env` object — and no amount of testing
 * the spawn path proves it, because the spawn path downloads a multi-hundred-MB
 * runtime and would take `start()` minutes on a CI runner. Exporting it lets a
 * test drive the publish directly and assert the invariant in milliseconds.
 */
export function publishManagedOllamaOrigin(port: number): void {
  const origin = bundledOllamaOrigin();

  // Cheap drift guard. `origin` is machine-built and always well-formed, so
  // extractPort cannot realistically fail here — the check exists to catch a
  // future edit to the resolver, not to handle bad input.
  const originPort = extractPort(origin);
  if (originPort !== port) {
    console.warn(
      `[OllamaManager] Managed origin ${origin} does not match resolved port ${port} — ` +
        `publishing the origin, which is what the child will bind.`,
    );
  }

  // Read through `env` (the live object), not a bare process.env peek, so an
  // already-published value is detected even if something else wrote it.
  if (env.OLLAMA_URL === origin) {
    return;
  }

  const previous = env.OLLAMA_URL;
  process.env.OLLAMA_URL = origin;
  // The load-bearing half. Without this the write above is decoration.
  reloadEnv();

  console.log(`[OllamaManager] Managed Ollama origin published: ${previous} → ${origin}.`);
  publishNodeEvent({
    kind: "info",
    title: "Ollama origin updated",
    detail: `Local engine is now served at ${origin}.`,
  });
}

class OllamaManager {
  private child: ChildProcess | null = null;
  private managed = false;
  private unlocked = false;
  private state: OllamaRunState = "unmanaged";
  private model = PRIMARY_MODEL;
  private lastError: string | null = null;
  private restartCount = 0;
  /** Embedding tile state machine — see {@link EmbeddingModelStatus}. */
  private embeddingStatus: EmbeddingModelStatus = "idle";
  /** Populated only on failure; shown as the retry tile's tooltip. */
  private embeddingError: string | null = null;
  /** True while `pullEmbeddingModel()` is running — guards a second pull. */
  private embeddingPulling = false;
  /** Pending `/api/tags` reconcile timer; null when none is scheduled. */
  private embeddingReconcileTimer: NodeJS.Timeout | null = null;
  /** Generation-model tile state machine — see {@link ModelStatus}. */
  private modelStatus: ModelStatus = "idle";
  /** Populated only on failure; shown as the retry tile's tooltip. */
  private modelError: string | null = null;
  /** Live progress of the in-flight generation pull, as Ollama reports it. */
  private modelPullPercent: number | null = null;
  private modelPullCompleted: number | null = null;
  private modelPullTotal: number | null = null;
  /** True while `pullGenerationModel()` is running — guards a second pull. */
  private modelPulling = false;
  /** Pending reconcile timer for the generation model. */
  private modelReconcileTimer: NodeJS.Timeout | null = null;
  /** True while a self-heal runs in the background; surfaced on the status route. */
  private repairing = false;
  /** Outcome of the last repair, so a 202'd request has something to report. */
  private repairMessage: string | null = null;
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
    const next = model.trim() || PRIMARY_MODEL;
    if (next === this.model) return;
    this.model = next;
    // A DIFFERENT MODEL IS A DIFFERENT DOWNLOAD. Carrying the old model's `ready`
    // forward would tell the dashboard the new model is installed when it is not,
    // so the tile resets to `idle` and the reconcile chain re-arms to find out.
    this.modelStatus = "idle";
    this.modelError = null;
    this.modelPullPercent = null;
    this.modelPullCompleted = null;
    this.modelPullTotal = null;
    this.stopModelReconcile();
    this.scheduleModelReconcile(0);
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
      embeddingModelReady: this.embeddingStatus === "ready",
      embeddingModelStatus: this.embeddingStatus,
      embeddingModelError: this.embeddingError,
      embeddingModel: EMBEDDING_MODEL,
      // Surfaces WHERE the runtime came from, so an operator can tell a node that
      // owns its own contained Ollama from one borrowing a host-wide install.
      bundledRuntime: bundledBinaryPresent(),
      bundledBinaryPath: bundledBinaryPresent() ? bundledBinaryPath() : "",
      // Deliberately reported alongside `bundledRuntime`: they disagree exactly
      // when the install is broken, which is the case worth surfacing.
      bundledRuntimeComplete: bundledRuntimeComplete(),
      bundledVersion: bundledOllama.getStatus().version,
      modelReady: this.modelStatus === "ready",
      modelStatus: this.modelStatus,
      modelError: this.modelError,
      modelPullPercent: this.modelPullPercent,
      modelPullCompleted: this.modelPullCompleted,
      modelPullTotal: this.modelPullTotal,
      repairing: this.repairing,
      repairMessage: this.repairMessage,
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
      codebase (OllamaClient, localAi, the /v1/chat proxy) reads OLLAMA_URL is
      how a node ends up serving on one port and being asked about another. So
      the isolated origin is published into the environment as soon as we take
      ownership, and the rest of the process is pointed at it atomically.

      An operator who does NOT enable management keeps their own OLLAMA_URL
      untouched — this only happens on the path where we spawn the child, so a
      node borrowing a host-wide Ollama behaves exactly as it did before.

      *** THE `reloadEnv()` CALL IS THE ACTUAL FIX, AND IT WAS MISSING. ***

      `env` is not a view of `process.env` — it is a plain object produced once
      by zod at module load (`src/config.ts`). Assigning `process.env.OLLAMA_URL`
      therefore changed NOTHING for the ~8 modules that import `env`. They kept
      reading the stale `http://127.0.0.1:11434` while the child bound 11435,
      which produced, all at once:

        - `getPort()`/`getStatus().port` reporting 11434 to the Mothership, so
          the fleet was told to call a port nothing was listening on;
        - `probeHealth()` probing 11434 and reporting the engine OFFLINE while
          it was healthy and holding models in VRAM;
        - `/v1/chat/completions` and `/v1/embeddings` 502-ing on every request;
        - `localAi` and the Orchestrator's `OllamaClient` aimed at a dead port.

      `reloadEnv()` re-reads `process.env` into that object. Without it the
      publish below was decoration.
    */
    const port = resolveBundledOllamaPort();
    publishManagedOllamaOrigin(port);

    /*
      CLEAR ANY ORPHAN BEFORE SPAWNING. A previous run that did not get to
      `stop()` (power cut, Task Manager, OTA swap) leaves `ollama serve` alive
      and holding this exact port; the new child then cannot bind, exits, and
      walks straight into the crash-restart ladder. The sweep verifies each
      holder really is an Ollama binary before signalling it, and never touches
      11434 — see `sweepOrphanedOllama` for why that distinction is deliberate.
    */
    try {
      const sweep = await sweepOrphanedOllama(port);
      for (const note of sweep.notes) console.log(`[OllamaManager] ${note}`);
      if (sweep.killed.length > 0) {
        console.log(
          `[OllamaManager] Cleared ${sweep.killed.length} orphaned Ollama process(es) from port ${port}.`,
        );
      }
    } catch (error) {
      // Never let a sweep failure block the spawn — the attempt below is the
      // real test of whether the port is usable.
      console.warn(
        `[OllamaManager] Orphan sweep could not complete — ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    // HARDWARE AUTO-PROFILING — a weak satellite laptop must never be handed
    // the 7B coder model; pick the model BEFORE spawning so the first pull
    // (below, once the server answers) requests the right one.
    this.model = recommendedPrimaryModel();
    try {
      // Materialise the runtime before spawning it. A throw here (caught below)
      // means this platform genuinely has no published build AND nothing is on
      // disk — a real "cannot run here", not a transient fault.
      //
      // THE CONDITION IS `bundledRuntimeComplete()`, NOT `bundledBinaryPresent()`.
      // Checking only for `ollama.exe` is what produced the reported failure: a
      // folder holding the supervisor but no `lib/ollama/llama-server.exe` was
      // treated as ready, so nothing was ever downloaded, the server started, and
      // every extraction then failed with "llama-server binary not found". The
      // cheap path now requires the whole runtime tree; `ensureBundledBinary()`
      // is the fallback that notices a half-install and rebuilds it.
      const binary = bundledRuntimeComplete() ? bundledBinaryPath() : await ensureBundledBinary();
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
   * EXTERNAL-NETWORK NOISE IS DROPPED. `OLLAMA_NO_CLOUD=1` stops a current Ollama
   * from probing ollama.com at all, but the suppression is belt-and-braces because
   * the log line is alarming out of all proportion to what it means: an operator
   * reading `model show cloud cache hydration failed` reasonably concludes their
   * node is broken. `/api/tags` answering 200 is the authoritative health signal
   * (see {@link probeHealth}); a failed attempt to reach a cloud cache is not a
   * local fault and must not be presented as one.
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
        for (const line of lines) {
          if (!isExternalNetworkNoise(line)) publishLine(kind, line);
        }
      });
      stream.on("end", () => {
        if (pending && !isExternalNetworkNoise(pending)) publishLine(kind, pending);
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

      /*
        FREE RECONCILIATION. This probe already asked `/api/tags`, so a model
        installed by ANY path — the background pull finishing, a manual
        `ollama pull`, a restored backup — flips the Embedding Model tile to
        `ready` on the next health ping without issuing a second request. This
        is also the only reconcile an UNMANAGED node gets (it never runs
        `ensureModelsPulled`), which is exactly why it lives here. The generation
        tile reconciles the same way from the same response body.
      */
      this.absorbEmbeddingInstalled(installedModels);
      this.absorbModelInstalled(installedModels);

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
        ? `Pulling ${activity?.label ?? "model weights"}…${
            this.modelStatus === "pulling" && this.modelPullPercent !== null
              ? ` ${this.modelPullPercent}%`
              : ""
          }`
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
    // The reconcile chain has no reason to keep polling a server this method is
    // about to take down; `start()` re-arms it when the child comes back.
    this.stopEmbeddingReconcile();
    this.stopModelReconcile();
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
      /*
        THE STREAM'S OWN ERRORS ARE COLLECTED, NOT SWALLOWED. This used to
        `resolve()` on `stream.on("error")` and then fall through to
        `return { ok: true, message: "pulled successfully" }` — so a pull whose
        connection died was announced to the operator as installed. That is the
        exact confident-wrong-answer failure this module exists to avoid, and
        making the command fire-and-forget made it worse: the HTTP response no
        longer carries the outcome, so the terminal line IS the report.
      */
      let streamError: string | null = null;
      let reportedError: string | null = null;
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
                reportedError = frame.error;
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
        stream.on("error", (error) => {
          streamError = error instanceof Error ? error.message : String(error);
          publishLine("err", "the pull stream ended unexpectedly");
          resolve();
        });
      });

      // An error reported INSIDE a 200 stream beats the fact that we reached the
      // end, and a dead socket beats both.
      const failure = streamError ?? reportedError;
      if (failure) {
        publishLine("err", `pull failed: ${failure}`);
        return { ok: false, message: failure };
      }

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
   * THE EMBEDDING MODEL PROVISIONER — `POST /api/pull` with a real stream.
   *
   * WHY A STREAM AND NOT `stream: false`. The old background path handed the
   * pull to `OllamaClient.pullModel()` and only learned the outcome at the very
   * end, so a hung or silently-failed download left the dashboard tile on
   * "pulling…" with nothing in the terminal to explain it. This reads Ollama's
   * NDJSON progress frames (`status` / `completed` / `total`) and pushes every
   * percentage into the Live Engine Terminal as it happens, so a stalled
   * download looks different from a slow one at a glance.
   *
   * THE THREE GUARANTEES THE OLD PATH LACKED:
   *   1. BOUNDED — an AbortController kills the fetch after
   *      EMBEDDING_PULL_TIMEOUT_MS, and the timeout is flagged so the failure
   *      line says "timed out after 10 minutes" rather than a bare abort.
   *   2. HONEST — success, timeout and error all end in a status transition
   *      (`ready` or `failed (click to retry)`), never a badge left spinning.
   *   3. SELF-RECONCILING — `/api/tags` is checked before, during (on the
   *      reconcile chain) and after the pull. The tag list is the source of
   *      truth: a model that landed by any path wins over what the stream
   *      claims, including on the failure path (a timeout that fires a beat
   *      after the download actually finished still reads `ready`).
   *
   * Never throws — failures are reported through the returned message, the
   * terminal and the status field, because every caller runs this
   * fire-and-forget on an idle node that must not be able to crash.
   */
  async pullEmbeddingModel(): Promise<{ ok: boolean; message: string }> {
    if (this.embeddingPulling) {
      return {
        ok: false,
        message: `already pulling ${EMBEDDING_MODEL} — watch the terminal for progress.`,
      };
    }
    // The tag list decides first: an installed model is an instant "ready"
    // with no download at all.
    if (await this.reconcileEmbedding()) {
      return { ok: true, message: `${EMBEDDING_MODEL} is already installed.` };
    }

    this.embeddingPulling = true;
    this.embeddingStatus = "pulling";
    this.embeddingError = null;
    publishLine("cmd", `pulling ${EMBEDDING_MODEL} …`);
    console.log(`[OllamaManager] Pulling embedding model "${EMBEDDING_MODEL}".`);
    noteEngineActivity("pulling", EMBEDDING_MODEL, EMBEDDING_PULL_TIMEOUT_MS);
    // Re-arm the reconcile chain at the fast cadence even if a slow (boot-time)
    // tick is already pending — a streaming pull deserves a 15s tag check.
    this.stopEmbeddingReconcile();
    this.scheduleEmbeddingReconcile(EMBEDDING_RECONCILE_FAST_MS);

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, EMBEDDING_PULL_TIMEOUT_MS);

    try {
      const origin = `http://127.0.0.1:${this.getPort()}`;
      const response = await fetch(`${origin}/api/pull`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // `stream: true` is what makes the NDJSON progress frames below exist.
        body: JSON.stringify({ model: EMBEDDING_MODEL, stream: true }),
        signal: controller.signal,
      });
      if (!response.ok || !response.body) {
        throw new Error(`HTTP ${response.status} from /api/pull`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let pending = "";
      let lastPercent = -1;
      let sawSuccess = false;

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        pending += decoder.decode(value, { stream: true });
        const parts = pending.split(/\r?\n/);
        // The final element is whatever came after the last newline: incomplete.
        pending = parts.pop() ?? "";
        for (const part of parts) {
          if (!part.trim()) continue;
          let frame: PullFrame;
          try {
            frame = JSON.parse(part) as PullFrame;
          } catch {
            continue; // not JSON — nothing actionable, and the stream must go on
          }
          if (frame.error) throw new Error(frame.error);
          if (frame.status === "success") sawSuccess = true;
          // Progress arrives per-layer; only a changed percentage is worth a
          // line, and each one re-arms the badge so a slow-but-moving download
          // never looks expired.
          if (typeof frame.total === "number" && frame.total > 0) {
            const percent = Math.floor(((frame.completed ?? 0) / frame.total) * 100);
            if (percent !== lastPercent) {
              lastPercent = percent;
              publishLine("out", `${frame.status ?? "downloading"} ${percent}%`);
              noteEngineActivity("pulling", EMBEDDING_MODEL, EMBEDDING_PULL_TIMEOUT_MS);
            }
          } else if (frame.status) {
            publishLine("out", frame.status);
          }
        }
      }
      /*
        THE STREAM ENDED. A stream that closed cleanly is not, by itself, proof
        the model is on disk — `/api/tags` is, and its tag lands a beat after
        the final frame, so give it a couple of seconds to agree before falling
        back to trusting the stream's own success frame.
      */
      if (!(await this.reconcileEmbedding())) {
        if (!sawSuccess) {
          throw new Error("the pull stream ended before the model appeared in /api/tags");
        }
        for (let attempt = 0; attempt < 4 && !this.isEmbeddingReady(); attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 500));
          await this.reconcileEmbedding();
        }
        if (!this.isEmbeddingReady()) {
          // The server said "success" and the tag list has not caught up —
          // trust the success frame; the reconcile chain keeps checking anyway.
          this.markEmbeddingReady("pull completed");
        }
      }
      return { ok: true, message: `${EMBEDDING_MODEL} pulled successfully.` };
    } catch (error) {
      // THE TIMEOUT MAY HAVE FIRED A MOMENT AFTER THE PULL ACTUALLY LANDED —
      // always ask the tag list before declaring failure.
      if (await this.reconcileEmbedding()) {
        return { ok: true, message: `${EMBEDDING_MODEL} is installed.` };
      }
      const message = timedOut
        ? `timed out after ${Math.round(EMBEDDING_PULL_TIMEOUT_MS / 60_000)} minutes`
        : error instanceof Error
          ? error.message
          : String(error);
      this.embeddingStatus = "failed";
      this.embeddingError = message;
      publishLine("err", `embedding model pull failed: ${message}`);
      console.warn(`[OllamaManager] Embedding model pull failed — ${message}`);
      publishNodeEvent({
        kind: "info",
        title: "Embedding model pull failed",
        detail: `${EMBEDDING_MODEL}: ${message}. Click the Embedding Model tile to retry.`,
      });
      // Keep reconciling after a failure — a later successful pull (manual, or
      // a retry the operator starts) still flips the tile to `ready` by itself.
      this.scheduleEmbeddingReconcile(EMBEDDING_RECONCILE_SLOW_MS);
      return { ok: false, message };
    } finally {
      clearTimeout(timer);
      this.embeddingPulling = false;
      clearEngineActivity();
    }
  }

  /**
   * ASKS `/api/tags` WHETHER THE EMBEDDING MODEL IS INSTALLED — AND BELIEVES IT.
   *
   * Every caller converges on this one answer (the pull's entry and exit, the
   * reconcile chain, the health probe, the retry route), so a model that landed
   * by ANY path flips the tile to `ready`. Never throws: an unreachable server
   * is simply "not found yet", because a probe failure during a pull's own
   * error handling must not mask the real error.
   */
  async reconcileEmbedding(): Promise<boolean> {
    if (this.embeddingStatus === "ready") return true;
    try {
      const origin = `http://127.0.0.1:${this.getPort()}`;
      const tags = await axios.get(`${origin}/api/tags`, { timeout: 3_000, proxy: false });
      if (!installedModelMatches(readOllamaModels(tags?.data), EMBEDDING_MODEL)) return false;
      this.markEmbeddingReady("found in /api/tags");
      return true;
    } catch {
      return false;
    }
  }

  /** Folds a tag list this module already holds into the tile state. */
  private absorbEmbeddingInstalled(installed: string[]): void {
    if (this.embeddingStatus === "ready") return;
    if (!installedModelMatches(installed, EMBEDDING_MODEL)) return;
    this.markEmbeddingReady("found in /api/tags");
  }

  /**
   * Read through a method rather than a direct field comparison inside
   * `pullEmbeddingModel`, so the compiler cannot narrow `embeddingStatus` to
   * its last-assigned literal across the awaits — `reconcileEmbedding()`
   * mutates it, and the whole point of those checks is to see that mutation.
   */
  private isEmbeddingReady(): boolean {
    return this.embeddingStatus === "ready";
  }

  /**
   * THE SINGLE TRANSITION INTO `ready` — every path reports through here, so
   * the terminal line, the console line and the overlay can never disagree
   * about how the model became ready.
   *
   * The overlay fires only when the operator was previously told `pulling` or
   * `failed`: a routine idle→ready at boot (model already installed) is not
   * news, and an overlay claiming "Pulled …" for a download that never ran
   * would be exactly the confident wrong answer this state machine exists to
   * prevent.
   */
  private markEmbeddingReady(source: string): void {
    const previous = this.embeddingStatus;
    if (previous === "ready") return;
    this.embeddingStatus = "ready";
    this.embeddingError = null;
    this.stopEmbeddingReconcile();
    publishLine("out", `✓ ${EMBEDDING_MODEL} is installed (${source}).`);
    console.log(`[OllamaManager] Embedding model "${EMBEDDING_MODEL}" ready — ${source}.`);
    if (previous === "pulling" || previous === "failed") {
      publishNodeEvent({
        kind: "info",
        title: "Embedding model ready",
        detail: `Pulled "${EMBEDDING_MODEL}" — local embeddings are now available.`,
      });
    }
  }

  /**
   * ORDERS ONE `/api/tags` RECONCILE — one pending timer at a time.
   *
   * The chain is self-perpetuating while the status is not `ready`: it
   * reschedules at the fast cadence during a pull, the slow cadence otherwise
   * (a failed pull keeps looking, because the model can still appear from
   * another path), and reaching `ready` breaks the chain for good. Delay zero
   * means "tick as soon as the loop is free", which is how `ensureModelsPulled`
   * gets a boot-time answer without a blocking round-trip.
   */
  private scheduleEmbeddingReconcile(delayMs: number): void {
    if (this.embeddingReconcileTimer || this.embeddingStatus === "ready") return;
    this.embeddingReconcileTimer = setTimeout(() => {
      this.embeddingReconcileTimer = null;
      void this.reconcileEmbedding().then((found) => {
        if (found || this.embeddingStatus === "ready") return;
        this.scheduleEmbeddingReconcile(
          this.embeddingStatus === "pulling" ? EMBEDDING_RECONCILE_FAST_MS : EMBEDDING_RECONCILE_SLOW_MS,
        );
      });
    }, delayMs);
    this.embeddingReconcileTimer.unref?.();
  }

  /** Cancels a pending reconcile. Safe when none is scheduled. */
  private stopEmbeddingReconcile(): void {
    if (this.embeddingReconcileTimer) {
      clearTimeout(this.embeddingReconcileTimer);
      this.embeddingReconcileTimer = null;
    }
  }

  /**
   * DYNAMIC MODEL SIZING + LOCAL EMBEDDING — pulls the hardware-appropriate
   * generation model and the embedding model so the node is ready to serve
   * both chat/generation and embeddings with no operator action.
   *
   * EMBEDDING FIRST, AND WHY. The embedding model is a ~100 MB download while
   * the generation model can be several GB; the old ordering put the big pull
   * in front, so on a fresh node the embedding pull had not even been ATTEMPTED
   * ten minutes in — while the tile already claimed "pulling…". Running the
   * small one first (bounded at 10 minutes) means the tile reaches a truthful
   * `ready`/`failed` long before the generation model finishes, and the
   * reconcile chain is armed before either starts so an already-installed
   * model reports `ready` on the very first tick with no download at all.
   *
   * Never throws — a failure here is reported through the embedding tile and
   * the terminal, not by taking down the caller's background chain.
   */
  private async ensureModelsPulled(): Promise<void> {
    this.scheduleEmbeddingReconcile(0);
    await this.pullEmbeddingModel();
    await this.pullGenerationModel();
  }

  /**
   * THE GENERATION MODEL PROVISIONER — the ~4.6 GB pull, never blocking a caller.
   *
   * THIS IS THE FIX FOR THE REPORTED FAILURE. The pull used to run through
   * `OllamaClient.pullModel()` with `stream: false` and a 15-minute axios timeout.
   * Ollama kept downloading (its own log said `downloading ... in 16 292 MB
   * part(s)`) while axios gave up, so the operator was shown a timeout error for a
   * transfer that was working. Three things changed, and all three matter:
   *
   *   1. STREAMING. `OllamaClient.pullModel` now requests `stream: true` and reads
   *      NDJSON progress frames, so the request stays demonstrably alive and real
   *      byte counts reach the status endpoint instead of nothing at all.
   *   2. FIRE-AND-FORGET. Callers never await this. The HTTP route returns
   *      `202 Accepted` and the dashboard polls `/api/ollama/status`, which is why
   *      a repair no longer holds a browser request open for the length of a
   *      multi-gigabyte download.
   *   3. RECONCILING. `/api/tags` is consulted before the pull (so an already
   *      installed model costs nothing), on a timer while it streams, and after it
   *      ends — including on the failure path, so a timeout that fires a moment
   *      after the download actually landed still reports `ready`.
   *
   * Never throws: every failure is reported through the returned message, the
   * terminal, the status field and the overlay, because every caller runs this on
   * an idle node that must not be able to crash.
   */
  async pullGenerationModel(): Promise<{ ok: boolean; message: string }> {
    const model = this.model;
    if (this.modelPulling) {
      return {
        ok: false,
        message: `already pulling ${model} — progress is on the Model tile and in the terminal.`,
      };
    }
    // The tag list decides first: an installed model is an instant "ready".
    if (await this.reconcileGeneration()) {
      return { ok: true, message: `${model} is already installed.` };
    }

    this.modelPulling = true;
    this.modelStatus = "pulling";
    this.modelError = null;
    this.modelPullPercent = 0;
    this.modelPullCompleted = null;
    this.modelPullTotal = null;
    publishLine("cmd", `pulling ${model} …`);
    console.log(`[OllamaManager] Pulling generation model "${model}".`);
    noteEngineActivity("pulling", model, MODEL_PULL_TIMEOUT_MS);
    this.stopModelReconcile();
    this.scheduleModelReconcile(MODEL_RECONCILE_FAST_MS);

    try {
      const client = new OllamaClient();
      await client.pullModel(model, (frame) => {
        // Only touch the fields when Ollama actually reported numbers — a
        // `status`-only frame must not blank out a percentage we already have.
        if (frame.percent !== null) this.modelPullPercent = frame.percent;
        if (typeof frame.total === "number") this.modelPullTotal = frame.total;
        if (typeof frame.completed === "number") this.modelPullCompleted = frame.completed;
      });
      this.markModelReady("pull completed");
      return { ok: true, message: `${model} pulled successfully.` };
    } catch (error) {
      // THE TIMEOUT MAY HAVE FIRED A MOMENT AFTER THE PULL ACTUALLY LANDED —
      // always ask the tag list before declaring failure.
      if (await this.reconcileGeneration()) {
        return { ok: true, message: `${model} is installed.` };
      }
      const message = error instanceof Error ? error.message : String(error);
      this.modelStatus = "failed";
      this.modelError = message;
      this.modelPullPercent = null;
      this.modelPullCompleted = null;
      this.modelPullTotal = null;
      publishLine("err", `model pull failed: ${message}`);
      console.warn(`[OllamaManager] Generation model pull failed — ${message}`);
      publishNodeEvent({
        kind: "info",
        title: "Model download failed",
        detail: `${model}: ${message}. Click the Model tile to retry.`,
      });
      // Keep reconciling after a failure — a later successful pull still flips the
      // tile to `ready` by itself.
      this.scheduleModelReconcile(EMBEDDING_RECONCILE_SLOW_MS);
      return { ok: false, message };
    } finally {
      this.modelPulling = false;
      clearEngineActivity();
    }
  }

  /**
   * ASKS `/api/tags` WHETHER THE GENERATION MODEL IS INSTALLED — AND BELIEVES IT.
   *
   * The tag list is the source of truth, so a model that landed by ANY path (this
   * pull, the operator's terminal, a manual `ollama pull`, a failover) flips the
   * tile to `ready`. Never throws: an unreachable server is simply "not found yet",
   * because a probe failure during a pull's own error handling must not mask the
   * real error.
   */
  async reconcileGeneration(): Promise<boolean> {
    if (this.modelStatus === "ready") return true;
    try {
      const origin = `http://127.0.0.1:${this.getPort()}`;
      const tags = await axios.get(`${origin}/api/tags`, { timeout: 3_000, proxy: false });
      if (!installedModelMatches(readOllamaModels(tags?.data), this.model)) return false;
      this.markModelReady("found in /api/tags");
      return true;
    } catch {
      return false;
    }
  }

  /** Folds a tag list the health probe already holds into the model tile. */
  private absorbModelInstalled(installed: string[]): void {
    if (this.modelStatus === "ready") return;
    if (!installedModelMatches(installed, this.model)) return;
    this.markModelReady("found in /api/tags");
  }

  /** Read through a method so awaits cannot narrow `modelStatus` to a literal. */
  private isModelReady(): boolean {
    return this.modelStatus === "ready";
  }

  /**
   * THE SINGLE TRANSITION INTO `ready` FOR THE GENERATION MODEL.
   *
   * Mirrors {@link markEmbeddingReady}: the overlay fires only when the operator
   * was previously told `pulling` or `failed`, because a routine idle→ready at
   * boot (model already installed) is not news, and claiming "Pulled …" for a
   * download that never ran is exactly the confident wrong answer this state
   * machine exists to prevent.
   */
  private markModelReady(source: string): void {
    const previous = this.modelStatus;
    if (previous === "ready") return;
    this.modelStatus = "ready";
    this.modelError = null;
    this.modelPullPercent = null;
    this.modelPullCompleted = null;
    this.modelPullTotal = null;
    this.stopModelReconcile();
    publishLine("out", `✓ ${this.model} is installed (${source}).`);
    console.log(`[OllamaManager] Generation model "${this.model}" ready — ${source}.`);
    if (previous === "pulling" || previous === "failed") {
      publishNodeEvent({
        kind: "info",
        title: "Model ready",
        detail: `Pulled "${this.model}" — local generation is now available.`,
      });
    }
  }

  /**
   * ORDERS ONE `/api/tags` RECONCILE FOR THE GENERATION MODEL — one pending
   * timer at a time, exactly like the embedding chain.
   */
  private scheduleModelReconcile(delayMs: number): void {
    if (this.modelReconcileTimer || this.isModelReady()) return;
    this.modelReconcileTimer = setTimeout(() => {
      this.modelReconcileTimer = null;
      void this.reconcileGeneration().then((found) => {
        if (found || this.isModelReady()) return;
        this.scheduleModelReconcile(
          this.modelStatus === "pulling" ? MODEL_RECONCILE_FAST_MS : EMBEDDING_RECONCILE_SLOW_MS,
        );
      });
    }, delayMs);
    this.modelReconcileTimer.unref?.();
  }

  /** Cancels a pending model reconcile. Safe when none is scheduled. */
  private stopModelReconcile(): void {
    if (this.modelReconcileTimer) {
      clearTimeout(this.modelReconcileTimer);
      this.modelReconcileTimer = null;
    }
  }

  /**
   * SELF-HEAL — the Embedded AI panel's repair routine. Kills a stuck
   * managed child, clears the last-error diagnostic, and relaunches the
   * server, re-pulling both models on the way back up.
   *
   * STILL AWAITABLE, AND STILL BLOCKING — see {@link startRepair} for why the HTTP
   * route no longer calls this directly.
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

  /**
   * STARTS A REPAIR AND RETURNS IMMEDIATELY — what the self-heal route calls.
   *
   * WHY THIS EXISTS. The route used to `await selfHeal()`, and `selfHeal()` awaits
   * `start()`, which can download the ~1.4 GB bundled runtime and then kick off a
   * ~4.6 GB model pull. The HTTP request therefore stayed open for minutes while
   * the repair was in fact working, and the browser reported a timeout — the same
   * "the operation succeeded but the operator saw an error" failure as the pull
   * itself. A repair is now ACCEPTED, not awaited: this returns immediately, the
   * work runs in the background, and `repairing`/`repairMessage` on the status
   * endpoint carry the outcome to the UI.
   *
   * A second request while a repair is already running is refused rather than
   * queued, so a double-click cannot race two restarts against each other.
   */
  startRepair(): { accepted: boolean; message: string } {
    if (this.repairing) {
      return {
        accepted: false,
        message: "A repair is already running — watch the Live Engine Terminal for progress.",
      };
    }
    this.repairing = true;
    this.repairMessage =
      "Repair started — restarting the local Ollama server and re-verifying models.";
    publishLine("cmd", "self-heal: restarting the local Ollama server …");

    void this.selfHeal()
      .then((result) => {
        this.repairMessage = result.message;
        publishLine(result.healed ? "out" : "err", result.message);
      })
      .catch((error) => {
        // `selfHeal` already catches, so this is belt-and-braces: a repair must
        // never leave `repairing` stuck true and the button disabled forever.
        this.repairMessage = `Self-heal failed — ${
          error instanceof Error ? error.message : String(error)
        }`;
        publishLine("err", this.repairMessage);
      })
      .finally(() => {
        this.repairing = false;
      });

    return { accepted: true, message: this.repairMessage };
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
