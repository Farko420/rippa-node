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
function parseVersion(value: string): [number, number, number] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(value.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/**
 * True when `candidate` is strictly newer than `current`.
 *
 * Unparseable input on either side returns `false` (never update), which keeps
 * an unresolvable local version or a malformed Mothership response from
 * triggering an endless restart loop.
 */
export function isVersionNewer(candidate: string, current: string = APP_VERSION): boolean {
  const next = parseVersion(candidate);
  const mine = parseVersion(current);
  if (!next || !mine) return false;

  for (let index = 0; index < 3; index += 1) {
    if (next[index] !== mine[index]) {
      return next[index] > mine[index];
    }
  }
  return false; // same core version — prerelease tags do not force an update
}