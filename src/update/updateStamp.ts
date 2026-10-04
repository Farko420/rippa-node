import fs from "node:fs";
import path from "node:path";
import { ensureDataDir } from "../utils/paths";
import { APP_VERSION } from "../version";

/**
 * VERSION & UPDATE TRACKING — what build is this, and when did it arrive.
 *
 * WHY THIS EXISTS SEPARATELY FROM `telemetry.ts`. The Mothership's Swarm Grid
 * shows a per-node version column, and "which build" and "how stale is it" are
 * two different questions. `getSystemVitals()` answers the second from live
 * `node:os` counters; this module answers both from persisted state, and one of
 * its two values has to survive a process restart to be worth anything.
 *
 * THE TIMESTAMP IS A STAMP FILE, NOT A FILE MTIME. `package.json`'s mtime is
 * the wrong signal for three reasons:
 *   - a `git pull` or a rebuild touches it without changing what is deployed;
 *   - inside the `pkg` snapshot the manifest's mtime is the BUILD MACHINE's
 *     clock, so every node on a release would report the same instant;
 *   - the file the swap actually replaces is `rippa-node.exe`, not package.json.
 *
 * So the stamp is written to the PERSISTENT data directory (`utils/paths`), which
 * the updater deliberately stages into precisely because it is the one place a
 * self-replacing binary is not allowed to destroy. Without that, every update
 * would also erase the evidence that an update happened.
 *
 * HOW THE STAMP GETS WRITTEN. Three writers, in order of authority:
 *   1. the watchdog, immediately after it renames the new executable into place
 *      (`src/watchdog.ts`) — the only point where "the update SUCCEEDED" is
 *      known;
 *   2. `OtaUpdater` just before handing the build off, so a failed swap still
 *      leaves evidence of the attempt;
 *   3. BOOT RECONCILIATION — if the stamp's version disagrees with the running
 *      `APP_VERSION`, the running binary is not the one that wrote the stamp, so
 *      it is stamped now. This is what makes the feature correct for installs
 *      updated by hand, or by an older build with no stamping at all.
 *
 * EVERY FUNCTION HERE NEVER THROWS. It runs on the heartbeat path, where an
 * exception would be reported as a failed heartbeat — a working node looking
 * broken because a stamp file could not be read.
 */

/** Stamp file name inside the persistent data directory. */
export const UPDATE_STAMP_FILE = "last-update.json";

/** What the stamp file holds. Both fields optional so a partial write still parses. */
export interface UpdateStamp {
  /** The version that was installed. */
  version?: string;
  /** ISO-8601 instant the install completed. */
  at?: string;
  /**
   * The GitHub Actions RUN ID this binary was installed from.
   *
   * WHY THIS EXISTS. OTA is now artifact-driven, and a workflow run ID is
   * strictly increasing where a version string is not: two builds can share a
   * `package.json` version, and a SemVer comparison then correctly refuses to
   * update even though the newer build is genuinely newer. Recording the run ID
   * gives the updater an unambiguous "is the remote newer than me" signal that
   * version-string coincidence cannot defeat.
   *
   * Optional and additive — a stamp written by an older build simply has none,
   * and the updater treats that as "build unknown", falling back to the version
   * comparison it has always used.
   */
  runId?: number;
}

/**
 * Absolute path of the stamp file, in the persistent data directory.
 *
 * Exported so tests and verification scripts can point at a real file rather
 * than mocking the filesystem.
 */
export function updateStampPath(): string {
  return path.join(ensureDataDir(), UPDATE_STAMP_FILE);
}

/**
 * Reads the persisted stamp, or `null` when there is none / it is unreadable.
 *
 * A corrupt or half-written file is treated as "no stamp" rather than an error:
 * the honest answer is "this node does not know when it was updated", and the
 * fallback chain in {@link getLastUpdatedAt} covers that case.
 */
export function readUpdateStamp(): UpdateStamp | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(updateStampPath(), "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const record = parsed as Record<string, unknown>;
    const version = typeof record.version === "string" ? record.version : undefined;
    const at = typeof record.at === "string" ? record.at : undefined;
    const runId = typeof record.runId === "number" && Number.isFinite(record.runId) ? record.runId : undefined;
    if (!version && !at) return null;
    return { version, at, ...(runId !== undefined ? { runId } : {}) };
  } catch {
    return null;
  }
}

/**
 * The workflow run ID of the build this node is currently running, or `null`.
 *
 * `null` means "unknown" — a stamp written by a build predating artifact OTA,
 * or no stamp at all — and every caller must treat it as "fall back to the
 * version comparison" rather than as "install unconditionally". Getting that
 * distinction wrong in the permissive direction would restart the fleet on
 * every single poll.
 */
export function installedRunId(): number | null {
  const runId = readUpdateStamp()?.runId;
  return typeof runId === "number" && Number.isFinite(runId) ? runId : null;
}

/**
 * Writes the stamp recording that `version` is now installed.
 *
 * Written via a temp file and renamed, so a crash mid-write cannot leave a
 * truncated JSON file that `readUpdateStamp()` would discard on every boot —
 * which would silently reset every node's "last updated" to the fallback.
 *
 * @returns the stamp written, or `null` when it could not be persisted.
 */
export function recordUpdateApplied(
  version: string = APP_VERSION,
  at?: string,
  runId?: number,
): UpdateStamp | null {
  const stamp: UpdateStamp = {
    version: String(version || APP_VERSION).trim(),
    at: at ?? new Date().toISOString(),
    // Preserved across a re-stamp: `reconcileUpdateStamp` re-stamps a build it
    // did not install, and dropping the run ID there would make the updater
    // believe it has never seen a build and re-download the same one forever.
    ...(runId ?? readUpdateStamp()?.runId ? { runId: runId ?? readUpdateStamp()?.runId } : {}),
  };
  try {
    const target = updateStampPath();
    const temporary = `${target}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(stamp, null, 2)}\n`, "utf8");
    fs.renameSync(temporary, target);
    return stamp;
  } catch (error) {
    console.warn(
      `[Version] Could not record the update stamp: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return null;
  }
}

/** Process boot instant, captured once, used as the last-resort fallback. */
const processStartedAt = new Date().toISOString();

/**
 * ISO-8601 instant this build last changed hands, or `null` if genuinely unknowable.
 *
 * RESOLUTION ORDER, most to least trustworthy:
 *   1. the stamp file, when its version matches the running build — it was
 *      written by the code that is actually running, so it is about THIS build;
 *   2. the `package.json` manifest's mtime, which is a real install event on an
 *      unpackaged (dev / `node dist/index.js`) node;
 *   3. this process's start time — honest, but a restart is not an update, so
 *      it is deliberately last rather than first.
 */
export function getLastUpdatedAt(): string | null {
  const stamp = readUpdateStamp();
  if (stamp?.at && stamp.version === APP_VERSION) return stamp.at;

  try {
    // Two levels up from src/update/ or dist/update/ = project root.
    const { mtimeMs } = fs.statSync(path.join(__dirname, "..", "..", "package.json"));
    if (Number.isFinite(mtimeMs) && mtimeMs > 0) return new Date(mtimeMs).toISOString();
  } catch {
    /* inside a pkg snapshot, or an unusual layout — fall through */
  }

  return processStartedAt;
}

/**
 * The version string that goes on the wire.
 *
 * Always `APP_VERSION` (which is `"unknown"` when package.json could not be
 * read, by design in `version.ts`). Coerced to a string here so the payload
 * field can never be `undefined` and break the Mothership's schema.
 */
export function getCurrentVersion(): string {
  return String(APP_VERSION || "unknown");
}

/**
 * BOOT RECONCILIATION — call once, after the data directory exists.
 *
 * If the stamp names a different version than the one running, this binary
 * arrived by a path that did not stamp (a manual copy, an older build, or an
 * install updated outside the OTA pipeline). Stamping now makes the next
 * heartbeat report the truth instead of a previous build's timestamp.
 *
 * A first-ever boot has no stamp and is left alone: writing one would claim the
 * node was "updated" at first launch, which is not what happened.
 */
export function reconcileUpdateStamp(): UpdateStamp | null {
  const stamp = readUpdateStamp();
  if (!stamp) return null;
  if (stamp.version === APP_VERSION) return stamp;
  const refreshed = recordUpdateApplied(APP_VERSION);
  if (refreshed) {
    console.log(
      `[Version] Build changed since the last stamp (${stamp.version} → ${APP_VERSION}) — ` +
        "recorded this install time.",
    );
  }
  return refreshed;
}