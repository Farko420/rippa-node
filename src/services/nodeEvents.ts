/**
 * NODE EVENTS — the one server -> browser push channel.
 *
 * WHY THIS EXISTS. Two features need the local dashboard to react to something
 * the node decided on its own, and neither can be expressed as a response to a
 * request the browser already made:
 *
 *   1. ADMIN COMMANDS. "Force OTA Update" and "Restart Node Service" arrive on a
 *      30-second heartbeat, not on any HTTP call the browser is waiting on. The
 *      operator needs to be told the instant it happens, and the overlay must
 *      survive the tab that happens to be open.
 *   2. BRAIN SYNC PROGRESS. Ingesting a bundle takes as long as the file is big;
 *      the browser cannot learn how far along it is from a single 200 response
 *      that arrives when the work is already finished.
 *   3. COMMAND CENTER MESSAGES. The Master posts batch-analysis results back
 *      into the admin's chat thread whenever ITS OWN queue decides — again
 *      nothing the browser requested, so it comes down the same one channel.
 *
 * So the node publishes here, and `GET /api/system/events` streams it to every
 * connected dashboard over Server-Sent Events. SSE (rather than WebSocket)
 * because the traffic is one-directional, it survives proxies as plain HTTP, and
 * it re-establishes itself on reconnect with no extra code.
 *
 * THE LAST EVENT IS RETAINED PER KIND. A dashboard that opens *after* an admin
 * command arrived (which is the normal case: the operator opens the dashboard
 * after the command was sent) would otherwise never learn it happened. The
 * retained "blocking" event is replayed on connect so the overlay still appears.
 */

/** What kind of thing happened. */
export type NodeEventKind = "admin_command" | "brain_sync" | "command_center" | "info";

export interface NodeEvent {
  /** Monotonic per-process id, so a client can drop duplicates on reconnect. */
  id: number;
  kind: NodeEventKind;
  /** Machine-readable name, e.g. "FORCE_UPDATE" or "RESTART_NODE". */
  command?: string;
  /** Full-screen headline, e.g. "Applying OTA Update…". */
  title?: string;
  /** Supporting sentence shown under the headline. */
  detail?: string;
  /** 0-100 where a bar is meaningful (brain sync). */
  percent?: number;
  /** Phase label for a progress bar, e.g. "Syncing chunks…". */
  phase?: string;
  /** ISO timestamp. */
  at: string;
  /**
   * True when the UI must NOT offer a dismiss control. A restart or an OTA swap
   * is not the operator's to cancel from the browser — the node has already
   * committed to it — so the overlay stays until the page goes away.
   */
  blocking?: boolean;
}

/** Omit-on-write shape used by publishers. */
export type NodeEventInput = Omit<NodeEvent, "id" | "at"> & { at?: string };

type Listener = (event: NodeEvent) => void;

const listeners = new Set<Listener>();
/** Latest event per kind, replayed to a dashboard that connects late. */
const latest = new Map<NodeEventKind, NodeEvent>();
let nextId = 1;

/** How many retained events to keep. One per kind is enough; the cap is a guard. */
const RETAIN_LIMIT = 16;

/** Subscribes to node events. Returns an unsubscribe function. */
export function subscribeNodeEvents(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Publishes an event to every connected dashboard.
 *
 * Never throws: this runs on the heartbeat and the OTA paths, where an exception
 * escaping into `sendHeartbeat` would be reported as a failed heartbeat — a
 * successful update reported as a broken node.
 */
export function publishNodeEvent(input: NodeEventInput): NodeEvent {
  const event: NodeEvent = { ...input, id: nextId++, at: input.at ?? new Date().toISOString() };
  latest.set(event.kind, event);
  if (latest.size > RETAIN_LIMIT) {
    // Map preserves insertion order, so the first key is the oldest.
    const oldest = latest.keys().next();
    if (!oldest.done && oldest.value !== event.kind) latest.delete(oldest.value);
  }
  for (const listener of listeners) {
    try {
      listener(event);
    } catch {
      // A dead SSE connection must never break the publisher.
    }
  }
  return event;
}

/** The most recent event of a kind, or null when none has been published. */
export function latestNodeEvent(kind: NodeEventKind): NodeEvent | null {
  return latest.get(kind) ?? null;
}

/** Clears retained state (used by tests and on a role change). */
export function resetNodeEvents(): void {
  listeners.clear();
  latest.clear();
  nextId = 1;
}