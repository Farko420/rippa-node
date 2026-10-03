#!/usr/bin/env node
/**
 * MOBILE WORKER BUNDLER — the browser-safe entrypoint for the Android APK.
 *
 * WHY A SEPARATE SCRIPT. This exists only to produce `mobile/www/worker.js` for
 * the Capacitor WebView, and it must be verifiable in isolation. The APK build
 * (`scripts/package-apk.mjs`) calls it, but it runs on its own too:
 *
 *     node scripts/build-mobile-worker.mjs --out <file>
 *
 * so the one question that actually broke the pipeline — "does the worker still
 * pull in Node builtins?" — can be answered in a second, with no Android SDK,
 * no Gradle and no network.
 *
 * THE PROBLEM IT SOLVES. `src/satellite/mobile-worker.ts` imports the storage
 * abstraction, whose desktop branch dynamically imports `storage-desktop.ts` →
 * `better-sqlite3`, `node:fs`, `node:path`. A dynamic import does NOT
 * tree-shake. esbuild resolves and parses the target during its scan phase,
 * BEFORE dead-code elimination, so guarding the branch with a runtime check
 * still produces:
 *
 *     X [ERROR] Could not resolve "path"
 *
 * which is precisely how the original APK build died. `--alias:` cannot solve
 * it either: esbuild only accepts bare package specifiers there, never the
 * relative `./storage-desktop.js` that the provider imports.
 *
 * THE FIX. A resolve plugin that hard-remaps the desktop provider to
 * `storage-desktop.browser.ts` for browser builds. The desktop module is then
 * never resolved, never parsed and never bundled. This is a substitution, not
 * an optimisation, so it cannot be undone by a bundler upgrade.
 *
 * THE GUARD. `--no-node-builtins` (default ON) greps the emitted bundle for
 * `better-sqlite3`, `node:*`, `require("fs")` and friends and exits non-zero on
 * a hit. A build that silently regresses fails here in a second instead of
 * producing an APK that dies on a tablet at 3am.
 */
import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/*
  THE ENTRYPOINT is `mobile/src/worker.ts`, NOT `src/satellite/mobile-worker.ts`
  directly. That file is the satellite core: it polls a Master for assignments
  and persists through the StorageProvider abstraction, which is exactly what
  makes the APK build viable. But on its own it is not the whole WebView
  application — it has no Mothership heartbeat, no task queue, no scraping and,
  critically, none of the `startWorker` / `workerStatus` / `onWorkerEvent`
  surface that the bundled index.html calls to run and render the node.

  `mobile/src/worker.ts` imports the satellite core and re-exposes it as
  `startSatellite()`, so bundling it produces one IIFE containing BOTH the
  dashboard API and the abstracted-storage satellite path. Bundling the
  satellite file alone would compile fine and then break at runtime the moment
  the page tried to start the worker.
*/
const entry = path.join(root, "mobile", "src", "worker.ts");
const browserStub = path.join(root, "src", "satellite", "storage-desktop.browser.ts");

/*
  THE BUILD VERSION IS INJECTED HERE, not hand-written into worker.ts.

  `mobile/src/worker.ts` declares `__RIPPA_FALLBACK_APK_VERSION__` and uses it as
  the reported version for runtimes with no native bridge. Reading it from the root
  package.json and passing it to esbuild as a `define` makes package.json the single
  source of truth, which is the only arrangement that survives CI: the workflow's
  Bump-version step raises package.json on every push, so a literal in worker.ts was
  stale the instant that step ran and failed the APK build on every single run.

  `define` substitutes the identifier textually at bundle time, so the reference is
  erased rather than resolved at runtime — the WebView never sees the global, and
  the guard below cannot be tripped by it either.
*/
const pkgVersion = JSON.parse(
  fs.readFileSync(path.join(root, "package.json"), "utf8"),
).version;
if (typeof pkgVersion !== "string" || !pkgVersion.trim()) {
  console.error("[BUNDLE] package.json has no usable `version` to inject.");
  process.exit(1);
}

const args = process.argv.slice(2);
const outIndex = args.indexOf("--out");
const outFile =
  outIndex !== -1 && args[outIndex + 1]
    ? path.resolve(String(args[outIndex + 1]))
    : path.join(root, "mobile", "www", "worker.js");
const skipGuard = args.includes("--no-guard");

/** Import specifiers that must never appear in a WebView bundle. */
const FORBIDDEN = [
  "better-sqlite3",
  "node:fs",
  "node:path",
  "node:os",
  "node:child_process",
  "node:crypto",
  "require(\"fs\")",
  "require(\"path\")",
  "require(\"child_process\")",
];

fs.mkdirSync(path.dirname(outFile), { recursive: true });

/**
 * Remaps the desktop SQLite provider onto the browser stub.
 *
 * Matches both `./storage-desktop` and `./storage-desktop.js`, so the seam keeps
 * working if the import is ever written without the extension (TypeScript's
 * `nodenext` resolution requires the `.js` specifier at runtime).
 */
const desktopStorageStub = {
  name: "rippa-desktop-storage-stub",
  setup(pluginBuild) {
    pluginBuild.onResolve({ filter: /^\.\/storage-desktop(\.js)?$/ }, () => ({
      path: browserStub,
    }));
  },
};

await build({
  entryPoints: [entry],
  outfile: outFile,
  bundle: true,
  format: "iife",
  globalName: "RippaMobileWorker",
  platform: "browser",
  target: "es2020",
  plugins: [desktopStorageStub],
  define: {
    __RIPPA_FALLBACK_APK_VERSION__: JSON.stringify(pkgVersion),
  },
  // Node builtins are NOT marked external. An external builtin would be left as
  // a dangling `require()` that survives into the APK and throws on a tablet;
  // failing the build here is the behaviour we want.
  logLevel: "warning",
  banner: {
    js: "/* rippa-satellite worker — generated by scripts/build-mobile-worker.mjs. Do not edit. */",
  },
});

const bundle = fs.readFileSync(outFile, "utf8");
const hits = FORBIDDEN.filter((needle) => bundle.includes(needle));

if (hits.length > 0 && !skipGuard) {
  console.error(
    "[BUNDLE] FATAL: the worker bundle references Node-only modules:\n" +
      hits.map((h) => `  - ${h}`).join("\n") +
      "\n[BUNDLE] The APK runs in an Android WebView, where none of these exist.",
  );
  process.exit(1);
}

const kb = (bundle.length / 1024).toFixed(1);
console.log(`[BUNDLE] worker -> ${path.relative(root, outFile)} (${kb} KB)`);
console.log(
  hits.length > 0
    ? `[BUNDLE] WARNING: guard skipped, bundle contains ${hits.join(", ")}`
    : "[BUNDLE] Guard passed: no better-sqlite3 / node builtins in the bundle.",
);