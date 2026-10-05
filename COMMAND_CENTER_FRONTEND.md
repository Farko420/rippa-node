# Command Center Frontend — Build Summary

## Overview

Completed implementation of the **Command Center intake system** frontend, mirroring the dashboard's PIN session + SSE auth patterns while providing a dedicated chat interface for AI training intake.

## Files Created

### 1. **public/command-center.html** (4.1 KB)
- Single-page shell with PIN lock screen + authenticated app view
- Thread container with message feed (auto-scroll, role badges, timestamps)
- Batch status panel with collapsible modal
- Footer composer: textarea with auto-resize, drag-drop zone, attach menu
- File input elements (files, folder, ZIP)

### 2. **public/command-center.css** (7.7 KB)
- **Layout**: Full-height flex shell, sticky footer, responsive grid (1fr 280px)
- **Messages**: User (blue left border) / Bot (green left border) styling
- **Composer**: Auto-resizing textarea, drag-drop visual feedback
- **Modal**: Centered overlay, read-only batch detail
- **Lock screen**: Full-screen gradient, PIN input, error messages
- **Responsive**: Stacks on mobile

### 3. **public/command-center.js** (13.8 KB)
- **Auth**: Same token pattern as dashboard (`rippa_dashboard_auth`)
- **Lock screen**: PIN unlock → `POST /api/auth/unlock`
- **Thread lifecycle**: Open, load messages, render with markdown
- **Composer**: Textarea, drag-drop, attach menu, file upload
- **Batch tracking**: Status display + modal detail
- **SSE**: Real-time events, auto-reconnect on 401
- **Init**: Token check, screen toggle, event stream start

### 4. **scripts/verify-command-center.mjs** (3.2 KB)
- Integration test: unlock → open thread → send message → check batch → verify messages
- Run with: `node scripts/verify-command-center.mjs`

## Integration Points

### Backend API Routes (in server.ts)
- `POST /api/auth/unlock` — PIN validation
- `POST /api/command-center/thread` — create/open
- `POST /api/command-center/message` — store message
- `POST /api/command-center/intake` — file intake
- `GET /api/command-center/thread?id=X` — load messages
- `GET /api/command-center/batch?threadId=X` — batch status
- `GET /api/system/events` — SSE (command_center events)

### Database Tables (SQLite)
- `cc_threads` — id, createdAt, lastMessageAt
- `cc_messages` — id, threadId, role, content, attachments JSON, createdAt
- `cc_batches` — id, threadId, status, photo/track/doc counts, summary, exifData, createdAt

## Key Design Decisions

1. **Shared Auth**: Single `rippa_dashboard_auth` token for dashboard + command-center
2. **Chat-First UI**: Messages as primary, batch status as sidebar (collapses on mobile)
3. **Client Markdown**: Basic parsing (`**bold**`, `` `code` ``, ` ``` ` blocks)
4. **SSE + Polling Fallback**: Real-time events with graceful degradation
5. **Drag-Drop + Menu**: Two upload paths, explicit type hints

## Build & Deploy

Run verification:
```bash
node scripts/verify-command-center.mjs
npm run build:webgui  # includes command-center files in REQUIRED check
npm run pkg           # freezes into exe
```

Limits:
- **2 GB global** multipart intake
- **2000 parts max** per request
- **512 MB** per file
- **Full message history** (no pagination)
