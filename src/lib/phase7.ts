import { api } from "./atlas";

export type JobStatus = "queued" | "running" | "completed" | "failed" | "cancelled" | "skipped";
export type JobType =
  | "extraction"
  | "guideline_ingestion"
  | "recommendation"
  | "quote_review"
  | "communication_generation"
  | "cleanup"
  | "other";

export interface AtlasJob {
  id: string;
  submission_id: string | null;
  document_id: string | null;
  quote_review_id: string | null;
  insurer_id: string | null;
  job_type: JobType;
  status: JobStatus;
  result_reference_id: string | null;
  error_code: string | null;
  error_message: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  metadata: Record<string, unknown> | null;
}

export interface JobSummary {
  failed_count: number;
  stuck_count: number;
  by_error_code: Record<string, number>;
  recent_failed_jobs: AtlasJob[];
  stuck_jobs: AtlasJob[];
}

export interface SystemStatus {
  environment: string;
  database: { ok: boolean; latency_ms: number };
  storage: {
    client_docs_bucket_configured: boolean;
    insurer_docs_bucket_configured: boolean;
  };
  ai_provider: { anthropic_configured: boolean };
  jobs_24h: {
    failed_count: number;
    stuck_count: number;
    by_error_code: Record<string, number>;
    last_success_by_type: Record<string, string | null>;
  };
}

export function getSystemStatus() {
  return api<{ ok: true; environment: string } & SystemStatus>("/api/admin/system-status");
}

export function listJobs() {
  return api<{ ok: true; jobs: AtlasJob[]; summary: JobSummary }>("/api/admin/jobs");
}

export function cleanupPreview() {
  return api<{
    ok: true;
    mode: "preview_only";
    expired_active_documents: unknown[];
    orphan_storage_note: string;
  }>("/api/admin/cleanup/preview");
}

export function updateAssignment(
  submissionId: string,
  input: {
    assigned_to?: string | null;
    queue_status?: "new" | "in_review" | "waiting_info" | "referred" | "completed" | "archived" | null;
  }
) {
  return api<{ ok: true }>(`/api/submissions/${submissionId}/assignment`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}
