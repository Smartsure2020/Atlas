/**
 * Powerhouse P1C — the deterministic quality gate, one test per row of the
 * classification table in docs/powerhouse-p1b-p2-intelligence-quality.md.
 * If a severity changes, the table and this file must change together.
 */

import {
  MATCHER_VERSION,
  matchInsurers,
  type MatchInputRisk,
} from "../../worker/src/matcher.js";
import type { AppetiteRow } from "../../worker/src/matcher-types.js";
import {
  buildRecommendationEvidenceV2,
  type QualityGapCodeV2,
  type QualityGapV2,
  type RecommendationEvidenceV2,
  type ScoredInsurerOutcomeEvidenceV2,
} from "../../worker/src/recommendation-evidence-v2.js";
import { TAXONOMY_VERSION } from "../../worker/src/taxonomy.js";

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

function rule(overrides: Partial<AppetiteRow>): AppetiteRow {
  return {
    id: "rule",
    insurer_id: "insurer-1",
    insurer_name: "Insurer One",
    product_line: "commercial_motor",
    risk_type: "transport",
    appetite_level: "standard",
    preferred_risks: [],
    caution_risks: [],
    declined_risks: [],
    required_documents: [],
    referral_triggers: [],
    notes: null,
    source: "manual",
    source_document_id: "doc-1",
    source_file_name: "guide.pdf",
    source_page: 3,
    source_section: "Motor",
    source_quote: "Quote.",
    is_active: true,
    ...overrides,
  };
}

function risk(overrides: Partial<MatchInputRisk> = {}): MatchInputRisk {
  return {
    product_candidates: ["commercial motor"],
    section_candidates: ["Commercial motor"],
    risk_candidates: ["transport"],
    features: [{ text: "transport fleet", source: "primary risk type" }],
    available_documents: ["Claims history"],
    overall_confidence: 0.9,
    overall_confidence_available: true,
    ...overrides,
  };
}

function evidence(
  matcherRisk: MatchInputRisk,
  rules: AppetiteRow[],
  extra: {
    noData?: { insurer_id: string; insurer_name: string }[];
    reviewed?: Record<string, unknown>;
    activeAppetite?: AppetiteRow[];
  } = {}
): RecommendationEvidenceV2 {
  const result = matchInsurers(matcherRisk, rules);
  result.no_data_for = extra.noData ?? [];
  return buildRecommendationEvidenceV2({
    recommendationId: "rec", submissionId: "sub", extractionId: "ext",
    reviewedAt: "2026-10-16T09:00:00.000Z", generatedAt: "2026-10-16T10:00:00.000Z",
    matcherVersion: MATCHER_VERSION, taxonomyVersion: TAXONOMY_VERSION,
    explanationMode: "deterministic", explanationSource: "deterministic",
    recommendationInputFingerprint: "fp_test",
    reviewed: extra.reviewed ?? {},
    matcherInput: matcherRisk,
    matcherResult: result,
    activeAppetite: extra.activeAppetite ?? rules,
  });
}

function gaps(ev: RecommendationEvidenceV2, code: QualityGapCodeV2): QualityGapV2[] {
  return ev.quality.gaps.filter((item) => item.code === code);
}
function severities(ev: RecommendationEvidenceV2, code: QualityGapCodeV2): string[] {
  return gaps(ev, code).map((item) => item.severity);
}
function scoredOf(ev: RecommendationEvidenceV2, insurerId: string): ScoredInsurerOutcomeEvidenceV2 {
  const found = ev.insurers.find((item) => item.insurer_id === insurerId);
  assert(found && found.status === "scored", `${insurerId} scored`);
  return found;
}

const MULTI = risk({
  product_candidates: ["commercial motor", "goods in transit"],
  section_candidates: ["Commercial motor", "Goods in transit"],
});

// ---------------------------------------------------------------------------
// Roll-up
// ---------------------------------------------------------------------------

test("1. clean single-section recommendation with full provenance is decision_ready with no gaps", () => {
  const ev = evidence(risk(), [rule({ id: "a", appetite_level: "preferred", preferred_risks: ["transport fleet"] })]);
  eq(ev.quality.state, "decision_ready", "state");
  deepEq(ev.quality.gaps, [], "no gaps at all");
  eq(scoredOf(ev, "insurer-1").quality.state, "decision_ready", "insurer state");
  eq(ev.quality.model, "recommendation-quality-v1", "model version recorded");
});

test("2. roll-up: any blocker => incomplete; else any material => caution; else decision_ready", () => {
  const advisoryOnly = evidence(risk(), [rule({ id: "a", source_document_id: null })]);
  eq(advisoryOnly.quality.state, "decision_ready", "advisory only");
  assert(advisoryOnly.quality.advisory_count > 0 && advisoryOnly.quality.material_count === 0, "has advisory, no material");

  const material = evidence(risk(), [rule({ id: "a", source: "ai_extracted", source_document_id: null })]);
  eq(material.quality.state, "caution", "material");

  const blocker = evidence(MULTI, [
    rule({ id: "a-motor" }),
    rule({ id: "a-git", product_line: "goods_in_transit", risk_type: "cargo", appetite_level: "declined" }),
  ]);
  eq(blocker.quality.state, "incomplete", "blocker");
  eq(blocker.quality.blocker_count, 1, "one blocker");
});

// ---------------------------------------------------------------------------
// Table rows
// ---------------------------------------------------------------------------

test("T1. no appetite data for an insurer => advisory (scope note), does not weaken ranked insurers", () => {
  const ev = evidence(risk(), [rule({ id: "a" })], { noData: [{ insurer_id: "insurer-9", insurer_name: "No Data Mutual" }] });
  deepEq(severities(ev, "insurer_appetite_data_missing"), ["advisory"], "advisory");
  eq(ev.quality.state, "decision_ready", "ranking still decision_ready");
  const outcome = ev.insurers.find((item) => item.insurer_id === "insurer-9");
  assert(outcome && outcome.status === "no_appetite_data" && !("quality" in outcome), "no-data outcome has no per-insurer quality");
});

test("T2. rule source document missing: material only for an AI-extracted rule that drives the outcome", () => {
  const aiDecisive = evidence(risk(), [rule({ id: "a", source: "ai_extracted", source_document_id: null })]);
  deepEq(severities(aiDecisive, "rule_source_document_missing"), ["material"], "ai-extracted, decisive");

  const manualDecisive = evidence(risk(), [rule({ id: "a", source: "manual", source_document_id: null })]);
  deepEq(severities(manualDecisive, "rule_source_document_missing"), ["advisory"], "manual rule has no document by design");

  const aiNonDecisive = evidence(MULTI, [
    rule({ id: "a-motor", appetite_level: "preferred", preferred_risks: ["transport fleet"] }),
    rule({ id: "a-git", product_line: "goods_in_transit", risk_type: "cargo", source: "ai_extracted", source_document_id: null }),
  ]);
  deepEq(severities(aiNonDecisive, "rule_source_document_missing"), ["advisory"], "ai-extracted but neither scored nor adverse");
});

test("T3. source locator incomplete (document known, page/quote missing) => advisory, never a blocker", () => {
  const ev = evidence(risk(), [rule({ id: "a", source_page: null, source_quote: null })]);
  const found = gaps(ev, "rule_source_locator_incomplete");
  eq(found.length, 1, "one gap");
  eq(found[0].severity, "advisory", "advisory");
  deepEq(found[0].missing, ["source_page", "source_quote"], "exactly what is missing, sorted");
  eq(ev.quality.state, "decision_ready", "does not degrade reliance");
});

test("T4. unresolved matched-rule snapshot => blocker", () => {
  const rules = [rule({ id: "a" })];
  const ev = evidence(risk(), rules, { activeAppetite: [] });
  assert(severities(ev, "matched_rule_snapshot_missing").every((s) => s === "blocker") && gaps(ev, "matched_rule_snapshot_missing").length > 0, "blocker");
  eq(ev.quality.state, "incomplete", "incomplete");
  assert(scoredOf(ev, "insurer-1").unresolved_rule_ids.includes("a"), "unresolved id recorded");
});

test("T5. reviewed fact confidence unavailable => advisory", () => {
  const ev = evidence(risk(), [rule({ id: "a" })], {
    reviewed: { red_flags: [{ issue: "roof condition" }] },
  });
  const found = gaps(ev, "reviewed_fact_confidence_unavailable");
  assert(found.length > 0 && found.every((item) => item.severity === "advisory"), "advisory");
  eq(ev.quality.state, "decision_ready", "no effect on reliance");
});

test("T6. taxonomy match missing => material; if it is the RECOMMENDED insurer it is also a blocker", () => {
  const unmatched = risk({ product_candidates: ["cyber"], section_candidates: ["Cyber"], risk_candidates: ["technology"] });
  const ev = evidence(unmatched, [rule({ id: "a" })]);
  deepEq(severities(ev, "taxonomy_match_missing"), ["material"], "insurer-level material");
  deepEq(severities(ev, "recommended_insurer_unscored"), ["blocker"], "top pick has no deterministic basis");
  eq(ev.quality.state, "incomplete", "incomplete");

  // Same insurer as a lower option behind a properly scored recommendation: material only.
  const withBetter = evidence(unmatched, [
    rule({ id: "a" }),
    rule({ id: "b", insurer_id: "insurer-2", insurer_name: "Insurer Two", product_line: "cyber", risk_type: "technology", appetite_level: "preferred" }),
  ]);
  deepEq(severities(withBetter, "recommended_insurer_unscored"), [], "recommended insurer is scored");
  deepEq(severities(withBetter, "taxonomy_match_missing"), ["material"], "still material for the unmatched option");
  eq(withBetter.quality.state, "caution", "caution");
});

test("T7. scored rule matches the risk type only => material", () => {
  const ev = evidence(risk(), [rule({ id: "a", product_line: "cyber", risk_type: "transport" })]);
  deepEq(severities(ev, "scored_rule_product_unmatched"), ["material"], "material");
});

test("T8. requested section not evaluated: material for a viable insurer, advisory once ruled out", () => {
  const sections = risk({ product_candidates: ["commercial motor", "cyber"], section_candidates: ["Commercial motor", "Cyber"] });
  const viable = evidence(sections, [rule({ id: "a" })]);
  deepEq(severities(viable, "requested_section_not_evaluated"), ["material"], "viable");
  const ruledOut = evidence(
    risk({ ...sections, features: [{ text: "asbestos roof", source: "occupation/business description" }] }),
    [rule({ id: "a", declined_risks: ["asbestos"] })]
  );
  deepEq(severities(ruledOut, "requested_section_not_evaluated"), ["advisory"], "ruled out: cannot get worse");
});

test("T9. section hard decline not reflected in the score => blocker (viable) / advisory (already ruled out)", () => {
  const rules = [
    rule({ id: "a-motor", appetite_level: "preferred" }),
    rule({ id: "a-git", product_line: "goods_in_transit", risk_type: "cargo", appetite_level: "declined" }),
  ];
  const viable = evidence(MULTI, rules);
  deepEq(severities(viable, "section_hard_decline_not_reflected"), ["blocker"], "viable");
  eq(scoredOf(viable, "insurer-1").ruled_out, false, "and the v1 outcome is NOT changed by it");

  const ruledOut = evidence(
    risk({ ...MULTI, features: [{ text: "transport fleet", source: "primary risk type" }, { text: "war risk", source: "exclusions" }] }),
    [...rules, rule({ id: "pf", product_line: "*", risk_type: "*", declined_risks: ["war"] })]
  );
  eq(scoredOf(ruledOut, "insurer-1").ruled_out, true, "portfolio decline rules the insurer out");
  deepEq(severities(ruledOut, "section_hard_decline_not_reflected"), ["advisory"], "already ruled out");
});

test("T10. section referral / soft decline / caution not reflected => material; neutral section => advisory", () => {
  const feats = [
    { text: "transport fleet", source: "primary risk type" },
    { text: "cross border haulage", source: "endorsements" },
  ];
  const referral = evidence(risk({ ...MULTI, features: feats }), [
    rule({ id: "m" }),
    rule({ id: "g", product_line: "goods_in_transit", risk_type: "cargo", referral_triggers: ["cross border"] }),
  ]);
  deepEq(severities(referral, "section_referral_not_reflected"), ["material"], "referral");

  const soft = evidence(
    risk({ ...MULTI, features: [{ text: "transport fleet", source: "primary risk type" }, { text: "asbestos", source: "red flag", ai_inferred: true }] }),
    [rule({ id: "m" }), rule({ id: "g", product_line: "goods_in_transit", risk_type: "cargo", declined_risks: ["asbestos"] })]
  );
  deepEq(severities(soft, "section_soft_decline_not_reflected"), ["material"], "AI-inferred decline stays distinct from hard decline");
  deepEq(severities(soft, "section_hard_decline_not_reflected"), [], "and is never a hard decline");

  const caution = evidence(risk({ ...MULTI, features: feats }), [
    rule({ id: "m" }),
    rule({ id: "g", product_line: "goods_in_transit", risk_type: "cargo", caution_risks: ["cross border"] }),
  ]);
  deepEq(severities(caution, "section_caution_not_reflected"), ["material"], "caution");

  const neutral = evidence(MULTI, [
    rule({ id: "m" }),
    rule({ id: "g", product_line: "goods_in_transit", risk_type: "cargo", appetite_level: "standard" }),
  ]);
  deepEq(severities(neutral, "section_outcome_not_scored"), ["advisory"], "nothing adverse: aggregation limitation only");
  eq(neutral.quality.state, "decision_ready", "decision_ready");
});

test("T11. conflicting rules: tie that flips a hard decline => blocker; tie on a lesser difference => material", () => {
  const hard = evidence(MULTI, [
    rule({ id: "m", appetite_level: "preferred", risk_type: "transport" }),
    rule({ id: "g", product_line: "goods_in_transit", risk_type: "transport", appetite_level: "declined" }),
  ]);
  deepEq(severities(hard, "scored_rule_selection_tie"), ["blocker"], "scored rule chosen by identity among rules that disagree on a decline");

  const lesser = evidence(MULTI, [
    rule({ id: "m", appetite_level: "preferred", risk_type: "transport" }),
    rule({ id: "g", product_line: "goods_in_transit", risk_type: "transport", appetite_level: "caution" }),
  ]);
  deepEq(severities(lesser, "scored_rule_selection_tie"), ["material"], "level differs only");

  const agree = evidence(MULTI, [
    rule({ id: "m", risk_type: "transport" }),
    rule({ id: "g", product_line: "goods_in_transit", risk_type: "transport" }),
  ]);
  deepEq(severities(agree, "scored_rule_selection_tie"), [], "tied rules agree: no gap");

  const sectionTie = evidence(risk(), [
    rule({ id: "dup-1", appetite_level: "preferred" }),
    rule({ id: "dup-2", appetite_level: "declined" }),
  ]);
  deepEq(severities(sectionTie, "section_rule_conflict"), ["blocker"], "two rules for ONE section disagreeing on a decline");
});

test("T12. missing trusted required document => advisory per document; no trusted documents => material only if something is required", () => {
  const missing = evidence(risk({ available_documents: [] }), [rule({ id: "a", required_documents: ["Claims history", "Risk survey"] })]);
  deepEq(gaps(missing, "required_document_missing").map((item) => [item.severity, item.missing[0]]), [["advisory", "Claims history"], ["advisory", "Risk survey"]], "per document, advisory");
  deepEq(severities(missing, "no_trusted_documents"), ["material"], "nothing evidenced and something is required");
  eq(missing.quality.state, "caution", "caution");

  const noneRequired = evidence(risk({ available_documents: [] }), [rule({ id: "a" })]);
  deepEq(severities(noneRequired, "no_trusted_documents"), ["advisory"], "nothing required: scope note only");
  eq(noneRequired.quality.state, "decision_ready", "decision_ready");

  const partial = evidence(risk({ available_documents: ["Claims history"] }), [rule({ id: "a", required_documents: ["Claims history", "Risk survey"] })]);
  deepEq(severities(partial, "no_trusted_documents"), [], "some trusted evidence exists");
  deepEq(severities(partial, "required_document_missing"), ["advisory"], "one missing document, advisory");
});

test("T13. a document required by product AND portfolio rules is ONE gap (one canonical outcome)", () => {
  const ev = evidence(risk({ available_documents: [] }), [
    rule({ id: "a", required_documents: ["Claims history"] }),
    rule({ id: "pf", product_line: "*", risk_type: "*", required_documents: ["claims history"] }),
  ]);
  eq(gaps(ev, "required_document_missing").length, 1, "one gap");
  eq(scoredOf(ev, "insurer-1").required_documents.length, 1, "one canonical document outcome");
});

test("T14. no requested cover sections declared => advisory scope note", () => {
  const ev = evidence(risk({ section_candidates: [] }), [rule({ id: "a" })]);
  deepEq(severities(ev, "requested_sections_not_declared"), ["advisory"], "advisory");
});

test("T15. ruled-out insurers are not 'complete' evidence for the recommendation unless nothing is hidden", () => {
  const ev = evidence(
    risk({ features: [{ text: "asbestos", source: "occupation/business description" }] }),
    [rule({ id: "a", declined_risks: ["asbestos"] })]
  );
  eq(scoredOf(ev, "insurer-1").ruled_out, true, "ruled out");
  eq(ev.quality.state, "decision_ready", "a documented hard decline with full provenance needs no caveat");
});

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

test("P1. per-insurer quality uses only that insurer's gaps; the recommendation uses all of them", () => {
  const ev = evidence(MULTI, [
    rule({ id: "a-motor" }),
    rule({ id: "a-git", product_line: "goods_in_transit", risk_type: "cargo", appetite_level: "declined" }),
    rule({ id: "b-motor", insurer_id: "insurer-2", insurer_name: "Insurer Two" }),
    rule({ id: "b-git", insurer_id: "insurer-2", insurer_name: "Insurer Two", product_line: "goods_in_transit", risk_type: "cargo" }),
  ]);
  eq(scoredOf(ev, "insurer-1").quality.state, "incomplete", "insurer 1 has the hidden decline");
  eq(scoredOf(ev, "insurer-2").quality.state, "decision_ready", "insurer 2 is clean");
  eq(ev.quality.state, "incomplete", "the recommendation is as weak as its weakest presented insurer");
  for (const insurer of ev.insurers) {
    if (insurer.status !== "scored") continue;
    const ids = ev.quality.gaps.filter((g) => g.insurer_id === insurer.insurer_id).map((g) => g.gap_id);
    deepEq(insurer.quality.gap_ids, ids, "gap ids are the insurer's own gaps");
  }
});

test("P2. the quality gate never changes a score, rank, flag or ruling (presentation only)", () => {
  const rules = [
    rule({ id: "a-motor", appetite_level: "preferred", preferred_risks: ["transport fleet"] }),
    rule({ id: "a-git", product_line: "goods_in_transit", risk_type: "cargo", appetite_level: "declined" }),
  ];
  const result = matchInsurers(MULTI, rules);
  const ev = evidence(MULTI, rules);
  const outcome = scoredOf(ev, "insurer-1");
  const matcher = result.insurers[0];
  eq(outcome.score, matcher.score, "score");
  eq(outcome.rank, matcher.rank, "rank");
  eq(outcome.ruled_out, matcher.ruled_out, "ruled_out");
  eq(outcome.referral_required, matcher.referral_required, "referral");
  eq(ev.quality.state, "incomplete", "while the gate says incomplete, the matcher answer stands unchanged");
});

test("P3. gap order and ids are deterministic under rule permutation", () => {
  const rules = [
    rule({ id: "a-motor" }),
    rule({ id: "a-git", product_line: "goods_in_transit", risk_type: "cargo", appetite_level: "declined", source_page: null }),
    rule({ id: "b-motor", insurer_id: "insurer-2", insurer_name: "Insurer Two", source: "ai_extracted", source_document_id: null }),
  ];
  const first = JSON.stringify(evidence(MULTI, rules).quality);
  const second = JSON.stringify(evidence(MULTI, [...rules].reverse()).quality);
  eq(second, first, "identical quality block");
});

test("P4. blockers sort before material before advisory", () => {
  const ev = evidence(MULTI, [
    rule({ id: "a-motor", source_page: null }),
    rule({ id: "a-git", product_line: "goods_in_transit", risk_type: "cargo", appetite_level: "declined" }),
  ]);
  const order = ev.quality.gaps.map((g) => g.severity);
  const sorted = [...order].sort((x, y) => ["blocker", "material", "advisory"].indexOf(x) - ["blocker", "material", "advisory"].indexOf(y));
  deepEq(order, sorted, "severity order");
});

test("P5. every gap code the builder can emit is in the documented vocabulary", () => {
  const known: QualityGapCodeV2[] = [
    "rule_source_document_missing", "rule_source_locator_incomplete", "matched_rule_snapshot_missing",
    "matched_input_source_missing", "reviewed_fact_confidence_unavailable", "insurer_appetite_data_missing",
    "taxonomy_match_missing", "scored_rule_product_unmatched", "scored_rule_selection_tie",
    "requested_section_not_evaluated", "section_rule_conflict", "section_hard_decline_not_reflected",
    "section_soft_decline_not_reflected", "section_referral_not_reflected", "section_caution_not_reflected",
    "section_outcome_not_scored", "required_document_missing", "recommended_insurer_unscored",
    "requested_sections_not_declared", "no_trusted_documents",
  ];
  const ev = evidence(MULTI, [
    rule({ id: "a-motor", source_document_id: null, source: "ai_extracted" }),
    rule({ id: "a-git", product_line: "goods_in_transit", risk_type: "cargo", appetite_level: "declined" }),
  ], { noData: [{ insurer_id: "z", insurer_name: "Z" }] });
  for (const item of ev.quality.gaps) assert(known.includes(item.code), `unknown gap code ${item.code}`);
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
console.log(`\nPowerhouse quality gate: ${tests.length - failures} passed, ${failures} failed out of ${tests.length}`);
if (failures > 0) process.exitCode = 1;
