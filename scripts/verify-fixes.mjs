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