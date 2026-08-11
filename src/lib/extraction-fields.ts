/**
 * Atlas — extraction field helpers (frontend)
 * ----------------------------------------------------------------------------
 * Small, dependency-free helpers for walking an extraction summary shape and
 * classifying fields by confidence band. Kept in `src/lib/` so both the
 * RiskInformationPanel page and the ExtractionTrustSummary component can
 * import it without the component reaching into a page module.
 */

import { confidenceBand, type ConfidenceBand } from "./status";

export interface ExtractionFieldSource {
  document_id?: string | null;
  file_name?: string | null;
  page?: number | null;
  section?: string | null;
  snippet?: string | null;
}

export interface ExtractionField {
  value: unknown;
  status?: string;
  confidence: number;
  source?: ExtractionFieldSource;
  notes?: string | null;
}

export function isExtractionField(value: unknown): value is ExtractionField {
  return (
    !!value &&
    typeof value === "object" &&
    "value" in (value as object) &&
    "confidence" in (value as object)
  );
}

/** Count fields whose confidence band falls into any of `bands`. */
export function countByBand(
  summary: Record<string, unknown> | null,
  reviewed: boolean,
  bands: ConfidenceBand[]
): number {
  if (!summary) return 0;
  let total = 0;
  const walk = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    if (isExtractionField(node)) {
      const { band } = confidenceBand(node.status, node.confidence, reviewed);
      if (bands.includes(band)) total += 1;
      return;
    }
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    Object.values(node as Record<string, unknown>).forEach(walk);
  };
  walk(summary);
  return total;
}
