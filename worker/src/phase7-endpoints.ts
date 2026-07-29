import { adminClient, audit, json, type AtlasUser } from "./auth";
import type { Env } from "./config";
import { roleCanViewManagerDashboard } from "./phase6-hardening";
import { auditAssignmentChange } from "./phase7-jobs";
import { buildHealthBody, summarizeJobs } from "./phase7-core";

const CLIENT_DOCS_BUCKET = "atlas-client-docs";
const INSURER_DOCS_BUCKET = "atlas-insurer-docs";

function requireManager(user: AtlasUser): Response | null {
  if (!roleCanViewManagerDashboard(user.role)) {
    return json({ error: "forbidden", detail: "manager_only" }, 403);
  }
  return null;
}

export async function handleSystemStatus(env: Env, user: AtlasUser): Promise<Response> {
  const guard = requireManager(user);
  if (guard) return guard;

  const admin = adminClient(env);
  const dbStarted = Date.now();
  const { error: dbError } = await admin.from("atlas_submissions").select("id").limit(1);
  const dbLatencyMs = Date.now() - dbStarted;

  const { data: buckets } = await admin.storage.listBuckets();
  const bucketIds = new Set((buckets ?? []).map((b) => b.id));

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data: recentJobs } = await admin
    .from("atlas_jobs")
    .select("id, job_type, status, error_code, started_at, completed_at, created_at")
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(200);
  const summary = summarizeJobs((recentJobs ?? []) as Record<string, unknown>[]);

  const lastSuccessByType: Record<string, string | null> = {};
  for (const type of ["extraction", "recommendation", "quote_review", "guideline_ingestion"]) {
    const row = ((recentJobs ?? []) as Record<string, unknown>[]).find(
      (j) => j.job_type === type && j.status === "completed"
    );
    lastSuccessByType[type] = (row?.completed_at as string | undefined) ?? null;
  }

  return json({
    ok: true,
    environment: env.ATLAS_ENV ?? "development",
    database: {
      ok: !dbError,
      latency_ms: dbLatencyMs,
    },
    storage: {
      client_docs_bucket_configured: bucketIds.has(CLIENT_DOCS_BUCKET),
      insurer_docs_bucket_configured: bucketIds.has(INSURER_DOCS_BUCKET),
    },
    ai_provider: {
      anthropic_configured: Boolean(env.ANTHROPIC_API_KEY),
    },
    jobs_24h: {
      failed_count: summary.failed_count,
      stuck_count: summary.stuck_count,
      by_error_code: summary.by_error_code,
      last_success_by_type: lastSuccessByType,
    },
  });
}

export async function handleListJobs(env: Env, user: AtlasUser): Promise<Response> {
  const guard = requireManager(user);
  if (guard) return guard;

  const admin = adminClient(env);
  const { data, error } = await admin
    .from("atlas_jobs")
    .select(
      "id, submission_id, document_id, quote_review_id, insurer_id, job_type, status, " +
        "result_reference_id, error_code, error_message, started_at, completed_at, created_at, metadata, " +
        "retry_count, max_retries, next_retry_at, last_error_code, cancellation_requested, " +
        "progress_percent, current_step, heartbeat_at"
    )
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) return json({ error: "fetch_failed" }, 500);

  const rows = (data ?? []) as unknown as Record<string, unknown>[];
  const summary = summarizeJobs(rows);
  return json({ ok: true, jobs: data ?? [], summary });
}

export async function handleCleanupPreview(env: Env, user: AtlasUser): Promise<Response> {
  const guard = requireManager(user);
  if (guard) return guard;

  const admin = adminClient(env);
  const now = new Date().toISOString();
  const { data: expiredDocs } = await admin
    .from("atlas_documents")
    .select("id, submission_id, file_name, storage_path, expires_at, status")
    .neq("status", "active")
    .lt("expires_at", now)
    .order("expires_at", { ascending: true })
    .limit(100);

  const candidateRows = (expiredDocs ?? []).map((doc) => ({
    candidate_type: "expired_document_row",
    status: "pending",
    storage_bucket: "atlas-client-docs",
    storage_path: doc.storage_path,
    document_id: doc.id,
    submission_id: doc.submission_id,
    reason: "Document row is past expires_at and is not active.",
    metadata: { file_name: doc.file_name, document_status: doc.status, expires_at: doc.expires_at },
  }));
  if (candidateRows.length > 0) {
    await admin.from("atlas_cleanup_candidates").insert(candidateRows);
  }

  await audit(env, {
    action: "cleanup_preview_run",
    actorId: user.id,
    metadata: { cleanup_candidate_count: candidateRows.length },
  });

  return json({
    ok: true,
    mode: "candidate_preview",
    cleanup_candidates_created: candidateRows.length,
    expired_inactive_documents: expiredDocs ?? [],
    orphan_storage_note:
      "The background worker detects orphan paths and deletes only candidates explicitly approved by a manager.",
  });
}

export async function handleUpdateAssignment(
  submissionId: string,
  request: Request,
  env: Env,
  user: AtlasUser
): Promise<Response> {
  const body = (await request.json().catch(() => null)) as {
    assigned_to?: string | null;
    queue_status?: "new" | "in_review" | "waiting_info" | "referred" | "completed" | "archived" | null;
  } | null;
  if (!body) return json({ error: "bad_request" }, 400);

  const update: Record<string, unknown> = {};
  if ("assigned_to" in body) {
    update.assigned_to = body.assigned_to ?? null;
    update.assigned_underwriter = body.assigned_to ?? null;
    update.assigned_at = body.assigned_to ? new Date().toISOString() : null;
    update.assigned_by = body.assigned_to ? user.id : null;
  }
  if (body.queue_status) update.queue_status = body.queue_status;
  if (Object.keys(update).length === 0) return json({ error: "no_editable_fields" }, 400);

  const admin = adminClient(env);
  const { error } = await admin
    .from("atlas_submissions")
    .update(update)
    .eq("id", submissionId);
  if (error) return json({ error: "assignment_update_failed" }, 500);

  await auditAssignmentChange(env, {
    submissionId,
    actor: user,
    assignedTo: "assigned_to" in update ? (update.assigned_to as string | null) : null,
    queueStatus: (update.queue_status as string | undefined) ?? null,
  });

  return json({ ok: true });
}
