/**
 * Atlas hybrid pipeline — usability decision
 * ----------------------------------------------------------------------------
 * `isUsableHybridExtraction` is the ONLY authority for whether a merged
 * hybrid extraction is safe to return to the consultant, or whether the
 * pipeline should escalate (bounded Sonnet, or — as a last resort — full
 * legacy fallback / human review).
 *
 * The decision runs after: section extraction → bounded per-section Sonnet
 * fallback → deterministic merge → schema validation. It intentionally
 * ignores per-section success ratios by themselves — "one successful section"
 * (e.g. only Intermediary Details) is NOT enough. The check is about the
 * merged CANONICAL extraction, not the pipeline's transport statistics.
 *
 * Rules (all deterministic; nothing here inspects LLM confidence):
 *
 *   Identity      — extracted_client.name (or quote_terms.insured_name).
 *   Insurer       — current_cover.current_insurer (or quote_terms.insurer_name).
 *   Policy id     — quote_terms.quote_reference OR broker-supplied policy #.
 *   Policy type   — risk_classification.primary_risk_type (or product_line).
 *   Policy period — at least one of inception / renewal date, in a parseable
 *                   date format.
 *   Cover         — current_cover.cover_sections MUST contain >=1 usable entry.
 *   Validation    — validateAndNormalizeExtraction() must have returned ok:true.
 *   Conflicts     — unresolved conflicts count is bounded.
 *   Section stats — a MINIMUM ratio of the RELEVANT sections must have
 *                   succeeded (either directly or via bounded Sonnet). "Minor"
 *                   sections do not count towards this ratio.
 *
 * The thresholds are configurable through env; see hybridUsabilityConfig().
 */

import type { PipelineEnv } from "./pipeline-mode.js";
import type { SectionType } from "./section-splitter.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface HybridUsabilityConfig {
  /** Minimum ratio of RELEVANT sections that must have produced usable data. */
  minRelevantSectionRatio: number;
  /** Absolute cap on unresolved conflict entries before the extraction is
   *  considered too noisy for automatic acceptance. */
  maxUnresolvedConflicts: number;
  /** When true, missing (extracted_client.name AND quote_terms.insured_name)
   *  makes the extraction unusable regardless of section success. Default true. */
  requireInsuredIdentity: boolean;
  /** When true, at least one cover_sections entry is required. Default true. */
  requireAtLeastOneCover: boolean;
  /** Set of section types considered CRITICAL for usability accounting. Every
   *  other section is "minor" and its outcome does not gate acceptance. */
  criticalSectionTypes: Set<SectionType>;
  /** Set of section types considered MINOR — informational only. */
  minorSectionTypes: Set<SectionType>;
}

export interface UsabilityEnv extends PipelineEnv {
  ATLAS_HYBRID_MIN_RELEVANT_SECTION_RATIO?: string;   // default "0.5"
  ATLAS_HYBRID_MAX_UNRESOLVED_CONFLICTS?: string;     // default "6"
  ATLAS_HYBRID_REQUIRE_INSURED_IDENTITY?: string;     // default "true"
  ATLAS_HYBRID_REQUIRE_AT_LEAST_ONE_COVER?: string;   // default "true"
}

function numEnv(v: string | undefined, def: number, min: number, max: number): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) return def;
  return n;
}

function boolEnv(v: string | undefined, def: boolean): boolean {
  if (v == null) return def;
  const s = v.trim().toLowerCase();
  if (s === "true" || s === "1" || s === "yes") return true;
  if (s === "false" || s === "0" || s === "no") return false;
  return def;
}

const DEFAULT_CRITICAL: readonly SectionType[] = [
  "policy_details",
  "premium_index",
  "buildings",
  "contents",
  "motor",
  "all_risks",
  "personal_liability",
];

const DEFAULT_MINOR: readonly SectionType[] = [
  "intermediary_details",
  "claims_history",
  "excesses",
  "endorsements",
  "other_cover",
  "unclassified",
];

export function hybridUsabilityConfig(env: UsabilityEnv): HybridUsabilityConfig {
  return {
    minRelevantSectionRatio: numEnv(env.ATLAS_HYBRID_MIN_RELEVANT_SECTION_RATIO, 0.5, 0, 1),
    maxUnresolvedConflicts: numEnv(env.ATLAS_HYBRID_MAX_UNRESOLVED_CONFLICTS, 6, 0, 100),
    requireInsuredIdentity: boolEnv(env.ATLAS_HYBRID_REQUIRE_INSURED_IDENTITY, true),
    requireAtLeastOneCover: boolEnv(env.ATLAS_HYBRID_REQUIRE_AT_LEAST_ONE_COVER, true),
    criticalSectionTypes: new Set(DEFAULT_CRITICAL),
    minorSectionTypes: new Set(DEFAULT_MINOR),
  };
}

// ---------------------------------------------------------------------------
// Signal extractors
// ---------------------------------------------------------------------------

function getField(extraction: Record<string, unknown>, section: string, field: string): { value?: unknown } | undefined {
  const sec = extraction[section];
  if (!sec || typeof sec !== "object") return undefined;
  return (sec as Record<string, unknown>)[field] as { value?: unknown } | undefined;
}

function isPresentScalar(f: { value?: unknown } | undefined): boolean {
  if (!f) return false;
  const v = f.value;
  if (v == null) return false;
  if (typeof v === "string") return v.trim().length > 0;
  return true;
}

function isPresentArray(f: { value?: unknown } | undefined): boolean {
  if (!f) return false;
  return Array.isArray(f.value) && (f.value as unknown[]).length > 0;
}

function firstPresent(...fs: ({ value?: unknown } | undefined)[]): boolean {
  return fs.some((f) => isPresentScalar(f));
}

function isParseableDate(f: { value?: unknown } | undefined): boolean {
  if (!f || typeof f.value !== "string") return false;
  return !Number.isNaN(Date.parse(f.value));
}

// ---------------------------------------------------------------------------
// Decision
// ---------------------------------------------------------------------------

export interface UsabilityInput {
  extraction: Record<string, unknown>;
  /** Whether validateAndNormalizeExtraction() returned ok. */
  schemaValid: boolean;
  /** Count of unresolved conflicts in the merged output. */
  unresolvedConflicts: number;
  /** Per-section outcomes: which SUCCEEDED (either Haiku success OR bounded
   *  Sonnet recovery). Minor sections don't gate acceptance; critical ones do. */
  successfulSectionTypes: SectionType[];
  failedSectionTypes: SectionType[];
  /** Reserved for future explicit signals — pass [] when none. */
  criticalFieldErrors?: string[];
}

export interface UsabilityDecision {
  usable: boolean;
  /** Short, privacy-safe reason enum. Never contains PII / field values. */
  reasons: string[];
  /** Structured signals the decision was made from. Numbers/booleans only. */
  signals: {
    hasInsuredIdentity: boolean;
    hasInsurer: boolean;
    hasPolicyId: boolean;
    hasPolicyType: boolean;
    hasPolicyPeriod: boolean;
    coverSectionsCount: number;
    schemaValid: boolean;
    unresolvedConflicts: number;
    relevantSectionSuccessRatio: number;
    criticalFieldErrorCount: number;
  };
}

export function isUsableHybridExtraction(
  input: UsabilityInput,
  cfg: HybridUsabilityConfig
): UsabilityDecision {
  const { extraction } = input;

  // Identity — merger writes to extracted_client.name OR quote_terms.insured_name
  // depending on section source. Either satisfies identity.
  const clientName = getField(extraction, "extracted_client", "name");
  const insuredName = getField(extraction, "quote_terms", "insured_name");
  const hasInsuredIdentity = firstPresent(clientName, insuredName);

  const currentInsurer = getField(extraction, "current_cover", "current_insurer");
  const quoteInsurer = getField(extraction, "quote_terms", "insurer_name");
  const hasInsurer = firstPresent(currentInsurer, quoteInsurer);

  const quoteRef = getField(extraction, "quote_terms", "quote_reference");
  const hasPolicyId = isPresentScalar(quoteRef);

  const primaryRisk = getField(extraction, "risk_classification", "primary_risk_type");
  const productLine = getField(extraction, "risk_classification", "product_line");
  const hasPolicyType = firstPresent(primaryRisk, productLine);

  const renewal = getField(extraction, "current_cover", "renewal_date");
  const quoteDate = getField(extraction, "quote_terms", "quote_date");
  const quoteExpiry = getField(extraction, "quote_terms", "quote_expiry_date");
  const hasPolicyPeriod =
    isParseableDate(renewal) || isParseableDate(quoteDate) || isParseableDate(quoteExpiry);

  const coverSections = getField(extraction, "current_cover", "cover_sections");
  const coverSectionsCount = isPresentArray(coverSections)
    ? (coverSections!.value as unknown[]).length
    : 0;

  // Relevant-section success ratio uses ONLY critical section types.
  const criticalSuccess = input.successfulSectionTypes.filter((t) => cfg.criticalSectionTypes.has(t));
  const criticalFailed = input.failedSectionTypes.filter((t) => cfg.criticalSectionTypes.has(t));
  const criticalDenominator = criticalSuccess.length + criticalFailed.length;
  const relevantSectionSuccessRatio = criticalDenominator === 0
    ? 1                                    // No critical sections attempted → not a hybrid failure.
    : criticalSuccess.length / criticalDenominator;

  const reasons: string[] = [];
  if (cfg.requireInsuredIdentity && !hasInsuredIdentity) reasons.push("missing_insured_identity");
  if (!hasInsurer) reasons.push("missing_insurer");
  if (!hasPolicyId) reasons.push("missing_policy_id");
  if (!hasPolicyType) reasons.push("missing_policy_type");
  if (!hasPolicyPeriod) reasons.push("missing_policy_period");
  if (cfg.requireAtLeastOneCover && coverSectionsCount === 0) reasons.push("no_cover_sections");
  if (!input.schemaValid) reasons.push("schema_invalid");
  if (input.unresolvedConflicts > cfg.maxUnresolvedConflicts) reasons.push("too_many_conflicts");
  if (relevantSectionSuccessRatio < cfg.minRelevantSectionRatio) reasons.push("insufficient_critical_section_coverage");
  if ((input.criticalFieldErrors?.length ?? 0) > 0) reasons.push("critical_field_errors");

  return {
    usable: reasons.length === 0,
    reasons,
    signals: {
      hasInsuredIdentity,
      hasInsurer,
      hasPolicyId,
      hasPolicyType,
      hasPolicyPeriod,
      coverSectionsCount,
      schemaValid: input.schemaValid,
      unresolvedConflicts: input.unresolvedConflicts,
      relevantSectionSuccessRatio,
      criticalFieldErrorCount: input.criticalFieldErrors?.length ?? 0,
    },
  };
}
