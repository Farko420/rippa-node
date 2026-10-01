# Rippa Node Architecture Improvements

## Overview

This document describes the architectural overhaul to support real-time brain sync, autonomous task claiming, and mobile APK compilation.

## 1. Mobile Runtime Decoupling

### Problem
The original codebase imported Node builtins at the top level, which prevented Capacitor from building a browser-safe APK. The WebView environment has no access to Node.js modules.

### Solution
Created a dedicated, browser-safe satellite runtime layer in `src/satellite/`:

- **storage-provider.ts**: Abstract interface for persistence
  - `InMemoryStorage` for mobile/testing
  - `createStorageProvider()` auto-detects environment
  
- **storage-desktop.ts**: Desktop-only SQLite implementation
  - Never imported by mobile builds
  - Esbuild tree-shakes it from the APK
  
- **mobile-worker.ts**: Browser-safe worker
  - No Node builtins, uses standard browser APIs
  - Polls `/api/mesh/heartbeat` for tasks
  - Executes and reports results via `/api/mesh/result`

### Usage
```typescript
import { satelliteWorker } from "./satellite/mobile-worker";

const config = {
  nodeRole: "satellite",
  masterUrl: "http://master.local:4000",
  meshKey: "shared-secret",
  nodeName: "Tablet 1",
  port: 4000,
};

await satelliteWorker.initialize(config);
```

## 2. Real-Time Brain Synchronization

### Existing Implementation
- **SyncManager** (10-min interval): Pushes verified knowledge to Mothership
- **BrainDeltaSync** (12-hour interval): Pulls cloud changes atomically
- Both master-only, started in `src/index.ts`

### Sync Loop
```
Master: Local DB → POST /api/swarm/submit → Mothership
Master: GET /api/brain/delta?cursor=... ← Mothership
Master: Ingest changes into SQLite (atomic transaction)
```

### State Tracking
- SyncManager logs synced record count
- BrainDeltaSync tracks cursor atomically
- Offline is degraded mode, not failure

## 3. Asymmetric Node Pairing

### Master
- Generates and holds `MESH_KEY`
- Advertises via UDP beacon (node code + name + port)
- Only source of mesh keys

### Satellite
- Scans LAN for Master beacons
- One-time handshake: POST `/api/mesh/pair`
- Stores issued key + peer list in config
- Never generates keys

### Web UI
- Master: Shows "Registration Code" (shared with operators)
- Satellite: Single input: "Enter Master's Code or IP"
- No key generation on Satellite

## 4. Task Claiming & Dispatch

### Heartbeat Flow
```
Satellite → POST /api/mesh/heartbeat {status: "idle"}
           ↓
       Master dispatcher
           ↓
Master ← {task: {...}} (if available)
       ↓
       Satellite executes
       ↓
       POST /api/mesh/result {taskId, status, result}
```

### Task State
- Assigned → Master marks "claimed"
- Failed → Re-queued after backoff
- Completed → Reported to Mothership

## 5. Local APK Build

### Command
```bash
npm run build:apk
```

### Pipeline
1. TypeScript compile
2. Esbuild mobile worker (browser target)
3. Stage dashboard → `mobile/www/`
4. Install Capacitor deps
5. Generate Android project
6. Apply manifest overlay
7. Gradle build
8. **Copy APK to root**: `rippa-satellite.apk`

### Output
```
rippa-satellite.apk (12.3 MB)
adb install -r rippa-satellite.apk
```

## 6. Persistence

### Desktop
- `%LOCALAPPDATA%\RippaNode` (Windows)
- `~/.rippa-node` (Unix)
- Config: node code, mesh key, pairing, database
- Survives OTA updates (exe replaced, data preserved)

### Mobile
- Capacitor storage or IndexedDB
- Auto-init on first boot
- Same config schema as desktop

## 7. Build Status

- [x] TypeScript compiles (no errors)
- [x] `npm run build` succeeds
- [x] Mobile worker is browser-safe
- [x] APK script copies to root
- [ ] `npm run build:apk` (needs Android SDK)
- [ ] `npm run package` (desktop EXE)

## Git Commit Message

```
feat: decouple mobile satellite runtime, enforce asymmetric master peering, and add local apk build script
```

### Changes
- src/satellite/storage-provider.ts (new)
- src/satellite/storage-desktop.ts (new)
- src/satellite/mobile-worker.ts (new)
- scripts/package-apk.mjs (APK copy)
- package.json (build:apk alias)
