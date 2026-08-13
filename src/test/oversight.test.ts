/**
 * Manager oversight — presentation helpers
 * ----------------------------------------------------------------------------
 * Pure-function tests. They cover the truths the workbench relies on:
 *   - the deterministic outcome order (known enums first in declared order,
 *     unknown enums appended alphabetically and never dropped)
 *   - bar widths that never divide by zero and never overflow the track
 *   - the exception/workload split
 *   - the communications count-difference that must never be negative
 *   - filter labels the toolbar and chips share
 *   - safe empty-state derivation
 * Nothing in this file touches the API surface.
 */

import { describe, expect, it } from "vitest";
import type { ManagerStats } from "../lib/phase4";
import {
  allPatternsEmpty,
  barWidth,
  communicationsSummary,
  dateRangeLabel,
  exceptionMetrics,
  maxCount,
  orderReviewOutcomes,
  workloadMetrics,
} from "../lib/oversight";

function baseStats(over: Partial<ManagerStats> = {}): ManagerStats {
  return {
    total_submissions: 0,
    quote_reviews_completed: 0,
    reviews_by_status: {},
    missing_info_open_count: 0,
    referrals_count: 0,
    declined_count: 0,
    overrides_count: 0,
    communications_generated_count: 0,
    communications_sent_manually_count: 0,
    common_missing_information: [],
    common_referral_triggers: [],
    common_declined_reasons: [],
    recent_reviews_needing_attention: [],
    ...over,
  };
}

describe("orderReviewOutcomes", () => {
  it("preserves the QUOTE_REVIEW_STATUS declared order", () => {
    const rows = orderReviewOutcomes({
      declined: 2,
      can_proceed: 5,
      refer: 1,
    });
    expect(rows.map((row) => row.status)).toEqual(["can_proceed", "refer", "declined"]);
  });

  it("appends unknown enum values in stable alphabetical order without dropping them", () => {
    const rows = orderReviewOutcomes({
      can_proceed: 3,
      newer_state: 1,
      another_state: 2,
    });
    expect(rows.map((row) => row.status)).toEqual([
      "can_proceed",
      "another_state",
      "newer_state",
    ]);
    // Unknown states must still have humanised labels so the row is legible.
    expect(rows.find((r) => r.status === "newer_state")?.label).toBe("Newer state");
  });

  it("returns an empty list for empty input and does not mutate its argument", () => {
    const input: Record<string, number> = {};
    Object.freeze(input);
    expect(orderReviewOutcomes(input)).toEqual([]);
  });
});

describe("maxCount", () => {
  it("returns the largest positive count", () => {
    expect(maxCount([{ count: 1 }, { count: 4 }, { count: 2 }])).toBe(4);
  });

  it("is floored at 1 so bar-width helpers never divide by zero", () => {
    expect(maxCount([])).toBe(1);
    expect(maxCount([{ count: 0 }, { count: 0 }])).toBe(1);
  });
});

describe("barWidth", () => {
  it("returns 0 for a zero count so an empty row reads as empty", () => {
    expect(barWidth(0, 10)).toBe(0);
  });

  it("clamps between the visibility floor and 100", () => {
    expect(barWidth(1, 100)).toBe(4);
    expect(barWidth(50, 100)).toBe(50);
    expect(barWidth(999, 100)).toBe(100);
  });

  it("returns 0 for non-finite or non-positive inputs", () => {
    expect(barWidth(1, 0)).toBe(0);
    expect(barWidth(Number.NaN, 10)).toBe(0);
    // A non-finite count is treated as data noise, not as "fill the whole
    // bar" — the row would otherwise mislead about the scale of other rows.
    expect(barWidth(Number.POSITIVE_INFINITY, 10)).toBe(0);
  });
});

describe("exceptionMetrics", () => {
  it("marks tiles as attention only when non-zero", () => {
    const tiles = exceptionMetrics(
      baseStats({
        missing_info_open_count: 0,
        referrals_count: 2,
        declined_count: 0,
        overrides_count: 1,
        recent_reviews_needing_attention: [],
      })
    );
    expect(tiles.find((t) => t.key === "missing")?.attention).toBe(false);
    expect(tiles.find((t) => t.key === "referrals")?.attention).toBe(true);
    expect(tiles.find((t) => t.key === "overrides")?.attention).toBe(true);
  });

  it("labels period-scoped vs recent-activity tiles honestly", () => {
    const tiles = exceptionMetrics(baseStats());
    expect(tiles.find((t) => t.key === "referrals")?.scope).toBe("period");
    expect(tiles.find((t) => t.key === "declined")?.scope).toBe("period");
    expect(tiles.find((t) => t.key === "missing")?.scope).toBe("recent");
    expect(tiles.find((t) => t.key === "overrides")?.scope).toBe("recent");
    // Recent-attention list is capped server-side; the hint must say so.
    const attention = tiles.find((t) => t.key === "attention")!;
    expect(attention.hint).toMatch(/Capped at the ten most recent/i);
  });
});

describe("workloadMetrics", () => {
  it("returns two supporting-context tiles with their scope tags", () => {
    const items = workloadMetrics(
      baseStats({ total_submissions: 42, quote_reviews_completed: 7 })
    );
    expect(items.map((item) => [item.key, item.value, item.scope])).toEqual([
      ["submissions", 42, "recent"],
      ["reviews", 7, "period"],
    ]);
  });
});

describe("communicationsSummary", () => {
  it("returns the exact counts and their positive difference", () => {
    const summary = communicationsSummary(
      baseStats({
        communications_generated_count: 10,
        communications_sent_manually_count: 3,
      })
    );
    expect(summary).toEqual({ drafted: 10, sent: 3, difference: 7 });
  });

  it("never presents a negative difference when sent exceeds drafted", () => {
    const summary = communicationsSummary(
      baseStats({
        communications_generated_count: 2,
        communications_sent_manually_count: 5,
      })
    );
    expect(summary.difference).toBe(0);
  });

  it("floors non-integer or negative inputs so the display can never go below zero", () => {
    const summary = communicationsSummary(
      baseStats({
        communications_generated_count: -1 as unknown as number,
        communications_sent_manually_count: 2.9 as unknown as number,
      })
    );
    expect(summary.drafted).toBe(0);
    expect(summary.sent).toBe(2);
    expect(summary.difference).toBe(0);
  });
});

describe("dateRangeLabel", () => {
  it("returns the human label for each known range", () => {
    expect(dateRangeLabel("7d")).toBe("Last 7 days");
    expect(dateRangeLabel("30d")).toBe("Last 30 days");
    expect(dateRangeLabel("90d")).toBe("Last 90 days");
    expect(dateRangeLabel("all")).toBe("All time");
  });

  it("falls back to the default label for unknown values", () => {
    expect(dateRangeLabel("weird")).toBe("Last 30 days");
    expect(dateRangeLabel(null)).toBe("Last 30 days");
  });
});

describe("allPatternsEmpty", () => {
  it("is true only when every pattern list is empty", () => {
    expect(allPatternsEmpty(baseStats())).toBe(true);
    expect(
      allPatternsEmpty(
        baseStats({ common_missing_information: [{ label: "IDs", count: 1 }] })
      )
    ).toBe(false);
  });
});
