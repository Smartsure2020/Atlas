#!/usr/bin/env node
/**
 * Powerhouse Batch B — mutation probes.
 *
 * Each probe makes ONE deliberate, plausible bug in production source, runs the
 * suites that are supposed to catch it, and demands that at least one fails. A
 * probe that SURVIVES means a test is missing; the script then exits non-zero.
 *
 *   npm run test:powerhouse-mutations
 *
 * How it stays honest and fast:
 *   - Backend mutants are transpiled with TypeScript's transpileModule (no type
 *     check, so a mutant that would not type-check still runs) straight into
 *     .test-dist, the suite is run, and the original is transpiled back. A final
 *     `tsc -p tsconfig.test.json` restores the real build.
 *   - Frontend mutants edit the source in place, run vitest, and restore the file
 *     from an in-memory copy in a `finally`.
 *   - Every edit must match the source EXACTLY the stated number of times, so a
 *     refactor that moves the mutation point fails loudly instead of "passing".
 *   - Before any mutation each suite is run once unmutated: a kill only counts
 *     against a green baseline.
 *
 * Nothing here is part of the product; it only reads and temporarily edits files
 * and always restores them.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REGISTER = "./scripts/register-test-esm-extensionless.mjs";

/** name -> { kind, command } */
const SUITES = {
  acceptance: { kind: "node", file: ".test-dist/tests/powerhouse/acceptance.test.js" },
  completeness: { kind: "node", file: ".test-dist/tests/powerhouse/completeness.test.js" },
  contradictions: { kind: "node", file: ".test-dist/tests/powerhouse/contradictions.test.js" },
  "detected-tracking": { kind: "node", file: ".test-dist/tests/powerhouse/detected-missing-info.test.js" },
  persistence: { kind: "node", file: ".test-dist/tests/powerhouse/persistence.test.js" },
  "evidence-v2": { kind: "node", file: ".test-dist/tests/powerhouse/evidence-v2.test.js" },
  "quality-gate": { kind: "node", file: ".test-dist/tests/powerhouse/quality-gate.test.js" },
  "view-model": { kind: "vitest", file: "src/test/recommendation-evidence.test.ts" },
  "evidence-ui": { kind: "vitest", file: "src/test/evidence-mode.test.tsx" },
  "missing-info-ui": { kind: "vitest", file: "src/test/missing-information-workbench.test.tsx" },
};

/**
 * edit: [find, replace, expectedMatches?]  (default 1)
 * Replacement is applied to every match.
 */
const PROBES = [
  // ---- The fourteen named in the brief ------------------------------------------------
  {
    id: "P01", brief: "a missing required item is treated as complete",
    file: "worker/src/completeness.ts",
    edits: [["if (entry.missingInsurers.size === 0) continue; // every requiring insurer has it: not a gap", "continue;"]],
    suites: ["completeness", "acceptance"],
  },
  {
    id: "P02", brief: "an irrelevant document satisfies a requirement (matcher presence test)",
    file: "worker/src/matcher.ts",
    edits: [["    return x.includes(r) || r.includes(x);", "    return true;"]],
    suites: ["acceptance", "completeness"],
  },
  {
    id: "P03", brief: "contradiction normalisation removed (email case-fold)",
    file: "worker/src/contradictions.ts",
    edits: [["        .replace(/[.,;:!?]+$/g, \"\")\n        .toLowerCase();", "        .replace(/[.,;:!?]+$/g, \"\");"]],
    suites: ["contradictions", "acceptance"],
  },
  {
    id: "P04", brief: "equal normalised values falsely contradict (clustering on the raw text)",
    file: "worker/src/contradictions.ts",
    edits: [
      ["const refs = groups.get(item.result.value) ?? new Map<string, Observation>();", "const refs = groups.get(String(item.observation.raw)) ?? new Map<string, Observation>();"],
      ["groups.set(item.result.value, refs);", "groups.set(String(item.observation.raw), refs);"],
    ],
    suites: ["contradictions", "acceptance"],
  },
  {
    id: "P05", brief: "a real mismatch is ignored",
    file: "worker/src/contradictions.ts",
    edits: [["if (groups.size >= 2) {", "if (groups.size >= 3) {"]],
    suites: ["contradictions", "acceptance"],
  },
  {
    id: "P06", brief: "a contradiction disappears when the source order reverses",
    file: "worker/src/contradictions.ts",
    edits: [["if (groups.size >= 2) {", "if (groups.size >= 2 && usable[0].result.value !== usable[1].result.value) {"]],
    suites: ["contradictions"],
  },
  {
    id: "P07", brief: "pairwise explosion: every source becomes its own group",
    file: "worker/src/contradictions.ts",
    edits: [
      ["const refs = groups.get(item.result.value) ?? new Map<string, Observation>();", "const refs = groups.get(`${item.result.value}|${item.observation.source_id}`) ?? new Map<string, Observation>();"],
      ["groups.set(item.result.value, refs);", "groups.set(`${item.result.value}|${item.observation.source_id}`, refs);"],
    ],
    suites: ["contradictions"],
  },
  {
    id: "P08", brief: "a downstream completeness analysis changes a matcher score",
    file: "worker/src/recommendation-evidence-v3.ts",
    edits: [["return { ...outcome, quality: insurerState };", "return { ...outcome, score: outcome.score - assessed.completeness.item_count, quality: insurerState };"]],
    suites: ["acceptance", "completeness"],
  },
  {
    id: "P09", brief: "a contradiction resolves itself",
    file: "worker/src/contradictions.ts",
    edits: [["        status: \"unresolved\",", "        status: \"resolved\","]],
    suites: ["contradictions", "acceptance"],
  },
  {
    id: "P10", brief: "historical v2 is treated as v3 (no 'not captured' branch)",
    file: "src/lib/recommendation-evidence.ts",
    edits: [["  if (view.version === \"v2\") return { mode: \"not_captured\", version: \"v2\", message: COMPLETENESS_NOT_CAPTURED_V2 };\n", "", 2]],
    suites: ["view-model", "evidence-ui"],
  },
  {
    id: "P11", brief: "completeness is reconstructed for a historical v2 packet",
    file: "src/lib/recommendation-evidence.ts",
    edits: [[
      "  if (view.version === \"v2\") return { mode: \"not_captured\", version: \"v2\", message: COMPLETENESS_NOT_CAPTURED_V2 };\n\n  const evidence = view.evidence;\n  const names",
      "  if (view.version === \"v2\") return { mode: \"captured\", state: \"complete\", stateMeta: COMPLETENESS_STATE.complete, materialCount: 0, nonblockingCount: 0, basis: [], caseLines: [], documentLines: [], insurerGroups: [], completeInsurers: [], reportedOmitted: 0 };\n\n  const evidence = view.evidence;\n  const names",
    ]],
    suites: ["view-model", "evidence-ui"],
  },
  {
    id: "P12", brief: "a raw privacy sentinel is copied into the evidence (extraction free text)",
    file: "worker/src/completeness.ts",
    edits: [
      ["      field_path: fieldPath,", "      field_path: fieldPath,\n      text: field,"],
      ["label: record.field_path ? schemaFieldLabel(record.field_path) : null,", "label: (record as { text?: string }).text ?? null,"],
    ],
    suites: ["completeness", "acceptance"],
  },
  {
    id: "P13", brief: "quality linkage removed",
    file: "worker/src/recommendation-quality-v3.ts",
    edits: [["return { ...item, quality_gap_ids: unique(covering.map((gap) => gap.gap_id)) };", "return { ...item, quality_gap_ids: [] };"]],
    suites: ["completeness", "acceptance"],
  },
  {
    id: "P14a", brief: "fingerprint: completeness model version removed",
    file: "worker/src/phase7-core.ts",
    edits: [["    completeness_model_version: input.completenessModelVersion,\n", ""]],
    suites: ["persistence"],
  },
  {
    id: "P14b", brief: "fingerprint: contradiction model version removed",
    file: "worker/src/phase7-core.ts",
    edits: [["    contradiction_model_version: input.contradictionModelVersion,\n", ""]],
    suites: ["persistence"],
  },
  // ---- Further plausible bugs ----------------------------------------------------------------
  {
    id: "P15", brief: "the invalid broker-email production registry is restored",
    file: "worker/src/contradictions.ts",
    edits: [["export const COMPARABLE_FIELDS: readonly ComparableFieldSpec[] = [];", "export const COMPARABLE_FIELDS: readonly ComparableFieldSpec[] = [{ field_key: \"broker.email\", label: \"Broker email address\", normalizer: \"email_trim_lowercase\", sensitivity: \"personal_identifier\", field_path: \"broker.email\", sources: [{ source_id: SOURCE_INTAKE_FORM, label: \"Submission intake\", read: intakeColumnSource(\"broker_email\") }, { source_id: SOURCE_REVIEWED_EXTRACTION, label: \"Reviewed extraction\", read: reviewedFieldSource(\"broker\", \"email\") }] }];"]],
    suites: ["contradictions", "acceptance"],
  },
  {
    id: "P16", brief: "personal identifiers are displayed unmasked",
    file: "worker/src/contradictions.ts",
    edits: [["if (spec.sensitivity === \"personal_identifier\") return maskIdentifier(kind, normalized);", "if (spec.sensitivity === \"personal_identifier\") return normalized;"]],
    suites: ["contradictions", "acceptance", "persistence"],
  },
  {
    id: "P17", brief: "severity ignores whether the matcher consumes the field",
    file: "worker/src/contradictions.ts",
    edits: [["severity: consumed ? \"material\" : \"advisory\",", "severity: \"advisory\","]],
    suites: ["contradictions"],
  },
  {
    id: "P18", brief: "a stale extraction-reported field survives a completed review",
    file: "worker/src/completeness.ts",
    edits: [["if (reviewedFieldIsPresent(reviewed, fieldPath) || resolved.has(fieldPath)) return;", "if (resolved.has(fieldPath)) return;"]],
    suites: ["completeness"],
  },
  {
    id: "P19", brief: "a wholly unevidenced insurer is no longer material",
    file: "worker/src/completeness.ts",
    edits: [["entry.missingInsurers.set(id, whollyUnevidenced ? \"material\" : \"nonblocking\");", "entry.missingInsurers.set(id, \"nonblocking\");"]],
    suites: ["completeness", "acceptance"],
  },
  {
    id: "P20", brief: "v3 stops being a superset of v2 (drops trusted documents)",
    file: "worker/src/recommendation-evidence-v3.ts",
    edits: [["    trusted_documents: base.trusted_documents,\n", ""]],
    suites: ["completeness", "acceptance"],
  },
  {
    id: "P21", brief: "an internal limitation becomes trackable (and so visible to a broker)",
    file: "src/lib/recommendation-evidence.ts",
    edits: [["sectionKey: null, trackable: false, owner: \"consultant\" };", "sectionKey: null, trackable: true, owner: \"consultant\" };"]],
    suites: ["view-model", "missing-info-ui"],
  },
  {
    id: "P22", brief: "an unreadable email is compared as if it were a value",
    file: "worker/src/contradictions.ts",
    edits: [["        return { ok: false, reason: \"not_an_email_address\" };", "        return { ok: true, value };"]],
    suites: ["contradictions"],
  },
  {
    id: "P23", brief: "a blank value counts as a recorded value",
    file: "worker/src/contradictions.ts",
    edits: [["(typeof raw === \"string\" && raw.trim() === \"\")", "false"]],
    suites: ["contradictions"],
  },
  {
    id: "P24", brief: "documents are not folded by canonical key (double counting)",
    file: "worker/src/completeness.ts",
    edits: [["const key = documentKey(outcome.document_type);", "const key = outcome.document_type;"]],
    suites: ["completeness", "acceptance"],
  },
  {
    id: "P25", brief: "the fingerprint digests raw rather than normalised values (cosmetic edits invalidate the cache)",
    file: "worker/src/contradictions.ts",
    edits: [["result.ok ? `ok:${result.value}` : `unparseable:${result.reason}`,", "`ok:${String(observation.raw)}`,"]],
    suites: ["persistence", "contradictions"],
  },
  {
    id: "P26", brief: "an extraction record with no `field` becomes an item",
    file: "worker/src/completeness.ts",
    edits: [["if (typeof field !== \"string\" || field.trim() === \"\") return;", "if (typeof field !== \"string\") return;"]],
    suites: ["completeness"],
  },
  {
    id: "P27", brief: "persisted value digests are restored",
    file: "worker/src/contradictions.ts",
    edits: [["            value_label: ordinalLabel(index),", "            value_digest: sha256Hex(normalized).slice(0, 16),\n            value_label: ordinalLabel(index),"]],
    suites: ["contradictions", "persistence"],
  },
  {
    id: "P28", brief: "the server-side detected-item allow-list is removed",
    file: "worker/src/detected-missing-info.ts",
    edits: [["\n  return null;\n}\n\n/**\n * Existing UUID primary key", "\n  return { item_type: \"underwriting_info\", title: \"Internal item\", description: \"Internal diagnostic data\", section_key: null, source: \"quote_review\", owner: \"broker\" };\n}\n\n/**\n * Existing UUID primary key"]],
    suites: ["detected-tracking"],
  },
  {
    id: "P29", brief: "detected-item idempotency is removed",
    file: "worker/src/detected-missing-info.ts",
    edits: [["const hex = sha256Hex(`atlas-detected-missing-info-v1\\u0000${submissionId}\\u0000${recommendationId}\\u0000${detectedItemId}`);", "const hex = sha256Hex(`atlas-detected-missing-info-v1\\u0000${submissionId}\\u0000${recommendationId}\\u0000${detectedItemId}\\u0000${Math.random()}`);"]],
    suites: ["detected-tracking"],
  },
];

// ---------------------------------------------------------------------------

const read = (file) => readFileSync(path.join(ROOT, file), "utf8");
const write = (file, text) => writeFileSync(path.join(ROOT, file), text);

function transpileInto(sourceFile, text) {
  const out = ts.transpileModule(text, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022, moduleResolution: ts.ModuleResolutionKind.Bundler },
    fileName: sourceFile,
  }).outputText;
  const target = path.join(ROOT, ".test-dist", sourceFile.replace(/\.ts$/, ".js"));
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, out);
}

function applyEdits(original, edits, id) {
  const lf = original.includes("\r\n");
  let text = original.replace(/\r\n/g, "\n");
  for (const [find, replace, expected = 1] of edits) {
    const parts = text.split(find);
    const matches = parts.length - 1;
    if (matches !== expected) throw new Error(`${id}: expected ${expected} match(es) for ${JSON.stringify(find.slice(0, 70))}, found ${matches}`);
    text = parts.join(replace);
  }
  return lf ? text.replace(/\n/g, "\r\n") : text;
}

function run(suiteName) {
  const suite = SUITES[suiteName];
  const vitest = path.join(ROOT, "node_modules", ".bin", process.platform === "win32" ? "vitest.cmd" : "vitest");
  const result =
    suite.kind === "node"
      ? spawnSync(process.execPath, ["--import", REGISTER, suite.file], { cwd: ROOT, encoding: "utf8", timeout: 600_000 })
      : spawnSync(vitest, ["run", suite.file], { cwd: ROOT, encoding: "utf8", timeout: 600_000, shell: process.platform === "win32" });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  const failed = result.status !== 0 || /^not ok/m.test(output);
  return { failed, output };
}

// `--only P11,P21` re-runs a subset (the baseline is then limited to the suites they need).
const onlyIndex = process.argv.indexOf("--only");
const only = onlyIndex >= 0 ? new Set(process.argv[onlyIndex + 1].split(",")) : null;
const selected = only ? PROBES.filter((probe) => only.has(probe.id)) : PROBES;

console.log("Powerhouse Batch B — mutation probes\n");
console.log("Baseline (unmutated):");
const needed = [...new Set(selected.flatMap((probe) => probe.suites))];
for (const name of needed) {
  const { failed, output } = run(name);
  console.log(`  ${failed ? "FAIL" : "pass"}  ${name}`);
  if (failed) {
    console.error(output.split("\n").slice(-25).join("\n"));
    console.error("\nThe baseline must be green before mutations mean anything.");
    process.exit(2);
  }
}

const results = [];
for (const probe of selected) {
  const original = read(probe.file);
  const isBackend = probe.file.startsWith("worker/");
  let killedBy = null;
  let note = "";
  try {
    const mutated = applyEdits(original, probe.edits, probe.id);
    if (isBackend) transpileInto(probe.file, mutated);
    else write(probe.file, mutated);
    for (const suite of probe.suites) {
      if (run(suite).failed) {
        killedBy = suite;
        break;
      }
    }
  } catch (error) {
    note = error.message;
  } finally {
    if (isBackend) transpileInto(probe.file, original);
    else write(probe.file, original);
  }
  const status = note ? "ERROR" : killedBy ? "killed" : "SURVIVED";
  results.push({ ...probe, status, killedBy, note });
  console.log(`${status.padEnd(8)} ${probe.id.padEnd(5)} ${probe.brief}${killedBy ? `  [${killedBy}]` : ""}${note ? `  (${note})` : ""}`);
}

const survived = results.filter((r) => r.status !== "killed");
console.log(`\n${results.length - survived.length}/${results.length} probes killed.`);
if (survived.length > 0) {
  console.error("Survivors / errors:", survived.map((r) => r.id).join(", "));
  process.exitCode = 1;
}
