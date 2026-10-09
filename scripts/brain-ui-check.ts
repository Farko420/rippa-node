/**
 * Drives the Master Control Center's brain drop zone with a real file upload,
 * proving the UI path (not just the API) reaches 1:1 parity.
 * Not part of the shipped app.
 */
import path from "node:path";
import fs from "node:fs";
import { chromium } from "playwright";

const BASE = "http://127.0.0.1:5100";
const PIN = "1357";
const BUNDLE = path.join(__dirname, "..", ".parity", "bundle.json");
const OUT = path.join(__dirname, "..", ".parity", "dashboard-brain.png");

void (async () => {
  // headless:true — background verification must never open a visible browser
  // GUI that steals OS focus from the operator's desktop.
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 1200 } });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push("console: " + m.text());
  });

  await page.goto(BASE + "/");
  await page.fill("#unlockPin", PIN);
  await page.click("#unlockBtn");
  await page.waitForTimeout(1200);
  await page.goto(BASE + "/dashboard");
  await page.waitForSelector("#ccApp:not([hidden])", { timeout: 20000 });
  await page.waitForTimeout(2000);

  console.log("drop zone visible:", await page.locator("#brainDrop").isVisible());

  // Real file upload through the hidden <input type="file"> the drop zone uses.
  await page.setInputFiles("#brainFile", BUNDLE);
  await page.waitForSelector("#brainStatus:not([hidden])", { timeout: 20000 });
  await page.waitForTimeout(1500);

  console.log("badge:", (await page.locator("#brainBadge").textContent())?.trim());
  console.log("counts:", (await page.locator("#brainCounts").textContent())?.trim());
  console.log("message:", (await page.locator("#brainMessage").textContent())?.trim());
  console.log("js errors:", errors.length ? errors : "none");

  await page.screenshot({ path: OUT, fullPage: true });
  console.log("screenshot bytes:", fs.statSync(OUT).size);

  await browser.close();
  process.exit(errors.length ? 1 : 0);
})().catch((e) => {
  console.error("FAILED:", e.message);
  process.exit(1);
});