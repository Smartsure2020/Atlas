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

interface EvidenceRule {
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

interface RequiredDocumentOutcome {
  evidence_id: string;
  document_type: string;
  present: boolean;
  rule_evidence_ids: string[];
  confidence_adjustment: number;
}

interface ScoredEvidenceOutcome {
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

interface NoDataEvidenceOutcome {
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

export interface RecommendationEvidence {
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
