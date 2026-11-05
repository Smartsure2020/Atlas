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
  "missing-info-interoperability": { kind: "node", file: ".test-dist/tests/powerhouse/missing-info-interoperability.test.js" },
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
    edits: [["\n  return null;\n}\n\nfunction exactPart", "\n  return { item_type: \"underwriting_info\", title: \"Internal item\", description: \"Internal diagnostic data\", section_key: null, source: \"quote_review\", owner: \"broker\" };\n}\n\nfunction exactPart"]],
    suites: ["detected-tracking"],
  },
  {
    id: "P29", brief: "detected-item idempotency is removed",
    file: "worker/src/detected-missing-info.ts",
    edits: [["const hex = sha256Hex(`atlas-detected-missing-info-v1\\u0000${submissionId}\\u0000${recommendationId}\\u0000${detectedItemId}`);", "const hex = sha256Hex(`atlas-detected-missing-info-v1\\u0000${submissionId}\\u0000${recommendationId}\\u0000${detectedItemId}\\u0000${Math.random()}`);"]],
    suites: ["detected-tracking"],
  },
  {
    id: "P30", brief: "submission-wide logical missing-info deduplication is removed",
    file: "worker/src/phase4-endpoints.ts",
    edits: [["if (logicalExisting) return json({ ok: true, id: String(logicalExisting.id), duplicate: true });", "if (false && logicalExisting) return json({ ok: true, id: String(logicalExisting.id), duplicate: true });"]],
    suites: ["detected-tracking"],
  },
  {
    id: "P31", brief: "waived missing-info rows stop counting as logical duplicates",
    file: "worker/src/detected-missing-info.ts",
    edits: [["if (typeof item.id !== \"string\") return false;", "if (typeof item.id !== \"string\" || (item as { status?: unknown }).status === \"waived\") return false;"]],
    suites: ["missing-info-interoperability"],
  },
  {
    id: "P32", brief: "detected tracking selects the oldest recommendation",
    file: "worker/src/phase4-endpoints.ts",
    edits: [[".select(\"id, evidence_json\")\n    .eq(\"submission_id\", submissionId)\n    .order(\"created_at\", { ascending: false })\n    .limit(1)", ".select(\"id, evidence_json\")\n    .eq(\"submission_id\", submissionId)\n    .order(\"created_at\", { ascending: true })\n    .limit(1)"]],
    suites: ["detected-tracking"],
  },
  {
    id: "P33", brief: "detected tracking omits recommendation ordering",
    file: "worker/src/phase4-endpoints.ts",
    edits: [[".select(\"id, evidence_json\")\n    .eq(\"submission_id\", submissionId)\n    .order(\"created_at\", { ascending: false })\n    .limit(1)", ".select(\"id, evidence_json\")\n    .eq(\"submission_id\", submissionId)\n    .limit(1)"]],
    suites: ["detected-tracking"],
  },
  {
    id: "P34", brief: "detected tracking omits the one-row recommendation limit",
    file: "worker/src/phase4-endpoints.ts",
    edits: [[".select(\"id, evidence_json\")\n    .eq(\"submission_id\", submissionId)\n    .order(\"created_at\", { ascending: false })\n    .limit(1)", ".select(\"id, evidence_json\")\n    .eq(\"submission_id\", submissionId)\n    .order(\"created_at\", { ascending: false })"]],
    suites: ["detected-tracking"],
  },
  {
    id: "P35", brief: "the detected item component is removed from its deterministic ID",
    file: "worker/src/detected-missing-info.ts",
    edits: [["const hex = sha256Hex(`atlas-detected-missing-info-v1\\u0000${submissionId}\\u0000${recommendationId}\\u0000${detectedItemId}`);", "const hex = sha256Hex(`atlas-detected-missing-info-v1\\u0000${submissionId}\\u0000${recommendationId}`);"]],
    suites: ["detected-tracking"],
  },
  {
    id: "P36", brief: "a whitespace-only reviewed value counts as supplied",
    file: "worker/src/completeness.ts",
    edits: [["if (typeof value === \"string\") return value.trim() !== \"\";", "if (typeof value === \"string\") return true;"]],
    suites: ["completeness"],
  },
  {
    id: "P37", brief: "an empty reviewed array counts as supplied",
    file: "worker/src/completeness.ts",
    edits: [["if (Array.isArray(value)) return value.length > 0;", "if (Array.isArray(value)) return true;"]],
    suites: ["completeness"],
  },
  {
    id: "P38", brief: "email plus tags are stripped during normalisation",
    file: "worker/src/contradictions.ts",
    edits: [["        .replace(/[.,;:!?]+$/g, \"\")\n        .toLowerCase();", "        .replace(/[.,;:!?]+$/g, \"\")\n        .toLowerCase()\n        .replace(/\\+/g, \"\");"]],
    suites: ["contradictions"],
  },
  {
    id: "P39", brief: "email dots are stripped during normalisation",
    file: "worker/src/contradictions.ts",
    edits: [["        .replace(/[.,;:!?]+$/g, \"\")\n        .toLowerCase();", "        .replace(/[.,;:!?]+$/g, \"\")\n        .toLowerCase()\n        .replace(/\\./g, \"\");"]],
    suites: ["contradictions"],
  },
  {
    id: "P40", brief: "email apostrophes and hyphens are stripped during normalisation",
    file: "worker/src/contradictions.ts",
    edits: [["        .replace(/[.,;:!?]+$/g, \"\")\n        .toLowerCase();", "        .replace(/[.,;:!?]+$/g, \"\")\n        .toLowerCase()\n        .replace(/['-]/g, \"\");"]],
    suites: ["contradictions"],
  },
  {
    id: "P41", brief: "Derive stops consulting the shared logical identity matcher",
    file: "worker/src/phase4-endpoints.ts",
    edits: [["if (findExistingLogicalMissingInfo(known, item, null, generatedFactPaths)) continue;", "if (false && findExistingLogicalMissingInfo(known, item, null, generatedFactPaths)) continue;"]],
    suites: ["missing-info-interoperability"],
  },
  {
    id: "P42", brief: "Track stops consulting the shared logical identity matcher",
    file: "worker/src/phase4-endpoints.ts",
    edits: [["if (logicalExisting) return json({ ok: true, id: String(logicalExisting.id), duplicate: true });", "if (false && logicalExisting) return json({ ok: true, id: String(logicalExisting.id), duplicate: true });"]],
    suites: ["missing-info-interoperability"],
  },
  {
    id: "P43", brief: "document identity stops using the canonical document key",
    file: "worker/src/detected-missing-info.ts",
    edits: [["if (isCanonicalRequiredDocument(candidate)) return `required_document|${documentKey(title)}`;", "if (isCanonicalRequiredDocument(candidate)) return `required_document|${title}`;"]],
    suites: ["missing-info-interoperability"],
  },
  {
    id: "P44", brief: "Derive candidates stop resolving their canonical fact path",
    file: "worker/src/detected-missing-info.ts",
    edits: [["return structuredFactPath ? resolveSchemaPath(structuredFactPath) : resolveSchemaFieldIdentity(String(candidate.title ?? \"\"));", "return structuredFactPath ? resolveSchemaPath(structuredFactPath) : null;"]],
    suites: ["missing-info-interoperability"],
  },
  {
    id: "P45", brief: "received rows stop counting as logical duplicates",
    file: "worker/src/detected-missing-info.ts",
    edits: [["if (typeof item.id !== \"string\") return false;", "if (typeof item.id !== \"string\" || (item as { status?: unknown }).status === \"received\") return false;"]],
    suites: ["missing-info-interoperability"],
  },
  {
    id: "P46", brief: "not-required rows stop counting as logical duplicates",
    file: "worker/src/detected-missing-info.ts",
    edits: [["if (typeof item.id !== \"string\") return false;", "if (typeof item.id !== \"string\" || (item as { status?: unknown }).status === \"not_required\") return false;"]],
    suites: ["missing-info-interoperability"],
  },
  {
    id: "P47", brief: "Derive inserts after its logical-item lookup fails",
    file: "worker/src/phase4-endpoints.ts",
    edits: [["if (existingError) return json({ error: \"fetch_failed\" }, 500);", "if (false && existingError) return json({ error: \"fetch_failed\" }, 500);"]],
    suites: ["missing-info-interoperability"],
  },
  {
    id: "P48", brief: "Track inserts after its logical-item lookup fails",
    file: "worker/src/phase4-endpoints.ts",
    edits: [["if (submissionItemsError) return json({ error: \"fetch_failed\" }, 500);", "if (false && submissionItemsError) return json({ error: \"fetch_failed\" }, 500);"]],
    suites: ["missing-info-interoperability"],
  },
  {
    id: "P49", brief: "logical duplicate lookup loses deterministic created-at/id ordering",
    file: "worker/src/phase4-endpoints.ts",
    edits: [["    .order(\"created_at\", { ascending: true })\n    .order(\"id\", { ascending: true });", ";", 2]],
    suites: ["missing-info-interoperability"],
  },
  {
    id: "P50", brief: "unknown free-text facts are fuzzily merged",
    file: "worker/src/detected-missing-info.ts",
    edits: [["return typeof value === \"string\" ? value.toLowerCase() : \"\";", "return typeof value === \"string\" ? value.toLowerCase().replace(/[^a-z0-9]/g, \"\") : \"\";"]],
    suites: ["missing-info-interoperability"],
  },
  {
    id: "P51", brief: "Derive no longer deduplicates two generated aliases within one batch",
    file: "worker/src/phase4-endpoints.ts",
    edits: [["known.push({ id: `pending-${rows.length}`, ...row });", "// pending rows omitted"]],
    suites: ["missing-info-interoperability"],
  },
  {
    id: "P52", brief: "stored registry aliases stop resolving to canonical fact identity",
    file: "worker/src/detected-missing-info.ts",
    edits: [
      ["      : resolveSchemaFieldIdentity(title);", "      : null;"],
      ["const aliases = candidatePath ? candidateFactAliases(candidatePath, peerFactPaths) : null;", "const aliases = null;"],
    ],
    suites: ["missing-info-interoperability"],
  },
  {
    id: "P53", brief: "ambiguous schema bare keys and labels globally resolve to the first path",
    file: "worker/src/completeness.ts",
    edits: [
      ["SCHEMA_KEY_PATHS.set(field.toLowerCase(), SCHEMA_KEY_PATHS.has(field.toLowerCase()) ? null : path);", "if (!SCHEMA_KEY_PATHS.has(field.toLowerCase())) SCHEMA_KEY_PATHS.set(field.toLowerCase(), path);"],
      ["SCHEMA_LABEL_PATHS.set(label, SCHEMA_LABEL_PATHS.has(label) ? null : path);", "if (!SCHEMA_LABEL_PATHS.has(label)) SCHEMA_LABEL_PATHS.set(label, path);"],
    ],
    suites: ["missing-info-interoperability"],
  },
  {
    id: "P54", brief: "peer-path collision protection is removed from ambiguous fact aliases",
    file: "worker/src/detected-missing-info.ts",
    edits: [["return new Set(aliases.map(aliasPart).filter(\n    (alias) => resolveSchemaFieldIdentity(alias) === path && !peers.some((peer) => peer.has(alias))\n  ));", "return new Set(aliases.map(aliasPart));"]],
    suites: ["missing-info-interoperability"],
  },
  {
    id: "P55", brief: "findings-derived document rows collapse by title alone",
    file: "worker/src/detected-missing-info.ts",
    edits: [["return candidate.item_type === \"document\" && candidate.source === \"rule\";", "return candidate.item_type === \"document\";"]],
    suites: ["missing-info-interoperability"],
  },
  {
    id: "P56", brief: "canonical required-document deduplication is removed",
    file: "worker/src/detected-missing-info.ts",
    edits: [["return candidate.item_type === \"document\" && candidate.source === \"rule\";", "return false;"]],
    suites: ["missing-info-interoperability"],
  },
  {
    id: "P57", brief: "Derive logical lookup loses submission scope",
    file: "worker/src/phase4-endpoints.ts",
    edits: [["const { data: existing, error: existingError } = await admin\n    .from(\"atlas_missing_info_items\")\n    .select(\"id, section_key, item_type, title, description, source, status, created_at\")\n    .eq(\"submission_id\", submissionId)", "const { data: existing, error: existingError } = await admin\n    .from(\"atlas_missing_info_items\")\n    .select(\"id, section_key, item_type, title, description, source, status, created_at\")"]],
    suites: ["missing-info-interoperability"],
  },
  {
    id: "P58", brief: "item_type is removed from exact fallback identity",
    file: "worker/src/detected-missing-info.ts",
    edits: [["    itemType,\n    exactPart(candidate.title),", "    \"\",\n    exactPart(candidate.title),"]],
    suites: ["missing-info-interoperability"],
  },
  {
    id: "P59", brief: "Track ignores its authoritative structured fact path",
    file: "worker/src/detected-missing-info.ts",
    edits: [["const candidateKey = missingInfoLogicalKey(candidate, structuredFactPath);", "const candidateKey = missingInfoLogicalKey(candidate);"]],
    suites: ["missing-info-interoperability"],
  },
  {
    id: "P60", brief: "legacy production Derive document tuples are no longer recognised",
    file: "worker/src/detected-missing-info.ts",
    edits: [["if (legacyDocumentKey && item.item_type === \"document\" && missingInfoExactKey(item) === legacyDocumentKey) return true;", "if (false && legacyDocumentKey && item.item_type === \"document\" && missingInfoExactKey(item) === legacyDocumentKey) return true;"]],
    suites: ["missing-info-interoperability"],
  },
  {
    id: "P61", brief: "historical Track deterministic-ID lookup is removed",
    file: "worker/src/phase4-endpoints.ts",
    edits: [["if (historical) return json({ ok: true, id: String(historical.id), duplicate: true });", "if (false && historical) return json({ ok: true, id: String(historical.id), duplicate: true });"]],
    suites: ["missing-info-interoperability"],
  },
  {
    id: "P62", brief: "Track reruns compute provenance from the current recommendation instead of prior recommendations",
    file: "worker/src/phase4-endpoints.ts",
    edits: [["    provenance.ids,\n    body.detected_item_id", "    [String(recommendation.id)],\n    body.detected_item_id"]],
    suites: ["missing-info-interoperability"],
  },
  {
    id: "P63", brief: "a globally ambiguous human alias is accepted for one canonical path",
    file: "worker/src/detected-missing-info.ts",
    edits: [["resolveSchemaFieldIdentity(alias) === path && !peers.some((peer) => peer.has(alias))", "!peers.some((peer) => peer.has(alias))"]],
    suites: ["missing-info-interoperability"],
  },
  {
    id: "P64", brief: "fact alias matching accepts substrings",
    file: "worker/src/detected-missing-info.ts",
    edits: [["aliases.has(aliasPart(item.title))", "[...aliases].some((alias) => aliasPart(item.title).includes(alias))"]],
    suites: ["missing-info-interoperability"],
  },
  {
    id: "P65", brief: "fact alias matching ignores item_type",
    file: "worker/src/detected-missing-info.ts",
    edits: [["return !!aliases && item.item_type === \"underwriting_info\" && aliases.has(aliasPart(item.title));", "return !!aliases && aliases.has(aliasPart(item.title));"]],
    suites: ["missing-info-interoperability"],
  },
  {
    id: "P66", brief: "Derive peer-path and global collision protection are removed",
    file: "worker/src/detected-missing-info.ts",
    edits: [["return new Set(aliases.map(aliasPart).filter(\n    (alias) => resolveSchemaFieldIdentity(alias) === path && !peers.some((peer) => peer.has(alias))\n  ));", "return new Set(aliases.map(aliasPart));"]],
    suites: ["missing-info-interoperability"],
  },
  {
    id: "P67", brief: "source is omitted from existing-row identity projections",
    file: "worker/src/phase4-endpoints.ts",
    edits: [[".select(\"id, section_key, item_type, title, description, source, status, created_at\")", ".select(\"id, section_key, item_type, title, description, status, created_at\")", 2]],
    suites: ["missing-info-interoperability"],
  },
  {
    id: "P68", brief: "historical recommendation provenance loses submission scope",
    file: "worker/src/phase4-endpoints.ts",
    edits: [["    .from(\"atlas_recommendations\")\n    .select(\"id\")\n    .eq(\"submission_id\", submissionId);", "    .from(\"atlas_recommendations\")\n    .select(\"id\");"]],
    suites: ["missing-info-interoperability"],
  },
  {
    id: "P69", brief: "Track ignores a failed historical provenance query",
    file: "worker/src/phase4-endpoints.ts",
    edits: [["  const provenance = await recommendationIdsForTrackProvenance(admin, submissionId, String(recommendation.id));\n  if (provenance.error) return json({ error: \"fetch_failed\" }, 500);", "  const provenance = await recommendationIdsForTrackProvenance(admin, submissionId, String(recommendation.id));\n  if (false && provenance.error) return json({ error: \"fetch_failed\" }, 500);"]],
    suites: ["missing-info-interoperability"],
  },
  {
    id: "P70", brief: "Derive ignores a failed historical provenance query",
    file: "worker/src/phase4-endpoints.ts",
    edits: [["  const provenance = known.length > 0 && generatedDetectedItemIds.some(Boolean)\n    ? await recommendationIdsForTrackProvenance(admin, submissionId)\n    : { ids: [], error: false };\n  if (provenance.error) return json({ error: \"fetch_failed\" }, 500);", "  const provenance = known.length > 0 && generatedDetectedItemIds.some(Boolean)\n    ? await recommendationIdsForTrackProvenance(admin, submissionId)\n    : { ids: [], error: false };\n  if (false && provenance.error) return json({ error: \"fetch_failed\" }, 500);"]],
    suites: ["missing-info-interoperability"],
  },
  {
    id: "P71", brief: "Track ignores a failed quote-review legacy-bridge lookup",
    file: "worker/src/phase4-endpoints.ts",
    edits: [["if (reviewError) return { items: [], error: true };", "if (false && reviewError) return { items: [], error: true };"]],
    suites: ["missing-info-interoperability"],
  },
  {
    id: "P72", brief: "Track ignores a failed quote-review-section legacy-bridge lookup",
    file: "worker/src/phase4-endpoints.ts",
    edits: [["if (sectionsError) return { items: [], error: true };", "if (false && sectionsError) return { items: [], error: true };"]],
    suites: ["missing-info-interoperability"],
  },
  {
    id: "P73", brief: "historical provenance examines only the newest prior recommendation",
    file: "worker/src/phase4-endpoints.ts",
    edits: [["  const { data, error } = await query\n    .order(\"created_at\", { ascending: false })\n    .limit(TRACK_PROVENANCE_RECOMMENDATION_LIMIT);", "  const { data, error } = await query\n    .order(\"created_at\", { ascending: false })\n    .limit(1);"]],
    suites: ["missing-info-interoperability"],
  },
  {
    id: "P74", brief: "historical provenance examines only the oldest prior recommendation",
    file: "worker/src/phase4-endpoints.ts",
    edits: [["  const { data, error } = await query\n    .order(\"created_at\", { ascending: false })\n    .limit(TRACK_PROVENANCE_RECOMMENDATION_LIMIT);", "  const { data, error } = await query\n    .order(\"created_at\", { ascending: true })\n    .limit(1);"]],
    suites: ["missing-info-interoperability"],
  },
  {
    id: "P75", brief: "source is removed only from Derive's existing-row projection",
    file: "worker/src/phase4-endpoints.ts",
    edits: [["  const { data: existing, error: existingError } = await admin\n    .from(\"atlas_missing_info_items\")\n    .select(\"id, section_key, item_type, title, description, source, status, created_at\")", "  const { data: existing, error: existingError } = await admin\n    .from(\"atlas_missing_info_items\")\n    .select(\"id, section_key, item_type, title, description, status, created_at\")"]],
    suites: ["missing-info-interoperability"],
  },
  {
    id: "P76", brief: "Track-side canonical document completeness item formula drifts",
    file: "worker/src/detected-missing-info.ts",
    edits: [["return key ? `cmp:required_document_missing:-:-:${key}` : null;", "return key ? `cmp:required_document_missing:-:document:${key}` : null;"]],
    suites: ["completeness"],
  },
  {
    id: "P77", brief: "Track-side structured fact path component drifts",
    file: "worker/src/detected-missing-info.ts",
    edits: [["return path ? `cmp:extraction_reported_information_missing:-:-:field:${path}` : null;", "return path ? `cmp:extraction_reported_information_missing:-:-:path:${path}` : null;"]],
    suites: ["completeness"],
  },
  {
    id: "P78", brief: "deterministic Track UUID drops recommendation scope",
    file: "worker/src/detected-missing-info.ts",
    edits: [["const hex = sha256Hex(`atlas-detected-missing-info-v1\\u0000${submissionId}\\u0000${recommendationId}\\u0000${detectedItemId}`);", "const hex = sha256Hex(`atlas-detected-missing-info-v1\\u0000${submissionId}\\u0000${detectedItemId}`);"]],
    suites: ["completeness"],
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
