import { api } from "./atlas";

export type QuoteReviewStatus =
  | "draft"
  | "review_required"
  | "can_proceed"
  | "refer"
  | "declined"
  | "info_required"
  | "overridden";

export type QuoteReviewSectionStatus =
  | "ok"
  | "caution"
  | "refer"
  | "declined"
  | "info_required"
  | "insufficient_rule_match";

export interface QuoteReview {
  id: string;
  submission_id: string;
  recommendation_id: string | null;
  insurer_id: string | null;
  status: QuoteReviewStatus;
  overall_outcome: string;
  overall_confidence: number;
  manual_review_required: boolean;
  review_snapshot: {
    quote_terms?: unknown;
    result?: unknown;
    [key: string]: unknown;
  };
  created_at: string;
  updated_at: string;
}

export interface QuoteReviewSection {
  id: string;
  quote_review_id: string;
  section_key: string;
  section_name: string;
  matched_rule_id: string | null;
  status: QuoteReviewSectionStatus;
  confidence: number;
  findings: string[];
  missing_documents: string[];
  referral_triggers: string[];
  declined_reasons: string[];
  rating_findings: string[];
  excess_findings: string[];
  warranty_findings: string[];
  source_evidence: {
    consultant_explanation?: string;
    rule?: {
      id?: string;
      product_line?: string;
      risk_type?: string;
      source_quote?: string | null;
      source_page?: number | null;
      source_section?: string | null;
      source_file_name?: string | null;
    } | null;
    quote?: unknown;
  };
}

export function runQuoteReview(
  submissionId: string,
  input: { recommendation_id?: string; insurer_id?: string | null; force?: boolean } = {}
) {
  return api<{ ok: true; quote_review_id: string; skipped?: boolean; message?: string }>(
    `/api/submissions/${submissionId}/quote-review`,
    { method: "POST", body: JSON.stringify(input) }
  );
}

export function getQuoteReview(submissionId: string) {
  return api<{
    ok: true;
    quote_review: QuoteReview | null;
    sections: QuoteReviewSection[];
  }>(`/api/submissions/${submissionId}/quote-review`);
}
