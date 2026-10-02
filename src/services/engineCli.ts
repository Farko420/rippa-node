/**
 * THE ENGINE TERMINAL CLI — what the Control Center's `$` prompt executes.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  THE ENTIRE SECURITY MODEL OF THIS FILE IS ONE SENTENCE:
 *  NO OPERATOR INPUT EVER REACHES A SHELL, A `spawn`, OR AN `exec`.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The input is matched against a fixed set of literal patterns and the ARGUMENT is
 * validated against a character allow-list. `ollama pull <model>` looks like a shell
 * command, and it is tempting to implement it with `child_process.exec` — which would
 * hand anyone who can reach this dashboard (it is PIN-gated, but a PIN is not a
 * shell) arbitrary code execution as the user running the node, on a machine holding
 * the node's keys. Instead every command here is an HTTP call to Ollama's own
 * documented API, exactly as the rest of this codebase talks to it. There is no code
 * path from the terminal to a shell, and that is the property worth protecting.
 *
 * WHY A STRICT MODEL-NAME ALLOW-LIST EVEN THOUGH NOTHING SHELLS OUT. Ollama model
 * names are `namespace/name:tag`. Rejecting whitespace, shell metacharacters and a
 * leading dash costs nothing, removes flag-injection (`--help`, `-x`) as a class, and
 * means a future refactor that *did* introduce a shell would still refuse the
 * dangerous shapes.
 *
 * WHY THE RESULT IS LINES AND NOT A STRING. Every command's output is already pushed
 * onto the telemetry bus line by line as it happens, so a long pull streams while it
 * runs. The value returned here is the one-sentence verdict the HTTP response
 * carries; the UI reads the stream for detail and this for the final word.
 */

import axios from "axios";
import { KEEP_ALIVE } from "../agent/OllamaClient";
import { publishLine } from "./engineTelemetry";

/** Every command this terminal understands, for `help` and for error messages. */
export const ENGINE_COMMANDS = [
  "ollama ps — models currently resident in RAM/VRAM",
  "ollama list — every model installed on disk",
  "ollama pull <model> — download a model (needs the padlock unlocked)",
  "ollama restart — stop and relaunch the local Ollama server (needs the padlock)",
  "test-infer — send a dummy prompt and report tokens/sec",
  "help — list these commands",
] as const;

/** Model names are `namespace/name:tag`. Nothing else is accepted. */
const SAFE_MODEL = /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,79}(?::[a-zA-Z0-9._-]{1,40})?$/;

/** Commands that change the engine's state, and therefore need the padlock. */
const MUTATING = ["ollama pull", "ollama restart"];

/** How long the dummy inference may take. A ping that hangs is itself the answer. */
const TEST_TIMEOUT_MS = 120_000;

export interface CliResult {
  ok: boolean;
  /** One-sentence verdict, also pushed to the terminal. */
  message: string;
}

export interface EngineCliDeps {
  /** Loopback origin of the local Ollama server, e.g. http://127.0.0.1:11434. */
  origin: string;
  /** True when the operator has unlocked manual overrides in the Control Center. */
  isUnlocked(): boolean;
  /** Stops and relaunches the managed child (or reports that there is none). */
  restart(): Promise<void>;
  /** Streams a model pull, reporting progress to the terminal as it goes. */
  pull(model: string): Promise<{ ok: boolean; message: string }>;
}

/**
 * Pulls model rows out of an Ollama list response body.
 *
 * `/api/ps` answers `{"models":[…]}` on current Ollama builds and `{"data":[…]}`
 * on older ones; `/api/tags` uses `models` but has used both. The FIRST argument is
 * the response BODY (axios's `response.data`), which is precisely the distinction
 * the health probe initially got wrong — see readOllamaModels in ollamaManager.ts
 * for the full account.
 */
function readModelRows(body: unknown): Record<string, unknown>[] {
  const envelope = (body ?? {}) as { models?: unknown; data?: unknown };
  const rows = Array.isArray(envelope.models) ? envelope.models : envelope.data;
  return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
}

/** Renders rows as a left-aligned text table with a header. Terminal-friendly. */
function table(headers: string[], rows: string[][]): string[] {
  if (rows.length === 0) return ["  (none)"];
  const widths = headers.map((header, column) =>
    Math.max(header.length, ...rows.map((row) => (row[column] ?? "").length)),
  );
  const line = (cells: string[]): string =>
    "  " + cells.map((cell, column) => (cell ?? "").padEnd(widths[column])).join("  ").trimEnd();
  return [line(headers), line(widths.map((width) => "-".repeat(width))), ...rows.map(line)];
}

/** Human byte size, since Ollama reports raw counts and neither of us cares. */
function formatBytes(bytes: unknown): string {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return "-";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(size >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

/** Validates a model argument, or explains why it was refused. */
function readModelArgument(
  argument: string,
): { ok: true; model: string } | { ok: false; message: string } {
  const model = argument.trim();
  if (!model) return { ok: false, message: "Which model? e.g. ollama pull qwen2.5:1.5b" };
  if (!SAFE_MODEL.test(model)) {
    return {
      ok: false,
      message: `"${model.slice(0, 40)}" is not a valid model name (expected namespace/name:tag).`,
    };
  }
  return { ok: true, model };
}
/**
 * Executes one terminal command.
 *
 * Never throws: every failure becomes an `ok: false` result plus a line in the
 * terminal, which is where the operator is looking and where they will look again.
 */
export async function runEngineCommand(raw: string, deps: EngineCliDeps): Promise<CliResult> {
  const input = String(raw ?? "").trim();
  if (!input) return { ok: false, message: "Type a command. Try `help`." };

  // Normalised for matching; the ORIGINAL argument keeps its case (model tags and
  // namespaces are case-sensitive) and is validated separately.
  const lower = input.toLowerCase();
  publishLine("cmd", `$ ${input}`);

  const fail = (message: string): CliResult => {
    publishLine("err", message);
    return { ok: false, message };
  };

  try {
    if (lower === "help" || lower === "?") {
      for (const line of ENGINE_COMMANDS) publishLine("out", line);
      return { ok: true, message: `${ENGINE_COMMANDS.length} commands available.` };
    }

    /*
      THE PADLOCK. Read-only commands work while the node is in autonomic control;
      anything that changes engine state requires the same explicit unlock that
      /api/ollama/managed and /api/ollama/override already require. A terminal in the
      dashboard must not become a back door around a control the panel enforces two
      buttons away — that would make the padlock decorative.
    */
    const mutating = MUTATING.some(
      (command) => lower === command || lower.startsWith(`${command} `),
    );
    if (mutating && !deps.isUnlocked()) {
      return fail("Locked — unlock the padlock above before changing the engine.");
    }

    if (lower === "ollama ps") {
      const { data } = await axios.get(`${deps.origin}/api/ps`, { timeout: 5_000, proxy: false });
      const entries = readModelRows(data);
      if (entries.length === 0) {
        // Normal, not an error: KEEP_ALIVE is 60s, so an idle engine holds nothing.
        publishLine("out", "  No models resident (weights unload 60s after the last request).");
        return { ok: true, message: "No models currently loaded." };
      }
      const rows = entries.map((entry: Record<string, unknown>) => [
        String(entry.name ?? "?"),
        String(entry.size_vram ?? entry.size ?? "?"),
        formatBytes(entry.size_vram),
        String(entry.expires_at ?? "-"),
      ]);
      for (const line of table(["MODEL", "SIZE", "VRAM", "EXPIRES"], rows)) publishLine("out", line);
      return { ok: true, message: `${entries.length} model(s) resident.` };
    }

    if (lower === "ollama list") {
      const { data } = await axios.get(`${deps.origin}/api/tags`, { timeout: 5_000, proxy: false });
      const entries = readModelRows(data);
      if (entries.length === 0) {
        publishLine("out", "  No models installed. Try: ollama pull qwen2.5:1.5b");
        return { ok: true, message: "No models installed." };
      }
      const rows = entries.map((entry: Record<string, unknown>) => [
        String(entry.name ?? "?"),
        formatBytes(entry.size),
        String(entry.modified_at ?? "-").slice(0, 19).replace("T", " "),
      ]);
      for (const line of table(["MODEL", "SIZE", "MODIFIED"], rows)) publishLine("out", line);
      return { ok: true, message: `${entries.length} model(s) installed.` };
    }

    if (lower.startsWith("ollama pull")) {
      const parsed = readModelArgument(input.slice("ollama pull".length));
      if (!parsed.ok) return fail(parsed.message);
      const result = await deps.pull(parsed.model);
      return result.ok ? { ok: true, message: result.message } : fail(result.message);
    }

    if (lower === "ollama restart") {
      await deps.restart();
      publishLine("out", "✓ Ollama server restarted.");
      return { ok: true, message: "Ollama server restarted." };
    }

    if (lower === "test-infer") {
      return await testInference(deps.origin);
    }

    return fail(`Unknown command. Available:\n         ${ENGINE_COMMANDS.join("\n         ")}`);
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}
/**
 * THE DIAGNOSTIC PING — "is inference actually working?"
 *
 * Distinct from `ollama ps`, which only proves the server is up and something is
 * loaded. This proves the whole path: model resolution, prompt ingest, token
 * generation and a parseable reply. It reports tokens/sec because that is the one
 * number an operator compares when deciding whether to pull a faster model.
 *
 * A model is chosen from whatever is resident, falling back to whatever is installed.
 * Naming a model that is not present would 404 and tell the operator nothing about
 * the engine they actually have.
 */
async function testInference(origin: string): Promise<CliResult> {
  const fail = (message: string): CliResult => {
    publishLine("err", message);
    return { ok: false, message };
  };

  const load = async (path: string): Promise<string> => {
    try {
      const { data } = await axios.get(`${origin}${path}`, { timeout: 5_000, proxy: false });
      const first = readModelRows(data)[0] as { name?: unknown } | undefined;
      return typeof first?.name === "string" ? first.name : "";
    } catch {
      return "";
    }
  };
  // Resident first, installed second: naming a model that is not present would 404
  // and tell the operator nothing about the engine they actually have.
  const model = (await load("/api/ps")) || (await load("/api/tags"));
  if (!model) {
    return fail("No model is available to test. Pull one first: ollama pull qwen2.5:1.5b");
  }

  publishLine("out", `pinging ${model} …`);
  const started = Date.now();
  try {
    const { data } = await axios.post<{
      response?: string;
      eval_count?: number;
      eval_duration?: number;
      total_duration?: number;
    }>(
      `${origin}/api/generate`,
      { model, prompt: "Reply with the single word: pong", stream: false, keep_alive: KEEP_ALIVE },
      { timeout: TEST_TIMEOUT_MS, proxy: false },
    );

    const tokens = Number(data?.eval_count ?? 0);
    const evalSeconds = Number(data?.eval_duration ?? 0) / 1e9;
    const wallMs = Date.now() - started;
    if (tokens <= 0) return fail("The model replied but reported no tokens generated.");

    const tokensPerSecond = evalSeconds > 0 ? tokens / evalSeconds : 0;
    const reply = String(data?.response ?? "").trim().replace(/\s+/g, " ").slice(0, 80);
    publishLine("out", `✓ ${reply}`);
    publishLine("out", `${tokens} tokens in ${evalSeconds.toFixed(2)}s — ${tokensPerSecond.toFixed(1)} tok/s`);
    publishLine("out", `wall clock ${wallMs}ms (includes model load if it was cold)`);
    return {
      ok: true,
      message: `Inference OK — ${tokensPerSecond.toFixed(1)} tok/s (${tokens} tokens, ${wallMs}ms).`,
    };
  } catch (error) {
    return fail(`Inference failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}