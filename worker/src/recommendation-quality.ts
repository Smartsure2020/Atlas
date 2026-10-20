/**
 * Powerhouse P1C — deterministic intelligence-quality gate.
 *
 * Classifies every evidence gap by MATERIALITY and rolls the gaps up into one
 * of three reliance states. Pure, synchronous, no LLM, no thresholds: each
 * severity below is a stated predicate over persisted evidence, and the full
 * classification table is documented in
 * docs/powerhouse-p1b-p2-intelligence-quality.md (§ Quality gate) and
 * enforced case-by-case in tests/powerhouse/quality-gate.test.ts.
 *
 * What it controls: PRESENTATION and RELIANCE only. It never changes a score,
 * rank, referral, decline or document-trust decision, and it never blocks the
 * underwriter — "incomplete" is shown, not enforced, and is never turned into
 * a decline.
 *
 * Vocabulary
 *   severity  blocker   Atlas cannot defend or rely on part of the outcome
 *                       as presented (a hidden hard decline, an unresolvable
 *                       rule, an outcome that depends on an arbitrary tie).
 *             material  the outcome is usable but a limitation changes how
 *                       far it can be relied on and must be shown.
 *             advisory  provenance or scope detail; does not change reliance.
 *   state     incomplete      >= 1 blocker
 *             caution         no blocker, >= 1 material
 *             decision_ready  only advisory gaps, or none
 */

import type {
  InsurerQualityV2,
  QualityGapV2,
  QualitySeverity,
  IntelligenceState,
  RecommendationQualityV2,
  ScoredInsurerCore,
  InsurerOutcomeCore,
} from "./recommendation-evidence-v2.js";
import type { ReviewedRiskEvidence } from "./recommendation-evidence.js";
import type { RequestedSection } from "./matcher.js";

/** Version of the classification table below; stored on every assessment. */
export const QUALITY_MODEL_VERSION = "recommendation-quality-v1" as const;

export interface QualityAssessmentInput {
  facts: ReviewedRiskEvidence[];
  insurers: InsurerOutcomeCore[];
  requestedSections: RequestedSection[];
  trustedDocumentCount: number;
}

const SEVERITY_ORDER: Record<QualitySeverity, number> = { blocker: 0, material: 1, advisory: 2 };

function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function stateFor(counts: { blocker: number; material: number }): IntelligenceState {
  if (counts.blocker > 0) return "incomplete";
  if (counts.material > 0) return "caution";
  return "decision_ready";
}

function gap(
  fields: Omit<QualityGapV2, "gap_id" | "insurer_id" | "rule_id" | "section_key" | "field_path" | "missing"> &
    Partial<Pick<QualityGapV2, "insurer_id" | "rule_id" | "section_key" | "field_path" | "missing">>
): QualityGapV2 {
  const full = {
    insurer_id: null,
    rule_id: null,
    section_key: null,
    field_path: null,
    missing: [] as string[],
    ...fields,
  };
  return {
    gap_id: [
      "gap", full.code, full.insurer_id ?? "-", full.rule_id ?? "-",
      full.section_key ?? "-", full.field_path ?? "-", full.missing.join("+") || "-",
    ].join(":"),
    ...full,
  };
}

interface RuleFacts {
  rule_id: string;
  resolved: boolean;
  source: "ai_extracted" | "manual" | null;
  source_document_id: string | null;
  locator: Record<"source_file_name" | "source_page" | "source_section" | "source_quote", unknown>;
  /** The rule sets the insurer's outcome or carries a decline / referral signal. */
  decisive: boolean;
  unattributedMatch: boolean;
}

const ADVERSE_KINDS = new Set(["hard_decline", "soft_decline_referral", "referral"]);

function ruleFactsFor(insurer: ScoredInsurerCore): RuleFacts[] {
  const byId = new Map<string, RuleFacts>();
  const touch = (ruleId: string): RuleFacts => {
    let facts = byId.get(ruleId);
    if (!facts) {
      facts = {
        rule_id: ruleId, resolved: true, source: null, source_document_id: null,
        locator: { source_file_name: null, source_page: null, source_section: null, source_quote: null },
        decisive: ruleId === insurer.selection.product_rule_id || ruleId === insurer.scored_against_rule_id,
        unattributedMatch: false,
      };
      byId.set(ruleId, facts);
    }
    return facts;
  };
  for (const rule of insurer.rule_evidence) {
    const facts = touch(rule.rule_id);
    facts.source = rule.source;
    facts.source_document_id = rule.source_document_id;
    facts.locator = {
      source_file_name: rule.source_file_name, source_page: rule.source_page,
      source_section: rule.source_section, source_quote: rule.source_quote,
    };
    if (rule.matcher_component === "base" || ADVERSE_KINDS.has(rule.effect) || rule.effect === "hard_decline") {
      facts.decisive = true;
    }
    if (rule.matched_value_count > 0 && rule.matched_input_sources.length === 0) facts.unattributedMatch = true;
  }
  for (const rule of insurer.considered_rules) {
    const facts = touch(rule.rule_id);
    if (!rule.snapshot_resolved) {
      facts.resolved = false;
    } else if (facts.source === null) {
      facts.source = rule.source;
      facts.source_document_id = rule.source_document_id;
      facts.locator = {
        source_file_name: rule.source_file_name, source_page: rule.source_page,
        source_section: rule.source_section, source_quote: rule.source_quote,
      };
    }
    if (
      rule.appetite_level === "declined" ||
      rule.conditions.some((condition) => ADVERSE_KINDS.has(condition.kind))
    ) {
      facts.decisive = true;
    }
  }
  return [...byId.values()];
}

function hardDeclineDiffers(insurer: ScoredInsurerCore, ruleIds: string[]): boolean {
  const flags = ruleIds.map((ruleId) => {
    const rule = insurer.considered_rules.find((item) => item.rule_id === ruleId);
    return !!rule && rule.conditions.some((condition) => condition.kind === "hard_decline");
  });
  return flags.some(Boolean) && !flags.every(Boolean);
}

function insurerGaps(insurer: ScoredInsurerCore): QualityGapV2[] {
  const out: QualityGapV2[] = [];
  const id = insurer.insurer_id;
  const ruledOut = insurer.ruled_out;

  // ---- Rule snapshots and provenance --------------------------------------
  for (const ruleId of insurer.unresolved_rule_ids) {
    out.push(gap({
      code: "matched_rule_snapshot_missing", severity: "blocker", scope: "rule",
      insurer_id: id, rule_id: ruleId, missing: ["active_rule_snapshot"],
    }));
  }
  for (const facts of ruleFactsFor(insurer)) {
    if (!facts.resolved) {
      out.push(gap({
        code: "matched_rule_snapshot_missing", severity: "blocker", scope: "rule",
        insurer_id: id, rule_id: facts.rule_id, missing: ["active_rule_snapshot"],
      }));
      continue;
    }
    if (!facts.source_document_id) {
      // An AI-extracted rule with no source document that also drives the
      // outcome cannot be traced to a guideline; a hand-entered rule has no
      // document by design, so it is only noted.
      out.push(gap({
        code: "rule_source_document_missing",
        severity: facts.source === "ai_extracted" && facts.decisive ? "material" : "advisory",
        scope: "rule", insurer_id: id, rule_id: facts.rule_id, missing: ["source_document_id"],
      }));
    } else {
      const missing = (Object.keys(facts.locator) as (keyof RuleFacts["locator"])[])
        .filter((key) => facts.locator[key] === null || facts.locator[key] === undefined)
        .sort();
      if (missing.length > 0) {
        out.push(gap({
          code: "rule_source_locator_incomplete", severity: "advisory", scope: "rule",
          insurer_id: id, rule_id: facts.rule_id, missing,
        }));
      }
    }
    if (facts.unattributedMatch) {
      out.push(gap({
        code: "matched_input_source_missing", severity: facts.decisive ? "material" : "advisory",
        scope: "rule", insurer_id: id, rule_id: facts.rule_id, missing: ["matched_input_sources"],
      }));
    }
  }

  // ---- Selection quality ---------------------------------------------------
  if (insurer.manual_review_required) {
    out.push(gap({
      code: "taxonomy_match_missing", severity: "material", scope: "insurer",
      insurer_id: id, missing: ["matched_product_rule"],
    }));
  } else if (insurer.selection.taxonomy_quality === 1) {
    out.push(gap({
      code: "scored_rule_product_unmatched", severity: "material", scope: "insurer",
      insurer_id: id, rule_id: insurer.selection.product_rule_id, missing: ["product_line_match"],
    }));
  }
  if (insurer.selection.basis === "tie_broken_by_canonical_order" && insurer.selection.tied_rules_disagree) {
    out.push(gap({
      code: "scored_rule_selection_tie",
      severity: hardDeclineDiffers(insurer, insurer.selection.tied_rule_ids) ? "blocker" : "material",
      scope: "insurer", insurer_id: id, rule_id: insurer.selection.product_rule_id,
      missing: ["unambiguous_rule_selection"],
    }));
  }

  // ---- Requested sections --------------------------------------------------
  for (const section of insurer.section_evaluations) {
    const base = { insurer_id: id, section_key: section.section_key, scope: "section" as const };
    if (section.status === "no_applicable_rule") {
      out.push(gap({
        ...base, code: "requested_section_not_evaluated",
        severity: ruledOut ? "advisory" : "material", missing: ["applicable_rule"],
      }));
      continue;
    }
    if (section.tied_rules_disagree) {
      out.push(gap({
        ...base, code: "section_rule_conflict",
        severity: hardDeclineDiffers(insurer, section.tied_rule_ids) ? "blocker" : "material",
        rule_id: section.selected_rule_id, missing: ["unambiguous_rule_selection"],
      }));
    }
    if (section.reflected_in_insurer_outcome) continue;
    // The selected rule for this section is NOT the rule that set the insurer's
    // score. If the insurer is already ruled out, nothing can make it worse.
    const adverse = (severity: QualitySeverity): QualitySeverity => (ruledOut ? "advisory" : severity);
    switch (section.outcome) {
      case "hard_decline":
        out.push(gap({ ...base, code: "section_hard_decline_not_reflected", severity: adverse("blocker"), rule_id: section.selected_rule_id, missing: ["section_outcome_in_score"] }));
        break;
      case "soft_decline_referral":
        out.push(gap({ ...base, code: "section_soft_decline_not_reflected", severity: adverse("material"), rule_id: section.selected_rule_id, missing: ["section_outcome_in_score"] }));
        break;
      case "referral":
        out.push(gap({ ...base, code: "section_referral_not_reflected", severity: adverse("material"), rule_id: section.selected_rule_id, missing: ["section_outcome_in_score"] }));
        break;
      case "caution":
        out.push(gap({ ...base, code: "section_caution_not_reflected", severity: adverse("material"), rule_id: section.selected_rule_id, missing: ["section_outcome_in_score"] }));
        break;
      default:
        out.push(gap({ ...base, code: "section_outcome_not_scored", severity: "advisory", rule_id: section.selected_rule_id, missing: ["section_outcome_in_score"] }));
    }
  }

  // ---- Documents -----------------------------------------------------------
  if (!ruledOut) {
    for (const doc of insurer.required_documents) {
      if (doc.present) continue;
      out.push(gap({
        code: "required_document_missing", severity: "advisory", scope: "insurer",
        insurer_id: id, missing: [doc.document_type],
      }));
    }
  }
  return out;
}

export function assessQuality(input: QualityAssessmentInput): {
  quality: RecommendationQualityV2;
  insurerQuality: Map<string, InsurerQualityV2>;
} {
  const gaps: QualityGapV2[] = [];
  const scored = input.insurers.filter((insurer): insurer is ScoredInsurerCore => insurer.status === "scored");

  for (const insurer of input.insurers) {
    if (insurer.status === "no_appetite_data") {
      // A scope note: it narrows what the ranking covers but does not weaken
      // the evidence behind the insurers that WERE ranked.
      gaps.push(gap({
        code: "insurer_appetite_data_missing", severity: "advisory", scope: "insurer",
        insurer_id: insurer.insurer_id, missing: ["active_appetite_rule"],
      }));
    } else {
      gaps.push(...insurerGaps(insurer));
    }
  }

  // ---- Recommendation scope -----------------------------------------------
  const recommended = [...scored].sort((a, b) => a.rank - b.rank).find((insurer) => !insurer.ruled_out);
  if (recommended?.manual_review_required) {
    gaps.push(gap({
      code: "recommended_insurer_unscored", severity: "blocker", scope: "recommendation",
      insurer_id: recommended.insurer_id, missing: ["scored_product_rule"],
    }));
  }
  if (input.requestedSections.length === 0) {
    gaps.push(gap({
      code: "requested_sections_not_declared", severity: "advisory", scope: "recommendation",
      missing: ["requested_cover_sections"],
    }));
  }
  if (input.trustedDocumentCount === 0) {
    const anyRequirement = scored.some((insurer) => !insurer.ruled_out && insurer.required_documents.length > 0);
    gaps.push(gap({
      code: "no_trusted_documents", severity: anyRequirement ? "material" : "advisory",
      scope: "recommendation", missing: ["trusted_document"],
    }));
  }
  for (const fact of input.facts) {
    if (!fact.confidence_available) {
      gaps.push(gap({
        code: "reviewed_fact_confidence_unavailable", severity: "advisory", scope: "reviewed_fact",
        field_path: fact.field_path, missing: ["confidence"],
      }));
    }
  }

  gaps.sort(
    (a, b) =>
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
      compareCodeUnits(a.code, b.code) ||
      compareCodeUnits(a.insurer_id ?? "", b.insurer_id ?? "") ||
      compareCodeUnits(a.rule_id ?? "", b.rule_id ?? "") ||
      compareCodeUnits(a.section_key ?? "", b.section_key ?? "") ||
      compareCodeUnits(a.field_path ?? "", b.field_path ?? "") ||
      compareCodeUnits(a.missing.join("+"), b.missing.join("+"))
  );

  const count = (list: QualityGapV2[], severity: QualitySeverity) => list.filter((item) => item.severity === severity).length;
  const insurerQuality = new Map<string, InsurerQualityV2>();
  for (const insurer of scored) {
    const own = gaps.filter((item) => item.insurer_id === insurer.insurer_id);
    const counts = { blocker: count(own, "blocker"), material: count(own, "material"), advisory: count(own, "advisory") };
    insurerQuality.set(insurer.insurer_id, {
      state: stateFor(counts),
      blocker_count: counts.blocker,
      material_count: counts.material,
      advisory_count: counts.advisory,
      gap_ids: own.map((item) => item.gap_id),
    });
  }
  const counts = { blocker: count(gaps, "blocker"), material: count(gaps, "material"), advisory: count(gaps, "advisory") };
  return {
    quality: {
      model: QUALITY_MODEL_VERSION,
      state: stateFor(counts),
      blocker_count: counts.blocker,
      material_count: counts.material,
      advisory_count: counts.advisory,
      gaps,
    },
    insurerQuality,
  };
}
