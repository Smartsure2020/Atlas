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

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, within, act, fireEvent } from "@testing-library/react";
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
    const columnHeaders = within(table)
      .getAllByRole("columnheader")
      .map((node) => node.textContent ?? "");
    expect(columnHeaders.some((text) => text.includes("Zurich"))).toBe(true);
    expect(within(table).getByText(/Atlas recommended/i)).toBeInTheDocument();
    // Secondary insurer starts included, ruled-out excluded.
    expect(columnHeaders.some((text) => text.includes("Allianz"))).toBe(true);
    expect(columnHeaders.some((text) => text.includes("Hollard"))).toBe(false);
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

  it("renders a real per-cell insurer label for the stacked representation", async () => {
    const user = userEvent.setup();
    const { container } = renderPanel();
    await user.click(screen.getByRole("button", { name: /Compare/i }));

    // The insurer name is a real DOM element inside every cell — not a
    // data-* attribute and not CSS-generated content — so the value↔insurer
    // association survives when the column header is dropped on mobile.
    const labels = Array.from(
      container.querySelectorAll("td .atlas-matrix__mobile-insurer")
    ).map((node) => node.textContent);
    expect(labels.length).toBeGreaterThan(0);
    expect(labels).toContain("Zurich");
    expect(labels).toContain("Allianz");

    // The obsolete generated-content hook is gone.
    expect(container.querySelector("td[data-insurer]")).toBeNull();

    // Desktop keeps its real column-header semantics: the insurer name appears
    // as a scope="col" header cell, so the mobile label is not a duplicate
    // accessible name at desktop (it is display:none there).
    const table = screen.getByRole("table", { name: /Insurer comparison/i });
    const colHeaders = within(table)
      .getAllByRole("columnheader")
      .map((node) => node.textContent ?? "");
    expect(colHeaders.some((text) => text.includes("Zurich"))).toBe(true);
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

describe("RecommendationPanel — comparison majority rendering", () => {
  // Two insurers whose appetite bands differ. Under the corrected semantics
  // this is a no-majority row: neither cell is an outlier and the row is not
  // receded as uniform.
  const twoWay = baseRecommendation({
    secondary_options_json: [SECONDARY],
    not_recommended_json: [],
  });

  it("marks no outlier and no uniform styling on a two-way differing row", async () => {
    const user = userEvent.setup();
    const { container } = renderPanel({ recommendation: twoWay });
    await user.click(screen.getByRole("button", { name: /Compare/i }));

    // No cell is flagged as differing, and no false "differs" announcement.
    expect(container.querySelector("td[data-differs='true']")).toBeNull();
    expect(screen.queryByText(/differs from the majority/i)).toBeNull();
    // The differing Appetite row is not receded as if the values were identical.
    const appetiteRow = within(screen.getByRole("table", { name: /Insurer comparison/i }))
      .getByText("Appetite")
      .closest("tr");
    expect(appetiteRow).not.toHaveAttribute("data-uniform");
  });

  it("marks exactly the one outlier when a strict majority exists", async () => {
    const user = userEvent.setup();
    // Three insurers: two referral-free, one requires a referral → 2–1 split.
    const a = scored({ insurer_id: "a", insurer_name: "Aviva", referral_required: false });
    const b = scored({ insurer_id: "b", insurer_name: "Bryte", referral_required: false });
    const c = scored({ insurer_id: "c", insurer_name: "Coface", referral_required: true });
    const rec = baseRecommendation({
      reasoning_json: { headline: "h", top: a, no_data_for: [] },
      secondary_options_json: [b, c],
      not_recommended_json: [],
    });
    const { container } = renderPanel({ recommendation: rec });
    await user.click(screen.getByRole("button", { name: /Compare/i }));

    // Exactly one cell (Coface's referral cell) is the outlier.
    const differing = container.querySelectorAll("td[data-differs='true']");
    expect(differing.length).toBe(1);
    expect(screen.getByText(/differs from the majority/i)).toBeInTheDocument();
  });

  it("uniform row is receded and marks no outlier", async () => {
    const user = userEvent.setup();
    // Two insurers identical on every comparison signature.
    const a = scored({ insurer_id: "a", insurer_name: "Aviva", band: "standard" });
    const b = scored({ insurer_id: "b", insurer_name: "Bryte", band: "standard" });
    const rec = baseRecommendation({
      reasoning_json: { headline: "h", top: a, no_data_for: [] },
      secondary_options_json: [b],
      not_recommended_json: [],
    });
    const { container } = renderPanel({ recommendation: rec });
    await user.click(screen.getByRole("button", { name: /Compare/i }));

    expect(container.querySelector("td[data-differs='true']")).toBeNull();
    expect(container.querySelector("tr[data-uniform='true']")).not.toBeNull();
  });
});

describe("RecommendationPanel — comparison scroll region", () => {
  const roCallbacks: ResizeObserverCallback[] = [];

  class FakeResizeObserver {
    private cb: ResizeObserverCallback;
    constructor(cb: ResizeObserverCallback) {
      this.cb = cb;
      roCallbacks.push(cb);
    }
    observe() {}
    unobserve() {}
    disconnect() {
      const index = roCallbacks.indexOf(this.cb);
      if (index >= 0) roCallbacks.splice(index, 1);
    }
  }

  beforeEach(() => {
    roCallbacks.length = 0;
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function setWidths(node: HTMLElement, scrollWidth: number, clientWidth: number) {
    Object.defineProperty(node, "scrollWidth", { configurable: true, value: scrollWidth });
    Object.defineProperty(node, "clientWidth", { configurable: true, value: clientWidth });
  }

  it("is not a region or tab stop when it does not overflow", async () => {
    const user = userEvent.setup();
    const { container } = renderPanel();
    await user.click(screen.getByRole("button", { name: /Compare/i }));

    const scroll = container.querySelector(".atlas-matrix-scroll") as HTMLElement;
    expect(scroll).not.toHaveAttribute("role");
    expect(scroll).not.toHaveAttribute("tabindex");
    expect(screen.queryByRole("region", { name: /Insurer comparison/i })).toBeNull();
  });

  it("becomes a named, focusable region once it overflows", async () => {
    const user = userEvent.setup();
    const { container } = renderPanel();
    await user.click(screen.getByRole("button", { name: /Compare/i }));

    const scroll = container.querySelector(".atlas-matrix-scroll") as HTMLElement;
    setWidths(scroll, 1200, 400);
    act(() => {
      roCallbacks.forEach((cb) => cb([], {} as ResizeObserver));
    });

    const region = screen.getByRole("region", { name: /Insurer comparison/i });
    expect(region).toBe(scroll);
    expect(region).toHaveAttribute("tabindex", "0");
    expect(within(region).getByRole("table", { name: /Insurer comparison/i })).toBeInTheDocument();
    region.focus();
    expect(document.activeElement).toBe(region);
  });

  it("recalculates scrollability when the selection changes", async () => {
    const user = userEvent.setup();
    const { container } = renderPanel();
    await user.click(screen.getByRole("button", { name: /Compare/i }));

    const scroll = container.querySelector(".atlas-matrix-scroll") as HTMLElement;
    // Now say the region overflows, then change the selection: the effect
    // re-runs on the new `shown` and re-measures without a manual RO tick.
    setWidths(scroll, 1200, 400);
    await user.click(screen.getByRole("checkbox", { name: /Hollard/i }));

    expect(screen.getByRole("region", { name: /Insurer comparison/i })).toBe(scroll);
  });

  it("disconnects its observer on unmount", async () => {
    const user = userEvent.setup();
    const { unmount } = renderPanel();
    await user.click(screen.getByRole("button", { name: /Compare/i }));
    expect(roCallbacks.length).toBeGreaterThan(0);
    unmount();
    expect(roCallbacks.length).toBe(0);
  });
});

describe("RecommendationPanel — comparison keyboard scrolling", () => {
  const roCallbacks: ResizeObserverCallback[] = [];

  class FakeResizeObserver {
    private cb: ResizeObserverCallback;
    constructor(cb: ResizeObserverCallback) {
      this.cb = cb;
      roCallbacks.push(cb);
    }
    observe() {}
    unobserve() {}
    disconnect() {
      const index = roCallbacks.indexOf(this.cb);
      if (index >= 0) roCallbacks.splice(index, 1);
    }
  }

  beforeEach(() => {
    roCallbacks.length = 0;
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // jsdom does not lay out or scroll. We install measurable widths and
  // scrollLeft, then wire scrollBy/scrollTo to mutate scrollLeft the same way
  // a real browser would, so the assertions describe the component's chosen
  // behaviour rather than jsdom internals.
  function makeScrollable(
    node: HTMLElement,
    { scrollWidth, clientWidth }: { scrollWidth: number; clientWidth: number }
  ) {
    Object.defineProperty(node, "scrollWidth", {
      configurable: true,
      value: scrollWidth,
    });
    Object.defineProperty(node, "clientWidth", {
      configurable: true,
      value: clientWidth,
    });
    let scrollLeft = 0;
    Object.defineProperty(node, "scrollLeft", {
      configurable: true,
      get: () => scrollLeft,
      set: (value: number) => {
        const max = Math.max(0, scrollWidth - clientWidth);
        scrollLeft = Math.max(0, Math.min(max, value));
      },
    });
    const scrollByMock = vi.fn((opts: ScrollToOptions) => {
      const max = Math.max(0, scrollWidth - clientWidth);
      scrollLeft = Math.max(0, Math.min(max, scrollLeft + (opts.left ?? 0)));
    });
    const scrollToMock = vi.fn((opts: ScrollToOptions) => {
      const max = Math.max(0, scrollWidth - clientWidth);
      scrollLeft = Math.max(0, Math.min(max, opts.left ?? 0));
    });
    (node as unknown as { scrollBy: typeof scrollByMock }).scrollBy = scrollByMock;
    (node as unknown as { scrollTo: typeof scrollToMock }).scrollTo = scrollToMock;
    return { scrollByMock, scrollToMock };
  }

  async function openComparison() {
    const user = userEvent.setup();
    const rendered = renderPanel();
    await user.click(screen.getByRole("button", { name: /Compare/i }));
    const scroll = rendered.container.querySelector(
      ".atlas-matrix-scroll"
    ) as HTMLElement;
    return { user, ...rendered, scroll };
  }

  function overflow(scroll: HTMLElement, dims = { scrollWidth: 1200, clientWidth: 400 }) {
    const controls = makeScrollable(scroll, dims);
    act(() => {
      roCallbacks.forEach((cb) => cb([], {} as ResizeObserver));
    });
    return controls;
  }

  it("exposes the named focusable region once the comparison overflows", async () => {
    const { scroll } = await openComparison();
    overflow(scroll);
    const region = screen.getByRole("region", { name: /Insurer comparison/i });
    expect(region).toBe(scroll);
    expect(region).toHaveAttribute("tabindex", "0");
  });

  it("ArrowRight advances scrollLeft", async () => {
    const { scroll } = await openComparison();
    const { scrollByMock } = overflow(scroll, { scrollWidth: 1200, clientWidth: 400 });
    scroll.focus();
    fireEvent.keyDown(scroll, { key: "ArrowRight" });
    expect(scrollByMock).toHaveBeenCalledTimes(1);
    const step = scrollByMock.mock.calls[0][0]!.left as number;
    expect(step).toBeGreaterThan(0);
    // ~80% of clientWidth (400) → around 320.
    expect(step).toBeGreaterThanOrEqual(300);
    expect(step).toBeLessThanOrEqual(340);
    expect(scroll.scrollLeft).toBe(step);
  });

  it("ArrowLeft reduces scrollLeft", async () => {
    const { scroll } = await openComparison();
    const { scrollByMock } = overflow(scroll, { scrollWidth: 1200, clientWidth: 400 });
    scroll.focus();
    // Move right first so there is somewhere to move back to.
    fireEvent.keyDown(scroll, { key: "ArrowRight" });
    const forward = scroll.scrollLeft;
    fireEvent.keyDown(scroll, { key: "ArrowLeft" });
    expect(scrollByMock).toHaveBeenCalledTimes(2);
    expect(scrollByMock.mock.calls[1][0]!.left).toBeLessThan(0);
    expect(scroll.scrollLeft).toBeLessThan(forward);
  });

  it("Home sets scrollLeft to 0", async () => {
    const { scroll } = await openComparison();
    const { scrollToMock } = overflow(scroll, { scrollWidth: 1200, clientWidth: 400 });
    scroll.focus();
    // Get somewhere non-zero, then Home.
    fireEvent.keyDown(scroll, { key: "End" });
    expect(scroll.scrollLeft).toBeGreaterThan(0);
    fireEvent.keyDown(scroll, { key: "Home" });
    const calls = scrollToMock.mock.calls;
    const last = calls[calls.length - 1];
    expect(last[0]!.left).toBe(0);
    expect(scroll.scrollLeft).toBe(0);
  });

  it("End moves to the maximum horizontal position", async () => {
    const { scroll } = await openComparison();
    const { scrollToMock } = overflow(scroll, { scrollWidth: 1200, clientWidth: 400 });
    scroll.focus();
    fireEvent.keyDown(scroll, { key: "End" });
    // Component passes scrollWidth; the browser (and our stub) clamps to max.
    const arg = scrollToMock.mock.calls[0][0]!.left as number;
    expect(arg).toBe(1200);
    expect(scroll.scrollLeft).toBe(1200 - 400);
  });

  it("calls preventDefault only for keys it handles", async () => {
    const { scroll } = await openComparison();
    overflow(scroll);
    scroll.focus();
    for (const key of ["ArrowRight", "ArrowLeft", "Home", "End"]) {
      const evt = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
      scroll.dispatchEvent(evt);
      expect(evt.defaultPrevented).toBe(true);
    }
  });

  it("ignores unrelated keys without preventing default and without scrolling", async () => {
    const { scroll } = await openComparison();
    const { scrollByMock, scrollToMock } = overflow(scroll);
    scroll.focus();
    for (const key of ["ArrowUp", "ArrowDown", "PageUp", "PageDown", "a", " "]) {
      const evt = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
      scroll.dispatchEvent(evt);
      expect(evt.defaultPrevented).toBe(false);
    }
    expect(scrollByMock).not.toHaveBeenCalled();
    expect(scrollToMock).not.toHaveBeenCalled();
  });

  it("does not hijack keyboard events originating inside interactive descendants", async () => {
    const { scroll } = await openComparison();
    const { scrollByMock, scrollToMock } = overflow(scroll);
    // Anything nested inside the scroll region stands in for an interactive
    // descendant — the handler must ignore events whose target is not the
    // region itself.
    const inner = scroll.querySelector("table") as HTMLElement;
    expect(inner).not.toBeNull();
    const evt = new KeyboardEvent("keydown", {
      key: "ArrowRight",
      bubbles: true,
      cancelable: true,
    });
    inner.dispatchEvent(evt);
    expect(evt.defaultPrevented).toBe(false);
    expect(scrollByMock).not.toHaveBeenCalled();
    expect(scrollToMock).not.toHaveBeenCalled();
  });

  it("does not attach scroll-key behaviour when the comparison does not overflow", async () => {
    const { scroll } = await openComparison();
    // No overflow → no role, no tabindex, no onKeyDown wiring.
    expect(scroll).not.toHaveAttribute("role");
    expect(scroll).not.toHaveAttribute("tabindex");
    const scrollByMock = vi.fn();
    const scrollToMock = vi.fn();
    (scroll as unknown as { scrollBy: typeof scrollByMock }).scrollBy = scrollByMock;
    (scroll as unknown as { scrollTo: typeof scrollToMock }).scrollTo = scrollToMock;
    fireEvent.keyDown(scroll, { key: "ArrowRight" });
    fireEvent.keyDown(scroll, { key: "End" });
    expect(scrollByMock).not.toHaveBeenCalled();
    expect(scrollToMock).not.toHaveBeenCalled();
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
