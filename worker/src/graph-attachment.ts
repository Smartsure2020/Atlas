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
import { isRetryableError } from "./phase8-core.js";

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
    if (err instanceof GraphError) {
      // 404 on the message endpoint means the message is gone BEFORE we
      // discovered its attachments. Reclassify to the Phase 5B-specific
      // non-retryable code so operator logs and retry policy agree. Do NOT
      // conflate with a Phase 5A @removed event — the intake row already
      // exists durably and stays put.
      if (err.status === 404) {
        throw new GraphError({
          status: 404,
          code: "graph_message_gone_before_attachment_discovery",
          message: "graph_message_gone_before_attachment_discovery",
        });
      }
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

/**
 * Cheap deterministic PDF signature check. Bytes must begin with `%PDF-`.
 * A malware-clean scan run is still required afterwards; this is only a
 * defence-in-depth guard against a Graph payload that trivially isn't a PDF.
 */
function looksLikePdf(bytes: ArrayBuffer): boolean {
  if (bytes.byteLength < 5) return false;
  const head = new Uint8Array(bytes, 0, 5);
  return head[0] === 0x25 // '%'
      && head[1] === 0x50 // 'P'
      && head[2] === 0x44 // 'D'
      && head[3] === 0x46 // 'F'
      && head[4] === 0x2d; // '-'
}

async function bytesSha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Deterministic storage path — ID only.
 *
 * Filename is NOT embedded (Checkpoint 4 §12): the attachment's original
 * name lives on atlas_intake_graph_attachments.filename and, once ingested,
 * on atlas_documents.file_name, both behind RLS. An operational locator
 * that ends up in cleanup metadata, logs, and (via the malware pipeline)
 * downstream alerts must not carry it.
 */
function buildStoragePath(row: Pick<AttachmentRowSnapshot, "submission_id" | "id">): string {
  return `${row.submission_id}/graph/${row.id}.pdf`;
}

async function loadAttachmentRow(
  admin: SupabaseClient,
  attachmentId: string,
): Promise<AttachmentRowSnapshot | null> {
  const { data, error } = await admin
    .from("atlas_intake_graph_attachments")
    .select(
      "id, intake_message_id, submission_id, mailbox, graph_message_id, graph_attachment_id, filename, mime_type, size_bytes, state, storage_path, sha256, duplicate_of_attachment_id",
    )
    .eq("id", attachmentId)
    .maybeSingle();
  // Fail closed on DB errors — a query error is uncertainty, NOT proof of
  // absence. Only (data === null AND error === null) means the row is
  // genuinely gone. Anything else must throw a retryable classified error
  // so atlas_jobs retries rather than silently completing the job.
  if (error) {
    throw new GraphError({
      status: 0,
      code: "attachment_load_failed",
      message: "attachment_load_failed",
    });
  }
  return (data as AttachmentRowSnapshot | null) ?? null;
}

async function claimAttachment(
  admin: SupabaseClient,
  attachmentId: string,
  expectedState: string,
): Promise<AttachmentRowSnapshot | null> {
  const { data, error } = await admin.rpc("atlas_intake_attachment_claim", {
    p_id: attachmentId,
    p_expected_state: expectedState,
  });
  if (error) {
    throw new GraphError({
      status: 0,
      code: "attachment_claim_failed",
      message: "attachment_claim_failed",
    });
  }
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
  const { error } = await admin.rpc("atlas_intake_attachment_fail", {
    p_id: attachmentId,
    p_expected_state: expectedState,
    p_next_state: nextState,
    p_error_code: errorCode,
  });
  if (error) {
    // A failed state-transition write is worse than a spurious retry: we do
    // not know what the on-disk attachment state is. Surface a retryable
    // error so atlas_jobs runs the whole ingest again cleanly.
    throw new GraphError({
      status: 0,
      code: "attachment_state_persist_failed",
      message: "attachment_state_persist_failed",
    });
  }
}

/**
 * Decide the next attachment state after a Graph/token failure. Retryable
 * codes return the row to `pending` so a future job attempt picks it up
 * from the top; non-retryable codes go straight to `failed_permanent` so a
 * subsequent retry can never resurrect an inherently doomed row.
 *
 * Uses the shared phase8-core classifier so attachment state and
 * atlas_jobs retryability always agree.
 */
function nextStateFor(code: string): "pending" | "failed_permanent" {
  return isRetryableError(code) ? "pending" : "failed_permanent";
}

/**
 * Persist the deterministic storage_path on the tracking row BEFORE the
 * storage upload is issued, so cleanup detection sees the reference before
 * the object exists.
 */
async function setPlannedStoragePath(
  admin: SupabaseClient,
  attachmentId: string,
  storagePath: string,
): Promise<void> {
  const { data, error } = await admin.rpc("atlas_intake_attachment_set_planned_path", {
    p_id: attachmentId,
    p_expected_state: "downloading",
    p_storage_path: storagePath,
  });
  if (error) {
    throw new GraphError({
      status: 0,
      code: "set_planned_path_failed",
      message: "set_planned_path_failed",
    });
  }
  const row = (Array.isArray(data) ? data[0] : data) as
    | { ok?: boolean; reason?: string }
    | undefined;
  if (!row?.ok) {
    throw new GraphError({
      status: 0,
      code: `set_planned_path_${row?.reason ?? "unknown"}`,
      message: `set_planned_path_${row?.reason ?? "unknown"}`,
    });
  }
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
      // No row returned means the state fence didn't match. Re-read.
      const refreshed = await loadAttachmentRow(admin, attachmentId);
      if (!refreshed) return { outcome: "ingest_missing" };
      row = refreshed;
      // If the row is STILL pending, that's a genuine race (another isolate
      // moved on, or a claim RPC that returned no row despite fence
      // matching). Never report success — surface a retryable conflict so
      // atlas_jobs runs again cleanly.
      if (row.state === "pending") {
        throw new GraphError({
          status: 0,
          code: "attachment_claim_conflict",
          message: "attachment_claim_conflict",
        });
      }
    } else {
      row = claimed;
    }
  }

  const submissionIdHash = await safeHash(row.submission_id);

  if (row.state === "downloading") {
    // Resume the download/hash/upload path. Same-row same-SHA registration
    // is idempotent, so a crash after hash+persist still resolves correctly:
    //   * A retry re-downloads the bytes (we don't cache them in memory
    //     across worker attempts).
    //   * The SHA is recomputed and passed to register_hash — the RPC
    //     returns 'owner' idempotently for a matching same-row same-SHA
    //     replay and fails closed ('attachment_hash_changed') if a
    //     different-SHA claim appears against an already-hashed row.
    //   * The deterministic storage_path is derived from ID only (no
    //     filename); if the row already has one persisted, we reuse it
    //     verbatim.
    let token;
    try {
      token = await acquireGraphToken(env, deps.graph);
    } catch (err) {
      const code = err instanceof GraphError ? err.code : "graph_token_failed";
      logAttachmentError({ code, jobId: job.id, attachmentId, submissionIdHash });
      // Retryability decision uses the SHARED classifier so attachment
      // state and atlas_jobs retryability always agree.
      await failAttachment(admin, row.id, "downloading", nextStateFor(code), code);
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
        attachmentMaxBytes(env),
      );
    } catch (err) {
      // Preserve Graph-level classification but map 404/403 to Phase 5B's
      // specific ingest codes so retryability and logs are unambiguous.
      let code = err instanceof GraphError ? err.code : "graph_bytes_failed";
      if (err instanceof GraphError) {
        if (err.status === 404) code = "graph_attachment_gone";
        else if (err.status === 403) code = "graph_forbidden";
      }
      logAttachmentError({ code, jobId: job.id, attachmentId, submissionIdHash });
      await failAttachment(admin, row.id, "downloading", nextStateFor(code), code);
      if (err instanceof GraphError && (err.status === 404 || err.status === 403)) {
        throw new GraphError({
          status: err.status,
          code,
          message: code,
          retryAfterSeconds: err.retryAfterSeconds,
        });
      }
      throw err;
    }

    const maxBytes = attachmentMaxBytes(env);
    if (bytes.byteLength > maxBytes) {
      logAttachmentError({ code: "size_mismatch", jobId: job.id, attachmentId, submissionIdHash });
      await failAttachment(admin, row.id, "downloading", "failed_permanent", "size_mismatch");
      return { outcome: "ingest_skipped", attachmentState: "failed_permanent" };
    }

    // Optional defence-in-depth (Checkpoint 4 §20): a plausible %PDF- header
    // must appear at byte 0. Existing manual uploads bypass this because the
    // Worker never sees their bytes; Phase 5B does, so it enforces it here.
    if (!looksLikePdf(bytes)) {
      logAttachmentError({ code: "attachment_content_invalid", jobId: job.id, attachmentId, submissionIdHash });
      await failAttachment(admin, row.id, "downloading", "failed_permanent", "attachment_content_invalid");
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

    // Owner path. Reload the row so we can safely reuse a previously
    // persisted storage_path (crash-recovery resume).
    const refreshed = await loadAttachmentRow(admin, attachmentId);
    if (!refreshed) return { outcome: "ingest_missing" };
    row = refreshed;

    const storagePath = row.storage_path ?? buildStoragePath(row);
    // Persist the planned path BEFORE any storage.upload call so cleanup
    // detection cannot classify our newly-uploaded object as an orphan.
    // Idempotent under retry (same path → 'idempotent_noop'); refuses to
    // overwrite a different path.
    if (row.storage_path !== storagePath) {
      await setPlannedStoragePath(admin, row.id, storagePath);
    }

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
    const reread = await loadAttachmentRow(admin, attachmentId);
    if (!reread) return { outcome: "ingest_missing" };
    row = reread;
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

