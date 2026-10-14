/**
 * NODE PROVISIONING BUNDLE — Windows and Android, end to end.
 *
 * Not part of the shipped app. Runs against `npm run build` output and needs no
 * network, no Android SDK and no GitHub token: `fetch` is stubbed so the whole
 * resolve → download → verify → zip flow is exercised against a synthetic
 * release, and the produced archive is then unpacked with `extract-zip` (the
 * same reader the node uses) to prove it is a real zip rather than bytes that
 * merely start with "PK".
 *
 * WHY THE ARCHIVE IS READ BACK. The point of this feature is a file an operator
 * double-clicks. A unit assertion that the buffer is non-empty would pass for an
 * archive Windows refuses to open, so the assertions below are on what a real
 * unzip tool finds inside it.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { ROOT, check, results } from "./verify-harness.mjs";

const require = createRequire(import.meta.url);
const extract = require("extract-zip");
const load = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);

// --- A config root the provisioner can read ----------------------------------
// `buildProvisionConfig` copies THIS node's node code and mesh key into the
// bundle, so the suite needs a deterministic config.json to copy from rather
// than whatever the operator's own machine happens to hold.
const configRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rippa-provision-"));
fs.writeFileSync(
  path.join(configRoot, "config.json"),
  JSON.stringify(
    {
      NODE_ROLE: "master",
      NODE_NAME: "Verify Master",
      NODE_API_KEY: "verify-master-key-0001",
      MOTHERSHIP_URL: "https://rippaadventures.com",
      MASTER_LOCAL_URL: "http://192.168.0.50:4000",
      OLLAMA_URL: "http://127.0.0.1:11434",
      PORT: 4000,
      DASHBOARD_PIN: "4242",
      NODE_CODE: "RIPPA-AAAA-BBBB",
      MESH_KEY: "mesh-key-from-the-master",
    },
    null,
    2,
  ),
);
process.env.RIPPA_CONFIG_ROOT = configRoot;
// A token is required for the resolver to take the authenticated path at all;
// without one it (correctly) declines to call the API and returns null.
process.env.GITHUB_OTA_TOKEN = "ghp_verify_token";
delete process.env.RIPPA_GITHUB_ASSET;

const ghAsset = await load("dist/update/githubAsset.js");
const zip = await load("dist/utils/zipArchive.js");
const provisioner = await load("dist/services/nodeProvisioner.js");

/**
 * Unpacks an in-memory archive into a fresh directory and returns that
 * directory.
 *
 * `extract-zip` takes a PATH rather than a buffer, so the archive is staged on
 * disk first — which is also a stronger test: it is exactly what the operator's
 * unzip tool will be handed.
 */
async function extractZipBuffer(buffer, tag) {
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), `rippa-zip-${tag}-`));
  const archivePath = path.join(stage, "bundle.zip");
  fs.writeFileSync(archivePath, buffer);
  const outDir = path.join(stage, "out");
  await extract(archivePath, { dir: outDir });
  return outDir;
}

// --- 1. `android` is a valid platform ----------------------------------------
check("android is accepted as a platform", provisioner.normalizeProvisionPlatform("android") === "android");
check("android is accepted case-insensitively", provisioner.normalizeProvisionPlatform("Android") === "android");
check("apk is an accepted alias", provisioner.normalizeProvisionPlatform("apk") === "android");
check("windows is accepted", provisioner.normalizeProvisionPlatform("windows") === "windows");
check("win32 is an accepted alias", provisioner.normalizeProvisionPlatform("win32") === "windows");
check("a host platform we cannot build for is rejected", provisioner.normalizeProvisionPlatform("darwin") === null);
check("an empty platform is rejected", provisioner.normalizeProvisionPlatform("") === null);
check(
  "the supported set is exactly windows + android",
  provisioner.SUPPORTED_PROVISION_PLATFORMS.join(",") === "windows,android",
  provisioner.SUPPORTED_PROVISION_PLATFORMS.join(","),
);

// --- 2. The resolver is configured for the Android artefact ------------------
const androidNames = ghAsset.releaseAssetNamesForPlatform("android");
check(
  "the Android lookup prefers the .apk names",
  androidNames.includes("rippa-node.apk") && androidNames.includes("app-release.apk"),
  androidNames.join(", "),
);
check(
  "the Android lookup also knows the workflow's own name",
  androidNames.includes("rippa-satellite.apk"),
  androidNames.join(", "),
);
check(
  "the Android extension fallback is .apk, never .exe",
  ghAsset.releaseAssetExtensionsForPlatform("android").join(",") === ".apk",
  ghAsset.releaseAssetExtensionsForPlatform("android").join(","),
);
check(
  "the desktop lookup is unchanged (rippa-node.exe / .exe)",
  ghAsset.releaseAssetNamesForPlatform("windows").includes("rippa-node.exe") &&
    ghAsset.releaseAssetExtensionsForPlatform("windows").join(",") === ".exe",
);

// A release publishing both must resolve to the RIGHT one per platform, which
// is the whole reason the extension is threaded through rather than inferred.
const MIXED_ASSETS = [
  { id: 11, name: "rippa-node.exe", url: "https://api.github.com/repos/o/r/releases/assets/11" },
  { id: 12, name: "app-release.apk", url: "https://api.github.com/repos/o/r/releases/assets/12" },
];
check(
  "the .apk is selected for android",
  ghAsset.selectAssetForDownload(MIXED_ASSETS, androidNames, [".apk"])?.id === 12,
);
check(
  "the .exe is still selected for desktop",
  ghAsset.selectAssetForDownload(MIXED_ASSETS, ["rippa-node.exe"], [".exe"])?.id === 11,
);
check(
  "the default fallback is still .exe (no existing caller is surprised)",
  ghAsset.selectAssetForDownload(MIXED_ASSETS, [])?.id === 11,
);
check(
  "a renamed .apk still resolves for android",
  ghAsset.selectAssetForDownload(
    [{ id: 13, name: "rippa-node-1.0.86.apk", url: "https://api.github.com/x" }],
    androidNames,
    [".apk"],
  )?.id === 13,
);

// --- 3. The zip writer produces a REAL archive -------------------------------
{
  const archive = zip.createZipArchive([
    { name: "binary.bin", data: Buffer.from([1, 2, 3, 4]) },
    { name: "config.json", data: '{"hello":"world"}', compress: true },
  ]);
  check(
    "the archive starts with the local-file-header magic",
    archive.subarray(0, 4).toString("latin1") === "PK\x03\x04",
  );
  check(
    "the archive ends with an end-of-central-directory record",
    archive.subarray(-22, -18).toString("latin1") === "PK\x05\x06",
  );
  check(
    'crc32 matches the known value for "123456789"',
    zip.crc32(Buffer.from("123456789")) === 0xcbf43926,
  );

  const outDir = await extractZipBuffer(archive, "writer");
  check("extract-zip reads the archive back", fs.existsSync(path.join(outDir, "binary.bin")));
  check(
    "the stored member survives byte-for-byte",
    fs.readFileSync(path.join(outDir, "binary.bin")).equals(Buffer.from([1, 2, 3, 4])),
  );
  check(
    "the deflated member decompresses to the original text",
    fs.readFileSync(path.join(outDir, "config.json"), "utf8") === '{"hello":"world"}',
  );
}

// --- 4. The whole flow, both platforms, against a stubbed release ------------
/*
  ONE STUB, TWO PLATFORMS. The release publishes both artefacts, exactly as the
  real `.github/workflows/build-node.yml` does, and the assertions below check
  that each platform's request lands on ITS OWN asset — which is the requirement
  this feature exists to satisfy.
*/
const APK_BYTES = Buffer.concat([
  Buffer.from([0x50, 0x4b, 0x03, 0x04]), // a real APK is a zip
  Buffer.from("verify-apk-payload"),
]);
const EXE_BYTES = Buffer.concat([
  Buffer.from([0x4d, 0x5a]), // "MZ"
  Buffer.from("verify-exe-payload"),
]);

const RELEASE = {
  tag_name: "v9.9.9",
  draft: false,
  prerelease: false,
  assets: [
    {
      id: 11,
      name: "rippa-node.exe",
      url: "https://api.github.com/repos/Farko420/rippa-node/releases/assets/11",
    },
    {
      id: 12,
      name: "app-release.apk",
      url: "https://api.github.com/repos/Farko420/rippa-node/releases/assets/12",
    },
  ],
};

/** Installs a fetch stub; `assetBody` overrides what the asset URL returns. */
function stubRelease({ assetBody } = {}) {
  const realFetch = globalThis.fetch;
  const asked = [];
  globalThis.fetch = async (url) => {
    const target = String(url);
    asked.push(target);
    if (target.includes("/releases/latest")) {
      return {
        ok: true,
        status: 200,
        json: async () => RELEASE,
        text: async () => JSON.stringify(RELEASE),
      };
    }
    if (target.endsWith("/releases/assets/12")) {
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        arrayBuffer: async () => assetBody ?? APK_BYTES,
      };
    }
    if (target.endsWith("/releases/assets/11")) {
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        arrayBuffer: async () => assetBody ?? EXE_BYTES,
      };
    }
    // The public shortcut is never reached while a token is configured; if it
    // ever is, the test must fail loudly rather than silently pass.
    return {
      ok: false,
      status: 404,
      statusText: "Not Found",
      arrayBuffer: async () => Buffer.alloc(0),
    };
  };
  return { asked, restore: () => (globalThis.fetch = realFetch) };
}

/** Unpacks a bundle into a fresh directory and returns that directory. */
async function unpack(bundle, tag) {
  return extractZipBuffer(bundle.bytes, tag);
}

// ---- 4a. ANDROID ------------------------------------------------------------
{
  const stub = stubRelease();
  try {
    const bundle = await provisioner.buildNodeProvisionBundle({
      platform: "android",
      nodeName: "Kitchen Tablet",
      nodeCode: "RIPPA-D2N6-6VZV",
      masterUrl: "http://192.168.0.50:4000",
    });

    check("the android bundle resolves the APK asset", bundle.assetName === "app-release.apk", bundle.assetName);
    check(
      "the android bundle came from GitHub's asset API (authenticated)",
      bundle.sourceUrl.endsWith("/releases/assets/12"),
      bundle.sourceUrl,
    );
    check(
      "the android bundle is named for its platform and node code",
      bundle.filename === "rippa-node-android-RIPPA-D2N6-6VZV.zip",
      bundle.filename,
    );
    check("the archive starts with a zip header", bundle.bytes.subarray(0, 2).toString("latin1") === "PK");

    const dir = await unpack(bundle, "android");
    check("the bundle contains the APK", fs.existsSync(path.join(dir, "app-release.apk")));
    check("the bundle contains config.json", fs.existsSync(path.join(dir, "config.json")));
    check("the bundle contains the install notes", fs.existsSync(path.join(dir, "PROVISION.txt")));
    check(
      "the APK member is byte-for-byte the release artefact",
      fs.readFileSync(path.join(dir, "app-release.apk")).equals(APK_BYTES),
    );
    check(
      "no .exe leaked into the android bundle",
      !fs.readdirSync(dir).some((f) => f.endsWith(".exe")),
      fs.readdirSync(dir).join(", "),
    );

    const config = JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8"));
    check("the generated config carries the requested node code", config.NODE_CODE === "RIPPA-D2N6-6VZV", config.NODE_CODE);
    check("the generated config carries the requested node name", config.NODE_NAME === "Kitchen Tablet");
    check("the generated config is a satellite", config.NODE_ROLE === "satellite");
    check(
      "the generated config carries the Master's mesh key",
      config.MESH_KEY === "mesh-key-from-the-master",
      String(config.MESH_KEY),
    );
    check("the generated config records the Master's code", config.PAIRED_MASTER_CODE === "RIPPA-AAAA-BBBB");
    check("the generated config points at the Master", config.MASTER_LOCAL_URL === "http://192.168.0.50:4000");
    check(
      "the generated config mints its OWN api key (not the Master's)",
      typeof config.NODE_API_KEY === "string" &&
        config.NODE_API_KEY.length === 64 &&
        config.NODE_API_KEY !== "verify-master-key-0001",
    );

    const notes = fs.readFileSync(path.join(dir, "PROVISION.txt"), "utf8");
    check("the notes name the sideload command", notes.includes("adb install -r app-release.apk"));
    check("the notes say where config.json goes on Android", notes.includes("/sdcard/Android/data/"));
  } finally {
    stub.restore();
  }
}

// ---- 4b. WINDOWS — the SAME flow, unchanged by the Android work -------------
{
  const stub = stubRelease();
  try {
    const bundle = await provisioner.buildNodeProvisionBundle({
      platform: "windows",
      nodeName: "Shed PC",
      pairWithMaster: false,
    });

    check("the windows bundle resolves the .exe asset", bundle.assetName === "rippa-node.exe", bundle.assetName);
    check(
      "the windows bundle came from GitHub's asset API (authenticated)",
      bundle.sourceUrl.endsWith("/releases/assets/11"),
      bundle.sourceUrl,
    );
    check(
      "the windows bundle filename names the platform",
      bundle.filename.startsWith("rippa-node-windows-"),
      bundle.filename,
    );

    const dir = await unpack(bundle, "windows");
    check("the bundle contains the .exe", fs.existsSync(path.join(dir, "rippa-node.exe")));
    check("the bundle contains config.json", fs.existsSync(path.join(dir, "config.json")));
    check(
      "the .exe member is byte-for-byte the release artefact",
      fs.readFileSync(path.join(dir, "rippa-node.exe")).equals(EXE_BYTES),
    );

    const config = JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8"));
    check(
      "a node code is minted when none is supplied",
      /^RIPPA-[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(config.NODE_CODE),
      config.NODE_CODE,
    );
    check(
      "pairWithMaster:false ships no pre-shared mesh key",
      config.MESH_KEY === undefined,
      String(config.MESH_KEY),
    );

    const notes = fs.readFileSync(path.join(dir, "PROVISION.txt"), "utf8");
    // The data folder moved from the OS app-data location to `data/` beside the
    // exe, so the operator notes have to name the place the node actually uses.
    check(
      "the windows notes name the local data folder beside the exe",
      notes.includes("data") && notes.includes("BESIDE THE EXE") && !notes.includes("%LOCALAPPDATA%"),
    );
  } finally {
    stub.restore();
  }
}

// ---- 4c. A non-artefact body is refused, not zipped ------------------------
{
  const stub = stubRelease({ assetBody: Buffer.from("<html>rate limited</html>") });
  try {
    await provisioner.buildNodeProvisionBundle({ platform: "android" });
    check("an HTML error page is not packaged as an APK", false, "no throw");
  } catch (error) {
    check(
      "an HTML error page is not packaged as an APK",
      /not an APK/.test(String(error.message)),
      String(error.message),
    );
  } finally {
    stub.restore();
  }
}

// ---- 4d. An unreachable release is reported, not swallowed ------------------
{
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false,
    status: 404,
    statusText: "Not Found",
    text: async () => "{}",
  });
  try {
    await provisioner.buildNodeProvisionBundle({ platform: "android" });
    check("a 404 from GitHub fails the request", false, "no throw");
  } catch (error) {
    check(
      "a 404 from GitHub fails the request and names the assets tried",
      /404/.test(String(error.message)) && /rippa-node\.apk/.test(String(error.message)),
      String(error.message),
    );
  } finally {
    globalThis.fetch = realFetch;
  }
}

// --- 5. THE ENDPOINT, over real HTTP ----------------------------------------
/*
  The service-level checks above prove the bundling flow. This one proves the
  CONTRACT an operator actually calls. It now has TWO shapes, chosen by the
  caller: a JSON body naming `android` (or any request carrying
  `Accept: application/json`) comes back as `{ apiKey, url }` with nothing
  fetched from GitHub, while `windows` still comes back as a .zip. The route is
  mounted on a bare Express app rather than the whole node, so the assertion is
  about the endpoint and nothing else.

  `globalThis.fetch` is stubbed to serve the synthetic release, but LOCAL requests
  are passed through to the real implementation — otherwise the stub would also
  intercept this test's own HTTP call to itself.
*/
const express = (await import("express")).default;
const { registerProvisionNodeRoutes } = await load("dist/api/provisionNodeRoutes.js");

const app = express();
app.use(express.json());
// The real `requireDashboardAuth` is exercised elsewhere; here it is replaced by
// a pass-through so the test can reach the handler without a dashboard session.
registerProvisionNodeRoutes(app, (_req, _res, next) => next());
const server = await new Promise((resolve) => {
  const s = app.listen(0, "127.0.0.1", () => resolve(s));
});
const base = `http://127.0.0.1:${server.address().port}/api/admin/provision-node`;

/**
 * POSTs `body` to the endpoint and returns `{ status, contentType, disposition,
 * platform, asset, bytes, json }`. `json` is the parsed body when the response
 * was JSON, and null otherwise (a zip body is not valid JSON).
 */
async function provisionRequest(body, { realFetch, accept } = {}) {
  const previous = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith("http://127.0.0.1:")) return realFetch(url, init);
    return previous(url, init);
  };
  try {
    const headers = { "Content-Type": "application/json" };
    if (accept) headers.Accept = accept;
    const response = await realFetch(base, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    const bytes = Buffer.from(await response.arrayBuffer());
    let json = null;
    try {
      json = JSON.parse(bytes.toString("utf8"));
    } catch {
      json = null;
    }
    return {
      status: response.status,
      contentType: response.headers.get("content-type") ?? "",
      disposition: response.headers.get("content-disposition") ?? "",
      platform: response.headers.get("x-rippa-node-platform"),
      asset: response.headers.get("x-rippa-node-asset"),
      bytes,
      json,
    };
  } finally {
    globalThis.fetch = previous;
  }
}

{
  const realFetch = globalThis.fetch;
  const stub = stubRelease();
  try {
    // ANDROID NOW RETURNS CREDENTIALS AS JSON. Nothing is fetched from GitHub
    // and no archive is built, so the stub above is never consulted for this
    // call — which is the whole point of the change.
    const android = await provisionRequest({ platform: "android" }, { realFetch });
    check("POST /api/admin/provision-node with platform=android returns 200", android.status === 200, String(android.status));
    check(
      "the android response is JSON, not a zip attachment",
      android.contentType.includes("application/json") && android.disposition === "",
      `${android.contentType} / ${android.disposition}`,
    );
    check(
      "the android response carries a non-empty apiKey and url",
      typeof android.json?.apiKey === "string" &&
        android.json.apiKey.length > 0 &&
        typeof android.json?.url === "string" &&
        android.json.url.length > 0,
      JSON.stringify(android.json),
    );
    check(
      "the android credentials are exactly { apiKey, url }",
      android.json !== null && Object.keys(android.json).sort().join(",") === "apiKey,url",
      Object.keys(android.json ?? {}).join(","),
    );

    // The same call spelled the other accepted way must behave identically.
    const viaOs = await provisionRequest({ os: "android" }, { realFetch });
    check(
      "the `os` alias is accepted for android and also returns JSON",
      viaOs.status === 200 && viaOs.contentType.includes("application/json") && typeof viaOs.json?.apiKey === "string",
      `${viaOs.status} / ${viaOs.contentType}`,
    );

    // The desktop flow is UNCHANGED: still a real, unpackable .zip.
    const windows = await provisionRequest({ platform: "windows" }, { realFetch });
    check(
      "platform=windows still returns the .exe bundle",
      windows.status === 200 && windows.asset === "rippa-node.exe",
      `${windows.status} / ${String(windows.asset)}`,
    );
    check(
      "the windows bundle is still served as a zip attachment",
      windows.contentType.includes("application/zip") &&
        windows.disposition.startsWith('attachment; filename="rippa-node-windows-'),
      `${windows.contentType} / ${windows.disposition}`,
    );

    const dir = await extractZipBuffer(windows.bytes, "http-windows");
    check(
      "the windows HTTP response unpacks to an EXE + config.json",
      fs.existsSync(path.join(dir, "rippa-node.exe")) && fs.existsSync(path.join(dir, "config.json")),
      fs.readdirSync(dir).join(", "),
    );

    // A scripted caller can ask for JSON for ANY platform, not just Android.
    const windowsJson = await provisionRequest(
      { platform: "windows" },
      { realFetch, accept: "application/json" },
    );
    check(
      "an Accept: application/json header switches windows to JSON credentials",
      windowsJson.status === 200 &&
        windowsJson.contentType.includes("application/json") &&
        typeof windowsJson.json?.apiKey === "string" &&
        typeof windowsJson.json?.url === "string",
      `${windowsJson.status} ${windowsJson.contentType} ${JSON.stringify(windowsJson.json)}`,
    );

    const rejected = await provisionRequest({ platform: "darwin" }, { realFetch });
    check("an unsupported platform is a 400, not a 500", rejected.status === 400, String(rejected.status));
    check(
      "the 400 names the supported platforms",
      rejected.bytes.toString("utf8").includes("windows, android"),
      rejected.bytes.toString("utf8"),
    );

    const missing = await provisionRequest({}, { realFetch });
    check("a body with no platform is a 400", missing.status === 400, String(missing.status));
  } finally {
    stub.restore();
  }
}

// --- 6. Master-only, exactly like every other /api/admin route ---------------
{
  const { env } = await load("dist/config.js");
  const realFetch = globalThis.fetch;
  const previousRole = env.NODE_ROLE;
  env.NODE_ROLE = "satellite";
  try {
    const response = await realFetch(base, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ platform: "android" }),
    });
    const text = await response.text();
    check(
      "a satellite refuses to provision (Master-only)",
      response.status === 400 && text.includes("Not a Master"),
      `${response.status} ${text}`,
    );
  } finally {
    env.NODE_ROLE = previousRole;
    globalThis.fetch = realFetch;
  }
}

// Awaited, not fired-and-forgotten: calling `process.exit()` while libuv is
// still tearing the listener down trips a Windows-only assertion inside Node
// (`!(handle->flags & UV_HANDLE_CLOSING)`), which turned a fully green run into
// a non-zero exit.
await new Promise((resolve) => server.close(resolve));

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
process.exit(failed.length ? 1 : 0);
