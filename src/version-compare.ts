/**
 * SEMANTIC VERSION COMPARISON — the one implementation of "is this newer?".
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM `src/version.ts`. That module reads the
 * running build's version with `require("../package.json")` at module load, which
 * is exactly right for Node and for the `pkg`-built .exe but fatal inside the
 * Android WebView: the bundle has no `require`, and the bundler's Node-leakage
 * guard fails the build on the mere mention of it. The COMPARISON, though, is pure
 * string work and is wanted by three callers that share it:
 *
 *   - `src/version.ts`        the desktop OTA updater (wraps this, defaulting
 *                             `current` to APP_VERSION)
 *   - `src/services/updater.ts`, `src/update/OtaUpdater.ts`, `src/server.ts`
 *   - `mobile/src/worker.ts`   the satellite's in-app APK update check
 *
 * So the pure half lives here, dependency-free and importable from either runtime,
 * and `src/version.ts` keeps its existing exports unchanged. Nothing is duplicated
 * and nothing is reimplemented.
 */

/** Extracts `[major, minor, patch]` from "v1.2.3" / "1.2.3-beta.1", or null. */
export function parseVersion(value: string): [number, number, number] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(value ?? "").trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/**
 * True when `candidate` is strictly newer than `current`.
 *
 * Unparseable input on EITHER side returns `false` (never update), which keeps an
 * unresolvable local version or a malformed Mothership response from triggering an
 * endless restart loop — or, on a tablet, an endless reinstall prompt for a build
 * that was never actually published.
 *
 * Both arguments are required here (no default) precisely so this module stays free
 * of the package.json lookup. `src/version.ts` supplies the default for Node.
 */
export function isVersionNewer(candidate: string, current: string): boolean {
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