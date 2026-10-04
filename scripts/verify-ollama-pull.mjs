/*
  THE LONG PULL — regression test for "repair throws a timeout error while Ollama
  is still downloading".

  THE BUG, PRECISELY

  `OllamaClient.pullModel()` used to POST `/api/pull` with `stream: false` and an
  axios `timeout` of 15 minutes. `stream: false` tells Ollama to buffer the whole
  download and answer once, so that timeout was a hard wall-clock limit on the
  transfer itself. The generation model the hardware auto-profiler selects is
  ~4.6 GB — Ollama's own log line for it is `downloading ... in 16 292 MB part(s)`
  — which no ordinary link delivers inside 15 minutes. So axios threw
  `timeout of 900000ms exceeded` WHILE OLLAMA WAS STILL DOWNLOADING, the failure
  surfaced to the operator as a broken repair, and the bytes kept landing with
  nobody watching. Compounding it, `/api/ollama/self-heal` AWAITED that whole
  chain, so the browser held the request open and timed out on its own too.

  THE INVARIANTS UNDER TEST

  1. STREAMING. The request body must carry `stream: true`. Asserted on the SERVER
     side, against what actually arrived — asserting it in the client would only
     prove the client called a function it defines.
  2. PROGRESS IS OBSERVABLE. `onProgress` must receive real percentages, because
     that is what makes "Downloading Model…" possible instead of a bare spinner.
  3. AN ERROR FRAME IS A FAILURE. Ollama reports a broken layer INSIDE a 200
     stream, so a client that only watched for `end` would call it a success —
     confidently reporting a pull that never landed as one that did.
  4. THE STATE MACHINE IS HONEST. The generation tile must reach `ready` only when
     `/api/tags` agrees, must be observably `pulling` mid-download, and must be
     able to say `failed` with a reason.

  NO OLLAMA BINARY AND NO MODEL DOWNLOAD. Every case stands up its own fake HTTP
  server emitting the same NDJSON frames Ollama does. Costs seconds.
*/
import http from "node:http";

/** What the fake recorded for the last /api/pull request body. */
let lastPullBody = null;
/** The tag list /api/tags currently reports. */
let installedTags = [];
/** How the fake should behave on the next pull. */
let pullMode = "ok"; // "ok" | "error-frame" | "silent"
/** Frames the fake emitted on the last pull. */
let framesEmitted = 0;

const slow = (ms) => new Promise((r) => setTimeout(r, ms));

const fake = http.createServer((req, res) => {
  if (req.url === "/api/tags") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ models: installedTags.map((name) => ({ name })) }));
  }
  if (req.url === "/api/ps") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ models: [] }));
  }
  if (req.url === "/api/pull" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      try {
        lastPullBody = JSON.parse(body || "{}");
      } catch {
        lastPullBody = { __unparseable: body };
      }
      framesEmitted = 0;
      res.writeHead(200, { "Content-Type": "application/x-ndjson" });

      // An error frame delivered INSIDE a 200 stream — the shape a stream:false
      // client could not distinguish from success.
      if (pullMode === "error-frame") {
        res.write(JSON.stringify({ status: "pulling manifest" }) + "\n");
        await slow(30);
        res.write(JSON.stringify({ error: "pull model manifest: file does not exist" }) + "\n");
        framesEmitted = 2;
        return res.end();
      }
      // Opens, says one thing, then goes silent and never ends.
      if (pullMode === "silent") {
        res.write(JSON.stringify({ status: "pulling manifest" }) + "\n");
        framesEmitted = 1;
        return;
      }

      // The real thing: progress frames arriving over time. Deliberately spread
      // out so a client waiting on one buffered body cannot pass quickly, and
      // spread across many frames so percentages are observable.
      const TOTAL = 16 * 292 * 1024 * 1024; // the ~4.6 GB the bug was reported on
      const STEPS = 8;
      for (let i = 1; i <= STEPS; i += 1) {
        res.write(
          JSON.stringify({
            status: i === STEPS ? "success" : `downloading sha256:layer${i}`,
            digest: `sha256:layer${i}`,
            total: TOTAL,
            completed: Math.floor((TOTAL * i) / STEPS),
          }) + "\n",
        );
        framesEmitted += 1;
        await slow(40);
      }
      res.end();
    });
    return;
  }
  res.writeHead(404).end();
});

await new Promise((r) => fake.listen(0, "127.0.0.1", r));
// MUST be set before the imports: src/config.ts snapshots process.env at load.
process.env.OLLAMA_URL = `http://127.0.0.1:${fake.address().port}`;

const { OllamaClient } = await import("../dist/agent/OllamaClient.js");
const { ollamaManager, isExternalNetworkNoise } = await import(
  "../dist/services/ollamaManager.js"
);
const { bundledOllamaEnv } = await import("../dist/services/bundled-ollama.js");
const { recentLines } = await import("../dist/services/engineTelemetry.js");

let passed = 0, failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : ` — ${detail}`}`);
  ok ? passed++ : failed++;
};
/* ── 1. The request must actually ask Ollama to stream ─────────────────────── */
console.log("\n[LONG-PULL] the request the node sends to /api/pull");

pullMode = "ok";
const seenPercents = [];
await new OllamaClient().pullModel("qwen2.5-coder:7b", (frame) => {
  if (frame.percent !== null) seenPercents.push(frame.percent);
});

check(
  "the pull request asks Ollama to STREAM (stream: true)",
  lastPullBody?.stream === true,
  `body=${JSON.stringify(lastPullBody)}`,
);
check("the pull request names the model", lastPullBody?.model === "qwen2.5-coder:7b");

/* ── 2. Progress must be observable, or the UI cannot show anything ─────────── */
console.log("\n[LONG-PULL] progress frames reach the caller");

check(
  "every percentage was reported, not just the last one",
  seenPercents.length >= 8,
  `percents=${JSON.stringify(seenPercents)}`,
);
check(
  "the reported percentages climb to completion",
  seenPercents.length > 0 && seenPercents[seenPercents.length - 1] === 100,
  `last=${seenPercents[seenPercents.length - 1]}`,
);
check(
  "percentages are monotonically non-decreasing",
  seenPercents.every((p, i) => i === 0 || p >= seenPercents[i - 1]),
  JSON.stringify(seenPercents),
);
check(
  "a multi-frame stream was actually consumed (not one buffered body)",
  framesEmitted >= 8,
  `frames=${framesEmitted}`,
);

const terminalText = recentLines().map((l) => l.text).join("\n");
check(
  "progress reached the Live Engine Terminal",
  /downloading sha256:layer/.test(terminalText) && /100%/.test(terminalText),
  terminalText.slice(-160),
);

/* ── 3. An in-stream error must NOT be reported as success ──────────────────── */
console.log("\n[LONG-PULL] a failure inside a 200 stream is still a failure");

pullMode = "error-frame";
let errorWasThrown = null;
try {
  await new OllamaClient().pullModel("qwen2.5-coder:7b");
} catch (error) {
  errorWasThrown = error instanceof Error ? error.message : String(error);
}
check(
  "an `error` frame inside a 200 stream rejects the pull",
  errorWasThrown !== null,
  "the pull resolved — a broken download was reported as a success",
);
check(
  "the rejection carries Ollama's own reason",
  /does not exist/i.test(String(errorWasThrown)),
  String(errorWasThrown),
);

// PLACEHOLDER_BODY

/* ── 4. The generation-model state machine ─────────────────────────────────── */
console.log("\n[LONG-PULL] the generation model tile is honest");

ollamaManager.setModel("qwen2.5-coder:7b");
installedTags = [];
check(
  "an uninstalled model does NOT start out ready",
  ollamaManager.getStatus(null).modelStatus !== "ready",
  ollamaManager.getStatus(null).modelStatus,
);
check(
  "the status endpoint exposes the progress fields the UI polls",
  "modelPullPercent" in ollamaManager.getStatus(null) &&
    "repairing" in ollamaManager.getStatus(null),
);

// Drive the real pull and sample the tile WHILE it streams — this is the moment
// the operator must see "Downloading Model…" rather than a spinner.
pullMode = "ok";
const pullPromise = ollamaManager.pullGenerationModel();
await slow(140);
const during = ollamaManager.getStatus(null);
check("mid-pull the tile reads `pulling`", during.modelStatus === "pulling", during.modelStatus);
check(
  "mid-pull the tile carries a real percentage",
  typeof during.modelPullPercent === "number" && during.modelPullPercent > 0,
  String(during.modelPullPercent),
);
check(
  "mid-pull the tile carries byte counts for the operator",
  typeof during.modelPullTotal === "number" && typeof during.modelPullCompleted === "number",
  `${during.modelPullCompleted}/${during.modelPullTotal}`,
);

const result = await pullPromise;
check("a completed pull reports success", result.ok, result.message);

// Ollama only lists the model once its layers are actually on disk.
installedTags = ["qwen2.5-coder:7b"];
const after = ollamaManager.getStatus(null);
check("the tile settles on `ready`", after.modelStatus === "ready", after.modelStatus);
check("`modelReady` mirrors it", after.modelReady === true);

/* ── 5. A pull that fails must be able to say so ────────────────────────────── */
console.log("\n[LONG-PULL] a failing download says `failed`, with a reason");

// A different model name, so the ready short-circuit does not apply.
ollamaManager.setModel("llama3:8b");
installedTags = [];
pullMode = "error-frame";
const brokenPull = await ollamaManager.pullGenerationModel();
const failedStatus = ollamaManager.getStatus(null);
check("a broken pull reports failure", brokenPull.ok === false, brokenPull.message);
check("the tile reads `failed`", failedStatus.modelStatus === "failed", failedStatus.modelStatus);
check(
  "the tile keeps Ollama's reason for the tooltip",
  typeof failedStatus.modelError === "string" && failedStatus.modelError.length > 0,
  String(failedStatus.modelError),
);
check(
  "a failed tile clears stale progress instead of freezing it at 100%",
  failedStatus.modelPullPercent === null,
  String(failedStatus.modelPullPercent),
);

/* ── 6. The reconcile is what makes `ready` trustworthy ─────────────────────── */
console.log("\n[LONG-PULL] /api/tags is the source of truth");

ollamaManager.setModel("mistral:7b");
installedTags = [];
check(
  "an absent model is not reported installed",
  (await ollamaManager.reconcileGeneration()) === false,
);
installedTags = ["mistral:7b:latest"]; // the :latest suffix Ollama adds
check(
  "the :latest suffix still reconciles as installed",
  (await ollamaManager.reconcileGeneration()) === true,
);

// Changing the model must NOT inherit the previous model's `ready` — that would
// tell the dashboard a model is installed when it has never been downloaded.
ollamaManager.setModel("never-downloaded:70b");
check(
  "switching models resets the tile rather than inheriting `ready`",
  ollamaManager.getStatus(null).modelStatus === "idle",
  ollamaManager.getStatus(null).modelStatus,
);

/* ── 7. Cloud-cache noise must not be presented as a local fault ────────────── */
console.log("\n[LONG-PULL] external cloud-cache noise is suppressed");

check(
  "the managed child is told not to phone home to ollama.com",
  bundledOllamaEnv().OLLAMA_NO_CLOUD === "1",
  JSON.stringify(bundledOllamaEnv()),
);

const noisy = [
  "model show cloud cache hydration failed: i/o timeout",
  "model show cloud cache hydration: context deadline exceeded",
];
const realFaults = [
  "loading model: out of memory",
  "listen tcp 127.0.0.1:11435: bind: address already in use",
  "pull model manifest: file does not exist",
  "llama-server exited unexpectedly",
];
check(
  "the reported cloud-cache line is recognised as external noise",
  noisy.every((line) => isExternalNetworkNoise(line)),
  noisy.filter((l) => !isExternalNetworkNoise(l)).join(" | "),
);
check(
  "genuine local faults are NEVER suppressed",
  realFaults.every((line) => !isExternalNetworkNoise(line)),
  realFaults.filter((l) => isExternalNetworkNoise(l)).join(" | "),
);

fake.close();
console.log(`\n[LONG-PULL] ${passed}/${passed + failed} checks passed.`);
process.exit(failed ? 1 : 0);