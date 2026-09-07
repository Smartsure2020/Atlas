/**
 * Atlas — Quote Pipeline read-only endpoints (Phase 4)
 * ---------------------------------------------------------------------------
 * Two read-only surfaces:
 *
 *   GET /api/pipeline/workload         manager/admin only
 *   GET /api/submissions/:id/quick     all roles that can access the case
 *
 * Neither endpoint mutates lifecycle state. Both proxy through the
 * service-role client behind server-side role gates.
 */

import { adminClient, json, jsonError, type AtlasUser } from "./auth.js";
import type { Env } from "./config.js";
import { emailsForUserIds } from "./user-directory.js";
import { normalizeAtlasRole, roleCanViewManagerDashboard } from "./phase6-hardening.js";
import { projectAuditForBroker, projectAuditForStaff, type RawAuditRow } from "./audit-projection.js";
import {
  computeWorkload,
  isAssignableAtlasRole,
  projectQuickSubmission,
  summariseDocuments,
  type RawDocumentRow,
  type RawQuickSubmissionRow,
  type WorkloadUserInput,
  type WorkloadSubmissionRow,
} from "./pipeline-core.js";

// ---------------------------------------------------------------------------
// GET /api/pipeline/workload
// ---------------------------------------------------------------------------
// Manager/admin only. Broker/consultant/underwriter/readonly all get 403.
// Data-shape must match auto-assignment's open-workload predicate exactly.

export async function handleGetWorkload(env: Env, user: AtlasUser): Promise<Response> {
  if (!roleCanViewManagerDashboard(user.role)) {
    return jsonError(
      "permission_denied",
      403,
      "Workload visibility is restricted to managers and admins."
    );
  }

  const admin = adminClient(env);

  // 1) Read profiles — capability + availability, keyed by auth.users.id.
  const { data: profiles, error: profilesError } = await admin
    .from("atlas_underwriter_profiles")
    .select("user_id, active_for_assignment");
  if (profilesError) {
    return jsonError("internal_error", 500, "Workload lookup failed.");
  }
  const profileRows = (profiles ?? []) as Array<{
    user_id: string;
    active_for_assignment: boolean;
  }>;

  // 2) Resolve each profile user's trusted app_metadata.atlas_role. We ignore
  //    every user whose role is not in the assignable set (broker/readonly/
  //    unknown) so a stray profile row cannot appear as underwriting capacity.
  const users: WorkloadUserInput[] = [];
  for (const p of profileRows) {
    try {
      const { data, error } = await admin.auth.admin.getUserById(p.user_id);
      if (error || !data?.user) continue;
      const rawRole = (data.user.app_metadata as Record<string, unknown>)?.atlas_role;
      const role = normalizeAtlasRole(rawRole);
      if (!isAssignableAtlasRole(role)) continue;
      users.push({
        user_id: p.user_id,
        email: data.user.email ?? null,
        role,
        active_for_assignment: p.active_for_assignment,
      });
    } catch {
      // Ignore individual lookup failures rather than 500 the whole panel.
      continue;
    }
  }

  // 3) Load the open workload rows. Predicate MUST match Phase 2
  //    auto-assignment exactly: assigned_to non-null, pipeline_stage non-null,
  //    pipeline_stage NOT terminal. NULL historical rows excluded.
  const { data: subs, error: subsError } = await admin
    .from("atlas_submissions")
    .select("assigned_to, pipeline_stage, line_of_business")
    .not("assigned_to", "is", null)
    .not("pipeline_stage", "is", null)
    .not("pipeline_stage", "in", "(bound,declined,lost)");
  if (subsError) {
    return jsonError("internal_error", 500, "Workload lookup failed.");
  }

  const workload = computeWorkload(users, (subs ?? []) as WorkloadSubmissionRow[]);

  return json({ ok: true, workload });
}

// ---------------------------------------------------------------------------
// GET /api/submissions/:id/quick
// ---------------------------------------------------------------------------
// Access is gated by canAccessSubmission in the router; inaccessible cases
// return 404 there (never 403). The payload is an explicit allow-list, so
// future atlas_submissions columns cannot silently reach the browser.

const QUICK_SUBMISSION_COLUMNS =
  "id, client_name, broker_name, broker_email, request_type, " +
  "pipeline_stage, queue_status, line_of_business, complexity, priority, " +
  "assigned_to, next_action, due_at, source_type, received_at, " +
  "created_at, updated_at, last_pipeline_stage_changed_at";

const RECENT_ASSIGNMENT_EVENT_LIMIT = 10;
const RECENT_AUDIT_LIMIT = 20;

export async function handleGetSubmissionQuick(
  submissionId: string,
  env: Env,
  user: AtlasUser
): Promise<Response> {
  const admin = adminClient(env);

  // Pull the submission with the allow-listed columns only. Migration 0023
  // is required for the pipeline columns; on an unmigrated dev DB we fall
  // back gracefully so the drawer keeps working.
  let submissionRow: RawQuickSubmissionRow | null = null;
  {
    const { data, error } = await admin
      .from("atlas_submissions")
      .select(QUICK_SUBMISSION_COLUMNS)
      .eq("id", submissionId)
      .maybeSingle();
    if (!error && data) {
      submissionRow = data as unknown as RawQuickSubmissionRow;
    } else {
      // Legacy fallback — synthesise nullable pipeline fields.
      const legacyColumns =
        "id, client_name, broker_name, broker_email, request_type, " +
        "queue_status, line_of_business, priority, assigned_to, " +
        "next_action, due_at, created_at, updated_at";
      const { data: legacy } = await admin
        .from("atlas_submissions")
        .select(legacyColumns)
        .eq("id", submissionId)
        .maybeSingle();
      if (legacy) {
        submissionRow = {
          ...((legacy as unknown) as Record<string, unknown>),
          pipeline_stage: null,
          complexity: null,
          source_type: null,
          received_at: null,
          last_pipeline_stage_changed_at: null,
        } as unknown as RawQuickSubmissionRow;
      }
    }
  }
  if (!submissionRow) return jsonError("not_found", 404, "Submission not found.");

  const assignedToEmail = submissionRow.assigned_to
    ? (await emailsForUserIds(admin, [submissionRow.assigned_to])).get(submissionRow.assigned_to) ?? null
    : null;

  const submission = projectQuickSubmission(submissionRow, assignedToEmail);

  // Documents — SUMMARY only. Never file names or storage paths.
  const { data: docRows } = await admin
    .from("atlas_documents")
    .select("id, status, scan_status")
    .eq("submission_id", submissionId);
  const documents = summariseDocuments((docRows ?? []) as RawDocumentRow[]);

  // Recent assignment events — bounded, no metadata beyond the existing
  // Phase-2 shape. Broker is never given assignment history.
  let assignmentEvents: Array<{
    id: string;
    assignment_source: string;
    event_type: string;
    from_user_id: string | null;
    to_user_id: string | null;
    actor_user_id: string | null;
    created_at: string;
  }> = [];
  if (user.role !== "broker") {
    const { data: evRows } = await admin
      .from("atlas_assignment_events")
      .select(
        "id, assignment_source, event_type, from_user_id, to_user_id, actor_user_id, created_at"
      )
      .eq("submission_id", submissionId)
      .order("created_at", { ascending: false })
      .limit(RECENT_ASSIGNMENT_EVENT_LIMIT);
    assignmentEvents = (evRows ?? []) as typeof assignmentEvents;
  }

  // Recent audit — broker gets the sanitised Phase-3 projection; staff get
  // the full projection with resolved actor email. Both are bounded.
  const { data: auditRows } = await admin
    .from("atlas_audit_logs")
    .select("id, action, actor, metadata_json, created_at")
    .eq("submission_id", submissionId)
    .order("created_at", { ascending: false })
    .limit(RECENT_AUDIT_LIMIT);
  const allAudit = (auditRows ?? []) as RawAuditRow[];

  let history: ReturnType<typeof projectAuditForStaff>;
  if (user.role === "broker") {
    history = projectAuditForBroker(allAudit, user.id, user.email ?? null);
  } else {
    const actorIds = new Set<string>();
    for (const r of allAudit) if (r.actor) actorIds.add(r.actor);
    let emailById = new Map<string, string>();
    try {
      emailById = await emailsForUserIds(admin, actorIds);
    } catch {
      // non-fatal
    }
    history = projectAuditForStaff(allAudit, emailById);
  }

  return json({
    ok: true,
    submission,
    documents,
    assignment_events: assignmentEvents,
    history,
  });
}
