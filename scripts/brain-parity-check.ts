/**
 * STEP 2 of the cross-repo contract test (runs INSIDE rippa-node).
 *
 * Reads a bundle produced by rippa-adventures' real exporter, pushes it through
 * the real `ingestBrainBundle`, and verifies 1:1 parity in SQLite — counts,
 * values, and the sync cursor. Then it exercises the safety guards.
 *
 * Not part of the shipped app.
 *
 * The body is wrapped in an async IIFE because `ingestBrainBundle` returns a
 * promise: it yields to the event loop between chunks so it can publish live
 * progress to the dashboard (see `yieldToEventLoop` in brainIngest). Top-level
 * await is unavailable here — this file runs as CommonJS under tsx.
 */
import fs from "node:fs";
import { initializeDeepBrain, closeDeepBrain, getDeepBrain } from "../src/db/database";
import { ingestBrainBundle, validateBundle, getSyncCursor, getBrainCounts } from "../src/services/brainIngest";

const BUNDLE_PATH = process.argv[2];
const results: Array<{ name: string; pass: boolean; detail?: string }> = [];
const check = (name: string, pass: boolean, detail?: string): void => {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
};

if (!BUNDLE_PATH) {
  console.error("usage: tsx scripts/brain-parity-check.ts <bundle.json>");
  process.exit(1);
}

const raw = JSON.parse(fs.readFileSync(BUNDLE_PATH, "utf8"));

async function main(): Promise<void> {
// --- 1. The cloud's bundle must satisfy the node's stricter validator -------
const checked = validateBundle(raw);
check("cloud bundle passes the node's validator", checked.ok, checked.ok ? "" : checked.error);
if (!checked.ok) process.exit(1);

// --- 2. Ingest into a real SQLite database ----------------------------------
initializeDeepBrain();
const db = getDeepBrain();

const result = await ingestBrainBundle(raw);
check("ingest succeeded", result.ok, result.message);
check("places ingested", result.counts.places === 3, `${result.counts.places}`);
check("categories ingested", result.counts.categories === 2, `${result.counts.categories}`);
check("knowledge chunks ingested", result.counts.knowledge_chunks === 2, `${result.counts.knowledge_chunks}`);
check("road features ingested", result.counts.road_features === 1, `${result.counts.road_features}`);
check("tags ingested (cloud always sends zero)", result.counts.tags === 0, `${result.counts.tags}`);
check("no warnings on a clean bundle", result.warnings.length === 0, result.warnings.join("; "));

// --- 3. 1:1 PARITY: what the cloud sent is what the node now holds ----------
const stored = getBrainCounts();
check(
  "row counts match the bundle 1:1",
  stored.places === 3 && stored.categories === 2 && stored.knowledge_chunks === 2 &&
    stored.road_features === 1 && stored.tags === 0,
  JSON.stringify(stored),
);

const place = (id: string): Record<string, unknown> | undefined =>
  db.prepare("SELECT * FROM brain_places WHERE id = ?").get(id) as Record<string, unknown> | undefined;

const lamington = place("place-1");
check("place row is present", Boolean(lamington));
check("name round-tripped", lamington?.["name"] === "Lamington National Park", String(lamington?.["name"]));
check("coordinates round-tripped", lamington?.["lat"] === -16.1517 && lamington?.["lng"] === 145.4931,
  `${lamington?.["lat"]},${lamington?.["lng"]}`);
check("category_ids stored as JSON text", String(lamington?.["category_ids"]) === '["national-park"]',
  String(lamington?.["category_ids"]));

// Unicode + apostrophe must survive JSON, SQLite and the parameter binding.
const unicode = place("place-3");
check("unicode + apostrophe survived", unicode?.["name"] === "Cape Tribulation's Rainforest",
  String(unicode?.["name"]));
check("smart quotes survived", String(unicode?.["summary"] ?? "").includes("“wet tropics”"),
  String(unicode?.["summary"]));

// A null-everything place must load as NULLs, not as empty strings.
const blueLake = place("place-2");
check("null fields stayed NULL", blueLake?.["lat"] === null && blueLake?.["summary"] === null,
  `lat=${blueLake?.["lat"]} summary=${blueLake?.["summary"]}`);

const chunk = db.prepare("SELECT * FROM brain_chunks WHERE id = ?").get("fact-1") as Record<string, unknown> | undefined;
check("knowledge chunk round-tripped", chunk?.["text"] === "Box jellyfish are present in the rivers after rain.");
check("chunk confidence round-tripped", chunk?.["confidence"] === 0.9, String(chunk?.["confidence"]));
check("chunk with no place kept NULL", chunk?.["place_id"] === null);

const road = db.prepare("SELECT * FROM brain_road_features WHERE id = ?").get("road-1") as Record<string, unknown> | undefined;
check("road feature round-tripped", road?.["name"] === "Mossman Gorge Road" && road?.["kind"] === "track");

// --- 4. The sync cursor ----------------------------------------------------
const cursor = getSyncCursor();
check("sync cursor equals the bundle's exported_at",
  cursor === raw.exported_at, `cursor=${cursor} bundle=${raw.exported_at}`);

// --- 5. Idempotency: re-uploading the same bundle must not duplicate --------
const again = await ingestBrainBundle(raw);
check("re-upload is idempotent (INSERT OR REPLACE)",
  again.ok && again.counts.places === 3, `places=${again.counts.places}`);
check("row count unchanged after re-upload",
  (db.prepare("SELECT COUNT(*) AS n FROM brain_places").get() as { n: number }).n === 3);
// --- 6. Guards -------------------------------------------------------------
const empty = await ingestBrainBundle({ ...raw, places: [] });
check("refuses a bundle with no places (would wipe the brain)", !empty.ok, empty.message.slice(0, 60));

const stale = { ...raw, exported_at: new Date(Date.parse(raw.exported_at) - 86_400_000).toISOString() };
const staleResult = await ingestBrainBundle(stale);
check("refuses an older bundle without force", !staleResult.ok, staleResult.message.slice(0, 60));
const forced = await ingestBrainBundle(stale, { force: true });
check("loads an older bundle WITH force", forced.ok, forced.message.slice(0, 40));
await ingestBrainBundle(raw, { force: true }); // restore the newest cursor

const wrongFormat = await ingestBrainBundle({ ...raw, format: "RIPPA_BRAIN_BUNDLE_V2" });
check("refuses an unknown format tag (V2 half-understood)", !wrongFormat.ok, wrongFormat.message.slice(0, 60));

const notJson = await ingestBrainBundle("just a string");
check("refuses a non-object payload", !notJson.ok, notJson.message.slice(0, 40));

const notArray = await ingestBrainBundle({ ...raw, places: { nope: true } });
check("refuses a non-array collection", !notArray.ok, notArray.message.slice(0, 50));

// A malformed row mid-bundle must be skipped, not fatal, and must be reported.
const withBadRow = await ingestBrainBundle({
  ...raw,
  places: [...raw.places, { id: "", name: "No id" }, { id: "place-9", name: "   " }],
});
check("skips unidentifiable rows instead of aborting", withBadRow.ok && withBadRow.counts.places === 3,
  `places=${withBadRow.counts.places}`);
check("reports the skipped rows as warnings", withBadRow.warnings.length >= 2,
  `${withBadRow.warnings.length} warning(s)`);

// --- 7. Atomicity: a refused upload must leave the brain untouched ----------
const before = getBrainCounts().places;
await ingestBrainBundle({ ...raw, places: "not an array" });
check("a rejected upload changed nothing", getBrainCounts().places === before,
  `${before} -> ${getBrainCounts().places}`);

closeDeepBrain();

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
process.exit(failed.length ? 1 : 0);
}

// See the header: top-level await is unavailable in this CommonJS script.
void main();
