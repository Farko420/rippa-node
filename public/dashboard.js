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

  let parsed;
  try {
    // A bundle can be tens of megabytes, so this parse is the slow part of the
    // whole interaction and the UI says so rather than appearing to hang.
    parsed = JSON.parse(await file.text());
  } catch (err) {
    drop.classList.remove("busy");
    title.textContent = "Drop the brain bundle here";
    setBrainMessage("That file is not valid JSON — it may be truncated.", "error");
    return;
  }

  title.textContent = "Loading…";
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
    title.textContent = "Drop the brain bundle here";
    const input = $("brainFile");
    // Cleared so re-picking the SAME file fires `change` again — otherwise a
    // second attempt after a fix appears to do nothing at all.
    if (input) input.value = "";
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

    card.innerHTML =
      '<div class="node-accent"' + (accent ? ' style="background:' + accent + '"' : "") + "></div>" +
      '<div class="node-top">' +
        '<span class="node-dot' + (satellite.online ? " on" : "") + '"></span>' +
        '<span class="node-name">' + esc(satellite.nodeName) + "</span>" +
      "</div>" +
      '<div class="node-code">' + esc(satellite.nodeCode) + "</div>" +
      '<div class="node-task">' + (task ? esc(task.label) : "Idle") + "</div>" +
      '<div class="node-badges">' +
        '<span class="badge ' + (task ? "busy" : "") + '">' + (task ? esc(task.load) : "idle") + "</span>" +
        '<span class="badge ' + (satellite.p2pRevoked ? "relay" : "p2p") + '">' +
          (satellite.p2pRevoked ? "master-relay" : "P2P") + "</span>" +
        '<span class="badge">' + (satellite.efficiency ?? 0) + "% eff</span>" +
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

/** Assigns a shared task; the Master auto-provisions the sibling payloads. */
async function assignTask() {
  const button = $("taskRun");
  const label = $("taskLabel");
  const load = $("taskLoad");
  if (!button) return;
  button.disabled = true;
  button.textContent = "Assigning…";
  try {
    const { response, data } = await api("/api/mesh/task", {
      method: "POST",
      body: JSON.stringify({
        label: (label && label.value.trim()) || "Shared swarm task",
        load: (load && load.value) || "normal",
      }),
    });
    if (!response.ok || !data.success) {
      showAlert(data.message || "Could not assign the task.", "err");
    } else {
      const task = data.task || {};
      showAlert(
        "Task assigned to " + ((task.assignees || []).length) + " node(s) — sibling endpoints auto-provisioned.",
        "ok",
      );
      if (label) label.value = "";
      await refresh();
    }
  } catch (err) {
    showAlert("Assignment failed: " + err.message, "err");
  } finally {
    button.disabled = false;
    button.textContent = "▶ Assign to Swarm";
  }
}

/** Clears an adaptive P2P revocation for the node shown in the modal. */
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

// --- WIRING -----------------------------------------------------------------

const runBtn = $("taskRun");
if (runBtn) runBtn.addEventListener("click", () => void assignTask());

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

const lockBtn = $("ccLock");
if (lockBtn) {
  lockBtn.addEventListener("click", async () => {
    try {
      await api("/api/system/auth/logout", { method: "POST", body: "{}" });
    } catch (err) {
      /* navigate anyway — the lock screen enforces access server-side */
    }
    window.location.href = "/";
  });
}

// Enter submits the task from the label field.
const labelInput = $("taskLabel");
if (labelInput) {
  labelInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") void assignTask();
  });
}

void refresh();
// OTA status is slower-moving than the topology, so it polls on its own slower
// cadence rather than piggy-backing on every 5s snapshot refresh.
void refreshUpdater();
setInterval(() => void refreshUpdater(), 60_000);

// The brain panel is wired once, not on every 5s refresh: the drop zone holds DOM
// listeners and a hidden file input, and re-binding them every five seconds would
// be both wasteful and a way to end up with two drop handlers firing per drop.
wireBrainPanel();

// Polls for the life of the page; no teardown hook is needed because the
// document is discarded wholesale when the operator navigates away.
setInterval(() => void refresh(), REFRESH_MS);
