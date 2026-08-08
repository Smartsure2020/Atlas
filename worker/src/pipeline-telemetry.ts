/**
 * Atlas hybrid pipeline — telemetry emitter
 * ----------------------------------------------------------------------------
 * Provider-neutral: knows nothing about Anthropic, Azure, unpdf, or Supabase
 * internals. Callers hand it a plain object; it writes to atlas_pipeline_metrics.
 *
 * Privacy contract:
 *   - NEVER accept or persist document text, PII, or free-form user content.
 *   - Only numeric durations, integer token counts, short enum-like route
 *     labels, and short provider-diagnostic strings that have been redacted
 *     upstream.
 *   - Insertion failures are logged, never thrown. Metrics must not break
 *     production paths.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

export type PipelineMode = "legacy" | "hybrid" | "shadow";

export type PipelineRoute =
  | "text_fast_path"
  | "ocr_required"
  | "layout_required"
  | "large_model_fallback"
  | "legacy_full_sonnet"
  | "unsupported"
  | "encrypted"
  | "failed";

export type FinalStatus = "completed" | "failed" | "cancelled" | "skipped" | "shadow";

export interface PipelineMetricInput {
  jobId?: string | null;
  submissionId?: string | null;
  documentId?: string | null;

  pipelineMode: PipelineMode;
  route: PipelineRoute;
  provider?: string | null;
  model?: string | null;

  documentType?: string | null;
  documentHash?: string | null; // full hash; we'll truncate
  pageCount?: number | null;
  fileSizeBytes?: number | null;

  queueMs?: number | null;
  downloadMs?: number | null;
  parseMs?: number | null;
  ocrMs?: number | null;
  llmTtftMs?: number | null;
  llmTotalMs?: number | null;
  validationMs?: number | null;
  matchingMs?: number | null;
  totalMs?: number | null;

  inputTokens?: number | null;
  cachedInputTokens?: number | null;
  cacheWriteTokens?: number | null;
  outputTokens?: number | null;

  retryCount?: number;
  schemaFailures?: number;
  fallbackReason?: string | null;
  escalatedToSonnet?: boolean;
  finalStatus: FinalStatus;

  // Section-based extraction telemetry. Persisted via the sanitized metadata
  // bag so no schema migration is required; every value here is a scalar and
  // safe under the PII allow-list.
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
  /** Redacted category enum, e.g. `haiku_timeout` / `haiku_rate_limited`. */
  failureCategory?: string | null;

  metadata?: Record<string, unknown> | null;
}

const MAX_ROUTE = 32;
const MAX_REASON = 120;

function short(v: string | null | undefined, max: number): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  return s.length > max ? s.slice(0, max) : s;
}

function intOrNull(v: number | null | undefined): number | null {
  return typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : null;
}

/**
 * Strip anything that looks like free-form document/PII from the metadata bag.
 * We intentionally keep only known numeric keys and boolean flags. Strings are
 * preserved only when they match an allow-list of short provider diagnostic
 * codes AND the key does not look like a PII holder.
 */
const PII_KEY_PATTERN =
  /(?:^|_)(?:name|email|phone|address|id_number|passport|ssn|dob|birthdate|surname|firstname|lastname|contact|snippet|text|body|content|description|note|value|raw)(?:$|_)/i;

function sanitizeMetadata(md: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (!md) return null;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(md)) {
    if (v == null) continue;
    if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
    else if (typeof v === "boolean") out[k] = v;
    else if (typeof v === "string" && v.length <= 80 && !/[\r\n]/.test(v) && !PII_KEY_PATTERN.test(k)) {
      out[k] = v;
    } else if (Array.isArray(v) && v.every((x) => typeof x === "string" && x.length <= 40) && !PII_KEY_PATTERN.test(k)) {
      out[k] = v.slice(0, 10);
    }
    // objects, long strings, unknown shapes, PII-shaped keys: dropped by design
  }
  return Object.keys(out).length > 0 ? out : null;
}

export async function emitPipelineMetric(
  admin: SupabaseClient,
  input: PipelineMetricInput
): Promise<void> {
  try {
    const hashPrefix = input.documentHash ? String(input.documentHash).slice(0, 12) : null;
    // Fold section-based counters into a safe metadata bag so no schema
    // migration is needed. Keys are scalar and under the PII allow-list.
    const sectionMeta: Record<string, unknown> = {};
    if (input.sectionCount != null) sectionMeta.section_count = intOrNull(input.sectionCount) ?? 0;
    if (input.successfulSectionCount != null) sectionMeta.section_success = intOrNull(input.successfulSectionCount) ?? 0;
    if (input.failedSectionCount != null) sectionMeta.section_failure = intOrNull(input.failedSectionCount) ?? 0;
    if (input.timedOutSectionCount != null) sectionMeta.section_timeout = intOrNull(input.timedOutSectionCount) ?? 0;
    if (input.maxConcurrency != null) sectionMeta.section_concurrency = intOrNull(input.maxConcurrency) ?? 0;
    if (input.sectionDetectionMs != null) sectionMeta.section_detection_ms = intOrNull(input.sectionDetectionMs) ?? 0;
    if (input.slowestSectionMs != null) sectionMeta.slowest_section_ms = intOrNull(input.slowestSectionMs) ?? 0;
    if (input.haikuTotalMs != null) sectionMeta.haiku_total_ms = intOrNull(input.haikuTotalMs) ?? 0;
    if (input.boundedSonnetMs != null) sectionMeta.bounded_sonnet_ms = intOrNull(input.boundedSonnetMs) ?? 0;
    if (input.boundedFallbackSectionCount != null) sectionMeta.bounded_fallback_sections = intOrNull(input.boundedFallbackSectionCount) ?? 0;
    if (input.fullLegacyFallbackUsed != null) sectionMeta.full_legacy_fallback_used = Boolean(input.fullLegacyFallbackUsed);
    if (input.failureCategory) sectionMeta.failure_category = short(input.failureCategory, 40);
    const mergedMetadata = { ...(input.metadata ?? {}), ...sectionMeta };
    const row = {
      job_id: input.jobId ?? null,
      submission_id: input.submissionId ?? null,
      document_id: input.documentId ?? null,
      pipeline_mode: input.pipelineMode,
      route: short(input.route, MAX_ROUTE) ?? "failed",
      provider: short(input.provider, 32),
      model: short(input.model, 64),
      document_type: short(input.documentType, 32),
      document_hash_prefix: hashPrefix,
      page_count: intOrNull(input.pageCount),
      file_size_bytes: intOrNull(input.fileSizeBytes),
      queue_ms: intOrNull(input.queueMs),
      download_ms: intOrNull(input.downloadMs),
      parse_ms: intOrNull(input.parseMs),
      ocr_ms: intOrNull(input.ocrMs),
      llm_ttft_ms: intOrNull(input.llmTtftMs),
      llm_total_ms: intOrNull(input.llmTotalMs),
      validation_ms: intOrNull(input.validationMs),
      matching_ms: intOrNull(input.matchingMs),
      total_ms: intOrNull(input.totalMs),
      input_tokens: intOrNull(input.inputTokens),
      cached_input_tokens: intOrNull(input.cachedInputTokens),
      cache_write_tokens: intOrNull(input.cacheWriteTokens),
      output_tokens: intOrNull(input.outputTokens),
      retry_count: intOrNull(input.retryCount) ?? 0,
      schema_failures: intOrNull(input.schemaFailures) ?? 0,
      fallback_reason: short(input.fallbackReason, MAX_REASON),
      escalated_to_sonnet: Boolean(input.escalatedToSonnet),
      final_status: input.finalStatus,
      metadata: sanitizeMetadata(mergedMetadata),
    };
    await admin.from("atlas_pipeline_metrics").insert(row);
  } catch (err) {
    // Metrics must never break the caller.
    console.warn("pipeline_metric_emit_failed", (err as Error)?.message ?? "unknown");
  }
}

/** Simple stopwatch for structured per-stage measurement. */
export class StageTimer {
  private stages = new Map<string, number>();
  private started = new Map<string, number>();
  private readonly t0 = Date.now();

  start(name: string): void {
    this.started.set(name, Date.now());
  }

  stop(name: string): number {
    const started = this.started.get(name);
    if (started === undefined) return 0;
    const elapsed = Date.now() - started;
    this.stages.set(name, (this.stages.get(name) ?? 0) + elapsed);
    this.started.delete(name);
    return elapsed;
  }

  ms(name: string): number | null {
    return this.stages.has(name) ? Math.trunc(this.stages.get(name)!) : null;
  }

  totalMs(): number {
    return Date.now() - this.t0;
  }
}
