import type { SupabaseClient } from "@supabase/supabase-js";
import type { Env } from "./config";
import { adminClient, audit, json, type AtlasUser } from "./auth";
import {
  buildExtractionFingerprint,
  buildGuidelineFingerprint,
  buildQuoteReviewFingerprint,
  buildRecommendationFingerprint,
  classifyJobAttempt,
  inputFingerprint,
  summarizeJobs,
} from "./phase7-core";
import { buildAlert, isRetryableError, nextRetryAt } from "./phase8-core";

export {
  buildExtractionFingerprint,
  buildGuidelineFingerprint,
  buildQuoteReviewFingerprint,
  buildRecommendationFingerprint,
  classifyJobAttempt,
  inputFingerprint,
  summarizeJobs,
};

export type AtlasJobType =
  | "extraction"
  | "guideline_ingestion"
  | "malware_scan"
  | "recommendation"
  | "quote_review"
  | "communication_generation"
  | "cleanup"
  | "other";

export type AtlasJobStatus = "queued" | "running" | "completed" | "failed" | "cancelled" | "skipped";

export interface JobRecordInput {
  submissionId?: string | null;
  documentId?: string | null;
  quoteReviewId?: string | null;
  insurerId?: string | null;
  jobType: AtlasJobType;
  inputFingerprint?: string | null;
  createdBy?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface BeginJobResult {
  action: "queued" | "started" | "duplicate_running" | "unchanged_completed" | "cancelled";
  jobId?: string;
  previousJobId?: string;
  resultReferenceId?: string | null;
  message?: string;
}

export async function beginJob(
  admin: SupabaseClient,
  input: JobRecordInput,
  opts: { force?: boolean; existingJobId?: string } = {}
): Promise<BeginJobResult> {
  if (opts.existingJobId) {
    const { data: existing } = await admin
      .from("atlas_jobs")
      .select("id, status, cancellation_requested")
      .eq("id", opts.existingJobId)
      .maybeSingle();
    if (!existing) return { action: "duplicate_running", message: "Background job was not found." };
    if (existing.status === "cancelled" || existing.cancellation_requested === true) {
      return { action: "cancelled", jobId: String(existing.id), message: "Background job was cancelled." };
    }
    await admin
      .from("atlas_jobs")
      .update({
        status: "running",
        started_at: new Date().toISOString(),
        claimed_at: new Date().toISOString(),
        heartbeat_at: new Date().toISOString(),
        current_step: "starting",
        progress_percent: 1,
      })
      .eq("id", opts.existingJobId)
      .in("status", ["queued", "failed", "running"]);
    return { action: "started", jobId: opts.existingJobId };
  }
  if (!opts.force && input.inputFingerprint) {
    const { data: running } = await admin
      .from("atlas_jobs")
      .select("id, status")
      .eq("job_type", input.jobType)
      .eq("input_fingerprint", input.inputFingerprint)
      .in("status", ["queued", "running"])
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (running?.id) {
      return {
        action: "duplicate_running",
        previousJobId: String(running.id),
        message: "This job is already running for unchanged inputs.",
      };
    }

    const { data: completed } = await admin
      .from("atlas_jobs")
      .select("id, result_reference_id")
      .eq("job_type", input.jobType)
      .eq("input_fingerprint", input.inputFingerprint)
      .eq("status", "completed")
      .order("completed_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (completed?.id) {
      const { data: skipped } = await admin
        .from("atlas_jobs")
        .insert(jobRow(input, "skipped", {
          completed_at: new Date().toISOString(),
          result_reference_id: completed.result_reference_id ?? null,
          error_code: "unchanged_input",
          error_message: "Inputs appear unchanged since the last run.",
        }))
        .select("id")
        .single();
      return {
        action: "unchanged_completed",
        jobId: skipped?.id ? String(skipped.id) : undefined,
        previousJobId: String(completed.id),
        resultReferenceId: completed.result_reference_id ?? null,
        message: "Inputs appear unchanged since the last run.",
      };
    }
  }

  const { data, error } = await admin
    .from("atlas_jobs")
    .insert(jobRow(input, "queued"))
    .select("id")
    .single();

  if (error || !data?.id) {
    return { action: "duplicate_running", message: "Could not create job record." };
  }
  return { action: "queued", jobId: String(data.id) };
}

function jobRow(input: JobRecordInput, status: AtlasJobStatus, extra: Record<string, unknown> = {}) {
  return {
    submission_id: input.submissionId ?? null,
    document_id: input.documentId ?? null,
    quote_review_id: input.quoteReviewId ?? null,
    insurer_id: input.insurerId ?? null,
    job_type: input.jobType,
    status,
    input_fingerprint: input.inputFingerprint ?? null,
    created_by: input.createdBy ?? null,
    metadata: input.metadata ?? null,
    ...extra,
  };
}

export async function completeJob(
  admin: SupabaseClient,
  jobId: string | undefined,
  params: { resultReferenceId?: string | null; quoteReviewId?: string | null; metadata?: Record<string, unknown> | null } = {}
) {
  if (!jobId) return;
  await admin
    .from("atlas_jobs")
    .update({
      status: "completed",
      progress_percent: 100,
      current_step: "completed",
      heartbeat_at: new Date().toISOString(),
      result_reference_id: params.resultReferenceId ?? null,
      quote_review_id: params.quoteReviewId ?? null,
      completed_at: new Date().toISOString(),
      metadata: params.metadata ?? null,
      error_code: null,
      error_message: null,
    })
    .eq("id", jobId);
}

export async function failJob(
  admin: SupabaseClient,
  jobId: string | undefined,
  params: { errorCode: string; errorMessage?: string | null }
) {
  if (!jobId) return;
  const { data: current } = await admin
    .from("atlas_jobs")
    .select("id, job_type, submission_id, document_id, retry_count, max_retries, cancellation_requested, status")
    .eq("id", jobId)
    .maybeSingle();
  const retryCount = typeof current?.retry_count === "number" ? current.retry_count : 0;
  const maxRetries = typeof current?.max_retries === "number" ? current.max_retries : 2;
  const retryable = isRetryableError(params.errorCode);
  const cancelled = current?.cancellation_requested === true || current?.status === "cancelled";
  await admin
    .from("atlas_jobs")
    .update({
      status: cancelled ? "cancelled" : "failed",
      current_step: cancelled ? "cancelled" : "failed",
      error_code: params.errorCode,
      error_message: params.errorMessage?.slice(0, 240) ?? null,
      last_error_code: params.errorCode,
      last_error_message: params.errorMessage?.slice(0, 240) ?? null,
      next_retry_at: nextRetryAt({ retryCount, maxRetries, retryable }),
      completed_at: new Date().toISOString(),
      heartbeat_at: new Date().toISOString(),
    })
    .eq("id", jobId);

  if (cancelled) return;

  await admin.from("atlas_operational_alerts").insert({
    ...buildAlert({
      alertType: "job_failed",
      severity: retryable ? "warning" : "critical",
      title: `${String(current?.job_type ?? "job")} failed`,
      message: params.errorCode,
      relatedJobId: jobId,
      relatedSubmissionId: (current?.submission_id as string | null | undefined) ?? null,
      relatedDocumentId: (current?.document_id as string | null | undefined) ?? null,
      metadata: { retryable },
    }),
    escalation_due_at: new Date(Date.now() + 30 * 60_000).toISOString(),
  });
}

export async function updateJobProgress(
  admin: SupabaseClient,
  jobId: string | undefined,
  progressPercent: number,
  currentStep: string
) {
  if (!jobId) return;
  await admin
    .from("atlas_jobs")
    .update({
      progress_percent: Math.max(0, Math.min(99, Math.trunc(progressPercent))),
      current_step: currentStep,
      heartbeat_at: new Date().toISOString(),
    })
    .eq("id", jobId)
    .eq("status", "running");
}

export async function isJobCancellationRequested(
  admin: SupabaseClient,
  jobId: string | undefined
): Promise<boolean> {
  if (!jobId) return false;
  const { data } = await admin
    .from("atlas_jobs")
    .select("status, cancellation_requested")
    .eq("id", jobId)
    .maybeSingle();
  return data?.status === "cancelled" || data?.cancellation_requested === true;
}

export function queuedJobResponse(job: BeginJobResult, jobType: AtlasJobType) {
  return json({
    ok: true,
    queued: true,
    job_id: job.jobId,
    job_type: jobType,
    status: "queued",
    message: "Work has been queued and will continue in the background.",
  }, 202);
}

export async function getLatestJob(
  env: Env,
  params: { submissionId?: string | null; documentId?: string | null; jobType: AtlasJobType }
) {
  const admin = adminClient(env);
  let query = admin
    .from("atlas_jobs")
    .select("*")
    .eq("job_type", params.jobType)
    .order("created_at", { ascending: false })
    .limit(1);
  if (params.submissionId) query = query.eq("submission_id", params.submissionId);
  if (params.documentId) query = query.eq("document_id", params.documentId);
  const { data } = await query.maybeSingle();
  return data ?? null;
}

export async function auditAssignmentChange(env: Env, params: {
  submissionId: string;
  actor: AtlasUser;
  assignedTo: string | null;
  queueStatus: string | null;
}) {
  await audit(env, {
    submissionId: params.submissionId,
    action: "submission_assignment_changed",
    actorId: params.actor.id,
    metadata: {
      assigned_to: params.assignedTo,
      queue_status: params.queueStatus,
    },
  });
}
