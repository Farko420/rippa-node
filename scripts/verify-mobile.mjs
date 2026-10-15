/**
 * MOBILE RUNTIME — platform detection, the lightweight scraping fallback, and the
 * WATERFALL's fast pass + validation.
 *
 * Not part of the shipped app. Pure in-process checks (no network, no browser,
 * no Android SDK) so they run identically on a laptop and in CI.
 *
 * Runs against `npm run build` output, which must exist first (the npm script
 * handles it) — see the note in verify-fixes.mjs about `npm run package` pruning
 * every .js out of dist/.
 */
import { pathToFileURL } from "node:url";
import path from "node:path";
import { ROOT, check, results } from "./verify-harness.mjs";

const load = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);
/** Cache-busted import, so a second read re-evaluates against the faked bridge. */
const loadAs = (rel, tag) => import(`${pathToFileURL(path.join(ROOT, rel)).href}?as=${tag}`);

const platform = await load("dist/platform.js");
const { htmlToText, extractTitle, decodeEntities, scrapeMobile } = await load(
  "dist/agent/MobileScraper.js",
);

// --- 1. Desktop: Chromium scraping must remain available --------------------
// This is the regression that would silently break the Windows .exe, so it is
// asserted explicitly rather than assumed.
check("desktop Node still supports browser scraping", platform.supportsBrowserScraping() === true);
check("desktop Node is NOT reported as mobile", platform.isMobile() === false);
check("desktop Node can spawn processes", platform.canSpawnProcesses() === true);
check("runtime flavor on desktop is 'node'", platform.runtimeFlavor() === "node");

// --- 2. Simulated Android WebView -------------------------------------------
// The bridge is injected by the native shell, so faking it is exactly what the
// real APK presents. Re-imported so no decision is cached from the probes above.
{
  const mobile = await loadAs("dist/platform.js", "webview");
  globalThis.Capacitor = { isNativePlatform: () => true, getPlatform: () => "android" };
  // Keep a reference to the real `process` before nulling it. Simulating the
  // WebView requires `process` to be absent for the duration of the block, but
  // the final `process.exit()` below runs OUTSIDE the block — so without this
  // the suite reported "28/28 checks passed" and then died with
  // "TypeError: Cannot read properties of undefined (reading 'exit')",
  // exiting non-zero on a fully green run.
  const realProcess = globalThis.process;
  globalThis.process = undefined; // no Node runtime inside a WebView

  check("Android bridge -> isAndroid() true", mobile.isAndroid() === true);
  check("Android bridge -> isMobile() true", mobile.isMobile() === true);
  check("Android bridge -> supportsBrowserScraping() FALSE", mobile.supportsBrowserScraping() === false);
  check("Android bridge -> flavor 'webview'", mobile.runtimeFlavor() === "webview");
  const caps = mobile.runtimeCapabilities();
  check("capabilities report mobile + fetch scraping", caps.isMobile === true && caps.browserScraping === false);
/*
  THE BEHAVIOURAL PROOF: a ScraperService built in this runtime must take the
  fallback and must NOT throw from its constructor. Before the guard, the
  constructor shelled out to `npx playwright install chromium` and the node
  died at boot on a tablet.
*/
let built = null;
try {
  const { ScraperService } = await loadAs("dist/agent/Scraper.js", "webview");
  built = new ScraperService();
  check("ScraperService constructs on Android without throwing", true);
  check("ScraperService reports it is NOT browser-backed", built.isBrowserBacked() === false);
} catch (error) {
  check("ScraperService constructs on Android without throwing", false, String(error.message));
}

// And it must answer using the mobile engine when asked to scrape.
if (built) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () =>
      "<html><head><title>Test Track Conditions</title></head><body><h1>Report</h1><p>Track is open.</p></body></html>",
  });
  try {
    const result = await built.scrape("https://example.test/report");
    check(
      "ScraperService.scrape() used the mobile engine on Android",
      result.title === "Test Track Conditions" && result.text.includes("Track is open"),
      `title=${result.title}`,
    );
  } catch (error) {
    check("ScraperService.scrape() used the mobile engine on Android", false, String(error.message));
  } finally {
    globalThis.fetch = originalFetch;
    await built.close().catch(() => {});
  }
}

delete globalThis.Capacitor;
globalThis.process = realProcess; // restore Node for the rest of the suite
}
// --- 3. HTML -> text extraction quality -------------------------------------
const fixture = `
<html><head><title> Lamington  NP &#8211; Conditions </title>
<style>.x{color:red}</style></head><body>
  <nav>Home About Contact</nav>
  <div class="cookie-banner">Accept cookies to continue</div>
  <script>alert('hi')</script>
  <h1>Track Report</h1>
  <p>Access is <b>open</b> to 4WD vehicles.</p>
  <p>Temperature: 18&#176;C &amp; light rain.</p>
  <footer>&copy; 2026</footer>
</body></html>`;

const text = htmlToText(fixture);
check("strips <script>", !text.includes("alert"));
check("strips <style>", !text.includes("color:red"));
check("strips <nav>", !text.includes("Home About Contact"));
check("strips cookie banner", !text.includes("Accept cookies"));
check("keeps the real content", text.includes("Track Report") && text.includes("open"));
check("keeps emphasis content", text.includes("Access is open to 4WD vehicles"));
check("decodes numeric entity (degree)", text.includes("18°C"));
check("decodes named entity (amp)", text.includes("18°C & light rain"));
check("strips <footer>", !text.includes("2026"));
check(
  "extracts and trims the title",
  extractTitle(fixture) === "Lamington NP – Conditions",
  extractTitle(fixture),
);
check("decodeEntities handles hex refs", decodeEntities("&#x2014;") === "—");
check(
  "decodeEntities leaves unknown entities alone",
  decodeEntities("&unknownthing;") === "&unknownthing;",
);

// These regexes are global, so a shared lastIndex would make the SECOND call
// silently skip matches. This is the regression the fresh-RegExp guard prevents.
const second = htmlToText("<body><script>x()</script><p>Second document</p></body>");
check("second extraction still strips (no shared lastIndex)", !second.includes("x()"));
check("second extraction keeps its own content", second.includes("Second document"));

// --- 4. Failure contract matches the desktop scraper ------------------------
{
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false,
    status: 404,
    headers: { get: () => null },
    text: async () => "",
  });
  try {
    await scrapeMobile("https://example.test/missing");
    check("non-2xx throws (matches desktop contract)", false, "no throw");
  } catch (error) {
    check("non-2xx throws (matches desktop contract)", /404/.test(String(error.message)));
  } finally {
    globalThis.fetch = originalFetch;
  }
}
{
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () => "<html><head><title>T</title></head><body></body></html>",
  });
  try {
    await scrapeMobile("https://example.test/empty");
    check("empty document throws (matches desktop contract)", false, "no throw");
  } catch (error) {
    check(
      "empty document throws (matches desktop contract)",
      /No extractable body text/.test(String(error.message)),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
}

// --- 5. WATERFALL SCRAPING — the fast pass and its validation ----------------
/*
 * The waterfall is the feature: fetch first, and escalate to a browser ONLY when
 * the response shows the fast pass did not see the page. The verdict logic is
 * pure and takes fixture HTML, so it is exercised here against a faked `fetch` —
 * no network, no browser, no Chromium download in CI. The escalation itself
 * (Playwright, navigation, teardown) is asserted at the source in verify-units.
 */
const { fastPassScrape, detectBotWall, looksLikeSpaSkeleton, countWords } = await load(
  "dist/agent/WaterfallScraper.js",
);

/** Runs `body` with `globalThis.fetch` replaced by `impl`, always restoring it. */
async function withFetch(impl, body) {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    return await body();
  } finally {
    globalThis.fetch = original;
  }
}

/** A `fetch` stub that returns one canned response. */
const serve = (status, html) => async () => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: () => null },
  text: async () => html,
});

const STATIC_PAGE = `<html><head><title>Lamington NP</title></head><body>
  <h1>Lamington National Park</h1>
  <p>${"The campground at Green Mountains is open and the waterfall track is passable after rain. ".repeat(4)}</p>
</body></html>`;

{
  const verdict = await withFetch(serve(200, STATIC_PAGE), () =>
    fastPassScrape("https://example.test/static"),
  );
  check(
    "a served static page passes the fast pass",
    verdict.ok === true,
    verdict.ok ? "" : verdict.reason,
  );
  check("...and its text is the page's text", verdict.ok && verdict.result.text.includes("Green Mountains"));
  check("...and its title is extracted", verdict.ok && verdict.result.title === "Lamington NP");
}

const CLOUDFLARE_BODY = `<html><head><title>Just a moment...</title></head><body>
  <div id="challenge-platform"><script>window.__cf_chl_opt = {};</script></div>
  <p>Checking your browser before accessing example.test.</p></body></html>`;

{
  const verdict = await withFetch(serve(403, CLOUDFLARE_BODY), () =>
    fastPassScrape("https://example.test/wall"),
  );
  check(
    "a 403 Cloudflare challenge fails the fast pass",
    verdict.ok === false && verdict.kind === "bot-wall",
    verdict.ok ? "" : verdict.reason,
  );
  check("...and it escalates to the browser", verdict.ok === false && verdict.escalate === true);
  check(
    "...and the reason names the refusal",
    verdict.ok === false && /403/.test(verdict.reason),
    verdict.ok ? "" : verdict.reason,
  );
}

{
  /*
    THE SNEAKY CASE: a 200 carrying a challenge body. Nothing in the status says
    "wall", so without the body check this document is handed to the LLM as
    though it were the page — which is how a node "successfully" learns nothing.
  */
  const verdict = await withFetch(serve(200, CLOUDFLARE_BODY), () =>
    fastPassScrape("https://example.test/wall-200"),
  );
  check(
    "a 200 carrying a challenge body still fails the fast pass",
    verdict.ok === false && verdict.kind === "bot-wall",
    verdict.ok ? "" : verdict.reason,
  );
  check(
    "...and the reason names Cloudflare",
    verdict.ok === false && /cloudflare/i.test(verdict.reason),
    verdict.ok ? "" : verdict.reason,
  );
}

{
  /*
    A BARE 403 — no challenge body to read, because the fast pass deliberately
    never downloads an error page's body. The status alone is the diagnosis.
  */
  const verdict = await withFetch(serve(403, "<html><body></body></html>"), () =>
    fastPassScrape("https://example.test/forbidden"),
  );
  check(
    "a bare 403 is diagnosed as a wall from the status alone",
    verdict.ok === false && verdict.kind === "bot-wall",
    verdict.ok ? "" : verdict.reason,
  );
  check("...and escalates", verdict.ok === false && verdict.escalate === true);
}

const SPA_SHELL = `<html><head><title>AllTrails</title>
  <script src="/_next/static/chunks/main-abc123.js" type="module"></script></head>
  <body><div id="root"></div>
  <noscript>You need to enable JavaScript to run this app.</noscript></body></html>`;

{
  const verdict = await withFetch(serve(200, SPA_SHELL), () =>
    fastPassScrape("https://example.test/spa"),
  );
  check(
    "a React shell with no server-side text fails the fast pass",
    verdict.ok === false && verdict.kind === "spa-skeleton",
    verdict.ok ? "" : verdict.reason,
  );
  check("...and escalates to the browser", verdict.ok === false && verdict.escalate === true);
}

{
  const verdict = await withFetch(serve(404, "<html><body><h1>Not found</h1></body></html>"), () =>
    fastPassScrape("https://example.test/gone"),
  );
  check("a 404 fails the fast pass", verdict.ok === false && verdict.kind === "http");
  check(
    "...but does NOT escalate (rendering a missing page cannot help)",
    verdict.ok === false && verdict.escalate === false,
  );
}

{
  /*
    THE WORD GATE IS THE ONLY RULE THAT CAN RULE A DOCUMENT IN. A long
    server-rendered page must never be escalated, however many framework markers
    it happens to carry.
  */
  const long = `<html><head><script src="/_next/static/app.js" type="module"></script></head>
    <body><div id="root">${"Track conditions are good and the campsite is open. ".repeat(20)}</div></body></html>`;
  const verdict = await withFetch(serve(200, long), () => fastPassScrape("https://example.test/ssr"));
  check("a long server-rendered page passes despite SPA markers", verdict.ok === true);
}

check(
  "detectBotWall is null on ordinary content",
  detectBotWall("<html><body><p>Trail open</p></body></html>", 200) === null,
);
check(
  "detectBotWall names a DataDome wall",
  /datadome/i.test(detectBotWall("<html>dd_cookie_test</html>", 200) ?? ""),
);
check(
  "looksLikeSpaSkeleton ignores a short but real static page",
  looksLikeSpaSkeleton(
    `<html><body><p>${"short page ".repeat(10)}</p>${"<!-- padding -->".repeat(200)}</body></html>`,
    "short page ".repeat(10),
  ) === false,
);
check("countWords counts whitespace-separated words", countWords(" one  two\nthree ") === 3);

{
  /*
    PREEMPTION IS NOT A WATERFALL TRIGGER. An abort must REJECT, never come back
    as "the fast pass failed" — that would spend a browser launch on work the
    engine just cancelled, on the exact path a PRIORITY task preempts.
  */
  const controller = new AbortController();
  controller.abort(new Error("preempted"));
  let rejected = false;
  await withFetch(serve(200, STATIC_PAGE), async () => {
    try {
      await fastPassScrape("https://example.test/aborted", controller.signal);
    } catch (error) {
      rejected = /preempted/.test(String(error.message));
    }
  });
  check("an aborted fast pass rejects instead of escalating", rejected);
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
process.exit(failed.length ? 1 : 0);