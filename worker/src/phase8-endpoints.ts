import { adminClient, audit, json, type AtlasUser } from "./auth";
import type { Env } from "./config";
import { roleCanViewManagerDashboard } from "./phase6-hardening";
import {
  applyManualRetry,
  canRetryJob,
  cancellationUpdate,
  canaryIsSafe,
  transitionAlert,
} from "./phase8-core";

const CLIENT_DOCS_BUCKET = "atlas-client-docs";
const INSURER_DOCS_BUCKET = "atlas-insurer-docs";

function requireManager(user: AtlasUser): Response | null {
  if (!roleCanViewManagerDashboard(user.role)) {
    return json({ error: "forbidden", detail: "manager_only" }, 403);
  }
  return null;
}

export async function handleRetryJob(jobId: string, env: Env, user: AtlasUser): Promise<Response> {
  const guard = requireManager(user);
  if (guard) return guard;
  const admin = adminClient(env);
  const { data: job } = await admin.from("atlas_jobs").select("*").eq("id", jobId).maybeSingle();
  if (!job) return json({ error: "not_found" }, 404);
  if (!canRetryJob(job as Record<string, unknown>)) {
    return json({ error: "not_retryable", detail: "job_cannot_be_retried" }, 400);
  }
  const update = applyManualRetry(job as { retry_count?: number | null; max_retries?: number | null; error_code?: string | null; last_error_code?: string | null });
  const { error } = await admin.from("atlas_jobs").update(update).eq("id", jobId);
  if (error) return json({ error: "retry_failed" }, 500);
  await audit(env, {
    submissionId: (job as { submission_id?: string | null }).submission_id ?? null,
    action: "job_retry_requested",
    actorId: user.id,
    metadata: { job_id: jobId, retry_count: update.retry_count },
  });
  return json({ ok: true, job_id: jobId, status: "queued", retry_count: update.retry_count });
}

export async function handleCancelJob(jobId: string, env: Env, user: AtlasUser): Promise<Response> {
  const guard = requireManager(user);
  if (guard) return guard;
  const admin = adminClient(env);
  const { data: job } = await admin.from("atlas_jobs").select("*").eq("id", jobId).maybeSingle();
  if (!job) return json({ error: "not_found" }, 404);
  const update = cancellationUpdate(job as Record<string, unknown>, user.id);
  const { error } = await admin.from("atlas_jobs").update(update).eq("id", jobId);
  if (error) return json({ error: "cancel_failed" }, 500);
  await audit(env, {
    submissionId: (job as { submission_id?: string | null }).submission_id ?? null,
    action: "job_cancel_requested",
    actorId: user.id,
    metadata: { job_id: jobId, previous_status: (job as { status?: string }).status ?? null },
  });
  return json({ ok: true, job_id: jobId, cancellation_requested: true, status: update.status ?? job.status });
}

export async function handleListAlerts(env: Env, user: AtlasUser): Promise<Response> {
  const guard = requireManager(user);
  if (guard) return guard;
  const admin = adminClient(env);
  const { data, error } = await admin
    .from("atlas_operational_alerts")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) return json({ error: "fetch_failed" }, 500);
  return json({ ok: true, alerts: data ?? [] });
}

export async function handleUpdateAlert(alertId: string, request: Request, env: Env, user: AtlasUser): Promise<Response> {
  const guard = requireManager(user);
  if (guard) return guard;
  const body = (await request.json().catch(() => null)) as { action?: "acknowledge" | "resolve" } | null;
  if (body?.action !== "acknowledge" && body?.action !== "resolve") return json({ error: "bad_request" }, 400);
  const admin = adminClient(env);
  const { data: alert } = await admin.from("atlas_operational_alerts").select("id, status").eq("id", alertId).maybeSingle();
  if (!alert) return json({ error: "not_found" }, 404);
  const update = transitionAlert(alert as { status?: string | null }, body.action, user.id);
  const { error } = await admin.from("atlas_operational_alerts").update(update).eq("id", alertId);
  if (error) return json({ error: "alert_update_failed" }, 500);
  await audit(env, {
    action: `operational_alert_${body.action}d`,
    actorId: user.id,
    metadata: { alert_id: alertId },
  });
  return json({ ok: true });
}

export async function handleCanary(env: Env, user: AtlasUser): Promise<Response> {
  const guard = requireManager(user);
  if (guard) return guard;
  const admin = adminClient(env);
  const [submissions, jobs, buckets] = await Promise.all([
    admin.from("atlas_submissions").select("id").limit(1),
    admin.from("atlas_jobs").select("id").limit(1),
    admin.storage.listBuckets(),
  ]);
  const bucketIds = new Set((buckets.data ?? []).map((b) => b.id));
  const body = {
    ok: !submissions.error && !jobs.error,
    checks: {
      database: !submissions.error,
      core_tables_readable: !submissions.error,
      jobs_table_readable: !jobs.error,
      client_docs_bucket_configured: bucketIds.has(CLIENT_DOCS_BUCKET),
      insurer_docs_bucket_configured: bucketIds.has(INSURER_DOCS_BUCKET),
      ai_provider_config_present: Boolean(env.ANTHROPIC_API_KEY),
      migration_hint: jobs.error ? "phase_7_or_8_jobs_schema_missing" : "jobs_schema_available",
    },
  };
  if (!canaryIsSafe(body)) return json({ error: "unsafe_canary_response" }, 500);
  return json(body);
}

export async function handleListCleanupCandidates(env: Env, user: AtlasUser): Promise<Response> {
  const guard = requireManager(user);
  if (guard) return guard;
  const admin = adminClient(env);
  const { data, error } = await admin
    .from("atlas_cleanup_candidates")
    .select("*")
    .order("detected_at", { ascending: false })
    .limit(100);
  if (error) return json({ error: "fetch_failed" }, 500);
  return json({ ok: true, candidates: data ?? [] });
}

export async function handleConfirmCleanupCandidate(candidateId: string, request: Request, env: Env, user: AtlasUser): Promise<Response> {
  const guard = requireManager(user);
  if (guard) return guard;
  const body = (await request.json().catch(() => null)) as { action?: "approve" | "dismiss" } | null;
  if (body?.action !== "approve" && body?.action !== "dismiss") return json({ error: "bad_request" }, 400);
  const admin = adminClient(env);
  const next = body.action === "approve" ? "approved" : "dismissed";
  const { data: candidate } = await admin
    .from("atlas_cleanup_candidates")
    .select("*")
    .eq("id", candidateId)
    .maybeSingle();
  if (!candidate) return json({ error: "not_found" }, 404);
  const { error } = await admin
    .from("atlas_cleanup_candidates")
    .update({
      status: next,
      approved_by: body.action === "approve" ? user.id : null,
      approved_at: body.action === "approve" ? new Date().toISOString() : null,
      metadata: {
        ...((candidate as { metadata?: Record<string, unknown> | null }).metadata ?? {}),
        phase8_note: "The background worker deletes this candidate only after manager approval and rechecks that active documents remain protected.",
      },
    })
    .eq("id", candidateId);
  if (error) return json({ error: "cleanup_update_failed" }, 500);
  await audit(env, {
    submissionId: (candidate as { submission_id?: string | null }).submission_id ?? null,
    action: `cleanup_candidate_${body.action}d`,
    actorId: user.id,
    metadata: { candidate_id: candidateId, cleanup_status: next },
  });
  return json({ ok: true, candidate_id: candidateId, status: next });
}
