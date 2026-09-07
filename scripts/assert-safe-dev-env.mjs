#!/usr/bin/env node
/**
 * Refuses to start the Atlas development server against the production
 * Supabase project. Runs as an npm `predev` hook.
 *
 * Loads the same Vite env resolution the dev server itself will use
 * (`.env.local` overrides `.env`), then checks the effective
 * `VITE_SUPABASE_URL`. Never prints keys or full URLs — reports only the
 * hostname on failure.
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const FORBIDDEN_PRODUCTION_REF = "algenlnxagpxzsgaworz";

function parseEnvFile(path) {
  if (!existsSync(path)) return {};
  const out = {};
  const raw = readFileSync(path, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[m[1]] = v;
  }
  return out;
}

function loadViteEnv(cwd = process.cwd()) {
  // Vite dev-mode precedence (highest first): process.env, .env.local, .env
  const local = parseEnvFile(resolve(cwd, ".env.local"));
  const base = parseEnvFile(resolve(cwd, ".env"));
  return { ...base, ...local, ...process.env };
}

function main() {
  const env = loadViteEnv();
  const url = env.VITE_SUPABASE_URL;

  if (!url) {
    process.stderr.write(
      "Refusing to start Atlas development server: VITE_SUPABASE_URL is not set.\n" +
      "Create a staging .env.local before running `npm run dev`.\n" +
      "See docs/phase4-live-staging-validation.md and .env.example.\n"
    );
    process.exit(2);
  }

  let hostname;
  try {
    hostname = new URL(url).hostname;
  } catch {
    process.stderr.write(
      "Refusing to start Atlas development server: VITE_SUPABASE_URL is not a valid URL.\n"
    );
    process.exit(2);
  }

  if (hostname.includes(FORBIDDEN_PRODUCTION_REF)) {
    process.stderr.write(
      `Refusing to start Atlas development server against production Supabase (host resolves to ${hostname}).\n` +
      "Create a staging .env.local configuration first.\n" +
      "See docs/phase4-live-staging-validation.md and .env.example.\n"
    );
    process.exit(2);
  }
}

main();
