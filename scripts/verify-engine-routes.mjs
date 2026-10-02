/**
 * THE NEW CONTROL-CENTER ROUTES, over real HTTP against a really-booted node.
 * Not part of the shipped app. Uses the same harness as verify-fixes.mjs.
 */
import { PORT, check, login, makeConfigRoot, spawnNode, waitForServer, results } from "./verify-harness.mjs";

const configRoot = makeConfigRoot();
const child = spawnNode(configRoot);
const base = `http://127.0.0.1:${PORT}`;
const withTimeout = (promise, ms) =>
  Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), ms))]);

/** Opens the SSE stream and returns the text up to and including the hello frame. */
async function readBacklog(signal) {
  const res = await fetch(`${base}/api/engine/stream`, { headers: { Cookie: cookie }, signal });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let seen = "";
  while (!seen.includes("hello")) {
    const { value, done } = await reader.read();
    if (done) break;
    seen += decoder.decode(value, { stream: true });
  }
  return seen;
}

let cookie = "";
try {
  const up = await waitForServer();
  check("node boots", up);
  if (!up) throw new Error("node did not boot");

  cookie = await login();
  check("dashboard login works", Boolean(cookie));

  // --- AUTH: every new route must be PIN-gated like the rest -------------------
  const anon = async (path, init) => (await fetch(`${base}${path}`, init)).status;
  check("/api/engine/health refuses an anonymous caller", (await anon("/api/engine/health")) === 401);
  check("/api/engine/exec refuses an anonymous caller",
    (await anon("/api/engine/exec", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: "ollama ps" }),
    })) === 401);

  // --- GET /api/engine/health -------------------------------------------------
  const healthRes = await fetch(`${base}/api/engine/health`, { headers: { Cookie: cookie } });
  const reading = await healthRes.json();
  check("health is 200 for an authenticated caller", healthRes.status === 200, String(healthRes.status));
  check("health reports a real state",
    ["ready", "busy", "pulling", "offline"].includes(reading.state), reading.state);
  check("health carries the shape the badge renders",
    typeof reading.detail === "string" && Array.isArray(reading.installedModels) &&
    Array.isArray(reading.loadedModels) && "modelLoaded" in reading && "latencyMs" in reading,
    JSON.stringify(Object.keys(reading)));

  // --- POST /api/engine/exec --------------------------------------------------
  const exec = async (command) => {
    const res = await fetch(`${base}/api/engine/exec`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ command }),
    });
    return { status: res.status, body: await res.json() };
  };

  const help = await exec("help");
  check("exec runs `help`", help.status === 200 && help.body.success === true, JSON.stringify(help.body));
  check("`help` reports the command count", /commands available/.test(help.body.message), help.body.message);
  check("exec rejects an empty command", (await exec("")).status === 400);
  const locked = await exec("ollama restart");
  check("exec refuses `ollama restart` while the padlock is locked",
    locked.body.success === false && /Locked/.test(locked.body.message), JSON.stringify(locked.body));
  check("exec refuses a traversal argument",
    (await exec("ollama pull ../../etc/passwd")).body.success === false);
  const unknown = await exec("rm -rf /");
  check("exec refuses an unknown command", unknown.body.success === false);
  check("exec never 500s on a bad command", unknown.status === 200, String(unknown.status));
// --- GET /api/engine/stream (SSE) -------------------------------------------
  const controller = new AbortController();
  let contentType = "";
  let seen = "";
  await withTimeout((async () => {
    const res = await fetch(`${base}/api/engine/stream`, {
      headers: { Cookie: cookie },
      signal: controller.signal,
    });
    contentType = res.headers.get("content-type") ?? "";
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    while (!seen.includes("hello")) {
      const { value, done } = await reader.read();
      if (done) break;
      seen += decoder.decode(value, { stream: true });
    }
  })(), 15_000).catch((error) => check("the engine stream opened", false, error.message));
  controller.abort();

  check("the stream is text/event-stream", contentType.includes("text/event-stream"), contentType);
  // The backlog frame is what makes a dashboard that opens MID-SESSION paint
  // itself. Without it the terminal is blank until something happens next.
  check("the stream opens with a backlog (hello) frame", seen.includes("hello"), seen.slice(0, 120));
  let backlog = null;
  try {
    backlog = JSON.parse(/data: (\{"type":"hello".*)/.exec(seen)?.[1] ?? "null");
  } catch {
    /* reported by the next check */
  }
  check("the backlog frame parses as JSON", backlog !== null);
  check("the backlog carries the arrays the UI repaints from",
    Array.isArray(backlog?.lines) && Array.isArray(backlog?.scrapes),
    JSON.stringify(Object.keys(backlog ?? {})));
  check("the backlog carries a health reading (or null before the first probe)",
    backlog?.health === null || typeof backlog?.health?.state === "string");

  // --- the terminal reflects what the CLI just did ----------------------------
  const controller2 = new AbortController();
  const replay = await withTimeout(readBacklog(controller2.signal), 10_000).catch(() => "");
  controller2.abort();
  check("the commands run above are echoed into the terminal backlog",
    replay.includes("$ help"), replay.slice(0, 240));
  check("a refused command appears in the terminal too",
    replay.includes("Locked") || replay.includes("$ ollama restart"), replay.slice(0, 400));
} finally {
  child.kill();
}

const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} checks passed.`);
process.exit(failed ? 1 : 0);