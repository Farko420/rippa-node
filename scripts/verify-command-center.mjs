#!/usr/bin/env node
/**
 * VERIFY-COMMAND-CENTER.MJS
 * Static verification: check that all command-center files exist and are well-formed.
 * Integration testing requires a running server (npm run dev).
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const publicDir = path.join(root, "public");

const files = [
  "command-center.html",
  "command-center.css",
  "command-center.js",
];

const results = [];

function check(name, pass, detail = "") {
  results.push({ name, pass });
  console.log(`${pass ? "✓" : "✗"} ${name}${detail ? " — " + detail : ""}`);
}

function main() {
  console.log("\n========================================");
  console.log("COMMAND CENTER STATIC VERIFICATION");
  console.log("========================================\n");

  // Check all files exist
  console.log("[1] Verifying files exist...");
  for (const file of files) {
    const path_to_file = path.join(publicDir, file);
    const exists = fs.existsSync(path_to_file);
    check(`${file} exists`, exists);
    if (!exists) continue;

    const content = fs.readFileSync(path_to_file, "utf8");
    const size = content.length;

    // Check HTML structure
    if (file === "command-center.html") {
      check("HTML has DOCTYPE", content.includes("<!DOCTYPE html>"));
      check("HTML has app shell", content.includes('id="ccApp"'));
      check("HTML has lock screen", content.includes('id="lockScreen"'));
      check("HTML has message list", content.includes('id="messageList"'));
      check("HTML has compose area", content.includes('id="messageInput"'));
      check("HTML has batch panel", content.includes('id="batchPanel"'));
      check(`HTML size: ${(size / 1024).toFixed(1)} KB`, true);
    }

    // Check CSS structure
    if (file === "command-center.css") {
      check("CSS has .cc-shell", content.includes(".cc-shell"));
      check("CSS has .cc-message", content.includes(".cc-message"));
      check("CSS has .cc-textarea", content.includes(".cc-textarea"));
      check("CSS has lock-screen", content.includes(".lock-screen"));
      check(`CSS size: ${(size / 1024).toFixed(1)} KB`, true);
    }

    // Check JS structure
    if (file === "command-center.js") {
      check("JS has IIFE wrapper", content.includes("(function () {"));
      check("JS has initThread", content.includes("function initThread()"));
      check("JS has sendMessage", content.includes("function sendMessage()"));
      check("JS has loadMessages", content.includes("function loadMessages()"));
      check("JS has wireComposer", content.includes("function wireComposer()"));
      check("JS has SSE integration", content.includes("EventSource"));
      check("JS has auth pattern", content.includes("rippa_dashboard_auth"));
      check("JS closes IIFE", content.includes("})();"));
      check(`JS size: ${(size / 1024).toFixed(1)} KB`, true);
    }
  }

  // Check package.json includes command-center in pkg.assets
  console.log("\n[2] Verifying package.json configuration...");
  const pkgPath = path.join(root, "package.json");
  const pkgContent = fs.readFileSync(pkgPath, "utf8");
  const pkg = JSON.parse(pkgContent);

  check(
    "pkg.assets includes command-center.html",
    pkg.pkg?.assets?.includes("public/command-center.html")
  );
  check(
    "pkg.assets includes command-center.css",
    pkg.pkg?.assets?.includes("public/command-center.css")
  );
  check(
    "pkg.assets includes command-center.js",
    pkg.pkg?.assets?.includes("public/command-center.js")
  );
  check(
    "npm script verify:command-center exists",
    pkg.scripts?.["verify:command-center"] ? true : false
  );

  // Summary
  console.log("\n[3] Summary");
  const passCount = results.filter((r) => r.pass).length;
  const totalCount = results.length;
  console.log(
    `\n========================================`
  );
  console.log(`${passCount}/${totalCount} checks passed`);
  if (passCount === totalCount) {
    console.log("✓ ALL STATIC CHECKS PASSED");
    console.log("========================================\n");
    process.exit(0);
  } else {
    console.log("✗ SOME CHECKS FAILED");
    console.log("========================================\n");
    process.exit(1);
  }
}

main();
