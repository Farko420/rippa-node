/**
 * BUG 1 & 2 — SETUP INPUT VALIDATION AND THE REMOVED MANUAL TASK UI.
 *
 * Asserted against the SHIPPED HTML/JS rather than the source, because these two
 * fixes are entirely front-end: the field's `type`/attributes and the absence of
 * the three task-control elements are the whole contract.
 */
import fs from "node:fs";
import path from "node:path";
import { ROOT, check } from "./verify-harness.mjs";

const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

const indexHtml = read("public/index.html");
const dashHtml = read("public/dashboard.html");
const appJs = read("public/app.js");
const dashJs = read("public/dashboard.js");

// --- 1. Master Node Code accepts alphanumeric codes -------------------------
const masterField = indexHtml.match(/<input id="masterUrl"[^>]*>/)?.[0] ?? "";
check(
  'Master Node field is type="text" (accepts RIPPA-D2N6-6VZV)',
  /type="text"/.test(masterField) && !/type="number"/.test(masterField),
  masterField.slice(0, 78),
);
check(
  "Master Node field has no numeric keyboard hint",
  !/id="masterUrl"[^>]*inputmode="numeric"/.test(indexHtml),
);
check(
  "Master Node field placeholder advertises a node code",
  /id="masterUrl"[\s\S]{0,200}?placeholder="[^"]*RIPPA-/.test(indexHtml),
);
check(
  "app.js has no digits-only filter on the Master Node value",
  !/masterUrl\.value\.replace\(\/\\D/.test(appJs),
);
check(
  "app.js resolves a pasted node code to a URL on save",
  /resolveMasterFieldForSave/.test(appJs) && /resolveNodeCodeToUrl/.test(appJs),
);

// --- 2. No manual "Assign to Swarm" UI --------------------------------------
for (const [name, html] of [
  ["index.html", indexHtml],
  ["dashboard.html", dashHtml],
]) {
  check(
    `${name}: taskRun / taskLabel / taskLoad removed`,
    !/id="taskRun"/.test(html) && !/id="taskLabel"/.test(html) && !/id="taskLoad"/.test(html),
  );
}
/**
 * Strips JS comments so an assertion tests CODE rather than prose.
 *
 * Necessary here because the removal notes deliberately name `assignTask()` to
 * record what was removed and why. Matching the raw text would flag those notes
 * as live references and force their deletion, which would lose the reasoning a
 * future maintainer needs. A simple line-comment / block-comment strip is enough
 * for this file — it contains no regex literals containing `//`.
 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
}

const dashJsCode = stripComments(dashJs);

// Asserts on CODE, not on the word.
check(
  "dashboard.js defines no manual assignTask function",
  !/function\s+assignTask\b/.test(dashJsCode),
);
check(
  "dashboard.js never calls assignTask",
  !/\bassignTask\s*\(/.test(dashJsCode),
);
check(
  "dashboard.js binds no listener to the removed #taskLabel field",
  !/\$\(\s*"taskLabel"\s*\)/.test(dashJsCode),
);
check(
  "dashboard.js no longer reads the removed #taskRun / #taskLoad controls",
  !/\$\(\s*"taskRun"\s*\)/.test(dashJsCode) && !/\$\(\s*"taskLoad"\s*\)/.test(dashJsCode),
);

// --- 3 & 6. The new UI surfaces exist in BOTH pages -------------------------
for (const [name, html] of [
  ["index.html", indexHtml],
  ["dashboard.html", dashHtml],
]) {
  check(`${name}: sync progress bar present`, /id="brainSyncBar"/.test(html));
  check(`${name}: sync status label present`, /id="brainSyncLabel"/.test(html));
  check(`${name}: unclosable admin overlay present`, /id="adminOverlay"/.test(html));
  // The overlay must carry no dismiss control — a close button would promise a
  // cancellation that does not exist for an already-committed restart/OTA swap.
  const overlay = html.slice(html.indexOf('id="adminOverlay"'), html.indexOf('id="adminOverlay"') + 900);
  check(
    `${name}: overlay offers no close/cancel control`,
    !/id="adminOverlayClose"|>Cancel<|>Dismiss</.test(overlay),
  );
}
check("dashboard.js consumes the node event stream", /EventSource\(\s*"\/api\/system\/events"/.test(dashJs));
check("dashboard.js paints backend sync progress", /function renderBrainSync/.test(dashJs));
check("dashboard.js shows the admin overlay", /function showAdminOverlay/.test(dashJs));