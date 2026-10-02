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

/*
  THE RELEASE VERSION, READ ONCE.

  Three consumers, one read: the APK's versionName/versionCode (patched into the
  generated build.gradle below), the dashboard's update-check fallback, and the
  drift assertion that keeps mobile/src/worker.ts honest. They MUST agree — an APK
  whose BuildConfig says 1.0.14 while the page compares against 1.0.13 is a node
  that offers itself an update forever — so none of them is allowed to parse
  package.json on its own.
*/
const rootPackage = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const appVersion = String(rootPackage.version ?? "");
if (!/^\d+\.\d+\.\d+/.test(appVersion)) {
  console.error(
    `[APK] package.json version "${appVersion}" is not MAJOR.MINOR.PATCH.\n` +
      "       The APK versionCode, the dashboard's update check and the release\n" +
      "       tooling all derive from it, and a version they cannot order is\n" +
      "       worse than no version at all.",
  );
  process.exit(1);
}
/*
  versionCode = major * 10000 + minor * 100 + patch. Monotonic for any version this
  project will realistically ship, and — the part that matters — it always INCREASES
  relative to the previous APK, because the installer refuses to downgrade and
  MobileBridge refuses to even prompt for one.
*/
const [major, minor, patch] = appVersion.split(".").map(Number);
const appVersionCode = major * 10000 + minor * 100 + patch;

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
  /* ---- NODE PAIRING SETUP ----------------------------------------------------
     THE CARD THAT WAS MISSING. Without it the APK opened straight onto telemetry
     showing "Heartbeats sent 0" and there was no control anywhere in the app that
     could change that, because nothing had ever written a key into localStorage.
     It sits ABOVE the telemetry on purpose: it is setup, not a statistic, and an
     operator should never have to scroll past a wall of zeroes to reach it. */
  .pair { margin-bottom:20px; padding:18px; border-radius:14px;
          border:1px solid var(--line); background:var(--bg); }
  .pair-head { display:flex; align-items:center; justify-content:space-between;
               gap:10px; margin-bottom:4px; }
  .pair-head h2 { margin:0; font-size:15px; }
  /* The badge is the whole point of the card: the operator needs to know, without
     scrolling, whether this phone is actually registered. */
  .badge { font-size:11px; font-weight:600; padding:4px 10px; border-radius:999px;
           border:1px solid var(--line); color:var(--mut); white-space:nowrap; }
  .badge.awaiting-setup { color:var(--mut); }
  .badge.connecting     { color:var(--warn); border-color:var(--warn); }
  .badge.connected      { color:var(--ok); border-color:var(--ok); }
  .badge.unauthorized   { color:var(--bad); border-color:var(--bad); }
  .badge.disconnected   { color:var(--warn); border-color:var(--warn); }
  .field { display:block; margin-top:12px; }
  .field span { display:block; font-size:12px; color:var(--mut); margin-bottom:5px; }
  /* 16px is not styling: anything smaller makes Android's WebView auto-ZOOM the
     page on focus, which then breaks the layout for every field after it. */
  .field input { width:100%; padding:10px 12px; font-size:16px;
                 background:var(--card); color:var(--txt); border:1px solid var(--line);
                 border-radius:9px; font-family:inherit; }
  .field input:focus { outline:none; border-color:var(--ok); }
  .pair .btn { width:100%; margin-top:16px; }
  .pair .saved { margin-top:10px; }
  /* ---- IN-APP UPDATE PROMPT ---------------------------------------------------
     THE CARD AN OPERATOR SHOULD NEVER HAVE TO GO LOOKING FOR. A satellite is
     unattended hardware: nobody is reading release notes, and nothing else on
     this page tells the operator a new build exists. So when there is one it sits
     ABOVE the pairing card — above everything — in the warning colour rather than
     the muted greys of the telemetry, and it is the only full-width green button
     on the screen while it is present. */
  .update { margin-bottom:20px; padding:18px; border-radius:14px;
            border:1px solid var(--warn); background:rgba(210,153,34,.14); }
  .update[hidden] { display:none; }
  .update-head { display:flex; align-items:center; justify-content:space-between;
                 gap:10px; margin-bottom:6px; flex-wrap:wrap; }
  .update-head h2 { margin:0; font-size:15px; color:var(--warn); }
  .update .badge { color:var(--warn); border-color:var(--warn); }
  .update-why { margin:0 0 6px; font-size:13px; line-height:1.5; }
  /* Release notes arrive from the Mothership, so they are inserted as TEXT and
     never as markup (see renderUpdate). pre-wrap keeps the notes' own line breaks
     without letting a long URL reflow the card off the screen. */
  .update-notes { margin:0 0 14px; padding:9px 11px; font-size:12px; line-height:1.5;
                  color:var(--mut); background:rgba(0,0,0,.25); border-radius:9px;
                  white-space:pre-wrap; word-break:break-word;
                  max-height:130px; overflow:auto; }
  .update .btn { width:100%; }
  .update .btn[disabled] { opacity:.75; }
  .update-status { margin-top:10px; font-size:11px; line-height:1.5; min-height:14px; }
  /* A spinner rather than a disabled label, so a long download on a tablet with
     no signal reads as "working" and not "broken". */
  .spinner { display:inline-block; width:12px; height:12px; margin-right:8px;
             vertical-align:-1px; border:2px solid rgba(13,17,23,.35);
             border-top-color:#0d1117; border-radius:50%;
             animation:spin .8s linear infinite; }
  @keyframes spin { to { transform:rotate(360deg); } }
</style>
</head>
<body>
<div class="card">
  <h1>Rippa Node &mdash; Android Satellite</h1>
  <p class="sub">Background worker. The screen may be turned off.</p>

  <!--
    THE IN-APP UPDATE PROMPT.

    Above everything else on purpose: it is setup, not telemetry, and a node on a
    desk is unattended hardware where nobody is watching for "new build available".
    It stays hidden until the Mothership reports a version genuinely newer than
    the one MobileBridge.getAppVersion() reports as installed — the comparison
    itself lives in the worker (checkForUpdate), because the worker is what holds
    the Mothership URL and the node key.

    The button is NOT disabled while hidden, because the whole card is hidden with
    it; everything about the update state lives in renderUpdate() and the
    rippa-update CustomEvent handler below.

    NOTE: this whole document is inside a JS template literal in the packager, so
    it must not contain a backtick, nor a dollar sign immediately followed by an
    opening brace — either one silently truncates the page at build time. (This
    sentence had to be worded twice: the obvious way to write it says the thing it
    is warning about.)
  -->
  <div class="update" id="updateCard" hidden>
    <div class="update-head">
      <h2 id="updateTitle">Update Available</h2>
      <span class="badge" id="updateFrom"></span>
    </div>
    <p class="update-why">A new version of Rippa Satellite is ready to install.</p>
    <p class="update-notes" id="updateNotes" hidden></p>
    <button class="btn" id="updateBtn" type="button">Update &amp; Install Now</button>
    <div class="update-status" id="updateStatus"></div>
  </div>

  <!--
    NODE PAIRING SETUP.

    This card is what makes the node a member of the swarm rather than a dark
    screen. Everything below it is telemetry about a connection that had no way to
    be configured: the worker reads a Mothership URL and a node key from
    localStorage, and until this card existed nothing ever WROTE either of them.
    The result was a tablet that looked alive and had sent zero heartbeats.

    The values are persisted by the worker's configureNode(), not by inline
    script here, so there is exactly one writer for the config the pollers read.
    NOTE: this whole block is inside a JS template literal, so it must not contain
    a backtick — one there silently truncates the page at build time.
  -->
  <div class="pair">
    <div class="pair-head">
      <h2>Node Connection Setup</h2>
      <span class="badge awaiting-setup" id="connBadge">Awaiting Setup</span>
    </div>
    <p class="hint">Enter the Mothership address and the node key issued by your
      Master. The key is stored on this device only and is sent as a bearer token.</p>

    <label class="field" for="pUrl">
      <span>Mothership URL</span>
      <input id="pUrl" type="text" inputmode="url" autocomplete="off"
             autocapitalize="none" spellcheck="false"
             value="https://rippaadventures.com" />
    </label>

    <label class="field" for="pKey">
      <span>Master Node / Satellite Key</span>
      <input id="pKey" type="text" autocomplete="off" autocapitalize="characters"
             spellcheck="false" placeholder="RIPPA-XXXX-XXXX" />
    </label>

    <label class="field" for="pName">
      <span>Device Name</span>
      <input id="pName" type="text" autocomplete="off"
             placeholder="Galaxy S26 Ultra" />
    </label>

    <button class="btn" id="pairSave" type="button">Save &amp; Connect</button>
    <div class="saved" id="pairSaved"></div>
  </div>

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
  var connBadge = document.getElementById('connBadge');
  var pairSavedEl = document.getElementById('pairSaved');
  /** Guards the one-time form fill, so a 2s re-render never clobbers typing. */
  var powerFormReady = false;
  /** Same guard for the pairing fields: re-seeding mid-typing would erase a key. */
  var pairFormReady = false;
  /* ---- IN-APP UPDATE PROMPT ---------------------------------------------------
     DOM handles, plus the two pieces of state the prompt needs. updatePayload is
     the last "available" result, kept so the click handler always has a URL to act
     on: an operator who taps Update fourteen minutes after the banner appeared
     must not have to wait on a fresh request, and must not lose the prompt if the
     Mothership has gone quiet in between. updateBusy is the one-tap guard. */
  var updateCard = document.getElementById('updateCard');
  var updateTitle = document.getElementById('updateTitle');
  var updateFrom = document.getElementById('updateFrom');
  var updateNotes = document.getElementById('updateNotes');
  var updateBtn = document.getElementById('updateBtn');
  var updateStatus = document.getElementById('updateStatus');
  var updatePayload = null;
  var updateBusy = false;
  /** How often the Mothership is asked whether a newer build exists. */
  var UPDATE_CHECK_MS = 15 * 60 * 1000;
  function line(text) {
    logEl.textContent = (text + '\\n' + logEl.textContent).slice(0, 4000);
  }

  /**
   * Paints the connection badge and seeds the pairing form.
   *
   * Both are driven from workerStatus(), which is the single source of truth for
   * whether this device is paired. The badge text is the worker's own label, so the
   * status shown here and the status the pollers are actually in cannot disagree.
   *
   * The form is seeded exactly once. It is filled from the STORED config rather
   * than from what was typed, and re-seeding it on every 2s tick would wipe out a
   * half-entered key between two characters.
   */
  function renderPairing(status) {
    var conn = status.connection || {};
    connBadge.textContent = conn.label || 'Disconnected';
    connBadge.className = 'badge ' + (conn.state || 'disconnected');

    if (pairFormReady || !status.config) return;
    document.getElementById('pUrl').value = status.config.mothershipUrl || '';
    document.getElementById('pKey').value = status.config.apiKey || '';
    document.getElementById('pName').value = status.config.nodeName || '';
    pairFormReady = true;
  }

  /**
   * Paints or hides the update prompt from a worker checkForUpdate() result.
   *
   * state is the only thing that decides visibility, and only "available" shows
   * the card. "current", "unavailable" and "error" all hide it: a failed version
   * check on an unattended tablet must be invisible, because the alternative — a
   * red banner about an unreachable Mothership sitting above a node that is
   * working perfectly well — is how operators learn to ignore banners.
   *
   * EVERYTHING FROM THE NETWORK IS INSERTED AS TEXT (textContent), never as HTML.
   * The release notes are written by the Mothership, and innerHTML here would make
   * a note field into a script-injection surface on a device that then has the
   * power to install an APK.
   *
   * The button is deliberately NOT reset while an install is in flight: the 2s
   * telemetry tick and the 15-minute version check both land here, and re-enabling
   * the button mid-download would invite a second tap that the native bridge then
   * rejects with "An update is already downloading".
   */
  function renderUpdate(check) {
    if (!check) return;
    if (check.state !== 'available' || !check.downloadUrl) {
      updateCard.hidden = true;
      return;
    }
    updatePayload = check;
    updateCard.hidden = false;
    updateTitle.textContent = 'Update Available (v' + check.remoteVersion + ')';
    updateFrom.textContent = 'v' + (check.currentVersion || '?') +
      ' \\u2192 v' + check.remoteVersion;
    if (check.notes) {
      updateNotes.hidden = false;
      updateNotes.textContent = check.notes;
    } else {
      updateNotes.hidden = true;
    }
    if (!updateBusy) {
      updateBtn.disabled = false;
      updateBtn.innerHTML = 'Update &amp; Install Now';
      updateStatus.textContent = bridgeHint();
      updateStatus.style.color = 'var(--mut)';
    }
  }

  /**
   * One line of advice about the Android install grant, or '' when it does not
   * apply. Checked here rather than discovered mid-download: Android 8+ makes the
   * operator grant "install unknown apps" manually, and the bridge takes them to
   * that Settings screen itself — but only if they know to expect it.
   */
  function bridgeHint() {
    try {
      if (window.mobileBridge && window.mobileBridge.canInstallPackages &&
          !window.mobileBridge.canInstallPackages()) {
        return 'Android will ask you to allow this app to install updates the ' +
          'first time. That setting is remembered.';
      }
    } catch (error) {
      /* a bridge that throws must not break the prompt */
    }
    return '';
  }

  /**
   * Asks the worker what the newest build is. Called on mount, on a 15-minute
   * timer, and once more after the pairing form is saved.
   *
   * The catch is not ceremony: checkForUpdate() is written never to reject, and
   * this second layer means a bug in it cannot take down the page's timer either.
   */
  function refreshUpdate() {
    if (!W || !W.checkForUpdate) return;
    W.checkForUpdate().then(renderUpdate).catch(function (error) {
      line('Update check failed: ' + error);
    });
  }
  /**
   * Sets the button into (or out of) its downloading state.
   *
   * The spinner is built with createElement rather than typed into innerHTML, so
   * the label can never be a source of markup.
   */
  function setUpdateBusy(busy, message, tone) {
    updateBusy = busy;
    updateBtn.disabled = busy;
    while (updateBtn.firstChild) updateBtn.removeChild(updateBtn.firstChild);
    if (busy) {
      var spinner = document.createElement('span');
      spinner.className = 'spinner';
      updateBtn.appendChild(spinner);
      updateBtn.appendChild(document.createTextNode(message || 'Downloading update\\u2026'));
    } else {
      updateBtn.textContent = 'Update & Install Now';
    }
    if (message !== undefined) {
      updateStatus.textContent = message;
      updateStatus.style.color = tone || 'var(--mut)';
    }
  }

  /**
   * THE ONE-TAP PATH.
   *
   * Native bridge: hand the URL (and the checksum, when the Mothership published
   * one) to MobileBridge, which downloads it, verifies the archive really is a
   * newer build of THIS app, and hands it to the Android package installer.
   *
   * Browser fallback: a plain navigation to the .apk. Deliberately NOT an <a
   * download> element — the same dashboard is served over http on a LAN for
   * checking a node, and in that context "Update & Install Now" has to download a
   * file rather than navigate to one.
   *
   * The button is guarded twice: updateBusy here, and a second rejection in the
   * bridge. A double-tap that got past both would leave the operator with two
   * threads writing one file, and the installer offered a truncated APK.
   */
  updateBtn.addEventListener('click', function () {
    if (updateBusy || !updatePayload || !updatePayload.downloadUrl) return;
    var bridge = window.mobileBridge;
    var url = updatePayload.downloadUrl;

    if (!bridge || typeof bridge.installApkUpdate !== 'function') {
      setUpdateBusy(true, 'Downloading in your browser\\u2026', 'var(--mut)');
      try {
        window.location.href = url;
      } catch (error) {
        setUpdateBusy(false, 'Could not start the download: ' + error, 'var(--bad)');
      }
      return;
    }

    setUpdateBusy(true, 'Downloading update\\u2026', 'var(--mut)');
    try {
      if (updatePayload.sha256) bridge.installApkUpdate(url, updatePayload.sha256);
      else bridge.installApkUpdate(url);
    } catch (error) {
      // A synchronous throw means the bridge object was replaced or is not the one
      // we expect. Falling back to a browser download beats a dead button.
      setUpdateBusy(false, 'Native install unavailable (' + error +
        '). Downloading in your browser\\u2026', 'var(--warn)');
      window.location.href = url;
    }
  });

  /**
   * Progress from the native download.
   *
   * MobileBridge cannot call back into the page directly, so it dispatches this
   * CustomEvent with detail.state/detail.message. Without this the operator would
   * be left looking at a spinner with no way to tell a 40 MB download on a weak
   * link from a hung one.
   *
   * Messages arrive as "state: detail" for failures, so the prefix is stripped
   * rather than shown twice.
   */
  window.addEventListener('rippa-update', function (event) {
    var detail = (event && event.detail) || {};
    var state = detail.state || '';
    var message = String(detail.message || '');
    var text = message.indexOf(': ') > -1 ? message.split(': ').slice(1).join(': ') : message;

    if (state === 'started') {
      setUpdateBusy(true, 'Starting download\\u2026', 'var(--mut)');
    } else if (state === 'progress') {
      updateStatus.textContent = 'Downloading update \\u00b7 ' + message;
    } else if (state === 'downloaded') {
      setUpdateBusy(true, 'Downloaded. Opening the installer\\u2026', 'var(--mut)');
    } else if (state === 'installing') {
      setUpdateBusy(true, 'Handing over to Android\\u2026', 'var(--ok)');
    } else if (state === 'error') {
      // "busy" is the bridge refusing a second concurrent download, which is a
      // transient state rather than a failure — so it must not re-enable the
      // button and leave the operator with nothing to press.
      var transient = message.indexOf('busy:') === 0;
      setUpdateBusy(transient, text || 'The update failed.', 'var(--bad)');
      line('Update failed: ' + text);
    }
  });
  // __UPDATE_UI_TAIL__
  /**
   * Persists the credentials and proves them against the Mothership.
   *
   * The button is disabled for the duration and the badge is left to the worker,
   * so the operator sees "Connecting..." and then the real outcome rather than an
   * optimistic "Saved!" that a 401 would contradict a second later.
   */
  document.getElementById('pairSave').addEventListener('click', function () {
    if (!W || !W.configureNode) return;
    var button = this;
    button.disabled = true;
    pairSavedEl.textContent = 'Connecting to the Mothership\\u2026';
    pairSavedEl.style.color = '';
    W.configureNode({
      mothershipUrl: document.getElementById('pUrl').value,
      nodeKey: document.getElementById('pKey').value,
      nodeName: document.getElementById('pName').value
    }).then(function (conn) {
      renderPairing({ connection: conn, config: W.workerStatus().config });
      // Re-check for a new build the moment the Mothership URL exists. Before this,
      // a node that had never been paired sat on the "no Mothership, nothing to
      // compare against" path until the 15-minute timer happened to fire, so the
      // update prompt could not appear for up to a quarter of an hour after setup.
      refreshUpdate();
      // A 401 or a dead network is reported as its own outcome, not as a failure
      // to save: the key IS stored either way, so the operator is not told to
      // retype something that was correctly written.
      if (conn.state === 'connected') {
        pairSavedEl.style.color = 'var(--ok)';
        pairSavedEl.textContent = 'Connected. This device is now in the swarm.';
      } else if (conn.state === 'unauthorized') {
        pairSavedEl.style.color = 'var(--bad)';
        pairSavedEl.textContent = 'The Mothership rejected that key (401). Check it and try again.';
      } else {
        pairSavedEl.style.color = 'var(--warn)';
        pairSavedEl.textContent = 'Saved, but the Mothership could not be reached. '
          + 'The node will retry on its own.';
      }
    }).catch(function (error) {
      pairSavedEl.style.color = 'var(--bad)';
      pairSavedEl.textContent = 'Could not save: ' + (error && error.message ? error.message : error);
    }).then(function () {
      button.disabled = false;
    });
  });
  function render(status) {
    var caps = status.capabilities || {};
    var conn = status.connection || {};
    var rows = [
      ['Connection', conn.label || 'Disconnected',
       conn.state === 'connected' ? 'ok' :
       (conn.state === 'awaiting-setup' || conn.state === 'unauthorized') ? 'bad' : 'warn'],
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
    renderPairing(status);
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

  // The update check runs on ITS OWN timer, not on the 2s telemetry tick. A
  // version check is a network round-trip to the Mothership; on that cadence it
  // would be 720 requests an hour against a device that may be on a metered
  // tablet connection. Fifteen minutes is also the right answer to "how stale can
  // an unattended node's software get" — a fix published at 9am is picked up the
  // same morning.
  refreshUpdate();
  setInterval(refreshUpdate, UPDATE_CHECK_MS);
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
console.log("[APK] Applied the manifest overlay (WAKE_LOCK + foreground service + updater).");

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
/*
  MainActivity is in this list NOW, which is a change of ownership worth stating.

  It used to be the one class `npx cap add android` generated and nobody owned:
  `public class MainActivity extends BridgeActivity {}`, five lines long. The WebView
  bridge has to be registered from inside it, and patching a generated file in
  place would revert on the next regeneration — the exact failure mode the overlay
  exists to prevent. So it is shipped here like every other class, and the
  component check below now verifies it too instead of excusing it.
*/
for (const file of [
  "RippaNodeService.java",
  "RippaNodePlugin.java",
  "RippaNodeBootReceiver.java",
  "MainActivity.java",
  "MobileBridge.java",
]) {
  fs.copyFileSync(path.join(overlayDir, file), path.join(javaTarget, file));
}

/*
  THE PROVIDER'S FILE ROOTS.

  `res/xml/file_paths.xml` is NOT optional garnish. FileProvider resolves
  getUriForFile() against it, and Capacitor's template version maps `external-path`
  (the whole shared volume) and `cache-path` but not `external-cache-path` — which
  is exactly where MobileBridge downloads the update APK. Left alone, the failure
  is an IllegalArgumentException the first time an operator taps Update, reported
  nowhere but in a Java stack trace on a device nobody is holding.
*/
const resTarget = path.join(androidDir, "app", "src", "main", "res");
for (const file of ["xml/file_paths.xml"]) {
  const destination = path.join(resTarget, file);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(path.join(overlayDir, "res", file), destination);
}
console.log("[APK] Staged res/xml/file_paths.xml (the FileProvider roots).");

/*
  THE GENERATED app/build.gradle NEEDS THREE FIXES, AND NONE OF THEM IS OPTIONAL.

  `app/build.gradle` is written by `npx cap add android` and has never been
  hand-maintained — until now, because the in-app updater needs `BuildConfig`.

  1. `buildFeatures { buildConfig true }`
     AGP 8 stopped generating BuildConfig unless you ask. MobileBridge.getAppVersion()
     reads BuildConfig.VERSION_NAME, so without this the Kotlin/Java compile fails
     with "cannot find symbol: BuildConfig". Verified against this repo's own last
     successful build: there is no `generated/source/buildConfig` directory and no
     BuildConfig.class in the javac output, i.e. the class genuinely does not exist
     by default here. It is a compile error, not a runtime one, so it cannot be
     worked around in Java.

  2. `versionCode` / `versionName` from the root package.json
     Capacitor's template hard-codes versionCode 1 / versionName "1.0". Left alone,
     EVERY build this repo has ever shipped claims to be the same version — so the
     version the dashboard reports to the Mothership is "1.0" on every tablet in
     the fleet, forever, and an updater that compares versions has nothing to
     compare. package.json is already the release version (.github bumps it for
     each release), so it is the single source of truth to read.

  3. `androidx.core:core` as an explicit dependency
     MobileBridge uses FileProvider. It is already on the classpath transitively
     through appcompat, and relying on that is fine until an appcompat downgrade or
     a `api` -> `implementation` change upstream turns it into an unsolvable
     compile error. variables.gradle already pins the version.

  THE PATCH IS VERIFIED, NOT ASSUMED. Each rewrite is re-read from disk below and
  the build fails loudly if any of the three did not land, because a silently
  unpatched build.gradle is exactly how a "works on my machine" updater ships.
*/
const gradleTarget = path.join(androidDir, "app", "build.gradle");

let gradle = fs.readFileSync(gradleTarget, "utf8");
gradle = gradle.replace(/versionCode\s+\d+/, `versionCode ${appVersionCode}`);
gradle = gradle.replace(/versionName\s+"[^"]*"/, `versionName "${appVersion}"`);

if (!/buildFeatures\s*{/.test(gradle)) {
  gradle = gradle.replace(
    /^(android\s*{\s*)$/m,
    `$1\n    // Emitted by scripts/package-apk.mjs — see the comment in that script.\n` +
      `    // Without this, AGP 8 does not generate BuildConfig and MobileBridge\n` +
      `    // will not compile.\n` +
      `    buildFeatures {\n        buildConfig true\n    }\n`,
  );
}

if (!gradle.includes("androidx.core:core:")) {
  gradle = gradle.replace(
    /(dependencies\s*{)/,
    `$1\n    // FileProvider, used by MobileBridge to hand a downloaded APK to the\n` +
      `    // system installer. Staged by scripts/package-apk.mjs.\n` +
      `    implementation "androidx.core:core:$androidxCoreVersion"`,
  );
}
fs.writeFileSync(gradleTarget, gradle);

const gradleApplied = fs.readFileSync(gradleTarget, "utf8");
const gradleProblems = [];
if (!/buildConfig\s+true/.test(gradleApplied)) gradleProblems.push("buildFeatures { buildConfig true }");
if (!gradleApplied.includes(`versionCode ${appVersionCode}`)) gradleProblems.push(`versionCode ${appVersionCode}`);
if (!gradleApplied.includes(`versionName "${appVersion}"`)) gradleProblems.push(`versionName "${appVersion}"`);
if (!gradleApplied.includes("androidx.core:core:")) gradleProblems.push("androidx.core:core");
if (gradleProblems.length) {
  console.error(
    `[APK] Could not patch ${path.relative(root, gradleTarget)}:\n` +
      `       missing ${gradleProblems.join(", ")}.\n` +
      "       Capacitor's Android template must have changed shape. The updater\n" +
      "       needs BuildConfig at compile time, so this has to fail here rather\n" +
      "       than halfway through a multi-minute Gradle run.",
  );
  process.exit(1);
}
console.log(`[APK] Patched app/build.gradle (BuildConfig on, version ${appVersion} / ${appVersionCode}).`);

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
  real staged .java files, at build time. `MainActivity` used to be the one
  legitimate exception — it was generated by `cap add android` into the app's own
  source set and not shipped in the overlay — but it now ships here too, because
  the WebView bridge has to be registered from inside it, so nothing is excused.
*/
const overlaySource = fs.readFileSync(path.join(overlayDir, "AndroidManifest.xml"), "utf8");

/*
  AND NO PRIVILEGED/SIGNATURE PERMISSIONS AT ALL. CHECKED, NOT ASSUMED.

  `android.permission.BATTERY_STATS` was declared in the overlay purely "for
  parity with the power-awareness feature". It is a signature|privileged
  permission, so a sideloaded APK is never granted it — the declaration was
  inert by construction — and carrying a privileged permission the app cannot
  hold is what produced the reported fatal `SecurityException` at launch
  ("Something went wrong with Rippa Node").

  Nothing needs it: @capacitor/device reads the battery via
  ACTION_BATTERY_CHANGED, a broadcast any app may observe with zero permissions.

  This is checked because the failure is invisible to every other tool in the
  chain. The manifest stays valid, the merger stays happy, Gradle exits 0, and
  the APK only reveals itself on a physical device as an instant crash on tap —
  precisely the class of bug that already cost this project one tablet.

  `FOREGROUND_SERVICE` and the typed `FOREGROUND_SERVICE_*` permissions are
  deliberately NOT matched here: those are normal, requestable permissions and
  the service genuinely needs them.
*/
const forbiddenPermissions = ["android.permission.BATTERY_STATS"];
for (const permission of forbiddenPermissions) {
  if (overlaySource.includes(`android:name="${permission}"`)) {
    console.error(
      `[APK] The manifest declares ${permission}, which was removed on purpose.\n` +
        "       It is a signature|privileged permission that a sideloaded APK is\n" +
        "       never granted, and declaring it crashes the app at launch. Battery\n" +
        "       reporting comes from ACTION_BATTERY_CHANGED via @capacitor/device\n" +
        "       and needs no permission. Remove the <uses-permission> line from\n" +
        `       ${path.relative(root, overlayDir)}/AndroidManifest.xml.`,
    );
    process.exit(1);
  }
}

const declaredComponents = [...overlaySource.matchAll(/android:name="(\.[A-Za-z0-9_]+)"/g)].map(
  (match) => `${manifestAppPackage}.${match[1].slice(1)}`,
);
const stagedJava = new Set(fs.readdirSync(javaTarget));
for (const className of declaredComponents) {
  const simple = className.slice(className.lastIndexOf(".") + 1);
  if (!stagedJava.has(`${simple}.java`)) {
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

/*
  THE IN-APP UPDATER IS WIRED END TO END. CHECKED HERE, BECAUSE IT CANNOT BE CHECKED
  ANYWHERE ELSE.

  Every one of these is a silent failure if it goes missing — the APK builds,
  installs, launches, the dashboard renders, the node joins the swarm, and the
  single "Update" button does nothing at all:

    - REQUEST_INSTALL_PACKAGES missing  -> the installer refuses the intent.
    - the FileProvider missing          -> FileProvider.getUriForFile throws
      IllegalArgumentException("Failed to find configured root"), on a tablet,
      with a stack trace nobody will ever read.
    - the provider's authority drifting from the string MobileBridge builds at
      runtime with `getPackageName() + ".provider"` -> same exception, and the two
      halves live in different files, so nothing but an assertion keeps them
      together.
    - file_paths.xml not mapping `external-cache-path` -> the updater downloads to
      getExternalCacheDir() and the provider cannot see that directory.
    - MainActivity not registering the interface -> `window.mobileBridge` is simply
      undefined in the page and every call site throws TypeError.

  Each of those is a runtime error on hardware, so the build asserts them instead.
*/
const updaterChecks = [
  [
    overlaySource.includes('android:name="android.permission.REQUEST_INSTALL_PACKAGES"'),
    "REQUEST_INSTALL_PACKAGES permission",
  ],
  [
    overlaySource.includes('android:name="androidx.core.content.FileProvider"'),
    "the androidx FileProvider",
  ],
  [
    overlaySource.includes('android:authorities="${applicationId}.provider"'),
    'the provider authority ${applicationId}.provider',
  ],
  [
    overlaySource.includes("android.support.FILE_PROVIDER_PATHS") &&
      overlaySource.includes('android:resource="@xml/file_paths"'),
    "the provider's @xml/file_paths metadata",
  ],
];

const bridgeSource = fs.readFileSync(path.join(overlayDir, "MobileBridge.java"), "utf8");
updaterChecks.push(
  [
    bridgeSource.includes('getPackageName() + ".provider"'),
    "the runtime authority MobileBridge passes to FileProvider",
  ],
  [
    /@JavascriptInterface\s+public void installApkUpdate\(String apkUrl\)/.test(bridgeSource),
    "mobileBridge.installApkUpdate(String)",
  ],
  [
    /@JavascriptInterface\s+public String getAppVersion\(\)/.test(bridgeSource),
    "mobileBridge.getAppVersion()",
  ],
  [
    /@JavascriptInterface\s+public boolean canInstallPackages\(\)/.test(bridgeSource),
    "mobileBridge.canInstallPackages()",
  ],
);

const mainActivitySource = fs.readFileSync(path.join(overlayDir, "MainActivity.java"), "utf8");
updaterChecks.push([
  /addJavascriptInterface\(\s*new MobileBridge\(/.test(mainActivitySource),
  "MainActivity registering MobileBridge as a JavascriptInterface",
]);

const filePathsSource = fs.readFileSync(path.join(overlayDir, "res", "xml", "file_paths.xml"), "utf8");
updaterChecks.push(
  [
    filePathsSource.includes("<external-cache-path"),
    "an external-cache-path root in file_paths.xml (where the APK is downloaded)",
  ],
  [
    filePathsSource.includes("<cache-path"),
    "a cache-path root in file_paths.xml (the no-external-volume fallback)",
  ],
);

const missingUpdaterPieces = updaterChecks.filter(([present]) => !present).map(([, label]) => label);
if (missingUpdaterPieces.length) {
  console.error(
    `[APK] The in-app updater is not wired end to end:\n` +
      missingUpdaterPieces.map((piece) => `         - missing ${piece}\n`).join("") +
      "       Each of these fails only at runtime, on a tablet, as a button that\n" +
      "       does nothing. Fix them here rather than in the field.",
  );
  process.exit(1);
}
console.log(`[APK] Verified ${updaterChecks.length} in-app updater wiring check(s).`);

/*
  THE UPDATE PROMPT IS WIRED TOO, AND THE FALLBACK VERSION HAS NOT DRIFTED.

  The prompt is the half of this feature that fails SILENTLY. A missing
  `refreshUpdate()` call, a renamed element id, or a `checkForUpdate` that never
  made it into the bundle all produce the same result on a tablet: a node that
  runs perfectly and never mentions that a newer build exists. There is no stack
  trace, no red screen, nothing in logcat.

  The version constant is checked for the same reason and with the same stakes.
  MobileBridge.getAppVersion() reports BuildConfig.VERSION_NAME, which is this
  same package.json version — so if the fallback constant drifts below it, a
  browser preview of the dashboard starts offering tablets an update they already
  have, and an operator learns to dismiss the banner. The APK build is where that
  is cheapest to catch.
*/
const workerSource = fs.readFileSync(path.join(mobileDir, "src", "worker.ts"), "utf8");
const fallbackVersion = /FALLBACK_APK_VERSION\s*=\s*"([^"]+)"/.exec(workerSource)?.[1];
if (fallbackVersion !== appVersion) {
  console.error(
    `[APK] mobile/src/worker.ts has FALLBACK_APK_VERSION = "${fallbackVersion}" but\n` +
      `       package.json says ${appVersion}.\n` +
      "       This constant is only used when there is no native bridge, but a\n" +
      "       stale one makes a browser preview offer an update from\n" +
      `       ${fallbackVersion} to ${appVersion} forever. Bump it, or take it from\n` +
      "       package.json at build time.",
  );
  process.exit(1);
}

const dashboard = fs.readFileSync(path.join(wwwDir, "index.html"), "utf8");
const promptChecks = [
  [dashboard.includes('id="updateCard"'), "the update card in the dashboard"],
  [dashboard.includes("Update &amp; Install Now"), 'the "Update & Install Now" button'],
  [dashboard.includes("checkForUpdate"), "the worker version check being called"],
  [dashboard.includes("installApkUpdate"), "the native install trigger"],
  [dashboard.includes("window.location.href = url"), "the browser download fallback"],
  [dashboard.includes("rippa-update"), "the native progress event listener"],
  [dashboard.includes("15 * 60 * 1000"), "the 15-minute re-check interval"],
  /*
    TEMPLATE-LITERAL LEAKAGE. The page is a JS template literal in this file, so a
    stray interpolation marker survives into the output and renders as literal
    source, and a botched one renders a bare `undefined` where a value should be.
    Both are checked by their actual signatures rather than by a bare substring
    search for "undefined", which the page legitimately contains twice
    (`!== undefined` and `=== undefined`) and would fail on forever.
  */
  [!dashboard.includes("${"), "no un-interpolated template marker in the page"],
  [!/'undefined'|"undefined"/.test(dashboard), "no interpolated value rendered as undefined"],
];
const missingPromptPieces = promptChecks.filter(([present]) => !present).map(([, label]) => label);
if (missingPromptPieces.length) {
  console.error(
    `[APK] The in-app update prompt is not wired:\n` +
      missingPromptPieces.map((piece) => `         - missing ${piece}\n`).join("") +
      "       Each of these fails silently on a tablet. Check the dashboard\n" +
      "       template in scripts/package-apk.mjs.",
  );
  process.exit(1);
}
console.log(`[APK] Verified ${promptChecks.length} update-prompt check(s); fallback version ${appVersion}.`);

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