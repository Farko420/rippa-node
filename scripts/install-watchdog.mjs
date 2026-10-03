#!/usr/bin/env node
/**
 * WATCHDOG INSTALLER.
 *
 * A thin wrapper that runs `rippa-watchdog.exe --install`, which writes the
 * per-user Windows Run key and the Startup-folder launcher (see `src/watchdog.ts`
 * for why both, and why neither needs elevation).
 *
 * It exists as a separate entry point because registration is the one watchdog
 * action an operator will run before they have ever seen the rest of the
 * tooling, and `npm run watchdog:install` should do the right thing without the
 * operator having to know where the exe landed or which flag to pass. It also
 * fails loudly rather than silently leaving the machine unsupervised — the
 * failure mode this whole architecture exists to eliminate.
 *
 * Usage: npm run watchdog:install          (install)
 *        node scripts/install-watchdog.mjs --uninstall
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDir = path.join(root, "dist");
const watchdogExe = path.join(distDir, "rippa-watchdog.exe");

const args = process.argv.slice(2);
const uninstall = args.includes("--uninstall");

if (!fs.existsSync(watchdogExe)) {
  console.error(`[Watchdog] ${watchdogExe} does not exist.`);
  console.error("[Watchdog] Build it first:  npm run package");
  process.exit(1);
}

const flag = uninstall ? "--uninstall" : "--install";
console.log(`[Watchdog] Running ${path.basename(watchdogExe)} ${flag} ...`);

const result = spawnSync(watchdogExe, [flag], { stdio: "inherit" });
if (result.error) {
  console.error(`[Watchdog] Could not start the watchdog: ${result.error.message}`);
  process.exit(1);
}
if (result.status !== 0) {
  console.error(`[Watchdog] ${flag} failed (exit ${result.status ?? "unknown"}).`);
  process.exit(result.status ?? 1);
}

console.log("");
console.log(
  uninstall
    ? "[Watchdog] Startup entries removed. This node will no longer start automatically."
    : "[Watchdog] Registered to start at logon. Start it now with:\n" +
      `          "${watchdogExe}"`,
);
