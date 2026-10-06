# SWARM ORCHESTRATION: PARALLEL CHUNKING & AI CONSENSUS

**Epic Status:** ✅ Implementation Complete  
**Components:** swarmChunker | swarmCompiler | consensusEngine | mothershipGateway | swarmCommander

## Overview

The Master Node now orchestrates parallel workload distribution across Satellite Nodes:

1. **CHUNKING** — Split large tasks into distributable units
2. **DISPATCH** — Send chunks to satellites via P2P HTTP
3. **COMPILATION** — Merge results from all nodes
4. **CONSENSUS** — Verify accuracy (2-node check for anti-hallucination)
5. **INJECTION** — Auto-publish verified data to Mothership (confidence >= 90)

## Core Files

### `swarmChunker.ts`
- `chunkPayload<T>()` — Split arrays into N chunks
- `chunkBySize()` — Split text by byte size
- `dispatchChunkToPeer()` — Send chunk to satellite
- `dispatchAllChunks()` — Distribute all chunks round-robin

### `swarmCompiler.ts`
- `awaitChunkResults()` — Collect responses with timeout
- `mergeResults()` — Stitch chunks back together
- `deduplicateByKey()` — Remove duplicates
- `compileChunks()` — Full pipeline

### `consensusEngine.ts`
- `sendConsensusCheckToSatellite()` — Ask satellite to verify
- `compareConsensusOutputs()` — Check if facts match
- `factsAreSimilar()` — Semantic similarity (Jaccard 60%+)
- `runConsensusCheck()` — Full 2-node verification

**Confidence Scoring:**
- **95+** — Consensus verified (facts match)
- **60** — Satellite unreachable (medium confidence)
- **40** — Conflict detected (send to Admin review)

### `mothershipGateway.ts`
- `buildMothershipPayload()` — Format for API
- `injectIntoMothership()` — POST to `/api/admin/places/import`
- `isEligibleForAutoPublish()` — Check confidence >= 90

### `swarmCommander.ts`
Unified orchestration:
- `executeSwarmCommand()` — Chunks → Dispatch → Compile → Consensus → Inject
- `compileSwarmResults()` — Just chunking + compilation

## Usage

```typescript
import { executeSwarmCommand } from "./services/swarmCommander";

const outcome = await executeSwarmCommand(
  facts,                           // VerifiedFact[]
  "https://source.com/page",       // sourceUrl
  satellites,                      // PeerEndpoint[]
  meshKey,                        // string
  {
    chunkSize: 100,
    verifyConsensus: true,
    autoInject: true,
    mothershipsApiKey: env.MOTHERSHIP_API_KEY,
  }
);

// outcome.success — all phases completed
// outcome.consensus.confidence_score — 95 (match) or 40 (conflict)
// outcome.mothership.autoPublished — true if >= 90 confidence
```

## New Server Endpoints

### POST /api/mesh/process-chunk
Satellites process chunks. Sent by Master with:
- chunkId, parentTaskId, sequenceNumber, totalChunks
- data[] — items to process
- Mesh-Key header for authentication

### POST /api/mesh/consensus-check
Satellites verify facts independently. Sent by Master with:
- checkId, prompt, sourceData
- Satellite extracts same facts as Master
- Results compared for semantic similarity

## Key Design Decisions

**Round-Robin Distribution:** First chunk to Master, rest to satellites  
**Timeouts:** 30s per chunk, 120s total compilation  
**Partial Failure:** Continues if majority chunks succeed  
**Consensus:**  70% fact match = agreement → confidence 95  
**Fallback:** Satellite unavailable = degraded confidence (60)

## Integration Points

- **IngestionEngine:** Heavy PDF/ZIP processing
- **CommandCenter:** PENDING_MASTER_ANALYSIS batch processing
- **AutonomousForager:** High-value fact verification
- **Mothership:** Auto-publish at >= 90 confidence

## Confidence Thresholds

| Score | Action |
|-------|--------|
| 95+ | ✅ AUTO-PUBLISH |
| 60-94 | ⏳ Admin Review |
| <40 | ❌ Reject |

---

For full details, see src/services/swarmChunker.ts, swarmCompiler.ts, etc.
