/**
 * Atlas Blueprint — Phase 2B frontend API helpers
 * ----------------------------------------------------------------------------
 * Typed wrappers over the recommendation endpoints. Imports `api` from the
 * existing lib/atlas.ts — no changes to that file's existing exports.
 */

import { api } from "./atlas";

// ---- Shapes the Worker returns inside the cached recommendation row ----

export interface ScoredInsurer {
  insurer_id: string;
  insurer_name: string;
  rank?: number;
  score: number;
  band: "preferred" | "standard" | "caution" | "declined" | "ruled_out" | "insufficient_rule_match";
  rule_status: "preferred" | "standard" | "caution" | "declined" | "referral" | "ruled_out" | "insufficient_rule_match";
  confidence: number;
  /**
   * Whether the confidence number carries provider provenance. The Worker
   * sets this alongside `confidence` so that a provider-rated zero can be
   * distinguished from an unavailable rating.
   */
  confidence_available: boolean;
  referral_required: boolean;
  manual_review_required: boolean;
  senior_review_required: boolean;
  ruled_out: boolean;
  scored_against_appetite_id: string | null;
  matched_rules: {
    appetite_id: string;
    matched_strings: string[];
    score_contribution?: number | null;
    matched_inputs?: {
      value: string;
      source_labels: string[];
      ai_inferred_only: boolean;
    }[];
    matched_rule_terms?: { term: string; input_source: string | null }[];
    effect?: MatcherRuleEffect;
    rule_product_line?: string;
    rule_risk_type?: string;
    source_quote?: string | null;
    source_page?: number | null;
    source_section?: string | null;
    source_file_name?: string | null;
    list:
      | "preferred"
      | "caution"
      | "declined"
      | "referral"
      | "base"
      | "portfolio_caution"
      | "portfolio_declined"
      | "portfolio_referral";
  }[];
  required_document_evidence?: {
    document_type: string;
    present: boolean;
    appetite_ids: string[];
    scopes: ("product" | "portfolio")[];
    confidence_adjustment: number;
  }[];
  score_reconciliation?: ScoreReconciliation;
  confidence_reconciliation?: ConfidenceReconciliation;
  scoring_notes: string[];
  missing_required_documents: string[];
  unmatched_sections: string[];
  unmatched_product_candidates: string[];
  nearby_rule_matches: string[];
  /** Filled in server-side from the LLM reasoning pass (or fallback). */
  reasoning: string;
}

export type MatcherRuleEffect =
  | "preferred"
  | "standard"
  | "caution"
  | "referral"
  | "hard_decline"
  | "soft_decline_referral";

export interface ScoreReconciliation {
  component_subtotal: number;
  hard_decline_adjustment: number;
  clamp_adjustment: number;
  final_score: number;
}

export interface ConfidenceReconciliation {
  input_confidence: number | null;
  input_confidence_available: boolean;
  required_document_adjustment: number;
  manual_review_cap_adjustment: number;
  final_confidence: number | null;
}

export interface EvidenceRule {
  evidence_id: string;
  rule_id: string;
  insurer_id: string;
  insurer_name: string;
  product_line: string;
  risk_type: string;
  appetite_level: "preferred" | "standard" | "caution" | "declined";
  effect: MatcherRuleEffect | "required_document_present" | "required_document_missing";
  matcher_component: string;
  score_contribution: number | null;
  matched_value_count: number;
  matched_rule_terms: { term: string; input_source: string | null }[];
  matched_input_sources: { source_labels: string[]; ai_inferred_only: boolean }[];
  required_document: string | null;
  source: "ai_extracted" | "manual";
  source_document_id: string | null;
  source_file_name: string | null;
  source_page: number | null;
  source_section: string | null;
  source_quote: string | null;
  rule_notes: string | null;
}

export interface RequiredDocumentOutcome {
  evidence_id: string;
  document_type: string;
  present: boolean;
  rule_evidence_ids: string[];
  confidence_adjustment: number;
}

export interface ScoredEvidenceOutcome {
  insurer_id: string;
  insurer_name: string;
  status: "scored";
  rank: number;
  score: number;
  band: ScoredInsurer["band"];
  rule_status: ScoredInsurer["rule_status"];
  confidence: number | null;
  confidence_available: boolean;
  referral_required: boolean;
  manual_review_required: boolean;
  senior_review_required: boolean;
  ruled_out: boolean;
  no_appetite_data: false;
  scored_against_rule_id: string | null;
  unresolved_rule_ids: string[];
  rule_evidence: EvidenceRule[];
  required_documents: RequiredDocumentOutcome[];
  score_reconciliation: ScoreReconciliation;
  confidence_reconciliation: ConfidenceReconciliation;
  outcome_reasons: {
    why_ranked: string[];
    strengthened_by: string[];
    weakened_by: string[];
    cautions: string[];
    referrals: string[];
    declines: string[];
    required_documents_present: string[];
    required_documents_missing: string[];
    evidence_gaps: string[];
  };
  unmatched_sections: string[];
  unmatched_product_candidates: string[];
  nearby_rule_matches: string[];
  matcher_notes: string[];
}

export interface NoDataEvidenceOutcome {
  insurer_id: string;
  insurer_name: string;
  status: "no_appetite_data";
  status_code: "no_active_appetite_data";
  no_appetite_data: true;
  rank: null;
  score: null;
  band: "no_appetite_data";
  rule_status: "no_appetite_data";
  rule_evidence: [];
  required_documents: [];
  outcome_reasons: { evidence_gaps: string[] };
}

export interface RecommendationEvidenceV1 {
  schema_version: "recommendation-evidence-v1";
  provenance: {
    recommendation_id: string;
    submission_id: string;
    extraction_id: string;
    reviewed_at: string | null;
    generated_at: string;
    matcher_version: string;
    taxonomy_version: string;
    explanation_mode: string;
    explanation_source: string;
    recommendation_input_fingerprint: string;
  };
  matcher_input: {
    product_candidates: string[];
    section_candidates?: string[];
    risk_candidates: string[];
    features: { source: string; ai_inferred: boolean; value_retained: false }[];
    available_documents: string[];
    overall_confidence: number;
    overall_confidence_available?: boolean;
  };
  reviewed_risk_facts: {
    field_path: string;
    label: string;
    present: true;
    value_retained: false;
    source_category: "reviewed_extraction" | "reviewed_ai_inference" | "extraction_metadata";
    matcher_roles: ("product_candidate" | "risk_candidate" | "feature" | "confidence")[];
    ai_inferred: boolean;
    confidence: number | null;
    confidence_available: boolean;
  }[];
  trusted_documents: {
    document_type: string;
    evidence_label: string;
    availability: "available";
    trust_basis: "active_exact_clean";
  }[];
  insurers: (ScoredEvidenceOutcome | NoDataEvidenceOutcome)[];
  quality: {
    status: "complete" | "gaps_present";
    gaps: {
      code: string;
      scope: "rule" | "reviewed_fact" | "insurer";
      insurer_id: string | null;
      rule_id: string | null;
      field_path: string | null;
      missing: string[];
    }[];
  };
}

/* ---------------------------------------------------------------------------
   recommendation-evidence-v2 (Powerhouse). Strict superset of v1 for the fields
   v1 already carried; adds requested sections, how the scoring rule was
   selected, considered-but-unselected rules, and a severity-classified quality
   gate. Read it through `resolveEvidence()` (lib/recommendation-evidence), never
   by inspecting `schema_version` ad hoc.
   ------------------------------------------------------------------------- */

export type QualitySeverity = "blocker" | "material" | "advisory";
export type IntelligenceState = "decision_ready" | "caution" | "incomplete";

export interface QualityGapV2 {
  gap_id: string;
  code: string;
  severity: QualitySeverity;
  scope: "recommendation" | "insurer" | "section" | "rule" | "reviewed_fact";
  insurer_id: string | null;
  rule_id: string | null;
  section_key: string | null;
  field_path: string | null;
  missing: string[];
}

export interface RuleConditionV2 {
  kind: "hard_decline" | "soft_decline_referral" | "referral" | "caution" | "preferred";
  origin: "appetite_level" | "declined_risks" | "referral_triggers" | "caution_risks" | "preferred_risks";
  matched_rule_terms: { term: string; input_source: string | null }[];
}

export type SelectionBasisV2 = "only_candidate" | "highest_taxonomy_quality" | "tie_broken_by_canonical_order";
export type SectionOutcomeV2 =
  | "hard_decline"
  | "soft_decline_referral"
  | "referral"
  | "caution"
  | "preferred"
  | "standard";

/** Aspects in which equally good (tied) rules differ in a way that could change the outcome. */
export type TieDifferenceV2 =
  | "appetite_level"
  | "hard_decline"
  | "soft_decline"
  | "preferred_terms"
  | "caution_terms"
  | "referral_terms"
  | "required_documents";

export interface SectionEvaluationV2 {
  section: string;
  section_key: string;
  status: "evaluated" | "no_applicable_rule";
  applicable_rule_ids: string[];
  selected_rule_id: string | null;
  selection_basis: SelectionBasisV2 | null;
  tied_rule_ids: string[];
  tied_rules_disagree: boolean;
  tie_differences: TieDifferenceV2[];
  outcome: SectionOutcomeV2 | null;
  reflected_in_insurer_outcome: boolean;
}

export interface ConsideredRuleV2 {
  rule_id: string;
  product_line: string;
  risk_type: string;
  appetite_level: "preferred" | "standard" | "caution" | "declined";
  taxonomy_quality: 1 | 2 | 3;
  section_keys: string[];
  selected_for_section_keys: string[];
  scored: boolean;
  not_scored_reason: "lower_taxonomy_quality" | "lost_tie_canonical_order" | null;
  listed_because: "scored_rule" | "section_applicable" | "product_relevant" | "tied_for_best" | "material_risk_only";
  conditions: RuleConditionV2[];
  snapshot_resolved: boolean;
  /** The rule's own required-document set; null when the snapshot was not resolved. */
  required_documents: string[] | null;
  source: "ai_extracted" | "manual" | null;
  source_document_id: string | null;
  source_file_name: string | null;
  source_page: number | null;
  source_section: string | null;
  source_quote: string | null;
}

export interface ScoredEvidenceOutcomeV2 extends ScoredEvidenceOutcome {
  selection: {
    product_rule_id: string | null;
    taxonomy_quality: 1 | 2 | 3 | null;
    basis: SelectionBasisV2 | null;
    tied_rule_ids: string[];
    tied_rules_disagree: boolean;
    tie_differences: TieDifferenceV2[];
    matching_rule_count: number;
    omitted_risk_only_rule_count: number;
  };
  section_evaluations: SectionEvaluationV2[];
  /** Product lines implied when no cover section was declared; not requested sections, not scored. */
  implied_product_evaluations: SectionEvaluationV2[];
  considered_rules: ConsideredRuleV2[];
  quality: {
    state: IntelligenceState;
    blocker_count: number;
    material_count: number;
    advisory_count: number;
    gap_ids: string[];
  };
}

export interface RecommendationEvidenceV2 {
  schema_version: "recommendation-evidence-v2";
  provenance: RecommendationEvidenceV1["provenance"];
  matcher_input: RecommendationEvidenceV1["matcher_input"];
  requested_sections: { section: string; section_key: string }[];
  scoring_scope: {
    insurer_score_basis: "single_best_product_rule_plus_portfolio_rules";
    section_outcomes: "evaluated_not_aggregated";
    aggregation_rule: null;
    business_decision_required: "multi_section_aggregation";
  };
  reviewed_risk_facts: RecommendationEvidenceV1["reviewed_risk_facts"];
  trusted_documents: RecommendationEvidenceV1["trusted_documents"];
  insurers: (ScoredEvidenceOutcomeV2 | NoDataEvidenceOutcome)[];
  quality: {
    model: string;
    state: IntelligenceState;
    blocker_count: number;
    material_count: number;
    advisory_count: number;
    gaps: QualityGapV2[];
  };
}

/** Discriminated on `schema_version`. Unknown future versions are handled by resolveEvidence(). */
export type RecommendationEvidence = RecommendationEvidenceV1 | RecommendationEvidenceV2;

export interface Recommendation {
  id: string;
  recommended_insurer: string | null;
  secondary_options_json: ScoredInsurer[];
  not_recommended_json: ScoredInsurer[];
  reasoning_json: {
    headline: string;
    top: ScoredInsurer | null;
    no_data_for: { insurer_id: string; insurer_name: string }[];
    manual_review_required?: boolean;
    unmatched_sections?: string[];
    unmatched_product_candidates?: string[];
    /**
     * Snapshot of the extraction confidence that produced this ranking.
     * `overall_confidence_available === false` means the ranking was
     * computed against a run where the provider did not return a rating.
     */
    overall_confidence?: number;
    overall_confidence_available?: boolean;
  };
  confidence_score: number;
  referral_required: boolean;
  senior_review_required: boolean;
  extraction_id: string | null;
  created_at: string;
  /** Null/absent on recommendations created before Phase 1A. */
  evidence_json?: RecommendationEvidence | null;
}

export function runRecommendation(submissionId: string, input: { force?: boolean } = {}) {
  return api<{ ok: true; recommendation_id: string; skipped?: boolean; message?: string }>(
    `/api/submissions/${submissionId}/recommend`,
    { method: "POST", body: JSON.stringify(input) }
  );
}

export function getRecommendation(submissionId: string) {
  return api<{ ok: true; recommendation: Recommendation | null }>(
    `/api/submissions/${submissionId}/recommendation`
  );
}
