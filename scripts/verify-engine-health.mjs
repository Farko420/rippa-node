/*
  Exercises the REAL ollamaManager.probeHealth() against a fake Ollama, covering
  every badge state. env.OLLAMA_URL is set before the import because src/config
  snapshots process.env at module load.
*/
import http from "node:http";

let psRows = [{ name: "qwen2.5:1.5b", size_vram: 1 }];
let tagsReachable = true;
/** Ollama has used both envelopes for /api/ps across versions; both must parse. */
let psEnvelope = "models";
const fake = http.createServer((req, res) => {
  if (!tagsReachable) return res.writeHead(503).end("nope");
  if (req.url === "/api/ps") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify(psEnvelope === "models" ? { models: psRows } : { data: psRows }));
  }
  if (req.url === "/api/tags") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ models: [{ name: "qwen2.5:1.5b" }] }));
  }
  res.writeHead(404).end();
});
await new Promise((r) => fake.listen(0, "127.0.0.1", r));
process.env.OLLAMA_URL = `http://127.0.0.1:${fake.address().port}`;

const { ollamaManager } = await import("../dist/services/ollamaManager.js");
const {
  noteEngineActivity, clearEngineActivity, publishScrape, recentScrapes,
} = await import("../dist/services/engineTelemetry.js");

let passed = 0, failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : ` — ${detail}`}`);
  ok ? passed++ : failed++;
};

console.log("\n[ENGINE-HEALTH] readiness probe behind the status dot");

const ready = await ollamaManager.probeHealth();
check("an answering server with a resident model is READY", ready.state === "ready", ready.state);
check("it reports the HTTP status it actually saw", ready.httpStatus === 200, String(ready.httpStatus));
check("it measures a ping latency", typeof ready.latencyMs === "number" && ready.latencyMs >= 0);
check("it reports the resident model", ready.modelLoaded === true && ready.loadedModels[0] === "qwen2.5:1.5b");
check("it lists installed models too", ready.installedModels.includes("qwen2.5:1.5b"));

// THE REGRESSION THIS SUITE WAS WRITTEN FOR. An older Ollama answers /api/ps with
// {"data":[…]}; a probe that only reads `models` reports zero models on a node with
// a 7B resident — a confident wrong answer from a health indicator.
psEnvelope = "data";
const legacy = await ollamaManager.probeHealth();
check("the legacy data envelope still reports the model",
  legacy.modelLoaded === true && legacy.loadedModels[0] === "qwen2.5:1.5b",
  JSON.stringify(legacy.loadedModels));
psEnvelope = "models";

psRows = [];
const idle = await ollamaManager.probeHealth();
check("no resident model is STILL ready (weights unload between jobs)", idle.state === "ready", idle.state);
check("but it is reported honestly as not loaded", idle.modelLoaded === false);
check("and the detail line says so", /no model resident/i.test(idle.detail), idle.detail);

noteEngineActivity("busy", "qwen2.5:1.5b");
const busy = await ollamaManager.probeHealth();
check("an active inference reads BUSY", busy.state === "busy", busy.state);
check("the busy detail names the model", busy.detail.includes("qwen2.5:1.5b"), busy.detail);

noteEngineActivity("pulling", "qwen2.5-coder:7b");
const pulling = await ollamaManager.probeHealth();
check("an active pull reads PULLING", pulling.state === "pulling", pulling.state);
check("the pulling detail names the model", pulling.detail.includes("qwen2.5-coder:7b"));
clearEngineActivity();

tagsReachable = false;
const offline = await ollamaManager.probeHealth();
check("an unreachable port reads OFFLINE", offline.state === "offline", offline.state);
check("offline reports no HTTP status at all", offline.httpStatus === null);
check("offline says WHICH port failed", offline.detail.includes(String(fake.address().port)), offline.detail);

fake.close();
process.env.OLLAMA_URL = "http://127.0.0.1:1";
const dead = await ollamaManager.probeHealth();
check("a closed port reads OFFLINE without throwing", dead.state === "offline", dead.state);

console.log("\n[ENGINE-HEALTH] crawl stream wording");
for (const [kind, message] of [
  ["navigate", "[NAVIGATE] https://x.test"],
  ["status", "[STATUS 200]"],
  ["extract", "[EXTRACT] 1,234 chars · 4 place candidates"],
]) publishScrape(kind, message, "https://x.test");
const rendered = recentScrapes().map((e) => e.message).join(" | ");
check("navigate/status/extract are all reported", /NAVIGATE/.test(rendered) && /STATUS 200/.test(rendered) && /EXTRACT/.test(rendered), rendered);
check("the extraction line carries the candidate count", /4 place candidates/.test(rendered));

console.log(`\n[ENGINE-HEALTH] ${passed}/${passed + failed} checks passed.`);
process.exit(failed ? 1 : 0);