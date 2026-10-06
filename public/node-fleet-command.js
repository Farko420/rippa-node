(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const REFRESH_MS = 10000;

  function authHeaders() {
    try {
      const token = localStorage.getItem("rippa_dashboard_auth") || "";
      return token ? { Authorization: "Bearer " + token } : {};
    } catch (err) {
      return {};
    }
  }

  async function api(path, options = {}) {
    const response = await fetch(path, {
      credentials: "same-origin",
      headers: Object.assign({ "Content-Type": "application/json" }, authHeaders()),
      ...options,
    });
    if (response.status === 401) {
      window.location.href = "/";
      throw new Error("Session expired");
    }
    return { response, data: await response.json().catch(() => ({})) };
  }

  async function fetchStats() {
    const { data } = await api("/api/admin/swarm-stats");
    return data.success ? data.data : null;
  }

  async function fetchAutoPublished() {
    const { data } = await api("/api/admin/auto-published?limit=5&offset=0");
    return data.success ? data.data?.places || [] : [];
  }

  async function fetchReviewQueue() {
    const { data } = await api("/api/admin/review-queue?limit=5&offset=0");
    return data.success ? data.data?.places || [] : [];
  }

  function formatPercent(n) {
    return typeof n === "number" ? n.toFixed(0) + "%" : "—";
  }

  async function render() {
    const content = $("content");
    const stats = await fetchStats();

    if (!stats) {
      content.innerHTML = `<div style="text-align: center; padding: 40px; color: var(--mut);">
        <p>Failed to load fleet stats.</p>
        <button style="background: none; border: none; color: var(--acc); cursor: pointer; text-decoration: underline; font-size: 13px;" onclick="location.reload()">Reload</button>
      </div>`;
      return;
    }

    const [autoPublished, reviewQueue] = await Promise.all([
      fetchAutoPublished(),
      fetchReviewQueue(),
    ]);

    const statsHtml = `
      <h2 style="margin: 0 0 20px; font-size: 20px;">Fleet Consensus & Telemetry</h2>
      <div class="stats-grid">
        <div class="stat-card"><span class="stat-label">Match Rate</span><span class="stat-value accent">${formatPercent(stats.consensus_match_rate)}</span></div>
        <div class="stat-card"><span class="stat-label">Verified</span><span class="stat-value ok">${stats.verified_count || 0}</span></div>
        <div class="stat-card"><span class="stat-label">Conflicts</span><span class="stat-value warn">${stats.conflict_count || 0}</span></div>
        <div class="stat-card"><span class="stat-label">Degraded</span><span class="stat-value danger">${stats.degraded_count || 0}</span></div>
        <div class="stat-card"><span class="stat-label">Pending</span><span class="stat-value">${stats.pending_count || 0}</span></div>
        <div class="stat-card"><span class="stat-label">Total</span><span class="stat-value">${stats.total_processed || 0}</span></div>
      </div>
    `;

    const actionsHtml = `
      <div style="margin: 20px 0; display: flex; gap: 12px; flex-wrap: wrap;">
        <a href="/admin/ai-auto-published" style="padding: 10px 16px; background: var(--acc); color: white; border-radius: 6px; text-decoration: none; font-size: 13px;">📋 Auto-Published</a>
        <a href="/admin/review-queue" style="padding: 10px 16px; background: #d29922; color: white; border-radius: 6px; text-decoration: none; font-size: 13px;">⚠️ Review Queue</a>
      </div>
    `;

    const autoHtml = `
      <h3 style="margin: 30px 0 16px; font-size: 16px; border-bottom: 1px solid var(--line); padding-bottom: 12px;">Auto-Published (Confidence ≥ 90)</h3>
      ${
        autoPublished.length > 0
          ? `<table><thead><tr><th>Name</th><th>Confidence</th></tr></thead><tbody>
        ${autoPublished.map((i) => `<tr><td>${i.name}</td><td style="text-align: right;"><span class="badge ok">${i.confidence_score.toFixed(0)}%</span></td></tr>`).join("")}
      </tbody></table><p style="font-size: 12px;"><a href="/admin/ai-auto-published" class="btn-link">View Full List →</a></p>`
          : `<p style="color: var(--mut); font-size: 13px;">No auto-published items.</p>`
      }
    `;

    const reviewHtml = `
      <h3 style="margin: 30px 0 16px; font-size: 16px; border-bottom: 1px solid var(--line); padding-bottom: 12px;">Pending Review (Confidence < 90)</h3>
      ${
        reviewQueue.length > 0
          ? `<table><thead><tr><th>Name</th><th>Confidence</th></tr></thead><tbody>
        ${reviewQueue.map((i) => `<tr><td>${i.name}</td><td style="text-align: right;"><span class="badge warn">${i.confidence_score.toFixed(0)}%</span></td></tr>`).join("")}
      </tbody></table><p style="font-size: 12px;"><a href="/admin/review-queue" class="btn-link">View Full Queue →</a></p>`
          : `<p style="color: var(--mut); font-size: 13px;">Review queue empty! ✓</p>`
      }
    `;

    const now = new Date().toLocaleTimeString();
    const timestamp = `<p style="text-align: center; color: var(--mut); font-size: 12px; margin-top: 32px;">
      Last updated: ${now}
      <button style="background: none; border: none; color: var(--acc); cursor: pointer; margin-left: 12px; text-decoration: underline; font-size: 12px;" onclick="location.reload()">Refresh</button>
    </p>`;

    content.innerHTML = statsHtml + actionsHtml + autoHtml + reviewHtml + timestamp;
  }

  window.addEventListener("load", () => {
    render();
    setInterval(render, REFRESH_MS);
  });
})();
