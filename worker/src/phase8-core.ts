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
  // A 400 from Graph classifies here so the same malformed request cannot
  // spin the atlas_jobs queue. Retrying an identical request is guaranteed
  // to fail identically — the fix must be a code change.
  "graph_bad_request",
  "graph_attachment_gone",
  "graph_message_gone_before_attachment_discovery",
  "graph_delta_reset_failed",
  "graph_attachment_page_limit",
  "discovery_missing_intake_id",
  "discovery_intake_missing_graph_ids",
  "ingest_missing_attachment_id",
  "attachment_hash_changed",
  "attachment_content_invalid",
  "size_mismatch",
  "graph_config_missing",
  "graph_token_malformed",
  // set_planned_path reason-suffixed classifications. Only 'racing_writer'
  // is retryable (see RETRYABLE below); everything else here is a
  // structural mismatch that should not spin the queue.
  "set_planned_path_storage_path_conflict",
  "set_planned_path_unexpected_state",
  "set_planned_path_storage_path_required",
  "set_planned_path_unknown",
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
  // Phase 5B Checkpoint 4: DB uncertainty must fail closed on the RPC
  // level and retry via atlas_jobs rather than complete the job.
  "attachment_load_failed",
  "attachment_claim_failed",
  "attachment_state_persist_failed",
  "attachment_claim_conflict",
  "set_planned_path_failed",
  "set_planned_path_racing_writer",
]);

export function isRetryableError(code: string | null | undefined): boolean {
  if (!code) return false;
  if (NON_RETRYABLE_CODES.has(code)) return false;
  if (RETRYABLE_CODES.has(code)) return true;
  return /^anthropic_5\d\d$/.test(code) || /^http_5\d\d$/.test(code) || /^scanner_http_5\d\d$/.test(code);
}

/**
 * Retry-After semantics:
 *   * A finite positive value is honored verbatim (rounded up to whole
 *     seconds); next_retry_at is ALWAYS ≥ now + retryAfterSeconds.
 *     Atlas never schedules an earlier retry than the upstream directive.
 *   * A non-finite / non-positive / representationally-unsafe value is
 *     treated as malformed and disables automatic retry (returns null) so
 *     the failure surfaces to operators for manual triage rather than
 *     being silently shortened.
 *
 * The historical upper clamp is removed on Checkpoint 5 §14: shortening a
 * valid Retry-After even from 24h → less would still be an early retry
 * that violates Microsoft Graph's contract.
 */
// Ceiling on the number of milliseconds we can safely add to `Date.now()`
// without overflowing Date's representable range. A retry request that
// would exceed this is refused as malformed.
export const RETRY_AFTER_MAX_SAFE_MS = Number.MAX_SAFE_INTEGER;

export function nextRetryAt(params: {
  retryCount: number;
  nowIso?: string;
  retryable: boolean;
  maxRetries?: number;
  /**
   * Optional upstream Retry-After hint (in seconds). When provided AND the
   * failure is retryable AND retries remain, the returned time is at least
   * `now + retryAfterSeconds`. Microsoft Graph's guidance is to wait at
   * least the number of seconds specified; we honor that directive
   * VERBATIM and never shorten it. A non-finite / non-positive /
   * unsafely-large value returns null (no automatic retry).
   */
  retryAfterSeconds?: number | null;
}): string | null {
  if (!params.retryable) return null;
  const max = params.maxRetries ?? 2;
  if (params.retryCount >= max) return null;
  const now = Date.parse(params.nowIso ?? new Date().toISOString());

  if (params.retryAfterSeconds != null) {
    // Malformed: null-checked above; must be finite, positive, and safely
    // representable as a Date offset. Otherwise refuse automatic retry —
    // never shorten a valid upstream directive.
    if (!Number.isFinite(params.retryAfterSeconds) || params.retryAfterSeconds <= 0) {
      return null;
    }
    const seconds = Math.max(1, Math.ceil(params.retryAfterSeconds));
    const ms = seconds * 1000;
    if (!Number.isFinite(ms) || ms > RETRY_AFTER_MAX_SAFE_MS - now) {
      return null;
    }
    return new Date(now + ms).toISOString();
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
