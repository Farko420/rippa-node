import type { PowerConfig } from "./resourceGovernor";

/**
 * POWER CONFIG SYNC — the Remote Config half of the Resource Governor.
 *
 * A LEAF MODULE, deliberately, for the same reason ./meshKeySync is one: the
 * heartbeat reply carries several independent directives (a release to install,
 * a mesh-key rotation, queued work, and now a power config), and burying each
 * parser inside `SwarmClient` is how they become impossible to test in
 * isolation and easy to regress one at a time. The parser reads a plain object
 * and returns either a validated config or `null`, so a heartbeat that carries
 * no directive costs one property read.
 *
 * The Mothership MAY send the field under either spelling — `power_config`
 * (snake_case, matching the rest of the swarm wire contract) or `powerConfig`
 * (camelCase, matching this codebase) — because the two sides are separate
 * deployments and an operator must not have to remember which applies where.
 */

/**
 * Invoked when the Mothership pushes a power configuration.
 *
 * Wired by index.ts to the Orchestrator (which applies it) and to
 * configManager (which persists it). Fire-and-forget on the heartbeat path, so
 * a throwing handler must never mark a healthy heartbeat as failed.
 */
export type PowerConfigHandler = (pushed: PushedPowerConfig) => void | Promise<void>;

/**
 * A pushed config plus the DESIRED STAMP that came with it.
 *
 * THE STAMP IS THE WHOLE DEVICE-SHADOW CONTRACT. The node echoes it back on
 * every heartbeat as `power_config_applied_at`, and the Mothership stops
 * re-sending the moment the echo matches what it holds. The node never parses
 * it — it is an opaque token echoed verbatim — so no clock synchronisation is
 * required between the two machines.
 *
 * `stamp` is null when the Mothership sent a config without one (an older
 * cloud, or a hand-crafted reply). A node can still apply the config in that
 * case; it simply cannot help the cloud decide it is in sync, which is the
 * honest limitation rather than a reason to reject the config.
 */
export interface PushedPowerConfig {
  config: PowerConfig;
  stamp: string | null;
}

/** The modes the Governor understands. Anything else is refused. */
const POWER_MODES = ["auto", "low", "medium", "high", "custom"] as const;

/** A well-formed `HH:MM` 24-hour clock time. */
const TIME_PATTERN = /^\d{1,2}:\d{2}$/;

/**
 * Extracts a power configuration from a heartbeat reply (or any object).
 *
 * Returns `null` when the reply carries no directive — the normal case for
 * almost every heartbeat — or when a directive is present but unusable. An
 * unknown mode is REFUSED rather than coerced: guessing would silently change a
 * machine's behaviour and hide the mistake that caused it.
 */
export function parsePowerConfig(payload: unknown): PushedPowerConfig | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const root = payload as Record<string, unknown>;

  const config = root["power_config"] ?? root["powerConfig"];
  if (!config || typeof config !== "object" || Array.isArray(config)) return null;

  const cfg = config as Record<string, unknown>;
  const mode = cfg["mode"];
  if (typeof mode !== "string" || !(POWER_MODES as readonly string[]).includes(mode)) {
    return null;
  }

  const schedule = parseSchedule(cfg["schedule"]);
  const threads = Number(cfg["custom_cpu_threads"]);
  const ram = Number(cfg["custom_ram_gb"]);

  // The DESIRED stamp, echoed to the cloud so it knows the node caught up.
  // Bounded and trimmed, but never parsed — see PushedPowerConfig.
  const rawStamp = root["power_config_updated_at"] ?? root["powerConfigUpdatedAt"];
  const stamp = typeof rawStamp === "string" && rawStamp.trim() ? rawStamp.trim().slice(0, 64) : null;

  return {
    config: {
      mode: mode as PowerConfig["mode"],
      ...(Number.isFinite(threads) && threads > 0 ? { custom_cpu_threads: Math.floor(threads) } : {}),
      ...(Number.isFinite(ram) && ram > 0 ? { custom_ram_gb: Math.floor(ram) } : {}),
      ...(schedule.length > 0 ? { schedule } : {}),
    },
    stamp,
  };
}

/**
 * Keeps only usable schedule windows.
 *
 * A window with an unparseable time is DROPPED, not repaired — the Governor
 * would ignore it anyway, and a window that silently meant something other than
 * what the operator wrote is worse than one that is plainly absent.
 */
function parseSchedule(value: unknown): NonNullable<PowerConfig["schedule"]> {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object")
    .map((entry) => ({
      start: typeof entry["start"] === "string" ? entry["start"] : "",
      end: typeof entry["end"] === "string" ? entry["end"] : "",
      mode: (typeof entry["mode"] === "string" ? entry["mode"] : "low") as "low" | "medium" | "high",
    }))
    .filter((entry) => TIME_PATTERN.test(entry.start) && TIME_PATTERN.test(entry.end));
}
