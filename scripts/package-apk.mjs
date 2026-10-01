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
 *   4. generate `android/` if absent, sync `www/` into it, then overlay the manifest
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
  /* ---- ADVANCED SETTINGS ---------------------------------------------------
     A collapsible panel, because the node has to work unattended on a tablet:
     the operator opens this once, sets the limits, and never thinks about it
     again. Power settings only exist on Android, so the panel is hidden
     entirely elsewhere rather than shown disabled. */
  details { margin-top:18px; border:1px solid var(--line); border-radius:12px;
            background:var(--bg); }
  details[hidden] { display:none; }
  summary { cursor:pointer; padding:14px 16px; font-size:14px; font-weight:600;
            list-style:none; display:flex; align-items:center; gap:8px; }
  summary::-webkit-details-marker { display:none; }
  summary::before { content:"\\25B8"; color:var(--mut); font-size:11px; }
  details[open] summary::before { content:"\\25BE"; }
  .settings-body { padding:0 16px 16px; }
  .hint { margin:0 0 12px; font-size:12px; color:var(--mut); line-height:1.5; }
  .opt { display:flex; align-items:flex-start; gap:10px; padding:10px 0;
         border-top:1px solid var(--line); }
  .opt input[type=checkbox] { margin-top:2px; width:16px; height:16px; flex:0 0 auto;
                              accent-color:var(--ok); }
  .opt label { font-size:13px; cursor:pointer; }
  .opt .desc { display:block; color:var(--mut); font-size:11px; margin-top:3px;
               line-height:1.45; }
  .num { width:64px; padding:6px 8px; margin-top:6px; font-size:13px;
         background:var(--bg); color:var(--txt); border:1px solid var(--line);
         border-radius:8px; }
  .batt { margin-top:14px; padding:10px 12px; border-radius:10px; font-size:12px;
          background:var(--bg); border:1px solid var(--line); line-height:1.5; }
  .banner { margin-top:12px; padding:11px 13px; border-radius:10px; font-size:12px;
            line-height:1.5; background:rgba(210,153,34,.12);
            border:1px solid var(--warn); color:var(--warn); }
  .saved { margin-top:10px; font-size:11px; color:var(--ok); min-height:14px; }
  .btn { margin-top:12px; padding:10px 16px; font-size:13px; font-weight:600;
         color:#0d1117; background:var(--ok); border:0; border-radius:9px;
         cursor:pointer; }
  .btn:active { opacity:.85; }
</style>
</head>
<body>
<div class="card">
  <h1>Rippa Node &mdash; Android Satellite</h1>
  <p class="sub">Background worker. The screen may be turned off.</p>
  <div id="rows"></div>

  <!--
    BATTERY + POWER LIMITS.

    Hidden by default and revealed from render() only once a real power
    reading exists (source !== 'unavailable'). A panel offering controls that
    do nothing is worse than no panel, so it appears exactly when it can be
    effective: on Android, with the Capacitor Device plugin reporting.
  -->
  <details id="powerPanel" hidden>
    <summary>Power &amp; Battery</summary>
    <div class="settings-body">
      <div class="batt" id="powerReadout">Reading battery&hellip;</div>

      <div class="opt">
        <input type="checkbox" id="pCharging" />
        <label for="pCharging">Run only when charging
          <span class="desc">Suspend all swarm work the moment the tablet is
          unplugged, and resume on its own when a charger appears.</span></label>
      </div>

      <div class="opt">
        <input type="checkbox" id="pPause" />
        <label for="pPause">Pause below a battery level
          <span class="desc">Suspend the swarm at or under the level on the
          right. Unticked = never pause for low battery.</span></label>
        <input class="num" type="number" id="pPercent" min="0" max="100" step="1" />
      </div>

      <div class="opt">
        <input type="checkbox" id="pThrottle" />
        <label for="pThrottle">Throttle polling on battery
          <span class="desc">Stretch every poll interval 6x while discharging,
          so heartbeats cost almost nothing. Automatic at full speed on
          mains.</span></label>
      </div>

      <button class="btn" id="pSave" type="button">Save &amp; apply now</button>
      <div class="saved" id="pSaved"></div>
    </div>
  </details>

  <div class="banner" id="powerBanner" hidden></div>
  <pre id="log">Starting&hellip;</pre>
</div>
<script src="worker.js"></script>
<script>
  var W = window.RippaMobileWorker;
  var logEl = document.getElementById('log');
  var started = false;
  var powerPanel = document.getElementById('powerPanel');
  var powerBanner = document.getElementById('powerBanner');
  var powerReadout = document.getElementById('powerReadout');
  var savedEl = document.getElementById('pSaved');
  /** Guards the one-time form fill, so a 2s re-render never clobbers typing. */
  var powerFormReady = false;
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
    renderPower(status.power);
  }

  /**
   * Renders battery state, the suspension banner and the limits form.
   *
   * The panel stays hidden until the source is a real reading rather than
   * 'unavailable': showing limit controls on a platform that cannot report a
   * battery would invite an operator to tick "run only when charging" and watch
   * it do nothing. evaluatePower() fails open in that case, so the node still
   * works; we simply do not advertise the setting.
   */
  function renderPower(power) {
    if (!power) return;
    if (power.source === 'unavailable') { powerPanel.hidden = true; return; }
    powerPanel.hidden = false;

    var level = power.level === null || power.level === undefined
      ? 'unknown' : power.level + '%';
    var state = power.charging ? 'charging' : 'on battery';
    var extra = power.throttle > 1 ? ' \\u00b7 polling throttled ' +
      power.throttle + 'x' : '';
    powerReadout.textContent = 'Battery ' + level + ' \\u00b7 ' + state + extra;

    if (power.suspended) {
      powerBanner.hidden = false;
      powerBanner.textContent = power.reason ||
        'Swarm work is paused by your power limits.';
    } else {
      powerBanner.hidden = true;
    }

    // Seed the controls from the stored limits exactly once. Re-seeding on every
    // render would undo half-finished edits while the operator types.
    if (!powerFormReady && power.limits) {
      document.getElementById('pCharging').checked =
        power.limits.runOnlyWhenCharging === true;
      document.getElementById('pThrottle').checked =
        power.limits.throttlePolling === true;
      var pct = document.getElementById('pPause');
      var box = document.getElementById('pPercent');
      pct.checked = power.limits.pauseBelowPercent !== null;
      if (pct.checked) box.value = power.limits.pauseBelowPercent;
      box.disabled = !pct.checked;
      powerFormReady = true;
    }
  }

  document.getElementById('pPause').addEventListener('change', function () {
    // A greyed-out field next to an unticked box reads as broken; disable it so
    // the enabled rule is unambiguous at a glance.
    document.getElementById('pPercent').disabled = !this.checked;
  });

  /**
   * Applies the limits immediately.
   *
   * setPowerLimits() returns the NORMALISED limits the worker will actually
   * enforce, so we re-render from that rather than from the form: a blank or
   * out-of-range number field is coerced by the worker, and the UI must show the
   * coerced truth, not the operator's typo.
   */
  document.getElementById('pSave').addEventListener('click', function () {
    if (!W || !W.setPowerLimits) return;
    var paused = document.getElementById('pPause').checked;
    var box = document.getElementById('pPercent');
    var applied = W.setPowerLimits({
      runOnlyWhenCharging: document.getElementById('pCharging').checked,
      pauseBelowPercent: paused ? box.value : null,
      throttlePolling: document.getElementById('pThrottle').checked
    });
    if (paused) box.value = applied.pauseBelowPercent;
    savedEl.textContent = 'Saved. Taking effect immediately \\u2014 no restart needed.';
    setTimeout(function () { savedEl.textContent = ''; }, 4000);
    if (W.workerStatus) renderPower(W.workerStatus().power);
  });
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
console.log("[APK] 1/5 Bundling the mobile worker (browser target)...");

/*
  DELEGATED TO scripts/build-mobile-worker.mjs, which owns the bundling and —
  critically — the esbuild plugin that remaps the desktop SQLite provider onto
  a browser stub.

  It used to be inline here, which is exactly how the pipeline broke: a plain
  `esbuild --platform=browser` invocation cannot exclude `storage-desktop.ts`
  because a dynamic import does not tree-shake (esbuild resolves it during its
  scan phase, before dead-code elimination), so the build died on
  `Could not resolve "path"` from inside better-sqlite3. Splitting it out means
  the fix is unit-testable on its own — `npm run test:mobile:bundle` — with no
  Android SDK, no Gradle and no network.

  The script also guards its own output for Node builtins and exits non-zero on
  a hit, so a regression fails here in a second rather than producing an APK
  that dies on a tablet.
*/
run(process.execPath, [path.join(root, "scripts", "build-mobile-worker.mjs"), "--out", path.join(wwwDir, "worker.js")]);

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
  `cap sync` — NOT `cap copy`, and the difference is load-bearing.

  `cap copy` only moves `webDir` into `app/src/main/assets/public/`. `cap sync`
  is `copy` PLUS `update`, and `update` is what actually wires NATIVE PLUGINS:
  it writes `app/src/main/assets/capacitor.plugins.json` and regenerates
  `app/capacitor.build.gradle` with the plugin projects on its dependencies.

  With `cap copy` alone, this project shipped `capacitor.plugins.json` = `[]` and
  an EMPTY dependencies block in capacitor.build.gradle — i.e. `@capacitor/device`
  was installed in mobile/node_modules but was NOT IN THE APK AT ALL. The app
  booted fine and simply reported `source: "unavailable"` forever, because the
  bridge had no Device plugin to talk to. A silent capability loss, not an error.

  So: sync on every build, then VERIFY the plugin registry below rather than
  trusting the exit code.
*/
const npxCap = isWindows ? "npx.cmd" : "npx";
if (!tryRun(npxCap, ["cap", "sync", "android"], { cwd: mobileDir, ...shellOpts })) {
  console.error("[APK] `npx cap sync android` failed — the APK would ship stale web assets.");
  process.exit(1);
}

/*
  ...AND VERIFY IT TOOK, rather than trusting the exit code.

  Cheap and it catches the whole family: a wrong `webDir`, a silent copy failure,
  a Gradle task picking up a cached `assets/` directory. Comparing the staged
  page against the copy Gradle will package turns "the build worked" into "the
  build packaged the thing you just wrote".
*/
const androidAssets = path.join(androidDir, "app", "src", "main", "assets", "public");
for (const [staged, packaged] of [
  ["index.html", "index.html"],
  ["worker.js", "worker.js"],
]) {
  const src = path.join(wwwDir, staged);
  const dst = path.join(androidAssets, packaged);
  if (!fs.existsSync(dst)) {
    console.error(`[APK] Assets were not synced: ${dst} is missing.`);
    process.exit(1);
  }
  const a = fs.statSync(src).size;
  const b = fs.statSync(dst).size;
  if (a !== b) {
    console.error(
      `[APK] Stale asset detected: ${staged} staged ${a} B but Android has ${b} B.`,
    );
    process.exit(1);
  }
}
console.log("[APK] Synced and verified the web assets in the Android project.");

/*
  ...AND VERIFY THE PLUGIN REGISTRY IS NOT EMPTY.

  `cap sync` writes `app/src/main/assets/capacitor.plugins.json`. An empty `[]`
  means no native plugin was linked, which is precisely the state that shipped
  before: the app launches and runs perfectly, while every battery reading comes
  back `source: "unavailable"` because the bridge has no Device plugin behind it.
  That is a capability regression with no error message anywhere, so it is
  asserted here instead of discovered on a tablet at 2am.
*/
const pluginsJson = path.join(
  androidDir,
  "app",
  "src",
  "main",
  "assets",
  "capacitor.plugins.json",
);
let pluginNames = [];
try {
  const parsed = JSON.parse(fs.readFileSync(pluginsJson, "utf8"));
  // Capacitor 6 writes a FLAT ARRAY of {pkg, classpath}; earlier majors wrote an
  // object keyed by plugin name. Both shapes are handled so this check does not
  // become a version tripwire.
  const entries = Array.isArray(parsed)
    ? parsed.map((entry) => entry?.classpath ?? "")
    : Object.keys(parsed?.plugins ?? {});
  pluginNames = entries.filter(Boolean).map((entry) => entry.split(".").pop());
} catch (error) {
  console.error(`[APK] Could not read ${pluginsJson}: ${error.message}`);
  process.exit(1);
}
if (!pluginNames.includes("DevicePlugin")) {
  console.error(
    `[APK] The Device plugin was not synced (registered: ${pluginNames.join(", ") || "none"}).\n` +
      "       @capacitor/device is what reports battery level while the screen is\n" +
      "       off. Without it the node runs, but blind. Check mobile/package.json\n" +
      "       and that `cap sync` (not `cap copy`) is running.",
  );
  process.exit(1);
}
console.log(`[APK] Capacitor plugins registered: ${pluginNames.join(", ")}`);

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

/** The application id, taken from the single source of truth for it. */
const manifestAppPackage = JSON.parse(
  fs.readFileSync(path.join(mobileDir, "capacitor.config.json"), "utf8"),
).appId;
console.log("[APK] Installed the native service, plugin and boot receiver.");

/*
  EVERY CLASS THIS OVERLAY NAMES MUST ACTUALLY EXIST. CHECKED, NOT ASSUMED.

  This is the guard for the crash that shipped as "instant native crash on
  launch, 0 bytes of Data/Cache". The overlay declared
  `android:name="com.rippaadventures.node.RippaNodeApplication"`, no such class
  existed in ANY toolchain output, and Android killed the process in
  handleBindApplication before it ever reached a WebView.

  Gradle cannot catch it. A missing Application class is not a compile error and
  not a manifest-merger error — the manifest is perfectly valid and the merger
  is perfectly happy. The APK builds, installs, and dies on tap. Worse, the
  failure is invisible until someone installs it on a physical device, which is
  exactly how it reached a tablet.

  So the component classes the overlay wires up are resolved here, against the
  real staged .java files, at build time. `MainActivity` is the one legitimate
  exception: it is generated by `cap add android` into the app's own source set,
  not shipped in the overlay.
*/
const overlaySource = fs.readFileSync(path.join(overlayDir, "AndroidManifest.xml"), "utf8");
const declaredComponents = [...overlaySource.matchAll(/android:name="(\.[A-Za-z0-9_]+)"/g)].map(
  (match) => `${manifestAppPackage}.${match[1].slice(1)}`,
);
for (const className of declaredComponents) {
  if (className === `${manifestAppPackage}.MainActivity`) continue;
  const simple = className.slice(className.lastIndexOf(".") + 1);
  const staged = fs
    .readdirSync(javaTarget)
    .some((file) => file === `${simple}.java`);
  if (!staged) {
    console.error(
      `[APK] The manifest names ${className} but no ${simple}.java is staged.\n` +
        "       Android instantiates these before the WebView exists, so a missing\n" +
        "       one is an instant crash on launch with no build-time error at all.\n" +
        `       Add the class to ${path.relative(root, overlayDir)}/ or stop naming it.`,
    );
    process.exit(1);
  }
}
console.log(
  `[APK] Verified ${declaredComponents.length} manifest component class(es) exist.`,
);

// --- 5. Gradle ---------------------------------------------------------------
if (skipGradle) {
  console.log("[APK] 5/5 Skipping Gradle (--skip-gradle). Staged assets are ready.");
  process.exit(0);
}

console.log("[APK] 5/5 Building the APK with Gradle ...");

/*
  PREFLIGHT. Gradle needs BOTH an Android SDK and a JDK, and when the JDK is
  missing Gradle exits 9009 after a confusing multi-line banner that mentions
  JAVA_HOME but never says which tool was not found. Checking both up front lets
  this script name the actual missing piece.

  The SDK check also honours the Windows default install location, because a
  developer machine typically has the SDK installed but neither ANDROID_HOME nor
  ANDROID_SDK_ROOT exported — the common case, not an edge case.
*/
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

/** True when a JDK is reachable, via JAVA_HOME or java on PATH. */
function hasJdk() {
  if (process.env.JAVA_HOME && fs.existsSync(process.env.JAVA_HOME)) return true;
  const probe = isWindows ? spawnSync("where", ["java"]) : spawnSync("which", ["java"]);
  return probe.status === 0;
}

if (!hasJdk()) {
  console.error(
    "[APK] No JDK found. Gradle needs a Java 17+ runtime.\n" +
      "       Set JAVA_HOME, or install a JDK (CI uses Temurin 17 via setup-java).\n" +
      "       Everything up to this point has been staged and verified —\n" +
      "       run with --skip-gradle to stage without building.",
  );
  process.exit(1);
}

const gradlew = path.join(androidDir, isWindows ? "gradlew.bat" : "gradlew");
/*
  TWO Windows-specific hazards, both hit and fixed while verifying this pipeline.

  1. `shell: isWindows` is REQUIRED, not cosmetic, and mirrors what step 3 already
     does for npm. Since Node 18.20/20.12, spawnSync() of a `.bat` WITHOUT a
     shell fails with EINVAL.
  2. With a shell enabled, the command is re-parsed by cmd.exe — and this
     workspace path contains a space ("Rippa Node"), so an unquoted path dies
     with "'C:\Projects\Rippa' is not recognized...". Quoting is therefore
     mandatory whenever the shell is used, not just when the path has a space:
     it is the only form that is correct on both.

  `shell: false` when not on Windows keeps the POSIX path free of an extra
  shell layer, where a quoted argument would become a literal quoted filename.
*/
if (isWindows) {
  run(`"${gradlew}"`, ["assembleDebug"], { cwd: androidDir, shell: true });
} else {
  run(gradlew, ["assembleDebug"], { cwd: androidDir });
}

const apk = path.join(androidDir, "app", "build", "outputs", "apk", "debug", "app-debug.apk");
if (!fs.existsSync(apk)) {
  console.error(`[APK] Gradle finished but ${apk} was not produced.`);
  process.exit(1);
}

// Copy APK to workspace root for easy sideloading
const rootApk = path.join(root, "rippa-satellite.apk");
fs.copyFileSync(apk, rootApk);
console.log(`[APK] Copied to workspace root: rippa-satellite.apk`);

const sizeMb = fs.statSync(apk).size / (1024 * 1024);
console.log("");
console.log(`[APK] ✔ rippa-satellite.apk (${sizeMb.toFixed(1)} MB)`);
console.log("[APK] Sideload with: adb install -r rippa-satellite.apk");
console.log("");