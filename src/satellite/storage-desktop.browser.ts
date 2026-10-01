/**
 * BROWSER STUB FOR THE DESKTOP SQLITE PROVIDER — build-time seam only.
 *
 * WHY THIS FILE EXISTS. `storage-provider.ts` picks an implementation at
 * runtime, and its desktop branch is a *dynamic* import of `storage-desktop.ts`
 * (better-sqlite3 + node:fs + node:path). Dynamic imports do not tree-shake:
 * esbuild resolves and parses the target module during its scan phase, long
 * before any dead-code elimination runs. So merely wrapping the desktop branch
 * in a runtime check is NOT enough — the bundler still walks into
 * `better-sqlite3`, finds `require("path")`, and fails with:
 *
 *     X [ERROR] Could not resolve "path"
 *
 * which is exactly how the first APK build died (and why the CI job was
 * deleted). esbuild's `--alias:` cannot help either: it only accepts bare
 * package specifiers, never the relative `./storage-desktop.js` we import.
 *
 * THE FIX. `scripts/package-apk.mjs` registers an esbuild plugin that remaps
 * `./storage-desktop.js` to THIS file for browser/Android bundles. The desktop
 * provider is therefore never resolved, never parsed and never bundled — it is
 * not a tree-shaking result, it is a hard substitution, which is the only
 * guarantee that survives a bundler upgrade.
 *
 * WHY IT THROWS ANYWAY. `createStorageProvider()` returns the browser provider
 * whenever `window` + `localStorage` exist, so this class is unreachable inside
 * an Android WebView. Throwing is deliberate: if some future code path ever
 * reaches it, the failure is loud and immediate instead of a silent data-loss
 * bug on a tablet nobody is watching.
 */
import type { StorageProvider } from "./storage-provider";

/*
  One shared Error instance. Every method below `throw`s it, which satisfies
  `noImplicitReturns` (tsconfig enables it) without needing a per-method return
  value — a silent `return` here would defeat the entire purpose of this stub,
  which is to fail loudly if anything ever reaches the desktop provider from a
  WebView.
*/
const UNREACHABLE = new Error(
  "DesktopStorageProvider is not available in a browser/WebView runtime. " +
    "Use createStorageProvider(), which selects a browser-safe provider when " +
    "window/localStorage are present.",
);

export class DesktopStorageProvider implements StorageProvider {
  constructor() {
    throw UNREACHABLE;
  }

  async init(): Promise<void> {
    throw UNREACHABLE;
  }
  async close(): Promise<void> {
    throw UNREACHABLE;
  }
  async get(): Promise<unknown> {
    throw UNREACHABLE;
  }
  async set(): Promise<void> {
    throw UNREACHABLE;
  }
  async deleteKey(): Promise<void> {
    throw UNREACHABLE;
  }
  async getAll(): Promise<never[]> {
    throw UNREACHABLE;
  }
  async insert(): Promise<number | string> {
    throw UNREACHABLE;
  }
  async update(): Promise<void> {
    throw UNREACHABLE;
  }
  async deleteRecord(): Promise<void> {
    throw UNREACHABLE;
  }
  async query(): Promise<never[]> {
    throw UNREACHABLE;
  }
}