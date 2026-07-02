import { api } from "./atlas";
import type { QuoteReview, QuoteReviewSection } from "./quote-reviews";

export type MissingInfoStatus = "open" | "requested" | "received" | "waived" | "not_required";
export type MissingInfoItemType = "document" | "quote_term" | "underwriting_info" | "referral_info" | "other";
export type MissingInfoOwner = "broker" | "client" | "consultant" | "insurer" | "senior_underwriter" | "unknown";

export interface MissingInfoItem {
  id: string;
  submission_id: string;
  quote_review_id: string | null;
  section_key: string | null;
  item_type: MissingInfoItemType;
  title: string;
  description: string | null;
  status: MissingInfoStatus;
  required_by_rule_id: string | null;
  source: "extraction" | "quote_review" | "manual" | "rule";
  owner: MissingInfoOwner;
  due_date: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
}

export interface ComparisonRow {
  quote_review_id: string;
  insurer: string;
  quote_reference: string | null;
  quote_date: string | null;
  date: string | null;
  overall_status: string;
  total_premium: number | null;
  section_count: number;
  status_counts: Record<string, number>;
  open_missing_info_count: number;
  referral_count: number;
  declined_count: number;
  manual_review_required: boolean;
  major_issue_count: number;
  decision: string | null;
  decision_reason: string | null;
  operationally_ready: boolean;
  cheapest_comparable: boolean;
  comparability_warning: string | null;
}

export type CommunicationType = "missing_info_request" | "referral_pack" | "review_summary" | "broker_note" | "internal_note" | "other";
export type CommunicationAudience = "broker" | "client" | "insurer" | "senior_underwriter" | "internal" | "unknown";
export type CommunicationStatus = "draft" | "copied" | "sent_manually" | "archived";

export interface CommunicationRecord {
  id: string;
  submission_id: string;
  quote_review_id: string | null;
  communication_type: CommunicationType;
  audience: CommunicationAudience;
  subject: string | null;
  body: string;
  status: CommunicationStatus;
  related_missing_info_item_ids: string[] | null;
  related_section_keys: string[] | null;
  created_at: string;
  updated_at: string;
  sent_at: string | null;
  notes: string | null;
}

export interface ManagerStats {
  total_submissions: number;
  quote_reviews_completed: number;
  reviews_by_status: Record<string, number>;
  missing_info_open_count: number;
  referrals_count: number;
  declined_count: number;
  overrides_count: number;
  communications_generated_count: number;
  communications_sent_manually_count: number;
  common_missing_information: { label: string; count: number }[];
  common_referral_triggers: { label: string; count: number }[];
  common_declined_reasons: { label: string; count: number }[];
  recent_reviews_needing_attention: QuoteReview[];
}

export function listMissingInfo(submissionId: string) {
  return api<{ ok: true; items: MissingInfoItem[] }>(`/api/submissions/${submissionId}/missing-info`);
}

export function generateMissingInfo(submissionId: string) {
  return api<{ ok: true; generated_count: number }>(`/api/submissions/${submissionId}/missing-info/generate`, {
    method: "POST",
  });
}

export function addMissingInfo(submissionId: string, input: {
  quote_review_id?: string | null;
  section_key?: string | null;
  item_type?: MissingInfoItemType;
  title: string;
  description?: string | null;
  owner?: MissingInfoOwner;
  due_date?: string | null;
  notes?: string | null;
}) {
  return api<{ ok: true; id: string }>(`/api/submissions/${submissionId}/missing-info`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function updateMissingInfo(itemId: string, input: {
  status?: MissingInfoStatus;
  notes?: string | null;
  owner?: MissingInfoOwner;
  due_date?: string | null;
}) {
  return api<{ ok: true }>(`/api/missing-info/${itemId}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export function generateDraft(
  submissionId: string,
  type: "missing-info" | "referral-pack" | "quote-summary",
  input: { recipient?: "broker" | "client" | "internal"; notes?: string } = {}
) {
  return api<{ ok: true; draft: string }>(`/api/submissions/${submissionId}/drafts/${type}`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function getQuoteReviewHistory(submissionId: string) {
  return api<{
    ok: true;
    reviews: QuoteReview[];
    sections_by_review: Record<string, QuoteReviewSection[]>;
    decisions_by_review: Record<string, unknown>;
    comparison: ComparisonRow[];
  }>(`/api/submissions/${submissionId}/quote-review-history`);
}

export function getManagerStats() {
  return api<{ ok: true; stats: ManagerStats }>("/api/manager/stats");
}

export function getManagerStatsFiltered(filters: {
  date_range?: "7d" | "30d" | "90d" | "all";
  status?: string;
  insurer_id?: string;
  consultant_id?: string;
  line_of_business?: string;
  outcome?: string;
}) {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) if (value) qs.set(key, value);
  return api<{ ok: true; stats: ManagerStats }>(`/api/manager/stats?${qs.toString()}`);
}

export function listCommunications(submissionId: string) {
  return api<{ ok: true; communications: CommunicationRecord[] }>(`/api/submissions/${submissionId}/communications`);
}

export function saveCommunication(submissionId: string, input: {
  quote_review_id?: string | null;
  communication_type: CommunicationType;
  audience: CommunicationAudience;
  subject?: string | null;
  body: string;
  related_missing_info_item_ids?: string[] | null;
  related_section_keys?: string[] | null;
  notes?: string | null;
}) {
  return api<{ ok: true; id: string; duplicate?: boolean }>(`/api/submissions/${submissionId}/communications`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function updateCommunication(id: string, input: {
  status?: CommunicationStatus;
  notes?: string | null;
  mark_related_missing_requested?: boolean;
}) {
  return api<{ ok: true }>(`/api/communications/${id}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}
