/**
 * Powerhouse Phase 3 — deterministic completeness.
 *
 * Question answered: "what does this case still need before an underwriter can
 * rely on it?" — by SCOPE (case, insurer, section, document, fact), with a stated
 * authority for every requirement.
 *
 * AUGMENT, DO NOT REBUILD. This module computes nothing new about insurers: it
 * restates what the authoritative matcher output and the persisted evidence
 * already establish (required-document outcomes, section evaluations, implied
 * products, the insurer inventory) plus the one fact-level record Atlas already
 * keeps (`missing_information[]` in the reviewed extraction), and gives each of
 * them one shared identity so they can be counted once, linked to quality gaps
 * and tracked in the existing Missing Information workspace.
 *
 * Hard rules (enforced by tests/powerhouse/completeness.test.ts):
 *   - Something is "required" only if an existing authoritative source says so:
 *     an appetite rule's `required_documents`, a cover section the submission
 *     declared, or the extraction's own missing-information record. No universal
 *     insurance requirement exists in Atlas and none is invented
 *     (`requirement_basis.universal_requirements = "none_defined"`).
 *   - No LLM, no prose inference, no thresholds. Missing stays missing.
 *   - A completeness gap is not a decline, not a blocker, not a score input. The
 *     vocabulary has no "blocker": the strongest state is `incomplete_material`.
 *   - One canonical document requirement per logical document (matcher
 *     `documentKey`), retaining every rule that requires it and its insurer scope.
 *     Presence is the matcher's own trusted exact-clean outcome — an unrelated
 *     clean document never satisfies it, and nothing is counted twice.
 *   - Free text from the extraction (the model's label of what is missing) is NOT
 *     persisted. A schema path is kept only when the text names a known
 *     extraction field exactly; otherwise only the record's index and priority.
 *     Resolved fields are suppressed when the current reviewed value is present,
 *     de-duplicated by canonical schema path, and never identified by array index.
 *
 * Cost is linear in (insurers × required documents + section evaluations): keyed
 * indexes, no scan of every document against every field.
 */

import { SECTION_FIELDS } from "./extraction.js";
import { documentKey } from "./matcher.js";
import type { InsurerOutcomeCore, ScoredInsurerCore } from "./recommendation-evidence-v2.js";
import { compareCodeUnits } from "./recommendation-evidence.js";
import type { RequestedSection } from "./matcher.js";

export const COMPLETENESS_MODEL_VERSION = "recommendation-completeness-v1" as const;

export type CompletenessState = "complete" | "incomplete_nonblocking" | "incomplete_material";
export type CompletenessMateriality = "material" | "nonblocking";

export type CompletenessCode =
  | "required_document_missing"
  | "requested_sections_not_declared"
  | "requested_section_not_evaluated"
  | "section_rule_ambiguous"
  | "multiple_products_without_declared_sections"
  | "implied_product_rule_ambiguous"
  | "insurer_appetite_data_missing"
  | "insurer_rule_match_missing"
  | "extraction_reported_information_missing";

export type CompletenessScope = "submission" | "insurer" | "section" | "document" | "fact";
export type CompletenessStatus = "missing" | "not_evaluated" | "ambiguous";
/** What the missing item can change. `not_determined` is used when Atlas cannot prove an effect. */
export type CompletenessAffects = "recommendation" | "insurer" | "section" | "rule" | "not_determined";
export type CompletenessSource =
  | "required_document_outcome"
  | "section_evaluation"
  | "implied_product_evaluation"
  | "insurer_selection"
  | "insurer_inventory"
  | "declared_sections"
  | "reviewed_extraction";

export interface CompletenessRequirement {
  /** WHO / WHAT requires it. */
  authority:
    | "appetite_rule"
    | "declared_cover_section"
    | "section_evaluation_model"
    | "rule_selection_model"
    | "active_insurer_inventory"
    | "extraction_report";
  insurer_id: string | null;
  rule_id: string | null;
  /** Appetite-rule authority only: a portfolio rule is the one with `*` product line and risk type. */
  rule_scope: "product" | "portfolio" | null;
  section_key: string | null;
  /** Extraction-report authority only: a pointer such as `missing_information[2]`, never the text. */
  reference: string | null;
  priority: "high" | "medium" | "low" | null;
  /** Document requirements only: the matcher's trusted exact-clean outcome for this insurer. */
  present: boolean | null;
}

export interface CompletenessItem {
  /** Deterministic identity, stable across runs and input order. */
  item_id: string;
  code: CompletenessCode;
  scope: CompletenessScope;
  status: CompletenessStatus;
  materiality: CompletenessMateriality;
  affects: CompletenessAffects;
  insurer_ids: string[];
  section_keys: string[];
  rule_ids: string[];
  field_path: string | null;
  /** Rule-owned document label or schema field label. Never client free text. */
  label: string | null;
  document_type: string | null;
  document_key: string | null;
  trust_basis: "active_exact_clean" | null;
  required_by: CompletenessRequirement[];
  source: CompletenessSource;
  /** Filled in by the quality integration; the quality gaps that already describe the same problem. */
  quality_gap_ids: string[];
  /** Always `open` at generation; later handling lives in the Missing Information workspace. */
  resolution_state: "open";
}

export interface InsurerCompleteness {
  insurer_id: string;
  state: CompletenessState;
  material_count: number;
  nonblocking_count: number;
  item_ids: string[];
}

export interface CompletenessAnalysis {
  model: typeof COMPLETENESS_MODEL_VERSION;
  state: CompletenessState;
  material_count: number;
  nonblocking_count: number;
  /** What "required" means in this packet — stated, so no reader has to guess. */
  requirement_basis: {
    documents: "appetite_rule_required_documents";
    sections: "declared_cover_sections";
    facts: "extraction_reported_missing_information_only";
    universal_requirements: "none_defined";
  };
  items: CompletenessItem[];
  insurers: InsurerCompleteness[];
  /** Items that are not scoped to any insurer. */
  case_item_ids: string[];
  /** Extraction-reported records beyond the persisted cap (count only). */
  extraction_reported_omitted: number;
}

export const REQUIREMENT_BASIS: CompletenessAnalysis["requirement_basis"] = {
  documents: "appetite_rule_required_documents",
  sections: "declared_cover_sections",
  facts: "extraction_reported_missing_information_only",
  universal_requirements: "none_defined",
};

const MAX_REPORTED_ITEMS = 50;

// ---------------------------------------------------------------------------
// Extraction-reported missing information (existing record; text not persisted)
// ---------------------------------------------------------------------------

export interface ReportedMissingRecord {
  /** Present only for unresolved/free-text records, whose conservative identity remains positional. */
  index: number | null;
  priority: "high" | "medium" | "low" | null;
  /** Set only when the model's label names a known extraction field exactly. */
  field_path: string | null;
}

const SCHEMA_PATHS: Map<string, string> = new Map();
const SCHEMA_KEY_PATHS: Map<string, string | null> = new Map();
const SCHEMA_LABEL_PATHS: Map<string, string | null> = new Map();
function labelForSchemaPath(path: string): string {
  const key = path.slice(path.indexOf(".") + 1);
  const words = key.split("_").filter(Boolean).map((word) => (word === "id" ? "ID" : word));
  const sentence = words.join(" ");
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}
for (const [section, fields] of Object.entries(SECTION_FIELDS)) {
  for (const { field } of fields) {
    const path = `${section}.${field}`;
    SCHEMA_PATHS.set(path.toLowerCase(), path);
    // A bare key resolves only if it names exactly ONE field in the whole schema.
    SCHEMA_KEY_PATHS.set(field.toLowerCase(), SCHEMA_KEY_PATHS.has(field.toLowerCase()) ? null : path);
    const label = labelForSchemaPath(path).toLowerCase();
    SCHEMA_LABEL_PATHS.set(label, SCHEMA_LABEL_PATHS.has(label) ? null : path);
  }
}

export function resolveSchemaPath(text: string): string | null {
  const key = text.trim().toLowerCase();
  return SCHEMA_PATHS.get(key) ?? SCHEMA_KEY_PATHS.get(key) ?? null;
}

/** Exact registry identity for either a stored schema key/path or Atlas's own generated label. */
export function resolveSchemaFieldIdentity(text: string): string | null {
  return resolveSchemaPath(text) ?? SCHEMA_LABEL_PATHS.get(text.trim().toLowerCase()) ?? null;
}

/** Exact aliases Atlas itself derives for one canonical schema path. */
export function schemaFieldAliases(path: string): readonly string[] | null {
  const canonical = SCHEMA_PATHS.get(path.trim().toLowerCase());
  if (!canonical) return null;
  const key = canonical.slice(canonical.indexOf(".") + 1);
  return [canonical, key, labelForSchemaPath(canonical)];
}

function reviewedFieldIsPresent(reviewed: Record<string, unknown>, path: string): boolean {
  const [section, key] = path.split(".");
  const bag = reviewed[section];
  if (!bag || typeof bag !== "object" || Array.isArray(bag)) return false;
  const field = (bag as Record<string, unknown>)[key];
  if (!field || typeof field !== "object" || Array.isArray(field) || !("value" in field)) return false;
  const value = (field as { value: unknown }).value;
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim() !== "";
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

/** "registration_or_id_number" -> "Registration or ID number". Derived from the schema key only. */
export function schemaFieldLabel(path: string): string {
  return labelForSchemaPath(path);
}

export function readExtractionReportedMissing(reviewed: Record<string, unknown>): {
  records: ReportedMissingRecord[];
  omitted: number;
} {
  const raw = reviewed.missing_information;
  if (!Array.isArray(raw)) return { records: [], omitted: 0 };
  const records: ReportedMissingRecord[] = [];
  const resolved = new Set<string>();
  let omitted = 0;
  raw.forEach((entry, index) => {
    // Same filter the existing consumers use: a record without a `field` is not an item.
    if (!entry || typeof entry !== "object") return;
    const field = (entry as { field?: unknown }).field;
    if (typeof field !== "string" || field.trim() === "") return;
    if (records.length >= MAX_REPORTED_ITEMS) {
      omitted++;
      return;
    }
    const priority = (entry as { priority?: unknown }).priority;
    const fieldPath = resolveSchemaPath(field);
    if (fieldPath) {
      if (reviewedFieldIsPresent(reviewed, fieldPath) || resolved.has(fieldPath)) return;
      resolved.add(fieldPath);
    }
    records.push({
      index: fieldPath ? null : index,
      priority: priority === "high" || priority === "medium" || priority === "low" ? priority : null,
      field_path: fieldPath,
    });
  });
  return { records, omitted };
}

// ---------------------------------------------------------------------------
// Assessment
// ---------------------------------------------------------------------------

export interface CompletenessInput {
  requestedSections: readonly RequestedSection[];
  insurers: readonly InsurerOutcomeCore[];
  reported: { records: ReportedMissingRecord[]; omitted: number };
}

interface Contribution {
  item_id: string;
  insurer_id: string | null;
  materiality: CompletenessMateriality;
}

const MATERIALITY_ORDER: Record<CompletenessMateriality, number> = { material: 0, nonblocking: 1 };

function stateFromCounts(material: number, nonblocking: number): CompletenessState {
  if (material > 0) return "incomplete_material";
  return nonblocking > 0 ? "incomplete_nonblocking" : "complete";
}

const sortedUnique = (values: Iterable<string>): string[] => [...new Set(values)].sort(compareCodeUnits);

function emptyRequirement(authority: CompletenessRequirement["authority"]): CompletenessRequirement {
  return {
    authority,
    insurer_id: null,
    rule_id: null,
    rule_scope: null,
    section_key: null,
    reference: null,
    priority: null,
    present: null,
  };
}

function baseItem(
  fields: Pick<CompletenessItem, "item_id" | "code" | "scope" | "status" | "affects" | "source" | "required_by"> &
    Partial<Omit<CompletenessItem, "materiality" | "quality_gap_ids" | "resolution_state">> & {
      materiality: CompletenessMateriality;
    }
): CompletenessItem {
  // Explicit key order: identity and classification first, detail after, so a
  // persisted packet reads top-down.
  return {
    item_id: fields.item_id,
    code: fields.code,
    scope: fields.scope,
    status: fields.status,
    materiality: fields.materiality,
    affects: fields.affects,
    insurer_ids: fields.insurer_ids ?? [],
    section_keys: fields.section_keys ?? [],
    rule_ids: fields.rule_ids ?? [],
    field_path: fields.field_path ?? null,
    label: fields.label ?? null,
    document_type: fields.document_type ?? null,
    document_key: fields.document_key ?? null,
    trust_basis: fields.trust_basis ?? null,
    required_by: fields.required_by,
    source: fields.source,
    quality_gap_ids: [],
    resolution_state: "open",
  };
}

function worse(a: CompletenessMateriality, b: CompletenessMateriality): CompletenessMateriality {
  return MATERIALITY_ORDER[a] <= MATERIALITY_ORDER[b] ? a : b;
}

interface DocumentAccumulator {
  labels: Set<string>;
  refs: Map<string, CompletenessRequirement>;
  missingInsurers: Map<string, CompletenessMateriality>;
  sectionKeys: Set<string>;
}

function isWhollyUnevidenced(insurer: ScoredInsurerCore): boolean {
  return insurer.required_documents.length > 0 && insurer.required_documents.every((doc) => !doc.present);
}

export function assessCompleteness(input: CompletenessInput): CompletenessAnalysis {
  const items = new Map<string, CompletenessItem>();
  const contributions: Contribution[] = [];

  const put = (item: CompletenessItem, contributing: { insurer_id: string | null; materiality: CompletenessMateriality }[]) => {
    const existing = items.get(item.item_id);
    if (existing) {
      existing.materiality = worse(existing.materiality, item.materiality);
    } else {
      items.set(item.item_id, item);
    }
    for (const contribution of contributing) contributions.push({ item_id: item.item_id, ...contribution });
  };

  // ---- Case level -------------------------------------------------------------
  if (input.requestedSections.length === 0) {
    put(
      baseItem({
        item_id: "cmp:requested_sections_not_declared:-:-:-",
        code: "requested_sections_not_declared",
        scope: "submission",
        status: "missing",
        materiality: "nonblocking",
        affects: "recommendation",
        source: "declared_sections",
        required_by: [emptyRequirement("section_evaluation_model")],
      }),
      [{ insurer_id: null, materiality: "nonblocking" }]
    );
  }

  for (const record of input.reported.records) {
    const reference = record.field_path ?? `missing_information[${record.index}]`;
    put(
      baseItem({
        item_id: `cmp:extraction_reported_information_missing:-:-:${record.field_path ? `field:${record.field_path}` : reference}`,
        code: "extraction_reported_information_missing",
        scope: "fact",
        status: "missing",
        materiality: "nonblocking",
        affects: "not_determined",
        field_path: record.field_path,
        label: record.field_path ? schemaFieldLabel(record.field_path) : null,
        source: "reviewed_extraction",
        required_by: [{ ...emptyRequirement("extraction_report"), reference, priority: record.priority }],
      }),
      [{ insurer_id: null, materiality: "nonblocking" }]
    );
  }

  // ---- Insurers ---------------------------------------------------------------
  const documents = new Map<string, DocumentAccumulator>();
  for (const insurer of input.insurers) {
    const id = insurer.insurer_id;
    if (insurer.status === "no_appetite_data") {
      put(
        baseItem({
          item_id: `cmp:insurer_appetite_data_missing:${id}:-:-`,
          code: "insurer_appetite_data_missing",
          scope: "insurer",
          status: "missing",
          materiality: "nonblocking",
          affects: "insurer",
          insurer_ids: [id],
          source: "insurer_inventory",
          required_by: [{ ...emptyRequirement("active_insurer_inventory"), insurer_id: id }],
        }),
        [{ insurer_id: id, materiality: "nonblocking" }]
      );
      continue;
    }

    const ruledOut = insurer.ruled_out;
    if (insurer.manual_review_required) {
      put(
        baseItem({
          item_id: `cmp:insurer_rule_match_missing:${id}:-:-`,
          code: "insurer_rule_match_missing",
          scope: "insurer",
          status: "not_evaluated",
          materiality: "material",
          affects: "insurer",
          insurer_ids: [id],
          source: "insurer_selection",
          required_by: [{ ...emptyRequirement("rule_selection_model"), insurer_id: id }],
        }),
        [{ insurer_id: id, materiality: "material" }]
      );
    }

    for (const section of insurer.section_evaluations) {
      const requirement = { ...emptyRequirement("declared_cover_section"), insurer_id: id, section_key: section.section_key };
      if (section.status === "no_applicable_rule") {
        const materiality: CompletenessMateriality = ruledOut ? "nonblocking" : "material";
        put(
          baseItem({
            item_id: `cmp:requested_section_not_evaluated:${id}:${section.section_key}:-`,
            code: "requested_section_not_evaluated",
            scope: "section",
            status: "not_evaluated",
            materiality,
            affects: "section",
            insurer_ids: [id],
            section_keys: [section.section_key],
            source: "section_evaluation",
            required_by: [requirement],
          }),
          [{ insurer_id: id, materiality }]
        );
        continue;
      }
      if (section.tied_rules_disagree) {
        put(
          baseItem({
            item_id: `cmp:section_rule_ambiguous:${id}:${section.section_key}:-`,
            code: "section_rule_ambiguous",
            scope: "section",
            status: "ambiguous",
            materiality: "material",
            affects: "section",
            insurer_ids: [id],
            section_keys: [section.section_key],
            rule_ids: sortedUnique(section.tied_rule_ids),
            source: "section_evaluation",
            required_by: [requirement],
          }),
          [{ insurer_id: id, materiality: "material" }]
        );
      }
    }

    if (insurer.implied_product_evaluations.length >= 2) {
      const materiality: CompletenessMateriality = ruledOut ? "nonblocking" : "material";
      const sectionKeys = sortedUnique(insurer.implied_product_evaluations.map((product) => product.section_key));
      put(
        baseItem({
          item_id: `cmp:multiple_products_without_declared_sections:${id}:-:-`,
          code: "multiple_products_without_declared_sections",
          scope: "insurer",
          status: "missing",
          materiality,
          affects: "insurer",
          insurer_ids: [id],
          section_keys: sectionKeys,
          source: "implied_product_evaluation",
          required_by: [{ ...emptyRequirement("section_evaluation_model"), insurer_id: id }],
        }),
        [{ insurer_id: id, materiality }]
      );
      for (const product of insurer.implied_product_evaluations) {
        if (!product.tied_rules_disagree) continue;
        put(
          baseItem({
            item_id: `cmp:implied_product_rule_ambiguous:${id}:${product.section_key}:-`,
            code: "implied_product_rule_ambiguous",
            scope: "section",
            status: "ambiguous",
            materiality: "material",
            affects: "section",
            insurer_ids: [id],
            section_keys: [product.section_key],
            rule_ids: sortedUnique(product.tied_rule_ids),
            source: "implied_product_evaluation",
            required_by: [{ ...emptyRequirement("section_evaluation_model"), insurer_id: id, section_key: product.section_key }],
          }),
          [{ insurer_id: id, materiality: "material" }]
        );
      }
    }

    // ---- Required documents: indexed by canonical document key ----------------
    // A ruled-out insurer has no document outcome (the matcher skips them), so its
    // requirements are not assessed — exactly as the quality gate does.
    if (ruledOut) continue;
    const whollyUnevidenced = isWhollyUnevidenced(insurer);
    const evidenceById = new Map(insurer.rule_evidence.map((rule) => [rule.evidence_id, rule]));
    const ruleSections = new Map<string, string[]>();
    for (const rule of insurer.considered_rules) ruleSections.set(rule.rule_id, rule.section_keys);

    for (const outcome of insurer.required_documents) {
      const key = documentKey(outcome.document_type);
      if (!key) continue;
      let entry = documents.get(key);
      if (!entry) {
        entry = { labels: new Set(), refs: new Map(), missingInsurers: new Map(), sectionKeys: new Set() };
        documents.set(key, entry);
      }
      entry.labels.add(outcome.document_type);
      let resolved = 0;
      for (const evidenceId of outcome.rule_evidence_ids) {
        const rule = evidenceById.get(evidenceId);
        if (!rule) continue;
        resolved++;
        const portfolio = rule.product_line.trim() === "*" && rule.risk_type.trim() === "*";
        entry.refs.set(`${id}\u0000${rule.rule_id}`, {
          ...emptyRequirement("appetite_rule"),
          insurer_id: id,
          rule_id: rule.rule_id,
          rule_scope: portfolio ? "portfolio" : "product",
          present: outcome.present,
        });
        for (const sectionKey of ruleSections.get(rule.rule_id) ?? []) entry.sectionKeys.add(sectionKey);
      }
      if (resolved === 0) {
        // The requirement exists but its rule snapshot is unresolved: keep the
        // insurer-scoped fact rather than dropping it. The unresolved rule is
        // already a quality blocker (`matched_rule_snapshot_missing`).
        entry.refs.set(`${id}\u0000`, { ...emptyRequirement("appetite_rule"), insurer_id: id, present: outcome.present });
      }
      if (!outcome.present) {
        entry.missingInsurers.set(id, whollyUnevidenced ? "material" : "nonblocking");
      }
    }
  }

  for (const [key, entry] of documents) {
    if (entry.missingInsurers.size === 0) continue; // every requiring insurer has it: not a gap
    const label = [...entry.labels].sort(compareCodeUnits)[0];
    const refs = [...entry.refs.values()].sort(
      (a, b) =>
        compareCodeUnits(a.insurer_id ?? "", b.insurer_id ?? "") ||
        compareCodeUnits(a.rule_id ?? "", b.rule_id ?? "")
    );
    const insurerIds = sortedUnique(entry.missingInsurers.keys());
    const materiality = [...entry.missingInsurers.values()].reduce<CompletenessMateriality>(worse, "nonblocking");
    put(
      baseItem({
        item_id: `cmp:required_document_missing:-:-:${key}`,
        code: "required_document_missing",
        scope: "document",
        status: "missing",
        materiality,
        affects: "insurer",
        insurer_ids: insurerIds,
        section_keys: sortedUnique(entry.sectionKeys),
        rule_ids: sortedUnique(refs.map((ref) => ref.rule_id).filter((ruleId): ruleId is string => ruleId !== null)),
        label,
        document_type: label,
        document_key: key,
        trust_basis: "active_exact_clean",
        source: "required_document_outcome",
        required_by: refs,
      }),
      [...entry.missingInsurers.entries()].map(([insurerId, insurerMateriality]) => ({
        insurer_id: insurerId,
        materiality: insurerMateriality,
      }))
    );
  }

  // ---- Assemble ---------------------------------------------------------------
  const ordered = [...items.values()].sort(
    (a, b) =>
      MATERIALITY_ORDER[a.materiality] - MATERIALITY_ORDER[b.materiality] ||
      compareCodeUnits(a.code, b.code) ||
      compareCodeUnits(a.item_id, b.item_id)
  );
  // Index once: insurer -> its contributions (no insurers × contributions scan).
  const byInsurer = new Map<string, Contribution[]>();
  for (const contribution of contributions) {
    if (contribution.insurer_id === null) continue;
    const list = byInsurer.get(contribution.insurer_id);
    if (list) list.push(contribution);
    else byInsurer.set(contribution.insurer_id, [contribution]);
  }
  const insurers: InsurerCompleteness[] = [...input.insurers]
    .map((insurer) => insurer.insurer_id)
    .sort(compareCodeUnits)
    .map((insurerId) => {
      const own = byInsurer.get(insurerId) ?? [];
      const material = new Set(own.filter((item) => item.materiality === "material").map((item) => item.item_id));
      const all = new Set(own.map((item) => item.item_id));
      return {
        insurer_id: insurerId,
        state: stateFromCounts(material.size, all.size - material.size),
        material_count: material.size,
        nonblocking_count: all.size - material.size,
        item_ids: [...all].sort(compareCodeUnits),
      };
    });
  const material = ordered.filter((item) => item.materiality === "material").length;
  return {
    model: COMPLETENESS_MODEL_VERSION,
    state: stateFromCounts(material, ordered.length - material),
    material_count: material,
    nonblocking_count: ordered.length - material,
    requirement_basis: { ...REQUIREMENT_BASIS },
    items: ordered,
    insurers,
    case_item_ids: ordered.filter((item) => item.insurer_ids.length === 0).map((item) => item.item_id),
    extraction_reported_omitted: input.reported.omitted,
  };
}
