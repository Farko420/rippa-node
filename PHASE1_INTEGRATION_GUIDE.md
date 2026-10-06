# PHASE 1 — BACKEND API INTEGRATION GUIDE

## Quick Reference for Phase 2 Frontend

---

## DATABASE HELPERS (`src/services/swarmTriageQueries.ts`)

### Reading Functions
```typescript
getAutoPublishedPlaces(limit=50, offset=0)  // confidence >= 90
getReviewQueuePlaces(limit=50, offset=0)    // confidence < 90
getReviewQueueCount()                        // Count for sidebar
getAutoPublishedCount()                      // Count of verified
getConsensusStats()                          // Fleet telemetry
getPlaceById(id)                             // Single place + metadata
getPlaceChunks(placeId)                      // Associated facts
```

### Action Functions
```typescript
approveAndPublishPlace(id)      // confidence=95, publish=1, status='verified'
rejectAndDeletePlace(id)        // confidence=0, publish=0
sendPlaceBackToSwarm(id)        // Reset for re-analysis
```

---

## REST API ENDPOINTS

All routes: `/api/admin/*`  
Auth: Requires `requireDashboardAuth` middleware

### GET /swarm-stats
Returns: `{ consensus_match_rate, verified_count, conflict_count, ... }`

### GET /auto-published?limit=50&offset=0
Returns: `{ places[], total, limit, offset, has_more }`

### GET /review-queue?limit=50&offset=0
Returns: `{ places[], total, limit, offset, has_more }`

### GET /review-count
Returns: `{ count: number }`

### GET /review-queue/:id
Returns: `{ place: SwarmTriageItem, chunks[] }`

### PUT /review-queue/:id
Body: `{ action: 'approve' | 'reject' | 'retry' }`
Returns: `{ success: bool, message: string, id, action }`

---

## Integration Patterns

### Sidebar Badge
```typescript
const { count } = await fetch('/api/admin/review-count').then(r => r.json());
showBadge(count > 0 ? count : '');
```

### List with Pagination
```typescript
const { data } = await fetch(
  `/api/admin/review-queue?limit=50&offset=${offset}`
).then(r => r.json());
// Use data.places, data.total, data.has_more
```

### Triage Action
```typescript
await fetch(`/api/admin/review-queue/${id}`, {
  method: 'PUT',
  body: JSON.stringify({ action: 'approve' })
}).then(r => r.json());
```

---

## Data Types

```typescript
interface SwarmTriageItem {
  id: string;
  name: string;
  summary: string | null;
  confidence_score: number;        // 0-100
  consensus_status: string;        // pending|verified|conflict|degraded
  ai_auto_published: number;       // 0 or 1
  source_url: string | null;
  category_ids: string | null;
}
```

---

## Error Handling

All errors return:
```json
{
  "success": false,
  "message": "Error description"
}
```

Status codes: 400 (bad request), 404 (not found), 500 (server error)

---

## Phase 2 UI Components

1. **Fleet Command Dashboard** — Show swarm stats
2. **Auto-Published Table** — List confidence >= 90 items
3. **Review Queue** — List confidence < 90 with triage actions
4. **Detail Modal** — Show place + chunks + action buttons
5. **Sidebar Badge** — Dynamic count of pending reviews

---

Ready for Phase 2! All backend is production-ready.
