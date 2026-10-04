/**
 * HETEROGENEOUS FLEET + AI ENDPOINT — capability flags, role badges, the
 * nullification rule and the network policy.
 *
 * WHY THIS FILE EXISTS. Three of the five epics share a failure mode that no
 * type-checker catches: a piece of state that is supposed to mean "unknown" is
 * quietly coerced into "no", and the UI then states as fact something nobody
 * established. `ai_enabled: null` -> `false` is the specific version of that bug
 * here, and it is why most of the checks below assert the PRESERVATION of a
 * tri-state rather than a particular rendered string.
 *
 * The other recurring risk is the inverse: relaxing validation so hard that a
 * genuine mistake is accepted. The "cannot clear a field you set" fix must not
 * become "accepts anything" — so enabling with no URL is still asserted as a
 * refusal, in the same run as the disable-with-blank case that must be accepted.
 *
 * Pure in-process checks (no network, no browser, no Android SDK), matching
 * verify-mobile.mjs. Runs against `npm run build` output.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { ROOT, check, results } from "./verify-harness.mjs";

/*
  `dist/` is emitted as CommonJS (the package is `"type": "commonjs"`), so the
  built modules are loaded through `createRequire`. A dynamic `import()` of these
  files resolves them as CommonJS but exposes only the default export, which is
  the module.exports object — the named exports are not reachable that way.
*/
const requireBuilt = createRequire(path.join(ROOT, "scripts", "verify-fleet-roles.mjs"));
const load = (rel) => requireBuilt(path.join(ROOT, rel));

const caps = load("dist/services/nodeCapabilities.js");

// === 1. THE TRI-STATE MUST SURVIVE ==========================================
/*
  The load-bearing assertions of the whole feature. If `false` and `null` collapse
  together anywhere downstream, the fleet view starts labelling nodes that never
  checked in as confirmed scrapers.
*/
check("normaliseAiEnabled keeps a true", caps.normaliseAiEnabled(true) === true);
check("normaliseAiEnabled keeps a false", caps.normaliseAiEnabled(false) === false);
check("normaliseAiEnabled maps null to null, NOT false", caps.normaliseAiEnabled(null) === null);
check("normaliseAiEnabled maps undefined to null", caps.normaliseAiEnabled(undefined) === null);
check("a non-boolean (0) is unknown, not 'no AI'", caps.normaliseAiEnabled(0) === null);
check("the string 'false' is unknown, not 'no AI'", caps.normaliseAiEnabled("false") === null);

const empty = caps.emptyCapabilities();
check("an unreported node starts as aiEnabled: null", empty.aiEnabled === null);
check(
  "an unreported node has no models",
  Array.isArray(empty.aiModels) && empty.aiModels.length === 0,
);

// === 2. MERGING RULES ========================================================
/*
  A heartbeat that omits capabilities must NOT erase what a previous one
  established, or every poll from an older build resets the fleet's knowledge.
*/
const knownAi = caps.mergeCapabilities(empty, {
  aiEnabled: true,
  aiModels: ["qwen2.5:1.5b"],
  runtime: "node",
  scrapingMode: "Headless Chromium",
});
const unchanged = caps.mergeCapabilities(knownAi, {});
check("an empty heartbeat preserves a known role", unchanged.aiEnabled === true);
check("an empty heartbeat preserves the model list", unchanged.aiModels.length === 1);

// The converse also matters: an explicit false must be able to turn AI OFF.
const turnedOff = caps.mergeCapabilities(knownAi, { aiEnabled: false });
check(
  "an explicit false overwrites a previous true",
  turnedOff.aiEnabled === false,
  String(turnedOff.aiEnabled),
);

// === 3. MODEL LIST HYGIENE ===================================================
/*
  Blank strings in the model list are the exact "empty model slot" the badge work
  replaces, so they are dropped rather than rendered.
*/
const mergedModels = caps.mergeCapabilities(empty, { aiModels: ["a", "", "  ", "a", " b "] });
check("blank model names are dropped", !mergedModels.aiModels.includes(""));
check("duplicates are collapsed", mergedModels.aiModels.filter((m) => m === "a").length === 1);
check("names are trimmed", mergedModels.aiModels.includes("b"));

// === 4. THE AI PAYLOAD MUST NOT BE DOWNGRADED BY THE SPREAD =================
/*
  `describeAiCapabilities` spreads the non-AI payload and then re-asserts
  aiEnabled. This exists specifically to fail if someone removes that re-assertion
  and silently turns every AI node into a scraper.
*/
const aiPayload = caps.describeAiCapabilities(["qwen2.5:1.5b"]);
check("an AI payload reports aiEnabled: true", aiPayload.aiEnabled === true);
check("an AI payload carries its models", aiPayload.aiModels.length === 1);

const scraperPayload = caps.describeCapabilities();
check("a non-AI payload reports aiEnabled: false", scraperPayload.aiEnabled === false);
check("a non-AI payload has no models", scraperPayload.aiModels.length === 0);
check("a non-AI payload still names a scraping mode", Boolean(scraperPayload.scrapingMode));

// === 5. THE AI ENDPOINT MODAL: VALIDATION IS CONDITIONAL =====================
const ai = load("dist/services/aiEndpointSettings.js");

check(
  "enabling with NO url is refused",
  typeof ai.validateAiEndpointSettings({ active_model: "m" }) === "string",
);
check(
  "enabling with a url but NO model is refused",
  typeof ai.validateAiEndpointSettings({ ai_endpoint: "http://127.0.0.1:11434" }) === "string",
);
check(
  "enabling with a NON-http url is refused",
  typeof ai.validateAiEndpointSettings({ ai_endpoint: "javascript:alert(1)", active_model: "m" }) === "string",
);
check(
  "enabling with a schemeless host is refused",
  typeof ai.validateAiEndpointSettings({ ai_endpoint: "example.com", active_model: "m" }) === "string",
);
check(
  "a complete, valid submission is accepted",
  ai.validateAiEndpointSettings({ ai_endpoint: "http://127.0.0.1:11434", active_model: "m" }) === null,
);

// === 6. THE NULLIFICATION RULE (the reported bug) ============================
/*
  THE CENTRAL ASSERTION. Turning the feature off must leave no residue, and the
  residue must be NULL rather than "". A stored "" is a URL that matches nothing
  and would read as "configured but broken" forever.
*/
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rippa-ai-"));
process.env["RIPPA_CONFIG_ROOT"] = tmpRoot;

const savedOn = ai.saveAiEndpointSettings({
  ai_enabled: true,
  ai_endpoint: "http://127.0.0.1:11434",
  active_model: "qwen2.5:1.5b",
  ai_model: "nomic-embed-text",
});
check("an enabled save stores the endpoint", savedOn.ai_endpoint === "http://127.0.0.1:11434");
check("an enabled save reports configured", ai.isAiEndpointConfigured(savedOn) === true);

// Now the bug: clear the URL while turning the feature OFF.
const cleared = ai.saveAiEndpointSettings({
  ai_enabled: false,
  ai_endpoint: "",
  active_model: "",
  ai_model: "",
});
check("disabling does not throw on a blank form", cleared.ai_enabled === false);
check("disabling nullifies the endpoint (null, not '')", cleared.ai_endpoint === null);
check("disabling nullifies the active model", cleared.active_model === null);
check("disabling nullifies the embedding model", cleared.ai_model === null);
check(
  "a disabled node is NOT reported as a configured provider",
  ai.isAiEndpointConfigured(cleared) === false,
);

// Whitespace-only must collapse to null too: that is what a half-deleted value
// actually looks like on disk.
const spaced = ai.saveAiEndpointSettings({
  ai_enabled: true,
  ai_endpoint: "   ",
  active_model: "  ",
  ai_model: "",
});
check("whitespace-only is stored as null, not as a broken URL", spaced.ai_endpoint === null);
check("whitespace-only model is stored as null", spaced.active_model === null);

/*
  THE NORMALISE-ROUND-TRIP. `writeConfig` normalises rather than merges, so any
  field `normalizeConfig` forgets is DELETED on the next unrelated save. This
  asserts the fields actually survive a write/read cycle, which is the exact way
  an operator's fallback endpoint would silently disappear.
*/
const reread = ai.getAiEndpointSettings();
check("settings survive a config round-trip", reread.ai_enabled === true);
check("a whitespace value stays null after a round-trip", reread.ai_endpoint === null);

// A stale URL must not be reported when the feature is off, even if the file
// still physically contains one (a hand-edited config.json).
fs.writeFileSync(
  path.join(tmpRoot, "config.json"),
  JSON.stringify({
    NODE_API_KEY: "abcdefgh",
    NODE_NAME: "T",
    ai_enabled: false,
    ai_endpoint: "http://leftover:11434",
    active_model: "stale-model",
  }),
  "utf8",
);
const stale = ai.getAiEndpointSettings();
check("a stale URL is ignored while the feature is off", stale.ai_endpoint === null, String(stale.ai_endpoint));

// === 7. NETWORK POLICY (Epic 5) ==============================================
const net = load("dist/agent/DeviceNetwork.js");

check("the default policy allows mobile data", net.DEFAULT_NETWORK_POLICY.wifiOnly === false);
check("an absent policy falls back to the default", net.normaliseNetworkPolicy(null).wifiOnly === false);
check(
  "a corrupt value does not arm the restriction",
  net.normaliseNetworkPolicy({ wifiOnly: "yes" }).wifiOnly === false,
);
check("an explicit true arms it", net.normaliseNetworkPolicy({ wifiOnly: true }).wifiOnly === true);

const wifi = { kind: "wifi", metered: false, downlinkMbps: 50, source: "connection-api" };
const cell = { kind: "cellular", metered: true, downlinkMbps: 10, source: "connection-api" };
const blind = { kind: "unknown", metered: false, downlinkMbps: null, source: "unavailable" };

check("wifi-only ALLOWS work on wifi", net.evaluateNetwork(wifi, { wifiOnly: true }).allowed === true);

const blocked = net.evaluateNetwork(cell, { wifiOnly: true });
check("wifi-only REFUSES work on cellular", blocked.allowed === false);
check("the refusal names the cellular restriction", blocked.cellularRestricted === true);
check("the refusal reason is operator-facing", /Cellular Restricted/.test(blocked.reason));

check(
  "cellular is allowed when the policy permits it",
  net.evaluateNetwork(cell, { wifiOnly: false }).allowed === true,
);
/*
  FAIL-OPEN, mirroring evaluatePower. A WebView without navigator.connection must
  not refuse to work at all — but note it must NOT report as wifi either, which is
  why the verdict carries `allowed` rather than a kind.
*/
check("an unreadable transport fails open", net.evaluateNetwork(blind, { wifiOnly: true }).allowed === true);

// === 8. DATA USAGE ROLLING WINDOWS ==========================================
const tracker = new net.DataUsageTracker();
const t0 = Date.now();

// Baseline: the page's own load must NOT be counted as swarm usage.
const baseline = tracker.record(t0, 5_000_000, 9_000_000);
check(
  "the first sample establishes a baseline and counts zero",
  baseline.received24h === 0 && baseline.sent24h === 0,
);
check("the page-load baseline is NOT counted as swarm usage", baseline.received24h !== 9_000_000);

// +2 MB received one minute later.
tracker.record(t0 + 60_000, 5_000_000, 11_000_000);
const afterMinute = tracker.usage(t0 + 60_000);
check("a delta of 2MB is recorded", afterMinute.received1h === 2_000_000, String(afterMinute.received1h));
check("the 1h and 24h windows agree inside the hour", afterMinute.received1h === afterMinute.received24h);

// +2 MB more, but 23 hours on: inside the 24h window, outside the 1h window.
const tLate = t0 + 23 * 3600 * 1000;
tracker.record(tLate, 5_000_000, 13_000_000);
const late = tracker.usage(tLate);
check("an older sample leaves the 1h window", late.received1h === 2_000_000, String(late.received1h));
check(
  "an older sample stays in the 24h window",
  late.received24h === 4_000_000,
  String(late.received24h),
);

/*
  A navigation clears the Resource Timing counters, which would otherwise make the
  delta negative and report a NEGATIVE transfer — worse than reporting none.
*/
const afterReset = tracker.record(tLate + 60_000, 0, 0);
check("a counter reset never yields a negative figure", afterReset.received1h >= 0);

check("formatBytes renders zero as 0 B", net.formatBytes(0) === "0 B");
check("formatBytes renders megabytes", net.formatBytes(2_000_000) === "1.9 MB", net.formatBytes(2_000_000));
// 1_400_000 / 1024^2 = 1.335 MB, so one decimal is "1.3" — the rounding boundary
// matters, which is why the expectation is spelled out rather than eyeballed.
check("formatBytes renders a fractional MB", net.formatBytes(1_400_000) === "1.3 MB", net.formatBytes(1_400_000));
check("formatBytes refuses to render a negative figure", net.formatBytes(-5) === "0 B");

// === 9. THE UI GATE IS TRI-STATE, NOT BOOLEAN ================================
/*
  A last, cheap guard against the original defect reappearing in the front end:
  the markup must gate the inference action on `=== true`, never on truthiness,
  because `null` is exactly the value that would slip through such a gate.
*/
const dashJs = fs.readFileSync(path.join(ROOT, "public/dashboard.js"), "utf8");
const dashHtml = fs.readFileSync(path.join(ROOT, "public/dashboard.html"), "utf8");

check(
  "the inference test is gated on an explicit `=== true`",
  /aiEnabled\s*!==\s*true|aiEnabled\s*===\s*true/.test(dashJs),
);
check(
  "no inference action is gated on a bare truthiness check of aiEnabled",
  !/if\s*\(\s*satellite\.aiEnabled\s*\)/.test(dashJs),
);
check("the AI Mesh Health panel is present", dashHtml.includes('id="aiMeshList"'));
check("the AI endpoint modal is present", dashHtml.includes('id="aiSettingsModal"'));
check("the modal's fallback toggle exists", dashHtml.includes('id="aiFallbackToggle"'));
check("scraper rows are muted, not filtered out", dashJs.includes("ai-mesh-row"));

// Tidy up the throwaway config root, only after every read has happened.
fs.rmSync(tmpRoot, { recursive: true, force: true });
delete process.env["RIPPA_CONFIG_ROOT"];

const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} checks passed.`);
process.exit(failed ? 1 : 0);
