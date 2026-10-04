/**
 * PROVES THE `1.0.19` FALLBACK DEAD END IS BROKEN, AGAINST THE REAL WEBVIEW BUNDLE.
 *
 * THE REPORTED SYMPTOM. A tablet running 1.0.27 showed "App Updates v1.0.27" and,
 * at the same time, "This device is on the latest build (v1.0.19)". The Mothership
 * answers `/api/node/latest-version` from a HARDCODED fallback whenever its GitHub
 * lookup fails — and the release repo is private, so it fails on every poll. The
 * tablet compared 1.0.19 against 1.0.27, correctly decided it was not newer, and
 * reported the contradiction back to the operator, who then had no way to install
 * a build at all.
 *
 * The fix has two halves and BOTH are asserted here:
 *
 *   1. A FORCED check (`{force: true}` — what the "Check for Updates" button
 *      sends) offers the published APK instead of consulting the version gate, so
 *      a stale advertised number can no longer trap the device.
 *   2. The dedicated `/api/node/latest-apk` route is preferred, because it never
 *      performs a GitHub lookup and therefore never falls back in the first place.
 *
 * The stale fallback is reproduced by serving `1.0.19` from a stub Mothership, so
 * this test fails against the old code for the same reason a real tablet did.
 *
 * Run: npm run build:apk:bundle && node scripts/verify-mobile-update.mjs
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bundlePath = path.join(root, "mobile", "www", "worker.js");

let passed = 0;
let failed = 0;
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
  console.error(`[MOBILE-UPDATE] ${bundlePath} not found. Run: npm run build:apk:bundle`);
  process.exit(1);
}

/**
 * Evaluates the bundle in a WebView-shaped scope with a stub `fetch`.
 *
 * `stub` maps a URL path fragment to a Response factory, so each scenario can
 * present the bundle with exactly the payload a misconfigured Mothership sends.
 */
function boot(stub, opts = {}) {
  const store = new Map();
  const requested = [];
  const sandbox = {
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => void store.set(k, String(v)),
      removeItem: (k) => void store.delete(k),
    },
    setInterval: () => 0,
    clearInterval: () => {},
    setTimeout: () => 0,
    clearTimeout: () => {},
    fetch: async (url) => {
      const asString = String(url);
      requested.push(asString);
      for (const [fragment, respond] of Object.entries(stub)) {
        if (asString.includes(fragment)) return respond();
      }
      return new Response("not found", { status: 404 });
    },
    console: { log() {}, warn() {}, error() {}, info() {} },
  };
  // A native bridge reporting the INSTALLED build, exactly as on a real device.
  if (opts.installedVersion) {
    sandbox.mobileBridge = {
      getAppVersion: () => opts.installedVersion,
      canInstallPackages: () => true,
    };
  }
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.Response = Response;
  sandbox.Request = Request;
  sandbox.Headers = Headers;
  sandbox.AbortController = AbortController;

  const context = vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(bundlePath, "utf8"), context, { filename: "worker.js" });

  const worker = sandbox.window.RippaMobileWorker;
  worker.configureNode({
    mothershipUrl: opts.mothershipUrl ?? "https://mothership.test",
    nodeKey: "nk_test_key_0001",
    nodeName: "Tablet",
  });
  return { worker, requested };
}

const json = (body) => () =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const INSTALLED = "1.0.27";

/** The poisoned feed: GitHub 404'd, so the hard-coded fallback answered. */
const STALE_FALLBACK = {
  ok: true,
  version: "1.0.19",
  tag_name: "v1.0.19",
  download_url: "https://mothership.test/api/download/apk",
};

console.log("\n[MOBILE-UPDATE] 1. The preferred route is the APK feed, not the poisoned one");
{
  const { worker, requested } = boot(
    {
      "/api/node/latest-apk": json({
        ok: true,
        version: "1.0.28",
        download_url: "https://mothership.test/api/download/apk",
        authoritative_download: true,
      }),
    },
    { installedVersion: INSTALLED },
  );

  const result = await worker.checkForUpdate();
  /*
    The first request overall is the heartbeat that `configureNode` fires, so the
    assertion looks at the update requests only — otherwise this would only pass
    by accident of scheduling.
  */
  const updateRequests = requested.filter((u) => u.includes("/api/node/"));
  check(
    "the APK feed is tried before the version feed",
    updateRequests[0]?.includes("/api/node/latest-apk"),
    `update requests were ${JSON.stringify(updateRequests)}`,
  );
  check("it resolves to the published build", result.state === "available", result.state);
  check(
    "the download URL is carried through",
    result.downloadUrl === "https://mothership.test/api/download/apk",
    result.downloadUrl,
  );
}

console.log("\n[MOBILE-UPDATE] 2. A FORCED check escapes the stale 1.0.19 fallback");
{
  const { worker } = boot(
    {
      "/api/node/latest-version": json(STALE_FALLBACK),
      "/api/node/apk-version": json(STALE_FALLBACK),
    },
    { installedVersion: INSTALLED },
  );

  /*
    The background poll stays conservative, and this is asserted FIRST on
    purpose: if it started forcing too, a tablet would be prompted to reinstall
    the same APK every 15 minutes, which is a worse failure than the original.
  */
  const passive = await worker.checkForUpdate();
  check(
    "the BACKGROUND poll still refuses the stale 1.0.19 fallback",
    passive.state === "current",
    `state was ${passive.state}`,
  );
  check(
    "and it offers no download for a build the device already has",
    passive.downloadUrl === "",
    passive.downloadUrl,
  );

  const forced = await worker.checkForUpdate({ force: true });
  check(
    "a FORCED check offers the APK despite the stale version",
    forced.state === "available",
    `state ${forced.state} (remote ${forced.remoteVersion}, local ${forced.currentVersion})`,
  );
  check(
    "the forced result carries a usable download URL",
    forced.downloadUrl === "https://mothership.test/api/download/apk",
    forced.downloadUrl,
  );
  check(
    "the forced result still reports the true installed version",
    forced.currentVersion === INSTALLED,
    forced.currentVersion,
  );
}

console.log("\n[MOBILE-UPDATE] 3. The dashboard never claims a STALE version is 'latest'");
{
  const dashboard = fs.readFileSync(path.join(root, "mobile", "www", "index.html"), "utf8");
  /*
    Assertions run against EXECUTABLE code only. The phrase appears inside the
    comment that explains why it was removed, so matching the raw document would
    fail forever; stripping comments first means this checks the string a user
    could actually be shown.
  */
  const code = dashboard
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, " ");

  /*
    The removed wording was 'This device is on the latest build (v' + remote + ')',
    which rendered the self-contradictory "latest build (v1.0.19)" on a 1.0.27
    device. The status must now name the INSTALLED build instead.
  */
  check(
    "the 'latest build' line no longer interpolates the remote version",
    !code.includes("This device is on the latest build"),
    "the self-contradictory wording is still in the shipped page",
  );
  check("the status reports the installed version instead", /This device is running v/.test(code));
  check(
    "the manual button sends force: true",
    /checkForUpdate\(\{\s*force: true\s*\}\)/.test(code),
  );
  check("a forced check also raises the install banner", /renderUpdate\(check\)/.test(code));
  check(
    "no developer prose leaked into the page",
    !/rippa-update CustomEvent handler below/.test(
      dashboard.replace(/<!--[\s\S]*?-->/g, " "),
    ),
  );
}

console.log(`\n[MOBILE-UPDATE] ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);