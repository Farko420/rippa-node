import axios from "axios";
import { env } from "../config";

/**
 * LOCAL AI ENGINE BINDING — automatic discovery of a local Ollama server.
 *
 * The fleet should spend local GPU time rather than cloud credits whenever a
 * node happens to have a model available. This module probes the configured
 * Ollama URL (plus the usual local alternatives), inspects which models are
 * actually pulled, and reports the node's AI capability so the Mothership can
 * offload heavy work (HTML→JSON structuring, review summarising) to it.
 *
 * Discovery is entirely read-only: it calls `GET /api/tags` and nothing else.
 */

/** Ports probed when the configured URL is unreachable. */
const FALLBACK_URLS = [
  "http://127.0.0.1:11434",
  "http://localhost:11434",
];

/** How often the node re-probes for a local AI server. */
const DISCOVERY_INTERVAL_MS = 5 * 60_000;
/** Probing must be fast — a dead port fails immediately, a live one is instant. */
const PROBE_TIMEOUT_MS = 2_500;

/**
 * Model-name fragments that mark a model as genuinely useful for skill work.
 * A node running only a tiny model is reported as present-but-not-capable
 * rather than advertised as an AI node it cannot serve.
 */
const CAPABILITY_MARKERS: Record<string, RegExp> = {
  /** Instruction-tuned code models: the self-healing loop depends on these. */
  coder: /(qwen.*coder|codellama|deepseek-coder|starCoder|codestral|starcoder2)/i,
  /** General instruct models. */
  instruct: /(llama3|mistral|qwen2\.5|phi3|gemma2|command-r|vicuna)/i,
  /** Embedding models are useful but cannot generate patches. */
  embedding: /(nomic-embed|mxbai|bge-|e5-|all-minilm)/i,
};

/** What the node discovered about its local AI. */
export interface LocalAiStatus {
  /** True when at least one usable model was found. */
  capable: boolean;
  /** Resolved base URL, or "" when nothing responded. */
  url: string;
  /** Every model the local server has pulled. */
  models: string[];
  /** Models this node advertises as `AI_CAPABLE_NODE`. */
  capableModels: string[];
  /** Best model for the self-healing patch generator, or "". */
  preferredModel: string;
  /** ISO timestamp of this probe. */
  checkedAt: string;
}

/** Shape of Ollama's `GET /api/tags`. */
interface TagsResponse {
  models?: Array<{ name?: string; model?: string }>;
}

/** Status reported when no local AI server answered. */
function offlineStatus(): LocalAiStatus {
  return {
    capable: false,
    url: "",
    models: [],
    capableModels: [],
    preferredModel: "",
    checkedAt: new Date().toISOString(),
  };
}

/** True when a model can generate patches (not an embedding-only model). */
export function isGenerativeModel(name: string): boolean {
  if (CAPABILITY_MARKERS.embedding.test(name)) return false;
  return CAPABILITY_MARKERS.coder.test(name) || CAPABILITY_MARKERS.instruct.test(name);
}

/**
 * Ranks generative models so the most capable one leads.
 *
 * Code-specialised models win, then size (a 7B beats a 1.5B for patch
 * generation). This ordering decides which model the self-healer uses.
 */
export function rankModels(models: string[]): string[] {
  return models
    .filter(isGenerativeModel)
    .sort((a, b) => {
      const coderA = CAPABILITY_MARKERS.coder.test(a) ? 1 : 0;
      const coderB = CAPABILITY_MARKERS.coder.test(b) ? 1 : 0;
      if (coderA !== coderB) return coderB - coderA;
      // Compare the largest declared size, e.g. "qwen2.5-coder:32b" > ":7b".
      const sizeOf = (name: string): number => {
        const match = /:(\d+(?:\.\d+)?)b/i.exec(name);
        return match ? Number(match[1]) : 0;
      };
      return sizeOf(b) - sizeOf(a);
    });
}

/**
 * Asks one candidate URL for its model list.
 *
 * `GET /api/tags` is Ollama's discovery endpoint and is side-effect free, so a
 * probe can never disturb a model that is mid-generation.
 */
async function probeTags(baseUrl: string): Promise<string[]> {
  const response = await axios.get<TagsResponse>(`${baseUrl.replace(/\/+$/, "")}/api/tags`, {
    timeout: PROBE_TIMEOUT_MS,
    headers: { Accept: "application/json" },
    // A wrong local address must not inherit a proxy route.
    proxy: false,
  });
  return (response.data?.models ?? [])
    .map((entry) => entry.name ?? entry.model ?? "")
    .filter((name) => name.trim().length > 0);
}

/**
 * AUTO-DISCOVERY: finds a local AI server and reports what it can do.
 *
 * The configured `OLLAMA_URL` is tried first, then the standard local fallbacks.
 * Returns an offline status (rather than throwing) when nothing answers, so a
 * node without a GPU simply advertises "not AI capable".
 */
export async function discoverLocalAi(): Promise<LocalAiStatus> {
  const candidates = [env.OLLAMA_URL ?? "", ...FALLBACK_URLS]
    .map((url) => url.trim())
    .filter(Boolean)
    // De-duplicate so a loopback alias is not probed twice.
    .filter((url, index, all) => all.indexOf(url) === index);

  for (const url of candidates) {
    try {
      const models = await probeTags(url);
      const capableModels = rankModels(models);
      if (capableModels.length === 0) {
        // Ollama is running but has nothing usable yet (embeddings only, or no
        // models pulled). Not an error — just not capable.
        continue;
      }
      return {
        capable: true,
        url,
        models,
        capableModels,
        preferredModel: capableModels[0],
        checkedAt: new Date().toISOString(),
      };
    } catch {
      // Not listening, or not Ollama. Try the next candidate.
      continue;
    }
  }
  return offlineStatus();
}

/** The capability flag broadcast to the Mothership. */
export function isAiCapable(status: LocalAiStatus): boolean {
  return status.capable && status.capableModels.length > 0;
}

/**
 * Keeps the node's AI capability fresh.
 *
 * A node may start before Ollama does (people boot the swarm and the model
 * server together), and a model may be pulled later. Re-probing on an interval
 * means the node advertises `AI_CAPABLE_NODE` as soon as a model appears, and
 * stops advertising it if Ollama is later shut down.
 *
 * Returns a callback so the caller can observe capability changes.
 */
export function startLocalAiDiscovery(
  onChange: (status: LocalAiStatus) => void,
  intervalMs = DISCOVERY_INTERVAL_MS,
): () => void {
  let previous: string | null = null;

  const probe = async (): Promise<void> => {
    const status = await discoverLocalAi();
    // Only notify on an actual capability change, so the Mothership is not
    // re-registered every cycle.
    if (status.url !== previous) {
      previous = status.url;
      if (status.capable) {
        console.log(
          `[LocalAI] AI_CAPABLE_NODE — ${status.url} (${status.capableModels.join(", ")})`,
        );
      } else {
        console.log("[LocalAI] No usable local model found — staying a standard node.");
      }
      onChange(status);
    }
  };

  void probe();
  const timer = setInterval(() => void probe(), intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
