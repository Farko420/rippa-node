# CRITICAL BUG FIXES: HEARTBEAT 500 ERROR, WATCHDOG EPERM, & STALE COMMAND QUEUE

## STATUS: EPIC 2 & 3 COMPLETE, EPIC 1 DOCUMENTED

This document tracks fixes for three critical fleet outages:

1. **EPIC 2: Watchdog Windows EPERM** ✅ FIXED
2. **EPIC 3: Acknowledge Refused Downgrades** ✅ ALREADY IMPLEMENTED  
3. **EPIC 1: Mothership Heartbeat 500 Error** ⏳ DOCUMENTED & AWAITING BACKEND FIX

---

## EPIC 2: WATCHDOG WINDOWS EPERM FIX ✅ FIXED

### Problem
```
[Watchdog] swap failed after 10 attempts (EPERM: operation not permitted, unlink 'C:\Rippa Node\rippa-node.exe.old')
```

The `.old` file stays locked by Windows (AV scanner, indexing, lingering handles) after a swap, causing cleanup to fail and the watchdog to abort boot entirely.

### Solution
**File:** `src/watchdog.ts` lines 497-506

Wrapped the final `.old` cleanup in a soft try/catch. If deletion fails:
- Log a warning (cleanup failed, but swap succeeded)
- Continue to boot the new executable anyway
- Next successful swap will clean up the stray `.old` file

### Code
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

---

## EPIC 3: ACKNOWLEDGE REFUSED DOWNGRADES ✅ ALREADY IMPLEMENTED

### Problem
Downgrade refusal (e.g., v1.0.20 node refuses `FORCE_UPDATE` to v1.0.19) doesn't acknowledge the command, leaving it queued upstream → infinite heartbeat loop.

### Solution
**File:** `src/services/heartbeat.ts` lines 654-673

When `forceUpdate()` returns `"rejected_downgrade"`, explicitly acknowledge with terminal status:

```typescript
if (committed === "rejected_downgrade") {
  await acknowledge(
    handlers,
    "FORCE_UPDATE",
    "rejected_downgrade — this node is already running a newer build...",
    { ...ackContext, status: "rejected_downgrade" },
  );
}
```

The Mothership recognizes `status: "rejected_downgrade"` as terminal (not transient) and removes the entry from the queue.

---

## EPIC 1: MOTHERSHIP HEARTBEAT 500 ERROR ⏳

### Problem  
The Node sends telemetry with new fields (`current_version`, `ollama.*`, `connected_satellites`) but the Mothership schema is missing those columns → Drizzle throws HTTP 500 on insert.

### Fields Being Sent
From `src/network/SwarmClient.ts` (HeartbeatPayload interface):

**New Telemetry Fields:**
- `current_version`: string (granular version for Swarm Grid)
- `last_updated_at`: ISO-8601 string
- `ollama`: { managed, running, model, port, task }
- `connected_satellites`: string[] (peer-to-peer nodes)
- `current_process`: { task, startedAt, elapsedSeconds }

### Fix: Update Mothership Schema

**Mothership Backend Location:** `wrangler/src/db/schema.ts` (or equivalent)

Add these columns to the `nodes` table:

```typescript
// Granular version tracking
current_version: text('current_version'),
last_updated_at: text('last_updated_at'),

// Ollama AI telemetry
ollama_managed: integer('ollama_managed'),        // bool: 0|1
ollama_running: integer('ollama_running'),        // bool: 0|1
ollama_model: text('ollama_model'),
ollama_port: integer('ollama_port'),
ollama_task: text('ollama_task'),

// Mesh peer-to-peer
connected_satellites: text('connected_satellites'), // JSON array as string

// Current task
current_process_task: text('current_process_task'),
current_process_started_at: text('current_process_started_at'),
current_process_elapsed_seconds: real('current_process_elapsed_seconds'),
```

Then generate & apply D1 migration:
```bash
npx drizzle-kit generate --name add_heterogeneous_node_telemetry
npx wrangler d1 migrations apply <db>
```

### Fallback: Sanitize Payload (if schema update blocked)

In `/api/swarm/heartbeat` route, strip unknown fields:
```typescript
const KNOWN_FIELDS = ['nodeName', 'nodeCode', 'role', 'status', 'version', ...];
const sanitized = Object.fromEntries(
  Object.entries(payload).filter(([k]) => KNOWN_FIELDS.includes(k))
);
```

⚠️ **Note:** Sanitization hides the problem—telemetry is lost. Schema migration is required for full functionality.

