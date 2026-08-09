/**
 * Phase 10 (hybrid pipeline) — unit tests
 * ---------------------------------------------------------------------------
 * Covers the new architectural pieces that redirect Atlas away from
 * always-Sonnet:
 *   - Pipeline mode + stage vocabulary
 *   - Route classifier (from document quality → route)
 *   - Deterministic explanation composer (matcher output → prose)
 *   - Email templates + polish-verifier
 *   - Telemetry sanitizer (no PII leakage)
 *   - Azure error redaction
 *
 * Live-provider tests (real Azure Document Intelligence, real Anthropic) are
 * deliberately OMITTED — they require credentials that must never live in the
 * repo. See docs/CONFIGURING_PIPELINE.md for the opt-in integration flow.
 */

import {
  pipelineMode,
  azureConfigured,
  maxTextFastpathPages,
  explanationMode,
  emailMode,
  isValidStage,
  PIPELINE_STAGES,
} from "../worker/src/pipeline-mode.js";
import {
  classifyRoute,
  detectEscalationSignals,
  shouldEscalateToSonnet,
} from "../worker/src/pipeline-router.js";
import {
  classifyQuality,
  DEFAULT_QUALITY_THRESHOLDS,
} from "../worker/src/parser-local-pdf.js";
import { composeExplanation, verifyPolish } from "../worker/src/explanation-composer.js";
import { draftEmail, verifyEmailPolish } from "../worker/src/email-templates.js";
import { redactAzureError, azureConfigFromEnv } from "../worker/src/parser-azure.js";
import type { InsurerScore } from "../worker/src/matcher.js";
import type { CanonicalField, ParsedDocument, ParsedPage } from "../worker/src/pipeline-types.js";


const tests: { name: string; fn: () => void | Promise<void> }[] = [];
function test(name: string, fn: () => void | Promise<void>) { tests.push({ name, fn }); }
function assert(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }
function eq<T>(a: T, b: T, msg: string) { if (a !== b) throw new Error(`${msg}: expected ${String(b)}, got ${String(a)}`); }

// ---------------------------------------------------------------------------
// pipeline-mode
// ---------------------------------------------------------------------------

test("pipelineMode defaults to legacy when unset or unknown", () => {
  eq(pipelineMode({}), "legacy", "unset");
  eq(pipelineMode({ ATLAS_DOCUMENT_PIPELINE_MODE: "" }), "legacy", "empty");
  eq(pipelineMode({ ATLAS_DOCUMENT_PIPELINE_MODE: "gibberish" }), "legacy", "gibberish");
});

test("pipelineMode accepts hybrid and shadow", () => {
  eq(pipelineMode({ ATLAS_DOCUMENT_PIPELINE_MODE: "hybrid" }), "hybrid", "hybrid");
  eq(pipelineMode({ ATLAS_DOCUMENT_PIPELINE_MODE: "SHADOW" }), "shadow", "shadow caseless");
});

test("azureConfigured requires both endpoint and key", () => {
  eq(azureConfigured({}), false, "no config");
  eq(azureConfigured({ AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT: "x" }), false, "no key");
  eq(azureConfigured({ AZURE_DOCUMENT_INTELLIGENCE_KEY: "x" }), false, "no endpoint");
  eq(
    azureConfigured({
      AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT: "https://x",
      AZURE_DOCUMENT_INTELLIGENCE_KEY: "k",
    }),
    true,
    "both"
  );
});

test("maxTextFastpathPages has a safe default and honours override", () => {
  eq(maxTextFastpathPages({}), 40, "default");
  eq(maxTextFastpathPages({ ATLAS_HYBRID_MAX_TEXT_FASTPATH_PAGES: "12" }), 12, "override");
  eq(maxTextFastpathPages({ ATLAS_HYBRID_MAX_TEXT_FASTPATH_PAGES: "-1" }), 40, "invalid falls back");
});

test("explanationMode + emailMode default to safe values", () => {
  eq(explanationMode({}), "deterministic", "explanation default");
  eq(explanationMode({ ATLAS_EXPLANATION_MODE: "polish" }), "polish", "polish");
  eq(emailMode({}), "template", "email default");
  eq(emailMode({ ATLAS_EMAIL_MODE: "polish" }), "polish", "email polish");
  eq(emailMode({ ATLAS_EMAIL_MODE: "legacy" }), "legacy", "email legacy");
});

test("stage vocabulary is closed", () => {
  assert(isValidStage("extracting_pdf_text"), "known stage");
  assert(!isValidStage("random_thing"), "unknown stage");
  assert(PIPELINE_STAGES.length >= 10, "at least ten stages");
});

// ---------------------------------------------------------------------------
// azureConfigFromEnv
// ---------------------------------------------------------------------------

test("azureConfigFromEnv returns null when not configured", () => {
  eq(azureConfigFromEnv({}), null, "empty env");
  eq(azureConfigFromEnv({ AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT: "x" }), null, "no key");
});

test("azureConfigFromEnv trims trailing slashes on endpoint", () => {
  const cfg = azureConfigFromEnv({
    AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT: "https://x.cognitiveservices.azure.com/",
    AZURE_DOCUMENT_INTELLIGENCE_KEY: "abc",
  });
  assert(cfg, "cfg present");
  eq(cfg!.endpoint, "https://x.cognitiveservices.azure.com", "trimmed");
  eq(cfg!.apiKey, "abc", "key preserved");
  eq(cfg!.modelId, "prebuilt-layout", "default model");
});

// ---------------------------------------------------------------------------
// pipeline-router: classifyRoute
// ---------------------------------------------------------------------------

function fakeDoc(quality: ParsedDocument["quality"], pageCount = 3): ParsedDocument {
  const pages: ParsedPage[] = Array.from({ length: pageCount }, (_, i) => ({
    page: i + 1, text: quality === "text_clean" ? "some text ".repeat(50) : "", charCount: quality === "text_clean" ? 500 : 0,
  }));
  return {
    documentId: "d1",
    fileName: "test.pdf",
    pageCount,
    quality,
    fullText: pages.map((p) => p.text).join("\n"),
    pages,
    tables: [],
    keyValues: [],
    parserMeta: {
      parser: "test", parserVersion: "1", charsPerPage: 500,
      emptyPageRatio: 0, invalidCharRatio: 0, encrypted: false, parseMs: 1,
    },
  };
}

test("text_clean → text_fast_path", () => {
  const r = classifyRoute(fakeDoc("text_clean", 3), { azureConfigured: true, maxTextFastPathPages: 40 });
  eq(r.route, "text_fast_path", "route");
});

test("scanned → ocr_required when azure present, else legacy_full_sonnet", () => {
  const withAzure = classifyRoute(fakeDoc("scanned"), { azureConfigured: true, maxTextFastPathPages: 40 });
  eq(withAzure.route, "ocr_required", "with azure");
  const noAzure = classifyRoute(fakeDoc("scanned"), { azureConfigured: false, maxTextFastPathPages: 40 });
  eq(noAzure.route, "legacy_full_sonnet", "no azure");
});

test("encrypted always short-circuits", () => {
  const r = classifyRoute(fakeDoc("encrypted"), { azureConfigured: true, maxTextFastPathPages: 40 });
  eq(r.route, "encrypted", "route");
});

test("forceLegacy overrides everything", () => {
  const r = classifyRoute(fakeDoc("text_clean"), { azureConfigured: true, maxTextFastPathPages: 40, forceLegacy: true });
  eq(r.route, "legacy_full_sonnet", "forced");
});

test("clean text over page cap → large_model_fallback", () => {
  const r = classifyRoute(fakeDoc("text_clean", 100), { azureConfigured: true, maxTextFastPathPages: 40 });
  eq(r.route, "large_model_fallback", "route");
});

// ---------------------------------------------------------------------------
// pipeline-router: escalation signals
// ---------------------------------------------------------------------------

function field(v: unknown, confidence: number | null = null): CanonicalField {
  return {
    value: v, confidence,
    sourceDocumentId: null, sourcePage: null, sourceText: null,
    boundingRegion: null, extractionMethod: "test", warnings: [],
  };
}

test("missing critical field escalates", () => {
  const sig = detectEscalationSignals({
    "extracted_client.name": field(null),
    "risk_classification.primary_risk_type": field("commercial buildings"),
    "current_cover.cover_sections": field(["buildings"]),
    "current_cover.sums_insured": field(["R5m"]),
  });
  const dec = shouldEscalateToSonnet(sig);
  eq(dec.escalate, true, "should escalate");
  assert(dec.reason?.startsWith("missing_critical:"), "reason names field");
});

test("low provider confidence on a critical field escalates", () => {
  const sig = detectEscalationSignals({
    "extracted_client.name": field("Acme", 0.4),
    "risk_classification.primary_risk_type": field("x"),
    "current_cover.cover_sections": field(["y"]),
    "current_cover.sums_insured": field(["z"]),
  }, { providerConfidenceThreshold: 0.6 });
  const dec = shouldEscalateToSonnet(sig);
  eq(dec.escalate, true, "should escalate");
  eq(dec.reason, "low_provider_confidence", "reason");
});

test("unknown taxonomy value escalates", () => {
  const known = new Set(["buildings", "motor"]);
  const sig = detectEscalationSignals({
    "extracted_client.name": field("Acme"),
    "risk_classification.primary_risk_type": field("cyber"),
    "current_cover.cover_sections": field(["x"]),
    "current_cover.sums_insured": field(["y"]),
  }, { knownTaxonomyValues: known });
  const dec = shouldEscalateToSonnet(sig);
  eq(dec.escalate, true, "should escalate");
  eq(dec.reason, "unknown_taxonomy_value", "reason");
});

test("all critical fields present, no signals → no escalation", () => {
  const sig = detectEscalationSignals({
    "extracted_client.name": field("Acme", 0.9),
    "risk_classification.primary_risk_type": field("buildings", 0.9),
    "current_cover.cover_sections": field(["buildings"], 0.9),
    "current_cover.sums_insured": field(["R5m"], 0.9),
  }, { providerConfidenceThreshold: 0.6 });
  const dec = shouldEscalateToSonnet(sig);
  eq(dec.escalate, false, "no escalation");
});

// ---------------------------------------------------------------------------
// parser-local-pdf: classifier thresholds
// ---------------------------------------------------------------------------

test("classifyQuality flags encrypted first", () => {
  const cls = classifyQuality([], true, false);
  eq(cls.quality, "encrypted", "quality");
});

test("classifyQuality flags corrupt when parseError", () => {
  const cls = classifyQuality([], false, true);
  eq(cls.quality, "corrupt", "quality");
});

test("classifyQuality flags scanned when totalChars=0", () => {
  const pages: ParsedPage[] = [{ page: 1, text: "", charCount: 0 }, { page: 2, text: "", charCount: 0 }];
  const cls = classifyQuality(pages, false, false);
  eq(cls.quality, "scanned", "quality");
});

test("classifyQuality flags text_sparse below chars-per-page threshold", () => {
  const pages: ParsedPage[] = [{ page: 1, text: "abc", charCount: 3 }];
  const cls = classifyQuality(pages, false, false, DEFAULT_QUALITY_THRESHOLDS);
  eq(cls.quality, "text_sparse", "quality");
});

test("classifyQuality flags text_clean when text is dense and valid", () => {
  const text = "a".repeat(500);
  const pages: ParsedPage[] = [{ page: 1, text, charCount: text.length }];
  const cls = classifyQuality(pages, false, false);
  eq(cls.quality, "text_clean", "quality");
});

// ---------------------------------------------------------------------------
// explanation-composer
// ---------------------------------------------------------------------------

function ins(over: Partial<InsurerScore> = {}): InsurerScore {
  return {
    insurer_id: "i1",
    insurer_name: "CIB",
    score: 80,
    band: "preferred",
    rule_status: "preferred",
    confidence: 0.85,
    confidence_available: true,
    referral_required: false,
    manual_review_required: false,
    senior_review_required: false,
    ruled_out: false,
    scored_against_appetite_id: "a1",
    matched_rules: [{ appetite_id: "a1", list: "preferred", matched_strings: ["body corporate"] }],
    scoring_notes: [],
    missing_required_documents: [],
    unmatched_sections: [],
    unmatched_product_candidates: [],
    nearby_rule_matches: [],
    ...over,
  };
}

test("composeExplanation ranks top insurer in headline", () => {
  const e = composeExplanation([ins()]);
  assert(e.headline.includes("CIB"), `headline mentions CIB: ${e.headline}`);
  assert(e.headline.includes("80"), `headline mentions score`);
});

test("composeExplanation never omits referral flag", () => {
  const e = composeExplanation([ins({ referral_required: true })]);
  assert(/refer/i.test(e.headline + e.per_insurer[0].reasoning), "referral mentioned somewhere");
  eq(e.facts[0].referral, true, "fact recorded");
});

test("composeExplanation never omits missing-documents list", () => {
  const e = composeExplanation([ins({ missing_required_documents: ["proposal form", "3-year claims"] })]);
  assert(e.per_insurer[0].reasoning.includes("proposal form"), "doc mentioned");
  assert(e.per_insurer[0].reasoning.includes("3-year claims"), "doc mentioned");
});

test("composeExplanation covers ruled_out insurers", () => {
  const e = composeExplanation([ins({ ruled_out: true, band: "ruled_out" })]);
  assert(/ruled out/i.test(e.per_insurer[0].reasoning), "reasoning marks ruled_out");
  eq(e.facts[0].ruled_out, true, "fact recorded");
});

test("verifyPolish flags ranking change", () => {
  const base = composeExplanation([ins({ insurer_id: "a" }), ins({ insurer_id: "b" })]);
  const polished = {
    headline: "x",
    per_insurer: [
      { insurer_id: "b", reasoning: "..." },
      { insurer_id: "a", reasoning: "..." },
    ],
  };
  const problems = verifyPolish(base, polished, ["CIB"]);
  assert(problems.length > 0, "must flag");
  assert(problems.some((p) => p.startsWith("ranking_changed")), "specific tag");
});

test("verifyPolish flags dropped referral wording", () => {
  const base = composeExplanation([ins({ referral_required: true })]);
  const polished = {
    headline: base.headline,
    per_insurer: [{ insurer_id: "i1", reasoning: "CIB looks good on this one." }],
  };
  const problems = verifyPolish(base, polished, ["CIB"]);
  assert(problems.some((p) => p.startsWith("missing_referral_")), "flags referral drop");
});

// ---------------------------------------------------------------------------
// email-templates
// ---------------------------------------------------------------------------

const emailCtx = () => ({
  submission: { client_name: "Acme Ltd", broker_name: "Alex", broker_email: "a@b", request_type: "new_business" },
  reviewedExtraction: {
    risk_classification: { primary_risk_type: { value: "commercial buildings" } },
    current_cover: {
      cover_sections: { value: ["buildings", "SASRIA"] },
      sums_insured: { value: ["R 5,000,000"] },
      current_insurer: { value: "OldCo" },
    },
    extracted_client: { name: { value: "Acme Ltd" }, entity_type: { value: "Pty" } },
    claims: { claims_history_available: { value: "yes" }, claims_summary: { value: "clean" } },
  } as Record<string, unknown>,
  recommendation: { recommended_insurer: "CIB", referral_required: true, senior_review_required: false, reasoning_json: null, secondary_options_json: null },
  decision: null,
  missingInformation: [{ field: "proposal_form", priority: "high", reason_required: "required by CIB" }],
  redFlags: [{ issue: "buildings SI exceeds standard authority", severity: "high" }],
});

test("broker_missing_info lists every missing item", () => {
  const d = draftEmail("broker_missing_info", emailCtx());
  assert(d.body.includes("proposal form"), "item listed");
  assert(d.subject.length > 0, "subject present");
});

test("insurer_submission surfaces referral flag prominently", () => {
  const d = draftEmail("insurer_submission", emailCtx());
  assert(/REFERRAL/.test(d.body), "referral section");
  assert(d.body.includes("Acme Ltd"), "client name");
  assert(d.body.includes("R 5,000,000"), "sum insured preserved");
});

test("internal_summary shows recommended insurer + red flags", () => {
  const d = draftEmail("internal_summary", emailCtx());
  assert(d.body.includes("CIB"), "insurer");
  assert(d.body.includes("buildings SI exceeds"), "flag");
});

test("verifyEmailPolish rejects dropped numeric token", () => {
  const base = draftEmail("insurer_submission", emailCtx());
  const polished = { subject: base.subject, body: base.body.replace("R 5,000,000", "the sum insured") };
  const problems = verifyEmailPolish(base, polished);
  assert(problems.some((p) => p.startsWith("dropped_numeric_token")), "must flag");
});

test("verifyEmailPolish rejects dropped referral flag", () => {
  const base = draftEmail("insurer_submission", emailCtx());
  const polished = { subject: base.subject, body: base.body.replace(/refer(ral)?/gi, "") };
  const problems = verifyEmailPolish(base, polished);
  assert(problems.includes("dropped_referral_flag"), "flag");
});

test("verifyEmailPolish accepts a faithful rewrite", () => {
  const base = draftEmail("broker_missing_info", emailCtx());
  const polished = { subject: base.subject, body: base.body }; // identical → trivially faithful
  const problems = verifyEmailPolish(base, polished);
  eq(problems.length, 0, "no problems");
});

// ---------------------------------------------------------------------------
// parser-azure: error redaction (no live call)
// ---------------------------------------------------------------------------

test("redactAzureError converts nested objects to compact codes", () => {
  const out = redactAzureError({ code: "InvalidRequest", status: 400, message: "long provider text that should not leak" });
  assert(out.startsWith("InvalidRequest"), "starts with code");
  assert(!out.includes("long provider text"), "message not surfaced");
});

test("redactAzureError handles unknown input safely", () => {
  eq(redactAzureError(null), "azure_unknown_error", "null");
  eq(redactAzureError(undefined), "azure_unknown_error", "undefined");
});

// ---------------------------------------------------------------------------
// runner
// ---------------------------------------------------------------------------

(async () => {
  let passed = 0;
  let failed = 0;
  for (const t of tests) {
    try {
      await t.fn();
      console.log(`  ✓ ${t.name}`);
      passed++;
    } catch (e) {
      console.error(`  ✗ ${t.name}: ${(e as Error).message}`);
      failed++;
    }
  }
  console.log(`\nPhase 10 hybrid: ${passed} passed, ${failed} failed out of ${tests.length}`);
  if (failed > 0 && typeof process !== "undefined") process.exitCode = 1;
})();
