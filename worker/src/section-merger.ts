/**
 * Atlas hybrid pipeline — deterministic section merger
 * ----------------------------------------------------------------------------
 * Combines per-section CanonicalPartial results into a canonical Atlas
 * extraction object matching validateAndNormalizeExtraction()'s shape. Rules:
 *
 *   1. Never invent confidence. If the section reply supplied a numeric
 *      value we keep it (with confidence_source="provider"); otherwise the
 *      canonical field's `confidence` is `null` (confidence_source="unavailable").
 *      Downstream consumers MUST treat null as "no information" — never as
 *      low quality — and must never fabricate a synthetic number here.
 *   2. Detect duplicate emissions of the same dotted key. When values match
 *      (semantic equality), keep the first + record a shared page. When
 *      values differ, keep the highest-precedence section's value AND record
 *      the disagreement in conflicts[] with both sources.
 *   3. Precedence (higher wins on conflict): explicit section > premium_index
 *      summary > policy_details > intermediary_details > unclassified.
 *      Rationale: a Buildings section's own sum_insured is more authoritative
 *      than the premium summary's sum_insured for buildings.
 *   4. List appends (cover_sections, sums_insured, etc.) are unioned in the
 *      order they arrived. Duplicate string values are dropped.
 *   5. Every write records source page provenance.
 *   6. The output goes through validateAndNormalizeExtraction() for schema
 *      conformance — we do not bypass the existing validators.
 */

import {
  EXTRACTION_SCHEMA_VERSION,
  validateAndNormalizeExtraction,
  type ValidationResult,
} from "./extraction.js";
import type { CanonicalPartial, FocusedField } from "./section-schemas.js";
import type { SectionType } from "./section-splitter.js";

const PRECEDENCE: Record<SectionType, number> = {
  buildings: 90,
  contents: 90,
  motor: 90,
  all_risks: 85,
  personal_liability: 80,
  claims_history: 80,
  excesses: 78,
  endorsements: 76,
  other_cover: 70,
  premium_index: 60,
  policy_details: 55,
  intermediary_details: 50,
  unclassified: 20,
};

function precedence(t: SectionType): number { return PRECEDENCE[t] ?? 30; }

// ---------------------------------------------------------------------------
// Canonical scaffold
// ---------------------------------------------------------------------------

function emptyField(arrayValue = false): Record<string, unknown> {
  // Unavailable-null: we never had a value to rate.
  return {
    value: arrayValue ? [] : null,
    status: "not_found",
    confidence: null,
    confidence_source: "unavailable",
    source: { document_id: null, file_name: null, page: null, section: null, snippet: null },
    notes: null,
  };
}

const SECTION_FIELDS: Record<string, { field: string; array?: boolean }[]> = {
  extracted_client: [
    { field: "name" }, { field: "entity_type" }, { field: "registration_or_id_number" },
    { field: "occupation_or_business_description" }, { field: "contact_details" }, { field: "risk_address" },
  ],
  broker: [{ field: "name" }, { field: "email" }, { field: "brokerage" }],
  current_cover: [
    { field: "current_insurer" }, { field: "renewal_date" }, { field: "current_premium" },
    { field: "cover_sections", array: true }, { field: "sums_insured", array: true },
    { field: "excesses", array: true }, { field: "warranties", array: true },
    { field: "endorsements", array: true }, { field: "exclusions", array: true },
    { field: "required_documents", array: true },
  ],
  risk_classification: [
    { field: "primary_risk_type" }, { field: "product_line" }, { field: "risk_type" },
    { field: "secondary_risk_types", array: true }, { field: "business_sector" }, { field: "complexity_level" },
  ],
  claims: [{ field: "claims_history_available" }, { field: "claims_summary" }, { field: "loss_ratio_available" }],
  quote_terms: [
    { field: "insurer_name" }, { field: "quote_reference" }, { field: "quote_date" },
    { field: "quote_expiry_date" }, { field: "insured_name" }, { field: "risk_address" },
    { field: "sections", array: true }, { field: "required_documents", array: true }, { field: "notes", array: true },
  ],
};

function scaffoldExtraction(): Record<string, unknown> {
  const out: Record<string, unknown> = {
    schema_version: EXTRACTION_SCHEMA_VERSION,
    consultant_summary: "",
    assumptions: [],
    conflicts: [],
    missing_information: [],
    red_flags: [],
    document_notes: [],
    overall_confidence: 0,
  };
  for (const [section, fields] of Object.entries(SECTION_FIELDS)) {
    const bag: Record<string, unknown> = {};
    for (const spec of fields) bag[spec.field] = emptyField(Boolean(spec.array));
    out[section] = bag;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Field & list writes
// ---------------------------------------------------------------------------

interface WriteRecord {
  sectionType: SectionType;
  documentId: string;
  page: number | null;
  value: unknown;
  confidence: number | null;
  documentIndex: number;
  stableIndex: number;
  startPage: number;
}

interface FieldSlot {
  chosen?: WriteRecord;
  duplicates: WriteRecord[];
}

function semanticEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return false;
  if (typeof a === "string" && typeof b === "string") return a.trim().toLowerCase() === b.trim().toLowerCase();
  try { return JSON.stringify(a) === JSON.stringify(b); } catch { return false; }
}

function setField(
  extraction: Record<string, unknown>,
  dottedKey: string,
  chosen: WriteRecord,
  method: string
): void {
  const [section, field] = dottedKey.split(".");
  if (!section || !field) return;
  const sec = (extraction[section] ??= {} as Record<string, unknown>) as Record<string, unknown>;
  const prior = (sec[field] ?? emptyField()) as Record<string, unknown>;
  // Confidence policy: preserve provider-supplied number; never fabricate.
  // When the section reply had no rating, we leave confidence null with
  // provenance "unavailable". Downstream must not treat null as low quality.
  const hasProviderNumber = typeof chosen.confidence === "number" && Number.isFinite(chosen.confidence);
  sec[field] = {
    ...prior,
    value: chosen.value,
    status: chosen.value == null ? "not_found" : "extracted",
    confidence: hasProviderNumber ? chosen.confidence : null,
    confidence_source: hasProviderNumber ? "provider" : "unavailable",
    source: {
      document_id: chosen.documentId ?? null,
      file_name: (prior.source as { file_name?: string | null } | undefined)?.file_name ?? null,
      page: chosen.page ?? null,
      section: chosen.sectionType,
      snippet: null,
    },
    notes: `resolved_via:${method}`,
  };
}

// ---------------------------------------------------------------------------
// Merge entry
// ---------------------------------------------------------------------------

export interface MergePartial {
  partial: CanonicalPartial;
  documentId: string;
  primarySectionType: SectionType;
  /** Zero-based source-order index of the parent document. */
  documentIndex: number;
  /** Stable, monotonic index assigned at split-time. */
  stableIndex: number;
  /** Section's starting page (used as an ordering tiebreaker). */
  startPage: number;
}

export interface SectionMergeInput {
  partials: MergePartial[];
  brokerEmailBody?: string | null;
}

export interface SectionMergeResult {
  extraction: Record<string, unknown>;
  validation: ValidationResult;
  conflicts: {
    field: string;
    chosen: { value: unknown; section: SectionType; page: number | null };
    rejected: { value: unknown; section: SectionType; page: number | null }[];
  }[];
  duplicateFieldCount: number;
}

/**
 * Deterministic total order over merge partials — the ONLY ordering the merge
 * step depends on. Section arrival / completion order is intentionally NOT a
 * factor. Ordering keys, in decreasing significance:
 *
 *   1. section-type precedence (higher first)
 *   2. document source order (documentIndex ascending)
 *   3. section starting page (ascending)
 *   4. stable section index (ascending)
 *
 * "First writer wins" downstream means "first in this sorted order".
 */
function comparePartials(a: MergePartial, b: MergePartial): number {
  const p = precedence(b.primarySectionType) - precedence(a.primarySectionType);
  if (p !== 0) return p;
  if (a.documentIndex !== b.documentIndex) return a.documentIndex - b.documentIndex;
  if (a.startPage !== b.startPage) return a.startPage - b.startPage;
  return a.stableIndex - b.stableIndex;
}

/** Deterministic ordering for writer records (used to sort duplicates). */
function compareWriteRecords(a: WriteRecord, b: WriteRecord): number {
  const p = precedence(b.sectionType) - precedence(a.sectionType);
  if (p !== 0) return p;
  if (a.documentIndex !== b.documentIndex) return a.documentIndex - b.documentIndex;
  if (a.startPage !== b.startPage) return a.startPage - b.startPage;
  return a.stableIndex - b.stableIndex;
}

export function mergeSectionPartials(input: SectionMergeInput): SectionMergeResult {
  const extraction = scaffoldExtraction();
  const slots = new Map<string, FieldSlot>();
  const listSeen = new Map<string, Set<string>>();
  const listPages = new Map<string, number | null>();

  // Sort ONCE up front. Everything downstream iterates in this stable order,
  // so shuffled Haiku/Sonnet completion order cannot change the output.
  const sortedPartials = [...input.partials].sort(comparePartials);

  for (const { partial, documentId, primarySectionType, documentIndex, stableIndex, startPage } of sortedPartials) {
    for (const [key, patch] of Object.entries(partial.fieldPatches)) {
      const rec: WriteRecord = {
        sectionType: primarySectionType,
        documentId,
        documentIndex,
        stableIndex,
        startPage,
        page: (patch.page as number | null) ?? null,
        value: patch.value,
        confidence: patch.confidence ?? null,
      };
      const slot = slots.get(key) ?? { duplicates: [] };
      // Because sortedPartials is in precedence-desc / source-order,
      // the FIRST writer for any key is the deterministic winner.
      if (!slot.chosen) slot.chosen = rec;
      else slot.duplicates.push(rec);
      slots.set(key, slot);
    }
    for (const [key, entries] of Object.entries(partial.listAppends)) {
      const seen = listSeen.get(key) ?? new Set<string>();
      for (const e of entries) {
        if (e.value == null) continue;
        const k = typeof e.value === "string" ? e.value.trim().toLowerCase() : JSON.stringify(e.value);
        if (seen.has(k)) continue;
        seen.add(k);
        // Append onto the list.
        const [section, field] = key.split(".");
        if (!section || !field) continue;
        const sec = (extraction[section] ??= {} as Record<string, unknown>) as Record<string, unknown>;
        const list = (sec[field] ?? emptyField(true)) as Record<string, unknown>;
        const values = Array.isArray(list.value) ? [...(list.value as unknown[])] : [];
        values.push(e.value);
        list.value = values;
        list.status = "extracted";
        // Confidence policy for lists: keep the max provider-supplied number,
        // or leave null when no provider ever rated an entry. NEVER fabricate.
        const priorConfidence = typeof list.confidence === "number" && Number.isFinite(list.confidence)
          ? (list.confidence as number)
          : null;
        const entryConfidence = typeof e.confidence === "number" && Number.isFinite(e.confidence)
          ? e.confidence
          : null;
        const nextConfidence =
          priorConfidence == null && entryConfidence == null
            ? null
            : Math.max(priorConfidence ?? 0, entryConfidence ?? 0);
        list.confidence = nextConfidence;
        list.confidence_source = nextConfidence == null ? "unavailable" : "provider";
        listPages.set(key, e.page ?? listPages.get(key) ?? null);
        list.source = {
          document_id: documentId,
          file_name: (list.source as { file_name?: string | null } | undefined)?.file_name ?? null,
          page: listPages.get(key) ?? null,
          section: primarySectionType,
          snippet: null,
        };
        list.notes = `resolved_via:section_${primarySectionType}`;
        sec[field] = list;
      }
      listSeen.set(key, seen);
    }
    if (partial.documentNotes.length > 0) {
      const notes = (extraction.document_notes as { note: string; document_id: string | null }[]);
      for (const n of partial.documentNotes) notes.push({ note: n, document_id: documentId });
    }
  }

  const conflicts: SectionMergeResult["conflicts"] = [];
  let duplicateFieldCount = 0;

  // Iterate slot keys in lexicographic order — Map iteration order is
  // insertion order, which is itself sortedPartials-driven, but sorting the
  // keys again makes the guarantee independent of that implementation detail.
  const sortedKeys = [...slots.keys()].sort();
  for (const key of sortedKeys) {
    const slot = slots.get(key);
    if (!slot?.chosen) continue;
    setField(extraction, key, slot.chosen, `section_${slot.chosen.sectionType}`);
    // Sort duplicates so conflict output is byte-identical across runs.
    const sortedDupes = [...slot.duplicates].sort(compareWriteRecords);
    const realConflicts = sortedDupes.filter((d) => !semanticEqual(d.value, slot.chosen!.value));
    if (slot.duplicates.length > 0) duplicateFieldCount++;
    if (realConflicts.length > 0) {
      conflicts.push({
        field: key,
        chosen: { value: slot.chosen.value, section: slot.chosen.sectionType, page: slot.chosen.page },
        rejected: realConflicts.map((r) => ({ value: r.value, section: r.sectionType, page: r.page })),
      });
    }
  }

  if (conflicts.length > 0) {
    const conflictList = extraction.conflicts as unknown[];
    for (const c of conflicts) {
      conflictList.push({
        field: c.field,
        description: `disagreement across sections (chosen: ${c.chosen.section})`,
        sources: [c.chosen.section, ...c.rejected.map((r) => r.section)],
      });
    }
  }

  // overall_confidence: mean of PROVIDER-supplied numeric confidences only.
  // Fields with null confidence (unavailable) are excluded from the average
  // — they must never be treated as "0" for scoring purposes.
  //
  // Provenance: when NO field was rated, we do not synthesize a number. The
  // canonical numeric column is preserved as 0 for backward compatibility
  // (see extraction.ts for why), but overall_confidence_source records the
  // semantic distinction so downstream consumers never read the 0 as a
  // genuine provider score of zero.
  // A finite provider-supplied confidence — INCLUDING 0 — counts as a real
  // rating. The scaffold uses `confidence: null, confidence_source: "unavailable"`
  // (see emptyField), so 0 can only reach here when a provider actually chose
  // it; excluding it would collapse "provider rated everything zero" into
  // "no rating available", which the escalation router treats as unavailable
  // and refuses to touch — a decision-quality regression.
  const confidences: number[] = [];
  for (const sectionKey of Object.keys(SECTION_FIELDS)) {
    const bag = (extraction[sectionKey] as Record<string, unknown>) ?? {};
    for (const spec of SECTION_FIELDS[sectionKey]) {
      const f = bag[spec.field] as { confidence?: unknown } | undefined;
      if (f && typeof f.confidence === "number" && Number.isFinite(f.confidence) && f.confidence >= 0 && f.confidence <= 1) {
        confidences.push(f.confidence);
      }
    }
  }
  if (confidences.length > 0) {
    extraction.overall_confidence =
      Math.round((confidences.reduce((s, x) => s + x, 0) / confidences.length) * 100) / 100;
    extraction.overall_confidence_source = "provider";
    extraction.overall_confidence_available = true;
  } else {
    extraction.overall_confidence = 0;
    extraction.overall_confidence_source = "unavailable";
    extraction.overall_confidence_available = false;
  }

  const validation = validateAndNormalizeExtraction(extraction);
  const finalExtraction = validation.value ?? extraction;
  return { extraction: finalExtraction, validation, conflicts, duplicateFieldCount };
}

/** Utility used by orchestrator + tests to consume a raw partial's key list. */
export function partialKeys(p: CanonicalPartial): string[] {
  const keys = new Set<string>();
  for (const k of Object.keys(p.fieldPatches)) keys.add(k);
  for (const k of Object.keys(p.listAppends)) keys.add(k);
  return [...keys];
}

/** Utility used by tests / diagnostics. */
export function focusedFieldValue(f: FocusedField | undefined): unknown {
  return f?.value ?? null;
}
