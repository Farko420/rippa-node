const $ = (id) => document.getElementById(id);
const role = $("role"), mothership = $("mothership"), masterUrl = $("masterUrl");
const nodeName = $("nodeName"), apiKey = $("apiKey"), port = $("port"), ollama = $("ollama");
const roleHint = $("roleHint"), mothershipWrap = $("mothershipWrap"), masterUrlWrap = $("masterUrlWrap");
const statusPill = $("statusPill"), keyState = $("keyState"), alertBox = $("alert"), saveBtn = $("save");
const dashPin = $("dashPin"), pinState = $("pinState");
const lockScreen = $("lockScreen"), dashCard = $("dashCard"), unlockPin = $("unlockPin");
const bootScreen = $("bootScreen"), setupBanner = $("setupBanner");
const unlockBtn = $("unlockBtn"), lockAlert = $("lockAlert"), lockSub = $("lockSub");
const satBridge = $("satBridge"), satMasterLabel = $("satMasterLabel");
const openMasterBtn = $("openMaster"), copyMasterBtn = $("copyMaster"), lockBtn = $("lockBtn");
// LAN auto-discovery + cloud link (satellite setup).
const scanBtn = $("scanBtn"), masterPicker = $("masterPicker"), scanState = $("scanState");
const cloudLinkWrap = $("cloudLinkWrap"), cloudLink = $("cloudLink");

const TOKEN_KEY = "rippa_dashboard_auth";
let masterBridgeUrl = "";

/**
 * Which screen is currently authoritative: "boot" | "setup" | "locked" | "dashboard".
 *
 * This is the single source of truth for screen visibility. Every container
 * (#bootScreen, #lockScreen, #dashCard) ships with the `hidden` attribute in
 * index.html, and `showScreen()` is the only function allowed to reveal one —
 * it always hides the others in the same synchronous step, so a screen can
 * never be painted over another (the Lock -> Setup flicker).
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
 * @param {"boot"|"setup"|"locked"|"dashboard"} screen
 */
function showScreen(screen) {
  currentScreen = screen;
  const setup = screen === "setup";
  const locked = screen === "locked";
  const dashboard = screen === "dashboard";
  const booting = screen === "boot";
  const set = (el, visible) => {
    if (!el) return;
    if (visible) {
      el.removeAttribute("hidden");
      el.classList.remove("hidden");
      el.style.removeProperty("display");
    } else {
      el.setAttribute("hidden", "");
      el.classList.add("hidden");
      el.style.display = "none";
    }
  };
  set(bootScreen, booting);
  set(lockScreen, locked);
  set(dashCard, setup || dashboard);
  if (setupBanner) set(setupBanner, setup);
  // Expose the mode for CSS/inspection; handy when diagnosing a flicker.
  try { if (document.body) document.body.setAttribute("data-screen", screen); } catch (err) { /* noop */ }
  if (locked) {
    setTimeout(() => { try { if (unlockPin) unlockPin.focus(); } catch (err) { /* noop */ } }, 50);
  }
}

let currentScreen = "boot";

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

function refreshBridge() {
  if (!role || !satBridge) return;
  const isSat = role.value === "satellite";
  const url = resolveMasterUrl();
  satBridge.classList.toggle("hidden", !isSat);
  if (isSat && satMasterLabel) satMasterLabel.textContent = url ? ("Master: " + url) : "Set the Master Node URL below.";
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
 * Opens the Master Command Center in a NEW TAB.
 *
 * `window.location.href` was used here previously, which navigated the current
 * tab to the Master and unloaded this Satellite dashboard — the user perceived
 * that as the button "flickering"/refreshing the page. Opening a new tab keeps
 * the Satellite dashboard live in the current tab.
 *
 * The URL is resolved from the last-loaded config state first (the authoritative
 * value from /api/system/config), then the live input, so it works even if the
 * field was never touched.
 */
if (openMasterBtn) openMasterBtn.addEventListener("click", (event) => {
  // Belt-and-braces: the button is outside any form, but never let a click
  // bubble into a submission or trigger the document's default action.
  event.preventDefault();

  const url = resolveMasterUrl();
  if (!url) {
    showAlert("Set the Master Node URL first.", "err");
    return;
  }

  // `noopener` prevents the Master page from reaching back through
  // window.opener to control this dashboard.
  const opened = window.open(url, "_blank", "noopener,noreferrer");
  if (!opened) {
    // Popup blocked: fall back to same-tab navigation rather than doing nothing.
    showAlert("New tab was blocked by the browser — opening in this tab instead.", "err");
    window.location.href = url;
  } else {
    // Some browsers honour noopener without honouring noreferrer.
    opened.opener = null;
  }
});
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
    showScreen("dashboard");
    showUnlocked();
    return true;
  } catch (e) {
    showLocked("Could not verify node status — is it online?");
    return false;
  }
}

async function load() {
  try {
    const res = await fetch("/api/system/config", { credentials: "same-origin", headers: authHeaders() });
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

if (saveBtn) saveBtn.addEventListener("click", async () => {
  hideAlert();
  saveBtn.disabled = true;
  saveBtn.textContent = "Saving…";
  const body = {
    node_role: role ? role.value : "master",
    mothership_url: mothership ? mothership.value.trim() : "",
    master_node_url: masterUrl ? masterUrl.value.trim() : "",
    cloud_link_code: cloudLink ? cloudLink.value.trim() : "",
    node_name: nodeName ? nodeName.value.trim() : "",
    node_api_key: apiKey ? apiKey.value : "",
    port: port ? (Number(port.value) || 4000) : 4000,
    ollama_url: ollama ? ollama.value.trim() : "",
  };
  // Keep the existing key when the field is left blank.
  if (!body.node_api_key) delete body.node_api_key;
  if (dashPin && dashPin.value.trim()) body.dashboard_pin = dashPin.value.trim();
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
      showAlert("✓ " + data.message, "ok");
      if (apiKey) apiKey.value = "";
      if (dashPin) dashPin.value = "";
      await load();
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
