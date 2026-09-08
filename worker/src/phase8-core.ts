import { inputFingerprint } from "./phase7-core.js";
import type { AtlasRole } from "./config.js";
import { roleCanViewManagerDashboard } from "./phase6-hardening.js";

const NON_RETRYABLE_CODES = new Set([
  "validation_failed",
  "missing_required_input",
  "review_invalid_shape",
  "extraction_invalid_shape",
  "invalid_shape",
  "extraction_not_reviewed",
  "matrix_empty",
  "unchanged_input",
  "permission_denied",
  // Phase 5B — non-retryable Graph / configuration failures. 403 is a
  // persistent scope/permission issue; 404 message/attachment is permanent
  // upstream deletion; a size mismatch means metadata lied and the row is
  // structurally invalid; a changed hash on an owned row means we would be
  // silently rewriting a claim.
  "graph_forbidden",
  "graph_attachment_gone",
  "graph_message_gone_before_attachment_discovery",
  "graph_delta_reset_failed",
  "discovery_missing_intake_id",
  "discovery_intake_missing_graph_ids",
  "ingest_missing_attachment_id",
  "attachment_hash_changed",
  "size_mismatch",
  "graph_config_missing",
  "graph_token_malformed",
]);

const RETRYABLE_CODES = new Set([
  "timeout",
  "upstream_unavailable",
  "temporary_storage_failure",
  "document_unavailable",
  "upload_failed",
  "extraction_failed",
  "recommendation_failed",
  "quote_review_failed",
  "guideline_ingestion_failed",
  "download_failed",
  "ai_call_failed",
  "anthropic_429",
  "anthropic_500",
  "anthropic_502",
  "anthropic_503",
  "anthropic_504",
  "scan_source_unavailable",
  "scanner_unavailable",
  // Phase 5B — retryable Graph / transport / storage / DB paths.
  "graph_throttled",
  "graph_server_error",
  "graph_token_failed",
  "graph_bytes_failed",
  "graph_url_invalid",
  "graph_url_origin_disallowed",
  "graph_url_userinfo_disallowed",
  "graph_unexpected_redirect",
  "graph_attachment_list_malformed",
  "graph_header_fetch_failed",
  "discovery_transport_failed",
  "discovery_commit_failed",
  "discovery_intake_load_failed",
  "storage_upload_failed",
  "sha256_failed",
  "hash_register_failed",
  "mark_uploaded_failed",
  "create_document_failed",
  "graph_unauthorized",
]);

export function isRetryableError(code: string | null | undefined): boolean {
  if (!code) return false;
  if (NON_RETRYABLE_CODES.has(code)) return false;
  if (RETRYABLE_CODES.has(code)) return true;
  return /^anthropic_5\d\d$/.test(code) || /^http_5\d\d$/.test(code) || /^scanner_http_5\d\d$/.test(code);
}

/** Upper clamp on any caller-supplied Retry-After (in seconds). */
export const RETRY_AFTER_MAX_SECONDS = 30 * 60;

export function nextRetryAt(params: {
  retryCount: number;
  nowIso?: string;
  retryable: boolean;
  maxRetries?: number;
  /**
   * Optional upstream Retry-After hint (in seconds). When provided AND the
   * failure is retryable AND retries remain, the returned time honors the
   * hint (clamped to a sensible ceiling) instead of the default step
   * schedule. Phase 5B uses this to propagate Microsoft Graph 429 semantics
   * through the atlas_jobs retry clock.
   */
  retryAfterSeconds?: number | null;
}): string | null {
  if (!params.retryable) return null;
  const max = params.maxRetries ?? 2;
  if (params.retryCount >= max) return null;
  const now = Date.parse(params.nowIso ?? new Date().toISOString());
  if (typeof params.retryAfterSeconds === "number"
      && Number.isFinite(params.retryAfterSeconds)
      && params.retryAfterSeconds > 0) {
    const seconds = Math.min(RETRY_AFTER_MAX_SECONDS, Math.max(1, Math.trunc(params.retryAfterSeconds)));
    return new Date(now + seconds * 1000).toISOString();
  }
  const minutes = params.retryCount <= 0 ? 5 : 30;
  return new Date(now + minutes * 60 * 1000).toISOString();
}

export function canRetryJob(job: {
  status?: unknown;
  retry_count?: unknown;
  max_retries?: unknown;
  last_error_code?: unknown;
  error_code?: unknown;
  cancellation_requested?: unknown;
}): boolean {
  if (job.status === "cancelled" || job.cancellation_requested === true) return false;
  const retryCount = typeof job.retry_count === "number" ? job.retry_count : 0;
  const maxRetries = typeof job.max_retries === "number" ? job.max_retries : 2;
  const code = String(job.last_error_code ?? job.error_code ?? "");
  return job.status === "failed" && retryCount < maxRetries && isRetryableError(code);
}

export function applyManualRetry(job: {
  retry_count?: number | null;
  max_retries?: number | null;
  error_code?: string | null;
  last_error_code?: string | null;
}) {
  const retryCount = job.retry_count ?? 0;
  const maxRetries = job.max_retries ?? 2;
  return {
    status: "queued" as const,
    retry_count: retryCount + 1,
    max_retries: maxRetries,
    next_retry_at: new Date().toISOString(),
    last_error_code: job.last_error_code ?? job.error_code ?? null,
  };
}

export function cancellationUpdate(job: { status?: unknown }, actorId: string) {
  const now = new Date().toISOString();
  if (job.status === "queued" || job.status === "failed" || job.status === "skipped") {
    return {
      status: "cancelled" as const,
      cancellation_requested: true,
      cancellation_requested_at: now,
      cancellation_requested_by: actorId,
      completed_at: now,
      next_retry_at: null,
    };
  }
  return {
    cancellation_requested: true,
    cancellation_requested_at: now,
    cancellation_requested_by: actorId,
    next_retry_at: null,
  };
}

export function buildExtractionFingerprintV2(input: {
  submissionId: string;
  brokerEmailPresent: boolean;
  documents: {
    id: string;
    storage_path?: string | null;
    created_at?: string | null;
    status?: string | null;
    file_hash?: string | null;
  }[];
}) {
  return inputFingerprint({
    type: "extraction_v2",
    submission_id: input.submissionId,
    broker_email_present: input.brokerEmailPresent,
    documents: input.documents
      .map((d) => ({
        id: d.id,
        file_hash: d.file_hash ?? null,
        storage_path: d.file_hash ? null : d.storage_path ?? null,
        created_at: d.file_hash ? null : d.created_at ?? null,
        status: d.status ?? null,
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  });
}

export function activeCleanupCandidates<T extends { status?: string | null }>(docs: T[]): T[] {
  return docs.filter((doc) => doc.status !== "active");
}

export function cleanupRequiresManager(role: AtlasRole): boolean {
  return !roleCanViewManagerDashboard(role);
}

export function buildAlert(input: {
  alertType: string;
  severity?: "info" | "warning" | "critical";
  title: string;
  message: string;
  relatedJobId?: string | null;
  relatedSubmissionId?: string | null;
  relatedDocumentId?: string | null;
  metadata?: Record<string, unknown> | null;
}) {
  return {
    alert_type: input.alertType,
    severity: input.severity ?? "warning",
    status: "open",
    title: input.title,
    message: input.message,
    related_job_id: input.relatedJobId ?? null,
    related_submission_id: input.relatedSubmissionId ?? null,
    related_document_id: input.relatedDocumentId ?? null,
    metadata: input.metadata ?? null,
  };
}

export function transitionAlert(
  current: { status?: string | null },
  action: "acknowledge" | "resolve",
  actorId: string
) {
  const now = new Date().toISOString();
  if (action === "acknowledge") {
    return {
      status: "acknowledged" as const,
      acknowledged_at: now,
      acknowledged_by: actorId,
    };
  }
  return {
    status: "resolved" as const,
    acknowledged_at: current.status === "open" ? now : undefined,
    acknowledged_by: current.status === "open" ? actorId : undefined,
    resolved_at: now,
    resolved_by: actorId,
  };
}

export function canaryIsSafe(body: Record<string, unknown>): boolean {
  const text = JSON.stringify(body).toLowerCase();
  return !text.includes("service_role") &&
    !text.includes("anthropic_api_key") &&
    !text.includes("client_secret") &&
    !text.includes("supabase_service_role_key");
}
