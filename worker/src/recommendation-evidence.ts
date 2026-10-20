/**
 * Phase 1A — deterministic, point-in-time recommendation evidence.
 *
 * This module does not score, rank, or infer. It serialises the authoritative
 * matcher result together with the exact reviewed input, active rule snapshot,
 * and trusted document labels already used by the recommendation endpoint.
 */

import type {
  ConfidenceReconciliation,
  InsurerScore,
  MatchInputRisk,
  MatcherRuleEffect,
  MatchedRuleTerm,
  MatchedRuleRef,
  ScoreReconciliation,
} from "./matcher.js";
import type { AppetiteRow, AppetiteLevel } from "./matcher-types.js";

export const RECOMMENDATION_EVIDENCE_SCHEMA_VERSION = "recommendation-evidence-v1";

export type EvidenceEffect =
  | MatcherRuleEffect
  | "required_document_present"
  | "required_document_missing";

export interface ReviewedRiskEvidence {
  field_path: string;
  label: string;
  present: true;
  value_retained: false;
  source_category: "reviewed_extraction" | "reviewed_ai_inference" | "extraction_metadata";
  matcher_roles: ("product_candidate" | "risk_candidate" | "feature" | "confidence")[];
  ai_inferred: boolean;
  confidence: number | null;
  confidence_available: boolean;
}

export interface PersistedMatcherInput {
  product_candidates: string[];
  section_candidates?: string[];
  risk_candidates: string[];
  features: {
    source: string;
    ai_inferred: boolean;
    value_retained: false;
  }[];
  available_documents: string[];
  overall_confidence: number;
  overall_confidence_available?: boolean;
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
  matched_value_count: number;
  matched_rule_terms: MatchedRuleTerm[];
  matched_input_sources: {
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

export interface RequiredDocumentOutcomeEvidence {
  evidence_id: string;
  document_type: string;
  present: boolean;
  rule_evidence_ids: string[];
  confidence_adjustment: number;
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

export interface ScoredInsurerOutcomeEvidence {
  insurer_id: string;
  insurer_name: string;
  status: "scored";
  rank: number;
  score: number;
  band: InsurerScore["band"];
  rule_status: InsurerScore["rule_status"];
  confidence: number | null;
  confidence_available: boolean;
  referral_required: boolean;
  manual_review_required: boolean;
  senior_review_required: boolean;
  ruled_out: boolean;
  no_appetite_data: false;
  scored_against_rule_id: string | null;
  unresolved_rule_ids: string[];
  rule_evidence: RuleEvidence[];
  required_documents: RequiredDocumentOutcomeEvidence[];
  score_reconciliation: ScoreReconciliation;
  confidence_reconciliation: ConfidenceReconciliation;
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

export interface NoDataInsurerOutcomeEvidence {
  insurer_id: string;
  insurer_name: string;
  status: "no_appetite_data";
  status_code: "no_active_appetite_data";
  no_appetite_data: true;
  rank: null;
  score: null;
  band: "no_appetite_data";
  rule_status: "no_appetite_data";
  rule_evidence: [];
  required_documents: [];
  outcome_reasons: {
    evidence_gaps: string[];
  };
}

export type InsurerOutcomeEvidence =
  | ScoredInsurerOutcomeEvidence
  | NoDataInsurerOutcomeEvidence;

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
  /** Privacy-minimised copy. Runtime matcher input remains unchanged. */
  matcher_input: PersistedMatcherInput;
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

function hasDisplayValue(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (Array.isArray(value)) return value.some(hasDisplayValue);
  if (typeof value === "object") {
    return Object.values(value as Record<string, unknown>).some(hasDisplayValue);
  }
  return String(value).trim().length > 0;
}

function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
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
    if (!hasDisplayValue(source.value)) continue;
    const confidence = typeof source.confidence === "number" && Number.isFinite(source.confidence)
      ? source.confidence
      : null;
    facts.push({
      field_path: `${spec.section}.${spec.key}`,
      label: spec.label,
      present: true,
      value_retained: false,
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
    if (!hasDisplayValue((raw as { issue?: unknown }).issue)) return;
    facts.push({
      field_path: `red_flags[${index}].issue`,
      label: "Red flag",
      present: true,
      value_retained: false,
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
    present: true,
    value_retained: false,
    source_category: "extraction_metadata",
    matcher_roles: ["confidence"],
    ai_inferred: false,
    confidence: risk.overall_confidence_available === false ? null : risk.overall_confidence,
    confidence_available: risk.overall_confidence_available !== false,
  });
  return facts;
}

function canonicalRisk(risk: MatchInputRisk): PersistedMatcherInput {
  const uniqueSorted = (values: string[]) => [...new Set(values)].sort(compareCodeUnits);
  return {
    product_candidates: [...risk.product_candidates],
    section_candidates: risk.section_candidates ? [...risk.section_candidates] : undefined,
    risk_candidates: [...risk.risk_candidates],
    features: risk.features.map((feature) => ({
      source: typeof feature === "string" ? "feature" : feature.source,
      ai_inferred: typeof feature === "string" ? false : feature.ai_inferred === true,
      value_retained: false as const,
    })),
    available_documents: uniqueSorted(risk.available_documents),
    overall_confidence: risk.overall_confidence,
    overall_confidence_available: risk.overall_confidence_available,
  };
}

/** Marker on the privacy-minimised compatibility snapshot in reasoning_json. */
export const MATCHER_INPUT_SNAPSHOT_MINIMISED = "matcher-input-minimised-v1";

/**
 * The shape persisted at `reasoning_json.matcher_input` for NEW recommendations.
 * It is the same privacy-minimised copy as `evidence_json.matcher_input` plus a
 * version marker, so readers can tell it from historical rows (which carry the
 * raw matcher input under no marker). Property names that existing readers use
 * (`available_documents`, `product_candidates`, `overall_confidence*`, …) are
 * unchanged; only `features[].text` — client free text — is gone.
 */
export function minimisedMatcherInputSnapshot(risk: MatchInputRisk): PersistedMatcherInput & {
  snapshot_version: typeof MATCHER_INPUT_SNAPSHOT_MINIMISED;
} {
  return { snapshot_version: MATCHER_INPUT_SNAPSHOT_MINIMISED, ...canonicalRisk(risk) };
}

const EFFECT_ORDER: Record<EvidenceEffect, number> = {
  preferred: 0,
  standard: 1,
  caution: 2,
  referral: 3,
  soft_decline_referral: 4,
  hard_decline: 5,
  required_document_present: 6,
  required_document_missing: 7,
};

function evidenceId(ruleId: string, component: string, suffix?: string): string {
  return `rule:${ruleId}:${component}${suffix ? `:${suffix}` : ""}`;
}

function snapshotRule(
  rule: AppetiteRow,
  insurerName: string,
  input: {
    effect: EvidenceEffect;
    component: RuleEvidence["matcher_component"];
    scoreContribution: number | null;
    matchedValues?: string[];
    matchedRuleTerms?: MatchedRuleTerm[];
    matchedInputs?: RuleEvidence["matched_input_sources"];
    requiredDocument?: string | null;
  }
): RuleEvidence {
  const matchedValues = [...new Set(input.matchedValues ?? [])].sort(compareCodeUnits);
  const sourceGroups = new Map<string, RuleEvidence["matched_input_sources"][number]>();
  for (const item of input.matchedInputs ?? []) {
    const sourceLabels = [...new Set(item.source_labels)].sort(compareCodeUnits);
    const key = `${sourceLabels.join("\u0000")}:${item.ai_inferred_only ? "1" : "0"}`;
    sourceGroups.set(key, { source_labels: sourceLabels, ai_inferred_only: item.ai_inferred_only });
  }
  const ruleTermPairs = new Map<string, MatchedRuleTerm>();
  for (const item of input.matchedRuleTerms ?? []) {
    const key = `${item.term}\u0000${item.input_source ?? "\u0000"}`;
    ruleTermPairs.set(key, { term: item.term, input_source: item.input_source ?? null });
  }
  return {
    evidence_id: evidenceId(rule.id, input.component, input.requiredDocument?.toLowerCase()),
    rule_id: rule.id,
    insurer_id: rule.insurer_id,
    insurer_name: insurerName,
    product_line: rule.product_line,
    risk_type: rule.risk_type,
    appetite_level: rule.appetite_level,
    effect: input.effect,
    matcher_component: input.component,
    score_contribution: input.scoreContribution,
    matched_value_count: matchedValues.length,
    matched_rule_terms: [...ruleTermPairs.values()].sort((a, b) =>
      compareCodeUnits(a.term, b.term)
      || compareCodeUnits(a.input_source ?? "", b.input_source ?? "")
    ),
    matched_input_sources: [...sourceGroups.entries()]
      .sort(([a], [b]) => compareCodeUnits(a, b))
      .map(([, item]) => item),
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
): {
  evidence: RuleEvidence[];
  unresolvedRuleIds: string[];
  requiredDocuments: RequiredDocumentOutcomeEvidence[];
} {
  const evidence: RuleEvidence[] = [];
  const unresolvedRuleIds: string[] = [];
  for (const ref of insurer.matched_rules) {
    if (!ref.effect) throw new Error(`matcher_effect_missing:${ref.appetite_id}:${ref.list}`);
    const rule = appetiteById.get(ref.appetite_id);
    if (!rule) {
      unresolvedRuleIds.push(ref.appetite_id);
      continue;
    }
    evidence.push(snapshotRule(rule, insurer.insurer_name, {
      effect: ref.effect,
      component: ref.list,
      scoreContribution: ref.score_contribution ?? null,
      matchedValues: ref.matched_strings,
      matchedRuleTerms: ref.matched_rule_terms ?? [],
      matchedInputs: ref.matched_inputs ?? [],
    }));
  }
  const requiredDocuments: RequiredDocumentOutcomeEvidence[] = [];
  for (const doc of insurer.required_document_evidence ?? []) {
    const ruleEvidenceIds: string[] = [];
    for (const appetiteId of doc.appetite_ids) {
      const rule = appetiteById.get(appetiteId);
      if (!rule) {
        unresolvedRuleIds.push(appetiteId);
        continue;
      }
      const snapshot = snapshotRule(rule, insurer.insurer_name, {
        effect: doc.present ? "required_document_present" : "required_document_missing",
        component: "required_document",
        scoreContribution: null,
        requiredDocument: doc.document_type,
      });
      evidence.push(snapshot);
      ruleEvidenceIds.push(snapshot.evidence_id);
    }
    requiredDocuments.push({
      evidence_id: `required-document:${doc.document_type.toLowerCase()}`,
      document_type: doc.document_type,
      present: doc.present,
      rule_evidence_ids: [...new Set(ruleEvidenceIds)].sort(compareCodeUnits),
      confidence_adjustment: doc.confidence_adjustment,
    });
  }
  return {
    evidence: evidence.sort((a, b) =>
      compareCodeUnits(a.rule_id, b.rule_id)
      || EFFECT_ORDER[a.effect] - EFFECT_ORDER[b.effect]
      || compareCodeUnits(a.evidence_id, b.evidence_id)
    ),
    unresolvedRuleIds: [...new Set(unresolvedRuleIds)].sort(compareCodeUnits),
    requiredDocuments: requiredDocuments.sort((a, b) => compareCodeUnits(a.evidence_id, b.evidence_id)),
  };
}

function ids(evidence: RuleEvidence[], predicate: (item: RuleEvidence) => boolean): string[] {
  return evidence.filter(predicate).map((item) => item.evidence_id);
}

function outcomeFor(
  insurer: InsurerScore,
  rules: RuleEvidence[],
  unresolvedRuleIds: string[],
  requiredDocuments: RequiredDocumentOutcomeEvidence[]
): ScoredInsurerOutcomeEvidence {
  if (!Number.isInteger(insurer.rank) || (insurer.rank ?? 0) < 1) {
    throw new Error(`matcher_rank_missing:${insurer.insurer_id}`);
  }
  if (!insurer.score_reconciliation) {
    throw new Error(`matcher_score_reconciliation_missing:${insurer.insurer_id}`);
  }
  if (!insurer.confidence_reconciliation) {
    throw new Error(`matcher_confidence_reconciliation_missing:${insurer.insurer_id}`);
  }
  const missingRuleIds = new Set(
    rules.filter((rule) => rule.source_document_id === null).map((rule) => rule.rule_id)
  );
  return {
    insurer_id: insurer.insurer_id,
    insurer_name: insurer.insurer_name,
    status: "scored",
    rank: insurer.rank!,
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
    required_documents: requiredDocuments,
    score_reconciliation: { ...insurer.score_reconciliation },
    confidence_reconciliation: { ...insurer.confidence_reconciliation },
    outcome_reasons: {
      why_ranked: ids(rules, (rule) => ["preferred", "standard", "caution"].includes(rule.effect)),
      strengthened_by: ids(rules, (rule) => (rule.score_contribution ?? 0) > 0),
      weakened_by: ids(rules, (rule) => (rule.score_contribution ?? 0) < 0),
      cautions: ids(rules, (rule) => rule.effect === "caution"),
      referrals: ids(rules, (rule) => rule.effect === "referral" || rule.effect === "soft_decline_referral"),
      declines: ids(rules, (rule) => rule.effect === "hard_decline"),
      required_documents_present: requiredDocuments.filter((doc) => doc.present).map((doc) => doc.evidence_id),
      required_documents_missing: requiredDocuments.filter((doc) => !doc.present).map((doc) => doc.evidence_id),
      evidence_gaps: [
        ...[...missingRuleIds].map((ruleId) => `rule:${ruleId}:source_document_missing`),
        ...unresolvedRuleIds.map((ruleId) => `rule:${ruleId}:snapshot_missing`),
        ...(insurer.manual_review_required ? [`insurer:${insurer.insurer_id}:taxonomy_match_missing`] : []),
      ].sort(),
    },
    unmatched_sections: [...insurer.unmatched_sections].sort(compareCodeUnits),
    unmatched_product_candidates: [...insurer.unmatched_product_candidates].sort(compareCodeUnits),
    nearby_rule_matches: [...insurer.nearby_rule_matches].sort(compareCodeUnits),
    matcher_notes: [...insurer.scoring_notes],
  };
}

function noDataOutcome(insurer: { insurer_id: string; insurer_name: string }): InsurerOutcomeEvidence {
  return {
    insurer_id: insurer.insurer_id,
    insurer_name: insurer.insurer_name,
    status: "no_appetite_data",
    status_code: "no_active_appetite_data",
    rank: null,
    score: null,
    band: "no_appetite_data",
    rule_status: "no_appetite_data",
    no_appetite_data: true,
    rule_evidence: [],
    required_documents: [],
    outcome_reasons: {
      evidence_gaps: [`insurer:${insurer.insurer_id}:appetite_data_missing`],
    },
  };
}

function qualityGaps(
  facts: ReviewedRiskEvidence[],
  insurers: InsurerOutcomeEvidence[]
): EvidenceQualityGap[] {
  const gaps: EvidenceQualityGap[] = [];
  const seenRules = new Map<string, RuleEvidence>();
  for (const insurer of insurers) {
    if (insurer.status === "no_appetite_data") {
      gaps.push({
        code: "insurer_appetite_data_missing", scope: "insurer", insurer_id: insurer.insurer_id,
        rule_id: null, field_path: null, missing: ["active_appetite_rule"],
      });
      continue;
    }
    if (insurer.manual_review_required) {
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
    if (rule.matched_value_count > 0 && rule.matched_input_sources.length === 0) {
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
    compareCodeUnits(a.code, b.code)
    || compareCodeUnits(a.insurer_id ?? "", b.insurer_id ?? "")
    || compareCodeUnits(a.rule_id ?? "", b.rule_id ?? "")
    || compareCodeUnits(a.field_path ?? "", b.field_path ?? "")
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
  const scored = input.matcherResult.insurers.map((insurer) => {
    const { evidence, unresolvedRuleIds, requiredDocuments } = ruleEvidenceFor(insurer, appetiteById);
    return outcomeFor(insurer, evidence, unresolvedRuleIds, requiredDocuments);
  });
  const noData = [...input.matcherResult.no_data_for]
    .sort((a, b) => compareCodeUnits(a.insurer_name, b.insurer_name) || compareCodeUnits(a.insurer_id, b.insurer_id))
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
      .sort(compareCodeUnits)
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
