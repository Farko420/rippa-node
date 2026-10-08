import "../pkgNativeShim"; // must load before playwright (exe loader shims)
import type { Browser, BrowserContext, Page } from "playwright";
import { describeRuntime, supportsBrowserScraping } from "../platform";
import { scrapeMobile } from "./MobileScraper";
import type { ResourceGovernor } from "../services/resourceGovernor";
import { hasSubscribers, publishScrape, publishViewport } from "../services/engineTelemetry";

/**
 * EVERY NODE-ONLY DEPENDENCY IN THIS FILE IS LOADED LAZILY, AND THAT IS LOAD-
 * BEARING FOR THE APK — not an optimisation.
 *
 * `playwright-core/lib/bootstrap.js` reads `process.versions` at MODULE EVALUATION
 * time. A static `import { chromium } from "playwright"` therefore throws
 * "Cannot read properties of undefined (reading 'versions')" the instant this
 * file is parsed inside the Capacitor WebView, where there is no `process`. That
 * kills the import chain and the node never boots on a tablet.
 *
 * So Playwright, `node:child_process` and `node:fs` are all reached through
 * `require()` INSIDE the functions that need them, which defers evaluation until
 * (and unless) `supportsBrowserScraping()` has already confirmed a desktop
 * runtime. Type-only imports above are erased at compile time and cost nothing.
 *
 * The practical effect: this module is now safe to import anywhere, and the
 * mobile path below never touches a single Node-only module.
 */
type ChromiumApi = typeof import("playwright");

let chromiumApi: ChromiumApi | null = null;

/** Loads (once) the Playwright API. Only ever called on a desktop runtime. */
function loadChromium(): ChromiumApi {
  if (!chromiumApi) chromiumApi = require("playwright") as ChromiumApi;
  return chromiumApi;
}

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
 * machine. If it is missing, it is installed programmatically, in-process, via
 * `playwright-core`'s internal registry (`agent/browserInstaller`) — with a
 * direct CDN download as a fallback — and the first launch waits for it.
 */

/** Resolved install promise so repeated checks never start a second download. */
let chromiumBootstrap: Promise<void> | null = null;

/**
 * TRUE once we have established Chromium cannot be obtained on this machine.
 *
 * WHY THIS IS A MODULE FLAG AND NOT A FIELD ON `ScraperService`. The bootstrap
 * is shared by every instance (see `chromiumBootstrap`), so the verdict has to
 * be shared too: a node that failed to download Chromium once must reach the
 * same conclusion on every scraper instance for the life of the process.
 *
 * THIS IS WHAT MAKES A FAILED DOWNLOAD SURVIVABLE. Without it, a failed
 * bootstrap only logged a line and then every subsequent `scrape()` still took
 * the Chromium path and threw "Executable doesn't exist at ...", turning a
 * recoverable first-boot network problem into a node that could never forage
 * again. With it, `scrape()` degrades to the lightweight fetch scraper and the
 * rest of the node carries on.
 */
let chromiumUnavailable = false;

/** Expected Chromium path, or null when Playwright cannot resolve it. */
function chromiumExecutablePath(): string | null {
  try {
    return loadChromium().chromium.executablePath();
  } catch {
    return null;
  }
}



function reportBootstrapFailure(reason: string): void {
  // Records the failure so every later scrape takes the lightweight path, then
  // explains what happened. Deliberately NOT fatal: the node must survive a
  // missing browser.
  chromiumUnavailable = true;
  console.log(`[Scraper] Automatic Chromium download did not finish (${reason}).`);
  console.log(
    "[Scraper] Browser scraping is disabled for this run — falling back to the " +
      "lightweight fetch scraper. All other node capabilities stay online.",
  );
  console.log(
    "[Scraper] The node will retry automatically on its next boot once the " +
      "Playwright CDN is reachable.",
  );
}

/**
 * Resolves the writable directory a packaged build must download Chromium into,
 * or "" when no override is needed.
 *
 * WHY A PACKAGED EXE NEEDS THIS. Playwright resolves its browser registry from
 * `PLAYWRIGHT_BROWSERS_PATH`, and when that is unset it falls back to a location
 * resolved from the *package installation*. Inside a `pkg` snapshot there is no
 * node_modules directory on disk, so that fallback points somewhere unusable or
 * unwritable and the download fails — exactly the reported "Playwright fails to
 * install Chromium on boot" symptom.
 *
 * `%LOCALAPPDATA%\RippaNode\browsers` is chosen deliberately: it is the same
 * per-user app-data root this app already uses for config.json and the Deep
 * Brain database (see `utils/paths.ts`), so it is guaranteed writable, survives
 * OTA swaps of the executable, and needs no admin rights.
 *
 * Returns "" on any failure, and for non-packaged runs, so the caller can simply
 * skip setting the variable rather than reason about which case it is in.
 */
function resolveBrowserInstallDir(): string {
  try {
    // `typeof` rather than truthiness: `process.pkg` is injected by the pkg
    // bootstrap and is genuinely absent from a plain `node`/`tsx` process.
    if (typeof (process as NodeJS.Process & { pkg?: unknown }).pkg === "undefined") {
      return "";
    }
    // Resolved through the app's own path helper rather than re-deriving
    // LOCALAPPDATA here, so the browser cache can never drift away from the
    // directory the rest of the app persists to. Lazily required for the same
    // reason `node:fs` is below — this file is evaluated inside a WebView too.
    const path = require("node:path") as typeof import("node:path");
    const { resolveDataDir } = require("../utils/paths") as typeof import("../utils/paths");
    return path.join(resolveDataDir(), "browsers");
  } catch (error) {
    console.warn(
      `[Scraper] Could not resolve a browser install directory — ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return "";
  }
}

/** Startup check: verify Chromium exists, else install it in the background. */
function ensureChromiumInstalled(): Promise<void> {
  if (chromiumBootstrap) return chromiumBootstrap;

  /*
    EVERYTHING BELOW IS INSIDE ONE TRY/CATCH, AND THE PROMISE NEVER REJECTS.

    This routine runs from `ScraperService`'s CONSTRUCTOR, i.e. while the
    Orchestrator is still being built. Anything that threw out of here — a
    missing `node:child_process`, a read-only filesystem, a bad spawn — took the
    entire node down at boot, before a single task could run. A missing browser
    is a degraded capability, never a fatal error, so the promise always
    resolves and the failure is recorded in `chromiumUnavailable` instead.
  */
  chromiumBootstrap = (async () => {
    try {
      // `node:fs` is required HERE rather than imported at the top of the file,
      // for the same reason Playwright is: this whole function is unreachable on
      // mobile, and a static import would still be evaluated.
      const fs = require("node:fs") as typeof import("node:fs");

      /*
        THE PACKAGED-EXE PATH FIX. Must happen BEFORE the first
        `chromium.executablePath()` call, because that call resolves and caches
        the browser registry path. Setting it afterwards is too late: the node
        would still look in the unwritable location.
      */
      const browserDir = resolveBrowserInstallDir();
      if (browserDir) {
        process.env.PLAYWRIGHT_BROWSERS_PATH = browserDir;
        fs.mkdirSync(browserDir, { recursive: true });
        console.log(`[Scraper] Packaged build — Chromium will be installed in ${browserDir}`);
      }

      const executable = chromiumExecutablePath();
      if (executable && fs.existsSync(executable)) {
        chromiumUnavailable = false;
        return;
      }

      console.log("[Scraper] Chromium browser not found on this machine.");
      console.log(
        "[Scraper] Downloading it now in the background (first run only — this can take a minute)…",
      );

      /*
        THE INSTALLER IS NOW PROGRAMMATIC. It used to be
        `npx --yes playwright install chromium` spawned as a detached child,
        which fails inside a `pkg` snapshot (no node_modules for npx to resolve)
        and on any Windows host with no global Node.js (no npx on PATH at all) —
        both producing "exit code 1" and a silent fall back to the lightweight
        fetch scraper.

        `installChromium` drives playwright-core's own registry in-process and
        falls back to a direct CDN download + unzip when that cannot run. It
        never spawns a shell, and it verifies the executable afterwards rather
        than trusting an exit code.
      */
      const { installChromium } = require("./browserInstaller") as typeof import("./browserInstaller");
      const result = await installChromium({
        browsersPath: resolveBrowserInstallDir() || undefined,
        executablePath: chromiumExecutablePath,
      });

      if (result.ok) {
        console.log(
          `[Scraper] Chromium download finished (${result.method}) — scraping is ready.`,
        );
        return;
      }

      // Verified rather than trusted: an installer that reports success having
      // written nothing must not leave the node believing it has a browser,
      // because that is the state where every scrape throws.
      const landed = chromiumExecutablePath();
      if (landed && fs.existsSync(landed)) {
        console.log("[Scraper] Chromium download finished — scraping is ready.");
        return;
      }
      reportBootstrapFailure(result.detail);
    } catch (error) {
      reportBootstrapFailure(error instanceof Error ? error.message : String(error));
    }
  })();

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
  /**
   * True when this runtime can actually drive Chromium.
   *
   * Captured ONCE in the constructor rather than probed per scrape: the answer
   * cannot change during a process's life (a WebView stays a WebView), and
   * re-probing on every pass would run the defensive `globalThis` walks on the
   * hot path of an overnight run.
   *
   * NOT `readonly`. This starts as "this runtime supports Chromium" and is
   * permanently demoted to false once the startup bootstrap proves no browser
   * can be obtained. See {@link ScraperService.scrape}, which is where that
   * demotion is acted on — a node whose browser never downloaded has to fall
   * back to the lightweight scraper rather than throw on every single task.
   */
  private canUseBrowser: boolean;

  /**
   * RESOURCE GOVERNOR — bounds how much browser work this node does.
   *
   * Optional: without one the scraper behaves exactly as before (one context at
   * a time is never exceeded here because the priority tier already serialised),
   * which keeps this class constructible standalone in the verification harness.
   */
  private governor: ResourceGovernor | null = null;
  /** Browser contexts open right now, across every concurrent scrape. */
  private activeContexts = 0;
  /** Callers parked on "a browser slot just freed up", in FIFO order. */
  private readonly browserWaiters: Array<() => void> = [];

  constructor() {
    this.canUseBrowser = supportsBrowserScraping();

    /*
      THE CHROMIUM BOOTSTRAP IS SKIPPED ON MOBILE — THE CRITICAL LINE FOR THE APK.

      `ensureChromiumInstalled()` reaches for `node:child_process` and installs
      the browser. Inside the Capacitor WebView there is no `child_process`, so
      that throws — and it throws from a CONSTRUCTOR, i.e. while the Orchestrator
      is still being built. The failure took the node down at boot on a tablet,
      before a single task ran. Guarding it here is what lets the APK start at
      all; the mobile path in `scrape()` then takes over with no Chromium.
    */
    if (this.canUseBrowser) {
      // Verifies the binary and, when missing, starts a silent background
      // install so no manual CLI command is ever needed. Guaranteed never to
      // reject, so no `.catch()` is needed here to keep boot alive.
      this.chromiumReady = ensureChromiumInstalled();
    } else {
      this.chromiumReady = Promise.resolve();
      console.log(
        `[Scraper] ${describeRuntime()} — Chromium unavailable here, using the lightweight fetch scraper.`,
      );
    }
  }

  /** True when Playwright is in use; false when the mobile fallback is active. */
  isBrowserBacked(): boolean {
    return this.canUseBrowser;
  }

  /** Wires the Resource Governor in. Called by the Orchestrator. */
  setGovernor(governor: ResourceGovernor | null): void {
    this.governor = governor;
  }

  /**
   * BLOCKS UNTIL A BROWSER SLOT IS FREE — the Governor's concurrency ceiling,
   * applied to Playwright contexts rather than to task scheduling.
   *
   * Context count is bounded separately from `TaskEngine.inFlight` on purpose:
   * a single priority task can drive several scrapes, so the two limits are
   * layered, not duplicated. Waiters are woken FIFO so no caller is starved.
   */
  private async acquireBrowserSlot(): Promise<void> {
    const limit = Math.max(1, this.governor?.getCurrentLimits().max_concurrent_tasks ?? 1);
    while (this.activeContexts >= limit) {
      await new Promise<void>((resolve) => this.browserWaiters.push(resolve));
    }
    this.activeContexts += 1;
  }

  /** Hands a browser slot back and wakes the next waiter, if any. */
  private releaseBrowserSlot(): void {
    this.activeContexts = Math.max(0, this.activeContexts - 1);
    this.browserWaiters.shift()?.();
  }

  /**
   * Launches (or returns the already-running) headless Chromium instance.
   * The browser is reused across scrapes and torn down via `close()`.
   *
   * HEADLESS IS NOT A DEFAULT HERE, IT IS A CONSTRAINT. This node forages and
   * scrapes unattended, often overnight, while the operator is doing something
   * else on the same machine. A headed Chromium is a foreground GUI window: it
   * appears over whatever was on screen and takes the caret, which is the exact
   * failure this whole file's launch options exist to prevent. Do NOT switch
   * `headless` to false, do NOT pass `--headless=false`, `--start-maximized`,
   * `--kiosk` or `--app=` to "see what it is doing" — use
   * `captureViewport()` below, which reports the rendered page as a JPEG on the
   * dashboard with no window at all.
   *
   * Playwright's own Chromium launcher already passes `windowsHide` on Windows,
   * so no console flashes here even though the binary is spawned for us.
   */
  private async getBrowser(): Promise<Browser> {
    if (this.browser && this.browser.isConnected()) {
      return this.browser;
    }

    // First launch waits for the background bootstrap download (if one ran).
    await this.chromiumReady;

    this.browser = await loadChromium().chromium.launch({
      headless: true,
      // Deliberately minimal. `--disable-blink-features=AutomationControlled`
      // is the only flag, and it is anti-bot-detection, not window control.
      // Anything that turns this into a visible window must not be added here.
      args: ["--disable-blink-features=AutomationControlled"],
    });

    // If Chromium dies underneath us, drop the handle so the next scrape relaunches.
    this.browser.on("disconnected", () => {
      this.browser = null;
    });

    console.log("[Scraper] Headless Chromium launched.");
    publishScrape("launch", "Headless Chromium launched — eyes open.");
    return this.browser;
  }

  /**
   * CAPTURES WHAT CHROMIUM IS ACTUALLY LOOKING AT.
   *
   * This is the "live viewport" panel in the Control Center: the operator can see
   * the page the node is reading, which is the difference between "the scraper says
   * it worked" and "I can see it working".
   *
   * THREE GUARDS, BECAUSE THIS RUNS ON THE SCRAPE HOT PATH:
   *
   *   1. SKIPPED ENTIRELY WITH NO DASHBOARD WATCHING. A screenshot costs a render
   *      and a JPEG encode. This node forages unattended overnight; paying that on
   *      every scrape for nobody to look at it is pure waste.
   *   2. JPEG at quality 40 and a downscaled viewport. The panel is ~500px wide;
   *      a full-fidelity PNG would be both larger on the wire and slower to encode.
   *   3. NEVER THROWS. If the page is mid-navigation, mid-teardown, or the context
   *      died, the capture is skipped. A screenshot failing must NEVER turn a
   *      successful scrape into a failed one.
   */
  private async captureViewport(page: Page, url: string): Promise<void> {
    if (!hasSubscribers()) return;
    try {
      const buffer = await page.screenshot({
        type: "jpeg",
        quality: 40,
        // "css" keeps the capture at the CSS pixel size rather than device pixels,
        // which halves the bytes on a HiDPI viewport for no visible difference here.
        scale: "css",
        timeout: 5_000,
      });
      const title = (await page.title().catch(() => "")) || url;
      publishViewport({
        dataUrl: `data:image/jpeg;base64,${buffer.toString("base64")}`,
        title,
        url,
      });
    } catch {
      // A page that navigates away mid-capture is normal, not an error worth
      // surfacing. The crawl stream already says what is happening.
    }
  }

  /** Scrapes a URL and returns sanitized body text. Throws on navigation failure / empty page. */
  async scrape(url: string, signal?: AbortSignal): Promise<ScrapeResult> {
    /*
      THE MOBILE FALLBACK, taken BEFORE any Playwright call.

      Placed at the top rather than deep inside `getBrowser()` on purpose: the
      decision is per-runtime, not per-browser-instance, and failing to take it
      early would mean constructing a Chromium context on a device that cannot
      run one. The returned shape is identical either way, so the caller (the
      idle forager) has no idea which engine produced the text.

      PREEMPTIBLE: the caller's AbortSignal is forwarded so a PRIORITY task
      arriving mid-scrape kills the fetch immediately.
    */
    if (!this.canUseBrowser) {
      publishScrape("idle", "Lightweight fetch scraper in use (no Chromium on this runtime).", url);
      return scrapeMobile(url, signal);
    }

    /*
      THE RUNTIME SAID YES BUT THE BROWSER IS NOT THERE.

      `canUseBrowser` is a statement about the RUNTIME (this is Node, not a
      WebView). It is not a promise that Chromium exists: on a packaged exe the
      download can still be in flight, fail, or never have been reached. Waiting
      for that verdict here — once, on the first scrape — and permanently
      demoting to the fetch scraper is what turns a failed Chromium install into
      a degraded node instead of a permanently broken one. Without this check the
      code below would call `chromium.launch()` against a binary that is not
      there and throw on every single task, forever.
    */
    await this.chromiumReady;
    if (chromiumUnavailable) {
      this.canUseBrowser = false;
      console.log(
        "[Scraper] No Chromium available — this node will use the lightweight fetch scraper.",
      );
      return scrapeMobile(url, signal);
    }

    /*
      A LAUNCH THAT FAILS IS ALSO A DEGRADATION, NOT A CRASH.

      Everything above can succeed — runtime is Node, the binary was found — and
      still fail here: the binary is corrupt, blocked by antivirus, or missing a
      system library. That must cost this node its browser scraping and nothing
      else, so the instance is demoted (which also stops `isBrowserBacked()`
      reporting a capability that does not work) and the caller falls back.
    */
    let browser: Browser;
    try {
      browser = await this.getBrowser();
    } catch (error) {
      this.canUseBrowser = false;
      console.warn(
        `[Scraper] Chromium failed to launch — ${
          error instanceof Error ? error.message : String(error)
        }. Using the lightweight fetch scraper instead.`,
      );
      return scrapeMobile(url, signal);
    }
    /*
      RESOURCE GOVERNOR — MEMORY GUARD.

      Opening a Chromium context is the single heaviest thing this node does, so
      it is exactly what the Governor exists to bound. When the host is already
      over its configured RAM limit, the browser is skipped for this pass and the
      lightweight scraper is used instead — pausing the heavy tier is the point,
      so the machine is never pushed into swap just to keep foraging.
    */
    if (this.governor?.isMemoryExceeded()) {
      publishScrape(
        "idle",
        "[GOVERNOR] Memory limit exceeded — using lightweight fetch scraper.",
        url,
      );
      return scrapeMobile(url, signal);
    }

    /*
      RESOURCE GOVERNOR — CONCURRENCY GATE.

      Wait for a free browser slot BEFORE opening the context, so no more than
      the Governor's `max_concurrent_tasks` contexts are ever open at once. The
      slot is handed back in the `finally` below (success and failure alike), and
      also on a context-launch error, so a failed launch cannot leak a slot.
    */
    await this.acquireBrowserSlot();
    let context: BrowserContext;
    try {
      context = await browser.newContext({
        // en-AU + a stock desktop UA keeps the parse honest for AU-targeted pages.
        locale: "en-AU",
        userAgent:
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        viewport: { width: 1366, height: 768 },
      });
    } catch (contextError) {
      this.releaseBrowserSlot();
      throw contextError;
    }

    try {
      const page = await context.newPage();
      publishScrape("navigate", `[NAVIGATE] ${url}`, url);
      // PREEMPTIBLE NAVIGATION: Playwright has no native AbortSignal for
      // `page.goto`, so the goto races a promise that rejects the instant the
      // engine's controller fires. The page/context close in `finally` then
      // frees Chromium for the incoming PRIORITY task.
      const response = await raceWithAbort(
        page.goto(url, {
          waitUntil: "domcontentloaded",
          timeout: NAV_TIMEOUT_MS,
        }),
        signal,
      );

      const status = response?.status();
      publishScrape(
        status !== undefined && status >= 400 ? "error" : "status",
        `[STATUS ${status ?? "?"}]`,
        url,
      );
      if (status !== undefined && status >= 400) {
        throw new Error(`HTTP ${status} for ${url}`);
      }
      throwIfScrapeAborted(signal);

      // Let lazy-loaded content settle, but never block longer than the cap.
      await page.waitForLoadState("networkidle", { timeout: NETWORK_IDLE_CAP_MS }).catch(() => undefined);

      const title = (await page.title().catch(() => "")) || url;
      // Taken before extraction so the operator sees the page as Chromium rendered
      // it, not as the sanitiser will go on to strip it down to.
      await this.captureViewport(page, url);
      throwIfScrapeAborted(signal);
      const text = await extractSanitizedBody(page);

      if (!text) {
        publishScrape("error", `[EXTRACT] no usable body text`, url);
        throw new Error(`No extractable body text at ${url}`);
      }

      publishScrape(
        "extract",
        `[EXTRACT] ${text.length.toLocaleString("en-AU")} chars · ${countPlaceCandidates(text)} place candidates`,
        url,
      );
      return { url, title, text };
    } catch (error) {
      publishScrape(
        "error",
        `[FAIL] ${error instanceof Error ? error.message : String(error)}`,
        url,
      );
      throw error;
    } finally {
      // One context per scrape: cookies/storage never leak between sources.
      await context.close().catch(() => undefined);
      // Hand the Governor's browser slot back, whatever the outcome.
      this.releaseBrowserSlot();
    }
  }

  /** Closes the shared Chromium instance. Safe to call multiple times. */
  async close(): Promise<void> {
    if (this.browser) {
      const browser = this.browser;
      this.browser = null;
      await browser.close().catch(() => undefined);
      console.log("[Scraper] Headless Chromium closed.");
      publishScrape("close", "Headless Chromium closed.");
    }
  }

  /**
   * SELF-HEAL — the Playwright Scraper panel's repair routine. Kills the
   * current browser instance (clearing any stuck/zombie Chromium process),
   * resets the Chromium-unavailable verdict so a resolved network issue is
   * retried, and re-launches a fresh instance.
   */
  async selfHeal(): Promise<{ healed: boolean; message: string }> {
    try {
      await this.close();
      chromiumUnavailable = false;
      chromiumBootstrap = null;
      this.canUseBrowser = supportsBrowserScraping();
      if (this.canUseBrowser) {
        await ensureChromiumInstalled();
        await this.getBrowser();
      }
      return {
        healed: true,
        message: this.canUseBrowser
          ? "Scraper self-heal complete — Chromium relaunched."
          : "Scraper self-heal complete — this runtime uses the lightweight fetch scraper.",
      };
    } catch (error) {
      this.canUseBrowser = false;
      const message = error instanceof Error ? error.message : String(error);
      return { healed: false, message: `Self-heal failed — ${message}` };
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

/**
 * Races a Playwright promise against an AbortSignal.
 *
 * Playwright's navigation API predates AbortSignal, so cancellation is a race:
 * when the engine fires its controller the race rejects immediately while the
 * underlying goto is abandoned with the context close. No signal (or an
 * already-settled promise) means this is a transparent passthrough.
 */
function raceWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error("Aborted"));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(signal.reason instanceof Error ? signal.reason : new Error("Aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/** Throws when the engine preempted the scrape between navigation steps. */
function throwIfScrapeAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error("Aborted");
  }
}

/**
 * COUNTS THINGS WORTH SENDING TO THE LLM — a cheap "is this page worth anything?"
 * signal for the live crawl stream, and the zero-yield detector behind the
 * forager's 7-day crawl cooldown.
 *
 * THE HEURISTIC IS DELIBERATELY CRUDE AND DELIBERATELY NOT A CLAIM. It counts lines
 * that mention a named place-type or carry coordinates, because that is what the
 * extractor downstream actually wants. It is shown to an operator as "N place
 * candidates" — a glanceable hint about yield, not a verdict.
 *
 * ONE BEHAVIOUR NOW DEPENDS ON IT READING ZERO: a page that reads cleanly (HTTP 200)
 * but yields no candidate lines is treated as zero-yield — the forager marks it
 * completed and cools the URL down for a week instead of re-crawling it on every
 * pass forever. A false zero therefore delays ONE url's re-check by seven days,
 * the cheapest possible failure mode for a deliberately crude counter.
 *
 * `countPlaceCandidates` rather than a general "score" so the terminal line reads as
 * what it is: a rough count, not a score the node trusts.
 */
export function countPlaceCandidates(text: string): number {
  const patterns =
    /\b(?:national park|state park|reservoir|campground|campsite|caravan park|lookout|waterfall|beach|track|trail|gorge|creek|river|mountain|lagoon|hot springs)\b/gi;
  const coords = /-?\d{1,3}\.\d{3,}\s*,\s*-?\d{1,3}\.\d{3,}/g;
  const lines = String(text ?? "").split("\n");
  let hits = 0;
  for (const line of lines) {
    if (patterns.test(line) || coords.test(line)) hits += 1;
    // Global regexes carry lastIndex between calls, so reset rather than let a
    // second line silently skip the match — the same trap as in verify-mobile.
    patterns.lastIndex = 0;
    coords.lastIndex = 0;
  }
  return hits;
}
