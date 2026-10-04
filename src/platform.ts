/**
 * RUNTIME CAPABILITY DETECTION — one place that answers "what can this build
 * actually do?".
 *
 * WHY THIS EXISTS. The node ships in three very different runtimes, and each can
 * do a different subset of the work:
 *
 *   1. `tsx src/index.ts` / `node dist/index.js` — full Node. Playwright works.
 *   2. the `pkg`-built `rippa-node.exe` — full Node, frozen FS. Works.
 *   3. the Capacitor Android APK — a JavaScript WebView. There is NO Node process,
 *      no `child_process`, no `better-sqlite3` native addon and no Chromium binary
 *      that Playwright could drive.
 *
 * Code reaching for a desktop-only capability has to ask first. Previously it
 * reached unconditionally: `ScraperService` called `ensureChromiumInstalled()` in
 * its constructor, which reaches for `node:child_process` and installs the
 * Playwright browser. Inside an APK that require throws, every idle foraging
 * pass throws, and the node looks permanently broken on a tablet.
 *
 * EVERY PROBE IS DEFENSIVE. This module is imported by code that also runs in a
 * WebView where `process` may be undefined. A detection helper that throws while
 * working out the platform would be worse than useless, so each check is wrapped
 * and defaults to the conservative answer.
 */

/** The coarse runtime families the node distinguishes. */
export type RuntimeFlavor =
  /** Playwright + native modules available (dev, compiled, packaged exe). */
  | "node"
  /** A browser-like sandbox: the Capacitor WebView on Android/iOS. */
  | "webview"
  /** A Node process that still cannot spawn binaries (sandboxed/managed). */
  | "restricted";

/**
 * True when running inside a real Node process.
 *
 * Checked via `process.versions.node` rather than `typeof process` alone: a
 * WebView can have a `process` shim injected by a bundler, which would otherwise
 * make every desktop check "succeed" and send the APK down the Playwright path.
 */
function hasNodeRuntime(): boolean {
  try {
    const proc = (globalThis as { process?: { versions?: { node?: string } } }).process;
    return typeof proc?.versions?.node === "string" && proc.versions.node.length > 0;
  } catch {
    return false;
  }
}

/**
 * True when the host exposes the Capacitor native bridge.
 *
 * The most reliable mobile signal available from JavaScript: the bridge is
 * injected by the native shell before any page script runs, so it is present in
 * release builds with no debug logging enabled.
 */
function hasCapacitorBridge(): boolean {
  try {
    const capacitor = (
      globalThis as {
        Capacitor?: { isNativePlatform?: () => boolean; getPlatform?: () => string };
      }
    ).Capacitor;
    if (!capacitor) return false;
    if (typeof capacitor.isNativePlatform === "function") return capacitor.isNativePlatform();
    return typeof capacitor.getPlatform === "function";
  } catch {
    return false;
  }
}

/** The user agent string, or "" when there is no DOM. */
function userAgent(): string {
  try {
    const nav = (globalThis as { navigator?: { userAgent?: string } }).navigator;
    return typeof nav?.userAgent === "string" ? nav.userAgent : "";
  } catch {
    return "";
  }
}

/**
 * True when this build is running as an ANDROID native app (the APK).
 *
 * Deliberately narrow: it must not fire for a desktop browser, nor for a Node
 * process that merely mentions Android in its UA (some crawlers do). The
 * Capacitor bridge is required, which is exactly the native case.
 */
export function isAndroid(): boolean {
  if (!hasCapacitorBridge()) return false;
  try {
    const platform = (globalThis as { Capacitor?: { getPlatform?: () => string } }).Capacitor
      ?.getPlatform?.();
    if (typeof platform === "string" && platform.length > 0) {
      return platform.toLowerCase() === "android";
    }
  } catch {
    /* fall through to the UA check */
  }
  return /android/i.test(userAgent());
}

/** True when this build is running as an iOS/iPadOS native app. */
export function isIOS(): boolean {
  if (!hasCapacitorBridge()) return false;
  try {
    const platform = (globalThis as { Capacitor?: { getPlatform?: () => string } }).Capacitor
      ?.getPlatform?.();
    if (typeof platform === "string" && platform.length > 0) {
      const name = platform.toLowerCase();
      return name === "ios" || name === "ipad";
    }
  } catch {
    /* fall through */
  }
  return /iphone|ipad|ipod/i.test(userAgent());
}

/**
 * True on ANY mobile build (the APK or an iOS wrapper).
 *
 * This is the switch the scraping fallback keys off: neither runtime can launch
 * a Chromium binary, so both take the lightweight path.
 */
export function isMobile(): boolean {
  return isAndroid() || isIOS();
}

/**
 * True when this runtime can spawn a child process.
 *
 * Separate from `hasNodeRuntime` because a Node build can still be sandboxed
 * (managed/container hosts block `spawn`). Treating "has Node" as "can spawn" is
 * what made the Playwright bootstrap fail confusingly inside the APK.
 */
export function canSpawnProcesses(): boolean {
  if (!hasNodeRuntime()) return false;
  try {
    const proc = (
      globalThis as { process?: { versions?: { node?: string }; platform?: string } }
    ).process;
    // Windows/POSIX only. Anything else cannot run a .exe/Chromium anyway.
    return proc?.platform === "win32" || proc?.platform === "linux" || proc?.platform === "darwin";
  } catch {
    return false;
  }
}

/**
 * The single question the scraper asks before touching Playwright.
 *
 * False in a WebView and on any runtime that cannot spawn — exactly the set of
 * environments where the Playwright browser installer and `chromium.launch()`
 * are guaranteed to fail.
 */
export function supportsBrowserScraping(): boolean {
  return hasNodeRuntime() && canSpawnProcesses() && !isMobile();
}

/** Which runtime family this is. Used in boot logs and on the health endpoint. */
export function runtimeFlavor(): RuntimeFlavor {
  if (isMobile()) return "webview";
  if (hasNodeRuntime()) return canSpawnProcesses() ? "node" : "restricted";
  return "webview";
}

/** One-line runtime description for logs and diagnostics. */
export function describeRuntime(): string {
  const platform = (() => {
    try {
      return (globalThis as { process?: { platform?: string } }).process?.platform ?? "webview";
    } catch {
      return "webview";
    }
  })();
  const detail = isAndroid()
    ? "android"
    : isIOS()
      ? "ios"
      : hasCapacitorBridge()
        ? "capacitor"
        : "none";
  return `${runtimeFlavor()} (platform=${platform}, mobileBridge=${detail})`;
}

/**
 * Capability summary exposed by the local health endpoint.
 *
 * Lets an operator confirm on the tablet — or from the LAN — that the build is
 * actually taking the mobile scraping path, instead of inferring it from a log
 * line nobody can read on a headless overnight run.
 */
export interface RuntimeCapabilities {
  flavor: RuntimeFlavor;
  platform: string;
  isMobile: boolean;
  isAndroid: boolean;
  /** False means "use the lightweight fetch scraper, not Playwright". */
  browserScraping: boolean;
  description: string;
}

export function runtimeCapabilities(): RuntimeCapabilities {
  let platform = "webview";
  try {
    platform = (globalThis as { process?: { platform?: string } }).process?.platform ?? "webview";
  } catch {
    /* keep the default */
  }
  return {
    flavor: runtimeFlavor(),
    platform,
    isMobile: isMobile(),
    isAndroid: isAndroid(),
    browserScraping: supportsBrowserScraping(),
    description: describeRuntime(),
  };
}