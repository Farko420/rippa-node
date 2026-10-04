/**
 * AI ENDPOINT SETTINGS — this node's own "AI Fallback Provider" configuration.
 *
 * WHY THIS EXISTS. A node that can serve inference is also a candidate to serve
 * it for OTHER nodes when their local brain is unavailable. Turning that on needs
 * three values (an endpoint URL, an active model, an embedding model), and the
 * operator has to be able to turn it back off again.
 *
 * THE BUG THIS FILE IS BUILT AROUND — "YOU CANNOT CLEAR A FIELD YOU SET".
 *
 * The settings screen validated `ai_endpoint` and `active_model` as required,
 * unconditionally. So an operator who wanted to turn the fallback OFF by
 * clearing the URL hit a client-side validation error demanding a URL and a
 * model, plus an inference test — for a feature they were in the act of
 * disabling. There was no way to reach the intended state, and the only escape
 * was to invent a plausible URL and keep a feature on that they did not want.
 *
 * The fix has two halves, and BOTH are load-bearing:
 *
 *   1. FRONTEND: skip validation entirely when the toggle is OFF (see
 *      `public/dashboard.js`). Blank is a legal answer.
 *   2. HERE: persist blank as NULL, not as "". An empty string is a VALUE —
 *      it is a URL that matches nothing, which will be picked up by a health
 *      check and reported as "configured but broken". NULL is the absence of a
 *      value, and it is the only representation that means "not configured".
 *
 * Writing "" would make this file's own `isAiEndpointConfigured()` lie, and
 * would surface as a permanently "unhealthy" node in the mesh panel.
 */

import { readConfigLenient, writeConfig, resolveAppRoot } from "../config/configManager";

/** The stored shape. Every field is nullable — null means "not configured". */
export interface AiEndpointSettings {
  /** Master switch. When false, the three values below are all forced to null. */
  ai_enabled: boolean;
  /** Base URL this node serves inference on, or null. */
  ai_endpoint: string | null;
  /** The model chosen for chat/completions, or null. */
  active_model: string | null;
  /** The model used for embeddings, or null. */
  ai_model: string | null;
}

/** The state of a node that has never been configured. */
export const DEFAULT_AI_ENDPOINT_SETTINGS: AiEndpointSettings = {
  ai_enabled: false,
  ai_endpoint: null,
  active_model: null,
  ai_model: null,
};

/**
 * Reads a possibly-missing string field as `string | null`.
 *
 * The `trim()` matters as much as the emptiness test: a field containing only
 * spaces is what a half-deleted value actually looks like on disk, and treating
 * it as a real value would resurrect the exact bug described above.
 */
/** Reads the persisted settings, normalising blanks to null. */
export function getAiEndpointSettings(): AiEndpointSettings {
  const config = readConfigLenient() as Record<string, unknown> | null;
  if (!config) return { ...DEFAULT_AI_ENDPOINT_SETTINGS };
  const enabled = config["ai_enabled"] === true;
  return {
    ai_enabled: enabled,
    // Only read the values through when the feature is ON. A half-written
    // config (feature off, URL left over from before) must not report a
    // configured endpoint.
    ai_endpoint: enabled ? optionalString(config["ai_endpoint"]) : null,
    active_model: enabled ? optionalString(config["active_model"]) : null,
    ai_model: enabled ? optionalString(config["ai_model"]) : null,
  };
}

/** True when this node is actually able to serve inference to the mesh. */
export function isAiEndpointConfigured(settings = getAiEndpointSettings()): boolean {
  return settings.ai_enabled && settings.ai_endpoint !== null;
}

/**
 * Persists the settings, applying the nullification rule.
 *
 * WHEN THE TOGGLE IS OFF, ALL THREE VALUES ARE FORCED TO NULL. This is not a
 * side effect of validation — it is the contract, and it is why the frontend is
 * allowed to submit a blank form at all. Turning the feature off must leave NO
 * residue: a stale URL in `config.json` is what makes a node look configured
 * to `isAiEndpointConfigured()` and get routed inference it cannot serve.
 *
 * The write goes through `writeConfig`, which NORMALISES rather than merges, so
 * the new fields must be carried through `normalizeConfig` (they are) or they
 * would be silently deleted on the next unrelated Setup save.
 */
export function saveAiEndpointSettings(input: Partial<AiEndpointSettings>): AiEndpointSettings {
  const enabled = input.ai_enabled === true;
  const next: AiEndpointSettings = {
    ai_enabled: enabled,
    // The forced-null branch is the bug fix. The enabled branch still trims,
    // so a whitespace-only URL is stored as null rather than as a broken value.
    ai_endpoint: enabled ? optionalString(input.ai_endpoint) : null,
    active_model: enabled ? optionalString(input.active_model) : null,
    ai_model: enabled ? optionalString(input.ai_model) : null,
  };

  const stored = readConfigLenient() as Record<string, unknown> | null;
  writeConfig(resolveAppRoot(), {
    ...(stored ?? {}),
    ai_enabled: next.ai_enabled,
    ai_endpoint: next.ai_endpoint,
    active_model: next.active_model,
    ai_model: next.ai_model,
  } as never);

  return next;
}

/**
 * Validates a settings submission. Returns the reason it was rejected, or null.
 *
 * CALLED ONLY WHEN THE FALLBACK TOGGLE IS ON, and that condition is enforced by
 * the CALLER, not here. This function assumes it is looking at a form that claims
 * to be enabling the feature; deciding whether validation applies at all is a
 * UI-state question, and burying it here would invite a future caller to
 * validate a form that was meant to be skipped.
 */
export function validateAiEndpointSettings(input: {
  ai_endpoint?: unknown;
  active_model?: unknown;
}): string | null {
  const endpoint = optionalString(input.ai_endpoint);
  if (!endpoint) return "An inference endpoint URL is required to enable the fallback provider.";
  // Rejects "example.com" as well as "javascript:..." — a fallback provider
  // that other nodes will POST real payloads to must be an explicit http(s)
  // origin, and the UI shows this message verbatim when it refuses.
  if (!/^https?:\/\/[^/\s]+/i.test(endpoint)) {
    return "The endpoint must be an http(s) URL, for example http://127.0.0.1:11434.";
  }
  if (!optionalString(input.active_model)) {
    return "An active model name is required to enable the fallback provider.";
  }
  return null;
}
function optionalString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}