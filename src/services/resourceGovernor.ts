/**
 * RESOURCE GOVERNOR — prevents local nodes from monopolizing host hardware.
 *
 * The Governor manages three resource constraints:
 *   1. CONCURRENCY: Maximum number of parallel tasks the node will execute.
 *   2. CPU THREADS: Thread limit injected into Ollama API requests.
 *   3. MEMORY: Monitor and throttle when RAM usage exceeds limits.
 *
 * It supports four preset modes (auto/low/medium/high) plus custom overrides,
 * and evaluates the current limit by checking scheduled time windows.
 *
 * AUTO MODE is special: it uses the OS to detect whether the user is actively
 * using the machine. If system load is high from other apps, the node throttles
 * down to Low automatically.
 */

import os from "node:os";
import { getCpuUsage, getRamUsage } from "./telemetry";

/**
 * AUTO MODE THRESHOLD — above this whole-machine CPU load, an Auto node assumes
 * the user is actively using the machine and throttles down to Low.
 */
const AUTO_LOAD_THRESHOLD_PERCENT = 70;

/** Shape persisted in config.json under `power_config`. */
export interface PowerConfig {
  /** Current mode: 'auto' | 'low' | 'medium' | 'high' | 'custom'. */
  mode: "auto" | "low" | "medium" | "high" | "custom";
  /** Custom CPU threads (used when mode === 'custom'). */
  custom_cpu_threads?: number;
  /** Custom RAM limit in GB (used when mode === 'custom'). */
  custom_ram_gb?: number;
  /** Time-based overrides, e.g., run on High from 02:00 to 08:00. */
  schedule?: PowerSchedule[];
}

/** One time window override. */
export interface PowerSchedule {
  /** Start time, HH:MM format (24-hour). */
  start: string;
  /** End time, HH:MM format (24-hour). */
  end: string;
  /** Mode to activate during this window. */
  mode: "low" | "medium" | "high";
}

/** Current resource limits. */
export interface ResourceLimits {
  /** Max tasks to run concurrently. */
  max_concurrent_tasks: number;
  /** CPU threads to inject into Ollama requests. */
  ollama_num_threads: number;
  /** RAM limit in GB; nil means unlimited. */
  ram_limit_gb: number | null;
  /** The mode that produced these limits. */
  active_mode: "auto" | "low" | "medium" | "high" | "custom";
}

/** Presets for each power mode. */
const PRESET_LIMITS: Record<string, Omit<ResourceLimits, "active_mode">> = {
  low: {
    max_concurrent_tasks: 1,
    ollama_num_threads: 2,
    ram_limit_gb: null,
  },
  medium: {
    max_concurrent_tasks: 2,
    ollama_num_threads: Math.max(2, Math.floor(os.cpus().length / 2)),
    ram_limit_gb: null,
  },
  high: {
    max_concurrent_tasks: os.cpus().length,
    ollama_num_threads: os.cpus().length,
    ram_limit_gb: null,
  },
};

/**
 * Parses "HH:MM" into minutes since midnight.
 * Returns null if the format is invalid.
 */
function parseTimeToMinutes(timeStr: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(timeStr.trim());
  if (!match) return null;
  const hours = parseInt(match[1], 10);
  const minutes = parseInt(match[2], 10);
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/**
 * Checks if a given time (in minutes since midnight) falls within a range.
 * Handles wrap-around (e.g., 23:00 to 02:00 crossing midnight).
 */
function isTimeInRange(currentMinutes: number, startMinutes: number, endMinutes: number): boolean {
  if (startMinutes <= endMinutes) {
    // Normal range: 08:00 to 17:00
    return currentMinutes >= startMinutes && currentMinutes < endMinutes;
  } else {
    // Wrap-around: 22:00 to 04:00 (cross midnight)
    return currentMinutes >= startMinutes || currentMinutes < endMinutes;
  }
}

export class ResourceGovernor {
  private config: PowerConfig;

  constructor(config: PowerConfig) {
    this.config = config;
  }

  /**
   * Updates the configuration (called when the Mothership pushes an update).
   */
  updateConfig(config: PowerConfig): void {
    this.config = config;
  }

  /**
   * Evaluates the current resource limits based on:
   *   1. The active mode (from schedule or config.mode).
   *   2. System state (for auto mode).
   *   3. Custom overrides.
   */
  getCurrentLimits(): ResourceLimits {
    let activeMode = this.getActiveMode();

    // For auto mode, check system load and potentially downgrade to low.
    if (activeMode === "auto") {
      if (this.isSystemUnderLoad()) {
        activeMode = "low";
      } else {
        activeMode = "medium"; // Default for auto when not under load
      }
    }

    // Apply custom overrides if mode is 'custom'.
    if (activeMode === "custom") {
      return {
        max_concurrent_tasks: this.config.custom_cpu_threads ?? 1,
        ollama_num_threads: this.config.custom_cpu_threads ?? 2,
        ram_limit_gb: this.config.custom_ram_gb ?? null,
        active_mode: "custom",
      };
    }

    // Use preset limits.
    const preset = PRESET_LIMITS[activeMode];
    if (!preset) {
      // Fallback to medium if mode is somehow invalid.
      return { ...PRESET_LIMITS.medium, active_mode: "medium" };
    }

    return {
      ...preset,
      active_mode: activeMode as "low" | "medium" | "high",
    };
  }

  /**
   * Determines the active mode by checking scheduled time windows first,
   * falling back to the configured mode.
   */
  private getActiveMode(): PowerConfig["mode"] {
    if (!this.config.schedule || this.config.schedule.length === 0) {
      return this.config.mode;
    }

    const now = new Date();
    const currentMinutes = now.getHours() * 60 + now.getMinutes();

    for (const window of this.config.schedule) {
      const startMin = parseTimeToMinutes(window.start);
      const endMin = parseTimeToMinutes(window.end);

      if (startMin !== null && endMin !== null) {
        if (isTimeInRange(currentMinutes, startMin, endMin)) {
          return window.mode;
        }
      }
    }

    // No active schedule window; return the base mode.
    return this.config.mode;
  }

  /**
   * AUTO MODE: Detect if the system is under heavy load from other applications.
   *
   * Checks:
   *   1. Average CPU load across all cores.
   *   2. If average is high (>70%), assume user is actively using the machine.
   */
  private isSystemUnderLoad(): boolean {
    /*
      CROSS-PLATFORM ON PURPOSE — `os.loadavg()` WOULD BE A BUG HERE.

      The obvious implementation is `os.loadavg()[0] / cpus.length`, and it is
      silently useless on Windows, where Node reports [0, 0, 0] unconditionally:
      an Auto node on the single most common host would never once throttle, and
      the feature would look like it simply did not work. `getCpuUsage()` derives
      load from the CPU tick deltas (see services/telemetry), which is correct on
      every platform and is already sampled in the background from boot.
    */
    return getCpuUsage() >= AUTO_LOAD_THRESHOLD_PERCENT;
  }

  /**
   * Returns the current estimated CPU usage as a percentage (0-100).
   * Used by telemetry and display.
   */
  getEstimatedCpuUsage(): number {
    return getCpuUsage();
  }

  /**
   * Returns the current RAM usage as a percentage (0-100).
   */
  getRamUsagePercent(): number {
    return getRamUsage();
  }

  /**
   * Checks if current RAM usage exceeds the configured limit.
   * Returns true if memory should be freed / tasks should be paused.
   */
  isMemoryExceeded(): boolean {
    const limits = this.getCurrentLimits();
    if (limits.ram_limit_gb === null) {
      return false; // No limit set.
    }

    const totalGb = os.totalmem() / (1024 * 1024 * 1024);
    const freeGb = os.freemem() / (1024 * 1024 * 1024);
    const usedGb = totalGb - freeGb;

    return usedGb > limits.ram_limit_gb;
  }

  /**
   * Returns a human-readable description of the current mode and limits.
   */
  describe(): string {
    const limits = this.getCurrentLimits();
    const mode = limits.active_mode;
    const tasks = limits.max_concurrent_tasks;
    const threads = limits.ollama_num_threads;
    const ram = limits.ram_limit_gb ? `${limits.ram_limit_gb}GB limit` : "no RAM limit";
    return `[Governor] Mode: ${mode}, Concurrency: ${tasks} task(s), Ollama threads: ${threads}, ${ram}`;
  }
}

/**
 * Default power configuration: auto mode, no schedule.
 */
export const DEFAULT_POWER_CONFIG: PowerConfig = {
  mode: "auto",
};
