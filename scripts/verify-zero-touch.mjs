import http from "node:http";
import net from "node:net";
import { check, results } from "./verify-harness.mjs";

/**
 * ZERO-TOUCH OLLAMA WATCHDOG — regression tests for the epic.
 *
 * Covers, without spawning a real Ollama or downloading anything:
 *  1. Dynamic port claims win over the static override in the resolver.
 *  2. Invalid claims are refused (resolver falls back, never binds garbage).
 *  3. `bundledOllamaOrigin(port)` honours an explicit healed port.
 *  4. `publishManagedOllamaOrigin(healed)` reaches the LIVE env object.
 *  5. Watchdog helpers: occupied-port detection, ephemeral claims, healed
 *     resolution, host-binary probing (pure), and the opt-out flag.
 *  6. `runLocalInference` routes at the live port and posts the result shape
 *     the orchestrator's `ai_inference` handler files upstream.
 */

const load = (rel) => import(`file://${process.cwd().replace(/\\/g, "/")}/${rel}?v=${Date.now()}`);


const bundled = await load("dist/services/bundled-ollama.js");
const { ollamaManager, publishManagedOllamaOrigin, runLocalInference } = await load(
  "dist/services/ollamaManager.js",
);
const watchdog = await load("dist/services/ollamaWatchdog.js");
const { env } = await import(`file://${process.cwd().replace(/\\/g, "/")}/dist/config.js?v=${Date.now()}`);

let passed = 0;
let failed = 0;
const t = (name, ok, detail = "") => {
  if (ok) passed += 1;
  else failed += 1;
  check(name, ok, detail);
};

const freePort = () =>
  new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref?.();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const a = s.address();
      const p = typeof a === "object" && a ? a.port : 0;
      s.close(() => resolve(p));
    });
  });

/* 1. Dynamic claim wins */
bundled.clearDynamicOllamaPort();
const claim = await freePort();
bundled.setDynamicOllamaPort(claim);
t("dynamic claim wins over the static override", bundled.resolveBundledOllamaPort() === claim);
t("getter returns the claim", bundled.getDynamicOllamaPort() === claim);

/* 2. Invalid claims refused */
bundled.setDynamicOllamaPort(-1);
t("negative claim refused", bundled.getDynamicOllamaPort() === claim);
bundled.setDynamicOllamaPort(99999);
t("out-of-range claim refused", bundled.getDynamicOllamaPort() === claim);
bundled.clearDynamicOllamaPort();
t("clear drops the claim", bundled.getDynamicOllamaPort() === null);

/* 3. Explicit origin */
const healedPort = await freePort();
t(
  "bundledOllamaOrigin(port) honours the healed port",
  bundled.bundledOllamaOrigin(healedPort) === `http://127.0.0.1:${healedPort}`,
);

/* 4. Publish reaches the LIVE env */
bundled.setDynamicOllamaPort(healedPort);
publishManagedOllamaOrigin(healedPort);
t(
  "live env resolves to the healed origin",
  env.OLLAMA_URL === `http://127.0.0.1:${healedPort}`,
  String(env.OLLAMA_URL),
);
t("getPort() agrees (heartbeat reports the bound port)", ollamaManager.getPort() === healedPort);

/* 5. Watchdog helpers */
t("zero-touch enabled by default", watchdog.isZeroTouchEnabled() === true);
process.env.RIPPA_ZERO_TOUCH_OLLAMA = "0";
t("opt-out flag disables it", watchdog.isZeroTouchEnabled() === false);
delete process.env.RIPPA_ZERO_TOUCH_OLLAMA;

const blocker = net.createServer();
await new Promise((r) => blocker.listen(0, "127.0.0.1", r));
const blockedPort = blocker.address().port;
t("occupied port detected", (await watchdog.isPortOccupied(blockedPort)) === true);
const emptyPort = await freePort();
t("free port detected as free", (await watchdog.isPortOccupied(emptyPort)) === false);
const kept = await watchdog.resolveHealedPort(emptyPort);
t("free preferred port needs no healing", kept.port === emptyPort && kept.healed === false);
const moved = await watchdog.resolveHealedPort(blockedPort);
t("occupied preferred port heals away", moved.port !== blockedPort && moved.healed === true);
t("healed port is actually free", (await watchdog.isPortOccupied(moved.port)) === false);
blocker.close();
t("host binary probe returns string-or-null", (() => {
  const found = watchdog.findHostOllamaBinary();
  return found === null || (typeof found === "string" && found.length > 0);
})());
t("installer info names an official URL", /ollama\.com/.test(watchdog.getOfficialInstallerInfo().url));
const plan = await watchdog.planZeroTouchOllama(emptyPort);
t("plan picks the free preferred port", plan.port === emptyPort, String(plan.port));
t("plan names the required model family", /qwen/i.test(plan.model), plan.model);

/* 6. runLocalInference routes at the live port */
const fake = http.createServer((req, res) => {
  if (req.url === "/api/tags") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ models: [{ name: "qwen2.5-coder:7b" }] }));
  }
  if (req.url === "/api/generate" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    return req.on("end", () => {
      const parsed = JSON.parse(body || "{}");
      if (parsed.stream !== false) {
        res.writeHead(400);
        return res.end("expected stream:false");
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ response: `echo: ${parsed.prompt}`, eval_count: 3 }));
    });
  }
  res.writeHead(404);
  res.end();
});
await new Promise((r) => fake.listen(0, "127.0.0.1", r));
const inferPort = fake.address().port;
bundled.setDynamicOllamaPort(inferPort);
publishManagedOllamaOrigin(inferPort);
const out = await runLocalInference({ prompt: "hello" });
t("inference returns the model text", out.text === "echo: hello", out.text);
t("inference reports the live port", out.port === inferPort, String(out.port));
t("inference names the model used", typeof out.model === "string" && out.model.length > 0, out.model);
let emptyFailed = false;
try {
  await runLocalInference({ prompt: "   " });
} catch {
  emptyFailed = true;
}
t("empty prompt is rejected, not sent", emptyFailed);
fake.close();

bundled.clearDynamicOllamaPort();

console.log(`\n[ZERO-TOUCH] ${passed}/${passed + failed} checks passed.`);
const failures = results.filter((r) => !r.pass);
if (failures.length) for (const f of failures) console.log(`  FAIL ${f.name}${f.detail ? ` — ${f.detail}` : ""}`);
process.exit(failures.length ? 1 : 0);
