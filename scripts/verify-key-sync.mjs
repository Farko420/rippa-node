/**
 * MESH KEY SYNC + UNREGISTERED-NODE PURGE — verification.
 *
 * Exercises the two fixes against the COMPILED output, so it runs the same code
 * the packaged exe does:
 *
 *   1. a Rippa AI rotation directive on the heartbeat reply rotates the key,
 *      purges stale/revoked peers, and re-keys the fleet automatically;
 *   2. a satellite on a stale or unknown key is told how to recover instead of
 *      being 401'd into silence — and an UNKNOWN key is still never handed the
 *      credential, which is the security property that makes (1) safe.
 *
 * Not part of the shipped app. See verify-harness.mjs for the shared helpers.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT, check, results } from "./verify-harness.mjs";

/** Imports a compiled module by path. Windows ESM needs a file:// URL. */
const load = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);

const { parseMeshKeySync } = await load("dist/services/meshKeySync.js");

// --- 1. Directive parsing ---------------------------------------------------

check(
  "a plain heartbeat reply yields no directive (change nothing)",
  parseMeshKeySync({ success: true, connected_satellites: ["RIPPA-AAAA-1111"] }) === null,
);

check(
  "a top-level mesh_key directive is read",
  parseMeshKeySync({ mesh_key: "RIPPA-RUMX-6FD4" })?.meshKey === "RIPPA-RUMX-6FD4",
);

check(
  "camelCase spelling is read too",
  parseMeshKeySync({ meshKey: "key-camel" })?.meshKey === "key-camel",
);

check(
  "the directive is found inside its envelope",
  parseMeshKeySync({ mesh_key_sync: { mesh_key: "enveloped" } })?.meshKey === "enveloped",
);

check(
  "revoked node codes are read as a list of records",
  JSON.stringify(
    parseMeshKeySync({
      mesh_sync: {
        revoked_nodes: [{ nodeCode: "RIPPA-BYNK-MNU4" }, { code: "RIPPA-498L-U4HU" }],
      },
    })?.revokedNodes,
  ) === JSON.stringify(["RIPPA-BYNK-MNU4", "RIPPA-498L-U4HU"]),
);

check(
  "a directive carrying only revocations (no new key) is still honoured",
  (() => {
    const d = parseMeshKeySync({ revoked_keys: ["mesh-old"] });
    return d !== null && d.meshKey === "" && d.revokedKeys.length === 1;
  })(),
);

/*
  THE SAFETY PROPERTY. `key` is a plausible field name for something that is not
  a credential. If the parser accepted one of these it could rotate the entire
  fleet's authentication key off a field name it invented, so it must not.
*/
check(
  "a non-string `key` field is NOT treated as a credential",
  parseMeshKeySync({ key: true }) === null && parseMeshKeySync({ key: { id: 7 } }) === null,
);
check("an empty-string key alone is not a directive", parseMeshKeySync({ mesh_key: "" }) === null);

// --- 2. Key classification & rotation state --------------------------------

/*
  nodeAuth reads/writes the real config.json, so these run against a throwaway
  data directory rather than the developer's actual node. The override must be
  set BEFORE the module is imported — `resolveAppRoot()` reads it at call time,
  but a stale value would still have been applied by an earlier import.
*/
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rippa-keysync-"));
process.env.RIPPA_CONFIG_ROOT = dataDir;
process.env.RIPPA_DATA_DIR = dataDir;

/*
  Seed a config.json FIRST. `persist()` in nodeAuth is a no-op when there is no
  config to merge into, so an empty directory would silently swallow every write
  and make these checks fail for reasons unrelated to the behaviour under test.
*/
fs.writeFileSync(
  path.join(dataDir, "config.json"),
  JSON.stringify(
    {
      NODE_ROLE: "master",
      NODE_NAME: "Key Sync Verify",
      NODE_API_KEY: "verify-key-sync-key-01",
      MOTHERSHIP_URL: "https://rippaadventures.com",
      MASTER_LOCAL_URL: "http://127.0.0.1:5199",
      OLLAMA_URL: "http://127.0.0.1:11434",
      PORT: 5199,
      DASHBOARD_PIN: "4242",
    },
    null,
    2,
  ),
);

const auth = await load("dist/config/nodeAuth.js");

auth.saveMeshKey("mesh-original", "RIPPA-MSTR-0001");
check("the original key is stored", auth.getMeshKey() === "mesh-original");
check("the original key validates", auth.classifyMeshKey("mesh-original") === "valid");

check(
  "a rotation that changes the key reports the change",
  auth.rotateMeshKey("mesh-next", "RIPPA-RUMX-6FD4") === true,
);
check(
  "a repeat of the same key is a no-op",
  auth.rotateMeshKey("mesh-next", "RIPPA-RUMX-6FD4") === false,
);
check("the new key validates", auth.classifyMeshKey("mesh-next") === "valid");

/*
  THE WHOLE POINT OF RETAINING THE PREDECESSOR. Without this, a satellite that
  was mid-poll when the rotation landed is indistinguishable from a stranger and
  stays locked out until an operator intervenes.
*/
check(
  "the previous key is recognised as STALE, not unknown",
  auth.classifyMeshKey("mesh-original") === "stale",
);
check("a random key is still unknown", auth.classifyMeshKey("mesh-guess") === "unknown");
check("no key at all is `missing`", auth.classifyMeshKey("") === "missing");

/*
  A REVOKED KEY MUST NEVER BE UPGRADED. Rippa AI withdrawing a credential is a
  deliberate decision; silently repairing it would override the operator's own
  control panel.
*/
auth.revokeMeshKeys(["mesh-bad-actor"]);
check(
  "a revoked key classifies as revoked",
  auth.classifyMeshKey("mesh-bad-actor") === "revoked",
);
check("revocation does not touch the active key", auth.getMeshKey() === "mesh-next");

// --- 3. Peer purge ----------------------------------------------------------

auth.applyPeerProvision([
  { nodeCode: "RIPPA-BYNK-MNU4", nodeName: "Ghost A", ipAddress: "10.0.0.4", port: 4000 },
  { nodeCode: "RIPPA-498L-U4HU", nodeName: "Ghost B", ipAddress: "10.0.0.5", port: 4000 },
  { nodeCode: "RIPPA-7Q4M-2XKD", nodeName: "Live", ipAddress: "10.0.0.9", port: 4000 },
]);
check("three peers provisioned", auth.listPeers().length === 3);

const purgedPeers = auth.purgePeerMesh(["RIPPA-BYNK-MNU4", "RIPPA-498L-U4HU"]);
check("both stale peers removed", purgedPeers.length === 2);
check(
  "the live peer survives the purge",
  auth.listPeers().length === 1 && auth.listPeers()[0].nodeCode === "RIPPA-7Q4M-2XKD",
);

// --- 4. Rotation state survives a config save (normaliser whitelist) ---------
/*
  `writeConfig` normalises and writes what `normalizeConfig` returns — it is not
  a merge, so a field missing from that function is DELETED on the next save.
  Rotation state living only in memory would strand the whole fleet on the next
  Setup-screen save, so this asserts it survives.
*/
const cfg = await load("dist/config/configManager.js");
// `writeConfig` takes the target root explicitly — the first argument, not a
// config object on its own.
cfg.writeConfig(dataDir, { ...cfg.readConfig(dataDir) });
check("the active key survives a config rewrite", cfg.readConfig(dataDir).MESH_KEY === "mesh-next");
check(
  "the previous key survives a config rewrite",
  cfg.readConfig(dataDir).MESH_KEY_PREVIOUS === "mesh-original",
);
check(
  "the revoked list survives a config rewrite",
  JSON.stringify(cfg.readConfig(dataDir).MESH_KEY_REVOKED) === JSON.stringify(["mesh-bad-actor"]),
);
check(
  "the node can still recognise its old key AFTER a config rewrite",
  auth.classifyMeshKey("mesh-original") === "stale",
);

// --- 5. LIVE: the actual HTTP surface ----------------------------------------
/*
  Everything above is in-process. This section drives a real spawned Master over
  HTTP, because the property that matters most is one only the wire can show:
  an UNAUTHENTICATED caller must be told how to recover WITHOUT being handed the
  fleet credential. A unit test on `buildSyncReset` would pass even if the route
  leaked the key in some other field, so it is checked against the real response.
*/

const live = await import("./verify-harness.mjs");
const configRoot = live.makeConfigRoot();
const child = live.spawnNode(configRoot);
const up = await live.waitForServer();

if (!up) {
  check("live Master booted", false, "server never answered /health");
  child.kill();
} else {
  check("live Master booted", true);

  const cookie = await live.login();
  const base = `http://127.0.0.1:${live.PORT}`;

  // Pair a satellite to obtain a real mesh key.
  const paired = await fetch(`${base}/api/mesh/pair`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      nodeCode: "RIPPA-D2N6-6VZV",
      nodeName: "Sync Satellite",
      ipAddress: "127.0.0.1",
      port: 5200,
    }),
  });
  const pairBody = await paired.json();
  const liveKey = pairBody?.meshKey ?? "";
  check("satellite paired and received a mesh key", Boolean(liveKey));

  // A VALID key still works — the happy path must be untouched.
  const good = await fetch(`${base}/api/mesh/heartbeat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Mesh-Key": liveKey },
    body: JSON.stringify({
      nodeCode: "RIPPA-D2N6-6VZV",
      nodeName: "Sync Satellite",
      ipAddress: "127.0.0.1",
      port: 5200,
      metrics: {},
    }),
  });
  check("a valid key is still accepted", good.status === 200, `HTTP ${good.status}`);

  /*
    THE SECURITY PROPERTY, asserted over the wire.

    An arbitrary caller presenting a made-up key gets actionable recovery advice
    so its client can re-pair automatically — and crucially does NOT receive the
    mesh key, because anything able to reach this port could otherwise just ask
    for the credential.
  */
  const bad = await fetch(`${base}/api/mesh/heartbeat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Mesh-Key": "totally-made-up-key" },
    body: JSON.stringify({ nodeCode: "RIPPA-498L-U4HU", nodeName: "Stranger" }),
  });
  const badBody = await bad.json();
  check("an unknown key is still refused with 401", bad.status === 401, `HTTP ${bad.status}`);
  check(
    "the refusal carries actionable syncReset guidance",
    badBody?.syncReset?.reason === "unknown-key" && badBody?.syncReset?.reauthRequired === true,
    JSON.stringify(badBody?.syncReset?.reason),
  );
  check(
    "SECURITY: an unknown key is NOT handed the active mesh key",
    badBody?.syncReset?.meshKey === undefined && !JSON.stringify(badBody).includes(liveKey),
    "the credential must never appear in a response to an unauthenticated caller",
  );

  /*
    THE ROTATION + STALE-RECOVERY PATH, driven through the real dispatcher.

    Deliberately in-process rather than over HTTP. The Master holds its mesh key
    in memory, so writing a new key into config.json underneath a running node
    would NOT change what it accepts — a disk-only test here would be testing a
    fiction. Rotation is a live operation performed by `applyMothershipSync`, so
    that is what this calls, with the real directive shape the Mothership sends.
  */
  const { SwarmDispatcher } = await load("dist/services/swarmDispatcher.js");
  const dir = live.makeConfigRoot();
  const prevRoot = process.env.RIPPA_CONFIG_ROOT;
  const prevData = process.env.RIPPA_DATA_DIR;
  process.env.RIPPA_CONFIG_ROOT = dir;
  process.env.RIPPA_DATA_DIR = dir;

  // Fresh module instances so the dispatcher reads THIS config root.
  const freshAuth = await import(`${pathToFileURL(path.join(ROOT, "dist/config/nodeAuth.js")).href}?t=${Date.now()}`);
  const freshDispatcherMod = await import(
    `${pathToFileURL(path.join(ROOT, "dist/services/swarmDispatcher.js")).href}?t=${Date.now()}`
  );

  freshAuth.saveMeshKey("mesh-satellite-key", "RIPPA-MSTR-0002");
  const dispatcher = new freshDispatcherMod.SwarmDispatcher();
  dispatcher.start();

  /*
    THE KEY MUST SURVIVE A "RESTART".

    Regression guard for a real lock-out bug: `start()` used to mint a fresh key
    on every boot instead of reusing the persisted one, so every Master restart
    invalidated the credential each satellite was holding. `start()` is called
    again here on a second dispatcher instance over the same config — exactly
    what a process restart does — and the key must come back unchanged.
  */
  const keyAfterFirstStart = dispatcher.getMeshKeyOrEmpty();
  check(
    "the Master starts with the persisted key, not a fresh one",
    keyAfterFirstStart === "mesh-satellite-key",
    keyAfterFirstStart,
  );

  // Simulate Rippa AI issuing a new key on the heartbeat reply.
  const syncOutcome = await dispatcher.applyMothershipSync({
    meshKey: "mesh-rotated-by-mothership",
    issuedBy: "RIPPA-RUMX-6FD4",
    revokedKeys: [],
    revokedNodes: [],
  });
  check(
    "a Rippa AI directive rotates the mesh key",
    syncOutcome.rotated === true,
  );
  check(
    "the rotated key is what the Master now accepts",
    freshAuth.getMeshKey() === "mesh-rotated-by-mothership",
  );
  check(
    "the active key still authenticates (no lockout for anyone)",
    dispatcher.authenticateOrReset("mesh-rotated-by-mothership", "RIPPA-D2N6-6VZV").ok === true,
  );

  // A satellite still holding the pre-rotation key.
  const staleCheck = dispatcher.authenticateOrReset("mesh-satellite-key", "RIPPA-D2N6-6VZV");
  check(
    "a stale key is recognised as stale, not unknown",
    staleCheck.ok === false && staleCheck.status === "stale",
    staleCheck.ok === false ? staleCheck.status : "accepted",
  );
  check(
    "a stale node is re-issued the active key automatically (no manual reconfig)",
    staleCheck.ok === false && staleCheck.reset.meshKey === "mesh-rotated-by-mothership",
  );

  // A revoked key is never auto-upgraded, even though it would otherwise look stale.
  freshAuth.revokeMeshKeys(["mesh-revoked-key"]);
  const revokedCheck = dispatcher.authenticateOrReset("mesh-revoked-key", "RIPPA-D2N6-6VZV");
  check(
    "a revoked key is never handed the active key",
    revokedCheck.ok === false && revokedCheck.reset.meshKey === undefined,
    revokedCheck.ok === false ? revokedCheck.status : "accepted",
  );

  // A completely unknown key gets guidance but never the credential.
  const unknownCheck = dispatcher.authenticateOrReset("key-nobody-has", "RIPPA-498L-U4HU");
  check(
    "an unknown key gets reauth guidance without the credential",
    unknownCheck.ok === false &&
      unknownCheck.reset.reason === "unknown-key" &&
      unknownCheck.reset.meshKey === undefined,
  );

  /*
    AND THE KEY SURVIVES A RESTART AFTER A ROTATION.

    This is the regression that mattered most: a Master restart must not quietly
    invalidate the credential the whole fleet is holding. A second dispatcher
    over the same config root is exactly what a process restart does.
  */
  dispatcher.stop();
  const restarted = new freshDispatcherMod.SwarmDispatcher();
  restarted.start();
  check(
    "after a restart the Master still uses the rotated key (no silent lock-out)",
    restarted.getMeshKeyOrEmpty() === "mesh-rotated-by-mothership",
    restarted.getMeshKeyOrEmpty(),
  );
  check(
    "and the fleet's key is still accepted after that restart",
    restarted.authenticateOrReset("mesh-rotated-by-mothership", "RIPPA-D2N6-6VZV").ok === true,
  );
  restarted.stop();
  dispatcher.start();

  // Purge: register a node, then remove it and confirm it leaves the fleet view.
  dispatcher.registerSatellite({
    nodeCode: "RIPPA-BYNK-MNU4",
    nodeName: "Ghost",
    ipAddress: "127.0.0.1",
    port: 5200,
  });
  check(
    "the registered node appears in the Swarm Grid",
    dispatcher.getSnapshot()["satellites"].length === 1,
  );
  const purged = dispatcher.purgeNodes(["RIPPA-BYNK-MNU4"], "test");
  check("the purged node is removed", purged.length === 1);
  check(
    "and it no longer appears in the Swarm Grid (no permanent warning left)",
    dispatcher.getSnapshot()["satellites"].length === 0,
  );
  check(
    "and it is no longer reported to the Mothership as connected",
    dispatcher.listConnectedSatelliteCodes().length === 0,
  );

  dispatcher.stop();
  process.env.RIPPA_CONFIG_ROOT = prevRoot;
  process.env.RIPPA_DATA_DIR = prevData;
  fs.rmSync(dir, { recursive: true, force: true });

  // The operator-triggered purge route removes a code that is not registered.
  const purge = await fetch(`${base}/api/mesh/purge`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ nodeCodes: ["RIPPA-BYNK-MNU4"] }),
  });
  const purgeBody = await purge.json();
  check("the purge route responds", purge.status === 200, `HTTP ${purge.status}`);
  check(
    "purging an unregistered node reports nothing to purge",
    Array.isArray(purgeBody?.purged) && purgeBody.purged.length === 0,
  );

  // The purge route must stay behind the dashboard passkey.
  const noAuth = await fetch(`${base}/api/mesh/purge`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  check(
    "the purge route is passkey-gated (an unauthenticated LAN client cannot)",
    noAuth.status === 401,
    `HTTP ${noAuth.status}`,
  );

  child.kill();
}

fs.rmSync(dataDir, { recursive: true, force: true });
fs.rmSync(configRoot, { recursive: true, force: true });

// --- Summary ----------------------------------------------------------------
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} mesh key sync checks passed.`);
if (failed.length > 0) {
  console.error(`FAILED: ${failed.map((f) => f.name).join(" | ")}`);
  process.exit(1);
}