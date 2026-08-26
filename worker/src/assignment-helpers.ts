/**
 * Atlas — Phase 2 (Quote Pipeline assignment engine) pure helpers
 * ---------------------------------------------------------------------------
 * Runtime-safe helpers with no Supabase/Cloudflare dependencies. Extracted
 * from worker/src/assignment-endpoints.ts so the phase-16 API tests can
 * exercise them in the plain-node test harness without booting the whole
 * Worker module graph.
 */

import type { AssignmentRpcResult } from "./quote-pipeline-types.js";

// Historical operational-workflow vocabulary, preserved verbatim across
// Phase 2 to keep PATCH /api/submissions/:id/assignment backwards compatible.
export const QUEUE_STATUS_VALUES = [
  "new",
  "in_review",
  "waiting_info",
  "referred",
  "completed",
  "archived",
] as const;
export type QueueStatus = (typeof QUEUE_STATUS_VALUES)[number];

export function isQueueStatus(v: unknown): v is QueueStatus {
  return (
    typeof v === "string" &&
    (QUEUE_STATUS_VALUES as readonly string[]).includes(v)
  );
}

export function isUuid(v: unknown): v is string {
  return (
    typeof v === "string" &&
    /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(
      v
    )
  );
}

/**
 * Map an AssignmentRpcResult outcome to (status, body) using safe error codes
 * only. Never returns raw PostgREST/SQL text. Any unknown outcome falls back
 * to 500 internal_error with a generic message.
 */
export function mapAssignmentRpcResult(
  result: AssignmentRpcResult
): { status: number; body: Record<string, unknown> } {
  switch (result.outcome) {
    case "assigned":
      return { status: 200, body: { ok: true, ...result } };
    case "already_assigned":
    case "unchanged":
      return { status: 200, body: { ok: true, ...result } };
    case "submission_not_found":
      return {
        status: 404,
        body: {
          ok: false,
          error: "not_found",
          message: "Submission not found.",
          outcome: result.outcome,
        },
      };
    case "target_user_not_found":
      return {
        status: 404,
        body: {
          ok: false,
          error: "not_found",
          message: "Assignment target user not found.",
          outcome: result.outcome,
        },
      };
    case "actor_required":
      return {
        status: 400,
        body: {
          ok: false,
          error: "missing_required_input",
          message: "Assignment actor is required.",
          outcome: result.outcome,
        },
      };
    case "pipeline_not_initialized":
      return {
        status: 409,
        body: {
          ok: false,
          error: "validation_failed",
          message:
            "This submission predates the Quote Pipeline and cannot be auto-assigned.",
          outcome: result.outcome,
        },
      };
    case "not_triaged":
      return {
        status: 409,
        body: {
          ok: false,
          error: "validation_failed",
          message: "Triage is required before auto-assignment.",
          outcome: result.outcome,
          pipeline_stage: result.pipeline_stage ?? null,
        },
      };
    case "terminal_submission":
      return {
        status: 409,
        body: {
          ok: false,
          error: "validation_failed",
          message: "Assignment changes are not allowed on terminal submissions.",
          outcome: result.outcome,
          pipeline_stage: result.pipeline_stage ?? null,
        },
      };
    case "classification_required":
      return {
        status: 409,
        body: {
          ok: false,
          error: "missing_required_input",
          message:
            "Line of business and complexity are required to auto-assign this submission.",
          outcome: result.outcome,
        },
      };
    case "no_eligible_underwriter":
      return {
        status: 409,
        body: {
          ok: false,
          error: "validation_failed",
          message: "No eligible underwriter is available for this submission.",
          outcome: result.outcome,
          eligible_candidate_count: result.eligible_candidate_count ?? 0,
        },
      };
    default:
      return {
        status: 500,
        body: {
          ok: false,
          error: "internal_error",
          message: "Unknown assignment outcome.",
        },
      };
  }
}
