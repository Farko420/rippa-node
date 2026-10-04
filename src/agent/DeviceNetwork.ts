/**
 * DEVICE NETWORK POLICY — Wi-Fi vs cellular, and rolling data accounting, for
 * the Android satellite.
 *
 * WHY THIS EXISTS, AND WHY IT IS NOT A POWER FEATURE. `DevicePower.ts` already
 * answers "may I run right now?" for the battery, and the obvious thing to do
 * for a metered connection is bolt it onto that module. It is deliberately NOT
 * done there, because the two policies have opposite failure modes and combining
 * them loses the distinction an operator needs:
 *
 *   - A flat battery is a HARD stop. The node dies, and nothing is lost but time.
 *   - Cellular data is a COST stop. The node keeps working fine; it just runs up
 *     a bill. An operator who set "Wi-Fi only" wants a quiet node, not a dead
 *     one, and a dead node reads as a fault while a paused node reads as policy.
 *
 * So this module is separate, has its own verdict, and reports its own reason,
 * and the worker decides how to combine the two (see `mobile/src/worker.ts`).
 *
 * THE ENFORCEMENT POINT IS DELIBERATE. The check gates ACCEPTING work, not just
 * running it: a Wi-Fi-only node that kept polling would keep pulling tasks off
 * the Mothership queue and holding them while it refuses to execute them,
 * starving nodes that could have done the work. Pausing ingestion is therefore
 * the correct behaviour, not merely the cautious one.
 *
 * DATA ACCOUNTING IS ESTIMATED, AND SAYS SO. `navigator.connection` reports
 * transfer since the browser session began, not since the app was installed, so
 * these are rolling figures accumulated by this module across a session. They
 * are presented as "last 1 hour" / "last 24 hours" buckets computed from
 * samples the module itself records — never as lifetime carrier totals, which a
 * WebView genuinely cannot read.
 */

/** How the device is currently connected. */
export type NetworkKind = "wifi" | "cellular" | "ethernet" | "unknown";

/** The operator's chosen policy. */
export interface NetworkPolicy {
  /** True => refuse to ingest or execute work while on cellular. */
  wifiOnly: boolean;
}

/** One reading of the connection. */
export interface NetworkSnapshot {
  kind: NetworkKind;
  /** True when the platform positively reports a metered (cellular) link. */
  metered: boolean;
  /** Round-trip estimate in ms when the platform offers one. */
  downlinkMbps: number | null;
  /** Where the reading came from, so a blind panel can explain itself. */
  source: "connection-api" | "unavailable";
}

/** The operator's default: do not spend their mobile data without permission. */
export const DEFAULT_NETWORK_POLICY: NetworkPolicy = { wifiOnly: false };

/** A reading taken when the platform offers nothing. Never blocks work. */
const UNKNOWN_SNAPSHOT: NetworkSnapshot = {
  kind: "unknown",
  metered: false,
  downlinkMbps: null,
  source: "unavailable",
};

/** The verdict for one moment, plus why — the reason drives the UI banner. */
export interface NetworkVerdict {
  /** False => the worker must pause task ingestion. */
  allowed: boolean;
  /** Human-readable cause, shown verbatim in the app. */
  reason: string;
  snapshot: NetworkSnapshot;
  /** True specifically because of the Wi-Fi-only policy on a cellular link. */
  cellularRestricted: boolean;
}

/** Rolling transfer totals for the windows the dashboard shows. */
export interface DataUsage {
  /** Bytes sent within the last hour. */
  sent1h: number;
  /** Bytes received within the last hour. */
  received1h: number;
  /** Bytes sent within the last 24 hours. */
  sent24h: number;
  /** Bytes received within the last 24 hours. */
  received24h: number;
}

/** One accumulated sample, kept so the rolling windows can be recomputed. */
interface Sample {
  at: number;
  sent: number;
  received: number;
}

/** Entries retained. At one sample per check this covers 24h, in ~100 numbers. */
const MAX_SAMPLES = 1_500;

/** Merges stored settings over the defaults, coercing anything malformed. */
export function normaliseNetworkPolicy(value: unknown): NetworkPolicy {
  if (!value || typeof value !== "object") return { ...DEFAULT_NETWORK_POLICY };
  const raw = value as Record<string, unknown>;
  // Only an explicit boolean enables the restriction. A corrupt or absent value
  // must not silently ARM a policy the operator never chose — over-restricting is
  // the failure that silently costs the operator their node.
  return { wifiOnly: raw["wifiOnly"] === true };
}

/*
  THE READER.

  `navigator.connection` is the only surface a WebView exposes that distinguishes
  Wi-Fi from cellular, and it is the same object Capacitor's Network plugin would
  sit behind. Reading it defensively matters more than usual: it is absent on
  desktop browsers, renamed in older Android WebViews (`webkitConnection`), and
  can be replaced wholesale by the app — so every access is guarded and the
  conservative answer is "unknown", never "wifi".

  ASSUMING WIFI WHEN UNKNOWN WOULD DEFEAT THE FEATURE. The dangerous failure for
  a Wi-Fi-only policy is not "paused on cellular" (wasteful but safe); it is
  "reporting Wi-Fi on cellular", which would quietly spend the operator's data
  while the UI claimed it was protecting them. Unknown therefore never counts as
  permission to use cellular.
*/
export async function readNetworkSnapshot(): Promise<NetworkSnapshot> {
  try {
    const nav = (globalThis as {
      navigator?: {
        connection?: NetworkInformationLike;
        mozConnection?: NetworkInformationLike;
        webkitConnection?: NetworkInformationLike;
      };
    }).navigator;
    if (!nav) return UNKNOWN_SNAPSHOT;

    const info = nav.connection ?? nav.mozConnection ?? nav.webkitConnection ?? null;
    if (!info) return UNKNOWN_SNAPSHOT;

    // `type` is the authoritative discriminator on Android. `effectiveType`
    // ("4g") is NOT used for this decision: it describes bandwidth, not
    // transport, and an unlimited 4G plan is still cellular.
    const type = typeof info.type === "string" ? info.type.toLowerCase() : "";
    let kind: NetworkKind = "unknown";
    if (type === "wifi" || type === "ethernet") kind = type;
    else if (type === "cellular") kind = "cellular";
    else if (type === "none") kind = "unknown";

    const downlink =
      typeof info.downlink === "number" && Number.isFinite(info.downlink) ? info.downlink : null;

    return {
      kind,
      metered: type === "cellular" || type === "none",
      downlinkMbps: downlink,
      source: "connection-api",
    };
  } catch {
    return UNKNOWN_SNAPSHOT;
  }
}

/** The subset of Network Information this module relies on. */
interface NetworkInformationLike {
  type?: string;
  effectiveType?: string;
  downlink?: number;
}

/**
 * Applies the policy to a reading.
 *
 * FAIL-OPEN, mirroring `evaluatePower`. When the platform reports nothing the
 * work is ALLOWED: a WebView without `navigator.connection` would otherwise
 * refuse to work at all, which is far worse than occasionally using cellular on
 * a device whose operator never asked us to guess.
 *
 * A reading that positively says "cellular" IS honoured, so an operator on a
 * metered plan who set Wi-Fi-only genuinely gets Wi-Fi-only behaviour on every
 * device that can report its transport at all.
 */
export function evaluateNetwork(
  snapshot: NetworkSnapshot,
  policy: NetworkPolicy,
): NetworkVerdict {
  if (snapshot.source === "unavailable") {
    return { allowed: true, reason: "", snapshot, cellularRestricted: false };
  }

  if (policy.wifiOnly && snapshot.kind === "cellular") {
    return {
      allowed: false,
      reason:
        "Paused (Cellular Restricted) \u2014 Wi-Fi only is set and this device is on mobile data.",
      snapshot,
      cellularRestricted: true,
    };
  }

  return { allowed: true, reason: "", snapshot, cellularRestricted: false };
}

/**
 * A rolling transfer counter, fed by the difference between successive readings.
 *
 * WHY DIFFERENCES AND NOT RAW TOTALS. The Resource Timing API's `transferSize` is
 * monotonic for the session, so a single high reading (the page itself loading)
 * would swamp the window. Recording the DELTA each sample is what makes "last
 * hour" mean anything.
 */
export class DataUsageTracker {
  private samples: Sample[] = [];
  private lastSent = 0;
  private lastReceived = 0;
  private primed = false;

  /**
   * Records one observation. Returns the current rolling usage.
   *
   * The FIRST call only establishes a baseline and records zero bytes: the total
   * already transferred at page load belongs to loading the page, not to the node
   * working, and counting it would make a freshly-opened dashboard report several
   * megabytes the operator never spent on swarm work.
   */
  record(now: number, sent: number, received: number): DataUsage {
    if (!this.primed) {
      this.primed = true;
      this.lastSent = sent;
      this.lastReceived = received;
      this.samples.push({ at: now, sent: 0, received: 0 });
    } else {
      // Guarded against a counter reset (a navigation clears it): a negative
      // delta would otherwise subtract from the window and report a negative
      // transfer, which is worse than reporting none.
      const sentDelta = Math.max(0, sent - this.lastSent);
      const receivedDelta = Math.max(0, received - this.lastReceived);
      this.lastSent = sent;
      this.lastReceived = received;
      this.samples.push({ at: now, sent: sentDelta, received: receivedDelta });
    }
    this.prune(now);
    return this.usage(now);
  }

  /** Drops samples older than the longest window we report. */
  private prune(now: number): void {
    const cutoff = now - 24 * 3600 * 1000;
    while (this.samples.length > 1 && this.samples[0].at < cutoff) this.samples.shift();
    if (this.samples.length > MAX_SAMPLES) this.samples = this.samples.slice(-MAX_SAMPLES);
  }

  /** Sums the samples inside each reporting window. */
  usage(now: number): DataUsage {
    const hour = now - 3600 * 1000;
    const day = now - 24 * 3600 * 1000;
    let sent1h = 0;
    let received1h = 0;
    let sent24h = 0;
    let received24h = 0;
    for (const sample of this.samples) {
      if (sample.at >= hour) {
        sent1h += sample.sent;
        received1h += sample.received;
      }
      if (sample.at >= day) {
        sent24h += sample.sent;
        received24h += sample.received;
      }
    }
    return { sent1h, received1h, sent24h, received24h };
  }
}

/** Formats a byte count for the dashboard ("1.4 MB"). */
export function formatBytes(bytes: number): string {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(size >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}