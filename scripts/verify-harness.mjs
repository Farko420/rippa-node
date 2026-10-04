/**
 * END-TO-END VERIFICATION FOR THE REPORTED BUGS (part 1 of 2).
 * Not part of the shipped app. See verify-fixes-2.mjs for the harness tail.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const PORT = 5199;
export const PIN = "4242";
export const SAT_CODE = "RIPPA-D2N6-6VZV";

export const results = [];
export const log = { text: "" };

export function check(name, pass, detail = "") {
  results.push({ name, pass });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Writes a throwaway master config and returns its directory. */
export function makeConfigRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rippa-verify-"));
  fs.writeFileSync(
    path.join(dir, "config.json"),
    JSON.stringify(
      {
        NODE_ROLE: "master",
        NODE_NAME: "Verify Master",
        NODE_API_KEY: "verify-master-key-0001",
        MOTHERSHIP_URL: "https://rippaadventures.com",
        MASTER_LOCAL_URL: `http://127.0.0.1:${PORT}`,
        OLLAMA_URL: "http://127.0.0.1:11434",
        PORT,
        DASHBOARD_PIN: PIN,
      },
      null,
      2,
    ),
  );
  return dir;
}

/** Spawns the built node against `configRoot`. */
export function spawnNode(configRoot) {
  const child = spawn(process.execPath, [path.join(ROOT, "dist", "index.js")], {
    cwd: ROOT,
    env: { ...process.env, RIPPA_CONFIG_ROOT: configRoot, PORT: String(PORT) },
    stdio: ["ignore", "pipe", "pipe"],
    // Without this, every suite that boots a node flashed a console window over
    // the operator's screen on Windows and stole focus.
    windowsHide: true,
  });
  child.stdout.on("data", (d) => (log.text += d));
  child.stderr.on("data", (d) => (log.text += d));
  return child;
}

/** Polls /health until the node answers. */
export async function waitForServer() {
  for (let i = 0; i < 80; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/health`);
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  return false;
}

/** Logs in and returns the session cookie header. */
export async function login() {
  const res = await fetch(`http://127.0.0.1:${PORT}/api/system/auth`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pin: PIN }),
  });
  return (res.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
}