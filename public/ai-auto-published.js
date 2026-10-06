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

  async function fetchPublished(offset = 0) {
    const { data } = await api(`/api/admin/auto-published?limit=${LIMIT}&offset=${offset}`);
    if (!data.success) return { places: [], total: 0, has_more: false };
    return data.data || { places: [], total: 0, has_more: false };
  }

  async function unpublishItem(placeId) {
    const { data } = await api(`/api/admin/review-queue/${placeId}`, {
      method: "PUT",
      body: JSON.stringify({ action: "retry" }),
    });
    if (data.success) {
      alert("Item moved to review queue");
      render(currentOffset);
    } else {
      alert("Failed to unpublish: " + (data.message || "Unknown error"));
    }
  }

  async function render(offset = 0) {
    currentOffset = offset;
    const content = $("content");
    content.innerHTML = `<div style="text-align: center; padding: 40px;"><p style="color: var(--mut);">Loading...</p></div>`;

    const result = await fetchPublished(offset);
    totalCount = result.total || 0;
    const items = result.places || [];
    const hasMore = result.has_more || false;

    const headerHtml = `<div class="header-row">
      <div>
        <h1>Auto-Published Items</h1>
        <p class="sub" style="margin: 4px 0 0;">Showing ${offset + 1}–${Math.min(offset + LIMIT, totalCount)} of ${totalCount} items</p>
      </div>
    </div>`;

    const tableHtml = items.length > 0
      ? `<table>
          <thead><tr>
            <th>Name</th>
            <th>Confidence</th>
            <th>Source</th>
            <th>Action</th>
          </tr></thead>
          <tbody>
            ${items.map(item => `
              <tr>
                <td><strong>${item.name || "Unnamed"}</strong></td>
                <td><span class="badge score">${item.confidence_score.toFixed(0)}%</span></td>
                <td style="font-size: 12px; color: var(--mut);">${item.source_url ? item.source_url.substring(0, 40) + "..." : "—"}</td>
                <td><button class="btn" onclick="window.unpublishItem('${item.id}')">Unpublish</button></td>
              </tr>
            `).join("")}
          </tbody>
        </table>`
      : `<div style="text-align: center; padding: 40px; color: var(--mut);">
          <p>No auto-published items.</p>
        </div>`;

    const paginationHtml = totalCount > LIMIT
      ? `<div class="pagination">
          ${offset > 0 ? `<button class="page-btn" onclick="window.goPage(${offset - LIMIT})">← Previous</button>` : ""}
          <span style="padding: 6px 12px; color: var(--mut); font-size: 12px;">Page ${Math.floor(offset / LIMIT) + 1}</span>
          ${hasMore ? `<button class="page-btn" onclick="window.goPage(${offset + LIMIT})">Next →</button>` : ""}
        </div>`
      : "";

    content.innerHTML = headerHtml + tableHtml + paginationHtml;
  }

  window.goPage = (offset) => render(offset);
  window.unpublishItem = unpublishItem;

  window.addEventListener("load", () => {
    render(0);
  });
})();
