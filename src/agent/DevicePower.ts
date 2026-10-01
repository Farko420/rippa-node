/**
 * DEVICE POWER AWARENESS — battery level, charging state and the operator's
 * limits, for the Android satellite.
 *
 * WHY THIS EXISTS. A satellite is a spare tablet left on a desk. Someone walks
 * past with it unplugged to charge their phone, and an unthrottled node will
 * happily drain the battery to 2% foraging all evening. The operator needs to
 * say "only run on mains, or above 20%, or slow down" and have the node actually
 * obey, rather than discovering a dead tablet the next morning.
 *
 * WHY IT SPEAKS TO THE CAPACITOR BRIDGE. `@capacitor/device` IS installed and
 * IS synced into the APK — that is genuinely where the battery reading comes
 * from. This module reaches it through `globalThis.Capacitor.Plugins.Device`
 * rather than an `import()`, because the package lives under
 * `mobile/node_modules` while this file is compiled by three toolchains with
 * three different resolvers (see the note on `readCapacitorDevice` for the full
 * reasoning). `navigator.getBattery()` is the fallback, and the native plugin is
 * preferred: only it reports the true charge while the screen is OFF and the
 * WebView is frozen — which is the entire reason this app exists.
 */

/** Coarse charging state, normalised across every source we read. */
export type ChargingState = "charging" | "full" | "unplugged" | "unknown";

/** One reading of the device's power state. */
export interface PowerSnapshot {
  /** Battery charge 0-100, or null when the platform refuses to say. */
  level: number | null;
  charging: boolean;
  /** True when the OS positively reports the device is on battery. */
  pluggedOut: boolean;
  state: ChargingState;
  /** Where the reading came from, so the UI can show WHY it is blind. */
  source: "capacitor-device" | "battery-status-api" | "unavailable";
}

/**
 * The operator's limits.
 *
 * `pauseBelowPercent: null` disables the low-battery rule entirely, which is
 * distinct from setting it to 0 (which would pause a device that merely reports
 * a level but is not reporting the battery at all).
 */
export interface PowerLimits {
  /** Do no work at all unless a charger is connected. */
  runOnlyWhenCharging: boolean;
  /** Suspend the swarm worker at or below this charge. null = never. */
  pauseBelowPercent: number | null;
  /** Stretch every poll interval to conserve charge. */
  throttlePolling: boolean;
}

/** Conservative defaults: honour the low-battery rule, stay usable otherwise. */
export const DEFAULT_POWER_LIMITS: PowerLimits = {
  runOnlyWhenCharging: false,
  pauseBelowPercent: 20,
  throttlePolling: false,
};

/**
 * How much to stretch poll intervals when throttling is on.
 *
 * 6x, chosen against the worker's own intervals: a 30s heartbeat becomes 3min,
 * a 15s task poll 90s and a 10s mesh poll 60s. Long enough to matter on a
 * draining cell, short enough to be useful again once replugged.
 */
export const THROTTLE_MULTIPLIER = 6;

/** A reading taken when the platform offers nothing. Never blocks work. */
const UNKNOWN_SNAPSHOT: PowerSnapshot = {
  level: null,
  charging: false,
  pluggedOut: false,
  state: "unknown",
  source: "unavailable",
};

/** The verdict for one moment, plus why — the reason drives the UI message. */
export interface PowerVerdict {
  /** False => the swarm worker must be suspended. */
  allowed: boolean;
  /** Human-readable cause, shown verbatim in the app. Empty when allowed. */
  reason: string;
  /** The snapshot the verdict came from, for the dashboard. */
  snapshot: PowerSnapshot;
}

/**
 * Reads a battery snapshot from the standard `navigator.getBattery()` API.
 *
 * Preferred over a one-shot plugin call because it is LIVE: the returned
 * `BatteryManager` fires `levelchange` / `chargingchange`, which is what lets
 * the worker resume the instant a tablet is replugged instead of waiting out a
 * poll interval. It also needs no native plugin at all, so it keeps working if
 * `npx cap sync` ever runs without `@capacitor/device` present.
 *
 * Returns null when the API is absent — common, not rare: Firefox and some
 * hardened WebViews do not implement it. Callers must treat that as "no
 * information", NEVER as "the battery is fine".
 */
async function readBatteryStatusApi(): Promise<PowerSnapshot | null> {
  try {
    const nav = (globalThis as { navigator?: { getBattery?: () => Promise<PowerManagerLike> } })
      .navigator;
    if (typeof nav?.getBattery !== "function") return null;
    const manager = await nav.getBattery();
    if (!manager) return null;

    const charging = manager.charging === true;
    return {
      level: toLevel(manager.level),
      charging,
      // Only a POSITIVE false counts as "on battery". `undefined` means the API
      // declined to answer, and treating that as unplugged would make
      // "run only when charging" suspend the node forever on a partial read.
      pluggedOut: manager.charging === false,
      state: charging ? "full" : manager.charging === false ? "unplugged" : "unknown",
      source: "battery-status-api",
    };
  } catch {
    // A WebView that exposes getBattery but throws on it is still a WebView we
    // must survive. Fall through to the next source.
    return null;
  }
}

/**
 * Reads a snapshot from the native `@capacitor/device` plugin.
 *
 * REACHED THROUGH THE BRIDGE, NOT THROUGH AN `import()`. This is deliberate and
 * load-bearing.
 *
 * `@capacitor/device` is installed under `mobile/node_modules`, but this file
 * lives in `src/` and is compiled by THREE toolchains with different resolvers:
 *
 *   - `tsc` resolves from the ROOT package, where the plugin does not exist, so
 *     `import("@capacitor/device")` fails the desktop build with TS2307;
 *   - esbuild resolves from `mobile/src/`, one level above `mobile/node_modules`,
 *     so the same specifier fails the APK build with "Could not resolve";
 *   - adding `paths` to tsconfig and an alias plugin to esbuild would fix both,
 *     at the cost of coupling the desktop build's type resolution to a package
 *     it can never actually run.
 *
 * Capacitor already publishes every registered plugin on `globalThis.Capacitor.
 * Plugins`, keyed by plugin name. `Device` is registered by `npx cap sync` from
 * the package installed in mobile/package.json — the package is genuinely
 * installed and genuinely synced, we simply speak to the bridge it registers
 * with instead of importing its thin JS wrapper. The behaviour is identical and
 * both toolchains stay honest.
 *
 * Tried FIRST because it is the only source that reports the true charge while
 * the screen is OFF and the WebView is frozen — the entire reason this app exists.
 */
async function readCapacitorDevice(): Promise<PowerSnapshot | null> {
  try {
    const bridge = (
      globalThis as {
        Capacitor?: {
          Plugins?: {
            Device?: {
              getBatteryInfo?: () => Promise<{ level?: number; charging?: boolean }>;
            };
          };
        };
      }
    ).Capacitor;
    const device = bridge?.Plugins?.Device;
    // No plugin => not synced, or a browser preview. Not an error.
    if (typeof device?.getBatteryInfo !== "function") return null;

    const info = await device.getBatteryInfo();
    if (!info) return null;
    const charging = info.charging === true;
    return {
      level: toLevel(info.level),
      charging,
      pluggedOut: info.charging === false,
      state: charging ? "charging" : "unplugged",
      source: "capacitor-device",
    };
  } catch {
    // Plugin present but the native call rejected (permission, dead bridge).
    // Fall back to the web API rather than losing power awareness entirely.
    return null;
  }
}

/**
 * Reads the current power state, trying every source in order of reliability.
 *
 * NEVER THROWS and NEVER returns null. A power check that could fail open into
 * an exception would take the whole swarm worker down at the worst possible
 * moment, so every failure collapses to UNKNOWN_SNAPSHOT.
 */
export async function readPowerSnapshot(): Promise<PowerSnapshot> {
  const fromPlugin = await readCapacitorDevice();
  if (fromPlugin) return fromPlugin;
  const fromWebApi = await readBatteryStatusApi();
  if (fromWebApi) return fromWebApi;
  return UNKNOWN_SNAPSHOT;
}
/**
 * Applies the operator's limits to a snapshot.
 *
 * FAIL-OPEN, and this is the most important property of the module.
 *
 * When the platform reports nothing (`source: "unavailable"`), work is ALLOWED.
 * The alternative — refusing to run when we cannot PROVE the battery is healthy
 * — would mean a plugin-less or desktop build silently does nothing at all,
 * which is far worse than occasionally draining a battery. The limits are
 * honoured the moment real data exists; they are never guessed at.
 */
export function evaluatePower(snapshot: PowerSnapshot, limits: PowerLimits): PowerVerdict {
  if (snapshot.source === "unavailable") {
    return { allowed: true, reason: "", snapshot };
  }

  // Ordering matters: "run only when charging" is the operator's bluntest
  // instruction, so a discharging tablet reports THAT rather than a low-battery
  // figure it may not even have. The message a user sees should name the rule
  // they actually set.
  if (limits.runOnlyWhenCharging && snapshot.pluggedOut) {
    const level = snapshot.level === null ? "unknown" : `${snapshot.level}%`;
    return {
      allowed: false,
      reason: `Paused — run only when charging; on battery at ${level}`,
      snapshot,
    };
  }

  if (
    limits.pauseBelowPercent !== null &&
    snapshot.level !== null &&
    snapshot.level <= limits.pauseBelowPercent
  ) {
    return {
      allowed: false,
      reason: `Paused — battery ${snapshot.level}% is at or below the ${limits.pauseBelowPercent}% limit`,
      snapshot,
    };
  }

  return { allowed: true, reason: "", snapshot };
}

/**
 * The multiplier to apply to poll intervals for the current state.
 *
 * Throttling is skipped while charging (1x): the operator's "save battery"
 * intent is already satisfied by a full battery, and slowing the swarm down at
 * the wall would needlessly cut throughput for no benefit.
 */
export function throttleFactor(snapshot: PowerSnapshot, limits: PowerLimits): number {
  if (!limits.throttlePolling) return 1;
  if (snapshot.charging || snapshot.source === "unavailable") return 1;
  return THROTTLE_MULTIPLIER;
}

/** Merges stored settings over the defaults, coercing anything malformed. */
export function normaliseLimits(value: unknown): PowerLimits {
  if (!value || typeof value !== "object") return { ...DEFAULT_POWER_LIMITS };
  const raw = value as Record<string, unknown>;
  const stored = raw["pauseBelowPercent"];
  const percent = stored === null || stored === undefined ? null : toLevel(stored);
  return {
    runOnlyWhenCharging: raw["runOnlyWhenCharging"] === true,
    // A non-numeric value discards the rule entirely rather than defaulting it
    // back to 20%, so a corrupt write cannot silently re-arm a limit the
    // operator had deliberately removed.
    pauseBelowPercent: percent,
    throttlePolling: raw["throttlePolling"] === true,
  };
}

/** The subset of the Battery Status API this module relies on. */
interface PowerManagerLike {
  level?: number;
  charging?: boolean;
}

/** Coerces anything to a sane 0-100 integer, or null if there is nothing usable. */
function toLevel(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, Math.round(n)));
}