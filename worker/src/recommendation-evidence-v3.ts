/**
 * Powerhouse Batch B — `recommendation-evidence-v3`.
 *
 * Why a new schema version and not additive v2 fields: v2 is live in production
 * and its `quality` block means "the v2 classification table". v3 changes what a
 * reader may conclude from `quality` (its gaps now carry completeness /
 * contradiction links, it has new gap codes, and it is stamped
 * `recommendation-quality-v3`), and it adds two top-level analyses that a v2
 * reader must not assume were performed. A historical v2 packet therefore stays
 * a v2 packet: it is never rewritten, never reconstructed and never presented as
 * though completeness / contradiction analysis had been captured.
 *
 * v3 is a strict SUPERSET of v2 for every shared field: both builders start from
 * the same `EvidenceBaseV2`, so provenance, matcher input, requested sections,
 * reviewed facts, trusted documents and every insurer outcome are produced by one
 * implementation. Like v1 and v2 this module only SERIALISES. It never scores,
 * ranks or reinterprets, and it uses no LLM.
 *
 * evidence_json is untyped jsonb: no migration, no rewrite.
 */

import {
  buildEvidenceBaseV2,
  type BuildEvidenceV2Input,
  type RecommendationEvidenceV2,
  type ScoredInsurerOutcomeEvidenceV2,
} from "./recommendation-evidence-v2.js";
import type { NoDataInsurerOutcomeEvidence } from "./recommendation-evidence.js";
import { assessCompleteness, readExtractionReportedMissing, type CompletenessAnalysis } from "./completeness.js";
import { analyseContradictions, type ContradictionAnalysis, type ObservationSet } from "./contradictions.js";
import { QUALITY_MODEL_VERSION, assessQualityV3, type RecommendationQualityV3 } from "./recommendation-quality-v3.js";

export const RECOMMENDATION_EVIDENCE_SCHEMA_VERSION_V3 = "recommendation-evidence-v3" as const;
export { QUALITY_MODEL_VERSION };

export type ScoredInsurerOutcomeEvidenceV3 = ScoredInsurerOutcomeEvidenceV2;
export type InsurerOutcomeEvidenceV3 = ScoredInsurerOutcomeEvidenceV3 | NoDataInsurerOutcomeEvidence;

export interface RecommendationEvidenceV3
  extends Omit<RecommendationEvidenceV2, "schema_version" | "insurers" | "quality"> {
  schema_version: typeof RECOMMENDATION_EVIDENCE_SCHEMA_VERSION_V3;
  insurers: InsurerOutcomeEvidenceV3[];
  quality: RecommendationQualityV3;
  /** What the case still needs, by scope, with the authority for each requirement. */
  completeness: CompletenessAnalysis;
  /** Recorded values that disagree. Never says which is right and never scores. */
  contradictions: ContradictionAnalysis;
}

export interface BuildEvidenceV3Input extends BuildEvidenceV2Input {
  /**
   * Comparable recorded values supplied to the pure engine. Production currently
   * supplies an empty set because the live registry is empty; engine tests inject
   * legitimate pairs. Raw values are transient and never persisted.
   */
  observations: ObservationSet;
}

export function buildRecommendationEvidenceV3(input: BuildEvidenceV3Input): RecommendationEvidenceV3 {
  const base = buildEvidenceBaseV2(input);
  const cores = [...base.scored, ...base.noData];

  const completeness = assessCompleteness({
    requestedSections: base.requested_sections,
    insurers: cores,
    reported: readExtractionReportedMissing(input.reviewed),
  });
  const contradictions = analyseContradictions({ observations: input.observations });
  const assessed = assessQualityV3({
    facts: base.reviewed_risk_facts,
    insurers: cores,
    requestedSections: base.requested_sections,
    trustedDocumentCount: base.trusted_documents.length,
    completeness,
    contradictions,
  });

  const insurers: InsurerOutcomeEvidenceV3[] = [
    ...base.scored.map((outcome) => {
      const insurerState = assessed.insurerQuality.get(outcome.insurer_id);
      if (!insurerState) throw new Error(`quality_missing:${outcome.insurer_id}`);
      return { ...outcome, quality: insurerState };
    }),
    ...base.noData,
  ];

  return {
    schema_version: RECOMMENDATION_EVIDENCE_SCHEMA_VERSION_V3,
    provenance: base.provenance,
    matcher_input: base.matcher_input,
    requested_sections: base.requested_sections,
    scoring_scope: base.scoring_scope,
    reviewed_risk_facts: base.reviewed_risk_facts,
    trusted_documents: base.trusted_documents,
    insurers,
    quality: assessed.quality,
    completeness: assessed.completeness,
    contradictions: assessed.contradictions,
  };
}
