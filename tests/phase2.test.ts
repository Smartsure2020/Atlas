import { matchInsurers, type MatchInputRisk } from "../worker/src/matcher.js";
import type { AppetiteRow } from "../worker/src/matcher-types.js";
import { canonicalTaxonomyKey } from "../worker/src/taxonomy.js";
import { validateIngestion } from "../worker/src/appetite-ingestion.js";

declare const process: { exitCode?: number };

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

function risk(overrides: Partial<MatchInputRisk> = {}): MatchInputRisk {
  return {
    product_candidates: ["commercial vehicle"],
    section_candidates: ["commercial vehicle"],
    risk_candidates: ["transport"],
    features: ["transport fleet", "sum insured > R5m"],
    available_documents: ["claims history"],
    overall_confidence: 0.82,
    ...overrides,
  };
}

function appetite(overrides: Partial<AppetiteRow> = {}): AppetiteRow {
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

test("taxonomy aliases normalize to canonical keys", () => {
  assertEqual(canonicalTaxonomyKey("G&T"), "public_liability", "G&T should map to public liability");
  assertEqual(canonicalTaxonomyKey("commercial vehicle"), "commercial_motor", "commercial vehicle should map to commercial motor");
});

test("alias candidates still match existing appetite rows", () => {
  const result = matchInsurers(risk(), [appetite()]);
  assertEqual(result.insurers[0].band, "standard", "commercial vehicle should match commercial_motor");
  assertEqual(result.insurers[0].manual_review_required, false, "valid product match should not require manual review");
});

test("no product match is marked insufficient and manual review", () => {
  const result = matchInsurers(
    risk({ product_candidates: ["cyber"], section_candidates: ["cyber"], risk_candidates: ["software"] }),
    [appetite()]
  );
  const top = result.insurers[0];
  assertEqual(top.band, "insufficient_rule_match", "no product match should not become standard baseline");
  assertEqual(top.manual_review_required, true, "no product match should require manual review");
  assert(top.unmatched_sections.includes("cyber"), "unmatched section should be surfaced");
});

test("portfolio overlay cannot rescue a missing product match", () => {
  const result = matchInsurers(
    risk({ product_candidates: ["cyber"], section_candidates: ["cyber"], risk_candidates: ["software"] }),
    [
      appetite({ id: "portfolio", product_line: "*", risk_type: "*", referral_triggers: ["sum insured > R5m"] }),
    ]
  );
  const top = result.insurers[0];
  assertEqual(top.band, "insufficient_rule_match", "portfolio-only match should remain insufficient");
  assertEqual(top.manual_review_required, true, "portfolio-only match should require manual review");
  assertEqual(top.referral_required, true, "portfolio referral trigger should still be recorded");
});

test("declined appetite remains ruled out", () => {
  const result = matchInsurers(risk(), [appetite({ appetite_level: "declined" })]);
  assertEqual(result.insurers[0].band, "ruled_out", "declined appetite should rule out insurer");
  assertEqual(result.insurers[0].rule_status, "ruled_out", "declined appetite should carry ruled_out status");
});

test("referral triggers remain referral status", () => {
  const result = matchInsurers(risk(), [appetite({ referral_triggers: ["sum insured > R5m"] })]);
  assertEqual(result.insurers[0].referral_required, true, "referral trigger should be captured");
  assertEqual(result.insurers[0].rule_status, "referral", "referral trigger should set referral rule status");
});

test("preferred risks do not become required documents", () => {
  const result = matchInsurers(
    risk({ features: ["fleet"], available_documents: [] }),
    [appetite({ preferred_risks: ["fleet"], required_documents: [] })]
  );
  assertEqual(result.insurers[0].missing_required_documents.length, 0, "preferred risk should not create document gaps");
});

test("source evidence is preserved in matched rule refs", () => {
  const result = matchInsurers(risk(), [
    appetite({
      source_quote: "commercial vehicles accepted",
      source_page: 4,
      source_section: "Motor",
      source_file_name: "guide.pdf",
      ingestion_confidence: 0.91,
    }),
  ]);
  const base = result.insurers[0].matched_rules.find((m) => m.list === "base");
  assert(base, "base rule should be present");
  assertEqual(base.source_quote, "commercial vehicles accepted", "source quote should be carried forward");
  assertEqual(base.source_page, 4, "source page should be carried forward");
});

test("ingestion validator preserves nullable evidence fields", () => {
  const validated = validateIngestion({
    insurer_summary: "Commercial motor focus.",
    rules: [
      {
        product_line: "commercial_motor",
        risk_type: "transport",
        appetite_level: "standard",
        preferred_risks: [],
        caution_risks: [],
        declined_risks: [],
        required_documents: [],
        referral_triggers: [],
        notes: "Manager review needed.",
        rating_notes: "Higher excess for heavy vehicles.",
        line_of_business: "commercial",
        source_quote: null,
        source_page: null,
        source_section: "Motor",
        confidence: 0.62,
      },
    ],
    document_notes: [],
  });
  assert(validated, "ingestion should validate");
  assertEqual(validated.rules[0].source_quote, null, "null source quote should be preserved");
  assertEqual(validated.rules[0].line_of_business, "commercial", "line of business should be preserved");
  assertEqual(validated.rules[0].rating_notes, "Higher excess for heavy vehicles.", "rating notes should be preserved");
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
