/**
 * MOBILE RUNTIME — platform detection + the lightweight scraping fallback.
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

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
process.exit(failed.length ? 1 : 0);