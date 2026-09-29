const $ = (id) => document.getElementById(id);
const role = $("role"), mothership = $("mothership"), masterUrl = $("masterUrl");
const nodeName = $("nodeName"), apiKey = $("apiKey"), port = $("port"), ollama = $("ollama");
const roleHint = $("roleHint"), mothershipWrap = $("mothershipWrap"), masterUrlWrap = $("masterUrlWrap");
const statusPill = $("statusPill"), keyState = $("keyState"), alertBox = $("alert"), saveBtn = $("save");
const dashPin = $("dashPin"), pinState = $("pinState");
const lockScreen = $("lockScreen"), dashCard = $("dashCard"), unlockPin = $("unlockPin");
const unlockBtn = $("unlockBtn"), lockAlert = $("lockAlert"), lockSub = $("lockSub");
const satBridge = $("satBridge"), satMasterLabel = $("satMasterLabel");
const openMasterBtn = $("openMaster"), copyMasterBtn = $("copyMaster"), lockBtn = $("lockBtn");

const TOKEN_KEY = "rippa_dashboard_auth";
let masterBridgeUrl = "";
let authChecked = false;

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
  if (dashCard) {
    dashCard.classList.add("hidden");
    dashCard.style.display = "none";
  }
  if (lockScreen) {
    lockScreen.classList.remove("hidden");
    lockScreen.style.display = "";
  }
  if (hint && lockSub) lockSub.textContent = hint;
  setTimeout(() => { try { if (unlockPin) unlockPin.focus(); } catch (err) { /* noop */ } }, 50);
}
function showUnlocked() {
  // CRITICAL: update the UI immediately on a successful auth — do not wait
  // for load()/refresh. Both class + inline style are toggled so a missing
  // or stale ".hidden" rule can never leave the lock screen visible.
  if (lockScreen) {
    lockScreen.classList.add("hidden");
    lockScreen.style.display = "none";
  }
  if (dashCard) {
    dashCard.classList.remove("hidden");
    dashCard.style.display = "";
  }
  try { authChecked = true; } catch (err) { /* noop */ }
  try { if (unlockPin) unlockPin.value = ""; } catch (err) { /* noop */ }
  try { hideLockAlert(); } catch (err) { /* noop */ }
  try { refreshRole(); } catch (err) { /* noop */ }
}

function refreshRole() {
  if (!role) return;
  const isSat = role.value === "satellite";
  if (mothershipWrap) mothershipWrap.classList.toggle("hidden", isSat);
  if (masterUrlWrap) masterUrlWrap.classList.toggle("hidden", !isSat);
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
  const url = (masterBridgeUrl || (masterUrl && masterUrl.value) || "").trim();
  satBridge.classList.toggle("hidden", !isSat);
  if (isSat && satMasterLabel) satMasterLabel.textContent = url ? ("Master: " + url) : "Set the Master Node URL below.";
}
if (role) role.addEventListener("change", refreshRole);
if (masterUrl) masterUrl.addEventListener("input", () => { masterBridgeUrl = masterUrl.value; refreshBridge(); });

if (openMasterBtn) openMasterBtn.addEventListener("click", () => {
  const url = (masterBridgeUrl || (masterUrl && masterUrl.value) || "").trim();
  if (!url) { showAlert("Set the Master Node URL first.", "err"); return; }
  window.location.href = url;
});
if (copyMasterBtn) copyMasterBtn.addEventListener("click", async () => {
  const url = (masterBridgeUrl || (masterUrl && masterUrl.value) || "").trim();
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
      try {
        if (lockScreen) { lockScreen.classList.add("hidden"); lockScreen.style.display = "none"; }
        if (dashCard) { dashCard.classList.remove("hidden"); dashCard.style.display = ""; }
      } catch (err2) { /* noop */ }
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

async function checkAuth() {
  try {
    const res = await fetch("/api/system/auth/status", { credentials: "same-origin", headers: authHeaders() });
    const data = await res.json().catch(() => ({}));
    masterBridgeUrl = (data && data.master_node_url) || "";
    if (data && data.authenticated) {
      showUnlocked();
      return true;
    }
    if (data && data.configured === false) {
      showUnlocked();
      return true;
    }
    showLocked();
    return false;
  } catch (e) {
    showLocked("Could not reach the node — is it online?");
    return false;
  }
}

async function load() {
  try {
    const res = await fetch("/api/system/config", { credentials: "same-origin", headers: authHeaders() });
    if (res.status === 401) { showLocked(); return; }
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.success) throw new Error("config fetch failed");
    const c = (data && data.config) || {};
    if (role) role.value = c.node_role || c.NODE_ROLE || "master";
    if (mothership) mothership.value = c.mothership_url || c.MOTHERSHIP_URL || "https://rippaadventures.com";
    if (masterUrl) { masterUrl.value = c.master_node_url || c.MASTER_LOCAL_URL || ""; masterBridgeUrl = masterUrl.value; }
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
    if (!authChecked) showLocked();
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
  try {
    const ok = await checkAuth();
    if (ok) { try { await load(); } catch (err) { /* unlocked UI already shown */ } }
    else { try { refreshRole(); } catch (err) { /* noop */ } }
  } catch (err) {
    try { showLocked(); } catch (err2) { /* noop */ }
  }
})();
