/**
 * GHOST MODE — the listener that makes a remote "Start node" possible at all.
 *
 * THE PROBLEM THIS SOLVES. The fleet dashboard has four controls, and three of
 * them arrive on the node's own heartbeat. The fourth — START — cannot, because
 * the only moment anyone presses Start is when the node is ALREADY STOPPED, and a
 * stopped node does not poll. Under the original contract (`exit 0` ends the
 * supervisor too) the process that would have delivered that command was the
 * process that had just exited, so the Start button could never work on any
 * machine, ever.
 *
 * SO THE WATCHDOG PICKS UP THE POLL. When the node exits 0, this module takes
 * over the command queue: a bare HTTPS request every {@link GHOST_POLL_INTERVAL_MS}
 * carrying the node's own credential, and on seeing a `start` it hands control
 * back to the supervision loop.
 *
 * WHY IT IS NOT `SwarmClient`. The watchdog's design rule (see its own header) is
 * that it imports NOTHING but `node:` builtins and the exit-code contract, so it
 * cannot fail in interesting ways. `SwarmClient` pulls in the task engine's HTTP
 * client, the telemetry shapes, the brain-delta types and the whole config schema
 * — none of which a supervisor needs, and all of which would put a broken
 * dependency between "the admin pressed Stop" and "the admin cannot press Start".
 * So this speaks the same WIRE CONTRACT (bearer key, `/api/swarm/watchdog/poll`, a
 * `commands` array) using `fetch`, which is a global in the pkg runtime.
 *
 * IT CARRIES THE NODE'S CREDENTIAL, and that is a real widening of what the
 * watchdog can see. It is deliberately given only the ONE thing it needs — the
 * Mothership URL and the node API key — and it can only act on
 * {@link isGhostActionable}. See that function for why the vocabulary is one word.
 */
import { ghostPollIntervalMs, isGhostActionable } from "./exitCodes";

/** How a single ghost poll is allowed to hang before it is abandoned. */
const GHOST_POLL_TIMEOUT_MS = 10_000;

/** Where the ghost asks for commands. Mirrors the node's own routes. */
export const GHOST_POLL_PATH = "/api/swarm/watchdog/poll";

/** Everything the ghost needs, and nothing it does not. */
export type GhostConfig = {
  /** Base URL of the Mothership, e.g. `https://rippaadventures.com`. */
  mothershipUrl: string;
  /** The node's bearer credential. Never logged. */
  apiKey: string;
};

/** One command as the cloud sends it. Only `command` is ever read. */
type GhostCommand = { command?: unknown; id?: unknown };

/**
 * ONE POLL. Resolves true when a `start` was seen and the caller should boot.
 *
 * NEVER THROWS. A ghosted watchdog has no node to serve, so the only thing a failed
 * poll can cost is one missed wake-up; the alternative — an exception escaping into
 * the supervision loop — would end Ghost Mode entirely and leave the machine
 * stopped with nobody able to start it.
 */
export async function pollForStart(config: GhostConfig): Promise<boolean> {
  try {
    const base = config.mothershipUrl.replace(/\/+$/, "");
    const response = await fetch(`${base}${GHOST_POLL_PATH}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ source: "watchdog", mode: "ghost" }),
      signal: AbortSignal.timeout(GHOST_POLL_TIMEOUT_MS),
    });

    if (!response.ok) return false;
    const payload = (await response.json()) as { commands?: GhostCommand[] };
    const commands = Array.isArray(payload?.commands) ? payload.commands : [];

    return commands.some((entry) => {
      const name = typeof entry?.command === "string" ? entry.command : "";
      /*
        MATCHED THROUGH `isGhostActionable`, NEVER BY COMPARING THE WHOLE RESPONSE.
        The cloud is trusted to be honest about what it wants, not to be trusted
        about what it is allowed to make this process do — the filter is what keeps a
        bug on the Mothership from turning the supervisor into something that runs
        whatever it is handed.
      */
      return isGhostActionable(name);
    });
  } catch {
    // Offline, DNS failure, timeout, non-JSON body — all the same to us: try again in
    // 30 seconds. Deliberately silent; the watchdog log records the MODE CHANGE once,
    // not every failed poll, or a long outage fills the log with a line every 30s.
    return false;
  }
}

/**
 * THE GHOST LOOP. Resolves true the moment a `start` arrives.
 *
 * `shouldContinue` is the supervisor's stop flag, so an operator's SIGINT (or
 * `--uninstall`) still ends a ghosted watchdog immediately rather than after the
 * current poll completes. It is checked BEFORE the first sleep as well, so a
 * watchdog signalled while entering Ghost Mode does not linger for 30 seconds first.
 */
export async function waitForStartCommand(
  config: GhostConfig,
  shouldContinue: () => boolean,
  intervalMs: number = ghostPollIntervalMs(),
): Promise<boolean> {
  while (shouldContinue()) {
    if (await pollForStart(config)) return true;
    if (!shouldContinue()) break;
    await sleep(intervalMs);
  }
  return false;
}

/** Resolves after `ms`. Local so this module needs no timer import. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}