import { getSystemVitals, type SystemVitals } from "./telemetry";

/**
 * HEARTBEAT TELEMETRY & REMOTE COMMAND EXECUTION.
 *
 * The Mothership heartbeat carries three things:
 *   1. a rich telemetry payload (CPU/RAM, the task in flight, the node's
 *      efficiency, and which satellites are linked peer-to-peer);
 *   2. an update advertisement (handled by the existing update-signal hook);
 *   3. a `pending_commands` queue that the Mothership uses for fleet
 *      management — restart, force-update, and P2P toggling.
 *
 * This module is deliberately separate from the heartbeat *transport*
 * (`SwarmClient`), which owns the schedule and the HTTP call. Keeping payload
 * construction and command handling here means the transport stays a thin,
 * easily testable wrapper.
 *
 * COMMAND SAFETY: executing instructions that arrive over the network is the
 * highest-risk code path in the node, so:
 *   - commands are matched against an explicit allowlist, never `eval`'d;
 *   - each command is executed once per id, so a Mothership that keeps
 *     re-sending the same queued command cannot restart the node in a loop;
 *   - `RIPPA_REMOTE_COMMANDS=false` disables the whole surface for operators
 *     who want telemetry without the ability to remotely control a machine.
 */

/** Commands the Mothership is allowed to invoke. */
export type RemoteCommandName =
  | "RESTART_NODE"
  | "FORCE_UPDATE"
  | "TOGGLE_P2P";

const COMMAND_ALLOWLIST: readonly RemoteCommandName[] = [
  "RESTART_NODE",
  "FORCE_UPDATE",
  "TOGGLE_P2P",
];

/** One entry from the Mothership's `pending_commands` array. */
export interface RemoteCommand {
  id?: string;
  command: string;
  /** Optional arguments; `TOGGLE_P2P` accepts `{ enabled: boolean }`. */
  args?: Record<string, unknown>;
}

/** The task this node is currently executing, mirrored from Task Manager. */
export interface CurrentProcessInfo {
  /** Task type/id, e.g. "scrape" or the swarm task id. */
  task: string;
  /** ISO timestamp the task started. */
  startedAt: string;
  /** Seconds elapsed on the task. */
  elapsedSeconds: number;
}

/** Rich telemetry broadcast with every heartbeat. */
export interface HeartbeatTelemetry extends SystemVitals {
  current_process: CurrentProcessInfo | null;
  efficiency_score: number;
  connected_satellites: string[];
}

/** Hooks the host wires in so this module stays free of framework imports. */
export interface CommandHandlers {
  /** Gracefully stop work and exit. */
  restartNode: () => Promise<void> | void;
  /** Run the OTA pipeline now (download + detached swap). */
  forceUpdate: () => Promise<void> | void;
  /** Enable or disable satellite-to-satellite mesh routing. */
  setP2pEnabled: (enabled: boolean) => Promise<void> | void;
  /** Reports the node's current P2P state, so TOGGLE_P2P can invert it. */
  isP2pEnabled: () => boolean;
}

/** Efficiency inputs: successful vs. total task attempts. */
export interface EfficiencyInput {
  succeeded: number;
  total: number;
}

/** The task in flight, tracked by the Orchestrator. */
let currentProcess: CurrentProcessInfo | null = null;

/** Records the task this node has started (drives `current_process`). */
export function setCurrentProcess(task: string): void {
  currentProcess = {
    task: String(task || "unknown").slice(0, 80),
    startedAt: new Date().toISOString(),
    elapsedSeconds: 0,
  };
}

/** Clears the tracked task when the node goes idle. */
export function clearCurrentProcess(): void {
  currentProcess = null;
}

/** The task in flight, or null when idle. */
export function getCurrentProcess(): CurrentProcessInfo | null {
  if (!currentProcess) return null;
  const elapsedSeconds = Math.max(
    0,
    Math.round((Date.now() - Date.parse(currentProcess.startedAt)) / 1000),
  );
  return { ...currentProcess, elapsedSeconds };
}

/**
 * Efficiency score 0-100 from successful/total task attempts.
 *
 * A node with no completed tasks reports 100 rather than 0: an empty sample is
 * not evidence of failure, and reporting 0 would make every freshly started
 * node look broken on the Mothership.
 */
export function computeEfficiencyScore(input: EfficiencyInput): number {
  if (!Number.isFinite(input.total) || input.total <= 0) return 100;
  const ratio = Math.min(1, Math.max(0, input.succeeded / input.total));
  return Math.round(ratio * 100);
}

/**
 * Assembles the telemetry block that rides along with every heartbeat.
 *
 * @param connectedSatellites node codes currently linked peer-to-peer. Resolved
 *        by the caller so this module does not depend on the swarm registry.
 * @param efficiency          the node's own success/total task counters.
 */
export function buildHeartbeatTelemetry(
  connectedSatellites: string[] = [],
  efficiency: EfficiencyInput = { succeeded: 0, total: 0 },
): HeartbeatTelemetry {
  return {
    ...getSystemVitals(),
    current_process: getCurrentProcess(),
    efficiency_score: computeEfficiencyScore(efficiency),
    connected_satellites: Array.isArray(connectedSatellites)
      ? connectedSatellites.map(String).filter(Boolean)
      : [],
  };
}

/**
 * Extracts and validates the `pending_commands` array from a heartbeat reply.
 *
 * Tolerates the shapes a Mothership may send: a bare array, or
 * `{ pending_commands: [...] }`. Non-object entries and unknown commands are
 * dropped here rather than at execution time, so the executor only ever sees
 * allowlisted work.
 */
export function parsePendingCommands(payload: unknown): RemoteCommand[] {
  if (!payload || typeof payload !== "object") return [];
  const root = payload as Record<string, unknown>;
  const raw = Array.isArray(root) ? root : root["pending_commands"];
  if (!Array.isArray(raw)) return [];

  const commands: RemoteCommand[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const name = String(record["command"] ?? "").trim().toUpperCase();
    if (!COMMAND_ALLOWLIST.includes(name as RemoteCommandName)) {
      console.warn(`[Heartbeat] Ignoring unknown remote command "${name}".`);
      continue;
    }
    commands.push({
      command: name,
      ...(typeof record["id"] === "string" && record["id"] ? { id: record["id"] } : {}),
      ...(record["args"] && typeof record["args"] === "object"
        ? { args: record["args"] as Record<string, unknown> }
        : {}),
    });
  }
  return commands;
}

/** Remembers executed command ids so a re-sent queue cannot re-fire them. */
const executedCommandIds = new Set<string>();

/** True when remote command execution is switched off by the operator. */
function remoteCommandsEnabled(): boolean {
  return process.env.RIPPA_REMOTE_COMMANDS !== "false";
}

/**
 * Executes the `pending_commands` returned by the Mothership.
 *
 * Each command is dispatched independently: one failing must not prevent the
 * rest from running. Returns the names that were executed, which the caller
 * logs for traceability.
 */
export async function executePendingCommands(
  commands: RemoteCommand[],
  handlers: CommandHandlers,
): Promise<RemoteCommandName[]> {
  if (commands.length === 0) return [];
  if (!remoteCommandsEnabled()) {
    console.warn("[Heartbeat] Remote commands received but disabled via RIPPA_REMOTE_COMMANDS=false.");
    return [];
  }

  const executed: RemoteCommandName[] = [];
  for (const entry of commands) {
    const key = entry.id ?? `${entry.command}:${JSON.stringify(entry.args ?? {})}`;
    if (executedCommandIds.has(key)) {
      console.log(`[Heartbeat] Skipping already-executed command ${key}.`);
      continue;
    }

    try {
      switch (entry.command) {
        case "RESTART_NODE":
          console.log("[Heartbeat] RESTART_NODE — shutting down gracefully.");
          await handlers.restartNode();
          break;
        case "FORCE_UPDATE":
          console.log("[Heartbeat] FORCE_UPDATE — starting the OTA pipeline.");
          await handlers.forceUpdate();
          break;
        case "TOGGLE_P2P": {
          // An explicit `enabled` argument wins; otherwise invert current state.
          const requested = entry.args?.["enabled"];
          const next =
            typeof requested === "boolean" ? requested : !handlers.isP2pEnabled();
          console.log(`[Heartbeat] TOGGLE_P2P — mesh routing ${next ? "enabled" : "disabled"}.`);
          await handlers.setP2pEnabled(next);
          break;
        }
      }
      executed.push(entry.command as RemoteCommandName);
      executedCommandIds.add(key);
    } catch (error) {
      // Mark as handled even on failure: retrying a restart command forever
      // would be worse than dropping it and waiting for the operator.
      console.warn(
        `[Heartbeat] Command ${entry.command} failed — ` +
          (error instanceof Error ? error.message : String(error)),
      );
      executedCommandIds.add(key);
    }
  }
  return executed;
}

/** Clears the executed-command memory (used by tests and on role change). */
export function resetExecutedCommands(): void {
  executedCommandIds.clear();
}
