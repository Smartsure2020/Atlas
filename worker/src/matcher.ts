/**
 * Atlas Blueprint — deterministic matcher (candidate-list matching)
 * ----------------------------------------------------------------------------
 * REPLACES the previous matcher.ts. Two material changes:
 *
 * (1) CANDIDATE LISTS for product/risk taxonomy.
 *     The previous version took a single product_line and a single risk_type
 *     from the submission. That worked when the extraction's risk_classification
 *     directly described what cover the submission needs — but in real
 *     commercial submissions, "what cover is needed" lives across multiple
 *     fields: cover_sections, secondary_risk_types, and only sometimes the
 *     primary_risk_type. So the matcher input is now `product_candidates` and
 *     `risk_candidates` as arrays. taxonomyQuality is computed for every
 *     (candidate × rule) pairing, and the best quality wins.
 *
 * (2) no_data_for IS NARROWER.
 *     Before: an insurer with active rules but no taxonomy match was hidden in
 *     no_data_for. Misleading — they clearly HAVE appetite, the matcher just
 *     couldn't connect the submission's words to it.
 *     Now: no_data_for is reserved for insurers with literally zero active
 *     rules. Everyone else who can't find a product match falls through to
 *     the "standard baseline" path (already in the code from the portfolio
 *     overlay refinement) and is presented with a note explaining the lack
 *     of a specific product match.
 *
 * The rubric is unchanged. The portfolio overlay is unchanged. Single best
 * match preserves predictable scoring (no inflation from multi-cover bundles).
 * The structural fix — per-cover-section scoring — is the better answer
 * eventually but is deliberately deferred.
 *
 * POWERHOUSE (matcher 2026-10-section-evaluation-v2) — what changed and what
 * deliberately did not:
 *
 *   UNCHANGED  Every score, band, rule_status, ruled_out, referral, review flag,
 *              required-document effect, confidence value and scoring note is
 *              produced by exactly the v1 scoring code path. A one-section
 *              submission is byte-for-byte v1 (see tests/powerhouse).
 *              How several section outcomes would combine into one insurer
 *              score is a business decision this module does NOT make.
 *
 *   ADDED      (a) Deterministic input order: appetite rows are put in a
 *                  canonical order before matching, and equal-scoring insurers
 *                  are ordered by a defined key, so no result depends on the
 *                  order the database returned rows in.
 *              (b) Additive, read-only section intelligence per insurer:
 *                  `selection`, `section_evaluations`, `considered_rules`.
 *                  These re-run the SAME term scan used for scoring against
 *                  rules the single-best-rule selector did not pick, so a
 *                  decline / referral / caution in another requested section
 *                  is visible instead of silently dropped. They never feed
 *                  back into `score`, `rank` or any flag.
 */

import type { AppetiteRow, AppetiteLevel } from "./matcher-types";
import {
  canonicalTaxonomyKey,
  nearbyTaxonomyMatches,
  normalizeLoose,
  taxonomyKeysRelated,
} from "./taxonomy.js";

/**
 * Bumped whenever the scoring rubric or matching semantics change. Stored on
 * every recommendation (with the matcher input) so an old recommendation can
 * be reconstructed and defended without replaying current code against it.
 */
export const MATCHER_VERSION = "2026-10-section-evaluation-v2";

/**
 * The matcher version that preceded Powerhouse. Scoring semantics are identical
 * between the two; v2 adds deterministic ordering and section intelligence.
 * Kept so parity tests and historical-row display can name it without
 * hard-coding the string in several places.
 */
export const MATCHER_VERSION_V1 = "2026-07-token-matching-v1";

const BASE_SCORE: Record<AppetiteLevel, number> = {
  preferred: 100,
  standard: 70,
  caution: 40,
  declined: 0,
};

const PREFERRED_PER_MATCH = 5;
const PREFERRED_MATCH_CAP = 20;
const CAUTION_PER_MATCH = 10;
const REFERRAL_TRIGGER_PENALTY = 8;
const DOC_GAP_CONFIDENCE_PENALTY = 0.1;
const DOC_GAP_CONFIDENCE_CAP = 0.3;
const CAUTION_BAND_MAX = 50;

const PORTFOLIO = "*";

/**
 * A feature the matcher scans against a rule's preferred/caution/declined/
 * referral term lists. `source` names where the text came from (so scoring
 * notes can show provenance) and `ai_inferred` marks text the AI produced
 * itself (red-flag issues) rather than read from a document. AI-inferred
 * matches never hard-rule an insurer out on their own — they downgrade to
 * a referral that needs human confirmation.
 */
export interface RiskFeature {
  text: string;
  source: string;
  ai_inferred?: boolean;
}

/** Plain strings are accepted for backward compatibility and treated as
 *  document-derived features with a generic source label. */
export type FeatureInput = string | RiskFeature;

export type MatcherRuleEffect =
  | "preferred"
  | "standard"
  | "caution"
  | "referral"
  | "hard_decline"
  | "soft_decline_referral";

export interface MatchedRuleTerm {
  /** Exact insurer-owned term from the appetite rule list. */
  term: string;
  /** Authoritative matcher feature-source label; null is never guessed. */
  input_source: string | null;
}

export interface MatchInputRisk {
  /** All taxonomy candidates that describe what COVER this submission needs.
   *  Built in deriveRisk() from cover_sections, secondary_risk_types, and
   *  primary_risk_type — whichever are present, all passed forward. */
  product_candidates: string[];
  section_candidates?: string[];
  /** Same idea for risk type — business sector, secondary types, anything
   *  the extraction surfaced that an appetite rule's risk_type might
   *  token-match. */
  risk_candidates: string[];
  features: FeatureInput[];
  available_documents: string[];
  /**
   * The provider-supplied overall confidence for the extraction this match is
   * running against. The numeric value alone is NOT enough — a value of 0 can
   * mean either "provider rated everything zero" (available) OR "no rating
   * available, compatibility numeric" (unavailable). Consult the availability
   * flag for that distinction.
   */
  overall_confidence: number;
  /**
   * Explicit availability of the overall confidence rating.
   *   true       — a provider rating exists (numeric may be any value in [0,1])
   *   false      — no rating available; the numeric is compatibility-only 0
   *   undefined  — legacy-compatible: treated as available (historical rows
   *                predate the flag). NEVER treat undefined as unavailable.
   */
  overall_confidence_available?: boolean;
}

export interface MatchedRuleRef {
  appetite_id: string;
  matched_strings: string[];
  /** Authoritative semantic effect. Evidence consumers must copy this value;
   * they must never reconstruct hard/soft decline meaning heuristically. */
  effect?: MatcherRuleEffect;
  /** Exact additive score delta emitted by the authoritative matcher. Null for
   * hard outcomes (for example a decline that zeroes the score). */
  score_contribution?: number | null;
  /** Structured linkage back to the reviewed matcher features that hit. */
  matched_inputs?: {
    value: string;
    source_labels: string[];
    ai_inferred_only: boolean;
  }[];
  /** Additive evidence output pairing insurer-owned terms with hit sources. */
  matched_rule_terms?: MatchedRuleTerm[];
  rule_product_line?: string;
  rule_risk_type?: string;
  source_quote?: string | null;
  source_page?: number | null;
  source_section?: string | null;
  source_file_name?: string | null;
  list:
    | "preferred"
    | "caution"
    | "declined"
    | "referral"
    | "base"
    | "portfolio_caution"
    | "portfolio_declined"
    | "portfolio_referral";
}

export interface RequiredDocumentEvidence {
  document_type: string;
  present: boolean;
  appetite_ids: string[];
  scopes: ("product" | "portfolio")[];
  /** Actual confidence delta applied once for this canonical document gap. */
  confidence_adjustment: number;
}

export interface ScoreReconciliation {
  component_subtotal: number;
  hard_decline_adjustment: number;
  clamp_adjustment: number;
  final_score: number;
}

export interface ConfidenceReconciliation {
  input_confidence: number | null;
  input_confidence_available: boolean;
  required_document_adjustment: number;
  manual_review_cap_adjustment: number;
  final_confidence: number | null;
}

// ---------------------------------------------------------------------------
// Section intelligence (read-only; never feeds the score)
// ---------------------------------------------------------------------------

/** What a rule's term lists produced against the submitted features. */
export type RuleConditionKind =
  | "hard_decline"
  | "soft_decline_referral"
  | "referral"
  | "caution"
  | "preferred";

export type RuleConditionOrigin =
  | "appetite_level"
  | "declined_risks"
  | "referral_triggers"
  | "caution_risks"
  | "preferred_risks";

export interface RuleCondition {
  kind: RuleConditionKind;
  origin: RuleConditionOrigin;
  /** Insurer-owned terms paired with the authoritative feature-source label.
   *  Empty for `appetite_level` origin (the rule itself is declined). */
  matched_rule_terms: MatchedRuleTerm[];
}

/**
 * How one rule was chosen among its competitors. `only_candidate`: a single
 * rule qualified. `highest_taxonomy_quality`: one rule strictly outscored the
 * rest. `tie_broken_by_canonical_order`: several rules were equally good and
 * the lowest canonical rule order won — a policy-neutral identity tie-break,
 * NOT an underwriting judgement.
 */
export type SelectionBasis =
  | "only_candidate"
  | "highest_taxonomy_quality"
  | "tie_broken_by_canonical_order";

/**
 * Worst-first label for the selected rule of a section. Presentation
 * precedence only (hard_decline > soft_decline_referral > referral > caution >
 * preferred > standard); it is never used to compute a score.
 */
export type SectionOutcome =
  | "hard_decline"
  | "soft_decline_referral"
  | "referral"
  | "caution"
  | "preferred"
  | "standard";

export interface RequestedSection {
  /** As submitted (first spelling seen). */
  section: string;
  /** Canonical taxonomy key — the identity used for matching and de-duplication. */
  section_key: string;
}

export interface SectionEvaluation extends RequestedSection {
  status: "evaluated" | "no_applicable_rule";
  /** Product rules whose product line relates to this section, best first. */
  applicable_rule_ids: string[];
  selected_rule_id: string | null;
  selection_basis: SelectionBasis | null;
  /** Equally good rules (including the selected one) when more than one tied. */
  tied_rule_ids: string[];
  /** True when tied rules differ in appetite level or in any condition kind. */
  tied_rules_disagree: boolean;
  outcome: SectionOutcome | null;
  /** True only when the selected rule is the one that set the insurer's score. */
  reflected_in_insurer_outcome: boolean;
}

export interface ConsideredRule {
  rule_id: string;
  product_line: string;
  risk_type: string;
  appetite_level: AppetiteLevel;
  /** Whole-submission taxonomy quality used by the v1 selector (1, 2 or 3). */
  taxonomy_quality: 1 | 2 | 3;
  /** Requested sections this rule is applicable to (canonical keys). */
  section_keys: string[];
  /** Sections for which this rule is the selected rule. */
  selected_for_section_keys: string[];
  /** True when this rule set the insurer's base outcome and score. */
  scored: boolean;
  not_scored_reason: "lower_taxonomy_quality" | "lost_tie_canonical_order" | null;
  conditions: RuleCondition[];
}

export interface InsurerSelection {
  /** The single product rule the score is based on (null: none qualified). */
  product_rule_id: string | null;
  taxonomy_quality: 1 | 2 | 3 | null;
  basis: SelectionBasis | null;
  tied_rule_ids: string[];
  tied_rules_disagree: boolean;
  /** Product rules with quality >= 1 (the selector's candidate pool). */
  matching_rule_count: number;
  /** Matching rules NOT listed in `considered_rules`: risk-type-only matches
   *  that neither tied for best nor relate to a requested product/section. */
  omitted_risk_only_rule_count: number;
}

export interface InsurerScore {
  insurer_id: string;
  insurer_name: string;
  /** Authoritative one-based rank assigned after the matcher finishes sorting. */
  rank?: number;
  score: number;
  band: AppetiteLevel | "ruled_out" | "insufficient_rule_match";
  rule_status: AppetiteLevel | "referral" | "ruled_out" | "insufficient_rule_match";
  /**
   * Compatibility numeric — 0 when the underlying extraction confidence is
   * unavailable. Consumers MUST NOT read this in isolation; use
   * `confidence_available` to distinguish "provider rated 0" from "no rating".
   */
  confidence: number;
  /** Explicit provenance flag for `confidence` (see MatchInputRisk). */
  confidence_available: boolean;
  referral_required: boolean;
  manual_review_required: boolean;
  senior_review_required: boolean;
  ruled_out: boolean;
  scored_against_appetite_id: string | null;
  matched_rules: MatchedRuleRef[];
  /** Present on new matcher outputs; optional keeps historical fixtures/payloads readable. */
  required_document_evidence?: RequiredDocumentEvidence[];
  score_reconciliation?: ScoreReconciliation;
  confidence_reconciliation?: ConfidenceReconciliation;
  scoring_notes: string[];
  missing_required_documents: string[];
  unmatched_sections: string[];
  unmatched_product_candidates: string[];
  nearby_rule_matches: string[];
  /** How the single scoring rule was selected. Read-only; absent on historical payloads. */
  selection?: InsurerSelection;
  /** One entry per requested cover section. Read-only; never aggregated into `score`. */
  section_evaluations?: SectionEvaluation[];
  /** Relevant rules the selector saw, bounded to the submitted product/section/risk. */
  considered_rules?: ConsideredRule[];
}

export interface MatchResult {
  insurers: InsurerScore[];
  no_data_for: { insurer_id: string; insurer_name: string }[];
  /** The de-duplicated cover sections the submission asked for. */
  requested_sections?: RequestedSection[];
}

const lower = (s: string) => s.toLowerCase();

/** Lowercase, separators → spaces, collapse whitespace, trim. */
function normTaxonomy(s: string): string {
  return canonicalTaxonomyKey(s);
}

/**
 * Best taxonomy-quality across all (product_candidate × risk_candidate) pairs
 * for this appetite rule. Returns the same 3/2/1/-1 scale as before:
 *   3 = both product and risk match (related canonical keys)
 *   2 = only product matches
 *   1 = only risk matches
 *  -1 = nothing matches any candidate
 * Keys are compared with taxonomyKeysRelated() — equality or underscore-token
 * containment — never raw substring containment, which produced silent false
 * positives ("risk" matching "business_all_risks").
 */
function taxonomyQualityWithCandidates(
  productCandidates: string[],
  riskCandidates: string[],
  rule: AppetiteRow
): number {
  const aPL = normTaxonomy(rule.product_line);
  const aRT = normTaxonomy(rule.risk_type);

  let bestPL = false;
  for (const c of productCandidates) {
    if (!c) continue;
    const n = normTaxonomy(c);
    if (n && aPL && taxonomyKeysRelated(aPL, n)) { bestPL = true; break; }
  }

  let bestRT = false;
  for (const c of riskCandidates) {
    if (!c) continue;
    const n = normTaxonomy(c);
    if (n && aRT && taxonomyKeysRelated(aRT, n)) { bestRT = true; break; }
  }

  if (bestPL && bestRT) return 3;
  if (bestPL) return 2;
  if (bestRT) return 1;
  return -1;
}

// ---------------------------------------------------------------------------
// Feature ↔ rule-term matching. Token-based with word boundaries: every token
// of the rule term must appear as a whole token of a single feature ("war"
// matches "war risk" but never "warranty"; "thatch roof" matches "thatch roof
// lapa"). Light plural folding so "vehicles" matches "vehicle".
// ---------------------------------------------------------------------------

interface FeatureHit {
  candidate: string;
  /** Which feature fields matched, e.g. ["business sector", "red flag [AI]"]. */
  sources: string[];
  /** True when the term matched ONLY in AI-inferred features (red flags). */
  ai_only: boolean;
}

function stemToken(t: string): string {
  return t.length > 3 && t.endsWith("s") ? t.slice(0, -1) : t;
}

function tokenSet(text: string): Set<string> {
  return new Set(normalizeLoose(text).split(" ").filter(Boolean).map(stemToken));
}

function termTokens(term: string): string[] {
  return normalizeLoose(term).split(" ").filter(Boolean).map(stemToken);
}

function normalizeFeatures(features: FeatureInput[]): RiskFeature[] {
  return features.map((f) =>
    typeof f === "string" ? { text: f, source: "feature", ai_inferred: false } : f
  );
}

function findMatches(features: RiskFeature[], candidates: string[]): FeatureHit[] {
  if (!features.length || !candidates.length) return [];
  const prepared = features
    .map((f) => ({ f, tokens: tokenSet(f.text) }))
    .filter((x) => x.tokens.size > 0);
  const hits: FeatureHit[] = [];
  for (const c of candidates) {
    const ct = termTokens(c);
    if (ct.length === 0) continue;
    const matched = prepared.filter((p) => ct.every((t) => p.tokens.has(t)));
    if (matched.length === 0) continue;
    hits.push({
      candidate: c,
      sources: [...new Set(matched.map((m) => `${m.f.source}${m.f.ai_inferred ? " [AI]" : ""}`))],
      ai_only: matched.every((m) => m.f.ai_inferred === true),
    });
  }
  return hits;
}

/** "term (from: source, source)" for scoring notes. */
function hitLabel(h: FeatureHit): string {
  return `${h.candidate} (from: ${h.sources.join(", ")})`;
}

function hasRequiredDoc(available: string[], required: string): boolean {
  const norm = (s: string) => lower(s).replace(/[_\-]+/g, " ");
  const r = norm(required);
  return available.some((a) => {
    const x = norm(a);
    return x.includes(r) || r.includes(x);
  });
}

function isPortfolio(r: AppetiteRow): boolean {
  return r.product_line.trim() === PORTFOLIO && r.risk_type.trim() === PORTFOLIO;
}

function ruleRef(
  rule: AppetiteRow,
  list: MatchedRuleRef["list"],
  matched_strings: string[] = [],
  options: {
    effect: MatcherRuleEffect;
    hits?: FeatureHit[];
    scoreContribution?: number | null;
  }
): MatchedRuleRef {
  return {
    appetite_id: rule.id,
    list,
    matched_strings,
    effect: options.effect,
    score_contribution: options.scoreContribution ?? null,
    matched_inputs: (options.hits ?? []).map((hit) => ({
      value: hit.candidate,
      source_labels: [...hit.sources],
      ai_inferred_only: hit.ai_only,
    })),
    matched_rule_terms: (options.hits ?? []).flatMap<MatchedRuleTerm>((hit) =>
      hit.sources.length > 0
        ? hit.sources.map((source) => ({ term: hit.candidate, input_source: source }))
        : [{ term: hit.candidate, input_source: null }]
    ),
    rule_product_line: rule.product_line,
    rule_risk_type: rule.risk_type,
    source_quote: rule.source_quote ?? null,
    source_page: rule.source_page ?? null,
    source_section: rule.source_section ?? null,
    source_file_name: rule.source_file_name ?? null,
  };
}

function unmatchedFromRisk(risk: MatchInputRisk, productRules: AppetiteRow[]): {
  unmatchedSections: string[];
  unmatchedProducts: string[];
  nearby: string[];
} {
  const ruleProducts = productRules.map((r) => r.product_line);
  const ruleRisks = productRules.map((r) => r.risk_type);
  const unmatchedSections = (risk.section_candidates ?? risk.product_candidates)
    .filter((s) => s && !ruleProducts.some((r) => canonicalTaxonomyKey(r) === canonicalTaxonomyKey(s)));
  const unmatchedProducts = risk.product_candidates
    .filter((s) => s && !ruleProducts.some((r) => canonicalTaxonomyKey(r) === canonicalTaxonomyKey(s)));
  const nearby = [
    ...risk.product_candidates.flatMap((p) => nearbyTaxonomyMatches(p, ruleProducts)),
    ...risk.risk_candidates.flatMap((r) => nearbyTaxonomyMatches(r, ruleRisks)),
  ];
  return {
    unmatchedSections: [...new Set(unmatchedSections)],
    unmatchedProducts: [...new Set(unmatchedProducts)],
    nearby: [...new Set(nearby)].slice(0, 6),
  };
}

// ---------------------------------------------------------------------------
// Deterministic ordering
// ---------------------------------------------------------------------------

/** Locale-independent comparison: UTF-16 code units, the same everywhere. */
export function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Canonical order for appetite rows: insurer, then canonical product line,
 * then canonical risk type, then rule id. It carries no underwriting meaning —
 * it exists so that "which rule is first" never depends on the order the
 * database happened to return rows in. Returns a new array.
 */
export function canonicalAppetiteOrder(rows: readonly AppetiteRow[]): AppetiteRow[] {
  return rows
    .map((row) => ({
      row,
      productKey: normTaxonomy(row.product_line),
      riskKey: normTaxonomy(row.risk_type),
    }))
    .sort(
      (a, b) =>
        compareCodeUnits(String(a.row.insurer_id), String(b.row.insurer_id)) ||
        compareCodeUnits(a.productKey, b.productKey) ||
        compareCodeUnits(a.riskKey, b.riskKey) ||
        compareCodeUnits(String(a.row.id), String(b.row.id))
    )
    .map((entry) => entry.row);
}

// ---------------------------------------------------------------------------
// Section intelligence — read-only evaluation of rules the scorer did not use.
// Everything below re-uses the scoring scan (`findMatches`) so a condition is
// reported exactly when scoring WOULD have seen it had that rule been selected.
// ---------------------------------------------------------------------------

export function requestedSectionsOf(risk: MatchInputRisk): RequestedSection[] {
  const seen = new Set<string>();
  const sections: RequestedSection[] = [];
  for (const raw of risk.section_candidates ?? []) {
    const section = typeof raw === "string" ? raw.trim() : "";
    if (!section) continue;
    const key = normTaxonomy(section);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    sections.push({ section, section_key: key });
  }
  return sections;
}

function termPairs(hits: FeatureHit[]): MatchedRuleTerm[] {
  return hits.flatMap<MatchedRuleTerm>((hit) =>
    hit.sources.length > 0
      ? hit.sources.map((source) => ({ term: hit.candidate, input_source: source }))
      : [{ term: hit.candidate, input_source: null }]
  );
}

/** Conditions in a fixed order so output is stable. */
function conditionsFor(rule: AppetiteRow, features: RiskFeature[]): RuleCondition[] {
  const conditions: RuleCondition[] = [];
  if (rule.appetite_level === "declined") {
    conditions.push({ kind: "hard_decline", origin: "appetite_level", matched_rule_terms: [] });
  }
  const declined = findMatches(features, rule.declined_risks);
  const declinedDocument = declined.filter((hit) => !hit.ai_only);
  const declinedAiOnly = declined.filter((hit) => hit.ai_only);
  if (declinedDocument.length > 0) {
    conditions.push({ kind: "hard_decline", origin: "declined_risks", matched_rule_terms: termPairs(declinedDocument) });
  }
  if (declinedAiOnly.length > 0) {
    conditions.push({ kind: "soft_decline_referral", origin: "declined_risks", matched_rule_terms: termPairs(declinedAiOnly) });
  }
  const preferred = findMatches(features, rule.preferred_risks);
  if (preferred.length > 0) {
    conditions.push({ kind: "preferred", origin: "preferred_risks", matched_rule_terms: termPairs(preferred) });
  }
  const caution = findMatches(features, rule.caution_risks);
  if (caution.length > 0) {
    conditions.push({ kind: "caution", origin: "caution_risks", matched_rule_terms: termPairs(caution) });
  }
  const referral = findMatches(features, rule.referral_triggers);
  if (referral.length > 0) {
    conditions.push({ kind: "referral", origin: "referral_triggers", matched_rule_terms: termPairs(referral) });
  }
  return conditions;
}

function sectionOutcomeOf(rule: AppetiteRow, conditions: RuleCondition[]): SectionOutcome {
  const has = (kind: RuleConditionKind) => conditions.some((condition) => condition.kind === kind);
  if (has("hard_decline")) return "hard_decline";
  if (has("soft_decline_referral")) return "soft_decline_referral";
  if (has("referral")) return "referral";
  if (has("caution") || rule.appetite_level === "caution") return "caution";
  return rule.appetite_level === "preferred" ? "preferred" : "standard";
}

/** Two rules "agree" when their level and set of condition kinds are identical. */
function ruleProfile(rule: AppetiteRow, conditions: RuleCondition[]): string {
  return `${rule.appetite_level}|${[...new Set(conditions.map((condition) => condition.kind))].sort().join(",")}`;
}

function qualityLevel(value: number): 1 | 2 | 3 {
  return value >= 3 ? 3 : value === 2 ? 2 : 1;
}

function riskCandidatesRelate(riskCandidates: string[], rule: AppetiteRow): boolean {
  const ruleRisk = normTaxonomy(rule.risk_type);
  if (!ruleRisk) return false;
  return riskCandidates.some((candidate) => {
    if (!candidate) return false;
    const key = normTaxonomy(candidate);
    return !!key && taxonomyKeysRelated(ruleRisk, key);
  });
}

function buildInsurerIntel(input: {
  productRules: AppetiteRow[];
  qualities: number[];
  bestQuality: number;
  usedRule: AppetiteRow | null;
  sections: RequestedSection[];
  risk: MatchInputRisk;
  features: RiskFeature[];
}): Pick<InsurerScore, "selection" | "section_evaluations" | "considered_rules"> {
  const { productRules, qualities, bestQuality, usedRule, sections, risk, features } = input;

  // ---- per-rule facts, in canonical rule order ------------------------------
  const conditionCache = new Map<string, RuleCondition[]>();
  const conditionsOf = (rule: AppetiteRow): RuleCondition[] => {
    const cached = conditionCache.get(rule.id);
    if (cached) return cached;
    const computed = conditionsFor(rule, features);
    conditionCache.set(rule.id, computed);
    return computed;
  };

  // ---- sections -------------------------------------------------------------
  const sectionApplicable = new Map<string, { rule: AppetiteRow; quality: number }[]>();
  for (const section of sections) {
    const applicable: { rule: AppetiteRow; quality: number }[] = [];
    for (const rule of productRules) {
      const productKey = normTaxonomy(rule.product_line);
      if (!productKey || !taxonomyKeysRelated(productKey, section.section_key)) continue;
      applicable.push({ rule, quality: riskCandidatesRelate(risk.risk_candidates, rule) ? 3 : 2 });
    }
    // Best quality first; canonical order (the input order) breaks ties.
    applicable.sort((a, b) => b.quality - a.quality);
    sectionApplicable.set(section.section_key, applicable);
  }

  // ---- insurer-level selection ---------------------------------------------
  const matchingIndexes = productRules
    .map((_, index) => index)
    .filter((index) => qualities[index] >= 1);
  const tiedAtBest = usedRule
    ? matchingIndexes.filter((index) => qualities[index] === bestQuality)
    : [];
  const tiedRules = tiedAtBest.map((index) => productRules[index]);
  const tiedDisagree =
    tiedRules.length > 1 &&
    new Set(tiedRules.map((rule) => ruleProfile(rule, conditionsOf(rule)))).size > 1;

  const selection: InsurerSelection = {
    product_rule_id: usedRule?.id ?? null,
    taxonomy_quality: usedRule ? qualityLevel(bestQuality) : null,
    basis: !usedRule
      ? null
      : matchingIndexes.length === 1
      ? "only_candidate"
      : tiedRules.length > 1
      ? "tie_broken_by_canonical_order"
      : "highest_taxonomy_quality",
    tied_rule_ids: tiedRules.length > 1 ? tiedRules.map((rule) => rule.id) : [],
    tied_rules_disagree: tiedDisagree,
    matching_rule_count: matchingIndexes.length,
    omitted_risk_only_rule_count: 0,
  };

  // ---- considered rules: bounded to what is relevant ------------------------
  const applicableRuleIds = new Set<string>();
  for (const list of sectionApplicable.values()) for (const entry of list) applicableRuleIds.add(entry.rule.id);

  const considered: ConsideredRule[] = [];
  let omitted = 0;
  const selectedForSections = new Map<string, string[]>();
  const sectionEvaluations: SectionEvaluation[] = sections.map((section) => {
    const applicable = sectionApplicable.get(section.section_key) ?? [];
    if (applicable.length === 0) {
      return {
        ...section,
        status: "no_applicable_rule" as const,
        applicable_rule_ids: [],
        selected_rule_id: null,
        selection_basis: null,
        tied_rule_ids: [],
        tied_rules_disagree: false,
        outcome: null,
        reflected_in_insurer_outcome: false,
      };
    }
    const top = applicable[0].quality;
    const tied = applicable.filter((entry) => entry.quality === top);
    const selected = tied[0].rule;
    const list = selectedForSections.get(selected.id) ?? [];
    list.push(section.section_key);
    selectedForSections.set(selected.id, list);
    return {
      ...section,
      status: "evaluated" as const,
      applicable_rule_ids: applicable.map((entry) => entry.rule.id),
      selected_rule_id: selected.id,
      selection_basis:
        applicable.length === 1
          ? ("only_candidate" as const)
          : tied.length > 1
          ? ("tie_broken_by_canonical_order" as const)
          : ("highest_taxonomy_quality" as const),
      tied_rule_ids: tied.length > 1 ? tied.map((entry) => entry.rule.id) : [],
      tied_rules_disagree:
        tied.length > 1 &&
        new Set(tied.map((entry) => ruleProfile(entry.rule, conditionsOf(entry.rule)))).size > 1,
      outcome: sectionOutcomeOf(selected, conditionsOf(selected)),
      reflected_in_insurer_outcome: usedRule?.id === selected.id,
    };
  });

  productRules.forEach((rule, index) => {
    const quality = qualities[index];
    if (quality < 1) return;
    const relevant = quality >= 2 || quality === bestQuality || applicableRuleIds.has(rule.id);
    if (!relevant) {
      omitted++;
      return;
    }
    const isScored = usedRule?.id === rule.id;
    considered.push({
      rule_id: rule.id,
      product_line: rule.product_line,
      risk_type: rule.risk_type,
      appetite_level: rule.appetite_level,
      taxonomy_quality: qualityLevel(quality),
      section_keys: sections
        .filter((section) => (sectionApplicable.get(section.section_key) ?? []).some((entry) => entry.rule.id === rule.id))
        .map((section) => section.section_key),
      selected_for_section_keys: selectedForSections.get(rule.id) ?? [],
      scored: isScored,
      not_scored_reason: isScored
        ? null
        : quality < bestQuality
        ? "lower_taxonomy_quality"
        : "lost_tie_canonical_order",
      conditions: conditionsOf(rule),
    });
  });
  // Scored rule first, then better quality, then canonical order (already the input order).
  considered.sort(
    (a, b) => Number(b.scored) - Number(a.scored) || b.taxonomy_quality - a.taxonomy_quality
  );
  selection.omitted_risk_only_rule_count = omitted;

  return { selection, section_evaluations: sectionEvaluations, considered_rules: considered };
}

export function matchInsurers(
  risk: MatchInputRisk,
  allAppetite: AppetiteRow[]
): MatchResult {
  const features = normalizeFeatures(risk.features);
  const requestedSections = requestedSectionsOf(risk);
  const intelByInsurer = new Map<string, ReturnType<typeof buildInsurerIntel>>();
  const productByInsurer = new Map<string, AppetiteRow[]>();
  const portfolioByInsurer = new Map<string, AppetiteRow[]>();
  // Canonical order: nothing below may depend on the order rows arrived in.
  for (const row of canonicalAppetiteOrder(allAppetite)) {
    if (!row.is_active) continue;
    if (isPortfolio(row)) {
      const arr = portfolioByInsurer.get(row.insurer_id) ?? [];
      arr.push(row);
      portfolioByInsurer.set(row.insurer_id, arr);
    } else {
      const arr = productByInsurer.get(row.insurer_id) ?? [];
      arr.push(row);
      productByInsurer.set(row.insurer_id, arr);
    }
  }

  const allInsurerIds = new Set<string>([
    ...productByInsurer.keys(),
    ...portfolioByInsurer.keys(),
  ]);

  const scored: InsurerScore[] = [];
  const noData: MatchResult["no_data_for"] = [];

  for (const insurerId of allInsurerIds) {
    const productRules = productByInsurer.get(insurerId) ?? [];
    const portfolioRules = portfolioByInsurer.get(insurerId) ?? [];

    // Best-fit product rule using candidate-list substring taxonomy matching.
    // Strict `>`: the first rule in canonical order wins every tie.
    const qualities = productRules.map((r) =>
      taxonomyQualityWithCandidates(risk.product_candidates, risk.risk_candidates, r)
    );
    let bestRule: AppetiteRow | null = null;
    let bestQuality = -1;
    for (let index = 0; index < productRules.length; index++) {
      if (qualities[index] > bestQuality) {
        bestQuality = qualities[index];
        bestRule = productRules[index];
      }
    }

    // NOTE: insurers with literally zero active rules never appear in
    // allAppetite at all, so they cannot be detected here. The CALLER is
    // responsible for populating no_data_for via insurersWithoutActiveRules()
    // against the full insurer list — otherwise those insurers silently
    // vanish from the recommendation.

    const usedRule = bestQuality >= 1 ? bestRule : null;
    intelByInsurer.set(
      insurerId,
      buildInsurerIntel({ productRules, qualities, bestQuality, usedRule, sections: requestedSections, risk, features })
    );
    const insurerName =
      usedRule?.insurer_name ??
      productRules[0]?.insurer_name ??
      portfolioRules[0].insurer_name;
    const notes: string[] = [];
    const matched: MatchedRuleRef[] = [];

    let score: number;
    let band: AppetiteLevel | "ruled_out" | "insufficient_rule_match";
    let referralRequired = false;

    if (usedRule) {
      score = BASE_SCORE[usedRule.appetite_level];
      band = usedRule.appetite_level;
      notes.push(
        `Base ${usedRule.appetite_level} (${usedRule.product_line} × ${usedRule.risk_type}) → ${score}`
      );
      matched.push(ruleRef(usedRule, "base", [], {
        effect:
          usedRule.appetite_level === "declined"
            ? "hard_decline"
            : usedRule.appetite_level,
        scoreContribution: score,
      }));

      const declinedHits = findMatches(features, usedRule.declined_risks);
      const declinedDocumentHits = declinedHits.filter((h) => !h.ai_only);
      const declinedAiOnlyHits = declinedHits.filter((h) => h.ai_only);
      if (declinedDocumentHits.length > 0) {
        notes.push(
          `Declined-risk match (product) → ruled out: ${declinedDocumentHits.map(hitLabel).join("; ")}`
        );
        matched.push(ruleRef(usedRule, "declined", declinedDocumentHits.map((h) => h.candidate), {
          effect: "hard_decline",
          hits: declinedDocumentHits,
          scoreContribution: null,
        }));
        scored.push(ruleOut(insurerId, insurerName, usedRule.id, matched, notes, score));
        continue;
      }
      if (declinedAiOnlyHits.length > 0) {
        // The term matched ONLY in AI-inferred red-flag text, not in anything
        // read from a document. An AI inference must not hard-rule an insurer
        // out by itself — downgrade to a referral that a human confirms.
        const drop = declinedAiOnlyHits.length * CAUTION_PER_MATCH;
        score -= drop;
        referralRequired = true;
        notes.push(
          `Declined-risk terms matched only in AI-inferred red flags -${drop} → referral, ` +
            `needs human confirmation before ruling out: ${declinedAiOnlyHits.map(hitLabel).join("; ")}`
        );
        matched.push(ruleRef(usedRule, "declined", declinedAiOnlyHits.map((h) => h.candidate), {
          effect: "soft_decline_referral",
          hits: declinedAiOnlyHits,
          scoreContribution: -drop,
        }));
      }

      if (usedRule.appetite_level === "declined") {
        notes.push("Insurer's appetite for this line/type is declined.");
        scored.push(ruleOut(insurerId, insurerName, usedRule.id, matched, notes, score));
        continue;
      }

      const preferredHits = findMatches(features, usedRule.preferred_risks);
      if (preferredHits.length > 0) {
        const lift = Math.min(preferredHits.length * PREFERRED_PER_MATCH, PREFERRED_MATCH_CAP);
        score += lift;
        notes.push(`Preferred-risk matches +${lift}: ${preferredHits.map(hitLabel).join("; ")}`);
        matched.push(ruleRef(usedRule, "preferred", preferredHits.map((h) => h.candidate), {
          effect: "preferred",
          hits: preferredHits,
          scoreContribution: lift,
        }));
      }

      const cautionHits = findMatches(features, usedRule.caution_risks);
      if (cautionHits.length > 0) {
        const drop = cautionHits.length * CAUTION_PER_MATCH;
        score -= drop;
        notes.push(`Caution-risk matches -${drop}: ${cautionHits.map(hitLabel).join("; ")}`);
        matched.push(ruleRef(usedRule, "caution", cautionHits.map((h) => h.candidate), {
          effect: "caution",
          hits: cautionHits,
          scoreContribution: -drop,
        }));
      }
    } else {
      // No product-specific rule could be matched to any candidate. Don't
      // disappear the insurer — proceed at standard baseline so the
      // portfolio overlay and the underwriter's eye can still apply.
      score = 0;
      band = "insufficient_rule_match";
      notes.push(
        productRules.length > 0
          ? `No specific product rule matched (insurer has ${productRules.length} active product rules, but none aligned with this submission's cover description). Manual review required.`
          : "No product rules on file for this insurer; portfolio/global rules only. Manual review required."
      );
    }

    if (usedRule) {
      const referralHits = findMatches(features, usedRule.referral_triggers);
      if (referralHits.length > 0) {
        const drop = referralHits.length * REFERRAL_TRIGGER_PENALTY;
        score -= drop;
        referralRequired = true;
        notes.push(`Referral triggers (product) -${drop}: ${referralHits.map(hitLabel).join("; ")}`);
        matched.push(ruleRef(usedRule, "referral", referralHits.map((h) => h.candidate), {
          effect: "referral",
          hits: referralHits,
          scoreContribution: -drop,
        }));
      }
    }

    let portfolioRuledOut = false;
    let portfolioRuledOutRule: string | null = null;
    for (const pf of portfolioRules) {
      const pDeclined = findMatches(features, pf.declined_risks);
      const pDeclinedDocument = pDeclined.filter((h) => !h.ai_only);
      const pDeclinedAiOnly = pDeclined.filter((h) => h.ai_only);
      if (pDeclinedDocument.length > 0) {
        notes.push(
          `Portfolio declined-risk match → ruled out: ${pDeclinedDocument.map(hitLabel).join("; ")}`
        );
        matched.push(ruleRef(pf, "portfolio_declined", pDeclinedDocument.map((h) => h.candidate), {
          effect: "hard_decline",
          hits: pDeclinedDocument,
          scoreContribution: null,
        }));
        portfolioRuledOut = true;
        portfolioRuledOutRule = pf.id;
        break;
      }
      if (pDeclinedAiOnly.length > 0) {
        // Same rule as the product path: AI-inferred text alone must not
        // hard-rule an insurer out — downgrade to a human-confirmed referral.
        const drop = pDeclinedAiOnly.length * CAUTION_PER_MATCH;
        score -= drop;
        referralRequired = true;
        notes.push(
          `Portfolio declined-risk terms matched only in AI-inferred red flags -${drop} → referral, ` +
            `needs human confirmation before ruling out: ${pDeclinedAiOnly.map(hitLabel).join("; ")}`
        );
        matched.push(ruleRef(pf, "portfolio_declined", pDeclinedAiOnly.map((h) => h.candidate), {
          effect: "soft_decline_referral",
          hits: pDeclinedAiOnly,
          scoreContribution: -drop,
        }));
      }
      const pCaution = findMatches(features, pf.caution_risks);
      if (pCaution.length > 0) {
        const drop = pCaution.length * CAUTION_PER_MATCH;
        score -= drop;
        notes.push(`Portfolio caution-risk matches -${drop}: ${pCaution.map(hitLabel).join("; ")}`);
        matched.push(ruleRef(pf, "portfolio_caution", pCaution.map((h) => h.candidate), {
          effect: "caution",
          hits: pCaution,
          scoreContribution: -drop,
        }));
      }
      const pReferral = findMatches(features, pf.referral_triggers);
      if (pReferral.length > 0) {
        const drop = pReferral.length * REFERRAL_TRIGGER_PENALTY;
        score -= drop;
        referralRequired = true;
        notes.push(`Portfolio referral triggers -${drop}: ${pReferral.map(hitLabel).join("; ")}`);
        matched.push(ruleRef(pf, "portfolio_referral", pReferral.map((h) => h.candidate), {
          effect: "referral",
          hits: pReferral,
          scoreContribution: -drop,
        }));
      }
    }

    if (portfolioRuledOut) {
      scored.push(ruleOut(insurerId, insurerName, portfolioRuledOutRule, matched, notes, score));
      continue;
    }

    const missingDocs: string[] = [];
    const required: { source: "product" | "portfolio"; appetiteId: string; doc: string }[] = [];
    if (usedRule) for (const d of usedRule.required_documents) required.push({ source: "product", appetiteId: usedRule.id, doc: d });
    for (const pf of portfolioRules) for (const d of pf.required_documents) required.push({ source: "portfolio", appetiteId: pf.id, doc: d });
    const seen = new Set<string>();
    for (const r of required) {
      if (seen.has(r.doc.toLowerCase())) continue;
      seen.add(r.doc.toLowerCase());
      if (!hasRequiredDoc(risk.available_documents, r.doc)) missingDocs.push(r.doc);
    }
    // Confidence provenance is preserved end-to-end (see MatchInputRisk).
    //   - explicitly unavailable  → compatibility 0, confidence_available=false
    //   - provider rating in [0,1] → that number, confidence_available=true
    //   - absent flag AND no valid number → 0.7 legacy default, available=true
    // The old `risk.overall_confidence || 0.7` collapsed a provider-rated 0
    // into 0.7 (a fabricated value) and silently hid unavailability. Truthiness
    // fallback is forbidden here — use explicit availability + finite-number
    // checks.
    const explicitlyUnavailable = risk.overall_confidence_available === false;
    const raw = risk.overall_confidence;
    const hasValidNumber =
      typeof raw === "number" && Number.isFinite(raw) && raw >= 0 && raw <= 1;
    let confidence: number;
    let confidenceAvailable: boolean;
    if (explicitlyUnavailable) {
      confidence = 0;
      confidenceAvailable = false;
      notes.push(
        "Extraction confidence unavailable — score reflects appetite match only; do not read the numeric 0 as a provider rating."
      );
    } else if (hasValidNumber) {
      confidence = raw;
      confidenceAvailable = true;
    } else {
      // Legacy-compatibility default. Preserves historical behaviour for rows
      // that never carried a confidence at all (predates the extraction contract).
      confidence = 0.7;
      confidenceAvailable = true;
    }
    const confidenceBeforeDocuments = confidence;
    if (missingDocs.length > 0) {
      const drop = Math.min(missingDocs.length * DOC_GAP_CONFIDENCE_PENALTY, DOC_GAP_CONFIDENCE_CAP);
      confidence = Math.max(0, confidence - drop);
      notes.push(`Required documents not evidenced: ${missingDocs.join("; ")} (confidence -${drop.toFixed(2)})`);
    }

    const requiredByDocument = new Map<string, RequiredDocumentEvidence>();
    for (const item of required) {
      const key = item.doc.toLowerCase();
      const current = requiredByDocument.get(key) ?? {
        document_type: item.doc,
        present: hasRequiredDoc(risk.available_documents, item.doc),
        appetite_ids: [],
        scopes: [],
        confidence_adjustment: 0,
      };
      if (!current.appetite_ids.includes(item.appetiteId)) current.appetite_ids.push(item.appetiteId);
      if (!current.scopes.includes(item.source)) current.scopes.push(item.source);
      requiredByDocument.set(key, current);
    }
    let remainingDocumentAdjustment = confidence - confidenceBeforeDocuments;
    for (const item of requiredByDocument.values()) {
      if (!item.present && remainingDocumentAdjustment < 0) {
        const applied = Math.max(remainingDocumentAdjustment, -DOC_GAP_CONFIDENCE_PENALTY);
        item.confidence_adjustment = applied;
        remainingDocumentAdjustment -= applied;
      }
      item.appetite_ids.sort();
      item.scopes.sort();
    }
    const requiredDocumentEvidence = [...requiredByDocument.values()];

    const componentSubtotal = score;
    score = Math.max(0, Math.min(100, componentSubtotal));
    const clampAdjustment = score - componentSubtotal;

    const manualReviewRequired = !usedRule;
    const unmatched = manualReviewRequired
      ? unmatchedFromRisk(risk, productRules)
      : { unmatchedSections: [], unmatchedProducts: [], nearby: [] };
    if (manualReviewRequired && unmatched.unmatchedSections.length > 0) {
      notes.push(`Unmatched cover sections: ${unmatched.unmatchedSections.join("; ")}`);
    }
    if (manualReviewRequired && unmatched.nearby.length > 0) {
      notes.push(`Nearby matrix terms to review: ${unmatched.nearby.join("; ")}`);
    }

    const seniorReview = !manualReviewRequired && score <= CAUTION_BAND_MAX && referralRequired;
    if (seniorReview) notes.push("Caution-band score with referral flag → senior review required.");

    const confidenceBeforeManualReviewCap = confidence;
    if (manualReviewRequired) confidence = Math.min(confidence, 0.35);
    const manualReviewCapAdjustment = confidence - confidenceBeforeManualReviewCap;

    const ruleStatus: InsurerScore["rule_status"] =
      band === "insufficient_rule_match"
        ? "insufficient_rule_match"
        : referralRequired
        ? "referral"
        : band;

    scored.push({
      insurer_id: insurerId,
      insurer_name: insurerName,
      score,
      band,
      rule_status: ruleStatus,
      confidence,
      confidence_available: confidenceAvailable,
      referral_required: referralRequired,
      manual_review_required: manualReviewRequired,
      senior_review_required: seniorReview,
      ruled_out: false,
      scored_against_appetite_id: usedRule?.id ?? null,
      matched_rules: matched,
      required_document_evidence: requiredDocumentEvidence,
      score_reconciliation: {
        component_subtotal: componentSubtotal,
        hard_decline_adjustment: 0,
        clamp_adjustment: clampAdjustment,
        final_score: score,
      },
      confidence_reconciliation: {
        input_confidence: confidenceAvailable ? confidenceBeforeDocuments : null,
        input_confidence_available: confidenceAvailable,
        required_document_adjustment: confidenceBeforeManualReviewCap - confidenceBeforeDocuments,
        manual_review_cap_adjustment: manualReviewCapAdjustment,
        final_confidence: confidenceAvailable ? confidence : null,
      },
      scoring_notes: notes,
      missing_required_documents: missingDocs,
      unmatched_sections: unmatched.unmatchedSections,
      unmatched_product_candidates: unmatched.unmatchedProducts,
      nearby_rule_matches: unmatched.nearby,
    });
  }

  // Section intelligence is attached after scoring so it can never influence it.
  for (const insurer of scored) {
    const intel = intelByInsurer.get(insurer.insurer_id);
    if (intel) Object.assign(insurer, intel);
  }

  // Ruled-out last, then score; equal scores fall back to a defined key
  // (insurer name, then id) instead of the order rows happened to arrive in.
  scored.sort((a, b) => {
    if (a.ruled_out !== b.ruled_out) return a.ruled_out ? 1 : -1;
    return (
      b.score - a.score ||
      compareCodeUnits(a.insurer_name, b.insurer_name) ||
      compareCodeUnits(a.insurer_id, b.insurer_id)
    );
  });
  scored.forEach((insurer, index) => { insurer.rank = index + 1; });

  return { insurers: scored, no_data_for: noData, requested_sections: requestedSections };
}

/**
 * Insurers with ZERO active appetite rules — they never reach matchInsurers
 * (its input is appetite rows), so the caller must surface them explicitly in
 * no_data_for. Otherwise "Atlas has no data for insurer X" silently reads as
 * "insurer X doesn't exist", overstating the recommendation's completeness.
 */
export function insurersWithoutActiveRules(
  insurers: { id: string; name: string }[],
  activeAppetite: { insurer_id: string }[]
): { insurer_id: string; insurer_name: string }[] {
  const withRules = new Set(activeAppetite.map((a) => a.insurer_id));
  return insurers
    .filter((i) => !withRules.has(i.id))
    .map((i) => ({ insurer_id: i.id, insurer_name: i.name }));
}

function ruleOut(
  insurer_id: string,
  insurer_name: string,
  scored_against: string | null,
  matched_rules: MatchedRuleRef[],
  scoring_notes: string[],
  component_subtotal: number
): InsurerScore {
  return {
    insurer_id,
    insurer_name,
    score: 0,
    band: "ruled_out",
    rule_status: "ruled_out",
    // Ruled-out insurers do not participate in confidence semantics — their
    // score is 0 by rule, not by extraction quality. Mark unavailable so no
    // downstream consumer misreads the 0 as a provider rating.
    confidence: 0,
    confidence_available: false,
    referral_required: false,
    manual_review_required: false,
    senior_review_required: false,
    ruled_out: true,
    scored_against_appetite_id: scored_against,
    matched_rules,
    required_document_evidence: [],
    score_reconciliation: {
      component_subtotal,
      hard_decline_adjustment: -component_subtotal,
      clamp_adjustment: 0,
      final_score: 0,
    },
    confidence_reconciliation: {
      input_confidence: null,
      input_confidence_available: false,
      required_document_adjustment: 0,
      manual_review_cap_adjustment: 0,
      final_confidence: null,
    },
    scoring_notes,
    missing_required_documents: [],
    unmatched_sections: [],
    unmatched_product_candidates: [],
    nearby_rule_matches: [],
  };
}
