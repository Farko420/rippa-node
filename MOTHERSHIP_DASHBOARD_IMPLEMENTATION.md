# MOTHERSHIP DASHBOARD - OTA PROGRESS UI

## DATABASE MIGRATION

```sql
ALTER TABLE nodes ADD COLUMN (
  ota_progress INTEGER DEFAULT 0 CHECK (ota_progress BETWEEN 0 AND 100),
  ota_state VARCHAR(32),
  ota_error TEXT
);
```

## HEARTBEAT ENDPOINT UPDATE

```typescript
// In POST /api/swarm/heartbeat handler:

if (payload.ota_status) {
  node.otaProgress = Math.max(0, Math.min(100, payload.ota_status.progress ?? 0));
  node.otaState = String(payload.ota_status.state || "completed").toLowerCase();
  node.otaError = payload.ota_status.errorMessage || null;
  
  if (node.otaProgress > 0) {
    console.log(`[OTA] ${node.nodeCode}: ${node.otaState} ${node.otaProgress}%`);
  }
} else {
  node.otaProgress = 0;
  node.otaState = null;
  node.otaError = null;
}

// Auto-clear on version change
if (
  payload.current_version &&
  payload.current_version !== node.currentVersion &&
  node.otaState === "staged"
) {
  console.log(`[OTA] ${node.nodeCode}: applied v${payload.current_version}`);
  node.otaState = "completed";
  node.otaProgress = 100;
}
```

## DASHBOARD CSS

```css
.node-card {
  position: relative;
  overflow: hidden;
}

.node-ota-progress {
  position: absolute;
  bottom: 0;
  left: 0;
  height: 2px;
  background: #10b981;  /* green */
  transition: width 0.3s ease-out;
  will-change: width;
}

.node-card[data-ota-state="downloading"] .node-ota-progress {
  background: linear-gradient(90deg, #10b981 0%, #059669 50%, #10b981 100%);
  background-size: 200% 100%;
  animation: ota-pulse 2s ease-in-out infinite;
}

@keyframes ota-pulse {
  0% { background-position: 100% 0; }
  100% { background-position: -100% 0; }
}

.node-card[data-ota-state="error"] .node-ota-progress {
  background: #ef4444;  /* red */
  animation: ota-error-pulse 0.8s infinite;
}

@keyframes ota-error-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.6; }
}

.node-card[data-ota-state="downloading"] .force-update-btn,
.node-card[data-ota-state="staged"] .force-update-btn {
  opacity: 0.6;
  cursor: not-allowed;
  pointer-events: none;
}

.node-card[data-ota-state="error"] .force-update-btn {
  background: #fef2f2;
  color: #7f1d1d;
  border-color: #ef4444;
}
```

## DASHBOARD JS - renderTopology()

```javascript
// In renderTopology(), after existing card setup:

// NEW: OTA state attributes
const otaStatus = satellite.ota_status;
if (otaStatus) {
  card.setAttribute("data-ota-state", otaStatus.state || "completed");
  card.setAttribute("data-ota-progress", otaStatus.progress || 0);
  if (otaStatus.errorMessage) {
    card.setAttribute("data-ota-error", otaStatus.errorMessage);
  }
}

// NEW: Progress bar HTML (add to card.innerHTML)
let progressBarHTML = "";
if (otaStatus && otaStatus.state !== "completed") {
  const width = otaStatus.state === "error" ? 100 : (otaStatus.progress || 0);
  progressBarHTML = `<div class="node-ota-progress" style="width: ${width}%"></div>`;
}

// Add progressBarHTML to end of card.innerHTML
```

## BUTTON STATE HANDLER

```javascript
function handleForceUpdateButton(satellite) {
  const otaStatus = satellite.ota_status;
  
  if (otaStatus?.state === "downloading" || otaStatus?.state === "staged") {
    showNotification("Update already in progress");
    return;
  }
  
  // Update button display
  const btn = document.querySelector(`[data-node="${satellite.nodeCode}"] .force-btn`);
  if (!btn) return;
  
  if (otaStatus?.state === "downloading") {
    btn.textContent = `Downloading ${otaStatus.progress}%...`;
    btn.disabled = true;
  } else if (otaStatus?.state === "error") {
    btn.textContent = "❌ Failed — Retry";
    btn.title = otaStatus.errorMessage;
  } else {
    btn.textContent = "Force OTA Update";
    btn.disabled = false;
  }
}
```

## Testing

- [ ] Progress bar animates 0→100%
- [ ] Red error state on failure
- [ ] Button disabled during update
- [ ] Auto-clear on version change
- [ ] Mobile responsive
- [ ] Accessibility compliant

**Next**: Implement in Mothership repository after Node PR merges
