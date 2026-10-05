/**
 * COMMAND CENTER — command-center.js
 * Chat interface for intake threads.
 */
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const TOKEN_KEY = "rippa_dashboard_auth";
  let currentThreadId = null;
  let eventSource = null;

  function getToken() {
    try {
      const fromStorage = localStorage.getItem(TOKEN_KEY) || "";
      if (fromStorage) return fromStorage;
    } catch (err) {}
    try {
      const match = document.cookie.match(/(?:^|;\\s*)rippa_dashboard_auth=([^;]*)/);
      return match ? decodeURIComponent(match[1]) : "";
    } catch (err) {
      return "";
    }
  }

  function setToken(t) {
    try {
      if (t) localStorage.setItem(TOKEN_KEY, t);
      else localStorage.removeItem(TOKEN_KEY);
    } catch (err) {}
  }

  function authHeaders() {
    try {
      const token = localStorage.getItem(TOKEN_KEY) || "";
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
      showLockScreen();
      throw new Error("Session expired.");
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

  function showLockScreen() {
    const shell = $("ccApp");
    const lockScreen = $("lockScreen");
    if (shell) shell.hidden = true;
    if (lockScreen) lockScreen.classList.remove("hidden");
  }

  function hideLockScreen() {
    const shell = $("ccApp");
    const lockScreen = $("lockScreen");
    if (shell) shell.hidden = false;
    if (lockScreen) lockScreen.classList.add("hidden");
  }

  function wireLockScreen() {
    const input = $("unlockPin");
    const btn = $("unlockBtn");
    const error = $("unlockError");

    if (!btn) return;

    btn.addEventListener("click", async () => {
      const pin = (input ? input.value : "").trim();
      if (!pin) {
        if (error) {
          error.textContent = "Enter a PIN.";
          error.style.display = "block";
        }
        return;
      }

      btn.disabled = true;
      if (error) error.style.display = "none";

      try {
        const { response, data } = await api("/api/auth/unlock", {
          method: "POST",
          body: JSON.stringify({ pin }),
        });

        if (response.ok && data.success) {
          setToken(data.token || "");
          hideLockScreen();
          void initThread();
          startEventStream();
        } else {
          if (error) {
            error.textContent = data.error || "Incorrect PIN.";
            error.style.display = "block";
          }
          if (input) input.value = "";
        }
      } catch (err) {
        if (error) {
          error.textContent = err.message || "Connection failed.";
          error.style.display = "block";
        }
      } finally {
        btn.disabled = false;
      }
    });

    if (input) {
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") btn.click();
      });
    }
  }

  async function initThread() {
    try {
      const { response, data } = await api("/api/command-center/thread", {
        method: "POST",
        body: JSON.stringify({ action: "open" }),
      });
      if (response.ok && data.success) {
        currentThreadId = data.threadId;
        await loadMessages();
      }
    } catch (err) {
      showAlert("Failed to open thread: " + err.message, "bad");
    }
  }

  async function loadMessages() {
    if (!currentThreadId) return;
    try {
      const { response, data } = await api(`/api/command-center/thread?id=${currentThreadId}`);
      if (response.ok && data.success) renderMessages(data.messages || []);
    } catch (err) {
      console.error("Failed to load messages:", err);
    }
  }

  function escapeHtml(text) {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
  }

  function renderMessages(messages) {
    const list = $("messageList");
    const empty = $("threadEmpty");
    if (!list) return;
    if (messages.length === 0) {
      list.innerHTML = "";
      if (empty) empty.hidden = false;
      return;
    }
    if (empty) empty.hidden = true;
    list.innerHTML = messages.map((msg) => {
      const isUser = msg.role === "user";
      const ts = new Date(msg.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      let content = escapeHtml(msg.content)
        .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
        .replace(/`([^`]+)`/g, "<code>$1</code>")
        .replace(/```([\s\S]*?)```/g, "<pre><code>$1</code></pre>");
      let html = `<div class="cc-message ${isUser ? "user" : "bot"}"><div class="cc-message-meta">${escapeHtml(msg.role)} · ${ts}</div><div class="cc-message-text">${content}</div>`;
      if (msg.attachments && msg.attachments.length > 0) {
        html += '<div class="cc-media">';
        msg.attachments.forEach((att) => {
          if (/\.(jpg|jpeg|png|gif|webp)$/i.test(att.fileName)) {
            html += `<img src="${escapeHtml(att.url)}" alt="${escapeHtml(att.fileName)}" />`;
          } else if (/\.(mp4|webm|mov)$/i.test(att.fileName)) {
            html += `<video controls><source src="${escapeHtml(att.url)}" /></video>`;
          } else {
            html += `<a href="${escapeHtml(att.url)}" target="_blank">📎 ${escapeHtml(att.fileName)}</a>`;
          }
        });
        html += "</div>";
      }
      html += "</div>";
      return html;
    }).join("");
    setTimeout(() => { list.scrollTop = list.scrollHeight; }, 0);
  }


  function wireComposer() {
    const textarea = $("messageInput");
    const sendBtn = $("sendBtn");
    const attachBtn = $("attachBtn");
    const attachDropdown = $("attachDropdown");
    const dropzone = $("dropzone");

    if (!textarea || !sendBtn) return;

    textarea.addEventListener("input", () => {
      textarea.style.height = "auto";
      textarea.style.height = Math.min(textarea.scrollHeight, 200) + "px";
    });

    textarea.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        e.preventDefault();
        sendBtn.click();
      }
    });

    sendBtn.addEventListener("click", () => void sendMessage());

    if (attachBtn && attachDropdown) {
      attachBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        attachDropdown.hidden = !attachDropdown.hidden;
      });

      $("attachFiles")?.addEventListener("click", () => {
        $("filesInput")?.click();
        attachDropdown.hidden = true;
      });

      $("attachFolder")?.addEventListener("click", () => {
        $("folderInput")?.click();
        attachDropdown.hidden = true;
      });

      $("attachZip")?.addEventListener("click", () => {
        $("zipInput")?.click();
        attachDropdown.hidden = true;
      });

      document.addEventListener("click", () => {
        attachDropdown.hidden = true;
      });
    }

    $("filesInput")?.addEventListener("change", (e) => {
      void uploadFiles(Array.from(e.target.files || []));
    });

    $("folderInput")?.addEventListener("change", (e) => {
      void uploadFiles(Array.from(e.target.files || []));
    });

    $("zipInput")?.addEventListener("change", (e) => {
      void uploadFiles(Array.from(e.target.files || []));
    });

    if (dropzone) {
      dropzone.addEventListener("dragover", (e) => {
        e.preventDefault();
        dropzone.classList.add("dragover");
      });

      dropzone.addEventListener("dragleave", () => {
        dropzone.classList.remove("dragover");
      });

      dropzone.addEventListener("drop", (e) => {
        e.preventDefault();
        dropzone.classList.remove("dragover");
        const files = Array.from(e.dataTransfer.files || []);
        void uploadFiles(files);
      });
    }
  }

  async function sendMessage() {
    const textarea = $("messageInput");
    if (!textarea || !currentThreadId) return;

    const content = textarea.value.trim();
    if (!content) return;

    textarea.value = "";
    textarea.style.height = "auto";

    try {
      const { response, data } = await api("/api/command-center/message", {
        method: "POST",
        body: JSON.stringify({ threadId: currentThreadId, content }),
      });

      if (response.ok && data.success) {
        await loadMessages();
      } else {
        showAlert("Failed to send message: " + (data.error || "Unknown error"), "bad");
      }
    } catch (err) {
      showAlert("Error: " + err.message, "bad");
    }
  }

  async function uploadFiles(files) {
    if (!currentThreadId || files.length === 0) return;

    const formData = new FormData();
    formData.append("threadId", currentThreadId);
    files.forEach((file, idx) => {
      formData.append(`file_${idx}`, file);
    });

    try {
      const response = await fetch("/api/command-center/intake", {
        method: "POST",
        credentials: "same-origin",
        headers: authHeaders(),
        body: formData,
      });

      if (response.status === 401) {
        showLockScreen();
        throw new Error("Session expired.");
      }

      const data = await response.json();

      if (response.ok && data.success) {
        showAlert(`Uploaded ${files.length} file(s). Processing batch...`, "ok");
        await loadMessages();
        await loadBatchStatus();
      } else {

  async function loadBatchStatus() {
    if (!currentThreadId) return;
    try {
      const { response, data } = await api(`/api/command-center/batch?threadId=${currentThreadId}`);
      if (response.ok && data.success && data.batch) renderBatchBadge(data.batch);
    } catch (err) {
      console.error("Failed to load batch status:", err);
    }
  }

  function renderBatchBadge(batch) {
    const panel = $("batchPanel");
    const badge = $("batchBadge");
    if (!panel || !badge) return;

    const items = [];
    if (batch.photoCount > 0) items.push(`${batch.photoCount} photos`);
    if (batch.trackCount > 0) items.push(`${batch.trackCount} tracks`);
    if (batch.documentCount > 0) items.push(`${batch.documentCount} docs`);

    if (items.length === 0) {
      panel.hidden = true;
      return;
    }

    panel.hidden = false;
    badge.className = batch.status === "processing" ? "batch-badge processing" : "batch-badge";
    badge.innerHTML = `📦 ${items.join(" · ")}<br><span style="font-size: 11px; color: var(--mut);">Status: ${batch.status}</span>`;
    $("batchModalBtn")?.addEventListener("click", () => void showBatchModal(batch), { once: true });
  }

  async function showBatchModal(batch) {
    const modal = $("batchModal");
    const detail = $("batchDetail");
    const modalX = $("batchModalX");
    const overlay = $("batchModalOverlay");
    if (!modal || !detail) return;

    detail.innerHTML = `<p><strong>Batch ID:</strong> ${escapeHtml(batch.id || "—")}</p><p><strong>Status:</strong> ${escapeHtml(batch.status || "unknown")}</p><p><strong>Photos:</strong> ${batch.photoCount || 0}</p><p><strong>Tracks:</strong> ${batch.trackCount || 0}</p><p><strong>Documents:</strong> ${batch.documentCount || 0}</p>${batch.summary ? `<p><strong>Summary:</strong> ${escapeHtml(batch.summary)}</p>` : ""}`;

    modal.hidden = false;
    const closeModal = () => { modal.hidden = true; };
    modalX?.addEventListener("click", closeModal, { once: true });
    overlay?.addEventListener("click", closeModal, { once: true });
  }

  function startEventStream() {
    if (typeof EventSource === "undefined") return;
    try {
      eventSource = new EventSource("/api/system/events", { withCredentials: true });
      eventSource.addEventListener("command_center", (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.type === "batch_complete" || data.type === "message") {
            void loadMessages();
            void loadBatchStatus();
          }
        } catch (err) {
          console.error("Failed to parse event:", err);
        }
      });
      eventSource.addEventListener("error", () => {
        if (eventSource && eventSource.readyState === 2) {
          eventSource.close();
          showLockScreen();
        }
      });
    } catch (err) {}
  }

  async function init() {
    const token = getToken();
    if (!token) {
      showLockScreen();
      wireLockScreen();
      return;
    }

    hideLockScreen();
    wireComposer();
    void initThread();
    startEventStream();

    $("ccLock")?.addEventListener("click", () => {
      setToken("");
      eventSource?.close();
      showLockScreen();
      wireLockScreen();
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  window.RippaCommandCenterStart = init;
})();

        showAlert("Upload failed: " + (data.error || "Unknown error"), "bad");
      }
    } catch (err) {
      showAlert("Error: " + err.message, "bad");
    }
  }
