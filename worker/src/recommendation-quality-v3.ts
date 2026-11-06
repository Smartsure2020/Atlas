/**
 * Powerhouse Batch B — quality model v3.
 *
 * Wraps the FROZEN v2 classification table (recommendation-quality.ts, whose
 * every row is unchanged) and adds exactly two things:
 *
 *   1. LINKAGE. Completeness items and contradictions get stable ids, and the
 *      quality gaps that already describe the same problem point at them (and they
 *      point back). A missing document is therefore ONE completeness item that
 *      references its quality gap(s) — not three separate quality gaps plus a
 *      completeness item plus a duplicate. Nothing is double counted: a gap is
 *      created here only for a problem the v2 table did not already classify.
 *   2. NEW GAP CODES for problems that previously had no gap at all:
 *        extraction_reported_information_missing  advisory
 *        conflicting_recorded_values              material when the field is
 *                                                 consumed by the matcher, else
 *                                                 advisory — never a blocker
 *        comparison_unavailable                    advisory when a registered
 *                                                 comparison cannot run
 *      Both are recommendation-level (no insurer), so they colour the overall
 *      state but never an individual insurer's state.
 *
 * What it controls: PRESENTATION and RELIANCE only. It never changes a score,
 * rank, referral or decline, never blocks the underwriter, and never turns a
 * completeness gap or a contradiction into a decline.
 */

import type {
  InsurerQualityV2,
  QualityGapCodeV2,
  QualityGapV2,
  QualitySeverity,
  IntelligenceState,
} from "./recommendation-evidence-v2.js";
import {
  assessQuality,
  buildQualityGap,
  compareQualityGaps,
  stateFor,
  type QualityAssessmentInput,
} from "./recommendation-quality.js";
import { documentKey } from "./matcher.js";
import type { CompletenessAnalysis, CompletenessCode, CompletenessItem } from "./completeness.js";
import type { ContradictionAnalysis } from "./contradictions.js";

/** Version of the v3 classification (the v2 table plus the linkage and the two codes above). */
export const QUALITY_MODEL_VERSION = "recommendation-quality-v3" as const;

export type QualityGapCodeV3 =
  | QualityGapCodeV2
  | "extraction_reported_information_missing"
  | "conflicting_recorded_values"
  | "comparison_unavailable";

export interface QualityGapV3 extends Omit<QualityGapV2, "code"> {
  code: QualityGapCodeV3;
  /** Completeness items describing the same problem (stable ids). */
  completeness_item_ids: string[];
  /** The contradiction this gap reports, when it is one. */
  contradiction_id: string | null;
}

export type InsurerQualityV3 = InsurerQualityV2;

export interface RecommendationQualityV3 {
  model: typeof QUALITY_MODEL_VERSION;
  state: IntelligenceState;
  blocker_count: number;
  material_count: number;
  advisory_count: number;
  gaps: QualityGapV3[];
}

export interface QualityAssessmentInputV3 extends QualityAssessmentInput {
  completeness: CompletenessAnalysis;
  contradictions: ContradictionAnalysis;
}

/**
 * Which existing v2 gap codes already describe each completeness code. A
 * completeness code absent from this table (`extraction_reported_information_missing`)
 * had no gap before and gets a new one below.
 */
const COVERED_BY: Partial<Record<CompletenessCode, readonly QualityGapCodeV2[]>> = {
  required_document_missing: ["required_document_missing", "required_documents_unevidenced"],
  requested_sections_not_declared: ["requested_sections_not_declared"],
  requested_section_not_evaluated: ["requested_section_not_evaluated"],
  section_rule_ambiguous: ["section_rule_conflict"],
  multiple_products_without_declared_sections: ["multiple_products_without_declared_sections"],
  implied_product_rule_ambiguous: ["implied_product_rule_conflict"],
  insurer_appetite_data_missing: ["insurer_appetite_data_missing"],
  insurer_rule_match_missing: ["taxonomy_match_missing"],
};

const unique = (values: Iterable<string>): string[] => [...new Set(values)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

function gapKey(code: string, insurerId: string | null, sectionKey: string | null): string {
  return `${code}\u0000${insurerId ?? ""}\u0000${sectionKey ?? ""}`;
}

/** Existing v2 gaps that cover this item (deterministic predicate per code). */
function coveringGaps(item: CompletenessItem, gapsByKey: Map<string, QualityGapV2[]>): QualityGapV2[] {
  const codes = COVERED_BY[item.code];
  if (!codes) return [];
  const found: QualityGapV2[] = [];
  const insurerIds: (string | null)[] = item.insurer_ids.length > 0 ? item.insurer_ids : [null];
  const sectionKeys: (string | null)[] =
    item.scope === "section" && item.section_keys.length > 0 ? item.section_keys : [null];
  for (const code of codes) {
    for (const insurerId of insurerIds) {
      for (const sectionKey of sectionKeys) {
        for (const gap of gapsByKey.get(gapKey(code, insurerId, sectionKey)) ?? []) {
          // A per-document gap only covers the document it names.
          if (code === "required_document_missing" && documentKey(gap.missing[0] ?? "") !== item.document_key) continue;
          found.push(gap);
        }
      }
    }
  }
  return found;
}

export function assessQualityV3(input: QualityAssessmentInputV3): {
  quality: RecommendationQualityV3;
  insurerQuality: Map<string, InsurerQualityV3>;
  completeness: CompletenessAnalysis;
  contradictions: ContradictionAnalysis;
} {
  const { quality: v2, insurerQuality } = assessQuality(input);

  // ---- Index the v2 gaps once ---------------------------------------------------
  const gapsByKey = new Map<string, QualityGapV2[]>();
  for (const gap of v2.gaps) {
    const key = gapKey(gap.code, gap.insurer_id, gap.section_key);
    const list = gapsByKey.get(key);
    if (list) list.push(gap);
    else gapsByKey.set(key, [gap]);
  }

  // ---- Link completeness items to the gaps that already describe them ------------
  const itemIdsByGap = new Map<string, Set<string>>();
  const linkedItems: CompletenessItem[] = input.completeness.items.map((item) => {
    const covering = coveringGaps(item, gapsByKey);
    for (const gap of covering) {
      const set = itemIdsByGap.get(gap.gap_id) ?? new Set<string>();
      set.add(item.item_id);
      itemIdsByGap.set(gap.gap_id, set);
    }
    return { ...item, quality_gap_ids: unique(covering.map((gap) => gap.gap_id)) };
  });

  const gaps: QualityGapV3[] = v2.gaps.map((gap) => ({
    ...gap,
    completeness_item_ids: unique(itemIdsByGap.get(gap.gap_id) ?? []),
    contradiction_id: null,
  }));

  // ---- New gap: extraction-reported information that was never classified ---------
  linkedItems.forEach((item, index) => {
    if (item.code !== "extraction_reported_information_missing") return;
    const reference = item.required_by[0]?.reference ?? item.item_id;
    const built = buildQualityGap({
      code: "extraction_reported_information_missing",
      severity: "advisory" as QualitySeverity,
      scope: "reviewed_fact",
      field_path: item.field_path,
      missing: [reference],
    });
    gaps.push({
      ...(built as QualityGapV2),
      code: "extraction_reported_information_missing",
      completeness_item_ids: [item.item_id],
      contradiction_id: null,
    });
    linkedItems[index] = { ...item, quality_gap_ids: [built.gap_id] };
  });

  // ---- New gap: every contradiction ----------------------------------------------
  const linkedContradictions = input.contradictions.contradictions.map((contradiction) => {
    const built = buildQualityGap({
      code: "conflicting_recorded_values",
      severity: contradiction.severity,
      scope: "reviewed_fact",
      field_path: contradiction.field_path ?? contradiction.field_key,
      missing: ["consistent_recorded_value"],
    });
    gaps.push({
      ...(built as QualityGapV2),
      code: "conflicting_recorded_values",
      completeness_item_ids: [],
      contradiction_id: contradiction.contradiction_id,
    });
    return { ...contradiction, quality_gap_id: built.gap_id };
  });

  // ---- New gap: a registered comparison genuinely could not run -----------------
  const linkedComparisons = input.contradictions.comparisons.map((comparison) => {
    if (comparison.outcome !== "comparison_unavailable" || !comparison.unavailable_reason) return comparison;
    const built = buildQualityGap({
      code: "comparison_unavailable",
      severity: "advisory" as QualitySeverity,
      scope: "reviewed_fact",
      field_path: comparison.field_key,
      missing: [comparison.unavailable_reason],
    });
    if (!gaps.some((gap) => gap.gap_id === built.gap_id)) {
      gaps.push({
        ...(built as QualityGapV2),
        code: "comparison_unavailable",
        completeness_item_ids: [],
        contradiction_id: null,
      });
    }
    return { ...comparison, quality_gap_id: built.gap_id };
  });

  gaps.sort(compareQualityGaps);
  const count = (severity: QualitySeverity) => gaps.filter((item) => item.severity === severity).length;
  const counts = { blocker: count("blocker"), material: count("material"), advisory: count("advisory") };

  return {
    quality: {
      model: QUALITY_MODEL_VERSION,
      state: stateFor(counts),
      blocker_count: counts.blocker,
      material_count: counts.material,
      advisory_count: counts.advisory,
      gaps,
    },
    // Per-insurer quality is exactly v2's: both new codes are recommendation-level.
    insurerQuality,
    completeness: { ...input.completeness, items: linkedItems },
    contradictions: { ...input.contradictions, comparisons: linkedComparisons, contradictions: linkedContradictions },
  };
}
