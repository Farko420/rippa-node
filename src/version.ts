/**
 * APP VERSION — the single source of truth for OTA comparisons.
 *
 * The version lives in `package.json`. It is read with `require()` (rather
 * than a static `import`) so the exact same lookup works in all three run
 * modes: `tsx src/index.ts` (dev), `node dist/index.js` (compiled) and the
 * `pkg`-built `rippa-node.exe` (where `require` resolves inside the snapshot).
 *
 * `global.APP_VERSION` is published for code that has no import path handy
 * (health probes, log scrapers, the OTA updater itself).
 */

import { isVersionNewer as isNewer } from "./version-compare";

declare global {
  /** Version of the running build, sourced from package.json. */
  // eslint-disable-next-line no-var
  var APP_VERSION: string | undefined;
}

/**
 * Used when package.json cannot be read. Deliberately NOT a valid semver
 * string: `isVersionNewer()` refuses to compare unparseable versions, so a
 * broken lookup disables OTA instead of triggering a bogus self-update.
 */
const UNKNOWN_VERSION = "unknown";

/** Reads `version` out of the project manifest, or `UNKNOWN_VERSION`. */
function readManifestVersion(): string {
  try {
    // Two levels up from `src/version.ts` / `dist/version.js` = project root.
    const manifest = require("../package.json") as { version?: unknown };
    const version = manifest?.version;
    if (typeof version === "string" && version.trim().length > 0) {
      return version.trim();
    }
    console.warn("[Version] package.json has no usable `version` field.");
  } catch (error) {
    console.warn(
      `[Version] Could not read package.json — ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return UNKNOWN_VERSION;
}

/** The running build's version, e.g. "1.0.0". */
export const APP_VERSION: string = readManifestVersion();

/** False when the version came from {@link UNKNOWN_VERSION} (OTA stays off). */
export const APP_VERSION_RESOLVED: boolean = APP_VERSION !== UNKNOWN_VERSION;

// Publish to the runtime context for non-importing callers.
globalThis.APP_VERSION = APP_VERSION;

/** Extracts `[major, minor, patch]` from "v1.2.3" / "1.2.3-beta.1", or null. */
export { parseVersion } from "./version-compare";

/**
 * True when `candidate` is strictly newer than `current`.
 *
 * Unparseable input on either side returns `false` (never update), which keeps
 * an unresolvable local version or a malformed Mothership response from
 * triggering an endless restart loop.
 *
 * THE COMPARISON ITSELF LIVES IN `./version-compare`, because it is pure string
 * work that the Android WebView also needs (mobile/src/worker.ts runs the same
 * check against the Mothership to drive the in-app APK updater) and this file
 * cannot be imported there — it reads package.json with `require()` at module
 * load. `current` keeps its APP_VERSION default here so every Node call site
 * keeps working exactly as it did.
 */
export function isVersionNewer(candidate: string, current: string = APP_VERSION): boolean {
  return isNewer(candidate, current);
}