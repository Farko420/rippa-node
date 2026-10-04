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

/*
  THE HANG GUARD.

  This job sat for 3+ hours on pkg's "Fetching base Node.js binaries to
  PKG_CACHE_PATH" step. The fetch inside @yao-pkg/pkg-fetch awaits an
  `undici.fetch` that is never aborted, so a stalled connection parks the step
  forever and, with no job timeout, holds the runner until GitHub's 6-hour
  ceiling.

  The timeout is asserted with an upper bound as well as a value, because
  "there is a timeout" is only half the property: a `timeout-minutes: 360`
  would satisfy a bare existence check while reintroducing the exact failure.
*/
check(
  "the release job has a timeout, so a pkg stall cannot burn the runner",
  typeof job["timeout-minutes"] === "number" && job["timeout-minutes"] > 0,
  `timeout-minutes is ${JSON.stringify(job["timeout-minutes"])}`,
);
check(
  "the release job's timeout is short enough to actually fail fast",
  job["timeout-minutes"] <= 30,
  `timeout-minutes is ${job["timeout-minutes"]}; anything above ~30 stops being a hang guard`,
);

/*
  THE PKG BINARY CACHE.

  `~/.pkg-cache` is pkg-fetch's own default — `places.js` computes
  `cachePath = PKG_CACHE_PATH || path.join(os.homedir(), '.pkg-cache')` — so
  caching that path is what makes the ~100 MB base binary survive between runs
  instead of being re-downloaded (and re-stalled) every time.

  It must also come BEFORE the build step, and the ordering is asserted rather
  than assumed: a cache step placed after the build is a cache step that has
  already missed its only opportunity to help.
*/
const pkgCache = (job.steps ?? []).find((s) => s.uses?.startsWith("actions/cache"));
const buildStep = (job.steps ?? []).find((s) => /npm run package/.test(s.run ?? ""));

check("the pkg base-binary cache exists", Boolean(pkgCache));
check(
  "it caches pkg's real cache directory (~/.pkg-cache)",
  (pkgCache?.with?.path ?? "").trim() === "~/.pkg-cache",
  `path is ${JSON.stringify(pkgCache?.with?.path)}`,
);
check(
  "the cache key is scoped to the runner OS",
  /^pkg-\$\{\{ runner\.os \}\}-/.test(pkgCache?.with?.key ?? ""),
  `key is ${JSON.stringify(pkgCache?.with?.key)}`,
);
check(
  "the cache is restored before the build, not after it",
  Boolean(pkgCache && buildStep) &&
    job.steps.indexOf(pkgCache) < job.steps.indexOf(buildStep),
  "a cache step after the build never helps the build",
);

/*
  THE CACHE KEY MUST PIN THE pkg-fetch VERSION.

  pkg resolves the `node22` target to a concrete patch version (v22.23.2) via
  pkg-fetch's patches.json, and that mapping moves on every pkg-fetch upgrade.
  A key that omits the version keeps serving a binary whose hash no longer
  matches, which pkg reports as "Binary hash does NOT match. Re-fetching..." —
  and then re-stalls. Asserted because this is silent in the Actions log when
  the restore itself "succeeds".
*/
check(
  "the cache key pins the installed pkg-fetch version",
  /steps\.pkgver\.outputs\.version/.test(pkgCache?.with?.key ?? ""),
  `key is ${JSON.stringify(pkgCache?.with?.key)}`,
);
check(
  "the pkg-fetch version is resolved from the INSTALLED package, not the manifest",
  /node_modules\/@yao-pkg\/pkg-fetch\/package\.json/.test(
    (job.steps ?? []).find((s) => s.id === "pkgver")?.run ?? "",
  ),
  "reading package.json instead cannot see a resolved/overridden install",
);

/*
  THE TARGET MUST HAVE A PREBUILT BINARY — THIS IS THE EXPENSIVE ONE TO LEARN.

  This is asserted as a hard rule because the inverse was actually proposed as
  a fix for the hang above: "downgrade node22 to node20 to guarantee a prebuilt
  binary exists". For the pinned @yao-pkg/pkg-fetch (v3.6) that is exactly
  backwards. pkg-fetch's `need()` downloads the release asset and, on failure,
  falls through to `Building base binary from source:` — and the v3.6 release
  ships NO node20 win-x64 asset:

      node-v20.20.2-win-x64  -> HTTP 404  (absent from the v3.6 release)
      node-v22.23.2-win-x64  -> HTTP 206  (present)

  So switching to node20 would not have avoided the multi-hour stall, it would
  have CAUSED one on every single run — a Node source build on a Windows
  runner that needs a full toolchain and hours of CPU.

  node22 is therefore load-bearing and must stay: better-sqlite3 13.x declares
  `engines: node >=22` and its prebuilds are N-API, and @yao-pkg/pkg itself
  requires `>=22.0.0`. Node 20 is not a safe fallback for this dependency set.
*/
const pkgScript = readFileSync(path.join(ROOT, "scripts/package.mjs"), "utf8");
const targets = [...pkgScript.matchAll(/--targets",?\s*\n?\s*"([^"]+)"/g)].map((m) => m[1]);
check(
  "the bundler targets node22, which HAS a prebuilt win-x64 binary",
  targets.length > 0 && targets.every((t) => t === "node22-win-x64"),
  `found targets ${JSON.stringify(targets)}; node20-win-x64 404s on pkg-fetch v3.6 and falls back to a source build`,
);
check(
  "the worker and the watchdog share one target (no runtime skew)",
  new Set(targets).size === 1,
  `targets ${JSON.stringify(targets)} would put the supervisor on a different Node than the worker`,
);
/*
  Asserted against the steps' real `env:` values, not against the raw file text.
  Scanning the text would match the comment above that documents this very
  rule — a check that fails the moment someone explains it is a check that
  teaches the wrong lesson.
*/
const setsPkgCachePath = (job.steps ?? []).some((s) =>
  Object.values(s.env ?? {}).some((v) => /PKG_CACHE_PATH/.test(String(v))),
);
check(
  "no step overrides PKG_CACHE_PATH away from the cached path",
  !setsPkgCachePath,
  "PKG_CACHE_PATH overrides ~/.pkg-cache, so the cache step would save nothing while reporting a hit",
);

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
  const probe = spawnSync(shell, ["-NoProfile", "-Command", ""], {
    stdio: "ignore",
    windowsHide: true,
  });
  if (probe.error) continue;
  const result = spawnSync(
    shell,
    ["-NoProfile", "-Command", `$e=$null;[void][System.Management.Automation.Language.Parser]::ParseFile('${script}',[ref]$null,[ref]$e);if($e -and $e.Count){$e|%{Write-Host ("  line {0}: {1}" -f $_.Extent.StartLineNumber,$_.Message)};exit 1}else{Write-Host '  ok  every pwsh step parses'}`],
    { encoding: "utf8", windowsHide: true },
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