import "../pkgNativeShim"; // must load before playwright (exe loader shims)
import { chromium, type Browser, type Page } from "playwright";
import { spawn } from "node:child_process";
import fs from "node:fs";

/**
 * THE EYES — headless scraping service.
 *
 * Launches a (reused) headless Chromium instance, navigates to a URL and
 * extracts the `innerText` of `<body>` after stripping navigation, footer,
 * scripts, styles and ad/popup chrome. This keeps the token payload sent
 * to the local LLM as small as possible.
 */

export interface ScrapeResult {
  url: string;
  title: string;
  /** Sanitized, whitespace-normalized body text (capped at MAX_TEXT_CHARS). */
  text: string;
}

/** Hard cap on extracted text so a single page can never blow the LLM context. */
const MAX_TEXT_CHARS = 20_000;
const NAV_TIMEOUT_MS = 30_000;
const NETWORK_IDLE_CAP_MS = 5_000;

/**
 * PLAYWRIGHT BROWSER BOOTSTRAP.
 *
 * On startup we check whether Playwright's Chromium binary is already on this
 * machine. If it is missing, `npx playwright install chromium` is kicked off
 * automatically in the background (silent, no CLI knowledge required) and the
 * first launch simply waits for the download to finish.
 */

/** Resolved install promise so repeated checks never start a second download. */
let chromiumBootstrap: Promise<void> | null = null;

/** Expected Chromium path, or null when Playwright cannot resolve it. */
function chromiumExecutablePath(): string | null {
  try {
    return chromium.executablePath();
  } catch {
    return null;
  }
}

/** Bundled Playwright version (used to pin the installer to this exact build). */
function bundledPlaywrightVersion(): string | null {
  try {
    const pkgJson = require("playwright/package.json") as { version?: unknown };
    return typeof pkgJson.version === "string" ? pkgJson.version : null;
  } catch {
    return null;
  }
}

function reportBootstrapFailure(reason: string): void {
  console.log(`[Scraper] Automatic Chromium download did not finish (${reason}).`);
  console.log('[Scraper] Once you are online, run: npx playwright install chromium');
}

/** Startup check: verify Chromium exists, else install it in the background. */
function ensureChromiumInstalled(): Promise<void> {
  if (chromiumBootstrap) return chromiumBootstrap;

  const executable = chromiumExecutablePath();
  if (executable && fs.existsSync(executable)) {
    chromiumBootstrap = Promise.resolve();
    return chromiumBootstrap;
  }

  console.log("[Scraper] Chromium browser not found on this machine.");
  console.log("[Scraper] Downloading it now in the background (first run only — this can take a minute)…");

  chromiumBootstrap = new Promise<void>((resolve) => {
    const version = bundledPlaywrightVersion();
    // Sanitized: only ever `playwright` or `playwright@<x.y.z>` (from package.json).
    const spec = version && /^[\w.-]+$/.test(version) ? `playwright@${version}` : "playwright";
    const onWindows = process.platform === "win32";
    // Windows needs the shell to reach npx.cmd. A single command string (no
    // args array + shell:true) avoids Node's DEP0190 deprecation warning.
    const child = onWindows
      ? spawn(`npx --yes ${spec} install chromium`, {
          cwd: process.cwd(),
          stdio: "ignore",
          detached: true,
          shell: true,
        })
      : spawn("npx", ["--yes", spec, "install", "chromium"], {
          cwd: process.cwd(),
          stdio: "ignore",
          detached: true,
        });

    child.once("error", (error: Error) => {
      reportBootstrapFailure(error.message);
      resolve();
    });
    child.once("exit", (code, signal) => {
      if (code === 0) {
        console.log("[Scraper] Chromium download finished — scraping is ready.");
      } else {
        reportBootstrapFailure(`exit code ${code ?? signal ?? "unknown"}`);
      }
      resolve();
    });
    child.unref();
  });

  return chromiumBootstrap;
}

/**
 * Selectors removed from the live DOM before `innerText` is read.
 * Covers the required <nav>/<footer>/<script>/<style> strip plus the usual
 * ad, cookie-banner and popup/modal chrome. `i` = case-insensitive match
 * (supported by Chromium).
 */
const SANITIZE_SELECTORS: string[] = [
  // Required strippers
  "nav",
  "footer",
  "script",
  "style",
  // Non-content / non-visible boilerplate that still costs tokens
  "noscript",
  "iframe",
  "svg",
  "canvas",
  "template",
  '[role="navigation"]',
  '[role="contentinfo"]',
  '[role="banner"]',
  '[role="dialog"]',
  '[role="alertdialog"]',
  '[aria-modal="true"]',
  // Ads
  '[aria-label*="advertis" i]',
  '[class*="advert" i]',
  '[id*="advert" i]',
  '[class*="adsense" i]',
  '[id*="adsense" i]',
  '[class*="sponsored" i]',
  '[class*=" banner" i]',
  '[id*="banner" i]',
  // Popups / cookie consent
  '[class*="popup" i]',
  '[id*="popup" i]',
  '[class*="modal" i]',
  '[id*="modal" i]',
  '[class*="cookie" i]',
  '[id*="cookie" i]',
  '[class*="newsletter" i]',
  '[class*="overlay" i]',
];

export class ScraperService {
  private browser: Browser | null = null;
  /** Resolved once the startup Chromium check (and any download) has settled. */
  private readonly chromiumReady: Promise<void>;

  constructor() {
    // Startup check — verifies the Chromium binary and, when missing, starts
    // a silent background install so no manual CLI command is ever needed.
    this.chromiumReady = ensureChromiumInstalled();
  }

  /**
   * Launches (or returns the already-running) headless Chromium instance.
   * The browser is reused across scrapes and torn down via `close()`.
   */
  private async getBrowser(): Promise<Browser> {
    if (this.browser && this.browser.isConnected()) {
      return this.browser;
    }

    // First launch waits for the background bootstrap download (if one ran).
    await this.chromiumReady;

    this.browser = await chromium.launch({
      headless: true,
      args: ["--disable-blink-features=AutomationControlled"],
    });

    // If Chromium dies underneath us, drop the handle so the next scrape relaunches.
    this.browser.on("disconnected", () => {
      this.browser = null;
    });

    console.log("[Scraper] Headless Chromium launched.");
    return this.browser;
  }

  /** Scrapes a URL and returns sanitized body text. Throws on navigation failure / empty page. */
  async scrape(url: string): Promise<ScrapeResult> {
    const browser = await this.getBrowser();
    const context = await browser.newContext({
      // en-AU + a stock desktop UA keeps the parse honest for AU-targeted pages.
      locale: "en-AU",
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      viewport: { width: 1366, height: 768 },
    });

    try {
      const page = await context.newPage();
      const response = await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: NAV_TIMEOUT_MS,
      });

      const status = response?.status();
      if (status !== undefined && status >= 400) {
        throw new Error(`HTTP ${status} for ${url}`);
      }

      // Let lazy-loaded content settle, but never block longer than the cap.
      await page.waitForLoadState("networkidle", { timeout: NETWORK_IDLE_CAP_MS }).catch(() => undefined);

      const title = (await page.title().catch(() => "")) || url;
      const text = await extractSanitizedBody(page);

      if (!text) {
        throw new Error(`No extractable body text at ${url}`);
      }

      return { url, title, text };
    } finally {
      // One context per scrape: cookies/storage never leak between sources.
      await context.close().catch(() => undefined);
    }
  }

  /** Closes the shared Chromium instance. Safe to call multiple times. */
  async close(): Promise<void> {
    if (this.browser) {
      const browser = this.browser;
      this.browser = null;
      await browser.close().catch(() => undefined);
      console.log("[Scraper] Headless Chromium closed.");
    }
  }
}

/**
 * Strips chrome elements from the live DOM, then reads `<body>.innerText`.
 * Runs inside the page so we never pay to ship the junk over the wire.
 *
 * NOTE: this is a STATIC script string evaluated as `(SCRIPT)(SELECTORS)`.
 * Passing a JS function reference here is fragile: bundlers (pkg) can reshape
 * the function's `.toString()`, which Playwright then rejects as
 * "not well-serializable". A literal expression string behaves identically
 * in dev and in the packaged exe.
 */
const SANITIZE_SCRIPT = `(SELECTORS) => {
  const body = document.body;
  if (!body) {
    return "";
  }
  for (const selector of SELECTORS) {
    try {
      body.querySelectorAll(selector).forEach((el) => el.remove());
    } catch {
      // A malformed selector must never abort the extraction — skip it.
    }
  }
  return body.innerText ?? "";
}`;

async function extractSanitizedBody(page: Page): Promise<string> {
  const expression = `(${SANITIZE_SCRIPT})(${JSON.stringify(SANITIZE_SELECTORS)})`;
  const raw: unknown = await page.evaluate(expression);

  if (typeof raw !== "string") {
    return "";
  }

  // Collapse runs of blank lines and cap the payload size.
  return raw
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, MAX_TEXT_CHARS);
}
