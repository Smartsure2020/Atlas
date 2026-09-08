/**
 * Atlas Phase 5B — Microsoft Graph attachment ingestion processors.
 * ----------------------------------------------------------------------------
 * Two job processors, both driven by the existing atlas_jobs cron executor:
 *
 *   1. handleGraphAttachmentDiscoveryJob
 *      - Loads the intake message row.
 *      - Lists attachments (metadata only — no bytes).
 *      - Applies deterministic filters.
 *      - Atomically upserts one tracking row per attachment and enqueues one
 *        `graph_attachment_ingest` job per eligible row.
 *      - Never fetches bytes. Never mutates the Phase 5A delta cursor.
 *
 *   2. handleGraphAttachmentIngestJob
 *      - Loads the tracking row and fences pending → downloading.
 *      - Fetches raw bytes via /$value.
 *      - Server-computes SHA-256 and registers hash ownership (deduplicates
 *        within the same submission).
 *      - Puts the object at the deterministic path in atlas-client-docs.
 *      - Calls atlas_intake_attachment_create_document to atomically create
 *        the atlas_documents row + malware_scan job + audit.
 *
 * Retry authority lives on atlas_jobs — this module NEVER schedules its own
 * retries. Attachment state is a recovery checkpoint, not a scheduling clock.
 *
 * PII: filename, mailbox, graph_message_id, graph_attachment_id, subject, and
 * raw sha256 NEVER reach console or alert metadata. Only classified codes and
 * safe hashes/prefixes are logged.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { attachmentMaxBytes, retentionDays, type Env } from "./config.js";
import {
  acquireGraphToken,
  fetchAttachmentBytes,
  GraphError,
  listMessageAttachments,
  type GraphAttachmentMetadata,
  type GraphClientDeps,
} from "./graph-client.js";
import { ATLAS_INTAKE_SYSTEM_ACTOR_ID, safeHash } from "./graph-intake.js";

const CLIENT_DOCS_BUCKET = "atlas-client-docs";

const INLINE_SIGNATURE_MAX_BYTES = 100 * 1024;
const INLINE_IMAGE_MAX_BYTES = 200 * 1024;

// The set of extensions/MIMEs treated as calendar invites (deterministic).
const CALENDAR_MIMES = new Set([
  "text/calendar",
  "application/ics",
]);

export interface AttachmentJobDeps {
  graph?: GraphClientDeps;
  now?: () => number;
}

export interface DiscoveryJobRow {
  id: string;
  metadata?: Record<string, unknown> | null;
}

export interface IngestJobRow {
  id: string;
  metadata?: Record<string, unknown> | null;
}

export interface AttachmentProcessResult {
  outcome:
    | "discovery_complete"
    | "discovery_intake_missing"
    | "discovery_no_attachments"
    | "ingest_complete"
    | "ingest_duplicate"
    | "ingest_skipped"
    | "ingest_unsupported"
    | "ingest_missing";
  ingestJobIds?: string[];
  documentId?: string | null;
  scanJobId?: string | null;
  attachmentState?: string;
}

// ---------------------------------------------------------------------------
// PII-safe logger
// ---------------------------------------------------------------------------

function logAttachmentError(params: {
  code: string;
  jobId?: string;
  attachmentId?: string;
  submissionIdHash?: string;
}): void {
  console.error("atlas_graph_attachment_error", {
    code: params.code,
    job_id: params.jobId ?? null,
    attachment_id: params.attachmentId ?? null,
    submission_id_hash: params.submissionIdHash ?? null,
    ts: new Date().toISOString(),
  });
}

// ---------------------------------------------------------------------------
// Filename sanitiser — reused from Phase 6 pattern; must not accept path
// separators or wildcards. Falls back to a bland default.
// ---------------------------------------------------------------------------

export function safeAttachmentFilename(raw: string | null | undefined): string {
  const cleaned = String(raw ?? "")
    .replace(/\\/g, "/")
    .split("/")
    .pop()
    ?.replace(/[^a-zA-Z0-9._ -]/g, "_")
    .trim()
    .slice(0, 120) || "attachment.pdf";
  return cleaned;
}

// ---------------------------------------------------------------------------
// Filter decision (metadata only). Returns the initial attachment-row state
// and a skip_reason when applicable. NEVER downloads bytes.
// ---------------------------------------------------------------------------

export interface AttachmentFilterDecision {
  initial_state: "pending" | "skipped" | "unsupported";
  skip_reason: string | null;
}

export function classifyAttachment(
  meta: GraphAttachmentMetadata,
  maxBytes: number,
): AttachmentFilterDecision {
  // Type-level gating first.
  if (meta.attachmentType === "itemAttachment") {
    return { initial_state: "unsupported", skip_reason: "item_attachment" };
  }
  if (meta.attachmentType === "referenceAttachment") {
    return { initial_state: "unsupported", skip_reason: "reference_attachment" };
  }
  if (meta.attachmentType === "unknown") {
    return { initial_state: "unsupported", skip_reason: "unknown_attachment_type" };
  }
  // fileAttachment past this point.

  // Inline signature / logo images.
  const size = typeof meta.size === "number" ? meta.size : null;
  const mime = (meta.contentType ?? "").toLowerCase();
  if (meta.isInline && meta.contentId && size != null && size < INLINE_SIGNATURE_MAX_BYTES) {
    return { initial_state: "skipped", skip_reason: "inline_signature" };
  }
  if (meta.isInline && mime.startsWith("image/") && size != null && size < INLINE_IMAGE_MAX_BYTES) {
    return { initial_state: "skipped", skip_reason: "inline_image" };
  }

  // Calendar invites.
  if (CALENDAR_MIMES.has(mime)) {
    return { initial_state: "skipped", skip_reason: "calendar_invite" };
  }

  // Oversize — decided from metadata alone, before any /$value GET.
  if (size != null && size > maxBytes) {
    return { initial_state: "skipped", skip_reason: "oversize" };
  }

  // MIME whitelist. First release: application/pdf only.
  if (mime !== "application/pdf") {
    return { initial_state: "skipped", skip_reason: "unsupported_mime" };
  }

  return { initial_state: "pending", skip_reason: null };
}

// ---------------------------------------------------------------------------
// Discovery processor
// ---------------------------------------------------------------------------

export async function handleGraphAttachmentDiscoveryJob(
  env: Env,
  admin: SupabaseClient,
  job: DiscoveryJobRow,
  deps: AttachmentJobDeps = {},
): Promise<AttachmentProcessResult> {
  const intakeMessageId = String((job.metadata ?? {}).intake_message_id ?? "");
  if (!intakeMessageId) {
    logAttachmentError({ code: "discovery_missing_intake_id", jobId: job.id });
    throw new GraphError({
      status: 0,
      code: "discovery_missing_intake_id",
      message: "discovery_missing_intake_id",
    });
  }

  const { data: intake, error: intakeErr } = await admin
    .from("atlas_submission_intake_messages")
    .select("id, submission_id, mailbox, graph_message_id, has_attachments")
    .eq("id", intakeMessageId)
    .maybeSingle();
  if (intakeErr) {
    throw new GraphError({
      status: 0,
      code: "discovery_intake_load_failed",
      message: "discovery_intake_load_failed",
    });
  }
  if (!intake) {
    return { outcome: "discovery_intake_missing" };
  }
  if (!intake.has_attachments) {
    return { outcome: "discovery_no_attachments" };
  }

  const mailbox = String(intake.mailbox ?? "");
  const graphMessageId = String(intake.graph_message_id ?? "");
  if (!mailbox || !graphMessageId) {
    // Structural inconsistency (intake row was created without the Graph
    // identifiers it must carry). Non-retryable.
    throw new GraphError({
      status: 0,
      code: "discovery_intake_missing_graph_ids",
      message: "discovery_intake_missing_graph_ids",
    });
  }

  const token = await acquireGraphToken(env, deps.graph);

  let metadata: GraphAttachmentMetadata[];
  try {
    metadata = await listMessageAttachments(mailbox, graphMessageId, token, deps.graph);
  } catch (err) {
    // GraphError is already classified. Rethrow so the outer executor can
    // decide retryability (respecting Retry-After for 429s via failJob's
    // extended plumbing).
    if (err instanceof GraphError) {
      // 404 on the message endpoint is not a retryable 404: the message is
      // gone before we got to discover its attachments. Do not confuse this
      // with a Phase 5A @removed event.
      throw err;
    }
    throw new GraphError({
      status: 0,
      code: "discovery_transport_failed",
      message: "discovery_transport_failed",
    });
  }

  if (metadata.length === 0) {
    // has_attachments=true with an empty list is a Graph inconsistency;
    // record nothing and complete the job.
    return { outcome: "discovery_no_attachments" };
  }

  const maxBytes = attachmentMaxBytes(env);
  const stubs = metadata.map((meta) => {
    const decision = classifyAttachment(meta, maxBytes);
    return {
      graph_attachment_id: meta.id,
      attachment_type: meta.attachmentType,
      filename: safeAttachmentFilename(meta.name),
      mime_type: meta.contentType ?? null,
      size_bytes: meta.size ?? null,
      is_inline: meta.isInline,
      content_id: meta.contentId,
      initial_state: decision.initial_state,
      skip_reason: decision.skip_reason,
    };
  });

  const { data: commit, error: commitErr } = await admin.rpc(
    "atlas_intake_attachment_discover_commit",
    {
      p_intake_message_id: intakeMessageId,
      p_system_actor_id: ATLAS_INTAKE_SYSTEM_ACTOR_ID,
      p_mailbox: mailbox,
      p_graph_message_id: graphMessageId,
      p_stubs: stubs,
    },
  );
  if (commitErr) {
    throw new GraphError({
      status: 0,
      code: "discovery_commit_failed",
      message: "discovery_commit_failed",
    });
  }

  const rows = (Array.isArray(commit) ? commit : []) as Array<{ ingest_job_id?: string | null }>;
  const ingestJobIds = rows
    .map((r) => r.ingest_job_id)
    .filter((v): v is string => typeof v === "string" && v.length > 0);

  return { outcome: "discovery_complete", ingestJobIds };
}

// ---------------------------------------------------------------------------
// Ingest processor
// ---------------------------------------------------------------------------

interface AttachmentRowSnapshot {
  id: string;
  intake_message_id: string;
  submission_id: string;
  mailbox: string;
  graph_message_id: string;
  graph_attachment_id: string;
  filename: string | null;
  mime_type: string | null;
  size_bytes: number | null;
  state: string;
  storage_path: string | null;
  sha256: string | null;
  duplicate_of_attachment_id: string | null;
}

async function bytesSha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function buildStoragePath(row: AttachmentRowSnapshot): string {
  const safe = safeAttachmentFilename(row.filename);
  return `${row.submission_id}/graph/${row.id}-${safe}`;
}

async function loadAttachmentRow(
  admin: SupabaseClient,
  attachmentId: string,
): Promise<AttachmentRowSnapshot | null> {
  const { data } = await admin
    .from("atlas_intake_graph_attachments")
    .select(
      "id, intake_message_id, submission_id, mailbox, graph_message_id, graph_attachment_id, filename, mime_type, size_bytes, state, storage_path, sha256, duplicate_of_attachment_id",
    )
    .eq("id", attachmentId)
    .maybeSingle();
  return (data as AttachmentRowSnapshot | null) ?? null;
}

async function claimAttachment(
  admin: SupabaseClient,
  attachmentId: string,
  expectedState: string,
): Promise<AttachmentRowSnapshot | null> {
  const { data } = await admin.rpc("atlas_intake_attachment_claim", {
    p_id: attachmentId,
    p_expected_state: expectedState,
  });
  const row = (Array.isArray(data) ? data[0] : data) as AttachmentRowSnapshot | undefined;
  return row ?? null;
}

async function failAttachment(
  admin: SupabaseClient,
  attachmentId: string,
  expectedState: string,
  nextState: "pending" | "downloading" | "failed_permanent",
  errorCode: string,
): Promise<void> {
  await admin.rpc("atlas_intake_attachment_fail", {
    p_id: attachmentId,
    p_expected_state: expectedState,
    p_next_state: nextState,
    p_error_code: errorCode,
  });
}

export async function handleGraphAttachmentIngestJob(
  env: Env,
  admin: SupabaseClient,
  job: IngestJobRow,
  deps: AttachmentJobDeps = {},
): Promise<AttachmentProcessResult> {
  const attachmentId = String((job.metadata ?? {}).attachment_id ?? "");
  if (!attachmentId) {
    throw new GraphError({
      status: 0,
      code: "ingest_missing_attachment_id",
      message: "ingest_missing_attachment_id",
    });
  }

  let row = await loadAttachmentRow(admin, attachmentId);
  if (!row) return { outcome: "ingest_missing" };

  // Idempotent replay: previously completed.
  if (row.state === "ingested") {
    return {
      outcome: "ingest_complete",
      attachmentState: row.state,
    };
  }
  if (row.state === "skipped" || row.state === "unsupported") {
    return {
      outcome: row.state === "skipped" ? "ingest_skipped" : "ingest_unsupported",
      attachmentState: row.state,
    };
  }
  if (row.state === "failed_permanent") {
    return { outcome: "ingest_skipped", attachmentState: row.state };
  }

  // Resume from any of the valid checkpoints. If the row is at `uploaded`
  // we skip Graph + storage and go straight to create_document.
  if (row.state === "pending") {
    const claimed = await claimAttachment(admin, attachmentId, "pending");
    if (!claimed) {
      // Another isolate claimed it, or the row moved on. Re-read and reflect.
      row = await loadAttachmentRow(admin, attachmentId);
      if (!row) return { outcome: "ingest_missing" };
    } else {
      row = claimed;
    }
  }

  const submissionIdHash = await safeHash(row.submission_id);

  if (row.state === "downloading" && (!row.sha256 || !row.storage_path)) {
    // Fresh (or resumed pre-upload) path: download → hash → register →
    // upload → mark_uploaded.
    let token;
    try {
      token = await acquireGraphToken(env, deps.graph);
    } catch (err) {
      const code = err instanceof GraphError ? err.code : "graph_token_failed";
      logAttachmentError({ code, jobId: job.id, attachmentId, submissionIdHash });
      await failAttachment(admin, row.id, "downloading", "pending", code);
      throw err;
    }

    let bytes: ArrayBuffer;
    try {
      bytes = await fetchAttachmentBytes(
        row.mailbox,
        row.graph_message_id,
        row.graph_attachment_id,
        token,
        deps.graph,
      );
    } catch (err) {
      const code = err instanceof GraphError ? err.code : "graph_bytes_failed";
      logAttachmentError({ code, jobId: job.id, attachmentId, submissionIdHash });
      const permanent = err instanceof GraphError && (err.status === 404 || err.status === 403);
      await failAttachment(admin, row.id, "downloading",
        permanent ? "failed_permanent" : "pending",
        permanent ? (err.status === 404 ? "graph_attachment_gone" : "graph_forbidden") : code,
      );
      throw err;
    }

    const maxBytes = attachmentMaxBytes(env);
    if (bytes.byteLength > maxBytes) {
      logAttachmentError({ code: "size_mismatch", jobId: job.id, attachmentId, submissionIdHash });
      await failAttachment(admin, row.id, "downloading", "failed_permanent", "size_mismatch");
      return { outcome: "ingest_skipped", attachmentState: "failed_permanent" };
    }

    let sha256Hex: string;
    try {
      sha256Hex = await bytesSha256Hex(bytes);
    } catch {
      await failAttachment(admin, row.id, "downloading", "pending", "sha256_failed");
      throw new GraphError({
        status: 0,
        code: "sha256_failed",
        message: "sha256_failed",
      });
    }

    const { data: hashData, error: hashErr } = await admin.rpc(
      "atlas_intake_attachment_register_hash",
      {
        p_id: row.id,
        p_expected_state: "downloading",
        p_sha256: sha256Hex,
        p_size_bytes: bytes.byteLength,
      },
    );
    if (hashErr) {
      // Fail-closed classification: 'attachment_hash_changed' comes back as
      // an RPC exception message. Any Postgres error here is treated as
      // non-retryable to prevent looping.
      const code = String((hashErr as { message?: string }).message ?? "hash_register_failed");
      const changed = code.includes("attachment_hash_changed");
      logAttachmentError({
        code: changed ? "attachment_hash_changed" : "hash_register_failed",
        jobId: job.id,
        attachmentId,
        submissionIdHash,
      });
      await failAttachment(
        admin,
        row.id,
        "downloading",
        changed ? "failed_permanent" : "pending",
        changed ? "attachment_hash_changed" : "hash_register_failed",
      );
      throw new GraphError({
        status: 0,
        code: changed ? "attachment_hash_changed" : "hash_register_failed",
        message: changed ? "attachment_hash_changed" : "hash_register_failed",
      });
    }
    const hashRow = (Array.isArray(hashData) ? hashData[0] : hashData) as
      | { outcome?: string; owner_id?: string; document_id?: string | null }
      | undefined;
    if (hashRow?.outcome === "duplicate") {
      // Row was flipped to skipped(duplicate_hash) inside the RPC. No bytes
      // are uploaded, no document is created. Job completes successfully.
      return {
        outcome: "ingest_duplicate",
        documentId: hashRow.document_id ?? null,
        attachmentState: "skipped",
      };
    }

    // Owner path: upload bytes to the deterministic path, then mark_uploaded.
    // Refresh the row so we have the freshly-persisted sha256 for path derivation.
    row = await loadAttachmentRow(admin, attachmentId);
    if (!row) return { outcome: "ingest_missing" };

    const storagePath = buildStoragePath(row);
    const { error: uploadErr } = await admin.storage
      .from(CLIENT_DOCS_BUCKET)
      .upload(storagePath, bytes, {
        // Deterministic path is uniquely owned by this attachment row, so
        // upsert:true only re-writes THIS row's own bytes on retry. Never
        // used for arbitrary caller-controlled paths.
        upsert: true,
        contentType: "application/pdf",
      });
    if (uploadErr) {
      logAttachmentError({
        code: "storage_upload_failed",
        jobId: job.id,
        attachmentId,
        submissionIdHash,
      });
      await failAttachment(admin, row.id, "downloading", "pending", "storage_upload_failed");
      throw new GraphError({
        status: 0,
        code: "storage_upload_failed",
        message: "storage_upload_failed",
      });
    }

    const { data: markData, error: markErr } = await admin.rpc(
      "atlas_intake_attachment_mark_uploaded",
      {
        p_id: row.id,
        p_expected_state: "downloading",
        p_storage_path: storagePath,
      },
    );
    if (markErr) {
      throw new GraphError({
        status: 0,
        code: "mark_uploaded_failed",
        message: "mark_uploaded_failed",
      });
    }
    const markRow = (Array.isArray(markData) ? markData[0] : markData) as
      | { ok?: boolean; reason?: string }
      | undefined;
    if (!markRow?.ok) {
      throw new GraphError({
        status: 0,
        code: `mark_uploaded_${markRow?.reason ?? "unknown"}`,
        message: `mark_uploaded_${markRow?.reason ?? "unknown"}`,
      });
    }
    row = await loadAttachmentRow(admin, attachmentId);
    if (!row) return { outcome: "ingest_missing" };
  }

  // At this point row.state must be 'uploaded' — either fresh, resumed from
  // a crash after upload, or (rare) the row was already uploaded before the
  // ingest job was claimed.
  if (row.state !== "uploaded") {
    // Duplicate rows land in 'skipped' before ever reaching here; other
    // states indicate the row moved on concurrently.
    return { outcome: "ingest_skipped", attachmentState: row.state };
  }

  const { data: docData, error: docErr } = await admin.rpc(
    "atlas_intake_attachment_create_document",
    {
      p_id: row.id,
      p_system_actor_id: ATLAS_INTAKE_SYSTEM_ACTOR_ID,
      p_retention_days: retentionDays(env),
    },
  );
  if (docErr) {
    throw new GraphError({
      status: 0,
      code: "create_document_failed",
      message: "create_document_failed",
    });
  }
  const docRow = (Array.isArray(docData) ? docData[0] : docData) as
    | { outcome?: string; document_id?: string; scan_job_id?: string }
    | undefined;
  return {
    outcome: "ingest_complete",
    documentId: docRow?.document_id ?? null,
    scanJobId: docRow?.scan_job_id ?? null,
    attachmentState: "ingested",
  };
}

