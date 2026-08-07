/**
 * Atlas hybrid pipeline — routing decisions
 * ----------------------------------------------------------------------------
 * Turns a ParsedDocument (from any parser) into a PipelineRoute, and decides
 * when the deterministic Haiku extraction should escalate to Sonnet. All
 * decisions here are deterministic: no LLM confidence, no vibes. This is what
 * lets us keep Sonnet as the EXCEPTION, not the default.
 */

import type { CanonicalField, ParsedDocument, RouteDecision } from "./pipeline-types.js";

export interface RoutingConfig {
  /** Providers configured for this Worker; drives what routes are reachable. */
  azureConfigured: boolean;
  /** Text-based PDFs shorter than this get the fast path even if unpdf isn't installed. */
  maxTextFastPathPages: number;
  /** Explicit legacy override — always false in hybrid mode. */
  forceLegacy?: boolean;
}

export function classifyRoute(doc: ParsedDocument, cfg: RoutingConfig): RouteDecision {
  if (cfg.forceLegacy) {
    return { route: "legacy_full_sonnet", reason: "forced_legacy_mode" };
  }
  switch (doc.quality) {
    case "encrypted":
      return { route: "encrypted", reason: "pdf_encrypted" };
    case "unsupported":
      return { route: "unsupported", reason: "unsupported_format" };
    case "empty":
      return { route: "failed", reason: "empty_document" };
    case "corrupt":
      // Corrupt local parse is a legitimate reason to try OCR when possible.
      return cfg.azureConfigured
        ? { route: "ocr_required", reason: "local_parse_corrupt" }
        : { route: "legacy_full_sonnet", reason: "corrupt_no_ocr_provider" };
    case "scanned":
      return cfg.azureConfigured
        ? { route: "ocr_required", reason: "scanned_needs_ocr" }
        : { route: "legacy_full_sonnet", reason: "scanned_no_ocr_provider" };
    case "layout_heavy":
      return cfg.azureConfigured
        ? { route: "layout_required", reason: "layout_needs_provider" }
        : { route: "text_fast_path", reason: "layout_hint_no_provider" };
    case "text_sparse":
      return cfg.azureConfigured
        ? { route: "ocr_required", reason: "text_sparse_below_threshold" }
        : { route: "text_fast_path", reason: "sparse_text_no_ocr_fallback" };
    case "text_clean":
    default:
      if (doc.pageCount > cfg.maxTextFastPathPages) {
        return { route: "large_model_fallback", reason: "page_count_exceeds_fast_path" };
      }
      return { route: "text_fast_path", reason: "text_extraction_clean" };
  }
}

// ---------------------------------------------------------------------------
// Deterministic escalation signals — why we call Sonnet on top of Haiku.
// ---------------------------------------------------------------------------

export interface EscalationSignals {
  missingCriticalFields: string[];
  schemaValidationErrors: string[];
  conflictingValues: string[];
  lowProviderConfidenceFields: string[];
  businessRuleFailures: string[];
  unknownTaxonomyValues: string[];
  invalidDates: string[];
}

const CRITICAL_FIELDS = [
  "extracted_client.name",
  "risk_classification.primary_risk_type",
  "current_cover.cover_sections",
  "current_cover.sums_insured",
];

export function detectEscalationSignals(
  fields: Record<string, CanonicalField | undefined>,
  extras: {
    validationErrors?: string[];
    knownTaxonomyValues?: Set<string>;
    providerConfidenceThreshold?: number;
  } = {}
): EscalationSignals {
  const missing: string[] = [];
  const lowConf: string[] = [];
  const unknownTax: string[] = [];
  const invalidDates: string[] = [];
  const threshold = extras.providerConfidenceThreshold ?? 0.6;

  for (const key of CRITICAL_FIELDS) {
    const f = fields[key];
    if (!f || f.value == null || (typeof f.value === "string" && !f.value.trim())) {
      missing.push(key);
    } else if (f.confidence != null && f.confidence < threshold) {
      lowConf.push(key);
    }
  }

  const taxKey = "risk_classification.primary_risk_type";
  const primary = fields[taxKey]?.value;
  if (
    extras.knownTaxonomyValues &&
    typeof primary === "string" &&
    primary.trim() &&
    !extras.knownTaxonomyValues.has(primary.trim().toLowerCase())
  ) {
    unknownTax.push(taxKey);
  }

  for (const [k, f] of Object.entries(fields)) {
    if (!f) continue;
    if (/date/.test(k) && typeof f.value === "string" && f.value.trim()) {
      if (Number.isNaN(Date.parse(f.value))) invalidDates.push(k);
    }
  }

  return {
    missingCriticalFields: missing,
    schemaValidationErrors: extras.validationErrors ?? [],
    conflictingValues: [],
    lowProviderConfidenceFields: lowConf,
    businessRuleFailures: [],
    unknownTaxonomyValues: unknownTax,
    invalidDates,
  };
}

export function shouldEscalateToSonnet(sig: EscalationSignals): { escalate: boolean; reason: string | null } {
  if (sig.missingCriticalFields.length > 0) {
    return { escalate: true, reason: `missing_critical:${sig.missingCriticalFields[0]}` };
  }
  if (sig.schemaValidationErrors.length > 0) {
    return { escalate: true, reason: "schema_validation_failed" };
  }
  if (sig.conflictingValues.length > 0) {
    return { escalate: true, reason: "conflicting_values" };
  }
  if (sig.lowProviderConfidenceFields.length > 0) {
    return { escalate: true, reason: "low_provider_confidence" };
  }
  if (sig.unknownTaxonomyValues.length > 0) {
    return { escalate: true, reason: "unknown_taxonomy_value" };
  }
  if (sig.invalidDates.length > 0) {
    return { escalate: true, reason: "invalid_date_format" };
  }
  if (sig.businessRuleFailures.length > 0) {
    return { escalate: true, reason: "business_rule_failure" };
  }
  return { escalate: false, reason: null };
}
