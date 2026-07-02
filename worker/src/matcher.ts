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
 */

import type { AppetiteRow, AppetiteLevel } from "./matcher-types";
import { canonicalTaxonomyKey, nearbyTaxonomyMatches } from "./taxonomy.js";

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

export interface MatchInputRisk {
  /** All taxonomy candidates that describe what COVER this submission needs.
   *  Built in deriveRisk() from cover_sections, secondary_risk_types, and
   *  primary_risk_type — whichever are present, all passed forward. */
  product_candidates: string[];
  section_candidates?: string[];
  /** Same idea for risk type — business sector, secondary types, anything
   *  the extraction surfaced that an appetite rule's risk_type might
   *  substring-match. */
  risk_candidates: string[];
  features: string[];
  available_documents: string[];
  overall_confidence: number;
}

export interface MatchedRuleRef {
  appetite_id: string;
  matched_strings: string[];
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

export interface InsurerScore {
  insurer_id: string;
  insurer_name: string;
  score: number;
  band: AppetiteLevel | "ruled_out" | "insufficient_rule_match";
  rule_status: AppetiteLevel | "referral" | "ruled_out" | "insufficient_rule_match";
  confidence: number;
  referral_required: boolean;
  manual_review_required: boolean;
  senior_review_required: boolean;
  ruled_out: boolean;
  scored_against_appetite_id: string | null;
  matched_rules: MatchedRuleRef[];
  scoring_notes: string[];
  missing_required_documents: string[];
  unmatched_sections: string[];
  unmatched_product_candidates: string[];
  nearby_rule_matches: string[];
}

export interface MatchResult {
  insurers: InsurerScore[];
  no_data_for: { insurer_id: string; insurer_name: string }[];
}

const lower = (s: string) => s.toLowerCase();

/** Lowercase, separators → spaces, collapse whitespace, trim. */
function normTaxonomy(s: string): string {
  return canonicalTaxonomyKey(s);
}

/**
 * Best taxonomy-quality across all (product_candidate × risk_candidate) pairs
 * for this appetite rule. Returns the same 3/2/1/-1 scale as before:
 *   3 = both product and risk match (any direction substring)
 *   2 = only product matches
 *   1 = only risk matches
 *  -1 = nothing matches any candidate
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
    if (n && aPL && (aPL.includes(n) || n.includes(aPL))) { bestPL = true; break; }
  }

  let bestRT = false;
  for (const c of riskCandidates) {
    if (!c) continue;
    const n = normTaxonomy(c);
    if (n && aRT && (aRT.includes(n) || n.includes(aRT))) { bestRT = true; break; }
  }

  if (bestPL && bestRT) return 3;
  if (bestPL) return 2;
  if (bestRT) return 1;
  return -1;
}

function findMatches(features: string[], candidates: string[]): string[] {
  if (!features.length || !candidates.length) return [];
  const f = features.map(lower);
  const hits: string[] = [];
  for (const c of candidates) {
    const cl = lower(c);
    if (f.some((x) => x.includes(cl) || cl.includes(x))) hits.push(c);
  }
  return hits;
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
  matched_strings: string[] = []
): MatchedRuleRef {
  return {
    appetite_id: rule.id,
    list,
    matched_strings,
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

export function matchInsurers(
  risk: MatchInputRisk,
  allAppetite: AppetiteRow[]
): MatchResult {
  const productByInsurer = new Map<string, AppetiteRow[]>();
  const portfolioByInsurer = new Map<string, AppetiteRow[]>();
  for (const row of allAppetite) {
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
    let bestRule: AppetiteRow | null = null;
    let bestQuality = -1;
    for (const r of productRules) {
      const quality = taxonomyQualityWithCandidates(
        risk.product_candidates,
        risk.risk_candidates,
        r
      );
      if (quality > bestQuality) {
        bestQuality = quality;
        bestRule = r;
      }
    }

    // (2) no_data_for is now narrow: only when the insurer literally has zero
    // active rules at all. An insurer with active rules but no taxonomy match
    // proceeds at standard baseline and is presented to the underwriter with
    // a clear note rather than hidden.
    const hasAnyRules = productRules.length > 0 || portfolioRules.length > 0;
    if (!hasAnyRules) {
      const name =
        productRules[0]?.insurer_name ?? portfolioRules[0]?.insurer_name ?? "Unknown";
      noData.push({ insurer_id: insurerId, insurer_name: name });
      continue;
    }

    const usedRule = bestQuality >= 1 ? bestRule : null;
    const insurerName =
      usedRule?.insurer_name ??
      productRules[0]?.insurer_name ??
      portfolioRules[0].insurer_name;
    const notes: string[] = [];
    const matched: MatchedRuleRef[] = [];

    let score: number;
    let band: AppetiteLevel | "ruled_out" | "insufficient_rule_match";

    if (usedRule) {
      score = BASE_SCORE[usedRule.appetite_level];
      band = usedRule.appetite_level;
      notes.push(
        `Base ${usedRule.appetite_level} (${usedRule.product_line} × ${usedRule.risk_type}) → ${score}`
      );
      matched.push(ruleRef(usedRule, "base"));

      const declinedHits = findMatches(risk.features, usedRule.declined_risks);
      if (declinedHits.length > 0) {
        notes.push(`Declined-risk match (product) → ruled out: ${declinedHits.join("; ")}`);
        matched.push(ruleRef(usedRule, "declined", declinedHits));
        scored.push(ruleOut(insurerId, insurerName, usedRule.id, matched, notes));
        continue;
      }

      if (usedRule.appetite_level === "declined") {
        notes.push("Insurer's appetite for this line/type is declined.");
        scored.push(ruleOut(insurerId, insurerName, usedRule.id, matched, notes));
        continue;
      }

      const preferredHits = findMatches(risk.features, usedRule.preferred_risks);
      if (preferredHits.length > 0) {
        const lift = Math.min(preferredHits.length * PREFERRED_PER_MATCH, PREFERRED_MATCH_CAP);
        score += lift;
        notes.push(`Preferred-risk matches +${lift}: ${preferredHits.join("; ")}`);
        matched.push(ruleRef(usedRule, "preferred", preferredHits));
      }

      const cautionHits = findMatches(risk.features, usedRule.caution_risks);
      if (cautionHits.length > 0) {
        const drop = cautionHits.length * CAUTION_PER_MATCH;
        score -= drop;
        notes.push(`Caution-risk matches -${drop}: ${cautionHits.join("; ")}`);
        matched.push(ruleRef(usedRule, "caution", cautionHits));
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

    let referralRequired = false;
    if (usedRule) {
      const referralHits = findMatches(risk.features, usedRule.referral_triggers);
      if (referralHits.length > 0) {
        const drop = referralHits.length * REFERRAL_TRIGGER_PENALTY;
        score -= drop;
        referralRequired = true;
        notes.push(`Referral triggers (product) -${drop}: ${referralHits.join("; ")}`);
        matched.push(ruleRef(usedRule, "referral", referralHits));
      }
    }

    let portfolioRuledOut = false;
    let portfolioRuledOutRule: string | null = null;
    for (const pf of portfolioRules) {
      const pDeclined = findMatches(risk.features, pf.declined_risks);
      if (pDeclined.length > 0) {
        notes.push(`Portfolio declined-risk match → ruled out: ${pDeclined.join("; ")}`);
        matched.push(ruleRef(pf, "portfolio_declined", pDeclined));
        portfolioRuledOut = true;
        portfolioRuledOutRule = pf.id;
        break;
      }
      const pCaution = findMatches(risk.features, pf.caution_risks);
      if (pCaution.length > 0) {
        const drop = pCaution.length * CAUTION_PER_MATCH;
        score -= drop;
        notes.push(`Portfolio caution-risk matches -${drop}: ${pCaution.join("; ")}`);
        matched.push(ruleRef(pf, "portfolio_caution", pCaution));
      }
      const pReferral = findMatches(risk.features, pf.referral_triggers);
      if (pReferral.length > 0) {
        const drop = pReferral.length * REFERRAL_TRIGGER_PENALTY;
        score -= drop;
        referralRequired = true;
        notes.push(`Portfolio referral triggers -${drop}: ${pReferral.join("; ")}`);
        matched.push(ruleRef(pf, "portfolio_referral", pReferral));
      }
    }

    if (portfolioRuledOut) {
      scored.push(ruleOut(insurerId, insurerName, portfolioRuledOutRule, matched, notes));
      continue;
    }

    const missingDocs: string[] = [];
    const required: { source: string; doc: string }[] = [];
    if (usedRule) for (const d of usedRule.required_documents) required.push({ source: "product", doc: d });
    for (const pf of portfolioRules) for (const d of pf.required_documents) required.push({ source: "portfolio", doc: d });
    const seen = new Set<string>();
    for (const r of required) {
      if (seen.has(r.doc.toLowerCase())) continue;
      seen.add(r.doc.toLowerCase());
      if (!hasRequiredDoc(risk.available_documents, r.doc)) missingDocs.push(r.doc);
    }
    let confidence = Math.max(0, Math.min(1, risk.overall_confidence || 0.7));
    if (missingDocs.length > 0) {
      const drop = Math.min(missingDocs.length * DOC_GAP_CONFIDENCE_PENALTY, DOC_GAP_CONFIDENCE_CAP);
      confidence = Math.max(0, confidence - drop);
      notes.push(`Required documents not evidenced: ${missingDocs.join("; ")} (confidence -${drop.toFixed(2)})`);
    }

    score = Math.max(0, Math.min(100, score));

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

    if (manualReviewRequired) confidence = Math.min(confidence, 0.35);

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
      referral_required: referralRequired,
      manual_review_required: manualReviewRequired,
      senior_review_required: seniorReview,
      ruled_out: false,
      scored_against_appetite_id: usedRule?.id ?? null,
      matched_rules: matched,
      scoring_notes: notes,
      missing_required_documents: missingDocs,
      unmatched_sections: unmatched.unmatchedSections,
      unmatched_product_candidates: unmatched.unmatchedProducts,
      nearby_rule_matches: unmatched.nearby,
    });
  }

  scored.sort((a, b) => {
    if (a.ruled_out !== b.ruled_out) return a.ruled_out ? 1 : -1;
    return b.score - a.score;
  });

  return { insurers: scored, no_data_for: noData };
}

function ruleOut(
  insurer_id: string,
  insurer_name: string,
  scored_against: string | null,
  matched_rules: MatchedRuleRef[],
  scoring_notes: string[]
): InsurerScore {
  return {
    insurer_id,
    insurer_name,
    score: 0,
    band: "ruled_out",
    rule_status: "ruled_out",
    confidence: 0,
    referral_required: false,
    manual_review_required: false,
    senior_review_required: false,
    ruled_out: true,
    scored_against_appetite_id: scored_against,
    matched_rules,
    scoring_notes,
    missing_required_documents: [],
    unmatched_sections: [],
    unmatched_product_candidates: [],
    nearby_rule_matches: [],
  };
}
