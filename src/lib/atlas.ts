/**
 * Atlas Blueprint — frontend Supabase client + API helper
 * ----------------------------------------------------------------------------
 * The browser holds only the user's Supabase session (anon key + session JWT).
 * It calls OUR Worker API with that token. It never holds the service-role key,
 * never holds the Anthropic key, never talks to Claude, and never computes a
 * recommendation. All of that is server-side by design.
 */

import { createClient } from "@supabase/supabase-js";
import { putSignedUpload, sha256File } from "./upload";

// Vite exposes only VITE_-prefixed vars to the client bundle. The service role
// and Anthropic keys are deliberately NOT here — they live only in the Worker.
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string;
const workerBaseUrl = import.meta.env.VITE_ATLAS_API_URL as string;

export const supabase = createClient(supabaseUrl, supabaseAnonKey);

/** Current session access token, or null if signed out. */
async function accessToken(): Promise<string | null> {
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}

/** The signed-in user's Atlas role, read from the trusted app_metadata claim. */
export async function currentRole(): Promise<"underwriter" | "consultant" | "manager" | "admin" | "readonly" | null> {
  const { data } = await supabase.auth.getUser();
  const role = (data.user?.app_metadata as Record<string, unknown>)?.atlas_role;
  return role === "admin" ||
    role === "manager" ||
    role === "consultant" ||
    role === "readonly" ||
    role === "underwriter"
    ? role
    : null;
}

/** Authenticated call to the Worker API. Attaches the session bearer token. */
export async function api<T = unknown>(
  path: string,
  init: RequestInit = {}
): Promise<T> {
  const token = await accessToken();
  if (!token) throw new Error("not_authenticated");

  const res = await fetch(`${workerBaseUrl}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...(init.headers || {}),
    },
  });

  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw new Error(
      (detail as { message?: string }).message ||
        (detail as { detail?: string; error?: string }).detail ||
        (detail as { error?: string }).error ||
        `http_${res.status}`
    );
  }
  return res.json() as Promise<T>;
}

/** Kick off Microsoft sign-in via the Worker (shared Azure app). */
export function startLogin() {
  window.location.href = `${workerBaseUrl}/auth/login`;
}

// ---- Phase 1 typed API surface ----

export interface SubmissionListItem {
  id: string;
  broker_name: string | null;
  client_name: string | null;
  request_type: string | null;
  status: string;
  assigned_underwriter: string | null;
  assigned_to: string | null;
  assigned_at: string | null;
  assigned_by: string | null;
  queue_status: string | null;
  line_of_business: "personal" | "commercial" | null;
  priority: "low" | "normal" | "high" | "urgent" | null;
  next_action: string | null;
  due_at: string | null;
  updated_at: string;
  pilot_flag: boolean | null;
  assigned_to_email: string | null;
  created_at: string;
  active_job: {
    job_type: string;
    status: string;
    progress_percent: number | null;
    current_step: string | null;
    cancellation_requested: boolean;
  } | null;
}

export function listSubmissions(filters: {
  q?: string;
  status?: string;
  queue_status?: string;
  line_of_business?: "personal" | "commercial";
  priority?: "low" | "normal" | "high" | "urgent";
  sort?: "newest" | "oldest";
  pilot?: boolean;
} = {}) {
  const params = new URLSearchParams();
  Object.entries(filters).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== false && value !== "") {
      params.set(key, String(value));
    }
  });
  const query = params.toString();
  return api<{ ok: true; submissions: SubmissionListItem[] }>(
    `/api/submissions${query ? `?${query}` : ""}`
  );
}

export function createSubmission(input: {
  broker_name?: string;
  broker_email?: string;
  client_name?: string;
  request_type?: string;
  broker_email_body?: string;
  line_of_business?: "personal" | "commercial";
}) {
  return api<{ ok: true; id: string }>("/api/submissions", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/**
 * Extraction record as the submission endpoint returns it. `extraction_confidence`
 * is the numeric compatibility column; `overall_confidence` and its availability
 * flag live inside extracted_json / reviewed_json. Resolve semantics via
 * `resolveExtractionConfidence` in src/lib/extraction-confidence.ts.
 */
export interface ExtractionRecord {
  id: string;
  extracted_json: Record<string, unknown> | null;
  reviewed_json: Record<string, unknown> | null;
  extraction_confidence?: number | null;
  missing_fields_json?: unknown;
  red_flags_json?: unknown;
  reviewed_by?: string | null;
  reviewed_at?: string | null;
  created_at?: string;
}

export interface SubmissionDetailResponse {
  ok: true;
  submission: Record<string, unknown>;
  documents: Record<string, unknown>[];
  extraction: ExtractionRecord | null;
  jobs?: Record<string, unknown>;
}

export function getSubmission(id: string) {
  return api<SubmissionDetailResponse>(
    `/api/submissions/${id}`
  );
}

/** Request a signed upload URL, then PUT the file straight to storage. */
export async function uploadDocument(
  submissionId: string,
  file: File,
  documentType: string
) {
  const fileHash = await sha256File(file);
  const signed = await api<{
    ok: true;
    upload: { url: string; path: string; token: string };
  }>("/api/uploads/sign", {
    method: "POST",
    body: JSON.stringify({
      submission_id: submissionId,
      file_name: file.name,
      content_type: file.type || "application/pdf",
      size_bytes: file.size,
      file_hash: fileHash,
    }),
  });

  // Upload directly to Supabase storage via the signed URL. Confirm the document
  // row only after the bytes land.
  await putSignedUpload(signed.upload, file, "application/octet-stream");

  return api<{
    ok: true;
    document_id: string;
    expires_at: string;
  }>("/api/uploads/confirm", {
    method: "POST",
    body: JSON.stringify({
      submission_id: submissionId,
      file_name: file.name,
      storage_path: signed.upload.path,
      document_type: documentType,
      content_type: file.type || "application/pdf",
      size_bytes: file.size,
      file_hash: fileHash,
    }),
  });
}

/** Manager-only: run extraction across the submission's documents + email. */
export function runExtraction(submissionId: string, input: { force?: boolean } = {}) {
  return api<{ ok: true; extraction_id: string; overall_confidence: number }>(
    `/api/submissions/${submissionId}/extract`,
    { method: "POST", body: JSON.stringify(input) }
  );
}

/** Save the underwriter-corrected summary into reviewed_json. */
export function saveReview(
  submissionId: string,
  extractionId: string,
  reviewedJson: Record<string, unknown>
) {
  return api<{ ok: true }>(`/api/submissions/${submissionId}/review`, {
    method: "POST",
    body: JSON.stringify({
      extraction_id: extractionId,
      reviewed_json: reviewedJson,
    }),
  });
}

// ---- Pilot integration ----

export interface PilotIssue {
  id: string;
  submission_id: string | null;
  title: string;
  description: string | null;
  severity: "low" | "medium" | "high" | "critical";
  status: "open" | "in_progress" | "resolved" | "wont_fix";
  reported_by: string;
  assigned_to: string | null;
  resolved_at: string | null;
  resolved_by: string | null;
  resolution_notes: string | null;
  created_at: string;
  updated_at: string;
}

export function listPilotIssues(submissionId: string) {
  return api<{ ok: true; issues: PilotIssue[] }>(
    `/api/submissions/${submissionId}/pilot-issues`
  );
}

export function createPilotIssue(
  submissionId: string,
  input: { title: string; description?: string; severity?: string; assigned_to?: string }
) {
  return api<{ ok: true; id: string }>(
    `/api/submissions/${submissionId}/pilot-issues`,
    { method: "POST", body: JSON.stringify(input) }
  );
}

export function updatePilotIssue(
  issueId: string,
  input: { status?: string; severity?: string; assigned_to?: string | null; resolution_notes?: string | null }
) {
  return api<{ ok: true }>(`/api/pilot-issues/${issueId}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export function updatePilotFlag(
  submissionId: string,
  input: { pilot_flag: boolean; pilot_notes?: string | null }
) {
  return api<{ ok: true }>(`/api/submissions/${submissionId}/pilot`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}
