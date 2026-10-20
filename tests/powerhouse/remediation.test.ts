/**
 * Powerhouse Batch 2 remediation — R2, R3, R4, R5, R9.
 *
 *   R2  tied rules disagree whenever the choice could change the outcome or the
 *       evidence the underwriter relies on (and ONLY then)
 *   R3  considered rules carry their own required-document set
 *   R4  no declared sections + several implied products is never "decision ready"
 *   R5  a materially relevant risk-only rule is surfaced, not just counted
 *   R9  an unrelated clean document does not make required documents "evidenced"
 *
 * Every test is deterministic and network-free. None of them asserts a change to
 * a score, rank or flag: those are the matcher's and are proven unchanged by the
 * differential and the acceptance cases.
 */

import { MATCHER_VERSION, matchInsurers, type InsurerScore, type MatchInputRisk } from "../../worker/src/matcher.js";
import type { AppetiteRow } from "../../worker/src/matcher-types.js";
import {
  buildRecommendationEvidenceV2,
  canonicalDocumentLabels,
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
    id: "rule", insurer_id: "insurer-1", insurer_name: "Insurer One",
    product_line: "commercial_motor", risk_type: "transport", appetite_level: "standard",
    preferred_risks: [], caution_risks: [], declined_risks: [], required_documents: [], referral_triggers: [],
    notes: null, source: "manual", source_document_id: "doc-1", source_file_name: "guide.pdf",
    source_page: 3, source_section: "Motor", source_quote: "Quote.", is_active: true,
    ...overrides,
  };
}

function risk(overrides: Partial<MatchInputRisk> = {}): MatchInputRisk {
  return {
    product_candidates: ["commercial motor"],
    section_candidates: ["Commercial motor"],
    risk_candidates: ["transport"],
    features: [
      { text: "transport fleet", source: "primary risk type" },
      { text: "high value cargo", source: "endorsements" },
      { text: "cross border haulage", source: "occupation/business description" },
      { text: "asbestos exposure", source: "red flag", ai_inferred: true },
    ],
    available_documents: ["Claims history"],
    overall_confidence: 0.9,
    overall_confidence_available: true,
    ...overrides,
  };
}

function build(matcherRisk: MatchInputRisk, rules: AppetiteRow[], activeAppetite: AppetiteRow[] = rules) {
  const result = matchInsurers(matcherRisk, rules);
  const evidence = buildRecommendationEvidenceV2({
    recommendationId: "rec", submissionId: "sub", extractionId: "ext",
    reviewedAt: "2026-10-16T09:00:00.000Z", generatedAt: "2026-10-16T10:00:00.000Z",
    matcherVersion: MATCHER_VERSION, taxonomyVersion: TAXONOMY_VERSION,
    explanationMode: "deterministic", explanationSource: "deterministic",
    recommendationInputFingerprint: "fp_test", reviewed: {}, matcherInput: matcherRisk,
    matcherResult: result, activeAppetite,
  });
  return { result, evidence };
}

const codes = (ev: RecommendationEvidenceV2, code: QualityGapCodeV2): QualityGapV2[] => ev.quality.gaps.filter((g) => g.code === code);
const severities = (ev: RecommendationEvidenceV2, code: QualityGapCodeV2) => codes(ev, code).map((g) => g.severity);
const scored = (ev: RecommendationEvidenceV2, id = "insurer-1"): ScoredInsurerOutcomeEvidenceV2 => {
  const found = ev.insurers.find((item) => item.insurer_id === id);
  assert(found && found.status === "scored", `${id} scored`);
  return found;
};
const insurerOf = (result: { insurers: InsurerScore[] }, id = "insurer-1") => result.insurers.find((i) => i.insurer_id === id)!;

// Two rules for the SAME product and risk type: equal taxonomy quality, so they tie.
const tie = (a: Partial<AppetiteRow>, b: Partial<AppetiteRow>) => [rule({ id: "t1", ...a }), rule({ id: "t2", ...b })];

// ---------------------------------------------------------------------------
// R2 — tie profile
// ---------------------------------------------------------------------------

test("R2-1. identical (outcome-equivalent) ties raise no disagreement and no quality gap", () => {
  const { result, evidence } = build(risk(), tie({}, {}));
  const insurer = insurerOf(result);
  eq(insurer.selection!.basis, "tie_broken_by_canonical_order", "it is a tie");
  eq(insurer.selection!.tied_rules_disagree, false, "equivalent");
  deepEq(insurer.selection!.tie_differences, [], "no differences");
  deepEq(codes(evidence, "scored_rule_selection_tie"), [], "no selection-tie gap");
  deepEq(codes(evidence, "section_rule_conflict"), [], "no section-conflict gap");
  eq(evidence.quality.state, "decision_ready", "decision_ready");
});

test("R2-2. a different PREFERRED hit count (different score) is a material disagreement", () => {
  const { result, evidence } = build(risk(), tie({ preferred_risks: ["transport fleet"] }, { preferred_risks: ["transport fleet", "high value"] }));
  const insurer = insurerOf(result);
  assert(insurer.selection!.tie_differences.includes("preferred_terms"), "preferred terms differ");
  deepEq(severities(evidence, "scored_rule_selection_tie"), ["material"], "insurer-level tie");
  deepEq(severities(evidence, "section_rule_conflict"), ["material"], "section-level tie");
  eq(evidence.quality.state, "caution", "caution — it no longer reads decision_ready");
  eq(insurer.score, 75, "the legacy score is the canonical-first rule's, unchanged");
});

test("R2-3. a different CAUTION term with the same count is a material disagreement", () => {
  const { result, evidence } = build(risk(), tie({ caution_risks: ["high value"] }, { caution_risks: ["cross border"] }));
  assert(insurerOf(result).selection!.tie_differences.includes("caution_terms"), "caution terms differ");
  deepEq(severities(evidence, "scored_rule_selection_tie"), ["material"], "material");
});

test("R2-3b. a different caution COUNT is a material disagreement", () => {
  const { result } = build(risk(), tie({ caution_risks: ["high value"] }, { caution_risks: ["high value", "cross border"] }));
  assert(insurerOf(result).selection!.tie_differences.includes("caution_terms"), "caution count differs");
});

test("R2-4. referral vs standard is a material disagreement", () => {
  const { result, evidence } = build(risk(), tie({}, { referral_triggers: ["cross border"] }));
  assert(insurerOf(result).selection!.tie_differences.includes("referral_terms"), "referral differs");
  deepEq(severities(evidence, "scored_rule_selection_tie"), ["material"], "material");
});

test("R2-5. soft (AI-inferred) decline vs standard is a material disagreement, never a blocker", () => {
  const { result, evidence } = build(risk(), tie({}, { declined_risks: ["asbestos"] }));
  const diffs = insurerOf(result).selection!.tie_differences;
  assert(diffs.includes("soft_decline") && !diffs.includes("hard_decline"), "soft only");
  deepEq(severities(evidence, "scored_rule_selection_tie"), ["material"], "material, not blocker");
});

test("R2-6. hard decline vs viable is a BLOCKER (the choice can rule the insurer out)", () => {
  const { result, evidence } = build(risk(), tie({}, { appetite_level: "declined" }));
  const diffs = insurerOf(result).selection!.tie_differences;
  assert(diffs.includes("hard_decline") && diffs.includes("appetite_level"), "hard decline + level differ");
  deepEq(severities(evidence, "scored_rule_selection_tie"), ["blocker"], "blocker");
  eq(evidence.quality.state, "incomplete", "incomplete");
  eq(insurerOf(result).ruled_out, false, "canonical-first (viable) rule is still the scored one: v1 outcome unchanged");
});

test("R2-6b. a document-derived declined term vs viable is also a blocker", () => {
  const { evidence } = build(risk({ features: [{ text: "asbestos roof", source: "occupation/business description" }] }), tie({}, { declined_risks: ["asbestos"] }));
  deepEq(severities(evidence, "scored_rule_selection_tie"), ["blocker"], "blocker");
});

test("R2-7. different REQUIRED DOCUMENTS is a material disagreement", () => {
  const { result, evidence } = build(risk(), tie({ required_documents: ["Claims history"] }, { required_documents: ["Risk survey"] }));
  deepEq(insurerOf(result).selection!.tie_differences, ["required_documents"], "only the documents differ");
  deepEq(severities(evidence, "scored_rule_selection_tie"), ["material"], "material");
  eq(evidence.quality.state, "caution", "caution");
});

test("R2-8. equivalent document sets in a different order / case / separator are NOT a disagreement", () => {
  const { result, evidence } = build(
    risk(),
    tie({ required_documents: ["Claims history", "Risk survey"] }, { required_documents: ["risk_survey", "CLAIMS HISTORY", "claims-history"] })
  );
  deepEq(insurerOf(result).selection!.tie_differences, [], "equivalent");
  deepEq(codes(evidence, "scored_rule_selection_tie"), [], "no gap");
});

test("R2-9. irrelevant metadata (notes, source, ids, product spelling) never manufactures a disagreement", () => {
  const { result } = build(
    risk(),
    tie(
      { notes: "alpha", source: "manual", source_document_id: "d1", source_file_name: "a.pdf", source_page: 1, rating_notes: "x" },
      { notes: "beta", source: "ai_extracted", source_document_id: null, source_file_name: null, source_page: null, rating_notes: "y" }
    )
  );
  eq(insurerOf(result).selection!.tied_rules_disagree, false, "metadata is not outcome-relevant");
});

test("R2-10. the technical tie-break is unchanged: canonical-first rule is scored, and a disagreement never changes the score", () => {
  const rules = tie({}, { preferred_risks: ["transport fleet", "high value"] });
  const a = insurerOf(matchInsurers(risk(), rules));
  const b = insurerOf(matchInsurers(risk(), [...rules].reverse()));
  eq(a.scored_against_appetite_id, "t1", "t1 sorts first");
  eq(b.scored_against_appetite_id, "t1", "row order irrelevant");
  eq(a.score, 70, "score is the scored rule's alone");
});

// ---------------------------------------------------------------------------
// R3 — considered rules carry their own required documents
// ---------------------------------------------------------------------------

test("R3-1. each considered rule carries ITS OWN required documents (the losing tied rule keeps its set)", () => {
  const { evidence } = build(risk(), tie({ required_documents: ["Claims history"] }, { required_documents: ["Risk survey", "Policy schedule"] }));
  const outcome = scored(evidence);
  const byId = new Map(outcome.considered_rules.map((r) => [r.rule_id, r]));
  deepEq(byId.get("t1")!.required_documents, ["Claims history"], "winner");
  deepEq(byId.get("t2")!.required_documents, ["Policy schedule", "Risk survey"], "loser keeps its own set, sorted");
});

test("R3-2. required documents are de-duplicated and sorted deterministically, whatever the rule's array order", () => {
  const a = build(risk(), [rule({ id: "t1", required_documents: ["Risk survey", "claims history", "Claims history", "RISK_SURVEY"] })]).evidence;
  const b = build(risk(), [rule({ id: "t1", required_documents: ["RISK_SURVEY", "Claims history", "claims history", "Risk survey"] })]).evidence;
  deepEq(scored(a).considered_rules[0].required_documents, ["Claims history", "RISK_SURVEY"], "de-duplicated by canonical key; the code-unit-smallest spelling is kept");
  deepEq(scored(a).considered_rules[0].required_documents, scored(b).considered_rules[0].required_documents, "order independent");
  deepEq(canonicalDocumentLabels(["b", "A", "a", "B"]), ["A", "B"], "helper: smallest spelling per key");
});

test("R3-3. an unresolved rule snapshot yields null — documents are never inferred from another rule", () => {
  const rules = tie({ required_documents: ["Claims history"] }, { required_documents: ["Risk survey"] });
  const { evidence } = build(risk(), rules, [rules[0]]);
  const byId = new Map(scored(evidence).considered_rules.map((r) => [r.rule_id, r]));
  deepEq(byId.get("t1")!.required_documents, ["Claims history"], "resolved");
  eq(byId.get("t2")!.required_documents, null, "unresolved -> null, not t1's documents");
  eq(byId.get("t2")!.snapshot_resolved, false, "flagged unresolved");
});

test("R3-4. matcher penalty semantics are untouched: only the scored rule's missing documents cost confidence", () => {
  const { result } = build(risk({ available_documents: [] }), tie({ required_documents: ["Claims history"] }, { required_documents: ["Risk survey", "Policy schedule"] }));
  const insurer = insurerOf(result);
  deepEq(insurer.missing_required_documents, ["Claims history"], "the loser's documents are not required");
  eq(Math.round(insurer.confidence * 100) / 100, 0.8, "one missing document, one 0.10 penalty");
});

// ---------------------------------------------------------------------------
// R5 — materially relevant risk-only rules are surfaced
// ---------------------------------------------------------------------------

const motor = () => rule({ id: "motor", product_line: "commercial_motor", risk_type: "transport", appetite_level: "preferred" });
const riskOnly = (over: Partial<AppetiteRow>) => rule({ id: "ro", product_line: "cyber", risk_type: "transport", ...over });

test("R5-1. a rule that matches neither the product nor the risk type is omitted and not even counted", () => {
  const { result } = build(risk(), [motor(), rule({ id: "irrelevant", product_line: "cyber", risk_type: "technology", appetite_level: "declined" })]);
  const sel = insurerOf(result).selection!;
  eq(sel.matching_rule_count, 1, "not a matching rule");
  deepEq(insurerOf(result).considered_rules!.map((r) => r.rule_id), ["motor"], "not listed");
});

test("R5-2. an ordinary non-material risk-only loser stays COUNT-ONLY", () => {
  const { result } = build(risk(), [motor(), riskOnly({ appetite_level: "standard" })]);
  deepEq(insurerOf(result).considered_rules!.map((r) => r.rule_id), ["motor"], "not listed");
  eq(insurerOf(result).selection!.omitted_risk_only_rule_count, 1, "counted");
});

test("R5-3. a risk-only rule that fired a CAUTION term is surfaced", () => {
  const { result, evidence } = build(risk(), [motor(), riskOnly({ caution_risks: ["high value"] })]);
  const listed = insurerOf(result).considered_rules!.find((r) => r.rule_id === "ro");
  assert(listed, "surfaced");
  eq(listed.listed_because, "material_risk_only", "why it is listed");
  deepEq(listed.conditions.map((c) => c.kind), ["caution"], "its condition");
  eq(insurerOf(result).selection!.omitted_risk_only_rule_count, 0, "no longer count-only");
  eq(scored(evidence).considered_rules.find((r) => r.rule_id === "ro")!.listed_because, "material_risk_only", "carried into evidence");
});

test("R5-4. a risk-only rule with a REFERRAL, SOFT DECLINE or HARD DECLINE (level or term) is surfaced", () => {
  const cases: [string, Partial<AppetiteRow>, string][] = [
    ["referral", { referral_triggers: ["cross border"] }, "referral"],
    ["soft decline", { declined_risks: ["asbestos"] }, "soft_decline_referral"],
    ["hard decline (level)", { appetite_level: "declined" }, "hard_decline"],
  ];
  for (const [label, over, kind] of cases) {
    const { result } = build(risk(), [motor(), riskOnly(over)]);
    const listed = insurerOf(result).considered_rules!.find((r) => r.rule_id === "ro");
    assert(listed, `${label} surfaced`);
    assert(listed.conditions.some((c) => c.kind === kind), `${label}: condition ${kind}`);
  }
  const hard = build(risk({ features: [{ text: "asbestos roof", source: "occupation/business description" }] }), [motor(), riskOnly({ declined_risks: ["asbestos"] })]);
  assert(insurerOf(hard.result).considered_rules!.find((r) => r.rule_id === "ro")!.conditions.some((c) => c.kind === "hard_decline"), "hard decline (term) surfaced");
});

test("R5-5. a risk-only rule with a materially DIFFERENT required-document set is surfaced; the SAME set is not", () => {
  const different = build(risk(), [rule({ ...motor(), required_documents: ["Claims history"] }), riskOnly({ required_documents: ["Risk survey"] })]);
  eq(insurerOf(different.result).considered_rules!.find((r) => r.rule_id === "ro")?.listed_because, "material_risk_only", "different documents surfaced");
  const same = build(risk(), [rule({ ...motor(), required_documents: ["Claims history"] }), riskOnly({ required_documents: ["claims_history"] })]);
  eq(insurerOf(same.result).considered_rules!.find((r) => r.rule_id === "ro"), undefined, "equivalent documents stay count-only");
});

test("R5-6. surfacing never changes the matcher's authoritative answer", () => {
  const without = insurerOf(matchInsurers(risk(), [motor(), riskOnly({ appetite_level: "standard" })]));
  const withMaterial = insurerOf(matchInsurers(risk(), [motor(), riskOnly({ appetite_level: "declined" })]));
  for (const key of ["score", "band", "rule_status", "ruled_out", "referral_required", "scored_against_appetite_id"] as const) {
    eq(withMaterial[key], without[key], `${key} unchanged by a surfaced risk-only rule`);
  }
});

test("R5-7. ordering of considered rules is deterministic under any permutation", () => {
  const rules = [
    motor(),
    riskOnly({ id: "ro-b", caution_risks: ["high value"] }),
    riskOnly({ id: "ro-a", referral_triggers: ["cross border"], product_line: "marine" }),
    riskOnly({ id: "ro-c", appetite_level: "standard" }),
  ];
  const expected = JSON.stringify(insurerOf(matchInsurers(risk(), rules)).considered_rules);
  for (const order of [[...rules].reverse(), [rules[2], rules[0], rules[3], rules[1]], [rules[3], rules[2], rules[1], rules[0]]]) {
    eq(JSON.stringify(insurerOf(matchInsurers(risk(), order)).considered_rules), expected, "identical listing");
  }
  deepEq(insurerOf(matchInsurers(risk(), rules)).considered_rules!.map((r) => r.rule_id), ["motor", "ro-b", "ro-a"], "scored first, then canonical order; the plain loser is count-only");
});

// ---------------------------------------------------------------------------
// R4 — multi-product, no declared sections
// ---------------------------------------------------------------------------

const multiProduct = (over: Partial<MatchInputRisk> = {}) =>
  risk({ product_candidates: ["commercial motor", "goods in transit"], section_candidates: [], ...over });
const gitRule = (over: Partial<AppetiteRow>) => rule({ id: "git", product_line: "goods_in_transit", risk_type: "cargo", ...over });

test("R4-1. no declared sections + two implied products is MATERIAL (caution) even with nothing adverse", () => {
  const { evidence } = build(multiProduct(), [motor(), gitRule({ appetite_level: "standard" })]);
  deepEq(evidence.requested_sections, [], "NO requested section is invented");
  deepEq(scored(evidence).section_evaluations, [], "no section evaluations either");
  eq(scored(evidence).implied_product_evaluations.length, 2, "two implied products evaluated");
  deepEq(severities(evidence, "multiple_products_without_declared_sections"), ["material"], "material");
  eq(evidence.quality.state, "caution", "overall caution");
});

test("R4-2. a hard decline in an implied product the legacy score does not reflect is a BLOCKER — but the insurer is not declined", () => {
  const { result, evidence } = build(multiProduct(), [motor(), gitRule({ appetite_level: "declined" })]);
  const insurer = insurerOf(result);
  eq(insurer.score, 100, "legacy score unchanged");
  eq(insurer.ruled_out, false, "NOT declined merely because sections were not declared");
  deepEq(severities(evidence, "implied_product_hard_decline_not_reflected"), ["blocker"], "blocker");
  eq(evidence.quality.state, "incomplete", "incomplete");
});

test("R4-3. referral / soft decline / caution in an implied product are material", () => {
  const cases: [QualityGapCodeV2, Partial<AppetiteRow>][] = [
    ["implied_product_referral_not_reflected", { referral_triggers: ["cross border"] }],
    ["implied_product_soft_decline_not_reflected", { declined_risks: ["asbestos"] }],
    ["implied_product_caution_not_reflected", { caution_risks: ["high value"] }],
  ];
  for (const [code, over] of cases) {
    const { evidence } = build(multiProduct(), [motor(), gitRule(over)]);
    deepEq(severities(evidence, code), ["material"], code);
  }
});

test("R4-4. the hidden-decline blocker downgrades to advisory once the insurer is already ruled out", () => {
  const { evidence } = build(
    multiProduct({ features: [{ text: "transport fleet", source: "primary risk type" }, { text: "war risk", source: "exclusions" }] }),
    [motor(), gitRule({ appetite_level: "declined" }), rule({ id: "pf", product_line: "*", risk_type: "*", declined_risks: ["war"] })]
  );
  eq(scored(evidence).ruled_out, true, "portfolio decline rules the insurer out");
  deepEq(severities(evidence, "implied_product_hard_decline_not_reflected"), ["advisory"], "cannot get worse");
  deepEq(severities(evidence, "multiple_products_without_declared_sections"), ["advisory"], "advisory when ruled out");
});

test("R4-5. a SINGLE implied product with no declared sections raises nothing new (single-product submissions stay decision_ready)", () => {
  const { evidence } = build(risk({ section_candidates: [] }), [motor()]);
  deepEq(codes(evidence, "multiple_products_without_declared_sections"), [], "no multi-product gap");
  deepEq(scored(evidence).implied_product_evaluations, [], "no implied evaluation for one product");
  eq(evidence.quality.state, "decision_ready", "decision_ready (the advisory scope note remains)");
  deepEq(severities(evidence, "requested_sections_not_declared"), ["advisory"], "scope note kept");
});

test("R4-6. when sections ARE declared, implied products are not produced (the requested-section model applies)", () => {
  const { evidence } = build(risk({ product_candidates: ["commercial motor", "goods in transit"], section_candidates: ["Commercial motor", "Goods in transit"] }), [motor(), gitRule({ appetite_level: "standard" })]);
  deepEq(scored(evidence).implied_product_evaluations, [], "none");
  deepEq(codes(evidence, "multiple_products_without_declared_sections"), [], "no gap");
});

test("R4-7. implied evaluations never alter any matcher answer", () => {
  const base = insurerOf(matchInsurers(multiProduct(), [motor(), gitRule({ appetite_level: "standard" })]));
  const adverse = insurerOf(matchInsurers(multiProduct(), [motor(), gitRule({ appetite_level: "declined" })]));
  for (const key of ["score", "band", "rule_status", "ruled_out", "referral_required", "manual_review_required", "senior_review_required", "scored_against_appetite_id"] as const) {
    eq(adverse[key], base[key], key);
  }
});

test("R4-8. tied rules that disagree inside one implied product are flagged", () => {
  const { evidence } = build(multiProduct(), [
    motor(),
    gitRule({ id: "git-1", appetite_level: "standard" }),
    gitRule({ id: "git-2", appetite_level: "declined" }),
  ]);
  deepEq(severities(evidence, "implied_product_rule_conflict"), ["blocker"], "decline vs viable inside one product");
});

// ---------------------------------------------------------------------------
// R9 — relevant trusted evidence
// ---------------------------------------------------------------------------

const withDocs = (available: string[], required: string[]) =>
  build(risk({ available_documents: available }), [rule({ id: "a", appetite_level: "preferred", required_documents: required })]).evidence;

test("R9-1. NO clean documents + required documents: both the wholly-absent and the unevidenced signals fire (material)", () => {
  const ev = withDocs([], ["Claims history"]);
  deepEq(severities(ev, "no_trusted_documents"), ["material"], "no trusted documents");
  deepEq(severities(ev, "required_documents_unevidenced"), ["material"], "unevidenced");
  eq(ev.quality.state, "caution", "caution");
});

test("R9-2. an UNRELATED clean document does not make required documents evidenced (the old cliff)", () => {
  const ev = withDocs(["Policy schedule"], ["Claims history"]);
  deepEq(codes(ev, "no_trusted_documents"), [], "trusted evidence is not wholly absent…");
  deepEq(severities(ev, "required_documents_unevidenced"), ["material"], "…but nothing the insurer requires is evidenced");
  eq(ev.quality.state, "caution", "NOT more reliance-ready than having no documents");
});

test("R9-3. a required document that IS trusted raises no document gap at all", () => {
  const ev = withDocs(["Claims history"], ["Claims history"]);
  deepEq(codes(ev, "required_documents_unevidenced"), [], "evidenced");
  deepEq(codes(ev, "required_document_missing"), [], "nothing missing");
  eq(ev.quality.state, "decision_ready", "decision_ready");
});

test("R9-4. MIX: some required documents present => per-document advisories only; none present => material, per insurer", () => {
  const rules = [
    rule({ id: "a", appetite_level: "preferred", required_documents: ["Claims history", "Risk survey"] }),
    rule({ id: "b", insurer_id: "insurer-2", insurer_name: "Insurer Two", required_documents: ["Policy schedule"] }),
  ];
  const ev = build(risk({ available_documents: ["Claims history", "Broker mandate"] }), rules).evidence;
  const unevidenced = codes(ev, "required_documents_unevidenced");
  deepEq(unevidenced.map((g) => g.insurer_id), ["insurer-2"], "only the insurer with NO required document evidenced");
  const missingForOne = ev.quality.gaps.filter((g) => g.code === "required_document_missing" && g.insurer_id === "insurer-1");
  deepEq(missingForOne.map((g) => [g.severity, g.missing[0]]), [["advisory", "Risk survey"]], "partial evidence stays advisory");
  eq(scored(ev, "insurer-1").quality.state, "decision_ready", "insurer 1 (partially evidenced) is decision ready");
  eq(scored(ev, "insurer-2").quality.state, "caution", "insurer 2 is not");
});

test("R9-5. confidence and trust semantics are untouched (quality classification only)", () => {
  const { result } = build(risk({ available_documents: ["Policy schedule"] }), [rule({ id: "a", appetite_level: "preferred", required_documents: ["Claims history"] })]);
  const insurer = insurerOf(result);
  eq(Math.round(insurer.confidence * 100) / 100, 0.8, "still -0.10 for the missing document");
  eq(insurer.score, 100, "score unchanged");
});

test("R9-6. a ruled-out insurer's requirements are not assessed (documents are not checked for it)", () => {
  const ev = build(risk({ available_documents: [], features: [{ text: "asbestos roof", source: "occupation/business description" }] }), [rule({ id: "a", declined_risks: ["asbestos"], required_documents: ["Claims history"] })]).evidence;
  eq(scored(ev).ruled_out, true, "ruled out");
  deepEq(codes(ev, "required_documents_unevidenced"), [], "no gap for a ruled-out insurer");
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
console.log(`\nPowerhouse remediation (R2/R3/R4/R5/R9): ${tests.length - failures} passed, ${failures} failed out of ${tests.length}`);
if (failures > 0) process.exitCode = 1;
