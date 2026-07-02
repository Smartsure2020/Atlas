import {
  buildComparisonRows,
  buildManagerStats,
  generateMissingInfoRequestDraft,
  generateQuoteReviewSummary,
  generateReferralPack,
  missingInfoFromQuoteReview,
  validateMissingInfoStatusUpdate,
  type MissingInfoItem,
} from "../worker/src/phase4-workflow.js";

declare const process: { exitCode?: number };

const tests: { name: string; fn: () => void | Promise<void> }[] = [];

function test(name: string, fn: () => void | Promise<void>) {
  tests.push({ name, fn });
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEqual<T>(actual: T, expected: T, message: string) {
  if (actual !== expected) throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
}

const section = {
  section_key: "commercial_motor",
  section_name: "Commercial Motor",
  matched_rule_id: "rule-1",
  status: "refer",
  findings: ["Sum insured or cover limit is missing or unclear."],
  missing_documents: ["claims history"],
  referral_triggers: ["sum insured over R1,000,000"],
  declined_reasons: [],
  rating_findings: ["unable_to_validate_rate: rating note exists but quoted rate is missing or unclear."],
  excess_findings: [],
  warranty_findings: ["Missing or unclear warranty/endorsement: alarm warranty"],
  source_evidence: { rule: { source_quote: "refer above R1m", source_file_name: "guide.pdf" } },
};

function item(overrides: Partial<MissingInfoItem> = {}): MissingInfoItem {
  return {
    id: overrides.id ?? "item-1",
    quote_review_id: overrides.quote_review_id ?? "review-1",
    section_key: overrides.section_key ?? "commercial_motor",
    item_type: overrides.item_type ?? "document",
    title: overrides.title ?? "claims history",
    description: overrides.description ?? "Required for Commercial Motor.",
    status: overrides.status ?? "open",
    source: overrides.source ?? "quote_review",
    owner: overrides.owner ?? "broker",
    ...overrides,
  };
}

const review = {
  id: "review-1",
  status: "refer",
  created_at: "2026-06-26T10:00:00.000Z",
  recommendation_id: "rec-1",
  insurer_id: "ins-1",
  review_snapshot: {
    quote_terms: {
      insurer_name: "Test Insurer",
      quote_reference: "Q-123",
      quote_date: "2026-06-25",
      sections: [{ section_name: "Commercial Motor", premium: "R1,200" }],
    },
  },
};

test("missing-info items generated from quote review findings", () => {
  const items = missingInfoFromQuoteReview({
    submissionId: "sub-1",
    quoteReviewId: "review-1",
    sections: [section],
    extractionMissing: [{ field: "driver details", reason_required: "Needed for rating" }],
  });
  assert(items.some((i) => i.title === "claims history" && i.item_type === "document"), "missing doc should become item");
  assert(items.some((i) => i.title === "driver details" && i.source === "extraction"), "extraction missing info should become item");
  assert(items.some((i) => i.description?.includes("unable_to_validate_rate")), "unclear rate should become item");
});

test("manual missing-info item can be represented", () => {
  const manual = item({ title: "Manual note", source: "manual", item_type: "other" });
  assertEqual(manual.source, "manual", "manual source should be preserved");
  assertEqual(manual.status, "open", "manual item starts open");
});

test("waiver and not-required require notes", () => {
  assertEqual(validateMissingInfoStatusUpdate({ status: "waived" }), "notes_required", "waiver should require notes");
  assertEqual(validateMissingInfoStatusUpdate({ status: "not_required", notes: "Confirmed not required" }), null, "note should allow not required");
});

test("broker request draft groups items by section", () => {
  const draft = generateMissingInfoRequestDraft({
    recipient: "broker",
    items: [item(), item({ id: "item-2", section_key: null, item_type: "quote_term", title: "Sum insured", description: "Please confirm" })],
  });
  assert(/Commercial Motor/i.test(draft) || /commercial motor/i.test(draft), "section should appear");
  assert(/General/.test(draft), "general group should appear");
  assert(/Documents:/.test(draft), "documents group should appear");
});

test("request draft does not imply cover is accepted", () => {
  const draft = generateMissingInfoRequestDraft({ recipient: "client", items: [item()] });
  assert(!/cover is accepted/i.test(draft), "draft should not promise cover accepted");
  assert(/does not confirm/i.test(draft), "draft should include no-acceptance wording");
});

test("referral pack includes triggers and rule evidence", () => {
  const draft = generateReferralPack({ review, sections: [section], missingItems: [item()] });
  assert(/sum insured over R1,000,000/.test(draft), "referral trigger should appear");
  assert(/refer above R1m/.test(draft), "rule evidence should appear");
  assert(/does not bind cover/i.test(draft), "pack should not bind cover");
});

test("quote review summary includes overall and section outcomes", () => {
  const summary = generateQuoteReviewSummary({
    review,
    sections: [section],
    decision: { decision_choice: "refer", decision_reason: "Senior review required" },
  });
  assert(/Overall result: refer/.test(summary), "overall status should appear");
  assert(/Commercial Motor: refer/.test(summary), "section outcome should appear");
  assert(/Decision: refer/.test(summary), "decision should appear");
});

test("old quote reviews remain visible in comparison input", () => {
  const rows = buildComparisonRows({
    reviews: [review, { ...review, id: "review-2", status: "can_proceed", created_at: "2026-06-27T10:00:00.000Z" }],
    sectionsByReview: { "review-1": [section], "review-2": [] },
  });
  assertEqual(rows.length, 2, "both reviews should remain visible");
});

test("comparison table supports multiple quote reviews", () => {
  const rows = buildComparisonRows({
    reviews: [review, { ...review, id: "review-2", review_snapshot: { quote_terms: { insurer_name: "Other", quote_reference: "Q-2", sections: [{ premium: "R900" }] } } }],
    sectionsByReview: { "review-1": [section], "review-2": [] },
    decisionsByReview: { "review-1": { decision_choice: "refer" } },
  });
  assertEqual(rows[0].total_premium, 1200, "premium should parse");
  assertEqual(rows[0].major_issue_count, 2, "major issues should count missing and referral");
  assertEqual(rows[0].decision, "refer", "decision should be surfaced");
});

test("manager stats count reviews by status", () => {
  const stats = buildManagerStats({
    submissions: [{ id: "sub-1" }, { id: "sub-2" }],
    reviews: [review, { ...review, id: "review-2", status: "declined" }],
    missingItems: [item(), item({ id: "item-2", status: "received" })],
    decisions: [{ decision_choice: "override" }, { ai_recommendation_accepted: true }],
    sections: [section, { ...section, declined_reasons: ["excluded risk"], referral_triggers: [] }],
  });
  assertEqual(stats.total_submissions, 2, "submissions should count");
  assertEqual(stats.reviews_by_status.refer, 1, "refer status should count");
  assertEqual(stats.reviews_by_status.declined, 1, "declined status should count");
  assertEqual(stats.missing_info_open_count, 1, "open missing info should count");
  assertEqual(stats.overrides_count, 1, "overrides should count");
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

if (failures > 0) process.exitCode = 1;
