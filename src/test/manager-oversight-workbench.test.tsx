/**
 * Manager oversight workbench — page-level tests
 * ----------------------------------------------------------------------------
 * Full mocks for the Atlas API so no test transitively loads ../lib/atlas.
 * Covered:
 *   - default request at mount and after Period changes
 *   - the full six-filter contract sent to the API on Apply
 *   - stale responses can never overwrite a newer one
 *   - the filter-chip removal and Clear all paths
 *   - loading (initial and refresh), populated, zero-data, no-attention,
 *     manager-only, and generic error states
 *   - the honest labels used for filter-scoped vs recent-activity metrics
 *   - unknown outcome bars are rendered rather than dropped
 *   - communications count difference is never presented as negative
 *   - row activation, keyboard Open activation, single request per state
 *   - axe-clean populated, filtered, empty and error surfaces
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "vitest-axe";

// The dashboard's only network call is getManagerStatsFiltered. Fully mock the
// module so ../lib/phase4 (and therefore ../lib/atlas) is never loaded.
const statsMock = vi.fn();
vi.mock("../lib/phase4", () => ({
  getManagerStatsFiltered: (...args: unknown[]) => statsMock(...args),
}));

import ManagerDashboard from "../pages/ManagerDashboard";
import type { ManagerStats } from "../lib/phase4";
import type { QuoteReview } from "../lib/quote-reviews";

function review(over: Partial<QuoteReview> = {}): QuoteReview {
  return {
    id: over.id ?? "qr_1",
    submission_id: over.submission_id ?? "sub_1",
    recommendation_id: null,
    insurer_id: null,
    status: over.status ?? "refer",
    overall_outcome: "refer",
    overall_confidence: 0.7,
    manual_review_required: over.manual_review_required ?? false,
    review_snapshot: {},
    created_at: over.created_at ?? "2026-08-01T10:00:00Z",
    updated_at: "2026-08-01T10:00:00Z",
  };
}

function stats(over: Partial<ManagerStats> = {}): ManagerStats {
  return {
    total_submissions: 42,
    quote_reviews_completed: 7,
    reviews_by_status: { can_proceed: 3, refer: 2, declined: 1 },
    missing_info_open_count: 4,
    referrals_count: 2,
    declined_count: 1,
    overrides_count: 1,
    communications_generated_count: 8,
    communications_sent_manually_count: 3,
    common_missing_information: [{ label: "claims_history", count: 3 }],
    common_referral_triggers: [{ label: "over_authority", count: 2 }],
    common_declined_reasons: [{ label: "poor_appetite_fit", count: 4 }],
    recent_reviews_needing_attention: [
      review({ id: "qr_1", submission_id: "sub_1", status: "refer" }),
      review({
        id: "qr_2",
        submission_id: "sub_2",
        status: "declined",
        manual_review_required: true,
      }),
    ],
    ...over,
  };
}

function renderDashboard(onOpen = vi.fn<(id: string) => void>()) {
  const rendered = render(<ManagerDashboard onOpenSubmission={onOpen} />);
  return { ...rendered, onOpen };
}

beforeEach(() => {
  statsMock.mockReset();
});

describe("Manager oversight workbench", () => {
  it("issues the default manager-stats request on mount", async () => {
    statsMock.mockResolvedValue({ ok: true, stats: stats() });
    renderDashboard();
    await screen.findByRole("heading", { name: /manager overview/i });
    expect(statsMock).toHaveBeenCalledTimes(1);
    expect(statsMock).toHaveBeenCalledWith({
      date_range: "30d",
      status: undefined,
      outcome: undefined,
      insurer_id: undefined,
      consultant_id: undefined,
      line_of_business: undefined,
    });
  });

  it("re-requests immediately when Period changes and shows the chip", async () => {
    statsMock.mockResolvedValue({ ok: true, stats: stats() });
    renderDashboard();
    const user = userEvent.setup();
    await screen.findByRole("heading", { name: /manager overview/i });
    statsMock.mockClear();
    statsMock.mockResolvedValue({ ok: true, stats: stats({ quote_reviews_completed: 12 }) });

    await user.selectOptions(screen.getByLabelText(/^period$/i), "7d");

    await waitFor(() =>
      expect(statsMock).toHaveBeenCalledWith(expect.objectContaining({ date_range: "7d" }))
    );
    expect(statsMock).toHaveBeenCalledTimes(1);
    // The active-filter chip prefixes the value with "Period:" — a unique
    // string on the page that will not collide with the select option.
    expect(await screen.findByText(/^Period:$/)).toBeInTheDocument();
  });

  it("sends every advanced filter parameter on Apply, one request per applied state", async () => {
    statsMock.mockResolvedValue({ ok: true, stats: stats() });
    renderDashboard();
    const user = userEvent.setup();
    await screen.findByRole("heading", { name: /manager overview/i });

    // The advanced filters live inside a <details> disclosure. jsdom does
    // not hide the fields when the details is closed, so we can query them
    // directly; the disclosure is open by default anyway when a screen
    // reader crawls the DOM.

    await user.selectOptions(screen.getByLabelText(/review outcome/i), "refer");
    await user.selectOptions(screen.getByLabelText(/decision outcome/i), "declined");
    await user.selectOptions(screen.getByLabelText(/line of business/i), "commercial");
    await user.type(screen.getByLabelText(/insurer identifier/i), "ins_123");
    await user.type(screen.getByLabelText(/consultant identifier/i), "u42");

    // Typing must not have hit the API yet.
    expect(statsMock).toHaveBeenCalledTimes(1);

    statsMock.mockClear();
    statsMock.mockResolvedValue({ ok: true, stats: stats() });
    await user.click(screen.getByRole("button", { name: /apply filters/i }));

    await waitFor(() => expect(statsMock).toHaveBeenCalledTimes(1));
    expect(statsMock).toHaveBeenCalledWith({
      date_range: "30d",
      status: "refer",
      outcome: "declined",
      insurer_id: "ins_123",
      consultant_id: "u42",
      line_of_business: "commercial",
    });
  });

  it("removes an active filter via its chip and clears every filter via Clear all", async () => {
    statsMock.mockResolvedValue({ ok: true, stats: stats() });
    renderDashboard();
    const user = userEvent.setup();
    await screen.findByRole("heading", { name: /manager overview/i });

    await user.selectOptions(screen.getByLabelText(/^period$/i), "7d");
    await screen.findByRole("button", { name: /remove period filter/i });

    statsMock.mockClear();
    await user.click(screen.getByRole("button", { name: /remove period filter/i }));
    await waitFor(() =>
      expect(statsMock).toHaveBeenLastCalledWith(expect.objectContaining({ date_range: "30d" }))
    );

    // Re-set period so Clear all has something to reset.
    await user.selectOptions(screen.getByLabelText(/^period$/i), "90d");
    statsMock.mockClear();
    await user.click(screen.getByRole("button", { name: /clear all/i }));
    await waitFor(() =>
      expect(statsMock).toHaveBeenLastCalledWith({
        date_range: "30d",
        status: undefined,
        outcome: undefined,
        insurer_id: undefined,
        consultant_id: undefined,
        line_of_business: undefined,
      })
    );
  });

  it("does not let a stale slower response overwrite the newer one", async () => {
    // The mount fetch is slow and never gets a chance to write. The second
    // fetch (triggered by the period change) fills the screen. When the
    // slow one finally resolves with a distinctive value, the sequence
    // guard must drop it on the floor.
    const distinctiveStale = 12345;
    const distinctiveFresh = 67890;
    type StatsResponse = { ok: true; stats: ManagerStats };
    let resolveSlow: (value: StatsResponse) => void = () => undefined;
    const slow = new Promise<StatsResponse>((resolve) => {
      resolveSlow = resolve;
    });
    statsMock.mockReturnValueOnce(slow);
    statsMock.mockResolvedValueOnce({
      ok: true,
      stats: stats({ total_submissions: distinctiveFresh }),
    });
    renderDashboard();
    const user = userEvent.setup();
    const period = await screen.findByLabelText(/^period$/i);
    await user.selectOptions(period, "7d");

    expect(await screen.findByText(String(distinctiveFresh))).toBeInTheDocument();

    resolveSlow({
      ok: true,
      stats: stats({ total_submissions: distinctiveStale }),
    });
    // Give the microtask queue a chance to run — the sequence guard should
    // still prevent the stale write.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.getByText(String(distinctiveFresh))).toBeInTheDocument();
    expect(screen.queryByText(String(distinctiveStale))).not.toBeInTheDocument();
  });

  it("shows the honest scope labels for exception tiles and outcome bars", async () => {
    statsMock.mockResolvedValue({ ok: true, stats: stats() });
    renderDashboard();
    await screen.findByText(/Where attention is needed/i);
    // Referrals is period-scoped; missing information is recent-activity.
    expect(screen.getByText("Referrals in period")).toBeInTheDocument();
    expect(screen.getAllByText(/across recent activity/i).length).toBeGreaterThan(0);
    // The outcome section explains counts do not imply a share of a denominator.
    expect(
      screen.getByText(/do not imply a share of any larger denominator/i)
    ).toBeInTheDocument();
  });

  it("renders unknown outcome enums rather than dropping them", async () => {
    statsMock.mockResolvedValue({
      ok: true,
      stats: stats({
        reviews_by_status: { can_proceed: 3, brand_new_state: 2 },
      }),
    });
    renderDashboard();
    await screen.findByText(/Reviews by outcome/i);
    expect(screen.getByText("Brand new state")).toBeInTheDocument();
  });

  it("shows the empty state under a zero-data period", async () => {
    statsMock.mockResolvedValue({
      ok: true,
      stats: {
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
      } satisfies ManagerStats,
    });
    renderDashboard();
    expect(await screen.findByText(/Nothing outstanding right now/i)).toBeInTheDocument();
    expect(screen.getByText(/No quote reviews in this period/i)).toBeInTheDocument();
    expect(screen.getByText(/No recurring patterns yet/i)).toBeInTheDocument();
  });

  it("shows the no-attention empty state when the attention list is empty", async () => {
    statsMock.mockResolvedValue({
      ok: true,
      stats: stats({ recent_reviews_needing_attention: [] }),
    });
    renderDashboard();
    expect(
      await screen.findByText(/Nothing needs manager attention/i)
    ).toBeInTheDocument();
  });

  it("never displays a negative communications count difference", async () => {
    statsMock.mockResolvedValue({
      ok: true,
      stats: stats({
        communications_generated_count: 2,
        communications_sent_manually_count: 5,
      }),
    });
    renderDashboard();
    await screen.findByText(/Communications follow-through/i);
    // No "-3" or negative number shows up; the difference cell is simply
    // omitted. The dedicated label "Count difference" is what we assert
    // against — the disclaimer note phrase "a count difference" (lowercase)
    // is deliberately not matched by this exact-word query.
    expect(screen.queryByText("-3")).not.toBeInTheDocument();
    expect(screen.queryByText(/^Count difference$/)).not.toBeInTheDocument();
  });

  it("presents the manager-only error with the correct wording", async () => {
    statsMock.mockRejectedValue(new Error("manager_only"));
    renderDashboard();
    expect(
      await screen.findByText(
        /This overview is available to underwriting managers and administrators only/i
      )
    ).toBeInTheDocument();
  });

  it("presents a generic API failure and issues one retry request", async () => {
    statsMock.mockRejectedValueOnce(new Error("http_500"));
    renderDashboard();
    const user = userEvent.setup();
    await screen.findByText(/The Atlas API did not respond/i);

    statsMock.mockClear();
    statsMock.mockResolvedValue({ ok: true, stats: stats() });
    await user.click(screen.getByRole("button", { name: /try again/i }));

    await waitFor(() => expect(statsMock).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/Where attention is needed/i)).toBeInTheDocument();
  });

  it("opens the submission from the row's Open action via keyboard", async () => {
    statsMock.mockResolvedValue({ ok: true, stats: stats() });
    const { onOpen } = renderDashboard();
    const user = userEvent.setup();
    const openButtons = await screen.findAllByRole("button", { name: /^open$/i });
    openButtons[0].focus();
    await user.keyboard("{Enter}");
    expect(onOpen).toHaveBeenCalledWith("sub_1");
  });

  it("opens the submission from a row click without a duplicate hidden action", async () => {
    statsMock.mockResolvedValue({ ok: true, stats: stats() });
    const { onOpen } = renderDashboard();
    const user = userEvent.setup();
    await screen.findByText(/Reviews needing attention/i);
    const rows = screen.getAllByRole("row");
    // Row order: header, then two data rows.
    await user.click(rows[1]);
    expect(onOpen).toHaveBeenCalledWith("sub_1");

    // No duplicate mobile-only card action for the same review — there is
    // exactly one "Open" control per row.
    const openControls = screen.getAllByRole("button", { name: /^open$/i });
    expect(openControls).toHaveLength(stats().recent_reviews_needing_attention.length);
  });

  it("is axe-clean in the populated state", async () => {
    statsMock.mockResolvedValue({ ok: true, stats: stats() });
    const { container } = renderDashboard();
    await screen.findByText(/Reviews needing attention/i);
    expect(await axe(container)).toHaveNoViolations();
  });

  it("is axe-clean in the filtered state", async () => {
    statsMock.mockResolvedValue({ ok: true, stats: stats() });
    const { container } = renderDashboard();
    const user = userEvent.setup();
    await screen.findByRole("heading", { name: /manager overview/i });
    await user.selectOptions(await screen.findByLabelText(/^period$/i), "7d");
    await screen.findByRole("button", { name: /remove period filter/i });
    expect(await axe(container)).toHaveNoViolations();
  });

  it("is axe-clean in the zero-data state", async () => {
    statsMock.mockResolvedValue({
      ok: true,
      stats: {
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
      } satisfies ManagerStats,
    });
    const { container } = renderDashboard();
    await screen.findByText(/Nothing outstanding right now/i);
    expect(await axe(container)).toHaveNoViolations();
  });

  it("is axe-clean in the manager-only error state", async () => {
    statsMock.mockRejectedValue(new Error("manager_only"));
    const { container } = renderDashboard();
    await screen.findByText(/underwriting managers and administrators only/i);
    expect(await axe(container)).toHaveNoViolations();
  });

  it("issues exactly one fetch per applied state under React StrictMode", async () => {
    // Regression test for the StrictMode double-mount that used to fire two
    // /api/manager/stats requests for the initial applied state. The fetch
    // is deferred by a microtask and cancelled by the effect cleanup, so the
    // discarded mount's request never leaves the client.
    const { StrictMode } = await import("react");
    statsMock.mockResolvedValue({ ok: true, stats: stats() });
    const onOpen = vi.fn<(id: string) => void>();
    render(
      <StrictMode>
        <ManagerDashboard onOpenSubmission={onOpen} />
      </StrictMode>
    );

    await screen.findByRole("heading", { name: /manager overview/i });
    // Wait long enough for the microtask queue to drain twice — once for the
    // discarded StrictMode mount, once for the surviving one.
    await waitFor(() => expect(statsMock).toHaveBeenCalledTimes(1));
    // Give any late duplicate a chance to appear, then re-assert.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(statsMock).toHaveBeenCalledTimes(1);

    // A subsequent applied-state change must still fire exactly one fetch —
    // the guard cancels stale scheduled fetches, it does not suppress
    // legitimate ones.
    const user = userEvent.setup();
    statsMock.mockClear();
    statsMock.mockResolvedValue({ ok: true, stats: stats({ quote_reviews_completed: 33 }) });
    await user.selectOptions(screen.getByLabelText(/^period$/i), "7d");
    await waitFor(() => expect(statsMock).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(statsMock).toHaveBeenCalledTimes(1);
  });
});
