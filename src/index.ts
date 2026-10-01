import { ensureConfiguration, isConfigComplete, openDashboard } from "./config/configManager";
import { ensureDataDir, migrateLegacyData } from "./utils/paths";
import { APP_VERSION } from "./version";
import { startVitalsSampler } from "./services/telemetry";
import { describeRuntime, supportsBrowserScraping } from "./platform";

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
  // --- 0a. Persistent storage, BEFORE anything reads or writes user data -----
  // The OTA updater replaces rippa-node.exe in place, so any file written beside
  // it is lost on every update. Data now lives in the OS app-data directory;
  // this step rescues the files older builds left next to the executable so an
  // existing node keeps its config, node code, mesh key and Deep Brain.
  const dataDir = ensureDataDir();
  console.log(`[Boot] Persistent data directory: ${dataDir}`);
  migrateLegacyData();

  // --- 0b. Non-blocking config load (GUI collects settings when missing) ---
  const boot = await ensureConfiguration();

  // Loaded via require() INSIDE main() so config above always applies first.
  // The string literals stay statically analyzable for the pkg bundler.
  const configModule = require("./config") as typeof import("./config");
  const { env, reloadEnv } = configModule;
  const { closeDeepBrain, initializeDeepBrain } = require("./db/database") as typeof import("./db/database");
  const serverModule = require("./server") as typeof import("./server");
  const { startServer, onConfigChange, getDispatcher, getSwarmUpdater } = serverModule;
  const { SwarmClient } = require("./network/SwarmClient") as typeof import("./network/SwarmClient");
  const { SyncManager } = require("./network/SyncManager") as typeof import("./network/SyncManager");
  const { BrainDeltaSync } = require("./network/BrainDeltaSync") as typeof import("./network/BrainDeltaSync");
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
  // Stated up front because it changes what the node can do: a build without
  // Chromium scrapes with `fetch` instead, which is visible here rather than
  // being discovered as silently degraded output days later.
  console.log(
    ` Runtime: ${describeRuntime()} | scraping: ${
      supportsBrowserScraping() ? "headless Chromium (Playwright)" : "lightweight fetch (mobile)"
    }`,
  );
  console.log(` Mothership: ${env.MOTHERSHIP_URL}`);
  console.log(` Ollama: ${env.OLLAMA_URL}`);
  console.log("══════════════════════════════════════════════");

  // --- 2. Always: local API + Web GUI. Master-only: Deep Brain. ---
  let httpServer: import("node:http").Server | null = null;
  httpServer = startServer();

  // The Rippa Node AI is owned by the server module (the API routes and the
  // boot sequence share one registry) and started for BOTH roles: a Master
  // monitors its satellites, a Satellite polls for work.
  const dispatcher = getDispatcher();
  dispatcher.start();

  // GitHub OTA: the Master polls GitHub hourly and broadcasts any new release
  // to the fleet. Satellites do not poll — they act on the trigger they receive.
  const swarmUpdater = getSwarmUpdater();
  if (isConfigComplete(readCurrentConfig())) {
    swarmUpdater.start();
  }
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
  let brainDeltaSync: import("./network/BrainDeltaSync").BrainDeltaSync | null = null;
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
    const client = new SwarmClient();
    swarm = client;

    // CPU load needs two samples separated by an interval, so the sampler
    // must be running before the first heartbeat to report a real figure.
    startVitalsSampler();

    // Wire the rich heartbeat telemetry + remote command execution. The swarm
    // dispatcher owns the registry, so it supplies the P2P link list and the
    // node's own task counters; the handlers below close the loop on commands.
    /*
      ONE ADMIN-COMMAND IMPLEMENTATION, SHARED BY BOTH CHANNELS.

      Admin work arrives two ways — a `pending_commands` entry on the heartbeat
      reply, and an ordinary queue task whose type is FORCE_OTA_UPDATE /
      RESTART_NODE_SERVICE — and both must behave identically. Building the
      handler object once (rather than twice) is what guarantees that: a fix
      applied here, such as forceUpdate bypassing the "already latest" check or
      acknowledging before the swap, applies on both paths at once. A second copy
      is how these two channels drifted apart in the first place.
    */
    const acknowledgeUpstream = async (
      command: string,
      detail: string,
      context?: { commandId?: string; status?: "completed" | "failed" | "in_progress" },
    ): Promise<void> => {
      /*
        POSTED TO THE DEDICATED ACK ROUTE, CARRYING THE COMMAND ID.

        This used to be a plain profile submission to `/api/swarm/submit` with no
        id attached. A profile submission is a *record*; it does not clear a
        queue. The Mothership had no way to know which entry the node had just
        finished, so it kept the entry queued and re-sent it on the next
        heartbeat — the "Skipping already-executed command" loop. Acknowledging
        through `/api/node/ack` with the id is what actually retires it.

        `client.acknowledgeRemoteCommand` owns the route fallback chain and the
        final profile-submission fallback, so this stays a one-liner and the
        behaviour is identical on every command channel.
      */
      await client.acknowledgeRemoteCommand({
        commandId: context?.commandId,
        command,
        detail,
        ...(context?.status ? { status: context.status } : {}),
      });
    };

    const adminCommands = {
      restartNode: () => shutdown("REMOTE_COMMAND"),
      // `forceUpdate`, NOT `checkNow`. checkNow() is the unattended poll and
      // deliberately refuses to reinstall the running build, so a "Force OTA
      // Update" that arrived on a node already at the latest version logged
      // "up to date" and did nothing — received and ignored, which is exactly
      // the reported symptom. forceUpdate() bypasses that check and returns
      // whether a swap is actually committed, so a refused update is reported
      // honestly instead of looking like a restart that never happened.
      forceUpdate: (): Promise<boolean> => swarmUpdater.forceUpdate(),
      setP2pEnabled: async (enabled: boolean) => {
        // Persisted through nodeAuth so the choice survives a restart.
        require("./config/nodeAuth").setP2pEnabled(enabled);
      },
      isP2pEnabled: () => require("./config/nodeAuth").p2pEnabled(),
      // Sent BEFORE the shutdown sequence begins: the update and restart handlers
      // both end in process.exit(0), so anything reported afterwards would never
      // reach the Mothership and the command would sit in the queue unacked.
      acknowledgeCommand: acknowledgeUpstream,
    };

    swarm.setTelemetrySources({
      connectedSatellites: () => {
        /*
          PEERING, NOT REACHABILITY — this is what makes the Mothership aware of
          the fleet. `listConnectedSatelliteCodes()` reports every satellite the
          Master has registered, whereas the previous `listOnlineSatellites()`
          filtered to nodes seen in the last 45s: one missed poll and the cloud
          was told the Master had no satellites at all, which reads identically
          to never having paired any.
        */
        const meshed = dispatcher.listConnectedSatelliteCodes();
        if (meshed.length > 0) return meshed;
        // A satellite has no registry of its own, so it reports its provisioned
        // siblings instead (see listPeers).
        return require("./config/nodeAuth").listPeers().map((peer: { nodeCode: string }) => peer.nodeCode);
      },
      efficiency: () => {
        const metrics = dispatcher.getLocalMetrics();
        const succeeded = metrics.tasksSucceeded || 0;
        const total = succeeded + (metrics.tasksFailed || 0) + (metrics.tasksTimedOut || 0);
        return { succeeded, total };
      },
      commandHandlers: adminCommands,
    });

    /*
      AUTOMATIC MESH KEY SYNC.

      Rippa AI can rotate the swarm connection key on any heartbeat reply, and
      this hook applies it: the Master persists the new key to config.json, drops
      revoked peer keys and unregistered nodes, then pushes the new credential to
      every satellite so the whole fleet re-keys itself with no operator action.
      A satellite ignores the directive (it has no registry of its own) — its
      Master is what issues its credential.

      Registered through the require() indirection used by index.ts so the
      bundler keeps the module statically analysable for the pkg build.
    */
    swarm.setMeshKeySyncHandler((directive) => {
      void dispatcher.applyMothershipSync(directive).catch((error: unknown) => {
        console.warn(
          `[Boot] Mesh key sync failed — ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
    });

    swarm.startHeartbeat();
    syncManager = new SyncManager(swarm);
    syncManager.start();
    // Pull half of brain parity: keeps this node's mirror of the cloud's
    // knowledge current. Master-only; a no-op until a bundle has been loaded.
    brainDeltaSync = new BrainDeltaSync(swarm);
    brainDeltaSync.start();
    /*
      THE ADMIN HOOKS ARE THE *SAME OBJECTS* the heartbeat's command handlers
      use, not a second copy. Admin work arrives on two channels — a
      `pending_commands` entry on the heartbeat, and an ordinary queue task
      whose type is FORCE_OTA_UPDATE / RESTART_NODE_SERVICE — and both must do
      the same thing. Sharing one object means a fix applied to one path (say,
      forceUpdate bypassing the "already latest" check) applies to both.
    */
    orchestrator = new Orchestrator(swarm, {
      /*
        THE SAME OBJECT THE HEARTBEAT PATH USES — see `adminCommands` above. Not
        a lookalike: the same reference, so the two channels cannot drift again.
      */
      restartNode: adminCommands.restartNode,
      forceUpdate: adminCommands.forceUpdate,
      setP2pEnabled: adminCommands.setP2pEnabled,
      isP2pEnabled: adminCommands.isP2pEnabled,
      acknowledgeCommand: adminCommands.acknowledgeCommand,
    });
    orchestrator.start();

    // A Master advertises itself on the LAN so satellite nodes can find it
    // without a hand-typed IP. Satellites never broadcast.
    if (shouldAdvertise(env.NODE_ROLE)) {
      /*
        THE NODE CODE IS ADVERTISED TOO, not just the name and address. It is
        what makes "enter this Master's code on the Satellite" a working
        instruction: the code is the only stable identity a Master has across a
        DHCP lease change or a renamed PC, and a beacon without it could only be
        resolved by IP.
      */
      void beacon.start(env.NODE_NAME, env.PORT, dispatcher.nodeCode);
    } else {
      beacon.stop();
    }
  };

  const stopNodeServices = async (): Promise<void> => {
    beacon.stop(); // release the UDP discovery port before rebinding
    dispatcher.stop();
    swarmUpdater.stop();
    if (orchestrator) {
      await orchestrator.stop();
      orchestrator = null;
    }
    if (syncManager) {
      syncManager.stop();
      syncManager = null;
    }
    if (brainDeltaSync) {
      brainDeltaSync.stop();
      brainDeltaSync = null;
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
    // The dispatcher reads NODE_ROLE, so a role change must restart it with the
    // new mode (Master monitor loop vs. Satellite poll loop).
    dispatcher.start();
    /*
      PAIR IMMEDIATELY IF A MASTER URL WAS JUST SAVED.

      Without this, pairing only happened on the satellite's own boot, so an
      operator who configured the Master URL and clicked Save saw a node that
      looked configured but did not appear in the Master's Swarm Grid for up to
      a full poll cycle — and if the node had already booted, not at all until
      the next restart. `ensurePaired` is a no-op when already paired.
    */
    void dispatcher.ensurePairedWithMaster();
    swarmUpdater.start();
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
