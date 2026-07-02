/**
 * Atlas Blueprint — submission detail + correction endpoints
 * ----------------------------------------------------------------------------
 * GET  /api/submissions/:id            -> submission + documents + latest extraction
 * POST /api/submissions/:id/review     -> save corrected summary to reviewed_json
 *
 * Correction is the core human-in-the-loop action and is allowed to ANY staff
 * underwriter (not manager-gated) — correcting the AI's read is the underwriter's
 * job. It writes reviewed_json and never alters the raw extracted_json.
 */

import { adminClient, audit, json, type AtlasUser } from "./auth";
import { validateAndNormalizeExtraction } from "./extraction";
import type { Env } from "./config";
import { getLatestJob } from "./phase7-jobs";

/** GET /api/submissions/:id — everything the detail screen needs. */
export async function handleGetSubmission(
  submissionId: string,
  env: Env,
  _user: AtlasUser
): Promise<Response> {
  const admin = adminClient(env);

  const baseSubmissionColumns =
    "id, broker_name, broker_email, client_name, request_type, status, " +
    "broker_email_body, assigned_underwriter, created_by, created_at, updated_at";
  const phase7SubmissionColumns =
    "id, broker_name, broker_email, client_name, request_type, status, " +
    "broker_email_body, assigned_underwriter, assigned_to, assigned_at, " +
    "assigned_by, queue_status, created_by, created_at, updated_at";

  const { data: submission, error } = await admin
    .from("atlas_submissions")
    .select(phase7SubmissionColumns)
    .eq("id", submissionId)
    .single();

  let submissionRow = submission as Record<string, unknown> | null;
  if (error || !submission) {
    const { data: fallback, error: fallbackError } = await admin
      .from("atlas_submissions")
      .select(baseSubmissionColumns)
      .eq("id", submissionId)
      .single();
    if (fallbackError || !fallback) return json({ error: "not_found" }, 404);
    const fallbackRow = fallback as unknown as Record<string, unknown>;
    submissionRow = {
      ...fallbackRow,
      assigned_to: fallbackRow.assigned_underwriter ?? null,
      assigned_at: null,
      assigned_by: null,
      queue_status: fallbackRow.status ?? null,
    };
  }

  const { data: documents } = await admin
    .from("atlas_documents")
    .select("id, file_name, document_type, status, expires_at, created_at")
    .eq("submission_id", submissionId)
    .order("created_at", { ascending: true });

  // Latest extraction (most recent run) for this submission.
  const { data: extraction } = await admin
    .from("atlas_extractions")
    .select(
      "id, extracted_json, reviewed_json, extraction_confidence, " +
        "missing_fields_json, red_flags_json, reviewed_by, reviewed_at, created_at"
    )
    .eq("submission_id", submissionId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const [extractionJob, recommendationJob, quoteReviewJob] = await Promise.all([
    getLatestJob(env, { submissionId, jobType: "extraction" }),
    getLatestJob(env, { submissionId, jobType: "recommendation" }),
    getLatestJob(env, { submissionId, jobType: "quote_review" }),
  ]);

  return json({
    ok: true,
    submission: submissionRow,
    documents: documents ?? [],
    extraction,
    jobs: {
      extraction: extractionJob,
      recommendation: recommendationJob,
      quote_review: quoteReviewJob,
    },
  });
}

/**
 * POST /api/submissions/:id/review
 * Body: { extraction_id: string, reviewed_json: object }
 * Saves the underwriter-corrected summary. This becomes the authoritative
 * version the matcher will use. The raw extracted_json is left untouched.
 */
export async function handleReview(
  submissionId: string,
  request: Request,
  env: Env,
  user: AtlasUser
): Promise<Response> {
  const body = (await request.json().catch(() => null)) as {
    extraction_id?: string;
    reviewed_json?: Record<string, unknown>;
  } | null;
  if (!body?.extraction_id || !body?.reviewed_json) {
    return json({ error: "bad_request" }, 400);
  }

  const admin = adminClient(env);

  // Guard: the extraction must belong to this submission.
  const { data: existing } = await admin
    .from("atlas_extractions")
    .select("id, submission_id")
    .eq("id", body.extraction_id)
    .single();
  if (!existing || existing.submission_id !== submissionId) {
    return json({ error: "extraction_mismatch" }, 400);
  }

  const validated = validateAndNormalizeExtraction(body.reviewed_json);
  if (!validated.ok || !validated.value) {
    return json(
      {
        error: "review_invalid_shape",
        detail: validated.errors.slice(0, 8),
      },
      400
    );
  }

  const { error: updErr } = await admin
    .from("atlas_extractions")
    .update({
      reviewed_json: validated.value,
      reviewed_by: user.id,
      reviewed_at: new Date().toISOString(),
    })
    .eq("id", body.extraction_id);
  if (updErr) return json({ error: "save_failed" }, 500);

  await audit(env, {
    submissionId,
    action: "extraction_reviewed",
    actorId: user.id,
    // Field NAMES that were corrected could be added by the caller; we keep it
    // to the extraction id here to avoid logging any values.
    metadata: { extraction_id: body.extraction_id },
  });

  return json({ ok: true });
}
