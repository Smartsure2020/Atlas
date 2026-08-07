import { adminClient, audit, json, jsonError, type AtlasUser } from "./auth";
import type { Env } from "./config";
import { roleCanViewManagerDashboard, roleCanWrite } from "./phase6-hardening";

// ---------------------------------------------------------------------------
// Pilot issue CRUD + pilot flag management
// ---------------------------------------------------------------------------

export async function handleListPilotIssues(
  submissionId: string,
  env: Env,
  _user: AtlasUser
): Promise<Response> {
  const admin = adminClient(env);
  const { data, error } = await admin
    .from("atlas_pilot_issues")
    .select("*")
    .eq("submission_id", submissionId)
    .order("created_at", { ascending: false });
  if (error) return json({ error: "fetch_failed" }, 500);
  return json({ ok: true, issues: data ?? [] });
}

export async function handleCreatePilotIssue(
  submissionId: string,
  request: Request,
  env: Env,
  user: AtlasUser
): Promise<Response> {
  if (!roleCanWrite(user.role)) {
    return jsonError("permission_denied", 403, "Readonly users cannot create pilot issues.");
  }
  const body = (await request.json().catch(() => null)) as {
    title?: string;
    description?: string;
    severity?: string;
    assigned_to?: string | null;
  } | null;
  if (!body?.title) {
    return jsonError("missing_required_input", 400, "Title is required.");
  }
  const validSeverities = ["low", "medium", "high", "critical"];
  const severity = validSeverities.includes(body.severity ?? "") ? body.severity : "medium";

  const admin = adminClient(env);
  const { data, error } = await admin
    .from("atlas_pilot_issues")
    .insert({
      submission_id: submissionId,
      title: body.title,
      description: body.description ?? null,
      severity,
      status: "open",
      reported_by: user.id,
      assigned_to: body.assigned_to ?? null,
    })
    .select("id")
    .single();
  if (error || !data) return json({ error: "create_failed" }, 500);

  await audit(env, {
    submissionId,
    action: "pilot_issue_created",
    actorId: user.id,
    metadata: { issue_id: data.id, severity },
  });
  return json({ ok: true, id: data.id }, 201);
}

export async function handleUpdatePilotIssue(
  issueId: string,
  request: Request,
  env: Env,
  user: AtlasUser
): Promise<Response> {
  if (!roleCanViewManagerDashboard(user.role)) {
    return jsonError("permission_denied", 403, "Only managers can update pilot issues.");
  }
  const body = (await request.json().catch(() => null)) as {
    status?: string;
    severity?: string;
    assigned_to?: string | null;
    resolution_notes?: string | null;
  } | null;
  if (!body) return jsonError("missing_required_input", 400, "Request body is required.");

  const admin = adminClient(env);
  const { data: existing } = await admin
    .from("atlas_pilot_issues")
    .select("id, status")
    .eq("id", issueId)
    .maybeSingle();
  if (!existing) return json({ error: "not_found" }, 404);

  const validStatuses = ["open", "in_progress", "resolved", "wont_fix"];
  const validSeverities = ["low", "medium", "high", "critical"];

  const update: Record<string, unknown> = {};
  if (body.status && validStatuses.includes(body.status)) {
    update.status = body.status;
    if (body.status === "resolved" || body.status === "wont_fix") {
      update.resolved_at = new Date().toISOString();
      update.resolved_by = user.id;
    }
  }
  if (body.severity && validSeverities.includes(body.severity)) {
    update.severity = body.severity;
  }
  if (body.assigned_to !== undefined) update.assigned_to = body.assigned_to;
  if (body.resolution_notes !== undefined) update.resolution_notes = body.resolution_notes;

  if (Object.keys(update).length === 0) {
    return jsonError("missing_required_input", 400, "No valid fields to update.");
  }

  const { error } = await admin.from("atlas_pilot_issues").update(update).eq("id", issueId);
  if (error) return json({ error: "update_failed" }, 500);

  await audit(env, {
    action: "pilot_issue_updated",
    actorId: user.id,
    metadata: { issue_id: issueId, fields: Object.keys(update) },
  });
  return json({ ok: true });
}

export async function handleUpdatePilotFlag(
  submissionId: string,
  request: Request,
  env: Env,
  user: AtlasUser
): Promise<Response> {
  if (!roleCanWrite(user.role)) {
    return jsonError("permission_denied", 403, "Readonly users cannot update pilot flags.");
  }
  const body = (await request.json().catch(() => null)) as {
    pilot_flag?: boolean;
    pilot_notes?: string | null;
  } | null;
  if (!body || body.pilot_flag === undefined) {
    return jsonError("missing_required_input", 400, "pilot_flag is required.");
  }

  const admin = adminClient(env);
  const update: Record<string, unknown> = { pilot_flag: body.pilot_flag };
  if (body.pilot_notes !== undefined) update.pilot_notes = body.pilot_notes;

  const { error } = await admin
    .from("atlas_submissions")
    .update(update)
    .eq("id", submissionId);
  if (error) return json({ error: "update_failed" }, 500);

  await audit(env, {
    submissionId,
    action: body.pilot_flag ? "pilot_flag_enabled" : "pilot_flag_disabled",
    actorId: user.id,
    metadata: { pilot_notes_present: Boolean(body.pilot_notes) },
  });
  return json({ ok: true });
}
