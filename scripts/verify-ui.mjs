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
// app.js gets the same treatment: the sanitizer's docblock deliberately QUOTES
// the old `.replace(/\D+/g, "")` line to record what it replaced, and asserting
// against raw text would flag that note as a live digits-only filter.
const appJsCode = stripComments(appJs);

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

// --- 7. REMOTE / CLOUD LINK ACCEPTS ALPHANUMERIC CODES ------------------------
//
// The sibling bug to the Master Node field above: this input ALSO assumed the
// value could only ever be digits, via three separate mechanisms (the numeric
// keyboard hint, a maxlength of 6, and a digits-only keystroke filter). Together
// they turned a pasted RIPPA-D2N6-6VZV into D266VZV before it ever left the
// browser. Each mechanism is asserted separately, because any one of them
// reintroduces the bug on its own.
const cloudField = indexHtml.match(/<input id="cloudLink"[^>]*>/)?.[0] ?? "";
check(
  'Cloud Link field is type="text" (not type="number")',
  /type="text"/.test(cloudField) && !/type="number"/.test(cloudField),
  cloudField.slice(0, 70),
);
check(
  "Cloud Link field has no numeric keyboard hint",
  !/id="cloudLink"[^>]*inputmode="numeric"/.test(indexHtml),
);
check(
  "Cloud Link field is not capped at 6 characters (a node code is 15)",
  !/id="cloudLink"[^>]*maxlength="6"/.test(indexHtml),
  cloudField.match(/maxlength="\d+"/)?.[0] ?? "no maxlength",
);
check(
  "app.js has NO digits-only filter on the Cloud Link value",
  !/cloudLink\.value\.replace\(\/\\D/.test(appJsCode),
);
check(
  "app.js sanitizes link input to A-Z / 0-9 / hyphen instead",
  /function sanitizeLinkInput/.test(appJsCode) && /\[\^A-Z0-9-\]/.test(appJsCode),
);
check(
  "the sanitizer is bound to the Cloud Link field",
  /bindLinkSanitizer\(cloudLink\)/.test(appJsCode),
);
check(
  "the sanitizer is also bound on paste (mobile WebViews can skip input)",
  /addEventListener\("paste"/.test(appJsCode),
);
check(
  "Cloud Link field placeholder advertises both accepted forms",
  /id="cloudLink"[\s\S]{0,300}?placeholder="[^"]*RIPPA-/.test(indexHtml) &&
    /id="cloudLink"[\s\S]{0,300}?placeholder="[^"]*\d{6}|123456/.test(indexHtml),
);

// The sanitizer's own behaviour, executed rather than pattern-matched: this is
// the actual "does RIPPA-D2N6-6VZV survive a round trip" question.
const sanitizeSrc = appJs.match(/function sanitizeLinkInput\(value\)\s*\{[\s\S]*?\n\}/)?.[0] ?? "";
if (sanitizeSrc) {
  // eslint-disable-next-line no-new-func
  const sanitize = new Function(`${sanitizeSrc}; return sanitizeLinkInput;`)();
  const pasted = "  rippa-d2n6-6vzv  ";
  check(
    "pasting RIPPA-D2N6-6VZV survives sanitising (no dropped characters)",
    sanitize(pasted) === "RIPPA-D2N6-6VZV",
    `"${pasted}" -> "${sanitize(pasted)}"`,
  );
  check("a 6-digit relay code still passes through untouched", sanitize("123456") === "123456");
  // Spaces/punctuation are REMOVED, not turned into hyphens. The server-side
  // normaliser repairs the grouping afterwards, so "RIPPA D2N6 6VZV" still lands
  // as a valid RIPPA-D2N6-6VZV — what must never happen is the field refusing
  // the input or eating the letters.
  check(
    "spaces and punctuation are stripped, not refused",
    sanitize("RIPPA D2N6 6VZV!") === "RIPPAD2N66VZV",
    `"RIPPA D2N6 6VZV!" -> "${sanitize("RIPPA D2N6 6VZV!")}"`,
  );
  check("a runaway paste is capped rather than unbounded", sanitize("A".repeat(500)).length === 24);
}

// --- 8. REGENERATABLE NODE IDENTITY ------------------------------------------
//
// The code used to be unchangeable: "permanent" in the UI, no API, no UI. The
// recovery from a bad code was deleting files and reinstalling. These assert
// each layer of the replacement independently.
for (const [name, html] of [
  ["index.html", indexHtml],
  ["dashboard.html", dashHtml],
]) {
  check(`${name}: a Regenerate Code control exists`, /id="ccRegenCode"/.test(html));
}
check("Setup exposes the node code as an editable text field", /id="nodeCode"[^>]*type="text"/.test(indexHtml));
check("Setup exposes a manual 'Set' control for a hand-typed code", /id="setNodeCode"/.test(indexHtml));
check("app.js binds the Regenerate button", /regenNodeCodeBtn\.addEventListener\("click"/.test(appJs));
check("app.js binds the manual Set button", /setNodeCodeBtn\.addEventListener\("click"/.test(appJs));
check("app.js calls the regenerate endpoint", /\/api\/config\/regenerate-code/.test(appJs));
check("app.js repaints the code straight from the response (no restart)", /renderNodeCode\(data\.nodeCode/.test(appJs));
check("dashboard.js calls the regenerate endpoint too", /\/api\/config\/regenerate-code/.test(dashJs));
check("the manual path validates the code shape before sending", /\^RIPPA-\[0-9A-HJ-NP-Z\]/.test(appJs));
