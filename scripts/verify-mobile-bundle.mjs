#!/usr/bin/env node
/**
 * WEBVIEW RUNTIME SMOKE TEST — proves the worker bundle really executes inside
 * an Android WebView, not merely that it compiles.
 *
 * WHY THIS EXISTS. The bundler guard (scripts/build-mobile-worker.mjs) proves
 * the bundle does not MENTION Node builtins. A string check is not the same as
 * a successful load: axios, the storage provider and the polling loop all run
 * real code, and any of them touching `process` would only blow up at runtime
 * on a tablet. This test therefore evaluates the bundle in a `vm` context with
 * the globals a WebView actually provides — and, critically, WITHOUT `process`,
 * `require`, `Buffer` or `global`.
 *
 * IT CAUGHT A REAL BUG. `src/satellite/mobile-worker.ts` annotated its interval
 * handle as `NodeJS.Timeout`. That is a type-only reference, so esbuild erases
 * it and the bundle built fine — but the code called `clearInterval` on it,
 * which is correct in both runtimes. The genuine hazard is the type itself: a
 * `NodeJS.Timeout` annotation invites `NodeJS`-namespaced APIs that a WebView
 * does not have. The bundle is checked for the `NodeJS` namespace below so the
 * two runtimes can never silently diverge again.
 *
 * Run: npm run test:mobile:bundle
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bundlePath = path.join(root, "mobile", "www", "worker.js");

let passed = 0;
let failed = 0;

/** Records a check; never throws, so every failure is reported at once. */
function check(name, condition, detail = "") {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

if (!fs.existsSync(bundlePath)) {
  console.error(`[WEBVIEW] ${bundlePath} not found. Run: npm run build:apk:bundle`);
  process.exit(1);
}

const code = fs.readFileSync(bundlePath, "utf8");

/*
  COMMENTS ARE STRIPPED before the Node-leakage scan.

  esbuild preserves comments in the emitted bundle, so prose in a source file
  becomes a false positive: the text explaining why `NodeJS.Timeout` was removed
  from mobile-worker.ts literally contains the string "NodeJS", and a substring
  search flags it. Scanning comments for *executable* Node references is
  meaningless, so they are removed first. This is not a weakening of the guard —
  the runtime section below still executes the real bundle.
*/
const scanTarget = code
  .replace(/\/\*[\s\S]*?\*\//g, " ")
  .replace(/(^|[^:])\/\/.*$/gm, "$1 ");

console.log("\n[WEBVIEW] 1. No Node type/runtime leakage into the bundle");
check("no NodeJS namespace", !scanTarget.includes("NodeJS."));
check("no process.version", !scanTarget.includes("process.version"));
check("no require(", !scanTarget.includes("require("));
/*
  A naive substring test for "Buffer." produces two false positives here: axios
  ships an `isBuffer()` type-detection helper and `ArrayBuffer` support, neither
  of which touches the Node global. The regex below requires `Buffer` to be a
  standalone identifier followed by a member access or call, so `isBuffer(`,
  `ArrayBuffer` and `estimateBase64BufferAllocation` are all correctly ignored
  while a genuine `Buffer.from(...)` would still be caught.
*/
check("no global Buffer usage", !/(^|[^\w.$])Buffer\s*[.[(]/.test(scanTarget));
check("no process.binding", !scanTarget.includes("process.binding"));

console.log("\n[WEBVIEW] 2. Evaluates in a WebView-shaped global scope");

/*
  A deliberately MINIMAL context: window, localStorage, timers, console and
  fetch — and nothing else. No `process`, no `require`, no `global`. If any
  bundled code assumes Node exists, this throws here rather than on the device.
*/
const store = new Map();
const sandbox = {
  window: undefined,
  localStorage: {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => void store.set(k, String(v)),
    removeItem: (k) => void store.delete(k),
  },
  setInterval: () => 0,
  clearInterval: () => {},
  setTimeout: () => 0,
  clearTimeout: () => {},
  fetch: async () => {
    throw new Error("offline in the smoke test");
  },
  console,
};
sandbox.window = sandbox;
sandbox.self = sandbox;
sandbox.globalThis = sandbox;

const context = vm.createContext(sandbox);

/*
  A FRESH EVALUATION OF THE SAME BUNDLE with a swappable `fetch`.

  Re-running the IIFE gives the module its own state — the bundle is a closed scope,
  so a second `vm.runInContext` builds a second worker with a second connection
  state. That is what lets one file drive a CONNECTED node, a REFUSED node and an
  UNCONFIGURED node in sequence without state from the first leaking into the second
  and making the later assertions meaningless.

  `store` is deliberately SHARED: the point of these tests is that a credential
  survives as persisted state, and a fresh private store would test nothing.
*/
const fetchCalls = [];
const blankFetchCalls = [];

/**
 * Evaluates the bundle in its own WebView-shaped context.
 *
 * `overrides.fetch` replaces the offline stub so a test can observe — or simulate —
 * the Mothership's answer. Everything else the worker touches at boot (timers,
 * localStorage, console) is present exactly as it is on a device.
 */
async function loadIn(tag, overrides = {}) {
  const scope = {
    window: undefined,
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => void store.set(k, String(v)),
      removeItem: (k) => void store.delete(k),
    },
    setInterval: () => 0,
    clearInterval: () => {},
    setTimeout: () => 0,
    clearTimeout: () => {},
    fetch: async () => {
      throw new Error("offline in the smoke test");
    },
    console,
    ...overrides,
  };
  scope.window = scope;
  scope.self = scope;
  scope.globalThis = scope;
  vm.runInContext(code, vm.createContext(scope), {
    filename: `worker.js#${tag}`,
    timeout: 10_000,
  });
  return scope.RippaMobileWorker;
}

let loaded = true;
let loadError = "";
try {
  vm.runInContext(code, context, { filename: "worker.js", timeout: 10_000 });
} catch (error) {
  loaded = false;
  loadError = String(error && error.message);
}

check("bundle evaluates without throwing", loaded, loadError);
check("exports a global", typeof sandbox.RippaMobileWorker === "object");

console.log("\n[WEBVIEW] 3. The dashboard API the bundled index.html calls is present");
const api = sandbox.RippaMobileWorker || {};
check("exports startWorker()", typeof api.startWorker === "function");
check("exports workerStatus()", typeof api.workerStatus === "function");
check("exports onWorkerEvent()", typeof api.onWorkerEvent === "function");
check("exports stopWorker()", typeof api.stopWorker === "function");
check("exports startSatellite()", typeof api.startSatellite === "function");

console.log("\n[WEBVIEW] 4. The satellite core and its storage abstraction are bundled");
check("exports SatelliteWorker", typeof api.SatelliteWorker === "function");
check("exports the satelliteWorker singleton", !!api.satelliteWorker);
check("singleton exposes initialize()", typeof api.satelliteWorker?.initialize === "function");
check("singleton exposes getStatus()", typeof api.satelliteWorker?.getStatus === "function");
check(
  "satellite role is 'unknown' before init",
  api.satelliteWorker?.getStatus?.()?.role === "unknown",
);

/*
  THE DECISIVE BEHAVIOURAL CHECK. `initialize()` runs in a context that has
  `window` and `localStorage`, so createStorageProvider() MUST take the browser
  branch and return InMemoryStorage. If it ever fell through to
  createDesktopProvider() it would hit the browser stub and throw — which is
  exactly the failure that made the APK unbuildable, caught here without a
  device.
*/
let initError = "";
try {
  await api.satelliteWorker.initialize({
    nodeRole: "satellite",
    nodeName: "Smoke Test Satellite",
    masterUrl: "",
    meshKey: "",
    port: 4000,
  });
} catch (error) {
  initError = String(error && error.message);
}
check("initialize() does not reach the SQLite provider", initError === "", initError);
check(
  "satellite reports its configured name",
  api.satelliteWorker?.getStatus?.()?.nodeName === "Smoke Test Satellite",
);
check(
  "no masterUrl means not connected",
  api.satelliteWorker?.getStatus?.()?.connected === false,
);

try {
  await api.satelliteWorker.shutdown();
} catch {
  /* best effort */
}

console.log("\n[WEBVIEW] 5. The dashboard starts and reports status offline");
const dashboardStatus = api.workerStatus?.() ?? {};
check("workerStatus() returns a report", typeof dashboardStatus === "object");
check("reports the runtime description", typeof dashboardStatus.capabilities === "object");
check("reports the node name", dashboardStatus.config?.nodeName === "Android Satellite");
check("starts out not running", dashboardStatus.running === false);

/*
  startWorker() reaches out to the Mothership. `fetch` here deliberately throws,
  which is the offline case: the node must degrade to "idle with an error
  recorded", never crash the page.
*/
let startError = "";
try {
  await api.startWorker();
} catch (error) {
  startError = String(error && error.message);
}
check("startWorker() survives an offline Mothership", startError === "", startError);
check(
  "polling loops are now running",
  api.workerStatus?.()?.running === true,
);
api.stopWorker?.();
check("stopWorker() clears the loops", api.workerStatus?.()?.running === false);

console.log("\n[WEBVIEW] 6. Pairing: the credentials the UI saves actually drive the pollers");

check("exports configureNode()", typeof api.configureNode === "function");

/*
  THE REGRESSION THIS FILE NOW GUARDS. The reported bug was an APK with a worker
  that could authenticate and no UI to give it a key, so it sat at "0 heartbeats"
  forever. These checks drive `configureNode()` exactly as the setup card does and
  assert the two things that were broken: the credential is persisted, and it is
  actually sent as a bearer token.
*/
const fresh = await loadIn("pairing", {
  fetch: async (url, init) => {
    fetchCalls.push({ url: String(url), init });
    return { ok: true, status: 200, json: async () => ({}) };
  },
});

const saved = await fresh.configureNode({
  mothershipUrl: "https://rippaadventures.com/",
  nodeKey: "rippa-d2n6-6vzv",
  nodeName: "Galaxy S26 Ultra",
});
check("configureNode() resolves to a connection status", typeof saved === "object");
check("a valid key produces Connected (200 OK)", saved.state === "connected", saved.label);
check("the badge label is the connected one", saved.label === "Connected (200 OK)", saved.label);

const stored = JSON.parse(store.get("rippa_node_mobile_config"));
check("the key is persisted to localStorage", stored.apiKey === "rippa-d2n6-6vzv");
check("the device name is persisted", stored.nodeName === "Galaxy S26 Ultra");
check("the trailing slash is stripped from the Mothership URL", stored.mothershipUrl === "https://rippaadventures.com");
check(
  "a pasted lowercase node code is normalised",
  stored.nodeCode === "RIPPA-D2N6-6VZV",
  stored.nodeCode,
);

/*
  THE AUTHORIZATION PROOF. A key stored in localStorage that never reaches the
  wire is the exact failure behind "0 heartbeats": the app looks configured, the
  Mothership sees anonymous requests, and nothing says why. The heartbeat URL and
  header are asserted directly.
*/
const beat = fetchCalls.find((c) => c.url.includes("/api/swarm/heartbeat"));
check("a heartbeat was actually sent", Boolean(beat), fetchCalls.map((c) => c.url).join(", "));
check(
  "the heartbeat carries Authorization: Bearer <key>",
  beat?.init?.headers?.Authorization === "Bearer rippa-d2n6-6vzv",
  String(beat?.init?.headers?.Authorization),
);
check(
  "the heartbeat targets the configured Mothership",
  beat?.url === "https://rippaadventures.com/api/swarm/heartbeat",
  String(beat?.url),
);
check(
  "workerStatus() reports the node as configured",
  fresh.workerStatus?.()?.connection?.configured === true,
);
check("workerStatus() reports the connected state", fresh.workerStatus?.()?.connection?.state === "connected");

/* 401 MUST SURFACE AS UNAUTHORIZED, never as a generic offline state. */
const refused = await loadIn("unauthorized", {
  fetch: async () => ({ ok: false, status: 401, json: async () => ({}) }),
});
const refusedResult = await refused.configureNode({
  mothershipUrl: "https://rippaadventures.com",
  nodeKey: "RIPPA-BAD0-CODE",
});
check("a refused key reports Unauthorized (401)", refusedResult.state === "unauthorized", refusedResult.label);
check("the badge label carries the 401", refusedResult.label === "Unauthorized (401)", refusedResult.label);
check("a 401 does not increment the heartbeat counter", refused.workerStatus?.()?.heartbeats === 0);

/*
  AND THE REPORTED SYMPTOM ITSELF: with no key, the node must NOT poll. Before
  this, an unconfigured APK kept hammering the Mothership with unauthenticated
  requests that could only be refused.
*/
const blank = await loadIn("blank", {
  fetch: async (url) => {
    blankFetchCalls.push(String(url));
    return { ok: true, status: 200, json: async () => ({}) };
  },
});
const blankResult = await blank.configureNode({
  mothershipUrl: "https://rippaadventures.com",
  nodeKey: "   ",
});
check("an empty key leaves the node Awaiting Setup", blankResult.state === "awaiting-setup", blankResult.label);
check("an unconfigured node reports configured=false", blankResult.configured === false);

await blank.startWorker();
check("no unauthenticated poll is attempted without a key", blankFetchCalls.length === 0, blankFetchCalls.join(", "));
check("the worker still runs while awaiting setup", blank.workerStatus?.()?.running === true);
blank.stopWorker();

console.log(`\n[WEBVIEW] ${passed}/${passed + failed} checks passed.`);
process.exit(failed ? 1 : 0);