/**
 * Projection of matcher output onto the fields that existed under matcher
 * version `2026-07-token-matching-v1`. Anything added later (section
 * evaluations, considered rules, selection basis …) is deliberately projected
 * away, so this is the parity lens: it answers "did the authoritative v1
 * answer change?" independent of what Powerhouse adds around it.
 */

import type { MatchResult } from "../../worker/src/matcher.js";

export function projectV1(result: MatchResult) {
  return {
    insurers: result.insurers.map((insurer, index) => ({
      position: index + 1,
      rank: insurer.rank ?? null,
      insurer_id: insurer.insurer_id,
      insurer_name: insurer.insurer_name,
      score: insurer.score,
      band: insurer.band,
      rule_status: insurer.rule_status,
      confidence: insurer.confidence,
      confidence_available: insurer.confidence_available,
      referral_required: insurer.referral_required,
      manual_review_required: insurer.manual_review_required,
      senior_review_required: insurer.senior_review_required,
      ruled_out: insurer.ruled_out,
      scored_against_appetite_id: insurer.scored_against_appetite_id,
      matched_rules: insurer.matched_rules.map((matched) => ({
        appetite_id: matched.appetite_id,
        list: matched.list,
        effect: matched.effect ?? null,
        score_contribution: matched.score_contribution ?? null,
        matched_strings: matched.matched_strings,
      })),
      required_documents: (insurer.required_document_evidence ?? []).map((doc) => ({
        document_type: doc.document_type,
        present: doc.present,
        appetite_ids: doc.appetite_ids,
        scopes: doc.scopes,
        confidence_adjustment: doc.confidence_adjustment,
      })),
      score_reconciliation: insurer.score_reconciliation ?? null,
      confidence_reconciliation: insurer.confidence_reconciliation ?? null,
      missing_required_documents: insurer.missing_required_documents,
      unmatched_sections: insurer.unmatched_sections,
      unmatched_product_candidates: insurer.unmatched_product_candidates,
      nearby_rule_matches: insurer.nearby_rule_matches,
      scoring_notes: insurer.scoring_notes,
    })),
    no_data_for: result.no_data_for,
  };
}

export type V1Projection = ReturnType<typeof projectV1>;
