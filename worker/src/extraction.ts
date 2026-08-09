/**
 * Atlas Blueprint - extraction contract
 * ----------------------------------------------------------------------------
 * The extraction contract is intentionally runtime-validated. Claude is useful
 * for reading messy insurance documents, but Atlas should only persist a shape
 * the rest of the underwriting workflow can trust.
 */

export const EXTRACTION_MODEL = "claude-sonnet-4-6";
export const EXTRACTION_SCHEMA_VERSION = "2026-06-phase1-evidence";

export const FIELD_STATUSES = [
  "extracted",
  "not_found",
  "not_applicable",
  "unclear",
  "conflicting",
  "low_confidence_extracted",
] as const;

export type FieldStatus = (typeof FIELD_STATUSES)[number];

export interface FieldSource {
  document_id: string | null;
  file_name: string | null;
  page: number | null;
  section: string | null;
  snippet: string | null;
}

/**
 * Where an extracted field's confidence number came from. This lets downstream
 * consumers tell "the provider rated this 0.4" apart from "no provider score
 * was available; do NOT interpret 0 as low quality" apart from "our own
 * deterministic rule set the number".
 *
 *   provider      — the LLM/OCR provider returned a numeric confidence.
 *   deterministic — a deterministic Atlas rule chose the number.
 *   unavailable   — no rating is available; confidence MUST be null.
 */
export type ConfidenceSource = "provider" | "deterministic" | "unavailable";

export interface ExtractedField {
  value: unknown;
  status: FieldStatus;
  /**
   * Nullable by contract. `null` means unavailable (see `confidence_source`);
   * do NOT synthesize a value to fill it. Downstream consumers must treat
   * `null` as "no information", never as "low quality".
   */
  confidence: number | null;
  /** Optional provenance marker. Absent means legacy/unspecified. */
  confidence_source?: ConfidenceSource;
  source: FieldSource;
  notes: string | null;
}

export interface ValidationResult {
  ok: boolean;
  value?: Record<string, unknown>;
  errors: string[];
}

const ALLOWED_STATUS = new Set<string>(FIELD_STATUSES);
const NULL_VALUE_STATUSES = new Set<FieldStatus>([
  "not_found",
  "not_applicable",
  "unclear",
  "conflicting",
]);

const FIELD_SOURCE_KEYS: (keyof FieldSource)[] = [
  "document_id",
  "file_name",
  "page",
  "section",
  "snippet",
];

const SECTION_FIELDS: Record<string, { field: string; array?: boolean }[]> = {
  extracted_client: [
    { field: "name" },
    { field: "entity_type" },
    { field: "registration_or_id_number" },
    { field: "occupation_or_business_description" },
    { field: "contact_details" },
    { field: "risk_address" },
  ],
  broker: [
    { field: "name" },
    { field: "email" },
    { field: "brokerage" },
  ],
  current_cover: [
    { field: "current_insurer" },
    { field: "renewal_date" },
    { field: "current_premium" },
    { field: "cover_sections", array: true },
    { field: "sums_insured", array: true },
    { field: "excesses", array: true },
    { field: "warranties", array: true },
    { field: "endorsements", array: true },
    { field: "exclusions", array: true },
    { field: "required_documents", array: true },
  ],
  risk_classification: [
    { field: "primary_risk_type" },
    { field: "product_line" },
    { field: "risk_type" },
    { field: "secondary_risk_types", array: true },
    { field: "business_sector" },
    { field: "complexity_level" },
  ],
  claims: [
    { field: "claims_history_available" },
    { field: "claims_summary" },
    { field: "loss_ratio_available" },
  ],
  quote_terms: [
    { field: "insurer_name" },
    { field: "quote_reference" },
    { field: "quote_date" },
    { field: "quote_expiry_date" },
    { field: "insured_name" },
    { field: "risk_address" },
    { field: "sections", array: true },
    { field: "required_documents", array: true },
    { field: "notes", array: true },
  ],
};

export const EXTRACTION_SYSTEM_PROMPT = `
You are the extraction engine for Atlas, an internal underwriting DECISION-SUPPORT
tool at a South African short-term insurance administrator. Your ONLY job is to
read the supplied documents and broker email and return a STRUCTURED RISK SUMMARY
as JSON.

STRICT RULES:
- Return ONLY a single JSON object. No prose, no markdown, no code fences.
- Use schema_version "${EXTRACTION_SCHEMA_VERSION}".
- Extract only facts visible in the supplied material. Do not guess.
- Separate facts, assumptions/inferences, missing information, conflicts, and
  underwriting red flags.
- You do NOT rate risk, calculate premiums, apply discounts, recommend an
  insurer, or make any underwriting decision.
- Every extracted field must use this exact field shape:
  {
    "value": any,
    "status": "extracted|not_found|not_applicable|unclear|conflicting|low_confidence_extracted",
    "confidence": 0,
    "source": {
      "document_id": null,
      "file_name": null,
      "page": null,
      "section": null,
      "snippet": null
    },
    "notes": null
  }
- confidence must be between 0 and 1.
- Use "extracted" only when the value is explicitly supported.
- Use "low_confidence_extracted" when a value is present but weakly supported.
- Use "not_found" when the information should exist but cannot be found.
- Use "not_applicable" when the item does not apply to this risk.
- Use "unclear" when the source is ambiguous or unreadable.
- Use "conflicting" when documents disagree; describe the conflict in notes.
- Do not invent page numbers or snippets. If unavailable, use null and lower
  confidence or mark the field unclear.
- Arrays must stay arrays. Objects must stay objects.
- If a document appears to be a scan/image with no readable text, do not
  fabricate content. Add a document_notes entry for that document.
- Use South African insurance context: ZAR sums insured, buildings, contents,
  SASRIA, public liability, motor, body corporate, sectional title, etc.

Return JSON in EXACTLY this shape:

{
  "schema_version": "${EXTRACTION_SCHEMA_VERSION}",
  "consultant_summary": "short consultant-friendly summary of what was found",
  "extracted_client": {
    "name": FIELD,
    "entity_type": FIELD,
    "registration_or_id_number": FIELD,
    "occupation_or_business_description": FIELD,
    "contact_details": FIELD,
    "risk_address": FIELD
  },
  "broker": {
    "name": FIELD,
    "email": FIELD,
    "brokerage": FIELD
  },
  "current_cover": {
    "current_insurer": FIELD,
    "renewal_date": FIELD,
    "current_premium": FIELD,
    "cover_sections": FIELD_WITH_ARRAY_VALUE,
    "sums_insured": FIELD_WITH_ARRAY_VALUE,
    "excesses": FIELD_WITH_ARRAY_VALUE,
    "warranties": FIELD_WITH_ARRAY_VALUE,
    "endorsements": FIELD_WITH_ARRAY_VALUE,
    "exclusions": FIELD_WITH_ARRAY_VALUE,
    "required_documents": FIELD_WITH_ARRAY_VALUE
  },
  "risk_classification": {
    "primary_risk_type": FIELD,
    "product_line": FIELD,
    "risk_type": FIELD,
    "secondary_risk_types": FIELD_WITH_ARRAY_VALUE,
    "business_sector": FIELD,
    "complexity_level": FIELD
  },
  "claims": {
    "claims_history_available": FIELD,
    "claims_summary": FIELD,
    "loss_ratio_available": FIELD
  },
  "quote_terms": {
    "insurer_name": FIELD,
    "quote_reference": FIELD,
    "quote_date": FIELD,
    "quote_expiry_date": FIELD,
    "insured_name": FIELD,
    "risk_address": FIELD,
    "sections": FIELD_WITH_ARRAY_VALUE,
    "required_documents": FIELD_WITH_ARRAY_VALUE,
    "notes": FIELD_WITH_ARRAY_VALUE
  },
  "assumptions": [
    {"assumption": "", "basis": "", "confidence": 0}
  ],
  "conflicts": [
    {"field": "", "description": "", "sources": []}
  ],
  "missing_information": [
    {"field": "", "reason_required": "", "priority": "high|medium|low"}
  ],
  "red_flags": [
    {"issue": "", "severity": "high|medium|low", "reason": ""}
  ],
  "document_notes": [
    {"document_id": null, "document": "", "file_name": "", "note": ""}
  ],
  "overall_confidence": 0
}

Replace FIELD and FIELD_WITH_ARRAY_VALUE with real field objects. For array
fields, value must be an array even when empty.

For quote/schedule documents, populate quote_terms when the source supports it.
Each quote_terms.sections item may contain section_name, section_key, premium,
rate, sum_insured, excess, cover_limit, warranties, endorsements, exclusions,
conditions, required_documents, notes, and source. Preserve arrays/objects. Do
not invent missing quote terms; use null/empty arrays and lower confidence or
unclear/not_found statuses where appropriate.
`.trim();

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function emptySource(): FieldSource {
  return {
    document_id: null,
    file_name: null,
    page: null,
    section: null,
    snippet: null,
  };
}

function defaultField(arrayValue = false): ExtractedField {
  // A default/scaffolded field has no value to rate. `null` (unavailable) is
  // the only honest confidence — 0 was previously synthesized here and it
  // was silently indistinguishable from a rated 0.
  return {
    value: arrayValue ? [] : null,
    status: "not_found",
    confidence: null,
    confidence_source: "unavailable",
    source: emptySource(),
    notes: null,
  };
}

function normalizeSource(raw: unknown): FieldSource {
  if (!isPlainObject(raw)) return emptySource();
  const source = emptySource();
  for (const key of FIELD_SOURCE_KEYS) {
    const value = raw[key];
    if (key === "page") {
      source.page = typeof value === "number" && Number.isFinite(value) ? value : null;
    } else {
      source[key] = typeof value === "string" && value.trim() ? value : null;
    }
  }
  return source;
}

function normalizeField(
  raw: unknown,
  path: string,
  errors: string[],
  arrayValue = false
): ExtractedField {
  if (!isPlainObject(raw) || !("value" in raw)) {
    errors.push(`${path} must be an extracted field object`);
    return defaultField(arrayValue);
  }

  const status = typeof raw.status === "string" ? raw.status : undefined;
  const rawConfidence = raw.confidence;
  const rawSource: ConfidenceSource | undefined =
    raw.confidence_source === "provider" || raw.confidence_source === "deterministic" || raw.confidence_source === "unavailable"
      ? raw.confidence_source
      : undefined;

  // Confidence semantics:
  //   - Explicit null   → unavailable (kept as null, never fabricated).
  //   - Missing         → unavailable (kept as null, never fabricated).
  //   - Numeric [0,1]   → preserved as-is; provenance preserved if supplied.
  //   - Anything else   → validation error; unavailable-null used as fallback.
  let confidence: number | null;
  let confidenceSource: ConfidenceSource;
  if (rawConfidence === null || rawConfidence === undefined) {
    confidence = null;
    confidenceSource = rawSource ?? "unavailable";
  } else {
    const n = Number(rawConfidence);
    if (!Number.isFinite(n) || n < 0 || n > 1) {
      errors.push(`${path}.confidence must be between 0 and 1 (or null when unavailable)`);
      confidence = null;
      confidenceSource = "unavailable";
    } else {
      confidence = n;
      confidenceSource = rawSource ?? "provider";
    }
  }

  const normalized: ExtractedField = {
    value: raw.value,
    status: ALLOWED_STATUS.has(status ?? "") ? (status as FieldStatus) : "extracted",
    confidence,
    confidence_source: confidenceSource,
    source: normalizeSource(raw.source),
    notes: typeof raw.notes === "string" && raw.notes.trim() ? raw.notes : null,
  };

  if (!status) {
    if (raw.value === null || raw.value === undefined) normalized.status = "not_found";
    else if (confidence != null && confidence > 0 && confidence <= 0.5) normalized.status = "low_confidence_extracted";
  } else if (!ALLOWED_STATUS.has(status)) {
    errors.push(`${path}.status is invalid`);
  }

  if (arrayValue && !Array.isArray(normalized.value)) {
    errors.push(`${path}.value must be an array`);
  }

  if (
    (normalized.value === null || normalized.value === undefined) &&
    !NULL_VALUE_STATUSES.has(normalized.status)
  ) {
    errors.push(`${path}.value cannot be null for status ${normalized.status}`);
  }

  return normalized;
}

function normalizeList(
  raw: unknown,
  path: string,
  errors: string[],
  requiredKeys: string[]
): unknown[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    errors.push(`${path} must be an array`);
    return [];
  }
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    if (!isPlainObject(item)) {
      errors.push(`${path}[${i}] must be an object`);
      continue;
    }
    for (const key of requiredKeys) {
      if (!(key in item)) errors.push(`${path}[${i}].${key} is required`);
    }
  }
  return raw;
}

export function validateAndNormalizeExtraction(raw: unknown): ValidationResult {
  const errors: string[] = [];
  if (!isPlainObject(raw)) {
    return { ok: false, errors: ["extraction must be an object"] };
  }

  const normalized: Record<string, unknown> = {
    ...raw,
    schema_version:
      typeof raw.schema_version === "string" && raw.schema_version.trim()
        ? raw.schema_version
        : "legacy-compatible",
    consultant_summary:
      typeof raw.consultant_summary === "string" ? raw.consultant_summary : "",
  };

  for (const [section, fields] of Object.entries(SECTION_FIELDS)) {
    const sourceSection = raw[section];
    if (!isPlainObject(sourceSection)) {
      if (section === "quote_terms" && sourceSection === undefined) {
        const outSection: Record<string, ExtractedField> = {};
        for (const spec of fields) outSection[spec.field] = defaultField(Boolean(spec.array));
        normalized[section] = outSection;
        continue;
      }
      errors.push(`${section} section is required`);
      normalized[section] = {};
      continue;
    }

    const outSection: Record<string, ExtractedField> = {};
    for (const spec of fields) {
      const fieldPath = `${section}.${spec.field}`;
      if (!(spec.field in sourceSection)) {
        outSection[spec.field] = defaultField(Boolean(spec.array));
        continue;
      }
      outSection[spec.field] = normalizeField(
        sourceSection[spec.field],
        fieldPath,
        errors,
        Boolean(spec.array)
      );
    }
    normalized[section] = outSection;
  }

  normalized.assumptions = normalizeList(raw.assumptions, "assumptions", errors, [
    "assumption",
    "basis",
    "confidence",
  ]);
  normalized.conflicts = normalizeList(raw.conflicts, "conflicts", errors, [
    "field",
    "description",
    "sources",
  ]);
  normalized.missing_information = normalizeList(
    raw.missing_information,
    "missing_information",
    errors,
    ["field", "reason_required", "priority"]
  );
  normalized.red_flags = normalizeList(raw.red_flags, "red_flags", errors, [
    "issue",
    "severity",
    "reason",
  ]);
  normalized.document_notes = normalizeList(raw.document_notes, "document_notes", errors, [
    "note",
  ]);

  // overall_confidence provenance.
  //
  // The canonical numeric field is retained (a NOT NULL constraint on
  // atlas_extractions.extraction_confidence and every existing downstream
  // reader relies on a number, so switching to null would be a schema-wide
  // change). To stop the compatibility 0 being read as "the provider rated
  // this run 0% confident", we ALSO write an explicit provenance flag:
  //
  //   overall_confidence_source        : "provider" | "unavailable"
  //   overall_confidence_available     : boolean  (mirrors the above for
  //                                       consumers that only want a flag)
  //
  // The UI, escalation router, matching pipeline and persistence layer treat
  // `overall_confidence_available === false` as "no rating" — the numeric 0
  // MUST NOT be surfaced or scored as a genuine provider confidence of zero.
  const rawOverall = raw.overall_confidence;
  const overall = Number(rawOverall);
  const providedNumeric =
    rawOverall !== null &&
    rawOverall !== undefined &&
    Number.isFinite(overall) &&
    overall >= 0 &&
    overall <= 1;
  const explicitlyUnavailable =
    rawOverall === null ||
    rawOverall === undefined ||
    raw.overall_confidence_available === false ||
    raw.overall_confidence_source === "unavailable";
  if (!providedNumeric && !explicitlyUnavailable) {
    errors.push("overall_confidence must be between 0 and 1 (or null when unavailable)");
    normalized.overall_confidence = 0;
    normalized.overall_confidence_source = "unavailable";
    normalized.overall_confidence_available = false;
  } else if (providedNumeric && !explicitlyUnavailable) {
    normalized.overall_confidence = overall;
    normalized.overall_confidence_source =
      raw.overall_confidence_source === "unavailable" ? "unavailable" : "provider";
    normalized.overall_confidence_available =
      raw.overall_confidence_source !== "unavailable";
  } else {
    // Unavailable: retain the compatibility 0 for downstream numeric readers.
    normalized.overall_confidence = 0;
    normalized.overall_confidence_source = "unavailable";
    normalized.overall_confidence_available = false;
  }

  return { ok: errors.length === 0, value: normalized, errors };
}

/** Backward-compatible boolean wrapper for older call sites and simple tests. */
export function isValidExtraction(obj: unknown): boolean {
  return validateAndNormalizeExtraction(obj).ok;
}

/** Pull the overall confidence safely (0..1), defaulting low if absent. */
export function overallConfidence(obj: Record<string, unknown>): number {
  const c = Number(obj["overall_confidence"]);
  return Number.isFinite(c) && c >= 0 && c <= 1 ? c : 0;
}

export interface DownloadCandidate {
  id: string;
  file_name: string;
  storage_path: string;
}

export interface UnavailableDocument {
  id: string;
  file_name: string;
}

export async function collectUnavailablePdfDocuments(
  docs: DownloadCandidate[],
  canDownload: (doc: DownloadCandidate) => Promise<boolean>
): Promise<UnavailableDocument[]> {
  const unavailable: UnavailableDocument[] = [];
  for (const doc of docs) {
    if (!doc.file_name.toLowerCase().endsWith(".pdf")) continue;
    if (!(await canDownload(doc))) {
      unavailable.push({ id: doc.id, file_name: doc.file_name });
    }
  }
  return unavailable;
}
