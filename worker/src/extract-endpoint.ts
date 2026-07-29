/**
 * Atlas Blueprint — extraction endpoint
 * ----------------------------------------------------------------------------
 * POST /api/submissions/:id/extract   (MANAGERS / admin only)
 *
 * Reads ALL of a submission's documents (PDFs sent natively to Claude for
 * accurate, no-retyping extraction) plus the pasted broker email, asks Claude
 * for the structured risk summary, validates and stores it in
 * atlas_extractions.extracted_json, and audit-logs. Never touches reviewed_json.
 *
 * Manager-only is enforced HERE, server-side: a plain underwriter calling this
 * is refused regardless of what the frontend allows.
 */

import { adminClient, audit, json, type AtlasUser } from "./auth";
import { roleCanRunExtraction } from "./phase6-hardening";
import {
  EXTRACTION_MODEL,
  EXTRACTION_SYSTEM_PROMPT,
  overallConfidence,
  validateAndNormalizeExtraction,
} from "./extraction";
import type { Env } from "./config";
import {
  beginJob,
  completeJob,
  failJob,
  queuedJobResponse,
  isJobCancellationRequested,
  updateJobProgress,
} from "./phase7-jobs";
import { buildExtractionFingerprintV2 } from "./phase8-core";
import { TAXONOMY_VERSION } from "./taxonomy";

const CLIENT_DOCS_BUCKET = "atlas-client-docs";
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

/** Convert an ArrayBuffer to base64 (Workers have btoa but not Buffer). */
function toBase64(buf: ArrayBuffer): string {
  let binary = "";
  const bytes = new Uint8Array(buf);
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export async function handleExtract(
  submissionId: string,
  request: Request,
  env: Env,
  user: AtlasUser
): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as { force?: boolean; background_job_id?: string };
  // ---- Manager-only gate (server-side, authoritative) ----
  if (!roleCanRunExtraction(user.role)) {
    await audit(env, {
      submissionId,
      action: "extraction_denied",
      actorId: user.id,
      metadata: { reason: "not_manager_or_admin" },
    });
    return json({ error: "forbidden", detail: "manager_only" }, 403);
  }

  const admin = adminClient(env);

  // ---- Gather inputs: pasted email + active document files ----
  const { data: submission } = await admin
    .from("atlas_submissions")
    .select("id, broker_email_body")
    .eq("id", submissionId)
    .single();
  if (!submission) return json({ error: "submission_not_found" }, 404);

  const { data: docsWithHash, error: docsHashError } = await admin
    .from("atlas_documents")
    .select("id, file_name, storage_path, document_type, status, scan_status, created_at, file_hash")
    .eq("submission_id", submissionId)
    .eq("status", "active")
    .in("scan_status", ["clean", "not_scanned"]);
  const { data: docsLegacy } = docsHashError
    ? await admin
        .from("atlas_documents")
        .select("id, file_name, storage_path, document_type, status, created_at")
        .eq("submission_id", submissionId)
        .eq("status", "active")
    : { data: null };
  const docs = docsWithHash ?? docsLegacy ?? [];

  const inputFp = buildExtractionFingerprintV2({
    submissionId,
    brokerEmailPresent: Boolean(submission.broker_email_body),
    documents: (docs ?? []) as { id: string; storage_path?: string | null; created_at?: string | null; status?: string | null; file_hash?: string | null }[],
  });
  const job = await beginJob(
    admin,
    {
      submissionId,
      jobType: "extraction",
      inputFingerprint: inputFp,
      createdBy: user.id,
      metadata: {
        active_documents: docs?.length ?? 0,
        request: { force: body.force === true },
      },
    },
    { force: body.force === true, existingJobId: body.background_job_id }
  );
  if (job.action === "unchanged_completed") {
    return json({
      ok: true,
      skipped: true,
      reason: "unchanged_input",
      message: job.message,
      extraction_id: job.resultReferenceId,
      previous_job_id: job.previousJobId,
    });
  }
  if (job.action === "duplicate_running") {
    return json({ error: "job_already_running", detail: job.message, job_id: job.previousJobId }, 409);
  }
  if (job.action === "cancelled") {
    return json({ error: "job_cancelled", detail: job.message, job_id: job.jobId }, 409);
  }
  if (job.action === "queued") return queuedJobResponse(job, "extraction");

  await updateJobProgress(admin, job.jobId, 10, "reading_documents");

  // Build the Claude message content: the instruction text + each PDF as a
  // native document block (Claude reads PDFs directly — best accuracy, no
  // re-typing, layout/tables preserved).
  const content: unknown[] = [];

  if (submission.broker_email_body) {
    content.push({
      type: "text",
      text:
        "BROKER EMAIL (pasted at intake):\n\n" + submission.broker_email_body,
    });
  }

  let attachedCount = 0;
  const unavailableDocuments: { id: string; file_name: string }[] = [];
  for (const doc of docs ?? []) {
    // Only PDFs go as native document blocks in this phase.
    if (!doc.file_name.toLowerCase().endsWith(".pdf")) continue;

    const { data: file, error: dlErr } = await admin.storage
      .from(CLIENT_DOCS_BUCKET)
      .download(doc.storage_path);
    if (dlErr || !file) {
      unavailableDocuments.push({ id: doc.id, file_name: doc.file_name });
      continue;
    }

    const b64 = toBase64(await file.arrayBuffer());
    content.push({
      type: "text",
      text:
        `SOURCE DOCUMENT\n` +
        `document_id: ${doc.id}\n` +
        `file_name: ${doc.file_name}\n` +
        `document_type: ${doc.document_type ?? "unknown"}`,
    });
    content.push({
      type: "document",
      source: { type: "base64", media_type: "application/pdf", data: b64 },
    });
    attachedCount++;
  }

  if (unavailableDocuments.length > 0) {
    await audit(env, {
      submissionId,
      action: "extraction_blocked_documents_unavailable",
      actorId: user.id,
      metadata: {
        documents: unavailableDocuments,
      },
    });
    await failJob(admin, job.jobId, {
      errorCode: "document_unavailable",
      errorMessage: "One or more documents could not be downloaded.",
    });
    return json(
      {
        error: "documents_unavailable",
        detail: "one_or_more_documents_could_not_be_downloaded",
        documents: unavailableDocuments,
      },
      409
    );
  }

  await updateJobProgress(admin, job.jobId, 35, "calling_extraction_model");
  if (await isJobCancellationRequested(admin, job.jobId)) {
    return json({ error: "job_cancelled", job_id: job.jobId }, 409);
  }

  if (content.length === 0) {
    await failJob(admin, job.jobId, {
      errorCode: "missing_required_input",
      errorMessage: "No broker email or active PDF document was available.",
    });
    return json(
      { error: "nothing_to_extract", detail: "no_email_or_pdf_documents" },
      400
    );
  }

  content.push({
    type: "text",
    text:
      "Extract the structured risk summary from the above. " +
      "Return ONLY the JSON object described in your instructions.",
  });

  // ---- Call Claude ----
  let extraction: Record<string, unknown>;
  try {
    const res = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model: EXTRACTION_MODEL,
        max_tokens: 16000,
        system: EXTRACTION_SYSTEM_PROMPT,
        messages: [{ role: "user", content }],
      }),
    });

    if (!res.ok) {
  let detail = "";
  try {
    const body = await res.text();
    detail = body.slice(0, 200).replace(/\s+/g, " ");
  } catch {}
  console.error("anthropic_error", res.status, detail);
  await failJob(admin, job.jobId, {
    errorCode: "extraction_failed",
    errorMessage: `anthropic_${res.status}`,
  });
  return json({ error: "extraction_failed", status: res.status, detail }, 502);
}

    const data = (await res.json()) as {
      content?: { type: string; text?: string }[];
    };
    const text =
      data.content?.filter((b) => b.type === "text").map((b) => b.text).join("") ??
      "";
    const clean = text.replace(/```json|```/g, "").trim();
    extraction = JSON.parse(clean);
  } catch {
    await failJob(admin, job.jobId, {
      errorCode: "extraction_failed",
      errorMessage: "AI extraction response could not be parsed.",
    });
    return json({ error: "extraction_parse_failed" }, 502);
  }

  const validated = validateAndNormalizeExtraction(extraction);
  if (!validated.ok || !validated.value) {
    await failJob(admin, job.jobId, {
      errorCode: "validation_failed",
      errorMessage: "Extraction response failed schema validation.",
    });
    return json(
      {
        error: "extraction_invalid_shape",
        detail: validated.errors.slice(0, 8),
      },
      502
    );
  }

  await updateJobProgress(admin, job.jobId, 85, "saving_extraction");

  // ---- Store as extracted_json (raw AI). reviewed_json stays null. ----
  extraction = validated.value;
  const confidence = overallConfidence(extraction);
  const { data: row, error: insErr } = await admin
    .from("atlas_extractions")
    .insert({
      submission_id: submissionId,
      extracted_json: extraction,
      extraction_confidence: confidence,
      missing_fields_json: extraction["missing_information"] ?? [],
      red_flags_json: extraction["red_flags"] ?? [],
      version_metadata: {
        model: EXTRACTION_MODEL,
        prompt: "extraction-v1",
        taxonomy: TAXONOMY_VERSION,
        appetite: "not_applicable",
        extraction: String((extraction as { schema_version?: unknown }).schema_version ?? "unknown"),
      },
    })
    .select("id")
    .single();

  if (insErr || !row) {
    await failJob(admin, job.jobId, { errorCode: "store_failed", errorMessage: "Could not store extraction row." });
    return json({ error: "store_failed" }, 500);
  }

  // Move the submission into review now that it has an extraction.
  await admin
    .from("atlas_submissions")
    .update({ status: "in_review" })
    .eq("id", submissionId);

  await audit(env, {
    submissionId,
    action: "extraction_run",
    actorId: user.id,
    // Counts and the extraction id only — never document contents or PII.
    metadata: {
      extraction_id: row.id,
      pdf_documents: attachedCount,
      had_pasted_email: Boolean(submission.broker_email_body),
      overall_confidence: confidence,
    },
  });

  await completeJob(admin, job.jobId, {
    resultReferenceId: row.id,
    metadata: {
      extraction_id: row.id,
      pdf_documents: attachedCount,
      overall_confidence: confidence,
      input_fingerprint: inputFp,
    },
  });

  return json({ ok: true, extraction_id: row.id, overall_confidence: confidence });
}
