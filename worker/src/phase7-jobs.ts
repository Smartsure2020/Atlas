import type { SupabaseClient } from "@supabase/supabase-js";
import type { Env } from "./config";
import { adminClient, audit, type AtlasUser } from "./auth";
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
  action: "started" | "duplicate_running" | "unchanged_completed";
  jobId?: string;
  previousJobId?: string;
  resultReferenceId?: string | null;
  message?: string;
}

export async function beginJob(
  admin: SupabaseClient,
  input: JobRecordInput,
  opts: { force?: boolean } = {}
): Promise<BeginJobResult> {
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
    .insert(jobRow(input, "running", { started_at: new Date().toISOString() }))
    .select("id")
    .single();

  if (error || !data?.id) {
    return { action: "duplicate_running", message: "Could not create job record." };
  }
  return { action: "started", jobId: String(data.id) };
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
    .select("id, job_type, submission_id, document_id, retry_count, max_retries")
    .eq("id", jobId)
    .maybeSingle();
  const retryCount = typeof current?.retry_count === "number" ? current.retry_count : 0;
  const maxRetries = typeof current?.max_retries === "number" ? current.max_retries : 2;
  const retryable = isRetryableError(params.errorCode);
  await admin
    .from("atlas_jobs")
    .update({
      status: "failed",
      error_code: params.errorCode,
      error_message: params.errorMessage?.slice(0, 240) ?? null,
      last_error_code: params.errorCode,
      last_error_message: params.errorMessage?.slice(0, 240) ?? null,
      next_retry_at: nextRetryAt({ retryCount, maxRetries, retryable }),
      completed_at: new Date().toISOString(),
    })
    .eq("id", jobId);

  await admin.from("atlas_operational_alerts").insert(buildAlert({
    alertType: "job_failed",
    severity: retryable ? "warning" : "critical",
    title: `${String(current?.job_type ?? "job")} failed`,
    message: params.errorCode,
    relatedJobId: jobId,
    relatedSubmissionId: (current?.submission_id as string | null | undefined) ?? null,
    relatedDocumentId: (current?.document_id as string | null | undefined) ?? null,
    metadata: { retryable },
  }));
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
