#!/usr/bin/env node
/**
 * WEB GUI BUILD STEP — runs immediately before `pkg`.
 *
 * The Local Web GUI in `public/` is hand-authored, dependency-free
 * HTML/CSS/JS: there is no bundler, no `dist/` and no framework build to run.
 * "Building" it therefore means guaranteeing, before the freezer is invoked,
 * that `public/` is complete — because `pkg` snapshots whatever exists at the
 * moment it runs and can never be re-run on the operator's machine afterwards.
 *
 * This exists because that guarantee was previously implicit. `npm run package`
 * called `pkg` straight away, so an empty/partial `public/` silently produced a
 * `rippa-node.exe` whose dashboard answered 503 forever
 * ("Web GUI assets (public/) not found in this build") with nothing in the
 * build log to explain why. This script turns that silent failure into a hard
 * build error, while the files are still fixable.
 *
 * Checks performed:
 *   1. `public/` exists.
 *   2. Every file the HTML entry points reference exists (so a half-copied
 *      folder cannot be frozen into an exe that renders unstyled/broken).
 *   3. `package.json`'s `pkg.assets` still contains a recursive `public/` glob —
 *      otherwise the next hand-edit of package.json can silently unbundle the
 *      dashboard.
 *
 * Usage: npm run build:webgui
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = path.join(root, "public");
const pkgJsonPath = path.join(root, "package.json");

/** Files without which the dashboard cannot render at all. */
const REQUIRED = ["index.html", "app.js", "styles.css", "dashboard.html", "dashboard.js", "dashboard.css", "command-center.html", "command-center.css", "command-center.js", "node-fleet-command.html", "node-fleet-command.js", "ai-auto-published.html", "ai-auto-published.js", "review-queue.html", "review-queue.js"];

/**
 * Virtual routes served by `src/server.ts` via `res.sendFile(...)`.
 * These look like missing static files to a naive href scan (`/admin/...`
 * has no matching `public/admin/` folder) but are valid at runtime, so the
 * reference check maps them back to the file they serve. Keep this in sync
 * with the `app.get(...)` routes in `src/server.ts`.
 */
const VIRTUAL_ROUTES = {
  "/": "index.html",
  "/dashboard": "dashboard.html",
  "/command-center": "command-center.html",
  "/admin/command-center": "command-center.html",
  "/admin/node-fleet-command": "node-fleet-command.html",
  "/admin/ai-auto-published": "ai-auto-published.html",
  "/admin/review-queue": "review-queue.html",
};

function fail(message) {
  console.error(`[WebGUI] BUILD FAILED — ${message}`);
  process.exit(1);
}

// --- 1. The output directory must exist ---------------------------------------
if (!fs.existsSync(publicDir) || !fs.statSync(publicDir).isDirectory()) {
  fail(
    `no \`public/\` directory at ${publicDir}. The Local Web GUI is a tracked, hand-authored ` +
      "folder — it is not generated — so restore it from git before packaging.",
  );
}

// --- 2. Required files must be present ----------------------------------------
const missing = REQUIRED.filter((name) => !fs.existsSync(path.join(publicDir, name)));
if (missing.length > 0) {
  fail(`public/ is incomplete — missing: ${missing.join(", ")}`);
}

// --- 3. Every local asset the HTML references must resolve ---------------------
// Catches the realistic failure (a file that was renamed or never copied) rather
// than just checking a hand-kept list stays in sync.
//
// NOTE: `src/server.ts` serves several virtual routes (`/dashboard`,
// `/admin/...`) via `res.sendFile(...)` — those have no matching file under
// `public/` (there is no `public/admin/` folder) but are valid at runtime.
// VIRTUAL_ROUTES maps each one back to the file it serves so the check
// validates the target exists instead of failing the build. API routes
// (`/api/...`) and other server-handled absolute paths are skipped outright.
const htmlFiles = fs
  .readdirSync(publicDir)
  .filter((name) => name.endsWith(".html"));
const broken = [];
for (const html of htmlFiles) {
  const source = fs.readFileSync(path.join(publicDir, html), "utf8");
  for (const match of source.matchAll(/(?:src|href)\s*=\s*["']([^"']+)["']/gi)) {
    const ref = match[1].split("?")[0].split("#")[0];
    // Skip absolute URLs, protocol-relative URLs and inline/data payloads.
    if (!ref || /^(?:[a-z]+:)?\/\//i.test(ref) || ref.startsWith("data:")) continue;
    // Skip non-file schemes (mailto:, tel:, javascript:, ...).
    if (/^[a-z][a-z0-9+.-]*:/i.test(ref)) continue;
    // API calls and other server-handled endpoints are not static files.
    if (ref.startsWith("/api/")) continue;
    // Virtual page routes served by server.ts -> validate the mapped file.
    if (ref.startsWith("/") && Object.hasOwn(VIRTUAL_ROUTES, ref)) {
      const target = VIRTUAL_ROUTES[ref];
      if (!fs.existsSync(path.join(publicDir, target))) {
        broken.push(`${html} -> ${ref} (maps to missing ${target})`);
      }
      continue;
    }
    // Any other site-absolute path (e.g. "/") resolves from public/ root.
    const diskRef = ref.startsWith("/") ? ref.slice(1) : ref;
    if (!diskRef) continue; // bare "/" or "/#..." — always valid (index route)
    if (!fs.existsSync(path.join(publicDir, diskRef))) broken.push(`${html} -> ${ref}`);
  }
}
if (broken.length > 0) {
  fail(`public/ references files that do not exist:\n         - ${broken.join("\n         - ")}`);
}

// --- 4. package.json must still bundle them -----------------------------------
const pkgConfig = JSON.parse(fs.readFileSync(pkgJsonPath, "utf8"));
const assets = pkgConfig?.pkg?.assets ?? [];
const bundlesPublic = assets.some((entry) => typeof entry === "string" && entry.startsWith("public/"));
if (!bundlesPublic) {
  fail(
    'package.json has no `pkg.assets` entry starting with "public/". Without it `pkg` ' +
      "freezes no Web GUI files and the exe boots to a 503 dashboard.",
  );
}

// --- Report -------------------------------------------------------------------
const files = fs.readdirSync(publicDir, { withFileTypes: true }).filter((entry) => entry.isFile());
const bytes = files.reduce((total, entry) => total + fs.statSync(path.join(publicDir, entry.name)).size, 0);
console.log(`[WebGUI] ✔ ${files.length} file(s), ${(bytes / 1024).toFixed(1)} KB in public/ — ready for pkg.`);
for (const entry of files.sort((a, b) => a.name.localeCompare(b.name))) {
  console.log(`[WebGUI]   ${entry.name}`);
}