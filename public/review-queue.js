(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const LIMIT = 50;
  let currentOffset = 0;
  let totalCount = 0;

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

  async function fetchQueue(offset = 0) {
    const { data } = await api(`/api/admin/review-queue?limit=${LIMIT}&offset=${offset}`);
    if (!data.success) return { places: [], total: 0, has_more: false };
    return data.data || { places: [], total: 0, has_more: false };
  }

  async function fetchDetail(placeId) {
    const { data } = await api(`/api/admin/review-queue/${placeId}`);
    return data.success ? data.data : null;
  }

  function showModal(item, chunks) {
    const modal = $("detailModal");
    $("modalTitle").textContent = item.name || "Item";
    $("modalSummary").textContent = (item.summary || "No summary").substring(0, 200);

    const chunksHtml = chunks && chunks.length > 0
      ? chunks.map(c => `<div class="fact-item">
          <div class="fact-label">${c.category || "data"}</div>
          <div class="fact-text">${c.text || "—"}</div>
          <div style="font-size: 11px; color: var(--mut); margin-top: 4px;">${c.confidence || 0}% confidence</div>
        </div>`).join("")
      : `<p style="color: var(--mut);">No chunks extracted.</p>`;
    $("modalChunks").innerHTML = chunksHtml;

    $("modalActions").innerHTML = `
      <button style="padding: 8px 16px; background: #3fb950; color: white; border: none; border-radius: 6px; cursor: pointer;" onclick="window.triageAction('${item.id}', 'approve')">✓ Approve</button>
      <button style="padding: 8px 16px; background: #f85149; color: white; border: none; border-radius: 6px; cursor: pointer;" onclick="window.triageAction('${item.id}', 'reject')">✕ Reject</button>
      <button style="padding: 8px 16px; background: var(--acc); color: white; border: none; border-radius: 6px; cursor: pointer;" onclick="window.triageAction('${item.id}', 'retry')">↻ Retry</button>
    `;

    modal.classList.add("show");
  }

  async function showDetail(placeId) {
    const detail = await fetchDetail(placeId);
    if (detail) {
      showModal(detail.place, detail.chunks);
    } else {
      alert("Failed to load details");
    }
  }

  async function triageAction(placeId, action) {
    const { data } = await api(`/api/admin/review-queue/${placeId}`, {
      method: "PUT",
      body: JSON.stringify({ action }),
    });
    if (data.success) {
      alert("Action completed");
      window.closeDetail();
      render(currentOffset);
    } else {
      alert("Failed: " + (data.message || "Error"));
    }
  }

  async function render(offset = 0) {
    currentOffset = offset;
    const result = await fetchQueue(offset);
    totalCount = result.total || 0;
    const items = result.places || [];
    const hasMore = result.has_more || false;

    let html = `<div class="header-row">
      <div><h1>Review Queue</h1><p class="sub" style="margin: 4px 0 0;">Showing ${offset + 1}–${Math.min(offset + LIMIT, totalCount)} of ${totalCount}</p></div>
      <span class="queue-badge">⚠️ ${totalCount}</span>
    </div>`;

    if (items.length > 0) {
      html += `<table><thead><tr><th>Name</th><th>Confidence</th><th>Status</th><th>Actions</th></tr></thead><tbody>`;
      items.forEach(item => {
        html += `<tr onclick="window.showDetail('${item.id}')">
          <td><strong>${item.name}</strong></td>
          <td><span class="queue-badge" style="background: rgba(210,153,34,0.2); color: #d29922;">${item.confidence_score.toFixed(0)}%</span></td>
          <td style="font-size: 12px; color: var(--mut);">${item.consensus_status || "pending"}</td>
          <td>
            <button class="btn-sm btn-approve" onclick="event.stopPropagation(); window.triageAction('${item.id}', 'approve')">Approve</button>
            <button class="btn-sm btn-reject" onclick="event.stopPropagation(); window.triageAction('${item.id}', 'reject')">Reject</button>
            <button class="btn-sm btn-retry" onclick="event.stopPropagation(); window.triageAction('${item.id}', 'retry')">Retry</button>
          </td>
        </tr>`;
      });
      html += `</tbody></table>`;
    } else {
      html += `<div style="text-align: center; padding: 40px; color: var(--mut);"><p>✓ Queue is empty!</p></div>`;
    }

    if (totalCount > LIMIT) {
      html += `<div class="pagination">`;
      if (offset > 0) html += `<button class="page-btn" onclick="window.goPage(${offset - LIMIT})">← Previous</button>`;
      html += `<span style="padding: 6px 12px; color: var(--mut); font-size: 12px;">Page ${Math.floor(offset / LIMIT) + 1}</span>`;
      if (hasMore) html += `<button class="page-btn" onclick="window.goPage(${offset + LIMIT})">Next →</button>`;
      html += `</div>`;
    }

    $("content").innerHTML = html;
  }

  window.goPage = (offset) => render(offset);
  window.showDetail = showDetail;
  window.triageAction = triageAction;
  window.closeDetail = () => $("detailModal").classList.remove("show");

  window.addEventListener("load", () => render(0));
})();
