/**
 * Atlas Blueprint — extraction endpoint
 * ----------------------------------------------------------------------------
 * POST /api/submissions/:id/extract   (MANAGERS / admin only)
 *
 * One mode boundary lives here:
 *
 *   legacy  -> runLegacyExtraction only.
 *   shadow  -> runLegacyExtraction is authoritative; if the job is sampled,
 *              runHybridExtraction runs afterwards and writes to
 *              atlas_pipeline_shadow_comparisons (aggregate counts only).
 *   hybrid  -> runHybridExtraction is authoritative. If it fails and the
 *              fallback policy permits, the legacy path is invoked as a
 *              narrow emergency fallback and the reason is recorded.
 *
 * The response shape, job lifecycle, cancellation, retries, RLS, and audit
 * behaviour are preserved regardless of mode.
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
import { pipelineMode } from "./pipeline-mode";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  runHybridExtraction,
  type DocumentRow,
  type HybridExtractionResult,
} from "./hybrid-orchestrator";
import { emitPipelineMetric } from "./pipeline-telemetry";
import { shouldShadowThisJob } from "./hybrid-shadow";
import { buildAlert } from "./phase8-core";
import { PIPELINE_VERSION } from "./hybrid-orchestrator";
import { enqueueShadowMessage, type ShadowQueueMessage } from "./shadow-queue";

const CLIENT_DOCS_BUCKET = "atlas-client-docs";
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

// ---------------------------------------------------------------------------
// Small helpers reused by both paths
// ---------------------------------------------------------------------------

function toBase64(buf: ArrayBuffer): string {
  let binary = "";
  const bytes = new Uint8Array(buf);
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

interface LoadedDocsResult {
  submissionBrokerEmail: string | null;
  docs: DocumentRow[];
}

async function loadSubmissionInputs(
  admin: SupabaseClient,
  submissionId: string
): Promise<LoadedDocsResult | null> {
  const { data: submission } = await admin
    .from("atlas_submissions")
    .select("id, broker_email_body")
    .eq("id", submissionId)
    .single();
  if (!submission) return null;

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
  const raw = (docsWithHash ?? docsLegacy ?? []) as DocumentRow[];

  return {
    submissionBrokerEmail: submission.broker_email_body ?? null,
    docs: raw,
  };
}

async function persistExtraction(
  admin: SupabaseClient,
  submissionId: string,
  extraction: Record<string, unknown>,
  versionMetadata: Record<string, unknown>
): Promise<{ id: string; confidence: number } | null> {
  const confidence = overallConfidence(extraction);
  const { data: row, error: insErr } = await admin
    .from("atlas_extractions")
    .insert({
      submission_id: submissionId,
      extracted_json: extraction,
      extraction_confidence: confidence,
      missing_fields_json: extraction["missing_information"] ?? [],
      red_flags_json: extraction["red_flags"] ?? [],
      version_metadata: versionMetadata,
    })
    .select("id")
    .single();
  if (insErr || !row) return null;
  await admin.from("atlas_submissions").update({ status: "in_review" }).eq("id", submissionId);
  return { id: String(row.id), confidence };
}

// ---------------------------------------------------------------------------
// The one manager-only entry point. It authorises, opens/claims a job, then
// dispatches to legacy or hybrid based on ATLAS_DOCUMENT_PIPELINE_MODE.
// ---------------------------------------------------------------------------

/**
 * Minimal interface Atlas relies on for background scheduling. Cloudflare
 * provides `ExecutionContext` with `waitUntil(promise)` — we type this
 * loosely so tests can pass in a stub.
 */
export interface ExtractExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

export async function handleExtract(
  submissionId: string,
  request: Request,
  env: Env,
  user: AtlasUser,
  ctx?: ExtractExecutionContext
): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as { force?: boolean; background_job_id?: string };

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
  const loaded = await loadSubmissionInputs(admin, submissionId);
  if (!loaded) return json({ error: "submission_not_found" }, 404);

  const inputFp = buildExtractionFingerprintV2({
    submissionId,
    brokerEmailPresent: Boolean(loaded.submissionBrokerEmail),
    documents: loaded.docs as { id: string; storage_path?: string | null; created_at?: string | null; status?: string | null; file_hash?: string | null }[],
  });

  const mode = pipelineMode(env);
  const job = await beginJob(
    admin,
    {
      submissionId,
      jobType: "extraction",
      inputFingerprint: inputFp,
      createdBy: user.id,
      metadata: {
        active_documents: loaded.docs.length,
        request: { force: body.force === true },
        pipeline_mode: mode,
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

  // ---- Dispatch -----------------------------------------------------------

  switch (mode) {
    case "hybrid":
      return runHybridAuthoritative({
        submissionId, env, admin, user, jobId: job.jobId!, inputFp, loaded, ctx,
      });
    case "shadow":
      return runLegacyAuthoritativeWithHybridShadow({
        submissionId, env, admin, user, jobId: job.jobId!, inputFp, loaded, ctx,
      });
    case "legacy":
    default:
      return runLegacyExtraction({
        submissionId, env, admin, user, jobId: job.jobId!, inputFp, loaded, ctx,
      });
  }
}

// ===========================================================================
// Legacy path (unchanged behaviour + telemetry)
// ===========================================================================

interface RunParams {
  submissionId: string;
  env: Env;
  admin: SupabaseClient;
  user: AtlasUser;
  jobId: string;
  inputFp: string;
  loaded: LoadedDocsResult;
  ctx?: ExtractExecutionContext;
}

interface LegacyRunOutcome {
  ok: boolean;
  extractionId?: string;
  extraction?: Record<string, unknown>;
  confidence?: number;
  totalMs: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  attachedCount: number;
  errorResponse?: Response;
}

async function runLegacyCore(params: RunParams): Promise<LegacyRunOutcome> {
  const started = Date.now();
  const { admin, env, submissionId, jobId, user, loaded } = params;

  await updateJobProgress(admin, jobId, 10, "validating_document");

  const content: unknown[] = [];
  if (loaded.submissionBrokerEmail) {
    content.push({ type: "text", text: "BROKER EMAIL (pasted at intake):\n\n" + loaded.submissionBrokerEmail });
  }

  const pdfDocs = loaded.docs.filter((d) => d.file_name.toLowerCase().endsWith(".pdf"));
  const downloads = await Promise.all(
    pdfDocs.map(async (doc) => {
      const { data: file, error: dlErr } = await admin.storage.from(CLIENT_DOCS_BUCKET).download(doc.storage_path);
      if (dlErr || !file) return { doc, b64: null as string | null };
      return { doc, b64: toBase64(await file.arrayBuffer()) };
    })
  );

  const unavailable: { id: string; file_name: string }[] = [];
  let attachedCount = 0;
  for (const { doc, b64 } of downloads) {
    if (!b64) { unavailable.push({ id: doc.id, file_name: doc.file_name }); continue; }
    content.push({
      type: "text",
      text: `SOURCE DOCUMENT\ndocument_id: ${doc.id}\nfile_name: ${doc.file_name}\ndocument_type: ${doc.document_type ?? "unknown"}`,
    });
    content.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: b64 } });
    attachedCount++;
  }

  if (unavailable.length > 0) {
    await audit(env, {
      submissionId, action: "extraction_blocked_documents_unavailable", actorId: user.id,
      metadata: { documents: unavailable },
    });
    await failJob(admin, jobId, { errorCode: "document_unavailable", errorMessage: "One or more documents could not be downloaded." });
    return {
      ok: false, totalMs: Date.now() - started, inputTokens: 0, outputTokens: 0, cachedTokens: 0, cacheWriteTokens: 0, attachedCount: 0,
      errorResponse: json({ error: "documents_unavailable", detail: "one_or_more_documents_could_not_be_downloaded", documents: unavailable }, 409),
    };
  }

  await updateJobProgress(admin, jobId, 35, "extracting_risk_information");
  if (await isJobCancellationRequested(admin, jobId)) {
    return { ok: false, totalMs: Date.now() - started, inputTokens: 0, outputTokens: 0, cachedTokens: 0, cacheWriteTokens: 0, attachedCount, errorResponse: json({ error: "job_cancelled", job_id: jobId }, 409) };
  }

  if (content.length === 0) {
    await failJob(admin, jobId, { errorCode: "missing_required_input", errorMessage: "No broker email or active PDF document was available." });
    return {
      ok: false, totalMs: Date.now() - started, inputTokens: 0, outputTokens: 0, cachedTokens: 0, cacheWriteTokens: 0, attachedCount,
      errorResponse: json({ error: "nothing_to_extract", detail: "no_email_or_pdf_documents" }, 400),
    };
  }

  content.push({ type: "text", text: "Extract the structured risk summary from the above. Return ONLY the JSON object described in your instructions." });

  let extraction: Record<string, unknown>;
  let usage = { input_tokens: 0, output_tokens: 0, cache_read: 0, cache_create: 0 };
  try {
    const res = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": ANTHROPIC_VERSION },
      body: JSON.stringify({
        model: EXTRACTION_MODEL, max_tokens: 16000,
        system: [{ type: "text", text: EXTRACTION_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content }],
      }),
    });
    if (!res.ok) {
      let detail = "";
      try { detail = (await res.text()).slice(0, 200).replace(/\s+/g, " "); } catch {}
      console.error("anthropic_error", res.status, detail);
      await failJob(admin, jobId, { errorCode: "extraction_failed", errorMessage: `anthropic_${res.status}` });
      return {
        ok: false, totalMs: Date.now() - started, inputTokens: 0, outputTokens: 0, cachedTokens: 0, cacheWriteTokens: 0, attachedCount,
        errorResponse: json({ error: "extraction_failed", status: res.status, detail }, 502),
      };
    }
    const data = (await res.json()) as {
      content?: { type: string; text?: string }[];
      usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
    };
    usage = {
      input_tokens: data.usage?.input_tokens ?? 0,
      output_tokens: data.usage?.output_tokens ?? 0,
      cache_read: data.usage?.cache_read_input_tokens ?? 0,
      cache_create: data.usage?.cache_creation_input_tokens ?? 0,
    };
    const text = data.content?.filter((b) => b.type === "text").map((b) => b.text).join("") ?? "";
    extraction = JSON.parse(text.replace(/```json|```/g, "").trim());
  } catch {
    await failJob(admin, jobId, { errorCode: "extraction_failed", errorMessage: "AI extraction response could not be parsed." });
    return { ok: false, totalMs: Date.now() - started, inputTokens: 0, outputTokens: 0, cachedTokens: 0, cacheWriteTokens: 0, attachedCount, errorResponse: json({ error: "extraction_parse_failed" }, 502) };
  }

  const validated = validateAndNormalizeExtraction(extraction);
  if (!validated.ok || !validated.value) {
    await failJob(admin, jobId, { errorCode: "validation_failed", errorMessage: "Extraction response failed schema validation." });
    return {
      ok: false, totalMs: Date.now() - started, inputTokens: usage.input_tokens, outputTokens: usage.output_tokens, cachedTokens: usage.cache_read, cacheWriteTokens: usage.cache_create, attachedCount,
      errorResponse: json({ error: "extraction_invalid_shape", detail: validated.errors.slice(0, 8) }, 502),
    };
  }
  extraction = validated.value;

  await updateJobProgress(admin, jobId, 85, "validating_extracted_fields");

  const saved = await persistExtraction(admin, submissionId, extraction, {
    model: EXTRACTION_MODEL,
    prompt: "extraction-v1",
    taxonomy: TAXONOMY_VERSION,
    appetite: "not_applicable",
    extraction: String((extraction as { schema_version?: unknown }).schema_version ?? "unknown"),
    pipeline_route: "legacy_full_sonnet",
  });
  if (!saved) {
    await failJob(admin, jobId, { errorCode: "store_failed", errorMessage: "Could not store extraction row." });
    return { ok: false, totalMs: Date.now() - started, inputTokens: usage.input_tokens, outputTokens: usage.output_tokens, cachedTokens: usage.cache_read, cacheWriteTokens: usage.cache_create, attachedCount, errorResponse: json({ error: "store_failed" }, 500) };
  }

  return {
    ok: true, extractionId: saved.id, extraction, confidence: saved.confidence,
    totalMs: Date.now() - started, inputTokens: usage.input_tokens, outputTokens: usage.output_tokens, cachedTokens: usage.cache_read, cacheWriteTokens: usage.cache_create, attachedCount,
  };
}

async function runLegacyExtraction(params: RunParams): Promise<Response> {
  const outcome = await runLegacyCore(params);
  if (!outcome.ok) {
    await emitPipelineMetric(params.admin, {
      pipelineMode: "legacy",
      route: "legacy_full_sonnet",
      model: EXTRACTION_MODEL,
      jobId: params.jobId,
      submissionId: params.submissionId,
      finalStatus: "failed",
      totalMs: outcome.totalMs,
      inputTokens: outcome.inputTokens, outputTokens: outcome.outputTokens,
      cachedInputTokens: outcome.cachedTokens, cacheWriteTokens: outcome.cacheWriteTokens,
    });
    return outcome.errorResponse!;
  }

  await audit(params.env, {
    submissionId: params.submissionId,
    action: "extraction_run",
    actorId: params.user.id,
    metadata: {
      extraction_id: outcome.extractionId, pdf_documents: outcome.attachedCount,
      had_pasted_email: Boolean(params.loaded.submissionBrokerEmail),
      overall_confidence: outcome.confidence, pipeline_mode: "legacy",
    },
  });
  await completeJob(params.admin, params.jobId, {
    resultReferenceId: outcome.extractionId,
    metadata: {
      extraction_id: outcome.extractionId, pdf_documents: outcome.attachedCount,
      overall_confidence: outcome.confidence, input_fingerprint: params.inputFp, pipeline_mode: "legacy",
    },
  });
  await emitPipelineMetric(params.admin, {
    pipelineMode: "legacy", route: "legacy_full_sonnet", model: EXTRACTION_MODEL,
    jobId: params.jobId, submissionId: params.submissionId,
    finalStatus: "completed", totalMs: outcome.totalMs,
    inputTokens: outcome.inputTokens, outputTokens: outcome.outputTokens,
    cachedInputTokens: outcome.cachedTokens, cacheWriteTokens: outcome.cacheWriteTokens,
    metadata: { pdf_documents: outcome.attachedCount },
  });
  return json({ ok: true, extraction_id: outcome.extractionId, overall_confidence: outcome.confidence });
}

// ===========================================================================
// Shadow path — legacy authoritative, hybrid runs in the Queue consumer
// ===========================================================================
//
// Ordering:
//   1. runLegacyCore                          (persist authoritative extraction)
//   2. audit + completeJob + legacy metric    (job is now "completed")
//   3. if sampled: `await queue.send(msg)`    (small identifier-only op)
//   4. return the legacy response
//
// Why not `ctx.waitUntil()` any more? HTTP `waitUntil` promises are capped at
// ~30s after the response is sent. Azure Document Intelligence polling is
// allowed up to 60s and Sonnet resolution can push past that too, so the
// shadow promise gets cancelled before the run completes and the evidence is
// unreliable. Cloudflare Queues have a substantially longer consumer budget,
// reliable delivery, and retries — the right primitive for this workload.
//
// Invariants preserved:
//   * Enqueue failure NEVER fails or alters the authoritative legacy response.
//   * Missing queue binding does NOT trigger any inline / waitUntil shadow.
//   * The queue message is identifier-only. See ShadowQueueMessage.

async function runLegacyAuthoritativeWithHybridShadow(params: RunParams): Promise<Response> {
  const outcome = await runLegacyCore(params);
  if (!outcome.ok) {
    await emitPipelineMetric(params.admin, {
      pipelineMode: "shadow", route: "legacy_full_sonnet", model: EXTRACTION_MODEL,
      jobId: params.jobId, submissionId: params.submissionId,
      finalStatus: "failed", totalMs: outcome.totalMs,
    });
    return outcome.errorResponse!;
  }

  const sampled = shouldShadowThisJob(params.inputFp, params.env);

  await audit(params.env, {
    submissionId: params.submissionId, action: "extraction_run", actorId: params.user.id,
    metadata: {
      extraction_id: outcome.extractionId, pdf_documents: outcome.attachedCount,
      had_pasted_email: Boolean(params.loaded.submissionBrokerEmail),
      overall_confidence: outcome.confidence, pipeline_mode: "shadow", shadow_sampled: sampled,
    },
  });
  await completeJob(params.admin, params.jobId, {
    resultReferenceId: outcome.extractionId,
    metadata: {
      extraction_id: outcome.extractionId, pdf_documents: outcome.attachedCount,
      overall_confidence: outcome.confidence, input_fingerprint: params.inputFp,
      pipeline_mode: "shadow", shadow_sampled: sampled,
    },
  });
  await emitPipelineMetric(params.admin, {
    pipelineMode: "shadow", route: "legacy_full_sonnet", model: EXTRACTION_MODEL,
    jobId: params.jobId, submissionId: params.submissionId,
    finalStatus: "completed", totalMs: outcome.totalMs,
    inputTokens: outcome.inputTokens, outputTokens: outcome.outputTokens,
    cachedInputTokens: outcome.cachedTokens, cacheWriteTokens: outcome.cacheWriteTokens,
    metadata: { pdf_documents: outcome.attachedCount, shadow_sampled: sampled },
  });

  if (sampled) {
    // Await ONLY the small queue.send() — never any hybrid processing.
    // If the queue is missing or the send fails, enqueueShadowMessage records
    // a privacy-safe metric and we return the legacy response unaltered.
    const message: ShadowQueueMessage = {
      v: 1,
      submissionId: params.submissionId,
      legacyExtractionId: String(outcome.extractionId),
      legacyJobId: params.jobId,
      inputFingerprint: params.inputFp,
      pipelineVersion: PIPELINE_VERSION,
      organisationId: null,
      enqueuedAt: Date.now(),
      legacyTotals: {
        totalMs: outcome.totalMs,
        inputTokens: outcome.inputTokens,
        outputTokens: outcome.outputTokens,
      },
    };
    try {
      await enqueueShadowMessage(params.env, params.admin, message);
    } catch (err) {
      // Belt & braces — enqueueShadowMessage does not throw, but if it ever
      // does, the legacy response still returns cleanly.
      console.warn("shadow_enqueue_unexpected_throw", (err as Error)?.message?.slice(0, 80) ?? "unknown");
    }
  }

  return json({ ok: true, extraction_id: outcome.extractionId, overall_confidence: outcome.confidence });
}

// ===========================================================================
// Hybrid path — authoritative orchestrator, narrow legacy emergency fallback
// ===========================================================================

async function runHybridAuthoritative(params: RunParams): Promise<Response> {
  const fallbackEnabled = params.env.ATLAS_LEGACY_FALLBACK_DISABLED !== "true";

  let hybrid: HybridExtractionResult;
  try {
    hybrid = await runHybridExtraction(
      {
        submissionId: params.submissionId,
        brokerEmailBody: params.loaded.submissionBrokerEmail,
        documents: params.loaded.docs,
      },
      {
        admin: params.admin,
        env: params.env,
        jobId: params.jobId,
        mode: "hybrid",
        legacyFallbackAllowed: fallbackEnabled,
        isCancelled: async () => isJobCancellationRequested(params.admin, params.jobId),
        onStage: async (stage, pct) => updateJobProgress(params.admin, params.jobId, pct, stage),
      }
    );
  } catch (err) {
    hybrid = {
      status: "failed", extraction: null, route: "failed", parser: "none",
      normalisationModel: null, fallbackModel: null, escalatedFields: [],
      warnings: [`orchestrator_threw:${(err as Error).message?.slice(0, 60) ?? "unknown"}`],
      provenance: [],
      metrics: {
        pipelineMode: "hybrid", route: "failed", finalStatus: "failed", totalMs: 0,
      },
      errorCode: "orchestrator_exception",
      suggestLegacyFallback: fallbackEnabled,
      fallbackReason: "orchestrator_exception",
    };
  }

  // Successful hybrid: persist and return.
  if (hybrid.status === "completed_hybrid" && hybrid.extraction) {
    await updateJobProgress(params.admin, params.jobId, 90, "preparing_recommendation");
    const saved = await persistExtraction(params.admin, params.submissionId, hybrid.extraction, {
      model: hybrid.normalisationModel ?? "claude-haiku-4-5",
      prompt: "hybrid-orchestrator-v1",
      taxonomy: TAXONOMY_VERSION,
      appetite: "not_applicable",
      extraction: String((hybrid.extraction as { schema_version?: unknown }).schema_version ?? "unknown"),
      pipeline_route: hybrid.route,
      escalated_fields: hybrid.escalatedFields,
      fallback_model: hybrid.fallbackModel,
    });
    if (!saved) {
      await failJob(params.admin, params.jobId, { errorCode: "store_failed", errorMessage: "Could not store hybrid extraction row." });
      await emitPipelineMetric(params.admin, { ...hybrid.metrics, jobId: params.jobId, submissionId: params.submissionId, finalStatus: "failed" });
      return json({ error: "store_failed" }, 500);
    }

    await audit(params.env, {
      submissionId: params.submissionId, action: "extraction_run", actorId: params.user.id,
      metadata: {
        extraction_id: saved.id, pdf_documents: hybrid.provenance.length,
        had_pasted_email: Boolean(params.loaded.submissionBrokerEmail),
        overall_confidence: saved.confidence, pipeline_mode: "hybrid",
        route: hybrid.route, escalated_field_count: hybrid.escalatedFields.length,
      },
    });
    await completeJob(params.admin, params.jobId, {
      resultReferenceId: saved.id,
      metadata: {
        extraction_id: saved.id, pdf_documents: hybrid.provenance.length,
        overall_confidence: saved.confidence, input_fingerprint: params.inputFp,
        pipeline_mode: "hybrid", route: hybrid.route,
      },
    });
    await emitPipelineMetric(params.admin, { ...hybrid.metrics, jobId: params.jobId, submissionId: params.submissionId, finalStatus: "completed" });
    return json({ ok: true, extraction_id: saved.id, overall_confidence: saved.confidence });
  }

  // Hybrid failed. Emergency legacy fallback if permitted AND not cancelled.
  const cancelled = await isJobCancellationRequested(params.admin, params.jobId);
  if (cancelled) {
    await failJob(params.admin, params.jobId, { errorCode: "cancelled", errorMessage: "Job was cancelled." });
    return json({ error: "job_cancelled", job_id: params.jobId }, 409);
  }

  if (hybrid.suggestLegacyFallback && fallbackEnabled) {
    // Record the escalation before we run legacy, so the reason survives even
    // if the legacy call itself fails.
    await params.admin.from("atlas_operational_alerts").insert(buildAlert({
      alertType: "hybrid_pipeline_legacy_fallback",
      severity: "warning",
      title: "Hybrid pipeline fell back to legacy Sonnet",
      message: hybrid.fallbackReason ?? hybrid.errorCode ?? "hybrid_failed",
      relatedJobId: params.jobId,
      relatedSubmissionId: params.submissionId,
      metadata: { route: hybrid.route, warnings_count: hybrid.warnings.length },
    }));
    await emitPipelineMetric(params.admin, {
      ...hybrid.metrics, jobId: params.jobId, submissionId: params.submissionId,
      finalStatus: "failed", fallbackReason: hybrid.fallbackReason ?? hybrid.errorCode ?? "hybrid_failed",
    });
    const legacyOutcome = await runLegacyCore(params);
    if (!legacyOutcome.ok) return legacyOutcome.errorResponse!;
    await audit(params.env, {
      submissionId: params.submissionId, action: "extraction_run", actorId: params.user.id,
      metadata: {
        extraction_id: legacyOutcome.extractionId, pdf_documents: legacyOutcome.attachedCount,
        had_pasted_email: Boolean(params.loaded.submissionBrokerEmail),
        overall_confidence: legacyOutcome.confidence,
        pipeline_mode: "hybrid", fallback: "legacy_emergency", fallback_reason: hybrid.fallbackReason,
      },
    });
    await completeJob(params.admin, params.jobId, {
      resultReferenceId: legacyOutcome.extractionId,
      metadata: {
        extraction_id: legacyOutcome.extractionId, pdf_documents: legacyOutcome.attachedCount,
        overall_confidence: legacyOutcome.confidence, input_fingerprint: params.inputFp,
        pipeline_mode: "hybrid", fallback: "legacy_emergency", fallback_reason: hybrid.fallbackReason,
      },
    });
    await emitPipelineMetric(params.admin, {
      pipelineMode: "hybrid", route: "legacy_full_sonnet", model: EXTRACTION_MODEL,
      jobId: params.jobId, submissionId: params.submissionId, finalStatus: "completed",
      totalMs: legacyOutcome.totalMs,
      inputTokens: legacyOutcome.inputTokens, outputTokens: legacyOutcome.outputTokens,
      cachedInputTokens: legacyOutcome.cachedTokens, cacheWriteTokens: legacyOutcome.cacheWriteTokens,
      fallbackReason: hybrid.fallbackReason ?? "hybrid_failed",
    });
    return json({ ok: true, extraction_id: legacyOutcome.extractionId, overall_confidence: legacyOutcome.confidence, fallback: "legacy_emergency" });
  }

  // No fallback: surface the failure honestly.
  await failJob(params.admin, params.jobId, {
    errorCode: hybrid.errorCode ?? "hybrid_extraction_failed",
    errorMessage: (hybrid.errorDetail ?? hybrid.fallbackReason ?? "hybrid pipeline failed").slice(0, 240),
  });
  await emitPipelineMetric(params.admin, { ...hybrid.metrics, jobId: params.jobId, submissionId: params.submissionId, finalStatus: "failed" });
  return json({ error: hybrid.errorCode ?? "hybrid_extraction_failed", detail: hybrid.errorDetail ?? hybrid.fallbackReason ?? null }, 502);
}
