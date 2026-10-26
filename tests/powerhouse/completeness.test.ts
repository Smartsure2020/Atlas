/**
 * Powerhouse Phase 3 — deterministic completeness, and its linkage to the quality
 * gate. Inputs are REAL matcher outputs (matchInsurers → evidence base), so the
 * required-document outcomes, section evaluations and selections that completeness
 * restates are the authoritative ones, not hand-built look-alikes.
 */

import { matchInsurers, type MatchInputRisk } from "../../worker/src/matcher.js";
import type { AppetiteRow } from "../../worker/src/matcher-types.js";
import {
  COMPLETENESS_MODEL_VERSION,
  REQUIREMENT_BASIS,
  assessCompleteness,
  readExtractionReportedMissing,
  schemaFieldLabel,
  type CompletenessAnalysis,
} from "../../worker/src/completeness.js";
import {
  buildEvidenceBaseV2,
  buildRecommendationEvidenceV2,
  type BuildEvidenceV2Input,
} from "../../worker/src/recommendation-evidence-v2.js";
import {
  buildRecommendationEvidenceV3,
  type RecommendationEvidenceV3,
} from "../../worker/src/recommendation-evidence-v3.js";
import { TAXONOMY_VERSION } from "../../worker/src/taxonomy.js";
import { MATCHER_VERSION } from "../../worker/src/matcher.js";
import { clone } from "./fixture-loader.js";

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

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function rule(overrides: Partial<AppetiteRow>): AppetiteRow {
  return {
    id: "rule", insurer_id: "insurer-1", insurer_name: "Insurer One", product_line: "commercial_motor",
    risk_type: "transport", appetite_level: "standard", preferred_risks: [], caution_risks: [], declined_risks: [],
    required_documents: [], referral_triggers: [], notes: null, source: "manual", source_document_id: "doc-1",
    source_file_name: "guide.pdf", source_page: 3, source_section: "Motor", source_quote: "Quote.", is_active: true,
    ...overrides,
  };
}

function risk(overrides: Partial<MatchInputRisk> = {}): MatchInputRisk {
  return {
    product_candidates: ["commercial motor"], section_candidates: ["Commercial motor"], risk_candidates: ["transport"],
    features: [{ text: "transport fleet", source: "primary risk type" }],
    available_documents: ["Claims history"], overall_confidence: 0.9, overall_confidence_available: true,
    ...overrides,
  };
}

const common = {
  recommendationId: "rec", submissionId: "sub", extractionId: "ext", reviewedAt: "2026-10-16T09:00:00.000Z",
  generatedAt: "2026-10-16T10:00:00.000Z", matcherVersion: MATCHER_VERSION, taxonomyVersion: TAXONOMY_VERSION,
  explanationMode: "deterministic", explanationSource: "deterministic", recommendationInputFingerprint: "fp_test",
};

function input(
  riskInput: MatchInputRisk,
  rules: AppetiteRow[],
  noData: { insurer_id: string; insurer_name: string }[] = [],
  reviewed: Record<string, unknown> = {}
): BuildEvidenceV2Input {
  const result = matchInsurers(clone(riskInput), clone(rules));
  result.no_data_for = noData;
  return { ...common, reviewed, matcherInput: clone(riskInput), matcherResult: result, activeAppetite: clone(rules) };
}

const NO_OBSERVATIONS = { observations: [], unavailable_sources: [] };

function completeness(riskInput: MatchInputRisk, rules: AppetiteRow[], noData: { insurer_id: string; insurer_name: string }[] = [], reviewed: Record<string, unknown> = {}): CompletenessAnalysis {
  const base = buildEvidenceBaseV2(input(riskInput, rules, noData, reviewed));
  return assessCompleteness({
    requestedSections: base.requested_sections,
    insurers: [...base.scored, ...base.noData],
    reported: readExtractionReportedMissing(reviewed),
  });
}

const v3 = (riskInput: MatchInputRisk, rules: AppetiteRow[], noData: { insurer_id: string; insurer_name: string }[] = [], reviewed: Record<string, unknown> = {}): RecommendationEvidenceV3 =>
  buildRecommendationEvidenceV3({ ...input(riskInput, rules, noData, reviewed), observations: NO_OBSERVATIONS });

const ids = (analysis: CompletenessAnalysis) => analysis.items.map((item) => item.item_id);

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

test("1. a complete case has no items and every insurer is complete", () => {
  const analysis = completeness(risk(), [rule({ id: "a", required_documents: ["Claims history"] }), rule({ id: "b", insurer_id: "insurer-2", insurer_name: "Two" })]);
  eq(analysis.state, "complete", "state");
  deepEq(analysis.items, [], "no items");
  deepEq(analysis.insurers.map((i) => i.state), ["complete", "complete"], "per insurer");
  eq(analysis.model, COMPLETENESS_MODEL_VERSION, "model recorded");
});

test("2. a required document that IS trusted is not a gap", () => {
  eq(completeness(risk(), [rule({ required_documents: ["Claims history"] })]).items.length, 0, "present");
  eq(completeness(risk({ available_documents: ["claims_history"] }), [rule({ required_documents: ["Claims History"] })]).items.length, 0, "matcher's own presence test decides (case + separators)");
});

test("3. an UNRELATED clean document never satisfies a requirement", () => {
  const analysis = completeness(risk({ available_documents: ["Policy schedule", "Financial statements"] }), [rule({ required_documents: ["Risk survey"] })]);
  eq(analysis.items.length, 1, "still missing");
  eq(analysis.items[0].document_key, "risk survey", "the requirement");
  eq(analysis.items[0].materiality, "material", "and nothing it requires is evidenced");
});

test("4. ONE canonical document per logical document: spellings, insurers and rules fold into one item that keeps every rule", () => {
  const rules = [
    rule({ id: "a-motor", insurer_id: "insurer-a", insurer_name: "A", required_documents: ["Risk survey", "Claims history"] }),
    rule({ id: "a-portfolio", insurer_id: "insurer-a", insurer_name: "A", product_line: "*", risk_type: "*", required_documents: ["RISK SURVEY"] }),
    rule({ id: "b-motor", insurer_id: "insurer-b", insurer_name: "B", required_documents: ["risk-survey"] }),
    rule({ id: "c-motor", insurer_id: "insurer-c", insurer_name: "C", required_documents: ["Risk  Survey"] }),
  ];
  const analysis = completeness(risk(), rules);
  const docs = analysis.items.filter((i) => i.code === "required_document_missing");
  eq(docs.length, 1, "one logical document");
  const [doc] = docs;
  deepEq(doc.insurer_ids, ["insurer-a", "insurer-b", "insurer-c"], "insurer scope kept");
  deepEq(doc.rule_ids, ["a-motor", "a-portfolio", "b-motor", "c-motor"], "every requiring rule kept");
  deepEq(doc.required_by.map((r) => [r.insurer_id, r.rule_id, r.rule_scope, r.present]), [
    ["insurer-a", "a-motor", "product", false],
    ["insurer-a", "a-portfolio", "portfolio", false],
    ["insurer-b", "b-motor", "product", false],
    ["insurer-c", "c-motor", "product", false],
  ], "scope and presence per rule");
  eq(doc.trust_basis, "active_exact_clean", "trust basis stated");
  eq(doc.scope, "document", "scope");
  eq(doc.affects, "insurer", "effect: it lowers an insurer's confidence");
  assert(doc.document_type === "RISK SURVEY" || doc.document_type === "Risk  Survey" || doc.document_type === "Risk survey" || doc.document_type === "risk-survey", "label is one of the spellings seen");
});

test("5. no double counting: a document required by a product AND a portfolio rule of one insurer is one item with two references", () => {
  const analysis = completeness(risk(), [
    rule({ id: "p", required_documents: ["Risk survey"] }),
    rule({ id: "port", product_line: "*", risk_type: "*", required_documents: ["risk survey"] }),
  ]);
  eq(analysis.items.length, 1, "one item");
  eq(analysis.items[0].required_by.length, 2, "two references");
  eq(analysis.material_count + analysis.nonblocking_count, 1, "counted once");
});

test("6. materiality mirrors the existing quality classification: partly evidenced is nonblocking, wholly unevidenced is material", () => {
  const partly = completeness(risk(), [rule({ required_documents: ["Claims history", "Risk survey"] })]);
  eq(partly.items[0].materiality, "nonblocking", "one of two present");
  eq(partly.state, "incomplete_nonblocking", "state");
  const wholly = completeness(risk(), [rule({ required_documents: ["Risk survey", "Financial statements"] })]);
  assert(wholly.items.every((i) => i.materiality === "material"), "none present");
  eq(wholly.state, "incomplete_material", "state");
});

test("7. materiality is decided per insurer and rolled up: the same document is nonblocking for one insurer and material for another", () => {
  const analysis = completeness(risk(), [
    rule({ id: "a", insurer_id: "insurer-a", insurer_name: "A", required_documents: ["Claims history", "Risk survey"] }),
    rule({ id: "b", insurer_id: "insurer-b", insurer_name: "B", required_documents: ["Risk survey"] }),
  ]);
  eq(analysis.items.length, 1, "one logical document");
  eq(analysis.items[0].materiality, "material", "worst insurer decides the item");
  deepEq(analysis.insurers.map((i) => [i.insurer_id, i.state]), [["insurer-a", "incomplete_nonblocking"], ["insurer-b", "incomplete_material"]], "but each insurer keeps its own state");
});

test("8. a ruled-out insurer's documents are not assessed (the matcher skips them)", () => {
  const analysis = completeness(risk(), [
    rule({ id: "a", insurer_id: "insurer-a", insurer_name: "A", appetite_level: "declined", required_documents: ["Risk survey"] }),
    rule({ id: "b", insurer_id: "insurer-b", insurer_name: "B" }),
  ]);
  eq(analysis.items.filter((i) => i.code === "required_document_missing").length, 0, "no document item for a ruled-out insurer");
});

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

test("9. a requested section with no applicable rule: material for a viable insurer, nonblocking once ruled out", () => {
  const riskInput = risk({ section_candidates: ["Commercial motor", "Cyber"], product_candidates: ["commercial motor", "cyber"] });
  const analysis = completeness(riskInput, [
    rule({ id: "a", insurer_id: "insurer-a", insurer_name: "A" }),
    rule({ id: "b", insurer_id: "insurer-b", insurer_name: "B", appetite_level: "declined" }),
  ]);
  const items = analysis.items.filter((i) => i.code === "requested_section_not_evaluated");
  deepEq(items.map((i) => [i.insurer_ids[0], i.section_keys[0], i.materiality, i.scope, i.affects]), [
    ["insurer-a", "cyber", "material", "section", "section"],
    ["insurer-b", "cyber", "nonblocking", "section", "section"],
  ], "per insurer and section");
  eq(items[0].required_by[0].authority, "declared_cover_section", "the submission's own declaration is the authority");
});

test("10. tied rules that disagree are 'ambiguous' (material); tied rules that are equivalent raise nothing", () => {
  // Two equally good rules (same product line and risk type) that differ in the preferred
  // terms they hit: choosing between them changes the score, so the section is ambiguous.
  const analysis = completeness(risk(), [
    rule({ id: "t1", preferred_risks: ["transport fleet"] }),
    rule({ id: "t2", preferred_risks: [] }),
  ]);
  const ambiguous = analysis.items.filter((i) => i.code === "section_rule_ambiguous");
  eq(ambiguous.length, 1, "one ambiguous section");
  deepEq([ambiguous[0].status, ambiguous[0].materiality, ambiguous[0].section_keys, ambiguous[0].rule_ids, ambiguous[0].scope], ["ambiguous", "material", ["commercial_motor"], ["t1", "t2"], "section"], "ambiguity is material, names the section and BOTH rules");
  // Equally good rules that are equivalent in outcome are not ambiguity.
  const equivalent = completeness(risk(), [rule({ id: "e1" }), rule({ id: "e2" })]);
  eq(equivalent.items.filter((i) => i.code === "section_rule_ambiguous").length, 0, "equivalent ties are not ambiguity");
  eq(equivalent.state, "complete", "and the case stays complete");
});

test("11. several products with no declared sections: case-level limitation plus an insurer item; nothing is invented", () => {
  const riskInput = risk({ section_candidates: [], product_candidates: ["commercial motor", "goods in transit"] });
  const analysis = completeness(riskInput, [
    rule({ id: "a-motor" }),
    rule({ id: "a-git", product_line: "goods_in_transit", risk_type: "cargo" }),
    rule({ id: "b-motor", insurer_id: "insurer-b", insurer_name: "B" }),
  ]);
  const codes = analysis.items.map((i) => i.code).sort();
  deepEq(codes, ["multiple_products_without_declared_sections", "requested_sections_not_declared"], "two items, no invented section");
  const limitation = analysis.items.find((i) => i.code === "requested_sections_not_declared")!;
  deepEq([limitation.scope, limitation.materiality, limitation.insurer_ids], ["submission", "nonblocking", []], "case-level, nonblocking");
  deepEq(analysis.case_item_ids, [limitation.item_id], "listed as a case item");
  eq(analysis.insurers.find((i) => i.insurer_id === "insurer-b")!.state, "complete", "a single product raises nothing for B");
});

test("12. no appetite data and no rule match are insurer-level items with their own authority", () => {
  const analysis = completeness(risk({ product_candidates: ["marine"], section_candidates: ["Marine"], risk_candidates: ["shipping"] }), [rule({ id: "a" })], [{ insurer_id: "insurer-z", insurer_name: "Zed" }]);
  const byCode = Object.fromEntries(analysis.items.map((i) => [i.code, i]));
  deepEq([byCode.insurer_appetite_data_missing.insurer_ids, byCode.insurer_appetite_data_missing.materiality, byCode.insurer_appetite_data_missing.required_by[0].authority], [["insurer-z"], "nonblocking", "active_insurer_inventory"], "no appetite data");
  deepEq([byCode.insurer_rule_match_missing.insurer_ids, byCode.insurer_rule_match_missing.materiality, byCode.insurer_rule_match_missing.status], [["insurer-1"], "material", "not_evaluated"], "no matching rule");
});

// ---------------------------------------------------------------------------
// Facts: only what the extraction itself reported
// ---------------------------------------------------------------------------

test("13. fact requirements come ONLY from the extraction's own missing_information; no universal requirement is invented", () => {
  const empty = completeness(risk(), [rule({})], [], {});
  eq(empty.items.length, 0, "a reviewed record with nothing reported creates no fact item — Atlas does not decide a vehicle registration or an ID number is required");
  deepEq(empty.requirement_basis, REQUIREMENT_BASIS, "basis stated in every packet");
  eq(empty.requirement_basis.universal_requirements, "none_defined", "explicit");
  const reported = completeness(risk(), [rule({})], [], { missing_information: [{ field: "extracted_client.registration_or_id_number", priority: "high", reason_required: "R" }] });
  eq(reported.items.length, 1, "reported => item");
  deepEq([reported.items[0].scope, reported.items[0].affects, reported.items[0].materiality], ["fact", "not_determined", "nonblocking"], "no claim about the outcome");
});

test("14. resolved schema facts are canonical, de-duplicated and stable; unresolved text stays positional", () => {
  const { records, omitted } = readExtractionReportedMissing({
    missing_information: [
      { field: "extracted_client.registration_or_id_number", priority: "high" },
      { field: "REGISTRATION_OR_ID_NUMBER", priority: "medium" },
      { field: "Number of vehicles (free text)", priority: "low" },
      { field: "name", priority: "low" },
      { field: "risk_address", priority: "bogus" },
      { field: "" },
      { reason_required: "no field" },
      null,
      "string entry",
      { field: "current_cover.cover_sections" },
    ],
  });
  deepEq(records, [
    { index: null, priority: "high", field_path: "extracted_client.registration_or_id_number" },
    { index: 2, priority: "low", field_path: null },
    { index: 3, priority: "low", field_path: null },
    { index: 4, priority: null, field_path: null },
    { index: null, priority: null, field_path: "current_cover.cover_sections" },
  ], "exact paths resolve once; ambiguous bare keys and free text do not");
  eq(omitted, 0, "none omitted");
  eq(schemaFieldLabel("extracted_client.registration_or_id_number"), "Registration or ID number", "label from the schema key only");
});

test("14b. stale extraction reports disappear once the reviewed schema value is meaningfully present", () => {
  const missing = readExtractionReportedMissing({
    extracted_client: { registration_or_id_number: { value: null } },
    missing_information: [{ field: "extracted_client.registration_or_id_number", priority: "high" }],
  });
  eq(missing.records.length, 1, "absent reviewed value remains missing");
  const supplied = readExtractionReportedMissing({
    extracted_client: { registration_or_id_number: { value: "REG-123" } },
    missing_information: [{ field: "extracted_client.registration_or_id_number", priority: "high" }],
  });
  eq(supplied.records.length, 0, "present reviewed value suppresses stale extraction report");
});

test("14c. duplicate/reordered structured reports produce one identical item; unknown prose is never promoted", () => {
  const a = completeness(risk(), [rule({})], [], {
    missing_information: [
      { field: "extracted_client.registration_or_id_number", priority: "high" },
      { field: "REGISTRATION_OR_ID_NUMBER", priority: "low" },
    ],
  });
  const b = completeness(risk(), [rule({})], [], {
    missing_information: [
      { field: "REGISTRATION_OR_ID_NUMBER", priority: "high" },
      { field: "extracted_client.registration_or_id_number", priority: "low" },
    ],
  });
  eq(a.items.length, 1, "duplicates collapse");
  eq(b.items.length, 1, "duplicates collapse after reorder");
  eq(a.items[0].item_id, b.items[0].item_id, "canonical path identity is position-independent");
  eq(a.items[0].required_by[0].reference, "extracted_client.registration_or_id_number", "canonical reference");
  const unknown = completeness(risk(), [rule({})], [], { missing_information: [{ field: "Please explain unusual circumstances", reason_required: "PRIVATE" }] });
  deepEq([unknown.items[0].field_path, unknown.items[0].label], [null, null], "unknown prose is not a structured requirement");
  assert(!JSON.stringify(unknown).includes("Please explain") && !JSON.stringify(unknown).includes("PRIVATE"), "unknown prose and reason are not persisted");
});

test("15. reported items are bounded; the overflow is a count, never text", () => {
  const many = { missing_information: Array.from({ length: 80 }, (_, i) => ({ field: `free text ${i}`, priority: "low" })) };
  const analysis = completeness(risk(), [rule({})], [], many);
  eq(analysis.items.length, 50, "capped");
  eq(analysis.extraction_reported_omitted, 30, "the rest is counted");
});

test("16. extraction free text never reaches the completeness structure", () => {
  const analysis = completeness(risk(), [rule({})], [], {
    missing_information: [{ field: "PRIVATE_FIELD_TEXT about Mr Smith", reason_required: "PRIVATE_REASON_TEXT", priority: "high" }],
  });
  const text = JSON.stringify(analysis);
  for (const needle of ["PRIVATE_FIELD_TEXT", "PRIVATE_REASON_TEXT", "Smith"]) assert(!text.includes(needle), `${needle} must not be persisted`);
  deepEq([analysis.items[0].label, analysis.items[0].field_path], [null, null], "unresolved => no label, no path");
});

// ---------------------------------------------------------------------------
// Vocabulary, determinism, purity
// ---------------------------------------------------------------------------

test("17. the vocabulary has no blocker: the strongest state is incomplete_material, and nothing is a decline", () => {
  const analysis = completeness(risk({ available_documents: [] }), [rule({ required_documents: ["Risk survey"] })]);
  eq(analysis.state, "incomplete_material", "strongest state");
  const text = JSON.stringify(analysis);
  for (const word of ["blocker", "decline", "ruled_out", "score", "rank"]) assert(!text.includes(`"${word}`), `no ${word} field`);
  assert(analysis.items.every((i) => i.materiality === "material" || i.materiality === "nonblocking"), "two materialities only");
  assert(analysis.items.every((i) => i.resolution_state === "open"), "a packet never claims resolution");
});

test("18. DETERMINISM — insurer order, rule order and repeated runs give byte-identical completeness", () => {
  const rules = [
    rule({ id: "a", insurer_id: "insurer-a", insurer_name: "A", required_documents: ["Risk survey"] }),
    rule({ id: "b", insurer_id: "insurer-b", insurer_name: "B", required_documents: ["Financial statements"] }),
    rule({ id: "c", insurer_id: "insurer-c", insurer_name: "C", required_documents: ["Claims history", "Risk survey"] }),
  ];
  const base = JSON.stringify(completeness(risk(), rules));
  eq(JSON.stringify(completeness(risk(), [...rules].reverse())), base, "reversed rules");
  eq(JSON.stringify(completeness(risk(), rules)), base, "repeat");
  const built = buildEvidenceBaseV2(input(risk(), rules));
  const forward = assessCompleteness({ requestedSections: built.requested_sections, insurers: [...built.scored, ...built.noData], reported: { records: [], omitted: 0 } });
  const backward = assessCompleteness({ requestedSections: built.requested_sections, insurers: [...built.scored, ...built.noData].reverse(), reported: { records: [], omitted: 0 } });
  eq(JSON.stringify(backward), JSON.stringify(forward), "insurer order in the input does not matter");
});

test("19. PURITY — completeness reads the matcher output and never mutates it or feeds back into it", () => {
  const built = buildEvidenceBaseV2(input(risk(), [rule({ required_documents: ["Risk survey"] })]));
  const before = JSON.stringify(built);
  assessCompleteness({ requestedSections: built.requested_sections, insurers: [...built.scored, ...built.noData], reported: { records: [], omitted: 0 } });
  eq(JSON.stringify(built), before, "inputs untouched");
});

test("20. item ids are deterministic, unique and stable under a change that does not concern them", () => {
  const rules = [rule({ id: "a", insurer_id: "insurer-a", insurer_name: "A", required_documents: ["Risk survey"] }), rule({ id: "b", insurer_id: "insurer-b", insurer_name: "B", required_documents: ["Financial statements"] })];
  const first = completeness(risk(), rules);
  eq(new Set(ids(first)).size, ids(first).length, "unique");
  const second = completeness(risk({ overall_confidence: 0.4 }), rules);
  deepEq(ids(second), ids(first), "unrelated change, same identities");
  assert(ids(first).every((id) => id.startsWith("cmp:")), "namespace");
});

// ---------------------------------------------------------------------------
// Quality linkage (evidence v3)
// ---------------------------------------------------------------------------

test("21. every completeness item that the v2 table already classified POINTS AT its quality gap(s); nothing is created twice", () => {
  const riskInput = risk({ section_candidates: ["Commercial motor", "Cyber"], product_candidates: ["commercial motor", "cyber"], available_documents: [] });
  const evidence = v3(riskInput, [
    rule({ id: "a", insurer_id: "insurer-a", insurer_name: "A", required_documents: ["Risk survey"] }),
    rule({ id: "b", insurer_id: "insurer-b", insurer_name: "B" }),
  ], [{ insurer_id: "insurer-z", insurer_name: "Zed" }]);
  const gapById = new Map(evidence.quality.gaps.map((g) => [g.gap_id, g]));
  eq(gapById.size, evidence.quality.gaps.length, "gap ids are unique");
  assert(evidence.completeness.items.length >= 4, "a rich case");
  for (const item of evidence.completeness.items) {
    assert(item.quality_gap_ids.length > 0, `${item.item_id}: linked to at least one gap`);
    for (const gapId of item.quality_gap_ids) {
      const gap = gapById.get(gapId);
      assert(gap, `${item.item_id}: ${gapId} exists`);
      assert(gap.completeness_item_ids.includes(item.item_id), `${gapId} points back at ${item.item_id}`);
    }
  }
  // The set of v2 gap CODES is unchanged: completeness added no duplicate gap for them.
  const v2 = buildRecommendationEvidenceV2(input(riskInput, [
    rule({ id: "a", insurer_id: "insurer-a", insurer_name: "A", required_documents: ["Risk survey"] }),
    rule({ id: "b", insurer_id: "insurer-b", insurer_name: "B" }),
  ], [{ insurer_id: "insurer-z", insurer_name: "Zed" }]));
  deepEq(evidence.quality.gaps.map((g) => g.gap_id), v2.quality.gaps.map((g) => g.gap_id), "same gaps, same order — only links were added");
});

test("22. every MATERIAL completeness item is backed by a material-or-worse quality gap (completeness and reliance cannot disagree)", () => {
  const riskInput = risk({ section_candidates: ["Commercial motor", "Cyber"], product_candidates: ["commercial motor", "cyber"], available_documents: [] });
  const evidence = v3(riskInput, [
    rule({ id: "a", insurer_id: "insurer-a", insurer_name: "A", required_documents: ["Risk survey"] }),
    rule({ id: "b", insurer_id: "insurer-b", insurer_name: "B" }),
  ]);
  const gapById = new Map(evidence.quality.gaps.map((g) => [g.gap_id, g]));
  const materialItems = evidence.completeness.items.filter((i) => i.materiality === "material");
  assert(materialItems.length > 0, "there are material items");
  for (const item of materialItems) {
    assert(item.quality_gap_ids.some((id) => ["material", "blocker"].includes(gapById.get(id)!.severity)), `${item.item_id}: has a material gap`);
  }
  assert(["caution", "incomplete"].includes(evidence.quality.state), "so the reliance state reflects it");
});

test("23. extraction-reported information gets exactly one NEW advisory gap each, linked both ways", () => {
  const evidence = v3(risk(), [rule({})], [], { missing_information: [{ field: "extracted_client.name", priority: "high" }, { field: "free text", priority: "low" }] });
  const gaps = evidence.quality.gaps.filter((g) => g.code === "extraction_reported_information_missing");
  eq(gaps.length, 2, "one per item");
  assert(gaps.every((g) => g.severity === "advisory" && g.insurer_id === null && g.completeness_item_ids.length === 1), "advisory, recommendation-level, linked");
  for (const item of evidence.completeness.items) deepEq(item.quality_gap_ids.length, 1, "the item points at its gap");
  eq(evidence.quality.state, "decision_ready", "advisory gaps do not change reliance");
});

test("24. v3 is a strict SUPERSET of v2: every shared field is identical, and v3 only adds links + two analyses", () => {
  const rules = [rule({ id: "a", insurer_id: "insurer-a", insurer_name: "A", required_documents: ["Risk survey"] }), rule({ id: "b", insurer_id: "insurer-b", insurer_name: "B", appetite_level: "preferred" })];
  const reviewed = { missing_information: [{ field: "x" }] };
  const two = buildRecommendationEvidenceV2(input(risk(), rules, [{ insurer_id: "insurer-z", insurer_name: "Zed" }], reviewed));
  const three = v3(risk(), rules, [{ insurer_id: "insurer-z", insurer_name: "Zed" }], reviewed);
  eq(three.schema_version, "recommendation-evidence-v3", "version");
  for (const key of ["provenance", "matcher_input", "requested_sections", "scoring_scope", "reviewed_risk_facts", "trusted_documents"] as const) {
    deepEq(three[key], two[key], key);
  }
  deepEq(three.insurers, two.insurers, "every insurer outcome, including each insurer's own quality block, is identical");
  const strip = (gaps: { gap_id: string }[]) => gaps.map((g) => g.gap_id);
  deepEq(strip(three.quality.gaps.filter((g) => g.code !== "extraction_reported_information_missing")), strip(two.quality.gaps), "the v2 gaps, in order");
  assert(three.completeness && three.contradictions, "the two additions");
  eq(three.quality.model, "recommendation-quality-v3", "the quality model is bumped");
  eq(two.quality.model, "recommendation-quality-v2", "and v2 is untouched");
});

test("25. scores, ranks and flags are NOT inputs: completeness and an empty production registry change nothing", () => {
  const rules = [rule({ id: "a", insurer_id: "insurer-a", insurer_name: "A", required_documents: ["Risk survey"] }), rule({ id: "b", insurer_id: "insurer-b", insurer_name: "B" })];
  const plain = buildRecommendationEvidenceV2(input(risk(), rules));
  const loaded = buildRecommendationEvidenceV3({
    ...input(risk(), rules, [], { missing_information: Array.from({ length: 10 }, (_, i) => ({ field: `f${i}` })) }),
    observations: {
      observations: [
        { field_key: "broker.email", source_id: "intake_form", source_label: "Submission intake", raw: "a@x.co", pointer: { record: "atlas_submissions", column: "broker_email" }, field_status: null, confidence: null },
        { field_key: "broker.email", source_id: "reviewed_extraction", source_label: "Reviewed extraction", raw: "b@x.co", pointer: { record: "atlas_extractions", record_id: "e", field_path: "broker.email", document_id: null, page: null }, field_status: "extracted", confidence: 0.9 },
      ],
      unavailable_sources: [],
    },
  });
  eq(loaded.contradictions.contradiction_count, 0, "unregistered observations cannot create a production contradiction");
  deepEq(loaded.contradictions.comparisons, [], "no production comparison attempt");
  const authoritative = (e: { insurers: unknown[] }) =>
    JSON.stringify((e.insurers as { insurer_id: string; rank: number | null; score: number | null; band: string; rule_status: string; confidence: number | null; referral_required?: boolean; manual_review_required?: boolean; senior_review_required?: boolean; ruled_out?: boolean; required_documents: unknown[]; rule_evidence: unknown[] }[]).map((i) => [
      i.insurer_id, i.rank, i.score, i.band, i.rule_status, i.confidence, i.referral_required, i.manual_review_required, i.senior_review_required, i.ruled_out, i.required_documents, i.rule_evidence,
    ]));
  eq(authoritative(loaded), authoritative(plain), "identical authoritative output");
});

test("26. the packet carries stable references only: no URL, storage path or token anywhere in the new structures", () => {
  const evidence = v3(risk(), [rule({ required_documents: ["Risk survey"] })], [], { missing_information: [{ field: "extracted_client.name" }] });
  const text = JSON.stringify([evidence.completeness, evidence.contradictions]);
  for (const needle of ["http://", "https://", "storage_path", "signed_url", "token", "secret", "service-role"]) assert(!text.includes(needle), `no ${needle}`);
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
console.log(`\nPowerhouse completeness: ${tests.length - failures} passed, ${failures} failed out of ${tests.length}`);
if (failures > 0) process.exitCode = 1;
