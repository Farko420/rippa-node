/*
  MANAGED-PATH REGRESSION TEST — the port the node BINDS is the port it reports.

  WHY THIS FILE IS SEPARATE FROM verify-engine-health.mjs

  That suite sets `OLLAMA_URL` to a throwaway fake before importing the manager,
  so it exercises the UNMANAGED path only. The failure this test exists for is
  invisible from there: it is about what happens AFTER a managed child takes
  ownership of the port. Keeping them separate also keeps each test honest about
  which mode it asserts, rather than re-pointing the env var mid-suite and
  hoping module-load order cooperates.

  THE BUG, PRECISELY

  `src/config.ts` builds `env` ONCE at module load via zod and exports it as a
  plain object. It is NOT a live view of `process.env`. So the original fix —
  `process.env.OLLAMA_URL = <managed origin>` — changed nothing for the ~8
  modules reading `env.OLLAMA_URL`, while the child had already been bound to
  11435 by `bundledOllamaEnv()`'s `OLLAMA_HOST`. Result: a node serving
  perfectly on 11435 while `getStatus().port` reported 11434 to the Mothership,
  `probeHealth()` probed a dead 11434 and showed the engine OFFLINE, and the
  /v1/chat + /v1/embeddings proxies 502'd on every request.

  THE INVARIANT UNDER TEST

  After `publishManagedOllamaOrigin(port)` the LIVE `env` object — the same
  reference every other module imported — must resolve to the managed origin.
  That holds only if `reloadEnv()` ran, which is why every assertion here reads
  `env.X` and not `process.env.X`: reading process.env would pass even with the
  fix reverted, because the revert's first half still works.

  NOT SPAWNING A REAL OLLAMA. `start()` would download a ~200MB runtime and bind
  a real port. The publish is pure with respect to the child, so it is driven
  directly; the spawn path stays covered by the engine suite.
*/
import http from "node:http";

/*
  THE ORDERING TRAP THIS FILE WALKS INTO ON PURPOSE.

  `RIPPA_BUNDLED_OLLAMA_PORT` is read by `resolveBundledOllamaPort()` at CALL
  time, but `env`'s default OLLAMA_URL is frozen at IMPORT time. So the override
  is set before any import, and the fake server binds to the SAME number the
  override names. `probeHealth()` builds its URL from `getPort()` →
  `env.OLLAMA_URL`, so it can only reach the fake server if the publish worked.
  A reverted fix therefore fails to connect to a port with no listener — a louder
  and more honest failure than a boolean mismatch.
*/
/*
  THE REAL MANAGED PORT BY DEFAULT — and overridable only when it is genuinely
  occupied, which is a state a developer's machine reaches routinely.

  WHY IT IS NOT AN EPHEMERAL PORT. Binding a random free port would let this
  suite pass while asserting about a number no production node will ever use,
  so the whole test would stop meaning anything. 11435 is the port under test.

  WHY THE OVERRIDE EXISTS ANYWAY. `verify-managed-ollama-origin.mjs` was the only
  suite that could not run on a machine with the product actually running: the
  managed `ollama.exe` supervises and RESPAWNS itself, so killing it is not an
  option and the bind died with EADDRINUSE every time. `resolveBundledOllamaPort()`
  reads `RIPPA_BUNDLED_OLLAMA_PORT` at call time precisely so a real port can be
  moved; this suite now sets that same variable rather than a second mechanism.

  It stays a Loud failure by default — an occupied 11435 with no override is
  still an error, not a silently-skipped test. The escape hatch is explicit.
*/
const MANAGED_PORT = Number(process.env.RIPPA_BUNDLED_OLLAMA_PORT) || 11435;

const fake = http.createServer((req, res) => {
  if (req.url === "/api/tags") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ models: [{ name: "nomic-embed-text:latest" }] }));
  }
  if (req.url === "/api/ps") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ models: [{ name: "qwen2.5:1.5b" }] }));
  }
  res.writeHead(404).end();
});

// Bind the REAL managed port, not an ephemeral one: a silent rebind elsewhere
// would mean asserting about a port that is not the one under test. A conflict
// fails loudly here instead.
await new Promise((resolve, reject) => {
  fake.once("error", reject);
  fake.listen(MANAGED_PORT, "127.0.0.1", resolve);
});

const EXPECTED_ORIGIN = `http://127.0.0.1:${MANAGED_PORT}`;

// MUST be set before the imports below — see the ordering trap above.
process.env.RIPPA_BUNDLED_OLLAMA_PORT = String(MANAGED_PORT);

const { env } = await import("../dist/config.js");
const { publishManagedOllamaOrigin, ollamaManager } = await import(
  "../dist/services/ollamaManager.js"
);
const { resolveBundledOllamaPort, bundledOllamaOrigin } = await import(
  "../dist/services/bundled-ollama.js"
);

let passed = 0, failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : ` — ${detail}`}`);
  ok ? passed++ : failed++;
};
/* ── 0. The starting condition the bug produced ────────────────────────────── */

console.log("\n[MANAGED-ORIGIN] the pre-publish state");

check(
  "the managed port is resolved from the override, not the 11434 default",
  resolveBundledOllamaPort() === MANAGED_PORT,
  String(resolveBundledOllamaPort()),
);
check(
  "the resolver's origin matches the port we bound",
  bundledOllamaOrigin() === EXPECTED_ORIGIN,
  bundledOllamaOrigin(),
);

/*
  THE FAILING STATE MADE VISIBLE. Before publishing, `env.OLLAMA_URL` is still
  the stale default even though the child is already bound to 11435 — the exact
  mismatch that made healthy nodes report OFFLINE. Asserting it guards against
  the test silently passing for the wrong reason later on.
*/
check(
  "before publishing, live env still holds the stale default (the bug's starting state)",
  env.OLLAMA_URL !== EXPECTED_ORIGIN,
  `env.OLLAMA_URL=${env.OLLAMA_URL}`,
);

/* ── 1. The publish itself ─────────────────────────────────────────────────── */

console.log("\n[MANAGED-ORIGIN] publishManagedOllamaOrigin reaches the LIVE env");

publishManagedOllamaOrigin(MANAGED_PORT);

// The load-bearing assertion. `env` is the object every importer holds, so this
// is the real thing and not a re-read of process.env.
check(
  "the live env object now resolves to the managed origin",
  env.OLLAMA_URL === EXPECTED_ORIGIN,
  `env.OLLAMA_URL=${env.OLLAMA_URL}`,
);
check(
  "process.env agrees with the published value",
  process.env.OLLAMA_URL === EXPECTED_ORIGIN,
  String(process.env.OLLAMA_URL),
);

/*
  A STRONGER FORM OF THE SAME CLAIM. `reloadEnv()` mutates the exported object
  IN PLACE precisely so existing importers keep working without re-importing. If
  a future refactor "fixed" this by reassigning a NEW object, this identity check
  fails even though a bare `env.OLLAMA_URL` read would still look correct.
*/
const { env: reimportedEnv } = await import("../dist/config.js");
check(
  "the env object identity is preserved (mutated in place, not replaced)",
  reimportedEnv === env,
);
/*
  NO `reloadEnv()` IS CALLED ANYWHERE IN THIS FILE, AND THAT IS DELIBERATE.

  An earlier draft asserted "a separate reloadEnv() is idempotent" here. It made
  this suite pass against a REVERTED fix: calling reloadEnv() in the test
  repaired the live `env` object by hand, so every downstream assertion
  (getStatus().port, the health badge) then passed vacuously — they observed the
  test's own repair, not the publish's effect. A test must never perform the very
  mutation it is asserting happened.
*/

/* ── 2. What the fleet and the dashboard actually observe ──────────────────── */

console.log("\n[MANAGED-ORIGIN] status and health reflect the BOUND port");

const status = ollamaManager.getStatus(null);
check(
  "getStatus().port reports the managed port, not the 11434 fallback",
  status.port === MANAGED_PORT,
  String(status.port),
);
check(
  "getPort() agrees — this is what the heartbeat sends the Mothership",
  ollamaManager.getPort() === MANAGED_PORT,
  String(ollamaManager.getPort()),
);

// Could only reach the fake server if the publish landed in the live env.
const health = await ollamaManager.probeHealth();
check(
  "the health badge reads READY through the managed port",
  health.state === "ready",
  `${health.state} — ${health.detail}`,
);
check(
  "the resident model is seen through the managed origin",
  health.modelLoaded === true && health.loadedModels[0] === "qwen2.5:1.5b",
  JSON.stringify(health.loadedModels),
);
check(
  "the probe reports the managed port, never the 11434 default",
  !/11434/.test(health.detail),
  health.detail,
);

/* ── 3. Idempotency — start() runs again on every managed restart ──────────── */

console.log("\n[MANAGED-ORIGIN] republishing is a no-op");

publishManagedOllamaOrigin(MANAGED_PORT);
check("a second publish leaves env unchanged", env.OLLAMA_URL === EXPECTED_ORIGIN);
check(
  "and does not disturb the reported port",
  ollamaManager.getStatus(null).port === MANAGED_PORT,
  String(ollamaManager.getStatus(null).port),
);

fake.close();

console.log(`\n[MANAGED-ORIGIN] ${passed}/${passed + failed} checks passed.`);
process.exit(failed ? 1 : 0);
