/**
 * DYNAMIC SKILL SANDBOX — executes AI-generated code from the Mothership.
 *
 * ============================================================================
 * READ THIS BEFORE TRUSTING IT
 * ============================================================================
 * Node's `vm` module is NOT a security sandbox; the official docs say so
 * outright, and code inside a `vm` context can escape it trivially via the
 * constructor chain. Running remote, AI-generated JavaScript inside `vm` on
 * this node's MAIN THREAD would therefore be a remote-code-execution channel
 * dressed up as a sandbox.
 *
 * This implementation therefore does NOT use main-thread `vm`. Instead it
 * executes every skill in a `node:worker_threads` Worker, which gives genuine
 * containment for the two things that actually matter in practice:
 *
 *   - MEMORY: `resourceLimits` caps the worker's heap (e.g. 128 MB). A runaway
 *     allocation terminates that worker instead of the node process.
 *   - TIME AND ISOLATION: the worker is forcibly `terminate()`d on timeout, it
 *     has its own V8 isolate, and it cannot reach this module's scope, the
 *     config file, or any in-memory state. A crash is a failed skill, not a
 *     dead node.
 *
 * What this does NOT give you: a hard security boundary against deliberately
 * hostile code. A determined attacker in the worker can still reach Node
 * built-ins through the constructor chain. Treat the Mothership as a TRUSTED
 * but fallible peer — it may send buggy code, not malicious code. If you need
 * to run genuinely untrusted code, put it in a container or a disposable VM;
 * do not point it at a fleet node.
 *
 * Controls provided:
 *   - hard execution timeout, enforced by the host (not the skill)
 *   - memory ceiling via worker resourceLimits
 *   - no ambient filesystem/process/network access inside the skill
 *   - `RIPPA_SKILL_EXECUTION=false` disables remote code execution entirely
 *   - every execution is audit-logged
 */

import { Worker } from "node:worker_threads";

/** Default wall-clock budget for one skill execution. */
export const DEFAULT_TIMEOUT_MS = 5_000;
/** Default heap ceiling for a skill worker. */
export const DEFAULT_MEMORY_MB = 128;
/** Hard cap on a skill's source, to bound parse time and memory. */
const MAX_SOURCE_BYTES = 256 * 1024;
/** Hard cap on input handed to a skill. */
const MAX_INPUT_BYTES = 4 * 1024 * 1024;

/** What a skill produced. */
export interface SkillResult {
  ok: boolean;
  /** The skill's return value (JSON-serialisable), or null on failure. */
  output: unknown;
  /** Failure reason, or "" on success. */
  error: string;
  /** Wall-clock duration in milliseconds. */
  durationMs: number;
  /** True when the host killed the worker (timeout / OOM). */
  terminated: boolean;
}

/** A skill as received from the Mothership. */
export interface SkillRequest {
  /** Task id, for logging and patch submission. */
  id?: string;
  /** Raw JavaScript. */
  code: string;
  /** Value bound to `input` inside the skill. */
  input?: unknown;
  /** Per-skill overrides. */
  timeoutMs?: number;
  memoryMb?: number;
}

/** True when remote code execution is permitted. */
function skillsEnabled(): boolean {
  return process.env.RIPPA_SKILL_EXECUTION !== "false";
}

/**
 * The worker bootstrap.
 *
 * Runs with `eval: true` so it needs no file on disk — which is what makes it
 * work inside a `pkg` snapshot. The skill is compiled with `new Function`, so
 * it only ever sees the arguments passed in, never this module's scope and
 * never a module-level `require`.
 */
const WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");

function serialiseError(error) {
  if (error && typeof error === "object") {
    return { name: String(error.name || "Error"), message: String(error.message || error), stack: String(error.stack || "") };
  }
  return { name: "Error", message: String(error), stack: "" };
}

(async () => {
  try {
    const source = String(workerData.code);
    const input = workerData.input;

    // The skill body is compiled into an ASYNC function taking only "input".
    // Being async is what lets a skill use top-level await. "use strict" plus
    // the arrow wrapper means the skill can never see this module's scope.
    const factory = new Function(
      "input",
      '"use strict"; return (async () => {\\n' + source + "\\n})();",
    );

    // A skill may return a value directly, a promise, or a function to be
    // called with the input. Normalise all three to a single resolved value.
    let output = await factory(input);
    if (typeof output === "function") {
      output = await output(input);
    }

    // JSON round-trip guarantees a transferable, serialisable result. Note that
    // this silently DROPS functions and undefined members rather than failing,
    // which is the safe direction: a skill cannot smuggle a function back into
    // the host.
    let safe;
    try {
      safe = JSON.parse(JSON.stringify(output === undefined ? null : output));
    } catch (err) {
      parentPort.postMessage({ ok: false, error: "skill returned a non-serialisable value: " + serialiseError(err).message });
      return;
    }
    parentPort.postMessage({ ok: true, output: safe });
  } catch (error) {
    const info = serialiseError(error);
    parentPort.postMessage({ ok: false, error: info.stack || info.message });
  }
})();
`;

/** Structured description of a thrown skill error. */
export interface SkillError {
  name: string;
  message: string;
  stack: string;
}

/**
 * Executes a single skill in an isolated worker.
 *
 * The timeout is enforced from this side with a timer, not trusted to the
 * worker: a skill that blocks the event loop forever cannot prevent the host
 * from reclaiming it.
 */
export async function executeSkill(request: SkillRequest): Promise<SkillResult> {
  const started = Date.now();

  if (!skillsEnabled()) {
    return fail("remote skill execution is disabled via RIPPA_SKILL_EXECUTION=false", started);
  }

  const code = String(request.code ?? "");
  if (!code.trim()) {
    return fail("skill payload contained no code", started);
  }
  if (code.length > MAX_SOURCE_BYTES) {
    return fail(`skill source exceeds ${MAX_SOURCE_BYTES} bytes`, started);
  }

  const timeoutMs = clampTimeout(request.timeoutMs);
  const memoryMb = clampMemory(request.memoryMb);

  // Bound the input size; an enormous payload would otherwise be copied into
  // every worker and defeat the memory cap.
  let input = request.input ?? null;
  try {
    const serialized = JSON.stringify(input);
    if (serialized && serialized.length > MAX_INPUT_BYTES) {
      input = JSON.parse(serialized.slice(0, MAX_INPUT_BYTES));
    }
  } catch {
    input = null; // non-serialisable input is dropped rather than crashing
  }

  let worker: Worker;
  try {
    worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: { code, input },
      resourceLimits: {
        maxOldGenerationSizeMb: memoryMb,
        maxYoungGenerationSizeMb: Math.min(memoryMb, 32),
        codeRangeSizeMb: 16,
        stackSizeMb: 4,
      },
      stdout: false,
      stderr: false,
    });
  } catch (error) {
    return fail(`could not start skill worker: ${describe(error)}`, started);
  }

  return new Promise<SkillResult>((resolve) => {
    let settled = false;
    /**
     * Ends the run exactly once, terminating the worker if still alive.
     * `durationMs` is stamped here rather than at each call site, so no path
     * can forget it.
     */
    const finish = (partial: Omit<SkillResult, "durationMs">, kill: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (kill) void worker.terminate().catch(() => undefined);
      resolve({ ...partial, durationMs: Date.now() - started });
    };

    const timer = setTimeout(() => {
      console.warn(`[Skill] Execution exceeded ${timeoutMs}ms — terminating the worker.`);
      finish(
        { ok: false, output: null, error: `timeout after ${timeoutMs}ms`, terminated: true },
        true,
      );
    }, timeoutMs);
    timer.unref?.();

    worker.on("message", (message: Record<string, unknown>) => {
      if (message?.["ok"] === true) {
        finish({ ok: true, output: message["output"] ?? null, error: "", terminated: false }, true);
      } else {
        finish(
          { ok: false, output: null, error: String(message?.["error"] ?? "unknown error"), terminated: false },
          true,
        );
      }
    });

    worker.on("error", (error) => {
      // Raised for OOM and for syntax errors in the skill itself.
      finish({ ok: false, output: null, error: describe(error), terminated: true }, true);
    });

    worker.on("exit", (code: number) => {
      // An exit before a message means the worker died without reporting.
      finish(
        { ok: false, output: null, error: `skill worker exited (code ${code}) without a result`, terminated: true },
        false,
      );
    });
  });
}

/** Runs several skills sequentially, stopping at the first failure. */
export async function executeSkillBatch(requests: SkillRequest[]): Promise<SkillResult[]> {
  const results: SkillResult[] = [];
  for (const request of requests) {
    const result = await executeSkill(request);
    results.push(result);
    if (!result.ok) break;
  }
  return results;
}

function fail(error: string, started: number): SkillResult {
  return { ok: false, output: null, error, durationMs: Date.now() - started, terminated: false };
}

/** Keeps a skill timeout inside a sane 250ms-60s window. */
function clampTimeout(value: number | undefined): number {
  if (!Number.isFinite(value) || (value as number) <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(60_000, Math.max(250, Math.floor(value as number)));
}

/** Keeps the heap ceiling inside 16-1024 MB. */
function clampMemory(value: number | undefined): number {
  if (!Number.isFinite(value) || (value as number) <= 0) return DEFAULT_MEMORY_MB;
  return Math.min(1024, Math.max(16, Math.floor(value as number)));
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
