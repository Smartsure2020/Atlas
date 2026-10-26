/** Hand-built comparison fixture for engine/UI tests only. Never a production registry. */
import { analyseContradictions, type ComparableFieldSpec, type Observation } from "../../worker/src/contradictions.js";
import { assessQualityV3 } from "../../worker/src/recommendation-quality-v3.js";
import type { RecommendationEvidenceV3 } from "../../worker/src/recommendation-evidence-v3.js";

type Row = Record<string, unknown>;

const REGISTRY: ComparableFieldSpec[] = [{
  field_key: "risk.product",
  label: "Product line",
  normalizer: "enum_trim_collapse_casefold",
  sensitivity: "none",
  field_path: "risk_classification.product_line",
  closed_vocabulary: ["motor", "property"],
  sources: [],
}];

function observation(source_id: string, raw: string, column: string): Observation {
  return {
    field_key: "risk.product",
    source_id,
    source_label: source_id === "synthetic_a" ? "Synthetic source A" : "Synthetic source B",
    raw,
    pointer: { record: "atlas_submissions", column },
    field_status: null,
    confidence: null,
  };
}

export function withInjectedProductComparison(baseRow: unknown, secondValue: "motor" | "property" = "property"): Row {
  const row = structuredClone(baseRow) as Row;
  const evidence = row.evidence_json as unknown as RecommendationEvidenceV3;
  const contradictions = analyseContradictions({
    registry: REGISTRY,
    observations: {
      observations: [observation("synthetic_a", "motor", "synthetic_a"), observation("synthetic_b", secondValue, "synthetic_b")],
      unavailable_sources: [],
    },
  });
  const assessed = assessQualityV3({
    facts: evidence.reviewed_risk_facts,
    insurers: evidence.insurers,
    requestedSections: evidence.requested_sections,
    trustedDocumentCount: evidence.trusted_documents.length,
    completeness: evidence.completeness,
    contradictions,
  });
  evidence.quality = assessed.quality;
  evidence.completeness = assessed.completeness;
  evidence.contradictions = assessed.contradictions;
  return row;
}
