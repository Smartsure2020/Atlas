/**
 * Frontend fixtures, generated from the real backend.
 *
 * Evidence Mode (src/) is tested against `fixtures/snapshots/*.row.json`: the
 * exact `Recommendation` row the GET endpoint returns for each acceptance case,
 * plus authentic historical rows. This test regenerates every snapshot from the
 * real endpoint / builders and fails if a committed snapshot has drifted, so the
 * UI tests can never be green against a shape the backend no longer produces.
 *
 * Write mode: POWERHOUSE_WRITE_SNAPSHOTS=1 (deliberate, reviewed in the diff).
 *
 * Only ids and timestamps are normalised; nothing semantic is touched.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { MATCHER_VERSION, matchInsurers } from "../../worker/src/matcher.js";
import { deriveRisk, resolveConfidenceProvenance } from "../../worker/src/recommendation-endpoints.js";
import { buildRecommendationEvidence } from "../../worker/src/recommendation-evidence.js";
import { buildRecommendationEvidenceV2 } from "../../worker/src/recommendation-evidence-v2.js";
import { caseIds, loadCase } from "./case-loader.js";
import { fixturePath } from "./fixture-loader.js";
import { getThroughHandler, runThroughHandler, type Row } from "./handler-harness.js";

const tests: { name: string; fn: () => void | Promise<void> }[] = [];
function test(name: string, fn: () => void | Promise<void>) { tests.push({ name, fn }); }
function assert(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }

const WRITE = process.env.POWERHOUSE_WRITE_SNAPSHOTS === "1";
const FIXED_AT = "2026-10-16T10:00:00.000Z";

function pretty(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function normalise(row: Row, id: string): Row {
  const copy = JSON.parse(JSON.stringify(row)) as Row;
  copy.id = id;
  copy.created_at = FIXED_AT;
  const evidence = copy.evidence_json as Row | null;
  if (evidence) {
    const provenance = evidence.provenance as Row;
    provenance.recommendation_id = id;
    provenance.generated_at = FIXED_AT;
  }
  return copy;
}

function check(name: string, actual: Row) {
  const path = fixturePath(`snapshots/${name}.row.json`);
  const text = pretty(actual);
  if (WRITE) {
    writeFileSync(path, text);
    return;
  }
  assert(existsSync(path), `${name}: snapshot missing (run with POWERHOUSE_WRITE_SNAPSHOTS=1 and review the diff)`);
  const committed = readFileSync(path, "utf8").replace(/\r\n/g, "\n");
  assert(committed === text, `${name}: committed snapshot differs from what the backend produces now`);
}

for (const id of caseIds()) {
  test(`snapshot ${id}`, async () => {
    const loaded = loadCase(id);
    const run = await runThroughHandler(loaded.input);
    assert(run.row, "row persisted");
    const row = normalise(run.row, `rec-${id}`);
    check(id, await getThroughHandler(row));
  });
}

// Authentic historical rows: v1 evidence built by the retained, unchanged v1
// builder (the Phase 1A production contract), and a pre-Phase-1A null.
async function legacyColumns(caseId: string) {
  const loaded = loadCase(caseId);
  const run = await runThroughHandler(loaded.input);
  assert(run.row, "row persisted");
  const row = normalise(run.row, `historical-${caseId}`);
  const { evidence_json: _drop, ...rest } = row;
  void _drop;
  return { loaded, rest };
}

function matcherArtifacts(loaded: ReturnType<typeof loadCase>) {
  const { input } = loaded;
  const docs = (input.documents ?? []).filter((d) => d.status === "active" && d.scan_status === "clean").map((d) => d.document_type);
  const confidence = resolveConfidenceProvenance(input.reviewed, {}, input.extractionConfidence ?? null);
  const risk = deriveRisk(input.reviewed, docs, confidence.overall_confidence, confidence.overall_confidence_available);
  const rules = loaded.rules.filter((r) => r.is_active === true) as unknown as Parameters<typeof matchInsurers>[1];
  const result = matchInsurers(JSON.parse(JSON.stringify(risk)), JSON.parse(JSON.stringify(rules)));
  result.no_data_for = (input.insurers ?? [])
    .filter((insurer) => !rules.some((rule) => rule.insurer_id === insurer.id))
    .map((insurer) => ({ insurer_id: insurer.id, insurer_name: insurer.name }));
  return { input, risk, rules, result };
}

function v1Evidence(caseId: string, loaded: ReturnType<typeof loadCase>, id: string) {
  const { input, risk, rules, result } = matcherArtifacts(loaded);
  void caseId;
  return buildRecommendationEvidence({
    recommendationId: id,
    submissionId: "11111111-1111-1111-1111-111111111111",
    extractionId: "22222222-2222-2222-2222-222222222222",
    reviewedAt: "2026-10-16T08:00:00.000Z",
    generatedAt: FIXED_AT,
    matcherVersion: "2026-07-token-matching-v1",
    taxonomyVersion: "2026-07-token-aliases-v1",
    explanationMode: "deterministic",
    explanationSource: "deterministic",
    recommendationInputFingerprint: "fp_historical",
    reviewed: input.reviewed,
    matcherInput: risk,
    matcherResult: result,
    activeAppetite: rules,
  });
}

/**
 * Authentic evidence-v2 packet: built by the RETAINED, UNCHANGED v2 builder — the
 * contract that production has been writing since Batch 2. It carries no
 * completeness or contradiction analysis and must never be shown as though it did.
 */
function v2Evidence(loaded: ReturnType<typeof loadCase>, id: string) {
  const { input, risk, rules, result } = matcherArtifacts(loaded);
  return buildRecommendationEvidenceV2({
    recommendationId: id,
    submissionId: "11111111-1111-1111-1111-111111111111",
    extractionId: "22222222-2222-2222-2222-222222222222",
    reviewedAt: "2026-10-16T08:00:00.000Z",
    generatedAt: FIXED_AT,
    matcherVersion: MATCHER_VERSION,
    taxonomyVersion: "2026-07-token-aliases-v1",
    explanationMode: "deterministic",
    explanationSource: "deterministic",
    recommendationInputFingerprint: "fp_historical",
    reviewed: input.reviewed,
    matcherInput: risk,
    matcherResult: result,
    activeAppetite: rules,
  });
}

test("snapshot historical-v1-complete (Phase 1A evidence, quality 'complete')", async () => {
  const { loaded, rest } = await legacyColumns("case-01-single-section-baseline");
  const id = "historical-case-01";
  const evidence = v1Evidence("case-01", loaded, id);
  assert(evidence.quality.status === "complete", "fixture intent: v1 complete");
  check("historical-v1-complete", { ...rest, id, evidence_json: evidence as unknown as Row });
});

test("snapshot historical-v1-gaps (Phase 1A evidence, quality 'gaps_present')", async () => {
  const { loaded, rest } = await legacyColumns("case-10-incomplete-provenance-locator");
  const id = "historical-case-10";
  const evidence = v1Evidence("case-10", loaded, id);
  assert(evidence.quality.status === "gaps_present" && evidence.quality.gaps.length > 0, "fixture intent: v1 gaps_present");
  check("historical-v1-gaps", { ...rest, id, evidence_json: evidence as unknown as Row });
});

test("snapshot historical-v2-decision-ready (Batch 2 evidence, quality 'decision_ready', no completeness / contradictions)", async () => {
  const { loaded, rest } = await legacyColumns("case-01-single-section-baseline");
  const id = "historical-v2-case-01";
  const evidence = v2Evidence(loaded, id);
  assert(evidence.schema_version === "recommendation-evidence-v2" && evidence.quality.state === "decision_ready", "fixture intent: v2 decision_ready");
  assert(!("completeness" in evidence) && !("contradictions" in evidence), "a v2 packet never carries the Batch B analyses");
  check("historical-v2-decision-ready", { ...rest, id, evidence_json: evidence as unknown as Row });
});

test("snapshot historical-v2-incomplete (Batch 2 evidence, quality 'incomplete')", async () => {
  const { loaded, rest } = await legacyColumns("case-05-multi-section-hard-decline");
  const id = "historical-v2-case-05";
  const evidence = v2Evidence(loaded, id);
  assert(evidence.quality.state === "incomplete", "fixture intent: v2 incomplete");
  check("historical-v2-incomplete", { ...rest, id, evidence_json: evidence as unknown as Row });
});

test("snapshot historical-null (recommendation from before evidence_json existed)", async () => {
  const { rest } = await legacyColumns("case-01-single-section-baseline");
  check("historical-null", { ...rest, id: "historical-null", evidence_json: null });
});

let failures = 0;
for (const item of tests) {
  try {
    await item.fn();
    console.log(`ok - ${item.name}`);
  } catch (error) {
    failures++;
    console.error(`not ok - ${item.name}`);
    console.error((error as Error).message);
  }
}
console.log(`\nPowerhouse UI snapshots: ${tests.length - failures} passed, ${failures} failed out of ${tests.length}`);
if (failures > 0) process.exitCode = 1;
