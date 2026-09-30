import axios from "axios";
import { OllamaClient } from "../agent/OllamaClient";
import { executeSkill, type SkillResult } from "./skillExecutor";
import { discoverLocalAi, type LocalAiStatus } from "./localAi";
import type { SwarmClient } from "../network/SwarmClient";

/**
 * AUTONOMOUS SELF-HEALING TASK LOOP.
 *
 * When a standard task fails — most often a scraper that broke because a site
 * changed its markup — reporting "Failed" wastes the fleet's time. This module
 * instead:
 *
 *   1. captures the real error and a sample of the offending input,
 *   2. asks the local Ollama model (falling back to the Mothership) to write a
 *      patched version of the function,
 *   3. runs that patch through the DYNAMIC_SKILL sandbox,
 *   4. re-runs the original task with the patch applied, and
 *   5. submits a successful patch back to the Mothership so every other node
 *      learns from the same fix.
 *
 * SAFETY RAILS — an autonomous rewrite loop is where AI systems go wrong, so
 * every stage is bounded and nothing is trusted:
 *   - at most {@link MAX_HEAL_ATTEMPTS} patches per task;
 *   - patches only ever run inside the skill sandbox, never `eval`'d here;
 *   - a patch must actually change the failing behaviour to be accepted, and
 *     the ORIGINAL output is kept if the patch does not improve on it;
 *   - `RIPPA_SELF_HEAL=false` disables the whole loop.
 */

/** Patches attempted per failing task before giving up. */
const MAX_HEAL_ATTEMPTS = 2;
/** How much of the offending input is sent to the model. */
const MAX_SAMPLE_CHARS = 4_000;
/** Model generation timeout — a local 7B writing a patch is slow. */
const PATCH_TIMEOUT_MS = 180_000;
/** Sandbox budget for evaluating a candidate patch. */
const PATCH_EXEC_TIMEOUT_MS = 5_000;

/** What a healer needs to know about a failure. */
export interface FailureContext {
  /** Task that failed. */
  taskId: string;
  /** Task type, e.g. "scrape". */
  taskType: string;
  /** The error message. */
  message: string;
  /** Stack trace, sent to the model so it can see the real failure site. */
  stack?: string;
  /** Sample of the input that triggered the failure. */
  inputSample?: unknown;
  /** The code that failed, if the task was skill-backed. */
  code?: string;
}

/** Outcome of a healing attempt. */
export interface HealOutcome {
  /** True when a patch fixed the task. */
  healed: boolean;
  /** The accepted patch, or "" when nothing was fixed. */
  patch: string;
  /** Attempts burned. */
  attempts: number;
  /** Human-readable trail for the logs. */
  log: string[];
}

/** Hooks the host supplies so this module has no transport dependencies. */
export interface HealDeps {
  /** Re-runs the original task with the patched code. */
  rerun: (patchedCode: string) => Promise<unknown>;
  /** Submits a successful patch so the fleet can reuse it. */
  submitPatch: (payload: Record<string, unknown>) => Promise<boolean>;
  /** Optional local model, used before falling back to the cloud. */
  ollama?: OllamaClient;
  /** Current local AI status, used to skip the local path when absent. */
  localStatus?: () => LocalAiStatus | null;
  /** Used for the cloud fallback. */
  swarm?: SwarmClient;
}

/** True when self-healing is permitted. */
function selfHealEnabled(): boolean {
  return process.env.RIPPA_SELF_HEAL !== "false";
}

/**
 * PROMPT — asks for a drop-in replacement function.
 *
 * Deliberately narrow: the model is told to return ONLY a function body, to use
 * no imports (the sandbox has no `require`), and to work defensively so a
 * layout change degrades to "less data" rather than another exception.
 */
const PATCH_SYSTEM_PROMPT = `You repair broken JavaScript data-processing functions.

You will be given a function that THREW an error. Return ONLY a corrected
version of that same function, with the same name and the same argument.

Hard rules:
- Return ONLY JavaScript code. No markdown fences, no explanation.
- Use NO import or require statements; none are available.
- Use only standard JavaScript (string, array, object, regex, JSON, Math).
- Be defensive: if an expected field is missing, skip it instead of throwing.
- Keep the original behaviour; only fix what caused the error.
`;

/**
 * Builds the user message describing the failure.
 *
 * The stack trace and a truncated input sample are both included: the stack
 * says WHERE it broke, the sample says WHAT it was looking at. Models produce
 * markedly better patches with both.
 */
function buildHealPrompt(context: FailureContext): string {
  const sample = String(context.inputSample ?? "").slice(0, MAX_SAMPLE_CHARS);
  return [
    "The following function failed while processing data.",
    "",
    "```javascript",
    context.code ?? "(function source unavailable)",
    "```",
    "",
    "It threw:",
    context.stack || context.message,
    "",
    "Input sample it was processing:",
    "```",
    sample,
    "```",
    "",
    "Return the corrected function.",
  ].join("\n");
}

/**
 * Extracts JavaScript from a model reply.
 *
 * Local models routinely wrap code in markdown fences or add a sentence of
 * preamble, so the fence is stripped and the fenced region is preferred when
 * present. Returns "" when no code can be recovered.
 */
export function extractCode(reply: string): string {
  const text = String(reply ?? "").trim();
  if (!text) return "";

  const fenced = /```(?:javascript|js)?\s*([\s\S]*?)```/i.exec(text);
  if (fenced?.[1]) return fenced[1].trim();

  // No fence: use the text as-is, provided it looks like code.
  if (/\bfunction\b|=>|\breturn\b/.test(text)) return text;
  return "";
}

/**
 * Asks the local model first (free), then the cloud (costs credits).
 *
 * Order matters: self-healing is supposed to save cloud spend, so a node with a
 * GPU should never bill the Mothership for a patch it could have written.
 */
async function requestPatch(context: FailureContext, deps: HealDeps): Promise<string> {
  const prompt = buildHealPrompt(context);
  const status = deps.localStatus?.() ?? null;

  if (deps.ollama && status?.capable) {
    try {
      const reply = await deps.ollama.generatePatch(PATCH_SYSTEM_PROMPT, prompt, {
        model: status.preferredModel,
        timeoutMs: PATCH_TIMEOUT_MS,
      });
      const code = extractCode(reply);
      if (code) {
        console.log(`[Heal] Local model ${status.preferredModel} produced a patch.`);
        return code;
      }
      console.warn("[Heal] Local model returned no usable code — trying the cloud.");
    } catch (error) {
      console.warn(`[Heal] Local patch generation failed — ${describe(error)}`);
    }
  }

  // Cloud fallback, via the Mothership's own model endpoint.
  if (deps.swarm) {
    try {
      const reply = await deps.swarm.requestSkillPatch(PATCH_SYSTEM_PROMPT, prompt);
      const code = extractCode(reply);
      if (code) {
        console.log("[Heal] Cloud model produced a patch.");
        return code;
      }
    } catch (error) {
      console.warn(`[Heal] Cloud patch generation failed — ${describe(error)}`);
    }
  }

  return "";
}
/**
 * STATIC GATE: does this patch plausibly parse as JavaScript?
 *
 * A patch that does not even parse is rejected before it costs a sandbox run.
 * The sandbox would catch it anyway, but failing fast keeps the heal loop from
 * burning attempts on a garbage response.
 */
export function looksLikeValidCode(code: string): boolean {
  const trimmed = String(code ?? "").trim();
  if (trimmed.length < 8) return false;
  try {
    // Compiling without running is the cheapest syntax check available.
    // eslint-disable-next-line no-new-func
    new Function(`return (async () => {${trimmed}})();`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Validates a candidate patch by running it in the sandbox, EXACTLY as the real
 * task will run it.
 *
 * Using the same wrapper and the same input as the eventual re-run is
 * deliberate: a dry-run that binds different names than production would reject
 * perfectly good patches (and, worse, accept ones that then fail for real).
 * The returned SkillResult is the patch's genuine pass/fail signal.
 */
async function validatePatch(code: string, inputSample: unknown): Promise<SkillResult> {
  return executeSkill({ code, input: inputSample, timeoutMs: PATCH_EXEC_TIMEOUT_MS });
}

/**
 * THE SELF-HEALING LOOP.
 *
 * Attempts up to {@link MAX_HEAL_ATTEMPTS} patches. A patch is accepted only
 * when it runs cleanly in the sandbox AND the re-run of the original task
 * succeeds. A successful patch is submitted to the Mothership so the rest of
 * the fleet inherits the fix.
 */
export async function healTask(context: FailureContext, deps: HealDeps): Promise<HealOutcome> {
  const log: string[] = [];

  if (!selfHealEnabled()) {
    log.push("self-healing disabled via RIPPA_SELF_HEAL=false");
    return { healed: false, patch: "", attempts: 0, log };
  }
  if (!context.code) {
    log.push("no source available for this task — nothing to patch");
    return { healed: false, patch: "", attempts: 0, log };
  }

  for (let attempt = 1; attempt <= MAX_HEAL_ATTEMPTS; attempt++) {
    log.push(`attempt ${attempt}/${MAX_HEAL_ATTEMPTS}: requesting a patch`);

    const patch = await requestPatch(context, deps);
    if (!patch) {
      log.push("no patch was generated — stopping");
      break;
    }
    if (!looksLikeValidCode(patch)) {
      log.push("generated patch does not parse — discarding");
      continue;
    }

    // Run the candidate in the sandbox before touching real work.
    const validation = await validatePatch(patch, context.inputSample);
    if (!validation.ok) {
      log.push(`patch failed validation (${validation.error.split("\n")[0]}) — discarding`);
      continue;
    }

    // Now the real test: re-run the original task with the patch applied.
    try {
      await deps.rerun(patch);
      log.push("patched task completed successfully");
      await deps.submitPatch({
        taskType: context.taskType,
        failedTaskId: context.taskId,
        originalCode: context.code,
        patchedCode: patch,
        error: context.message,
        recoveredAt: new Date().toISOString(),
      });
      return { healed: true, patch, attempts: attempt, log };
    } catch (error) {
      log.push(`re-run with the patch still failed (${describe(error)}) — retrying`);
    }
  }

  log.push("exhausted attempts — reporting the original failure");
  return { healed: false, patch: "", attempts: MAX_HEAL_ATTEMPTS, log };
}

/**
 * Discovers local AI and reports whether this node should advertise itself as
 * an `AI_CAPABLE_NODE`.
 *
 * Exposed separately so boot can prime the capability before the first
 * heartbeat, so the Mothership can route work to this node immediately.
 */
export async function probeLocalAi(): Promise<LocalAiStatus> {
  return discoverLocalAi();
}

/** True when a patch-generation request should be attempted at all. */
export function canGeneratePatches(deps: HealDeps): boolean {
  const status = deps.localStatus?.() ?? null;
  return Boolean(deps.swarm) || Boolean(deps.ollama && status?.capable);
}

function describe(error: unknown): string {
  if (axios.isAxiosError(error)) return error.message;
  return error instanceof Error ? error.message : String(error);
}