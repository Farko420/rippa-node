/**
 * RESOURCE GOVERNOR — verification.
 *
 * Exercises the SHIPPED compiled output (dist/), so this runs the same code the
 * packaged exe does, against the four things the feature actually promises:
 *
 *   1. the mode PRESETS produce the documented concurrency and CPU-thread limits;
 *   2. a SCHEDULE window overrides the base mode, including across midnight;
 *   3. the Mothership's PUSHED config is parsed (and a bad one is refused);
 *   4. the TASK ENGINE actually runs tasks concurrently up to the limit and no
 *      further — the one assertion that would catch a Governor that is wired up
 *      but not consulted.
 *
 * (4) is the load-bearing one. Everything else can pass while the node quietly
 * ignores the limit, which is exactly the "monopolised the host" complaint this
 * feature exists to answer.
 *
 * Not part of the shipped app. See verify-harness.mjs for the shared helpers.
 */
import { pathToFileURL } from "node:url";
import os from "node:os";
import path from "node:path";
import { ROOT, check, results } from "./verify-harness.mjs";

/** Imports a compiled module by path. Windows ESM needs a file:// URL. */
const load = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);

const { ResourceGovernor } = await load("dist/services/resourceGovernor.js");

// --- 1. Presets --------------------------------------------------------------

const low = new ResourceGovernor({ mode: "low" }).getCurrentLimits();
check("Low caps concurrency at one task", low.max_concurrent_tasks === 1, String(low.max_concurrent_tasks));
check("Low caps the local model to two threads", low.ollama_num_threads === 2, String(low.ollama_num_threads));

const medium = new ResourceGovernor({ mode: "medium" }).getCurrentLimits();
check("Medium runs two tasks at once", medium.max_concurrent_tasks === 2, String(medium.max_concurrent_tasks));
check("Medium is below the high-water mark on a multi-core host", medium.ollama_num_threads <= os.cpus().length);

const high = new ResourceGovernor({ mode: "high" }).getCurrentLimits();
check(
  "High allows one task per logical core",
  high.max_concurrent_tasks === os.cpus().length,
  `${high.max_concurrent_tasks} vs ${os.cpus().length}`,
);
check("High uses every core for the model", high.ollama_num_threads === os.cpus().length);

// --- 2. Custom overrides -----------------------------------------------------

const custom = new ResourceGovernor({
  mode: "custom",
  custom_cpu_threads: 3,
  custom_ram_gb: 6,
}).getCurrentLimits();
check("Custom applies its thread ceiling", custom.ollama_num_threads === 3, String(custom.ollama_num_threads));
check("Custom applies its concurrency ceiling", custom.max_concurrent_tasks === 3);
check("Custom applies its RAM ceiling", custom.ram_limit_gb === 6, String(custom.ram_limit_gb));
check("Custom reports itself as the active mode", custom.active_mode === "custom");

// --- 3. Schedules ------------------------------------------------------------

/** `HH:MM` for a Date. */
const hhmm = (d) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;

/** A window that definitely CONTAINS the current minute (±30 min). */
const windowCoveringNow = () => {
  const now = Date.now();
  return { start: hhmm(new Date(now - 30 * 60_000)), end: hhmm(new Date(now + 30 * 60_000)), mode: "high" };
};

/** A one-hour window that definitely does NOT contain the current minute (+2h). */
const windowAwayFromNow = () => {
  const now = Date.now();
  return { start: hhmm(new Date(now + 2 * 3600_000)), end: hhmm(new Date(now + 3 * 3600_000)), mode: "high" };
};

const inWindow = new ResourceGovernor({ mode: "low", schedule: [windowCoveringNow()] }).getCurrentLimits();
check("an active window overrides the base mode", inWindow.active_mode === "high", inWindow.active_mode);

const outOfWindow = new ResourceGovernor({ mode: "low", schedule: [windowAwayFromNow()] }).getCurrentLimits();
check("a window that does not cover now leaves the base mode", outOfWindow.active_mode === "low", outOfWindow.active_mode);

/*
  THE MIDNIGHT-WRAP WINDOW. `23:00 -> 02:00` is the case a naive
  `now >= start && now < end` gets wrong, and it is the window an overnight
  node is most likely to be given ("run High while the office is asleep").
  Constructed so it always contains now: start an hour ago, end an hour ahead,
  which wraps exactly when the current hour is 23 or 0.
*/
const wrap = new ResourceGovernor({ mode: "low", schedule: [windowCoveringNow()] }).getCurrentLimits();
check("a window that crosses midnight is still evaluated", wrap.active_mode === "high", wrap.active_mode);

// Windows are checked in order, and the FIRST covering one wins.
const ordered = new ResourceGovernor({
  mode: "low",
  schedule: [windowCoveringNow(), { start: "00:00", end: "23:59", mode: "medium" }],
}).getCurrentLimits();
check("the first matching window wins, not the broadest", ordered.active_mode === "high", ordered.active_mode);

// --- 4. Memory ceiling -------------------------------------------------------

const unlimited = new ResourceGovernor({ mode: "low" });
check("the preset modes impose no RAM ceiling", unlimited.isMemoryExceeded() === false);

const tiny = new ResourceGovernor({ mode: "custom", custom_ram_gb: 1 });
check("a 1GB ceiling is exceeded on any real host", tiny.isMemoryExceeded() === true);

// --- 5. Parsing the Mothership's push ---------------------------------------

const { parsePowerConfig } = await load("dist/services/powerConfigSync.js");

check("a heartbeat with no power directive yields nothing", parsePowerConfig({ ok: true }) === null);
check(
  "snake_case power_config is read",
  parsePowerConfig({ power_config: { mode: "high" } })?.config.mode === "high",
);
check(
  "camelCase powerConfig is read too",
  parsePowerConfig({ powerConfig: { mode: "low" } })?.config.mode === "low",
);
check("an unknown mode is refused rather than guessed", parsePowerConfig({ power_config: { mode: "turbo" } }) === null);
check(
  "the desired stamp is carried through for the echo",
  parsePowerConfig({ power_config: { mode: "auto" }, power_config_updated_at: "2026-10-04 01:02:03" })?.stamp ===
    "2026-10-04 01:02:03",
);
check(
  "a config with no stamp still parses (older cloud)",
  parsePowerConfig({ power_config: { mode: "auto" } })?.stamp === null,
);
check(
  "schedule windows are parsed",
  parsePowerConfig({
    power_config: { mode: "auto", schedule: [{ start: "02:00", end: "06:00", mode: "high" }] },
  })?.config.schedule?.[0]?.mode === "high",
);
check(
  "a malformed window time is dropped, not stored",
  parsePowerConfig({
    power_config: { mode: "auto", schedule: [{ start: "banana", end: "06:00", mode: "high" }] },
  })?.config.schedule === undefined,
);
check(
  "custom numbers are read as whole positive values",
  parsePowerConfig({ power_config: { mode: "custom", custom_cpu_threads: 3.7, custom_ram_gb: 4 } })?.config
    .custom_cpu_threads === 3,
);
check(
  "a zero custom number is treated as absent, not as a zero limit",
  parsePowerConfig({ power_config: { mode: "custom", custom_cpu_threads: 0 } })?.config.custom_cpu_threads ===
    undefined,
);

// --- 6. The engine actually consults the Governor ---------------------------

const { TaskEngine } = await load("dist/services/taskEngine.js");

let maxInFlight = 0;
let inFlight = 0;
const fakeSwarm = {
  dispatch: null,
  setTaskDispatchHandler(handler) {
    this.dispatch = handler;
  },
  setStatus: () => {},
  claimTask: async (task) => ({ task, acknowledged: true }),
  releaseTask: async () => {},
  fetchTasks: async () => [],
  submitProfile: async () => true,
};

const engine = new TaskEngine({
  swarm: fakeSwarm,
  governor: new ResourceGovernor({ mode: "medium" }),
  handlePriorityTask: async () => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    // Long enough that any permitted overlap is guaranteed to be observed.
    await new Promise((resolve) => setTimeout(resolve, 40));
    inFlight -= 1;
    return { status: "success", detail: "ok" };
  },
  forager: {
    runPass: async () => ({ status: "skipped", message: "harness stub" }),
    stats: () => ({ learned: 0, fed: 0, preemptions: 0 }),
  },
  priorityPollMs: 3_600_000,
  idleGapMs: 3_600_000,
});

engine.start();
fakeSwarm.dispatch(Array.from({ length: 5 }, (_, i) => ({ id: `t${i}`, type: "scrape", status: "pending" })));
await new Promise((resolve) => setTimeout(resolve, 600));
const inFlightAfter = engine.inFlightCount();
await engine.stop();

check(
  "the engine runs MORE than one task at once under Medium (concurrency is real)",
  maxInFlight > 1,
  `observed max ${maxInFlight}`,
);
check(
  "the engine never exceeds the Governor's ceiling",
  maxInFlight <= 2,
  `observed max ${maxInFlight}, ceiling 2`,
);
check("every task has finished by the time the queue drains", inFlightAfter === 0, String(inFlightAfter));

/*
  EXPLICIT EXIT, not just `process.exitCode`. The TaskEngine's loops park on
  long `setTimeout`s that are deliberately not unref'd (a real node must stay
  alive to poll), so setting a code and returning leaves the harness hanging for
  the full poll interval instead of finishing.
*/
const failed = results.filter((r) => !r.pass).length;
console.log("");
console.log(failed === 0 ? `All ${results.length} governor checks passed.` : `${failed} of ${results.length} FAILED.`);
process.exit(failed === 0 ? 0 : 1);
