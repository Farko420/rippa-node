/**
 * WATERFALL SCRAPING — the fast pass, and the verdict that decides when to
 * escalate to a real browser.
 *
 * WHY THIS EXISTS. A large share of the sources this node forages — park
 * authorities, trail reports, campground pages — are static HTML: a plain HTTP
 * GET returns the whole document, and driving Chromium to read it costs a
 * browser launch, a renderer process and ~150MB of RAM. But an increasing share
 * are JavaScript applications — AllTrails, interactive park maps, anything
 * behind a bot wall — where the served HTML is an empty shell and the content
 * only exists once the page's own scripts have run. One engine cannot serve both
 * well, so the node runs a WATERFALL:
 *
 *   STEP 1  FAST PASS — `fetch`, the same lightweight engine as the mobile
 *           scraper (`MobileScraper.fetchPage`). Cheap, no browser, no renderer.
 *   STEP 2  VALIDATION — inspect what came back. A 403/Cloudflare challenge, a
 *           React/Next shell with no server-rendered text, or an empty body all
 *           mean the fast pass did NOT see the page, so its result is discarded
 *           rather than fed to the LLM as if it were the page.
 *   STEP 3  FALLBACK — drive headless Chromium, wait for the network to go idle,
 *           and read `document.body.innerText`. That lives in
 *           `ScraperService.scrape`; this module only decides that it is needed
 *           and hands over the reason.
 *
 * WHY PLAYWRIGHT AND NOT `puppeteer-core`. The brief allowed "or a similar
 * lightweight headless browser controller". Playwright is already this node's
 * browser engine, and every genuinely hard part of driving a browser on an
 * operator's own desktop is already solved around it: `agent/browserInstaller`
 * downloads Chromium IN-PROCESS (which matters inside the `pkg`-frozen exe,
 * where there is no `npx` to shell out to), `PLAYWRIGHT_BROWSERS_PATH` is already
 * redirected into the node's own data directory, and `package.json`'s
 * `pkg.assets` already whitelists playwright-core's registry. `puppeteer-core`
 * ships NO browser, so adopting it would mean a SECOND download manager, a
 * second cache location and a second set of frozen assets — a duplicate of
 * machinery that already works, to drive the same Chromium binary. This feature
 * changes WHEN the browser is used, not WHICH library drives it, so the existing
 * engine is the one to keep.
 *
 * WHAT THIS MODULE DOES NOT DO. It never launches a browser and never throws for
 * an expected failure — it returns a VERDICT. Keeping the judgement here rather
 * than inside `ScraperService` is what makes the heuristics testable against
 * fixture HTML with no network and no browser, which is exactly how
 * `scripts/verify-mobile.mjs` exercises them.
 *
 * ABORT IS NEVER A VERDICT. A caller-initiated abort (a PRIORITY task
 * preempting a forage pass) must propagate as a rejection, never be reclassified
 * as "the fast pass failed, so launch a browser" — that would spend a browser
 * launch on work the engine just cancelled. Only the fetch deadline and genuine
 * transport faults produce a failure verdict.
 */

import { fetchPage } from "./MobileScraper";
import type { MobileScrapeResult } from "./MobileScraper";

/**
 * Below this many words a served document is treated as a SHELL rather than a
 * page, and the browser is asked to render it properly.
 *
 * Chosen with the failure modes in mind, both of which are cheap: a false
 * positive costs one Chromium launch and returns the same text anyway, while a
 * false negative hands the LLM an empty skeleton and silently teaches the node
 * nothing. Erring towards escalation is therefore the correct direction.
 */
export const MIN_USEFUL_WORDS = 40;

/**
 * A document smaller than this cannot be a rich application shell worth
 * escalating: an SPA that renders anything meaningful ships a bundle, and a
 * bundle reference needs at least a couple of kilobytes of markup around it.
 */
export const SPA_MIN_HTML_BYTES = 2_048;

/**
 * THE FAST PASS'S OWN, SHORTER DEADLINE.
 *
 * WHY SHORTER THAN THE MOBILE SCRAPER'S 30s. On the APK the fetch IS the engine,
 * so it gets the full navigation deadline — there is nothing to fall back to. On
 * a desktop the fetch is only the FIRST rung of the waterfall: a host that has
 * not served its HTML in fifteen seconds is either broken or stalling scripted
 * clients on purpose, and both are exactly what the browser fallback exists for.
 * Waiting the full thirty seconds first would spend two thirds of the forager's
 * 90-second per-URL budget before Chromium was even asked — which is the
 * opposite of what a "fast pass" is for.
 */
export const FAST_PASS_TIMEOUT_MS = 15_000;

/**
 * A single mount point with nothing inside it — the signature of a React/Vue/
 * Next document that has not run its bundle yet:
 *
 *   <div id="root"></div>      <div id="app"></div>      <div id="__next"></div>
 */
const EMPTY_MOUNT_MARKER =
  /<(?:div|main)[^>]+id\s*=\s*["'](?:root|app|__next|__nuxt|svelte|gatsby-focus-wrapper)["'][^>]*>\s*<\/(?:div|main)>/i;

/** The notices frameworks print when their bundle has not run yet. */
const NEEDS_JAVASCRIPT_NOTICE =
  /you need to enable javascript|enable javascript to (?:run|continue|view)|javascript is (?:required|disabled)/i;

/**
 * Evidence the document is a client-side application rather than served content.
 *
 * `data-reactroot` appears on server-rendered React too, which is why this is
 * only ever consulted AFTER the word-count gate — an SSR page carries its text
 * in the HTML and never reaches this check.
 */
const BUNDLE_MARKER =
  /\/_next\/|\/static\/js\/|__NEXT_DATA__|__NUXT__|data-reactroot|<script[^>]+type\s*=\s*["']module["']/i;

/**
 * BOT WALLS AND INTERSTITIALS — the markers that mean "this is not the page".
 *
 * Deliberately a small, high-confidence list rather than a long one: every entry
 * is a string a challenge page emits and an ordinary content page does not.
 * Cloudflare leads it because it is what the reported sources (AllTrails and
 * friends) actually serve, and the same 403-with-a-challenge-body shape is used
 * by Imperva, PerimeterX and DataDome.
 */
const BOT_WALL_SIGNATURES: ReadonlyArray<readonly [RegExp, string]> = [
  [/cf-chl-|__cf_chl_|cf_chl_opt|challenge-platform|cf-please-wait/i, "Cloudflare bot challenge"],
  [/just a moment\.\.\./i, 'Cloudflare interstitial ("Just a moment...")'],
  [/attention required![\s\S]{0,40}cloudflare/i, 'Cloudflare "Attention Required"'],
  [/checking your browser before accessing/i, "Cloudflare browser check"],
  [/enable javascript and cookies to continue/i, "Cloudflare JavaScript/cookie challenge"],
  [/ddos protection by cloudflare/i, "Cloudflare DDoS interstitial"],
  [/verifying you are human|verify you are human/i, "human-verification interstitial"],
  [/_Incapsula_Resource|visid_incap|incap_ses/i, "Imperva/Incapsula bot wall"],
  [/px-captcha|_pxhd|perimeterx/i, "PerimeterX bot wall"],
  [/datadome|dd_cookie_test/i, "DataDome bot wall"],
];

/** Which check tripped. Reported on the crawl stream so the reason is visible. */
export type FastPassFailureKind = "http" | "network" | "empty" | "bot-wall" | "spa-skeleton";

/** The fast pass saw the page: its text is the page's text. */
export interface FastPassSuccess {
  ok: true;
  result: MobileScrapeResult;
  /** HTTP status of the response. */
  status: number;
  /** Size of the document the fast pass judged, for the log line. */
  htmlBytes: number;
}

/** The fast pass did not see the page: escalate, or fail honestly. */
export interface FastPassFailure {
  ok: false;
  kind: FastPassFailureKind;
  /** One short sentence — used in the crawl stream and the fleet log. */
  reason: string;
  /** The error to surface when no browser is available to escalate to. */
  error: Error;
  /** Present when a response was received at all. */
  status?: number;
  /**
   * Whether a browser could plausibly do better.
   *
   * False for a definitive HTTP answer (404/410): a page that does not exist
   * does not appear when rendered, so launching Chromium for it would burn a
   * browser start to reach the same conclusion.
   */
  escalate: boolean;
}

export type FastPassOutcome = FastPassSuccess | FastPassFailure;

/** Whitespace-separated word count. Used by the shell detector below. */
export function countWords(text: string): number {
  const matches = String(text ?? "").match(/\S+/g);
  return matches ? matches.length : 0;
}

/**
 * Names the bot wall in `html`, or null when the document is not a wall.
 *
 * The status codes are checked as well as the body, because a wall does not
 * always leave a recognisable signature (a bare 403 from a WAF says nothing
 * else), and because a 200 carrying a challenge body is the shape that most
 * easily slips through to the LLM as though it were content.
 */
export function detectBotWall(html: string, status?: number): string | null {
  const body = String(html ?? "");
  for (const [pattern, label] of BOT_WALL_SIGNATURES) {
    if (pattern.test(body)) return label;
  }
  if (status === 403) return "HTTP 403 (refused)";
  if (status === 429) return "HTTP 429 (rate limited)";
  if (status === 503) return "HTTP 503 (often a bot wall)";
  return null;
}

/**
 * True when the document is a client-side application shell — markup that would
 * render into a page, with no server-side text in it to read.
 *
 * The word-count gate comes FIRST on purpose: it is the only check that can rule
 * the document in, so a page with real prose is never escalated no matter which
 * framework markers it happens to contain.
 */
export function looksLikeSpaSkeleton(html: string, text: string): boolean {
  const body = String(html ?? "");
  if (countWords(text) >= MIN_USEFUL_WORDS) return false;
  if (EMPTY_MOUNT_MARKER.test(body)) return true;
  if (NEEDS_JAVASCRIPT_NOTICE.test(body)) return true;
  return body.length >= SPA_MIN_HTML_BYTES && BUNDLE_MARKER.test(body);
}

/**
 * A definitive "this resource is not there" — rendering it changes nothing.
 *
 * Kept as its own function so the escalation policy is one readable line rather
 * than a condition buried in the verdict construction.
 */
function isEscalatable(status?: number): boolean {
  return status !== 404 && status !== 410;
}

/**
 * STEP 1 + STEP 2 — fetch the URL cheaply, then judge what came back.
 *
 * Never launches a browser. Throws ONLY on a caller-initiated abort, so
 * preemption keeps propagating exactly as it did before this existed.
 */
export async function fastPassScrape(url: string, signal?: AbortSignal): Promise<FastPassOutcome> {
  const attempt = await fetchPage(url, signal, FAST_PASS_TIMEOUT_MS);

  // A transport-level outcome (non-2xx, network fault, empty body). The error is
  // carried through untouched so that a node with no browser to escalate to
  // still fails with exactly the message it always did.
  if (!attempt.ok) {
    /*
      TWO FAILURES THAT DESERVE A BETTER NAME THAN THE TRANSPORT GAVE THEM.

      A 403/429/503 IS the bot wall the brief names — the status alone is the
      diagnosis, and there is no body to read because the fast pass never
      downloads one. And "no extractable body text" is two different things: a
      blank page, or a React/Next shell whose content only exists after its
      bundle runs. Naming them correctly is what makes the crawl stream readable
      and the escalation log line worth reading.
    */
    const statusWall = attempt.status === undefined ? null : detectBotWall("", attempt.status);
    if (statusWall) {
      return {
        ok: false,
        kind: "bot-wall",
        reason: statusWall,
        error: attempt.error,
        status: attempt.status,
        escalate: true,
      };
    }

    if (attempt.kind === "empty" && looksLikeSpaSkeleton(attempt.html ?? "", "")) {
      return {
        ok: false,
        kind: "spa-skeleton",
        reason: "client-rendered shell (no server-side body text at all)",
        error: new Error(
          `No extractable body text at ${url} — the page is assembled by its own JavaScript`,
        ),
        status: attempt.status,
        escalate: true,
      };
    }

    return {
      ok: false,
      kind: attempt.kind,
      reason: attempt.reason,
      error: attempt.error,
      status: attempt.status,
      escalate: isEscalatable(attempt.status),
    };
  }

  const { html, status, title, text } = attempt.page;

  const wall = detectBotWall(html, status);
  if (wall) {
    return {
      ok: false,
      kind: "bot-wall",
      reason: `${wall} — the fast pass did not see the page`,
      error: new Error(`${wall} at ${url}`),
      status,
      escalate: true,
    };
  }

  if (looksLikeSpaSkeleton(html, text)) {
    return {
      ok: false,
      kind: "spa-skeleton",
      reason: `client-rendered shell (${countWords(text)} words of server-side text)`,
      error: new Error(
        `No extractable body text at ${url} — the page is assembled by its own JavaScript`,
      ),
      status,
      escalate: true,
    };
  }

  return { ok: true, result: { url, title, text }, status, htmlBytes: html.length };
}
