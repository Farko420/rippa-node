/**
 * NODE CAPABILITIES — "what can this node actually do?", as reported to the fleet.
 *
 * WHY THIS EXISTS. The fleet is heterogeneous, and until now a Master's Control
 * Center assumed every node was identical. It rendered one card per satellite
 * with an empty "model" slot and offered "Test Local Inference" to all of them,
 * including the Android phones (a Galaxy S26 scraper) that have no Ollama, no
 * model and no inference endpoint at all. The operator's conclusion was that
 * those nodes were broken.
 *
 * They are not broken. They are scrapers. The fleet needs to be able to say so
 * from DATA rather than from an operator's guess, which is what this module
 * produces: one small, self-describing payload that travels on the heartbeat
 * and drives every role-aware decision in the UI.
 *
 * THE THREE-WAY `ai_enabled` IS DELIBERATE, AND IS THE MOST IMPORTANT DETAIL
 * IN THIS FILE:
 *
 *   true    — the node hosts a local LLM and can serve inference.
 *   false   — the node positively reports it has NO AI runtime. Not an error.
 *   null    — the node has not said anything (an older build, or a node that has
 *             not completed its first handshake).
 *
 * Collapsing `null` into `false` would be a lie told in the safest-looking
 * direction: the UI would confidently label a node "Dedicated Scraper Node — AI
 * Disabled" when the truth is that nobody asked it yet. Every consumer must
 * therefore treat only an explicit `false` as a confirmed scraper, and must NOT
 * offer inference actions for `false` OR `null` (both cannot serve inference, but
 * for different reasons, and only one of them is a known fact).
 */

import { runtimeCapabilities, supportsBrowserScraping } from "../platform";

/**
 * What a node reports about itself on every heartbeat.
 *
 * Kept deliberately small. This rides the hot polling path (every 10s per node)
 * into a registry that is persisted to `config.json` on disk, so every field
 * here is one an operator has to look at when a saved registry is wrong.
 */
export interface NodeCapabilities {
  /**
   * Tri-state, see the file header. `undefined` is normalised to `null` so the
   * JSON on the wire and the field on disk always agree.
   */
  aiEnabled?: boolean | null;
  /** Model names this node can serve. Empty unless `aiEnabled === true`. */
  aiModels?: string[];
  /** Human-readable runtime, e.g. "Android WebView" or "Node (platform=win32)". */
  runtime?: string;
  /** How this node scrapes, e.g. "Lightweight Fetch" or "Headless Chromium". */
  scrapingMode?: string;
}

/**
 * Coerces anything into a tri-state AI flag.
 *
 * `undefined`, `null` and any non-boolean become `null` (unknown) rather than
 * `false`. This is the single place that decision is made, so a stray
 * `ai_enabled: 0` from a JSON body cannot be read as a confident "no AI here".
 */
export function normaliseAiEnabled(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

/** Keeps only non-empty, trimmed strings; drops anything else. */
function modelList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const name = entry.trim();
    // An empty string in this list would render as a blank chip in the UI, which
    // is exactly the "empty model slot" this whole module exists to eliminate.
    if (name) seen.add(name);
  }
  return [...seen];
}
/**
 * Builds this node's own capability payload as a NON-AI node.
 *
 * Called by the satellite just before it posts a heartbeat, so the Master never
 * has to guess and never has to probe a node it may not even be able to reach.
 *
 * No `models` argument: importing the Ollama manager here would drag
 * `node:child_process` into the WebView bundle, which
 * `scripts/build-mobile-worker.mjs` hard-fails on. The AI variant below takes
 * its models from the caller, which on desktop is the manager itself.
 */
export function describeCapabilities(): NodeCapabilities {
  const caps = runtimeCapabilities();
  return {
    aiEnabled: false,
    aiModels: [],
    runtime: caps.isMobile ? runtimeLabel(caps.isAndroid) : caps.description,
    scrapingMode: supportsBrowserScraping() ? "Headless Chromium" : "Lightweight Fetch",
  };
}

/**
 * The AI half of a capability payload, for a node that DOES host a model.
 *
 * Split from {@link describeCapabilities} because the two cases have opposite
 * defaults: a desktop node with a running Ollama is an AI Brain, while a node
 * that has no local runtime is a scraper. Building the AI payload separately
 * keeps that distinction impossible to get backwards at a call site.
 */
export function describeAiCapabilities(models: string[]): NodeCapabilities {
  const base = describeCapabilities();
  // `aiEnabled` is re-asserted AFTER the spread on purpose. `describeCapabilities`
  // returns the scraper default of `false`, so spreading it last would silently
  // downgrade a perfectly good AI node to "AI disabled" — the exact bug Epic 1
  // exists to fix, reintroduced one layer down.
  return { ...base, aiEnabled: true, aiModels: modelList(models) };
}

/**
 * The runtime label with the operator-facing wording.
 *
 * "webview (platform=webview, mobileBridge=android)" is a diagnostic string for
 * a log file. A fleet card has room for three words, and "Android WebView" is
 * what makes a Galaxy S26 immediately legible as "phone, not a server".
 */
function runtimeLabel(isAndroid: boolean): string {
  return isAndroid ? "Android WebView" : "Mobile WebView";
}

/** Merges a heartbeat's capability payload onto a stored one, field by field. */
export function mergeCapabilities(
  stored: NodeCapabilities,
  incoming: NodeCapabilities,
): NodeCapabilities {
  return {
    aiEnabled: normaliseAiEnabled(incoming.aiEnabled ?? stored.aiEnabled),
    aiModels: modelList(incoming.aiModels ?? stored.aiModels),
    runtime: (incoming.runtime ?? stored.runtime ?? "") || undefined,
    scrapingMode: (incoming.scrapingMode ?? stored.scrapingMode ?? "") || undefined,
  };
}

/** An empty payload, for a node that has never reported. */
export function emptyCapabilities(): NodeCapabilities {
  return { aiEnabled: null, aiModels: [], runtime: "", scrapingMode: "" };
}