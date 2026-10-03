#!/usr/bin/env node
/**
 * STANDALONE .EXE PACKAGER.
 *
 * Builds Rippa Node into a clean, portable `dist/` folder:
 *
 *   1. Clean     — wipe dist/ so a stale file can never be frozen in.
 *   2. Compile   — tsc -> dist/.
 *   3. Verify    — assert public/ is complete (see scripts/build-webgui.mjs).
 *   4. Bundle    — pkg freezes the JS + required assets (SQLite prebuild,
 *                  Playwright registry data, Local Web GUI in public/) into
 *                  `dist/rippa-node.exe`.
 *   5. Prune     — drop the intermediate .js/.map files so dist/ only contains
 *                  the finished executable (+ any user files created later:
 *                  config.json and the Deep Brain database live beside it).
 *   6. Stage     — copy public/ beside the exe, for folder-copy deployments.
 *
 * THE DASHBOARD LIVES INSIDE THE EXE. Step 4 is what serves the Web GUI on a
 * released build: `pkg.assets` bundles the whole `public/` tree, and the backend
 * resolves it through `__dirname`, which inside a `pkg` exe is the virtual
 * snapshot. The
 * step-6 copy is a convenience for anyone dragging the whole `dist/` folder
 * around — it is NOT required, and must never be mistaken for the real source,
 * because the OTA updater replaces the .exe alone and would leave that copy
 * stale next to a freshly bundled GUI.
 *
 * The whole dist/ folder can then be copied to any Windows PC. First run of
 * rippa-node.exe opens the Local Configuration Dashboard in the browser.
 *
 * Usage: npm run package
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDir = path.join(root, "dist");
const exeName = "rippa-node.exe";
const exePath = path.join(distDir, exeName);
const watchdogName = "rippa-watchdog.exe";
const watchdogPath = path.join(distDir, watchdogName);
const isWindows = process.platform === "win32";

/** Runs a command, inheriting stdio; exits the build on failure. */
function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: "inherit",
    ...options,
  });
  if (result.error) {
    console.error(`[Package] Failed to start ${command}: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`[Package] ${command} exited with code ${result.status}`);
    process.exit(result.status ?? 1);
  }
}

/** Locates the installed pkg CLI entry point (prefers @yao-pkg/pkg, falls back to npx). */
function resolvePkgInvocation() {
  const candidates = [
    path.join(root, "node_modules", "@yao-pkg", "pkg"),
    path.join(root, "node_modules", "pkg"),
  ];
  for (const pkgDir of candidates) {
    const pkgJsonPath = path.join(pkgDir, "package.json");
    if (!fs.existsSync(pkgJsonPath)) continue;
    const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, "utf8"));
    const binField = typeof pkgJson.bin === "string" ? pkgJson.bin : pkgJson.bin?.pkg;
    const bin = binField ?? (pkgJson.bin ? Object.values(pkgJson.bin)[0] : null);
    if (bin) {
      return { command: process.execPath, args: [path.join(pkgDir, bin)], options: {} };
    }
  }
  // pkg not installed yet — let npx fetch it on the fly (needs internet once).
  const npx = isWindows ? "npx.cmd" : "npx";
  return { command: npx, args: ["--yes", "@yao-pkg/pkg"], options: { shell: isWindows } };
}

// --- 1. Clean ---------------------------------------------------------------
console.log("[Package] 1/7 Cleaning dist/ ...");
fs.rmSync(distDir, { recursive: true, force: true });

// --- 2. Compile TypeScript ---------------------------------------------------
console.log("[Package] 2/7 Compiling TypeScript ...");
run(process.execPath, [path.join(root, "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.json"]);

// --- 2b. Write the watchdog's reduced pkg manifest --------------------------
// The watchdog imports nothing from `services/`, `db/` or `network/` — it only
// needs `update/exitCodes` and `update/swapHandoff` — so it does not need the
// SQLite prebuild or the Playwright registry either. `package.json`'s own `pkg`
// block would drag all of that in, which is why the watchdog gets its own
// manifest rather than sharing the node's.
//
// The `bin`/`scripts`/`dependencies` fields are copies of the real ones so pkg
// resolves the runtime version and the module tree identically for both exes.
console.log("[Package] 2b/7 Writing the watchdog pkg manifest ...");
run(process.execPath, [path.join(root, "scripts", "build-watchdog.mjs")]);

// `pkg` snapshots whatever `public/` contains AT THIS MOMENT and that snapshot is
// frozen into the exe forever after. If the folder is empty or half-copied the
// only symptom an operator ever sees is a 503 dashboard with no build error, so
// the packaging is aborted here instead. `npm run package` normally runs this
// check first via `build:webgui`; running this file directly must be just as safe.
console.log("[Package] 3/7 Verifying Web GUI assets ...");
run(process.execPath, [path.join(root, "scripts", "build-webgui.mjs")]);

// --- 4. Bundle with pkg ------------------------------------------------------
console.log("[Package] 4/7 Bundling rippa-node.exe (@yao-pkg/pkg, node22-win-x64) ...");
const pkg = resolvePkgInvocation();
// Relative entry + output paths (no spaces) + cwd:root keep this safe in any
// checkout. Explicit entry file — pkg doesn't need a package.json "bin".
// node22 matches Playwright's (>=20) and better-sqlite3's (>=22) engine needs.
// --config package.json is required: the fork only auto-discovers .pkgrc* files,
// so without it the "pkg" block (native + Playwright assets) would be ignored.
run(
  pkg.command,
  [
    ...pkg.args,
    "dist/index.js",
    "--config",
    "package.json",
    "--targets",
    "node22-win-x64",
    "--output",
    `dist/${exeName}`,
  ],
  pkg.options,
);

if (!fs.existsSync(exePath)) {
  console.error(`[Package] Expected ${exePath} to exist after pkg — aborting.`);
  process.exit(1);
}

/*
  THE WATCHDOG IS BUNDLED AS A SECOND, SINGLE-ENTRY `pkg` RUN.

  Both exes are built by the SAME pkg binary and the SAME `--targets node22-win-x64`,
  which is what keeps the supervisor and the worker on one Node version — the two
  processes share a data directory, a SQLite file and an exit-code protocol, and a
  runtime-version skew between them would be a genuinely baffling thing to debug.
  Two invocations also keep each `--output` name exact: pkg derives an exe's name
  from its ENTRY POINT, so a two-entry run would emit `index.exe` plus
  `watchdog.exe` and neither would be the filename the installer, the startup
  entry and the OTA updater all refer to.

  The watchdog gets its OWN `--config` pointing at a generated manifest with an
  empty `assets` block, because `public/` is ~2 MB of dashboard files the watchdog
  never reads. Freezing them into a supervisor with no UI would double the
  installer size for nothing; `scripts/build-watchdog.mjs` writes that manifest.
*/
console.log("[Package] 5/7 Bundling rippa-watchdog.exe ...");
const watchdogPkgConfig = path.join(distDir, "pkg-watchdog.json");
if (!fs.existsSync(watchdogPkgConfig)) {
  console.error(
    `[Package] Expected ${watchdogPkgConfig} — build the watchdog first (npm run build:watchdog).`,
  );
  process.exit(1);
}
run(
  pkg.command,
  [
    ...pkg.args,
    "dist/watchdog.js",
    "--config",
    watchdogPkgConfig,
    "--targets",
    "node22-win-x64",
    "--output",
    `dist/${watchdogName}`,
  ],
  pkg.options,
);

if (!fs.existsSync(watchdogPath)) {
  console.error(`[Package] Expected ${watchdogPath} to exist after pkg — aborting.`);
  process.exit(1);
}

// --- 6. Prune build artifacts ------------------------------------------------
console.log("[Package] 6/7 Pruning intermediate build files from dist/ ...");
let pruned = 0;
const prune = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      prune(entryPath);
      // Remove directories that end up empty after pruning.
      if (fs.readdirSync(entryPath).length === 0) {
        fs.rmdirSync(entryPath);
        pruned += 1;
      }
    } else if (/\.(js|js\.map|d\.ts)$/.test(entry.name)) {
      fs.unlinkSync(entryPath);
      pruned += 1;
    }
  }
};
prune(distDir);

// --- 7. Stage public/ beside the exe (fallback for folder copies) -------------
// This is a CONVENIENCE copy for "copy the whole dist/ folder" deployments, NOT
// the primary source of the dashboard. The primary source is the recursive
// `public/` glob frozen into the snapshot by pkg, read via `__dirname` in
// `configManager.resolvePublicDir()` — that is what makes a bare `rippa-node.exe`
// (which is all the OTA updater replaces) serve its own dashboard.
const publicSrc = path.join(root, "public");
const publicDest = path.join(distDir, "public");
if (fs.existsSync(publicSrc)) {
  fs.rmSync(publicDest, { recursive: true, force: true });
  fs.cpSync(publicSrc, publicDest, { recursive: true });
  console.log("[Package] 7/7 Staged public/ beside the exe (folder-copy convenience).");
} else {
  console.error(`[Package] Expected ${publicSrc} to exist after step 3 — aborting.`);
  process.exit(1);
}

const sizeMb = fs.statSync(exePath).size / (1024 * 1024);
const watchdogSizeMb = fs.statSync(watchdogPath).size / (1024 * 1024);
console.log("");
console.log(`[Package] ✔ dist/${exeName} (${sizeMb.toFixed(1)} MB) — ${pruned} build files pruned.`);
console.log(`[Package] ✔ dist/${watchdogName} (${watchdogSizeMb.toFixed(1)} MB) — the supervisor.`);
console.log("[Package] Copy the whole dist/ folder to any Windows PC and run rippa-watchdog.exe;");
console.log("[Package] the first launch opens the Local Configuration Dashboard in the browser.");
console.log("[Package] Run \"rippa-watchdog.exe --install\" once to start it automatically at logon.");
console.log("");
