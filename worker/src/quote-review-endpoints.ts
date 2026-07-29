import { adminClient, audit, json, type AtlasUser } from "./auth";
import type { Env } from "./config";
import type { AppetiteRow } from "./matcher-types";
import { TAXONOMY_VERSION } from "./taxonomy";
import { buildQuoteReview } from "./quote-review";
import {
  beginJob,
  buildQuoteReviewFingerprint,
  completeJob,
  failJob,
  queuedJobResponse,
  isJobCancellationRequested,
  updateJobProgress,
} from "./phase7-jobs";

interface RunQuoteReviewInput {
  recommendation_id?: string;
  insurer_id?: string | null;
  force?: boolean;
  background_job_id?: string;
}

export async function handleRunQuoteReview(
  submissionId: string,
  request: Request,
  env: Env,
  user: AtlasUser
): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as RunQuoteReviewInput;
  const admin = adminClient(env);

  const { data: extraction } = await admin
    .from("atlas_extractions")
    .select("id, submission_id, reviewed_json, overall_confidence:extraction_confidence")
    .eq("submission_id", submissionId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!extraction) return json({ error: "no_extraction", detail: "run_extraction_first" }, 400);
  if (!extraction.reviewed_json) {
    return json({ error: "extraction_not_reviewed", detail: "review_extraction_first" }, 400);
  }

  let recommendation: Record<string, unknown> | null = null;
  if (body.recommendation_id) {
    const { data } = await admin
      .from("atlas_recommendations")
      .select("*")
      .eq("id", body.recommendation_id)
      .single();
    if (!data || data.submission_id !== submissionId) return json({ error: "recommendation_mismatch" }, 400);
    recommendation = data as Record<string, unknown>;
  } else {
    const { data } = await admin
      .from("atlas_recommendations")
      .select("*")
      .eq("submission_id", submissionId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    recommendation = (data as Record<string, unknown> | null) ?? null;
  }

  const top = (recommendation?.reasoning_json as { top?: { insurer_id?: string } } | undefined)?.top;
  const insurerId = body.insurer_id ?? top?.insurer_id ?? null;

  // A quote review must be scoped to ONE insurer. Unscoped, findRule() would
  // check quoted sections against whichever insurer's rules happen to share a
  // product line — validating a quote against a competitor's appetite.
  if (!insurerId) {
    return json(
      {
        error: "insurer_scope_required",
        detail: "insurer_scope_required",
        message:
          "Run a recommendation (or select an insurer) before running a quote review, so sections are checked against that insurer's rules only.",
      },
      400
    );
  }

  const { data: docs } = await admin
    .from("atlas_documents")
    .select("document_type, file_name, scan_status")
    .eq("submission_id", submissionId)
    .eq("status", "active")
    .in("scan_status", ["clean", "not_scanned"]);
  const availableDocuments = ((docs ?? []) as { document_type: string | null; file_name: string | null; scan_status?: string | null }[])
    .flatMap((d) => [d.document_type, d.file_name])
    .filter((x: string | null): x is string => typeof x === "string" && x.trim().length > 0);

  let query = admin
    .from("atlas_insurer_appetite")
    .select(
      "id, insurer_id, insurer_name, product_line, risk_type, appetite_level, " +
        "preferred_risks, caution_risks, declined_risks, required_documents, " +
        "referral_triggers, notes, rating_notes, line_of_business, source_quote, " +
        "source_page, source_section, source_file_name, ingestion_confidence, " +
        "source, source_document_id, is_active, updated_at"
    )
    .eq("is_active", true);
  if (insurerId) query = query.eq("insurer_id", insurerId);
  const { data: appetiteRaw } = await query;
  const appetite = (appetiteRaw ?? []) as unknown as AppetiteRow[];

  const inputFp = buildQuoteReviewFingerprint({
    submissionId,
    extractionId: extraction.id,
    recommendationId: recommendation?.id ? String(recommendation.id) : null,
    insurerId,
    activeRuleIds: ((appetiteRaw ?? []) as unknown as { id: string; updated_at?: string | null }[]).map(
      (a) => `${a.id}:${a.updated_at ?? ""}`
    ),
  });
  const job = await beginJob(
    admin,
    {
      submissionId,
      insurerId,
      jobType: "quote_review",
      inputFingerprint: inputFp,
      createdBy: user.id,
      metadata: {
        extraction_id: extraction.id,
        recommendation_id: recommendation?.id ?? null,
        insurer_id: insurerId,
        active_rules: appetite.length,
        request: {
          recommendation_id: body.recommendation_id ?? recommendation?.id ?? null,
          insurer_id: insurerId,
          force: body.force === true,
        },
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
      quote_review_id: job.resultReferenceId,
      previous_job_id: job.previousJobId,
    });
  }
  if (job.action === "duplicate_running") {
    return json({ error: "job_already_running", detail: job.message, job_id: job.previousJobId }, 409);
  }
  if (job.action === "cancelled") {
    return json({ error: "job_cancelled", detail: job.message, job_id: job.jobId }, 409);
  }
  if (job.action === "queued") return queuedJobResponse(job, "quote_review");

  await updateJobProgress(admin, job.jobId, 25, "checking_quote_against_appetite");
  if (await isJobCancellationRequested(admin, job.jobId)) {
    return json({ error: "job_cancelled", job_id: job.jobId }, 409);
  }

  const reviewedJson = extraction.reviewed_json as Record<string, unknown>;
  const result = buildQuoteReview({
    reviewed: reviewedJson,
    recommendation,
    appetite,
    availableDocuments,
  });
  await updateJobProgress(admin, job.jobId, 75, "saving_quote_review");

  const snapshot = {
    extraction_id: extraction.id,
    recommendation_id: recommendation?.id ?? null,
    insurer_id: insurerId,
    reviewed_json: reviewedJson,
    recommendation,
    quote_terms: result.quote_terms,
    result,
  };

  const { data: reviewRow, error: reviewErr } = await admin
    .from("atlas_quote_reviews")
    .insert({
      submission_id: submissionId,
      recommendation_id: recommendation?.id ?? null,
      insurer_id: insurerId,
      status: result.status,
      overall_outcome: result.overall_outcome,
      overall_confidence: result.overall_confidence,
      manual_review_required: result.manual_review_required,
      created_by: user.id,
      reviewed_by: user.id,
      review_snapshot: snapshot,
      version_metadata: {
        model: "deterministic_quote_review",
        prompt: "quote-review-rules-v1",
        taxonomy: TAXONOMY_VERSION,
        appetite: inputFp,
        extraction: String((reviewedJson as { schema_version?: unknown }).schema_version ?? "unknown"),
      },
    })
    .select("id")
    .single();
  if (reviewErr || !reviewRow) {
    await failJob(admin, job.jobId, { errorCode: "quote_review_failed", errorMessage: "Could not store quote review row." });
    return json({ error: "store_failed" }, 500);
  }

  if (result.sections.length > 0) {
    const sectionRows = result.sections.map((s) => ({
      quote_review_id: reviewRow.id,
      section_key: s.section_key,
      section_name: s.section_name,
      matched_rule_id: s.matched_rule_id,
      status: s.status,
      confidence: s.confidence,
      findings: s.findings,
      missing_documents: s.missing_documents,
      referral_triggers: s.referral_triggers,
      declined_reasons: s.declined_reasons,
      rating_findings: s.rating_findings,
      excess_findings: s.excess_findings,
      warranty_findings: s.warranty_findings,
      source_evidence: {
        ...s.source_evidence,
        consultant_explanation: s.consultant_explanation,
      },
    }));
    const { error: sectionErr } = await admin.from("atlas_quote_review_sections").insert(sectionRows);
    if (sectionErr) {
      await failJob(admin, job.jobId, { errorCode: "quote_review_failed", errorMessage: "Could not store quote review sections." });
      return json({ error: "section_store_failed" }, 500);
    }
  }

  await audit(env, {
    submissionId,
    action: "quote_review_run",
    actorId: user.id,
    metadata: {
      quote_review_id: reviewRow.id,
      recommendation_id: recommendation?.id ?? null,
      insurer_id: insurerId,
      status: result.status,
      sections: result.sections.length,
    },
  });

  await completeJob(admin, job.jobId, {
    resultReferenceId: reviewRow.id,
    quoteReviewId: reviewRow.id,
    metadata: {
      quote_review_id: reviewRow.id,
      recommendation_id: recommendation?.id ?? null,
      input_fingerprint: inputFp,
      sections: result.sections.length,
    },
  });

  return json({ ok: true, quote_review_id: reviewRow.id });
}

export async function handleGetQuoteReview(
  submissionId: string,
  env: Env,
  _user: AtlasUser
): Promise<Response> {
  const admin = adminClient(env);
  const { data: review, error } = await admin
    .from("atlas_quote_reviews")
    .select(
      "id, submission_id, recommendation_id, insurer_id, status, overall_outcome, " +
        "overall_confidence, manual_review_required, created_by, reviewed_by, " +
        "review_snapshot, created_at, updated_at"
    )
    .eq("submission_id", submissionId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) return json({ error: "fetch_failed" }, 500);
  if (!review) return json({ ok: true, quote_review: null, sections: [] });
  const reviewId = (review as unknown as { id: string }).id;

  const { data: sections, error: sectionErr } = await admin
    .from("atlas_quote_review_sections")
    .select("*")
    .eq("quote_review_id", reviewId)
    .order("created_at", { ascending: true });
  if (sectionErr) return json({ error: "fetch_failed" }, 500);

  return json({ ok: true, quote_review: review, sections: sections ?? [] });
}
