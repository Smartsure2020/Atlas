/**
 * Powerhouse synthetic fixture loader.
 *
 * Fixtures are plain JSON (`tests/powerhouse/fixtures/*.json`) so they diff
 * cleanly and carry no executable logic. A fixture lists its appetite rules
 * as partial rows; `rule_defaults` fills the remaining AppetiteRow fields so a
 * rule only states what makes it different. Loading is pure and synchronous:
 * no network, no clock, no randomness.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { MatchInputRisk } from "../../worker/src/matcher.js";
import type { AppetiteRow } from "../../worker/src/matcher-types.js";

export interface FixtureFile {
  fixture_schema: "powerhouse-fixture-v1";
  id: string;
  title: string;
  description: string;
  rule_defaults?: Partial<AppetiteRow>;
  risk: MatchInputRisk;
  /** Reviewed extraction JSON handed to the evidence builder (synthetic only). */
  reviewed?: Record<string, unknown>;
  rules: Partial<AppetiteRow>[];
  no_data_insurers?: { insurer_id: string; insurer_name: string }[];
  [extra: string]: unknown;
}

export interface LoadedFixture<T extends FixtureFile = FixtureFile> {
  file: T;
  rules: AppetiteRow[];
}

const FIXTURE_DIR = resolve(process.cwd(), "tests/powerhouse/fixtures");

export function fixturePath(name: string): string {
  return resolve(FIXTURE_DIR, name);
}

export function readJson<T = unknown>(name: string): T {
  return JSON.parse(readFileSync(fixturePath(name), "utf8")) as T;
}

export function loadFixture<T extends FixtureFile = FixtureFile>(name: string): LoadedFixture<T> {
  const file = readJson<T>(name);
  if (file.fixture_schema !== "powerhouse-fixture-v1") {
    throw new Error(`fixture_schema_unsupported:${name}`);
  }
  const rules = file.rules.map((rule) => ({ ...(file.rule_defaults ?? {}), ...rule }) as AppetiteRow);
  return { file, rules };
}

/** Deep clone through JSON so a matcher can never mutate the loaded fixture. */
export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
