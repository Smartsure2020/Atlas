/**
 * Atlas Blueprint — Phase 2A endpoint handlers
 * ----------------------------------------------------------------------------
 * The appetite-ingestion side of Phase 2: insurers, guideline documents, the
 * AI ingestion step, and confirming/editing the proposed rules into the live
 * matrix.
 *
 * Everything here is MANAGER (admin) ONLY — server-side enforced. This is the
 * data that drives every future recommendation; an underwriter shouldn't be
 * able to quietly change what Atlas recommends for everyone else.
 *
 * Every state change to an appetite row writes a snapshot into
 * atlas_appetite_history so a recommendation made months ago can be defended
 * against the rules as they were on that date.
 */

import { adminClient, audit, json, type AtlasUser } from "./auth";
import {
  APPETITE_MODEL,
  APPETITE_SYSTEM_PROMPT,
  validateIngestion,
} from "./appetite-ingestion";
import type { Env } from "./config";
import { roleCanManageAppetite, validateUploadInput, MAX_GUIDELINE_UPLOAD_BYTES } from "./phase6-hardening";
import {
  beginJob,
  buildGuidelineFingerprint,
  completeJob,
  failJob,
} from "./phase7-jobs";

const INSURER_DOCS_BUCKET = "atlas-insurer-docs";
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

/** Worker doesn't have Buffer; encode an ArrayBuffer as base64 by hand. */
function toBase64(buf: ArrayBuffer): string {
  let binary = "";
  const bytes = new Uint8Array(buf);
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** Shared 403 helper. Phase 2A is admin-only across the board. */
function requireAdmin(user: AtlasUser): Response | null {
  if (!roleCanManageAppetite(user.role)) {
    return json({ error: "forbidden", detail: "manager_only" }, 403);
  }
  return null;
}

/** Snapshot an appetite row into history. Called on every meaningful change. */
async function snapshotAppetite(
  env: Env,
  appetiteId: string,
  changeType: "created" | "updated" | "confirmed" | "deactivated",
  changedBy: string
) {
  const admin = adminClient(env);
  const { data: row } = await admin
    .from("atlas_insurer_appetite")
    .select("*")
    .eq("id", appetiteId)
    .single();
  if (!row) return;
  await admin.from("atlas_appetite_history").insert({
    appetite_id: appetiteId,
    change_type: changeType,
    snapshot_json: row,
    changed_by: changedBy,
  });
}

// ----------------------------------------------------------------------------
// GET /api/insurers — list with counts; for the Insurers index page.
// Any staff can see the list; underwriters benefit from knowing who's available.
// ----------------------------------------------------------------------------
export async function handleListInsurers(
  env: Env,
  _user: AtlasUser
): Promise<Response> {
  const admin = adminClient(env);
  const { data, error } = await admin
    .from("atlas_insurers")
    .select("id, name, quote_channel, active, notes, created_at")
    .order("name", { ascending: true });
  if (error) return json({ error: "list_failed" }, 500);

  // Counts of active appetite rules per insurer, in one extra query.
  const counts = new Map<string, number>();
  const { data: rows } = await admin
    .from("atlas_insurer_appetite")
    .select("insurer_id")
    .eq("is_active", true);
  for (const r of rows ?? []) {
    counts.set(r.insurer_id, (counts.get(r.insurer_id) ?? 0) + 1);
  }

  const insurers = (data ?? []).map((i: { id: string; [k: string]: unknown }) => ({
    ...i,
    active_appetite_count: counts.get(i.id) ?? 0,
  }));
  return json({ ok: true, insurers });
}

// POST /api/insurers — create. Admin only.
export async function handleCreateInsurer(
  request: Request,
  env: Env,
  user: AtlasUser
): Promise<Response> {
  const guard = requireAdmin(user);
  if (guard) return guard;

  const body = (await request.json().catch(() => null)) as {
    name?: string;
    quote_channel?: string;
    notes?: string;
  } | null;
  if (!body?.name?.trim()) return json({ error: "bad_request" }, 400);

  const admin = adminClient(env);
  const { data, error } = await admin
    .from("atlas_insurers")
    .insert({
      name: body.name.trim(),
      quote_channel: body.quote_channel ?? null,
      notes: body.notes ?? null,
    })
    .select("id")
    .single();
  if (error || !data) return json({ error: "create_failed" }, 500);

  await audit(env, {
    action: "insurer_created",
    actorId: user.id,
    metadata: { insurer_id: data.id, name: body.name.trim() },
  });
  return json({ ok: true, id: data.id }, 201);
}

// ----------------------------------------------------------------------------
// GET /api/insurers/:id — detail: insurer + its documents + its appetite rules
// (both active and pending). Admin-only because pending proposals are review
// data, and edits flow from here.
// ----------------------------------------------------------------------------
export async function handleGetInsurer(
  insurerId: string,
  env: Env,
  user: AtlasUser
): Promise<Response> {
  const guard = requireAdmin(user);
  if (guard) return guard;

  const admin = adminClient(env);
  const { data: insurer, error } = await admin
    .from("atlas_insurers")
    .select("id, name, quote_channel, active, notes, created_at")
    .eq("id", insurerId)
    .single();
  if (error || !insurer) return json({ error: "not_found" }, 404);

  const { data: documents } = await admin
    .from("atlas_insurer_documents")
    .select(
      "id, file_name, document_kind, processing_status, processed_at, " +
        "proposed_count, processing_error, created_at"
    )
    .eq("insurer_id", insurerId)
    .order("created_at", { ascending: false });

  const { data: appetite } = await admin
    .from("atlas_insurer_appetite")
    .select(
      "id, product_line, risk_type, appetite_level, preferred_risks, " +
        "caution_risks, declined_risks, required_documents, referral_triggers, " +
        "notes, rating_notes, line_of_business, source_quote, source_page, " +
        "source_section, source_file_name, ingestion_confidence, " +
        "source, source_document_id, is_active, confirmed_by, " +
        "confirmed_at, created_at, updated_at"
    )
    .eq("insurer_id", insurerId)
    .order("is_active", { ascending: false })
    .order("created_at", { ascending: false });

  return json({
    ok: true,
    insurer,
    documents: documents ?? [],
    appetite: appetite ?? [],
  });
}

// ----------------------------------------------------------------------------
// POST /api/insurers/:id/documents/sign — signed upload URL for a guideline.
// The actual upload goes straight from the browser to Supabase storage, same
// pattern as Phase 1 client documents. Admin only.
// ----------------------------------------------------------------------------
export async function handleSignInsurerDoc(
  insurerId: string,
  request: Request,
  env: Env,
  user: AtlasUser
): Promise<Response> {
  const guard = requireAdmin(user);
  if (guard) return guard;

  const body = (await request.json().catch(() => null)) as {
    file_name?: string;
    content_type?: string;
    size_bytes?: number;
  } | null;
  if (!body?.file_name) return json({ error: "bad_request" }, 400);

  const admin = adminClient(env);
  const validation = validateUploadInput({
    fileName: body.file_name,
    contentType: body.content_type,
    sizeBytes: body.size_bytes,
    maxBytes: MAX_GUIDELINE_UPLOAD_BYTES,
  });
  if (!validation.ok) {
    return json({
      error: "validation_failed",
      detail: validation.reason,
      max_bytes: MAX_GUIDELINE_UPLOAD_BYTES,
    }, 400);
  }
  const path = `${insurerId}/${crypto.randomUUID()}-${validation.fileName}`;

  const { data: signed, error: signErr } = await admin.storage
    .from(INSURER_DOCS_BUCKET)
    .createSignedUploadUrl(path);
  if (signErr || !signed) return json({ error: "sign_failed" }, 500);

  return json({
    ok: true,
    upload: { url: signed.signedUrl, path, token: signed.token },
  });
}

export async function handleConfirmInsurerDoc(
  insurerId: string,
  request: Request,
  env: Env,
  user: AtlasUser
): Promise<Response> {
  const guard = requireAdmin(user);
  if (guard) return guard;

  const body = (await request.json().catch(() => null)) as {
    file_name?: string;
    storage_path?: string;
    document_kind?: string;
    content_type?: string;
    size_bytes?: number;
    file_hash?: string | null;
  } | null;
  if (!body?.file_name || !body?.storage_path) return json({ error: "bad_request" }, 400);
  if (!body.storage_path.startsWith(`${insurerId}/`)) {
    return json({ error: "bad_request", detail: "path_insurer_mismatch" }, 400);
  }

  const admin = adminClient(env);
  const validation = validateUploadInput({
    fileName: body.file_name,
    contentType: body.content_type,
    sizeBytes: body.size_bytes,
    maxBytes: MAX_GUIDELINE_UPLOAD_BYTES,
  });
  if (!validation.ok) {
    return json({
      error: "validation_failed",
      detail: validation.reason,
      max_bytes: MAX_GUIDELINE_UPLOAD_BYTES,
    }, 400);
  }

  const { data: doc, error: docErr } = await admin
    .from("atlas_insurer_documents")
    .insert({
      insurer_id: insurerId,
      file_name: validation.fileName,
      storage_path: body.storage_path,
      document_kind: body.document_kind ?? "guideline",
      uploaded_by: user.id,
      processing_status: "awaiting_processing",
      file_hash: body.file_hash ?? null,
      file_size_bytes: validation.sizeBytes,
      content_type: validation.contentType,
    })
    .select("id")
    .single();
  if (docErr || !doc) return json({ error: "doc_row_failed" }, 500);

  await audit(env, {
    action: "insurer_document_uploaded",
    actorId: user.id,
    metadata: {
      insurer_id: insurerId,
      document_id: doc.id,
      document_kind: body.document_kind ?? "guideline",
      file_name: validation.fileName,
      file_hash_present: Boolean(body.file_hash),
    },
  });

  return json({
    ok: true,
    document_id: doc.id,
  });
}

// ----------------------------------------------------------------------------
// POST /api/insurer-documents/:id/process — the AI ingestion step.
// Synchronous: reads the PDF natively to Claude, validates the proposed rules,
// inserts them as is_active=false. Retry-safe: if processing failed previously,
// the user can call this again on the same document.
// ----------------------------------------------------------------------------
export async function handleProcessInsurerDoc(
  documentId: string,
  request: Request,
  env: Env,
  user: AtlasUser
): Promise<Response> {
  const guard = requireAdmin(user);
  if (guard) return guard;
  const body = (await request.json().catch(() => ({}))) as { force?: boolean };

  const admin = adminClient(env);

  // Fetch document + insurer name (denormalised onto appetite rows for reads).
  const { data: doc } = await admin
    .from("atlas_insurer_documents")
    .select("id, insurer_id, file_name, storage_path, processing_status")
    .eq("id", documentId)
    .single();
  if (!doc) return json({ error: "document_not_found" }, 404);

  const { data: insurer } = await admin
    .from("atlas_insurers")
    .select("id, name")
    .eq("id", doc.insurer_id)
    .single();
  if (!insurer) return json({ error: "insurer_not_found" }, 404);

  const inputFp = buildGuidelineFingerprint({
    documentId,
    storagePath: doc.storage_path,
  });
  const job = await beginJob(
    admin,
    {
      documentId,
      insurerId: doc.insurer_id,
      jobType: "guideline_ingestion",
      inputFingerprint: inputFp,
      createdBy: user.id,
      metadata: { insurer_id: doc.insurer_id, file_name: doc.file_name },
    },
    { force: body.force === true }
  );
  if (job.action === "unchanged_completed") {
    return json({
      ok: true,
      skipped: true,
      reason: "unchanged_input",
      message: job.message,
      document_id: job.resultReferenceId ?? documentId,
      previous_job_id: job.previousJobId,
    });
  }
  if (job.action === "duplicate_running") {
    return json({ error: "job_already_running", detail: job.message, job_id: job.previousJobId }, 409);
  }

  // Mark in-flight (defensive; sync flow is short, but this surfaces stuck rows).
  await admin
    .from("atlas_insurer_documents")
    .update({ processing_status: "processing", processing_error: null })
    .eq("id", documentId);

  // Download the file from the private bucket.
  const { data: file, error: dlErr } = await admin.storage
    .from(INSURER_DOCS_BUCKET)
    .download(doc.storage_path);
  if (dlErr || !file) {
    await admin
      .from("atlas_insurer_documents")
      .update({
        processing_status: "failed",
        processing_error: "download_failed",
      })
      .eq("id", documentId);
    await failJob(admin, job.jobId, { errorCode: "document_unavailable", errorMessage: "Guideline document could not be downloaded." });
    return json({ error: "download_failed" }, 502);
  }

  const b64 = toBase64(await file.arrayBuffer());

  // Call Claude. Native PDF block for accuracy (no in-Worker parsing).
  let parsed: unknown;
  try {
    const res = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model: APPETITE_MODEL,
        max_tokens: 16000,
        system: APPETITE_SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "document",
                source: { type: "base64", media_type: "application/pdf", data: b64 },
              },
              {
                type: "text",
                text:
                  `This is a guideline / wording / appetite document for the ` +
                  `insurer "${insurer.name}". Propose the structured appetite ` +
                  `rules per your instructions. Return ONLY the JSON object.`,
              },
            ],
          },
        ],
      }),
    });

    if (!res.ok) {
      let errType = `anthropic_${res.status}`;
      try {
        const errBody = (await res.json()) as { error?: { type?: string; message?: string } };
        if (errBody?.error?.type) errType = errBody.error.type;
      } catch { /* ignore parse failure, fall back to status code */ }
      await admin
        .from("atlas_insurer_documents")
        .update({
          processing_status: "failed",
          processing_error: errType,
        })
        .eq("id", documentId);
      await failJob(admin, job.jobId, { errorCode: "guideline_ingestion_failed", errorMessage: errType });
      return json({ error: "ai_call_failed", status: res.status, detail: errType }, 502);
    }

    const data = (await res.json()) as {
      content?: { type: string; text?: string }[];
    };
    const text =
      data.content?.filter((b) => b.type === "text").map((b) => b.text).join("") ??
      "";
    const clean = text.replace(/```json|```/g, "").trim();
    parsed = JSON.parse(clean);
  } catch {
    await admin
      .from("atlas_insurer_documents")
      .update({
        processing_status: "failed",
        processing_error: "parse_failed",
      })
      .eq("id", documentId);
    await failJob(admin, job.jobId, { errorCode: "guideline_ingestion_failed", errorMessage: "AI response could not be parsed." });
    return json({ error: "parse_failed" }, 502);
  }

  const validated = validateIngestion(parsed);
  if (!validated) {
    await admin
      .from("atlas_insurer_documents")
      .update({
        processing_status: "failed",
        processing_error: "invalid_shape",
      })
      .eq("id", documentId);
    await failJob(admin, job.jobId, { errorCode: "validation_failed", errorMessage: "Guideline ingestion response failed validation." });
    return json({ error: "invalid_shape" }, 502);
  }

  // Insert proposed rows (is_active=false) and snapshot 'created' for each.
  let inserted = 0;
  for (const rule of validated.rules) {
    const { data: row, error: insErr } = await admin
      .from("atlas_insurer_appetite")
      .insert({
        insurer_id: insurer.id,
        insurer_name: insurer.name,
        product_line: rule.product_line,
        risk_type: rule.risk_type,
        appetite_level: rule.appetite_level,
        preferred_risks: rule.preferred_risks,
        caution_risks: rule.caution_risks,
        declined_risks: rule.declined_risks,
        required_documents: rule.required_documents,
        referral_triggers: rule.referral_triggers,
        notes: rule.notes,
        rating_notes: rule.rating_notes,
        line_of_business: rule.line_of_business,
        source_quote: rule.source_quote,
        source_page: rule.source_page,
        source_section: rule.source_section,
        source_file_name: doc.file_name,
        ingestion_confidence: rule.confidence,
        source: "ai_extracted",
        source_document_id: documentId,
        is_active: false,
      })
      .select("id")
      .single();
    if (insErr || !row) continue;
    inserted++;
    await snapshotAppetite(env, row.id, "created", user.id);
  }

  await admin
    .from("atlas_insurer_documents")
    .update({
      processing_status: "processed",
      processed_at: new Date().toISOString(),
      proposed_count: inserted,
      processing_error: null,
    })
    .eq("id", documentId);

  await audit(env, {
    action: "insurer_document_processed",
    actorId: user.id,
    metadata: {
      insurer_id: insurer.id,
      document_id: documentId,
      proposed_count: inserted,
    },
  });

  await completeJob(admin, job.jobId, {
    resultReferenceId: documentId,
    metadata: {
      insurer_id: insurer.id,
      document_id: documentId,
      proposed_count: inserted,
      input_fingerprint: inputFp,
    },
  });

  return json({
    ok: true,
    insurer_summary: validated.insurer_summary,
    proposed_count: inserted,
    document_notes: validated.document_notes,
  });
}

// ----------------------------------------------------------------------------
// PUT /api/appetite/:id — edit a proposed (or active) row's fields.
// Admin only. Snapshots 'updated' into history.
// ----------------------------------------------------------------------------
export async function handleEditAppetite(
  appetiteId: string,
  request: Request,
  env: Env,
  user: AtlasUser
): Promise<Response> {
  const guard = requireAdmin(user);
  if (guard) return guard;

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return json({ error: "bad_request" }, 400);

  // Whitelist editable columns; never let the caller change is_active or
  // insurer_id through this endpoint.
  const editable = new Set([
    "product_line",
    "risk_type",
    "appetite_level",
    "preferred_risks",
    "caution_risks",
    "declined_risks",
    "required_documents",
    "referral_triggers",
    "notes",
    "rating_notes",
    "line_of_business",
    "source_quote",
    "source_page",
    "source_section",
    "source_file_name",
    "ingestion_confidence",
  ]);
  const update: Record<string, unknown> = {};
  for (const k of Object.keys(body)) {
    if (editable.has(k)) update[k] = body[k];
  }
  if (Object.keys(update).length === 0) {
    return json({ error: "no_editable_fields" }, 400);
  }

  const admin = adminClient(env);
  const { error } = await admin
    .from("atlas_insurer_appetite")
    .update(update)
    .eq("id", appetiteId);
  if (error) return json({ error: "update_failed" }, 500);

  await snapshotAppetite(env, appetiteId, "updated", user.id);
  await audit(env, {
    action: "appetite_edited",
    actorId: user.id,
    metadata: { appetite_id: appetiteId, fields: Object.keys(update) },
  });
  return json({ ok: true });
}

// ----------------------------------------------------------------------------
// POST /api/appetite/:id/confirm — flip is_active=true. Live in the matrix.
// Admin only. Snapshots 'confirmed' into history.
// ----------------------------------------------------------------------------
export async function handleConfirmAppetite(
  appetiteId: string,
  env: Env,
  user: AtlasUser
): Promise<Response> {
  const guard = requireAdmin(user);
  if (guard) return guard;

  const admin = adminClient(env);
  const { error } = await admin
    .from("atlas_insurer_appetite")
    .update({
      is_active: true,
      confirmed_by: user.id,
      confirmed_at: new Date().toISOString(),
    })
    .eq("id", appetiteId);
  if (error) return json({ error: "confirm_failed" }, 500);

  await snapshotAppetite(env, appetiteId, "confirmed", user.id);
  await audit(env, {
    action: "appetite_confirmed",
    actorId: user.id,
    metadata: { appetite_id: appetiteId },
  });
  return json({ ok: true });
}

// ----------------------------------------------------------------------------
// POST /api/appetite/:id/deactivate — flip is_active=false (e.g. supersede
// after a guideline update). Admin only. Snapshots 'deactivated'. We never
// hard-delete an appetite row — past recommendations must remain defensible
// against the row that produced them.
// ----------------------------------------------------------------------------
export async function handleDeactivateAppetite(
  appetiteId: string,
  env: Env,
  user: AtlasUser
): Promise<Response> {
  const guard = requireAdmin(user);
  if (guard) return guard;

  const admin = adminClient(env);
  const { error } = await admin
    .from("atlas_insurer_appetite")
    .update({ is_active: false })
    .eq("id", appetiteId);
  if (error) return json({ error: "deactivate_failed" }, 500);

  await snapshotAppetite(env, appetiteId, "deactivated", user.id);
  await audit(env, {
    action: "appetite_deactivated",
    actorId: user.id,
    metadata: { appetite_id: appetiteId },
  });
  return json({ ok: true });
}
