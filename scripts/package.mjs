#!/usr/bin/env node
/**
 * STANDALONE .EXE PACKAGER.
 *
 * Builds Rippa Node into a clean, portable `dist/` folder:
 *
 *   3. Bundle  — pkg freezes the JS + required assets (SQLite prebuild,
 *                Playwright registry data, Local Web GUI in public/) into
 *                `dist/rippa-node.exe`.
 *   4. Prune   — drop the intermediate .js/.map files so dist/ only contains
 *                the finished executable (+ any user files created later:
 *                config.json and the Deep Brain database live beside it).
 *                A copy of public/ is staged beside the exe as fallback.
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
console.log("[Package] 1/4 Cleaning dist/ ...");
fs.rmSync(distDir, { recursive: true, force: true });

// --- 2. Compile TypeScript ---------------------------------------------------
console.log("[Package] 2/4 Compiling TypeScript ...");
run(process.execPath, [path.join(root, "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.json"]);

// --- 3. Bundle with pkg ------------------------------------------------------
console.log("[Package] 3/4 Bundling rippa-node.exe (@yao-pkg/pkg, node22-win-x64) ...");
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

// --- 4. Prune build artifacts ------------------------------------------------
console.log("[Package] 4/4 Pruning intermediate build files from dist/ ...");
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

// --- 5. Stage public/ beside the exe (fallback if snapshot lookup misses) ---
const publicSrc = path.join(root, "public");
const publicDest = path.join(distDir, "public");
if (fs.existsSync(publicSrc)) {
  fs.rmSync(publicDest, { recursive: true, force: true });
  fs.cpSync(publicSrc, publicDest, { recursive: true });
  console.log("[Package] 5/5 Staged public/ beside the exe.");
}

const sizeMb = fs.statSync(exePath).size / (1024 * 1024);
console.log("");
console.log(`[Package] ✔ dist/${exeName} (${sizeMb.toFixed(1)} MB) — ${pruned} build files pruned.`);
console.log("[Package] Copy the whole dist/ folder to any Windows PC and run the exe;");
console.log("[Package] the first launch opens the Local Configuration Dashboard in the browser.");
console.log("");
