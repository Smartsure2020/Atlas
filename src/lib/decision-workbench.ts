/**
 * Atlas — decision workbench presentation semantics
 * ----------------------------------------------------------------------------
 * Pure derivation helpers shared by the recommendation and quote-review
 * panels. Everything here is a straight read of the Worker's existing data
 * shapes — no fabricated fields, no thresholds, no scoring re-interpretation.
 *
 * Kept as a lib module so the panels can render from the same source of
 * truth and so display semantics (rank groupings, insurer choice list, the
 * decision-oriented recommendation summary) can be exercised directly in
 * tests without mounting either page.
 */
import type { Recommendation, ScoredInsurer } from "./recommendations";

/* ---------------------------------------------------------------------------
   Structured reasons for a single insurer.
   ------------------------------------------------------------------------- */

export type ReasonKind = "blocker" | "referral" | "concern" | "strength" | "info";

export interface ReasonGroup {
  kind: ReasonKind;
  title: string;
  body: string;
  nextAction?: string;
}

/**
 * Turn the matcher's flat arrays into the structured reason shape the design
 * system uses: what the issue is, why it matters, and what happens next.
 */
export function groupFindings(insurer: ScoredInsurer): ReasonGroup[] {
  const groups: ReasonGroup[] = [];

  if (insurer.ruled_out) {
    const declined = (insurer.matched_rules ?? []).filter(
      (rule) => rule.list === "declined" || rule.list === "portfolio_declined"
    );
    groups.push({
      kind: "blocker",
      title: "Hard appetite failure",
      body: declined.length
        ? `The insurer's guideline declines this risk. Matched: ${declined
            .flatMap((rule) => rule.matched_strings)
            .join("; ")}.`
        : "This risk falls outside the insurer's stated appetite, so Atlas cannot recommend it.",
      nextAction:
        "Placing here would need the insurer to make an exception. Record an override reason if a manager approves it.",
    });
  }

  if (insurer.referral_required) {
    const triggers = (insurer.matched_rules ?? [])
      .filter((rule) => rule.list === "referral" || rule.list === "portfolio_referral")
      .flatMap((rule) => rule.matched_strings);
    groups.push({
      kind: "referral",
      title: "Referral required",
      body: triggers.length
        ? `The guideline requires a referral because of: ${triggers.join("; ")}.`
        : "The guideline requires the insurer or a senior underwriter to approve this risk before you proceed.",
      nextAction:
        "Prepare a referral pack with the risk summary, claims experience and mitigating factors.",
    });
  }

  const caution = (insurer.matched_rules ?? [])
    .filter((rule) => rule.list === "caution" || rule.list === "portfolio_caution")
    .flatMap((rule) => rule.matched_strings);
  if (caution.length > 0) {
    groups.push({
      kind: "concern",
      title: "Written with caution",
      body: `The guideline flags this risk for care: ${caution.join("; ")}.`,
      nextAction: "Expect tighter terms, higher excesses, or additional warranties on this risk.",
    });
  }

  const preferred = (insurer.matched_rules ?? [])
    .filter((rule) => rule.list === "preferred")
    .flatMap((rule) => rule.matched_strings);
  if (preferred.length > 0) {
    groups.push({
      kind: "strength",
      title: "Inside preferred appetite",
      body: `The guideline actively wants this business: ${preferred.join("; ")}.`,
    });
  }

  if ((insurer.missing_required_documents ?? []).length > 0) {
    groups.push({
      kind: "concern",
      title: "Documents this insurer requires",
      body: (insurer.missing_required_documents ?? []).join("; "),
      nextAction: "Request these from the broker before submitting to this insurer.",
    });
  }

  const unmatched = [
    ...(insurer.unmatched_sections ?? []).map((item) => `section "${item}"`),
    ...(insurer.unmatched_product_candidates ?? []).map((item) => `product "${item}"`),
  ];
  if (unmatched.length > 0) {
    groups.push({
      kind: "info",
      title: "Not covered by any rule on file",
      body: `Atlas found no guideline rule for ${unmatched.join(", ")}.`,
      nextAction:
        "Confirm the insurer's position on these directly, or ask a manager to add the missing appetite rules.",
    });
  }

  return groups;
}

/**
 * Meta for a single matched-rule list entry (used inside the ranked
 * disclosure). Kept as a helper so both the ranked view and any future
 * comparison-cell view render the same label and tone.
 */
export function ruleListMeta(list: string): { label: string; tone: "success" | "danger" | "referral" | "warning" | "neutral" } {
  switch (list) {
    case "preferred":
      return { label: "Preferred", tone: "success" };
    case "declined":
    case "portfolio_declined":
      return { label: "Declined", tone: "danger" };
    case "referral":
    case "portfolio_referral":
      return { label: "Referral trigger", tone: "referral" };
    case "caution":
    case "portfolio_caution":
      return { label: "Caution", tone: "warning" };
    default:
      return { label: "Base rule", tone: "neutral" };
  }
}

/**
 * Map a section-status tone onto the `Reason` component's structured kind.
 * Shared so quote-review section blocks and recommendation reasons stay
 * visually consistent.
 */
export function toneToReasonKind(tone: string): ReasonKind {
  switch (tone) {
    case "danger":
      return "blocker";
    case "referral":
      return "referral";
    case "warning":
      return "concern";
    case "success":
      return "strength";
    default:
      return "info";
  }
}

/* ---------------------------------------------------------------------------
   Ranked view derivation.
   ------------------------------------------------------------------------- */

export type InsurerGroupKey = "top" | "secondary" | "ruled_out";

export interface RankedInsurer {
  insurer: ScoredInsurer;
  /** 1 for the top pick, 2..N for other viable options, null for ruled-out. */
  rank: number | null;
  group: InsurerGroupKey;
}

/** Flat, ordered list: top first, then secondary, then ruled-out. */
export function rankInsurers(recommendation: Recommendation | null): RankedInsurer[] {
  if (!recommendation) return [];
  const out: RankedInsurer[] = [];
  const top = recommendation.reasoning_json.top;
  if (top) out.push({ insurer: top, rank: 1, group: "top" });
  (recommendation.secondary_options_json ?? []).forEach((insurer, index) => {
    out.push({ insurer, rank: index + 2, group: "secondary" });
  });
  (recommendation.not_recommended_json ?? []).forEach((insurer) => {
    out.push({ insurer, rank: null, group: "ruled_out" });
  });
  return out;
}

/* ---------------------------------------------------------------------------
   Decision-oriented summary of the whole recommendation.
   Every field is derived from existing Worker data — nothing invented.
   ------------------------------------------------------------------------- */

export interface RecommendationSummary {
  hasRecommendation: boolean;
  topInsurerName: string | null;
  /** True when at least one insurer cleared appetite. */
  hasViableTop: boolean;
  /** Insurers that were scored and NOT ruled out (includes the top pick). */
  viableCount: number;
  ruledOutCount: number;
  /** Aggregated across all viable insurers — a quick "how much did Atlas find". */
  matchedRuleCount: number;
  /** Distinct required-document strings across viable insurers. */
  missingDocumentsCount: number;
  /** Distinct unmatched section/product candidates across viable insurers. */
  unmatchedCoverageCount: number;
  /** Insurers with no rules on file at all. */
  noDataInsurerCount: number;
  requiresReferral: boolean;
  requiresSeniorReview: boolean;
  requiresManualReview: boolean;
  computedAt: string | null;
}

function distinctCount(values: string[]): number {
  return new Set(values.map((value) => value.trim()).filter((value) => value.length > 0)).size;
}

export function summariseRecommendation(
  recommendation: Recommendation | null
): RecommendationSummary {
  if (!recommendation) {
    return {
      hasRecommendation: false,
      topInsurerName: null,
      hasViableTop: false,
      viableCount: 0,
      ruledOutCount: 0,
      matchedRuleCount: 0,
      missingDocumentsCount: 0,
      unmatchedCoverageCount: 0,
      noDataInsurerCount: 0,
      requiresReferral: false,
      requiresSeniorReview: false,
      requiresManualReview: false,
      computedAt: null,
    };
  }

  const top = recommendation.reasoning_json.top ?? null;
  const secondary = recommendation.secondary_options_json ?? [];
  const ruledOut = recommendation.not_recommended_json ?? [];
  const viable = [...(top ? [top] : []), ...secondary];

  const matchedRuleCount = viable.reduce(
    (acc, insurer) => acc + (insurer.matched_rules?.length ?? 0),
    0
  );
  const missingDocumentsCount = distinctCount(
    viable.flatMap((insurer) => insurer.missing_required_documents ?? [])
  );
  const unmatchedCoverageCount = distinctCount(
    viable.flatMap((insurer) => [
      ...(insurer.unmatched_sections ?? []),
      ...(insurer.unmatched_product_candidates ?? []),
    ])
  );

  return {
    hasRecommendation: true,
    topInsurerName: top?.insurer_name ?? null,
    hasViableTop: Boolean(top),
    viableCount: viable.length,
    ruledOutCount: ruledOut.length,
    matchedRuleCount,
    missingDocumentsCount,
    unmatchedCoverageCount,
    noDataInsurerCount: recommendation.reasoning_json.no_data_for?.length ?? 0,
    requiresReferral:
      Boolean(recommendation.referral_required) ||
      viable.some((insurer) => insurer.referral_required),
    requiresSeniorReview:
      Boolean(recommendation.senior_review_required) ||
      viable.some((insurer) => insurer.senior_review_required),
    requiresManualReview: viable.some((insurer) => insurer.manual_review_required),
    computedAt: recommendation.created_at ?? null,
  };
}

/* ---------------------------------------------------------------------------
   Insurer choice list used by the placement decision form.
   ------------------------------------------------------------------------- */

export interface InsurerChoiceEntry {
  insurer: ScoredInsurer;
  group: "Recommended" | "Other viable options" | "Ruled out by appetite";
  groupKey: InsurerGroupKey;
  ruledOut: boolean;
}

export function insurerChoiceList(
  recommendation: Recommendation | null
): InsurerChoiceEntry[] {
  if (!recommendation) return [];
  const top = recommendation.reasoning_json.top ?? null;
  const entries: InsurerChoiceEntry[] = [];
  if (top) {
    entries.push({ insurer: top, group: "Recommended", groupKey: "top", ruledOut: false });
  }
  for (const insurer of recommendation.secondary_options_json ?? []) {
    entries.push({
      insurer,
      group: "Other viable options",
      groupKey: "secondary",
      ruledOut: false,
    });
  }
  for (const insurer of recommendation.not_recommended_json ?? []) {
    entries.push({
      insurer,
      group: "Ruled out by appetite",
      groupKey: "ruled_out",
      ruledOut: true,
    });
  }
  return entries;
}
