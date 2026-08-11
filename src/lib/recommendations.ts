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
  scoring_notes: string[];
  missing_required_documents: string[];
  unmatched_sections: string[];
  unmatched_product_candidates: string[];
  nearby_rule_matches: string[];
  /** Filled in server-side from the LLM reasoning pass (or fallback). */
  reasoning: string;
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
