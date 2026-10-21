/**
 * Powerhouse Phase 4 — deterministic contradiction detection.
 *
 * Question answered: "which RECORDED values for the same fact disagree?"
 * Question deliberately NOT answered: "which one is true?"
 *
 * Hard rules (each is enforced by tests/powerhouse/contradictions.test.ts):
 *   - No LLM, no embeddings, no fuzzy matching, no tolerance. A contradiction is
 *     two (or more) values that are DIFFERENT after a documented, deterministic
 *     normalisation, recorded by independent sources, for a field that is
 *     explicitly registered as comparable.
 *   - Atlas applies NO source precedence. Reviewed does not beat intake, newer does
 *     not beat older, higher confidence does not win. The analysis says
 *     `source_precedence: "none_applied"`. (The one existing precedence — a saved
 *     human review supersedes the AI's original extraction — is respected by never
 *     treating extracted-vs-reviewed as a contradiction: see the registry notes.)
 *   - Values that cannot be parsed are "comparison unavailable", never a
 *     contradiction. A source that could not be read is "comparison unavailable".
 *     Absent / null / blank is "nothing recorded", never a disagreement.
 *   - Agreement is not reported as evidence and is never scored.
 *   - One logical contradiction CLUSTER per field (value groups), never one
 *     record per pair of sources.
 *   - Raw values are TRANSIENT. They are normalised, digested and discarded: the
 *     persisted analysis carries a typed canonical value only for non-sensitive
 *     kinds, a masked rendition for personal identifiers, and always a
 *     domain-separated SHA-256 prefix. Never a URL, storage path or free text.
 *   - Contradictions never score, rank, decline or refer. They feed the quality
 *     gate (presentation / reliance) and nothing else. A contradiction is NOT
 *     evidence of fraud or misrepresentation; severity is never `blocker`
 *     (that would require proving the field drives a hard decline, which needs a
 *     counterfactual matcher run this batch does not perform).
 *
 * Cost is linear in (observations + registry sources): keyed by field, no
 * source × field scan.
 */

import { sha256Hex } from "./digest.js";
import { FACT_FIELDS, type ReviewedRiskEvidence } from "./recommendation-evidence.js";

export const CONTRADICTION_MODEL_VERSION = "recommendation-contradictions-v1" as const;

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

export type ComparisonKind = "enum" | "boolean" | "identifier" | "email" | "date" | "number";

export type NormalizerId =
  | "enum_trim_collapse_casefold"
  | "boolean_yes_no"
  | "identifier_strip_separators_uppercase"
  | "email_trim_lowercase"
  | "date_iso_calendar"
  | "number_plain_decimal";

export type UnparseableReason =
  | "unsupported_value_shape"
  | "not_a_boolean"
  | "unsupported_identifier_characters"
  | "not_an_email_address"
  | "not_an_iso_calendar_date"
  | "not_a_plain_number"
  | "value_too_long";

export type MatcherRole = ReviewedRiskEvidence["matcher_roles"][number];

export type FieldSensitivity = "none" | "personal_identifier";

export type SourcePointer =
  | { record: "atlas_submissions"; column: string }
  | {
      record: "atlas_extractions";
      record_id: string;
      field_path: string;
      document_id: string | null;
      page: number | null;
    };

export interface Observation {
  field_key: string;
  source_id: string;
  source_label: string;
  /** TRANSIENT. Never persisted, never logged. */
  raw: unknown;
  pointer: SourcePointer;
  field_status: string | null;
  confidence: number | null;
}

export interface UnavailableSource {
  source_id: string;
  reason: "source_read_failed";
}

export interface ObservationSet {
  observations: Observation[];
  unavailable_sources: UnavailableSource[];
}

// ---------------------------------------------------------------------------
// Normalisation — every comparison documents its normaliser; nothing meaningful
// is silently normalised away (characters outside a normaliser's alphabet make
// the value UNPARSEABLE, not "equal after dropping them").
// ---------------------------------------------------------------------------

type NormalizeResult = { ok: true; value: string } | { ok: false; reason: UnparseableReason };

export interface NormalizerSpec {
  id: NormalizerId;
  kind: ComparisonKind;
  /** The exact steps, in order. Persisted with every contradiction. */
  steps: string[];
  normalize(raw: unknown): NormalizeResult;
}

const MAX_VALUE_LENGTH = 200;

function asText(raw: unknown): string | null {
  if (typeof raw === "string") return raw;
  if (typeof raw === "number" && Number.isFinite(raw)) return String(raw);
  return null;
}

function canonicalDecimal(text: string): string | null {
  const match = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) return null;
  const integer = match[2].replace(/^0+(?=\d)/, "");
  const fraction = (match[3] ?? "").replace(/0+$/, "");
  const negative = match[1] === "-" && (integer !== "0" || fraction !== "");
  return `${negative ? "-" : ""}${integer}${fraction ? `.${fraction}` : ""}`;
}

function isoCalendarDate(text: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1000) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return text;
}

export const NORMALIZERS: Record<NormalizerId, NormalizerSpec> = {
  enum_trim_collapse_casefold: {
    id: "enum_trim_collapse_casefold",
    kind: "enum",
    steps: ["require text", "trim surrounding whitespace", "collapse internal whitespace runs to one space", "lower-case"],
    normalize(raw) {
      if (typeof raw !== "string") return { ok: false, reason: "unsupported_value_shape" };
      const value = raw.trim().replace(/\s+/g, " ").toLowerCase();
      if (value.length > MAX_VALUE_LENGTH) return { ok: false, reason: "value_too_long" };
      return { ok: true, value };
    },
  },
  boolean_yes_no: {
    id: "boolean_yes_no",
    kind: "boolean",
    steps: ["accept boolean, 1/0, or true/false/yes/no/y/n text (trimmed, lower-cased)", "map to \"true\" | \"false\""],
    normalize(raw) {
      if (typeof raw === "boolean") return { ok: true, value: raw ? "true" : "false" };
      const text = asText(raw);
      if (text === null) return { ok: false, reason: "unsupported_value_shape" };
      const key = text.trim().toLowerCase();
      if (["true", "yes", "y", "1"].includes(key)) return { ok: true, value: "true" };
      if (["false", "no", "n", "0"].includes(key)) return { ok: true, value: "false" };
      return { ok: false, reason: "not_a_boolean" };
    },
  },
  identifier_strip_separators_uppercase: {
    id: "identifier_strip_separators_uppercase",
    kind: "identifier",
    steps: [
      "require text or number",
      "remove whitespace and the separators - _ . / \\",
      "upper-case",
      "require 1-64 characters of A-Z / 0-9 only (anything else makes the value unparseable)",
    ],
    normalize(raw) {
      const text = asText(raw);
      if (text === null) return { ok: false, reason: "unsupported_value_shape" };
      const value = text.replace(/[\s\-_./\\]+/g, "").toUpperCase();
      if (!/^[A-Z0-9]{1,64}$/.test(value)) return { ok: false, reason: "unsupported_identifier_characters" };
      return { ok: true, value };
    },
  },
  email_trim_lowercase: {
    id: "email_trim_lowercase",
    kind: "email",
    steps: [
      "require text",
      "trim surrounding whitespace",
      "lower-case (the repository already compares email identifiers this way)",
      "require one at-sign separating a local part from a dotted domain, with no spaces, angle brackets, commas or semicolons",
    ],
    normalize(raw) {
      if (typeof raw !== "string") return { ok: false, reason: "unsupported_value_shape" };
      const value = raw.trim().toLowerCase();
      if (value.length > 254) return { ok: false, reason: "value_too_long" };
      if (!/^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]+$/.test(value)) {
        return { ok: false, reason: "not_an_email_address" };
      }
      return { ok: true, value };
    },
  },
  date_iso_calendar: {
    id: "date_iso_calendar",
    kind: "date",
    steps: ["require text", "trim surrounding whitespace", "require YYYY-MM-DD", "require a real calendar date (year >= 1000)"],
    normalize(raw) {
      if (typeof raw !== "string") return { ok: false, reason: "unsupported_value_shape" };
      const value = isoCalendarDate(raw.trim());
      return value === null ? { ok: false, reason: "not_an_iso_calendar_date" } : { ok: true, value };
    },
  },
  number_plain_decimal: {
    id: "number_plain_decimal",
    kind: "number",
    steps: [
      "require a finite number or text of the form [+-]digits[.digits] (no currency, thousands separators or exponents)",
      "drop a leading +, leading zeros and trailing fractional zeros; -0 is 0",
      "compare as decimal TEXT (no floating-point)",
    ],
    normalize(raw) {
      const text = asText(raw);
      if (text === null) return { ok: false, reason: "unsupported_value_shape" };
      const value = canonicalDecimal(text.trim());
      return value === null ? { ok: false, reason: "not_a_plain_number" } : { ok: true, value };
    },
  },
};

/** True for "nothing recorded": null, undefined, blank text. Never a disagreement. */
export function isAbsentValue(raw: unknown): boolean {
  return raw === null || raw === undefined || (typeof raw === "string" && raw.trim() === "");
}

// ---------------------------------------------------------------------------
// Registry — the ONLY fields Atlas will compare.
//
// Adding a field is a deliberate, reviewed act: it needs two independently
// recorded sources, a normaliser whose meaning is established, and a decision on
// sensitivity. See docs/powerhouse-p3-p4-forensic-baseline.md §G for the candidate
// pairs that were examined and left OUT (extracted-vs-reviewed is superseded by the
// review mechanism; names and addresses have no established normaliser; markers
// written by the extraction model are an LLM verdict, not two retained values).
// ---------------------------------------------------------------------------

export interface IntakeRecord {
  broker_email?: unknown;
}

export type IntakeInput =
  | { status: "available"; record: IntakeRecord }
  | { status: "not_found" }
  | { status: "unavailable" };

export interface ObservationContext {
  reviewed: Record<string, unknown>;
  extractionId: string;
  intake: IntakeInput;
}

export type SourceRead =
  | {
      status: "value";
      raw: unknown;
      pointer: SourcePointer;
      field_status: string | null;
      confidence: number | null;
    }
  | { status: "absent" }
  | { status: "unavailable" };

export interface ObservationSourceSpec {
  source_id: string;
  label: string;
  read(context: ObservationContext): SourceRead;
}

export interface ComparableFieldSpec {
  field_key: string;
  label: string;
  normalizer: NormalizerId;
  sensitivity: FieldSensitivity;
  /**
   * The reviewed-extraction path of this fact when it is one (e.g.
   * `risk_classification.product_line`). Matcher roles are derived from the
   * single FACT_FIELDS table through this path; `null` means the field is not a
   * reviewed matcher input.
   */
  field_path: string | null;
  /**
   * For an `enum` field: the closed set of (normalised) values that are safe to
   * display. A value outside the set — or any enum field that declares no set —
   * is shown by digest only, because an "enum" that is really free text must never
   * be copied into the evidence.
   */
  closed_vocabulary?: readonly string[];
  sources: ObservationSourceSpec[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Read `reviewed[section][key]` as an extracted field `{value, status, confidence, source}`. */
export function reviewedFieldSource(section: string, key: string): ObservationSourceSpec["read"] {
  return (context) => {
    const bag = context.reviewed[section];
    const field = isRecord(bag) ? bag[key] : undefined;
    if (!isRecord(field) || !("value" in field) || isAbsentValue(field.value)) return { status: "absent" };
    const source = isRecord(field.source) ? field.source : {};
    return {
      status: "value",
      raw: field.value,
      pointer: {
        record: "atlas_extractions",
        record_id: context.extractionId,
        field_path: `${section}.${key}`,
        document_id: typeof source.document_id === "string" && UUID.test(source.document_id) ? source.document_id : null,
        page: typeof source.page === "number" && Number.isFinite(source.page) ? source.page : null,
      },
      field_status: typeof field.status === "string" ? field.status : null,
      confidence: typeof field.confidence === "number" && Number.isFinite(field.confidence) ? field.confidence : null,
    };
  };
}

/** Read one column of the submission's intake row. */
export function intakeColumnSource(column: keyof IntakeRecord & string): ObservationSourceSpec["read"] {
  return (context) => {
    if (context.intake.status === "unavailable") return { status: "unavailable" };
    if (context.intake.status === "not_found") return { status: "absent" };
    const raw = context.intake.record[column];
    if (isAbsentValue(raw)) return { status: "absent" };
    return {
      status: "value",
      raw,
      pointer: { record: "atlas_submissions", column },
      field_status: null,
      confidence: null,
    };
  };
}

export const SOURCE_INTAKE_FORM = "intake_form";
export const SOURCE_REVIEWED_EXTRACTION = "reviewed_extraction";

export const COMPARABLE_FIELDS: readonly ComparableFieldSpec[] = [
  {
    field_key: "broker.email",
    label: "Broker email address",
    normalizer: "email_trim_lowercase",
    sensitivity: "personal_identifier",
    field_path: "broker.email",
    sources: [
      { source_id: SOURCE_INTAKE_FORM, label: "Submission intake", read: intakeColumnSource("broker_email") },
      {
        source_id: SOURCE_REVIEWED_EXTRACTION,
        label: "Reviewed extraction",
        read: reviewedFieldSource("broker", "email"),
      },
    ],
  },
];

export function matcherRolesFor(fieldPath: string | null): MatcherRole[] {
  if (!fieldPath) return [];
  const spec = FACT_FIELDS.find((item) => `${item.section}.${item.key}` === fieldPath);
  return spec ? [...spec.roles] : [];
}

// ---------------------------------------------------------------------------
// Persisted contract
// ---------------------------------------------------------------------------

export interface ContradictionSourceRef {
  source_id: string;
  source_label: string;
  pointer: SourcePointer;
  field_status: string | null;
  confidence: number | null;
}

export interface ContradictionValueGroup {
  /** First 16 hex chars of SHA-256 over a domain-separated normalised value. */
  value_digest: string;
  /**
   * Typed canonical value for non-sensitive kinds (boolean / date / number /
   * closed enum). A masked rendition for personal identifiers. `null` when the
   * value is not safe to show at all. NEVER the raw recorded text.
   */
  value_display: string | null;
  source_count: number;
  sources: ContradictionSourceRef[];
}

export interface ContradictionRecord {
  contradiction_id: string;
  code: "conflicting_recorded_values";
  field_key: string;
  field_path: string | null;
  label: string;
  scope: "submission";
  /** Always `unresolved` at detection: Atlas has no record of a human accepting the disagreement. */
  status: "unresolved";
  resolution_state: "unresolved";
  severity: "material" | "advisory";
  severity_basis: "matcher_consumed_field" | "field_not_consumed_by_matcher";
  comparison_basis: { kind: ComparisonKind; normalization: NormalizerId; normalization_steps: string[] };
  affects_matcher_input: boolean;
  matcher_roles: MatcherRole[];
  /** Two or more groups; one group per distinct normalised value. */
  value_groups: ContradictionValueGroup[];
  /** Filled in by the quality integration. */
  quality_gap_id: string | null;
}

export type ComparisonOutcome = "agree" | "conflict" | "single_source" | "comparison_unavailable";

export interface FieldComparison {
  field_key: string;
  label: string;
  kind: ComparisonKind;
  normalization: NormalizerId;
  outcome: ComparisonOutcome;
  /** Distinct sources that supplied a comparable value. */
  source_ids: string[];
  unparseable_source_ids: string[];
  unavailable_source_ids: string[];
  unavailable_reason: "unparseable_value" | "source_unavailable" | null;
  contradiction_id: string | null;
}

export interface ContradictionAnalysis {
  model: typeof CONTRADICTION_MODEL_VERSION;
  /** Atlas reports disagreement; it never says which value is correct. */
  source_precedence: "none_applied";
  /** What Atlas looked at: one row per registered field that had a recorded value or an unreadable source. */
  comparisons: FieldComparison[];
  contradictions: ContradictionRecord[];
  contradiction_count: number;
  material_count: number;
  advisory_count: number;
  unavailable_count: number;
}

// ---------------------------------------------------------------------------
// Value representation
// ---------------------------------------------------------------------------

const DIGEST_DOMAIN = "atlas-contradiction-value-v1";

function valueDigest(fieldKey: string, normalized: string): string {
  return sha256Hex(`${DIGEST_DOMAIN}\u0000${fieldKey}\u0000${normalized}`).slice(0, 16);
}

export function maskIdentifier(kind: ComparisonKind, normalized: string): string {
  if (kind === "email") {
    const at = normalized.lastIndexOf("@");
    const local = at > 0 ? normalized.slice(0, at) : normalized;
    const tld = normalized.slice(normalized.lastIndexOf(".") + 1);
    return `${[...local][0] ?? ""}•••@•••.${tld}`;
  }
  const chars = [...normalized];
  return chars.length >= 7 ? `${chars[0]}•••${chars.slice(-2).join("")}` : "•••";
}

function displayFor(spec: ComparableFieldSpec, kind: ComparisonKind, normalized: string): string | null {
  if (spec.sensitivity === "personal_identifier") return maskIdentifier(kind, normalized);
  if (kind === "enum") return spec.closed_vocabulary?.includes(normalized) ? normalized : null;
  return normalized;
}

function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function pointerKey(pointer: SourcePointer): string {
  return JSON.stringify(pointer);
}

// ---------------------------------------------------------------------------
// Observation collection (adapter from Atlas records to comparable observations)
// ---------------------------------------------------------------------------

export function collectObservations(
  context: ObservationContext,
  registry: readonly ComparableFieldSpec[] = COMPARABLE_FIELDS
): ObservationSet {
  const observations: Observation[] = [];
  const unavailable = new Map<string, UnavailableSource>();
  for (const spec of registry) {
    for (const source of spec.sources) {
      const read = source.read(context);
      if (read.status === "absent") continue;
      if (read.status === "unavailable") {
        unavailable.set(source.source_id, { source_id: source.source_id, reason: "source_read_failed" });
        continue;
      }
      observations.push({
        field_key: spec.field_key,
        source_id: source.source_id,
        source_label: source.label,
        raw: read.raw,
        pointer: read.pointer,
        field_status: read.field_status,
        confidence: read.confidence,
      });
    }
  }
  return {
    observations,
    unavailable_sources: [...unavailable.values()].sort((a, b) => compareCodeUnits(a.source_id, b.source_id)),
  };
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

interface Normalised {
  observation: Observation;
  result: NormalizeResult;
}

function normaliseAll(spec: ComparableFieldSpec, observations: readonly Observation[]): Normalised[] {
  const normalizer = NORMALIZERS[spec.normalizer];
  return observations.map((observation) => ({
    observation,
    result: isAbsentValue(observation.raw) ? { ok: false as const, reason: "unsupported_value_shape" as const } : normalizer.normalize(observation.raw),
  }));
}

function groupObservationsByField(set: ObservationSet): Map<string, Observation[]> {
  const byField = new Map<string, Observation[]>();
  for (const observation of set.observations) {
    const list = byField.get(observation.field_key);
    if (list) list.push(observation);
    else byField.set(observation.field_key, [observation]);
  }
  return byField;
}

export function analyseContradictions(input: {
  observations: ObservationSet;
  registry?: readonly ComparableFieldSpec[];
}): ContradictionAnalysis {
  const registry = input.registry ?? COMPARABLE_FIELDS;
  const byField = groupObservationsByField(input.observations);
  const unavailableIds = new Set(input.observations.unavailable_sources.map((item) => item.source_id));
  const comparisons: FieldComparison[] = [];
  const contradictions: ContradictionRecord[] = [];

  for (const spec of [...registry].sort((a, b) => compareCodeUnits(a.field_key, b.field_key))) {
    const normalizer = NORMALIZERS[spec.normalizer];
    const observed = byField.get(spec.field_key) ?? [];
    const unavailableForField = spec.sources
      .map((source) => source.source_id)
      .filter((id) => unavailableIds.has(id))
      .sort(compareCodeUnits);
    // Nothing recorded means nothing to compare — even when another source could
    // not be read, there is no value on this side to disagree with.
    if (observed.length === 0) continue;

    const normalised = normaliseAll(spec, observed);
    const recordedSourceCount = new Set(observed.map((item) => item.source_id)).size;
    const usable = normalised.filter((item): item is Normalised & { result: { ok: true; value: string } } => item.result.ok);
    const unparseableSources = [
      ...new Set(normalised.filter((item) => !item.result.ok).map((item) => item.observation.source_id)),
    ].sort(compareCodeUnits);
    const usableSources = [...new Set(usable.map((item) => item.observation.source_id))].sort(compareCodeUnits);

    // Cluster by normalised value — one group per distinct value, de-duplicated sources.
    const groups = new Map<string, Map<string, Observation>>();
    for (const item of usable) {
      const refs = groups.get(item.result.value) ?? new Map<string, Observation>();
      refs.set(`${item.observation.source_id}\u0000${pointerKey(item.observation.pointer)}`, item.observation);
      groups.set(item.result.value, refs);
    }

    let outcome: ComparisonOutcome;
    let unavailableReason: FieldComparison["unavailable_reason"] = null;
    let contradictionId: string | null = null;

    if (groups.size >= 2) {
      outcome = "conflict";
      const valueGroups: ContradictionValueGroup[] = [...groups.entries()]
        .map(([normalized, refs]) => {
          const sources = [...refs.values()]
            .map<ContradictionSourceRef>((observation) => ({
              source_id: observation.source_id,
              source_label: observation.source_label,
              pointer: observation.pointer,
              field_status: observation.field_status,
              confidence: observation.confidence,
            }))
            .sort(
              (a, b) =>
                compareCodeUnits(a.source_id, b.source_id) || compareCodeUnits(pointerKey(a.pointer), pointerKey(b.pointer))
            );
          return {
            value_digest: valueDigest(spec.field_key, normalized),
            value_display: displayFor(spec, normalizer.kind, normalized),
            source_count: sources.length,
            sources,
          };
        })
        .sort((a, b) => compareCodeUnits(a.value_digest, b.value_digest));
      const roles = matcherRolesFor(spec.field_path);
      const consumed = roles.length > 0;
      contradictionId = `ctr:${spec.field_key}:${sha256Hex(valueGroups.map((g) => g.value_digest).join("+")).slice(0, 12)}`;
      contradictions.push({
        contradiction_id: contradictionId,
        code: "conflicting_recorded_values",
        field_key: spec.field_key,
        field_path: spec.field_path,
        label: spec.label,
        scope: "submission",
        status: "unresolved",
        resolution_state: "unresolved",
        severity: consumed ? "material" : "advisory",
        severity_basis: consumed ? "matcher_consumed_field" : "field_not_consumed_by_matcher",
        comparison_basis: { kind: normalizer.kind, normalization: normalizer.id, normalization_steps: [...normalizer.steps] },
        affects_matcher_input: consumed,
        matcher_roles: roles,
        value_groups: valueGroups,
        quality_gap_id: null,
      });
    } else if (unparseableSources.length > 0 && recordedSourceCount >= 2 && usableSources.length < 2) {
      // Two sources recorded a value but at least one cannot be read: Atlas cannot
      // say they agree OR disagree. (A single malformed value has nothing to be
      // compared with, so it is just `single_source` below.)
      outcome = "comparison_unavailable";
      unavailableReason = "unparseable_value";
    } else if (unavailableForField.length > 0) {
      outcome = "comparison_unavailable";
      unavailableReason = "source_unavailable";
    } else if (usableSources.length >= 2) {
      outcome = "agree";
    } else {
      outcome = "single_source";
    }

    comparisons.push({
      field_key: spec.field_key,
      label: spec.label,
      kind: normalizer.kind,
      normalization: normalizer.id,
      outcome,
      source_ids: usableSources,
      unparseable_source_ids: unparseableSources,
      unavailable_source_ids: unavailableForField,
      unavailable_reason: unavailableReason,
      contradiction_id: contradictionId,
    });
  }

  const material = contradictions.filter((item) => item.severity === "material").length;
  return {
    model: CONTRADICTION_MODEL_VERSION,
    source_precedence: "none_applied",
    comparisons,
    contradictions,
    contradiction_count: contradictions.length,
    material_count: material,
    advisory_count: contradictions.length - material,
    unavailable_count: comparisons.filter((item) => item.outcome === "comparison_unavailable").length,
  };
}

// ---------------------------------------------------------------------------
// Fingerprint input
// ---------------------------------------------------------------------------

/**
 * A cryptographic digest of everything the contradiction analysis would read:
 * for every registered observation, its field, source and NORMALISED outcome (or
 * why it could not be normalised), plus unreadable sources. Two inputs that
 * normalise identically produce identical analyses and therefore share a digest,
 * so cosmetic edits do not force a recompute; any change that can change the
 * output does. Raw values are not retained and the digest is never logged.
 */
export function fingerprintObservations(
  set: ObservationSet,
  registry: readonly ComparableFieldSpec[] = COMPARABLE_FIELDS
): string {
  const specs = new Map(registry.map((spec) => [spec.field_key, spec]));
  const rows: string[] = [];
  for (const observation of set.observations) {
    const spec = specs.get(observation.field_key);
    if (!spec) continue;
    const result = isAbsentValue(observation.raw)
      ? ({ ok: false, reason: "unsupported_value_shape" } as const)
      : NORMALIZERS[spec.normalizer].normalize(observation.raw);
    rows.push(
      [
        observation.field_key,
        observation.source_id,
        result.ok ? `ok:${result.value}` : `unparseable:${result.reason}`,
        pointerKey(observation.pointer),
        observation.field_status ?? "-",
        observation.confidence === null ? "-" : String(observation.confidence),
      ].join("\u0001")
    );
  }
  for (const source of set.unavailable_sources) rows.push(`unavailable\u0001${source.source_id}\u0001${source.reason}`);
  rows.sort(compareCodeUnits);
  return sha256Hex(`${CONTRADICTION_MODEL_VERSION}\u0002${rows.join("\u0002")}`);
}
