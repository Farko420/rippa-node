import os from "node:os";
import axios, { type AxiosInstance } from "axios";
import { z } from "zod";
import { env } from "../config";

/**
 * HARDWARE AUTO-PROFILING — picks the generation model a satellite should
 * auto-pull based on physical RAM, using Node's native `os` module.
 *
 * >= 8GB: the primary code model (qwen2.5-coder:7b).
 * < 8GB: a small, fast fallback (qwen2.5:1.5b) that will not freeze the host.
 */
export function recommendedPrimaryModel(): string {
  const totalGb = os.totalmem() / (1024 * 1024 * 1024);
  return totalGb >= LOW_RAM_THRESHOLD_GB ? PRIMARY_MODEL : LOW_RAM_MODEL;
}

/** Total system RAM in whole GB — surfaced to the dashboard/status panels. */
export function systemRamGb(): number {
  return Math.round((os.totalmem() / (1024 * 1024 * 1024)) * 10) / 10;
}

/**
 * THE BRAIN — local Ollama extraction client.
 *
 * Talks to the node's Ollama instance over HTTP, drives the model with a
 * system prompt that enforces the `verified_knowledge` JSON shape, and
 * hard-validates the response with zod before handing it back.
 */

/** Preferred model; falls back to `llama3` when it is not pulled locally. */
export const PRIMARY_MODEL = "qwen2.5-coder:7b";
export const FALLBACK_MODEL = "llama3";

/**
 * HARDWARE AUTO-PROFILING — lightweight satellite nodes must never be handed
 * the 7B coder model: on an 8GB laptop that freezes the host OS. This is the
 * model selected when `os.totalmem()` reports less than `LOW_RAM_THRESHOLD_GB`.
 */
export const LOW_RAM_MODEL = "qwen2.5:1.5b";
/** RAM (GB) at/above which the full PRIMARY_MODEL is safe to auto-pull. */
export const LOW_RAM_THRESHOLD_GB = 8;

/**
 * LOCAL EMBEDDING MODEL — pulled alongside the chat model so the node can
 * generate vector embeddings for the Rippa AI knowledge base without relying
 * on a paid external API.
 */
export const EMBEDDING_MODEL = "nomic-embed-text";

/**
 * AGGRESSIVE VRAM UNLOADING — Ollama's default `keep_alive` is 5 minutes.
 * This node also runs Playwright scrapers, so inference requests are forced
 * to flush the model from VRAM almost immediately after replying.
 */
export const KEEP_ALIVE = "60s";

/** Ollama's default port when OLLAMA_URL is not set. */
export const DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434";

/** Hard cap on source text sent to the model (keeps the prompt in-budget). */
const MAX_INPUT_CHARS = 16_000;
const REQUEST_TIMEOUT_MS = 180_000; // local 7B inference can take a while

/**
 * The structured shape of a `verified_knowledge` row, as produced by the LLM.
 * `coordinates` is a "lat, lon" string when the source implies a place,
 * otherwise `null`.
 */
export const verifiedFactSchema = z.object({
  category: z.string().min(1),
  fact_summary: z.string().min(1),
  confidence_score: z.number(),
  coordinates: z.string().nullable(),
});
export type VerifiedFact = z.infer<typeof verifiedFactSchema>;

/**
 * SYSTEM PROMPT — the critical directive:
 *  - Australian outdoor guide persona.
 *  - Extracts locations, rules, hazards and descriptions.
 *  - CRITICAL: every imperial measurement must be converted to metric.
 *  - Output is a single JSON object matching `verified_knowledge`.
 */
const SYSTEM_PROMPT = `You are an Australian outdoor guide with decades of experience in the Queensland bush, 4WD touring, bushwalking and remote-area safety.

From the TEXT supplied by the user, extract the single most useful and verifiable fact for an outdoor-adventure knowledge base. Cover these kinds of facts when present: locations, rules/regulations, hazards, and descriptions of places or conditions.

CRITICAL MEASUREMENT RULE: The source text may use imperial units. You MUST convert ALL imperial measurements to metric before writing anything: feet -> metres, miles -> kilometres, pounds -> kilograms, ounces -> grams, inches -> centimetres, Fahrenheit -> Celsius. Never leave an imperial unit (ft, feet, mi, miles, lb, lbs, in, degrees F) anywhere in your output. Round sensibly (e.g. "1,500 ft" -> "457 metres").

Australia-specific conventions:
- Use Australian English spelling.
- Report coordinates as decimal degrees "latitude, longitude" (WGS84) when the text identifies a real place; otherwise use null.
- Distances in metres or kilometres; state track grades and hazards plainly.

Respond with ONLY one JSON object (no markdown fences, no commentary) with exactly this structure:
{
  "category": "location" | "rule" | "hazard" | "description",
  "fact_summary": "One concise sentence containing the extracted fact with all measurements in metric units.",
  "confidence_score": <number from 0.0 to 1.0 - how well the source states this fact>,
  "coordinates": "<lat, lon>" or null
}`;

interface ChatResponse {
  message?: { content?: string };
  done?: boolean;
}

export class OllamaClient {
  private readonly client: AxiosInstance;
  private resolvedModel: string | null = null;

  constructor(baseUrl: string = env.OLLAMA_URL ?? DEFAULT_OLLAMA_URL) {
    this.client = axios.create({
      baseURL: baseUrl.replace(/\/+$/, ""),
      timeout: REQUEST_TIMEOUT_MS,
      headers: { "Content-Type": "application/json" },
    });
  }

  /**
   * Extracts a `verified_knowledge`-shaped fact from raw page text.
   * Returns `null` when the model is unreachable or the payload is not
   * valid JSON matching the schema — callers decide what to do then.
   */
  async extractFacts(rawText: string): Promise<VerifiedFact | null> {
    const input = rawText.slice(0, MAX_INPUT_CHARS);
    try {
      return await this.extractFactsWithModel(input, await this.resolveModel());
    } catch (error) {
      // AUTO-FAILOVER: the primary model failed to load or generate — pull and
      // switch to FALLBACK_MODEL, then retry exactly once. A second failure is
      // reported to the caller rather than looping forever.
      console.warn(
        `[Ollama] Primary model request failed (${
          error instanceof Error ? error.message : String(error)
        }) — attempting fallback.`,
      );
      try {
        await this.pullModel(FALLBACK_MODEL);
        return await this.extractFactsWithModel(input, FALLBACK_MODEL);
      } catch (fallbackError) {
        console.warn(
          `[Ollama] Fallback model also failed — ${
            fallbackError instanceof Error ? fallbackError.message : String(fallbackError)
          }`,
        );
        return null;
      }
    }
  }

  /** The actual `/api/chat` call, shared by the primary and fallback attempts. */
  private async extractFactsWithModel(input: string, model: string): Promise<VerifiedFact | null> {
    const { data } = await this.client.post<ChatResponse>("/api/chat", {
      model,
      stream: false,
      format: "json", // force JSON-only output from the model
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: `TEXT:\n${input}` },
      ],
      options: {
        temperature: 0.1, // deterministic extraction
        num_ctx: 8192,
      },
      // AGGRESSIVE VRAM UNLOADING — flush this model out of VRAM almost
      // immediately after replying, so Playwright/GPU work is never starved.
      keep_alive: KEEP_ALIVE,
    });

    const content = data?.message?.content;
    if (!content) {
      console.warn(`[Ollama] Empty response from model "${model}".`);
      return null;
    }

    return parseFactPayload(content, model);
  }

  /**
   * Picks `PRIMARY_MODEL` when it is pulled locally, otherwise falls back
   * to `llama3`. The answer is cached for the process lifetime; if the
   * model list cannot be fetched we just try the primary and let the
   * subsequent call surface any error.
   */
  private async resolveModel(): Promise<string> {
    if (this.resolvedModel) {
      return this.resolvedModel;
    }

    try {
      const { data } = await this.client.get<{ models?: Array<{ name?: string }> }>("/api/tags", {
        timeout: 5_000,
      });
      const names = (data?.models ?? []).map((m) => m.name ?? "");

      if (matchesModel(names, PRIMARY_MODEL)) {
        this.resolvedModel = PRIMARY_MODEL;
      } else if (matchesModel(names, FALLBACK_MODEL)) {
        console.warn(`[Ollama] "${PRIMARY_MODEL}" not available — falling back to "${FALLBACK_MODEL}".`);
        this.resolvedModel = FALLBACK_MODEL;
      } else {
        console.warn(`[Ollama] No recognised model found — attempting "${PRIMARY_MODEL}".`);
        this.resolvedModel = PRIMARY_MODEL;
      }
    } catch {
      this.resolvedModel = PRIMARY_MODEL;
    }

    return this.resolvedModel;
  }

  /**
   * Generates raw code from a system + user prompt.
   *
   * Added for the self-healing loop, which needs JavaScript back rather than
   * the strictly-validated `verified_knowledge` shape that
   * {@link extractFacts} produces. Unlike `extractFacts` this performs NO schema
   * validation — the patcher parses and sandbox-tests the result itself.
   */
  async generatePatch(
    systemPrompt: string,
    userPrompt: string,
    options: { model?: string; timeoutMs?: number } = {},
  ): Promise<string> {
    const model = options.model ?? (await this.resolveModel());
    try {
      const { data } = await this.client.post(
        "/api/generate",
        {
          model,
          system: systemPrompt,
          prompt: userPrompt,
          stream: false,
          options: {
            // Low temperature: a patch should follow the original code, not
            // improvise a redesign.
            temperature: 0.1,
          },
          // AGGRESSIVE VRAM UNLOADING — see extractFactsWithModel.
          keep_alive: KEEP_ALIVE,
        },
        { timeout: options.timeoutMs ?? REQUEST_TIMEOUT_MS },
      );
      const body = (data ?? {}) as { response?: string; message?: { content?: string } };
      return String(body.response ?? body.message?.content ?? "");
    } catch (error) {
      console.warn(
        `[Ollama] Patch generation failed — ${error instanceof Error ? error.message : String(error)}`,
      );
      return "";
    }
  }

  /**
   * AUTO-FAILOVER SUPPORT — pulls `model` via `POST /api/pull` and, on
   * success, pins it as the resolved model for subsequent calls.
   *
   * Used by `ollamaManager.failoverToFallback()` when the primary model
   * fails to load or generate, so the node can recover a usable local model
   * without operator intervention. Streaming is disabled so this resolves
   * once the pull genuinely completes rather than mid-download.
   */
  async pullModel(model: string): Promise<void> {
    const name = model.trim();
    if (!name) throw new Error("pullModel: empty model name");
    await this.client.post(
      "/api/pull",
      { model: name, stream: false },
      { timeout: 15 * 60_000 }, // a fresh pull can be a large download
    );
    this.resolvedModel = name;
    console.log(`[Ollama] Pulled and pinned fallback model "${name}".`);
  }

  /**
   * LOCAL EMBEDDING CAPABILITY — generates vector embeddings via Ollama's
   * `/api/embeddings` endpoint so the Mothership's knowledge base does not
   * have to pay for an external embedding API when a node can do it locally.
   */
  async embed(input: string, model: string = EMBEDDING_MODEL): Promise<number[]> {
    const { data } = await this.client.post<{ embedding?: number[] }>(
      "/api/embeddings",
      { model, prompt: input, keep_alive: KEEP_ALIVE },
      { timeout: 60_000 },
    );
    return data?.embedding ?? [];
  }

  /** Clears the cached model resolution, forcing a fresh `/api/tags` check. */
  resetResolvedModel(): void {
    this.resolvedModel = null;
  }

  /** The model currently pinned/resolved, or "" before the first resolution. */
  get currentModel(): string {
    return this.resolvedModel ?? "";
  }
}

/**
 * True when any installed model name equals `target`, or shares its bare
 * name (e.g. target "llama3" matches installed "llama3.1:latest").
 */
function matchesModel(installed: string[], target: string): boolean {
  const bare = target.split(":")[0];
  return installed.some((name) => name === target || name.split(":")[0] === bare);
}

/**
 * Parses and validates the model's raw output: tolerates markdown fences
 * or surrounding chatter, accepts either a single object or an array
 * (highest confidence wins), and normalises confidence to 0–1.
 */
function parseFactPayload(content: string, model: string): VerifiedFact | null {
  const candidate = stripToJsonObject(content);
  if (!candidate) {
    console.warn(`[Ollama] Model "${model}" did not return JSON — ignoring.`);
    return null;
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(candidate);
  } catch {
    console.warn(`[Ollama] Model "${model}" returned malformed JSON — ignoring.`);
    return null;
  }

  // If the model returned several facts, keep the most confident one.
  if (Array.isArray(decoded)) {
    if (decoded.length === 0) {
      console.warn(`[Ollama] Model "${model}" returned an empty fact array.`);
      return null;
    }
    decoded = decoded
      .slice()
      .sort((x, y) => confidenceOf(y) - confidenceOf(x))[0];
  }

  const parsed = verifiedFactSchema.safeParse(decoded);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    console.warn(`[Ollama] Payload failed schema validation: ${issue ? `${issue.path.join(".")} — ${issue.message}` : "unknown"}`);
    return null;
  }

  const fact = parsed.data;

  // Normalise confidence: accept 0–1 as-is, treat 0–100 as a percentage.
  let confidence = fact.confidence_score;
  if (confidence > 1 && confidence <= 100) {
    confidence = confidence / 100;
  }
  confidence = Math.max(0, Math.min(1, confidence));

  const coordinates =
    fact.coordinates === null || fact.coordinates.trim() === ""
      ? null
      : fact.coordinates.trim();

  return {
    category: fact.category.trim(),
    fact_summary: fact.fact_summary.trim(),
    confidence_score: confidence,
    coordinates,
  };
}

/** Best-effort extraction of the first balanced JSON object in a string. */
function stripToJsonObject(content: string): string | null {
  const unfenced = content.replace(/```(?:json)?/gi, "").trim();
  const start = unfenced.indexOf("{");
  const end = unfenced.lastIndexOf("}");
  if (start === -1 || end <= start) {
    return null;
  }
  return unfenced.slice(start, end + 1);
}

/** Reads and normalises a candidate's confidence score (0–1 scale). */
function confidenceOf(candidate: unknown): number {
  if (typeof candidate === "object" && candidate !== null && "confidence_score" in candidate) {
    const value = (candidate as { confidence_score?: unknown }).confidence_score;
    if (typeof value === "number") {
      return value > 1 && value <= 100 ? value / 100 : value;
    }
  }
  return 0;
}

