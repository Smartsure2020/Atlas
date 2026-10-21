/**
 * Powerhouse Phase 4 — the deterministic contradiction engine.
 *
 * Two kinds of proof live here. The pipeline benchmark (acceptance.test.ts) proves
 * the engine on the ONE comparison Atlas's data model can support today (intake
 * broker email vs reviewed broker email). Cases 30, 31, 34 and 36 need a boolean,
 * a date, a matcher-consumed field or a third source — none of which Atlas records
 * twice — so they are proven HERE against an explicitly injected registry. Nothing
 * in this file adds a comparable field to production.
 */

import {
  COMPARABLE_FIELDS,
  NORMALIZERS,
  analyseContradictions,
  collectObservations,
  fingerprintObservations,
  isAbsentValue,
  maskIdentifier,
  matcherRolesFor,
  type ComparableFieldSpec,
  type ContradictionAnalysis,
  type NormalizerId,
  type Observation,
  type ObservationSet,
} from "../../worker/src/contradictions.js";
import { assessCompleteness } from "../../worker/src/completeness.js";
import { assessQualityV3 } from "../../worker/src/recommendation-quality-v3.js";

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
// Helpers
// ---------------------------------------------------------------------------

const spec = (
  field_key: string,
  normalizer: NormalizerId,
  over: Partial<ComparableFieldSpec> = {}
): ComparableFieldSpec => ({ field_key, label: field_key, normalizer, sensitivity: "none", field_path: null, sources: [], ...over });

const obs = (field_key: string, source_id: string, raw: unknown, over: Partial<Observation> = {}): Observation => ({
  field_key,
  source_id,
  source_label: `Source ${source_id}`,
  raw,
  pointer: { record: "atlas_submissions", column: source_id },
  field_status: null,
  confidence: null,
  ...over,
});

const set = (observations: Observation[], unavailable: ObservationSet["unavailable_sources"] = []): ObservationSet => ({
  observations,
  unavailable_sources: unavailable,
});

const REGISTRY: ComparableFieldSpec[] = [
  spec("claims.flag", "boolean_yes_no"),
  spec("policy.start", "date_iso_calendar"),
  spec("sum.insured", "number_plain_decimal"),
  spec("vehicle.registration", "identifier_strip_separators_uppercase", { sensitivity: "personal_identifier" }),
  spec("risk.sector", "enum_trim_collapse_casefold", { field_path: "risk_classification.business_sector" }),
  spec("risk.product", "enum_trim_collapse_casefold", { field_path: "risk_classification.product_line" }),
  spec("broker.email", "email_trim_lowercase", { sensitivity: "personal_identifier", field_path: "broker.email" }),
];

const analyse = (observations: Observation[], unavailable: ObservationSet["unavailable_sources"] = []): ContradictionAnalysis =>
  analyseContradictions({ observations: set(observations, unavailable), registry: REGISTRY });

function shuffled<T>(values: T[], seed: number): T[] {
  const out = [...values];
  let state = seed >>> 0;
  for (let i = out.length - 1; i > 0; i--) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const j = state % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// ---------------------------------------------------------------------------
// Normalisation table — every comparison documents its normaliser
// ---------------------------------------------------------------------------

test("1. every normaliser declares its kind and its exact steps", () => {
  for (const [id, normalizer] of Object.entries(NORMALIZERS)) {
    eq(normalizer.id, id, `${id}: id`);
    assert(normalizer.steps.length >= 2, `${id}: steps documented`);
    assert(["enum", "boolean", "identifier", "email", "date", "number"].includes(normalizer.kind), `${id}: kind`);
  }
});

test("2. normalisers: valid equivalents agree, real differences differ, unreadable values are refused", () => {
  const n = (id: NormalizerId, raw: unknown) => NORMALIZERS[id].normalize(raw);
  const ok = (id: NormalizerId, raw: unknown) => { const r = n(id, raw); assert(r.ok, `${id}(${JSON.stringify(raw)}) should parse`); return r.value; };
  const bad = (id: NormalizerId, raw: unknown) => assert(!n(id, raw).ok, `${id}(${JSON.stringify(raw)}) must be refused`);

  // enum: trim, collapse whitespace, case-fold
  eq(ok("enum_trim_collapse_casefold", "  Commercial   MOTOR "), "commercial motor", "enum");
  eq(ok("enum_trim_collapse_casefold", "commercial motor"), "commercial motor", "enum equal");
  assert(ok("enum_trim_collapse_casefold", "commercial motor") !== ok("enum_trim_collapse_casefold", "commercial property"), "enum differs");
  bad("enum_trim_collapse_casefold", 12);

  // boolean
  for (const yes of [true, "true", "YES", " y ", 1, "1"]) eq(ok("boolean_yes_no", yes), "true", `yes: ${String(yes)}`);
  for (const no of [false, "false", "No", " n ", 0, "0"]) eq(ok("boolean_yes_no", no), "false", `no: ${String(no)}`);
  bad("boolean_yes_no", "maybe");
  bad("boolean_yes_no", {});

  // identifier: separators and case are formatting, other characters are content
  eq(ok("identifier_strip_separators_uppercase", "ABC 123"), "ABC123", "space");
  eq(ok("identifier_strip_separators_uppercase", "abc-123"), "ABC123", "hyphen + case");
  eq(ok("identifier_strip_separators_uppercase", "A.B/C_1 2-3"), "ABC123", "mixed separators");
  assert(ok("identifier_strip_separators_uppercase", "ABC 123") !== ok("identifier_strip_separators_uppercase", "ABC 124"), "a different digit is a different identifier");
  assert(ok("identifier_strip_separators_uppercase", "AB1C") !== ok("identifier_strip_separators_uppercase", "ABIC"), "1 and I are never merged");
  bad("identifier_strip_separators_uppercase", "AB#123");
  bad("identifier_strip_separators_uppercase", "ÀBC 123");
  bad("identifier_strip_separators_uppercase", "---");
  bad("identifier_strip_separators_uppercase", "X".repeat(65));

  // email
  eq(ok("email_trim_lowercase", "  Broker@EXAMPLE.co.za "), "broker@example.co.za", "email");
  bad("email_trim_lowercase", "Broker <broker@example.co.za>");
  bad("email_trim_lowercase", "a@b");
  bad("email_trim_lowercase", "two@one.co, other@two.co");
  bad("email_trim_lowercase", 5);

  // date: ISO calendar dates only; locale guessing is not done
  eq(ok("date_iso_calendar", " 2026-02-28 "), "2026-02-28", "date");
  eq(ok("date_iso_calendar", "2028-02-29"), "2028-02-29", "leap day");
  bad("date_iso_calendar", "2026-02-29");
  bad("date_iso_calendar", "2026-13-01");
  bad("date_iso_calendar", "01/05/2026");
  bad("date_iso_calendar", "2026-05-01T00:00:00Z");
  bad("date_iso_calendar", "0099-01-01");

  // number: plain decimals only, compared as text (no floating point)
  eq(ok("number_plain_decimal", "01.50"), "1.5", "leading zero + trailing zero");
  eq(ok("number_plain_decimal", 1.5), "1.5", "number");
  eq(ok("number_plain_decimal", "+12"), "12", "plus");
  eq(ok("number_plain_decimal", "-0"), "0", "negative zero");
  eq(ok("number_plain_decimal", "0.1000"), "0.1", "fraction");
  assert(ok("number_plain_decimal", "0.1") !== ok("number_plain_decimal", "0.10000001"), "no tolerance");
  bad("number_plain_decimal", "1,234");
  bad("number_plain_decimal", "R 1000");
  bad("number_plain_decimal", "1e3");
  bad("number_plain_decimal", Number.NaN);
});

// ---------------------------------------------------------------------------
// Cases 28-33 at engine level, plus 30 and 31 (boolean, date)
// ---------------------------------------------------------------------------

test("3. CASE 28 — two sources that agree after normalisation: NO contradiction", () => {
  const result = analyse([obs("broker.email", "intake", "  Broker@Example.co.za "), obs("broker.email", "extraction", "broker@example.co.za")]);
  eq(result.contradiction_count, 0, "no contradiction");
  eq(result.comparisons[0].outcome, "agree", "agree");
  deepEq(result.comparisons[0].source_ids, ["extraction", "intake"], "both sources counted");
});

test("4. CASE 29 / 33 — genuinely different values: ONE contradiction, no tolerance", () => {
  const result = analyse([obs("broker.email", "intake", "john.smith@example.co.za"), obs("broker.email", "extraction", "jon.smith@example.co.za")]);
  eq(result.contradiction_count, 1, "contradiction");
  const [c] = result.contradictions;
  eq(c.value_groups.length, 2, "two groups");
  eq(c.status, "unresolved", "unresolved");
  eq(c.resolution_state, "unresolved", "resolution state");
});

test("5. CASE 30 — boolean contradiction (yes vs no) and boolean agreement across spellings", () => {
  const conflict = analyse([obs("claims.flag", "a", "Yes"), obs("claims.flag", "b", false)]);
  eq(conflict.contradiction_count, 1, "yes vs no");
  deepEq(conflict.contradictions[0].value_groups.map((g) => g.value_display).sort(), ["false", "true"], "typed values shown (non-sensitive)");
  const agree = analyse([obs("claims.flag", "a", "yes"), obs("claims.flag", "b", true), obs("claims.flag", "c", 1)]);
  eq(agree.contradiction_count, 0, "different spellings of yes agree");
});

test("6. CASE 31 — date contradiction; a differently formatted date is NOT guessed", () => {
  const conflict = analyse([obs("policy.start", "a", "2026-05-01"), obs("policy.start", "b", "2026-05-02")]);
  eq(conflict.contradiction_count, 1, "valid parsed dates differ");
  deepEq(conflict.contradictions[0].value_groups.map((g) => g.value_display).sort(), ["2026-05-01", "2026-05-02"], "typed dates shown");
  const agree = analyse([obs("policy.start", "a", "2026-05-01"), obs("policy.start", "b", " 2026-05-01 ")]);
  eq(agree.contradiction_count, 0, "equal dates agree");
  const ambiguous = analyse([obs("policy.start", "a", "2026-05-01"), obs("policy.start", "b", "01/05/2026")]);
  eq(ambiguous.contradiction_count, 0, "01/05/2026 could be 1 May or 5 January: Atlas does not guess");
  eq(ambiguous.comparisons[0].outcome, "comparison_unavailable", "comparison unavailable instead");
  eq(ambiguous.comparisons[0].unavailable_reason, "unparseable_value", "reason");
});

test("7. CASE 32 — identifier formatting that normalises equal is not a contradiction ('ABC 123' vs 'abc-123' vs 'ABC123')", () => {
  const result = analyse([
    obs("vehicle.registration", "a", "ABC 123"),
    obs("vehicle.registration", "b", "abc-123"),
    obs("vehicle.registration", "c", "ABC123"),
  ]);
  eq(result.contradiction_count, 0, "same identifier");
  eq(result.comparisons[0].outcome, "agree", "agree");
});

test("8. numbers: equal after parsing agree; any difference is a contradiction", () => {
  eq(analyse([obs("sum.insured", "a", "1500000"), obs("sum.insured", "b", 1500000.0)]).contradiction_count, 0, "equal");
  eq(analyse([obs("sum.insured", "a", "1500000"), obs("sum.insured", "b", "1500000.01")]).contradiction_count, 1, "a cent apart is a difference");
  eq(analyse([obs("sum.insured", "a", "1500000"), obs("sum.insured", "b", "R1 500 000")]).contradiction_count, 0, "unparseable currency text is unavailable, not a conflict");
});

// ---------------------------------------------------------------------------
// Case 36 — clusters, not pairs
// ---------------------------------------------------------------------------

test("9. CASE 36 — three sources, two agree and one differs: ONE logical cluster, not pairwise spam", () => {
  const result = analyse([obs("risk.sector", "s1", "Transport"), obs("risk.sector", "s2", "transport"), obs("risk.sector", "s3", "Logistics")]);
  eq(result.contradiction_count, 1, "one cluster");
  const [c] = result.contradictions;
  eq(c.value_groups.length, 2, "two distinct values");
  deepEq(c.value_groups.map((g) => g.source_count).sort(), [1, 2], "two sources agree, one differs");
  deepEq(c.value_groups.flatMap((g) => g.sources.map((s) => s.source_id)).sort(), ["s1", "s2", "s3"], "every source is attributed exactly once");
});

test("10. A A B B is one contradiction (two groups of two), never four pairs", () => {
  const result = analyse([
    obs("risk.sector", "s1", "A"), obs("risk.sector", "s2", "a"),
    obs("risk.sector", "s3", "B"), obs("risk.sector", "s4", "b"),
  ]);
  eq(result.contradiction_count, 1, "one cluster");
  deepEq(result.contradictions[0].value_groups.map((g) => g.source_count), [2, 2], "2 + 2");
});

test("11. many sources, many values: still exactly one cluster per field, one group per distinct value", () => {
  const values = ["a", "b", "c", "d", "a", "b", "c", "d", "a"];
  const result = analyse(values.map((value, index) => obs("risk.sector", `s${index}`, value)));
  eq(result.contradiction_count, 1, "one cluster");
  eq(result.contradictions[0].value_groups.length, 4, "four distinct values");
});

// ---------------------------------------------------------------------------
// Case 34 / 35 — severity and quality linkage
// ---------------------------------------------------------------------------

test("12. severity follows ONLY whether the matcher consumes the field (derived from the one FACT_FIELDS table)", () => {
  eq(analyse([obs("risk.product", "a", "motor"), obs("risk.product", "b", "property")]).contradictions[0].severity, "material", "product_line is a matcher input");
  eq(analyse([obs("risk.sector", "a", "x"), obs("risk.sector", "b", "y")]).contradictions[0].severity, "material", "business_sector is a matcher input");
  const advisory = analyse([obs("broker.email", "a", "a@x.co"), obs("broker.email", "b", "b@x.co")]).contradictions[0];
  eq(advisory.severity, "advisory", "broker email is not");
  eq(advisory.severity_basis, "field_not_consumed_by_matcher", "basis stated");
  eq(advisory.affects_matcher_input, false, "flag");
  const material = analyse([obs("risk.product", "a", "motor"), obs("risk.product", "b", "property")]).contradictions[0];
  deepEq(material.matcher_roles, ["product_candidate"], "roles recorded");
  eq(material.affects_matcher_input, true, "flag");
  assert(!JSON.stringify(analyse([obs("risk.product", "a", "m"), obs("risk.product", "b", "p")])).includes("blocker"), "never a blocker");
  deepEq(matcherRolesFor("not.a.fact"), [], "unknown paths have no roles");
  deepEq(matcherRolesFor(null), [], "no path, no roles");
});

test("13. CASE 34 — a contradiction on a matcher-consumed field becomes a MATERIAL quality gap that links back; scores are not an input", () => {
  const contradictions = analyse([obs("risk.product", "intake", "commercial motor"), obs("risk.product", "extraction", "commercial property")]);
  const completeness = assessCompleteness({
    requestedSections: [{ section: "Commercial motor", section_key: "commercial_motor" }],
    insurers: [],
    reported: { records: [], omitted: 0 },
  });
  const assessed = assessQualityV3({
    facts: [],
    insurers: [],
    requestedSections: [{ section: "Commercial motor", section_key: "commercial_motor" }],
    trustedDocumentCount: 1,
    completeness,
    contradictions,
  });
  const gap = assessed.quality.gaps.find((g) => g.code === "conflicting_recorded_values")!;
  assert(gap, "gap exists");
  eq(gap.severity, "material", "material because the matcher consumes the field");
  eq(gap.contradiction_id, contradictions.contradictions[0].contradiction_id, "gap -> contradiction");
  eq(assessed.contradictions.contradictions[0].quality_gap_id, gap.gap_id, "contradiction -> gap");
  eq(assessed.quality.state, "caution", "the reliance state moves to caution");
  eq(assessed.quality.blocker_count, 0, "a contradiction can never create a blocker");
  eq(gap.insurer_id, null, "recommendation-level: no individual insurer is re-labelled");
});

test("14. an advisory contradiction leaves the reliance state untouched", () => {
  const contradictions = analyse([obs("broker.email", "a", "a@x.co"), obs("broker.email", "b", "b@x.co")]);
  const assessed = assessQualityV3({
    facts: [],
    insurers: [],
    requestedSections: [{ section: "Commercial motor", section_key: "commercial_motor" }],
    trustedDocumentCount: 1,
    completeness: assessCompleteness({ requestedSections: [{ section: "Commercial motor", section_key: "commercial_motor" }], insurers: [], reported: { records: [], omitted: 0 } }),
    contradictions,
  });
  eq(assessed.quality.state, "decision_ready", "advisory only");
  eq(assessed.quality.advisory_count, 1, "but it is listed");
});

// ---------------------------------------------------------------------------
// No false positives
// ---------------------------------------------------------------------------

test("15. nothing recorded is not a disagreement: null, undefined, blank and whitespace are absent", () => {
  for (const blank of [null, undefined, "", "   ", "\n\t"]) {
    eq(isAbsentValue(blank), true, `absent: ${JSON.stringify(blank)}`);
  }
  eq(isAbsentValue(0), false, "0 is a value");
  eq(isAbsentValue(false), false, "false is a value");
  // Through the real collector: a reviewed field with a null value is not an observation.
  const set1 = collectObservations({
    reviewed: { broker: { email: { value: null, status: "not_found" } } },
    extractionId: "e",
    intake: { status: "available", record: { broker_email: "a@x.co" } },
  });
  deepEq(set1.observations.map((o) => o.source_id), ["intake_form"], "only the intake value exists");
  const result = analyseContradictions({ observations: set1 });
  eq(result.contradiction_count, 0, "null vs value: no contradiction");
  eq(result.comparisons[0].outcome, "single_source", "a single source cannot disagree with itself");
  // A genuinely absent intake row behaves the same.
  const set2 = collectObservations({
    reviewed: { broker: { email: { value: "a@x.co", status: "extracted", confidence: 0.9 } } },
    extractionId: "e",
    intake: { status: "not_found" },
  });
  eq(analyseContradictions({ observations: set2 }).comparisons[0].outcome, "single_source", "no intake row: nothing to compare");
});

test("16. malformed values are 'comparison unavailable', never a contradiction", () => {
  const result = analyse([obs("broker.email", "a", "see attached"), obs("broker.email", "b", "b@x.co")]);
  eq(result.contradiction_count, 0, "no contradiction");
  eq(result.comparisons[0].outcome, "comparison_unavailable", "unavailable");
  deepEq(result.comparisons[0].unparseable_source_ids, ["a"], "which source");
  eq(result.unavailable_count, 1, "counted");
  // Two readable sources still compare even if a third is unreadable.
  const withNoise = analyse([obs("broker.email", "a", "a@x.co"), obs("broker.email", "b", "A@X.CO"), obs("broker.email", "c", "junk")]);
  eq(withNoise.comparisons[0].outcome, "agree", "the readable pair agrees");
  deepEq(withNoise.comparisons[0].unparseable_source_ids, ["c"], "and the unreadable one is reported");
  // A single malformed value has nothing to be compared with.
  eq(analyse([obs("broker.email", "a", "junk")]).comparisons[0].outcome, "single_source", "single malformed value");
});

test("17. an unreadable SOURCE is 'comparison unavailable'; it never invents agreement or conflict", () => {
  // The injected registry declares no sources, so this one runs on the production registry.
  const real = analyseContradictions({
    observations: collectObservations({
      reviewed: { broker: { email: { value: "b@x.co", status: "extracted", confidence: 0.9 } } },
      extractionId: "e",
      intake: { status: "unavailable" },
    }),
  });
  eq(real.contradiction_count, 0, "no contradiction");
  eq(real.comparisons[0].outcome, "comparison_unavailable", "unavailable");
  eq(real.comparisons[0].unavailable_reason, "source_unavailable", "reason");
  deepEq(real.comparisons[0].unavailable_source_ids, ["intake_form"], "which source");
});

test("18. PROPERTY — formatting variants of ONE identifier never contradict (1,000 randomised mutations)", () => {
  let state = 99;
  const next = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state; };
  const base = "jane.doe@example.co.za";
  const variants = (): string => {
    let value = base;
    if (next() % 2) value = value.toUpperCase();
    else if (next() % 2) value = value.replace(/^./, (c) => c.toUpperCase());
    const pad = (n: number) => " ".repeat(n % 4);
    return `${pad(next())}${value}${pad(next())}`;
  };
  for (let i = 0; i < 1000; i++) {
    const count = 2 + (next() % 4);
    const observations = Array.from({ length: count }, (_, index) => obs("broker.email", `source-${index}`, variants()));
    const result = analyse(shuffled(observations, next()));
    eq(result.contradiction_count, 0, `iteration ${i}: formatting is not disagreement`);
  }
});

test("19. PROPERTY — a genuinely different value always contradicts, wherever it sits in the input (mutation of one character)", () => {
  const base = "jane.doe@example.co.za";
  for (let position = 0; position < base.length; position++) {
    if (base[position] === "@" || base[position] === ".") continue;
    const mutated = `${base.slice(0, position)}${base[position] === "x" ? "y" : "x"}${base.slice(position + 1)}`;
    const result = analyse([obs("broker.email", "a", base), obs("broker.email", "b", base.toUpperCase()), obs("broker.email", "c", mutated)]);
    eq(result.contradiction_count, 1, `position ${position}: one-character change is a real difference`);
  }
});

test("20. ORDER — reversing or shuffling the sources never changes the analysis", () => {
  const observations = [
    obs("risk.sector", "s1", "Transport"), obs("risk.sector", "s2", "transport"), obs("risk.sector", "s3", "Logistics"),
    obs("broker.email", "i", "a@x.co"), obs("broker.email", "e", "b@x.co"),
    obs("claims.flag", "a", "yes"), obs("claims.flag", "b", "yes"),
  ];
  const base = JSON.stringify(analyse(observations));
  eq(JSON.stringify(analyse([...observations].reverse())), base, "reversed");
  for (let seed = 1; seed <= 25; seed++) eq(JSON.stringify(analyse(shuffled(observations, seed))), base, `shuffle ${seed}`);
});

test("21. DUPLICATES — the same value from the same source twice, or from two documents, is still one value", () => {
  const groupOf = (analysis: ContradictionAnalysis, sourceId: string) =>
    analysis.contradictions[0].value_groups.find((g) => g.sources.some((s) => s.source_id === sourceId))!;
  const same = analyse([obs("risk.sector", "s1", "x"), obs("risk.sector", "s1", "x"), obs("risk.sector", "s2", "y")]);
  eq(groupOf(same, "s1").source_count, 1, "identical duplicate observations collapse");
  const twoDocuments = analyse([
    obs("risk.sector", "doc", "x", { pointer: { record: "atlas_extractions", record_id: "e", field_path: "p", document_id: "d1", page: 1 } }),
    obs("risk.sector", "doc", "x", { pointer: { record: "atlas_extractions", record_id: "e", field_path: "p", document_id: "d2", page: 4 } }),
    obs("risk.sector", "other", "y"),
  ]);
  const group = groupOf(twoDocuments, "doc");
  eq(group.source_count, 2, "two distinct documents are two pointers");
  eq(twoDocuments.contradictions[0].value_groups.length, 2, "but still ONE value");
  // Agreement among duplicates is not a contradiction and creates nothing.
  eq(analyse([obs("risk.sector", "s1", "x"), obs("risk.sector", "s2", "x"), obs("risk.sector", "s3", "x")]).contradiction_count, 0, "duplicate agreement");
});

test("22. unregistered fields can never produce a contradiction", () => {
  const result = analyse([obs("not.registered", "a", "1"), obs("not.registered", "b", "2")]);
  eq(result.contradiction_count, 0, "not registered");
  deepEq(result.comparisons, [], "not even compared");
});

// ---------------------------------------------------------------------------
// Source precedence and resolution
// ---------------------------------------------------------------------------

test("23. NO PRECEDENCE — swapping which source holds which value changes nothing but attribution; no value is 'chosen'", () => {
  const a = analyse([obs("broker.email", "intake", "a@x.co"), obs("broker.email", "extraction", "b@x.co")]);
  const b = analyse([obs("broker.email", "intake", "b@x.co"), obs("broker.email", "extraction", "a@x.co")]);
  eq(a.contradictions[0].contradiction_id, b.contradictions[0].contradiction_id, "same disagreement, same identity");
  eq(a.source_precedence, "none_applied", "stated");
  const text = JSON.stringify(a).toLowerCase();
  for (const word of ["chosen", "winner", "correct_value", "authoritative", "preferred_value", "resolved_to"]) assert(!text.includes(word), `no '${word}' anywhere`);
  deepEq(a.contradictions[0].value_groups.map((g) => g.value_digest), b.contradictions[0].value_groups.map((g) => g.value_digest), "groups are ordered by neutral digest, not by source");
});

test("24. a contradiction never resolves itself: status and resolution are always 'unresolved'", () => {
  for (const c of analyse([obs("risk.sector", "a", "x"), obs("risk.sector", "b", "y")]).contradictions) {
    eq(c.status, "unresolved", "status");
    eq(c.resolution_state, "unresolved", "resolution");
  }
});

test("25. re-analysing the same input is byte-identical, and a changed value yields a different identity", () => {
  const input = [obs("broker.email", "a", "a@x.co"), obs("broker.email", "b", "b@x.co")];
  eq(JSON.stringify(analyse(input)), JSON.stringify(analyse(input)), "deterministic");
  const changed = analyse([obs("broker.email", "a", "a@x.co"), obs("broker.email", "b", "c@x.co")]);
  assert(analyse(input).contradictions[0].contradiction_id !== changed.contradictions[0].contradiction_id, "a different disagreement has a different id");
});

// ---------------------------------------------------------------------------
// Privacy
// ---------------------------------------------------------------------------

test("26. PRIVACY — raw values are never persisted; sensitive kinds are masked; digests differ", () => {
  const raw1 = "Alice.Private@Example-Brokers.co.za";
  const raw2 = "bob.secret@other-brokers.co.za";
  const result = analyse([obs("broker.email", "a", raw1), obs("broker.email", "b", raw2)]);
  const text = JSON.stringify(result);
  for (const needle of [raw1, raw1.toLowerCase(), raw2, "alice.private", "bob.secret", "example-brokers", "other-brokers"]) {
    assert(!text.toLowerCase().includes(needle.toLowerCase()), `${needle} must not be persisted`);
  }
  deepEq(result.contradictions[0].value_groups.map((g) => g.value_display).sort(), ["a•••@•••.za", "b•••@•••.za"], "masked");
  eq(new Set(result.contradictions[0].value_groups.map((g) => g.value_digest)).size, 2, "distinct digests");
  const registration = analyse([obs("vehicle.registration", "a", "CA 123-456"), obs("vehicle.registration", "b", "CA 123-457")]);
  assert(!JSON.stringify(registration).includes("123456"), "identifier body not persisted");
  deepEq(registration.contradictions[0].value_groups.map((g) => g.value_display).sort(), ["C•••56", "C•••57"], "masked identifier");
});

test("27. PRIVACY — an enum is displayed only when the registry DECLARES a closed vocabulary; anything else is digest-only", () => {
  // No declared vocabulary: even a short, innocent-looking value is not displayed.
  const undeclared = analyse([obs("risk.sector", "a", "Another long sentence with a name"), obs("risk.sector", "b", "transport")]);
  for (const group of undeclared.contradictions[0].value_groups) eq(group.value_display, null, "no declared vocabulary => digest only");
  // Declared vocabulary: members are shown; a free-text value outside it is not.
  const declared = analyseContradictions({
    observations: set([obs("risk.sector", "a", "Transport"), obs("risk.sector", "b", "A sentence about Mr Smith's business at 12 Main Road"), obs("risk.sector", "c", "logistics")]),
    registry: [spec("risk.sector", "enum_trim_collapse_casefold", { field_path: "risk_classification.business_sector", closed_vocabulary: ["transport", "logistics"] })],
  });
  const shown = declared.contradictions[0].value_groups.map((g) => g.value_display);
  eq(shown.filter((value) => value === null).length, 1, "the free-text value is withheld");
  deepEq(shown.filter((value): value is string => value !== null).sort(), ["logistics", "transport"], "members of the vocabulary are shown");
  assert(!JSON.stringify(declared).includes("Smith"), "the free text is nowhere in the analysis");
  // Booleans, dates and numbers are typed canonical values and are shown.
  eq(analyse([obs("sum.insured", "a", "10"), obs("sum.insured", "b", "20")]).contradictions[0].value_groups.every((g) => g.value_display !== null), true, "typed values");
});

test("28. masking never reveals more than the first character and a TLD / the last two characters", () => {
  eq(maskIdentifier("email", "alice@example.co.za"), "a•••@•••.za", "email");
  eq(maskIdentifier("identifier", "CA123456"), "C•••56", "identifier");
  eq(maskIdentifier("identifier", "AB12"), "•••", "short identifiers are fully masked");
});

// ---------------------------------------------------------------------------
// Fingerprint input
// ---------------------------------------------------------------------------

test("29. fingerprintObservations: normalised-equal inputs share a digest; any real change, an unreadable source or a new source changes it", () => {
  const base = collectObservations({
    reviewed: { broker: { email: { value: "b@x.co", status: "extracted", confidence: 0.9 } } },
    extractionId: "e",
    intake: { status: "available", record: { broker_email: "a@x.co" } },
  });
  const digest = fingerprintObservations(base);
  assert(/^[0-9a-f]{64}$/.test(digest), "sha-256 hex");
  const cosmetic = collectObservations({
    reviewed: { broker: { email: { value: "b@x.co", status: "extracted", confidence: 0.9 } } },
    extractionId: "e",
    intake: { status: "available", record: { broker_email: "  A@X.CO " } },
  });
  eq(fingerprintObservations(cosmetic), digest, "cosmetic edit: same digest (same analysis)");
  const changed = collectObservations({
    reviewed: { broker: { email: { value: "b@x.co", status: "extracted", confidence: 0.9 } } },
    extractionId: "e",
    intake: { status: "available", record: { broker_email: "z@x.co" } },
  });
  assert(fingerprintObservations(changed) !== digest, "a different value");
  const unreadable = collectObservations({
    reviewed: { broker: { email: { value: "b@x.co", status: "extracted", confidence: 0.9 } } },
    extractionId: "e",
    intake: { status: "unavailable" },
  });
  assert(fingerprintObservations(unreadable) !== digest, "an unreadable source is not the same as an empty one");
  const missing = collectObservations({
    reviewed: { broker: { email: { value: "b@x.co", status: "extracted", confidence: 0.9 } } },
    extractionId: "e",
    intake: { status: "not_found" },
  });
  assert(fingerprintObservations(missing) !== digest && fingerprintObservations(missing) !== fingerprintObservations(unreadable), "not found, unreadable and available are three different inputs");
  const reordered = { ...base, observations: [...base.observations].reverse() };
  eq(fingerprintObservations(reordered), digest, "observation order is irrelevant");
  assert(!digest.includes("a@x.co"), "no raw value in the digest");
});

// ---------------------------------------------------------------------------
// The registry itself
// ---------------------------------------------------------------------------

test("30. the production registry is exactly the one defensible comparison, and every entry is well formed", () => {
  deepEq(COMPARABLE_FIELDS.map((f) => f.field_key), ["broker.email"], "one field: intake broker email vs reviewed broker email");
  for (const field of COMPARABLE_FIELDS) {
    assert(field.sources.length >= 2, `${field.field_key}: at least two independent sources`);
    assert(NORMALIZERS[field.normalizer], `${field.field_key}: known normaliser`);
    eq(new Set(field.sources.map((s) => s.source_id)).size, field.sources.length, `${field.field_key}: distinct sources`);
  }
  deepEq(COMPARABLE_FIELDS[0].sources.map((s) => s.source_id), ["intake_form", "reviewed_extraction"], "intake vs reviewed");
  deepEq(matcherRolesFor(COMPARABLE_FIELDS[0].field_path), [], "broker email is not consumed by the matcher");
});

test("31. collectObservations reads real shapes: provenance pointers carry no text, only ids and pages", () => {
  const goodDocument = "11111111-2222-4333-8444-555555555555";
  const result = collectObservations({
    reviewed: {
      broker: {
        email: {
          value: "b@x.co", status: "low_confidence_extracted", confidence: 0.4,
          source: { document_id: goodDocument, file_name: "PRIVATE-NAME.pdf", page: 3, section: "S", snippet: "SNIPPET TEXT b@x.co" },
        },
      },
    },
    extractionId: "ext-1",
    intake: { status: "available", record: { broker_email: "a@x.co" } },
  });
  const reviewed = result.observations.find((o) => o.source_id === "reviewed_extraction")!;
  deepEq(reviewed.pointer, { record: "atlas_extractions", record_id: "ext-1", field_path: "broker.email", document_id: goodDocument, page: 3 }, "pointer");
  eq(reviewed.field_status, "low_confidence_extracted", "status carried");
  eq(reviewed.confidence, 0.4, "confidence carried");
  const garbled = collectObservations({
    reviewed: { broker: { email: { value: "b@x.co", status: "extracted", source: { document_id: "not-a-uuid", page: "3" } } } },
    extractionId: "ext-1",
    intake: { status: "not_found" },
  }).observations[0];
  deepEq(garbled.pointer, { record: "atlas_extractions", record_id: "ext-1", field_path: "broker.email", document_id: null, page: null }, "an invented document id or page is dropped, not trusted");
  // Nothing from file names or snippets can reach the analysis.
  const analysis = JSON.stringify(analyseContradictions({ observations: result }));
  for (const forbidden of ["PRIVATE-NAME", "SNIPPET TEXT"]) assert(!analysis.includes(forbidden), `${forbidden} must not be carried`);
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
console.log(`\nPowerhouse contradictions: ${tests.length - failures} passed, ${failures} failed out of ${tests.length}`);
if (failures > 0) process.exitCode = 1;
