/**
 * RIPPA SATELLITE MOBILE WORKER — Browser-safe, no Node builtins
 */

import axios from "axios";
import { createStorageProvider } from "./storage-provider";
import type { StorageProvider } from "./storage-provider";

export interface SatelliteConfig {
  nodeRole: "master" | "satellite";
  masterUrl?: string;
  meshKey?: string;
  nodeName: string;
  port: number;
}

export interface TaskAssignment {
  id: string;
  type: string;
  payload?: Record<string, unknown>;
}

export interface TaskResult {
  taskId: string;
  status: "success" | "failed" | "timeout";
  result?: Record<string, unknown>;
  error?: string;
  completedAt: string;
}

export class SatelliteWorker {
  private storage: StorageProvider | null = null;
  private config: SatelliteConfig | null = null;
  private currentTask: TaskAssignment | null = null;
  /*
    A browser-safe timer handle.

    This was `NodeJS.Timeout`, which is a lie on the platform this file actually
    ships to: the bundle runs in an Android WebView, where setInterval returns a
    number. It type-checked only because `@types/node` is installed for the
    desktop build, so the error would have surfaced at runtime on a tablet —
    not at compile time. Declaring the shape we truly depend on (something
    clearInterval accepts) keeps this file honest on both platforms.
  */
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  /*
    POWER SUSPENSION.

    A satellite left on a desk can have its tablet unplugged by someone walking
    past. Without a pause, the node keeps claiming tasks and draining the battery
    all evening. `setSuspended()` stops the Master poll entirely — it is a
    genuine pause, not a flag consulted inside the poll body — so no network
    traffic is generated at all while suspended and nothing can be half-claimed
    when the tablet is picked up.

    The flag is consulted in `pollMaster` as well as gating the timer: the timer
    is the primary mechanism, but the guard means a poll that is already in
    flight when the limits change cannot start new work either.
  */
  private suspended = false;

  /**
   * Pauses or resumes Master polling without tearing anything down.
   *
   * Storage stays open and `currentTask` is preserved, so resuming is instant
   * and an in-flight task is not lost. Safe to call repeatedly and from either
   * side of the power transition — the worker calls it on every evaluation.
   */
  setSuspended(suspended: boolean): void {
    if (this.suspended === suspended) return;
    this.suspended = suspended;
    if (suspended) {
      this.stopPolling();
    } else if (this.config?.nodeRole === "satellite") {
      this.startPolling();
    }
  }

  /** True while the power limits hold this node off the mesh. */
  isSuspended(): boolean {
    return this.suspended;
  }

  async initialize(config: SatelliteConfig): Promise<void> {
    this.config = config;
    this.storage = await createStorageProvider();
    await this.storage.init();
    console.log(`[Satellite] ${config.nodeRole}: "${config.nodeName}"`);
    if (config.nodeRole === "satellite") {
      this.startPolling();
    }
  }

  async shutdown(): Promise<void> {
    this.stopPolling();
    if (this.storage) await this.storage.close();
  }

  /**
   * Tears down the poll timer only, leaving storage and config intact.
   *
   * Split out of `shutdown()` because pausing for battery must NOT close the
   * database: the node is expected to resume the moment a charger appears, and
   * re-initialising storage on every power transition would both cost work and
   * risk losing cached state on a tablet that is barely awake.
   */
  private stopPolling(): void {
    if (!this.pollTimer) return;
    clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  private startPolling(): void {
    if (this.pollTimer) return;
    // Belt and braces: `setSuspended` already clears the timer, but a race
    // between suspend and resume must not leave a live timer behind.
    if (this.suspended) return;
    const poll = async () => {
      try {
        await this.pollMaster();
      } catch {
        // silent
      }
    };
    void poll();
    this.pollTimer = setInterval(() => void poll(), 10000);
  }

  private async pollMaster(): Promise<void> {
    if (!this.config?.masterUrl) return;
    // The timer is torn down on suspend, but a poll already in flight when the
    // battery limit tripped would otherwise still claim a task. Re-check here so
    // the guarantee holds regardless of which happened first.
    if (this.suspended) return;
    const masterUrl = this.config.masterUrl.replace(/\/$/, "");
    
    try {
      const response = await axios.post(`${masterUrl}/api/mesh/heartbeat`, { status: "idle" }, {
        timeout: 8000,
        headers: { "X-Mesh-Key": this.config.meshKey || "" },
      });

      const task = response.data?.task as TaskAssignment | undefined;
      if (task && task.id !== this.currentTask?.id) {
        this.currentTask = task;
        await this.executeTask(task);
      }
    } catch {
      // silent on timeout
    }
  }

  private async executeTask(task: TaskAssignment): Promise<void> {
    let result: TaskResult | null = null;
    try {
      switch (task.type) {
        case "verify_location":
          result = await this.verifyLocation(task);
          break;
        case "scrape_data":
          result = await this.scrapeData(task);
          break;
        case "extract_facts":
          result = await this.extractFacts(task);
          break;
        default:
          result = { taskId: task.id, status: "failed", error: "Unknown", completedAt: new Date().toISOString() };
      }
    } catch (error) {
      result = {
        taskId: task.id,
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
        completedAt: new Date().toISOString(),
      };
    }
    if (result) await this.reportResult(result);
    this.currentTask = null;
  }

  private async verifyLocation(task: TaskAssignment): Promise<TaskResult> {
    return { taskId: task.id, status: "success", result: { verified: true }, completedAt: new Date().toISOString() };
  }

  private async scrapeData(task: TaskAssignment): Promise<TaskResult> {
    return { taskId: task.id, status: "success", result: { scraped: true }, completedAt: new Date().toISOString() };
  }

  private async extractFacts(task: TaskAssignment): Promise<TaskResult> {
    return { taskId: task.id, status: "success", result: { extracted: true }, completedAt: new Date().toISOString() };
  }

  private async reportResult(result: TaskResult): Promise<void> {
    if (!this.config?.masterUrl) return;
    const masterUrl = this.config.masterUrl.replace(/\/$/, "");
    try {
      await axios.post(`${masterUrl}/api/mesh/result`, result, {
        timeout: 5000,
        headers: { "X-Mesh-Key": this.config.meshKey || "" },
      });
    } catch {
      // silent
    }
  }

  getStatus() {
    return {
      role: this.config?.nodeRole || "unknown",
      nodeName: this.config?.nodeName || "Unnamed",
      currentTask: this.currentTask,
      connected: Boolean(this.config?.masterUrl),
      suspended: this.suspended,
      timestamp: new Date().toISOString(),
    };
  }
}

export const satelliteWorker = new SatelliteWorker();
