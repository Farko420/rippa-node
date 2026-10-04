import fs from "node:fs";
import path from "node:path";
import extract from "extract-zip";

/**
 * PROGRAMMATIC PLAYWRIGHT BROWSER INSTALLATION.
 *
 * WHY THIS FILE EXISTS. The bootstrap used to run `npx playwright install
 * chromium` in a detached child process. That is unreliable in precisely the
 * environments this app ships to, and the failure looked like a network fault:
 *
 *   * inside a `pkg` snapshot there is no `node_modules` on disk, so `npx` has
 *     nothing to resolve and exits non-zero immediately;
 *   * a Windows host with no global Node.js has no `npx` on PATH at all, so the
 *     spawn raises ENOENT and no browser is ever fetched;
 *   * `npx --yes playwright@x.y.z` re-downloads the whole Playwright package
 *     from npm on every first boot, which is slow and fails behind a proxy even
 *     when the browser CDN itself is perfectly reachable.
 *
 * So the install now happens IN-PROCESS, through the same internal registry that
 * `playwright-core/cli.js` drives (`coreBundle.registry.install`), with a direct
 * CDN + unzip fallback for the case where even that cannot run. Nothing here
 * spawns a shell and nothing here needs `npx`.
 *
 * ORDER OF ESCALATION:
 *   1. `coreBundle.registry.install([...])` — the real installer, the same code
 *      path as the CLI, minus the shell.
 *   2. A direct HTTPS download of the Chromium zip from the Playwright CDN,
 *      unzipped into `PLAYWRIGHT_BROWSERS_PATH` with the `INSTALLATION_COMPLETE`
 *      marker written so the registry accepts that copy later.
 *
 * Never throws: every entry point resolves with a result describing what
 * happened, because the caller is a boot-time capability check that must not be
 * able to take the node down.
 */

/** Playwright's browser CDN base. A constant so a mirror is a one-line edit. */
const PLAYWRIGHT_CDN_BASE = "https://cdn.playwright.dev";

/** Directory a browser unpacks into, e.g. `chromium-win64/chrome.exe`. */
const CHROMIUM_ZIP_DIR = "win64";

/** Marker file the Playwright registry treats as "this browser is complete". */
const INSTALLATION_MARKER = "INSTALLATION_COMPLETE";

export type BrowserInstallMethod = "registry" | "cdn" | "none";

export interface BrowserInstallResult {
  ok: boolean;
  /** Which strategy actually installed (or verified) the browser. */
  method: BrowserInstallMethod;
  /** Operator-facing explanation. Returned, never thrown. */
  detail: string;
}

export interface InstallOptions {
  /**
   * Destination for the browser registry. Forced onto `PLAYWRIGHT_BROWSERS_PATH`
   * BEFORE Playwright is loaded, because the registry directory is computed at
   * module-evaluation time and cannot be changed afterwards.
   */
  browsersPath?: string;
  logPrefix?: string;
  /** Resolves the Chromium executable, so "installed" is verified not assumed. */
  executablePath?: () => string | null;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * FORCES `PLAYWRIGHT_BROWSERS_PATH` and makes sure the directory exists.
 *
 * MUST run before anything touches `playwright-core`: `registryDirectory` is a
 * module-level constant inside the core bundle, so a value assigned afterwards
 * is silently ignored and the install lands wherever the snapshot's virtual
 * filesystem points — which is the original "Chromium fails to install on boot"
 * bug in packaged builds.
 */
export function forceBrowsersPath(browsersPath: string): void {
  if (!browsersPath) return;
  process.env.PLAYWRIGHT_BROWSERS_PATH = browsersPath;
  try {
    fs.mkdirSync(browsersPath, { recursive: true });
  } catch (error) {
    console.warn(`[Scraper] Could not create ${browsersPath} — ${describeError(error)}`);
  }
}

/** True when Playwright can already find a Chromium binary on disk. */
function alreadyInstalled(executablePath: () => string | null): boolean {
  const executable = executablePath();
  return Boolean(executable && fs.existsSync(executable));
}

/** The slice of playwright-core's internal Registry this module drives. */
interface PlaywrightRegistry {
  findExecutable: (name: string) => { name: string; installType?: string } | null;
  install: (executables: unknown[], options?: Record<string, unknown>) => Promise<unknown>;
}

/**
 * STRATEGY 1 — the internal Playwright registry, driven programmatically.
 *
 * `require("playwright-core/cli")` is deliberately NOT used: `cli.js` calls
 * `program.parse(process.argv)` at MODULE SCOPE, which would hijack this
 * process's argv and try to interpret the node's own command line as Playwright
 * CLI arguments. The core bundle exports the registry itself, and that is the
 * part that actually downloads browsers — so that is what is driven here.
 */
async function installViaRegistry(): Promise<void> {
  const bundle = require("playwright-core/lib/coreBundle") as {
    registry?: { registry?: PlaywrightRegistry };
  };
  // `coreBundle.registry` is the MODULE NAMESPACE; the live Registry singleton
  // with `.install()` / `.findExecutable()` hangs off it as `.registry`. Reading
  // one level too shallow yields an object with no `install`, which is exactly
  // the silent "this build of playwright-core does not support installing" that
  // sent us to the CDN fallback for no reason.
  const registry = bundle?.registry?.registry;
  if (!registry || typeof registry.install !== "function") {
    throw new Error("playwright-core does not expose its internal registry");
  }

  const executable = registry.findExecutable("chromium");
  if (!executable || executable.installType === "none") {
    throw new Error("chromium is not a downloadable executable on this platform");
  }

  await registry.install([executable], {
    /*
      Playwright's garbage collector deletes browser folders it believes no
      installed package refers to. In a SHARED AppData directory that is a
      genuine hazard — and the browser being installed here is precisely the
      kind of folder it sweeps — so it is turned off.
    */
    gc: false,
  });
}

/**
 * Reads Chromium's CDN coordinates out of the bundled `browsers.json`.
 *
 * TWO VALUES, NOT ONE. The CDN path is keyed on `browserVersion`
 * (`builds/cft/153.0.8010.12/win64/chrome-win64.zip`) while the on-disk
 * directory is keyed on `revision` (`chromium-1243`). Using one for both is how a
 * manual download ends up in a folder Playwright never looks in — the file is
 * there and `chromium.launch()` still throws "Executable doesn't exist".
 *
 * `require.resolve` finds the package root so this also works inside the `pkg`
 * snapshot, where `browsers.json` is a declared asset.
 */
export function readChromiumCoordinates(): { browserVersion: string; revision: string } {
  const path = require("node:path") as typeof import("node:path");
  const fsModule = require("node:fs") as typeof import("node:fs");
  // `browsers.json` is a SIBLING of package.json, not a field of it.
  const descriptorPath = path.join(
    path.dirname(require.resolve("playwright-core/package.json")),
    "browsers.json",
  );
  const manifest = JSON.parse(fsModule.readFileSync(descriptorPath, "utf8")) as {
    browsers?: {
      name: string;
      revision: string;
      browserVersion?: string;
      revisionOverrides?: Record<string, string>;
    }[];
  };
  const descriptor = (manifest.browsers ?? []).find((entry) => entry.name === "chromium");
  const revision =
    descriptor?.revisionOverrides?.[process.platform] ?? descriptor?.revision;
  const browserVersion = descriptor?.browserVersion;
  if (!revision || !browserVersion) {
    throw new Error("browsers.json declares no usable chromium revision/browserVersion");
  }
  return { revision, browserVersion };
}

/**
 * STRATEGY 2 — direct download from the Playwright CDN.
 *
 * Only reached when the internal registry cannot run (a snapshot missing
 * `coreBundle`, a locked registry directory, an exotic host). Downloads the
 * platform zips for the pinned version, unzips them into place and writes the
 * `INSTALLATION_COMPLETE` marker so strategies 1 and 3 accept the result.
 *
 * BOTH ARCHIVES ARE REQUIRED, NOT ALTERNATIVE CANDIDATES. Playwright 1.49+
 * resolves `chromium.launch()` to the HEADLESS SHELL — a separate binary in a
 * separate directory (`chromium_headless_shell-<rev>`) — and falls back to full
 * Chromium only when the shell is absent AND a channel is requested. Installing
 * just `chrome-win64.zip` therefore produces a browser that downloads
 * successfully, passes every "is it there?" check here, and still throws
 * "Executable doesn't exist" at launch. Both go in, or the fallback is useless.
 */
async function installViaCdn(prefix: string): Promise<void> {
  const browsersPath = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (!browsersPath) throw new Error("PLAYWRIGHT_BROWSERS_PATH is not set");

  const { revision, browserVersion } = readChromiumCoordinates();
  const hostPlatform = process.platform === "win32" ? "win64" : process.platform;

  const archives: { file: string; dir: string }[] = [
    { file: `chrome-${hostPlatform}.zip`, dir: `chromium-${revision}` },
    {
      file: `chrome-headless-shell-${hostPlatform}.zip`,
      dir: `chromium_headless_shell-${revision}`,
    },
  ];

  let lastError = "";
  for (const { file, dir } of archives) {
    const url = `${PLAYWRIGHT_CDN_BASE}/builds/cft/${browserVersion}/${CHROMIUM_ZIP_DIR}/${file}`;
    const zipPath = path.join(browsersPath, `${file}.part`);
    // `<name>-<revision>` is the directory name the registry looks in — built
    // from `revision`, never from `browserVersion`, or Playwright will not see
    // the download at all.
    const target = path.join(browsersPath, dir);
    try {
      console.log(`${prefix} Fetching ${url} …`);
      const response = await fetch(url, {
        signal: AbortSignal.timeout(15 * 60_000),
        headers: { "User-Agent": "rippa-node-scraper" },
      });
      if (!response.ok) {
        lastError = `${file} → HTTP ${response.status}`;
        continue;
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length < 1024) {
        lastError = `${file} → only ${buffer.length} bytes`;
        continue;
      }
      fs.writeFileSync(zipPath, buffer);
      fs.rmSync(target, { recursive: true, force: true });
      fs.mkdirSync(target, { recursive: true });
      await extract(zipPath, { dir: target });
      /*
        The registry refuses to launch a browser folder without this marker, so
        writing it is what makes a CDN-installed browser usable at all — without
        it `chromium.launch()` still throws "Executable doesn't exist".
      */
      fs.writeFileSync(path.join(target, INSTALLATION_MARKER), "", "utf8");
      fs.rmSync(zipPath, { force: true });
      console.log(`${prefix} Unpacked ${file} into ${target}`);
    } catch (error) {
      lastError = `${file} → ${describeError(error)}`;
    }
  }
  if (lastError) console.warn(`${prefix} Last CDN failure: ${lastError}`);
}

/**
 * Installs Chromium, escalating from the internal registry to a direct CDN
 * download. Never throws — inspect `ok` and `detail`.
 */
export async function installChromium(
  options: InstallOptions = {},
): Promise<BrowserInstallResult> {
  const prefix = options.logPrefix ?? "[Scraper]";
  const executablePath = options.executablePath ?? (() => null);

  // Must precede every Playwright import, in every runtime.
  if (options.browsersPath) forceBrowsersPath(options.browsersPath);

  if (alreadyInstalled(executablePath)) {
    return { ok: true, method: "registry", detail: "already installed" };
  }

  try {
    await installViaRegistry();
    if (alreadyInstalled(executablePath)) {
      return { ok: true, method: "registry", detail: "installed by the Playwright registry" };
    }
  } catch (error) {
    console.warn(
      `${prefix} The bundled Playwright registry could not install Chromium ` +
        `(${describeError(error)}) — falling back to a direct CDN download.`,
    );
  }

  try {
    await installViaCdn(prefix);
    if (alreadyInstalled(executablePath)) {
      return { ok: true, method: "cdn", detail: "installed from the Playwright CDN" };
    }
    return {
      ok: false,
      method: "cdn",
      detail: "the CDN download reported success but no executable was found",
    };
  } catch (error) {
    return { ok: false, method: "none", detail: describeError(error) };
  }
}