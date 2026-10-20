/** Phase 1A — deterministic recommendation evidence contract. */

import type { SupabaseClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AtlasUser } from "../worker/src/auth.js";
import type { Env } from "../worker/src/config.js";
import {
  handleGetRecommendation,
  loadAvailableDocumentTypes,
} from "../worker/src/recommendation-endpoints.js";
import {
  MATCHER_VERSION,
  insurersWithoutActiveRules,
  matchInsurers,
  type MatchInputRisk,
} from "../worker/src/matcher.js";
import type { AppetiteRow } from "../worker/src/matcher-types.js";
import {
  buildRecommendationEvidence,
  type RecommendationEvidenceV1,
} from "../worker/src/recommendation-evidence.js";
import { buildRecommendationFingerprint } from "../worker/src/phase7-core.js";
import { TAXONOMY_VERSION } from "../worker/src/taxonomy.js";

const runtimeGlobals = globalThis as { WebSocket?: unknown };
if (typeof runtimeGlobals.WebSocket === "undefined") {
  runtimeGlobals.WebSocket = class UnusedWebSocket {};
}

const tests: { name: string; fn: () => void | Promise<void> }[] = [];
function test(name: string, fn: () => void | Promise<void>) { tests.push({ name, fn }); }
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function eq<T>(actual: T, expected: T, message: string) {
  if (actual !== expected) throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function deepEq(actual: unknown, expected: unknown, message: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

const SUB = "11111111-1111-1111-1111-111111111111";
const EXT = "22222222-2222-2222-2222-222222222222";
const REC = "33333333-3333-4333-8333-333333333333";
const GENERATED = "2026-10-16T10:00:00.000Z";

function reviewedField(value: unknown, confidence: number | null = 0.9) {
  return {
    value,
    status: value === null ? "not_found" : "extracted",
    confidence,
    confidence_source: confidence === null ? "unavailable" : "provider",
  };
}

function reviewed() {
  return {
    schema_version: "test-v1",
    extracted_client: {
      occupation_or_business_description: reviewedField("transport fleet"),
      risk_address: reviewedField("1 Main Road"),
      entity_type: reviewedField("Company"),
    },
    current_cover: {
      cover_sections: reviewedField(["Commercial motor"]),
      endorsements: reviewedField([]),
      exclusions: reviewedField([]),
    },
    risk_classification: {
      product_line: reviewedField("commercial motor"),
      risk_type: reviewedField("transport"),
      primary_risk_type: reviewedField("transport fleet"),
      secondary_risk_types: reviewedField([]),
      business_sector: reviewedField("transport"),
      complexity_level: reviewedField("medium"),
    },
    red_flags: [],
  } as Record<string, unknown>;
}

function risk(overrides: Partial<MatchInputRisk> = {}): MatchInputRisk {
  return {
    product_candidates: ["commercial motor"],
    section_candidates: ["commercial motor"],
    risk_candidates: ["transport"],
    features: [
      { text: "transport fleet", source: "occupation/business description" },
      { text: "medium", source: "complexity level" },
    ],
    available_documents: ["Claims history"],
    overall_confidence: 0.9,
    overall_confidence_available: true,
    ...overrides,
  };
}

function appetite(overrides: Partial<AppetiteRow> = {}): AppetiteRow {
  return {
    id: overrides.id ?? "rule-1",
    insurer_id: overrides.insurer_id ?? "insurer-1",
    insurer_name: overrides.insurer_name ?? "Evidence Insurance",
    product_line: "commercial_motor",
    risk_type: "transport",
    appetite_level: "standard",
    preferred_risks: [],
    caution_risks: [],
    declined_risks: [],
    required_documents: [],
    referral_triggers: [],
    notes: "Approved underwriting note.",
    source: "manual",
    source_document_id: "document-1",
    source_file_name: "motor-guide.pdf",
    source_page: 7,
    source_section: "Commercial motor",
    source_quote: "Transport fleets are considered.",
    is_active: true,
    ...overrides,
  };
}

function buildEvidence(args: {
  matcherRisk?: MatchInputRisk;
  rules?: AppetiteRow[];
  noData?: { insurer_id: string; insurer_name: string }[];
  reviewedJson?: Record<string, unknown>;
} = {}): { evidence: RecommendationEvidenceV1; result: ReturnType<typeof matchInsurers>; matcherRisk: MatchInputRisk; rules: AppetiteRow[] } {
  const matcherRisk = args.matcherRisk ?? risk();
  const rules = args.rules ?? [appetite()];
  const result = matchInsurers(matcherRisk, rules);
  result.no_data_for = args.noData ?? [];
  const evidence = rebuildEvidence(result, matcherRisk, rules, args.reviewedJson);
  return { evidence, result, matcherRisk, rules };
}

function rebuildEvidence(
  result: ReturnType<typeof matchInsurers>,
  matcherRisk: MatchInputRisk,
  rules: AppetiteRow[],
  reviewedJson: Record<string, unknown> = reviewed()
): RecommendationEvidenceV1 {
  return buildRecommendationEvidence({
    recommendationId: REC,
    submissionId: SUB,
    extractionId: EXT,
    reviewedAt: "2026-10-16T09:00:00.000Z",
    generatedAt: GENERATED,
    matcherVersion: MATCHER_VERSION,
    taxonomyVersion: TAXONOMY_VERSION,
    explanationMode: "deterministic",
    explanationSource: "deterministic",
    recommendationInputFingerprint: "fp_test",
    reviewed: reviewedJson,
    matcherInput: matcherRisk,
    matcherResult: result,
    activeAppetite: rules,
  });
}

function effects(evidence: RecommendationEvidenceV1) {
  return evidence.insurers[0].rule_evidence.map((item) => item.effect);
}

function firstScored(evidence: RecommendationEvidenceV1) {
  const outcome = evidence.insurers[0];
  assert(outcome.status === "scored", "first insurer should be scored");
  return outcome;
}

test("1. preferred match carries exact rule provenance and authoritative positive contribution", () => {
  const { evidence } = buildEvidence({ rules: [appetite({ preferred_risks: ["transport fleet"] })] });
  const preferred = firstScored(evidence).rule_evidence.find((item) => item.effect === "preferred" && item.matcher_component === "preferred");
  assert(preferred, "preferred evidence should exist");
  eq(preferred.rule_id, "rule-1", "rule id");
  eq(preferred.source_document_id, "document-1", "source document id");
  eq(preferred.score_contribution, 5, "matcher contribution");
  deepEq(preferred.matched_input_sources[0].source_labels, ["occupation/business description"], "matched source label");
});

test("2. caution evidence is machine-readable and linked to the exact rule", () => {
  const { evidence } = buildEvidence({ rules: [appetite({ caution_risks: ["medium"] })] });
  assert(effects(evidence).includes("caution"), "caution effect should exist");
  const outcome = firstScored(evidence);
  const caution = outcome.rule_evidence.find((item) => item.matcher_component === "caution");
  eq(caution?.score_contribution, -10, "caution contribution");
  assert(outcome.outcome_reasons.cautions.includes(caution!.evidence_id), "outcome cites caution evidence");
});

test("3. document-backed decline is represented as a hard decline without invented additive score", () => {
  const { evidence } = buildEvidence({ rules: [appetite({ declined_risks: ["transport fleet"] })] });
  const outcome = firstScored(evidence);
  eq(outcome.ruled_out, true, "insurer ruled out");
  const decline = outcome.rule_evidence.find((item) => item.effect === "hard_decline");
  assert(decline, "decline evidence should exist");
  eq(decline.score_contribution, null, "hard outcome has no fabricated additive delta");
  assert(outcome.outcome_reasons.declines.includes(decline.evidence_id), "outcome cites decline evidence");
});

test("4. referral trigger evidence is explicit and rule-linked", () => {
  const { evidence } = buildEvidence({ rules: [appetite({ referral_triggers: ["transport fleet"] })] });
  const outcome = firstScored(evidence);
  eq(outcome.referral_required, true, "referral flag");
  const referral = outcome.rule_evidence.find((item) => item.effect === "referral");
  assert(referral, "referral evidence should exist");
  eq(referral.score_contribution, -8, "referral contribution");
});

test("5. required document present is linked to its appetite rule", () => {
  const { evidence } = buildEvidence({ rules: [appetite({ required_documents: ["Claims history"] })] });
  const outcome = firstScored(evidence);
  const doc = outcome.rule_evidence.find((item) => item.effect === "required_document_present");
  assert(doc, "present document evidence should exist");
  eq(doc.rule_id, "rule-1", "document check rule id");
  eq(doc.required_document, "Claims history", "required document label");
});

test("6. required document missing is explicit but is not mislabeled as a score reason", () => {
  const { evidence } = buildEvidence({
    matcherRisk: risk({ available_documents: [] }),
    rules: [appetite({ required_documents: ["Claims history"] })],
  });
  const outcome = firstScored(evidence);
  const doc = outcome.rule_evidence.find((item) => item.effect === "required_document_missing");
  assert(doc, "missing document evidence should exist");
  const required = outcome.required_documents.find((item) => item.document_type === "Claims history");
  assert(required, "dedicated required-document outcome exists");
  assert(outcome.outcome_reasons.required_documents_missing.includes(required.evidence_id), "missing list cites dedicated outcome");
  assert(!outcome.outcome_reasons.weakened_by.includes(doc.evidence_id), "confidence-only document gap is not a score reason");
});

type DocumentRow = { document_type: string; submission_id: string; status: string; scan_status: unknown };
function documentAdmin(rows: DocumentRow[]): SupabaseClient {
  return {
    from: () => {
      const filters: { key: string; value: unknown }[] = [];
      const query: Record<string, unknown> = {};
      query.select = () => query;
      query.eq = (key: string, value: unknown) => { filters.push({ key, value }); return query; };
      query.then = (resolve: (value: unknown) => unknown) => Promise.resolve(resolve({
        data: rows.filter((row) => filters.every((filter) => (row as unknown as Record<string, unknown>)[filter.key] === filter.value)),
        error: null,
      }));
      return query;
    },
  } as unknown as SupabaseClient;
}

test("7. trusted-document evidence contains the same active exact-clean set consumed by the matcher", async () => {
  const admin = documentAdmin([
    { submission_id: SUB, document_type: "Claims history", status: "active", scan_status: "clean" },
    { submission_id: SUB, document_type: "Policy schedule", status: "active", scan_status: "clean" },
  ]);
  const loaded = await loadAvailableDocumentTypes(admin, SUB);
  assert(loaded.ok, "loader succeeds");
  const { evidence } = buildEvidence({ matcherRisk: risk({ available_documents: loaded.availableDocs }) });
  deepEq(evidence.trusted_documents.map((item) => item.document_type), ["Claims history", "Policy schedule"], "trusted set");
});

test("8. pending, failed, infected, not_scanned, null, and expired documents never become trusted evidence", async () => {
  const rows: DocumentRow[] = [
    { submission_id: SUB, document_type: "Clean", status: "active", scan_status: "clean" },
    ...["not_scanned", "pending", "failed", "infected", null].map((state) => ({
      submission_id: SUB, document_type: `Noise-${String(state)}`, status: "active", scan_status: state,
    })),
    { submission_id: SUB, document_type: "Expired", status: "expired", scan_status: "clean" },
  ];
  const loaded = await loadAvailableDocumentTypes(documentAdmin(rows), SUB);
  assert(loaded.ok, "loader succeeds");
  deepEq(loaded.availableDocs, ["Clean"], "only exact-clean active document reaches evidence input");
  const { evidence } = buildEvidence({ matcherRisk: risk({ available_documents: loaded.availableDocs }) });
  deepEq(evidence.trusted_documents.map((item) => item.document_type), ["Clean"], "evidence remains clean-only");
});

test("9. source_document_id is preserved point in time", () => {
  const { evidence } = buildEvidence();
  assert(firstScored(evidence).rule_evidence.every((item) => item.source_document_id === "document-1"), "source id preserved");
});

test("10. page, section, quote, and filename are preserved when available", () => {
  const { evidence } = buildEvidence();
  const rule = firstScored(evidence).rule_evidence[0];
  eq(rule.source_page, 7, "page");
  eq(rule.source_section, "Commercial motor", "section");
  eq(rule.source_quote, "Transport fleets are considered.", "quote");
  eq(rule.source_file_name, "motor-guide.pdf", "filename");
});

test("11. missing provenance stays null and is surfaced as a quality gap", () => {
  const { evidence } = buildEvidence({ rules: [appetite({ source_document_id: null, source_file_name: null, source_page: null, source_section: null, source_quote: null })] });
  const rule = firstScored(evidence).rule_evidence[0];
  eq(rule.source_document_id, null, "source id remains null");
  eq(rule.source_page, null, "page remains null");
  eq(rule.source_section, null, "section remains null");
  eq(rule.source_quote, null, "quote remains null");
  assert(evidence.quality.gaps.some((gap) => gap.code === "rule_source_document_missing"), "missing provenance is reported");
});

test("12. insurer with no active appetite data remains represented", () => {
  const noData = insurersWithoutActiveRules(
    [{ id: "insurer-1", name: "Evidence Insurance" }, { id: "insurer-2", name: "No Rules Insurance" }],
    [{ insurer_id: "insurer-1" }]
  );
  const { evidence } = buildEvidence({ noData });
  const missing = evidence.insurers.find((item) => item.insurer_id === "insurer-2");
  assert(missing, "no-data insurer present");
  eq(missing.no_appetite_data, true, "no-data state");
  eq(missing.rank, null, "no invented rank");
  eq(missing.status, "no_appetite_data", "explicit no-data status");
  eq(missing.score, null, "no invented score");
  for (const absent of ["confidence", "manual_review_required", "senior_review_required", "matcher_notes", "scored_against_rule_id"]) {
    assert(!(absent in missing), `no-data outcome must omit ${absent}`);
  }
});

test("13. building evidence cannot alter matcher ranking or scores", () => {
  const rules = [
    appetite({ id: "preferred", insurer_id: "insurer-1", insurer_name: "A", appetite_level: "preferred" }),
    appetite({ id: "caution", insurer_id: "insurer-2", insurer_name: "B", appetite_level: "caution" }),
  ];
  const matcherResult = matchInsurers(risk(), rules);
  const before = matcherResult.insurers.map((item) => ({ id: item.insurer_id, score: item.score }));
  buildRecommendationEvidence({
    recommendationId: REC, submissionId: SUB, extractionId: EXT, reviewedAt: null, generatedAt: GENERATED,
    matcherVersion: MATCHER_VERSION, taxonomyVersion: TAXONOMY_VERSION, explanationMode: "deterministic",
    explanationSource: "deterministic", recommendationInputFingerprint: "fp", reviewed: reviewed(),
    matcherInput: risk(), matcherResult, activeAppetite: rules,
  });
  deepEq(matcherResult.insurers.map((item) => ({ id: item.insurer_id, score: item.score })), before, "matcher result remains untouched");
});

test("14. semantically identical input produces deterministic evidence ordering", () => {
  const rules = [appetite({ preferred_risks: ["transport fleet"], required_documents: ["Claims history", "Policy schedule"] })];
  const first = buildEvidence({ matcherRisk: risk({ available_documents: ["Policy schedule", "Claims history"] }), rules });
  const secondResult = structuredClone(first.result);
  secondResult.insurers[0].matched_rules.reverse();
  secondResult.insurers[0].required_document_evidence?.reverse();
  const second = buildRecommendationEvidence({
    recommendationId: REC, submissionId: SUB, extractionId: EXT, reviewedAt: "2026-10-16T09:00:00.000Z", generatedAt: GENERATED,
    matcherVersion: MATCHER_VERSION, taxonomyVersion: TAXONOMY_VERSION, explanationMode: "deterministic",
    explanationSource: "deterministic", recommendationInputFingerprint: "fp_test", reviewed: reviewed(),
    matcherInput: risk({ available_documents: ["Claims history", "Policy schedule"] }), matcherResult: secondResult,
    activeAppetite: rules,
  });
  deepEq(second.trusted_documents, first.evidence.trusted_documents, "trusted document ordering");
  deepEq(firstScored(second).rule_evidence, firstScored(first.evidence).rule_evidence, "rule evidence ordering");
});

test("15. appetite rule changes retain existing fingerprint invalidation behavior", () => {
  const common = {
    submissionId: SUB, extractionId: EXT, reviewedAt: GENERATED, availableDocuments: ["Claims history"],
    matcherVersion: MATCHER_VERSION, taxonomyVersion: TAXONOMY_VERSION,
    evidenceSchemaVersion: "recommendation-evidence-v1",
  };
  const first = buildRecommendationFingerprint({ ...common, activeRuleIds: ["rule-1:2026-01-01"] });
  const changed = buildRecommendationFingerprint({ ...common, activeRuleIds: ["rule-1:2026-10-16"] });
  assert(first !== changed, "rule version change must change fingerprint");
});

test("16. historical recommendation without evidence_json still reads successfully", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({
    id: "legacy-rec", recommended_insurer: "Legacy", secondary_options_json: [], not_recommended_json: [],
    reasoning_json: { headline: "Legacy" }, confidence_score: 0.8, referral_required: false,
    senior_review_required: false, extraction_id: EXT, created_at: "2025-01-01T00:00:00Z",
  }), { status: 200, headers: { "Content-Type": "application/json" } })) as typeof fetch;
  try {
    const response = await handleGetRecommendation(SUB, {
      SUPABASE_URL: "http://stub.supabase.test", SUPABASE_SERVICE_ROLE_KEY: "test-key",
    } as unknown as Env, { id: "user", email: "user@example.test", role: "manager" } as AtlasUser);
    eq(response.status, 200, "legacy GET status");
    const body = await response.json() as { recommendation?: Record<string, unknown> };
    eq(body.recommendation?.id, "legacy-rec", "legacy row returned");
    assert(body.recommendation?.evidence_json == null, "missing evidence remains absent/null");
  } finally {
    globalThis.fetch = original;
  }
});

test("17. evidence payload contains no storage path, signed URL, token, secret, or prompt fields", () => {
  const { evidence } = buildEvidence();
  const serialised = JSON.stringify(evidence).toLowerCase();
  for (const forbidden of ["storage_path", "signed_url", "auth_token", "service_role", "api_key", "system_prompt"]) {
    assert(!serialised.includes(`\"${forbidden}\"`), `forbidden key ${forbidden}`);
  }
});

test("18. persisted evidence redacts all client free text while retaining source and confidence metadata", () => {
  const sentinels = [
    "PERSON_SENTINEL_9QX", "ID_SENTINEL_8QX", "PHONE_SENTINEL_7QX",
    "BANK_SENTINEL_6QX", "ADDRESS_SENTINEL_5QX", "POLICY_SENTINEL_4QX",
  ];
  const reviewedJson = reviewed();
  const client = reviewedJson.extracted_client as Record<string, unknown>;
  client.occupation_or_business_description = reviewedField(`${sentinels[0]} ${sentinels[1]} ${sentinels[2]}`);
  client.risk_address = reviewedField(`${sentinels[3]} ${sentinels[4]}`);
  const cover = reviewedJson.current_cover as Record<string, unknown>;
  cover.endorsements = reviewedField([sentinels[5]]);
  reviewedJson.red_flags = [{ issue: sentinels.join(" ") }];
  const { evidence } = buildEvidence({
    reviewedJson,
    matcherRisk: risk({
      features: [
        { text: `${sentinels.join(" ")} transport fleet`, source: "occupation/business description" },
        { text: sentinels[5], source: "red flag", ai_inferred: true },
      ],
    }),
    rules: [appetite({ preferred_risks: ["transport fleet"] })],
  });
  const serialised = JSON.stringify(evidence);
  for (const sentinel of sentinels) assert(!serialised.includes(sentinel), `redact ${sentinel}`);
  assert(evidence.matcher_input.features.every((item) => item.value_retained === false), "features declare redaction");
  assert(evidence.reviewed_risk_facts.every((item) => item.present && item.value_retained === false), "facts retain presence only");
  deepEq(firstScored(evidence).rule_evidence.flatMap((item) => item.matched_rule_terms), [
    { term: "transport fleet", input_source: "occupation/business description" },
  ], "only the insurer-owned term and stable source survive");
});

test("19. score reconciliation exposes subtotal, hard-decline adjustment, clamp, and final score", () => {
  const belowCap = firstScored(buildEvidence({
    rules: [appetite({ preferred_risks: ["transport fleet"] })],
  }).evidence);
  deepEq(belowCap.score_reconciliation, {
    component_subtotal: 75,
    hard_decline_adjustment: 0,
    clamp_adjustment: 0,
    final_score: 75,
  }, "unclamped reconciliation");

  const clamped = firstScored(buildEvidence({
    rules: [appetite({ appetite_level: "preferred", preferred_risks: ["transport fleet"] })],
  }).evidence);
  deepEq(clamped.score_reconciliation, {
    component_subtotal: 105,
    hard_decline_adjustment: 0,
    clamp_adjustment: -5,
    final_score: 100,
  }, "clamped reconciliation");

  const declined = firstScored(buildEvidence({
    rules: [appetite({ declined_risks: ["transport fleet"] })],
  }).evidence);
  deepEq(declined.score_reconciliation, {
    component_subtotal: 70,
    hard_decline_adjustment: -70,
    clamp_adjustment: 0,
    final_score: 0,
  }, "hard-decline reconciliation");
  for (const item of [belowCap, clamped, declined]) {
    const score = item.score_reconciliation;
    eq(score.component_subtotal + score.hard_decline_adjustment + score.clamp_adjustment, score.final_score, "score arithmetic");
    eq(score.final_score, item.score, "final score matches outcome");
  }
});

test("20. confidence reconciliation and duplicate required-document semantics apply one penalty", () => {
  const product = appetite({ required_documents: ["Claims history"] });
  const portfolio = appetite({
    id: "portfolio-rule",
    product_line: "*",
    risk_type: "*",
    required_documents: ["Claims history"],
  });
  const outcome = firstScored(buildEvidence({
    matcherRisk: risk({ available_documents: [] }),
    rules: [product, portfolio],
  }).evidence);
  deepEq(outcome.confidence_reconciliation, {
    input_confidence: 0.9,
    input_confidence_available: true,
    required_document_adjustment: -0.09999999999999998,
    manual_review_cap_adjustment: 0,
    final_confidence: 0.8,
  }, "confidence arithmetic");
  eq(outcome.required_documents.length, 1, "one canonical document outcome");
  eq(outcome.required_documents[0].rule_evidence_ids.length, 2, "both governing rules linked");
  eq(outcome.required_documents[0].confidence_adjustment, -0.09999999999999998, "penalty applied once");
});

test("21. AI-only declined match is authoritatively a soft-decline referral, never a hard decline", () => {
  const outcome = firstScored(buildEvidence({
    matcherRisk: risk({ features: [{ text: "volatile AI inference", source: "red flag", ai_inferred: true }] }),
    rules: [appetite({ declined_risks: ["volatile ai inference"] })],
  }).evidence);
  const soft = outcome.rule_evidence.find((item) => item.effect === "soft_decline_referral");
  assert(soft, "soft decline effect copied from matcher");
  assert(outcome.outcome_reasons.referrals.includes(soft.evidence_id), "soft decline is a referral");
  assert(!outcome.outcome_reasons.declines.includes(soft.evidence_id), "soft decline is not a hard decline");
  eq(outcome.ruled_out, false, "AI-only match does not rule out");
});

test("22. insurer-owned matched terms retain authoritative term/source pairing for every effect", () => {
  const cases = [
    {
      label: "preferred",
      matcherRisk: risk({ features: [{ text: "transport fleet", source: "occupation/business description" }] }),
      rule: appetite({ preferred_risks: ["transport fleet"] }),
      effect: "preferred",
      expected: { term: "transport fleet", input_source: "occupation/business description" },
    },
    {
      label: "caution",
      matcherRisk: risk({ features: [{ text: "medium complexity", source: "complexity level" }] }),
      rule: appetite({ caution_risks: ["medium"] }),
      effect: "caution",
      expected: { term: "medium", input_source: "complexity level" },
    },
    {
      label: "hard decline",
      matcherRisk: risk({ features: [{ text: "transport fleet", source: "occupation/business description" }] }),
      rule: appetite({ declined_risks: ["transport fleet"] }),
      effect: "hard_decline",
      expected: { term: "transport fleet", input_source: "occupation/business description" },
    },
    {
      label: "soft decline referral",
      matcherRisk: risk({ features: [{ text: "volatile inference", source: "red flag", ai_inferred: true }] }),
      rule: appetite({ declined_risks: ["volatile inference"] }),
      effect: "soft_decline_referral",
      expected: { term: "volatile inference", input_source: "red flag [AI]" },
    },
    {
      label: "referral",
      matcherRisk: risk({ features: [{ text: "high value", source: "sum insured" }] }),
      rule: appetite({ referral_triggers: ["high value"] }),
      effect: "referral",
      expected: { term: "high value", input_source: "sum insured" },
    },
  ] as const;
  for (const item of cases) {
    const outcome = firstScored(buildEvidence({ matcherRisk: item.matcherRisk, rules: [item.rule] }).evidence);
    const evidence = outcome.rule_evidence.find((ruleEvidence) => ruleEvidence.effect === item.effect);
    assert(evidence, `${item.label} evidence exists`);
    deepEq(evidence.matched_rule_terms, [item.expected], `${item.label} term/source pairing`);
  }
});

test("23. matcher-authored ranks are copied exactly and no-data rank remains null", () => {
  const { evidence, result } = buildEvidence({
    rules: [
      appetite({ id: "preferred", insurer_id: "insurer-a", insurer_name: "A", appetite_level: "preferred" }),
      appetite({ id: "standard", insurer_id: "insurer-b", insurer_name: "B", appetite_level: "standard" }),
    ],
    noData: [{ insurer_id: "insurer-c", insurer_name: "C" }],
  });
  deepEq(result.insurers.map((item) => item.rank), [1, 2], "matcher authoritative ranks");
  deepEq(evidence.insurers.filter((item) => item.status === "scored").map((item) => item.rank), [1, 2], "evidence exact ranks");
  const noData = evidence.insurers.find((item) => item.status === "no_appetite_data");
  assert(noData, "no-data insurer exists");
  eq(noData.rank, null, "no-data rank stays null");
});

test("24. evidence builder fails closed when the matcher omits its authoritative rank", () => {
  const built = buildEvidence();
  delete built.result.insurers[0].rank;
  let error: unknown;
  try {
    rebuildEvidence(built.result, built.matcherRisk, built.rules);
  } catch (caught) {
    error = caught;
  }
  assert(error instanceof Error, "missing matcher rank is rejected");
  eq(error.message, "matcher_rank_missing:insurer-1", "stable missing-rank failure");
});

test("25. evidence builder copies matcher-owned term pairs without reconstructing them", () => {
  const built = buildEvidence({ rules: [appetite({ preferred_risks: ["transport fleet"] })] });
  const preferred = built.result.insurers[0].matched_rules.find((item) => item.effect === "preferred");
  assert(preferred, "preferred matcher rule exists");
  preferred.matched_rule_terms = [];
  const evidence = rebuildEvidence(built.result, built.matcherRisk, built.rules);
  const copied = firstScored(evidence).rule_evidence.find((item) => item.effect === "preferred");
  assert(copied, "preferred evidence exists");
  deepEq(copied.matched_rule_terms, [], "builder does not infer term pairs from matched strings or client input");
});

test("26. manual-review confidence cap adjustment is copied and reconciles to the final confidence", () => {
  const outcome = firstScored(buildEvidence({
    matcherRisk: risk({ overall_confidence: 0.9, overall_confidence_available: true }),
    rules: [appetite({ product_line: "cyber", risk_type: "technology" })],
  }).evidence);
  eq(outcome.manual_review_required, true, "manual review path selected");
  deepEq(outcome.confidence_reconciliation, {
    input_confidence: 0.9,
    input_confidence_available: true,
    required_document_adjustment: 0,
    manual_review_cap_adjustment: -0.55,
    final_confidence: 0.35,
  }, "authoritative manual-review cap reconciliation");
  eq(outcome.confidence, 0.35, "outcome final confidence");
});

test("27. present required document remains dedicated evidence and never becomes a score strength", () => {
  const outcome = firstScored(buildEvidence({
    rules: [appetite({ required_documents: ["Claims history"] })],
  }).evidence);
  const documentOutcome = outcome.required_documents.find((item) => item.document_type === "Claims history");
  assert(documentOutcome?.present, "document is present in dedicated evidence");
  const documentRules = outcome.rule_evidence.filter((item) => item.effect === "required_document_present");
  assert(documentRules.length > 0, "present document rule linkage exists");
  for (const item of documentRules) {
    assert(!outcome.outcome_reasons.strengthened_by.includes(item.evidence_id), "document presence is not a score strength");
  }
  assert(!outcome.outcome_reasons.strengthened_by.includes(documentOutcome.evidence_id), "document outcome is not a score strength");
});

test("28. non-ASCII canonical ordering uses stable code-unit order for terms, sources, and documents", () => {
  const terms = ["éclair", "alpha_beta", "Zulu", "alpha-beta"];
  const sources = ["é-source", "a_source", "Z-source", "a-source"];
  const matcherRisk = risk({
    features: sources.map((source) => ({ text: terms.join(" "), source })),
    available_documents: ["éclair", "alpha_beta", "Zulu", "alpha-beta"],
  });
  const rules = [appetite({ preferred_risks: terms })];
  const first = buildEvidence({ matcherRisk, rules });
  const expectedTerms = ["Zulu", "alpha-beta", "alpha_beta", "éclair"];
  const expectedSources = ["Z-source", "a-source", "a_source", "é-source"];
  const preferred = firstScored(first.evidence).rule_evidence.find((item) => item.effect === "preferred");
  assert(preferred, "preferred evidence exists");
  deepEq([...new Set(preferred.matched_rule_terms.map((item) => item.term))], expectedTerms, "term code-unit order");
  deepEq(preferred.matched_rule_terms.filter((item) => item.term === "Zulu").map((item) => item.input_source), expectedSources, "source code-unit order");
  deepEq(first.evidence.trusted_documents.map((item) => item.document_type), expectedTerms, "document code-unit order");

  const reversed = structuredClone(first.result);
  for (const ref of reversed.insurers[0].matched_rules) ref.matched_rule_terms?.reverse();
  const reversedRisk = risk({ ...matcherRisk, available_documents: [...matcherRisk.available_documents].reverse() });
  const second = rebuildEvidence(reversed, reversedRisk, rules);
  deepEq(firstScored(second).rule_evidence, firstScored(first.evidence).rule_evidence, "serialization stable after input reversal");
  deepEq(second.trusted_documents, first.evidence.trusted_documents, "document serialization stable after input reversal");
});

test("29. evidence migration is independently verifiable, additive, nullable, and does not rewrite history", () => {
  const sql = readFileSync(resolve("supabase/migrations/0037_recommendation_evidence_contract.sql"), "utf8").toLowerCase();
  assert(/add column if not exists evidence_json jsonb\s*;/.test(sql), "migration adds nullable jsonb column");
  assert(!/evidence_json jsonb\s+not null/.test(sql), "historical rows must not be forced non-null");
  assert(!/\bupdate\s+public\.atlas_recommendations\b/.test(sql), "migration must not rewrite historical rows");
  assert(!/\bdrop\s+(column|table)\b/.test(sql), "migration must not remove schema");
  assert(!/create policy|drop policy|alter policy/.test(sql), "migration must not change RLS semantics");
});

test("mutation guard: removing rule linkage creates a visible snapshot-missing gap", () => {
  const { result, matcherRisk } = buildEvidence({ rules: [appetite({ preferred_risks: ["transport fleet"] })] });
  const evidence = buildRecommendationEvidence({
    recommendationId: REC, submissionId: SUB, extractionId: EXT, reviewedAt: null, generatedAt: GENERATED,
    matcherVersion: MATCHER_VERSION, taxonomyVersion: TAXONOMY_VERSION, explanationMode: "deterministic",
    explanationSource: "deterministic", recommendationInputFingerprint: "fp", reviewed: reviewed(),
    matcherInput: matcherRisk, matcherResult: result, activeAppetite: [],
  });
  assert(evidence.quality.gaps.some((gap) => gap.code === "matched_rule_snapshot_missing" && gap.rule_id === "rule-1"), "broken linkage must be detected");
});

test("mutation guard: required-document evidence comes from matcher output, not reconstruction", () => {
  const { result, matcherRisk, rules } = buildEvidence({ rules: [appetite({ required_documents: ["Claims history"] })] });
  result.insurers[0].required_document_evidence = [];
  const evidence = buildRecommendationEvidence({
    recommendationId: REC, submissionId: SUB, extractionId: EXT, reviewedAt: null, generatedAt: GENERATED,
    matcherVersion: MATCHER_VERSION, taxonomyVersion: TAXONOMY_VERSION, explanationMode: "deterministic",
    explanationSource: "deterministic", recommendationInputFingerprint: "fp", reviewed: reviewed(),
    matcherInput: matcherRisk, matcherResult: result, activeAppetite: rules,
  });
  assert(!effects(evidence).includes("required_document_present"), "builder must not independently recreate matcher evidence");
});

test("mutation guard: builder rejects matcher rules that omit the authoritative effect", () => {
  const { result, matcherRisk, rules } = buildEvidence({ rules: [appetite({ preferred_risks: ["transport fleet"] })] });
  delete result.insurers[0].matched_rules[0].effect;
  let threw = false;
  try {
    buildRecommendationEvidence({
      recommendationId: REC, submissionId: SUB, extractionId: EXT, reviewedAt: null, generatedAt: GENERATED,
      matcherVersion: MATCHER_VERSION, taxonomyVersion: TAXONOMY_VERSION, explanationMode: "deterministic",
      explanationSource: "deterministic", recommendationInputFingerprint: "fp", reviewed: reviewed(),
      matcherInput: matcherRisk, matcherResult: result, activeAppetite: rules,
    });
  } catch (error) {
    threw = String((error as Error).message).startsWith("matcher_effect_missing:");
  }
  assert(threw, "missing matcher effect must fail closed");
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
console.log(`\nPhase 1A recommendation evidence: ${tests.length - failures} passed, ${failures} failed out of ${tests.length}`);
if (failures > 0) process.exitCode = 1;
