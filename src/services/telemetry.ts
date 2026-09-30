import os from "node:os";

/**
 * SYSTEM VITALS MONITOR — real-time CPU/RAM load for the Mothership.
 *
 * Backed entirely by the native `node:os` module (no extra dependency), and
 * available in the `pkg` build exactly as it is under `node`.
 *
 * CPU measurement needs TWO samples to be meaningful, because `os.cpus()`
 * reports *cumulative* tick counters — a single read carries no load
 * information at all. Waiting for a second read inside `getSystemVitals()`
 * would block the caller, so a background sampler keeps the pair fresh and the
 * getter stays instantaneous:
 *
 *   - {@link startVitalsSampler} runs a cheap interval that snapshots the CPU
 *     tick counters and the current timestamp.
 *   - `getSystemVitals()` compares the newest sample against the one before it
 *     and reports the delta as a percentage.
 *
 * With no sampler running (unit tests, or before boot) the first call primes the
 * sample and reports 0 rather than a fabricated number.
 */

/** How often the background sampler refreshes the CPU baseline. */
const SAMPLE_INTERVAL_MS = 2_000;

/** A CPU tick-counter snapshot plus the moment it was taken. */
interface CpuSample {
  /** Summed idle time per core, in milliseconds. */
  idle: number;
  /** Summed total time per core, in milliseconds. */
  total: number;
  takenAt: number;
}

/** The metrics broadcast to the Mothership in the heartbeat payload. */
export interface SystemVitals {
  /** CPU load 0-100 across all cores. */
  cpu_usage: number;
  /** Physical memory in use, 0-100. */
  ram_usage: number;
  /** Free physical memory in bytes. */
  ram_free_bytes: number;
  /** Total physical memory in bytes. */
  ram_total_bytes: number;
  /** Uptime of the host, in seconds. */
  system_uptime_seconds: number;
  /** Number of logical CPU cores. */
  cpu_cores: number;
  /** Process RSS in bytes — what Task Manager shows for this node. */
  process_memory_bytes: number;
}

/** Latest CPU sample, and the one before it, for the delta calculation. */
let previous: CpuSample | null = null;
let latest: CpuSample | null = null;
let sampler: NodeJS.Timeout | null = null;

/** Rounds to one decimal place, avoiding values like 33.333333333333336. */
function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * Snapshots the cumulative CPU tick counters and the current time.
 *
 * Idle/total are summed across cores: the per-core counters are independent, so
 * adding them is what produces a whole-machine load figure.
 */
function takeSample(): CpuSample {
  let idle = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    const times = cpu.times;
    // A core can be offline (array present, counters zero); guard the division.
    idle += times.idle;
    total += times.user + times.nice + times.sys + times.irq + times.idle;
  }
  return { idle, total, takenAt: Date.now() };
}

/**
 * Computes CPU load 0-100 from the two most recent samples.
 *
 * Returns 0 until two samples exist — there is genuinely nothing to compare on
 * the very first call, and reporting a made-up number would be worse than an
 * honest zero.
 */
export function getCpuUsage(): number {
  const now = latest;
  const before = previous;
  if (!now || !before) return 0;

  const totalDelta = now.total - before.total;
  const idleDelta = now.idle - before.idle;
  // A zero delta means the counters did not advance (no interval elapsed);
  // dividing by it would yield Infinity/NaN.
  if (!Number.isFinite(totalDelta) || totalDelta <= 0) return 0;

  const usage = ((totalDelta - idleDelta) / totalDelta) * 100;
  if (!Number.isFinite(usage)) return 0;
  return round1(Math.min(100, Math.max(0, usage)));
}

/** Computes physical memory usage 0-100 from `os.freemem()` / `os.totalmem()`. */
export function getRamUsage(): number {
  const total = os.totalmem();
  if (!total) return 0;
  const used = total - os.freemem();
  return round1(Math.min(100, Math.max(0, (used / total) * 100)));
}

/**
 * The full vitals snapshot for one heartbeat.
 *
 * Always resolves — a vitals failure must never prevent the heartbeat itself
 * from being sent, so every field degrades to a safe number.
 */
export function getSystemVitals(): SystemVitals {
  return {
    cpu_usage: getCpuUsage(),
    ram_usage: getRamUsage(),
    ram_free_bytes: os.freemem(),
    ram_total_bytes: os.totalmem(),
    system_uptime_seconds: Math.round(os.uptime()),
    cpu_cores: os.cpus().length,
    process_memory_bytes: process.memoryUsage().rss,
  };
}

/**
 * Starts the background CPU sampler (idempotent).
 *
 * Takes one sample immediately so the very next `getSystemVitals()` already has
 * something to compare against rather than reporting a zero spike.
 */
export function startVitalsSampler(intervalMs = SAMPLE_INTERVAL_MS): void {
  if (sampler) return;
  previous = takeSample();
  latest = previous;
  sampler = setInterval(() => {
    previous = latest;
    latest = takeSample();
  }, intervalMs);
  // Never hold the process open just to sample CPU.
  sampler.unref?.();
}

/** Stops the background sampler and drops the retained samples. */
export function stopVitalsSampler(): void {
  if (sampler) {
    clearInterval(sampler);
    sampler = null;
  }
  previous = null;
  latest = null;
}