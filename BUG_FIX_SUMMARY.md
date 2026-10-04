# CRITICAL BUG FIX SUMMARY

## Overview
Three critical fleet outages addressed:
1. **✅ EPIC 2: Watchdog Windows EPERM Fix** — IMPLEMENTED & TESTED (51/51 tests pass)
2. **✅ EPIC 3: Acknowledge Refused Downgrades** — VERIFIED EXISTING (all downgrade tests pass)
3. **📋 EPIC 1: Mothership Heartbeat 500 Error** — DOCUMENTED & AWAITING BACKEND FIX

---

## EPIC 2: WATCHDOG WINDOWS EPERM FIX ✅ DONE

### The Bug
```
[Watchdog] swap failed after 10 attempts (EPERM: operation not permitted, 
  unlink 'C:\Rippa Node\rippa-node.exe.old')
```

### Root Cause
Windows locks `.old` files briefly after a swap. The cleanup step at line 491 threw EPERM, causing the catch block to fail and abort boot, even though the new executable was successfully in place.

### Fix: Soft Try/Catch Around Cleanup
**File:** `src/watchdog.ts` lines 497-506

```typescript
if (renamed) {
  try {
    fs.rmSync(backup, { force: true });
  } catch (cleanupError) {
    log(
      `could not remove ${backup} (${describeError(cleanupError)}) — ` +
        "leaving it on disk and continuing; the swap itself succeeded.",
    );
  }
}
```

**Behavior:**
- If cleanup succeeds → no change
- If cleanup fails → log warning but **continue boot anyway**
- The new executable is already in place (line 489)
- Next swap will clean up the stray `.old` file

### Testing Results
✅ **All 51 watchdog tests pass** (run: `npm run test:watchdog`)

---

## EPIC 3: ACKNOWLEDGE REFUSED DOWNGRADES ✅ VERIFIED

### The Bug
v1.0.20 node refuses `FORCE_UPDATE` to v1.0.19, but doesn't acknowledge. Mothership re-sends the same command on every heartbeat → infinite loop.

### Solution: Already Implemented
**File:** `src/services/heartbeat.ts` lines 654-673

When `forceUpdate()` returns `"rejected_downgrade"`:
```typescript
if (committed === "rejected_downgrade") {
  await acknowledge(
    handlers,
    "FORCE_UPDATE",
    "rejected_downgrade — this node is already running...",
    { ...ackContext, status: "rejected_downgrade" },
  );
}
```

The `status: "rejected_downgrade"` tells Mothership:
- This is **terminal** (not transient)
- Entry can be safely removed from queue
- No retry will change the outcome

### Testing Results
✅ **All downgrade tests pass** (run: `npm run test:verify`)

Key passing tests:
- ✅ refused downgrade acknowledged with terminal status
- ✅ acknowledgment carries the command id
- ✅ Mothership settles it instead of looping

---

## EPIC 1: MOTHERSHIP HEARTBEAT 500 ERROR 📋

### The Bug
Node sends new telemetry fields (Heterogeneous Nodes update) but Mothership schema is missing columns → HTTP 500 on insert.

### Fields Being Sent
From `src/network/SwarmClient.ts` HeartbeatPayload:
- `current_version`: string (granular version for Swarm Grid)
- `last_updated_at`: ISO-8601 string
- `ollama`: { managed, running, model, port, task }
- `connected_satellites`: string[] (peer-to-peer nodes)
- `current_process`: { task, startedAt, elapsedSeconds }

### Fix: Update Mothership Schema

**Location:** `wrangler/src/db/schema.ts`

Add to `nodes` table:
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

Generate and apply D1 migration:
```bash
npx drizzle-kit generate --name add_heterogeneous_node_telemetry
npx wrangler d1 migrations apply <db>
```

### Fallback: Sanitize Payload
If schema migration blocked, sanitize in `/api/swarm/heartbeat`:
```typescript
const KNOWN_FIELDS = ['nodeName', 'nodeCode', 'role', 'status', 'version', ...];
const sanitized = Object.fromEntries(
  Object.entries(payload).filter(([k]) => KNOWN_FIELDS.includes(k))
);
```

⚠️ Note: Sanitization is a short-term workaround. Schema migration is required for full functionality.

---

## Summary

| Epic | Issue | Status |
|------|-------|--------|
| 2 | Watchdog EPERM crash | ✅ FIXED (wrapped cleanup in try/catch) |
| 3 | Downgrade loop | ✅ VERIFIED (already acknowledged properly) |
| 1 | Heartbeat 500 | 📋 DOCUMENTED (awaiting Mothership schema update) |

