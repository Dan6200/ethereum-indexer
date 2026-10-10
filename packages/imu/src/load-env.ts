import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Resolve the repo-root .env (3 levels up from src/) and load it explicitly.
// Bun only auto-loads .env from CWD, which breaks `bun run --filter ... start`.
const envPath = join(__dirname, "../../../.env");

if (existsSync(envPath)) {
  if (typeof process.loadEnvFile === "function") {
    process.loadEnvFile(envPath);
  } else {
    for (const line of readFileSync(envPath, "utf8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim();
      if (key && process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
  }
}
