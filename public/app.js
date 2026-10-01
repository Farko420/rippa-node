const $ = (id) => document.getElementById(id);
const role = $("role"), mothership = $("mothership"), masterUrl = $("masterUrl");
const nodeName = $("nodeName"), apiKey = $("apiKey"), port = $("port"), ollama = $("ollama");
const roleHint = $("roleHint"), mothershipWrap = $("mothershipWrap"), masterUrlWrap = $("masterUrlWrap");
const statusPill = $("statusPill"), keyState = $("keyState"), alertBox = $("alert"), saveBtn = $("save");
const dashPin = $("dashPin"), pinState = $("pinState");
const lockScreen = $("lockScreen"), dashCard = $("dashCard"), unlockPin = $("unlockPin");
const bootScreen = $("bootScreen"), setupBanner = $("setupBanner"), setupGaps = $("setupGaps");
// The setup form and the Master Control Center are SEPARATE containers in
// index.html. Keeping them distinct is what lets a successful save actually
// leave the setup screen instead of re-rendering it.
const setupContainer = $("setupContainer"), dashboardContainer = $("dashboardContainer");
const unlockBtn = $("unlockBtn"), lockAlert = $("lockAlert"), lockSub = $("lockSub");
const satBridge = $("satBridge"), satMasterLabel = $("satMasterLabel");
const bridgeLink = $("bridgeLink"), copyMasterBtn = $("copyMaster"), lockBtn = $("lockBtn");
// LAN auto-discovery + cloud link (satellite setup).
const scanBtn = $("scanBtn"), masterPicker = $("masterPicker"), scanState = $("scanState");
const cloudLinkWrap = $("cloudLinkWrap"), cloudLink = $("cloudLink");

const TOKEN_KEY = "rippa_dashboard_auth";
let masterBridgeUrl = "";

/**
 * Which screen is currently authoritative: "boot" | "setup" | "locked" | "dashboard".
 *
 * This is the single source of truth for screen visibility. Every container
 * (#bootScreen, #lockScreen, #setupContainer, #dashboardContainer) ships with the
 * `hidden` attribute in index.html, and `showScreen()` is the only function
 * allowed to reveal one - it always hides the others in the same synchronous
 * step, so a screen can never be painted over another (the Lock -> Setup
 * flicker).
 *
 * THE SETUP TRAP, EXPLICITLY: `setup` and `dashboard` are DIFFERENT containers.
 * The setup form lives in #setupContainer and the Master Control Center lives in
 * #dashboardContainer. An earlier build pointed both modes at the same
 * #dashCard element, so "showing the dashboard" just re-showed the config form
 * and a successful save appeared to do nothing. They are now separate, and
 * transitioning means hiding one and showing the other.
 */

/**
 * Shows exactly one top-level screen and hides the others, atomically.
 *
 * Both the `hidden` ATTRIBUTE and the legacy `hidden` CLASS are toggled, plus
 * the inline `display` style. The attribute is what index.html ships and what
 * `[hidden]{display:none!important}` in styles.css keys off; the class/style
 * are kept so stale cached markup or CSS can never leave two screens visible
 * at the same time.
 *
 * `display:block` is set explicitly for the dashboard because the Control
 * Center's own layout rules expect a block container.
 *
 * @param {"boot"|"setup"|"locked"|"dashboard"} screen
 */
function showScreen(screen) {
  currentScreen = screen;
  const set = (el, visible, display) => {
    if (!el) return;
    if (visible) {
      el.removeAttribute("hidden");
      el.classList.remove("hidden");
      el.style.display = display || "";
    } else {
      el.setAttribute("hidden", "");
      el.classList.add("hidden");
      el.style.display = "none";
    }
  };
  set(bootScreen, screen === "boot");
  set(lockScreen, screen === "locked");
  // Setup and Dashboard are mutually exclusive containers. Showing one always
  // hides the other in the same synchronous step - this is the fix for the
  // operator being stranded on the setup screen after a successful save.
  set(setupContainer, screen === "setup", "flex");
  set(dashboardContainer, screen === "dashboard", "block");
  if (setupBanner) setupBanner.hidden = screen !== "setup";
  // Expose the mode for CSS/inspection; handy when diagnosing a flicker.
  try { if (document.body) document.body.setAttribute("data-screen", screen); } catch (err) { /* noop */ }
  if (screen === "locked") {
    setTimeout(() => { try { if (unlockPin) unlockPin.focus(); } catch (err) { /* noop */ } }, 50);
  }
}

let currentScreen = "boot";

/**
 * True once the operator has explicitly opened the settings on a CONFIGURED
 * node (the Control Center's "Setup" button).
 *
 * While set, load() will not auto-advance to the dashboard, so the form stays on
 * screen while it is being read. It is cleared the moment the operator lands on
 * the dashboard through any other path, so the trap escape hatch is always armed
 * except during a deliberate settings visit.
 */
let userPinnedToSetup = false;

/**
 * Last config loaded from /api/system/config, kept as the authoritative source
 * for the Master URL so bridge actions work before/without touching the input.
 */
let configState = {};

/**
 * True once the user has edited/cleared the Master field. When set, the cached
 * config value is NOT used as a fallback — otherwise deliberately clearing the
 * field would silently fall back to the saved URL and still open a Master.
 */
let masterUrlEdited = false;

/**
 * Resolves the Master Command Center URL.
 *
 * Precedence: the live input first (so a typed value wins), then the last
 * remembered selection, then the loaded config state as a fallback for the
 * case where the field was never touched.
 * Returns "" when no Master has been configured.
 */
function resolveMasterUrl() {
  const fromInput = ((masterUrl && masterUrl.value) || "").trim();
  if (fromInput) return fromInput;
  const fromSelection = (masterBridgeUrl || "").trim();
  if (fromSelection) return fromSelection;
  if (masterUrlEdited) return "";
  return (configState.master_node_url || configState.MASTER_LOCAL_URL || "").trim();
}

function showAlert(msg, kind) {
  if (!alertBox) return;
  alertBox.textContent = msg;
  alertBox.className = "alert " + kind;
  alertBox.classList.remove("hidden");
}
function hideAlert() { if (alertBox) alertBox.classList.add("hidden"); }
function showLockAlert(msg) {
  if (!lockAlert) return;
  lockAlert.textContent = msg;
  lockAlert.className = "alert err";
  lockAlert.classList.remove("hidden");
}
function hideLockAlert() { if (lockAlert) lockAlert.classList.add("hidden"); }

function getToken() {
  try {
    const fromStorage = localStorage.getItem(TOKEN_KEY) || "";
    if (fromStorage) return fromStorage;
  } catch (err) { /* private mode — cookie session still works */ }
  try {
    const match = document.cookie.match(/(?:^|;\s*)rippa_dashboard_auth=([^;]*)/);
    return match ? decodeURIComponent(match[1]) : "";
  } catch (err) { return ""; }
}
function setToken(t) {
  try {
    if (t) localStorage.setItem(TOKEN_KEY, t);
    else localStorage.removeItem(TOKEN_KEY);
  } catch (err) { /* private mode — cookie session still works */ }
}
function authHeaders() {
  const t = getToken();
  return t ? { Authorization: "Bearer " + t } : {};
}

function showLocked(hint) {
  showScreen("locked");
  if (hint && lockSub) lockSub.textContent = hint;
  else if (lockSub) lockSub.textContent = "Enter the Master passkey to manage this node.";
}
function showUnlocked() {
  // CRITICAL: the UI is updated in the same tick as the state change — never
  // wait for load()/refresh. showScreen() guarantees only one screen is
  // visible, so a slow /api/system/config cannot re-introduce the flicker.
  showScreen(currentScreen === "setup" ? "setup" : "dashboard");
  try { if (unlockPin) unlockPin.value = ""; } catch (err) { /* noop */ }
  try { hideLockAlert(); } catch (err) { /* noop */ }
  try { refreshRole(); } catch (err) { /* noop */ }
}

function refreshRole() {
  if (!role) return;
  const isSat = role.value === "satellite";
  if (mothershipWrap) mothershipWrap.classList.toggle("hidden", isSat);
  if (masterUrlWrap) masterUrlWrap.classList.toggle("hidden", !isSat);
  if (cloudLinkWrap) cloudLinkWrap.classList.toggle("hidden", !isSat);
  if (roleHint) roleHint.textContent = isSat
    ? "Satellite forwards through a Master on your LAN."
    : "Master connects directly to the Mothership cloud.";
  const dashSub = $("dashSub");
  if (dashSub) dashSub.textContent = isSat ? "Satellite Node — Local Stats + Master Bridge" : "Master Command Center";
  try { refreshBridge(); } catch (err) { /* noop */ }
}

/**
 * Points the native bridge anchor at the resolved Master URL.
 *
 * The "Open Master Command Center" control is a real <a target="_blank">, so
 * the browser performs the navigation itself: no click listener, no
 * window.open() and therefore no pop-up blocker and no form/default action to
 * swallow the click (both of which made the old <button> appear to flicker).
 * `noopener noreferrer` is hard-coded in index.html, so the Master page can
 * never reach back through window.opener.
 *
 * When no Master is configured yet the href is REMOVED rather than blanked. An
 * anchor without href is inert — it cannot navigate and is not focusable — so
 * there is nothing for the browser to "flicker" to, and the CSS renders it in
 * a disabled state instead of as a live link.
 *
 * @param {string} url The Master URL, or "" when none is configured.
 */
function applyBridgeHref(url) {
  if (!bridgeLink) return;
  const target = (url || "").trim();
  if (target) {
    bridgeLink.href = target;
    bridgeLink.removeAttribute("aria-disabled");
    bridgeLink.removeAttribute("title");
  } else {
    bridgeLink.removeAttribute("href");
    bridgeLink.setAttribute("aria-disabled", "true");
    bridgeLink.setAttribute("title", "Set the Master Node URL below to enable this link");
  }
}

function refreshBridge() {
  if (!role || !satBridge) return;
  const isSat = role.value === "satellite";
  const url = resolveMasterUrl();
  satBridge.classList.toggle("hidden", !isSat);
  if (isSat && satMasterLabel) satMasterLabel.textContent = url ? ("Master: " + url) : "Set the Master Node URL below.";
  applyBridgeHref(url);
}
if (role) role.addEventListener("change", refreshRole);
if (masterUrl) masterUrl.addEventListener("input", () => { masterBridgeUrl = masterUrl.value; masterUrlEdited = true; refreshBridge(); });

/**
 * LAN AUTO-DISCOVERY.
 *
 * Asks the node to listen for Master beacons for ~3 seconds, then fills the
 * dropdown. Picking an entry writes the URL into the Master field so the
 * existing bridge/save logic works unchanged. The manual text input below is
 * always kept, so a user on an unusual network can still type an address.
 */
function setScanState(text) {
  if (scanState) scanState.textContent = text;
}

function populateMasterPicker(masters) {
  if (!masterPicker) return;
  const current = masterBridgeUrl || (masterUrl && masterUrl.value) || "";
  masterPicker.innerHTML = "";
  const blank = document.createElement("option");
  blank.value = "";
  blank.textContent = "— No Master selected —";
  masterPicker.appendChild(blank);
  (masters || []).forEach((m) => {
    const opt = document.createElement("option");
    opt.value = m.url;
    opt.textContent = `${m.nodeName} — ${m.ipAddress}${m.port ? ":" + m.port : ""}`;
    masterPicker.appendChild(opt);
  });
  // Preselect the Master already configured, if we found it again.
  if (current && [...masterPicker.options].some((o) => o.value === current)) {
    masterPicker.value = current;
  }
}

async function scanForMasters() {
  if (!scanBtn) return;
  scanBtn.disabled = true;
  scanBtn.textContent = "Scanning…";
  setScanState("Listening for Master nodes on this network (about 3 seconds)…");
  try {
    const res = await fetch("/api/system/network/scan", {
      credentials: "same-origin",
      headers: authHeaders(),
    });
    if (res.status === 401) { showLocked(); return; }
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.success) throw new Error("scan failed");
    const masters = data.masters || [];
    populateMasterPicker(masters);
    if (masters.length === 0) {
      setScanState("No Masters found. Make sure the Master is running on this network, or type its address below.");
    } else {
      setScanState(`Found ${masters.length} Master${masters.length === 1 ? "" : "s"}. Select one above, or type an address below.`);
      // Auto-select the single obvious choice to save a click.
      if (masters.length === 1 && masterUrl) {
        masterUrl.value = masters[0].url;
        masterBridgeUrl = masters[0].url;
        if (masterPicker) masterPicker.value = masters[0].url;
        refreshBridge();
      }
    }
  } catch (e) {
    setScanState("Scan failed — check that this node is reachable, or type the Master address below.");
  } finally {
    scanBtn.disabled = false;
    scanBtn.textContent = "📡 Scan Local Network";
  }
}

if (scanBtn) scanBtn.addEventListener("click", () => { void scanForMasters(); });
// The relay code is 6 digits; strip anything else as it is typed.
if (cloudLink) cloudLink.addEventListener("input", () => {
  const digits = cloudLink.value.replace(/\D+/g, "").slice(0, 6);
  if (cloudLink.value !== digits) cloudLink.value = digits;
});
if (masterPicker) masterPicker.addEventListener("change", () => {
  const url = masterPicker.value;
  if (!url) return;
  if (masterUrl) masterUrl.value = url;
  masterBridgeUrl = url;
  refreshBridge();
  setScanState("Master selected. Save to apply.");
});
// Keep the dropdown in sync when the address is typed by hand.
if (masterUrl) masterUrl.addEventListener("input", () => {
  if (masterPicker && masterUrl.value !== masterPicker.value) masterPicker.value = "";
});

/**
 * The "Open Master Command Center" control is a native <a> in index.html and
 * intentionally has NO click listener here.
 *
 * This used to be a <button> with a `window.open()` handler plus a
 * `window.location.href` fallback. That was defeated twice over: the pop-up
 * blocker refused the programmatic `window.open()`, and the fallback navigated
 * this Satellite dashboard away (which the user saw as the page flickering).
 * The href is now set from the config state by applyBridgeHref(), so the
 * browser handles the click natively — unblockable and flicker-free.
 */
if (copyMasterBtn) copyMasterBtn.addEventListener("click", async (event) => {
  event.preventDefault();
  const url = resolveMasterUrl();
  if (!url) return;
  try { await navigator.clipboard.writeText(url); showAlert("Master URL copied.", "ok"); }
  catch (e) { showAlert("Copy failed: " + e.message, "err"); }
});

const toggleKeyBtn = $("toggleKey");
if (toggleKeyBtn && apiKey) toggleKeyBtn.addEventListener("click", () => {
  apiKey.type = apiKey.type === "password" ? "text" : "password";
});
const togglePinBtn = $("togglePin");
if (togglePinBtn && dashPin) togglePinBtn.addEventListener("click", () => {
  dashPin.type = dashPin.type === "password" ? "text" : "password";
});

async function unlock(pin) {
  hideLockAlert();
  if (!pin) { showLockAlert("Enter the passkey to continue."); return false; }
  if (!unlockBtn) { showLockAlert("Unlock button not ready — reload the page."); return false; }
  unlockBtn.disabled = true;
  unlockBtn.textContent = "Unlocking…";
  try {
    const res = await fetch("/api/system/auth", {
      method: "POST",
      credentials: "same-origin",
      headers: Object.assign({ "Content-Type": "application/json" }, authHeaders()),
      body: JSON.stringify({ pin: pin }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !(data && (data.success || data.authenticated))) {
      showLockAlert((data && data.message) || "Incorrect passkey.");
      return false;
    }
    // Persist session token (cookie session is primary; localStorage is backup).
    try { if (data.token) setToken(data.token); } catch (err) { /* noop */ }
    // CRITICAL FIX: transition the UI immediately — do NOT wait for load().
    // showUnlocked() hides #lockScreen, shows #dashCard, and refreshes the view.
    try { showUnlocked(); } catch (uiErr) {
      // Last-resort DOM fallback so a missing helper can never strand the user.
      // Goes through showScreen() so the `hidden` attribute, the class and the
      // inline style can never disagree about which screen is visible.
      try {
        showScreen("dashboard");
      } catch (err2) {
        try {
          if (lockScreen) { lockScreen.setAttribute("hidden", ""); lockScreen.style.display = "none"; }
          if (dashCard) { dashCard.removeAttribute("hidden"); dashCard.style.removeProperty("display"); }
        } catch (err3) { /* noop */ }
      }
    }
    try {
      await load();
    } catch (loadErr) {
      // load() failure must NOT re-lock a just-authenticated session.
      try { showAlert("Unlocked, but config failed to load: " + loadErr.message, "err"); } catch (err2) { /* noop */ }
    }
    // Re-assert unlocked state in case load() hit a transient 401/flash.
    try { showUnlocked(); } catch (err) { /* noop */ }
    return true;
  } catch (e) {
    showLockAlert("Unlock failed: " + (e && e.message ? e.message : e));
    return false;
  } finally {
    try {
      unlockBtn.disabled = false;
      unlockBtn.textContent = "🔓 Unlock Command Center";
    } catch (err) { /* noop */ }
  }
}
if (unlockBtn) unlockBtn.addEventListener("click", (event) => { try { if (event) event.preventDefault(); } catch (err) { /* noop */ } try { unlock(unlockPin.value.trim()); } catch (e) { showLockAlert("Unlock failed: " + e.message); } });
if (unlockPin) unlockPin.addEventListener("keydown", (e) => {
  if (e.key === "Enter") { try { e.preventDefault(); } catch (err) { /* noop */ } try { unlock(unlockPin.value.trim()); } catch (err) { showLockAlert("Unlock failed: " + err.message); } }
});

if (lockBtn) lockBtn.addEventListener("click", async () => {
  try { await fetch("/api/system/auth/logout", { method: "POST", credentials: "same-origin", headers: authHeaders() }); } catch (err) { /* noop */ }
  setToken("");
  showLocked();
});

// CROSS-SCRIPT HOOKS for dashboard.js.
//
// The merged index.html loads both scripts as plain (non-module) scripts: they
// share one global scope but there is no import boundary between them. Exposing
// these two transitions lets the Control Center's Lock and Setup buttons move
// between containers in place, instead of each navigating away and re-running the
// whole boot probe from scratch.
//
// Both are optional and guarded on the dashboard side: the standalone
// /dashboard page has no lock screen or setup form, so there is nothing to show.
window.RippaShowLocked = showLocked;

// "Back to Command Center" — the inverse of RippaShowSetup. Clears the settings
// pin so the trap escape hatch is armed again, then reveals the dashboard.
const backToDash = $("backToDash");
if (backToDash) {
  backToDash.addEventListener("click", () => {
    userPinnedToSetup = false;
    showScreen("dashboard");
    try { if (typeof window.RippaControlCenterStart === "function") window.RippaControlCenterStart(); } catch (err) { /* noop */ }
    try { void refreshRole(); } catch (err) { /* noop */ }
  });
}
window.RippaShowSetup = async () => {
  // Pin to setup so load()'s trap escape hatch does not immediately bounce the
  // operator back to the dashboard they deliberately navigated away from.
  userPinnedToSetup = true;
  showScreen("setup");
  // Re-read the saved config so the form shows current values, not stale ones.
  // showScreen("setup") is re-asserted afterwards so a slow read cannot leave
  // the operator looking at a half-rendered form.
  try { await load(); } catch (err) { /* the screen is already correct */ }
  showScreen("setup");
};

/**
 * BOOT SEQUENCER — the only place a screen is chosen from server state.
 *
 * Every container is `hidden` in index.html, so nothing is on screen until this
 * fetch resolves. Exactly one screen is then revealed, in one synchronous step:
 *
 *   !configured                     -> Setup Screen
 *   configured && !authenticated    -> Lock Screen
 *   configured &&  authenticated   -> Dashboard
 *
 * A malformed/failed response is treated as "cannot verify" and falls back to
 * the Lock Screen, which is the safe default: it never claims the node is
 * configured, so it can never expose the dashboard to an unauthenticated LAN
 * visitor.
 *
 * @returns {Promise<boolean>} true when a config payload can be loaded.
 */
async function checkAuth() {
  try {
    const res = await fetch("/api/system/auth/status", { credentials: "same-origin", headers: authHeaders() });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data || typeof data.configured !== "boolean") {
      throw new Error("status " + res.status);
    }
    masterBridgeUrl = (data.master_node_url || "").trim();
    // Point the native <a> straight at the API's master_node_url so the link is
    // live before the config fetch (and while the Lock/Setup screens are up).
    applyBridgeHref(masterBridgeUrl);

    if (!data.configured) {
      // No usable config.json yet -> first-run Setup Screen.
      showScreen("setup");
      showUnlocked();
      return true;
    }
    if (!data.authenticated) {
      // Configured, but this browser has no live session -> Lock Screen.
      showLocked();
      return false;
    }
    // Configured + authenticated -> Dashboard.
    // Clear the settings pin here: reaching the dashboard through the normal
    // boot path means any deliberate "view settings" visit is over, so the trap
    // escape hatch must be armed again for the next config read.
    userPinnedToSetup = false;
    showScreen("dashboard");
    showUnlocked();
    try { if (typeof window.RippaControlCenterStart === "function") window.RippaControlCenterStart(); } catch (err) { /* noop */ }
    return true;
  } catch (e) {
    showLocked("Could not verify node status — is it online?");
    return false;
  }
}

/**
 * Renders the server's `missing` list into the setup banner.
 *
 * Without this the setup screen said only "setup required" with nothing to act
 * on. The server now names the specific fields still blocking a complete
 * config, so an operator can see exactly what to fill in.
 */
function renderSetupGaps(missing) {
  if (!setupGaps) return;
  const list = Array.isArray(missing) ? missing.filter(Boolean) : [];
  setupGaps.innerHTML = "";
  if (list.length === 0) {
    // Configured: leave the list empty so a stale list can never linger.
    if (setupBanner) {
      setupBanner.innerHTML =
        "<strong>Setup incomplete.</strong> This node has no usable <code>config.json</code> yet &mdash; fill in your details below and save to start the node services.";
    }
    return;
  }
  for (const item of list) {
    const li = document.createElement("li");
    li.textContent = item;
    setupGaps.appendChild(li);
  }
  if (setupBanner) {
    setupBanner.insertAdjacentHTML(
      "beforeend",
      ` <span class="hint">Still required: ${list.join(", ")}.</span>`,
    );
  }
}

async function load() {
  try {
    // GET /api/config - the canonical "what is saved right now" read. The server
    // recomputes `configured` from config.json on every call, so this can never
    // return a stale cached copy after a save.
    const res = await fetch("/api/config", { credentials: "same-origin", headers: authHeaders() });
    if (res.status === 401) {
      // The session expired between the boot probe and this fetch. Only drop to
      // the Lock Screen if we were showing the authenticated dashboard — during
      // first-run setup a 401 is surfaced in place, so the Setup Screen is not
      // replaced by the Lock Screen mid-boot (a second flicker source).
      if (currentScreen === "dashboard") showLocked();
      else showAlert("Dashboard is locked — enter the passkey to continue.", "err");
      return;
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.success) throw new Error("config fetch failed");
    const c = (data && data.config) || {};
    configState = c; // cached for bridge actions (see resolveMasterUrl)
    if (role) role.value = c.node_role || c.NODE_ROLE || "master";
    if (mothership) mothership.value = c.mothership_url || c.MOTHERSHIP_URL || "https://rippaadventures.com";
    if (masterUrl) { masterUrl.value = c.master_node_url || c.MASTER_LOCAL_URL || ""; masterBridgeUrl = masterUrl.value; }
    // The authoritative master_node_url from the config payload becomes the
    // bridge anchor's href. The browser opens it natively — no click handler.
    applyBridgeHref(c.master_node_url || c.MASTER_LOCAL_URL || "");
    if (cloudLink) cloudLink.value = c.cloud_link_code || c.CLOUD_LINK_CODE || "";
    if (nodeName) nodeName.value = c.node_name || c.NODE_NAME || "";
    if (port) port.value = c.port || c.PORT || 4000;
    if (ollama) ollama.value = c.ollama_url || c.OLLAMA_URL || "http://127.0.0.1:11434";
    if (apiKey) apiKey.value = "";
    if (dashPin) dashPin.value = "";
    if (apiKey) apiKey.placeholder = c.apiKeyConfigured ? "Key saved (enter a new one to replace)" : "Paste key from Admin Fleet Command";
    if (keyState) keyState.textContent = c.apiKeyConfigured ? "✓ API key is configured." : "⚠ No API key saved yet.";
    if (pinState) pinState.textContent = c.pinConfigured ? "✓ Passkey is set. Leave blank to keep it." : "⚠ No passkey set — set one now.";
    if (statusPill) { statusPill.textContent = data.configured ? "● configured" : "● setup required"; statusPill.className = "pill " + (data.configured ? "ok" : "warn"); }
    renderSetupGaps(data.missing);

    // The return path only exists on a CONFIGURED node — on an unconfigured one
    // there is no dashboard to return to, so the button stays hidden rather than
    // offering a dead end.
    const backBtn = $("backToDash");
    if (backBtn) backBtn.hidden = !data.configured;

    /*
      THE ESCAPE HATCH FROM THE SETUP TRAP.

      Re-evaluated on EVERY config read, not just at boot. If the saved config is
      now complete but the operator is sitting on the setup screen (because the
      save landed after the last screen decision, or because they were sent here
      by a stale tab), this hides #setupContainer and shows #dashboardContainer
      immediately.

      `userPinnedToSetup` suppresses this ONLY while the operator has explicitly
      asked to view the settings (the Control Center's "Setup" button). Without
      that guard, deliberately opening the settings of a configured node would
      bounce straight back to the dashboard on the very next read — the mirror
      image of the original trap, and just as confusing.
    */
    if (data.configured && currentScreen === "setup" && !userPinnedToSetup) {
      if (data.authenticated) {
        showScreen("dashboard");
        try { if (typeof window.RippaControlCenterStart === "function") window.RippaControlCenterStart(); } catch (err) { /* noop */ }
      }
    }
    const lan = $("lanHint");
    if (lan) lan.textContent = location.host + " (bound 0.0.0.0)";
  } catch (e) {
    try { showAlert("Could not load current config: " + (e && e.message ? e.message : e), "err"); } catch (err2) { /* noop */ }
    // The screen was already chosen by checkAuth(); a failed config fetch must
    // NOT swap it for another screen (that was a Setup -> Lock flicker).
    // Only fall back to the Lock Screen if we never reached a verified state.
    if (currentScreen === "boot") showLocked("Could not load configuration from the node.");
  }
  try { refreshRole(); } catch (err) { /* noop */ }
}

/*
 * MASTER NODE FIELD: A NODE CODE IS A VALID VALUE, NOT A MALFORMED URL.
 *
 * The field accepts `RIPPA-D2N6-6VZV` as readily as `http://192.168.1.50:4000`,
 * and this is where a code is turned into a URL the node can dial. The old code
 * path assumed every value was an address, so a pasted node code was rejected
 * server-side as "must be a valid http(s) URL" and the documented
 * "paste your Master's code" flow simply did not work.
 *
 * Resolving a code needs a LAN scan (the Master advertises itself with a beacon),
 * so it happens on demand rather than on every keystroke. A code that matches no
 * beacon is left in the field untouched and explained, never silently rewritten —
 * a satellite on an isolated network can still be pointed at a URL by hand.
 */

/** True when `value` looks like a `RIPPA-XXXX-XXXX` node code. */
function looksLikeNodeCode(value) {
  return /^RIPPA-[0-9A-HJ-NP-Z]{4}-[0-9A-HJ-NP-Z]{4}$/i.test(String(value || "").trim());
}

/**
 * Resolves a node code to the Master's LAN URL via a discovery scan.
 * Returns "" when nothing matches.
 */
async function resolveNodeCodeToUrl(code) {
  try {
    const res = await fetch("/api/system/network/scan", {
      credentials: "same-origin",
      headers: authHeaders(),
    });
    if (res.status === 401) {
      showLocked();
      return "";
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.success) return "";
    const wanted = String(code).trim().toUpperCase();
    const match = (data.masters || []).find(
      (master) => String(master.nodeCode || "").trim().toUpperCase() === wanted,
    );
    return match ? match.url : "";
  } catch (err) {
    return ""; // a failed scan is not a setup error; the URL path still works
  }
}

/**
 * Prepares the Master Node field for saving: returns the URL to persist.
 *
 * A code is scanned for and swapped for the Master's real address. Anything else
 * is passed through untouched, so manual entry keeps working exactly as before.
 */
async function resolveMasterFieldForSave() {
  const raw = (masterUrl && masterUrl.value ? masterUrl.value : "").trim();
  if (!raw || !looksLikeNodeCode(raw)) return raw;

  setScanState("Looking up Master node code " + raw + " on this network…");
  const url = await resolveNodeCodeToUrl(raw);
  if (url) {
    if (masterUrl) masterUrl.value = url;
    masterBridgeUrl = url;
    masterUrlEdited = false;
    if (masterPicker && [...masterPicker.options].some((o) => o.value === url)) {
      masterPicker.value = url;
    }
    refreshBridge();
    setScanState("Master node code " + raw + " resolved to " + url + ".");
  } else {
    // Left as typed on purpose: see the docblock. An unreachable Master now looks
    // like "not a valid URL", so the message names the code explicitly.
    setScanState(
      "No Master answering to " + raw + " on this network. Start the Master, scan again, " +
        "or type its address (http://…:4000) by hand.",
    );
  }
  return url;
}

if (saveBtn) saveBtn.addEventListener("click", async () => {
  hideAlert();
  saveBtn.disabled = true;
  saveBtn.textContent = "Saving…";
  const body = {
    node_role: role ? role.value : "master",
    mothership_url: mothership ? mothership.value.trim() : "",
    // Resolved through resolveMasterFieldForSave() so a pasted NODE CODE becomes
    // the Master's real URL before validation sees it. See that function.
    master_node_url: await resolveMasterFieldForSave(),
    cloud_link_code: cloudLink ? cloudLink.value.trim() : "",
    node_name: nodeName ? nodeName.value.trim() : "",
    node_api_key: apiKey ? apiKey.value : "",
    port: port ? (Number(port.value) || 4000) : 4000,
    ollama_url: ollama ? ollama.value.trim() : "",
  };
  // Keep the existing key when the field is left blank.
  if (!body.node_api_key) delete body.node_api_key;
  if (dashPin && dashPin.value.trim()) body.dashboard_pin = dashPin.value.trim();
  /*
    CAPTURED BEFORE THE FIELD IS CLEARED.

    First-run setup runs with no dashboard session (the auth gate stays open
    only while the config is incomplete). The moment this save completes the
    config, that gate closes and every subsequent request 401s - which bounced
    the operator straight to the Lock Screen, demanding the passkey they had
    just typed one moment earlier. Holding the value lets us establish the
    session with it instead.
  */
  const submittedPin = (dashPin && dashPin.value.trim()) || "";
  try {
    const res = await fetch("/api/system/config", {
      method: "POST",
      credentials: "same-origin",
      headers: Object.assign({ "Content-Type": "application/json" }, authHeaders()),
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) { showLocked(); return; }
    if (!res.ok || !data.success) {
      const msgs = (data.errors || []).map((e) => e.path + ": " + e.message).join("\n") || data.message || "Save failed";
      showAlert(msgs, "err");
    } else {
      /*
        LEAVE THE SETUP SCREEN.

        The POST response now carries the freshly-read config payload, so
        `configured` here reflects what is ACTUALLY on disk. If the save produced
        a complete config we transition immediately; if it did not, we stay put
        and show exactly which fields are still missing.

        This is the direct fix for the reported trap: previously the save
        succeeded, the alert said so, and the screen never changed - the
        operator was left on the form with a valid config.json beside it.
      */
      if (apiKey) apiKey.value = "";
      if (dashPin) dashPin.value = "";
      if (data.configured) {
        showAlert("✓ " + data.message, "ok");
        userPinnedToSetup = false;
        /*
          ESTABLISH THE SESSION BEFORE SHOWING THE DASHBOARD.

          Completing the config CLOSES the auth gate that first-run setup was
          relying on, and this browser never had a session (there was no passkey
          to unlock with until now). Showing the dashboard anyway meant every
          poll immediately 401'd and bounced the operator to the Lock Screen,
          asking for the passkey they had just typed - a second, subtler version
          of the very trap this screen was rebuilt to escape.

          So: log in with the passkey just submitted, and only fall back to the
          Lock Screen if that genuinely fails. A node saved WITHOUT a passkey
          falls back too, which is correct - there is nothing to log in with, and
          the default passkey is a server-side secret we must not assume.
        */
        /*
          WHY THE LOGIN IS UNCONDITIONAL (when a passkey is in hand).

          The save response reports `authenticated:true`, but that means "this
          request was permitted" — the config gate is open while the node is
          unconfigured — NOT "this browser holds a session". No cookie was
          issued, so the very next request 401s. Gating the login on that flag
          therefore skipped the one call that actually creates the session.

          POSTing /api/system/auth is idempotent and harmless when a session
          already exists, so it is simply always attempted; the explicit
          verification below decides what the operator actually sees.
        */
        if (submittedPin) {
          try {
            const authRes = await fetch("/api/system/auth", {
              method: "POST",
              credentials: "same-origin",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ pin: submittedPin }),
            });
            const authData = await authRes.json().catch(() => ({}));
            if (authRes.ok && authData && authData.success) {
              try { if (authData.token) setToken(authData.token); } catch (err) { /* noop */ }
            }
          } catch (err) { /* handled by the check below */ }
        }
        // Re-read now that we hold a session (or know we do not).
        await load();
        // Verify rather than assume: showing a dashboard we cannot authenticate
        // would 401 on its first poll and bounce back to Lock anyway, which reads
        // as a glitch. Saying why here is clearer.
        try {
          const res2 = await fetch("/api/config", { credentials: "same-origin", headers: authHeaders() });
          const d2 = await res2.json().catch(() => ({}));
          if (!d2.authenticated) {
            showLocked(
              submittedPin
                ? "Setup saved. Enter the passkey you just set to open the Command Center."
                : "Setup saved. No passkey was set, so the default passkey is required.",
            );
            return;
          }
        } catch (err) { /* if we cannot even ask, let load()'s handling stand */ }
        showScreen("dashboard");
        try { if (typeof window.RippaControlCenterStart === "function") window.RippaControlCenterStart(); } catch (err) { /* noop */ }
      } else {
        // Still incomplete. Say why, and name the fields.
        const gaps = Array.isArray(data.missing) ? data.missing : [];
        renderSetupGaps(gaps);
        showAlert(
          "Saved, but setup is not complete yet." +
            (gaps.length ? " Still required: " + gaps.join(", ") + "." : ""),
          "err",
        );
        showScreen("setup");
      }
    }
  } catch (e) {
    try { showAlert("Save failed: " + (e && e.message ? e.message : e), "err"); } catch (err2) { /* noop */ }
  } finally {
    try { saveBtn.disabled = false; saveBtn.textContent = "💾 Save & Restart Node"; } catch (err) { /* noop */ }
  }
});

(async () => {
  // Screens are `hidden` in the markup; the boot splash is the only thing
  // painted. checkAuth() reveals exactly one screen once the status probe
  // resolves, so this is the single, flicker-free transition.
  try {
    showScreen("boot");
    const ok = await checkAuth();
    if (ok) { try { await load(); } catch (err) { /* screen already chosen */ } }
    else { try { refreshRole(); } catch (err) { /* noop */ } }
  } catch (err) {
    try { showLocked("Could not reach the node — is it online?"); } catch (err2) { /* noop */ }
  }
})();
