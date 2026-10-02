/**
 * ENGINE TELEMETRY — the bus behind the Control Center's two live panels.
 *
 * WHY A SEPARATE BUS FROM `nodeEvents`. That module retains the LATEST event per
 * kind, because its job is putting an overlay up for something that happened while
 * the operator was away. A terminal is the opposite: it is an ordered stream where
 * line 40 is worthless without lines 1-39, and retaining "the latest log line" is
 * meaningless. Mixing the two would either lose the scrollback or pollute the
 * overlay channel with every scraper navigation.
 *
 * WHY SSE AND NOT WEBSOCKET, ON THE FRONTEND TOO. `GET /api/engine/stream` is
 * one-directional — the browser only ever listens; commands go back over ordinary
 * POSTs. SSE gets automatic reconnection for free, survives reverse proxies as plain
 * HTTP, and needs no dependency in an exe built with `pkg` and frozen. A WebSocket
 * server would add a real runtime dependency to buy nothing.
 *
 * EVERYTHING HERE IS BEST-EFFORT. This module sits on the scrape and inference hot
 * paths, so no function in it throws — see the catch in {@link publish}.
 */

/** Where a terminal line came from. The UI colours each differently. */
export type EngineLineStream = "stdout" | "stderr" | "cmd" | "out" | "err";

export interface EngineLine {
  seq: number;
  stream: EngineLineStream;
  text: string;
  at: string;
}

/** A single step of a scrape, rendered as a live crawl stream. */
export type ScrapeEventKind =
  | "launch"
  | "navigate"
  | "status"
  | "extract"
  | "error"
  | "close"
  | "idle";

export interface ScrapeEvent {
  seq: number;
  kind: ScrapeEventKind;
  /** Human sentence, already formatted for the terminal-style list. */
  message: string;
  url?: string;
  at: string;
}

/** The latest headless-Chromium visual. Held as a data URL; never persisted. */
export interface ViewportFrame {
  /** `data:image/jpeg;base64,…` */
  dataUrl: string;
  title: string;
  url: string;
  at: string;
}

/**
 * Engine health, derived from a real probe rather than from what the node hopes is
 * true. `ready` is deliberately about REACHABILITY; `modelLoaded` is reported
 * separately because Ollama unloads weights from VRAM 60s after a request (see
 * KEEP_ALIVE), so "nothing resident" is normal between jobs and must NOT paint red.
 */
export interface EngineHealth {
  state: "ready" | "busy" | "pulling" | "offline";
  /** HTTP status from /api/tags, or null when the port did not answer at all. */
  httpStatus: number | null;
  /** Round-trip time of the probe. */
  latencyMs: number | null;
  /** True when /api/ps reports at least one resident model. */
  modelLoaded: boolean;
  /** Model names currently resident in RAM/VRAM. */
  loadedModels: string[];
  /** Every model installed on disk. */
  installedModels: string[];
  /** One short sentence for the badge's tooltip. */
  detail: string;
  at: string;
}

/** A frame of anything. One union so the SSE writer has a single shape. */
export type TelemetryFrame =
  | ({ type: "line" } & EngineLine)
  | ({ type: "scrape" } & ScrapeEvent)
  | ({ type: "viewport" } & ViewportFrame)
  | ({ type: "health" } & EngineHealth)
  | {
      type: "hello";
      lines: EngineLine[];
      scrapes: ScrapeEvent[];
      viewport: ViewportFrame | null;
      health: EngineHealth | null;
    };

/**
 * Buffer caps.
 *
 * A dashboard is a window onto a recent history, not a log archive. 300 lines is
 * roughly a screenful and a half of scrollback; beyond that the memory cost is real
 * and an operator has already scrolled past it.
 */
const LINE_LIMIT = 300;
const SCRAPE_LIMIT = 80;

type Listener = (frame: TelemetryFrame) => void;

const listeners = new Set<Listener>();
const lines: EngineLine[] = [];
const scrapes: ScrapeEvent[] = [];
let viewport: ViewportFrame | null = null;
let health: EngineHealth | null = null;
let nextSeq = 1;
/**
 * In-flight work, with a hard expiry.
 *
 * WHY THE EXPIRY IS LOAD-BEARING. `busy` and `pulling` are set when work STARTS and
 * cleared when it finishes. If the work throws in a way that skips the clear — or the
 * node is killed mid-inference — a naive flag would leave the badge spinning "BUSY"
 * forever on a node that is idle and healthy. Every marker therefore carries its own
 * deadline and is ignored once it passes, so the badge is correct again without
 * anything having to run a recovery path.
 */
let activity: { kind: "busy" | "pulling"; label: string; until: number } | null = null;

/** Subscribes to telemetry frames. Returns an unsubscribe function. */
export function subscribeTelemetry(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * True when at least one dashboard is listening.
 *
 * This gates the genuinely expensive work — capturing a Chromium screenshot costs a
 * render and a JPEG encode. A node running overnight with nobody watching must not
 * pay for it, so the capture is skipped entirely rather than captured and dropped.
 */
export function hasSubscribers(): boolean {
  return listeners.size > 0;
}

/** Fans a frame out to every listener. Never throws, by design. */
function publish(frame: TelemetryFrame): void {
  for (const listener of listeners) {
    try {
      listener(frame);
    } catch {
      // One wedged dashboard connection must not stop the others.
    }
  }
}

/** Appends to a capped ring buffer and returns the newest entry. */
function push<T>(buffer: T[], item: T, limit: number): T {
  buffer.push(item);
  if (buffer.length > limit) buffer.splice(0, buffer.length - limit);
  return item;
}

/** Records one terminal line and pushes it to every listener. */
export function publishLine(stream: EngineLineStream, text: string): EngineLine | null {
  const clean = String(text ?? "").replace(/\s+$/, "");
  if (!clean) return null; // blank lines from a piped process are noise, not news
  const line = push(
    lines,
    { seq: nextSeq++, stream, text: clean.slice(0, 2_000), at: new Date().toISOString() },
    LINE_LIMIT,
  );
  publish({ type: "line", ...line });
  return line;
}

/** Records one scrape step and pushes it to every listener. */
export function publishScrape(kind: ScrapeEventKind, message: string, url?: string): ScrapeEvent | null {
  const event = push(
    scrapes,
    { seq: nextSeq++, kind, message: String(message ?? "").slice(0, 500), url, at: new Date().toISOString() },
    SCRAPE_LIMIT,
  );
  publish({ type: "scrape", ...event });
  return event;
}

/** Replaces the latest viewport frame. Only the newest one is ever kept. */
export function publishViewport(frame: Omit<ViewportFrame, "at">): void {
  viewport = { ...frame, at: new Date().toISOString() };
  publish({ type: "viewport", ...viewport });
}

/** Replaces the latest health reading. */
export function publishHealth(reading: EngineHealth): void {
  health = reading;
  publish({ type: "health", ...reading });
}

/**
 * Marks the engine as doing something.
 *
 * @param kind  "busy" while generating, "pulling" while downloading weights.
 * @param label Shown in the terminal, e.g. the model being pulled.
 * @param ttlMs How long the mark is honoured if the work never clears it.
 */
export function noteEngineActivity(kind: "busy" | "pulling", label: string, ttlMs = 120_000): void {
  activity = { kind, label, until: Date.now() + ttlMs };
}

/** Clears any activity mark. Safe to call when nothing was marked. */
export function clearEngineActivity(): void {
  activity = null;
}

/** The live activity mark, or null once it has expired. */
export function currentEngineActivity(): { kind: "busy" | "pulling"; label: string } | null {
  if (!activity) return null;
  if (Date.now() >= activity.until) {
    activity = null;
    return null;
  }
  return { kind: activity.kind, label: activity.label };
}

/** The newest N terminal lines, oldest first — what a joining dashboard replays. */
export function recentLines(limit = LINE_LIMIT): EngineLine[] {
  return lines.slice(-limit);
}

/** The newest N scrape events, oldest first. */
export function recentScrapes(limit = SCRAPE_LIMIT): ScrapeEvent[] {
  return scrapes.slice(-limit);
}

/** The latest viewport frame, or null when Chromium has not rendered one yet. */
export function latestViewport(): ViewportFrame | null {
  return viewport;
}

/** The latest health reading, or null before the first probe completes. */
export function latestHealth(): EngineHealth | null {
  return health;
}

/** The `hello` frame: everything a newly-connected dashboard needs to paint itself. */
export function backlog(): TelemetryFrame {
  return { type: "hello", lines: recentLines(), scrapes: recentScrapes(), viewport, health };
}

/** Clears all state. Used by tests. */
export function resetTelemetry(): void {
  listeners.clear();
  lines.length = 0;
  scrapes.length = 0;
  viewport = null;
  health = null;
  activity = null;
  nextSeq = 1;
}