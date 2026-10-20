/**
 * Loader for Powerhouse acceptance CASE fixtures (`fixtures/cases/*.json`).
 *
 * A case is a complete synthetic recommendation scenario: a reviewed
 * extraction (compact form), the trusted-document rows, the insurer registry
 * and the appetite rules. It is run through the REAL recommendation endpoint
 * so the benchmark covers deriveRisk → matcher → evidence → persisted row.
 * Expected outcomes live beside each case in `<id>.expected.json`.
 */

import { readdirSync } from "node:fs";
import type { AppetiteRow } from "../../worker/src/matcher-types.js";
import { readJson, fixturePath } from "./fixture-loader.js";
import { reviewedField, type HarnessInput, type Row } from "./handler-harness.js";

export interface CaseFile {
  fixture_schema: "powerhouse-case-v1";
  id: string;
  title: string;
  description: string;
  /** What this case exists to prove, in the author's words (also asserted in code). */
  intent: string[];
  rule_defaults?: Partial<AppetiteRow> & { updated_at?: string };
  /** Plain values; each leaf of the three extraction sections becomes a reviewed field. */
  reviewed_compact: Record<string, unknown>;
  documents: { document_type: string; status: string; scan_status: string | null }[];
  insurers: { id: string; name: string; active: boolean }[];
  extraction_confidence?: number | null;
  rules: (Partial<AppetiteRow> & { updated_at?: string })[];
  /** Synthetic sensitive strings that must appear in NO persisted column. */
  sentinels?: string[];
}

const FIELD_SECTIONS = new Set(["extracted_client", "current_cover", "risk_classification"]);

/** Expand compact values into reviewed-field objects (value, status, confidence). */
export function expandReviewed(compact: Record<string, unknown>): Row {
  const out: Row = {};
  for (const [key, value] of Object.entries(compact)) {
    if (!FIELD_SECTIONS.has(key) || !value || typeof value !== "object") {
      out[key] = value;
      continue;
    }
    const section: Row = {};
    for (const [field, raw] of Object.entries(value as Row)) {
      const explicit = raw && typeof raw === "object" && !Array.isArray(raw) && "value" in (raw as Row);
      section[field] = explicit
        ? reviewedField((raw as Row).value, (raw as Row).confidence as number | null)
        : reviewedField(raw);
    }
    out[key] = section;
  }
  return out;
}

export function caseIds(): string[] {
  return readdirSync(fixturePath("cases"))
    .filter((name) => name.endsWith(".json") && !name.endsWith(".expected.json"))
    .map((name) => name.replace(/\.json$/, ""))
    .sort();
}

export function loadCase(id: string): { file: CaseFile; input: HarnessInput; rules: Row[] } {
  const file = readJson<CaseFile>(`cases/${id}.json`);
  if (file.fixture_schema !== "powerhouse-case-v1") throw new Error(`case_schema_unsupported:${id}`);
  const rules = file.rules.map((rule) => ({ ...(file.rule_defaults ?? {}), ...rule }) as unknown as Row);
  return {
    file,
    rules,
    input: {
      reviewed: expandReviewed(file.reviewed_compact),
      rules,
      documents: file.documents,
      insurers: file.insurers,
      extractionConfidence: file.extraction_confidence,
    },
  };
}

export function loadExpected<T = unknown>(id: string): T {
  return readJson<T>(`cases/${id}.expected.json`);
}
