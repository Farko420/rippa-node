/**
 * Contract tests for the RELEASE PIPELINE in .github/workflows/build-node.yml.
 *
 * WHY THIS FILE EXISTS
 *
 * OTA updates were aborting, and the failure was invisible from the Actions UI:
 * a green run, a release page, and a fleet that never moved. Every individual
 * setting in the workflow was defensible on its own, which is precisely why
 * nothing looked wrong:
 *
 *   * `push: branches: [main, master]` with NO `tags:`. `git push origin v1.0.11`
 *     — the ordinary way to cut a release — matched no trigger at all. No build,
 *     no release, and a green page because nothing ran.
 *   * `release: types: [published]` while the workflow itself PUBLISHES a
 *     release. That is a self-trigger, and it settles only because
 *     `softprops/action-gh-release` updates the existing release rather than
 *     creating a second one. That is the action's behaviour, not GitHub's.
 *   * `fail_on_unmatched_files: false`. Deliberate — it stops a packaging path
 *     rename from aborting the run — but it means a renamed binary publishes a
 *     release with NO .exe asset and still reports success. And
 *     `parseLatestRelease` (src/services/updater.ts) REJECTS an assetless
 *     release outright, so every node silently skips the update.
 *
 * So the properties that matter are not visible in a diff; they are relations
 * between the workflow and the updater that reads what it publishes. That is
 * what is asserted here.
 *
 * It ALSO parse-checks every `pwsh` step. A PowerShell syntax error in a
 * workflow step surfaces as a failed run with a line number in generated YAML
 * nobody can map back to a source line, which is the most expensive kind of
 * small mistake. The steps are extracted with `${{ ... }}` replaced by
 * placeholders, because GitHub substitutes those BEFORE the shell runs and
 * leaving them in place would test text the runner never executes.
 *
 * Run with: node scripts/verify-release-workflow.mjs
 *   (then: powershell -NoProfile -File <generated ps-check.ps1>)
 */
import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import yaml from "yaml";

// `ROOT` is the REPO root, not this file's directory — this script lives in
// scripts/ and reads a workflow at the top of the tree.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const raw = readFileSync(path.join(ROOT, ".github/workflows/build-node.yml"), "utf8");
const doc = yaml.parse(raw);

/* ── 1. YAML shape ───────────────────────────────────────────────────────── */

let failed = 0;
let checkedPowerShell = false;
const check = (name, ok, detail = "") => {
  if (ok) {
    console.log(`  ok  ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${name}${detail ? `\n       ${detail}` : ""}`);
  }
};

const job = doc.jobs["build-and-release"];

check("the workflow parses as YAML", Boolean(doc.jobs), "no jobs found");
check("push triggers on the default branches", JSON.stringify(doc.on.push?.branches) === '["main","master"]', JSON.stringify(doc.on.push?.branches));

/*
  THE TAG TRIGGER IS THE FIX. With `branches:` alone, `git push origin v1.0.11`
  matches no trigger at all: no build, no release, no OTA, and a green Actions
  page because nothing ran.
*/
check("push triggers on version tags too", JSON.stringify(doc.on.push?.tags) === '["v*"]', JSON.stringify(doc.on.push?.tags));

check("contents: write is granted", doc.permissions?.contents === "write", JSON.stringify(doc.permissions));

const publish = (job.steps ?? []).find((s) => s.uses?.startsWith("softprops/action-gh-release"));
check("the release step uses action-gh-release@v2", publish?.uses === "softprops/action-gh-release@v2", publish?.uses);
check("it uploads .exe files", /\.exe/.test(publish?.with?.files ?? ""), publish?.with?.files);
check("it publishes to the rolling 'latest' tag", publish?.with?.tag_name === "latest", publish?.with?.tag_name);
check("the release target is a SHA, never a branch", /steps\.release_tag\.outputs\.commitish/.test(publish?.with?.target_commitish ?? ""));

/*
  THE LOOP GUARD. The workflow publishes a release, and publishing a release
  fires the `release` trigger again. Without this `if:`, that is an infinite
  rebuild-and-republish loop — and because the version-bump step also COMMITS
  BACK, it would bury the repo in "chore: bump version" commits.
*/
check("the release-triggered run is guarded against self-retrigger", /github\.event\.release\.tag_name != 'latest'/.test(job.if ?? ""), job.if);

/*
  THE TAG MUST NOT BUMP. `extractVersion` in src/services/updater.ts reads the
  version out of the release NAME, and a tag push that bumps publishes a release
  whose body contradicts the tag the operator just pushed.
*/
const bump = (job.steps ?? []).find((s) => s.id === "version");
check("a tag push takes its version from the tag", /github\.ref_type.*tag/.test(bump?.run ?? "") && /regex\]::Match/.test(bump?.run ?? ""), "the bump step is tag-unaware");

const commitBump = (job.steps ?? []).find((s) => s.name === "Commit the version bump");
check("the commit-back is skipped on a tag (detached HEAD)", /github\.ref_type != 'tag'/.test(commitBump?.if ?? ""), commitBump?.if);

/*
  THE VERIFICATION STEP, AND THE ASSET NAME IT ENFORCES.

  The updater fetches its binary by LITERAL FILENAME lookup —
  `/releases/latest/download/rippa-node.exe` — so the asset name is part of the
  updater's public contract, not a packaging detail. A release that publishes the
  right bytes under any other name 404s on every node, and does so silently: the
  release page looks perfect and the fleet simply never updates.

  So this step is asserted to check for that EXACT name, and the workflow's
  `files:` list is asserted to name the same file explicitly. The two are the same
  contract seen from each side, which is why they are asserted together rather
  than separately — a rename that changed only one of them is precisely the bug.

  The watchdog is asserted too: a release carrying a worker with no supervisor
  reproduces the original fault (a restart that acts as a shutdown), so shipping
  one without the other is not a state the fleet should ever reach.
*/
const verify = (job.steps ?? []).find((s) => String(s.name ?? "").startsWith("Verify the published"));
check("a post-publish verification step exists", Boolean(verify));
check("it reads the endpoint the fleet polls", /releases\/latest/.test(verify?.run ?? ""));

// The exact name, matching RELEASE_ASSET_NAME in src/services/updater.ts.
const ASSET = "rippa-node.exe";
check(
  "the verification names the exact asset the updater requests",
  verify?.run?.includes(`$expectedAsset = '${ASSET}'`),
  "the workflow and the updater must agree on the literal filename",
);
check(
  "it matches that asset by EXACT name, not by wildcard",
  /Where-Object \{ \$_\.name -eq \$expectedAsset \}/.test(verify?.run ?? "") &&
    !/Where-Object \{ \$_\.name -like "\*\\\.exe" \}/.test(verify?.run ?? ""),
  'a -like "*.exe" rule is a coin flip between the worker and the watchdog',
);
check(
  "it requires the watchdog asset as well",
  /rippa-watchdog\.exe/.test(verify?.run ?? ""),
  "a worker with no supervisor regresses restart-as-shutdown",
);

/*
  THE RELEASE MUST NAME ITS FILES, NOT GLOB THEM.

  `files: dist/*.exe` published whatever happened to be in dist/ — which, now that
  the supervisor ships too, includes a second .exe the asset-selection rule has to
  disambiguate. Worse, `fail_on_unmatched_files: false` meant a rename published a
  release with NO asset at all while the run reported success: the exact shape of
  the silent 404 this whole contract exists to prevent.
*/
const files = publish?.with?.files ?? "";
check(
  "the worker is published under its exact name",
  files.includes(`dist/${ASSET}`),
  files,
);
check("the watchdog is published too", files.includes("dist/rippa-watchdog.exe"), files);
check(
  "no wildcard .exe glob is published",
  !/\*\.exe/.test(files),
  "a glob publishes whatever dist/ happens to contain, which is not a contract",
);
check(
  "a missing file FAILS the release instead of publishing an empty one",
  publish?.with?.fail_on_unmatched_files === true,
  String(publish?.with?.fail_on_unmatched_files),
);

/*
  THE LOCATE STEP MUST PICK THE WORKER BY NAME.

  It used to take the LARGEST .exe, which only ever returned the worker by
  accident — an accident that ends the moment the watchdog grows past it, and
  would then publish a supervisor as the fleet's worker.
*/
const locate = (job.steps ?? []).find((s) => s.id === "exe");
check(
  "the artifact is located by exact name, not by size",
  locate?.run?.includes(`$wanted = '${ASSET}'`) && !/Sort-Object Length/.test(locate?.run ?? ""),
  "size-ordering is how the wrong binary gets published",
);

/* ── 2. PowerShell parses ────────────────────────────────────────────────── */

let out = "";
for (const [index, step] of (job.steps ?? []).entries()) {
  if (step.shell !== "pwsh" || !step.run) continue;
  const body = String(step.run).replace(/\$\{\{[^}]*\}\}/g, "PLACEHOLDER");
  out += `function Step_${index} {\n${body}\n}\n`;
}
writeFileSync(path.join(ROOT, "ps-check.ps1"), out, "utf8");

/*
  PARSE-CHECK THE POWERSHELL, WHEN A POWERSHELL IS AVAILABLE.

  Done in-process rather than by shelling out to `powershell -File`, because that
  needs a script on disk to report line numbers against, and the file this script
  just wrote is the one to report against. `pwsh` is preferred (cross-platform,
  and what `windows-latest` actually runs) with `powershell` as the fallback.

  SKIPPED, NOT PASSED, when neither exists: a machine with no PowerShell cannot
  prove the steps parse, and saying "ok" there would be a lie. The YAML
  assertions above have already run by this point.
*/
const { spawnSync } = await import("node:child_process");
const script = path.join(ROOT, "ps-check.ps1");
for (const shell of ["pwsh", "powershell"]) {
  const probe = spawnSync(shell, ["-NoProfile", "-Command", ""], { stdio: "ignore" });
  if (probe.error) continue;
  const result = spawnSync(
    shell,
    ["-NoProfile", "-Command", `$e=$null;[void][System.Management.Automation.Language.Parser]::ParseFile('${script}',[ref]$null,[ref]$e);if($e -and $e.Count){$e|%{Write-Host ("  line {0}: {1}" -f $_.Extent.StartLineNumber,$_.Message)};exit 1}else{Write-Host '  ok  every pwsh step parses'}`],
    { encoding: "utf8" },
  );
  const out = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  console.log(out || `  ${result.status === 0 ? "ok" : "FAIL"}  pwsh parse check via ${shell}`);
  if (result.status !== 0) failed += 1;
  checkedPowerShell = true;
  break;
}
if (!checkedPowerShell) {
  console.log("  skip  no PowerShell on this machine — pwsh steps were not parse-checked");
}

console.log(failed === 0 ? "\nall workflow assertions passed\n" : `\n${failed} FAILED\n`);
process.exit(failed === 0 ? 0 : 1);