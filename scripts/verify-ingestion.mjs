/**
 * THE INGESTION ENGINE'S THREE-LAYER CLEANUP GUARANTEE.
 *
 * Asserts the disk-hoarding fixes end to end, against the REAL filesystem:
 *
 *   1. TEMP DIRECTORY ISOLATION — every task gets its own `os.tmpdir()` child,
 *      sanitised so a hostile task id cannot escape the temp root.
 *   2. SUCCESS STATE — the moment the draft JSON POST succeeds, the ZIPs,
 *      extracted photos and PDFs are gone (proven by observing the filesystem
 *      from inside the completion report, which runs AFTER the POST).
 *   3. FAILURE STATE — an Ollama crash or a Mothership POST failure still
 *      leaves nothing behind (`try/finally` inside `withTaskWorkspace`).
 *   4. CRASH STATE — the stale sweep deletes orphaned workspaces and only
 *      those: fresh ones and foreign directories are untouched.
 *
 * The default download stage is also exercised for real against a local HTTP
 * server serving a PDF and an HTML page, so the text-extraction → model → POST
 * chain is proven, not mocked.
 *
 * Run with: npm run test:ingestion
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { pathToFileURL } from "node:url";
import { ROOT, check, results } from "./verify-harness.mjs";

const load = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);
const ing = await load("dist/services/ingestionEngine.js");

/** The fact every stubbed model call returns. */
const FACT = {
  category: "rule",
  fact_summary: "Fire bans apply in Lamington National Park.",
  confidence_score: 0.9,
  coordinates: null,
};

/** A well-formed fleet task; override per scenario. */
const task = (over = {}) => ({
  id: "task-verify-1",
  kind: "pdf_extract",
  url: "https://r2.example.invalid/payload.zip",
  focus: "park rules",
  maxFacts: 5,
  attempts: 1,
  ...over,
});

/** Directories currently parked in the temp root with our prefix. */
const ourWorkspaces = () =>
  fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith(ing.INGEST_WORKSPACE_PREFIX));

// --- 1. TEMP DIRECTORY ISOLATION ---------------------------------------------

check(
  "every call yields a uniquely named workspace (os.tmpdir + task id + suffix)",
  ing.taskWorkspaceDir("task-1") !== ing.taskWorkspaceDir("task-1"),
);
const hostile = ing.taskWorkspaceDir("../../evil.exe");
check(
  "a traversal task id stays inside os.tmpdir() with no '..' left",
  hostile.startsWith(os.tmpdir()) && !hostile.includes(".."),
  hostile,
);
check(
  "workspaces carry the sweep's prefix",
  path.basename(hostile).startsWith(ing.INGEST_WORKSPACE_PREFIX),
  path.basename(hostile),
);

// --- 2. THE try/finally PRIMITIVE (withTaskWorkspace) -------------------------

let ranInDir = null;
let existedDuringBody = false;
let threw = null;
try {
  await ing.withTaskWorkspace("wf-throw", async (dir) => {
    ranInDir = dir;
    existedDuringBody = fs.existsSync(dir);
    fs.writeFileSync(path.join(dir, "map.pdf"), "%PDF-fake bytes");
    throw new Error("boom");
  });
} catch (error) {
  threw = error;
}
check("the body runs inside a freshly created workspace", existedDuringBody === true);
check("the body's error is rethrown, not swallowed", threw?.message === "boom");
check(
  "FAILURE STATE: the workspace is deleted even when the body throws",
  ranInDir !== null && !fs.existsSync(ranInDir),
  ranInDir,
);

const okDir = await ing.withTaskWorkspace("wf-ok", async (dir) => {
  fs.writeFileSync(path.join(dir, "payload.zip"), Buffer.alloc(16));
  return dir;
});
check("SUCCESS STATE: a clean body's workspace is gone on return", !fs.existsSync(okDir), okDir);

// --- 3. THE ENGINE'S THREE OUTCOMES ------------------------------------------

/**
 * A recording engine: real workspace/filesystem, fake network and model.
 * `collectText` writes the heavyweight artefacts (ZIP, photo, PDF) so every
 * cleanup assertion below is about actual bytes on actual disk.
 */
function harness(options = {}) {
  const rec = { drafts: [], completions: [], workspace: null, existsAtComplete: [] };
  const deps = {
    swarm: {
      fetchFleetTask: async () => null,
      ingestBrainFacts: async (payload) => {
        rec.drafts.push(payload);
        return true;
      },
      completeFleetTask: async (result) => {
        rec.completions.push(result);
        rec.existsAtComplete.push(rec.workspace ? fs.existsSync(rec.workspace) : null);
        return true;
      },
    },
    ollama: { extractFacts: options.extract ?? (async () => FACT) },
  };
  if (!options.useRealCollect) {
    deps.collectText = async (_task, dir) => {
      rec.workspace = dir;
      fs.mkdirSync(path.join(dir, "photos"), { recursive: true });
      fs.writeFileSync(path.join(dir, "payload.zip"), Buffer.alloc(4096));
      fs.writeFileSync(path.join(dir, "photos", "IMG_001.jpg"), Buffer.alloc(2048));
      fs.writeFileSync(path.join(dir, "map.pdf"), "%PDF-1.4 fake map");
      return "Fire bans apply in Lamington National Park. Camping is allowed in designated areas only.";
    };
  }
  return { engine: new ing.IngestionEngine(deps), deps, rec };
}

// A. SUCCESS — the exact-moment guarantee.
const a = harness();
const resA = await a.engine.runTask(task());
check(
  "SUCCESS: the draft POST carried the extracted facts",
  a.rec.drafts.length === 1 && a.rec.drafts[0].facts[0]?.fact_summary === FACT.fact_summary,
  JSON.stringify(a.rec.drafts[0] ?? null),
);
check(
  "SUCCESS: the task reports ok with the fact count",
  resA.ok === true && resA.facts === 1 && a.rec.completions[0]?.ok === true,
  JSON.stringify(resA),
);
check(
  "SUCCESS: the workspace is already gone when the completion report runs (wiped at POST moment)",
  a.rec.existsAtComplete[0] === false,
  `exists=${a.rec.existsAtComplete[0]}`,
);
check(
  "SUCCESS: no trace of the ZIP, photo directory or PDF remains",
  a.rec.workspace !== null && !fs.existsSync(a.rec.workspace),
  a.rec.workspace ?? "",
);

// B. OLLAMA CRASH — the model process dies mid-extraction.
const b = harness({
  extract: async () => {
    throw new Error("ECONNREFUSED 127.0.0.1:11434 (ollama died)");
  },
});
const resB = await b.engine.runTask(task({ id: "task-ollama-crash" }));
check(
  "OLLAMA CRASH: the failure is reported with the real cause",
  resB.ok === false && /ECONNREFUSED/.test(resB.detail),
  resB.detail,
);
check("OLLAMA CRASH: no draft is POSTed", b.rec.drafts.length === 0);
check(
  "OLLAMA CRASH: the finally deletes the workspace",
  b.rec.workspace !== null && !fs.existsSync(b.rec.workspace),
  b.rec.workspace ?? "",
);

// C. MODEL ANSWERS NOTHING (the other shape of a dead local AI).
const c = harness({ extract: async () => null });
const resC = await c.engine.runTask(task({ id: "task-model-null" }));
check(
  "MODEL SILENT: zero facts fails the task instead of POSTing an empty draft",
  resC.ok === false && c.rec.drafts.length === 0 && /no facts/.test(resC.detail),
  resC.detail,
);
check(
  "MODEL SILENT: the finally deletes the workspace",
  c.rec.workspace !== null && !fs.existsSync(c.rec.workspace),
);

// D. MOTHERSHIP REJECTS THE DRAFT POST (returns false).
const d = harness();
d.deps.swarm.ingestBrainFacts = async (payload) => {
  d.rec.drafts.push(payload);
  return false;
};
const resD = await d.engine.runTask(task({ id: "task-post-refused" }));
check(
  "POST REFUSED: reported as a failure with the Mothership's answer in the detail",
  resD.ok === false && /did not accept/.test(resD.detail),
  resD.detail,
);
check(
  "POST REFUSED: the finally deletes the workspace",
  d.rec.workspace !== null && !fs.existsSync(d.rec.workspace),
);

// E. MOTHERSHIP POST THROWS (transport failure).
const e = harness();
e.deps.swarm.ingestBrainFacts = async (payload) => {
  e.rec.drafts.push(payload);
  throw new Error("socket hang up");
};
const resE = await e.engine.runTask(task({ id: "task-post-throw" }));
check(
  "POST THROWS: the error surfaces in the completion detail",
  resE.ok === false && /socket hang up/.test(resE.detail),
  resE.detail,
);
check(
  "POST THROWS: the finally deletes the workspace",
  e.rec.workspace !== null && !fs.existsSync(e.rec.workspace),
);

// F. AN IDLE QUEUE claims nothing and creates nothing.
const f = harness();
const before = ourWorkspaces().length;
await f.engine.runOnce();
check(
  "an empty queue creates no workspace",
  ourWorkspaces().length === before && f.rec.workspace === null,
);

// --- 4. CRASH-STATE SWEEP -----------------------------------------------------

const stamp = Date.now().toString(36);
const staleDir = path.join(os.tmpdir(), `${ing.INGEST_WORKSPACE_PREFIX}stale-${stamp}`);
const freshDir = path.join(os.tmpdir(), `${ing.INGEST_WORKSPACE_PREFIX}fresh-${stamp}`);
const foreignDir = path.join(os.tmpdir(), `not-rippa-ingest-${stamp}`);
for (const dir of [staleDir, freshDir, foreignDir]) fs.mkdirSync(dir, { recursive: true });
const longAgo = new Date(Date.now() - 3 * 60 * 60_000);
fs.utimesSync(staleDir, longAgo, longAgo);
const swept = await ing.sweepStaleWorkspaces();
check("CRASH STATE: an orphaned (3h old) workspace is swept", !fs.existsSync(staleDir));
check("CRASH STATE: a fresh workspace is left strictly alone", fs.existsSync(freshDir));
check("CRASH STATE: a foreign directory with a similar name is untouched", fs.existsSync(foreignDir));
check("the sweep reports how many orphans it removed", swept >= 1, String(swept));
fs.rmSync(freshDir, { recursive: true, force: true });
fs.rmSync(foreignDir, { recursive: true, force: true });

// --- 5. PDF TEXT EXTRACTION (no library — the engine's own reader) ------------

const rawPdf = Buffer.from(
  "%PDF-1.4\n1 0 obj << /Length 58 >> stream\n" +
    "BT (Fire bans apply in Lamington National Park.) Tj ET\n" +
    "endstream\nendobj\n%%EOF",
  "latin1",
);
check(
  "an uncompressed PDF content stream yields its text",
  ing.extractPdfText(rawPdf).includes("Fire bans apply in Lamington National Park"),
  ing.extractPdfText(rawPdf),
);
const deflated = zlib.deflateSync(
  Buffer.from("BT (Camping allowed only in designated areas.) Tj ET", "latin1"),
);
const flatePdf = Buffer.concat([
  Buffer.from("%PDF-1.4\nstream\n", "latin1"),
  deflated,
  Buffer.from("\nendstream\n%%EOF", "latin1"),
]);
check(
  "a FlateDecode (compressed) content stream yields its text",
  ing.extractPdfText(flatePdf).includes("Camping allowed only in designated areas"),
  ing.extractPdfText(flatePdf),
);
const escaped = Buffer.from(
  "stream\nBT (Cafe open 24/7 \\(seasonal\\)) Tj ET\nendstream",
  "latin1",
);
check(
  "escaped parentheses inside a PDF string are decoded",
  ing.extractPdfText(escaped).includes("Cafe open 24/7 (seasonal)"),
  ing.extractPdfText(escaped),
);
check(
  "a scanned/image-only PDF yields no text rather than garbage",
  ing.extractPdfText(Buffer.from("%PDF-1.4\nno operators at all here")) === "",
);

// --- 6. THE REAL DOWNLOAD STAGE (local HTTP server, no mocks) -----------------

const PDF_BODY = Buffer.from(
  "%PDF-1.4\n1 0 obj << /Length 58 >> stream\n" +
    "BT (Fire bans apply in Lamington National Park.) Tj ET\n" +
    "endstream\nendobj\n%%EOF",
  "latin1",
);
const PAGE =
  "<html><head><style>body{color:red}</style></head><body><h1>Track report</h1>" +
  "<p>Creek crossing is 0.8 metres deep after rain.</p><script>evil()</script></body></html>";

const server = http.createServer((req, res) => {
  if (req.url === "/maps/park-rules.pdf") {
    res.writeHead(200, { "content-type": "application/pdf" });
    res.end(PDF_BODY);
  } else if (req.url === "/pages/track.html") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(PAGE);
  } else {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;

// PDF: downloaded INTO the workspace → text extracted → model fed → draft
// POSTed → workspace wiped. The model input assertion proves the real bytes
// made it through every stage, not just that no error was thrown.
let pdfModelInput = "";
const g = harness({
  useRealCollect: true,
  extract: async (text) => {
    pdfModelInput = text;
    return FACT;
  },
});
const resG = await g.engine.runTask(
  task({ id: "task-pdf-real", url: `${base}/maps/park-rules.pdf` }),
);
check(
  "REAL PDF: the extracted text reached the model",
  /Fire bans apply in Lamington National Park/.test(pdfModelInput),
  pdfModelInput.slice(0, 120),
);
check(
  "REAL PDF: the task completed with its facts POSTed",
  resG.ok === true && resG.facts === 1 && g.rec.drafts.length === 1,
  JSON.stringify(resG),
);
check(
  "REAL PDF: no workspace remains on disk afterwards",
  ourWorkspaces().filter((n) => n.includes("task-pdf-real")).length === 0,
);

// HTML: read in memory (never written to disk), still the full chain, with
// markup stripped before the model sees it.
let htmlModelInput = "";
const h = harness({
  useRealCollect: true,
  extract: async (text) => {
    htmlModelInput = text;
    return FACT;
  },
});
const resH = await h.engine.runTask(
  task({ id: "task-html-real", kind: "page_digest", url: `${base}/pages/track.html` }),
);
check(
  "REAL HTML: body text extracted and markup stripped",
  /Creek crossing is 0.8 metres deep after rain/.test(htmlModelInput) &&
    !/<script|<p>/i.test(htmlModelInput),
  htmlModelInput.slice(0, 160),
);
check(
  "REAL HTML: the task completed and left nothing behind",
  resH.ok === true && ourWorkspaces().filter((n) => n.includes("task-html-real")).length === 0,
);

// A missing payload (404) fails the task AND cleans the workspace it created.
const i = harness({ useRealCollect: true });
const resI = await i.engine.runTask(task({ id: "task-404", url: `${base}/missing.bin` }));
check("REAL 404: reported as a failure with the HTTP cause", resI.ok === false, resI.detail);
check(
  "REAL 404: no workspace remains after the failed download",
  ourWorkspaces().filter((n) => n.includes("task-404")).length === 0,
);

server.closeAllConnections?.();
await new Promise((resolve) => server.close(resolve));

// --- SUMMARY ------------------------------------------------------------------

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
process.exit(failed.length ? 1 : 0);
