/**
 * Powerhouse — `recommendation-evidence-v2` contract tests.
 *
 * v2 must (a) be a strict superset of v1 for everything v1 already said,
 * (b) add section / selection / considered-rule / quality data from the
 * matcher result without scoring anything itself, (c) fail closed, (d) stay
 * privacy-minimised, and (e) be deterministic.
 */

import { MATCHER_VERSION, matchInsurers, type MatchInputRisk } from "../../worker/src/matcher.js";
import type { AppetiteRow } from "../../worker/src/matcher-types.js";
import { buildRecommendationEvidence } from "../../worker/src/recommendation-evidence.js";
import {
  RECOMMENDATION_EVIDENCE_SCHEMA_VERSION_V2,
  SCORING_SCOPE_V2,
  buildRecommendationEvidenceV2,
  type RecommendationEvidenceV2,
} from "../../worker/src/recommendation-evidence-v2.js";
import { TAXONOMY_VERSION } from "../../worker/src/taxonomy.js";
import { loadFixture, clone } from "./fixture-loader.js";
import { getThroughHandler, reviewedField, runThroughHandler, type Row } from "./handler-harness.js";

const tests: { name: string; fn: () => void | Promise<void> }[] = [];
function test(name: string, fn: () => void | Promise<void>) { tests.push({ name, fn }); }
function assert(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
function eq<T>(actual: T, expected: T, message: string) {
  if (actual !== expected) throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function deepEq(actual: unknown, expected: unknown, message: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}:\n  expected ${JSON.stringify(expected)}\n  got      ${JSON.stringify(actual)}`);
  }
}

const common = {
  recommendationId: "rec", submissionId: "sub", extractionId: "ext",
  reviewedAt: "2026-10-16T09:00:00.000Z", generatedAt: "2026-10-16T10:00:00.000Z",
  matcherVersion: MATCHER_VERSION, taxonomyVersion: TAXONOMY_VERSION,
  explanationMode: "deterministic", explanationSource: "deterministic",
  recommendationInputFingerprint: "fp_test",
};

function build(risk: MatchInputRisk, rules: AppetiteRow[], noData: { insurer_id: string; insurer_name: string }[] = []) {
  const result = matchInsurers(clone(risk), clone(rules));
  result.no_data_for = noData;
  const v2 = buildRecommendationEvidenceV2({ ...common, reviewed: {}, matcherInput: clone(risk), matcherResult: result, activeAppetite: clone(rules) });
  const v1 = buildRecommendationEvidence({ ...common, reviewed: {}, matcherInput: clone(risk), matcherResult: result, activeAppetite: clone(rules) });
  return { v1, v2, result };
}

test("1. schema, identity and explicit scoring scope", () => {
  const { file, rules } = loadFixture("baseline-multi-section.json");
  const { v2 } = build(file.risk, rules);
  eq(v2.schema_version, RECOMMENDATION_EVIDENCE_SCHEMA_VERSION_V2, "schema version");
  eq(v2.schema_version, "recommendation-evidence-v2", "literal name");
  deepEq(v2.scoring_scope, SCORING_SCOPE_V2, "scoring scope is stated, not inferred");
  eq(v2.scoring_scope.aggregation_rule, null, "no aggregation rule exists");
  eq(v2.scoring_scope.business_decision_required, "multi_section_aggregation", "the open decision is named");
  deepEq(v2.requested_sections.map((s) => s.section_key), ["commercial_motor", "goods_in_transit"], "requested sections");
  eq(v2.provenance.matcher_version, "2026-10-section-evaluation-v2", "matcher version recorded");
});

test("2. SUPERSET: every v1 field of every insurer outcome is reproduced unchanged in v2", () => {
  const { file, rules } = loadFixture("baseline-multi-section.json");
  const { v1, v2 } = build(file.risk, rules, [{ insurer_id: "insurer-z", insurer_name: "Zed Mutual" }]);
  eq(v2.insurers.length, v1.insurers.length, "same insurers");
  v1.insurers.forEach((old, index) => {
    const now = v2.insurers[index] as unknown as Record<string, unknown>;
    for (const [key, value] of Object.entries(old)) {
      deepEq(now[key], value, `insurer ${old.insurer_id}.${key}`);
    }
  });
  deepEq(v2.reviewed_risk_facts, v1.reviewed_risk_facts, "reviewed facts");
  deepEq(v2.trusted_documents, v1.trusted_documents, "trusted documents");
  deepEq(v2.matcher_input, v1.matcher_input, "matcher input");
  deepEq(v2.provenance, v1.provenance, "provenance");
});

test("3. v2 adds selection, section evaluations, considered rules and per-insurer quality to scored insurers only", () => {
  const { file, rules } = loadFixture("baseline-multi-section.json");
  const { v2 } = build(file.risk, rules, [{ insurer_id: "insurer-z", insurer_name: "Zed Mutual" }]);
  for (const insurer of v2.insurers) {
    if (insurer.status === "scored") {
      assert(insurer.selection && Array.isArray(insurer.section_evaluations) && Array.isArray(insurer.considered_rules), "scored: new fields");
      assert(insurer.quality && typeof insurer.quality.state === "string", "scored: quality");
    } else {
      eq(insurer.rank, null, "no-data outcome has no rank");
      eq(insurer.score, null, "no-data outcome has no fabricated score");
      for (const key of ["selection", "section_evaluations", "considered_rules", "quality"]) {
        assert(!(key in insurer), `no-data outcome carries no ${key}`);
      }
      eq(insurer.status_code, "no_active_appetite_data", "explicit no-data status code");
    }
  }
});

test("4. considered rules carry point-in-time provenance from the active rule set; nothing is invented", () => {
  const { file, rules } = loadFixture("baseline-multi-section.json");
  const edited = clone(rules).map((r) => r.id === "alpha-git" ? { ...r, source_document_id: null, source_page: null, source_quote: null } : r);
  const { v2 } = build(file.risk, edited);
  const alpha = v2.insurers.find((i) => i.insurer_id === "insurer-alpha");
  assert(alpha && alpha.status === "scored", "alpha");
  const git = alpha.considered_rules.find((r) => r.rule_id === "alpha-git")!;
  eq(git.snapshot_resolved, true, "resolved");
  eq(git.source_document_id, null, "missing stays missing");
  eq(git.source_page, null, "page not fabricated");
  eq(git.source_quote, null, "quote not fabricated");
  eq(git.source_file_name, "guideline.pdf", "present provenance preserved");
});

test("5. FAIL CLOSED: a matcher result without section intelligence is refused, never silently downgraded", () => {
  const { file, rules } = loadFixture("baseline-multi-section.json");
  const result = matchInsurers(clone(file.risk), clone(rules));
  const stripped = { ...result, insurers: result.insurers.map(({ selection: _s, section_evaluations: _e, considered_rules: _c, ...rest }) => rest) };
  let thrown = "";
  try {
    buildRecommendationEvidenceV2({ ...common, reviewed: {}, matcherInput: file.risk, matcherResult: stripped, activeAppetite: rules });
  } catch (error) {
    thrown = (error as Error).message;
  }
  assert(thrown.startsWith("matcher_section_intelligence_missing:"), `expected fail-closed, got "${thrown}"`);
});

test("6. DETERMINISTIC: identical input gives byte-identical JSON, and JSON round-trips losslessly", () => {
  const { file, rules } = loadFixture("baseline-multi-section.json");
  const first = JSON.stringify(build(file.risk, rules).v2);
  const second = JSON.stringify(build(file.risk, [...rules].reverse()).v2);
  eq(second, first, "row order does not affect the packet");
  eq(JSON.stringify(JSON.parse(first)), first, "round trip");
});

test("7. PRIVACY: no feature text, reviewed value, storage path or URL appears in the packet", () => {
  const risk: MatchInputRisk = {
    product_candidates: ["commercial motor"], section_candidates: ["Commercial motor"], risk_candidates: ["transport"],
    features: [
      { text: "SENTINEL_TEXT_ONE transport fleet", source: "occupation/business description" },
      { text: "SENTINEL_TEXT_TWO", source: "risk address" },
      { text: "SENTINEL_TEXT_THREE", source: "red flag", ai_inferred: true },
    ],
    available_documents: [], overall_confidence: 0.9, overall_confidence_available: true,
  };
  const { file } = loadFixture("baseline-multi-section.json");
  const { v2 } = build(risk, clone(file.rules as AppetiteRow[]).map((r) => ({ ...r, preferred_risks: ["transport fleet"] })) as AppetiteRow[]);
  const text = JSON.stringify(v2);
  for (const needle of ["SENTINEL_TEXT_ONE", "SENTINEL_TEXT_TWO", "SENTINEL_TEXT_THREE", "storage_path", "signed_url", "http://", "https://"]) {
    assert(!text.includes(needle), `packet must not contain ${needle}`);
  }
  assert(v2.matcher_input.features.every((f) => f.value_retained === false), "features redacted");
});

test("8. HANDLER: the persisted evidence_json is v2, GET returns it unchanged, quality is derived server-side", async () => {
  const reviewed: Row = {
    schema_version: "t",
    extracted_client: { occupation_or_business_description: reviewedField("transport fleet") },
    current_cover: { cover_sections: reviewedField(["Commercial motor", "Goods in transit"]) },
    risk_classification: {
      product_line: reviewedField("commercial motor"), risk_type: reviewedField("transport"),
      primary_risk_type: reviewedField("transport fleet"), business_sector: reviewedField("transport"),
    },
    red_flags: [],
  };
  const { rules } = loadFixture("baseline-multi-section.json");
  const run = await runThroughHandler({
    reviewed,
    rules: clone(rules) as unknown as Row[],
    documents: [],
    insurers: [{ id: "insurer-alpha", name: "Alpha Insurance", active: true }, { id: "insurer-nodata", name: "No Data Mutual", active: true }],
  });
  eq(run.status, 200, "run ok");
  assert(run.row, "row");
  const evidence = run.row.evidence_json as unknown as RecommendationEvidenceV2;
  eq(evidence.schema_version, "recommendation-evidence-v2", "v2 persisted");
  eq(evidence.provenance.recommendation_id, run.row.id, "identity link");
  assert(["decision_ready", "caution", "incomplete"].includes(evidence.quality.state), "quality state present");
  eq(evidence.quality.state, "incomplete", "alpha's hidden Goods in transit decline makes this incomplete");
  const got = await getThroughHandler(run.row);
  deepEq(got.evidence_json, run.row.evidence_json, "GET returns the persisted evidence unchanged");
  const serialised = JSON.stringify(run.row);
  for (const forbidden of ["storage_path", "signed_url", "service-role-test-key", "anthropic-test-key"]) {
    assert(!serialised.includes(forbidden), `row excludes ${forbidden}`);
  }
});

test("9. HANDLER: evidence-builder failure still fails the job safely with no recommendation written", async () => {
  const { rules } = loadFixture("baseline-multi-section.json");
  const { installRestStub, buildTables, env, MANAGER, forcedRequest } = await import("./handler-harness.js");
  const { handleRunRecommendation } = await import("../../worker/src/recommendation-endpoints.js");
  const stub = installRestStub(buildTables({
    reviewed: { schema_version: "t" }, rules: clone(rules) as unknown as Row[], documents: [], insurers: [],
  }));
  try {
    const res = await handleRunRecommendation("11111111-1111-1111-1111-111111111111", forcedRequest(), env(), MANAGER, {
      buildEvidence: () => { throw new Error("injected detail"); },
    });
    eq(res.status, 500, "safe failure");
    eq(stub.writes("atlas_recommendations").length, 0, "nothing persisted");
  } finally {
    stub.restore();
  }
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
console.log(`\nPowerhouse evidence v2: ${tests.length - failures} passed, ${failures} failed out of ${tests.length}`);
if (failures > 0) process.exitCode = 1;
