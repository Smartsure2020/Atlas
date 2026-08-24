/**
 * Atlas — manager oversight presentation helpers
 * ----------------------------------------------------------------------------
 * Pure, deterministic helpers used by the Manager Overview. Nothing here
 * fetches, mutates or reinterprets the ManagerStats contract: the worker
 * decides what the numbers mean, this file only decides how to say it.
 *
 * Two ideas underpin the helpers:
 *
 *  1. Filter honesty. Only a subset of ManagerStats fields respect the
 *     toolbar filters — the rest come from a recent server-side cap
 *     (currently 500 rows). We surface that split in section captions and
 *     tile hints so a manager reading "0" during a filtered view does not
 *     mistake it for "nothing happened".
 *  2. No fabricated denominators. reviews_by_status is a set of counts
 *     with no shared denominator to trust across filter states, so we
 *     render proportional bars against the largest visible bar — the same
 *     approach the shared RankedList primitive uses — rather than invent
 *     percentages.
 */
import type { ManagerStats } from "./phase4";
import { QUOTE_REVIEW_STATUS, quoteReviewStatus } from "./status";

/**
 * Deterministic outcome order for the reviews-by-status bars. The mapped
 * QUOTE_REVIEW_STATUS keys come first in their declared order; any unknown
 * enum a newer backend sends is appended in a stable alphabetical run so
 * the row is never dropped and the visible order never depends on hash
 * iteration.
 */
export function orderReviewOutcomes(
  counts: Record<string, number>
): { status: string; label: string; count: number }[] {
  const known = Object.keys(QUOTE_REVIEW_STATUS);
  const seen = new Set<string>();
  const rows: { status: string; label: string; count: number }[] = [];
  for (const key of known) {
    if (Object.prototype.hasOwnProperty.call(counts, key)) {
      rows.push({ status: key, label: quoteReviewStatus(key).label, count: counts[key] ?? 0 });
      seen.add(key);
    }
  }
  const extras = Object.keys(counts)
    .filter((key) => !seen.has(key))
    .sort((a, b) => a.localeCompare(b, "en"));
  for (const key of extras) {
    rows.push({ status: key, label: quoteReviewStatus(key).label, count: counts[key] ?? 0 });
  }
  return rows;
}

/**
 * Largest count across a list of items, floored at 1 so a bar-width
 * calculation never divides by zero and every visible row still renders a
 * legible track.
 */
export function maxCount<T extends { count: number }>(items: T[]): number {
  let max = 0;
  for (const item of items) if (item.count > max) max = item.count;
  return max > 0 ? max : 1;
}

/**
 * Safe bar-width helper. Returns a whole-number percentage in [floor, 100]
 * so bars remain visible for non-zero values but never claim more than the
 * track allows. Zero counts return 0 so a "nothing recorded" row reads as
 * empty rather than as a hair-line stripe.
 */
export function barWidth(count: number, max: number, floor = 4): number {
  if (!(count > 0) || !(max > 0)) return 0;
  const raw = (count / max) * 100;
  if (!Number.isFinite(raw)) return 0;
  return Math.min(100, Math.max(floor, Math.round(raw)));
}

export type ExceptionScope = "period" | "recent" | "period_capped";

export interface ExceptionMetric {
  key: string;
  label: string;
  value: number;
  scope: ExceptionScope;
  hint: string;
  attention: boolean;
}

/**
 * The exception-summary strip. Every entry is a number the worker already
 * calculated; nothing here derives a rate. The scope tag exists so the UI
 * can group filter-scoped tiles apart from aggregate-recent tiles without
 * the two being read as directly comparable.
 */
export function exceptionMetrics(stats: ManagerStats): ExceptionMetric[] {
  return [
    {
      key: "missing",
      label: "Outstanding information",
      value: stats.missing_info_open_count,
      scope: "recent",
      hint: "Items still open or awaiting a reply, across recent activity.",
      attention: stats.missing_info_open_count > 0,
    },
    {
      key: "referrals",
      label: "Referrals in period",
      value: stats.referrals_count,
      scope: "period",
      hint: "Reviews that required insurer or senior authority in the selected period.",
      attention: stats.referrals_count > 0,
    },
    {
      key: "declined",
      label: "Declined in period",
      value: stats.declined_count,
      scope: "period",
      hint: "Reviews where the quote conflicted with the insurer's appetite.",
      attention: stats.declined_count > 0,
    },
    {
      key: "overrides",
      label: "Recommendation overrides",
      value: stats.overrides_count,
      scope: "recent",
      hint: "Decisions that departed from the insurer Atlas ranked first. Each override carries a recorded reason.",
      attention: stats.overrides_count > 0,
    },
    {
      key: "attention",
      // Renamed from "Recent reviews shown" — the tile value is a
      // capped count (worker caps at ten), not a genuine period total.
      // Reading only the tile value + scope previously suggested "10
      // reviews needed attention in this period" which is not real.
      // "shown below" + the period_capped scope make the cap explicit
      // in both the label and the tag.
      label: "Recent reviews shown below",
      value: stats.recent_reviews_needing_attention.length,
      scope: "period_capped",
      hint: "Referred, declined, information-required or manual-review reviews shown below. Capped at the ten most recent in the selected period.",
      attention: stats.recent_reviews_needing_attention.length > 0,
    },
  ];
}

/**
 * The supporting workload strip — context, not exceptions. Kept separate
 * from exceptionMetrics so a manager glancing at the top of the page is
 * not asked to weigh a five-tile row where "Submissions" and "Referrals"
 * sit at the same visual weight.
 */
export interface WorkloadMetric {
  key: string;
  label: string;
  value: number;
  scope: ExceptionScope;
  hint: string;
}

export function workloadMetrics(stats: ManagerStats): WorkloadMetric[] {
  return [
    {
      key: "submissions",
      label: "Submissions",
      value: stats.total_submissions,
      scope: "recent",
      hint: "All submissions on file — not narrowed by the filters below Period.",
    },
    {
      key: "reviews",
      label: "Quote reviews completed",
      value: stats.quote_reviews_completed,
      scope: "period",
      hint: "Reviews Atlas finished against an insurer's rules in the selected period.",
    },
  ];
}

/**
 * Communications follow-through summary. The count difference is the raw
 * gap between drafted and recorded-as-sent; we never label it a failure
 * because staff can send outside Atlas. Difference is floored at zero so
 * a data race that shows sent>drafted never reads as a negative number.
 */
export interface CommunicationsSummary {
  drafted: number;
  sent: number;
  difference: number;
}

export function communicationsSummary(stats: ManagerStats): CommunicationsSummary {
  const drafted = Math.max(0, Math.trunc(stats.communications_generated_count));
  const sent = Math.max(0, Math.trunc(stats.communications_sent_manually_count));
  const difference = drafted > sent ? drafted - sent : 0;
  return { drafted, sent, difference };
}

/**
 * Human-readable label + value for the Period select — used both by the
 * filter bar and by the active-filter chips so the two never disagree.
 */
export const OVERSIGHT_DATE_RANGES = [
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
  { value: "90d", label: "Last 90 days" },
  { value: "all", label: "All time" },
] as const;

export type OversightDateRange = (typeof OVERSIGHT_DATE_RANGES)[number]["value"];

export function dateRangeLabel(value: string | null | undefined): string {
  const hit = OVERSIGHT_DATE_RANGES.find((range) => range.value === value);
  return hit ? hit.label : "Last 30 days";
}

/**
 * True when the aggregate lists and counts would all read as zero across
 * the current stats — used to decide whether to show a "nothing recorded
 * yet" empty state under the patterns section without hiding the
 * per-section empty labels the ranked lists already draw.
 */
export function allPatternsEmpty(stats: ManagerStats): boolean {
  return (
    stats.common_missing_information.length === 0 &&
    stats.common_referral_triggers.length === 0 &&
    stats.common_declined_reasons.length === 0
  );
}
