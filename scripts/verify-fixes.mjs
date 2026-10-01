/**
 * BUGS 4, 5, 6 — P2P PAIRING, TASK CLAIMING, ADMIN COMMANDS, SYNC PROGRESS.
 * Drives a real node over real HTTP. See verify-harness.mjs for the fixtures.
 *
 * RUNS AGAINST `npm run build` OUTPUT, which must therefore exist first (the npm
 * script does it for you). This matters more than it sounds: step 4 of
 * `scripts/package.mjs` deliberately PRUNES every `.js` out of `dist/` once the
 * `.exe` has been frozen into it, so after `npm run package` there is no compiled
 * JavaScript left here to import. Building first keeps these checks
 * order-independent.
 */
import fs from "node:fs";
import path from "node:path";
import {
  ROOT,
  PORT,
  PIN,
  SAT_CODE,
  check,
  login,
  makeConfigRoot,
  results,
  sleep,
  spawnNode,
  waitForServer,
} from "./verify-harness.mjs";
import "./verify-ui.mjs";

const configRoot = makeConfigRoot();
const child = spawnNode(configRoot);

try {
  const up = await waitForServer();
  check("node boots", up);
  if (!up) throw new Error("node did not boot");

  const cookie = await login();
  check("dashboard login works", Boolean(cookie));

  // --- 4. Pairing puts the satellite in the Swarm Grid -----------------------
  const pair = await fetch(`http://127.0.0.1:${PORT}/api/mesh/pair`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      nodeCode: SAT_CODE,
      nodeName: "Verify Satellite",
      ipAddress: "127.0.0.1",
      port: 5200,
    }),
  });
  const paired = await pair.json();
  check("satellite pairs with the Master", pair.ok && paired.success === true, `HTTP ${pair.status}`);

  const hb = await fetch(`http://127.0.0.1:${PORT}/api/mesh/heartbeat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Mesh-Key": paired.meshKey ?? "" },
    body: JSON.stringify({
      nodeCode: SAT_CODE,
      nodeName: "Verify Satellite",
      ipAddress: "127.0.0.1",
      port: 5200,
    }),
  });
  check("satellite heartbeat authenticated (mesh key accepted)", hb.ok, `HTTP ${hb.status}`);

  const snap = await (
    await fetch(`http://127.0.0.1:${PORT}/api/mesh/snapshot`, { headers: { Cookie: cookie } })
  ).json();
  check(
    "paired satellite appears in the Swarm Grid (was \"0 satellites\")",
    (snap.satellites ?? []).some((s) => s.nodeCode === SAT_CODE),
    `satellites=${(snap.satellites ?? []).length}`,
  );
  check("snapshot summary total is 1", snap?.summary?.total === 1, `total=${snap?.summary?.total}`);
  const codeBefore = String(snap.nodeCode ?? "");
  check(
    "the node exposes a well-formed node code on the snapshot",
    /^RIPPA-[0-9A-HJ-NP-Z]{4}-[0-9A-HJ-NP-Z]{4}$/.test(codeBefore),
    codeBefore,
  );

  /*
    REMOTE / CLOUD LINK ACCEPTS A NODE CODE.

    Saved through the real POST /api/system/config path, which is where the old
    "must be exactly 6 digits" validation used to reject a pasted node code with
    a 400. Asserting the request succeeds AND that the value round-trips back
    through the config payload covers both halves: the field accepts it, and it
    is not silently dropped on the way to disk.
  */
  const saveCloud = async (value) => {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/system/config`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      // validateConfigInput requires a COMPLETE config on every save, so the
      // other fields are resent alongside the one under test. Leaving them out
      // would 400 on `node_name` / `mothership_url` and the assertion would pass
      // for entirely the wrong reason. `port` is included because the real setup
      // form always posts it and normalizeConfig defaults an absent port to
      // 4000 — omitting it here would silently reset the node's own port.
      body: JSON.stringify({
        node_role: "master",
        node_name: "Verify Master",
        mothership_url: "https://rippaadventures.com",
        port: PORT,
        cloud_link_code: value,
      }),
    });
    return { res, body: await res.json() };
  };

  const cloud = await saveCloud("RIPPA-D2N6-6VZV");
  check(
    "a node code is accepted in the Remote / Cloud Link field (was 400)",
    cloud.res.ok && cloud.body.success === true,
    `HTTP ${cloud.res.status} ${JSON.stringify(cloud.body.errors ?? cloud.body.message ?? "")}`,
  );
  check(
    "the node code round-trips through the Cloud Link field intact",
    cloud.body?.config?.cloud_link_code === "RIPPA-D2N6-6VZV",
    `got "${cloud.body?.config?.cloud_link_code}"`,
  );

  // The classic 6-digit tunnel code must keep working — this is an addition, not
  // a replacement, and regressing it would silently break existing installs.
  const digits = await saveCloud("123456");
  check(
    "a 6-digit relay code is still accepted (not a regression)",
    digits.res.ok && digits.body?.config?.cloud_link_code === "123456",
    `HTTP ${digits.res.status}`,
  );

  // Genuinely invalid input must STILL be refused rather than quietly accepted.
  const tooLong = await saveCloud("1234567");
  check("a 7-digit value is still rejected, not truncated", tooLong.res.status === 400, `HTTP ${tooLong.res.status}`);

  const cfg1 = JSON.parse(fs.readFileSync(path.join(configRoot, "config.json"), "utf8"));
  check(
    "Master persisted the mesh key (satellites are not 401'd after a restart)",
    typeof cfg1.MESH_KEY === "string" && cfg1.MESH_KEY.length > 0,
  );
  await sleep(1600);
  const cfg2 = JSON.parse(fs.readFileSync(path.join(configRoot, "config.json"), "utf8"));
  check(
    "Master persisted the registry (grid survives a restart)",
    Array.isArray(cfg2.SATELLITE_REGISTRY) &&
      cfg2.SATELLITE_REGISTRY.some((r) => r.nodeCode === SAT_CODE),
  );

  /*
    REGENERATING THE NODE CODE — END TO END.

    The bug being fixed is "the node code is permanently locked to the machine".
    So this asserts the whole chain, not just the HTTP 200: a different code is
    minted, it lands in config.json, every mesh association made under the old
    code is gone, the in-memory registry is empty, and — critically — the node's
    other settings survive. A regenerate that wiped the API key or the passkey
    would be a worse bug than the one it fixes.
  */
  const regen = await fetch(`http://127.0.0.1:${PORT}/api/config/regenerate-code`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: "{}",
  });
  const regenBody = await regen.json();
  const codeAfter = String(regenBody.nodeCode ?? "");
  check("POST /api/config/regenerate-code succeeds", regen.ok && regenBody.success === true, `HTTP ${regen.status}`);
  check(
    "the response carries a brand-new, well-formed code",
    /^RIPPA-[0-9A-HJ-NP-Z]{4}-[0-9A-HJ-NP-Z]{4}$/.test(codeAfter),
    codeAfter,
  );
  check(
    "the new code is DIFFERENT from the old one",
    codeAfter !== "" && codeAfter !== codeBefore,
    `${codeBefore} -> ${codeAfter}`,
  );

  const cfgAfter = JSON.parse(fs.readFileSync(path.join(configRoot, "config.json"), "utf8"));
  check("the new code is persisted to config.json", cfgAfter.NODE_CODE === codeAfter, String(cfgAfter.NODE_CODE));
  check(
    "the old mesh key is REPLACED, not reused",
    String(cfgAfter.MESH_KEY ?? "") !== "" && String(cfgAfter.MESH_KEY) !== String(cfg2.MESH_KEY),
    `old=${cfg2.MESH_KEY} new=${cfgAfter.MESH_KEY}`,
  );
  check(
    "the mesh key is re-issued for the new identity",
    String(cfgAfter.MESH_KEY_ISSUER ?? "") === codeAfter,
    String(cfgAfter.MESH_KEY_ISSUER),
  );
  check(
    "the satellite registry is cleared",
    (cfgAfter.SATELLITE_REGISTRY ?? []).length === 0,
    `${(cfgAfter.SATELLITE_REGISTRY ?? []).length} left`,
  );

  // The live process must agree with the file — otherwise the UI would show a
  // code the node is not actually using until the next restart.
  const snapAfter = await (
    await fetch(`http://127.0.0.1:${PORT}/api/mesh/snapshot`, { headers: { Cookie: cookie } })
  ).json();
  check(
    "the running node reports the NEW code (no restart needed)",
    snapAfter.nodeCode === codeAfter,
    String(snapAfter.nodeCode),
  );
  check(
    "the in-memory registry was cleared too (grid is empty)",
    (snapAfter.satellites ?? []).length === 0,
    `${(snapAfter.satellites ?? []).length} left`,
  );

  // AND THE SETTINGS SURVIVED. This is the "without bricking existing settings"
  // half of the requirement, and it is the half a naive implementation breaks.
  check("the API key survived the code change", cfgAfter.NODE_API_KEY === "verify-master-key-0001", String(cfgAfter.NODE_API_KEY));
  check("the dashboard passkey survived the code change", cfgAfter.DASHBOARD_PIN === PIN, String(cfgAfter.DASHBOARD_PIN));
  check("the node name survived the code change", cfgAfter.NODE_NAME === "Verify Master", String(cfgAfter.NODE_NAME));
  check("the node role survived the code change", cfgAfter.NODE_ROLE === "master", String(cfgAfter.NODE_ROLE));
  check("the Mothership URL survived the code change", cfgAfter.MOTHERSHIP_URL === "https://rippaadventures.com", String(cfgAfter.MOTHERSHIP_URL));
  check("the Cloud Link setting survived the code change", cfgAfter.cloud_link_code === "123456", String(cfgAfter.cloud_link_code));
  check("the port survived the code change", Number(cfgAfter.PORT) === PORT, String(cfgAfter.PORT));
  check("the node is still configured (no return to the Setup screen)", regenBody.configured === true);

  // A satellite paired under the old code must now be refused by the new
  // identity's mesh key — this is what "must re-pair" actually means.
  const staleHeartbeat = await fetch(`http://127.0.0.1:${PORT}/api/mesh/heartbeat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Mesh-Key": paired.meshKey ?? "" },
    body: JSON.stringify({ nodeCode: SAT_CODE, nodeName: "Verify Satellite", ipAddress: "127.0.0.1", port: 5200 }),
  });
  check("a satellite holding the OLD mesh key is rejected (must re-pair)", staleHeartbeat.status === 401, `HTTP ${staleHeartbeat.status}`);

  // Manual entry path, including its failure mode.
  const manualBad = await fetch(`http://127.0.0.1:${PORT}/api/config/regenerate-code`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ nodeCode: "not-a-code" }),
  });
  check("an invalid manual code is refused with a 400", manualBad.status === 400, `HTTP ${manualBad.status}`);
  const stillOld = JSON.parse(fs.readFileSync(path.join(configRoot, "config.json"), "utf8"));
  check("a refused manual code leaves the node code untouched", stillOld.NODE_CODE === codeAfter, String(stillOld.NODE_CODE));

  const manualGood = await fetch(`http://127.0.0.1:${PORT}/api/config/regenerate-code`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ nodeCode: "rippa-abc2-def3" }),
  });
  const manualBody = await manualGood.json();
  check(
    "a valid manual code is adopted and canonicalised to upper case",
    manualGood.ok && manualBody.nodeCode === "RIPPA-ABC2-DEF3",
    String(manualBody.nodeCode),
  );

  // The /api/system/config alias must exist too, or a UI that hard-codes it 404s.
  const alias = await fetch(`http://127.0.0.1:${PORT}/api/system/config/regenerate-code`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: "{}",
  });
  check("the /api/system/config/regenerate-code alias also works", alias.ok, `HTTP ${alias.status}`);

  // And the whole thing must be behind the dashboard passkey.
  const unauth = await fetch(`http://127.0.0.1:${PORT}/api/config/regenerate-code`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  check("regenerate is passkey-gated (an unauthenticated LAN client cannot)", unauth.status === 401, `HTTP ${unauth.status}`);

  // --- 3. Brain sync progress over SSE --------------------------------------
  const events = [];
  const controller = new AbortController();
  const streamDone = fetch(`http://127.0.0.1:${PORT}/api/system/events`, {
    headers: { Cookie: cookie },
    signal: controller.signal,
  })
    .then(async (res) => {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf("\n\n")) !== -1) {
          const frame = buf.slice(0, i);
          buf = buf.slice(i + 2);
          for (const line of frame.split("\n")) {
            if (line.startsWith("data: ")) {
              try {
                events.push(JSON.parse(line.slice(6)));
              } catch {
                /* ignore */
              }
            }
          }
        }
      }
    })
    .catch(() => {});

  await sleep(600);
  const bundle = JSON.parse(fs.readFileSync(path.join(ROOT, ".parity", "bundle.json"), "utf8"));
  const many = {
    ...bundle,
    places: Array.from({ length: 900 }, (_, i) => ({
      ...bundle.places[i % bundle.places.length],
      id: `place-verify-${i}`,
      name: `Verify Place ${i}`,
    })),
  };
  const upload = await fetch(`http://127.0.0.1:${PORT}/api/brain/upload-backup`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify(many),
  });
  const upBody = await upload.json();
  check("900-row brain bundle loads", upload.ok && upBody.success === true, String(upBody.message).slice(0, 70));
  await sleep(800);
  controller.abort();

  const sync = events.filter((e) => e.kind === "brain_sync");
  const percents = sync.map((e) => e.percent);
  check(
    "ingestion published INTERMEDIATE progress (not a 0->100 jump)",
    percents.some((p) => p > 0 && p < 100),
    `${sync.length} frames, percents=${[...new Set(percents)].slice(0, 10).join(",")}`,
  );
  check("terminal 'Parity Achieved' frame published", sync.some((e) => e.phase === "done"));
  await streamDone;
} catch (error) {
  check("live harness ran to completion", false, String((error && error.message) || error));
} finally {
  /*
    Shut the node down properly before deleting its config root.

    The Deep Brain (`local_knowledge.db`) lives in that directory and Windows
    keeps a handle on it until the process has actually exited, so deleting while
    it is still shutting down throws EPERM. Kill, wait for exit, then remove.
    Cleanup is best-effort: a leftover temp folder must never fail the run.
  */
  await new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once("exit", resolve);
    child.kill();
    setTimeout(resolve, 4000);
  });
  try {
    fs.rmSync(configRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    /* the OS will clear the temp folder; never fail the run over cleanup */
  }
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
process.exit(failed.length ? 1 : 0);