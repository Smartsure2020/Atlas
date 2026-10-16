/**
 * Phase 1A — deterministic, point-in-time recommendation evidence.
 *
 * This module does not score, rank, or infer. It serialises the authoritative
 * matcher result together with the exact reviewed input, active rule snapshot,
 * and trusted document labels already used by the recommendation endpoint.
 */

import type {
  InsurerScore,
  MatchInputRisk,
  MatchedRuleRef,
} from "./matcher.js";
import type { AppetiteRow, AppetiteLevel } from "./matcher-types.js";

export const RECOMMENDATION_EVIDENCE_SCHEMA_VERSION = "recommendation-evidence-v1";

export type EvidenceEffect =
  | "preferred_match"
  | "standard_match"
  | "caution"
  | "decline"
  | "referral"
  | "required_document_present"
  | "required_document_missing"
  | "other";

export interface ReviewedRiskEvidence {
  field_path: string;
  label: string;
  display_value: string;
  source_category: "reviewed_extraction" | "reviewed_ai_inference" | "extraction_metadata";
  matcher_roles: ("product_candidate" | "risk_candidate" | "feature" | "confidence")[];
  ai_inferred: boolean;
  confidence: number | null;
  confidence_available: boolean;
}

export interface RuleEvidence {
  evidence_id: string;
  rule_id: string;
  insurer_id: string;
  insurer_name: string;
  product_line: string;
  risk_type: string;
  appetite_level: AppetiteLevel;
  effect: EvidenceEffect;
  matcher_component: MatchedRuleRef["list"] | "required_document";
  score_contribution: number | null;
  matched_values: string[];
  matched_input_sources: {
    value: string;
    source_labels: string[];
    ai_inferred_only: boolean;
  }[];
  required_document: string | null;
  source: "ai_extracted" | "manual";
  source_document_id: string | null;
  source_file_name: string | null;
  source_page: number | null;
  source_section: string | null;
  source_quote: string | null;
  rule_notes: string | null;
}

export interface EvidenceQualityGap {
  code:
    | "rule_source_document_missing"
    | "rule_source_locator_incomplete"
    | "matched_rule_snapshot_missing"
    | "matched_input_source_missing"
    | "reviewed_fact_confidence_unavailable"
    | "insurer_appetite_data_missing"
    | "taxonomy_match_missing";
  scope: "rule" | "reviewed_fact" | "insurer";
  insurer_id: string | null;
  rule_id: string | null;
  field_path: string | null;
  missing: string[];
}

export interface InsurerOutcomeEvidence {
  insurer_id: string;
  insurer_name: string;
  rank: number | null;
  score: number | null;
  band: InsurerScore["band"] | "no_appetite_data";
  rule_status: InsurerScore["rule_status"] | "no_appetite_data";
  confidence: number | null;
  confidence_available: boolean;
  referral_required: boolean;
  manual_review_required: boolean;
  senior_review_required: boolean;
  ruled_out: boolean;
  no_appetite_data: boolean;
  scored_against_rule_id: string | null;
  unresolved_rule_ids: string[];
  rule_evidence: RuleEvidence[];
  outcome_reasons: {
    why_ranked: string[];
    strengthened_by: string[];
    weakened_by: string[];
    cautions: string[];
    referrals: string[];
    declines: string[];
    required_documents_present: string[];
    required_documents_missing: string[];
    evidence_gaps: string[];
  };
  unmatched_sections: string[];
  unmatched_product_candidates: string[];
  nearby_rule_matches: string[];
  /** Retained for traceability while P1C replaces remaining prose-only gaps. */
  matcher_notes: string[];
}

export interface RecommendationEvidenceV1 {
  schema_version: typeof RECOMMENDATION_EVIDENCE_SCHEMA_VERSION;
  provenance: {
    recommendation_id: string;
    submission_id: string;
    extraction_id: string;
    reviewed_at: string | null;
    generated_at: string;
    matcher_version: string;
    taxonomy_version: string;
    explanation_mode: string;
    explanation_source: string;
    recommendation_input_fingerprint: string;
  };
  /** Canonical snapshot of the exact values handed to matchInsurers(). */
  matcher_input: MatchInputRisk;
  reviewed_risk_facts: ReviewedRiskEvidence[];
  trusted_documents: {
    document_type: string;
    evidence_label: string;
    availability: "available";
    trust_basis: "active_exact_clean";
  }[];
  insurers: InsurerOutcomeEvidence[];
  quality: {
    status: "complete" | "gaps_present";
    gaps: EvidenceQualityGap[];
  };
}

interface FieldShape {
  value?: unknown;
  confidence?: unknown;
  confidence_source?: unknown;
}

function field(record: Record<string, unknown>, key: string): FieldShape | null {
  const candidate = record[key];
  return candidate && typeof candidate === "object" && "value" in candidate
    ? candidate as FieldShape
    : null;
}

function displayValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.map(displayValue).filter(Boolean).join(", ");
  if (typeof value === "object") {
    return Object.values(value as Record<string, unknown>).map(displayValue).filter(Boolean).join(", ");
  }
  return String(value).trim();
}

const FACT_FIELDS: {
  section: string;
  key: string;
  label: string;
  roles: ReviewedRiskEvidence["matcher_roles"];
}[] = [
  { section: "risk_classification", key: "product_line", label: "Product line", roles: ["product_candidate"] },
  { section: "risk_classification", key: "risk_type", label: "Risk type", roles: ["product_candidate", "risk_candidate"] },
  { section: "risk_classification", key: "primary_risk_type", label: "Primary risk type", roles: ["product_candidate", "risk_candidate", "feature"] },
  { section: "risk_classification", key: "secondary_risk_types", label: "Secondary risk types", roles: ["product_candidate", "risk_candidate", "feature"] },
  { section: "risk_classification", key: "business_sector", label: "Business sector", roles: ["risk_candidate", "feature"] },
  { section: "risk_classification", key: "complexity_level", label: "Complexity level", roles: ["risk_candidate", "feature"] },
  { section: "extracted_client", key: "occupation_or_business_description", label: "Occupation or business description", roles: ["feature"] },
  { section: "extracted_client", key: "risk_address", label: "Risk address", roles: ["feature"] },
  { section: "extracted_client", key: "entity_type", label: "Entity type", roles: ["feature"] },
  { section: "current_cover", key: "cover_sections", label: "Cover sections", roles: ["product_candidate", "feature"] },
  { section: "current_cover", key: "endorsements", label: "Endorsements", roles: ["feature"] },
  { section: "current_cover", key: "exclusions", label: "Exclusions", roles: ["feature"] },
];

export function buildReviewedRiskEvidence(
  reviewed: Record<string, unknown>,
  risk: MatchInputRisk
): ReviewedRiskEvidence[] {
  const facts: ReviewedRiskEvidence[] = [];
  for (const spec of FACT_FIELDS) {
    const section = (reviewed[spec.section] as Record<string, unknown> | null) ?? {};
    const source = field(section, spec.key);
    if (!source) continue;
    const value = displayValue(source.value);
    if (!value) continue;
    const confidence = typeof source.confidence === "number" && Number.isFinite(source.confidence)
      ? source.confidence
      : null;
    facts.push({
      field_path: `${spec.section}.${spec.key}`,
      label: spec.label,
      display_value: value,
      source_category: "reviewed_extraction",
      matcher_roles: [...spec.roles],
      ai_inferred: false,
      confidence,
      confidence_available: confidence !== null && source.confidence_source !== "unavailable",
    });
  }

  const redFlags = Array.isArray(reviewed.red_flags) ? reviewed.red_flags : [];
  redFlags.forEach((raw, index) => {
    if (!raw || typeof raw !== "object") return;
    const issue = displayValue((raw as { issue?: unknown }).issue);
    if (!issue) return;
    facts.push({
      field_path: `red_flags[${index}].issue`,
      label: "Red flag",
      display_value: issue,
      source_category: "reviewed_ai_inference",
      matcher_roles: ["feature"],
      ai_inferred: true,
      confidence: null,
      confidence_available: false,
    });
  });

  facts.push({
    field_path: "overall_confidence",
    label: "Overall extraction confidence",
    display_value: risk.overall_confidence_available === false ? "unavailable" : String(risk.overall_confidence),
    source_category: "extraction_metadata",
    matcher_roles: ["confidence"],
    ai_inferred: false,
    confidence: risk.overall_confidence_available === false ? null : risk.overall_confidence,
    confidence_available: risk.overall_confidence_available !== false,
  });
  return facts;
}

function canonicalRisk(risk: MatchInputRisk): MatchInputRisk {
  const uniqueSorted = (values: string[]) => [...new Set(values)].sort((a, b) => a.localeCompare(b));
  return {
    product_candidates: [...risk.product_candidates],
    section_candidates: risk.section_candidates ? [...risk.section_candidates] : undefined,
    risk_candidates: [...risk.risk_candidates],
    features: risk.features.map((feature) => typeof feature === "string" ? feature : { ...feature }),
    available_documents: uniqueSorted(risk.available_documents),
    overall_confidence: risk.overall_confidence,
    overall_confidence_available: risk.overall_confidence_available,
  };
}

function effectFor(ref: MatchedRuleRef, appetiteLevel: AppetiteLevel): EvidenceEffect {
  if (ref.list === "preferred") return "preferred_match";
  if (ref.list === "caution" || ref.list === "portfolio_caution") return "caution";
  if (ref.list === "referral" || ref.list === "portfolio_referral") return "referral";
  if (ref.list === "declined" || ref.list === "portfolio_declined") return "decline";
  if (ref.list === "base") {
    if (appetiteLevel === "preferred") return "preferred_match";
    if (appetiteLevel === "standard") return "standard_match";
    if (appetiteLevel === "caution") return "caution";
    return "decline";
  }
  return "other";
}

const EFFECT_ORDER: Record<EvidenceEffect, number> = {
  preferred_match: 0,
  standard_match: 1,
  caution: 2,
  decline: 3,
  referral: 4,
  required_document_present: 5,
  required_document_missing: 6,
  other: 7,
};

function evidenceId(ruleId: string, component: string, suffix: string): string {
  return `rule:${ruleId}:${component}:${suffix || "rule"}`;
}

function snapshotRule(
  rule: AppetiteRow,
  insurerName: string,
  input: {
    effect: EvidenceEffect;
    component: RuleEvidence["matcher_component"];
    scoreContribution: number | null;
    matchedValues?: string[];
    matchedInputs?: RuleEvidence["matched_input_sources"];
    requiredDocument?: string | null;
  }
): RuleEvidence {
  const matchedValues = [...new Set(input.matchedValues ?? [])].sort((a, b) => a.localeCompare(b));
  const suffix = input.requiredDocument ?? matchedValues.join("|");
  return {
    evidence_id: evidenceId(rule.id, input.component, suffix),
    rule_id: rule.id,
    insurer_id: rule.insurer_id,
    insurer_name: insurerName,
    product_line: rule.product_line,
    risk_type: rule.risk_type,
    appetite_level: rule.appetite_level,
    effect: input.effect,
    matcher_component: input.component,
    score_contribution: input.scoreContribution,
    matched_values: matchedValues,
    matched_input_sources: (input.matchedInputs ?? [])
      .map((item) => ({
        value: item.value,
        source_labels: [...new Set(item.source_labels)].sort((a, b) => a.localeCompare(b)),
        ai_inferred_only: item.ai_inferred_only,
      }))
      .sort((a, b) => a.value.localeCompare(b.value)),
    required_document: input.requiredDocument ?? null,
    source: rule.source,
    source_document_id: rule.source_document_id ?? null,
    source_file_name: rule.source_file_name ?? null,
    source_page: rule.source_page ?? null,
    source_section: rule.source_section ?? null,
    source_quote: rule.source_quote ?? null,
    rule_notes: rule.notes ?? null,
  };
}

function ruleEvidenceFor(
  insurer: InsurerScore,
  appetiteById: Map<string, AppetiteRow>
): { evidence: RuleEvidence[]; unresolvedRuleIds: string[] } {
  const evidence: RuleEvidence[] = [];
  const unresolvedRuleIds: string[] = [];
  for (const ref of insurer.matched_rules) {
    const rule = appetiteById.get(ref.appetite_id);
    if (!rule) {
      unresolvedRuleIds.push(ref.appetite_id);
      continue;
    }
    evidence.push(snapshotRule(rule, insurer.insurer_name, {
      effect: effectFor(ref, rule.appetite_level),
      component: ref.list,
      scoreContribution: ref.score_contribution ?? null,
      matchedValues: ref.matched_strings,
      matchedInputs: ref.matched_inputs ?? [],
    }));
  }
  for (const doc of insurer.required_document_evidence ?? []) {
    const rule = appetiteById.get(doc.appetite_id);
    if (!rule) {
      unresolvedRuleIds.push(doc.appetite_id);
      continue;
    }
    evidence.push(snapshotRule(rule, insurer.insurer_name, {
      effect: doc.present ? "required_document_present" : "required_document_missing",
      component: "required_document",
      scoreContribution: null,
      requiredDocument: doc.document_type,
    }));
  }
  return {
    evidence: evidence.sort((a, b) =>
      a.rule_id.localeCompare(b.rule_id)
      || EFFECT_ORDER[a.effect] - EFFECT_ORDER[b.effect]
      || a.evidence_id.localeCompare(b.evidence_id)
    ),
    unresolvedRuleIds: [...new Set(unresolvedRuleIds)].sort((a, b) => a.localeCompare(b)),
  };
}

function ids(evidence: RuleEvidence[], predicate: (item: RuleEvidence) => boolean): string[] {
  return evidence.filter(predicate).map((item) => item.evidence_id);
}

function outcomeFor(
  insurer: InsurerScore,
  rank: number,
  rules: RuleEvidence[],
  unresolvedRuleIds: string[]
): InsurerOutcomeEvidence {
  const missingRuleIds = new Set(
    rules.filter((rule) => rule.source_document_id === null).map((rule) => rule.rule_id)
  );
  return {
    insurer_id: insurer.insurer_id,
    insurer_name: insurer.insurer_name,
    rank,
    score: insurer.score,
    band: insurer.band,
    rule_status: insurer.rule_status,
    confidence: insurer.confidence_available ? insurer.confidence : null,
    confidence_available: insurer.confidence_available,
    referral_required: insurer.referral_required,
    manual_review_required: insurer.manual_review_required,
    senior_review_required: insurer.senior_review_required,
    ruled_out: insurer.ruled_out,
    no_appetite_data: false,
    scored_against_rule_id: insurer.scored_against_appetite_id,
    unresolved_rule_ids: unresolvedRuleIds,
    rule_evidence: rules,
    outcome_reasons: {
      why_ranked: ids(rules, (rule) => ["preferred_match", "standard_match", "caution"].includes(rule.effect)),
      strengthened_by: ids(rules, (rule) => rule.effect === "preferred_match" || rule.effect === "required_document_present"),
      weakened_by: ids(rules, (rule) => rule.effect === "caution" || rule.effect === "required_document_missing" || (rule.score_contribution ?? 0) < 0),
      cautions: ids(rules, (rule) => rule.effect === "caution"),
      referrals: ids(rules, (rule) => rule.effect === "referral" || (rule.effect === "decline" && !insurer.ruled_out)),
      declines: ids(rules, (rule) => rule.effect === "decline"),
      required_documents_present: ids(rules, (rule) => rule.effect === "required_document_present"),
      required_documents_missing: ids(rules, (rule) => rule.effect === "required_document_missing"),
      evidence_gaps: [
        ...[...missingRuleIds].map((ruleId) => `rule:${ruleId}:source_document_missing`),
        ...unresolvedRuleIds.map((ruleId) => `rule:${ruleId}:snapshot_missing`),
        ...(insurer.manual_review_required ? [`insurer:${insurer.insurer_id}:taxonomy_match_missing`] : []),
      ].sort(),
    },
    unmatched_sections: [...insurer.unmatched_sections].sort((a, b) => a.localeCompare(b)),
    unmatched_product_candidates: [...insurer.unmatched_product_candidates].sort((a, b) => a.localeCompare(b)),
    nearby_rule_matches: [...insurer.nearby_rule_matches].sort((a, b) => a.localeCompare(b)),
    matcher_notes: [...insurer.scoring_notes],
  };
}

function noDataOutcome(insurer: { insurer_id: string; insurer_name: string }): InsurerOutcomeEvidence {
  return {
    insurer_id: insurer.insurer_id,
    insurer_name: insurer.insurer_name,
    rank: null,
    score: null,
    band: "no_appetite_data",
    rule_status: "no_appetite_data",
    confidence: null,
    confidence_available: false,
    referral_required: false,
    manual_review_required: true,
    senior_review_required: true,
    ruled_out: false,
    no_appetite_data: true,
    scored_against_rule_id: null,
    unresolved_rule_ids: [],
    rule_evidence: [],
    outcome_reasons: {
      why_ranked: [], strengthened_by: [], weakened_by: [], cautions: [], referrals: [], declines: [],
      required_documents_present: [], required_documents_missing: [],
      evidence_gaps: [`insurer:${insurer.insurer_id}:appetite_data_missing`],
    },
    unmatched_sections: [],
    unmatched_product_candidates: [],
    nearby_rule_matches: [],
    matcher_notes: ["No active appetite data was available for this insurer."],
  };
}

function qualityGaps(
  facts: ReviewedRiskEvidence[],
  insurers: InsurerOutcomeEvidence[]
): EvidenceQualityGap[] {
  const gaps: EvidenceQualityGap[] = [];
  const seenRules = new Map<string, RuleEvidence>();
  for (const insurer of insurers) {
    if (insurer.no_appetite_data) {
      gaps.push({
        code: "insurer_appetite_data_missing", scope: "insurer", insurer_id: insurer.insurer_id,
        rule_id: null, field_path: null, missing: ["active_appetite_rule"],
      });
    }
    if (insurer.manual_review_required && !insurer.no_appetite_data) {
      gaps.push({
        code: "taxonomy_match_missing", scope: "insurer", insurer_id: insurer.insurer_id,
        rule_id: null, field_path: null, missing: ["matched_product_rule"],
      });
    }
    for (const ruleId of insurer.unresolved_rule_ids) {
      gaps.push({
        code: "matched_rule_snapshot_missing", scope: "rule", insurer_id: insurer.insurer_id,
        rule_id: ruleId, field_path: null, missing: ["active_rule_snapshot"],
      });
    }
    for (const rule of insurer.rule_evidence) seenRules.set(rule.rule_id, rule);
  }
  for (const rule of seenRules.values()) {
    if (!rule.source_document_id) {
      gaps.push({
        code: "rule_source_document_missing", scope: "rule", insurer_id: rule.insurer_id,
        rule_id: rule.rule_id, field_path: null, missing: ["source_document_id"],
      });
    } else {
      const missing = (["source_file_name", "source_page", "source_section", "source_quote"] as const)
        .filter((key) => rule[key] === null);
      if (missing.length > 0) {
        gaps.push({
          code: "rule_source_locator_incomplete", scope: "rule", insurer_id: rule.insurer_id,
          rule_id: rule.rule_id, field_path: null, missing: [...missing],
        });
      }
    }
    if (rule.matched_values.length > 0 && rule.matched_input_sources.length === 0) {
      gaps.push({
        code: "matched_input_source_missing", scope: "rule", insurer_id: rule.insurer_id,
        rule_id: rule.rule_id, field_path: null, missing: ["matched_input_sources"],
      });
    }
  }
  for (const fact of facts) {
    if (!fact.confidence_available) {
      gaps.push({
        code: "reviewed_fact_confidence_unavailable", scope: "reviewed_fact", insurer_id: null,
        rule_id: null, field_path: fact.field_path, missing: ["confidence"],
      });
    }
  }
  return gaps.sort((a, b) =>
    a.code.localeCompare(b.code)
    || (a.insurer_id ?? "").localeCompare(b.insurer_id ?? "")
    || (a.rule_id ?? "").localeCompare(b.rule_id ?? "")
    || (a.field_path ?? "").localeCompare(b.field_path ?? "")
  );
}

export function buildRecommendationEvidence(input: {
  recommendationId: string;
  submissionId: string;
  extractionId: string;
  reviewedAt: string | null;
  generatedAt: string;
  matcherVersion: string;
  taxonomyVersion: string;
  explanationMode: string;
  explanationSource: string;
  recommendationInputFingerprint: string;
  reviewed: Record<string, unknown>;
  matcherInput: MatchInputRisk;
  matcherResult: {
    insurers: InsurerScore[];
    no_data_for: { insurer_id: string; insurer_name: string }[];
  };
  activeAppetite: AppetiteRow[];
}): RecommendationEvidenceV1 {
  const appetiteById = new Map(input.activeAppetite.map((rule) => [rule.id, rule]));
  const facts = buildReviewedRiskEvidence(input.reviewed, input.matcherInput);
  const scored = input.matcherResult.insurers.map((insurer, index) => {
    const { evidence, unresolvedRuleIds } = ruleEvidenceFor(insurer, appetiteById);
    return outcomeFor(insurer, index + 1, evidence, unresolvedRuleIds);
  });
  const noData = [...input.matcherResult.no_data_for]
    .sort((a, b) => a.insurer_name.localeCompare(b.insurer_name) || a.insurer_id.localeCompare(b.insurer_id))
    .map(noDataOutcome);
  const insurers = [...scored, ...noData];
  const gaps = qualityGaps(facts, insurers);

  return {
    schema_version: RECOMMENDATION_EVIDENCE_SCHEMA_VERSION,
    provenance: {
      recommendation_id: input.recommendationId,
      submission_id: input.submissionId,
      extraction_id: input.extractionId,
      reviewed_at: input.reviewedAt,
      generated_at: input.generatedAt,
      matcher_version: input.matcherVersion,
      taxonomy_version: input.taxonomyVersion,
      explanation_mode: input.explanationMode,
      explanation_source: input.explanationSource,
      recommendation_input_fingerprint: input.recommendationInputFingerprint,
    },
    matcher_input: canonicalRisk(input.matcherInput),
    reviewed_risk_facts: facts,
    trusted_documents: [...new Set(input.matcherInput.available_documents)]
      .sort((a, b) => a.localeCompare(b))
      .map((documentType) => ({
        document_type: documentType,
        evidence_label: documentType,
        availability: "available" as const,
        trust_basis: "active_exact_clean" as const,
      })),
    insurers,
    quality: { status: gaps.length > 0 ? "gaps_present" : "complete", gaps },
  };
}
