/**
 * Atlas — Evidence Mode view model
 * ----------------------------------------------------------------------------
 * Turns the persisted `evidence_json` (recommendation-evidence-v1 or -v2) into
 * the exact lines the Evidence Mode UI shows.
 *
 * Rules this module keeps (and tests enforce):
 *   • evidence_json is the ONLY source. Nothing is reconstructed from reasoning
 *     prose, appetite rows, notes or heuristics.
 *   • It DISPLAYS. It never scores, ranks, classifies materiality or decides
 *     completeness — severity, state, outcome and reflection all arrive already
 *     decided by the Worker. The copy tables below only attach wording.
 *   • Missing stays missing. An absent page, quote, file or document id is
 *     reported as absent; nothing is defaulted, inferred or "best-effort" filled.
 *   • v1 is never promoted to v2. A v1 packet shows what v1 captured and says,
 *     plainly, what it did not (sections, considered rules, severities).
 *   • An unknown or malformed packet degrades to "unsupported" — it never throws.
 *
 * Deliberately a separate module from ./recommendations so that panels and tests
 * which mock the API client keep working without stubbing view logic.
 */

import type {
  EvidenceRule,
  IntelligenceState,
  QualityGapV2,
  QualitySeverity,
  RecommendationEvidence,
  RecommendationEvidenceV1,
  RecommendationEvidenceV2,
  ScoredEvidenceOutcome,
  ScoredEvidenceOutcomeV2,
  ConsideredRuleV2,
  SectionEvaluationV2,
} from "./recommendations";
import type { Tone } from "./status";

/* ---------------------------------------------------------------------------
   Resolving what the row actually holds
   ------------------------------------------------------------------------- */

export type EvidenceView =
  /** Historical recommendation: `evidence_json` is null/absent. */
  | { kind: "absent" }
  /** A schema this build cannot read, or a packet missing required structure. */
  | { kind: "unsupported"; schemaVersion: string | null }
  | { kind: "ready"; version: "v1"; evidence: RecommendationEvidenceV1 }
  | { kind: "ready"; version: "v2"; evidence: RecommendationEvidenceV2 };

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * Classify `evidence_json` without trusting it. Structural checks are the
 * minimum the view needs to render safely; they do not validate semantics.
 */
export function resolveEvidence(value: unknown): EvidenceView {
  if (value === null || value === undefined) return { kind: "absent" };
  if (!isRecord(value)) return { kind: "unsupported", schemaVersion: null };
  const schema = typeof value.schema_version === "string" ? value.schema_version : null;
  const structural =
    Array.isArray(value.insurers) &&
    isRecord(value.provenance) &&
    isRecord(value.quality) &&
    Array.isArray(value.trusted_documents);
  if (!structural) return { kind: "unsupported", schemaVersion: schema };
  if (schema === "recommendation-evidence-v1") {
    return { kind: "ready", version: "v1", evidence: value as unknown as RecommendationEvidenceV1 };
  }
  if (schema === "recommendation-evidence-v2" && isRecord(value.scoring_scope) && Array.isArray(value.requested_sections)) {
    return { kind: "ready", version: "v2", evidence: value as unknown as RecommendationEvidenceV2 };
  }
  return { kind: "unsupported", schemaVersion: schema };
}

/* ---------------------------------------------------------------------------
   Wording tables (presentation only)
   ------------------------------------------------------------------------- */

export interface Labelled {
  label: string;
  tone: Tone;
  description?: string;
}

const EFFECT: Record<string, Labelled> = {
  preferred: { label: "Preferred appetite", tone: "success" },
  standard: { label: "Standard appetite", tone: "neutral" },
  caution: { label: "Caution", tone: "warning" },
  referral: { label: "Referral trigger", tone: "referral" },
  soft_decline_referral: {
    label: "Possible decline — needs human confirmation",
    tone: "referral",
    description:
      "The declined-risk term was matched only in AI-inferred red flags, so it is a referral for a person to confirm, not a decline.",
  },
  hard_decline: {
    label: "Hard decline",
    tone: "danger",
    description: "A declined-risk term matched information read from a document, or the rule itself is declined.",
  },
  required_document_present: { label: "Required document present", tone: "success" },
  required_document_missing: { label: "Required document missing", tone: "warning" },
};

export function effectLabel(effect: string): Labelled {
  return EFFECT[effect] ?? { label: effect.replace(/_/g, " "), tone: "neutral" };
}

const COMPONENT: Record<string, string> = {
  base: "Base appetite for this product and risk type",
  preferred: "Preferred-risk term matched",
  caution: "Caution-risk term matched",
  declined: "Declined-risk term matched",
  referral: "Referral trigger matched",
  portfolio_caution: "Portfolio caution-risk term matched",
  portfolio_declined: "Portfolio declined-risk term matched",
  portfolio_referral: "Portfolio referral trigger matched",
  required_document: "Required document",
};

export function componentLabel(component: string): string {
  return COMPONENT[component] ?? component.replace(/_/g, " ");
}

export const SECTION_OUTCOME: Record<string, Labelled> = {
  hard_decline: { label: "Hard decline", tone: "danger" },
  soft_decline_referral: { label: "Possible decline (AI-inferred)", tone: "referral" },
  referral: { label: "Referral trigger", tone: "referral" },
  caution: { label: "Caution", tone: "warning" },
  preferred: { label: "Preferred", tone: "success" },
  standard: { label: "Standard", tone: "neutral" },
};

export const SEVERITY: Record<QualitySeverity, Labelled> = {
  blocker: {
    label: "Blocker",
    tone: "danger",
    description: "Atlas cannot defend or rely on part of this outcome as presented.",
  },
  material: {
    label: "Material",
    tone: "warning",
    description: "Usable, but this limitation changes how far the outcome can be relied on.",
  },
  advisory: { label: "Advisory", tone: "neutral", description: "Detail that does not change reliance." },
};

export const INTELLIGENCE_STATE: Record<IntelligenceState, Labelled & { meaning: string }> = {
  decision_ready: {
    label: "Decision ready",
    tone: "success",
    meaning: "The evidence is complete enough for normal underwriter consideration.",
  },
  caution: {
    label: "Use with caution",
    tone: "warning",
    meaning: "The recommendation is usable, but material limitations apply. They are shown as evidence gaps.",
  },
  incomplete: {
    label: "Incomplete",
    tone: "warning",
    meaning:
      "Atlas does not have enough deterministic support to present this as a complete recommendation. " +
      "Nothing is blocked or declined by this: it tells you how far to rely on the result.",
  },
};

export interface GapCopy {
  title: string;
  body: string;
}

/** Plain-language wording per gap code. Severity is never decided here. */
const GAP_COPY: Record<string, GapCopy> = {
  insurer_appetite_data_missing: {
    title: "No active appetite data available",
    body: "Atlas has no active appetite rules for this insurer, so it could not be scored. This is a gap in the guideline data, not a decline.",
  },
  matched_rule_snapshot_missing: {
    title: "A rule behind this outcome could not be shown",
    body: "A rule that contributed to this result is not in the active rule set Atlas recorded.",
  },
  rule_source_document_missing: {
    title: "Rule has no source document recorded",
    body: "Atlas cannot trace this rule to a guideline document.",
  },
  rule_source_locator_incomplete: {
    title: "Rule's source location is incomplete",
    body: "The source document is known, but part of its location (file, section, page or excerpt) was not recorded.",
  },
  matched_input_source_missing: {
    title: "Matched term has no input source",
    body: "A rule term matched, but Atlas did not record which part of the submission triggered it.",
  },
  reviewed_fact_confidence_unavailable: {
    title: "Confidence unavailable for a reviewed fact",
    body: "The extraction provider did not give a confidence rating for this reviewed fact.",
  },
  taxonomy_match_missing: {
    title: "No product rule matched",
    body: "No appetite rule for this insurer matched the submitted product, so the ranking is provisional and needs manual review.",
  },
  scored_rule_product_unmatched: {
    title: "Score rests on a risk-type match only",
    body: "The rule that set this score matches the risk type but none of the requested products or sections.",
  },
  scored_rule_selection_tie: {
    title: "Score depends on a tie between equally good rules",
    body: "Several rules matched equally well and disagree. Atlas used a fixed identity order to pick one; that is not an underwriting judgement.",
  },
  requested_section_not_evaluated: {
    title: "A requested section has no applicable rule",
    body: "Atlas found no appetite rule for this requested cover section, so this outcome says nothing about it.",
  },
  section_rule_conflict: {
    title: "Rules for one section disagree",
    body: "Several equally good rules apply to this requested section and disagree. Atlas used a fixed identity order to pick one.",
  },
  section_hard_decline_not_reflected: {
    title: "A requested section is declined but not reflected in the score",
    body: "This insurer's rule for a requested section is a hard decline, yet the insurer's score and status come from a different rule. How to combine sections is an open business decision.",
  },
  section_soft_decline_not_reflected: {
    title: "A possible decline in another section is not reflected in the score",
    body: "A declined-risk term matched only in AI-inferred information for a requested section that the score does not reflect. A person should confirm it.",
  },
  section_referral_not_reflected: {
    title: "A referral trigger in another section is not reflected in the score",
    body: "A requested section has a referral trigger that the insurer-level referral flag and score do not include.",
  },
  section_caution_not_reflected: {
    title: "A caution in another section is not reflected in the score",
    body: "A requested section carries a caution that the score does not include.",
  },
  section_outcome_not_scored: {
    title: "A requested section is shown but not scored",
    body: "Sections are evaluated separately and are not combined into the insurer score. Nothing adverse was found in this one.",
  },
  required_document_missing: {
    title: "Required document not evidenced",
    body: "This document is required by the insurer's guideline and was not among the trusted documents. It reduces confidence only.",
  },
  recommended_insurer_unscored: {
    title: "The recommended insurer has no scored product rule",
    body: "No product-level rule matched the top-ranked insurer, so this recommendation has no deterministic appetite basis.",
  },
  requested_sections_not_declared: {
    title: "No requested cover sections were recorded",
    body: "The reviewed submission lists no cover sections, so there was nothing to evaluate section by section.",
  },
  no_trusted_documents: {
    title: "No trusted documents were available",
    body: "Atlas counts only active documents with a clean scan. None were available when this ran.",
  },
};

/** Wording for the machine tokens in a gap's `missing` list. */
const MISSING_LABEL: Record<string, string> = {
  source_document_id: "source document",
  source_file_name: "file name",
  source_page: "page",
  source_section: "section",
  source_quote: "source excerpt",
  active_appetite_rule: "active appetite rule",
  active_rule_snapshot: "rule snapshot",
  matched_input_sources: "input source for a matched term",
  matched_product_rule: "matched product rule",
  scored_product_rule: "scored product rule",
  product_line_match: "product line match",
  applicable_rule: "applicable rule",
  section_outcome_in_score: "this section's outcome in the score",
  unambiguous_rule_selection: "an unambiguous choice between rules",
  requested_cover_sections: "requested cover sections",
  trusted_document: "trusted document",
  confidence: "confidence rating",
};

export function missingLabel(token: string): string {
  return MISSING_LABEL[token] ?? token.replace(/_/g, " ");
}

export function gapCopy(code: string): GapCopy {
  return GAP_COPY[code] ?? { title: "Evidence gap", body: `Atlas recorded a gap that this version cannot describe (${code}).` };
}

/* ---------------------------------------------------------------------------
   Provenance
   ------------------------------------------------------------------------- */

export interface ProvenanceView {
  source: "ai_extracted" | "manual" | null;
  documentId: string | null;
  fileName: string | null;
  section: string | null;
  page: number | null;
  quote: string | null;
  /** Human labels of what is not recorded, e.g. ["source document", "page"]. */
  missing: string[];
  /** True only when document, file, section, page and excerpt are all recorded. */
  complete: boolean;
}

export function provenanceOf(rule: {
  source: "ai_extracted" | "manual" | null;
  source_document_id: string | null;
  source_file_name: string | null;
  source_page: number | null;
  source_section: string | null;
  source_quote: string | null;
}): ProvenanceView {
  const missing: string[] = [];
  if (!rule.source_document_id) missing.push("source document");
  if (!rule.source_file_name) missing.push("file name");
  if (!rule.source_section) missing.push("section");
  if (rule.source_page === null || rule.source_page === undefined) missing.push("page");
  if (!rule.source_quote) missing.push("source excerpt");
  return {
    source: rule.source,
    documentId: rule.source_document_id ?? null,
    fileName: rule.source_file_name ?? null,
    section: rule.source_section ?? null,
    page: rule.source_page ?? null,
    quote: rule.source_quote ?? null,
    missing,
    complete: missing.length === 0,
  };
}

/* ---------------------------------------------------------------------------
   Per-insurer view
   ------------------------------------------------------------------------- */

export interface RuleLine {
  evidenceId: string;
  ruleId: string;
  effect: string;
  effectMeta: Labelled;
  /** The matcher component that emitted this entry (base, preferred, caution, …). */
  component: string;
  componentLabel: string;
  productLine: string;
  riskType: string;
  appetiteLevel: string;
  /** Exact matcher delta, or null (hard outcomes carry no additive score). */
  contribution: number | null;
  contributionLabel: string;
  terms: { term: string; source: string | null }[];
  provenance: ProvenanceView;
}

export interface DocumentLine {
  documentType: string;
  present: boolean;
  confidenceAdjustment: number;
  requiredBy: { ruleId: string; productLine: string; riskType: string; portfolio: boolean }[];
}

export interface SectionLine {
  section: string;
  sectionKey: string;
  status: "evaluated" | "no_applicable_rule";
  outcome: SectionEvaluationV2["outcome"];
  outcomeMeta: Labelled | null;
  selectedRule: { ruleId: string; productLine: string; riskType: string; appetiteLevel: string } | null;
  tied: boolean;
  tiedDisagree: boolean;
  reflected: boolean;
}

export interface ConsideredLine {
  ruleId: string;
  productLine: string;
  riskType: string;
  appetiteLevel: string;
  scored: boolean;
  notScoredReason: ConsideredRuleV2["not_scored_reason"];
  sectionNames: string[];
  conditions: {
    kind: string;
    meta: Labelled;
    terms: { term: string; source: string | null }[];
    fromRuleLevel: boolean;
  }[];
  provenance: ProvenanceView | null;
}

export interface GapLine {
  gapId: string;
  /** Set on recommendation-level lists, where gaps from several insurers are shown together. */
  insurerName: string | null;
  code: string;
  severity: QualitySeverity | null;
  copy: GapCopy;
  section: string | null;
  rule: string | null;
  missing: string[];
}

export interface InsurerEvidenceView {
  version: "v1" | "v2";
  status: "scored";
  insurerId: string;
  insurerName: string;
  rank: number;
  score: number;
  band: ScoredEvidenceOutcome["band"];
  ruleStatus: ScoredEvidenceOutcome["rule_status"];
  flags: { referral: boolean; manualReview: boolean; seniorReview: boolean; ruledOut: boolean };
  confidence: number | null;
  scoreReconciliation: ScoredEvidenceOutcome["score_reconciliation"];
  confidenceReconciliation: ScoredEvidenceOutcome["confidence_reconciliation"];
  ranking: { whyRanked: RuleLine[]; strengthened: RuleLine[]; weakened: RuleLine[] };
  rules: RuleLine[];
  triggers: { hardDeclines: RuleLine[]; softDeclines: RuleLine[]; referrals: RuleLine[]; cautions: RuleLine[] };
  documents: { present: DocumentLine[]; missing: DocumentLine[] };
  trustedDocuments: string[];
  /** v2 only; null on v1 means "not captured", never "none". */
  sections: SectionLine[] | null;
  considered: ConsideredLine[] | null;
  selection: ScoredEvidenceOutcomeV2["selection"] | null;
  scoringStatement: string | null;
  gaps: GapLine[];
  quality: { mode: "v2"; state: IntelligenceState; blockers: number; material: number; advisory: number }
    | { mode: "v1"; status: RecommendationEvidenceV1["quality"]["status"]; gapCount: number };
  unmatched: { sections: string[]; products: string[]; nearby: string[] };
  provenanceRules: { rule: RuleLine | null; ruleId: string; productLine: string; riskType: string; provenance: ProvenanceView }[];
  diagnostics: {
    schemaVersion: string;
    recommendationId: string;
    extractionId: string;
    matcherVersion: string;
    taxonomyVersion: string;
    fingerprint: string;
    scoredRuleId: string | null;
    unresolvedRuleIds: string[];
    evidenceIds: string[];
    qualityModel: string | null;
  };
}

export interface NoDataInsurerView {
  status: "no_data";
  insurerId: string;
  insurerName: string;
  message: string;
}

export type InsurerView = InsurerEvidenceView | NoDataInsurerView;

function signed(value: number): string {
  return `${value > 0 ? "+" : value < 0 ? "−" : ""}${Math.abs(value)}`;
}

function ruleLine(rule: EvidenceRule): RuleLine {
  const contribution = rule.score_contribution;
  return {
    evidenceId: rule.evidence_id,
    ruleId: rule.rule_id,
    effect: rule.effect,
    effectMeta: effectLabel(rule.effect),
    component: rule.matcher_component,
    componentLabel: componentLabel(rule.matcher_component),
    productLine: rule.product_line,
    riskType: rule.risk_type,
    appetiteLevel: rule.appetite_level,
    contribution,
    contributionLabel:
      contribution === null
        ? rule.effect === "hard_decline"
          ? "No additive score — insurer ruled out"
          : "No score effect"
        : `${signed(contribution)} points`,
    terms: rule.matched_rule_terms.map((pair) => ({ term: pair.term, source: pair.input_source })),
    provenance: provenanceOf({
      source: rule.source,
      source_document_id: rule.source_document_id,
      source_file_name: rule.source_file_name,
      source_page: rule.source_page,
      source_section: rule.source_section,
      source_quote: rule.source_quote,
    }),
  };
}

function scoredView(
  version: "v1" | "v2",
  evidence: RecommendationEvidence,
  outcome: ScoredEvidenceOutcome | ScoredEvidenceOutcomeV2
): InsurerEvidenceView {
  const v2Outcome = version === "v2" ? (outcome as ScoredEvidenceOutcomeV2) : null;
  const v2Evidence = version === "v2" ? (evidence as RecommendationEvidenceV2) : null;

  const nonDocument = outcome.rule_evidence.filter((rule) => rule.matcher_component !== "required_document");
  const lines = nonDocument.map(ruleLine);
  const byId = new Map(lines.map((line) => [line.evidenceId, line]));
  const pick = (ids: string[]): RuleLine[] =>
    ids.map((id) => byId.get(id)).filter((line): line is RuleLine => !!line);

  // Rule context for wording (product line / risk type) comes only from rules
  // the packet already carries for this insurer.
  const ruleContext = new Map<string, { productLine: string; riskType: string }>();
  for (const rule of outcome.rule_evidence) ruleContext.set(rule.rule_id, { productLine: rule.product_line, riskType: rule.risk_type });
  for (const rule of v2Outcome?.considered_rules ?? []) ruleContext.set(rule.rule_id, { productLine: rule.product_line, riskType: rule.risk_type });

  const documents = outcome.required_documents.map<DocumentLine>((doc) => ({
    documentType: doc.document_type,
    present: doc.present,
    confidenceAdjustment: doc.confidence_adjustment,
    requiredBy: doc.rule_evidence_ids
      .map((id) => outcome.rule_evidence.find((rule) => rule.evidence_id === id))
      .filter((rule): rule is EvidenceRule => !!rule)
      .map((rule) => ({
        ruleId: rule.rule_id,
        productLine: rule.product_line,
        riskType: rule.risk_type,
        portfolio: rule.product_line.trim() === "*" && rule.risk_type.trim() === "*",
      })),
  }));

  const sections: SectionLine[] | null = v2Outcome
    ? v2Outcome.section_evaluations.map<SectionLine>((section) => {
        const selected = section.selected_rule_id ? ruleContext.get(section.selected_rule_id) : undefined;
        const considered = v2Outcome.considered_rules.find((rule) => rule.rule_id === section.selected_rule_id);
        return {
          section: section.section,
          sectionKey: section.section_key,
          status: section.status,
          outcome: section.outcome,
          outcomeMeta: section.outcome ? SECTION_OUTCOME[section.outcome] : null,
          selectedRule: section.selected_rule_id
            ? {
                ruleId: section.selected_rule_id,
                productLine: selected?.productLine ?? "",
                riskType: selected?.riskType ?? "",
                appetiteLevel: considered?.appetite_level ?? "",
              }
            : null,
          tied: section.tied_rule_ids.length > 1,
          tiedDisagree: section.tied_rules_disagree,
          reflected: section.reflected_in_insurer_outcome,
        };
      })
    : null;

  const sectionName = new Map((v2Evidence?.requested_sections ?? []).map((item) => [item.section_key, item.section]));
  const considered: ConsideredLine[] | null = v2Outcome
    ? v2Outcome.considered_rules.map<ConsideredLine>((rule) => ({
        ruleId: rule.rule_id,
        productLine: rule.product_line,
        riskType: rule.risk_type,
        appetiteLevel: rule.appetite_level,
        scored: rule.scored,
        notScoredReason: rule.not_scored_reason,
        sectionNames: rule.section_keys.map((key) => sectionName.get(key) ?? key),
        conditions: rule.conditions.map((condition) => ({
          kind: condition.kind,
          meta: effectLabel(condition.kind),
          terms: condition.matched_rule_terms.map((pair) => ({ term: pair.term, source: pair.input_source })),
          fromRuleLevel: condition.origin === "appetite_level",
        })),
        provenance: rule.snapshot_resolved
          ? provenanceOf({
              source: rule.source,
              source_document_id: rule.source_document_id,
              source_file_name: rule.source_file_name,
              source_page: rule.source_page,
              source_section: rule.source_section,
              source_quote: rule.source_quote,
            })
          : null,
      }))
    : null;

  const gaps: GapLine[] = v2Evidence
    ? v2Evidence.quality.gaps
        .filter((gap: QualityGapV2) => gap.insurer_id === outcome.insurer_id)
        .map((gap) => ({
          gapId: gap.gap_id,
          insurerName: null,
          code: gap.code,
          severity: gap.severity,
          copy: gapCopy(gap.code),
          section: gap.section_key ? sectionName.get(gap.section_key) ?? gap.section_key : null,
          rule: gap.rule_id,
          missing: gap.missing,
        }))
    : (evidence as RecommendationEvidenceV1).quality.gaps
        .filter((gap) => gap.insurer_id === outcome.insurer_id)
        .map((gap, index) => ({
          gapId: `v1:${gap.code}:${gap.rule_id ?? "-"}:${index}`,
          insurerName: null,
          code: gap.code,
          severity: null,
          copy: gapCopy(gap.code),
          section: null,
          rule: gap.rule_id,
          missing: gap.missing,
        }));

  // Provenance table: every distinct rule the packet carries for this insurer.
  const seen = new Set<string>();
  const provenanceRules: InsurerEvidenceView["provenanceRules"] = [];
  for (const line of lines) {
    if (seen.has(line.ruleId)) continue;
    seen.add(line.ruleId);
    provenanceRules.push({ rule: line, ruleId: line.ruleId, productLine: line.productLine, riskType: line.riskType, provenance: line.provenance });
  }
  for (const rule of outcome.rule_evidence) {
    if (seen.has(rule.rule_id)) continue;
    seen.add(rule.rule_id);
    const line = ruleLine(rule);
    provenanceRules.push({ rule: null, ruleId: rule.rule_id, productLine: line.productLine, riskType: line.riskType, provenance: line.provenance });
  }
  for (const rule of considered ?? []) {
    if (seen.has(rule.ruleId) || !rule.provenance) continue;
    seen.add(rule.ruleId);
    provenanceRules.push({ rule: null, ruleId: rule.ruleId, productLine: rule.productLine, riskType: rule.riskType, provenance: rule.provenance });
  }

  const quality: InsurerEvidenceView["quality"] = v2Outcome
    ? {
        mode: "v2",
        state: v2Outcome.quality.state,
        blockers: v2Outcome.quality.blocker_count,
        material: v2Outcome.quality.material_count,
        advisory: v2Outcome.quality.advisory_count,
      }
    : {
        mode: "v1",
        status: (evidence as RecommendationEvidenceV1).quality.status,
        gapCount: gaps.length,
      };

  return {
    version,
    status: "scored",
    insurerId: outcome.insurer_id,
    insurerName: outcome.insurer_name,
    rank: outcome.rank,
    score: outcome.score,
    band: outcome.band,
    ruleStatus: outcome.rule_status,
    flags: {
      referral: outcome.referral_required,
      manualReview: outcome.manual_review_required,
      seniorReview: outcome.senior_review_required,
      ruledOut: outcome.ruled_out,
    },
    confidence: outcome.confidence,
    scoreReconciliation: outcome.score_reconciliation,
    confidenceReconciliation: outcome.confidence_reconciliation,
    ranking: {
      whyRanked: pick(outcome.outcome_reasons.why_ranked),
      strengthened: pick(outcome.outcome_reasons.strengthened_by),
      weakened: pick(outcome.outcome_reasons.weakened_by),
    },
    rules: lines,
    triggers: {
      hardDeclines: lines.filter((line) => line.effect === "hard_decline"),
      softDeclines: lines.filter((line) => line.effect === "soft_decline_referral"),
      referrals: lines.filter((line) => line.effect === "referral"),
      cautions: lines.filter((line) => line.effect === "caution"),
    },
    documents: {
      present: documents.filter((doc) => doc.present),
      missing: documents.filter((doc) => !doc.present),
    },
    trustedDocuments: evidence.trusted_documents.map((doc) => doc.document_type),
    sections,
    considered,
    selection: v2Outcome ? v2Outcome.selection : null,
    scoringStatement: v2Evidence
      ? v2Evidence.scoring_scope.section_outcomes === "evaluated_not_aggregated"
        ? "This score comes from the single best-matching product rule plus any portfolio rules. Requested cover sections are evaluated separately and are not combined into the score."
        : null
      : null,
    gaps,
    quality,
    unmatched: {
      sections: outcome.unmatched_sections,
      products: outcome.unmatched_product_candidates,
      nearby: outcome.nearby_rule_matches,
    },
    provenanceRules,
    diagnostics: {
      schemaVersion: evidence.schema_version,
      recommendationId: evidence.provenance.recommendation_id,
      extractionId: evidence.provenance.extraction_id,
      matcherVersion: evidence.provenance.matcher_version,
      taxonomyVersion: evidence.provenance.taxonomy_version,
      fingerprint: evidence.provenance.recommendation_input_fingerprint,
      scoredRuleId: outcome.scored_against_rule_id,
      unresolvedRuleIds: outcome.unresolved_rule_ids,
      evidenceIds: outcome.rule_evidence.map((rule) => rule.evidence_id),
      qualityModel: v2Evidence ? v2Evidence.quality.model : null,
    },
  };
}

/**
 * One insurer's evidence, or null when the packet has no outcome for that id
 * (a partial/foreign packet — never fabricated).
 */
export function insurerView(view: EvidenceView, insurerId: string): InsurerView | null {
  if (view.kind !== "ready") return null;
  const outcome = (view.evidence.insurers as (ScoredEvidenceOutcome | ScoredEvidenceOutcomeV2 | { status: string; insurer_id: string; insurer_name: string })[])
    .find((item) => item.insurer_id === insurerId);
  if (!outcome) return null;
  if (outcome.status === "no_appetite_data") {
    return {
      status: "no_data",
      insurerId: outcome.insurer_id,
      insurerName: outcome.insurer_name,
      message: "No active appetite data available",
    };
  }
  return scoredView(view.version, view.evidence, outcome as ScoredEvidenceOutcome | ScoredEvidenceOutcomeV2);
}

/** Ids of insurers the packet reports as having no appetite data (explicit, not inferred). */
export function noDataInsurers(view: EvidenceView): { insurerId: string; insurerName: string }[] {
  if (view.kind !== "ready") return [];
  return (view.evidence.insurers as { status: string; insurer_id: string; insurer_name: string }[])
    .filter((item) => item.status === "no_appetite_data")
    .map((item) => ({ insurerId: item.insurer_id, insurerName: item.insurer_name }));
}

/* ---------------------------------------------------------------------------
   Recommendation-level quality
   ------------------------------------------------------------------------- */

export interface RecommendationQualityView {
  mode: "v2" | "v1";
  state: IntelligenceState | null;
  legacyStatus: "complete" | "gaps_present" | null;
  blockers: number;
  material: number;
  advisory: number;
  gapCount: number;
  gaps: GapLine[];
  scoringStatement: string | null;
  requestedSections: string[];
  matcherVersion: string;
}

export function recommendationQuality(view: EvidenceView): RecommendationQualityView | null {
  if (view.kind !== "ready") return null;
  const names = new Map(
    (view.evidence.insurers as { insurer_id: string; insurer_name: string }[]).map((item) => [item.insurer_id, item.insurer_name])
  );
  if (view.version === "v2") {
    const evidence = view.evidence;
    const sectionName = new Map(evidence.requested_sections.map((item) => [item.section_key, item.section]));
    return {
      mode: "v2",
      state: evidence.quality.state,
      legacyStatus: null,
      blockers: evidence.quality.blocker_count,
      material: evidence.quality.material_count,
      advisory: evidence.quality.advisory_count,
      gapCount: evidence.quality.gaps.length,
      gaps: evidence.quality.gaps.map((gap) => ({
        gapId: gap.gap_id,
        code: gap.code,
        severity: gap.severity,
        copy: gapCopy(gap.code),
        section: gap.section_key ? sectionName.get(gap.section_key) ?? gap.section_key : null,
        rule: gap.rule_id,
        missing: gap.missing,
        insurerName: gap.insurer_id ? names.get(gap.insurer_id) ?? null : null,
      })),
      scoringStatement:
        evidence.scoring_scope.section_outcomes === "evaluated_not_aggregated"
          ? "Each insurer's score comes from its single best-matching product rule plus any portfolio rules. Requested cover sections are evaluated separately and are not combined into the score."
          : null,
      requestedSections: evidence.requested_sections.map((item) => item.section),
      matcherVersion: evidence.provenance.matcher_version,
    };
  }
  const evidence = view.evidence;
  return {
    mode: "v1",
    state: null,
    legacyStatus: evidence.quality.status,
    blockers: 0,
    material: 0,
    advisory: 0,
    gapCount: evidence.quality.gaps.length,
    gaps: evidence.quality.gaps.map((gap, index) => ({
      gapId: `v1:${gap.code}:${gap.rule_id ?? "-"}:${index}`,
      code: gap.code,
      severity: null,
      copy: gapCopy(gap.code),
      section: null,
      rule: gap.rule_id,
      missing: gap.missing,
      insurerName: gap.insurer_id ? names.get(gap.insurer_id) ?? null : null,
    })),
    scoringStatement: null,
    requestedSections: [],
    matcherVersion: evidence.provenance.matcher_version,
  };
}
