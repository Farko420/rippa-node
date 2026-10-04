# CRITICAL BUG FIXES - IMPLEMENTATION COMPLETE ✅

## Status Summary

| Epic | Issue | Status | Tests |
|------|-------|--------|-------|
| **EPIC 2** | Watchdog EPERM crash on OTA | ✅ FIXED | **51/51 PASS** |
| **EPIC 3** | Downgrade command loop | ✅ VERIFIED | **All PASS** |
| **EPIC 1** | Heartbeat 500 error | 📋 DOCUMENTED | Await backend |

---

## EPIC 2: WATCHDOG WINDOWS EPERM FIX ✅

### The Problem
Watchdog crashed during OTA when `.old` file wouldn't delete (Windows lock):
```
[Watchdog] swap failed after 10 attempts (EPERM: operation not permitted)
```

### The Solution
**File:** `src/watchdog.ts` lines 490-506

Wrapped cleanup in try/catch. If deletion fails:
- Log warning (not error)
- Continue boot anyway (new executable already in place)
- Next swap cleans up stray file

```typescript
if (renamed) {
  try {
    fs.rmSync(backup, { force: true });
  } catch (cleanupError) {
    log(`could not remove ${backup} (${describeError(cleanupError)}) — ` +
        "leaving it on disk and continuing; the swap itself succeeded.");
  }
}
```

### Test Results
```
✅ applyStagedUpdate reports success
✅ the old executable is removed after successful swap
✅ All 51 watchdog tests pass
```

---

## EPIC 3: ACKNOWLEDGE REFUSED DOWNGRADES ✅

### The Problem
v1.0.20 node refuses downgrade to v1.0.19 but doesn't acknowledge. Mothership re-sends command on every heartbeat → loop.

### The Solution
**File:** `src/services/heartbeat.ts` lines 654-673

When downgrade rejected, acknowledge with terminal status:
```typescript
if (committed === "rejected_downgrade") {
  await acknowledge(handlers, "FORCE_UPDATE",
    "rejected_downgrade — this node is already running...",
    { ...ackContext, status: "rejected_downgrade" });
}
```

Status `"rejected_downgrade"` tells Mothership:
- This is **terminal** (not transient)
- Queue entry can be safely removed
- No retry will change outcome

### Test Results
```
✅ refused downgrade acknowledged with terminal status
✅ acknowledgment carries the command id
✅ Mothership settles it instead of looping
```

---

## EPIC 1: MOTHERSHIP HEARTBEAT 500 ERROR 📋

### The Problem
Node sends new telemetry fields (Heterogeneous Nodes update) but Mothership schema missing columns → HTTP 500.

### New Fields Sent
From `src/network/SwarmClient.ts`:
- `current_version`: string
- `last_updated_at`: ISO-8601
- `ollama`: { managed, running, model, port, task }
- `connected_satellites`: string[]
- `current_process`: { task, startedAt, elapsedSeconds }

### The Fix
**Location:** `wrangler/src/db/schema.ts`

Add these 10 columns to `nodes` table:
```typescript
current_version: text('current_version'),
last_updated_at: text('last_updated_at'),
ollama_managed: integer('ollama_managed'),
ollama_running: integer('ollama_running'),
ollama_model: text('ollama_model'),
ollama_port: integer('ollama_port'),
ollama_task: text('ollama_task'),
connected_satellites: text('connected_satellites'),
current_process_task: text('current_process_task'),
current_process_started_at: text('current_process_started_at'),
current_process_elapsed_seconds: real('current_process_elapsed_seconds'),
```

Generate & apply migration:
```bash
npx drizzle-kit generate --name add_heterogeneous_node_telemetry
npx wrangler d1 migrations apply <db>
```

---

## Test Commands

```bash
# EPIC 2: Watchdog
npm run test:watchdog          # 51/51 pass ✅

# EPIC 3: Downgrade  
npm run test:verify            # Downgrade tests pass ✅

# Full verification
npm run test:verify            # Runs all unit tests
```

---

## Summary

**EPIC 2 & 3:** ✅ Production-ready
- Watchdog OTA no longer crashes on file locks
- Downgrade refusals properly acknowledged
- No more command loops

**EPIC 1:** 📋 Awaiting Mothership schema migration
- Documentation provided
- Implementation straightforward (10 columns, 1 migration)

