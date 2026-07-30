/**
 * Atlas Blueprint — Phase 2A frontend API helpers
 * ----------------------------------------------------------------------------
 * Typed wrappers over the new insurer/appetite endpoints. Imports `api` from
 * the existing lib/atlas.ts — no changes to that file's existing exports.
 */

import { api } from "./atlas";
import { putSignedUpload, sha256File } from "./upload";

// ---- Shapes returned by the Worker ----

export interface InsurerListItem {
  id: string;
  name: string;
  quote_channel: string | null;
  active: boolean;
  notes: string | null;
  active_appetite_count: number;
  created_at: string;
}

export interface InsurerDocument {
  id: string;
  file_name: string;
  document_kind: string | null;
  processing_status:
    | "awaiting_processing"
    | "processing"
    | "processed"
    | "failed";
  processed_at: string | null;
  proposed_count: number;
  processing_error: string | null;
  scan_status?: "pending" | "clean" | "infected" | "failed" | "not_scanned";
  created_at: string;
}

export interface AppetiteRow {
  id: string;
  product_line: string;
  risk_type: string;
  appetite_level: "preferred" | "standard" | "caution" | "declined";
  preferred_risks: string[];
  caution_risks: string[];
  declined_risks: string[];
  required_documents: string[];
  referral_triggers: string[];
  notes: string;
  rating_notes: string | null;
  line_of_business: "personal" | "commercial" | "both" | null;
  source_quote: string | null;
  source_page: number | null;
  source_section: string | null;
  source_file_name: string | null;
  ingestion_confidence: number | null;
  source: "ai_extracted" | "manual";
  source_document_id: string | null;
  is_active: boolean;
  confirmed_by: string | null;
  confirmed_at: string | null;
}

// ---- Calls ----

export function listInsurers() {
  return api<{ ok: true; insurers: InsurerListItem[] }>("/api/insurers");
}

export function createInsurer(input: {
  name: string;
  quote_channel?: string;
  notes?: string;
}) {
  return api<{ ok: true; id: string }>("/api/insurers", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function getInsurer(id: string) {
  return api<{
    ok: true;
    insurer: InsurerListItem;
    documents: InsurerDocument[];
    appetite: AppetiteRow[];
  }>(`/api/insurers/${id}`);
}

/** Two-step upload mirroring Phase 1: sign, then PUT the file to storage. */
export async function uploadGuideline(
  insurerId: string,
  file: File,
  documentKind: string
) {
  const fileHash = await sha256File(file);
  const signed = await api<{
    ok: true;
    upload: { url: string; path: string; token: string };
  }>(`/api/insurers/${insurerId}/documents/sign`, {
    method: "POST",
    body: JSON.stringify({
      file_name: file.name,
      content_type: file.type || "application/pdf",
      size_bytes: file.size,
      file_hash: fileHash,
    }),
  });

  await putSignedUpload(signed.upload, file, "application/pdf");

  return api<{ ok: true; document_id: string }>(
    `/api/insurers/${insurerId}/documents/confirm`,
    {
      method: "POST",
      body: JSON.stringify({
        file_name: file.name,
        storage_path: signed.upload.path,
        document_kind: documentKind,
        content_type: file.type || "application/pdf",
        size_bytes: file.size,
        file_hash: fileHash,
      }),
    }
  );
}

/** Run AI ingestion against an uploaded guideline. Sync; ~30–90s typical. */
export function processInsurerDocument(documentId: string, input: { force?: boolean } = {}) {
  return api<{
    ok: true;
    queued?: boolean;
    job_id?: string;
    status?: string;
    skipped?: boolean;
    message?: string;
    insurer_summary: string;
    proposed_count: number;
    document_notes: { note: string }[];
  }>(`/api/insurer-documents/${documentId}/process`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function editAppetite(
  appetiteId: string,
  update: Partial<Omit<AppetiteRow, "id" | "source" | "source_document_id" | "is_active" | "confirmed_by" | "confirmed_at">>
) {
  return api<{ ok: true }>(`/api/appetite/${appetiteId}`, {
    method: "PUT",
    body: JSON.stringify(update),
  });
}

export function confirmAppetite(appetiteId: string) {
  return api<{ ok: true }>(`/api/appetite/${appetiteId}/confirm`, {
    method: "POST",
  });
}

export function deactivateAppetite(appetiteId: string) {
  return api<{ ok: true }>(`/api/appetite/${appetiteId}/deactivate`, {
    method: "POST",
  });
}

// ---- Manual appetite rule creation (added in refine) ----

export function addAppetiteRule(
  insurerId: string,
  rule: {
    product_line: string;
    risk_type: string;
    appetite_level: "preferred" | "standard" | "caution" | "declined";
    preferred_risks?: string[];
    caution_risks?: string[];
    declined_risks?: string[];
    required_documents?: string[];
    referral_triggers?: string[];
    notes?: string;
    rating_notes?: string;
    line_of_business?: "personal" | "commercial" | "both" | null;
    source_quote?: string | null;
    source_page?: number | null;
    source_section?: string | null;
    source_file_name?: string | null;
    ingestion_confidence?: number | null;
  }
) {
  return api<{ ok: true; id: string }>(`/api/insurers/${insurerId}/appetite`, {
    method: "POST",
    body: JSON.stringify(rule),
  });
}

export function updateInsurer(
  insurerId: string,
  update: {
    name?: string;
    quote_channel?: string | null;
    active?: boolean;
    notes?: string | null;
  }
) {
  return api<{ ok: true }>(`/api/insurers/${insurerId}`, {
    method: "PATCH",
    body: JSON.stringify(update),
  });
}
