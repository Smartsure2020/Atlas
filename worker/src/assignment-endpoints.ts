/**
 * Atlas — Phase 2 (Quote Pipeline assignment engine) Worker endpoints
 * ---------------------------------------------------------------------------
 * The Worker is the API/security boundary. Assignment mutations go through the
 * canonical SECURITY DEFINER functions installed by migration 0024:
 *
 *   - public.atlas_auto_assign_submission(uuid, uuid)
 *   - public.atlas_set_submission_assignment(uuid, uuid, uuid)
 *
 * Both functions live behind service_role EXECUTE only. Browser callers never
 * reach them directly — every route below authorises the caller and then
 * proxies via the service-role client.
 *
 * Historical PATCH /api/submissions/:id/assignment shape:
 *   - accepts { assigned_to?: uuid|null, queue_status?: <string>|null }
 *   - assigned_to (if present) is routed through
 *     atlas_set_submission_assignment, which writes the assignment event and
 *     the audit row atomically. The Worker MUST NOT then write a duplicate
 *     assignment audit event.
 *   - queue_status keeps the pre-existing operational-workflow behaviour and
 *     is written on the submissions row separately from the canonical
 *     assignment transaction.
 */

import { adminClient, audit, json, jsonError, type AtlasUser } from "./auth.js";
import type { Env } from "./config.js";
import type {
  AssignmentEventRecord,
  AssignmentEventType,
  AssignmentOutcome,
  AssignmentRpcResult,
  AssignmentSource,
  QuotePipelineStage,
} from "./quote-pipeline-types.js";
import {
  QUEUE_STATUS_VALUES,
  isQueueStatus,
  isUuid,
  mapAssignmentRpcResult,
  type QueueStatus,
} from "./assignment-helpers.js";

// --------------------------------------------------------------------------
// POST /api/submissions/:id/assignment/auto
// --------------------------------------------------------------------------

export async function handleAutoAssignSubmission(
  submissionId: string,
  _request: Request,
  env: Env,
  user: AtlasUser
): Promise<Response> {
  const admin = adminClient(env);
  const { data, error } = await admin.rpc("atlas_auto_assign_submission", {
    p_submission_id: submissionId,
    p_actor: user.id,
  });

  if (error) {
    return jsonError(
      "internal_error",
      500,
      "Auto-assignment failed."
    );
  }

  const result = (data ?? { outcome: "submission_not_found", submission_id: submissionId }) as
    AssignmentRpcResult;
  const mapped = mapAssignmentRpcResult(result);
  return json(mapped.body, mapped.status);
}

// --------------------------------------------------------------------------
// GET /api/submissions/:id/assignment-history
// --------------------------------------------------------------------------
// Access is already gated by the shared canAccessSubmission check in the
// router. Rows are returned oldest-first so the caller can render a natural
// timeline without reversing.

export async function handleGetAssignmentHistory(
  submissionId: string,
  env: Env,
  _user: AtlasUser
): Promise<Response> {
  const admin = adminClient(env);
  const { data, error } = await admin
    .from("atlas_assignment_events")
    .select(
      "id, submission_id, assignment_source, event_type, from_user_id, to_user_id, actor_user_id, selected_open_count, eligible_candidate_count, created_at"
    )
    .eq("submission_id", submissionId)
    .order("created_at", { ascending: true });

  if (error) {
    return jsonError("internal_error", 500, "Failed to fetch assignment history.");
  }

  const events = ((data ?? []) as unknown as AssignmentEventRecord[]).map((e) => ({
    id: e.id,
    submission_id: e.submission_id,
    assignment_source: e.assignment_source as AssignmentSource,
    event_type: e.event_type as AssignmentEventType,
    from_user_id: e.from_user_id,
    to_user_id: e.to_user_id,
    actor_user_id: e.actor_user_id,
    selected_open_count: e.selected_open_count,
    eligible_candidate_count: e.eligible_candidate_count,
    created_at: e.created_at,
  }));

  return json({ ok: true, events });
}

// --------------------------------------------------------------------------
// PATCH /api/submissions/:id/assignment  (canonical migration)
// --------------------------------------------------------------------------
// Preserves the existing request contract exactly. Any assigned_to change is
// routed through atlas_set_submission_assignment (which writes the
// assignment event and audit row atomically). queue_status keeps its
// existing behaviour and is updated directly on the submissions row. If both
// fields are present in the same request, both are applied.

export interface UpdateAssignmentRequestBody {
  assigned_to?: string | null;
  queue_status?: QueueStatus | null;
}

export async function handleUpdateAssignment(
  submissionId: string,
  request: Request,
  env: Env,
  user: AtlasUser
): Promise<Response> {
  const raw = (await request.json().catch(() => null)) as
    | UpdateAssignmentRequestBody
    | null;
  if (!raw) return json({ error: "bad_request" }, 400);

  const hasAssignedTo = "assigned_to" in raw;
  const hasQueueStatus = "queue_status" in raw && raw.queue_status !== null && raw.queue_status !== undefined;

  if (!hasAssignedTo && !hasQueueStatus) {
    return json({ error: "no_editable_fields" }, 400);
  }

  // Validate assigned_to shape early so we don't send garbage into the RPC.
  if (hasAssignedTo && raw.assigned_to !== null && !isUuid(raw.assigned_to)) {
    return json({ error: "bad_request", detail: "assigned_to must be a uuid or null" }, 400);
  }

  // Validate queue_status.
  if (hasQueueStatus && !isQueueStatus(raw.queue_status)) {
    return json({ error: "bad_request", detail: "invalid queue_status" }, 400);
  }

  const admin = adminClient(env);
  let assignmentBody: Record<string, unknown> | null = null;
  let assignmentStatus = 200;

  if (hasAssignedTo) {
    const { data, error } = await admin.rpc("atlas_set_submission_assignment", {
      p_submission_id: submissionId,
      p_assigned_to: raw.assigned_to ?? null,
      p_actor: user.id,
    });
    if (error) {
      return jsonError("internal_error", 500, "Assignment update failed.");
    }
    const rpc = (data ?? {
      outcome: "submission_not_found",
      submission_id: submissionId,
    }) as AssignmentRpcResult;
    const mapped = mapAssignmentRpcResult(rpc);
    if (mapped.status >= 400) {
      return json(mapped.body, mapped.status);
    }
    assignmentBody = mapped.body as Record<string, unknown>;
    assignmentStatus = mapped.status;
  }

  if (hasQueueStatus) {
    const { error } = await admin
      .from("atlas_submissions")
      .update({ queue_status: raw.queue_status })
      .eq("id", submissionId);
    if (error) {
      return jsonError("internal_error", 500, "Queue status update failed.");
    }
    // Preserve the pre-existing queue-status audit contract. We deliberately
    // do NOT re-emit an assignment_changed audit row here — the canonical
    // assignment function already wrote one inside its own transaction.
    await audit(env, {
      submissionId,
      action: "submission_queue_status_changed",
      actorId: user.id,
      metadata: { queue_status: raw.queue_status },
    });
  }

  if (assignmentBody) {
    return json(assignmentBody, assignmentStatus);
  }
  return json({ ok: true });
}

// Re-export the pure helpers so callers can pick them up from a single place.
export {
  QUEUE_STATUS_VALUES,
  isQueueStatus,
  isUuid,
  mapAssignmentRpcResult,
};
export type { QueueStatus };

// Re-export a stable, typed union so callers get compile-time checking.
export type { AssignmentEventRecord, AssignmentOutcome, QuotePipelineStage };
