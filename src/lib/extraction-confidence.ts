/**
 * Atlas — extraction-confidence semantics (frontend)
 * ----------------------------------------------------------------------------
 * One resolver, one formatter, one shape. Every UI surface that shows the
 * overall extraction confidence must go through this file so that the four
 * distinct scenarios stay distinct on screen:
 *
 *   provider-rated 0 available  →  0% · Provider rating available
 *   provider-rated 0.4 available →  40% · Provider rating available
 *   explicitly unavailable      →  Unavailable — no percentage
 *   legacy row with valid number →  legacy number, labelled Legacy rating
 *   legacy row without number    →  Not recorded — never invented as 70%
 *
 * The precedence mirrors the Worker (see worker/src/recommendation-endpoints.ts)
 * so the ranking pipeline and the underwriter workbench cannot disagree:
 *
 *   1. reviewed_json explicit availability flag
 *   2. valid reviewed_json overall_confidence, respecting an extracted
 *      explicit-unavailable flag unless the reviewer explicitly overrides it
 *   3. extracted_json explicit availability flag
 *   4. valid extracted_json overall_confidence
 *   5. valid extraction_confidence compatibility column (legacy)
 *   6. otherwise not_recorded  — the frontend NEVER invents 0.7
 *
 * `overall_confidence_source` is used only for provenance labelling. A
 * malformed source string must not override an explicit availability flag.
 */

export interface ExtractionRecordLike {
  extracted_json: Record<string, unknown> | null;
  reviewed_json: Record<string, unknown> | null;
  extraction_confidence?: number | null;
}

export type ExtractionConfidenceSource =
  | "provider"
  | "reviewed"
  | "legacy"
  | "unavailable";

export type ExtractionConfidenceState =
  | {
      state: "available";
      value: number;
      source: "provider" | "reviewed" | "legacy";
      available: true;
    }
  | {
      state: "unavailable";
      value: null;
      source: "unavailable";
      available: false;
    }
  | {
      state: "not_recorded";
      value: null;
      source: "legacy";
      available: null;
    };

function isValidRatio(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function readFlag(json: Record<string, unknown> | null, key: string): boolean | undefined {
  if (!json || typeof json !== "object") return undefined;
  const value = json[key];
  if (value === true) return true;
  if (value === false) return false;
  return undefined;
}

function readNumber(json: Record<string, unknown> | null, key: string): unknown {
  if (!json || typeof json !== "object") return undefined;
  return json[key];
}

function readSource(json: Record<string, unknown> | null): string | null {
  if (!json || typeof json !== "object") return null;
  const raw = json.overall_confidence_source;
  return typeof raw === "string" ? raw : null;
}

/**
 * Resolve extraction confidence for a UI surface.
 *
 * Zero is valid. Truthiness checks must not be used to infer availability.
 * `overall_confidence_source` is provenance only and cannot override an
 * explicit availability flag.
 */
export function resolveExtractionConfidence(
  extraction: ExtractionRecordLike | null | undefined
): ExtractionConfidenceState {
  if (!extraction) {
    return { state: "not_recorded", value: null, source: "legacy", available: null };
  }

  const reviewed = extraction.reviewed_json;
  const extracted = extraction.extracted_json;

  const reviewedFlag = readFlag(reviewed, "overall_confidence_available");
  const extractedFlag = readFlag(extracted, "overall_confidence_available");

  // 1. Reviewer's explicit "unavailable" wins outright.
  if (reviewedFlag === false) {
    return { state: "unavailable", value: null, source: "unavailable", available: false };
  }

  // 2. Reviewer's numeric value, respecting an extracted explicit-unavailable
  //    only when the reviewer did NOT explicitly override it with `true`.
  const reviewedNumber = readNumber(reviewed, "overall_confidence");
  if (isValidRatio(reviewedNumber)) {
    if (reviewedFlag !== true && extractedFlag === false) {
      return { state: "unavailable", value: null, source: "unavailable", available: false };
    }
    return { state: "available", value: reviewedNumber, source: "reviewed", available: true };
  }

  // 3. Extracted explicit "unavailable" wins over legacy numbers.
  if (extractedFlag === false) {
    return { state: "unavailable", value: null, source: "unavailable", available: false };
  }

  // 4. Extracted numeric — provider provenance unless the source is missing.
  const extractedNumber = readNumber(extracted, "overall_confidence");
  if (isValidRatio(extractedNumber)) {
    const rawSource = readSource(extracted);
    // A malformed source string does NOT override the availability we just
    // resolved. It only refines the provenance label from provider → provider.
    const source: "provider" | "reviewed" | "legacy" =
      rawSource === "reviewed" ? "reviewed" : "provider";
    return { state: "available", value: extractedNumber, source, available: true };
  }

  // 5. Legacy compatibility column: valid finite [0,1] number, no flag on
  //    either side, historical row predates provenance.
  const legacy = extraction.extraction_confidence;
  if (isValidRatio(legacy)) {
    return { state: "available", value: legacy, source: "legacy", available: true };
  }

  // 6. Nothing on file — do NOT invent 0.7 for the UI. Downstream Worker
  //    behaviour is unchanged; only the underwriter surface refuses to guess.
  return { state: "not_recorded", value: null, source: "legacy", available: null };
}

/**
 * Whole-percent rounding. Guarantees 0 → 0, 1 → 100, 0.005 → 1 (round-half-up).
 * Used only when the state is `available`.
 */
function toPercent(value: number): number {
  return Math.round(value * 100);
}

export interface FormattedConfidence {
  /** Short label used in badges and metric tiles ("0%", "40%", "Unavailable", "Not recorded"). */
  headline: string;
  /** Provenance label, e.g. "Provider rating available", "Legacy rating", or empty. */
  provenance: string;
  /** Plain-language explanation shown alongside the metric. */
  explanation: string;
  /**
   * Whether this state ever renders a percentage. Callers can use it to gate
   * meter-style visuals so an unavailable state never shows 0%.
   */
  hasPercent: boolean;
}

export function formatExtractionConfidence(
  state: ExtractionConfidenceState
): FormattedConfidence {
  if (state.state === "available") {
    const percent = toPercent(state.value);
    if (state.source === "reviewed") {
      return {
        headline: `${percent}%`,
        provenance: "Provider rating (reviewed)",
        explanation:
          "The extraction provider returned an overall rating. A person reviewed the extraction as well.",
        hasPercent: true,
      };
    }
    if (state.source === "legacy") {
      return {
        headline: `${percent}%`,
        provenance: "Legacy rating",
        explanation:
          "This historical extraction predates confidence provenance. Treat the rating as indicative only.",
        hasPercent: true,
      };
    }
    return {
      headline: `${percent}%`,
      provenance: "Provider rating available",
      explanation:
        "The extraction provider returned an overall rating for this run. Field-level bands still apply.",
      hasPercent: true,
    };
  }

  if (state.state === "unavailable") {
    return {
      headline: "Unavailable",
      provenance: "No overall rating",
      explanation:
        "The extraction provider did not return an overall rating. Review the individual field evidence before relying on the summary.",
      hasPercent: false,
    };
  }

  return {
    headline: "Not recorded",
    provenance: "No overall rating on file",
    explanation:
      "No overall extraction confidence has been recorded for this submission. Rely on the field-level evidence.",
    hasPercent: false,
  };
}
