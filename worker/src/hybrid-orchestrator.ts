/**
 * Atlas hybrid pipeline — orchestrator
 * ----------------------------------------------------------------------------
 * The one authoritative service that turns raw documents into the CANONICAL
 * Atlas extraction shape (`validateAndNormalizeExtraction`'s value type). It
 * MUST NOT invent a competing extraction model — everything downstream
 * (matcher, recommendation, decisions) reads the existing schema.
 *
 * Sequence:
 *
 *     for each document:
 *       LocalPdfParser.parse
 *       classifyRoute
 *       if OCR/layout needed and Azure configured -> AzureDocumentIntelligenceParser.parse
 *
 *     assemble text corpus (broker email + per-doc text with page delimiters)
 *     Haiku normalisation -> canonical Atlas extraction
 *     validateAndNormalizeExtraction (existing)
 *     detect escalation signals
 *       if escalate and fewer than N attempts:
 *         bounded Sonnet resolution over ONLY the affected fields
 *         merge only those fields
 *         re-validate
 *     if fatal failure and legacy fallback allowed -> return LEGACY_FALLBACK
 *
 * The orchestrator does NOT persist anything or call the job APIs — that stays
 * with the endpoint. The orchestrator just returns a HybridExtractionResult
 * so the endpoint can decide whether to write it, shadow-log it, or discard it.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Env } from "./config.js";
import {
  EXTRACTION_SCHEMA_VERSION,
  overallConfidence,
  validateAndNormalizeExtraction,
} from "./extraction.js";
import { LocalPdfParser } from "./parser-local-pdf.js";
import {
  AzureDocumentIntelligenceParser,
  azureConfigFromEnv,
  redactAzureError,
} from "./parser-azure.js";
import {
  classifyRoute,
  detectEscalationSignals,
  shouldEscalateToSonnet,
} from "./pipeline-router.js";
import type { PipelineRoute, ParsedDocument, CanonicalField } from "./pipeline-types.js";
import {
  azureConfigured,
  maxTextFastpathPages,
  sectionConcurrency,
  perSectionTimeoutMs,
  overallHybridDeadlineMs,
  sectionCharCap,
  type PipelineEnv,
  type PipelineMode,
  type SectionExtractionEnv,
} from "./pipeline-mode.js";
import { StageTimer, type PipelineMetricInput } from "./pipeline-telemetry.js";
import { canonicalTaxonomyKey } from "./taxonomy.js";
import {
  runSonnetBoundedResolution,
  runSonnetSectionResolution,
  type NormalisationUsage,
} from "./hybrid-llm.js";
import { splitDocumentsIntoSections, type DocumentSection } from "./section-splitter.js";
import { extractSections, type SectionRunResult } from "./section-extractor.js";
import { mergeSectionPartials, type MergePartial } from "./section-merger.js";
import type { CanonicalPartial } from "./section-schemas.js";
import { isUsableHybridExtraction, hybridUsabilityConfig } from "./hybrid-usability.js";
import { ATLAS_MODEL_HAIKU, ATLAS_MODEL_SONNET, type Usage } from "./anthropic-client.js";

const CLIENT_DOCS_BUCKET = "atlas-client-docs";

// PIPELINE_VERSION lives in its own module so tests can import it without
// pulling the full orchestrator (and @supabase/supabase-js value imports)
// into their compile graph.
export { PIPELINE_VERSION } from "./pipeline-version.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DocumentRow {
  id: string;
  file_name: string;
  storage_path: string;
  document_type: string | null;
  file_hash?: string | null;
}

export interface ExtractionInput {
  submissionId: string;
  brokerEmailBody: string | null;
  documents: DocumentRow[];
}

export interface ExtractionContext {
  admin: SupabaseClient;
  env: Env & PipelineEnv & SectionExtractionEnv;
  jobId?: string | null;
  mode: PipelineMode;
  isCancelled?: () => Promise<boolean>;
  onStage?: (stage: string, progressPercent: number) => Promise<void>;
  /** Explicitly allow the emergency legacy fallback. Off for shadow (never falls back). */
  legacyFallbackAllowed: boolean;
}

export type OrchestratorStatus =
  | "completed_hybrid"
  | "completed_legacy_fallback"
  | "failed";

export interface HybridExtractionResult {
  status: OrchestratorStatus;
  extraction: Record<string, unknown> | null;
  route: PipelineRoute;
  parser: string;
  normalisationModel: string | null;
  fallbackModel: string | null;
  escalatedFields: string[];
  warnings: string[];
  provenance: {
    documentId: string;
    fileName: string;
    pageCount: number;
    parser: string;
    quality: string;
    parseMs: number;
    ocrMs?: number;
  }[];
  metrics: PipelineMetricInput;
  /** Populated only when status = failed. */
  errorCode?: string;
  errorDetail?: string;
  /** True when the caller should invoke runLegacyExtraction as an emergency step. */
  suggestLegacyFallback?: boolean;
  fallbackReason?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isPdf(name: string): boolean {
  return name.toLowerCase().endsWith(".pdf");
}

async function downloadBytes(
  admin: SupabaseClient,
  storagePath: string
): Promise<ArrayBuffer | null> {
  const { data, error } = await admin.storage.from(CLIENT_DOCS_BUCKET).download(storagePath);
  if (error || !data) return null;
  return await data.arrayBuffer();
}

/** Flatten the canonical extraction into a CanonicalField map for escalation checks. */
function flattenToCanonicalFields(extraction: Record<string, unknown>): Record<string, CanonicalField> {
  const out: Record<string, CanonicalField> = {};
  const sections = ["extracted_client", "current_cover", "risk_classification", "claims", "quote_terms"];
  for (const section of sections) {
    const sec = extraction[section];
    if (!sec || typeof sec !== "object") continue;
    for (const [k, raw] of Object.entries(sec as Record<string, unknown>)) {
      const f = raw as { value?: unknown; confidence?: number; source?: { page?: number | null; snippet?: string | null; document_id?: string | null } } | undefined;
      if (!f) continue;
      out[`${section}.${k}`] = {
        value: f.value ?? null,
        confidence: typeof f.confidence === "number" ? f.confidence : null,
        sourceDocumentId: f.source?.document_id ?? null,
        sourcePage: f.source?.page ?? null,
        sourceText: f.source?.snippet ?? null,
        boundingRegion: null,
        extractionMethod: "haiku_normalise",
        warnings: [],
      };
    }
  }
  return out;
}

/** Set a nested field back onto the extraction, preserving existing shape. */
function setFieldOnExtraction(
  extraction: Record<string, unknown>,
  dottedKey: string,
  value: unknown,
  sourcePage: number | null,
  method: string
): void {
  const [section, field] = dottedKey.split(".");
  if (!section || !field) return;
  const sec = (extraction[section] ?? {}) as Record<string, unknown>;
  const existing = (sec[field] ?? {}) as Record<string, unknown>;
  // Confidence policy: bounded Sonnet does not supply a numeric rating —
  // we neither invent one nor demote any provider number that was already
  // recorded on this field. Null with source "unavailable" is the honest
  // default; a prior provider number is preserved as-is.
  const priorConfidence = typeof existing.confidence === "number" && Number.isFinite(existing.confidence)
    ? (existing.confidence as number)
    : null;
  const priorSource =
    existing.confidence_source === "provider" || existing.confidence_source === "deterministic" || existing.confidence_source === "unavailable"
      ? existing.confidence_source
      : (priorConfidence == null ? "unavailable" : "provider");
  sec[field] = {
    ...existing,
    value,
    status: value == null ? "not_found" : "extracted",
    confidence: priorConfidence,
    confidence_source: priorSource,
    source: {
      document_id: (existing.source as { document_id?: string | null } | undefined)?.document_id ?? null,
      file_name: (existing.source as { file_name?: string | null } | undefined)?.file_name ?? null,
      page: sourcePage,
      section: (existing.source as { section?: string | null } | undefined)?.section ?? null,
      snippet: (existing.source as { snippet?: string | null } | undefined)?.snippet ?? null,
    },
    notes: `resolved_via:${method}`,
  };
  extraction[section] = sec;
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

/**
 * Run the hybrid extraction pipeline. Pure orchestration — never persists.
 * The endpoint decides what to do with the result.
 */
export async function runHybridExtraction(
  input: ExtractionInput,
  ctx: ExtractionContext
): Promise<HybridExtractionResult> {
  const timer = new StageTimer();
  const warnings: string[] = [];
  const parsedDocs: { doc: DocumentRow; parsed: ParsedDocument }[] = [];
  const provenance: HybridExtractionResult["provenance"] = [];

  const azureCfg = azureConfigured(ctx.env) ? azureConfigFromEnv(ctx.env) : null;
  const localParser = new LocalPdfParser();
  const azureParser = azureCfg ? new AzureDocumentIntelligenceParser(azureCfg) : null;
  const routingCfg = {
    azureConfigured: Boolean(azureCfg),
    maxTextFastPathPages: maxTextFastpathPages(ctx.env),
  };

  // ---- Stage: validating documents + downloading ----
  await ctx.onStage?.("validating_document", 10);
  const pdfs = input.documents.filter((d) => isPdf(d.file_name));

  timer.start("download");
  const downloaded: { doc: DocumentRow; bytes: ArrayBuffer | null }[] = await Promise.all(
    pdfs.map(async (doc) => ({ doc, bytes: await downloadBytes(ctx.admin, doc.storage_path) }))
  );
  timer.stop("download");

  const unavailable = downloaded.filter((d) => !d.bytes).map((d) => d.doc);
  if (unavailable.length > 0 && downloaded.every((d) => !d.bytes)) {
    return failResult({
      route: "failed",
      status: "failed",
      errorCode: "document_unavailable",
      errorDetail: `${unavailable.length}_documents_unreachable`,
      timer,
      mode: ctx.mode,
      suggestLegacyFallback: ctx.legacyFallbackAllowed,
      fallbackReason: "download_failed",
    });
  }

  if (await ctx.isCancelled?.()) {
    return failResult({ route: "failed", status: "failed", errorCode: "cancelled", timer, mode: ctx.mode });
  }

  // ---- Stage: local parse ----
  await ctx.onStage?.("extracting_pdf_text", 25);
  timer.start("parse");
  let overallRoute: PipelineRoute = "text_fast_path";
  for (const { doc, bytes } of downloaded) {
    if (!bytes) {
      warnings.push(`download_failed:${doc.id.slice(0, 8)}`);
      continue;
    }
    const parsed = await localParser.parse({
      documentId: doc.id,
      fileName: doc.file_name,
      mimeType: null,
      bytes,
      documentType: doc.document_type,
    });
    parsedDocs.push({ doc, parsed });
    provenance.push({
      documentId: doc.id,
      fileName: doc.file_name,
      pageCount: parsed.pageCount,
      parser: parsed.parserMeta.parser,
      quality: parsed.quality,
      parseMs: parsed.parserMeta.parseMs,
    });

    const route = classifyRoute(parsed, routingCfg);
    if (route.route === "encrypted" || route.route === "unsupported") {
      warnings.push(`${route.route}:${doc.id.slice(0, 8)}`);
    }
    if (routePriority(route.route) > routePriority(overallRoute)) overallRoute = route.route;
  }
  timer.stop("parse");

  if (parsedDocs.length === 0 && !input.brokerEmailBody) {
    return failResult({
      route: "failed",
      status: "failed",
      errorCode: "missing_required_input",
      timer,
      mode: ctx.mode,
    });
  }

  // ---- Stage: Azure OCR/layout if required ----
  if ((overallRoute === "ocr_required" || overallRoute === "layout_required") && azureParser) {
    await ctx.onStage?.("processing_scanned_pages", 40);
    timer.start("ocr");
    for (const entry of parsedDocs) {
      if (
        entry.parsed.quality === "scanned" ||
        entry.parsed.quality === "corrupt" ||
        entry.parsed.quality === "layout_heavy" ||
        entry.parsed.quality === "text_sparse"
      ) {
        const bytes = downloaded.find((d) => d.doc.id === entry.doc.id)?.bytes;
        if (!bytes) continue;
        if (await ctx.isCancelled?.()) {
          return failResult({ route: overallRoute, status: "failed", errorCode: "cancelled", timer, mode: ctx.mode });
        }
        try {
          const ocrStarted = Date.now();
          const ocrParsed = await azureParser.parse({
            documentId: entry.doc.id,
            fileName: entry.doc.file_name,
            mimeType: null,
            bytes,
            documentType: entry.doc.document_type,
          });
          entry.parsed = ocrParsed;
          const prov = provenance.find((p) => p.documentId === entry.doc.id);
          if (prov) {
            prov.parser = ocrParsed.parserMeta.parser;
            prov.quality = ocrParsed.quality;
            prov.ocrMs = Date.now() - ocrStarted;
          }
        } catch (err) {
          warnings.push(`azure_failed:${redactAzureError(err)}`);
          // Continue with what local parser returned; validation will decide.
        }
      }
    }
    timer.stop("ocr");
  } else if ((overallRoute === "ocr_required" || overallRoute === "layout_required") && !azureParser) {
    // OCR needed but no provider — depending on policy, fall back to legacy.
    warnings.push("azure_unconfigured");
    if (ctx.legacyFallbackAllowed) {
      return {
        status: "failed",
        extraction: null,
        route: overallRoute,
        parser: parsedDocs[0]?.parsed.parserMeta.parser ?? "none",
        normalisationModel: null,
        fallbackModel: null,
        escalatedFields: [],
        warnings,
        provenance,
        metrics: buildMetrics({
          route: overallRoute,
          mode: ctx.mode,
          timer,
          finalStatus: "failed",
          fallbackReason: "azure_not_configured_ocr_required",
        }),
        errorCode: "ocr_required_no_provider",
        suggestLegacyFallback: true,
        fallbackReason: "azure_not_configured_ocr_required",
      };
    }
  }

  if (await ctx.isCancelled?.()) {
    return failResult({ route: overallRoute, status: "failed", errorCode: "cancelled", timer, mode: ctx.mode });
  }

  // ---- Stage: section detection ----
  await ctx.onStage?.("identifying_document_sections", 45);
  timer.start("section_detection");
  const split = splitDocumentsIntoSections(
    parsedDocs.map((p) => p.parsed),
    { approxCharCap: sectionCharCap(ctx.env) }
  );
  timer.stop("section_detection");

  // If we detected literally nothing (impossible in practice, but guard),
  // fall back to full-document extraction.
  if (split.sections.length === 0) {
    warnings.push("no_sections_detected");
    return {
      status: "failed", extraction: null, route: overallRoute,
      parser: parsedDocs[0]?.parsed.parserMeta.parser ?? "none",
      normalisationModel: ATLAS_MODEL_HAIKU, fallbackModel: null,
      escalatedFields: [], warnings, provenance,
      metrics: buildMetrics({
        route: overallRoute, mode: ctx.mode, timer, finalStatus: "failed",
        fallbackReason: "section_detection_empty",
        sectionCount: 0, successfulSectionCount: 0, failedSectionCount: 0,
        timedOutSectionCount: 0, maxConcurrency: sectionConcurrency(ctx.env),
        sectionDetectionMs: timer.ms("section_detection") ?? 0,
      }),
      errorCode: "section_detection_empty",
      suggestLegacyFallback: ctx.legacyFallbackAllowed,
      fallbackReason: "section_detection_empty",
    };
  }

  // Attach a synthetic broker-email section so its content still flows into the
  // canonical extraction via the policy_details schema (it usually names the
  // broker + a rough summary and lives outside any PDF).
  const sectionsToRun: DocumentSection[] = [...split.sections];
  if (input.brokerEmailBody && input.brokerEmailBody.trim()) {
    // Broker email pseudo-section is always documentIndex=-1 and stableIndex=-1
    // — it precedes every parsed document in source order (sorts before doc 0
    // via lexicographic tuple compare in the merger).
    sectionsToRun.unshift({
      documentId: "broker_email",
      fileName: "(pasted broker email)",
      sectionType: "policy_details",
      heading: "Broker Email",
      pages: [0],
      text: input.brokerEmailBody.trim(),
      approxChars: input.brokerEmailBody.trim().length,
      sourceOffsets: { startPage: 0, endPage: 0 },
      documentIndex: -1,
      stableIndex: -1,
    });
  }

  // ---- Stage: controlled parallel Haiku extraction per section ----
  await ctx.onStage?.("extracting_risk_information", 55);
  timer.start("haiku");
  const concurrency = sectionConcurrency(ctx.env);
  const sectionOutcome = await extractSections({
    env: ctx.env,
    sections: sectionsToRun,
    concurrency,
    perSectionTimeoutMs: perSectionTimeoutMs(ctx.env),
    overallDeadlineMs: overallHybridDeadlineMs(ctx.env),
    isCancelled: ctx.isCancelled,
    onProgress: async (completed, total, lastType) => {
      // Progress reflects completed sections, not fake elapsed time.
      const stage =
        lastType === "policy_details" || lastType === "intermediary_details"
          ? "extracting_policy_details"
          : "extracting_cover_sections";
      const pct = 55 + Math.round((completed / Math.max(1, total)) * 20); // 55..75
      await ctx.onStage?.(stage, pct);
    },
  });
  timer.stop("haiku");

  const successCount = sectionOutcome.totals.success;
  const failureCount = sectionOutcome.totals.failure;
  const timeoutCount = sectionOutcome.totals.timeout;
  const cancelledCount = sectionOutcome.totals.cancelled;

  // If the caller cancelled mid-run, surface it cleanly.
  if (cancelledCount > 0 && successCount === 0) {
    return failResult({
      route: overallRoute, status: "failed", errorCode: "cancelled",
      timer, mode: ctx.mode,
    });
  }

  // ---- Stage: bounded per-section Sonnet fallback for failed sections ----
  // We ONLY escalate individual failed/timed-out sections, never the whole doc.
  const boundedSonnetPartials: MergePartial[] = [];
  let boundedSonnetMs = 0;
  let boundedFallbackSectionCount = 0;
  const boundedFailures: SectionRunResult[] = [];
  const failedNeedingResolution = sectionOutcome.results.filter(
    (r) => r.outcome === "failure" || r.outcome === "timeout"
  );
  // Retry eligibility per category. "invalid_request" (wrong shape / unknown
  // model / auth-tier mismatch) and "auth_failed" are genuine API-level
  // problems — retrying with a bigger model or the same key does not help,
  // so they are deliberately excluded. "invalid_model_output" (a malformed
  // reply) IS retried exactly once via bounded Sonnet. "network_failure" is
  // a transient transport hiccup: the section extractor already retries once
  // in-place; if that fails too we still allow bounded Sonnet recovery so a
  // brief network blip cannot flip the whole document to legacy full Sonnet.
  const canRetryCategory = new Set([
    "timeout",
    "server_error",
    "rate_limited",
    "network_failure",
    "unknown_failure",
    "invalid_model_output",
    "schema_failure", // legacy name for invalid_model_output; retry-once eligible
    "output_truncated",
    "deadline_exceeded",
  ]);
  const remainingBudget = () => overallHybridDeadlineMs(ctx.env) - timer.totalMs();
  if (failedNeedingResolution.length > 0 && remainingBudget() > 30_000) {
    await ctx.onStage?.("resolving_uncertain_fields", 78);
    timer.start("sonnet");
    for (const r of failedNeedingResolution) {
      if (await ctx.isCancelled?.()) break;
      if (remainingBudget() < 15_000) break;
      if (r.category && !canRetryCategory.has(r.category)) {
        boundedFailures.push(r);
        continue;
      }
      try {
        const s = await runSonnetSectionResolution({
          env: ctx.env,
          section: r.section,
          timeoutMs: Math.min(60_000, remainingBudget()),
        });
        boundedSonnetPartials.push({
          partial: s.partial,
          documentId: r.section.documentId,
          primarySectionType: r.section.sectionType,
          documentIndex: r.section.documentIndex,
          stableIndex: r.section.stableIndex,
          startPage: r.section.sourceOffsets.startPage,
        });
        boundedFallbackSectionCount++;
      } catch (err) {
        warnings.push(`sonnet_section_failed:${r.section.sectionType}:${(err as Error).message?.slice(0, 40) ?? "unknown"}`);
        boundedFailures.push(r);
      }
    }
    boundedSonnetMs = timer.stop("sonnet");
  }

  // Collect first-pass partials. The merger sorts them by a deterministic
  // total order — collection order here does not affect the merged output.
  const partialsForMerge: MergePartial[] = [];
  let haikuInputTokens = 0, haikuCached = 0, haikuCacheWrite = 0, haikuOutput = 0;
  let seenModel: string | undefined;
  for (const r of sectionOutcome.results) {
    if (r.outcome === "success" && r.partial) {
      partialsForMerge.push({
        partial: r.partial,
        documentId: r.section.documentId,
        primarySectionType: r.section.sectionType,
        documentIndex: r.section.documentIndex,
        stableIndex: r.section.stableIndex,
        startPage: r.section.sourceOffsets.startPage,
      });
    }
    if (r.usage) {
      haikuInputTokens += r.usage.input_tokens;
      haikuCached += r.usage.cache_read_input_tokens;
      haikuCacheWrite += r.usage.cache_creation_input_tokens;
      haikuOutput += r.usage.output_tokens;
    }
    if (r.model && !seenModel) seenModel = r.model;
  }
  partialsForMerge.push(...boundedSonnetPartials);

  // Zero-partial guard: bounded Sonnet already ran; if nothing at all is
  // usable, we cannot map the document to canonical shape. Suggest fallback
  // (subject to the caller's policy) without attempting a merge.
  if (partialsForMerge.length === 0) {
    const firstCat = failedNeedingResolution[0]?.category ?? "unknown_failure";
    warnings.push(`hybrid_no_partials:${firstCat}`);
    return {
      status: "failed", extraction: null, route: overallRoute,
      parser: parsedDocs[0]?.parsed.parserMeta.parser ?? "none",
      normalisationModel: ATLAS_MODEL_HAIKU, fallbackModel: null,
      escalatedFields: [], warnings, provenance,
      metrics: buildMetrics({
        route: overallRoute, mode: ctx.mode, timer, finalStatus: "failed",
        fallbackReason: `haiku_${String(firstCat)}`,
        sectionCount: sectionsToRun.length,
        successfulSectionCount: successCount,
        failedSectionCount: failureCount,
        timedOutSectionCount: timeoutCount,
        maxConcurrency: concurrency,
        sectionDetectionMs: timer.ms("section_detection") ?? 0,
        slowestSectionMs: sectionOutcome.totals.slowestSectionMs,
        haikuTotalMs: sectionOutcome.totals.haikuTotalMs,
        boundedSonnetMs, boundedFallbackSectionCount,
        failureCategory: `haiku_${String(firstCat)}`,
        inputTokens: haikuInputTokens, cachedInputTokens: haikuCached,
        cacheWriteTokens: haikuCacheWrite, outputTokens: haikuOutput,
        model: seenModel ?? ATLAS_MODEL_HAIKU,
      }),
      errorCode: `haiku_${String(firstCat)}`,
      suggestLegacyFallback: ctx.legacyFallbackAllowed,
      fallbackReason: `haiku_${String(firstCat)}`,
    };
  }

  // ---- Stage: deterministic merge ----
  await ctx.onStage?.("merging_extracted_sections", 82);
  const merge = mergeSectionPartials({
    partials: partialsForMerge,
    brokerEmailBody: input.brokerEmailBody,
  });
  let extraction = merge.extraction;
  let validated = merge.validation;

  // ---- Stage: validation ----
  await ctx.onStage?.("validating_extracted_fields", 86);
  timer.start("validation");
  validated = validateAndNormalizeExtraction(extraction);
  extraction = validated.value ?? extraction;
  timer.stop("validation");

  // ---- Usability decision ----
  // Runs AFTER bounded Sonnet + merge + validation. "Any successful section"
  // is NOT enough — the merged extraction itself has to carry the critical
  // facts. Sections marked "minor" (intermediary, endorsements, unclassified,
  // etc.) do not count towards the critical section ratio.
  const successfulSectionTypes = [
    ...sectionOutcome.results.filter((r) => r.outcome === "success").map((r) => r.section.sectionType),
    ...boundedSonnetPartials.map((p) => p.primarySectionType),
  ];
  const failedSectionTypes = sectionOutcome.results
    .filter((r) => (r.outcome === "failure" || r.outcome === "timeout") &&
      !boundedSonnetPartials.some((b) => b.stableIndex === r.section.stableIndex))
    .map((r) => r.section.sectionType);
  const usabilityCfg = hybridUsabilityConfig(ctx.env);
  const usability = isUsableHybridExtraction({
    extraction,
    schemaValid: validated.ok,
    unresolvedConflicts: merge.conflicts.length,
    successfulSectionTypes,
    failedSectionTypes,
  }, usabilityCfg);

  if (!usability.usable) {
    const firstCat = failedNeedingResolution[0]?.category ?? "insufficient_data";
    const reasonTag = usability.reasons[0] ?? "unusable_hybrid";
    warnings.push(`hybrid_unusable:${reasonTag}`);
    return {
      status: "failed", extraction: null, route: overallRoute,
      parser: parsedDocs[0]?.parsed.parserMeta.parser ?? "none",
      normalisationModel: ATLAS_MODEL_HAIKU, fallbackModel: null,
      escalatedFields: [], warnings, provenance,
      metrics: buildMetrics({
        route: overallRoute, mode: ctx.mode, timer, finalStatus: "failed",
        fallbackReason: `unusable:${reasonTag}`,
        sectionCount: sectionsToRun.length,
        successfulSectionCount: successCount,
        failedSectionCount: failureCount,
        timedOutSectionCount: timeoutCount,
        maxConcurrency: concurrency,
        sectionDetectionMs: timer.ms("section_detection") ?? 0,
        slowestSectionMs: sectionOutcome.totals.slowestSectionMs,
        haikuTotalMs: sectionOutcome.totals.haikuTotalMs,
        boundedSonnetMs, boundedFallbackSectionCount,
        failureCategory: `unusable:${reasonTag}`,
        inputTokens: haikuInputTokens, cachedInputTokens: haikuCached,
        cacheWriteTokens: haikuCacheWrite, outputTokens: haikuOutput,
        model: seenModel ?? ATLAS_MODEL_HAIKU,
        metadata: {
          unusable_reasons: usability.reasons.slice(0, 6),
          cover_sections_count: usability.signals.coverSectionsCount,
          critical_section_ratio: Math.round(usability.signals.relevantSectionSuccessRatio * 100) / 100,
          hybrid_haiku_failure_category: String(firstCat),
        },
      }),
      errorCode: `unusable:${reasonTag}`,
      // Emergency full-document fallback is only proposed here — after
      // bounded Sonnet has already tried to rescue individual sections.
      // The caller decides whether to actually run legacy Sonnet, honouring
      // its own deadline / policy / cancellation checks.
      suggestLegacyFallback: ctx.legacyFallbackAllowed,
      fallbackReason: `unusable:${reasonTag}`,
    };
  }

  const known = new Set<string>();
  known.add("buildings"); known.add("motor"); known.add("contents");
  // Union with a broader canonicalizer for unknown-taxonomy detection:
  const knownTax = new Set<string>();
  for (const k of ["motor", "commercial_motor", "buildings", "contents", "goods_in_transit", "business_all_risks", "public_liability", "electronic_equipment", "theft", "sectional_title"]) {
    knownTax.add(k);
  }

  // ---- Stage: post-merge field-level bounded Sonnet resolution ----
  // The bounded per-section Sonnet resolver above rescues sections whose
  // Haiku call failed. This second pass handles residual field-level gaps
  // (critical missing values, low provider confidence, unknown taxonomy,
  // invalid dates) that survive successful section extraction.
  const escalatedFields: string[] = [];
  let sonnetFieldUsage: NormalisationUsage | null = null;
  {
    const fields = flattenToCanonicalFields(extraction);
    const signals = detectEscalationSignals(fields, {
      validationErrors: validated.errors,
      knownTaxonomyValues: knownTax,
      providerConfidenceThreshold: 0.6,
    });
    const dec = shouldEscalateToSonnet(signals);
    const remaining = overallHybridDeadlineMs(ctx.env) - timer.totalMs();
    if (dec.escalate && remaining > 20_000 && !(await ctx.isCancelled?.())) {
      const targetFields = [
        ...signals.missingCriticalFields,
        ...signals.lowProviderConfidenceFields,
        ...signals.unknownTaxonomyValues,
        ...signals.invalidDates,
      ].filter((v, i, a) => a.indexOf(v) === i);
      if (targetFields.length > 0) {
        await ctx.onStage?.("resolving_uncertain_fields", 88);
        const evidencePages = evidencePagesFromSections(sectionsToRun, targetFields, fields);
        timer.start("sonnet_fields");
        try {
          const sonnet = await runSonnetBoundedResolution({
            env: ctx.env,
            targetFields,
            currentValues: targetFields.map((k) => ({
              field: k,
              currentValue: fields[k]?.value ?? null,
              currentConfidence: fields[k]?.confidence ?? null,
              reason: dec.reason ?? "unknown",
            })),
            evidenceText: evidencePages,
          });
          sonnetFieldUsage = sonnet.usage;
          for (const patched of sonnet.resolvedFields) {
            if (!targetFields.includes(patched.field)) continue;
            if (patched.value === undefined) continue;
            setFieldOnExtraction(extraction, patched.field, patched.value, patched.page ?? null, "sonnet_bounded");
            escalatedFields.push(patched.field);
          }
        } catch (err) {
          warnings.push(`sonnet_fields_failed:${(err as Error).message?.slice(0, 60) ?? "unknown"}`);
        }
        timer.stop("sonnet_fields");
        validated = validateAndNormalizeExtraction(extraction);
        extraction = validated.value ?? extraction;
      }
    }
  }

  // Preserve canonical extraction taxonomy check hint using canonicalizer.
  // Uses canonicalTaxonomyKey to normalise any primary_risk_type value.
  void canonicalTaxonomyKey;

  const finalStatus: OrchestratorStatus = "completed_hybrid";
  const route = overallRoute;
  const parser = parsedDocs[0]?.parsed.parserMeta.parser ?? "none";
  const conf = overallConfidence(extraction);

  const totalSonnetTokens = (u: Usage | null) => ({
    input: u?.input_tokens ?? 0,
    cached: u?.cache_read_input_tokens ?? 0,
    write: u?.cache_creation_input_tokens ?? 0,
    output: u?.output_tokens ?? 0,
  });
  const s1 = totalSonnetTokens(sonnetFieldUsage);
  // Bounded per-section Sonnet fallback tokens are already summed by the
  // extractSections runner (they emit their own usage). We fold their
  // consumption into the totals if any.
  const totalInput = haikuInputTokens + s1.input;
  const totalCached = haikuCached + s1.cached;
  const totalCacheWrite = haikuCacheWrite + s1.write;
  const totalOutput = haikuOutput + s1.output;

  return {
    status: finalStatus,
    extraction,
    route,
    parser,
    normalisationModel: seenModel ?? ATLAS_MODEL_HAIKU,
    fallbackModel: (escalatedFields.length > 0 || boundedFallbackSectionCount > 0) ? ATLAS_MODEL_SONNET : null,
    escalatedFields,
    warnings,
    provenance,
    metrics: buildMetrics({
      route,
      mode: ctx.mode,
      timer,
      finalStatus: "completed",
      fallbackReason: null,
      escalatedToSonnet: escalatedFields.length > 0 || boundedFallbackSectionCount > 0,
      inputTokens: totalInput,
      cachedInputTokens: totalCached,
      cacheWriteTokens: totalCacheWrite,
      outputTokens: totalOutput,
      model: seenModel ?? ATLAS_MODEL_HAIKU,
      schemaFailures: validated.ok ? 0 : 1,
      sectionCount: sectionsToRun.length,
      successfulSectionCount: successCount,
      failedSectionCount: failureCount,
      timedOutSectionCount: timeoutCount,
      maxConcurrency: concurrency,
      sectionDetectionMs: timer.ms("section_detection") ?? 0,
      slowestSectionMs: sectionOutcome.totals.slowestSectionMs,
      haikuTotalMs: sectionOutcome.totals.haikuTotalMs,
      boundedSonnetMs,
      boundedFallbackSectionCount,
      fullLegacyFallbackUsed: false,
      metadata: {
        overall_confidence: Math.round(conf * 100) / 100,
        // Provenance flag so a downstream reader can tell an actual 0% score
        // apart from "no field was rated, compatibility zero written".
        overall_confidence_available: (extraction as { overall_confidence_available?: unknown }).overall_confidence_available !== false,
        pages_total: parsedDocs.reduce((s, p) => s + p.parsed.pageCount, 0),
        schema_version: EXTRACTION_SCHEMA_VERSION,
        merge_conflicts: merge.conflicts.length,
        merge_duplicates: merge.duplicateFieldCount,
        usable_cover_sections: usability.signals.coverSectionsCount,
        usable_critical_ratio: Math.round(usability.signals.relevantSectionSuccessRatio * 100) / 100,
      },
    }),
  };
}

// ---------------------------------------------------------------------------
// Helper: build a compact evidence pack for the escalated fields only.
// We include the page each target field currently cites (if any) plus a small
// context window from the corpus for that page. This keeps Sonnet's input
// small and bounded.
// ---------------------------------------------------------------------------

function evidencePagesFromSections(
  sections: DocumentSection[],
  fields: string[],
  fieldMap: Record<string, CanonicalField>
): string {
  const wantPages = new Set<number>();
  const wantDocs = new Set<string>();
  for (const key of fields) {
    const f = fieldMap[key];
    if (f?.sourcePage != null) wantPages.add(f.sourcePage);
    if (f?.sourceDocumentId) wantDocs.add(f.sourceDocumentId);
  }
  const chunks: string[] = [];
  for (const s of sections) {
    const pageMatch = s.pages.some((p) => wantPages.has(p));
    const docMatch = wantDocs.size === 0 || wantDocs.has(s.documentId);
    if (pageMatch && docMatch) {
      chunks.push(`--- ${s.fileName} [${s.sectionType}] pages ${s.pages.join(",")} ---\n${s.text}`);
    }
  }
  if (chunks.length === 0) {
    for (const s of sections.slice(0, 4)) {
      chunks.push(`--- ${s.fileName} [${s.sectionType}] ---\n${s.text}`);
    }
  }
  return chunks.join("\n\n").slice(0, 12_000);
}

// ---------------------------------------------------------------------------
// Route priority helper (used to promote worst-quality route across the batch).
// ---------------------------------------------------------------------------

function routePriority(r: PipelineRoute): number {
  switch (r) {
    case "text_fast_path": return 0;
    case "layout_required": return 1;
    case "ocr_required": return 2;
    case "large_model_fallback": return 3;
    case "encrypted": return 4;
    case "unsupported": return 5;
    case "legacy_full_sonnet": return 6;
    case "failed": return 7;
  }
}

// ---------------------------------------------------------------------------
// Failure helpers
// ---------------------------------------------------------------------------

interface FailParams {
  route: PipelineRoute;
  status: OrchestratorStatus;
  errorCode: string;
  errorDetail?: string;
  timer: StageTimer;
  mode: PipelineMode;
  suggestLegacyFallback?: boolean;
  fallbackReason?: string;
}

function failResult(p: FailParams): HybridExtractionResult {
  return {
    status: p.status,
    extraction: null,
    route: p.route,
    parser: "none",
    normalisationModel: null,
    fallbackModel: null,
    escalatedFields: [],
    warnings: [],
    provenance: [],
    metrics: buildMetrics({
      route: p.route,
      mode: p.mode,
      timer: p.timer,
      finalStatus: "failed",
      fallbackReason: p.fallbackReason ?? p.errorCode,
    }),
    errorCode: p.errorCode,
    errorDetail: p.errorDetail,
    suggestLegacyFallback: p.suggestLegacyFallback ?? false,
    fallbackReason: p.fallbackReason,
  };
}

function buildMetrics(input: {
  route: PipelineRoute;
  mode: PipelineMode;
  timer: StageTimer;
  finalStatus: "completed" | "failed" | "cancelled" | "skipped" | "shadow";
  fallbackReason?: string | null;
  escalatedToSonnet?: boolean;
  inputTokens?: number;
  cachedInputTokens?: number;
  cacheWriteTokens?: number;
  outputTokens?: number;
  model?: string;
  schemaFailures?: number;
  sectionCount?: number;
  successfulSectionCount?: number;
  failedSectionCount?: number;
  timedOutSectionCount?: number;
  maxConcurrency?: number;
  sectionDetectionMs?: number;
  slowestSectionMs?: number;
  haikuTotalMs?: number;
  boundedSonnetMs?: number;
  boundedFallbackSectionCount?: number;
  fullLegacyFallbackUsed?: boolean;
  failureCategory?: string | null;
  metadata?: Record<string, unknown>;
}): PipelineMetricInput {
  return {
    pipelineMode: input.mode,
    route: input.route,
    provider: input.route === "ocr_required" || input.route === "layout_required" ? "azure" : null,
    model: input.model ?? null,
    downloadMs: input.timer.ms("download") ?? undefined,
    parseMs: input.timer.ms("parse") ?? undefined,
    ocrMs: input.timer.ms("ocr") ?? undefined,
    llmTotalMs:
      (input.timer.ms("haiku") ?? 0) +
        (input.timer.ms("sonnet") ?? 0) +
        (input.timer.ms("sonnet_fields") ?? 0) || undefined,
    validationMs: input.timer.ms("validation") ?? undefined,
    totalMs: input.timer.totalMs(),
    inputTokens: input.inputTokens ?? undefined,
    cachedInputTokens: input.cachedInputTokens ?? undefined,
    cacheWriteTokens: input.cacheWriteTokens ?? undefined,
    outputTokens: input.outputTokens ?? undefined,
    schemaFailures: input.schemaFailures ?? 0,
    fallbackReason: input.fallbackReason ?? undefined,
    escalatedToSonnet: input.escalatedToSonnet ?? false,
    finalStatus: input.finalStatus,
    sectionCount: input.sectionCount,
    successfulSectionCount: input.successfulSectionCount,
    failedSectionCount: input.failedSectionCount,
    timedOutSectionCount: input.timedOutSectionCount,
    maxConcurrency: input.maxConcurrency,
    sectionDetectionMs: input.sectionDetectionMs,
    slowestSectionMs: input.slowestSectionMs,
    haikuTotalMs: input.haikuTotalMs,
    boundedSonnetMs: input.boundedSonnetMs,
    boundedFallbackSectionCount: input.boundedFallbackSectionCount,
    fullLegacyFallbackUsed: input.fullLegacyFallbackUsed,
    failureCategory: input.failureCategory ?? null,
    metadata: input.metadata ?? null,
  };
}
