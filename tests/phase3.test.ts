import { buildQuoteReview } from "../worker/src/quote-review.js";
import type { AppetiteRow } from "../worker/src/matcher-types.js";
import { validateQuoteDecision } from "../worker/src/quote-decision.js";
import {
  evaluateDecisionGate,
  isRuledOutSelection,
  type RecommendationForGate,
} from "../worker/src/decision-rules.js";


const tests: { name: string; fn: () => void | Promise<void> }[] = [];

function test(name: string, fn: () => void | Promise<void>) {
  tests.push({ name, fn });
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEqual<T>(actual: T, expected: T, message: string) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

function field(value: unknown, confidence = 0.9) {
  return {
    value,
    status: value === null ? "not_found" : "extracted",
    confidence,
    source: { document_id: "doc-1", file_name: "quote.pdf", page: 1, section: "Schedule", snippet: null },
    notes: null,
  };
}

function reviewed(section: Record<string, unknown>) {
  return {
    extracted_client: {
      name: field("ABC Foods"),
      entity_type: field("Company"),
      registration_or_id_number: field(null, 0),
      occupation_or_business_description: field("Restaurant and delivery fleet"),
      contact_details: field(null, 0),
      risk_address: field("1 Main Road"),
    },
    broker: { name: field("Broker"), email: field("b@example.com"), brokerage: field("Brokerage") },
    current_cover: {
      current_insurer: field("Insurer"),
      renewal_date: field("2026-07-01"),
      current_premium: field("R10,000"),
      cover_sections: field([]),
      sums_insured: field([]),
      excesses: field([]),
      warranties: field([]),
      endorsements: field([]),
      exclusions: field([]),
      required_documents: field([]),
    },
    risk_classification: {
      primary_risk_type: field("Commercial"),
      product_line: field("commercial_motor"),
      risk_type: field("transport"),
      secondary_risk_types: field([]),
      business_sector: field("Restaurant"),
      complexity_level: field("medium"),
    },
    claims: {
      claims_history_available: field(false),
      claims_summary: field(null, 0),
      loss_ratio_available: field(false),
    },
    quote_terms: {
      insurer_name: field("Test Insurer"),
      quote_reference: field("Q-123"),
      quote_date: field("2026-06-20"),
      quote_expiry_date: field("2026-07-20"),
      insured_name: field("ABC Foods"),
      risk_address: field("1 Main Road"),
      sections: field([section]),
      required_documents: field([]),
      notes: field([]),
    },
    assumptions: [],
    conflicts: [],
    missing_information: [],
    red_flags: [],
    document_notes: [],
    overall_confidence: 0.8,
  };
}

function rule(overrides: Partial<AppetiteRow> = {}): AppetiteRow {
  return {
    id: overrides.id ?? "rule-1",
    insurer_id: overrides.insurer_id ?? "ins-1",
    insurer_name: overrides.insurer_name ?? "Test Insurer",
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
    source_document_id: null,
    is_active: true,
    ...overrides,
  };
}

function section(overrides: Record<string, unknown> = {}) {
  return {
    section_name: "Commercial Motor",
    section_key: "commercial_motor",
    sum_insured: "R500,000",
    premium: "R5,000",
    rate: "1.0%",
    excess: "R5,000",
    warranties: [],
    endorsements: [],
    exclusions: [],
    conditions: [],
    required_documents: [],
    notes: [],
    ...overrides,
  };
}

test("quote review can be created from reviewed extraction and appetite", () => {
  const result = buildQuoteReview({
    reviewed: reviewed(section()),
    appetite: [rule()],
    availableDocuments: [],
  });
  assertEqual(result.sections.length, 1, "one quote section should be reviewed");
  assertEqual(result.sections[0].status, "caution", "restaurant mismatch caution should be surfaced");
  assert(result.quote_terms.quote_reference === "Q-123", "quote reference should be snapshottable");
});

test("section above underwriting limit becomes refer", () => {
  const result = buildQuoteReview({
    reviewed: reviewed(section({ sum_insured: "R2,000,000" })),
    appetite: [rule({ referral_triggers: ["sum insured over R1,000,000"] })],
    availableDocuments: [],
  });
  assertEqual(result.sections[0].status, "refer", "limit breach should refer");
  assertEqual(result.status, "refer", "overall outcome should refer");
});

test("declined issue makes overall outcome declined", () => {
  const result = buildQuoteReview({
    reviewed: reviewed(section({ exclusions: ["hire and reward"] })),
    appetite: [rule({ declined_risks: ["hire and reward"] })],
    availableDocuments: [],
  });
  assertEqual(result.sections[0].status, "declined", "declined issue should decline section");
  assertEqual(result.status, "declined", "overall outcome should be declined");
});

test("missing required document becomes info_required", () => {
  const result = buildQuoteReview({
    reviewed: reviewed(section()),
    appetite: [rule({ required_documents: ["claims history"] })],
    availableDocuments: [],
  });
  assertEqual(result.sections[0].status, "info_required", "missing required document should require info");
});

test("missing matched product rule remains insufficient_rule_match", () => {
  const result = buildQuoteReview({
    reviewed: reviewed(section({ section_name: "Cyber", section_key: "cyber" })),
    appetite: [rule()],
    availableDocuments: [],
  });
  assertEqual(result.sections[0].status, "insufficient_rule_match", "unmatched section should remain insufficient");
  assertEqual(result.status, "review_required", "overall outcome should require review");
});

test("portfolio/global rules cannot make an unmatched section pass", () => {
  const result = buildQuoteReview({
    reviewed: reviewed(section({ section_name: "Cyber", section_key: "cyber" })),
    appetite: [rule({ product_line: "*", risk_type: "*", referral_triggers: ["sum insured over R10,000,000"] })],
    availableDocuments: [],
  });
  assertEqual(result.sections[0].status, "insufficient_rule_match", "portfolio-only rules should not pass unmatched section");
});

test("rate validation returns unable_to_validate_rate if data is incomplete", () => {
  const result = buildQuoteReview({
    reviewed: reviewed(section({ rate: null })),
    appetite: [rule({ rating_notes: "Expected rate 1% to 2%" })],
    availableDocuments: [],
  });
  assert(result.sections[0].rating_findings.some((x) => x.includes("unable_to_validate_rate")), "missing rate should be flagged");
});

test("rate outside expected band flags rating_review_required", () => {
  const result = buildQuoteReview({
    reviewed: reviewed(section({ rate: "3.5%" })),
    appetite: [rule({ rating_notes: "Expected rate 1% to 2%" })],
    availableDocuments: [],
  });
  assert(result.sections[0].rating_findings.some((x) => x.includes("rating_review_required")), "outside rate should be flagged");
});

test("missing warranty or endorsement is flagged", () => {
  const result = buildQuoteReview({
    reviewed: reviewed(section({ warranties: [] })),
    appetite: [rule({ caution_risks: ["alarm warranty"] })],
    availableDocuments: [],
  });
  assert(result.sections[0].warranty_findings.some((x) => x.includes("alarm warranty")), "missing warranty should be flagged");
});

test("section written in isolation is flagged where applicable", () => {
  const result = buildQuoteReview({
    reviewed: reviewed(section({ section_name: "Public Liability", section_key: "public_liability" })),
    appetite: [rule({ product_line: "public_liability", risk_type: "liability" })],
    availableDocuments: [],
  });
  assert(result.sections[0].findings.some((x) => x.includes("isolation")), "isolation warning should be flagged");
});

test("consultant override requires a reason", () => {
  const blocked = validateQuoteDecision({
    quoteReviewStatus: "declined",
    decisionChoice: "proceed",
    decisionStatus: "ready_for_quote",
  });
  assertEqual(blocked, "declined_override_reason_required", "declined proceed should require reason");
  const allowed = validateQuoteDecision({
    quoteReviewStatus: "declined",
    decisionChoice: "override",
    decisionStatus: "ready_for_quote",
    decisionReason: "Manager approved after referral.",
  });
  assertEqual(allowed, null, "reasoned override should pass");
});

test("manual referral requires a decision reason regardless of quote review status", () => {
  const blocked = validateQuoteDecision({
    quoteReviewStatus: "info_required",
    decisionChoice: "refer",
    decisionStatus: "referred",
  });
  assertEqual(blocked, "referral_notes_required", "referral without a reason should be blocked");

  const allowed = validateQuoteDecision({
    quoteReviewStatus: "info_required",
    decisionChoice: "refer",
    decisionStatus: "referred",
    decisionReason: "Senior underwriting authority required.",
  });
  assertEqual(allowed, null, "referral with a reason should pass");
});

test("declines and overrides require a decision reason", () => {
  assertEqual(
    validateQuoteDecision({ quoteReviewStatus: "info_required", decisionChoice: "decline", decisionStatus: "closed" }),
    "declined_reason_required",
    "decline without a reason should be blocked"
  );
  assertEqual(
    validateQuoteDecision({ quoteReviewStatus: "info_required", decisionChoice: "override", decisionStatus: "ready_for_quote" }),
    "override_reason_required",
    "override without a reason should be blocked"
  );
});

// ---- Decision gate: ruled-out override enforcement (server-resolved) ----

const gateRecommendation: RecommendationForGate = {
  id: "rec-1",
  recommended_insurer: "Good Insurer",
  not_recommended_json: [
    { insurer_id: "ins-x", insurer_name: "Ruled Out Insurer" },
  ],
};

test("consultant cannot select a ruled-out insurer even without recommendation_id", () => {
  // The server resolves the latest recommendation itself; a client omitting
  // recommendation_id must still hit the manager-only gate.
  const result = evaluateDecisionGate({
    decisionChoice: "override",
    decisionStatus: "ready_for_quote",
    selectedInsurer: "Ruled Out Insurer",
    recommendation: gateRecommendation,
    canManage: false,
  });
  assert(!result.ok && result.error === "ruled_out_override_forbidden", "bypass via omitted recommendation_id must be closed");
});

test("consultant is blocked when recommendation is supplied explicitly", () => {
  const result = evaluateDecisionGate({
    decisionChoice: "override",
    selectedInsurer: "ruled out insurer",
    recommendation: gateRecommendation,
    canManage: false,
  });
  assert(!result.ok && result.error === "ruled_out_override_forbidden", "existing explicit path must stay blocked");
});

test("manager may override to a ruled-out insurer and it is flagged", () => {
  const result = evaluateDecisionGate({
    decisionChoice: "override",
    selectedInsurer: "Ruled Out Insurer",
    recommendation: gateRecommendation,
    canManage: true,
  });
  assert(result.ok && result.ruledOutOverride === true, "manager override should pass and be flagged for audit");
});

test("ruled-out match works by insurer_id when names differ", () => {
  assert(
    isRuledOutSelection(gateRecommendation, "Renamed Insurer", "ins-x"),
    "id match should catch a renamed insurer"
  );
  assert(
    !isRuledOutSelection(gateRecommendation, "Some Other Insurer", "ins-y"),
    "non-ruled-out id and name should not match"
  );
  assert(
    isRuledOutSelection(gateRecommendation, "  RULED OUT INSURER  ", null),
    "name match should be case/whitespace insensitive when no id is present"
  );
});

test("proceeding with an insurer requires a recommendation to exist", () => {
  const result = evaluateDecisionGate({
    decisionChoice: "proceed",
    decisionStatus: "ready_for_quote",
    selectedInsurer: "Any Insurer",
    recommendation: null,
    canManage: false,
  });
  assert(!result.ok && result.error === "recommendation_required", "proceed without any recommendation must be refused");
});

test("close-out decisions remain valid without a recommendation", () => {
  for (const decisionChoice of ["decline", "request_info", "refer"]) {
    const result = evaluateDecisionGate({
      decisionChoice,
      decisionStatus: decisionChoice === "refer" ? "referred" : "closed",
      selectedInsurer: null,
      recommendation: null,
      canManage: false,
    });
    assert(result.ok, `${decisionChoice} without a recommendation should still be allowed`);
  }
});

test("accepted flag cannot smuggle a ruled-out selection past the gate", () => {
  // ai_recommendation_accepted is a client claim; the matcher's top pick is
  // never ruled out, so a ruled-out selection is an override by definition.
  const result = evaluateDecisionGate({
    decisionChoice: "proceed",
    selectedInsurer: "Ruled Out Insurer",
    recommendation: gateRecommendation,
    canManage: false,
  });
  assert(!result.ok && result.error === "ruled_out_override_forbidden", "spoofed accept must not skip the gate");
});

test("quote review result contains snapshot-ready quote terms", () => {
  const result = buildQuoteReview({
    reviewed: reviewed(section()),
    appetite: [rule()],
    availableDocuments: [],
  });
  assert(result.quote_terms.sections.length === 1, "quote terms should include sections for snapshot storage");
  const evidence = result.sections[0].source_evidence as { rule?: { id?: string } };
  assert(evidence.rule?.id === "rule-1", "source evidence should include matched rule");
});

let failures = 0;
for (const t of tests) {
  try {
    await t.fn();
    console.log(`ok - ${t.name}`);
  } catch (err) {
    failures++;
    console.error(`not ok - ${t.name}`);
    console.error((err as Error).message);
  }
}

if (failures > 0) {
  process.exitCode = 1;
}
