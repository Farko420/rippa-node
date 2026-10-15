/**
 * MOBILE SCRAPING FALLBACK — `fetch` + static HTML extraction.
 *
 * WHY THIS EXISTS. The deep scraper drives a real Chromium through Playwright,
 * which executes JavaScript and so sees the page a human would. An Android APK
 * has no Chromium *binary* Playwright can drive and no `spawn` to launch one
 * with, so on a tablet every scrape threw and the idle forager reported a
 * permanent failure — the node looked alive but learned nothing.
 *
 * WHAT IT GIVES UP, stated plainly: this fetches the raw HTML response, so
 * content assembled by client-side JavaScript (React-rendered pages, infinite
 * scroll, anything behind a bot wall) will not be present. For the sources this
 * node forages — park authorities, trail reports, static info pages — the served
 * HTML does contain the content, and a few hundred KB over `fetch` is far kinder
 * to a tablet's battery overnight than driving a full browser.
 *
 * WHY NO CHEERIO. A DOM parser would be a new runtime dependency in the SAME
 * package.json the Windows `.exe` build freezes with `pkg`. Cheerio's tree is
 * large, and adding it to satisfy one fallback path risks the existing exe build
 * for no desktop benefit — where the Chromium path is still used. Tag-stripping
 * is ~40 lines, has no dependencies, and runs identically in Node and a WebView.
 *
 * The result shape is deliberately identical to the Playwright scraper's, so the
 * forager cannot tell which engine produced the text and needs no branching.
 */

/**
 * The mobile scraper's result. Deliberately the same `url`/`title`/`text` shape
 * as `ScraperService.scrape()` (which additionally reports WHICH pass of the
 * waterfall produced the text — see `ScrapeEngine`), so the forager cannot tell
 * which engine produced the text and needs no branching.
 */
export interface MobileScrapeResult {
  url: string;
  title: string;
  /** Sanitized, whitespace-normalized body text (capped, like the desktop path). */
  text: string;
}

/** Hard cap on extracted text so one page cannot blow the LLM context budget. */
const MAX_TEXT_CHARS = 20_000;
/** Whole-response cap. Guards against downloading a multi-megabyte asset. */
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const NAV_TIMEOUT_MS = 30_000;

/**
 * Elements removed along with their content.
 *
 * Mirrors the intent of the desktop selector list — chrome, scripts, ads,
 * popups — expressed as tag/attribute patterns because there is no live DOM to
 * query. Kept deliberately short: a long regex list over static HTML is both
 * slow and easy to get subtly wrong, so it covers the common high-yield cases.
 */
const STRIP_BLOCKS: RegExp[] = [
  /<script\b[\s\S]*?<\/script>/gi,
  /<style\b[\s\S]*?<\/style>/gi,
  /<noscript\b[\s\S]*?<\/noscript>/gi,
  /<template\b[\s\S]*?<\/template>/gi,
  /<svg\b[\s\S]*?<\/svg>/gi,
  /<iframe\b[\s\S]*?<\/iframe>/gi,
  /<nav\b[\s\S]*?<\/nav>/gi,
  /<header\b[\s\S]*?<\/header>/gi,
  /<footer\b[\s\S]*?<\/footer>/gi,
  /<aside\b[\s\S]*?<\/aside>/gi,
  /<!--[\s\S]*?-->/g,
  // Popup / ad / consent shells by class or id, including nested divs/sections.
  /<(div|section|aside)\b[^>]*(?:class|id)\s*=\s*["'][^"']*(?:cookie|consent|popup|modal|overlay|newsletter|sponsor|advert|(?:^|\W)ads?(?:\W|$)|banner)[^"']*["'][^>]*>[\s\S]*?<\/\1>/gi,
];
/** Extracts `<title>` from raw HTML, or "". */
export function extractTitle(html: string): string {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (!match) return "";
  return decodeEntities(match[1].replace(/\s+/g, " ").trim()).slice(0, 300);
}

/** Named HTML entities that actually show up in AU outdoor-guide prose. */
const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  hellip: "…",
  deg: "°",
  eacute: "é",
  egrave: "è",
  uuml: "ü",
  ouml: "ö",
  auml: "ä",
};

/**
 * Decodes the entity set above, plus numeric entities.
 *
 * A bounded table plus numeric refs is deliberate: `&amp;` in a sentence and
 * `&#8211;` for an en dash are both common, while a full entity table is
 * megabytes of data for characters that never appear in this corpus.
 */
export function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) => {
      const code = Number.parseInt(hex, 16);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : "";
    })
    .replace(/&#(\d+);/g, (_match, dec: string) => {
      const code = Number.parseInt(dec, 10);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : "";
    })
    .replace(/&([a-z]+);/gi, (match, name: string) => ENTITIES[name.toLowerCase()] ?? match);
}

/**
 * Turns a raw HTML document into clean, capped body text.
 *
 * Exported separately from `scrape()` so it can be unit-tested directly against
 * fixture HTML — which is how this fallback's correctness is verified in CI on a
 * machine with no browser and no network.
 */
export function htmlToText(html: string): string {
  let working = html;

  for (const pattern of STRIP_BLOCKS) {
    // A FRESH RegExp per pass: these are global+case-insensitive, and a shared
    // `lastIndex` across calls would make the second document skip matches.
    working = working.replace(new RegExp(pattern.source, pattern.flags), " ");
  }

  // Drop the head entirely (title/meta/links were already handled) and convert
  // block-level boundaries to newlines so paragraphs survive as paragraphs.
  working = working.replace(/<head\b[\s\S]*?<\/head>/gi, " ");
  working = working.replace(
    /<\/?(?:p|div|section|article|br|li|tr|h[1-6]|blockquote|pre|td)\b[^>]*>/gi,
    "\n",
  );
  // Everything else is inline markup, removed outright.
  working = working.replace(/<[^>]+>/g, " ");

  working = decodeEntities(working)
    .replace(/\r/g, "")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return working.slice(0, MAX_TEXT_CHARS);
}

/**
 * The desktop UA. Sent from mobile too: many sites serve a materially worse page
 * to a bare `fetch` from a WebView, and impersonating desktop is precisely what
 * makes this fallback good enough to keep working overnight.
 */
const DESKTOP_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/** Raw outcome of ONE lightweight fetch, before any waterfall judgement. */
export interface FetchedPage {
  url: string;
  title: string;
  /** Sanitized, whitespace-normalized body text (capped, like the desktop path). */
  text: string;
  /** The raw HTML response, capped at MAX_RESPONSE_BYTES. */
  html: string;
  /** HTTP status. Always 2xx here — anything else is a failure, not a page. */
  status: number;
}

/** Why a fetch did not produce a page. */
export type FetchFailureKind = "http" | "network" | "empty";

/**
 * A fetch attempt that never throws for an EXPECTED failure.
 *
 * WHY THIS SHAPE EXISTS. The waterfall (`agent/WaterfallScraper`) has to be able
 * to say "the fast pass failed, escalate to a browser" — a decision it cannot
 * make from an exception alone, and must not make by catching one, because a
 * caller-initiated ABORT arrives as an exception too and must keep propagating
 * (a PRIORITY task preempting a forage pass must never trigger a browser
 * launch). So `fetchPage` returns the outcome and `scrapeMobile` rethrows it,
 * which keeps ONE fetch implementation serving both callers.
 */
export type FetchAttempt =
  | { ok: true; page: FetchedPage }
  | {
      ok: false;
      kind: FetchFailureKind;
      reason: string;
      error: Error;
      status?: number;
      /**
       * The document that produced no text, when one was received.
       *
       * Only the EMPTY case carries this. A non-2xx never has its body read (the
       * status is the answer, and downloading an error page on a tablet for no
       * reason is exactly what the mobile path exists to avoid), and a network
       * fault has no body at all. It is here because "no text" has two very
       * different causes the waterfall must be able to tell apart: a genuinely
       * blank page, and a React/Next shell whose content only exists after its
       * bundle runs.
       */
      html?: string;
    };

/**
 * Fetches a URL with `fetch` alone and reports the outcome.
 *
 * PREEMPTIBLE: `signal` aborts the fetch when a PRIORITY task arrives. The
 * timeout signal is linked (not replaced) so an explicit abort wins over the
 * navigation deadline instead of one clobbering the other. An abort is RETHROWN
 * rather than returned as a failure — see {@link FetchAttempt}.
 */
export async function fetchPage(
  url: string,
  signal?: AbortSignal,
  /**
   * Deadline for the whole attempt. Defaults to the mobile navigation deadline,
   * which is right for the APK (there the fetch IS the engine, so it gets the
   * full budget). The desktop waterfall passes a SHORTER one — see
   * `FAST_PASS_TIMEOUT_MS` in `WaterfallScraper`.
   */
  timeoutMs: number = NAV_TIMEOUT_MS,
): Promise<FetchAttempt> {
  throwIfAborted(signal);
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = linkSignals(signal, timeout);

  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      redirect: "follow",
      headers: {
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-AU,en;q=0.9",
        "User-Agent": DESKTOP_UA,
      },
      signal: combined,
    });
  } catch (error) {
    // A preemption is not a scraping failure — it is the engine cancelling this
    // work, so it must reject exactly as it did before this refactor existed.
    throwIfAborted(signal);
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      kind: "network",
      reason: `network error (${message})`,
      error: new Error(`Fetch failed for ${url}: ${message}`),
    };
  }

  if (!response.ok) {
    return {
      ok: false,
      kind: "http",
      reason: `HTTP ${response.status}`,
      error: new Error(`HTTP ${response.status} for ${url}`),
      status: response.status,
    };
  }

  // Reject an oversized body up front when the server declares a length, then
  // clamp the real payload too — a server can lie about, or omit, Content-Length.
  const declared = Number(response.headers?.get?.("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    const message = `response is ${(declared / 1024 / 1024).toFixed(1)} MB — refusing to download a page this large`;
    return { ok: false, kind: "network", reason: message, error: new Error(message) };
  }

  let html: string;
  try {
    html = (await response.text()).slice(0, MAX_RESPONSE_BYTES);
  } catch (error) {
    throwIfAborted(signal);
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      kind: "network",
      reason: `response body failed (${message})`,
      error: new Error(`Fetch failed for ${url}: ${message}`),
    };
  }
  throwIfAborted(signal);

  const title = extractTitle(html) || url;
  const text = htmlToText(html);

  if (!text) {
    return {
      ok: false,
      kind: "empty",
      reason: "no extractable body text",
      error: new Error(`No extractable body text at ${url}`),
      status: response.status,
      // Carried so the waterfall can tell a blank page from a client-rendered
      // shell — the same "no text" verdict, two very different diagnoses.
      html,
    };
  }

  return { ok: true, page: { url, title, text, html, status: response.status } };
}

/**
 * Fetches a URL and returns sanitized text using only `fetch`.
 *
 * Throws on a non-2xx response or an empty document, matching the desktop
 * scraper's contract exactly so the forager's failure and backoff handling is
 * identical on either engine.
 *
 * This is the engine the APK runs, and the same one the desktop waterfall uses
 * as its FAST PASS — one implementation, two callers, so the two paths can never
 * drift into fetching pages differently.
 */
export async function scrapeMobile(url: string, signal?: AbortSignal): Promise<MobileScrapeResult> {
  const attempt = await fetchPage(url, signal);
  if (attempt.ok) {
    return { url, title: attempt.page.title, text: attempt.page.text };
  }
  throw attempt.error;
}

/** Throws a preemption-flavoured abort when `signal` is already fired. */
function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error("Aborted");
  }
}

/**
 * Links an optional caller signal with the navigation timeout.
 *
 * Returns `undefined` when neither exists (plain fetch), the single live
 * signal when only one exists, or a combined signal that fires when EITHER
 * fires — so a PRIORITY preempt and the nav deadline can each win honestly.
 */
function linkSignals(first?: AbortSignal, second?: AbortSignal): AbortSignal | undefined {
  if (first && second) return AbortSignal.any([first, second]);
  return first ?? second;
}