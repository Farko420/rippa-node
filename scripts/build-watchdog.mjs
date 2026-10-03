#!/usr/bin/env node
/**
 * WATCHDOG PACKAGE MANIFEST WRITER.
 *
 * `scripts/package.mjs` needs a `pkg` config for `dist/watchdog.js` that is NOT
 * the project's own `package.json`. This writes one, next to the compiled output,
 * and is the reason the two executables can be built by the same tool at the same
 * Node target without dragging a ~2 MB dashboard snapshot and a SQLite native
 * prebuild into a process that never loads a database or renders a page.
 *
 * WHAT IS DELIBERATELY ABSENT, and why each is safe:
 *
 *   `pkg.assets` (empty)   The watchdog serves no HTTP and reads no files it did
 *                          not write itself. Freezing `public/` in would add
 *                          roughly 2 MB to every install for no benefit.
 *   better-sqlite3 prebuild The watchdog touches no database. It does copy the
 *                          node's executable, and `update/swapHandoff` is where
 *                          that logic lives — no native module involved.
 *   Playwright registry     The watchdog launches the node and waits. It never
 *                          scrapes anything.
 *
 * WHAT IS COPIED, and why: `name`/`version`/`bin` so pkg resolves the same runtime
 * and the same entry-point convention as the node, and `dependencies` so pkg
 * resolves the module tree from the same place. A manifest that omitted them
 * would work by accident today and break the moment the tree changed.
 *
 * The output lands in `dist/`, which `scripts/package.mjs` prunes, so this is a
 * build artefact and is never committed.
 *
 * Usage: node scripts/build-watchdog.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = path.join(root, "package.json");
const outPath = path.join(root, "dist", "pkg-watchdog.json");

const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

const reduced = {
  name: manifest.name,
  version: manifest.version,
  description: "Rippa Watchdog — supervises rippa-node.exe (generated pkg manifest).",
  main: "dist/watchdog.js",
  bin: manifest.bin,
  scripts: manifest.scripts,
  dependencies: manifest.dependencies,
  // Empty on purpose — see the header. Every entry in the real `pkg.assets`
  // belongs to the node, not the supervisor.
  pkg: {
    assets: [],
  },
};

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, `${JSON.stringify(reduced, null, 2)}\n`, "utf8");

console.log(`[Watchdog] Wrote ${path.relative(root, outPath)} (assets: none).`);
