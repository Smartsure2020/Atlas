/**
 * Atlas hybrid pipeline — shadow mode helpers
 * ----------------------------------------------------------------------------
 * Two responsibilities:
 *
 *   1. Deterministic SAMPLING by input fingerprint. A configurable percentage
 *      (default 0%) of jobs are shadowed. Same fingerprint => same decision,
 *      so a retry never runs a second shadow.
 *
 *   2. Field-level COMPARISON between the authoritative legacy extraction and
 *      the shadow hybrid extraction. Persists AGGREGATE COUNTS only — never
 *      raw values. Row is idempotent per fingerprint.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { PipelineEnv } from "./pipeline-mode.js";
import type { HybridExtractionResult } from "./hybrid-orchestrator.js";

const CRITICAL_FIELDS = [
  "extracted_client.name",
  "extracted_client.risk_address",
  "risk_classification.primary_risk_type",
  "current_cover.cover_sections",
  "current_cover.sums_insured",
  "current_cover.renewal_date",
] as const;

// ---------------------------------------------------------------------------
// Deterministic sampler
// ---------------------------------------------------------------------------

/**
 * FNV-1a 32-bit hash. Compact, fast, no dependencies — good enough for
 * bucketing fingerprints deterministically into [0, 99].
 */
function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function shadowSamplePercent(env: PipelineEnv & { ATLAS_SHADOW_SAMPLE_PERCENT?: string }): number {
  const n = Number(env.ATLAS_SHADOW_SAMPLE_PERCENT);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.trunc(n)));
}

export function shouldShadowThisJob(
  inputFingerprint: string,
  env: PipelineEnv & { ATLAS_SHADOW_SAMPLE_PERCENT?: string }
): boolean {
  const pct = shadowSamplePercent(env);
  if (pct <= 0) return false;
  if (pct >= 100) return true;
  return fnv1a(inputFingerprint) % 100 < pct;
}

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

interface FieldShape { value?: unknown }

function pickField(extraction: Record<string, unknown> | null, dotted: string): unknown {
  if (!extraction) return undefined;
  const [section, field] = dotted.split(".");
  const sec = extraction[section] as Record<string, unknown> | undefined;
  if (!sec) return undefined;
  const raw = sec[field] as FieldShape | undefined;
  if (!raw || typeof raw !== "object") return undefined;
  return raw.value;
}

function canonicalString(v: unknown): string {
  if (v == null) return "";
  if (Array.isArray(v)) return v.map(canonicalString).sort().join("|");
  if (typeof v === "object") return canonicalString(Object.values(v as Record<string, unknown>));
  return String(v).trim().toLowerCase();
}

function fieldsMatch(a: unknown, b: unknown): boolean {
  return canonicalString(a) === canonicalString(b);
}

export interface ShadowComparison {
  criticalMatch: number;
  criticalMismatch: number;
  criticalMissingHybrid: number;
  criticalMissingLegacy: number;
  noncriticalMatch: number;
  noncriticalMismatch: number;
  conflictCount: number;
  unknownTaxonomyCount: number;
  hybridWouldRequireReview: boolean;
}

export function compareExtractions(
  legacy: Record<string, unknown> | null,
  hybrid: Record<string, unknown> | null
): ShadowComparison {
  const cmp: ShadowComparison = {
    criticalMatch: 0, criticalMismatch: 0,
    criticalMissingHybrid: 0, criticalMissingLegacy: 0,
    noncriticalMatch: 0, noncriticalMismatch: 0,
    conflictCount: 0, unknownTaxonomyCount: 0,
    hybridWouldRequireReview: false,
  };
  for (const key of CRITICAL_FIELDS) {
    const l = pickField(legacy, key);
    const h = pickField(hybrid, key);
    const lPresent = l != null && !(typeof l === "string" && !l.trim()) && !(Array.isArray(l) && l.length === 0);
    const hPresent = h != null && !(typeof h === "string" && !h.trim()) && !(Array.isArray(h) && h.length === 0);
    if (!lPresent && !hPresent) continue;
    if (!lPresent) cmp.criticalMissingLegacy++;
    else if (!hPresent) cmp.criticalMissingHybrid++;
    else if (fieldsMatch(l, h)) cmp.criticalMatch++;
    else cmp.criticalMismatch++;
  }

  const conflicts = (hybrid?.conflicts as unknown[]) ?? (legacy?.conflicts as unknown[]) ?? [];
  cmp.conflictCount = Array.isArray(conflicts) ? conflicts.length : 0;

  cmp.hybridWouldRequireReview =
    cmp.criticalMissingHybrid > 0 || cmp.criticalMismatch > 0 || cmp.conflictCount > 0;

  return cmp;
}

// ---------------------------------------------------------------------------
// Persistence (idempotent by input_fingerprint)
// ---------------------------------------------------------------------------

export interface WriteShadowInput {
  admin: SupabaseClient;
  submissionId: string;
  legacyJobId: string | null;
  legacyExtractionId: string | null;
  inputFingerprint: string;
  pipelineVersion: string;
  extractionSchemaVersion?: string | null;
  parserVersion?: string | null;
  normalisationModel?: string | null;
  azureModel?: string | null;
  comparison: ShadowComparison;
  hybrid: HybridExtractionResult;
  legacyTotalMs: number | null;
  legacyInputTokens: number | null;
  legacyOutputTokens: number | null;
  /** Delay (ms) between the legacy response leaving and the shadow run starting. */
  shadowQueueDelayMs?: number | null;
}

export async function writeShadowComparison(input: WriteShadowInput): Promise<void> {
  try {
    // Sanitise the escalated_fields array to names only, and cap length.
    const escalated = (input.hybrid.escalatedFields ?? []).slice(0, 32).map((s) => String(s).slice(0, 60));
    const row = {
      submission_id: input.submissionId,
      legacy_job_id: input.legacyJobId,
      legacy_extraction_id: input.legacyExtractionId,
      input_fingerprint: input.inputFingerprint,
      pipeline_version: input.pipelineVersion,
      extraction_schema_version: input.extractionSchemaVersion ?? null,
      parser_version: input.parserVersion ?? null,
      normalisation_model: input.normalisationModel ?? null,
      azure_model: input.azureModel ?? null,
      critical_field_match_count: input.comparison.criticalMatch,
      critical_field_mismatch_count: input.comparison.criticalMismatch,
      critical_field_missing_hybrid_count: input.comparison.criticalMissingHybrid,
      critical_field_missing_legacy_count: input.comparison.criticalMissingLegacy,
      noncritical_field_match_count: input.comparison.noncriticalMatch,
      noncritical_field_mismatch_count: input.comparison.noncriticalMismatch,
      conflict_count: input.comparison.conflictCount,
      unknown_taxonomy_count: input.comparison.unknownTaxonomyCount,
      escalated_fields: escalated,
      hybrid_route: input.hybrid.route,
      hybrid_fallback_reason: input.hybrid.fallbackReason ?? null,
      hybrid_would_require_review: input.comparison.hybridWouldRequireReview,
      legacy_total_ms: input.legacyTotalMs,
      hybrid_total_ms: input.hybrid.metrics.totalMs ?? null,
      legacy_input_tokens: input.legacyInputTokens,
      legacy_output_tokens: input.legacyOutputTokens,
      hybrid_haiku_input_tokens: input.hybrid.metrics.inputTokens ?? null,
      hybrid_haiku_output_tokens: input.hybrid.metrics.outputTokens ?? null,
      hybrid_sonnet_input_tokens: input.hybrid.escalatedFields.length > 0
        ? input.hybrid.metrics.inputTokens ?? null
        : 0,
      hybrid_sonnet_output_tokens: input.hybrid.escalatedFields.length > 0
        ? input.hybrid.metrics.outputTokens ?? null
        : 0,
      metadata: {
        warnings_count: (input.hybrid.warnings ?? []).length,
        parser: input.hybrid.parser,
        shadow_queue_delay_ms: input.shadowQueueDelayMs ?? null,
      },
    };

    // Insert; on unique-(fingerprint,pipeline_version) conflict skip
    // (idempotent under retry AND across multiple ctx.waitUntil callbacks).
    const { error } = await input.admin
      .from("atlas_pipeline_shadow_comparisons")
      .upsert(row, { onConflict: "input_fingerprint,pipeline_version", ignoreDuplicates: true });
    if (error) console.warn("shadow_comparison_insert_failed", error.message);
  } catch (err) {
    console.warn("shadow_comparison_write_failed", (err as Error)?.message ?? "unknown");
  }
}
