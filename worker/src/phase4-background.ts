import { adminClient, audit, type AtlasUser } from "./auth";
import { graphJobProcessingEnabled, type Env } from "./config";
import { scanStorageObject } from "./malware-scan";
import {
  buildAlert,
  isRetryableError,
  nextRetryAt,
} from "./phase8-core";
import {
  completeJob,
  failJob,
  updateJobProgress,
  type AtlasJobType,
} from "./phase7-jobs";
import { handleExtract } from "./extract-endpoint";
import { handleRunRecommendation } from "./recommendation-endpoints";
import { handleRunQuoteReview } from "./quote-review-endpoints";
import { handleProcessInsurerDoc } from "./insurer-endpoints";
import {
  handleGraphAttachmentDiscoveryJob,
  handleGraphAttachmentIngestJob,
} from "./graph-attachment";
import { GraphError } from "./graph-client";
import {
  CLIENT_DOCS_BUCKET,
  INSURER_DOCS_BUCKET,
  findActiveStorageReference,
} from "./cleanup-reference";
export { findActiveStorageReference } from "./cleanup-reference";
export type { StorageReferenceCheck } from "./cleanup-reference";

type JobRow = {
  id: string;
  job_type: AtlasJobType;
  submission_id?: string | null;
  document_id?: string | null;
  created_by?: string | null;
  status: string;
  retry_count?: number | null;
  max_retries?: number | null;
  metadata?: Record<string, unknown> | null;
};

function batchSize(env: Env): number {
  const parsed = Number(env.ATLAS_WORKER_BATCH_SIZE ?? "5");
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(20, Math.trunc(parsed)) : 5;
}

function stuckMinutes(env: Env): number {
  const parsed = Number(env.ATLAS_STUCK_JOB_MINUTES ?? "20");
  return Number.isFinite(parsed) && parsed > 0 ? Math.max(5, Math.trunc(parsed)) : 20;
}

function alertEscalateMinutes(env: Env): number {
  const parsed = Number(env.ATLAS_ALERT_ESCALATE_MINUTES ?? "30");
  return Number.isFinite(parsed) && parsed > 0 ? Math.max(5, Math.trunc(parsed)) : 30;
}

function systemUser(job: JobRow): AtlasUser {
  return { id: job.created_by ?? "00000000-0000-0000-0000-000000000000", email: null, role: "manager" };
}

function internalRequest(job: JobRow): Request {
  const request = (job.metadata?.request as Record<string, unknown> | undefined) ?? {};
  return new Request("https://atlas.internal/background", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...request, force: true, background_job_id: job.id }),
  });
}

/**
 * Phase 6 LEVEL 2 kill-switch — release a claimed graph_attachment_* job
 * back to `queued` without consuming retry budget. Only invoked when the
 * processor returned `{ outcome: "processing_paused" }`, i.e. the direct
 * defence-in-depth path (normal flow skips claim entirely). Explicit
 * `.eq("status","running")` guard prevents clobbering a concurrent state
 * change.
 */
async function releaseClaimToQueued(admin: ReturnType<typeof adminClient>, jobId: string): Promise<void> {
  await admin.from("atlas_jobs").update({
    status: "queued",
    started_at: null,
    claimed_at: null,
    heartbeat_at: null,
    current_step: null,
    progress_percent: 0,
    error_code: null,
    error_message: null,
  }).eq("id", jobId).eq("status", "running");
}

async function claimJob(admin: ReturnType<typeof adminClient>, candidate: JobRow): Promise<JobRow | null> {
  const now = new Date().toISOString();
  const retryCount = candidate.status === "failed" ? (candidate.retry_count ?? 0) + 1 : (candidate.retry_count ?? 0);
  const { data } = await admin
    .from("atlas_jobs")
    .update({
      status: "running",
      started_at: now,
      claimed_at: now,
      heartbeat_at: now,
      current_step: "starting",
      progress_percent: 1,
      retry_count: retryCount,
      attempt_count: ((candidate as JobRow & { attempt_count?: number | null }).attempt_count ?? 0) + 1,
      next_retry_at: null,
      error_code: null,
      error_message: null,
    })
    .eq("id", candidate.id)
    .in("status", ["queued", "failed"])
    .eq("cancellation_requested", false)
    .select("*")
    .maybeSingle();
  return (data as JobRow | null) ?? null;
}

async function createAlertOnce(
  admin: ReturnType<typeof adminClient>,
  env: Env,
  input: Parameters<typeof buildAlert>[0] & { escalationMinutes?: number }
) {
  const relatedJobId = input.relatedJobId ?? null;
  let query = admin
    .from("atlas_operational_alerts")
    .select("id")
    .eq("alert_type", input.alertType)
    .in("status", ["open", "acknowledged"])
    .limit(1);
  query = relatedJobId ? query.eq("related_job_id", relatedJobId) : query.is("related_job_id", null);
  const { data: existing } = await query.maybeSingle();
  if (existing?.id) return;
  await admin.from("atlas_operational_alerts").insert({
    ...buildAlert(input),
    escalation_due_at: new Date(Date.now() + (input.escalationMinutes ?? alertEscalateMinutes(env)) * 60_000).toISOString(),
  });
}

async function scanJob(env: Env, admin: ReturnType<typeof adminClient>, job: JobRow) {
  if (!job.document_id) throw new Error("missing_required_input");
  const metadata = job.metadata ?? {};
  const bucket = String(metadata.bucket ?? CLIENT_DOCS_BUCKET);
  const path = String(metadata.storage_path ?? "");
  const fileName = String(metadata.file_name ?? "upload.pdf");
  const contentType = String(metadata.content_type ?? "application/pdf");
  if (!path) throw new Error("missing_required_input");
  await updateJobProgress(admin, job.id, 25, "scanning_upload");
  const result = await scanStorageObject(env, { bucket, path, fileName, contentType });
  const scannedAt = new Date().toISOString();
  if (result.verdict === "infected") {
    await admin.storage.from(bucket).remove([path]);
    if (bucket === CLIENT_DOCS_BUCKET) {
      await admin.from("atlas_documents").update({ scan_status: "infected", scan_error: result.signature ?? "malware_detected", scanned_at: scannedAt, status: "expired", expired_at: scannedAt }).eq("id", job.document_id);
    } else {
      await admin.from("atlas_insurer_documents").update({ scan_status: "infected", scan_error: result.signature ?? "malware_detected", scanned_at: scannedAt, processing_status: "failed" }).eq("id", job.document_id);
    }
    await createAlertOnce(admin, env, {
      alertType: "malware_detected",
      severity: "critical",
      title: "Malware detected in upload",
      message: "An uploaded document was quarantined and removed.",
      relatedDocumentId: job.document_id,
      relatedSubmissionId: job.submission_id ?? null,
      metadata: { bucket, scanner: result.scanner },
    });
    throw new Error("malware_detected");
  }
  const cleanUpdate = { scan_status: "clean", scan_error: null, scanned_at: scannedAt };
  if (bucket === CLIENT_DOCS_BUCKET) {
    await admin.from("atlas_documents").update(cleanUpdate).eq("id", job.document_id);
  } else {
    await admin.from("atlas_insurer_documents").update(cleanUpdate).eq("id", job.document_id);
  }
  await audit(env, {
    submissionId: job.submission_id ?? null,
    action: "malware_scan_completed",
    actorId: null,
    metadata: { document_id: job.document_id, scanner: result.scanner, bypassed: result.bypassed },
  });
  await completeJob(admin, job.id, { resultReferenceId: job.document_id, metadata: { scanner: result.scanner, bypassed: result.bypassed } });
}

async function processJob(env: Env, job: JobRow): Promise<void> {
  const admin = adminClient(env);
  if (job.job_type === "malware_scan") {
    try {
      await scanJob(env, admin, job);
    } catch (error) {
      const errorCode = (error as Error).message || "malware_scan_failed";
      if (errorCode !== "malware_detected") {
        const bucket = String(job.metadata?.bucket ?? CLIENT_DOCS_BUCKET);
        const table = bucket === CLIENT_DOCS_BUCKET ? "atlas_documents" : "atlas_insurer_documents";
        await admin.from(table).update({
          scan_status: "failed",
          scan_error: errorCode,
          scanned_at: new Date().toISOString(),
        }).eq("id", job.document_id);
      }
      await failJob(admin, job.id, { errorCode, errorMessage: "Upload malware scan failed." });
    }
    return;
  }

  // Phase 5B: attachment discovery + ingest processors. Retry authority is
  // owned by atlas_jobs; failure here NEVER mutates the Phase 5A delta cursor.
  //
  // Phase 6 LEVEL 2 kill-switch: processQueuedJobs already skips claim for
  // these job types when graphJobProcessingEnabled(env) is false. If a direct
  // caller reaches us anyway (e.g. legacy test path), the processor itself
  // will return { outcome: "processing_paused" } and we release the job back
  // to queued WITHOUT consuming retry budget.
  if (job.job_type === "graph_attachment_discovery" || job.job_type === "graph_attachment_ingest") {
    try {
      const result = job.job_type === "graph_attachment_discovery"
        ? await handleGraphAttachmentDiscoveryJob(env, admin, { id: job.id, metadata: job.metadata })
        : await handleGraphAttachmentIngestJob(env, admin, { id: job.id, metadata: job.metadata });
      if (result.outcome === "processing_paused") {
        await releaseClaimToQueued(admin, job.id);
        return;
      }
      await completeJob(admin, job.id, { metadata: null });
    } catch (error) {
      const graphErr = error instanceof GraphError ? error : null;
      const errorCode = graphErr?.code ?? (error as Error)?.message ?? "attachment_processing_failed";
      await failJob(admin, job.id, {
        errorCode,
        errorMessage: `Phase 5B attachment ${job.job_type} failed.`,
        retryAfterSeconds: graphErr?.retryAfterSeconds ?? null,
      });
    }
    return;
  }

  if (!job.submission_id && job.job_type !== "guideline_ingestion") {
    await failJob(admin, job.id, { errorCode: "missing_required_input", errorMessage: "Job has no submission target." });
    return;
  }

  let response: Response;
  const user = systemUser(job);
  const request = internalRequest(job);
  if (job.job_type === "extraction") {
    response = await handleExtract(job.submission_id!, request, env, user);
  } else if (job.job_type === "recommendation") {
    response = await handleRunRecommendation(job.submission_id!, request, env, user);
  } else if (job.job_type === "quote_review") {
    response = await handleRunQuoteReview(job.submission_id!, request, env, user);
  } else if (job.job_type === "guideline_ingestion") {
    response = await handleProcessInsurerDoc(job.document_id!, request, env, user);
  } else {
    await failJob(admin, job.id, { errorCode: "unsupported_job_type", errorMessage: "No background processor is registered for this job type." });
    return;
  }

  const current = await admin.from("atlas_jobs").select("status").eq("id", job.id).maybeSingle();
  if (current.data?.status === "running") {
    await failJob(admin, job.id, {
      errorCode: response.ok ? "worker_did_not_finalize" : `worker_http_${response.status}`,
      errorMessage: "Background worker did not finalize the job record.",
    });
  }
}

async function recoverStuckJobs(env: Env, admin: ReturnType<typeof adminClient>) {
  const cutoff = new Date(Date.now() - stuckMinutes(env) * 60_000).toISOString();
  const { data: stuck } = await admin
    .from("atlas_jobs")
    .select("id, job_type, submission_id, document_id, retry_count, max_retries")
    .eq("status", "running")
    .lt("heartbeat_at", cutoff)
    .limit(50);
  for (const job of (stuck ?? []) as JobRow[]) {
    await admin.from("atlas_jobs").update({
      status: "failed",
      error_code: "stuck_timeout",
      error_message: "Worker heartbeat expired before completion.",
      last_error_code: "stuck_timeout",
      last_error_message: "Worker heartbeat expired before completion.",
      next_retry_at: nextRetryAt({ retryCount: job.retry_count ?? 0, maxRetries: job.max_retries ?? 2, retryable: true }),
      completed_at: new Date().toISOString(),
      current_step: "stuck",
    }).eq("id", job.id).eq("status", "running");
    await createAlertOnce(admin, env, {
      alertType: "job_stuck",
      severity: "critical",
      title: `${job.job_type} job is stuck`,
      message: "The background worker stopped reporting progress. Retry is available.",
      relatedJobId: job.id,
      relatedSubmissionId: job.submission_id ?? null,
      relatedDocumentId: job.document_id ?? null,
      metadata: { retryable: true },
    });
  }
}

async function processQueuedJobs(env: Env) {
  const admin = adminClient(env);
  await recoverStuckJobs(env, admin);
  const now = new Date().toISOString();
  const [queued, retryable] = await Promise.all([
    admin.from("atlas_jobs").select("*").eq("status", "queued").eq("cancellation_requested", false).order("created_at", { ascending: true }).limit(batchSize(env)),
    admin.from("atlas_jobs").select("*").eq("status", "failed").eq("cancellation_requested", false).lte("next_retry_at", now).order("next_retry_at", { ascending: true }).limit(batchSize(env)),
  ]);
  const candidates = [...((queued.data ?? []) as JobRow[]), ...((retryable.data ?? []) as JobRow[])].slice(0, batchSize(env));
  // Phase 6 LEVEL 2 kill-switch — when Graph attachment processing is
  // administratively paused, skip claim for graph_attachment_* candidates
  // entirely. Their queue state stays intact; retry budget is not consumed.
  const graphProcessingOn = graphJobProcessingEnabled(env);
  for (const candidate of candidates) {
    if (!graphProcessingOn && (candidate.job_type === "graph_attachment_discovery" || candidate.job_type === "graph_attachment_ingest")) {
      continue;
    }
    const claimed = await claimJob(admin, candidate);
    if (!claimed) continue;
    try {
      await processJob(env, claimed);
    } catch (error) {
      await failJob(admin, claimed.id, {
        errorCode: (error as Error).message || "worker_exception",
        errorMessage: "Background worker failed unexpectedly.",
      });
    }
  }
}

async function escalateAlerts(env: Env, admin: ReturnType<typeof adminClient>) {
  const now = new Date().toISOString();
  const { data: alerts } = await admin.from("atlas_operational_alerts").select("id, title, message, severity").in("status", ["open", "acknowledged"]).lte("escalation_due_at", now).is("escalated_at", null).limit(50);
  for (const alert of alerts ?? []) {
    await admin.from("atlas_operational_alerts").update({ severity: "critical", escalated_at: now, escalated_to: "manager_queue" }).eq("id", alert.id);
    if (env.ATLAS_ALERT_WEBHOOK_URL) {
      await fetch(env.ATLAS_ALERT_WEBHOOK_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ event: "atlas_alert_escalated", alert_id: alert.id, title: alert.title, message: alert.message }) }).catch(() => undefined);
    }
  }
}

async function monitorSignals(env: Env, admin: ReturnType<typeof adminClient>) {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  // "Low confidence" now requires the confidence to be AVAILABLE.
  //
  // A hybrid run with unavailable rating persists `extraction_confidence = 0`
  // (compatibility numeric) with `extracted_json.overall_confidence_available
  // = false` (provenance). A naive `< 0.5` filter would count that as a
  // low-confidence output — false alerts, and worse, the limit(100) could
  // fill with unavailable rows and hide real ones. The filter below excludes
  // rows whose JSON provenance is explicitly "false", while retaining
  // historical/legacy rows (no flag → available) exactly as before. Applied
  // at the query layer so limit(100) counts only genuine low-confidence rows.
  //
  // Provider-rated 0 (available:true) → still counted as low.
  // Legacy row (no flag) with < 0.5 → still counted as low.
  const notUnavailableExtraction =
    "extracted_json->>overall_confidence_available.is.null,extracted_json->>overall_confidence_available.eq.true";
  const notUnavailableRecommendation =
    "reasoning_json->>overall_confidence_available.is.null,reasoning_json->>overall_confidence_available.eq.true";
  const [extractions, recommendations, reviews, decisions] = await Promise.all([
    admin
      .from("atlas_extractions")
      .select("id, submission_id, extraction_confidence")
      .lt("extraction_confidence", 0.5)
      .or(notUnavailableExtraction)
      .gte("created_at", since)
      .limit(100),
    admin
      .from("atlas_recommendations")
      .select("id, recommended_insurer, confidence_score")
      .lt("confidence_score", 0.5)
      .or(notUnavailableRecommendation)
      .gte("created_at", since)
      .limit(100),
    admin.from("atlas_quote_reviews").select("id, submission_id, overall_confidence, manual_review_required").lt("overall_confidence", 0.5).gte("created_at", since).limit(100),
    admin.from("atlas_decisions").select("id, ai_recommendation_accepted").gte("decided_at", since).limit(500),
  ]);
  const lowConfidence = (extractions.data?.length ?? 0) + (recommendations.data?.length ?? 0) + (reviews.data?.length ?? 0);
  if (lowConfidence > 0) await createAlertOnce(admin, env, { alertType: "low_confidence_output", severity: "warning", title: "Low-confidence underwriting outputs", message: "One or more recent outputs require human scrutiny before reliance.", metadata: { outputs: lowConfidence } });

  const decisionRows = decisions.data ?? [];
  const overrides = decisionRows.filter((row) => row.ai_recommendation_accepted === false).length;
  if (decisionRows.length >= 5 && overrides / decisionRows.length >= 0.4) {
    await createAlertOnce(admin, env, { alertType: "high_override_rate", severity: "warning", title: "High recommendation override rate", message: "Recent human decisions are overriding Atlas unusually often.", metadata: { decisions: decisionRows.length, overrides } });
  }

  const missingEvidence = (reviews.data ?? []).filter((row) => row.manual_review_required === true).length;
  if (missingEvidence > 0) await createAlertOnce(admin, env, { alertType: "missing_evidence", severity: "warning", title: "Quote reviews missing evidence", message: "Recent quote reviews require manual evidence or have an explicit data gap.", metadata: { quote_reviews: missingEvidence } });

  const { data: recentRecommendations } = await admin.from("atlas_recommendations").select("recommended_insurer").gte("created_at", since).not("recommended_insurer", "is", null).limit(500);
  const counts = new Map<string, number>();
  for (const row of recentRecommendations ?? []) counts.set(String(row.recommended_insurer), (counts.get(String(row.recommended_insurer)) ?? 0) + 1);
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  if (top && (recentRecommendations?.length ?? 0) >= 5 && top[1] / (recentRecommendations?.length ?? 1) >= 0.8) {
    await createAlertOnce(admin, env, { alertType: "unusual_insurer_recommendations", severity: "warning", title: "Unusual insurer recommendation concentration", message: "Recent recommendations are concentrated on one insurer and should be reviewed.", metadata: { insurer: top[0], recent_recommendations: recentRecommendations?.length ?? 0, count: top[1] } });
  }
}

async function listStoragePaths(
  admin: ReturnType<typeof adminClient>,
  bucket: string,
  prefix = "",
  depth = 0,
  output: string[] = []
): Promise<string[]> {
  if (depth > 4 || output.length >= 2000) return output;
  const { data } = await admin.storage.from(bucket).list(prefix, { limit: 1000, offset: 0 });
  for (const item of data ?? []) {
    const path = prefix ? `${prefix}/${item.name}` : item.name;
    if (!item.id) await listStoragePaths(admin, bucket, path, depth + 1, output);
    else output.push(path);
    if (output.length >= 2000) break;
  }
  return output;
}

async function candidateExists(
  admin: ReturnType<typeof adminClient>,
  bucket: string,
  path: string
): Promise<boolean> {
  const { data } = await admin
    .from("atlas_cleanup_candidates")
    .select("id")
    .eq("storage_bucket", bucket)
    .eq("storage_path", path)
    .in("status", ["pending", "approved"])
    .limit(1)
    .maybeSingle();
  return Boolean(data?.id);
}

async function detectCleanupCandidates(env: Env, admin: ReturnType<typeof adminClient>) {
  const now = new Date().toISOString();
  const [clientDocs, insurerDocs, clientObjects, insurerObjects] = await Promise.all([
    admin.from("atlas_documents").select("id, submission_id, file_name, storage_path, expires_at, status").eq("status", "active").lt("expires_at", now).limit(500),
    admin.from("atlas_insurer_documents").select("id, insurer_id, file_name, storage_path, processing_status").limit(500),
    listStoragePaths(admin, CLIENT_DOCS_BUCKET),
    listStoragePaths(admin, INSURER_DOCS_BUCKET),
  ]);

  // Any partial DB read here must NOT be interpreted as "no reference" —
  // that would let a genuinely-referenced path be classified as an orphan.
  if (clientDocs.error || insurerDocs.error) {
    console.warn("atlas_cleanup_detection_aborted", { reason: "reference_query_failed" });
    return;
  }

  for (const doc of clientDocs.data ?? []) {
    if (await candidateExists(admin, CLIENT_DOCS_BUCKET, doc.storage_path)) continue;
    await admin.from("atlas_cleanup_candidates").insert({
      candidate_type: "expired_document_row",
      status: "pending",
      storage_bucket: CLIENT_DOCS_BUCKET,
      storage_path: doc.storage_path,
      document_id: doc.id,
      submission_id: doc.submission_id,
      reason: "Client document is past its approved retention expiry.",
      metadata: { file_name: doc.file_name, expires_at: doc.expires_at },
    });
  }

  // Orphan detection now goes through the shared reference-check helper
  // that production deletion uses — so a Phase 5B path in ANY active state
  // (including pending with a persisted storage_path after a retryable
  // upload failure) is protected identically at detection and deletion
  // time. A DB error inside the helper is treated as still-referenced.
  for (const path of clientObjects) {
    const ref = await findActiveStorageReference(admin, CLIENT_DOCS_BUCKET, path);
    if (ref.referenced) continue;
    if (await candidateExists(admin, CLIENT_DOCS_BUCKET, path)) continue;
    await admin.from("atlas_cleanup_candidates").insert({
      candidate_type: "orphan_storage_path",
      status: "pending",
      storage_bucket: CLIENT_DOCS_BUCKET,
      storage_path: path,
      reason: "Storage object has no matching Atlas document row.",
      metadata: { detected_by: "background_cleanup_scan" },
    });
  }

  for (const path of insurerObjects) {
    const ref = await findActiveStorageReference(admin, INSURER_DOCS_BUCKET, path);
    if (ref.referenced) continue;
    if (await candidateExists(admin, INSURER_DOCS_BUCKET, path)) continue;
    await admin.from("atlas_cleanup_candidates").insert({
      candidate_type: "orphan_storage_path",
      status: "pending",
      storage_bucket: INSURER_DOCS_BUCKET,
      storage_path: path,
      reason: "Insurer storage object has no matching Atlas document row.",
      metadata: { detected_by: "background_cleanup_scan" },
    });
  }
}

async function processApprovedCleanup(env: Env, admin: ReturnType<typeof adminClient>) {
  if (env.ATLAS_ENV === "production" && env.ATLAS_CLEANUP_APPROVED !== "true") return;
  const { data: candidates } = await admin
    .from("atlas_cleanup_candidates")
    .select("*")
    .eq("status", "approved")
    .order("approved_at", { ascending: true })
    .limit(50);
  for (const candidate of candidates ?? []) {
    if (!candidate.storage_bucket || !candidate.storage_path) continue;
    if (candidate.document_id && candidate.candidate_type === "expired_document_row") {
      const { data: doc } = await admin.from("atlas_documents").select("status").eq("id", candidate.document_id).maybeSingle();
      if (doc?.status === "active") {
        await admin.from("atlas_cleanup_candidates").update({ status: "dismissed", error_code: "active_document_protected", error_message: "Active documents are never deleted by cleanup." }).eq("id", candidate.id);
        continue;
      }
    }
    // Deletion-time revalidation. A candidate flagged as an orphan may have
    // acquired a legitimate reference between detection and approval —
    // atlas_documents.storage_path OR, for atlas-client-docs, an active
    // Phase 5B atlas_intake_graph_attachments.storage_path (including
    // state='pending' when a hash claim + persisted path is retryable
    // after a partial upload failure). Uses the same helper the detection
    // pass uses so the two decisions cannot diverge. Fails CLOSED if any
    // reference lookup errors: candidate is marked failed with a classified
    // code and a safe operational alert is raised. Raw DB error text NEVER
    // enters the alert.
    if (candidate.candidate_type === "orphan_storage_path") {
      const ref = await findActiveStorageReference(
        admin,
        String(candidate.storage_bucket),
        String(candidate.storage_path),
      );
      if (!ref.ok) {
        await admin.from("atlas_cleanup_candidates").update({
          status: "failed",
          error_code: "cleanup_reference_check_failed",
          error_message: "Reference lookup failed; deletion refused for safety.",
        }).eq("id", candidate.id);
        await createAlertOnce(admin, env, {
          alertType: "cleanup_reference_check_failed",
          severity: "critical",
          title: "Cleanup reference lookup failed",
          message: "A candidate could not be revalidated before deletion; the object was NOT removed.",
          metadata: { candidate_id: candidate.id, reason: ref.reason },
        });
        continue;
      }
      if (ref.referenced) {
        await admin.from("atlas_cleanup_candidates").update({
          status: "dismissed",
          error_code: "storage_path_now_referenced",
          error_message: "Path has an active reference and must not be deleted.",
        }).eq("id", candidate.id);
        continue;
      }
    }
    const { error } = await admin.storage.from(candidate.storage_bucket).remove([candidate.storage_path]);
    if (error) {
      await admin.from("atlas_cleanup_candidates").update({ status: "failed", error_code: "storage_delete_failed", error_message: "Storage deletion failed." }).eq("id", candidate.id);
      await createAlertOnce(admin, env, { alertType: "cleanup_failed", severity: "critical", title: "Approved cleanup failed", message: "An approved storage cleanup could not delete its object.", metadata: { candidate_id: candidate.id } });
      continue;
    }
    await admin.from("atlas_cleanup_candidates").update({ status: "completed", completed_at: new Date().toISOString(), error_code: null, error_message: null }).eq("id", candidate.id);
    if (candidate.document_id && candidate.storage_bucket === CLIENT_DOCS_BUCKET) {
      await admin.from("atlas_documents").update({ status: "expired", expired_at: new Date().toISOString() }).eq("id", candidate.document_id);
    }
  }
}

export async function runBackgroundMaintenance(env: Env): Promise<void> {
  const admin = adminClient(env);
  const stages: [string, Promise<unknown>][] = [
    ["job_processing", processQueuedJobs(env)],
    ["cleanup_detection", detectCleanupCandidates(env, admin)],
    ["approved_cleanup", processApprovedCleanup(env, admin)],
    ["signal_monitoring", monitorSignals(env, admin)],
    ["alert_escalation", escalateAlerts(env, admin)],
  ];
  const results = await Promise.allSettled(stages.map(([, stage]) => stage));
  results.forEach((result, index) => {
    if (result.status === "rejected") {
      console.error("atlas_background_stage_failed", stages[index][0], result.reason);
    }
  });
}
