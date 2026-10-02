import { getSystemVitals, type SystemVitals } from "./telemetry";
import { publishNodeEvent } from "./nodeEvents";
import { ollamaManager } from "./ollamaManager";

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

/**
 * FLEET MANAGEMENT TASK TYPES, and why they are listed here at all.
 *
 * The Mothership expresses "Force OTA Update" and "Restart Node Service" two
 * different ways, and this file used to understand only one of them. It parsed
 * `pending_commands` (a `{command: "FORCE_UPDATE"}` array) and ignored a queue
 * entry whose `type` was `FORCE_OTA_UPDATE` or `RESTART_NODE_SERVICE` — which is
 * exactly the shape an operator's "Force Update" button produces. Those tasks
 * then fell through the orchestrator's `switch`, hit `default:`, and were
 * reported back as "no handler for type ..." — received, logged, and ignored.
 *
 * So the same names are now recognised as task types, and both spellings map onto
 * one canonical command. Keeping the allowlist as the single gate means this
 * adds no new capability: an admin command is only ever executed after matching
 * an entry that was already permitted.
 */
const ADMIN_TASK_TYPES: Readonly<Record<string, RemoteCommandName>> = {
  FORCE_UPDATE: "FORCE_UPDATE",
  FORCE_OTA_UPDATE: "FORCE_UPDATE",
  OTA_UPDATE: "FORCE_UPDATE",
  UPDATE: "FORCE_UPDATE",
  RESTART_NODE: "RESTART_NODE",
  RESTART_NODE_SERVICE: "RESTART_NODE",
  RESTART: "RESTART_NODE",
  RESTART_SERVICE: "RESTART_NODE",
  TOGGLE_P2P: "TOGGLE_P2P",
};

/**
 * Maps a task type onto an admin command, or null when it is ordinary work.
 *
 * Exported so the orchestrator can intercept an admin task BEFORE its own
 * `switch` — the interception has to happen upstream of task execution, or the
 * task is already reported as skipped by the time anyone notices what it was.
 */
export function adminCommandForTaskType(type: string | undefined): RemoteCommandName | null {
  if (!type) return null;
  return ADMIN_TASK_TYPES[String(type).trim().toUpperCase()] ?? null;
}

/** One entry from the Mothership's `pending_commands` array. */
export interface RemoteCommand {
  id?: string;
  /**
   * The id to acknowledge against, when it differs from {@link id}.
   *
   * The executor dedupes on `id`, and the Orchestrator namespaces its synthetic
   * ids (`task:<id>`) so an admin task cannot collide with a heartbeat entry of
   * the same name. That namespaced form is correct as a dedup key but WRONG as
   * something to send upstream: the Mothership filed the entry as `<id>`, so
   * acknowledging `task:<id>` would match nothing and the entry would never be
   * cleared. This carries the real id for that purpose while `id` keeps doing
   * the local bookkeeping.
   */
  ackId?: string;
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

/**
 * Embedded Ollama AI status reported on every heartbeat, so Fleet Command can
 * show — per node — whether the local server is active, what model is
 * loaded, and what task it is currently processing.
 */
export interface OllamaTelemetry {
  /** True when this node is supervising its own `ollama serve` process. */
  managed: boolean;
  /** True when the server is confirmed up and answering. */
  running: boolean;
  /** Model currently selected/loaded. */
  model: string;
  /** Port the local server is configured to serve on. */
  port: number;
  /** The task this node is actively processing, or null when idle. */
  task: string | null;
}

/** Rich telemetry broadcast with every heartbeat. */
export interface HeartbeatTelemetry extends SystemVitals {
  current_process: CurrentProcessInfo | null;
  efficiency_score: number;
  connected_satellites: string[];
  ollama: OllamaTelemetry;
}

/**
 * Hooks the host wires in so this module stays free of framework imports.
 *
 * `forceUpdate` returns whether the swap is actually committed. That matters
 * because the OTA pipeline ends in `process.exit(0)`: a handler that returned
 * nothing would make "I am about to restart" and "the update was refused" look
 * identical, and the Mothership would be told a node rebooted when it did not.
 */
export interface CommandHandlers {
  /** Gracefully stop work and exit. */
  restartNode: () => Promise<void> | void;
  /**
   * Run the OTA pipeline now (download + detached swap).
   *
   * @returns true when the command counts as APPLIED — a swap is committed (and
   *          the process is exiting), or the node is in dev mode and physically
   *          cannot swap itself. Only meaningful on paths that do NOT exit
   *          (unusable payload, refused handoff, failed download).
   */
  forceUpdate: () => Promise<boolean> | boolean | void;
  /** Enable or disable satellite-to-satellite mesh routing. */
  setP2pEnabled: (enabled: boolean) => Promise<void> | void;
  /** Reports the node's current P2P state, so TOGGLE_P2P can invert it. */
  isP2pEnabled: () => boolean;
  /**
   * Reports an admin command back to the Mothership so the queue entry is
   * retired. This is what stops an executed command being re-sent forever.
   *
   * WHY THIS IS NEEDED. An OTA update ends in `process.exit(0)` from inside the
   * handler, so anything the engine would normally report afterwards — the
   * `task_result` the engine files when `reported` is false — never runs. The
   * command was received, acted on, and the fleet was never told; from the
   * dashboard the node simply went silent and then came back, which is
   * indistinguishable from ignoring the command. The host supplies this so the
   * acknowledgement is sent BEFORE the shutdown sequence begins.
   *
   * WHY `context` CARRIES THE ID. The acknowledgement's entire purpose is to
   * clear one specific queue entry, which is impossible without its id. The
   * executor passes it here so the host can forward it verbatim to the ack
   * endpoint. It is optional so a two-argument host handler keeps working.
   */
  acknowledgeCommand?: (
    command: RemoteCommandName,
    detail: string,
    context?: {
      /** The queue entry's id, when the Mothership supplied one. */
      commandId?: string;
      /**
       * Defaults to "completed". The two shutting-down commands report
       * "in_progress" up front, because at that moment the outcome is not yet
       * knowable and claiming success would be a lie.
       */
      status?: "completed" | "failed" | "in_progress";
    },
  ) => Promise<void> | void;
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
    ollama: buildOllamaTelemetry(),
  };
}

/** Assembles the embedded-AI telemetry block from `ollamaManager`'s state. */
function buildOllamaTelemetry(): OllamaTelemetry {
  const activeTask = getCurrentProcess();
  const status = ollamaManager.getStatus(activeTask?.task ?? null);
  return {
    managed: status.managed,
    running: status.state === "running",
    model: status.model,
    port: status.port,
    task: status.task,
  };
}

/**
 * Extracts and validates the `pending_commands` array from a heartbeat reply.
 *
 * Tolerates the shapes a Mothership may send: a bare array, or
 * `{ pending_commands: [...] }`. Non-object entries and unknown commands are
 * dropped here rather than at execution time, so the executor only ever sees
 * allowlisted work.
 *
 * ALIASES MATTER HERE. The command name arrives as whatever the operator's button
 * was labelled — `FORCE_OTA_UPDATE`, `RESTART_NODE_SERVICE`, `restart` — not
 * necessarily the canonical token. The old exact-match test silently discarded
 * every one of those, which is how "Force OTA Update" reached the node and was
 * then dropped without a word. Normalising through {@link adminCommandForTaskType}
 * means the allowlist is judged on the MEANING of the command, and the allowlist
 * is still the only thing that can authorise execution.
 */
export function parsePendingCommands(payload: unknown): RemoteCommand[] {
  if (!payload || typeof payload !== "object") return [];
  const root = payload as Record<string, unknown>;
  const raw = Array.isArray(root) ? root : (root["pending_commands"] ?? root["commands"]);
  if (!Array.isArray(raw)) return [];

  const commands: RemoteCommand[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    // `command` is canonical; `type`/`action`/`name` are what several
    // Mothership builds actually send. All are resolved through the same alias
    // table so no spelling of an admin command can slip past unrecognised.
    const rawName = String(
      record["command"] ?? record["type"] ?? record["action"] ?? record["name"] ?? "",
    )
      .trim()
      .toUpperCase();
    const name = adminCommandForTaskType(rawName);
    if (!name || !COMMAND_ALLOWLIST.includes(name)) {
      console.warn(`[Heartbeat] Ignoring unknown remote command "${rawName}".`);
      continue;
    }
    commands.push({
      command: name,
      // The id is read from every spelling the Mothership realistically uses.
      // It looked cosmetic before this change, but the id is the key the
      // acknowledgement is matched on upstream: an entry filed as
      // `command_id: "c-9"` and parsed as `undefined` produced an ack the cloud
      // could not bind to anything, so the queue entry was never cleared and the
      // command came back on the next heartbeat — the loop this fixes.
      ...(commandIdFrom(record) ? { id: commandIdFrom(record) } : {}),
      ...(record["args"] && typeof record["args"] === "object"
        ? { args: record["args"] as Record<string, unknown> }
        : {}),
    });
  }
  return commands;
}

/**
 * Extracts the queue entry's id, tolerating the field names in use across
 * Mothership deployments. Returns `undefined` when none is present, which the
 * executor treats as "this entry cannot be retired upstream".
 */
function commandIdFrom(record: Record<string, unknown>): string | undefined {
  for (const key of ["id", "command_id", "commandId", "task_id", "taskId"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    // Some deployments number their queue; a number is a perfectly good id.
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return undefined;
}

/** Remembers executed command ids so a re-sent queue cannot re-fire them. */
const executedCommandIds = new Set<string>();

/**
 * Timestamp of the last "already executed" acknowledgement, per command key.
 *
 * The skip-path acknowledgement exists so a Mothership that keeps re-sending a
 * finished command is told to stop. But if its ack route is missing or broken,
 * that same re-send arrives every 30 seconds and would produce one POST per
 * heartbeat, forever — trading a log loop for a network loop. Rate-limiting to
 * one retry per {@link SKIP_ACK_THROTTLE_MS} keeps the signal alive while
 * stopping it becoming its own kind of spam, and it still retries, so a
 * transient outage heals on its own.
 */
const lastSkipAckAt = new Map<string, number>();

/** Minimum gap between "already executed" acks for the same command. */
const SKIP_ACK_THROTTLE_MS = 60_000;

/** True when remote command execution is switched off by the operator. */
function remoteCommandsEnabled(): boolean {
  return process.env.RIPPA_REMOTE_COMMANDS !== "false";
}

/**
 * Sends an admin-command acknowledgement upstream, if the host wired one up.
 *
 * Never throws: an unreachable Mothership must not prevent a command from being
 * carried out. A node that cannot reach the cloud should still update itself.
 */
async function acknowledge(
  handlers: CommandHandlers,
  command: RemoteCommandName,
  detail: string,
  context?: { commandId?: string; status?: "completed" | "failed" | "in_progress" },
): Promise<void> {
  if (!handlers.acknowledgeCommand) return;
  try {
    await handlers.acknowledgeCommand(command, detail, context);
  } catch (error) {
    console.warn(
      `[Heartbeat] Could not acknowledge ${command} upstream — ` +
        (error instanceof Error ? error.message : String(error)),
    );
  }
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
    // `RemoteCommand.command` is a plain string because it comes off the wire;
    // the allowlist gate in `parsePendingCommands` is what guarantees it is one
    // of the three allowlisted names by the time it reaches here.
    const command = entry.command as RemoteCommandName;
    const key = entry.id ?? `${entry.command}:${JSON.stringify(entry.args ?? {})}`;
    // The id sent upstream, which is the REAL queue id where one exists. See
    // `RemoteCommand.ackId` for why this is not simply `entry.id`.
    const upstreamId = entry.ackId ?? entry.id;
    const ackContext = upstreamId ? { commandId: upstreamId } : {};

    /*
      ALREADY EXECUTED — BUT STILL ACKNOWLEDGE IT.

      This is the fix for the endless "Skipping already-executed command" loop.
      The dedup set is LOCAL state: it stops the command re-running, but it is
      invisible to the Mothership, which therefore has no reason to retire the
      queue entry and re-sends it on the very next heartbeat. Skipping in silence
      guaranteed the loop could never end, no matter how many heartbeats passed.

      So the skip is reported as a completion, carrying the command id the cloud
      needs to bind the acknowledgement to the entry. The command is not re-run —
      the local guard still holds — but the cloud is now told, and stops sending.

      Rate-limited, because if the cloud's ack route is absent this re-send would
      otherwise become one POST per heartbeat indefinitely.
    */
    if (executedCommandIds.has(key)) {
      const lastAck = lastSkipAckAt.get(key) ?? 0;
      if (Date.now() - lastAck >= SKIP_ACK_THROTTLE_MS) {
        lastSkipAckAt.set(key, Date.now());
        console.log(
          `[Heartbeat] Skipping already-executed command ${key} — re-acknowledging ` +
            `so the Mothership retires it.`,
        );
        await acknowledge(handlers, command, "already executed — clearing from queue", {
          ...ackContext,
          status: "completed",
        });
      } else {
        console.log(`[Heartbeat] Skipping already-executed command ${key}.`);
      }
      continue;
    }

    // Resets the throttle so a genuinely new command reusing an id is not
    // silenced by the previous one's backoff window.
    lastSkipAckAt.delete(key);

    // Tracked so a command that already acknowledged up front (the two that end
    // in process.exit) is not acknowledged a second time on the way out.
    let acknowledgedUpFront = false;

    try {
      switch (entry.command) {
        case "RESTART_NODE":
          console.log("[Heartbeat] RESTART_NODE — shutting down gracefully.");
          // Announced BEFORE the handler runs, not after: a restart handler ends
          // in process.exit(), so anything published afterwards never reaches a
          // browser. The dashboard needs the notice while the node is still up.
          publishNodeEvent({
            kind: "admin_command",
            command: "RESTART_NODE",
            title: "Restarting Node…",
            detail: "The Mothership asked this node to restart. The service will come back automatically.",
            blocking: true,
          });
          // Restart also exits from inside its handler, so it is acknowledged up
          // front for the same reason FORCE_UPDATE is. "in_progress" rather than
          // "completed" because the node is about to go away — the outcome is not
          // knowable yet, and the id is what retires the queue entry either way.
          await acknowledge(handlers, "RESTART_NODE", "accepted — restarting the node", {
            ...ackContext,
            status: "in_progress",
          });
          acknowledgedUpFront = true;
          await handlers.restartNode();
          break;
        case "FORCE_UPDATE":
          console.log("[Heartbeat] FORCE_UPDATE — starting the OTA pipeline.");
          // Same reasoning: the overlay must appear while the download runs, not
          // after it has already finished.
          publishNodeEvent({
            kind: "admin_command",
            command: "FORCE_UPDATE",
            title: "Applying OTA Update…",
            detail:
              "Downloading the latest release, verifying it, then swapping the executable and restarting.",
            blocking: true,
          });
          /*
            ACKNOWLEDGE *BEFORE* THE SWAP, NOT AFTER.

            The OTA pipeline ends in process.exit(0) from inside the handler, so a
            report filed afterwards would never be sent. Worse, the command would
            sit in the fleet queue unacknowledged and be re-dispatched on the next
            poll, starting a second download every cycle.

            The acknowledgement is therefore sent up front, describing the update
            as accepted-and-in-progress, and the returned boolean is only used to
            correct the record on the paths that do NOT exit (an unusable payload,
            a refused handoff, a failed download) — where "accepted" would
            otherwise be a lie.

            DEV MODE IS NOT ONE OF THOSE PATHS. A node running under tsx/node
            cannot swap its own binary, so the updater deliberately reports the
            command as APPLIED anyway (see `OtaUpdater.forceUpdate`). Filing a
            failed ack there left the command re-dispatched on every heartbeat
            with nothing the node could ever do about it.
          */
          await acknowledge(handlers, "FORCE_UPDATE", "accepted — downloading the latest release", {
            ...ackContext,
            status: "in_progress",
          });
          acknowledgedUpFront = true;
          const committed = await handlers.forceUpdate();
          if (committed === false) {
            await acknowledge(
              handlers,
              "FORCE_UPDATE",
              "not applied — no swap was committed (Mothership payload unusable, download failed, or another updater owns the handoff)",
              { ...ackContext, status: "failed" },
            );
            // The record is now correct, so the generic completion ack below
            // would only contradict it.
            acknowledgedUpFront = true;
          }
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

      /*
        EVERY OTHER COMMAND IS ACKNOWLEDGED ON THE WAY OUT.

        TOGGLE_P2P previously reported nothing at all, so its queue entry was
        never retired and came back every heartbeat even though it had plainly
        been applied. Retiring the entry here — rather than only on the two
        exiting paths — is what makes the acknowledgement a general contract
        instead of a special case for the two commands that happen to restart.
      */
      if (!acknowledgedUpFront) {
        await acknowledge(handlers, command, "executed", {
          ...ackContext,
          status: "completed",
        });
      }
    } catch (error) {
      // Mark as handled even on failure: retrying a restart command forever
      // would be worse than dropping it and waiting for the operator.
      const reason = error instanceof Error ? error.message : String(error);
      console.warn(`[Heartbeat] Command ${command} failed — ${reason}`);
      executedCommandIds.add(key);

      /*
        A FAILED COMMAND IS STILL RETIRED UPSTREAM, and reported as failed.

        Leaving a failed entry in the queue would restart the same loop this
        change is fixing, on a command already known to be unrunnable here. The
        failure is recorded truthfully, so the operator sees what happened rather
        than a command that silently vanished.
      */
      await acknowledge(handlers, command, `failed — ${reason}`, {
        ...ackContext,
        status: "failed",
      });
    }
  }
  return executed;
}

/** Clears the executed-command memory (used by tests and on role change). */
export function resetExecutedCommands(): void {
  executedCommandIds.clear();
  lastSkipAckAt.clear();
}
