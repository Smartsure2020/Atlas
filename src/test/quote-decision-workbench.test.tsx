/**
 * Quote review and placement decision workbench tests (Phase 3)
 * ----------------------------------------------------------------------------
 * Exercises the observable behaviour of the modernised quote-review tab:
 * the Atlas review card, the human decision surface as a separate region,
 * the context strip, form seeding, override/ruled-out validation paths,
 * the confirmation dialog, prior-decision preservation, previous reviews
 * and the quote comparison.
 *
 * All external modules are fully mocked so no test transitively loads
 * ../lib/atlas.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "vitest-axe";

const runQuoteReviewMock = vi.fn();
const recordDecisionMock = vi.fn();
const getQuoteReviewHistoryMock = vi.fn();

vi.mock("../lib/quote-reviews", () => ({
  runQuoteReview: (...args: unknown[]) => runQuoteReviewMock(...args),
}));
vi.mock("../lib/decisions", () => ({
  recordDecision: (...args: unknown[]) => recordDecisionMock(...args),
}));
vi.mock("../lib/phase4", () => ({
  getQuoteReviewHistory: (...args: unknown[]) => getQuoteReviewHistoryMock(...args),
}));

import QuoteReviewPanel from "../pages/QuoteReviewPanel";
import type {
  QuoteReview,
  QuoteReviewSection,
  QuoteReviewSectionStatus,
} from "../lib/quote-reviews";
import type { Decision } from "../lib/decisions";
import type { Recommendation, ScoredInsurer } from "../lib/recommendations";
import type { WorkspaceData } from "../pages/SubmissionDetail";
import type { ExtractionConfidenceState } from "../lib/extraction-confidence";
import type { ComparisonRow } from "../lib/phase4";

const AVAILABLE: ExtractionConfidenceState = {
  state: "available",
  value: 0.6,
  source: "provider",
  available: true,
};
const UNAVAILABLE: ExtractionConfidenceState = {
  state: "unavailable",
  value: null,
  source: "unavailable",
  available: false,
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
    scored_against_appetite_id: null,
    matched_rules: over.matched_rules ?? [],
    scoring_notes: [],
    missing_required_documents: [],
    unmatched_sections: [],
    unmatched_product_candidates: [],
    nearby_rule_matches: [],
    reasoning: over.reasoning ?? "",
  };
}

const TOP = scored({ insurer_id: "ins_top", insurer_name: "Zurich", band: "preferred" });
const SECONDARY = scored({ insurer_id: "ins_2", insurer_name: "Allianz", band: "standard" });
const RULED_OUT = scored({
  insurer_id: "ins_out",
  insurer_name: "Hollard",
  band: "ruled_out",
  ruled_out: true,
});

function recommendation(over: Partial<Recommendation> = {}): Recommendation {
  return {
    id: "rec_1",
    recommended_insurer: TOP.insurer_name,
    secondary_options_json: [SECONDARY],
    not_recommended_json: [RULED_OUT],
    reasoning_json: {
      headline: "Zurich fits best.",
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

function makeQuoteReview(over: Partial<QuoteReview> = {}): QuoteReview {
  return {
    id: "qr_1",
    submission_id: "sub_1",
    recommendation_id: "rec_1",
    insurer_id: TOP.insurer_id,
    status: "can_proceed",
    overall_outcome: "can_proceed",
    overall_confidence: 0.85,
    manual_review_required: false,
    review_snapshot: {},
    created_at: "2026-08-01T11:00:00Z",
    updated_at: "2026-08-01T11:00:00Z",
    ...over,
  };
}

function section(
  status: QuoteReviewSectionStatus,
  over: Partial<QuoteReviewSection> = {}
): QuoteReviewSection {
  return {
    id: `sec_${status}_${Math.random().toString(36).slice(2, 6)}`,
    quote_review_id: "qr_1",
    section_key: over.section_key ?? status,
    section_name: over.section_name ?? `${status} section`,
    matched_rule_id: null,
    status,
    confidence: 0.9,
    findings: over.findings ?? [],
    missing_documents: over.missing_documents ?? [],
    referral_triggers: over.referral_triggers ?? [],
    declined_reasons: over.declined_reasons ?? [],
    rating_findings: over.rating_findings ?? [],
    excess_findings: over.excess_findings ?? [],
    warranty_findings: over.warranty_findings ?? [],
    source_evidence: over.source_evidence ?? {},
  };
}

function workspace(over: Partial<WorkspaceData> = {}): WorkspaceData {
  return {
    payload: {
      submission: {
        id: "sub_1",
        client_name: "Acme",
        broker_name: "B",
        broker_email: null,
        request_type: "R",
        status: "in_review",
        queue_status: "in_review",
        line_of_business: "commercial",
        priority: "normal",
        next_action: null,
        due_at: null,
        assigned_to: null,
        assigned_underwriter: null,
        pilot_flag: null,
        pilot_notes: null,
        assigned_to_email: null,
        created_at: "2026-08-01T09:00:00Z",
        updated_at: "2026-08-01T10:00:00Z",
      } as WorkspaceData["payload"]["submission"],
      documents: [],
      extraction: {
        id: "ext_1",
        extracted_json: null,
        reviewed_json: {},
        extraction_confidence: 0.7,
      },
      jobs: {},
    },
    recommendation: recommendation(),
    quoteReview: makeQuoteReview(),
    quoteSections: [],
    decision: null,
    missingInfo: [],
    ...over,
  };
}

function renderPanel(
  props: Partial<React.ComponentProps<typeof QuoteReviewPanel>> = {}
) {
  const onRefresh = vi.fn().mockResolvedValue(undefined);
  const onGoToTab = vi.fn();
  const rendered = render(
    <QuoteReviewPanel
      submissionId="sub_1"
      data={workspace()}
      extractionReviewed={true}
      extractionConfidence={AVAILABLE}
      onRefresh={onRefresh}
      onGoToTab={onGoToTab}
      {...props}
    />
  );
  return { ...rendered, onRefresh, onGoToTab };
}

beforeEach(() => {
  runQuoteReviewMock.mockReset();
  recordDecisionMock.mockReset();
  getQuoteReviewHistoryMock.mockReset().mockResolvedValue({
    reviews: [],
    comparison: [],
  });
});

describe("QuoteReviewPanel — no review", () => {
  it("shows the no-review empty state and no decision surface", () => {
    renderPanel({ data: workspace({ quoteReview: null }) });
    expect(screen.getByText(/No quote review yet/i)).toBeInTheDocument();
    // Decision card only renders when a quote review exists.
    expect(screen.queryByRole("region", { name: /Placement decision/i })).toBeNull();
    // No "Your placement decision" heading.
    expect(
      screen.queryByRole("heading", { name: /Your placement decision/i })
    ).toBeNull();
  });

  it("gates behind the unreviewed-extraction notice and routes back", async () => {
    const user = userEvent.setup();
    const { onGoToTab } = renderPanel({
      extractionReviewed: false,
      data: workspace({ quoteReview: null }),
    });
    expect(
      screen.getByText(/The quote review compares the quote against the reviewed risk information/i)
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Open risk information/i }));
    expect(onGoToTab).toHaveBeenCalledWith("risk");
  });
});

describe("QuoteReviewPanel — completed review", () => {
  it("names the Atlas review and human decision as separate accessible regions", () => {
    renderPanel({
      data: workspace({ quoteSections: [section("ok"), section("refer")] }),
    });
    expect(
      screen.getByRole("heading", { name: /Atlas quote review/i })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: /Your placement decision/i })
    ).toBeInTheDocument();
    // The decision surface is landmarked as its own region.
    expect(
      screen.getByRole("region", { name: /Placement decision/i })
    ).toBeInTheDocument();
  });

  it("shows every finding group in the section blocks", () => {
    const rich = section("refer", {
      section_name: "Buildings",
      findings: ["Adjust wording"],
      missing_documents: ["Schedule"],
      referral_triggers: ["Sum insured above authority"],
      declined_reasons: [],
      rating_findings: ["Rate below floor"],
      excess_findings: ["Excess too low"],
      warranty_findings: ["Warranty missing"],
      source_evidence: {
        consultant_explanation: "This section needs referral.",
        rule: {
          source_file_name: "zurich-rules.pdf",
          source_page: 4,
          source_quote: "Buildings > R50m require referral.",
          source_section: "Buildings",
        },
      },
    });
    renderPanel({ data: workspace({ quoteSections: [rich] }) });
    expect(screen.getByText(/Referral triggers/i)).toBeInTheDocument();
    expect(screen.getByText(/Documents outstanding/i)).toBeInTheDocument();
    expect(screen.getByText(/Rating findings/i)).toBeInTheDocument();
    expect(screen.getByText(/Excess findings/i)).toBeInTheDocument();
    expect(screen.getByText(/Warranty findings/i)).toBeInTheDocument();
    expect(screen.getByText(/Other findings/i)).toBeInTheDocument();
  });

  it("makes the rule evidence disclosure reachable and reveals the source reference", async () => {
    const user = userEvent.setup();
    renderPanel({
      data: workspace({
        quoteSections: [
          section("refer", {
            source_evidence: {
              rule: {
                source_file_name: "zurich-rules.pdf",
                source_page: 4,
                source_quote: "Buildings > R50m require referral.",
                source_section: "Buildings",
              },
            },
          }),
        ],
      }),
    });
    await user.click(screen.getByText(/The rule this was checked against/i));
    expect(screen.getByText(/zurich-rules\.pdf/i)).toBeInTheDocument();
    expect(screen.getByText(/Buildings > R50m require referral/i)).toBeInTheDocument();
  });

  it("does not relabel quote-review confidence as extraction confidence when extraction is unavailable", () => {
    renderPanel({
      extractionConfidence: UNAVAILABLE,
      data: workspace({
        quoteReview: makeQuoteReview({ overall_confidence: 0.87 }),
      }),
    });
    expect(
      screen.getByText(/Extraction confidence is unavailable/i)
    ).toBeInTheDocument();
    expect(screen.queryByText(/extraction confidence.*87/i)).toBeNull();
    expect(screen.queryByText(/87.*extraction/i)).toBeNull();
  });
});

describe("QuoteReviewPanel — decision surface", () => {
  it("seeds insurer and choice from the current review", () => {
    renderPanel();
    // Atlas review status is can_proceed → decision choice defaults to proceed.
    const decisionSelect = screen.getByRole("combobox", { name: /^Decision/ }) as HTMLSelectElement;
    expect(decisionSelect.value).toBe("proceed");
    // Insurer selection defaults to the recommendation's top insurer.
    const insurerSelect = screen.getByRole("combobox", { name: /^Insurer/ }) as HTMLSelectElement;
    expect(insurerSelect.value).toBe(TOP.insurer_id);
  });

  it("shows the same-insurer context (matches Atlas's recommendation) with no override warning", () => {
    renderPanel();
    expect(screen.getByText(/Matches Atlas's recommendation/i)).toBeInTheDocument();
    expect(
      screen.queryByText(/This differs from the Atlas recommendation/i)
    ).toBeNull();
  });

  it("warns when the underwriter picks a different insurer and requires a reason", async () => {
    const user = userEvent.setup();
    renderPanel();
    const insurerSelect = screen.getByRole("combobox", { name: /^Insurer/ });
    await user.selectOptions(insurerSelect, SECONDARY.insurer_id);
    expect(
      screen.getByText(/This differs from the Atlas recommendation/i)
    ).toBeInTheDocument();
    // Click the record button without a reason — should show validation.
    await user.click(screen.getByRole("button", { name: /Record placement decision/i }));
    expect(
      screen.getByText(/Required for overrides, referrals and declines/i)
    ).toBeInTheDocument();
    // Nothing should have hit the API.
    expect(recordDecisionMock).not.toHaveBeenCalled();
  });

  it("shows the ruled-out warning and blocks casual recording", async () => {
    const user = userEvent.setup();
    renderPanel();
    const insurerSelect = screen.getByRole("combobox", { name: /^Insurer/ });
    await user.selectOptions(insurerSelect, RULED_OUT.insurer_id);
    expect(
      screen.getByText(/This insurer was ruled out by appetite/i)
    ).toBeInTheDocument();
  });

  it("opens the confirmation dialog when the form validates and records on confirm", async () => {
    const user = userEvent.setup();
    recordDecisionMock.mockResolvedValue({ ok: true, decision_id: "dec_1" });
    renderPanel();
    await user.click(screen.getByRole("button", { name: /Record placement decision/i }));
    // The confirmation dialog opens.
    const dialog = await screen.findByRole("dialog", {
      name: /Record this placement decision\?/i,
    });
    expect(dialog).toBeInTheDocument();
    // Confirm.
    await user.click(within(dialog).getByRole("button", { name: /Record decision/i }));
    await waitFor(() => {
      expect(recordDecisionMock).toHaveBeenCalledTimes(1);
    });
    const [, payload] = recordDecisionMock.mock.calls[0];
    expect(payload).toMatchObject({
      quote_review_id: "qr_1",
      selected_insurer_id: TOP.insurer_id,
      decision_choice: "proceed",
      ai_recommendation_accepted: true,
    });
  });

  it("closes the confirmation dialog on Escape and returns focus to the trigger", async () => {
    const user = userEvent.setup();
    renderPanel();
    const trigger = screen.getByRole("button", { name: /Record placement decision/i });
    await user.click(trigger);
    await screen.findByRole("dialog", { name: /Record this placement decision\?/i });
    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", { name: /Record this placement decision\?/i })
      ).toBeNull();
    });
    expect(document.activeElement).toBe(trigger);
  });

  it("requires the override reason when Decision = override", async () => {
    const user = userEvent.setup();
    renderPanel();
    const decisionSelect = screen.getByRole("combobox", { name: /^Decision/ });
    await user.selectOptions(decisionSelect, "override");
    // Override reason select appears.
    expect(screen.getByRole("combobox", { name: /Override reason/i })).toBeInTheDocument();
    // Attempt to record without a written reason.
    await user.click(screen.getByRole("button", { name: /Record placement decision/i }));
    expect(
      screen.getByText(/Required for overrides, referrals and declines/i)
    ).toBeInTheDocument();
    expect(recordDecisionMock).not.toHaveBeenCalled();
  });

  it("preserves a recorded decision as historical context above the form", () => {
    const priorDecision: Decision = {
      id: "dec_prior",
      quote_review_id: "qr_1",
      recommendation_id: "rec_1",
      selected_insurer: "Zurich",
      selected_insurer_id: TOP.insurer_id,
      decision_status: "ready_for_quote",
      decision_choice: "proceed",
      decision_reason: null,
      underwriter_notes: null,
      ai_recommendation_accepted: true,
      override_reason_code: null,
      override_reason: null,
      decision_snapshot: null,
      decided_by: "u_1",
      decided_at: "2026-08-01T12:00:00Z",
    };
    renderPanel({ data: workspace({ decision: priorDecision }) });
    expect(screen.getByText(/A decision is already recorded/i)).toBeInTheDocument();
    expect(
      screen.getByText(
        /Recording another decision creates a new audited entry — the previous one is kept/i
      )
    ).toBeInTheDocument();
    // The form remains present for a new decision.
    expect(
      screen.getByRole("button", { name: /Record placement decision/i })
    ).toBeInTheDocument();
  });
});

describe("QuoteReviewPanel — confirmation dialog focus restoration", () => {
  const dialogName = /Record this placement decision\?/i;

  it("1. the trigger is focusable and can hold focus", () => {
    renderPanel();
    const trigger = screen.getByRole("button", { name: /Record placement decision/i });
    trigger.focus();
    expect(document.activeElement).toBe(trigger);
  });

  it("2. activating the trigger opens the confirmation dialog", async () => {
    const user = userEvent.setup();
    renderPanel();
    const trigger = screen.getByRole("button", { name: /Record placement decision/i });
    await user.click(trigger);
    expect(await screen.findByRole("dialog", { name: dialogName })).toBeInTheDocument();
  });

  it("3. Escape closes the dialog and restores focus to the trigger", async () => {
    const user = userEvent.setup();
    renderPanel();
    const trigger = screen.getByRole("button", { name: /Record placement decision/i });
    await user.click(trigger);
    await screen.findByRole("dialog", { name: dialogName });
    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: dialogName })).toBeNull();
    });
    expect(document.activeElement).toBe(trigger);
  });

  it("4. the dialog can be reopened after being dismissed", async () => {
    const user = userEvent.setup();
    renderPanel();
    const trigger = screen.getByRole("button", { name: /Record placement decision/i });
    await user.click(trigger);
    await screen.findByRole("dialog", { name: dialogName });
    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: dialogName })).toBeNull();
    });
    // Focus is back on the trigger, so it can be activated again immediately.
    await user.click(trigger);
    expect(await screen.findByRole("dialog", { name: dialogName })).toBeInTheDocument();
  });

  it("5. Cancel closes the dialog and restores focus to the trigger", async () => {
    const user = userEvent.setup();
    renderPanel();
    const trigger = screen.getByRole("button", { name: /Record placement decision/i });
    await user.click(trigger);
    const dialog = await screen.findByRole("dialog", { name: dialogName });
    await user.click(within(dialog).getByRole("button", { name: /^Cancel$/i }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: dialogName })).toBeNull();
    });
    expect(document.activeElement).toBe(trigger);
  });

  it("6. focus stays trapped inside the open dialog when tabbing", async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.click(screen.getByRole("button", { name: /Record placement decision/i }));
    const dialog = await screen.findByRole("dialog", { name: dialogName });
    // Initial focus lands inside the dialog.
    expect(dialog.contains(document.activeElement)).toBe(true);
    // Tabbing forward and backward keeps focus within the dialog rather than
    // escaping to the page behind it.
    await user.tab();
    expect(dialog.contains(document.activeElement)).toBe(true);
    await user.tab({ shift: true });
    expect(dialog.contains(document.activeElement)).toBe(true);
  });
});

describe("QuoteReviewPanel — previous reviews and comparison", () => {
  it("labels the current review and earlier reviews distinctly", async () => {
    getQuoteReviewHistoryMock.mockResolvedValue({
      reviews: [
        makeQuoteReview({ id: "qr_1", created_at: "2026-08-01T11:00:00Z" }),
        makeQuoteReview({
          id: "qr_0",
          created_at: "2026-07-30T09:00:00Z",
          status: "declined",
        }),
      ],
      comparison: [],
    });
    renderPanel();
    await waitFor(() => {
      expect(screen.getByText(/Previous reviews/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/Current review/i)).toBeInTheDocument();
    expect(screen.getByText(/Earlier review/i)).toBeInTheDocument();
  });

  it("places the comparability warning before the premium comparison", async () => {
    const rows: ComparisonRow[] = [
      {
        quote_review_id: "qr_1",
        insurer: "Zurich",
        quote_reference: "Z-1",
        quote_date: null,
        date: null,
        overall_status: "can_proceed",
        total_premium: 12000,
        section_count: 3,
        status_counts: {},
        open_missing_info_count: 0,
        referral_count: 0,
        declined_count: 0,
        manual_review_required: false,
        major_issue_count: 0,
        decision: null,
        decision_reason: null,
        operationally_ready: true,
        cheapest_comparable: true,
        comparability_warning: "Sums insured differ.",
      },
      {
        quote_review_id: "qr_2",
        insurer: "Allianz",
        quote_reference: "A-1",
        quote_date: null,
        date: null,
        overall_status: "can_proceed",
        total_premium: 15000,
        section_count: 4,
        status_counts: {},
        open_missing_info_count: 0,
        referral_count: 0,
        declined_count: 0,
        manual_review_required: false,
        major_issue_count: 0,
        decision: null,
        decision_reason: null,
        operationally_ready: true,
        cheapest_comparable: false,
        comparability_warning: null,
      },
    ];
    getQuoteReviewHistoryMock.mockResolvedValue({
      reviews: [makeQuoteReview({ id: "qr_1" })],
      comparison: rows,
    });
    const { container } = renderPanel();
    await waitFor(() => {
      expect(screen.getByText(/Compare cover before comparing premium/i)).toBeInTheDocument();
    });
    // The warning must appear before the table that shows premium.
    const warning = screen.getByText(/Compare cover before comparing premium/i);
    const table = screen.getByRole("table", { name: /Quote comparison/i });
    const warningIndex = Array.from(container.querySelectorAll("*")).indexOf(warning);
    const tableIndex = Array.from(container.querySelectorAll("*")).indexOf(table);
    expect(warningIndex).toBeLessThan(tableIndex);
    // The lowest-premium footer copy never calls it a recommendation.
    expect(
      screen.getByText(
        /lowest premium is shown as a comparison input only, never as a recommendation/i
      )
    ).toBeInTheDocument();
  });
});

describe("QuoteReviewPanel — read-only interactions do not hit the network", () => {
  it("toggling a rule disclosure does not call the review or decision endpoints", async () => {
    const user = userEvent.setup();
    renderPanel({
      data: workspace({
        quoteSections: [
          section("refer", {
            source_evidence: {
              rule: { source_file_name: "z.pdf", source_page: 1, source_quote: "q" },
            },
          }),
        ],
      }),
    });
    runQuoteReviewMock.mockClear();
    recordDecisionMock.mockClear();
    getQuoteReviewHistoryMock.mockClear();
    await user.click(screen.getByText(/The rule this was checked against/i));
    expect(runQuoteReviewMock).not.toHaveBeenCalled();
    expect(recordDecisionMock).not.toHaveBeenCalled();
    expect(getQuoteReviewHistoryMock).not.toHaveBeenCalled();
  });
});

describe("QuoteReviewPanel — axe", () => {
  it("is axe-clean for a completed review with sections and a fresh decision surface", async () => {
    const { container } = renderPanel({
      data: workspace({ quoteSections: [section("ok"), section("refer")] }),
    });
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
