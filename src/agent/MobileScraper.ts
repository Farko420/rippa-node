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

/** Identical contract to `ScraperService.scrape()`. */
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

/**
 * Fetches a URL and returns sanitized text using only `fetch`.
 *
 * Throws on a non-2xx response or an empty document, matching the desktop
 * scraper's contract exactly so the forager's failure and backoff handling is
 * identical on either engine.
 *
 * PREEMPTIBLE: `signal` aborts the fetch when a PRIORITY task arrives. The
 * timeout signal is linked (not replaced) so an explicit abort wins over the
 * navigation deadline instead of one clobbering the other.
 */
export async function scrapeMobile(url: string, signal?: AbortSignal): Promise<MobileScrapeResult> {
  throwIfAborted(signal);
  const timeout = AbortSignal.timeout(NAV_TIMEOUT_MS);
  const combined = linkSignals(signal, timeout);
  const response = await fetch(url, {
    method: "GET",
    redirect: "follow",
    headers: {
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-AU,en;q=0.9",
      "User-Agent": DESKTOP_UA,
    },
    signal: combined,
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }

  // Reject an oversized body up front when the server declares a length, then
  // clamp the real payload too — a server can lie about, or omit, Content-Length.
  const declared = Number(response.headers?.get?.("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    throw new Error(
      `response is ${(declared / 1024 / 1024).toFixed(1)} MB — refusing to download a page this large on mobile`,
    );
  }

  const html = (await response.text()).slice(0, MAX_RESPONSE_BYTES);
  throwIfAborted(signal);
  const title = extractTitle(html) || url;
  const text = htmlToText(html);

  if (!text) {
    throw new Error(`No extractable body text at ${url}`);
  }

  return { url, title, text };
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