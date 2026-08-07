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
  EXTRACTION_MODEL,
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
  type PipelineEnv,
  type PipelineMode,
} from "./pipeline-mode.js";
import { StageTimer, type PipelineMetricInput } from "./pipeline-telemetry.js";
import { canonicalTaxonomyKey } from "./taxonomy.js";
import {
  runHaikuNormalisation,
  runSonnetBoundedResolution,
  type NormalisationUsage,
} from "./hybrid-llm.js";

const CLIENT_DOCS_BUCKET = "atlas-client-docs";
const MAX_ESCALATION_ATTEMPTS = 1;

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
  env: Env & PipelineEnv;
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

/**
 * Concatenate parsed documents into a Haiku-friendly text corpus with clear
 * per-document / per-page delimiters. Haiku sees TEXT — never the raw PDF.
 */
function assembleCorpus(
  brokerEmail: string | null,
  parsed: { doc: DocumentRow; parsed: ParsedDocument }[]
): string {
  const lines: string[] = [];
  if (brokerEmail && brokerEmail.trim()) {
    lines.push("=== BROKER EMAIL (pasted at intake) ===");
    lines.push(brokerEmail.trim());
    lines.push("");
  }
  for (const { doc, parsed: p } of parsed) {
    lines.push(`=== SOURCE DOCUMENT ===`);
    lines.push(`document_id: ${doc.id}`);
    lines.push(`file_name: ${doc.file_name}`);
    lines.push(`document_type: ${doc.document_type ?? "unknown"}`);
    lines.push(`parser: ${p.parserMeta.parser}`);
    lines.push(`quality: ${p.quality}`);
    lines.push("");
    for (const page of p.pages) {
      lines.push(`--- page ${page.page} ---`);
      if (page.text.trim()) lines.push(page.text.trim());
      else lines.push("(no extractable text on this page)");
      lines.push("");
    }
    if (p.tables.length > 0) {
      lines.push(`--- tables (${p.tables.length}) ---`);
      for (const t of p.tables) {
        lines.push(`table on page ${t.page}:`);
        for (const row of t.rows) lines.push("  | " + row.join(" | ") + " |");
      }
      lines.push("");
    }
  }
  return lines.join("\n");
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
  sec[field] = {
    ...existing,
    value,
    status: value == null ? "not_found" : "extracted",
    confidence: existing.confidence ?? 0.7,
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

  // ---- Stage: Haiku normalisation ----
  await ctx.onStage?.("extracting_risk_information", 55);
  const corpus = assembleCorpus(input.brokerEmailBody, parsedDocs);
  timer.start("haiku");
  let normalisation: { extraction: Record<string, unknown>; usage: NormalisationUsage; model: string };
  try {
    normalisation = await runHaikuNormalisation({
      env: ctx.env,
      corpus,
      documentIds: parsedDocs.map((p) => p.doc.id),
      brokerEmailPresent: Boolean(input.brokerEmailBody),
    });
  } catch (err) {
    warnings.push(`haiku_failed:${(err as Error).message?.slice(0, 60) ?? "unknown"}`);
    return {
      status: "failed",
      extraction: null,
      route: overallRoute,
      parser: parsedDocs[0]?.parsed.parserMeta.parser ?? "none",
      normalisationModel: "claude-haiku-4-5",
      fallbackModel: null,
      escalatedFields: [],
      warnings,
      provenance,
      metrics: buildMetrics({
        route: overallRoute,
        mode: ctx.mode,
        timer,
        finalStatus: "failed",
        fallbackReason: "haiku_call_failed",
      }),
      errorCode: "haiku_call_failed",
      suggestLegacyFallback: ctx.legacyFallbackAllowed,
      fallbackReason: "haiku_call_failed",
    };
  }
  timer.stop("haiku");

  // ---- Stage: validation ----
  await ctx.onStage?.("validating_extracted_fields", 70);
  timer.start("validation");
  let validated = validateAndNormalizeExtraction(normalisation.extraction);
  let extraction = validated.value ?? normalisation.extraction;
  timer.stop("validation");

  const known = new Set<string>();
  known.add("buildings"); known.add("motor"); known.add("contents");
  // Union with a broader canonicalizer for unknown-taxonomy detection:
  const knownTax = new Set<string>();
  for (const k of ["motor", "commercial_motor", "buildings", "contents", "goods_in_transit", "business_all_risks", "public_liability", "electronic_equipment", "theft", "sectional_title"]) {
    knownTax.add(k);
  }

  // ---- Stage: escalation to bounded Sonnet ----
  const escalatedFields: string[] = [];
  let sonnetUsage: NormalisationUsage | null = null;
  let sonnetAttempts = 0;
  while (sonnetAttempts < MAX_ESCALATION_ATTEMPTS) {
    const fields = flattenToCanonicalFields(extraction);
    const signals = detectEscalationSignals(fields, {
      validationErrors: validated.errors,
      knownTaxonomyValues: knownTax,
      providerConfidenceThreshold: 0.6,
    });
    const dec = shouldEscalateToSonnet(signals);
    if (!dec.escalate) break;

    await ctx.onStage?.("resolving_uncertain_fields", 82);
    if (await ctx.isCancelled?.()) break;

    const targetFields = [
      ...signals.missingCriticalFields,
      ...signals.lowProviderConfidenceFields,
      ...signals.unknownTaxonomyValues,
      ...signals.invalidDates,
    ].filter((v, i, a) => a.indexOf(v) === i);
    if (targetFields.length === 0) break;

    // Build a page-scoped evidence pack for ONLY the affected fields.
    const evidencePages = evidencePagesFor(parsedDocs, targetFields, fields, corpus);
    timer.start("sonnet");
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
      sonnetUsage = sonnet.usage;

      // Merge ONLY the requested fields, and only if Sonnet returned a value.
      for (const patched of sonnet.resolvedFields) {
        if (!targetFields.includes(patched.field)) continue; // reject out-of-scope changes
        if (patched.value === undefined) continue;
        setFieldOnExtraction(extraction, patched.field, patched.value, patched.page ?? null, "sonnet_bounded");
        escalatedFields.push(patched.field);
      }
    } catch (err) {
      warnings.push(`sonnet_failed:${(err as Error).message?.slice(0, 60) ?? "unknown"}`);
    }
    timer.stop("sonnet");

    // Re-validate after merge.
    validated = validateAndNormalizeExtraction(extraction);
    extraction = validated.value ?? extraction;
    sonnetAttempts++;
    // One attempt is the ceiling; break regardless.
    break;
  }

  // Preserve canonical extraction taxonomy check hint using canonicalizer.
  // Uses canonicalTaxonomyKey to normalise any primary_risk_type value.
  void canonicalTaxonomyKey;

  const finalStatus: OrchestratorStatus = "completed_hybrid";
  const route = overallRoute;
  const parser = parsedDocs[0]?.parsed.parserMeta.parser ?? "none";
  const conf = overallConfidence(extraction);

  return {
    status: finalStatus,
    extraction,
    route,
    parser,
    normalisationModel: normalisation.model,
    fallbackModel: escalatedFields.length > 0 ? EXTRACTION_MODEL : null,
    escalatedFields,
    warnings,
    provenance,
    metrics: buildMetrics({
      route,
      mode: ctx.mode,
      timer,
      finalStatus: "completed",
      fallbackReason: null,
      escalatedToSonnet: escalatedFields.length > 0,
      inputTokens: normalisation.usage.input_tokens + (sonnetUsage?.input_tokens ?? 0),
      cachedInputTokens: normalisation.usage.cache_read_input_tokens + (sonnetUsage?.cache_read_input_tokens ?? 0),
      cacheWriteTokens: normalisation.usage.cache_creation_input_tokens + (sonnetUsage?.cache_creation_input_tokens ?? 0),
      outputTokens: normalisation.usage.output_tokens + (sonnetUsage?.output_tokens ?? 0),
      model: normalisation.model,
      schemaFailures: validated.ok ? 0 : 1,
      metadata: {
        overall_confidence: Math.round(conf * 100) / 100,
        pages_total: parsedDocs.reduce((s, p) => s + p.parsed.pageCount, 0),
        schema_version: EXTRACTION_SCHEMA_VERSION,
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

function evidencePagesFor(
  parsedDocs: { doc: DocumentRow; parsed: ParsedDocument }[],
  fields: string[],
  fieldMap: Record<string, CanonicalField>,
  fullCorpus: string
): string {
  const wantPages = new Set<string>();
  for (const key of fields) {
    const f = fieldMap[key];
    if (f?.sourceDocumentId && f.sourcePage != null) {
      wantPages.add(`${f.sourceDocumentId}:${f.sourcePage}`);
    }
  }
  if (wantPages.size === 0) {
    // No source-page hints from Haiku; give Sonnet a small slice of the corpus
    // (first 6000 chars) rather than the full document set.
    return fullCorpus.slice(0, 6000);
  }
  const chunks: string[] = [];
  for (const { doc, parsed } of parsedDocs) {
    for (const page of parsed.pages) {
      if (wantPages.has(`${doc.id}:${page.page}`)) {
        chunks.push(`--- ${doc.file_name} page ${page.page} ---\n${page.text}`);
      }
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
    llmTotalMs: (input.timer.ms("haiku") ?? 0) + (input.timer.ms("sonnet") ?? 0) || undefined,
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
    metadata: input.metadata ?? null,
  };
}
