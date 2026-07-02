/**
 * Atlas Blueprint — Phase 3 frontend API helpers
 * ----------------------------------------------------------------------------
 * Typed wrappers for the decision, email, and audit endpoints. Imports `api`
 * from the existing lib/atlas.ts — no changes to that file's existing exports.
 */

import { api } from "./atlas";

// ---- Decision ----

export type OverrideReasonCode =
  | "client_preference"
  | "broker_relationship"
  | "claims_history_factor"
  | "pricing_factor"
  | "capacity_constraint"
  | "client_request"
  | "other";

export interface Decision {
  id: string;
  quote_review_id: string | null;
  recommendation_id: string | null;
  selected_insurer: string | null;
  selected_insurer_id: string | null;
  decision_status: "ready_for_quote" | "referred" | "closed";
  decision_choice: "proceed" | "refer" | "request_info" | "decline" | "override" | null;
  decision_reason: string | null;
  underwriter_notes: string | null;
  ai_recommendation_accepted: boolean;
  override_reason_code: OverrideReasonCode | null;
  override_reason: string | null;
  decision_snapshot: unknown;
  decided_by: string;
  decided_at: string;
}

export interface DecisionInput {
  quote_review_id?: string;
  recommendation_id?: string;
  selected_insurer?: string;
  selected_insurer_id?: string | null;
  decision_status?: "ready_for_quote" | "referred" | "closed";
  decision_choice?: "proceed" | "refer" | "request_info" | "decline" | "override";
  decision_reason?: string;
  ai_recommendation_accepted: boolean;
  override_reason_code?: OverrideReasonCode;
  override_reason?: string;
  underwriter_notes?: string;
}

export function recordDecision(submissionId: string, input: DecisionInput) {
  return api<{ ok: true; decision_id: string }>(
    `/api/submissions/${submissionId}/decision`,
    { method: "POST", body: JSON.stringify(input) }
  );
}

export function getDecision(submissionId: string) {
  return api<{ ok: true; decision: Decision | null }>(
    `/api/submissions/${submissionId}/decision`
  );
}

// ---- Emails ----

export type EmailType =
  | "broker-missing-info"
  | "broker-acknowledgement"
  | "insurer-submission"
  | "internal-summary";

export interface EmailDraft {
  subject: string;
  body: string;
}

export function generateEmail(submissionId: string, type: EmailType) {
  return api<{ ok: true } & EmailDraft>(
    `/api/submissions/${submissionId}/emails/${type}`,
    { method: "POST" }
  );
}

// ---- Audit ----

export interface AuditEvent {
  id: string;
  action: string;
  actor_id: string | null;
  actor_email: string | null;
  metadata: unknown;
  created_at: string;
}

export function getAuditTimeline(submissionId: string) {
  return api<{ ok: true; events: AuditEvent[] }>(
    `/api/submissions/${submissionId}/audit`
  );
}
