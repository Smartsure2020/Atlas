/**
 * Phase 2 accuracy suite — false-positive regression tests.
 * These encode the matching fixes: token-based taxonomy (no substring
 * landmines), token-based feature matching, AI-inferred red flags never
 * hard-ruling insurers out, no_data_for completeness, and insurer-scoped
 * quote-review rule selection.
 */

import {
  insurersWithoutActiveRules,
  matchInsurers,
  type MatchInputRisk,
} from "../worker/src/matcher.js";
import { canonicalTaxonomyKey, taxonomyKeysRelated } from "../worker/src/taxonomy.js";
import { buildQuoteReview } from "../worker/src/quote-review.js";
import type { AppetiteRow } from "../worker/src/matcher-types.js";

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

// ---------------------------------------------------------------------------
// Taxonomy: short aliases and substrings must not misclassify
// ---------------------------------------------------------------------------

test("short aliases no longer hijack unrelated words", () => {
  assertEqual(canonicalTaxonomyKey("Storage"), "storage", "'storage' must not become sectional title via 'st'");
  assertEqual(canonicalTaxonomyKey("Digital marketing"), "digital_marketing", "'digital' must not become goods in transit via 'git'");
  assertEqual(canonicalTaxonomyKey("Coffee"), "coffee", "'coffee' must not become electronic equipment via 'ee'");
  assertEqual(canonicalTaxonomyKey("Barn storage"), "barn_storage", "'barn' must not become business all risks via 'bar'");
});

test("short aliases still work as exact values", () => {
  assertEqual(canonicalTaxonomyKey("BAR"), "business_all_risks", "exact 'BAR' should still map");
  assertEqual(canonicalTaxonomyKey("ST"), "sectional_title", "exact 'ST' should still map");
  assertEqual(canonicalTaxonomyKey("GIT"), "goods_in_transit", "exact 'GIT' should still map");
  assertEqual(canonicalTaxonomyKey("EE"), "electronic_equipment", "exact 'EE' should still map");
});

test("word-boundary aliases match whole tokens, not substrings", () => {
  assertEqual(canonicalTaxonomyKey("Fire"), "buildings", "'fire' alias should still map to buildings");
  assertEqual(canonicalTaxonomyKey("Fire and allied perils"), "buildings", "'fire' as a token should map");
  assertEqual(canonicalTaxonomyKey("Misfire prevention"), "misfire_prevention", "'misfire' must not match the 'fire' alias");
});

test("most specific alias wins when several match", () => {
  assertEqual(
    canonicalTaxonomyKey("Motor Commercial (3 vehicles - LDVs)"),
    "commercial_motor",
    "multi-token 'commercial motor' should beat single-token 'motor'"
  );
  assertEqual(canonicalTaxonomyKey("Office Contents"), "contents", "office contents should map to contents");
});

test("canonical keys relate by token containment, not substring", () => {
  assert(taxonomyKeysRelated("motor", "commercial_motor"), "motor should relate to commercial_motor");
  assert(taxonomyKeysRelated("buildings", "buildings"), "equal keys relate");
  assert(!taxonomyKeysRelated("risk", "business_all_risks"), "'risk' must not relate to business_all_risks");
  assert(!taxonomyKeysRelated("st", "storage"), "'st' must not relate to 'storage'");
});

// ---------------------------------------------------------------------------
// Matcher features: token matching + AI-inferred red-flag handling
// ---------------------------------------------------------------------------

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

function risk(overrides: Partial<MatchInputRisk> = {}): MatchInputRisk {
  return {
    product_candidates: ["commercial vehicle"],
    section_candidates: ["commercial vehicle"],
    risk_candidates: ["transport"],
    features: [],
    available_documents: [],
    overall_confidence: 0.82,
    ...overrides,
  };
}

test("declined term must not match inside an unrelated word", () => {
  const result = matchInsurers(
    risk({ features: [{ text: "annual warranty maintenance services", source: "endorsements" }] }),
    [appetite({ declined_risks: ["war"] })]
  );
  assertEqual(result.insurers[0].ruled_out, false, "'war' must not rule out via 'warranty'");
});

test("document-derived declined match still hard-rules the insurer out", () => {
  const result = matchInsurers(
    risk({ features: [{ text: "thatch roof lapa on premises", source: "occupation/business description" }] }),
    [appetite({ declined_risks: ["thatch"] })]
  );
  assertEqual(result.insurers[0].ruled_out, true, "document-backed declined term should rule out");
  assert(
    result.insurers[0].scoring_notes.some((n) => n.includes("occupation/business description")),
    "rule-out note should show which field matched"
  );
});

test("AI-inferred red flag alone downgrades to referral, never rules out", () => {
  const result = matchInsurers(
    risk({ features: [{ text: "possible asbestos roof sheeting", source: "red flag", ai_inferred: true }] }),
    [appetite({ declined_risks: ["asbestos"] })]
  );
  const top = result.insurers[0];
  assertEqual(top.ruled_out, false, "AI-only red flag must not hard-rule out");
  assertEqual(top.referral_required, true, "AI-only declined match should force referral");
  assert(
    top.scoring_notes.some((n) => n.includes("human confirmation")),
    "note should say human confirmation is needed"
  );
});

test("declined term backed by BOTH a document field and a red flag still rules out", () => {
  const result = matchInsurers(
    risk({
      features: [
        { text: "thatch construction noted", source: "exclusions" },
        { text: "thatch fire exposure", source: "red flag", ai_inferred: true },
      ],
    }),
    [appetite({ declined_risks: ["thatch"] })]
  );
  assertEqual(result.insurers[0].ruled_out, true, "document evidence still rules out despite red-flag overlap");
});

test("plural folding matches vehicle/vehicles both ways", () => {
  const result = matchInsurers(
    risk({ features: [{ text: "delivery vehicles operating nationally", source: "cover sections" }] }),
    [appetite({ caution_risks: ["delivery vehicle"] })]
  );
  assert(
    result.insurers[0].scoring_notes.some((n) => n.includes("delivery vehicle")),
    "singular rule term should match plural feature text"
  );
});

test("legacy plain-string features still work", () => {
  const result = matchInsurers(
    risk({ features: ["transport fleet", "sum insured > R5m"] }),
    [appetite({ referral_triggers: ["sum insured > R5m"] })]
  );
  assertEqual(result.insurers[0].referral_required, true, "string features remain supported");
});

// ---------------------------------------------------------------------------
// no_data_for completeness
// ---------------------------------------------------------------------------

test("insurers without any active rules are surfaced, not hidden", () => {
  const missing = insurersWithoutActiveRules(
    [
      { id: "ins-1", name: "Has Rules" },
      { id: "ins-2", name: "No Rules Yet" },
    ],
    [{ insurer_id: "ins-1" }]
  );
  assertEqual(missing.length, 1, "exactly one insurer lacks rules");
  assertEqual(missing[0].insurer_name, "No Rules Yet", "the ruleless insurer should be named");
});

// ---------------------------------------------------------------------------
// Quote review rule selection: risk-type preference + ambiguity reporting
// ---------------------------------------------------------------------------

function field(value: unknown, confidence = 0.9) {
  return {
    value,
    status: value === null ? "not_found" : "extracted",
    confidence,
    source: { document_id: "doc-1", file_name: "quote.pdf", page: 1, section: "Schedule", snippet: null },
    notes: null,
  };
}

function reviewedWithRiskType(riskType: string) {
  return {
    extracted_client: {
      name: field("Body Corporate of Test"),
      entity_type: field("Body Corporate"),
      registration_or_id_number: field(null, 0),
      occupation_or_business_description: field("Residential scheme"),
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
      primary_risk_type: field(riskType),
      product_line: field("buildings"),
      risk_type: field(riskType),
      secondary_risk_types: field([]),
      business_sector: field("Property"),
      complexity_level: field("medium"),
    },
    claims: {
      claims_history_available: field(false),
      claims_summary: field(null, 0),
      loss_ratio_available: field(false),
    },
    quote_terms: {
      insurer_name: field("Test Insurer"),
      quote_reference: field("Q-1"),
      quote_date: field("2026-06-20"),
      quote_expiry_date: field("2026-07-20"),
      insured_name: field("Body Corporate of Test"),
      risk_address: field("1 Main Road"),
      sections: field([
        { section_name: "Buildings", section_key: "buildings", sum_insured: "R5,000,000", excess: "R1,000" },
      ]),
      required_documents: field([]),
      notes: field([]),
    },
    assumptions: [],
    conflicts: [],
    missing_information: [],
    red_flags: [],
    document_notes: [],
    overall_confidence: 0.8,
  } as Record<string, unknown>;
}

const buildingsBodyCorpRule = appetite({
  id: "rule-bc",
  product_line: "buildings",
  risk_type: "body_corporate",
});
const buildingsCommercialRule = appetite({
  id: "rule-comm",
  product_line: "buildings",
  risk_type: "commercial_building",
});

test("quote review picks the risk-type-compatible rule among same-product rules", () => {
  const result = buildQuoteReview({
    reviewed: reviewedWithRiskType("body corporate"),
    appetite: [buildingsCommercialRule, buildingsBodyCorpRule],
    availableDocuments: [],
  });
  assertEqual(result.sections[0].matched_rule_id, "rule-bc", "body-corporate rule should be preferred");
  assert(
    !result.sections[0].findings.some((f) => f.includes("Multiple appetite rules")),
    "a clean risk-type discriminator should not be flagged ambiguous"
  );
});

test("quote review reports ambiguity when no rule discriminates", () => {
  const result = buildQuoteReview({
    reviewed: reviewedWithRiskType("transport"),
    appetite: [buildingsBodyCorpRule, buildingsCommercialRule],
    availableDocuments: [],
  });
  assert(
    result.sections[0].findings.some((f) => f.includes("Multiple appetite rules")),
    "ambiguous rule choice must be surfaced to the consultant"
  );
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
