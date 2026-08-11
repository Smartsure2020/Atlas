/**
 * Recommendation workbench tests (Phase 3)
 * ----------------------------------------------------------------------------
 * Exercises the observable behaviour of the modernised recommendation panel:
 * the decision-oriented summary, the ranked hierarchy, the comparison matrix
 * (default selection, zero-selection empty state, recommended-column
 * labelling, differences highlighting, mobile-safe DOM), the evidence
 * disclosure and the internal-score honesty rule.
 *
 * Every external module the panel touches is fully mocked so no test ever
 * transitively loads ../lib/atlas (which builds the Supabase client at
 * module load and requires env vars CI does not have).
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "vitest-axe";

const runRecommendationMock = vi.fn();
vi.mock("../lib/recommendations", () => ({
  runRecommendation: (...args: unknown[]) => runRecommendationMock(...args),
}));

import RecommendationPanel from "../pages/RecommendationPanel";
import type { Recommendation, ScoredInsurer } from "../lib/recommendations";
import type { ExtractionConfidenceState } from "../lib/extraction-confidence";
import type { MissingInfoItem } from "../lib/phase4";

const AVAILABLE: ExtractionConfidenceState = {
  state: "available",
  value: 0.6,
  source: "provider",
  available: true,
};

function scored(over: Partial<ScoredInsurer>): ScoredInsurer {
  return {
    insurer_id: over.insurer_id ?? "ins_x",
    insurer_name: over.insurer_name ?? "Insurer X",
    score: over.score ?? 80,
    band: over.band ?? "standard",
    rule_status: over.rule_status ?? "standard",
    confidence: over.confidence ?? 0.8,
    confidence_available: over.confidence_available ?? true,
    referral_required: over.referral_required ?? false,
    manual_review_required: over.manual_review_required ?? false,
    senior_review_required: over.senior_review_required ?? false,
    ruled_out: over.ruled_out ?? false,
    scored_against_appetite_id: over.scored_against_appetite_id ?? null,
    matched_rules: over.matched_rules ?? [],
    scoring_notes: over.scoring_notes ?? [],
    missing_required_documents: over.missing_required_documents ?? [],
    unmatched_sections: over.unmatched_sections ?? [],
    unmatched_product_candidates: over.unmatched_product_candidates ?? [],
    nearby_rule_matches: over.nearby_rule_matches ?? [],
    reasoning: over.reasoning ?? "",
  };
}

const TOP = scored({
  insurer_id: "ins_top",
  insurer_name: "Zurich",
  band: "preferred",
  score: 92,
  reasoning: "Preferred appetite with matched sections.",
  matched_rules: [
    {
      appetite_id: "ap_1",
      matched_strings: ["office buildings"],
      rule_product_line: "commercial",
      rule_risk_type: "buildings",
      source_file_name: "zurich-appetite.pdf",
      source_page: 12,
      source_section: "Preferred",
      source_quote: "Prefer commercial office buildings.",
      list: "preferred",
    },
  ],
});

const SECONDARY = scored({
  insurer_id: "ins_2",
  insurer_name: "Allianz",
  band: "standard",
  score: 78,
  reasoning: "Standard appetite. Documents outstanding.",
  missing_required_documents: ["Broker letter of appointment"],
});

const RULED_OUT = scored({
  insurer_id: "ins_3",
  insurer_name: "Hollard",
  band: "ruled_out",
  score: 0,
  ruled_out: true,
  reasoning: "Outside declared appetite.",
});

function baseRecommendation(over: Partial<Recommendation> = {}): Recommendation {
  return {
    id: "rec_1",
    recommended_insurer: TOP.insurer_name,
    secondary_options_json: [SECONDARY],
    not_recommended_json: [RULED_OUT],
    reasoning_json: {
      headline: "Zurich is the strongest fit for this risk.",
      top: TOP,
      no_data_for: [],
    },
    confidence_score: 0.85,
    referral_required: false,
    senior_review_required: false,
    extraction_id: "ext_1",
    created_at: "2026-08-01T10:00:00Z",
    ...over,
  };
}

function renderPanel(
  props: Partial<React.ComponentProps<typeof RecommendationPanel>> = {}
) {
  const onRefresh = vi.fn().mockResolvedValue(undefined);
  const onGoToTab = vi.fn();
  const rendered = render(
    <RecommendationPanel
      submissionId="sub_1"
      recommendation={baseRecommendation()}
      extractionExists={true}
      extractionReviewed={true}
      extractionConfidence={AVAILABLE}
      openMissingInfo={[]}
      onRefresh={onRefresh}
      onGoToTab={onGoToTab}
      {...props}
    />
  );
  return { ...rendered, onRefresh, onGoToTab };
}

describe("RecommendationPanel — gates", () => {
  beforeEach(() => {
    runRecommendationMock.mockReset();
  });

  it("shows the no-extraction empty state and routes to the risk tab", async () => {
    const user = userEvent.setup();
    const { onGoToTab } = renderPanel({
      extractionExists: false,
      recommendation: null,
    });
    expect(screen.getByText(/Atlas needs an extraction/i)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Open risk information/i }));
    expect(onGoToTab).toHaveBeenCalledWith("risk");
  });

  it("gates when the extraction has not been reviewed and unlocks routing", async () => {
    const user = userEvent.setup();
    const { onGoToTab } = renderPanel({
      extractionReviewed: false,
      recommendation: null,
    });
    expect(
      screen.getByText(/Atlas will not run a recommendation against an unreviewed extraction/i)
    ).toBeInTheDocument();
    const runButton = screen.getByRole("button", { name: /Run recommendation/i });
    expect(runButton).toBeDisabled();
    await user.click(screen.getByRole("button", { name: /Open risk information/i }));
    expect(onGoToTab).toHaveBeenCalledWith("risk");
  });

  it("shows the no-recommendation inline empty state when extraction is reviewed", () => {
    renderPanel({ recommendation: null });
    expect(
      screen.getByText(/Atlas has not produced a recommendation yet/i)
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Run recommendation/i })).toBeEnabled();
  });
});

describe("RecommendationPanel — decision summary", () => {
  it("names the top insurer, appetite band, and derived counts", () => {
    renderPanel({
      recommendation: baseRecommendation(),
      openMissingInfo: [{ id: "mi_1" }, { id: "mi_2" }] as MissingInfoItem[],
    });
    const summary = screen.getByRole("region", { name: /Recommendation summary/i });
    // Named top insurer appears (may also appear elsewhere, but at least once here).
    expect(within(summary).getAllByText("Zurich").length).toBeGreaterThan(0);
    // Appetite band badge is present.
    expect(within(summary).getByText(/Preferred appetite/i)).toBeInTheDocument();

    // Counts strip is present and reports the recommended labels.
    expect(within(summary).getByText("Viable insurers")).toBeInTheDocument();
    expect(within(summary).getByText("Ruled out")).toBeInTheDocument();
    expect(within(summary).getByText("Matched rules")).toBeInTheDocument();
    expect(within(summary).getByText("Required documents")).toBeInTheDocument();
    // Outstanding info surfaces because openMissingInfo has items.
    expect(within(summary).getByText("Outstanding information")).toBeInTheDocument();
  });

  it("shows the no-viable-insurer state honestly when top is null", () => {
    renderPanel({
      recommendation: baseRecommendation({
        reasoning_json: {
          headline: "No insurer cleared appetite for this risk.",
          top: null,
          no_data_for: [],
        },
        secondary_options_json: [],
        not_recommended_json: [RULED_OUT],
      }),
    });
    // "No insurer cleared appetite" appears in the summary title AND in the
    // Notice below; the point is that the state is stated at least once.
    expect(
      screen.getAllByText(/No insurer cleared appetite/i).length
    ).toBeGreaterThan(0);
    expect(
      screen.getByRole("region", { name: /Recommendation summary/i })
    ).toBeInTheDocument();
  });
});

describe("RecommendationPanel — hierarchy and flags", () => {
  it("renders top, secondary and ruled-out groupings distinctly", () => {
    const { container } = renderPanel();
    // Top block carries the "Recommended" rank label.
    expect(screen.getByText("Recommended")).toBeInTheDocument();
    // Section dividers.
    expect(screen.getByText(/Other viable options/i)).toBeInTheDocument();
    expect(screen.getByText(/Ruled out by appetite/i)).toBeInTheDocument();
    // Insurer names present.
    expect(screen.getByRole("heading", { name: "Zurich" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Allianz" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Hollard" })).toBeInTheDocument();
    // Ruled-out block carries its "Not available" caption.
    expect(container.textContent ?? "").toMatch(/Not available for this risk/i);
  });

  it("distinguishes referral, senior-review and manual-review flags", () => {
    const referral = scored({
      insurer_id: "ins_r",
      insurer_name: "ReferralCo",
      band: "standard",
      referral_required: true,
    });
    const senior = scored({
      insurer_id: "ins_s",
      insurer_name: "SeniorCo",
      band: "standard",
      senior_review_required: true,
    });
    const manual = scored({
      insurer_id: "ins_m",
      insurer_name: "ManualCo",
      band: "insufficient_rule_match",
      manual_review_required: true,
    });
    renderPanel({
      recommendation: baseRecommendation({
        reasoning_json: { headline: "Mixed flags.", top: referral, no_data_for: [] },
        secondary_options_json: [senior, manual],
        not_recommended_json: [],
      }),
    });
    expect(screen.getAllByText(/Referral required/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Senior review/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Manual review/i).length).toBeGreaterThan(0);
  });

  it("surfaces the missing-information warning and routes to the tab", async () => {
    const user = userEvent.setup();
    const { onGoToTab } = renderPanel({
      openMissingInfo: [{ id: "a" }, { id: "b" }, { id: "c" }] as MissingInfoItem[],
    });
    expect(
      screen.getByText(/Outstanding information may change this result/i)
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Review outstanding information/i }));
    expect(onGoToTab).toHaveBeenCalledWith("missing-information");
  });
});

describe("RecommendationPanel — ranked/compare keyboard operation", () => {
  it("toggles between ranked and compare via keyboard without extra fetches", async () => {
    const user = userEvent.setup();
    const { onRefresh } = renderPanel();
    onRefresh.mockClear();
    runRecommendationMock.mockClear();

    const compare = screen.getByRole("button", { name: /Compare/i, pressed: false });
    compare.focus();
    await user.keyboard("{Enter}");
    expect(screen.getByRole("group", { name: /Recommendation view/i })).toBeInTheDocument();
    expect(
      screen.getByText(/Insurers in the comparison/i)
    ).toBeInTheDocument();
    // Toggling views must not trigger the recommendation endpoint.
    expect(runRecommendationMock).not.toHaveBeenCalled();
    expect(onRefresh).not.toHaveBeenCalled();
  });
});

describe("RecommendationPanel — comparison matrix", () => {
  it("defaults selection to viable insurers and labels the recommended column", async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.click(screen.getByRole("button", { name: /Compare/i }));

    // Comparison table renders and the recommended column has its role label.
    const table = screen.getByRole("table", { name: /Insurer comparison/i });
    expect(within(table).getByText("Zurich")).toBeInTheDocument();
    expect(within(table).getByText(/Atlas recommended/i)).toBeInTheDocument();
    // Secondary insurer starts included, ruled-out excluded.
    expect(within(table).getByText("Allianz")).toBeInTheDocument();
    expect(within(table).queryByText("Hollard")).toBeNull();
  });

  it("renders the zero-selection empty state when all checkboxes are unchecked", async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.click(screen.getByRole("button", { name: /Compare/i }));

    // Uncheck the two default selections.
    const zurich = screen.getByRole("checkbox", { name: /Zurich \(recommended\)/i });
    const allianz = screen.getByRole("checkbox", { name: /^Allianz/i });
    await user.click(zurich);
    await user.click(allianz);

    expect(screen.getByText(/No insurers selected/i)).toBeInTheDocument();
    expect(screen.queryByRole("table", { name: /Insurer comparison/i })).toBeNull();
  });

  it("carries data-insurer on cells for the mobile stacked representation", async () => {
    const user = userEvent.setup();
    const { container } = renderPanel();
    await user.click(screen.getByRole("button", { name: /Compare/i }));
    const cells = container.querySelectorAll("td[data-insurer]");
    expect(cells.length).toBeGreaterThan(0);
    const insurerNames = new Set(
      Array.from(cells).map((cell) => cell.getAttribute("data-insurer"))
    );
    expect(insurerNames.has("Zurich")).toBe(true);
    expect(insurerNames.has("Allianz")).toBe(true);
  });
});

describe("RecommendationPanel — evidence and honesty", () => {
  it("exposes matched-rule evidence in the ranked disclosure with a source reference", async () => {
    const user = userEvent.setup();
    renderPanel();
    const disclosures = screen.getAllByText(/Matched rules and scoring detail/i);
    expect(disclosures.length).toBeGreaterThan(0);
    await user.click(disclosures[0]);
    // Source metadata renders.
    expect(screen.getByText(/zurich-appetite\.pdf/i)).toBeInTheDocument();
    expect(screen.getByText(/Prefer commercial office buildings/i)).toBeInTheDocument();
  });

  it("states empty evidence honestly", () => {
    renderPanel({
      recommendation: baseRecommendation({
        reasoning_json: {
          headline: "Sparse.",
          top: scored({
            insurer_id: "ins_e",
            insurer_name: "EmptyCo",
            band: "standard",
            matched_rules: [],
          }),
          no_data_for: [],
        },
        secondary_options_json: [],
        not_recommended_json: [],
      }),
    });
    expect(
      screen.getByText(/No appetite rule matched this risk for EmptyCo/i)
    ).toBeInTheDocument();
  });

  it("never renders the internal score as a percentage", async () => {
    const user = userEvent.setup();
    const { container } = renderPanel();
    // Open the top insurer's disclosure.
    const disclosures = screen.getAllByText(/Matched rules and scoring detail/i);
    await user.click(disclosures[0]);
    // The internal-score line is present as an explanation and has NO percent.
    expect(container.textContent ?? "").toMatch(/Internal score 92\./);
    expect(container.textContent ?? "").not.toMatch(/Internal score 92%/);
    expect(container.textContent ?? "").not.toMatch(/92% probability/i);
  });
});

describe("RecommendationPanel — axe", () => {
  it("is axe-clean in the ranked-with-top state", async () => {
    const { container } = renderPanel();
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it("is axe-clean in the compare mode", async () => {
    const user = userEvent.setup();
    const { container } = renderPanel();
    await user.click(screen.getByRole("button", { name: /Compare/i }));
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it("is axe-clean when no insurer cleared appetite", async () => {
    const { container } = renderPanel({
      recommendation: baseRecommendation({
        reasoning_json: { headline: "None.", top: null, no_data_for: [] },
        secondary_options_json: [],
        not_recommended_json: [RULED_OUT],
      }),
    });
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
