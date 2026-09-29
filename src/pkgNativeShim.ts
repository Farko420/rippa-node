import Module from "node:module";

/**
 * PKG SINGLE-FILE EXE SUPPORT — loader shims for the packaged build.
 *
 * `pkg` snapshots the JS + asset files into a virtual read-only filesystem
 * (`/snapshot/...`). Two things inside that snapshot need help:
 *
 * 1. NATIVE ADDONS — pkg's own prelude already patches `process.dlopen` to
 *    extract `.node` files (e.g. the better-sqlite3 prebuild) to a real temp
 *    folder and load them from there, so nothing is needed from us.
 *
 * 2. `node:inspector` — pkg's Node build ships WITHOUT the inspector, so any
 *    `require("inspector")` throws ERR_INSPECTOR_NOT_AVAILABLE. Playwright's
 *    client bundle requires it at module load (for Page.coverage), which would
 *    kill the whole exe during boot. The scraper never uses coverage APIs, so
 *    a no-op stub installed below is sufficient.
 *
 * Outside a packaged exe every hook below is a complete no-op, so dev builds
 * and `node dist/index.js` behave exactly as before.
 */

type PackagedProcess = NodeJS.Process & { pkg?: unknown };

function isPackaged(): boolean {
  return Boolean((process as PackagedProcess).pkg);
}

function isInspectorRequest(request: unknown): boolean {
  return request === "inspector" || request === "node:inspector";
}

/** Minimal no-op stand-in for `node:inspector` inside the packaged exe. */
class NoopInspectorSession {
  connect(): void {
    /* coverage sessions are unavailable in the packaged build */
  }
  disconnect(): void {
    /* coverage sessions are unavailable in the packaged build */
  }
  on(): this {
    return this;
  }
  once(): this {
    return this;
  }
  removeListener(): this {
    return this;
  }
  post(): void {
    /* coverage profiling is never started by the packaged build */
  }
}

const INSPECTOR_STUB = { Session: NoopInspectorSession, open: () => undefined };

interface ModuleShape {
  prototype?: { require?: (this: unknown, ...args: unknown[]) => unknown };
  _load?: (request: string, parent?: NodeModule, isMain?: boolean) => unknown;
}

/** Intercepts inspector requests on Module.prototype.require (primary hook). */
function installInspectorRequireHook(mod: ModuleShape): void {
  const proto = mod.prototype;
  const originalRequire = proto?.require;
  if (!proto || typeof originalRequire !== "function") return;
  const withHook = originalRequire as (...args: unknown[]) => unknown;
  if ((withHook as { __rippaInspectorHook?: boolean }).__rippaInspectorHook) return;
  const wrapped = function (this: unknown, ...args: unknown[]): unknown {
    const request = args[0];
    if (isInspectorRequest(request)) {
      return INSPECTOR_STUB;
    }
    return (originalRequire as (...requireArgs: unknown[]) => unknown).apply(this, args);
  };
  (wrapped as { __rippaInspectorHook?: boolean }).__rippaInspectorHook = true;
  proto.require = wrapped;
}

/** Intercepts inspector requests on the static Module._load (backup hook). */
function installInspectorLoadHook(mod: ModuleShape): void {
  const originalLoad = mod._load;
  if (typeof originalLoad !== "function") return;
  const withHook = originalLoad as (...args: unknown[]) => unknown;
  if ((withHook as { __rippaInspectorHook?: boolean }).__rippaInspectorHook) return;
  const wrapped = function (
    this: unknown,
    request: string,
    parent?: NodeModule,
    isMain?: boolean,
  ): unknown {
    if (isInspectorRequest(request)) {
      return INSPECTOR_STUB;
    }
    return (originalLoad as (...args: unknown[]) => unknown).call(this, request, parent, isMain);
  };
  (wrapped as { __rippaInspectorHook?: boolean }).__rippaInspectorHook = true;
  mod._load = wrapped;
}

/**
 * Installs the inspector stub. Safe to import from anywhere; idempotent.
 * NOTE: a stub is only installed when `process.pkg` is set (packaged exe).
 */
export function installPkgNativeShim(): void {
  if (!isPackaged()) return;
  const mod = Module as unknown as ModuleShape;
  if (!mod || typeof mod !== "function") return;
  installInspectorRequireHook(mod);
  installInspectorLoadHook(mod);
}

installPkgNativeShim();
