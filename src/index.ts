import { ensureConfiguration, isConfigComplete, openDashboard } from "./config/configManager";
import { APP_VERSION } from "./version";

// Deeper fatal-error stacks (the default of 10 frames hides the caller module).
(Error as { stackTraceLimit?: number }).stackTraceLimit = 60;

/**
 * RIPPA NODE — entry point.
 *
 * 0. Load config.json (non-blocking). When missing/incomplete, the Local Web
 *    GUI still boots on port 4000 and the default browser opens to it.
 * 1. Load + validate configuration (config.json overrides .env; zod via ./config).
 * 2. Always start the Express API + Web GUI on port 4000 (master + satellite).
 *    Master-only: initialize the Deep Brain (SQLite).
 * 3. Start the Mothership heartbeat (only when fully configured).
 * 4. Start the master-only cloud trickle-sync of verified_knowledge.
 * 5. Start the autonomous Agent Orchestrator loop (only when configured).
 * POST /api/system/config re-initializes services with the new parameters.
 */
async function main(): Promise<void> {
  // --- 0. Non-blocking config load (GUI collects settings when missing) ---
  const boot = await ensureConfiguration();

  // Loaded via require() INSIDE main() so config above always applies first.
  // The string literals stay statically analyzable for the pkg bundler.
  const configModule = require("./config") as typeof import("./config");
  const { env, reloadEnv } = configModule;
  const { closeDeepBrain, initializeDeepBrain } = require("./db/database") as typeof import("./db/database");
  const serverModule = require("./server") as typeof import("./server");
  const { startServer, onConfigChange } = serverModule;
  const { SwarmClient } = require("./network/SwarmClient") as typeof import("./network/SwarmClient");
  const { SyncManager } = require("./network/SyncManager") as typeof import("./network/SyncManager");
  const { Orchestrator } = require("./agent/Orchestrator") as typeof import("./agent/Orchestrator");
  const { readConfig } = require("./config/configManager") as typeof import("./config/configManager");

  const readCurrentConfig = (): import("./config/configManager").RippaNodeConfig | null => {
    try {
      return readConfig();
    } catch {
      return null;
    }
  };

  console.log("══════════════════════════════════════════════");
  console.log(` Rippa Node v${APP_VERSION} — "${env.NODE_NAME}"`);
  console.log(` Role: ${env.NODE_ROLE} | API port: ${env.PORT}`);
  console.log(` Mothership: ${env.MOTHERSHIP_URL}`);
  console.log(` Ollama: ${env.OLLAMA_URL}`);
  console.log("══════════════════════════════════════════════");

  // --- 2. Always: local API + Web GUI. Master-only: Deep Brain. ---
  let httpServer: import("node:http").Server | null = null;
  httpServer = startServer();
  let deepBrainOpen = false;
  const openDeepBrain = (): void => {
    if (env.NODE_ROLE === "master") {
      initializeDeepBrain();
      deepBrainOpen = true;
    } else {
      console.log("[Boot] Satellite mode — skipping Deep Brain (stateless).");
    }
  };
  openDeepBrain();

  // --- 3-5. Node services (heartbeat, sync, orchestrator) — live handles. ---
  let swarm: import("./network/SwarmClient").SwarmClient | null = null;
  let syncManager: import("./network/SyncManager").SyncManager | null = null;
  let orchestrator: import("./agent/Orchestrator").Orchestrator | null = null;

  // LAN discovery beacon — advertised by Masters so Satellites can auto-detect.
  const { MasterBeacon, shouldAdvertise } = require("./network/discovery") as typeof import("./network/discovery");
  const beacon = new MasterBeacon();

  const startNodeServices = (): void => {
    if (!isConfigComplete(readCurrentConfig())) {
      console.log("[Boot] Node not fully configured — services paused until GUI setup completes.");
      return;
    }
    if (swarm) return; // already running
    swarm = new SwarmClient();
    swarm.startHeartbeat();
    syncManager = new SyncManager(swarm);
    syncManager.start();
    orchestrator = new Orchestrator(swarm);
    orchestrator.start();

    // A Master advertises itself on the LAN so satellite nodes can find it
    // without a hand-typed IP. Satellites never broadcast.
    if (shouldAdvertise(env.NODE_ROLE)) {
      void beacon.start(env.NODE_NAME, env.PORT);
    } else {
      beacon.stop();
    }
  };

  const stopNodeServices = async (): Promise<void> => {
    beacon.stop(); // release the UDP discovery port before rebinding
    if (orchestrator) {
      await orchestrator.stop();
      orchestrator = null;
    }
    if (syncManager) {
      syncManager.stop();
      syncManager = null;
    }
    if (swarm) {
      swarm.stopHeartbeat();
      swarm = null;
    }
  };

  startNodeServices();

  // Re-initializes node services with new parameters after a GUI save.
  onConfigChange(async () => {
    reloadEnv();
    console.log(`[Boot] New role: ${env.NODE_ROLE} | port: ${env.PORT}`);
    await stopNodeServices();
    if (env.NODE_ROLE === "master" && !deepBrainOpen) {
      openDeepBrain();
    } else if (env.NODE_ROLE !== "master" && deepBrainOpen) {
      closeDeepBrain();
      deepBrainOpen = false;
    }
    startNodeServices();
    console.log("[Boot] Re-initialization complete.");
  });

  if (!boot.configured) {
    const url = `http://localhost:${env.PORT}/`;
    console.log(`[Boot] Opening Local Configuration Dashboard: ${url}`);
    void openDashboard(url);
  }

  // Graceful shutdown.
  const shutdown = async (signal: string): Promise<void> => {
    console.log(`\n[Boot] ${signal} received — shutting down...`);
    await stopNodeServices();
    if (deepBrainOpen) {
      closeDeepBrain();
      deepBrainOpen = false;
    }
    if (httpServer) {
      await new Promise<void>((resolve) => httpServer!.close(() => resolve()));
      httpServer = null;
    }
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((error) => {
  console.error("[Boot] Fatal error:", error);
  process.exit(1);
});
