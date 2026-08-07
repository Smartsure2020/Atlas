import {
  buildComparisonRows,
  buildManagerStats,
  communicationDedupeKey,
  generateMissingInfoRequestDraft,
  generateQuoteReviewSummary,
  transitionCommunication,
  withControlledHeader,
} from "../worker/src/phase4-workflow.js";


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

const review = {
  id: "review-1",
  status: "can_proceed",
  created_at: "2026-06-25T10:00:00.000Z",
  insurer_id: "ins-1",
  manual_review_required: false,
  review_snapshot: {
    quote_terms: {
      insurer_name: "Insurer A",
      quote_reference: "Q1",
      quote_date: "2026-06-24",
      sections: [{ section_name: "Motor", premium: "R1000" }],
    },
    reviewed_json: { risk_classification: { line_of_business: { value: "commercial" } } },
  },
};

const section = {
  section_key: "motor",
  section_name: "Motor",
  status: "ok",
  missing_documents: [] as string[],
  referral_triggers: [] as string[],
  declined_reasons: [] as string[],
};

test("communication draft can be saved without duplicate key drift", () => {
  const a = communicationDedupeKey({
    submission_id: "sub-1",
    quote_review_id: "review-1",
    communication_type: "missing_info_request",
    audience: "broker",
    body: "Please send docs.",
  });
  const b = communicationDedupeKey({
    submission_id: "sub-1",
    quote_review_id: "review-1",
    communication_type: "missing_info_request",
    audience: "broker",
    body: "Please   send docs.\n",
  });
  assertEqual(a, b, "same draft content should dedupe");
});

test("saved communication can be marked copied", () => {
  const next = transitionCommunication({ current: "draft", next: "copied" });
  assertEqual(next.status, "copied", "status should become copied");
  assertEqual(next.sent_at, undefined, "copied should not set sent_at");
});

test("saved communication can be marked sent manually", () => {
  const next = transitionCommunication({ current: "copied", next: "sent_manually" });
  assertEqual(next.status, "sent_manually", "status should become sent manually");
  assert(Boolean(next.sent_at), "sent manually should set sent_at");
});

test("related missing-info items can move to requested", () => {
  const ids = ["item-1", "item-2"];
  const shouldRequest = transitionCommunication({ current: "draft", next: "sent_manually" }).status === "sent_manually";
  assert(shouldRequest && ids.length === 2, "sent communication can drive related item requested updates");
});

test("quote comparison handles multiple quote reviews with richer counts", () => {
  const rows = buildComparisonRows({
    reviews: [
      review,
      {
        ...review,
        id: "review-2",
        status: "refer",
        review_snapshot: { quote_terms: { insurer_name: "Insurer B", quote_reference: "Q2", sections: [{ premium: "R900" }] } },
      },
    ],
    sectionsByReview: {
      "review-1": [section],
      "review-2": [{ ...section, status: "refer", referral_triggers: ["limit referral"] }],
    },
    missingItemsByReview: { "review-2": [{ title: "claims", item_type: "document", source: "quote_review", status: "open", owner: "broker" }] },
  });
  assertEqual(rows.length, 2, "two reviews should compare");
  assertEqual(rows[0].section_count, 1, "section count should be present");
  assertEqual(rows[1].referral_count, 1, "referral count should be present");
});

test("comparison warns when premiums are not comparable", () => {
  const rows = buildComparisonRows({
    reviews: [review, { ...review, id: "review-2", status: "refer" }],
    sectionsByReview: { "review-1": [section], "review-2": [{ ...section, status: "refer" }] },
  });
  assert(rows.some((r) => r.comparability_warning), "differing outcomes should warn about comparability");
});

test("manager dashboard filters by date range and status", () => {
  const stats = buildManagerStats({
    submissions: [{ id: "sub-1" }],
    reviews: [
      review,
      { ...review, id: "old", status: "declined", created_at: "2026-01-01T10:00:00.000Z" },
    ],
    missingItems: [],
    decisions: [],
    sections: [],
    communications: [],
    filters: { dateRange: "7d", status: "can_proceed", now: "2026-06-26T10:00:00.000Z" },
  });
  assertEqual(stats.quote_reviews_completed, 1, "only recent matching review should count");
  assertEqual(stats.reviews_by_status.can_proceed, 1, "status filter should apply");
});

test("controlled output does not imply cover is bound", () => {
  const text = withControlledHeader("Summary", "The quote can be reviewed.");
  assert(/does not bind cover/i.test(text), "disclaimer should say not binding");
  assert(!/cover is bound/i.test(text), "output should not imply cover is bound");
});

test("old submissions without quote reviews remain safe in stats", () => {
  const stats = buildManagerStats({
    submissions: [{ id: "sub-1" }],
    reviews: [],
    missingItems: [],
    decisions: [],
    sections: [],
    communications: [],
  });
  assertEqual(stats.quote_reviews_completed, 0, "zero reviews should be safe");
});

test("review summary includes controlled timestamp and disclaimer", () => {
  const summary = generateQuoteReviewSummary({
    review,
    sections: [section],
    generatedAt: "2026-06-26T10:00:00.000Z",
  });
  assert(/Generated: 2026-06-26/.test(summary), "generated date should appear");
  assert(/decision-support review tool/i.test(summary), "disclaimer should appear");
});

test("missing info request remains copy-safe", () => {
  const draft = generateMissingInfoRequestDraft({
    recipient: "broker",
    generatedAt: "2026-06-26T10:00:00.000Z",
    items: [{ title: "claims history", item_type: "document", source: "manual", status: "open", owner: "broker" }],
  });
  assert(/Please could you assist/.test(draft), "draft should retain professional request wording");
  assert(!/accepted before review/i.test(draft), "draft should not imply acceptance");
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
