/**
 * decision-workbench pure helpers
 * ----------------------------------------------------------------------------
 * These functions are the derivation seam the recommendation and quote-review
 * panels share. Their correctness is worth verifying directly so a UI test
 * failure narrows to rendering rather than derivation.
 */

import { describe, expect, it } from "vitest";
import type { Recommendation, ScoredInsurer } from "../lib/recommendations";
import {
  classifyComparisonRow,
  groupFindings,
  insurerChoiceList,
  rankInsurers,
  ruleListMeta,
  summariseRecommendation,
  toneToReasonKind,
} from "../lib/decision-workbench";

function scored(over: Partial<ScoredInsurer>): ScoredInsurer {
  return {
    insurer_id: over.insurer_id ?? "ins",
    insurer_name: over.insurer_name ?? "X",
    score: over.score ?? 0,
    band: over.band ?? "standard",
    rule_status: over.rule_status ?? "standard",
    confidence: over.confidence ?? 0.5,
    confidence_available: true,
    referral_required: over.referral_required ?? false,
    manual_review_required: over.manual_review_required ?? false,
    senior_review_required: over.senior_review_required ?? false,
    ruled_out: over.ruled_out ?? false,
    scored_against_appetite_id: null,
    matched_rules: over.matched_rules ?? [],
    scoring_notes: over.scoring_notes ?? [],
    missing_required_documents: over.missing_required_documents ?? [],
    unmatched_sections: over.unmatched_sections ?? [],
    unmatched_product_candidates: over.unmatched_product_candidates ?? [],
    nearby_rule_matches: [],
    reasoning: over.reasoning ?? "",
  };
}

function rec(over: Partial<Recommendation> = {}): Recommendation {
  return {
    id: "rec_1",
    recommended_insurer: null,
    secondary_options_json: [],
    not_recommended_json: [],
    reasoning_json: { headline: "H", top: null, no_data_for: [] },
    confidence_score: 0,
    referral_required: false,
    senior_review_required: false,
    extraction_id: null,
    created_at: "2026-08-01T10:00:00Z",
    ...over,
  };
}

describe("groupFindings", () => {
  it("emits a blocker for a ruled-out insurer with the declined strings", () => {
    const groups = groupFindings(
      scored({
        ruled_out: true,
        matched_rules: [
          {
            appetite_id: "a",
            matched_strings: ["mining", "explosives"],
            list: "declined",
          },
        ],
      })
    );
    expect(groups[0].kind).toBe("blocker");
    expect(groups[0].body).toMatch(/mining/);
    expect(groups[0].body).toMatch(/explosives/);
  });

  it("emits a referral, a concern and a strength when the flags line up", () => {
    const groups = groupFindings(
      scored({
        referral_required: true,
        matched_rules: [
          { appetite_id: "a", matched_strings: ["over authority"], list: "referral" },
          { appetite_id: "b", matched_strings: ["asbestos"], list: "caution" },
          { appetite_id: "c", matched_strings: ["retail"], list: "preferred" },
        ],
        missing_required_documents: ["Broker LoA"],
      })
    );
    const kinds = groups.map((g) => g.kind);
    expect(kinds).toContain("referral");
    expect(kinds).toContain("concern");
    expect(kinds).toContain("strength");
  });

  it("flags unmatched sections and products as info", () => {
    const groups = groupFindings(
      scored({
        unmatched_sections: ["marine"],
        unmatched_product_candidates: ["cyber"],
      })
    );
    const info = groups.find((g) => g.kind === "info");
    expect(info?.body).toMatch(/marine/);
    expect(info?.body).toMatch(/cyber/);
  });
});

describe("ruleListMeta", () => {
  it("maps enum values onto tone and label", () => {
    expect(ruleListMeta("preferred").tone).toBe("success");
    expect(ruleListMeta("declined").tone).toBe("danger");
    expect(ruleListMeta("portfolio_declined").tone).toBe("danger");
    expect(ruleListMeta("referral").tone).toBe("referral");
    expect(ruleListMeta("caution").tone).toBe("warning");
    expect(ruleListMeta("unknown").tone).toBe("neutral");
  });
});

describe("toneToReasonKind", () => {
  it("maps section-status tones onto reason kinds", () => {
    expect(toneToReasonKind("danger")).toBe("blocker");
    expect(toneToReasonKind("referral")).toBe("referral");
    expect(toneToReasonKind("warning")).toBe("concern");
    expect(toneToReasonKind("success")).toBe("strength");
    expect(toneToReasonKind("neutral")).toBe("info");
  });
});

describe("rankInsurers", () => {
  it("returns [] for a null recommendation", () => {
    expect(rankInsurers(null)).toEqual([]);
  });

  it("orders top, secondary then ruled-out with the expected ranks", () => {
    const top = scored({ insurer_id: "t", insurer_name: "T" });
    const a = scored({ insurer_id: "a", insurer_name: "A" });
    const b = scored({ insurer_id: "b", insurer_name: "B" });
    const out = scored({ insurer_id: "o", insurer_name: "O", ruled_out: true });
    const ranked = rankInsurers(
      rec({
        reasoning_json: { headline: "H", top, no_data_for: [] },
        secondary_options_json: [a, b],
        not_recommended_json: [out],
      })
    );
    expect(ranked).toEqual([
      { insurer: top, rank: 1, group: "top" },
      { insurer: a, rank: 2, group: "secondary" },
      { insurer: b, rank: 3, group: "secondary" },
      { insurer: out, rank: null, group: "ruled_out" },
    ]);
  });
});

describe("summariseRecommendation", () => {
  it("returns an empty summary for null", () => {
    const s = summariseRecommendation(null);
    expect(s.hasRecommendation).toBe(false);
    expect(s.viableCount).toBe(0);
    expect(s.ruledOutCount).toBe(0);
    expect(s.computedAt).toBeNull();
  });

  it("counts viable insurers, ruled-out, matched rules and distinct required documents", () => {
    const top = scored({
      insurer_id: "t",
      matched_rules: [
        { appetite_id: "a", matched_strings: [], list: "preferred" },
        { appetite_id: "b", matched_strings: [], list: "caution" },
      ],
      missing_required_documents: ["Doc A", "Doc B"],
    });
    const secondary = scored({
      insurer_id: "s",
      matched_rules: [{ appetite_id: "c", matched_strings: [], list: "preferred" }],
      missing_required_documents: ["Doc A"], // duplicate — distinctCount squashes.
    });
    const rulesOut = scored({ insurer_id: "o", ruled_out: true });
    const s = summariseRecommendation(
      rec({
        reasoning_json: { headline: "H", top, no_data_for: [] },
        secondary_options_json: [secondary],
        not_recommended_json: [rulesOut],
      })
    );
    expect(s.hasRecommendation).toBe(true);
    expect(s.hasViableTop).toBe(true);
    expect(s.viableCount).toBe(2);
    expect(s.ruledOutCount).toBe(1);
    expect(s.matchedRuleCount).toBe(3);
    expect(s.missingDocumentsCount).toBe(2); // Doc A + Doc B
  });

  it("reports no viable top when the reasoning has no top pick", () => {
    const s = summariseRecommendation(
      rec({
        reasoning_json: { headline: "None.", top: null, no_data_for: [] },
        not_recommended_json: [scored({ ruled_out: true })],
      })
    );
    expect(s.hasViableTop).toBe(false);
    expect(s.viableCount).toBe(0);
    expect(s.ruledOutCount).toBe(1);
  });
});

describe("insurerChoiceList", () => {
  it("returns [] for a null recommendation", () => {
    expect(insurerChoiceList(null)).toEqual([]);
  });

  it("groups top, other viable options and ruled-out separately", () => {
    const top = scored({ insurer_id: "t", insurer_name: "T" });
    const a = scored({ insurer_id: "a", insurer_name: "A" });
    const out = scored({ insurer_id: "o", insurer_name: "O", ruled_out: true });
    const choices = insurerChoiceList(
      rec({
        reasoning_json: { headline: "H", top, no_data_for: [] },
        secondary_options_json: [a],
        not_recommended_json: [out],
      })
    );
    expect(choices).toHaveLength(3);
    expect(choices[0].groupKey).toBe("top");
    expect(choices[0].group).toBe("Recommended");
    expect(choices[1].groupKey).toBe("secondary");
    expect(choices[2].groupKey).toBe("ruled_out");
    expect(choices[2].ruledOut).toBe(true);
  });
});

describe("classifyComparisonRow", () => {
  it("treats a single insurer as uniform", () => {
    expect(classifyComparisonRow(["A"])).toEqual({ kind: "uniform", signature: "A" });
  });

  it("all identical → uniform, no outlier", () => {
    expect(classifyComparisonRow(["A", "A", "A"])).toEqual({ kind: "uniform", signature: "A" });
  });

  it("two insurers with different values → no majority (neither is an outlier)", () => {
    expect(classifyComparisonRow(["A", "B"])).toEqual({ kind: "no-majority" });
  });

  it("three all-distinct values → no majority", () => {
    expect(classifyComparisonRow(["A", "B", "C"])).toEqual({ kind: "no-majority" });
  });

  it("four insurers split 2–2 → no majority", () => {
    expect(classifyComparisonRow(["A", "A", "B", "B"])).toEqual({ kind: "no-majority" });
  });

  it("four insurers split 2–1–1 → no strict majority (plurality is not >half)", () => {
    expect(classifyComparisonRow(["A", "A", "B", "C"])).toEqual({ kind: "no-majority" });
  });

  it("three insurers split 2–1 → strict majority on the pair", () => {
    expect(classifyComparisonRow(["A", "A", "B"])).toEqual({ kind: "majority", signature: "A" });
  });

  it("four insurers split 3–1 → strict majority on the triple", () => {
    expect(classifyComparisonRow(["A", "A", "A", "B"])).toEqual({ kind: "majority", signature: "A" });
  });

  it("is independent of column order", () => {
    const a = classifyComparisonRow(["A", "A", "B"]);
    const b = classifyComparisonRow(["B", "A", "A"]);
    const c = classifyComparisonRow(["A", "B", "A"]);
    expect(a).toEqual(b);
    expect(b).toEqual(c);
    expect(a).toEqual({ kind: "majority", signature: "A" });
    // A tie stays a tie no matter how the columns are arranged.
    expect(classifyComparisonRow(["A", "B"])).toEqual(classifyComparisonRow(["B", "A"]));
  });
});
