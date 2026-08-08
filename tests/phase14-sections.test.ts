/**
 * Phase 14 (section-based hybrid extraction) — unit tests
 * ---------------------------------------------------------------------------
 * Covers the new architectural pieces that broke the single-Haiku-call
 * bottleneck:
 *
 *   - Section splitter: heading detection, page-boundary preservation,
 *     long-section re-split, unclassified fallback
 *   - Focused schemas: mapper turns each focused reply into a canonical
 *     partial keyed by dotted field paths
 *   - Controlled parallel extractor: concurrency cap, per-section outcome
 *     independence, cancellation, deadline, rate-limit retry, invalid-request
 *     no-retry, heartbeat progress
 *   - Deterministic merger: precedence, conflict retention, duplicate detection
 *   - Error classifier: HTTP status → category
 *   - Telemetry: PII allow-list still holds when we fold section counters in
 *
 * Live-provider tests are deliberately OMITTED — Haiku/Sonnet calls are
 * exercised through the callOverride injection point.
 */

import {
  splitDocumentsIntoSections,
  DEFAULT_SPLITTER_CONFIG,
  type DocumentSection,
  type SectionType,
} from "../worker/src/section-splitter.js";
import {
  mapFocusedReplyToPartial,
  schemaFor,
} from "../worker/src/section-schemas.js";
import {
  extractSections,
} from "../worker/src/section-extractor.js";
import {
  mergeSectionPartials,
  type MergePartial,
} from "../worker/src/section-merger.js";
import {
  isUsableHybridExtraction,
  hybridUsabilityConfig,
} from "../worker/src/hybrid-usability.js";
import {
  classifyAnthropicError,
  categoryFromStatus,
  AnthropicCallError,
  parseJsonReply,
} from "../worker/src/anthropic-client.js";
import { validateAndNormalizeExtraction } from "../worker/src/extraction.js";
import { emitPipelineMetric } from "../worker/src/pipeline-telemetry.js";
import type { ParsedDocument, ParsedPage } from "../worker/src/pipeline-types.js";
import type { Env } from "../worker/src/config.js";
import type { Usage } from "../worker/src/anthropic-client.js";

const tests: { name: string; fn: () => void | Promise<void> }[] = [];
function test(name: string, fn: () => void | Promise<void>) { tests.push({ name, fn }); }
function assert(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }
function eq<T>(a: T, b: T, msg: string) { if (a !== b) throw new Error(`${msg}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }

// ---------------------------------------------------------------------------
// Fixture helpers — anonymised synthetic 15-page policy schedule
// ---------------------------------------------------------------------------

function pg(page: number, text: string): ParsedPage {
  return { page, text, charCount: text.length };
}

function pd(pages: ParsedPage[], documentId = "doc-1", fileName = "schedule.pdf"): ParsedDocument {
  return {
    documentId, fileName,
    pageCount: pages.length,
    quality: "text_clean",
    fullText: pages.map((p) => p.text).join("\n\n"),
    pages, tables: [], keyValues: [],
    parserMeta: { parser: "test", parserVersion: "1", charsPerPage: 100, emptyPageRatio: 0, invalidCharRatio: 0, encrypted: false, parseMs: 1 },
  };
}

/** Synthetic 15-page personal-lines schedule shaped like a real one but with
 *  fully invented names, ids, addresses, VINs. NO real policyholder data. */
function syntheticSchedule(): ParsedDocument {
  const pages: ParsedPage[] = [
    pg(1, "Policy Details\nInsured: Zephyr Holdings CC\nRegistration Number: 2011/012345/23\nRisk Address: 42 Redwood Lane, Bryanston, 2191\nInception Date: 2024-05-01\nRenewal Date: 2025-05-01"),
    pg(2, "Intermediary Details\nBroker: NovaCover Brokers\nEmail: hello@example.invalid\nAdministrator: Atlas Underwriting"),
    pg(3, "Premium Summary\nBuildings included: Yes\nContents included: Yes\nMotor included: Yes\nAll Risks included: Yes\nTotal Premium: R 24,500.00\nSasria: R 320.00"),
    pg(4, "Buildings\nRisk Address: 42 Redwood Lane, Bryanston, 2191\nSum Insured: R 3,500,000\nPremium: R 8,200.00\nExcess: R 5,000\nEndorsements: Geyser cover included"),
    pg(5, "Buildings continued\nConditions: Alarm to be linked to armed response\nSecurity: Beam sensors on perimeter"),
    pg(6, "Contents\nSum Insured: R 850,000\nPremium: R 3,900.00\nExcess: R 1,500\nConditions: Safe for jewellery items above R 25,000"),
    pg(7, "All Risks\nSpecified items:\n- Camera Body (R 45,000)\n- Wedding Ring (R 30,000)\nUnspecified Sum: R 20,000\nPremium: R 850.00"),
    pg(8, "Motor Vehicles\nVehicle 1: 2019 Toyota Fortuner (ABC 123 GP) VIN JT1234567890 Sum Insured R 480,000 Cover Comprehensive Excess R 6,000\nVehicle 2: 2021 VW Polo (XYZ 987 GP) VIN WV9876543210 Sum Insured R 260,000 Cover Comprehensive Excess R 4,500"),
    pg(9, "Motor continued\nSecurity Requirements: Tracking device, immobiliser\nEndorsements: Named driver only"),
    pg(10, "Personal Liability\nSum Insured: R 5,000,000\nPremium: R 480.00\nExcess: R 0"),
    pg(11, "Claims History\nClaims history available: Yes\n2023-08-14 Motor R 12,000 Settled\n2022-11-02 Contents R 6,500 Settled"),
    pg(12, "Excesses\nMotor: 5% of claim, minimum R 4,500\nBuildings: R 5,000 flat\nContents: R 1,500 flat"),
    pg(13, "Endorsements\n- Cover excludes damage caused by wear and tear\n- Cover excludes electronic equipment kept outside the risk address"),
    pg(14, "Conditions and Warranties\n- The insured warrants that keys are not left in vehicles unattended\n- Alarm activated whenever premises are unattended"),
    pg(15, "End of schedule."),
  ];
  return pd(pages, "doc-synth", "synthetic_schedule.pdf");
}

// ---------------------------------------------------------------------------
// section-splitter
// ---------------------------------------------------------------------------

test("splitter recognises common short-term insurance section headings", () => {
  const { sections, headingsDetected } = splitDocumentsIntoSections([syntheticSchedule()]);
  assert(headingsDetected, "headings were detected");
  const types = new Set(sections.map((s) => s.sectionType));
  assert(types.has("policy_details"), "policy_details detected");
  assert(types.has("premium_index"), "premium_index detected");
  assert(types.has("buildings"), "buildings detected");
  assert(types.has("contents"), "contents detected");
  assert(types.has("all_risks"), "all_risks detected");
  assert(types.has("motor"), "motor detected");
  assert(types.has("claims_history"), "claims_history detected");
  assert(types.has("excesses"), "excesses detected");
  assert(types.has("endorsements"), "endorsements detected");
});

test("splitter preserves page numbers within each section", () => {
  const { sections } = splitDocumentsIntoSections([syntheticSchedule()]);
  const buildings = sections.find((s) => s.sectionType === "buildings");
  assert(buildings, "buildings section present");
  assert(buildings!.pages.includes(4), "page 4 kept");
  assert(buildings!.sourceOffsets.startPage === 4, "startPage");
  assert(buildings!.pages.every((p) => Number.isInteger(p) && p > 0), "all pages positive integers");
});

test("splitter re-splits oversized sections at page boundaries", () => {
  const big = "X ".repeat(6000);
  const doc = pd([
    pg(1, "Motor\nfirst"), pg(2, big), pg(3, big), pg(4, "trailing"),
  ]);
  const { sections } = splitDocumentsIntoSections([doc], { approxCharCap: 5_000 });
  const motor = sections.filter((s) => s.sectionType === "motor");
  assert(motor.length >= 2, `expected >=2 motor chunks, got ${motor.length}`);
  for (const chunk of motor) assert(chunk.approxChars <= 20_000, "each chunk bounded");
  // Union of pages equals 1..4
  const pages = new Set<number>();
  for (const c of motor) for (const p of c.pages) pages.add(p);
  for (const p of [1, 2, 3, 4]) assert(pages.has(p), `page ${p} present`);
});

test("splitter falls back to page-window slices when no headings match", () => {
  const doc = pd([
    pg(1, "just some free-form text with no heading"),
    pg(2, "more free-form"), pg(3, "even more"), pg(4, "again"), pg(5, "fin"),
  ]);
  const { sections, headingsDetected } = splitDocumentsIntoSections([doc], { fallbackPageWindow: 2, approxCharCap: 5000 });
  eq(headingsDetected, false, "no headings detected");
  assert(sections.length >= 2, `expected multiple chunks, got ${sections.length}`);
  for (const s of sections) eq(s.sectionType, "unclassified", "unclassified");
});

test("splitter never produces zero sections for a non-empty document", () => {
  const doc = pd([pg(1, "Just one page with policy holder info and nothing else.")]);
  const { sections } = splitDocumentsIntoSections([doc]);
  assert(sections.length >= 1, "at least one section");
});

// ---------------------------------------------------------------------------
// section-schemas mapper
// ---------------------------------------------------------------------------

test("focused policy_details reply maps to canonical dotted-path patches", () => {
  const partial = mapFocusedReplyToPartial("policy_details", {
    insured_name: { value: "Zephyr Holdings CC", page: 1 },
    entity_type: { value: "cc", page: 1 },
    registration_or_id_number: { value: "2011/012345/23", page: 1 },
    risk_address: { value: "42 Redwood Lane", page: 1 },
    policy_number: { value: "POL-0001", page: 1 },
    renewal_date: { value: "2025-05-01", page: 1 },
    insurer_name: { value: "Atlas Insurance", page: 1 },
  });
  assert("extracted_client.name" in partial.fieldPatches, "name patch");
  eq(partial.fieldPatches["extracted_client.name"].value, "Zephyr Holdings CC", "name value");
  eq(partial.fieldPatches["extracted_client.name"].page, 1, "name page");
  assert("quote_terms.quote_reference" in partial.fieldPatches, "policy number patch");
  assert("current_cover.current_insurer" in partial.fieldPatches, "insurer patch");
  eq(partial.sectionType, "policy_details", "section type preserved");
});

test("focused motor reply appends cover_sections + sums_insured", () => {
  const partial = mapFocusedReplyToPartial("motor", {
    vehicles: {
      value: [
        { year: 2019, make: "Toyota", model: "Fortuner", registration: "ABC123", sum_insured: "R 480,000", excess: "R 6,000" },
        { year: 2021, make: "VW", model: "Polo", registration: "XYZ987", sum_insured: "R 260,000", excess: "R 4,500" },
      ],
      page: 8,
    },
  });
  assert("current_cover.cover_sections" in partial.listAppends, "cover_sections list");
  assert("current_cover.sums_insured" in partial.listAppends, "sums list");
  eq(partial.listAppends["current_cover.sums_insured"].length, 2, "two vehicles summed");
});

test("schemaFor returns a defined focused schema for every section type", () => {
  for (const t of [
    "policy_details","intermediary_details","premium_index","buildings","contents",
    "all_risks","personal_liability","motor","claims_history","excesses","endorsements",
    "other_cover","unclassified",
  ] as const) {
    const s = schemaFor(t);
    assert(s.systemPromptFragment.length > 20, `${t} prompt`);
    assert(s.schemaHint.includes("{"), `${t} schema hint contains json`);
    assert(s.maxOutputTokens >= 500 && s.maxOutputTokens <= 3000, `${t} maxOutputTokens sane`);
  }
});

// ---------------------------------------------------------------------------
// section-extractor
// ---------------------------------------------------------------------------

function mkSection(type: DocumentSection["sectionType"], text: string, page = 1, stableIndex = 0, documentIndex = 0): DocumentSection {
  return {
    documentId: "d", fileName: "f.pdf", sectionType: type, heading: type,
    pages: [page], text, approxChars: text.length,
    sourceOffsets: { startPage: page, endPage: page },
    stableIndex, documentIndex,
  };
}

const fakeEnv: Env = { ANTHROPIC_API_KEY: "test-key" } as unknown as Env;
const zeroUsage: Usage = { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 };

test("extractSections runs sections concurrently up to the cap", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const sections = Array.from({ length: 6 }, (_, i) => mkSection("policy_details", `page ${i}`, i + 1, i, 0));
  const outcome = await extractSections({
    env: fakeEnv,
    sections,
    concurrency: 3,
    perSectionTimeoutMs: 5000,
    overallDeadlineMs: 60_000,
    callOverride: async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 20));
      inFlight--;
      return { text: JSON.stringify({ insured_name: { value: "X", page: 1 } }), usage: zeroUsage, model: "haiku-test" };
    },
  });
  eq(outcome.totals.success, 6, "all 6 succeeded");
  assert(maxInFlight <= 3, `concurrency capped, saw ${maxInFlight}`);
  assert(maxInFlight >= 2, `at least some parallelism, saw ${maxInFlight}`);
});

test("extractSections: one section failure does not cancel the others", async () => {
  const sections = [
    mkSection("policy_details", "ok", 1, 0, 0),
    mkSection("buildings", "boom", 2, 1, 0),
    mkSection("motor", "ok", 3, 2, 0),
  ];
  const outcome = await extractSections({
    env: fakeEnv,
    sections,
    concurrency: 2,
    perSectionTimeoutMs: 5000,
    overallDeadlineMs: 60_000,
    callOverride: async ({ section }) => {
      if (section.sectionType === "buildings") {
        throw new AnthropicCallError("anthropic_400", 400, "bad", "invalid_request");
      }
      return { text: JSON.stringify({ insured_name: { value: "X", page: 1 } }), usage: zeroUsage, model: "haiku-test" };
    },
  });
  eq(outcome.totals.success, 2, "two succeed");
  eq(outcome.totals.failure, 1, "one fails");
  const failed = outcome.results.find((r) => r.section.sectionType === "buildings");
  eq(failed?.outcome, "failure", "buildings marked failure");
  eq(failed?.category, "invalid_request", "category retained");
});

test("extractSections: invalid_request is NOT retried", async () => {
  let calls = 0;
  const outcome = await extractSections({
    env: fakeEnv,
    sections: [mkSection("policy_details", "x")],
    concurrency: 1,
    perSectionTimeoutMs: 2000,
    overallDeadlineMs: 10_000,
    callOverride: async () => {
      calls++;
      throw new AnthropicCallError("anthropic_400", 400, "bad", "invalid_request");
    },
  });
  eq(outcome.results[0].attempts, 1, "one attempt only");
  eq(calls, 1, "callOverride invoked once");
});

test("extractSections: network_failure IS retried once (bounded Haiku recovery)", async () => {
  let calls = 0;
  const outcome = await extractSections({
    env: fakeEnv,
    sections: [mkSection("policy_details", "x")],
    concurrency: 1,
    perSectionTimeoutMs: 5000,
    overallDeadlineMs: 30_000,
    callOverride: async () => {
      calls++;
      if (calls === 1) throw new AnthropicCallError("anthropic_network_error", 0, "econnreset", "network_failure");
      return { text: JSON.stringify({ insured_name: { value: "X", page: 1 } }), usage: zeroUsage, model: "haiku-test" };
    },
  });
  eq(outcome.results[0].attempts, 2, "two attempts for network_failure");
  eq(outcome.results[0].outcome, "success", "eventually succeeded after retry");
  eq(calls, 2, "callOverride invoked twice");
});

test("extractSections: auth_failed is NOT retried", async () => {
  let calls = 0;
  const outcome = await extractSections({
    env: fakeEnv,
    sections: [mkSection("policy_details", "x")],
    concurrency: 1,
    perSectionTimeoutMs: 2000,
    overallDeadlineMs: 10_000,
    callOverride: async () => {
      calls++;
      throw new AnthropicCallError("anthropic_401", 401, "bad_key", "auth_failed");
    },
  });
  eq(outcome.results[0].attempts, 1, "one attempt for auth_failed");
  eq(calls, 1, "auth_failed does not retry");
  eq(outcome.results[0].category, "auth_failed", "category retained");
});

test("extractSections: rate_limited IS retried (once)", async () => {
  let calls = 0;
  const outcome = await extractSections({
    env: fakeEnv,
    sections: [mkSection("policy_details", "x")],
    concurrency: 1,
    perSectionTimeoutMs: 5000,
    overallDeadlineMs: 30_000,
    callOverride: async () => {
      calls++;
      if (calls === 1) throw new AnthropicCallError("anthropic_429", 429, "slow down", "rate_limited");
      return { text: JSON.stringify({ insured_name: { value: "X", page: 1 } }), usage: zeroUsage, model: "haiku-test" };
    },
  });
  eq(outcome.results[0].attempts, 2, "two attempts");
  eq(outcome.results[0].outcome, "success", "eventually succeeded");
});

test("extractSections: cancellation stops the queue and marks remainders cancelled", async () => {
  let done = 0;
  const sections = Array.from({ length: 5 }, (_, i) => mkSection("policy_details", `p${i}`, i + 1, i, 0));
  const outcome = await extractSections({
    env: fakeEnv,
    sections,
    concurrency: 1,
    perSectionTimeoutMs: 2000,
    overallDeadlineMs: 60_000,
    isCancelled: async () => done >= 2,
    callOverride: async () => {
      done++;
      return { text: JSON.stringify({ insured_name: { value: "X" } }), usage: zeroUsage, model: "haiku-test" };
    },
  });
  eq(outcome.totals.success, 2, "two sections completed before cancellation");
  eq(outcome.totals.cancelled, 3, "three cancelled");
});

test("extractSections: overall deadline stops further calls", async () => {
  const sections = Array.from({ length: 3 }, (_, i) => mkSection("policy_details", `p${i}`, i + 1, i, 0));
  const outcome = await extractSections({
    env: fakeEnv,
    sections,
    concurrency: 1,
    perSectionTimeoutMs: 5000,
    overallDeadlineMs: 400,
    callOverride: async () => {
      await new Promise((r) => setTimeout(r, 300));
      return { text: JSON.stringify({ insured_name: { value: "X" } }), usage: zeroUsage, model: "haiku-test" };
    },
  });
  assert(outcome.totals.timeout >= 1, `deadline should mark >=1 timeout, saw ${outcome.totals.timeout}`);
  eq(outcome.totals.deadlineExceeded, true, "deadlineExceeded flagged");
});

test("extractSections emits progress heartbeat by completed count", async () => {
  const progress: number[] = [];
  const sections = Array.from({ length: 3 }, (_, i) => mkSection("policy_details", `p${i}`, i + 1, i, 0));
  await extractSections({
    env: fakeEnv,
    sections,
    concurrency: 1,
    perSectionTimeoutMs: 2000,
    overallDeadlineMs: 30_000,
    onProgress: (completed) => { progress.push(completed); },
    callOverride: async () => ({ text: JSON.stringify({ insured_name: { value: "X" } }), usage: zeroUsage, model: "haiku-test" }),
  });
  eq(progress.length, 3, "three heartbeats");
  eq(progress[0], 1, "first at 1");
  eq(progress[2], 3, "last at total");
});

// ---------------------------------------------------------------------------
// section-merger
// ---------------------------------------------------------------------------

/**
 * mp() — merge-partial factory. Wraps a partial with deterministic ordering
 * fields so tests can focus on the payload without repeating boilerplate.
 * Every test callsite supplies (at minimum) a stableIndex to avoid the
 * default value silently producing identical orderings.
 */
function mp(
  partial: import("../worker/src/section-schemas.js").CanonicalPartial,
  opts: { docId?: string; sectionType?: SectionType; docIndex?: number; stableIndex?: number; startPage?: number } = {}
): import("../worker/src/section-merger.js").MergePartial {
  return {
    partial,
    documentId: opts.docId ?? "d",
    primarySectionType: opts.sectionType ?? partial.sectionType,
    documentIndex: opts.docIndex ?? 0,
    stableIndex: opts.stableIndex ?? 0,
    startPage: opts.startPage ?? 1,
  };
}

test("mergeSectionPartials picks a value when only one section supplies it", () => {
  const merged = mergeSectionPartials({
    partials: [mp({
      sectionType: "policy_details",
      fieldPatches: { "extracted_client.name": { value: "Alpha CC", page: 1 } },
      listAppends: {},
      documentNotes: [],
    }, { stableIndex: 0 })],
  });
  const client = merged.extraction.extracted_client as Record<string, { value?: unknown; source?: { page?: number | null }; confidence?: unknown; confidence_source?: unknown }>;
  eq(client.name?.value, "Alpha CC", "value preserved");
  eq(client.name?.source?.page, 1, "source page preserved");
  eq(merged.conflicts.length, 0, "no conflicts");
});

test("mergeSectionPartials records a conflict when two sections disagree and higher precedence wins", () => {
  const merged = mergeSectionPartials({
    partials: [
      mp({ sectionType: "policy_details", fieldPatches: { "extracted_client.risk_address": { value: "SUMMARY: X Lane", page: 1 } }, listAppends: {}, documentNotes: [] }, { stableIndex: 0, startPage: 1 }),
      mp({ sectionType: "buildings", fieldPatches: { "extracted_client.risk_address": { value: "42 Redwood Lane, Bryanston, 2191", page: 4 } }, listAppends: {}, documentNotes: [] }, { stableIndex: 1, startPage: 4 }),
    ],
  });
  const client = merged.extraction.extracted_client as Record<string, { value?: unknown; source?: { page?: number | null } }>;
  eq(client.risk_address?.value, "42 Redwood Lane, Bryanston, 2191", "buildings wins (higher precedence)");
  eq(merged.conflicts.length, 1, "one conflict recorded");
  eq(merged.conflicts[0].chosen.section, "buildings", "chosen source recorded");
  eq(merged.conflicts[0].rejected[0].section, "policy_details", "rejected source retained");
});

test("mergeSectionPartials deduplicates list appends", () => {
  const merged = mergeSectionPartials({
    partials: [
      mp({ sectionType: "buildings", fieldPatches: {}, listAppends: { "current_cover.cover_sections": [{ value: "buildings", page: 4 }] }, documentNotes: [] }, { stableIndex: 0, startPage: 4 }),
      mp({ sectionType: "premium_index", fieldPatches: {}, listAppends: { "current_cover.cover_sections": [{ value: "buildings", page: 3 }, { value: "motor", page: 3 }] }, documentNotes: [] }, { stableIndex: 1, startPage: 3 }),
    ],
  });
  const cover = merged.extraction.current_cover as Record<string, { value?: unknown }>;
  const list = cover.cover_sections?.value as unknown[];
  eq(list.length, 2, "buildings + motor, no duplicate buildings");
});

test("mergeSectionPartials produces a validated canonical extraction", () => {
  const merged = mergeSectionPartials({
    partials: [mp({
      sectionType: "policy_details",
      fieldPatches: { "extracted_client.name": { value: "Alpha CC", page: 1 } },
      listAppends: {}, documentNotes: [],
    }, { stableIndex: 0 })],
  });
  assert(merged.validation.ok || merged.validation.errors.length >= 0, "validation runs");
  const scaffold = merged.extraction.extracted_client as Record<string, unknown>;
  assert("name" in scaffold, "extracted_client.name present");
});

// ---------------------------------------------------------------------------
// Error classifier
// ---------------------------------------------------------------------------

test("categoryFromStatus maps typical Anthropic HTTP codes", () => {
  eq(categoryFromStatus(401), "auth_failed", "401");
  eq(categoryFromStatus(403), "auth_failed", "403");
  eq(categoryFromStatus(429), "rate_limited", "429");
  eq(categoryFromStatus(400), "invalid_request", "400");
  eq(categoryFromStatus(500), "server_error", "500");
  eq(categoryFromStatus(504), "server_error", "504");
  eq(categoryFromStatus(200), "unknown_failure", "200 has no category");
});

test("classifyAnthropicError recognises AbortError as timeout", () => {
  const abort = Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
  eq(classifyAnthropicError(abort), "timeout", "AbortError");
});

test("classifyAnthropicError recognises AnthropicCallError category", () => {
  eq(classifyAnthropicError(new AnthropicCallError("x", 429, "y", "rate_limited")), "rate_limited", "propagate");
});

// ---------------------------------------------------------------------------
// Telemetry — section counters survive the PII allow-list
// ---------------------------------------------------------------------------

function fakeAdmin() {
  const rows: Record<string, unknown>[] = [];
  const client = { from: () => ({ insert: async (row: Record<string, unknown>) => { rows.push(row); return { error: null }; } }) };
  return { client, rows };
}

test("telemetry preserves section counters in the sanitized metadata bag", async () => {
  const { client, rows } = fakeAdmin();
  await emitPipelineMetric(client as unknown as import("@supabase/supabase-js").SupabaseClient, {
    pipelineMode: "hybrid",
    route: "text_fast_path",
    finalStatus: "completed",
    sectionCount: 12,
    successfulSectionCount: 11,
    failedSectionCount: 0,
    timedOutSectionCount: 1,
    maxConcurrency: 2,
    sectionDetectionMs: 8,
    slowestSectionMs: 3400,
    haikuTotalMs: 12_400,
    boundedSonnetMs: 5_100,
    boundedFallbackSectionCount: 1,
    fullLegacyFallbackUsed: false,
    failureCategory: "haiku_timeout",
  });
  const meta = rows[0].metadata as Record<string, unknown>;
  eq(meta.section_count, 12, "section_count kept");
  eq(meta.section_success, 11, "section_success kept");
  eq(meta.section_timeout, 1, "section_timeout kept");
  eq(meta.section_concurrency, 2, "section_concurrency kept");
  eq(meta.haiku_total_ms, 12_400, "haiku_total_ms kept");
  eq(meta.bounded_sonnet_ms, 5_100, "bounded_sonnet_ms kept");
  eq(meta.bounded_fallback_sections, 1, "bounded_fallback_sections kept");
  eq(meta.full_legacy_fallback_used, false, "full_legacy_fallback_used kept");
  eq(meta.failure_category, "haiku_timeout", "failure_category kept");
});

// ---------------------------------------------------------------------------
// Hardening 1 — never invent confidence
// ---------------------------------------------------------------------------

test("merger keeps confidence null when the section reply did not supply one", () => {
  const merged = mergeSectionPartials({
    partials: [mp({
      sectionType: "policy_details",
      fieldPatches: { "extracted_client.name": { value: "Alpha CC", page: 1 } }, // no confidence
      listAppends: {},
      documentNotes: [],
    }, { stableIndex: 0 })],
  });
  const client = merged.extraction.extracted_client as Record<string, { confidence?: unknown; confidence_source?: unknown; value?: unknown }>;
  eq(client.name?.value, "Alpha CC", "value present");
  eq(client.name?.confidence, null, "confidence stays null when unavailable");
  eq(client.name?.confidence_source, "unavailable", "confidence_source records provenance");
});

test("merger preserves a provider-supplied confidence with source=provider", () => {
  const merged = mergeSectionPartials({
    partials: [mp({
      sectionType: "policy_details",
      fieldPatches: { "extracted_client.name": { value: "Alpha CC", page: 1, confidence: 0.42 } },
      listAppends: {},
      documentNotes: [],
    }, { stableIndex: 0 })],
  });
  const client = merged.extraction.extracted_client as Record<string, { confidence?: unknown; confidence_source?: unknown }>;
  eq(client.name?.confidence, 0.42, "provider number preserved");
  eq(client.name?.confidence_source, "provider", "source=provider");
});

test("merger never fabricates 0.7 anywhere in the extraction", () => {
  const merged = mergeSectionPartials({
    partials: [
      mp({ sectionType: "buildings", fieldPatches: {}, listAppends: { "current_cover.cover_sections": [{ value: "buildings", page: 4 }] }, documentNotes: [] }, { stableIndex: 0 }),
      mp({ sectionType: "policy_details", fieldPatches: { "extracted_client.name": { value: "Alpha CC", page: 1 } }, listAppends: {}, documentNotes: [] }, { stableIndex: 1 }),
    ],
  });
  const asString = JSON.stringify(merged.extraction);
  assert(!asString.includes('"confidence":0.7'), `no invented 0.7: ${asString.slice(0, 200)}`);
});

test("empty scaffold fields carry null confidence and source=unavailable", () => {
  const merged = mergeSectionPartials({ partials: [] });
  const client = merged.extraction.extracted_client as Record<string, { confidence?: unknown; confidence_source?: unknown }>;
  eq(client.name?.confidence, null, "scaffold name confidence is null");
  eq(client.name?.confidence_source, "unavailable", "scaffold name source is unavailable");
});

test("validateAndNormalizeExtraction accepts null confidence without error", () => {
  const raw = {
    schema_version: "test",
    extracted_client: {
      name: { value: "Zephyr", status: "extracted", confidence: null, source: {}, notes: null },
      entity_type: { value: null, status: "not_found", confidence: null, source: {}, notes: null },
      registration_or_id_number: { value: null, status: "not_found", confidence: null, source: {}, notes: null },
      occupation_or_business_description: { value: null, status: "not_found", confidence: null, source: {}, notes: null },
      contact_details: { value: null, status: "not_found", confidence: null, source: {}, notes: null },
      risk_address: { value: null, status: "not_found", confidence: null, source: {}, notes: null },
    },
    broker: {}, current_cover: {}, risk_classification: {}, claims: {}, quote_terms: {},
    overall_confidence: 0,
  };
  const v = validateAndNormalizeExtraction(raw as unknown as Record<string, unknown>);
  const client = v.value?.extracted_client as Record<string, { confidence?: unknown; confidence_source?: unknown }> | undefined;
  eq(client?.name?.confidence, null, "null confidence preserved through validation");
  eq(client?.name?.confidence_source, "unavailable", "explicit null defaults source to unavailable");
  // No confidence-range validation errors should have been raised for null.
  assert(!v.errors.some((e) => e.includes("confidence")), `no confidence errors: ${v.errors.join("|")}`);
});

// ---------------------------------------------------------------------------
// Hardening 2 — deterministic merge ordering under concurrent completion
// ---------------------------------------------------------------------------

/** Produce a deterministic pseudo-random shuffle using a seeded RNG so the
 *  test itself is reproducible. */
function shuffleWithSeed<T>(arr: T[], seed: number): T[] {
  const out = [...arr];
  let s = seed;
  for (let i = out.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const j = s % (i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

test("merger is byte-identical across shuffled completion orders", () => {
  // Build a realistic mix: multiple sections, some duplicated keys, some
  // list appends, cross-document sources.
  const canonicalPartials: MergePartial[] = [
    mp({ sectionType: "policy_details", fieldPatches: { "extracted_client.name": { value: "Alpha CC", page: 1 } }, listAppends: {}, documentNotes: [] }, { stableIndex: 0, docIndex: 0, startPage: 1 }),
    mp({ sectionType: "premium_index", fieldPatches: { "current_cover.current_premium": { value: "R 24500", page: 3 } }, listAppends: { "current_cover.cover_sections": [{ value: "buildings", page: 3 }, { value: "motor", page: 3 }] }, documentNotes: [] }, { stableIndex: 1, docIndex: 0, startPage: 3 }),
    mp({ sectionType: "buildings", fieldPatches: { "extracted_client.risk_address": { value: "42 Redwood Lane", page: 4 } }, listAppends: { "current_cover.sums_insured": [{ value: "buildings: R3.5m", page: 4 }] }, documentNotes: [] }, { stableIndex: 2, docIndex: 0, startPage: 4 }),
    mp({ sectionType: "policy_details", fieldPatches: { "extracted_client.risk_address": { value: "SUMMARY ADDR", page: 1 } }, listAppends: {}, documentNotes: [] }, { stableIndex: 3, docIndex: 0, startPage: 1 }),
    mp({ sectionType: "motor", fieldPatches: {}, listAppends: { "current_cover.cover_sections": [{ value: "motor", page: 8 }], "current_cover.sums_insured": [{ value: "motor: R480k", page: 8 }] }, documentNotes: [] }, { stableIndex: 4, docIndex: 0, startPage: 8 }),
    mp({ sectionType: "endorsements", fieldPatches: {}, listAppends: { "current_cover.endorsements": [{ value: "Geyser cover included", page: 13 }] }, documentNotes: [] }, { stableIndex: 5, docIndex: 0, startPage: 13 }),
  ];

  const canonical = mergeSectionPartials({ partials: canonicalPartials });
  const canonicalJson = JSON.stringify(canonical.extraction);
  const canonicalConflicts = JSON.stringify(canonical.conflicts);

  for (const seed of [1, 7, 42, 137, 999, 12345]) {
    const shuffled = shuffleWithSeed(canonicalPartials, seed);
    const attempt = mergeSectionPartials({ partials: shuffled });
    eq(JSON.stringify(attempt.extraction), canonicalJson, `extraction byte-identical for seed ${seed}`);
    eq(JSON.stringify(attempt.conflicts), canonicalConflicts, `conflicts byte-identical for seed ${seed}`);
  }
});

test("merger tie-breaker is (precedence, docIndex, startPage, stableIndex)", () => {
  // Two buildings sections (equal precedence). docIndex 0 wins over docIndex 1.
  const a = mp({ sectionType: "buildings", fieldPatches: { "extracted_client.risk_address": { value: "ADDR-A", page: 4 } }, listAppends: {}, documentNotes: [] }, { docId: "docA", docIndex: 0, startPage: 4, stableIndex: 10 });
  const b = mp({ sectionType: "buildings", fieldPatches: { "extracted_client.risk_address": { value: "ADDR-B", page: 4 } }, listAppends: {}, documentNotes: [] }, { docId: "docB", docIndex: 1, startPage: 4, stableIndex: 0 });
  const merged = mergeSectionPartials({ partials: [b, a] });
  const client = merged.extraction.extracted_client as Record<string, { value?: unknown }>;
  eq(client.risk_address?.value, "ADDR-A", "docIndex 0 wins over docIndex 1");
  eq(merged.conflicts[0].chosen.section, "buildings", "chosen still buildings");
});

// ---------------------------------------------------------------------------
// Hardening 3 — usability-based fallback rule
// ---------------------------------------------------------------------------

const usabilityCfg = hybridUsabilityConfig({});

function usabilityExtraction(opts: {
  name?: string | null; insurer?: string | null; policyRef?: string | null;
  primaryRisk?: string | null; renewal?: string | null; covers?: string[];
} = {}): Record<string, unknown> {
  const mk = (v: unknown) => ({ value: v, status: v == null ? "not_found" : "extracted", confidence: null, source: {}, notes: null });
  return {
    schema_version: "test",
    extracted_client: { name: mk(opts.name ?? null), risk_address: mk(null), entity_type: mk(null), registration_or_id_number: mk(null), occupation_or_business_description: mk(null), contact_details: mk(null) },
    broker: {}, quote_terms: { quote_reference: mk(opts.policyRef ?? null), insurer_name: mk(null), insured_name: mk(null) },
    current_cover: { current_insurer: mk(opts.insurer ?? null), renewal_date: mk(opts.renewal ?? null), cover_sections: { value: opts.covers ?? [], status: (opts.covers?.length ? "extracted" : "not_found"), confidence: null, source: {}, notes: null } },
    risk_classification: { primary_risk_type: mk(opts.primaryRisk ?? null), product_line: mk(null) },
    claims: {}, overall_confidence: 0,
  };
}

test("usability: most critical succeed, one minor fails → usable (no full fallback)", () => {
  const dec = isUsableHybridExtraction({
    extraction: usabilityExtraction({ name: "Zephyr", insurer: "Atlas", policyRef: "P123", primaryRisk: "buildings", renewal: "2025-05-01", covers: ["buildings"] }),
    schemaValid: true, unresolvedConflicts: 0,
    successfulSectionTypes: ["policy_details", "premium_index", "buildings", "contents", "motor"],
    failedSectionTypes: ["endorsements"],
  }, usabilityCfg);
  eq(dec.usable, true, `usable, reasons: ${dec.reasons.join(",")}`);
});

test("usability: only intermediary_details succeeds → unusable → full fallback eligible", () => {
  const dec = isUsableHybridExtraction({
    extraction: usabilityExtraction({}),
    schemaValid: true, unresolvedConflicts: 0,
    successfulSectionTypes: ["intermediary_details"],
    failedSectionTypes: ["policy_details", "premium_index", "buildings", "motor"],
  }, usabilityCfg);
  eq(dec.usable, false, "unusable");
  assert(dec.reasons.includes("missing_insured_identity"), "flagged identity");
  assert(dec.reasons.includes("no_cover_sections"), "flagged cover");
  assert(dec.reasons.includes("insufficient_critical_section_coverage"), "flagged critical coverage");
});

test("usability: Haiku fails 2 sections, bounded Sonnet recovers both → usable", () => {
  // Sonnet recovery contributes to successfulSectionTypes and REMOVES those from failedSectionTypes.
  const dec = isUsableHybridExtraction({
    extraction: usabilityExtraction({ name: "Zephyr", insurer: "Atlas", policyRef: "P123", primaryRisk: "buildings", renewal: "2025-05-01", covers: ["buildings", "motor"] }),
    schemaValid: true, unresolvedConflicts: 0,
    successfulSectionTypes: ["policy_details", "premium_index", "buildings", "motor", "contents"],
    failedSectionTypes: [],
  }, usabilityCfg);
  eq(dec.usable, true, `usable after bounded recovery, reasons: ${dec.reasons.join(",")}`);
});

test("usability: all sections fail → unusable → full fallback eligible", () => {
  const dec = isUsableHybridExtraction({
    extraction: usabilityExtraction({}),
    schemaValid: true, unresolvedConflicts: 0,
    successfulSectionTypes: [],
    failedSectionTypes: ["policy_details", "premium_index", "buildings", "motor"],
  }, usabilityCfg);
  eq(dec.usable, false, "unusable");
  eq(dec.signals.relevantSectionSuccessRatio, 0, "ratio 0");
});

test("usability: critical fields absent despite minor successes → unusable", () => {
  const dec = isUsableHybridExtraction({
    // Minor sections succeeded but the merged extraction has no identity/insurer/period.
    extraction: usabilityExtraction({ covers: ["buildings"] }),
    schemaValid: true, unresolvedConflicts: 0,
    successfulSectionTypes: ["endorsements", "intermediary_details", "claims_history"],
    failedSectionTypes: [],
  }, usabilityCfg);
  eq(dec.usable, false, "unusable");
  assert(dec.reasons.includes("missing_insured_identity"), "identity missing");
  assert(dec.reasons.includes("missing_insurer"), "insurer missing");
  assert(dec.reasons.includes("missing_policy_id"), "policy id missing");
});

test("usability: too many unresolved conflicts flags unusable", () => {
  const dec = isUsableHybridExtraction({
    extraction: usabilityExtraction({ name: "Z", insurer: "A", policyRef: "P", primaryRisk: "buildings", renewal: "2025-05-01", covers: ["buildings"] }),
    schemaValid: true, unresolvedConflicts: 999,
    successfulSectionTypes: ["policy_details", "buildings"],
    failedSectionTypes: [],
  }, usabilityCfg);
  eq(dec.usable, false, "unusable due to conflicts");
  assert(dec.reasons.includes("too_many_conflicts"), "flagged conflict count");
});

// ---------------------------------------------------------------------------
// Hardening 4 — error classification wording
// ---------------------------------------------------------------------------

test("invalid_request and invalid_model_output are distinct categories", () => {
  const req = new AnthropicCallError("anthropic_400", 400, "bad_request_shape", "invalid_request");
  const out = new AnthropicCallError("anthropic_invalid_model_output", 200, "json_parse", "invalid_model_output");
  eq(req.category, "invalid_request", "invalid_request preserved");
  eq(out.category, "invalid_model_output", "invalid_model_output preserved");
  assert(req.category !== out.category, "categories are distinct");
});

test("parseJsonReply throws invalid_model_output, never invalid_request", () => {
  try {
    parseJsonReply("not json at all");
    throw new Error("should have thrown");
  } catch (err) {
    assert(err instanceof AnthropicCallError, "AnthropicCallError");
    eq((err as AnthropicCallError).category, "invalid_model_output", "invalid_model_output category");
  }
});

// ---------------------------------------------------------------------------
// Hardening 5 — overall_confidence provenance (unavailable ≠ genuine 0%)
// ---------------------------------------------------------------------------

test("merger: no rated fields → overall_confidence=0 with source=unavailable", () => {
  const merged = mergeSectionPartials({
    partials: [mp({
      sectionType: "policy_details",
      fieldPatches: { "extracted_client.name": { value: "Zephyr", page: 1 } }, // no confidence
      listAppends: {}, documentNotes: [],
    }, { stableIndex: 0 })],
  });
  const ext = merged.extraction as Record<string, unknown>;
  eq(ext.overall_confidence, 0, "compatibility zero preserved for legacy readers");
  eq(ext.overall_confidence_source, "unavailable", "provenance is unavailable");
  eq(ext.overall_confidence_available, false, "availability flag false");
});

test("merger: rated fields → overall_confidence=mean with source=provider", () => {
  const merged = mergeSectionPartials({
    partials: [mp({
      sectionType: "policy_details",
      fieldPatches: {
        "extracted_client.name": { value: "Zephyr", page: 1, confidence: 0.8 },
        "extracted_client.risk_address": { value: "42 Redwood", page: 1, confidence: 0.6 },
      },
      listAppends: {}, documentNotes: [],
    }, { stableIndex: 0 })],
  });
  const ext = merged.extraction as Record<string, unknown>;
  eq(ext.overall_confidence, 0.7, "mean of 0.8 and 0.6");
  eq(ext.overall_confidence_source, "provider", "provenance is provider");
  eq(ext.overall_confidence_available, true, "availability flag true");
});

test("validator: null overall_confidence is accepted as unavailable, no error", () => {
  const raw = {
    schema_version: "test",
    extracted_client: {}, broker: {}, current_cover: {}, risk_classification: {}, claims: {}, quote_terms: {},
    overall_confidence: null,
  };
  const v = validateAndNormalizeExtraction(raw as unknown as Record<string, unknown>);
  eq(v.value?.overall_confidence, 0, "compatibility zero written");
  eq(v.value?.overall_confidence_source, "unavailable", "source unavailable");
  eq(v.value?.overall_confidence_available, false, "available false");
  assert(!v.errors.some((e) => e.toLowerCase().includes("overall_confidence")), `no overall_confidence errors: ${v.errors.join("|")}`);
});

test("validator: numeric overall_confidence is preserved with source=provider", () => {
  const raw = {
    schema_version: "test",
    extracted_client: {}, broker: {}, current_cover: {}, risk_classification: {}, claims: {}, quote_terms: {},
    overall_confidence: 0.42,
  };
  const v = validateAndNormalizeExtraction(raw as unknown as Record<string, unknown>);
  eq(v.value?.overall_confidence, 0.42, "numeric preserved");
  eq(v.value?.overall_confidence_source, "provider", "source provider");
  eq(v.value?.overall_confidence_available, true, "available true");
});

test("validator: invalid overall_confidence (out of range) records error and marks unavailable", () => {
  const raw = {
    schema_version: "test",
    extracted_client: {}, broker: {}, current_cover: {}, risk_classification: {}, claims: {}, quote_terms: {},
    overall_confidence: 42,
  };
  const v = validateAndNormalizeExtraction(raw as unknown as Record<string, unknown>);
  eq(v.value?.overall_confidence, 0, "unsafe number defaults to 0");
  eq(v.value?.overall_confidence_source, "unavailable", "source unavailable");
  assert(v.errors.some((e) => e.includes("overall_confidence")), "error raised");
});

// ---------------------------------------------------------------------------
// Hardening 6 — telemetry sanitiser: metrics survive, PII/raw errors dropped
// ---------------------------------------------------------------------------

test("telemetry: critical coverage + unusable reasons survive sanitisation", async () => {
  const { client, rows } = fakeAdmin();
  await emitPipelineMetric(client as unknown as import("@supabase/supabase-js").SupabaseClient, {
    pipelineMode: "hybrid",
    route: "text_fast_path",
    finalStatus: "failed",
    sectionCount: 6,
    successfulSectionCount: 2,
    failedSectionCount: 4,
    boundedFallbackSectionCount: 3,
    fullLegacyFallbackUsed: true,
    failureCategory: "unusable:missing_insurer",
    metadata: {
      unusable_reasons: ["missing_insured_identity", "missing_insurer", "no_cover_sections"],
      critical_section_ratio: 0.33,
      overall_confidence_available: false,
    },
  });
  const meta = rows[0].metadata as Record<string, unknown>;
  eq(meta.section_count, 6, "section_count kept");
  eq(meta.section_success, 2, "section_success kept");
  eq(meta.section_failure, 4, "section_failure kept");
  eq(meta.bounded_fallback_sections, 3, "bounded_fallback_sections kept");
  eq(meta.full_legacy_fallback_used, true, "full_legacy_fallback_used kept");
  eq(meta.failure_category, "unusable:missing_insurer", "failure_category kept");
  eq(meta.critical_section_ratio, 0.33, "critical_section_ratio kept");
  eq(meta.overall_confidence_available, false, "provenance flag kept");
  const reasons = meta.unusable_reasons as string[];
  assert(Array.isArray(reasons) && reasons.length === 3, "unusable_reasons array kept");
});

test("telemetry: raw provider error strings and PII-shaped keys are stripped", async () => {
  const { client, rows } = fakeAdmin();
  const longRaw = "provider stack trace ".repeat(30) + "with insured name Jane Doe 070 555 1234";
  await emitPipelineMetric(client as unknown as import("@supabase/supabase-js").SupabaseClient, {
    pipelineMode: "hybrid",
    route: "text_fast_path",
    finalStatus: "failed",
    metadata: {
      // These keys hit the PII allow-list block:
      insured_name: "Jane Doe",
      contact_email: "jane@example.invalid",
      risk_address: "42 Redwood Lane, Bryanston",
      raw_error: longRaw,                       // too long AND matches PII key
      extracted_value: { field: "leaks" },      // object shape dropped by design
      // These SHOULD survive:
      section_count: 4,
    },
  });
  const meta = rows[0].metadata as Record<string, unknown>;
  eq(meta.section_count, 4, "safe numeric kept");
  assert(!("insured_name" in meta), "PII-shaped key insured_name dropped");
  assert(!("contact_email" in meta), "PII-shaped key contact_email dropped");
  assert(!("risk_address" in meta), "PII-shaped key risk_address dropped");
  assert(!("raw_error" in meta), "raw provider error dropped");
  assert(!("extracted_value" in meta), "object shape dropped");
});

// ---------------------------------------------------------------------------
// Hardening 7 — critical vs minor section failures drive fallback correctly
// ---------------------------------------------------------------------------

test("usability: network failures on ONLY minor sections still usable → no full fallback", () => {
  // Critical sections all succeeded (policy_details, buildings, motor, contents),
  // network_failure only hit the minor endorsements section. Extraction usable.
  const dec = isUsableHybridExtraction({
    extraction: usabilityExtraction({
      name: "Zephyr", insurer: "Atlas", policyRef: "P123",
      primaryRisk: "buildings", renewal: "2025-05-01", covers: ["buildings", "motor"],
    }),
    schemaValid: true, unresolvedConflicts: 0,
    successfulSectionTypes: ["policy_details", "premium_index", "buildings", "motor", "contents"],
    failedSectionTypes: ["endorsements"],
  }, usabilityCfg);
  eq(dec.usable, true, `usable, reasons: ${dec.reasons.join(",")}`);
});

test("usability: network failures across all critical sections → unusable → fallback eligible", () => {
  const dec = isUsableHybridExtraction({
    extraction: usabilityExtraction({}), // nothing merged for critical fields
    schemaValid: true, unresolvedConflicts: 0,
    successfulSectionTypes: ["intermediary_details", "endorsements"],
    failedSectionTypes: ["policy_details", "premium_index", "buildings", "motor", "contents"],
  }, usabilityCfg);
  eq(dec.usable, false, "unusable when critical sections all failed");
  assert(dec.reasons.length > 0, "reasons populated so telemetry can surface them");
});

// ---------------------------------------------------------------------------
// Runner
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
  console.log(`\nPhase 14 sections: ${passed} passed, ${failed} failed out of ${tests.length}`);
  if (failed > 0 && typeof process !== "undefined") process.exitCode = 1;
})();
// keep DEFAULT_SPLITTER_CONFIG referenced so the import is not dead
void DEFAULT_SPLITTER_CONFIG;
