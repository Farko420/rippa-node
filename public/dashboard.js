/**
 * MASTER CONTROL CENTER — dashboard.js
 *
 * Renders the live swarm from GET /api/mesh/snapshot:
 *   - Swarm Topology: a grid of every paired satellite, by Node Name.
 *   - Active Processes: shared tasks, with collaborating nodes grouped and
 *     colour-linked so the collaboration is visible at a glance.
 *   - Satellite Detail Modal: per-node task progress, efficiency score, load
 *     handling (heavy/normal/lite) and problem-solving rate.
 *
 * The snapshot is polled rather than pushed, so a node that goes offline simply
 * stops updating and is rendered greyed out by the server's staleness check.
 */
/*
 * RIPPA_CONTROL_CENTER_MODULE
 *
 * WHY THIS FILE IS WRAPPED IN AN IIFE.
 *
 * index.html loads app.js AND this file as two plain classic scripts. They share
 * one global scope, so a top-level "const $" in BOTH files makes the second one
 * fail to PARSE with "SyntaxError: Identifier '$' has already been declared".
 *
 * That failure is silent and severe: the browser drops the entire script, so the
 * swarm grid, the brain drop zone and the OTA strip are present in the DOM but
 * have no event handlers and no poll loop. The page looks built and is dead —
 * the Master Brain Parity zone appeared in the markup and did nothing at all.
 *
 * Wrapping the body scopes every declaration ($, esc, api, refresh, ...) to this
 * file, which is what "a module" should have meant. Nothing inside needs to be
 * global: the only cross-script value is the explicit
 * window.RippaControlCenterStart assigned at the bottom, and app.js already
 * feature-detects it.
 */
(function () {
"use strict";

const $ = (id) => document.getElementById(id);

/** How often the Control Center refreshes from the Master. */
const REFRESH_MS = 5000;

/** Stable colour per shared task, so collaborating nodes always match. */
const TASK_COLORS = ["#2f81f7", "#3fb950", "#d29922", "#8957e5", "#f85149", "#39c5cf"];

/** Last snapshot, kept so the modal can render detail without another fetch. */
let snapshot = null;
/** Node code currently shown in the modal (null when closed). */
let openNodeCode = null;

// --- HTTP -------------------------------------------------------------------

function authHeaders() {
  try {
    const token = localStorage.getItem("rippa_dashboard_auth") || "";
    return token ? { Authorization: "Bearer " + token } : {};
  } catch (err) {
    return {}; // private mode — the cookie session still authenticates
  }
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: "same-origin",
    headers: Object.assign({ "Content-Type": "application/json" }, authHeaders()),
    ...options,
  });
  // A 401 means the dashboard session lapsed — bounce to the lock screen
  // rather than rendering an empty swarm that looks like a real outage.
  if (response.status === 401) {
    window.location.href = "/";
    throw new Error("Dashboard session expired.");
  }
  return { response, data: await response.json().catch(() => ({})) };
}

function showAlert(message, kind) {
  const box = $("ccAlert");
  if (!box) return;
  box.textContent = message;
  box.className = "alert " + (kind || "ok");
  box.classList.remove("hidden");
}

function hideAlert() {
  const box = $("ccAlert");
  if (box) box.classList.add("hidden");
}

// --- MASTER BRAIN PARITY ----------------------------------------------------
//
// THE FILE IS READ HERE AND SENT AS JSON, NOT AS A MULTIPART UPLOAD. The endpoint
// takes a parsed bundle, so parsing it in the browser means the operator sees a
// clear "that file is not JSON" before anything is sent, and the server receives
// the same bytes either way. A multipart FormData path would add a second parse
// site for no benefit.

/** Refuses a file that is obviously not a bundle, before it is read. */
function looksLikeBundle(name) {
  return /\.json$/i.test(name || "");
}

function setBrainBadge(text, kind) {
  const badge = $("brainBadge");
  if (!badge) return;
  badge.textContent = text;
  badge.className = "brain-badge" + (kind ? " brain-badge-" + kind : "");
}

function setBrainMessage(text, kind) {
  const box = $("brainMessage");
  if (!box) return;
  if (!text) {
    box.hidden = true;
    return;
  }
  box.textContent = text;
  box.className = "hint" + (kind ? " brain-" + kind : "");
  box.hidden = false;
}

/** Renders the "1:1 Brain Parity Locked" badge from a load or a status read. */
function renderBrainState(payload) {
  const status = $("brainStatus");
  if (!status) return;
  const counts = (payload && payload.counts) || {};
  const places = counts.places || 0;
  if (places > 0) {
    setBrainBadge("1:1 Brain Parity Locked", null);
  } else {
    setBrainBadge("No brain loaded", "empty");
  }
  $("brainCounts").textContent =
    places > 0
      ? places.toLocaleString() +
        " places · " +
        (counts.knowledge_chunks || 0).toLocaleString() +
        " knowledge chunks" +
        (payload && payload.lastSync ? " · synced " + payload.lastSync.slice(0, 19).replace("T", " ") + "Z" : "")
      : "Drop a bundle from Admin → Rippa Labs to give this node the Mothership's knowledge.";
  status.hidden = false;
}

async function loadBrainStatus() {
  try {
    const { data } = await api("/api/brain/status");
    if (data && data.success) renderBrainState(data);
  } catch (err) {
    // A satellite has no Deep Brain at all, and that is not worth shouting about
    // on a Master Control Center — the panel simply stays empty.
  }
}

/**
 * Reads a File with a real progress bar.
 *
 * A master brain bundle can be tens of megabytes, and `file.text()` gives the
 * operator a frozen drop zone for the whole read with no explanation. This
 * reports genuine byte progress via FileReader's `progress` event, so the bar
 * moves because bytes were actually consumed rather than on a decorative timer.
 */
function readFileWithProgress(file, onProgress) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onprogress = (event) => {
      if (event.lengthComputable && typeof onProgress === "function") {
        onProgress(event.loaded / event.total);
      }
    };
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("The file could not be read."));
    reader.readAsText(file);
  });
}

/** Shows, moves and hides the drop zone's progress bar. */
function setBrainProgress(percent, text) {
  const wrap = $("brainProgress");
  const bar = $("brainProgressBar");
  const label = $("brainProgressText");
  if (percent === null) {
    if (wrap) wrap.hidden = true;
    return;
  }
  if (wrap) wrap.hidden = false;
  if (bar) bar.style.width = Math.max(0, Math.min(100, percent)) + "%";
  if (label && text) label.textContent = text;
}

async function uploadBrainFile(file) {
  const drop = $("brainDrop");
  const title = $("brainDropTitle");
  if (!drop || !title) return;
  if (!looksLikeBundle(file.name)) {
    setBrainMessage("That does not look like a brain bundle — expected a .json file.", "error");
    return;
  }

  drop.classList.add("busy");
  title.textContent = "Reading " + file.name + "…";
  setBrainMessage("");
  // Indeterminate until the first progress event arrives, so the bar is present
  // and visibly "working" even for a file small enough to read in one tick.
  setBrainProgress(4, "Reading " + file.name + "…");

  let parsed;
  try {
    // A bundle can be tens of megabytes, so this parse is the slow part of the
    // whole interaction and the UI reports it rather than appearing to hang.
    const text = await readFileWithProgress(file, (fraction) => {
      setBrainProgress(fraction * 100, "Reading " + (fraction * 100).toFixed(0) + "%…");
    });
    setBrainProgress(100, "Parsing bundle…");
    parsed = JSON.parse(text);
  } catch (err) {
    drop.classList.remove("busy");
    title.textContent = "Drop rippa-brain-master.json here";
    setBrainProgress(null);
    setBrainMessage(
      err instanceof SyntaxError
        ? "That file is not valid JSON — it may be truncated."
        : "The file could not be read: " + ((err && err.message) || String(err)),
      "error",
    );
    return;
  }

  title.textContent = "Loading…";
  setBrainProgress(100, "Uploading to the node…");
  try {
    const { response, data } = await api("/api/brain/upload-backup", {
      method: "POST",
      body: JSON.stringify(parsed),
    });
    if (response.ok && data && data.success) {
      renderBrainState(data);
      const warnings = (data.warnings || []).length;
      setBrainMessage(
        data.message + (warnings ? " " + warnings + " row(s) were skipped — see the server log." : ""),
        warnings ? "warn" : null,
      );
    } else {
      setBrainBadge("Load refused", "error");
      setBrainMessage((data && data.message) || "The node refused the bundle.", "error");
    }
  } catch (err) {
    setBrainBadge("Upload failed", "error");
    setBrainMessage(String((err && err.message) || err), "error");
  } finally {
    drop.classList.remove("busy");
    title.textContent = "Drop rippa-brain-master.json here";
    // Cleared so re-picking the SAME file fires `change` again — otherwise a
    // second attempt after a fix appears to do nothing at all.
    const input = $("brainFile");
    if (input) input.value = "";
    // Leave the completed bar up briefly so the success state is legible before
    // the zone returns to its idle appearance.
    setTimeout(() => setBrainProgress(null), 1200);
  }
}

function wireBrainPanel() {
  const drop = $("brainDrop");
  const input = $("brainFile");
  if (!drop || !input) return;

  drop.addEventListener("click", () => input.click());
  drop.addEventListener("keydown", (event) => {
    // The zone is a div with role="button", so it must answer the keyboard or it
    // is a control a keyboard user cannot reach.
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      input.click();
    }
  });
  input.addEventListener("change", () => {
    const file = input.files && input.files[0];
    if (file) void uploadBrainFile(file);
  });

  ["dragenter", "dragover"].forEach((name) =>
    drop.addEventListener(name, (event) => {
      event.preventDefault(); // without this the browser navigates to the file
      drop.classList.add("dragging");
    }),
  );
  ["dragleave", "drop"].forEach((name) =>
    drop.addEventListener(name, (event) => {
      event.preventDefault();
      drop.classList.remove("dragging");
    }),
  );
  drop.addEventListener("drop", (event) => {
    const files = event.dataTransfer && event.dataTransfer.files;
    const file = files && files[0];
    if (file) void uploadBrainFile(file);
  });

  void loadBrainStatus();
}

// --- HELPERS ----------------------------------------------------------------

/** Deterministic task colour so a task looks the same on every render. */
function taskColor(taskId) {
  let hash = 0;
  for (let i = 0; i < String(taskId).length; i++) {
    hash = (hash * 31 + String(taskId).charCodeAt(i)) >>> 0;
  }
  return TASK_COLORS[hash % TASK_COLORS.length];
}

/** Escapes text before it reaches innerHTML (node names come off the LAN). */
function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[ch]);
}

/** Task progress is derived from completed-vs-attempted counters. */
function progressOf(satellite) {
  const metrics = satellite.metrics || {};
  const total =
    (metrics.tasksSucceeded || 0) + (metrics.tasksFailed || 0) + (metrics.tasksTimedOut || 0);
  if (!total) return 0;
  return Math.round(((metrics.tasksSucceeded || 0) / total) * 100);
}

// --- RENDERING --------------------------------------------------------------

/** Draws the summary tiles from the snapshot's `summary` block. */
function renderSummary(summary) {
  const s = summary || {};
  const set = (id, value) => {
    const el = $(id);
    if (el) el.textContent = String(value ?? 0);
  };
  set("statTotal", s.total);
  set("statOnline", s.online);
  set("statBusy", s.busy);
  set("statRevoked", s.p2pRevoked);
  set("statEff", (s.avgEfficiency ?? 100) + "%");
}

/**
 * Draws the topology grid — one card per satellite, by Node Name.
 * Clicking a card opens the detail modal.
 */
/**
 * Formats a duration in seconds as a compact human string ("3d 4h", "12m 08s").
 *
 * Used for the uptime readouts. Hours are dropped when there are days, and
 * seconds are dropped when there are hours, because a card has room for roughly
 * eight characters and "4d 03:12:47" would not fit legibly.
 */
function formatUptime(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  if (total < 60) return total + "s";
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return minutes + "m " + String(total % 60).padStart(2, "0") + "s";
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours + "h " + String(minutes % 60).padStart(2, "0") + "m";
  const days = Math.floor(hours / 24);
  return days + "d " + String(hours % 24).padStart(2, "0") + "h";
}

/**
 * Maps host uptime onto a 0-100 scale for the bar.
 *
 * The bar is a *relative* health indicator, not a percentage of anything: 24h
 * of uptime is a good sign for a node that is meant to run continuously, and the
 * scale saturates there. Showing "42%" for 10 hours would imply a score the
 * number has no meaning for, so the raw duration in the readout carries the
 * actual figure and the bar only conveys "new vs. established".
 */
function uptimePercent(seconds) {
  const value = Number(seconds);
  if (!isFinite(value) || value <= 0) return null;
  return Math.min(100, (value / (24 * 3600)) * 100);
}

/**
 * One labelled vitals bar (CPU / RAM / uptime) for a node card.
 *
 * A node that has not reported a figure yet (an older build, or a satellite
 * still mid-handshake) renders an explicit "-" rather than a fake 0% bar —
 * a zero-width bar next to "0%" would read as "idle and healthy" when the truth
 * is "no data", which is the opposite of what a health readout should do.
 */
function vitalsRow(kind, label, percent, value) {
  const hasData = typeof percent === "number" && isFinite(percent);
  const width = hasData ? Math.max(0, Math.min(100, percent)) : 0;
  return (
    '<div class="nm-row ' + kind + '">' +
      '<span class="nm-label">' + label + "</span>" +
      '<div class="bar"><div class="bar-fill" style="width:' + width + '%"></div></div>' +
      '<span class="nm-val">' + (hasData ? value : "—") + "</span>" +
    "</div>"
  );
}

function renderTopology(satellites) {
  const grid = $("topology");
  const empty = $("topologyEmpty");
  if (!grid) return;
  grid.innerHTML = "";
  const list = satellites || [];
  if (empty) empty.hidden = list.length > 0;

  list.forEach((satellite) => {
    const task = satellite.currentTask;
    const card = document.createElement("button");
    card.type = "button";
    card.className =
      "node-card" + (task ? " busy" : "") + (satellite.p2pRevoked ? " revoked" : "") +
      (satellite.online ? "" : " offline");

    const accent = task ? taskColor(task.id) : "";
    if (accent) card.style.setProperty("--accent", accent);

    // Node IP, so a moved or re-addressed machine is obvious at a glance.
    const endpoint = satellite.endpoint || {};
    const ip = endpoint.ipAddress || "";

    card.innerHTML =
      '<div class="node-accent"' + (accent ? ' style="background:' + accent + '"' : "") + "></div>" +
      '<div class="node-top">' +
        '<span class="node-dot' + (satellite.online ? " on" : "") + '"></span>' +
        '<span class="node-name">' + esc(satellite.nodeName) + "</span>" +
      "</div>" +
      '<div class="node-code">' + esc(satellite.nodeCode) + "</div>" +
      (ip ? '<div class="node-ip">' + esc(ip) + "</div>" : "") +
      '<div class="node-task">' + (task ? esc(task.label) : "Idle") + "</div>" +
      '<div class="node-badges">' +
        '<span class="badge ' + (task ? "busy" : "") + '">' + (task ? esc(task.load) : "idle") + "</span>" +
        '<span class="badge ' + (satellite.p2pRevoked ? "relay" : "p2p") + '">' +
          (satellite.p2pRevoked ? "master-relay" : "P2P") + "</span>" +
        '<span class="badge">' + (satellite.efficiency ?? 0) + "% eff</span>" +
      "</div>" +
      // LIVE NODE METRICS — CPU, RAM and uptime, straight from the satellite's
      // own telemetry. These answer "is this machine healthy", which the swarm
      // counters above cannot.
      '<div class="node-metrics">' +
        vitalsRow("cpu", "CPU", satellite.cpuUsage, Math.round(satellite.cpuUsage ?? 0) + "%") +
        vitalsRow("ram", "RAM", satellite.ramUsage, Math.round(satellite.ramUsage ?? 0) + "%") +
        vitalsRow("uptime", "UP", uptimePercent(satellite.uptimeSeconds),
          formatUptime(satellite.uptimeSeconds)) +
      "</div>";

    card.addEventListener("click", () => openSatellite(satellite.nodeCode));
    grid.appendChild(card);
  });
}

/**
 * Draws active processes, grouping nodes that share a task and linking them
 * with a coloured rail so collaboration is visible without reading labels.
 *
 * Only RUNNING tasks are listed. A task whose assignees have all finished is
 * history, not an active process — showing it would make the panel grow without
 * bound and would misrepresent idle nodes as busy.
 */
function renderProcesses(tasks, satellites) {
  const list = $("processes");
  const empty = $("processesEmpty");
  if (!list) return;
  list.innerHTML = "";

  // A task is active while at least one assignee is still executing it.
  const running = new Set(
    (satellites || []).filter((s) => s.currentTask && s.currentTask.id).map((s) => s.currentTask.id),
  );
  const entries = (tasks || []).filter(
    (task) => running.has(task.id) && (task.assignees || []).length > 0,
  );
  if (empty) empty.hidden = entries.length > 0;

  entries.forEach((task) => {
    const color = taskColor(task.id);
    const wrapper = document.createElement("div");
    wrapper.className = "proc";

    const chain = (task.assignees || [])
      .map((member) => esc(member.nodeName))
      .join('<span class="proc-link">──</span>');

    wrapper.innerHTML =
      '<div class="proc-head">' +
        '<span class="proc-swatch" style="background:' + color + '"></span>' +
        '<span class="proc-label">' + esc(task.label) + "</span>" +
        '<span class="proc-meta">' + esc(task.load) + " · " +
          (task.assignees || []).length + " node(s)" + "</span>" +
      "</div>" +
      '<div class="proc-chain">' + chain + "</div>" +
      (task.p2p
        ? ""
        : '<p class="proc-revoke">⚠ P2P revoked — reporting to Master only. ' +
          esc(task.p2pRevokeReason || "") + "</p>");

    list.appendChild(wrapper);
  });
}
// --- SATELLITE DETAIL MODAL -------------------------------------------------

/**
 * Opens the performance modal for one satellite.
 *
 * Prefers the dedicated detail endpoint (always current) and falls back to the
 * matching entry in the cached snapshot so the modal still opens if that single
 * request fails — the grid data is the same shape.
 */
async function openSatellite(nodeCode) {
  const modal = $("ccModal");
  if (!modal) return;
  openNodeCode = nodeCode;
  modal.hidden = false;

  let detail = null;
  try {
    const { response, data } = await api("/api/mesh/satellite/" + encodeURIComponent(nodeCode));
    if (response.ok && data.success) detail = data.satellite;
  } catch (err) {
    /* fall through to the cached copy below */
  }
  if (!detail && snapshot) {
    detail = (snapshot.satellites || []).find((s) => s.nodeCode === nodeCode) || null;
  }
  if (detail) renderSatelliteDetail(detail);
}

function closeSatellite() {
  const modal = $("ccModal");
  if (modal) modal.hidden = true;
  openNodeCode = null;
}

/** Fills every block of the modal from one satellite's detail record. */
function renderSatelliteDetail(satellite) {
  const setText = (id, value) => {
    const el = $(id);
    if (el) el.textContent = String(value ?? "");
  };
  const setBar = (id, percent) => {
    const el = $(id);
    if (el) el.style.width = Math.max(0, Math.min(100, percent || 0)) + "%";
  };

  setText("ccModalName", satellite.nodeName);
  setText("ccModalCode", satellite.nodeCode + (satellite.online ? " · online" : " · offline"));

  // --- Current task & progress ---
  const task = satellite.currentTask;
  const metrics = satellite.metrics || {};
  if (task) {
    setText("mTask", task.label + " (" + task.load + ")");
    setBar("mBar", progressOf(satellite));
    setText(
      "mTaskMeta",
      (satellite.p2pRevoked ? "Reporting to Master only" : "Collaborating peer-to-peer") +
        " · " + (satellite.completedTasks || 0) + " task(s) completed",
    );
  } else {
    setText("mTask", "Idle — waiting for the Master to assign work");
    setBar("mBar", 0);
    setText("mTaskMeta", (satellite.completedTasks || 0) + " task(s) completed since pairing");
  }

  // --- Efficiency score ---
  const efficiency = satellite.efficiency ?? 0;
  setText("mScore", efficiency);
  const ring = $("mScoreRing");
  if (ring) ring.style.borderColor = efficiency >= 75 ? "var(--ok)" : efficiency >= 45 ? "var(--warn)" : "var(--acc)";
  setText(
    "mScoreNote",
    "Uptime " + Math.round(metrics.uptimeSeconds || 0) + "s · " +
      (metrics.tasksSucceeded || 0) + " succeeded / " +
      ((metrics.tasksFailed || 0) + (metrics.tasksTimedOut || 0)) + " not completed",
  );

  // --- System vitals (the same figures shown on the swarm grid card) ---
  const hasCpu = typeof satellite.cpuUsage === "number" && isFinite(satellite.cpuUsage);
  const hasRam = typeof satellite.ramUsage === "number" && isFinite(satellite.ramUsage);
  setBar("mCpu", hasCpu ? satellite.cpuUsage : 0);
  setText("mCpuVal", hasCpu ? Math.round(satellite.cpuUsage) + "%" : "—");
  setBar("mRam", hasRam ? satellite.ramUsage : 0);
  setText("mRamVal", hasRam ? Math.round(satellite.ramUsage) + "%" : "—");
  setBar("mUptime", uptimePercent(satellite.uptimeSeconds) || 0);
  setText("mUptimeVal", formatUptime(satellite.uptimeSeconds));
  setText(
    "mCores",
    satellite.cpuCores
      ? satellite.cpuCores + " logical cores · host uptime " + formatUptime(satellite.uptimeSeconds)
      : "Host uptime " + formatUptime(satellite.uptimeSeconds),
  );

  // --- Load handling metrics ---
  const rates = satellite.loadRates || {};
  ["heavy", "normal", "lite"].forEach((bucket) => {
    const value = rates[bucket];
    const label = value === undefined ? "—" : value + "%";
    setBar("m" + bucket.charAt(0).toUpperCase() + bucket.slice(1), value === undefined ? 0 : value);
    setText("m" + bucket.charAt(0).toUpperCase() + bucket.slice(1) + "Val", label);
  });

  // --- Problem solving rate ---
  setText("mPsa", (satellite.problemSolvingRate ?? 100) + "%");
  setText(
    "mPsaNote",
    (metrics.challengesResolved || 0) + " of " + (metrics.challenges || 0) +
      " captcha / retry loops resolved without failing the task.",
  );

  // --- Networking ---
  const endpoint = satellite.endpoint || {};
  setText(
    "mNet",
    "LAN " + (endpoint.lanUrl || "unknown") +
      " · Cloud Link " + (endpoint.cloudLinkUrl || "not configured") +
      " · P2P failure rate " + (satellite.p2pFailureRate ?? 0) + "%",
  );
  const restore = $("mRestoreP2p");
  if (restore) restore.hidden = !satellite.p2pRevoked;
}
// --- POLLING + ACTIONS ------------------------------------------------------

/**
 * Regenerates this node's code from the Control Center header.
 *
 * Deliberately no confirm dialog — see the identical reasoning on the Setup
 * button in app.js. The action is reversible (press it again), it leaves every
 * setting untouched, and the one thing it does change (pairing / satellite
 * list) is called out in the tooltip and in Setup's own hint text.
 *
 * The endpoint response carries the new code, but the header is repainted by the
 * normal snapshot poll a moment later anyway; writing it directly just means the
 * change is visible immediately rather than up to five seconds later.
 */
async function regenerateNodeCode() {
  const btn = $("ccRegenCode");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "…";
  }
  try {
    const { response, data } = await api("/api/config/regenerate-code", {
      method: "POST",
      body: "{}",
    });
    if (!response.ok || !data.success) {
      showAlert(data.message || "Could not change the node code.", "err");
      return;
    }
    const code = $("ccNodeCode");
    if (code) code.textContent = data.nodeCode || "—";
    showAlert(
      "New node code: " + (data.nodeCode || "—") + ". Satellites must pair with the new code.",
      "ok",
    );
    // Repaint the grid immediately: the registry was cleared server-side, so
    // waiting for the next tick would show a stale fleet for several seconds.
    void refresh();
  } catch (err) {
    showAlert("Could not change the node code: " + (err && err.message ? err.message : err), "err");
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "🎲";
    }
  }
}

const regenBtn = $("ccRegenCode");
if (regenBtn) regenBtn.addEventListener("click", () => { void regenerateNodeCode(); });

/** Fetches the snapshot and repaints every panel. */
async function refresh() {
  try {
    const { response, data } = await api("/api/mesh/snapshot");
    if (!response.ok || !data.success) return;
    snapshot = data;

    const boot = $("ccBoot");
    const app = $("ccApp");
    if (boot) boot.hidden = true;
    if (app) app.hidden = false;

    const code = $("ccNodeCode");
    if (code) code.textContent = data.nodeCode || "—";
    const sub = $("ccSub");
    if (sub) sub.textContent = (data.nodeName || "Master") + " · " + (data.satellites || []).length + " node(s)";

    renderSummary(data.summary);
    renderTopology(data.satellites);
    renderProcesses(data.tasks, data.satellites);

    // Keep an open modal live while the fleet updates underneath it.
    if (openNodeCode) {
      const current = (data.satellites || []).find((s) => s.nodeCode === openNodeCode);
      if (current) renderSatelliteDetail(current);
    }
  } catch (err) {
    const sub = $("ccBootSub");
    if (sub && $("ccApp") && $("ccApp").hidden) {
      sub.textContent = "Could not reach the Master — is this node online?";
    }
  }
}

/**
 * Renders the OTA strip from /api/mesh/updater.
 *
 * Deliberately non-blocking: a failed or absent updater response only hides the
 * strip — the live topology and process views must never be held up by it.
 */
async function refreshUpdater() {
  const strip = $("ccOta");
  const tile = $("statOta");
  try {
    const { response, data } = await api("/api/mesh/updater");
    if (!response.ok || !data.success) return;

    const current = data.currentVersion || "—";
    if (tile) tile.textContent = "v" + current;

    if (!strip) return;
    strip.hidden = false;
    strip.classList.remove("up-to-date", "available");

    if (data.updateAvailable && data.latest) {
      strip.classList.add("available");
      $("otaText").textContent =
        "Update available: v" + current + " → v" + data.latest.version +
        " — the Master rolls the fleet forward automatically within the hour.";
      // Only the Master can push; satellites have nothing to broadcast to.
      const push = $("otaPush");
      if (push) push.hidden = !(data.onlineSatellites > 0);
    } else {
      strip.classList.add("up-to-date");
      $("otaText").textContent =
        data.latest
          ? "Fleet is up to date on v" + current + " (latest published: v" + data.latest.version + ")."
          : "Running v" + current + " — no published release detected yet.";
    }
  } catch (err) {
    /* updater unavailable — leave the topology panels untouched */
  }
}

/** Asks the Master to broadcast the known release immediately. */
async function pushUpdate() {
  const button = $("otaPush");
  if (button) {
    button.disabled = true;
    button.textContent = "Pushing…";
  }
  try {
    const { response, data } = await api("/api/mesh/broadcast-update", {
      method: "POST",
      body: "{}",
    });
    if (!response.ok || !data.success) {
      showAlert(data.message || "Update push failed.", "err");
    } else {
      showAlert(
        "Broadcast " + data.version + " to " + data.delivered + " online satellite(s).",
        "ok",
      );
    }
  } catch (err) {
    showAlert("Update push failed: " + err.message, "err");
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = "Push to Swarm Now";
    }
  }
}

// --- POLLING + ACTIONS ------------------------------------------------------

/**
 * Clears an adaptive P2P revocation for the node shown in the modal.
 */
async function restoreP2p() {
  if (!openNodeCode) return;
  try {
    await api("/api/mesh/satellite/" + encodeURIComponent(openNodeCode) + "/restore-p2p", {
      method: "POST",
      body: "{}",
    });
    showAlert("P2P restored — the node will be re-provisioned with its siblings.", "ok");
    await refresh();
  } catch (err) {
    showAlert("Restore failed: " + err.message, "err");
  }
}

// --- NODE EVENT STREAM (SSE) -------------------------------------------------
//
// ONE connection carries both live features this dashboard needs:
//
//   brain_sync    progress through a bundle load -> the Sync Status bar.
//   admin_command a Force OTA Update / Restart -> the full-screen overlay.
//
// Both are things the NODE decides on a timer, not things the browser asks for,
// so a request/response cycle cannot express either. EventSource is used rather
// than WebSocket because the traffic is one-directional and SSE reconnects on its
// own — which matters for the brain-sync case, where the stream has to survive a
// 30-second silent ingest.

/** The live EventSource, or null before start / after an auth failure. */
let eventSource = null;
/** Highest event id seen, so a reconnect replays nothing twice. */
let lastEventId = 0;

/**
 * Opens the node event stream. Idempotent.
 *
 * A 401 means the dashboard session lapsed mid-life. EventSource cannot read a
 * response status, so the failure is detected from the error event instead, and
 * the page is sent back to the lock screen exactly as the snapshot poll does.
 */
function startEventStream() {
  if (eventSource) return;
  if (typeof EventSource === "undefined") return; // ancient browser: skip quietly

  try {
    eventSource = new EventSource("/api/system/events", { withCredentials: true });
  } catch (err) {
    return; // stream unsupported — the rest of the dashboard still works
  }

  eventSource.onmessage = (message) => {
    let event;
    try {
      event = JSON.parse(message.data);
    } catch (err) {
      return; // a malformed frame must not kill the stream
    }
    if (typeof event.id === "number" && event.id <= lastEventId) return;
    lastEventId = typeof event.id === "number" ? event.id : lastEventId;

    if (event.kind === "brain_sync") {
      renderBrainSync(event);
    } else if (event.kind === "admin_command" && event.blocking) {
      showAdminOverlay(event);
    }
  };

  eventSource.onerror = () => {
    // EventSource retries on its own for transient drops. The one case worth
    // handling is an expired session, where it would otherwise retry forever
    // against a 401 and never recover.
    if (eventSource && eventSource.readyState === 2 /* CLOSED */) {
      eventSource.close();
      eventSource = null;
    }
  };
}

/**
 * Paints one backend progress tick into the Sync Status panel.
 *
 * The percentage comes from the ingestion engine's own row counter, not from the
 * browser's upload progress, so it tracks rows actually committed rather than
 * bytes handed to the server. The class carries the state so the colour changes
 * too: blue while working, green on "Parity Achieved", red on failure.
 */
function renderBrainSync(event) {
  const panel = $("brainSync");
  const bar = $("brainSyncBar");
  const label = $("brainSyncLabel");
  const detail = $("brainSyncDetail");
  if (!panel || !bar) return;

  const percent = Math.max(0, Math.min(100, Number(event.percent) || 0));
  bar.style.width = percent + "%";

  panel.classList.remove("done", "failed");
  if (event.phase === "done") panel.classList.add("done");
  else if (event.phase === "failed") panel.classList.add("failed");

  if (label) {
    label.textContent =
      event.phase === "done"
        ? "Parity Achieved"
        : event.phase === "failed"
          ? "Load Failed"
          : event.title || "Syncing…";
  }
  if (detail) detail.textContent = event.detail || "";
}

/**
 * Shows the full-screen, unclosable admin overlay.
 *
 * There is intentionally no dismiss path here. By the time this event is
 * published the node has already committed: the OTA batch script is spawned (or
 * the shutdown has begun), so a "Cancel" button would offer a control that does
 * not exist. The overlay lifts only when the page does, which coincides with the
 * restart it is announcing.
 */
function showAdminOverlay(event) {
  const overlay = $("adminOverlay");
  if (!overlay) return;
  const title = $("adminOverlayTitle");
  const detail = $("adminOverlayDetail");
  // Prefer the node's own wording; the fallbacks exist so a command with no
  // title still produces a specific screen rather than a blank "Working…".
  const fallbackTitle =
    event.command === "RESTART_NODE" ? "Restarting Node…" : "Applying OTA Update…";
  if (title) title.textContent = event.title || fallbackTitle;
  if (detail) {
    detail.textContent =
      event.detail ||
      (event.command === "RESTART_NODE"
        ? "The Mothership asked this node to restart."
        : "The Mothership asked this node to update to the latest build.");
  }
  overlay.hidden = false;
}

/** Wires the brain panel and opens the node event stream. */
function startNodeEvents() {
  startEventStream();
  // The engine stream carries the terminal, the crawl stream and the viewport, and
  // opening it is ALSO what tells the node a dashboard is watching — which is the
  // signal that permits it to spend the cost of capturing a Chromium screenshot.
  startEngineStream();
}

// --- WIRING -----------------------------------------------------------------

/*
  NO MANUAL TASK-ASSIGNMENT WIRING.

  The "Assign to Swarm" button and its #taskLabel / #taskLoad fields have been
  removed from both HTML pages, so this file no longer has a way — or a reason —
  to POST /api/mesh/task. That endpoint only marks satellites busy in this node's
  local registry; it cannot pull work off the Mothership queue. Real work arrives
  through the priority tier of the TaskEngine, which claims and runs it with no
  operator input. Leaving the handler wired would only be dead code pointing at
  elements that no longer exist.
*/

const closeBtn = $("ccModalClose");
if (closeBtn) closeBtn.addEventListener("click", closeSatellite);

const restoreBtn = $("mRestoreP2p");
if (restoreBtn) restoreBtn.addEventListener("click", () => void restoreP2p());

const otaBtn = $("otaPush");
if (otaBtn) otaBtn.addEventListener("click", () => void pushUpdate());

// Clicking the modal backdrop closes it; clicking the card does not.
const modal = $("ccModal");
if (modal) {
  modal.addEventListener("click", (event) => {
    if (event.target === modal) closeSatellite();
  });
}

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeSatellite();
});

// --- RESPONSIVE NAV + VIEW SWITCHING -----------------------------------------

function setText(id, value) {
  const el = $(id);
  if (el) el.textContent = value;
}

function showView(viewId) {
  ["viewFleet", "viewOllama", "viewScraper", "viewMesh"].forEach((id) => {
    const el = $(id);
    if (el) el.hidden = id !== viewId;
  });
  document.querySelectorAll(".cc-nav-item").forEach((btn) => {
    btn.classList.toggle("active", btn.getAttribute("data-view") === viewId);
  });
  if (viewId === "viewOllama") void refreshOllama();
  if (viewId === "viewScraper") void refreshScraper();
  if (viewId === "viewMesh") void refreshMesh();
  // Starts the 5s readiness ping when the Embedded AI tab is opened, and stops it
  // when the operator navigates away. See syncHealthPolling for why it is scoped.
  syncHealthPolling();
}

document.querySelectorAll(".cc-nav-item").forEach((btn) => {
  btn.addEventListener("click", () => {
    showView(btn.getAttribute("data-view"));
    const nav = $("ccNav");
    if (nav) nav.classList.remove("open");
  });
});

const navToggle = $("ccNavToggle");
if (navToggle) {
  navToggle.addEventListener("click", () => {
    const nav = $("ccNav");
    if (!nav) return;
    const open = nav.classList.toggle("open");
    navToggle.setAttribute("aria-expanded", open ? "true" : "false");
  });
}

// --- OLLAMA CONTROL PANEL -----------------------------------------------------
//
// Padlock defaults LOCKED: the node and Rippa AI keep full autonomic control
// over the server and model selection. Unlocking is a local, dashboard-PIN
// gated toggle (same auth as every other mutating route here) that reveals
// manual overrides — it does not itself change anything on the server.

let ollamaUnlocked = false;
let ollamaManagedState = false;
/** True only while the Embedding Model tile last reported a FAILED pull — arms the retry click. */
let ollamaEmbedFailed = false;

/** Paints a shared status badge (Active / Error / Downloading / Idle). */
function setStatusBadge(id, state) {
  const badge = $(id);
  if (!badge) return;
  const labels = { active: "Active", error: "Error", downloading: "Downloading", idle: "Idle" };
  badge.textContent = labels[state] || "Idle";
  badge.className = "status-badge status-" + (labels[state] ? state : "idle");
}

/**
 * EMBEDDING MODEL TILE — three visible states, because "pulling…" forever is a lie.
 *
 * The server owns the state machine (`embeddingModelStatus` on
 * /api/ollama/status, backed by a 10-minute AbortController and periodic
 * reconciliation against GET /api/tags):
 *   ready   -> the model name; confirmed against the tag list, not hoped for
 *   pulling -> the NDJSON pull stream is open; progress hits the terminal
 *   failed  -> the pull timed out or errored — clicking the tile retries it
 *   idle    -> before the first attempt; shown as pulling (it is about to run)
 */
function renderEmbeddingTile(status) {
  const tile = $("ollamaEmbed");
  const state = status.embeddingModelStatus || (status.embeddingModelReady ? "ready" : "pulling");
  ollamaEmbedFailed = state === "failed";
  if (!tile) return;
  if (state === "ready") {
    setText("ollamaEmbed", status.embeddingModel || "ready");
    tile.style.cursor = "";
    tile.title = "Local embedding model installed.";
  } else if (state === "failed") {
    setText("ollamaEmbed", "failed (click to retry)");
    tile.style.cursor = "pointer";
    tile.title =
      "The embedding model pull failed" +
      (status.embeddingModelError ? " — " + status.embeddingModelError : "") +
      ". Click to retry.";
  } else {
    setText("ollamaEmbed", "pulling…");
    tile.style.cursor = "";
    tile.title = "Downloading the embedding model — progress streams into the Live Engine Terminal.";
  }
}

function renderOllamaStatus(status) {
  if (!status) return;
  ollamaManagedState = Boolean(status.managed);
  setText("ollamaRunning", status.running ? "Active" : status.managed ? "Starting..." : "Unmanaged");
  setText("ollamaManaged", status.managed ? "Self-managed" : "External / manual");
  setText("ollamaModel", status.model || "-");
  setText("ollamaPort", String(status.port || "-"));
  setText("ollamaTask", status.task || "Idle");
  setText("ollamaRestarts", String(status.restartCount || 0));
  setText("ollamaRam", status.ramGb ? status.ramGb + " GB" : "—");
  renderEmbeddingTile(status);
  setStatusBadge(
    "ollamaStatusBadge",
    status.lastError ? "error" : status.running ? "active" : status.managed ? "downloading" : "idle",
  );

  const errBox = $("ollamaError");
  if (errBox) {
    if (status.lastError) {
      errBox.textContent = "Last error: " + status.lastError;
      errBox.hidden = false;
    } else {
      errBox.hidden = true;
    }
  }

  ollamaUnlocked = Boolean(status.unlocked);
  const padlock = $("ollamaPadlock");
  const icon = $("ollamaPadlockIcon");
  const label = $("ollamaPadlockLabel");
  const override = $("ollamaOverride");
  if (padlock) padlock.classList.toggle("unlocked", ollamaUnlocked);
  if (icon) icon.textContent = ollamaUnlocked ? "🔓" : "🔒";
  if (label) {
    label.textContent = ollamaUnlocked
      ? "Unlocked — Manual Override"
      : "Locked — Autonomic Control";
  }
  if (override) override.hidden = !ollamaUnlocked;
}

async function refreshOllama() {
  try {
    const { response, data } = await api("/api/ollama/status");
    if (!response.ok || !data.success) return;
    renderOllamaStatus(data);
  } catch (err) {
    /* panel simply stays on its last known state */
  }
}

const ollamaPadlockBtn = $("ollamaPadlock");
if (ollamaPadlockBtn) {
  ollamaPadlockBtn.addEventListener("click", async () => {
    try {
      const { response, data } = await api("/api/ollama/unlock", {
        method: "POST",
        body: JSON.stringify({ unlocked: !ollamaUnlocked }),
      });
      if (response.ok && data.success) {
        void refreshOllama();
      }
    } catch (err) {
      showAlert("Could not toggle the padlock.", "err");
    }
  });
}

const ollamaApplyBtn = $("ollamaApply");
if (ollamaApplyBtn) {
  ollamaApplyBtn.addEventListener("click", async () => {
    const model = ($("ollamaModelInput") || {}).value || "";
    const port = Number(($("ollamaPortInput") || {}).value || 0);
    try {
      const { response, data } = await api("/api/ollama/override", {
        method: "POST",
        body: JSON.stringify({ model, port: port || undefined }),
      });
      if (response.ok && data.success) {
        showAlert(data.message || "Override applied.", "ok");
        void refreshOllama();
      } else {
        showAlert(data.message || "Could not apply override.", "err");
      }
    } catch (err) {
      showAlert("Could not apply override.", "err");
    }
  });
}

const ollamaManagedBtn = $("ollamaManagedToggle");
if (ollamaManagedBtn) {
  ollamaManagedBtn.addEventListener("click", async () => {
    try {
      const { response, data } = await api("/api/ollama/managed", {
        method: "POST",
        body: JSON.stringify({ managed: !ollamaManagedState }),
      });
      if (response.ok && data.success) void refreshOllama();
    } catch (err) {
      showAlert("Could not toggle self-managed mode.", "err");
    }
  });
}

const ollamaRestartBtn = $("ollamaRestartBtn");
if (ollamaRestartBtn) {
  ollamaRestartBtn.addEventListener("click", async () => {
    ollamaRestartBtn.disabled = true;
    try {
      const { response, data } = await api("/api/ollama/restart", { method: "POST", body: "{}" });
      showAlert(
        data.message || (response.ok ? "Restart requested." : "Restart failed."),
        response.ok ? "ok" : "err",
      );
      setTimeout(() => void refreshOllama(), 2000);
    } finally {
      ollamaRestartBtn.disabled = false;
    }
  });
}

/** Wires a generic Self-Heal button: POSTs to `path`, shows the result, refreshes `after`. */
function wireSelfHeal(btnId, path, after) {
  const btn = $(btnId);
  if (!btn) return;
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    const original = btn.textContent;
    btn.textContent = "🩹 Healing…";
    try {
      const { response, data } = await api(path, { method: "POST", body: "{}" });
      showAlert(data.message || (response.ok ? "Self-heal complete." : "Self-heal failed."), response.ok ? "ok" : "err");
    } catch (err) {
      showAlert("Self-heal request failed.", "err");
    } finally {
      btn.disabled = false;
      btn.textContent = original;
      if (after) void after();
    }
  });
}

// CLICK-TO-RETRY for the Embedding Model tile. Armed ONLY while the last poll
// reported a failed pull, so a stray click on a healthy or in-progress tile
// does nothing. The route returns immediately; the 5s poll picks up the
// pulling -> ready/failed transition, and progress lands in the terminal.
const ollamaEmbedTile = $("ollamaEmbed");
if (ollamaEmbedTile) {
  ollamaEmbedTile.addEventListener("click", async () => {
    if (!ollamaEmbedFailed) return;
    ollamaEmbedFailed = false;
    try {
      const { data } = await api("/api/ollama/embedding-pull", { method: "POST", body: "{}" });
      showAlert(data.message || "Retrying the embedding model pull…", "ok");
    } catch (err) {
      showAlert("Could not retry the embedding model pull.", "err");
    }
    void refreshOllama();
  });
}

wireSelfHeal("ollamaSelfHeal", "/api/ollama/self-heal", refreshOllama);
wireSelfHeal("scraperSelfHeal", "/api/scraper/self-heal", () => refreshScraper());
wireSelfHeal("meshSelfHeal", "/api/mesh/self-heal", () => refreshMesh());

// --- LIVE ENGINE TERMINAL + SCRAPER VISUALISER -------------------------------
//
// ONE SSE CONNECTION CARRIES ALL FOUR LIVE SURFACES:
//
//   line     engine stdout/stderr, command echo, command output -> the terminal
//   health   the readiness probe result                          -> the status dot
//   scrape   navigate / status / extract                         -> the crawl stream
//   viewport a JPEG of the page Chromium is reading              -> the thumbnail
//
// A SECOND stream from /api/system/events rather than more kinds on that one,
// because that endpoint retains the latest event per KIND — correct for an overlay
// you may have missed, wrong for scrollback where only the last line would survive.
// See /api/engine/stream in src/server.ts.
//
// RECONNECTION IS THE BROWSER'S JOB. EventSource re-establishes itself on a drop
// with no code here, and the server replays a backlog frame on every connect, so a
// reconnect restores the terminal, the crawl stream and the current screenshot
// without a single extra request.

let engineSource = null;

/** Lines already painted, so a reconnect cannot duplicate the backlog. */
let termCount = 0;
let scrapeCount = 0;

/** Caps the DOM as well as the server's ring buffer. */
const TERM_DOM_LIMIT = 400;
const SCRAPE_DOM_LIMIT = 80;

/**
 * Auto-scroll, but ONLY when the operator is already at the bottom.
 *
 * Without the check, a terminal that scrolls itself down is unusable: you cannot
 * scroll up to read a stack trace, because the next log line yanks you back. This is
 * the difference between a log viewer and a log spammer.
 */
function stickToBottom(el) {
  if (!el) return;
  const near = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  if (near) el.scrollTop = el.scrollHeight;
}

/** Appends one terminal line, colouring it by stream. */
function appendTermLine(line) {
  const out = $("termOut");
  if (!out) return;
  if (termCount === 0) {
    const empty = out.querySelector(".term-empty");
    if (empty) empty.remove();
  }
  const row = document.createElement("span");
  row.className = "term-line is-" + (line.stream || "out");
  row.textContent = line.text;
  out.appendChild(row);
  termCount += 1;
  while (termCount > TERM_DOM_LIMIT && out.firstChild) {
    out.removeChild(out.firstChild);
    termCount -= 1;
  }
  stickToBottom(out);
}

/** Appends one crawl-stream event. */
function appendScrapeLine(event) {
  const out = $("scrapeStream");
  if (!out) return;
  const row = document.createElement("span");
  row.className = "scrape-line is-" + (event.kind || "status");
  row.textContent = event.message;
  out.appendChild(row);
  scrapeCount += 1;
  while (scrapeCount > SCRAPE_DOM_LIMIT && out.firstChild) {
    out.removeChild(out.firstChild);
    scrapeCount -= 1;
  }
  const counter = $("scrapeCount");
  if (counter) counter.textContent = scrapeCount + (scrapeCount === 1 ? " event" : " events");
  stickToBottom(out);
  if (event.url) eventUrl = event.url;
  trackViewportActivity(event.kind);
}

/*
  THE VIEWPORT'S IDLE CYCLE.

  A screenshot is only ever captured DURING a scrape, so between scrapes the panel
  holds a frozen thumbnail. Left alone that is actively misleading — a still of a
  campsite page from 40 minutes ago reads exactly like "this is what the scraper is
  looking at now". So the crawl stream drives the state: a NAVIGATE cancels the
  idle countdown and says Chromium is working; an EXTRACT, ERROR or CLOSE schedules
  the return to the radar a few seconds later.

  The delay exists so the final frame of a finished scrape stays on screen long
  enough to be read, instead of vanishing the instant the job ends.
*/
let viewportIdleTimer = null;
function trackViewportActivity(kind) {
  if (viewportIdleTimer) {
    clearTimeout(viewportIdleTimer);
    viewportIdleTimer = null;
  }
  if (kind === "navigate") {
    setText("viewportTitle", "Chromium is navigating…");
    setText("viewportUrl", eventUrl || "");
    return;
  }
  if (kind === "extract" || kind === "error" || kind === "close") {
    viewportIdleTimer = setTimeout(markViewportIdle, 8_000);
  }
}

/** The URL of the most recent crawl event, used to label the viewport mid-scrape. */
let eventUrl = "";

/** Paints a readiness reading into the health dot. */
function renderHealth(reading) {
  const badge = $("ollamaHealthBadge");
  const label = $("ollamaHealthLabel");
  if (!badge || !reading) return;
  const text = { ready: "Ready", busy: "Busy", pulling: "Pulling", offline: "Offline" };
  badge.className = "health-badge is-" + (reading.state || "offline");
  if (label) label.textContent = text[reading.state] || "Offline";
  // The tooltip says WHY the dot is the colour it is, including the honest
  // "no model resident" case that is entirely normal between jobs.
  badge.title = reading.detail || "";
}

/** Shows a captured Chromium frame, or falls back to the idle radar. */
function renderViewport(frame) {
  const img = $("viewportImg");
  const radar = $("viewportRadar");
  const led = $("viewportLed");
  if (!img) return;
  if (!frame || !frame.dataUrl) {
    markViewportIdle();
    return;
  }
  if (radar) radar.hidden = true;
  img.hidden = false;
  if (led) led.classList.add("on");
  if (img.getAttribute("src") !== frame.dataUrl) img.setAttribute("src", frame.dataUrl);
  setText("viewportTitle", frame.title || "No page loaded");
  setText("viewportUrl", frame.url || "");
}

/** Returns the viewport to the idle radar. */
function markViewportIdle() {
  const img = $("viewportImg");
  const radar = $("viewportRadar");
  const led = $("viewportLed");
  if (img) img.hidden = true;
  if (radar) radar.hidden = false;
  if (led) led.classList.remove("on");
  setText("viewportTitle", "No page loaded");
  setText("viewportUrl", "Waiting for dispatch from Mothership…");
}
function handleEngineFrame(frame) {
  if (!frame || !frame.type) return;
  if (frame.type === "line") appendTermLine(frame);
  else if (frame.type === "scrape") appendScrapeLine(frame);
  else if (frame.type === "health") renderHealth(frame);
  else if (frame.type === "viewport") renderViewport(frame);
  else if (frame.type === "hello") renderBacklog(frame);
}

/**
 * Paints the backlog frame the server sends on every connect.
 *
 * `replaceChildren` rather than appending: a reconnect replays the same lines, and
 * appending them would double every entry in the scrollback. The DOM is rebuilt from
 * the server's capped ring buffer, which is also why the server's cap (300) and this
 * one's (400) are allowed to differ — the DOM may hold a little more than the server
 * remembers, never less.
 */
function renderBacklog(frame) {
  const out = $("termOut");
  const stream = $("scrapeStream");
  if (out) {
    out.replaceChildren();
    termCount = 0;
    if (!frame.lines || frame.lines.length === 0) {
      const empty = document.createElement("span");
      empty.className = "term-empty";
      empty.textContent = "No engine output yet. Type `help` for commands.";
      out.appendChild(empty);
    }
    (frame.lines || []).forEach(appendTermLine);
  }
  if (stream) {
    stream.replaceChildren();
    scrapeCount = 0;
    (frame.scrapes || []).forEach(appendScrapeLine);
  }
  if (frame.health) renderHealth(frame.health);
  if (frame.viewport) renderViewport(frame.viewport);
  else markViewportIdle();
}

/** Opens the engine stream. Idempotent. */
function startEngineStream() {
  if (engineSource) return;
  if (typeof EventSource === "undefined") return;
  try {
    engineSource = new EventSource("/api/engine/stream", { withCredentials: true });
  } catch (err) {
    return; // unsupported — the status tiles and self-heal still work
  }
  engineSource.onmessage = (message) => {
    try {
      handleEngineFrame(JSON.parse(message.data));
    } catch (err) {
      /* a malformed frame must not kill the stream */
    }
  };
  engineSource.onerror = () => {
    // EventSource retries on its own for transient drops. CLOSED (readyState 2) is
    // the one case needing help — an expired session, which would otherwise retry
    // against a 401 forever. The snapshot poll sends the page back to the lock screen.
    if (engineSource && engineSource.readyState === 2) {
      engineSource.close();
      engineSource = null;
    }
  };
}

// The $ prompt. Enter submits; the server streams the output back over the SSE
// connection, so this handler only reports a TRANSPORT failure — the command's own
// output already arrived over the stream by the time this response does.
const termForm = $("termForm");
if (termForm) {
  termForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const input = $("termInput");
    if (!input) return;
    const command = input.value.trim();
    if (!command) return;
    input.value = "";
    try {
      const { response, data } = await api("/api/engine/exec", {
        method: "POST",
        body: JSON.stringify({ command }),
      });
      if (!response.ok) showAlert(data.message || "The node could not run that command.", "err");
    } catch (err) {
      showAlert("Command could not be sent to the node.", "err");
    }
  });
}

/*
  THE 5-SECOND READINESS PING.

  Polled, not pushed: the badge's most important job is to be able to say OFFLINE,
  and a push stream cannot report the absence of its own events. Five seconds is the
  specified cadence and is cheap — a loopback GET against a server this node already
  talks to constantly.

  It runs only while the Embedded AI tab is visible. Pinging an Ollama nobody is
  looking at every five seconds, for as long as the tab sits open in a background
  window, is exactly the kind of cost this node should not carry overnight.
*/
let healthTimer = null;
function refreshEngineHealth() {
  return api("/api/engine/health")
    .then(({ response, data }) => {
      if (response.ok && data && data.state) renderHealth(data);
    })
    .catch(() => {
      /* the badge keeps its last reading; the next tick retries */
    });
}
function syncHealthPolling() {
  const view = $("viewOllama");
  const shouldRun = Boolean(view) && !view.hidden;
  if (shouldRun && !healthTimer) {
    void refreshEngineHealth();
    healthTimer = setInterval(refreshEngineHealth, 5000);
  } else if (!shouldRun && healthTimer) {
    clearInterval(healthTimer);
    healthTimer = null;
  }
}

// --- PLAYWRIGHT SCRAPER PANEL -------------------------------------------------

async function refreshScraper() {
  try {
    const { response, data } = await api("/api/scraper/status");
    if (!response.ok || !data.success) return;
    setText("scraperEngine", data.browserBacked ? "Headless Chromium" : "Lightweight fetch");
    setText("scraperRuntime", data.runtime || "—");
    setStatusBadge("scraperStatusBadge", data.state === "active" ? "active" : data.state === "stopped" ? "idle" : "idle");
  } catch (err) {
    /* panel stays on its last known state */
  }
}

// --- MESH NETWORK PANEL -------------------------------------------------------

async function refreshMesh() {
  try {
    const { response, data } = await api("/api/mesh/snapshot");
    if (!response.ok || !data.success) return;
    const satellites = Array.isArray(data.satellites) ? data.satellites : [];
    const online = satellites.filter((s) => s && s.online).length;
    setText("meshSatellites", String(satellites.length));
    setText("meshOnline", String(online));
    setStatusBadge("meshStatusBadge", satellites.length === 0 ? "idle" : online > 0 ? "active" : "error");
  } catch (err) {
    /* panel stays on its last known state */
  }
}

// Keep the panels live while they are the open view (independent, slower
// cadence — matches the OTA strip's own poll so this is not just
// piggy-backing on it).
setInterval(() => {
  if ($("viewOllama") && !$("viewOllama").hidden) void refreshOllama();
  if ($("viewScraper") && !$("viewScraper").hidden) void refreshScraper();
  if ($("viewMesh") && !$("viewMesh").hidden) void refreshMesh();
}, 5000);

const lockBtn = $("ccLock");
if (lockBtn) {
  lockBtn.addEventListener("click", async () => {
    try {
      await api("/api/system/auth/logout", { method: "POST", body: "{}" });
    } catch (err) {
      /* continue anyway — the lock screen enforces access server-side */
    }
    // On the merged index.html the Lock Screen is already in this document, so
    // app.js can reveal it directly. A full navigation would work too, but it
    // would throw away the page and re-run the whole boot probe for no reason.
    // The standalone /dashboard page has no lock screen, so it navigates home.
    if (window.RippaShowLocked) {
      window.RippaShowLocked();
    } else {
      window.location.href = "/";
    }
  });
}

// "Setup" returns to the config form without leaving the page (merged page only;
// the standalone dashboard uses an <a href="/">, which this button is not).
const setupBtn = $("ccSetupBtn");
if (setupBtn) {
  setupBtn.addEventListener("click", () => {
    if (window.RippaShowSetup) window.RippaShowSetup();
  });
}

/*
  THE "ENTER SUBMITS THE TASK" HANDLER IS GONE WITH THE FIELD IT BELONGS TO.

  It bound to #taskLabel and called assignTask(). With the manual assignment UI
  removed, #taskLabel no longer exists in either page, so `labelInput` was always
  null and the guard silently skipped it. It is removed rather than left in place
  because it is a live reference to a deleted function: had the element ever
  reappeared — a cached page, a stale bundle — pressing Enter would have thrown
  a ReferenceError inside the listener instead of assigning anything.
*/

/*
 * CONTROL CENTER STARTUP — idempotent, and called by app.js.

 * index.html now embeds the dashboard inside #dashboardContainer, so this file
 * loads on a page that may still be showing the Setup Screen. Auto-starting the
 * 5s poll immediately would fire authenticated requests from a screen the
 * operator never opened — and, worse, the first 401 would bounce them to "/",
 * reloading the page. So the poll only begins once app.js reveals the dashboard.
 *
 * On the standalone /dashboard page there is no #dashboardContainer, and the
 * page IS the dashboard, so it starts itself immediately (the original
 * behaviour, and the path that keeps that page working unchanged).
 *
 * Exposed on `window` because app.js is a separate classic script with no module
 * boundary to import across.
 */
let controlCenterStarted = false;
function startControlCenter() {
  // Guard against a second call: two poll loops would double every request and
  // render each snapshot twice.
  if (controlCenterStarted) return;
  controlCenterStarted = true;

  void refresh();
  // OTA status is slower-moving than the topology, so it polls on its own slower
  // cadence rather than piggy-backing on every 5s snapshot refresh.
  void refreshUpdater();
  setInterval(() => void refreshUpdater(), 60_000);

  // The brain panel is wired once, not on every 5s refresh: the drop zone holds
  // DOM listeners and a hidden file input, and re-binding them every five seconds
  // would be both wasteful and a way to end up with two drop handlers firing per
  // drop.
  wireBrainPanel();

  /*
    THE EVENT STREAM IS OPENED HERE, NOT AT SCRIPT LOAD.

    It sits behind `requireDashboardAuth`, so opening it before the dashboard
    exists would either 401 or — on a first-run node whose config is incomplete —
    hold a connection open that has no session to authenticate with. Starting it
    from the same place as the rest of the Control Center means it only ever runs
    on a page that is already authenticated, and `startEventStream` is idempotent
    so the repeated calls from app.js's screen transitions cannot open a second
    connection.
  */
  startNodeEvents();

  // Polls for the life of the page; no teardown hook is needed because the
  // document is discarded wholesale when the operator navigates away.
  setInterval(() => void refresh(), REFRESH_MS);
}
window.RippaControlCenterStart = startControlCenter;

// Standalone /dashboard: this document IS the Control Center, so start now.
if (!$("dashboardContainer")) startControlCenter();

// --- MODULE END ---------------------------------------------------------------
})();
