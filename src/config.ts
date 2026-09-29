import { config as loadDotenv } from "dotenv";
import { z } from "zod";
import {
  DEFAULT_DASHBOARD_PIN,
  DEFAULT_MOTHERSHIP_URL,
  DEFAULT_OLLAMA_URL,
  DEFAULT_PORT,
  applyConfigToEnv,
  readConfigLenient,
} from "./config/configManager";

// Load environment variables (from `.env` for dev/legacy setups) …
loadDotenv();
// … then layer the portable app's config.json on top. Lenient read so an
// unconfigured node can still boot the Local Web GUI (config API fills it).
applyConfigToEnv(readConfigLenient());

if (!process.env.NODE_API_KEY || process.env.NODE_API_KEY.trim().length < 8) {
  // Placeholder lets zod pass on first boot; index.ts gates services on
  // isConfigComplete() and the GUI collects the real key. POST save with
  // force=true overwrites this placeholder via reloadEnv().
  process.env.NODE_API_KEY = "unconfigured-local-node";
}
if (!process.env.NODE_NAME) process.env.NODE_NAME = "Unnamed Rippa Node";
if (!process.env.MOTHERSHIP_URL) process.env.MOTHERSHIP_URL = DEFAULT_MOTHERSHIP_URL;
if (!process.env.DASHBOARD_PIN) process.env.DASHBOARD_PIN = DEFAULT_DASHBOARD_PIN;
if (!process.env.MASTER_LOCAL_URL) {
  const port = Number(process.env.PORT) > 0 ? Number(process.env.PORT) : DEFAULT_PORT;
  process.env.MASTER_LOCAL_URL = `http://127.0.0.1:${port}`;
}
if (!process.env.OLLAMA_URL) process.env.OLLAMA_URL = DEFAULT_OLLAMA_URL;

const envSchema = z.object({
  NODE_ROLE: z.enum(["master", "satellite"]).default("master"),
  NODE_NAME: z.string().min(1).default("Unnamed Rippa Node"),
  NODE_API_KEY: z.string().min(8, "NODE_API_KEY must be at least 8 characters"),
  MOTHERSHIP_URL: z.url(),
  MASTER_LOCAL_URL: z.url(),
  OLLAMA_URL: z.url().default("http://127.0.0.1:11434"),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  DASHBOARD_PIN: z.string().min(4, "DASHBOARD_PIN must be at least 4 characters").default(DEFAULT_DASHBOARD_PIN),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("❌ Invalid configuration — fix config.json or your .env file:");
  for (const issue of parsed.error.issues) {
    console.error(`   - ${issue.path.join(".") || "(root)"}: ${issue.message}`);
  }
  console.error("   Open http://localhost:4000/ to reconfigure via the Local Web GUI.");
  process.exit(1);
}

export const env = parsed.data;

/**
 * Refreshes the live `env` object from `process.env` after a GUI save, so
 * running services observe new values without a process restart. Importers
 * must read `env.X` at call time (not destructure) to see reloads.
 */
export function reloadEnv(): typeof env {
  const target = env as Record<string, unknown>;
  target["NODE_ROLE"] = process.env.NODE_ROLE === "satellite" ? "satellite" : "master";
  target["NODE_NAME"] =
    process.env.NODE_NAME && process.env.NODE_NAME.trim()
      ? process.env.NODE_NAME
      : "Unnamed Rippa Node";
  target["NODE_API_KEY"] = process.env.NODE_API_KEY ?? "";
  target["MOTHERSHIP_URL"] = process.env.MOTHERSHIP_URL ?? "";
  target["MASTER_LOCAL_URL"] = process.env.MASTER_LOCAL_URL ?? "";
  target["OLLAMA_URL"] = process.env.OLLAMA_URL ?? "";
  target["DASHBOARD_PIN"] =
    process.env.DASHBOARD_PIN && process.env.DASHBOARD_PIN.trim()
      ? process.env.DASHBOARD_PIN
      : DEFAULT_DASHBOARD_PIN;
  const port = Number(process.env.PORT);
  target["PORT"] =
    Number.isFinite(port) && port > 0 && port <= 65535 ? Math.floor(port) : 4000;
  return env;
}

export type NodeRole = (typeof env)["NODE_ROLE"];
