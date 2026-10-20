/**
 * Powerhouse — `recommendation-evidence-v2`.
 *
 * Why a new schema version and not additive v1 fields: v2 changes the MEANING
 * of three things that production already stores under v1 —
 *   1. quality: `complete | gaps_present` becomes a severity-classified gate
 *      (`decision_ready | caution | incomplete`), so a v1 reader would
 *      misread "complete";
 *   2. sections: the insurer outcome is now accompanied by per-requested-section
 *      evaluations that are explicitly NOT part of the score;
 *   3. selection: how the single scoring rule was chosen (including ties), and
 *      the relevant rules that were considered but not selected.
 * v1 rows stay valid and readable; nothing is rewritten and no schema migration
 * is needed (evidence_json is untyped jsonb). The frontend reads both through a
 * discriminated union on `schema_version`.
 *
 * Like v1, this module only SERIALISES the authoritative matcher result. It
 * never scores, ranks or reinterprets, and it uses no LLM.
 */

import type {
  InsurerSelection,
  MatchInputRisk,
  RequestedSection,
  SectionEvaluation,
  ConsideredRule,
  InsurerScore,
} from "./matcher.js";
import { requestedSectionsOf } from "./matcher.js";
import type { AppetiteRow } from "./matcher-types.js";
import {
  buildReviewedRiskEvidence,
  canonicalRisk,
  compareCodeUnits,
  noDataOutcome,
  outcomeFor,
  ruleEvidenceFor,
  type NoDataInsurerOutcomeEvidence,
  type PersistedMatcherInput,
  type RecommendationEvidenceV1,
  type ReviewedRiskEvidence,
  type ScoredInsurerOutcomeEvidence,
} from "./recommendation-evidence.js";
import { QUALITY_MODEL_VERSION, assessQuality } from "./recommendation-quality.js";

export const RECOMMENDATION_EVIDENCE_SCHEMA_VERSION_V2 = "recommendation-evidence-v2" as const;
export { QUALITY_MODEL_VERSION };

// ---------------------------------------------------------------------------
// Quality vocabulary
// ---------------------------------------------------------------------------

export type QualitySeverity = "blocker" | "material" | "advisory";
export type IntelligenceState = "decision_ready" | "caution" | "incomplete";

export type QualityGapCodeV2 =
  | "rule_source_document_missing"
  | "rule_source_locator_incomplete"
  | "matched_rule_snapshot_missing"
  | "matched_input_source_missing"
  | "reviewed_fact_confidence_unavailable"
  | "insurer_appetite_data_missing"
  | "taxonomy_match_missing"
  | "scored_rule_product_unmatched"
  | "scored_rule_selection_tie"
  | "requested_section_not_evaluated"
  | "section_rule_conflict"
  | "section_hard_decline_not_reflected"
  | "section_soft_decline_not_reflected"
  | "section_referral_not_reflected"
  | "section_caution_not_reflected"
  | "section_outcome_not_scored"
  | "required_document_missing"
  | "recommended_insurer_unscored"
  | "requested_sections_not_declared"
  | "no_trusted_documents";

export interface QualityGapV2 {
  /** Deterministic identity; stable across runs for the same finding. */
  gap_id: string;
  code: QualityGapCodeV2;
  severity: QualitySeverity;
  scope: "recommendation" | "insurer" | "section" | "rule" | "reviewed_fact";
  insurer_id: string | null;
  rule_id: string | null;
  section_key: string | null;
  field_path: string | null;
  /** What is absent (or, for document gaps, which document). Machine tokens. */
  missing: string[];
}

export interface InsurerQualityV2 {
  state: IntelligenceState;
  blocker_count: number;
  material_count: number;
  advisory_count: number;
  gap_ids: string[];
}

export interface RecommendationQualityV2 {
  model: typeof QUALITY_MODEL_VERSION;
  state: IntelligenceState;
  blocker_count: number;
  material_count: number;
  advisory_count: number;
  gaps: QualityGapV2[];
}

// ---------------------------------------------------------------------------
// Outcome shapes
// ---------------------------------------------------------------------------

export interface ConsideredRuleEvidence extends ConsideredRule {
  /** False when the rule is not in the active rule set handed to the builder. */
  snapshot_resolved: boolean;
  source: "ai_extracted" | "manual" | null;
  source_document_id: string | null;
  source_file_name: string | null;
  source_page: number | null;
  source_section: string | null;
  source_quote: string | null;
}

export interface ScoredInsurerOutcomeEvidenceV2 extends ScoredInsurerOutcomeEvidence {
  selection: InsurerSelection;
  /** One entry per requested section. NOT combined into `score`. */
  section_evaluations: SectionEvaluation[];
  /** Relevant rules the selector saw, scored rule first. Bounded by relevance. */
  considered_rules: ConsideredRuleEvidence[];
  quality: InsurerQualityV2;
}

/** Everything but the quality block — what the quality gate reads. */
export type ScoredInsurerCore = Omit<ScoredInsurerOutcomeEvidenceV2, "quality">;
export type InsurerOutcomeCore = ScoredInsurerCore | NoDataInsurerOutcomeEvidence;
export type InsurerOutcomeEvidenceV2 = ScoredInsurerOutcomeEvidenceV2 | NoDataInsurerOutcomeEvidence;

/**
 * An explicit, point-in-time statement of HOW the insurer score was formed, so
 * no reader has to infer whether section outcomes were combined. They were not:
 * how to combine them is an open business decision (see the Powerhouse report).
 */
export interface ScoringScopeV2 {
  insurer_score_basis: "single_best_product_rule_plus_portfolio_rules";
  section_outcomes: "evaluated_not_aggregated";
  aggregation_rule: null;
  business_decision_required: "multi_section_aggregation";
}

export const SCORING_SCOPE_V2: ScoringScopeV2 = {
  insurer_score_basis: "single_best_product_rule_plus_portfolio_rules",
  section_outcomes: "evaluated_not_aggregated",
  aggregation_rule: null,
  business_decision_required: "multi_section_aggregation",
};

export interface RecommendationEvidenceV2 {
  schema_version: typeof RECOMMENDATION_EVIDENCE_SCHEMA_VERSION_V2;
  provenance: RecommendationEvidenceV1["provenance"];
  /** Privacy-minimised copy. Runtime matcher input remains unchanged. */
  matcher_input: PersistedMatcherInput;
  requested_sections: RequestedSection[];
  scoring_scope: ScoringScopeV2;
  reviewed_risk_facts: ReviewedRiskEvidence[];
  trusted_documents: RecommendationEvidenceV1["trusted_documents"];
  insurers: InsurerOutcomeEvidenceV2[];
  quality: RecommendationQualityV2;
}

export interface BuildEvidenceV2Input {
  recommendationId: string;
  submissionId: string;
  extractionId: string;
  reviewedAt: string | null;
  generatedAt: string;
  matcherVersion: string;
  taxonomyVersion: string;
  explanationMode: string;
  explanationSource: string;
  recommendationInputFingerprint: string;
  reviewed: Record<string, unknown>;
  matcherInput: MatchInputRisk;
  matcherResult: {
    insurers: InsurerScore[];
    no_data_for: { insurer_id: string; insurer_name: string }[];
    requested_sections?: RequestedSection[];
  };
  activeAppetite: AppetiteRow[];
}

function consideredEvidence(
  rule: ConsideredRule,
  appetiteById: Map<string, AppetiteRow>
): ConsideredRuleEvidence {
  const row = appetiteById.get(rule.rule_id);
  return {
    ...rule,
    section_keys: [...rule.section_keys],
    selected_for_section_keys: [...rule.selected_for_section_keys],
    conditions: rule.conditions.map((condition) => ({
      ...condition,
      matched_rule_terms: condition.matched_rule_terms.map((pair) => ({ ...pair })),
    })),
    snapshot_resolved: !!row,
    source: row?.source ?? null,
    source_document_id: row?.source_document_id ?? null,
    source_file_name: row?.source_file_name ?? null,
    source_page: row?.source_page ?? null,
    source_section: row?.source_section ?? null,
    source_quote: row?.source_quote ?? null,
  };
}

export function buildRecommendationEvidenceV2(input: BuildEvidenceV2Input): RecommendationEvidenceV2 {
  const appetiteById = new Map(input.activeAppetite.map((rule) => [rule.id, rule]));
  const facts = buildReviewedRiskEvidence(input.reviewed, input.matcherInput);
  const requestedSections = (input.matcherResult.requested_sections ?? requestedSectionsOf(input.matcherInput))
    .map((section) => ({ ...section }));

  const scored: ScoredInsurerCore[] = input.matcherResult.insurers.map((insurer) => {
    if (!insurer.selection || !insurer.section_evaluations || !insurer.considered_rules) {
      throw new Error(`matcher_section_intelligence_missing:${insurer.insurer_id}`);
    }
    const { evidence, unresolvedRuleIds, requiredDocuments } = ruleEvidenceFor(insurer, appetiteById);
    const base = outcomeFor(insurer, evidence, unresolvedRuleIds, requiredDocuments);
    const considered = insurer.considered_rules.map((rule) => consideredEvidence(rule, appetiteById));
    const unresolved = new Set(base.unresolved_rule_ids);
    for (const rule of considered) if (!rule.snapshot_resolved) unresolved.add(rule.rule_id);
    return {
      ...base,
      unresolved_rule_ids: [...unresolved].sort(compareCodeUnits),
      selection: { ...insurer.selection, tied_rule_ids: [...insurer.selection.tied_rule_ids] },
      section_evaluations: insurer.section_evaluations.map((section) => ({
        ...section,
        applicable_rule_ids: [...section.applicable_rule_ids],
        tied_rule_ids: [...section.tied_rule_ids],
      })),
      considered_rules: considered,
    };
  });

  const noData: NoDataInsurerOutcomeEvidence[] = [...input.matcherResult.no_data_for]
    .sort((a, b) => compareCodeUnits(a.insurer_name, b.insurer_name) || compareCodeUnits(a.insurer_id, b.insurer_id))
    .map((insurer) => noDataOutcome(insurer) as NoDataInsurerOutcomeEvidence);

  const trustedDocuments = [...new Set(input.matcherInput.available_documents)].sort(compareCodeUnits);
  const { quality, insurerQuality } = assessQuality({
    facts,
    insurers: [...scored, ...noData],
    requestedSections,
    trustedDocumentCount: trustedDocuments.length,
  });

  const insurers: InsurerOutcomeEvidenceV2[] = [
    ...scored.map((outcome) => {
      const insurerState = insurerQuality.get(outcome.insurer_id);
      if (!insurerState) throw new Error(`quality_missing:${outcome.insurer_id}`);
      return { ...outcome, quality: insurerState };
    }),
    ...noData,
  ];

  return {
    schema_version: RECOMMENDATION_EVIDENCE_SCHEMA_VERSION_V2,
    provenance: {
      recommendation_id: input.recommendationId,
      submission_id: input.submissionId,
      extraction_id: input.extractionId,
      reviewed_at: input.reviewedAt,
      generated_at: input.generatedAt,
      matcher_version: input.matcherVersion,
      taxonomy_version: input.taxonomyVersion,
      explanation_mode: input.explanationMode,
      explanation_source: input.explanationSource,
      recommendation_input_fingerprint: input.recommendationInputFingerprint,
    },
    matcher_input: canonicalRisk(input.matcherInput),
    requested_sections: requestedSections,
    scoring_scope: { ...SCORING_SCOPE_V2 },
    reviewed_risk_facts: facts,
    trusted_documents: trustedDocuments.map((documentType) => ({
      document_type: documentType,
      evidence_label: documentType,
      availability: "available" as const,
      trust_basis: "active_exact_clean" as const,
    })),
    insurers,
    quality,
  };
}
