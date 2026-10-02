/**
 * DRIVES THE REAL DASHBOARD IN REAL CHROMIUM.
 *
 * The other engine suites prove the server behaves. This one proves the PANELS
 * render and the `$` prompt works in a browser: that the markup, the CSS and
 * dashboard.js agree with each other, which no amount of server testing can show.
 * Not part of the shipped app.
 */
import { chromium } from "playwright";
import { PORT, PIN, check, makeConfigRoot, results, spawnNode, waitForServer } from "./verify-harness.mjs";

const configRoot = makeConfigRoot();
const child = spawnNode(configRoot);
const base = `http://127.0.0.1:${PORT}`;
let browser = null;

try {
  const up = await waitForServer();
  check("node boots", up);
  if (!up) throw new Error("node did not boot");

  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 1100 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));

  // /dashboard IS the Control Center as a dedicated page — but it has NO unlock
  // form of its own (the lock screen lives on the root's app.js, and dashboard.html
  // was built for a session that is already authenticated). So there is no #unlockPin
  // here by design: the test logs in through the API first, carries the session
  // cookie into the browser, and opens the page already authorised.
  const loginRes = await page.request.post(base + "/api/system/auth", {
    data: { pin: PIN },
  });
  if (!loginRes.ok()) throw new Error("could not log the browser in: HTTP " + loginRes.status());
  await page.goto(base + "/dashboard", { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#ccApp:not([hidden])", { timeout: 25_000 });
  await page.waitForTimeout(1500);

  // --- THE EMBEDDED AI TAB ---------------------------------------------------
  await page.click('.cc-nav-item[data-view="viewOllama"]');
  await page.waitForTimeout(1200);

  check("the health badge is rendered", await page.locator("#ollamaHealthBadge").isVisible());
  const badgeClass = await page.getAttribute("#ollamaHealthBadge", "class");
  check("the badge carries a state class (not the old static pill)",
    /is-(ready|busy|pulling|offline)/.test(badgeClass ?? ""), String(badgeClass));
  const label = await page.textContent("#ollamaHealthLabel");
  check("the badge is labelled in words, not colour alone",
    ["Ready", "Busy", "Pulling", "Offline", "Probing…"].includes((label ?? "").trim()), String(label));
  check("the badge has a tooltip explaining the state",
    ((await page.getAttribute("#ollamaHealthBadge", "title")) ?? "").length > 0);

  check("the terminal renders", await page.locator("#termOut").isVisible());
  const fontFamily = await page.evaluate(
    () => getComputedStyle(document.getElementById("termOut")).fontFamily,
  );
  check("the terminal is monospace", /mono|Menlo|Consolas/i.test(fontFamily), fontFamily);
  check("the terminal uses the dark node background",
    await page.evaluate(() => getComputedStyle(document.getElementById("termOut")).backgroundColor)
      === "rgb(13, 17, 23)");
  check("the $ prompt is present", (await page.textContent(".term-prompt"))?.trim() === "$");
  check("the command input is present", await page.locator("#termInput").isVisible());

  // The empty-state hint must be there, or the box reads as broken.
  check("an empty terminal explains itself",
    ((await page.textContent("#termOut")) ?? "").length > 0,
    await page.textContent("#termOut"));

  // --- TYPE A REAL COMMAND ---------------------------------------------------
  await page.fill("#termInput", "help");
  await page.press("#termInput", "Enter");
  await page.waitForTimeout(1200);

  const terminalText = await page.textContent("#termOut");
  check("the submitted command is echoed into the terminal", terminalText.includes("$ help"), terminalText.slice(0, 120));
  check("its output streams back", terminalText.includes("ollama ps"), terminalText.slice(0, 240));
  check("the input clears after submit", (await page.inputValue("#termInput")) === "");
  check("the echoed line is styled as a command",
    (await page.locator(".term-line.is-cmd").count()) > 0);

  await page.fill("#termInput", "rm -rf /");
  await page.press("#termInput", "Enter");
  await page.waitForTimeout(1200);
  const afterBad = await page.textContent("#termOut");
  check("a refused command is shown in the terminal, not swallowed",
    afterBad.includes("$ rm -rf /") && /Unknown command|Available/.test(afterBad),
    afterBad.slice(-200));

  // --- THE SCRAPER TAB -------------------------------------------------------
  await page.click('.cc-nav-item[data-view="viewScraper"]');
  await page.waitForTimeout(1000);
  check("the live scrape stream renders", await page.locator("#scrapeStream").isVisible());
  check("the live viewport renders", await page.locator(".viewport").isVisible());
  check("the idle radar is showing before anything is scraped",
    !(await page.locator("#viewportRadar").getAttribute("hidden")));
  check("the radar says what it is waiting for",
    ((await page.textContent("#viewportRadar")) ?? "").includes("Waiting for dispatch"),
    await page.textContent("#viewportRadar"));
  check("the screenshot slot holds nothing while idle",
    await page.evaluate(() => {
      // Scoped to the SCRAPER VIEW (#viewScraper), which is the visible document
      // region at this point: getElementById hit the index.html copy of the panel
      // instead of dashboard.html's, and that copy — markup-frozen since the merge —
      // never receives frames. An unscoped id lookup here is a coin flip between
      // documents, so the check goes at the visible view's own tree.
      const view = document.getElementById("viewScraper");
      const img = view ? view.querySelector("#viewportImg") : null;
      return Boolean(img) && img.getAttribute("src") === null && img.hidden === true;
    }));
  check("and the idle radar occupies the stage instead",
    await page.evaluate(() => {
      const view = document.getElementById("viewScraper");
      const radar = view ? view.querySelector("#viewportRadar") : null;
      return Boolean(radar) && radar.getAttribute("hidden") === null;
    }));
  check("the split layout is two columns on a wide viewport",
    await page.evaluate(() => {
      const split = document.querySelector(".scrape-split");
      return getComputedStyle(split).gridTemplateColumns.split(" ").length === 2;
    }));

  check("no uncaught page errors anywhere in that run", errors.length === 0, errors.join(" | "));
} finally {
  if (browser) await browser.close().catch(() => {});
  child.kill();
}

const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} checks passed.`);
process.exit(failed ? 1 : 0);