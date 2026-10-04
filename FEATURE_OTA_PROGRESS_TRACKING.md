# FEATURE EPIC: REMOTE OTA PROGRESS TRACKING & DASHBOARD UI

## Status Summary
✅ **PARTIALLY IMPLEMENTED** - Hybrid model (heartbeat + rapid pings support)

Core Node-side infrastructure in place; Mothership UI/DB work pending.

## Quick Reference

### Node Repository Changes
- ✅ OtaStatus interface with state/progress/targetVersion/errorMessage
- ✅ OtaUpdater.getOtaStatus() exported getter
- ✅ HeartbeatTelemetry.ota_status field added
- ✅ SwarmClient OTA provider registration (design complete)
- ✅ Index.ts wiring to OtaUpdater (design complete)
- ⏳ Download progress tracking (needs pipeline integration)
- ⏳ Error state capture (needs catch block update)

### Mothership Changes (TODO)
- Database: Add ota_progress, ota_state, ota_error columns to nodes table
- API: Parse ota_status from heartbeat, store in DB, auto-clear on version change
- Dashboard: Progress bar CSS + button state management in JS

## Architecture

**OTA Status Flows Through**:
```
OtaUpdater.otaStatus
    ↓
OtaUpdater.getOtaStatus()  [getter]
    ↓
index.ts otaStatusProvider callback
    ↓
SwarmClient.readOtaStatus()  [defensive)
    ↓
HeartbeatPayload.ota_status (every 30s)
    ↓
Mothership /api/swarm/heartbeat
    ↓
Fleet Command Dashboard (realtime UI)
```

## State Machine

```
COMPLETED (initial)
    ↓ [FORCE_UPDATE starts]
DOWNLOADING (0-99%)
    ↓ [download finishes]
STAGED (100%)
    ↓ [node restarts]
COMPLETED (version changes, auto-clear)

ERROR (any stage)
    ↓ [operator retries]
DOWNLOADING
```

## Next Steps
1. Fix remaining Node-side compilation issues
2. Add download progress tracking in pipeline
3. Add error capture in catch block
4. Mothership database migration
5. Mothership heartbeat endpoint parsing
6. Dashboard CSS + JS rendering
