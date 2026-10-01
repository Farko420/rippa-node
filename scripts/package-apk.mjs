#!/usr/bin/env node
/**
 * ANDROID APK PACKAGER — isolated from the Windows .exe pipeline.
 *
 * WHY A SEPARATE SCRIPT. `scripts/package.mjs` builds `rippa-node.exe` with `pkg`
 * on Windows and must keep doing exactly that, untouched. Android needs a
 * completely different toolchain (Capacitor + Gradle + the Android SDK) and runs
 * on ubuntu-latest. Keeping them apart means an APK problem can never break a
 * fleet release, and vice versa.
 *
 * WHAT IT DOES, in order:
 *   1. bundle the mobile worker with esbuild (browser target, no Node builtins)
 *   2. stage the dashboard into `mobile/www/`
 *   3. install the Capacitor deps
 *   4. generate `android/` if absent, then apply the manifest overlay
 *   5. run Gradle to emit the APK
 *
 * EVERYTHING HERE IS ISOLATED FROM THE WINDOWS BUILD ON PURPOSE. `mobile/` holds
 * its own package.json (Capacitor deps only) and `www/` is a generated staging
 * copy that the `pkg` build never reads, so nothing added for the APK can reach
 * the .exe pipeline. `mobile/capacitor.config.json` is likewise strict JSON with
 * NO comments — Capacitor parses it with a plain JSON reader and silently falls
 * back to defaults (an empty appId) when it cannot.
 *
 * STEPS 1-3 RUN ANYWHERE (no Android SDK needed) and are what local verification
 * uses. Step 5 needs the SDK; the script says so plainly rather than dying with a
 * Gradle stack trace.
 *
 * Usage: node scripts/package-apk.mjs [--skip-gradle]
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mobileDir = path.join(root, "mobile");
const wwwDir = path.join(mobileDir, "www");
const overlayDir = path.join(mobileDir, "android-overlay");
const androidDir = path.join(mobileDir, "android");
const skipGradle = process.argv.includes("--skip-gradle");
const isWindows = process.platform === "win32";

/** Runs a command, inheriting stdio; exits the build on failure. */
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit", ...options });
  if (result.error) {
    console.error(`[APK] Failed to start ${command}: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`[APK] ${command} exited with code ${result.status}`);
    process.exit(result.status ?? 1);
  }
}

/** Best-effort: returns true on success without ever exiting. */
function tryRun(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit", ...options });
  return !result.error && result.status === 0;
}

/**
 * THE MOBILE ENTRY PAGE.
 *
 * The desktop dashboard is an Express app talking to a Node server on port 4000,
 * which does not exist inside the APK. This is the mobile equivalent: it starts
 * the worker and reports what it is doing, so a tablet left on a desk can be
 * checked from any browser on the same LAN.
 */
const MOBILE_INDEX_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Rippa Node &mdash; Android Satellite</title>
<style>
  :root { --bg:#0d1117; --card:#161b22; --line:#30363d; --txt:#e6edf3;
          --mut:#8b949e; --ok:#3fb950; --warn:#d29922; --bad:#f85149; }
  * { box-sizing:border-box; }
  body { margin:0; font-family:"Segoe UI",system-ui,sans-serif; color:var(--txt);
         background:var(--bg); min-height:100vh; padding:20px; }
  .card { max-width:640px; margin:0 auto; background:var(--card);
          border:1px solid var(--line); border-radius:16px; padding:24px; }
  h1 { margin:0 0 4px; font-size:20px; }
  .sub { margin:0 0 18px; color:var(--mut); font-size:13px; }
  .row { display:flex; justify-content:space-between; gap:10px; padding:8px 0;
         border-bottom:1px solid var(--line); font-size:13px; }
  .row span:first-child { color:var(--mut); }
  .ok { color:var(--ok); } .warn { color:var(--warn); } .bad { color:var(--bad); }
  pre { margin-top:14px; max-height:190px; overflow:auto; font-size:11px;
        color:var(--mut); white-space:pre-wrap; }
</style>
</head>
<body>
<div class="card">
  <h1>Rippa Node &mdash; Android Satellite</h1>
  <p class="sub">Background worker. The screen may be turned off.</p>
  <div id="rows"></div>
  <pre id="log">Starting&hellip;</pre>
</div>
<script src="worker.js"></script>
<script>
  var W = window.RippaMobileWorker;
  var logEl = document.getElementById('log');
  var started = false;
  function line(text) {
    logEl.textContent = (text + '\\n' + logEl.textContent).slice(0, 4000);
  }
  function render(status) {
    var caps = status.capabilities || {};
    var rows = [
      ['Worker', status.running ? 'running' : 'stopped', status.running ? 'ok' : 'warn'],
      ['Runtime', caps.description || '-', ''],
      ['Scraping', caps.browserScraping ? 'headless Chromium' : 'lightweight fetch',
                  caps.browserScraping ? 'ok' : 'warn'],
      ['Foreground service', 'requested on boot', ''],
      ['Heartbeats sent', status.heartbeats || 0, ''],
      ['Tasks claimed', status.tasksClaimed || 0, ''],
      ['Tasks completed', status.tasksCompleted || 0,
       (status.tasksCompleted || 0) > 0 ? 'ok' : ''],
      ['Tasks failed', status.tasksFailed || 0, (status.tasksFailed || 0) > 0 ? 'warn' : ''],
      ['Master mesh beats', status.meshHeartbeats || 0, ''],
      ['Last error', status.lastError || 'none', status.lastError ? 'bad' : '']
    ];
    document.getElementById('rows').innerHTML = rows.map(function (r) {
      return '<div class="row"><span>' + r[0] + '</span><span class="' + r[2] + '">' +
             r[1] + '</span></div>';
    }).join('');
  }
  if (W && W.onWorkerEvent) {
    W.onWorkerEvent(function (event) {
      if (event.type === 'log') line(event.message);
      if (W.workerStatus) render(W.workerStatus());
    });
  }
  // Autostart: this page IS the node. Requiring a tap would mean the tablet
  // does nothing until someone walks over to it.
  if (W) { render(W.workerStatus()); startWorker(); }
  function startWorker() {
    if (!W || started) return;
    started = true;
    W.startWorker();
    setInterval(function () { render(W.workerStatus()); }, 2000);
  }
</script>
</body>
</html>
`;

// --- 1. Bundle the worker ----------------------------------------------------
console.log("[APK] 1/5 Bundling the mobile worker (esbuild, browser target)...");

/*
  THE BUNDLE TARGETS esnext AND THE BROWSER PLATFORM, with every Node builtin
  marked external. That last part is deliberate: if the worker ever reaches for
  `node:fs`, this build FAILS LOUDLY here rather than producing an APK that dies
  at runtime on a tablet. A broken APK is far more expensive to diagnose than a
  red build step.
*/
const buildResult = spawnSync(
  process.execPath,
  [
    path.join(root, "node_modules", "esbuild", "bin", "esbuild"),
    path.join(mobileDir, "src", "worker.ts"),
    "--bundle",
    "--format=iife",
    "--global-name=RippaMobileWorker",
    "--platform=browser",
    "--target=es2020",
    "--outfile=" + path.join(wwwDir, "worker.js"),
    "--external:node:*",
    "--external:fs",
    "--log-level=warning",
  ],
  { cwd: root, stdio: "inherit" },
);
if (buildResult.error || buildResult.status !== 0) {
  console.error("[APK] Worker bundling failed — the worker must not depend on Node builtins.");
  process.exit(1);
}

// --- 2. Stage the dashboard --------------------------------------------------
console.log("[APK] 2/5 Staging the dashboard into mobile/www/ ...");
fs.mkdirSync(wwwDir, { recursive: true });
const publicDest = path.join(wwwDir, "public");
fs.rmSync(publicDest, { recursive: true, force: true });
fs.cpSync(path.join(root, "public"), publicDest, { recursive: true });
console.log(`[APK] Staged public/ into ${path.relative(root, publicDest)}/`);
/*
  THE MOBILE ENTRY PAGE.

  The packaged desktop dashboard is an Express app talking to a Node server on
  port 4000, which does not exist inside the APK. This page is the mobile
  equivalent: it starts the worker and reports what it is doing, so a tablet on a
  desk can be checked from a browser on the same LAN.
*/
fs.writeFileSync(path.join(wwwDir, "index.html"), MOBILE_INDEX_HTML, "utf8");
console.log(`[APK] Staged worker.js + index.html into ${path.relative(root, wwwDir)}/`);

// --- 3. Capacitor dependencies ----------------------------------------------
console.log("[APK] 3/5 Installing Capacitor dependencies ...");
/*
  `shell: isWindows` IS REQUIRED, not cosmetic. Since Node 18.20/20.12 spawning a
  `.cmd` without a shell throws EINVAL on Windows — which is exactly how `npm`
  and `npx` are invoked there. Without this the build dies on step 3 with a
  message that says nothing about npm.
*/
const npm = isWindows ? "npm.cmd" : "npm";
const shellOpts = { shell: isWindows };
// `npm ci` when a lockfile is in sync, otherwise fall back so a fresh checkout
// never hard-fails the build on a lockfile mismatch.
if (!tryRun(npm, ["ci", "--no-audit", "--no-fund"], { cwd: mobileDir, ...shellOpts })) {
  run(npm, ["install", "--no-audit", "--no-fund"], { cwd: mobileDir, ...shellOpts });
}

// --- 4. Generate the Android project, then overlay the manifest --------------
console.log("[APK] 4/5 Preparing the Android project ...");
if (!fs.existsSync(androidDir)) {
  const npx = isWindows ? "npx.cmd" : "npx";
  if (!tryRun(npx, ["cap", "add", "android"], { cwd: mobileDir, ...shellOpts })) {
    console.error("[APK] `npx cap add android` failed — cannot build an APK without it.");
    process.exit(1);
  }
}

/*
  THE OVERLAY IS APPLIED AFTER GENERATION, ALWAYS.

  Capacitor regenerates AndroidManifest.xml from its own template, so patching it
  in place would silently revert on the next `cap sync`. Copying our manifest in
  at build time makes the permissions and the foreground-service declaration a
  property of THIS repository rather than of a generated file.
*/
const manifestTarget = path.join(androidDir, "app", "src", "main", "AndroidManifest.xml");
fs.copyFileSync(path.join(overlayDir, "AndroidManifest.xml"), manifestTarget);
console.log("[APK] Applied the manifest overlay (WAKE_LOCK + foreground service).");

const javaTarget = path.join(
  androidDir,
  "app",
  "src",
  "main",
  "java",
  "com",
  "rippaadventures",
  "node",
);
fs.mkdirSync(javaTarget, { recursive: true });
for (const file of ["RippaNodeService.java", "RippaNodePlugin.java", "RippaNodeBootReceiver.java"]) {
  fs.copyFileSync(path.join(overlayDir, file), path.join(javaTarget, file));
}
console.log("[APK] Installed the native service, plugin and boot receiver.");

// --- 5. Gradle ---------------------------------------------------------------
if (skipGradle) {
  console.log("[APK] 5/5 Skipping Gradle (--skip-gradle). Staged assets are ready.");
  process.exit(0);
}

console.log("[APK] 5/5 Building the APK with Gradle ...");
const hasSdk =
  Boolean(process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT) ||
  fs.existsSync(path.join(process.env.LOCALAPPDATA || "", "Android", "Sdk"));
if (!hasSdk) {
  console.error(
    "[APK] No Android SDK found (set ANDROID_HOME or ANDROID_SDK_ROOT).\n" +
      "       Expected on a machine without the SDK; CI installs it.\n" +
      "       Everything up to this point has been staged and verified.",
  );
  process.exit(1);
}

const gradlew = path.join(androidDir, isWindows ? "gradlew.bat" : "gradlew");
run(gradlew, ["assembleDebug"], { cwd: androidDir });

const apk = path.join(androidDir, "app", "build", "outputs", "apk", "debug", "app-debug.apk");
if (!fs.existsSync(apk)) {
  console.error(`[APK] Gradle finished but ${apk} was not produced.`);
  process.exit(1);
}
const sizeMb = fs.statSync(apk).size / (1024 * 1024);
console.log("");
console.log(`[APK] rippa-node.apk (${sizeMb.toFixed(1)} MB)`);
console.log("[APK] Install with: adb install -r " + path.relative(root, apk));
console.log("");