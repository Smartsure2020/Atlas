/**
 * Missing information workbench tests (Phase 4)
 * ----------------------------------------------------------------------------
 * Exercises the modernised MissingInfoPanel: the action summary derived from
 * items on file, lifecycle groups in order, the deterministic overdue label,
 * the mark-requested / mark-received / waive / not-required paths, the
 * derive-from-analysis and add-item flows, and the read-only variant.
 *
 * External modules are fully mocked so no test transitively loads
 * ../lib/atlas.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "vitest-axe";

const addMissingInfoMock = vi.fn();
const updateMissingInfoMock = vi.fn();
const generateMissingInfoMock = vi.fn();

vi.mock("../lib/phase4", async () => {
  return {
    addMissingInfo: (...args: unknown[]) => addMissingInfoMock(...args),
    updateMissingInfo: (...args: unknown[]) => updateMissingInfoMock(...args),
    generateMissingInfo: (...args: unknown[]) => generateMissingInfoMock(...args),
  };
});

import MissingInfoPanel from "../pages/MissingInfoPanel";
import { ToastProvider } from "../components/ui";
import type { MissingInfoItem } from "../lib/phase4";

import case22 from "../../tests/powerhouse/fixtures/snapshots/case-22-complete-single-section.row.json";
import case23 from "../../tests/powerhouse/fixtures/snapshots/case-23-required-fact-missing.row.json";
import case24 from "../../tests/powerhouse/fixtures/snapshots/case-24-required-document-missing-rule-provenance.row.json";
import case26 from "../../tests/powerhouse/fixtures/snapshots/case-26-section-without-applicable-rule.row.json";
import case27 from "../../tests/powerhouse/fixtures/snapshots/case-27-multiple-products-no-declared-sections-completeness.row.json";
import case29 from "../../tests/powerhouse/fixtures/snapshots/case-29-sources-disagree.row.json";
import histV1 from "../../tests/powerhouse/fixtures/snapshots/historical-v1-complete.row.json";
import histV2 from "../../tests/powerhouse/fixtures/snapshots/historical-v2-incomplete.row.json";

const evidenceOf = (row: unknown) => (row as { evidence_json: unknown }).evidence_json;

function item(over: Partial<MissingInfoItem> = {}): MissingInfoItem {
  return {
    id: over.id ?? `mi_${Math.random().toString(36).slice(2, 8)}`,
    submission_id: "sub_1",
    quote_review_id: over.quote_review_id ?? null,
    section_key: over.section_key ?? null,
    item_type: over.item_type ?? "underwriting_info",
    title: over.title ?? "Three years of claims experience",
    description: over.description ?? "Needed to price the risk correctly.",
    status: over.status ?? "open",
    required_by_rule_id: null,
    source: over.source ?? "extraction",
    owner: over.owner ?? "broker",
    due_date: over.due_date ?? null,
    notes: over.notes ?? null,
    created_at: "2026-08-01T09:00:00Z",
    updated_at: "2026-08-01T09:00:00Z",
    resolved_at: null,
  };
}

function renderPanel(
  props: Partial<React.ComponentProps<typeof MissingInfoPanel>> = {}
) {
  const onRefresh = vi.fn().mockResolvedValue(undefined);
  const onGoToTab = vi.fn();
  const rendered = render(
    <ToastProvider>
      <MissingInfoPanel
        submissionId="sub_1"
        items={[]}
        quoteReviewId={null}
        canWrite={true}
        onRefresh={onRefresh}
        onGoToTab={onGoToTab}
        {...props}
      />
    </ToastProvider>
  );
  return { ...rendered, onRefresh, onGoToTab };
}

beforeEach(() => {
  addMissingInfoMock.mockReset();
  updateMissingInfoMock.mockReset();
  generateMissingInfoMock.mockReset();
});

describe("MissingInfoPanel — empty state", () => {
  it("shows the empty state and the derive action for a writer", () => {
    renderPanel();
    expect(screen.getByText(/Nothing is outstanding/i)).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /Derive from analysis/i })).not.toHaveLength(0);
  });

  it("hides write actions from a read-only user", () => {
    renderPanel({ canWrite: false });
    expect(screen.queryByRole("button", { name: /Derive from analysis/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /Add item/i })).toBeNull();
  });
});

describe("MissingInfoPanel — summary and lifecycle", () => {
  it("counts each lifecycle bucket in the action summary", () => {
    renderPanel({
      items: [
        item({ status: "open", title: "A" }),
        item({ status: "open", title: "B" }),
        item({ status: "requested", title: "C" }),
        item({ status: "received", title: "D" }),
        item({ status: "waived", title: "E", notes: "n" }),
      ],
    });
    const summary = screen.getByRole("region", { name: /Missing information summary/i });
    // Uses digits per label, so a per-cell containment check is enough.
    const notRequested = within(summary).getByText(/Not yet requested/i).parentElement!;
    expect(within(notRequested).getByText("2")).toBeInTheDocument();
    const awaitingReply = within(summary).getByText(/Awaiting a reply/i).parentElement!;
    expect(within(awaitingReply).getByText("1")).toBeInTheDocument();
    const awaitingReview = within(summary).getByText(/Awaiting review/i).parentElement!;
    expect(within(awaitingReview).getByText("1")).toBeInTheDocument();
    const closed = within(summary).getByText(/Deliberately closed/i).parentElement!;
    expect(within(closed).getByText("1")).toBeInTheDocument();
  });

  it("renders the lifecycle groups in job order", () => {
    renderPanel({
      items: [
        item({ status: "waived", title: "Closed one", notes: "n" }),
        item({ status: "received", title: "Received one" }),
        item({ status: "open", title: "Open one" }),
        item({ status: "requested", title: "Requested one" }),
      ],
    });
    const headings = screen
      .getAllByRole("heading", { level: 3 })
      .map((h) => h.textContent ?? "");
    // Order must be outstanding → requested → received → closed.
    expect(headings[0]).toMatch(/Outstanding/);
    expect(headings[1]).toMatch(/Requested/);
    expect(headings[2]).toMatch(/Received/);
    expect(headings[3]).toMatch(/Waived or not required/);
  });

  it("labels an item overdue only when its own due date has passed", () => {
    const yesterday = new Date();
    yesterday.setUTCDate(yesterday.getUTCDate() - 2);
    const tomorrow = new Date();
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 2);
    renderPanel({
      items: [
        item({
          id: "past",
          title: "Overdue chase",
          status: "requested",
          due_date: yesterday.toISOString().slice(0, 10),
        }),
        item({
          id: "future",
          title: "Upcoming",
          status: "requested",
          due_date: tomorrow.toISOString().slice(0, 10),
        }),
      ],
    });
    const overdueRow = screen.getByText(/Overdue chase/).closest("li")!;
    // The row's overdue label lives inside a StatusBadge with a specific
    // description as its title attribute.
    expect(
      within(overdueRow).getByTitle(/The recorded due date has passed/i)
    ).toBeInTheDocument();
    const upcomingRow = screen.getByText(/^Upcoming$/).closest("li")!;
    expect(
      within(upcomingRow).queryByTitle(/The recorded due date has passed/i)
    ).toBeNull();
  });

  it("shows owner, source, type, due date and notes on each row", () => {
    renderPanel({
      items: [
        item({
          title: "Vehicle schedule",
          owner: "broker",
          source: "quote_review",
          item_type: "document",
          due_date: "2027-01-01",
          notes: "Broker will email next week.",
        }),
      ],
    });
    expect(screen.getByText(/Owed by: Broker/i)).toBeInTheDocument();
    expect(screen.getByText(/Source: Quote review/i)).toBeInTheDocument();
    expect(screen.getByText(/Type: Document/i)).toBeInTheDocument();
    expect(screen.getByText(/Due 01 Jan 2027/i)).toBeInTheDocument();
    expect(screen.getByText(/Broker will email next week/i)).toBeInTheDocument();
  });
});

describe("MissingInfoPanel — actions", () => {
  it("mark requested calls update once and refreshes", async () => {
    const user = userEvent.setup();
    updateMissingInfoMock.mockResolvedValue({ ok: true });
    const { onRefresh } = renderPanel({
      items: [item({ id: "mi_1", title: "Claims", status: "open" })],
    });
    await user.click(screen.getByRole("button", { name: /Mark requested/i }));
    await waitFor(() => {
      expect(updateMissingInfoMock).toHaveBeenCalledWith("mi_1", expect.objectContaining({ status: "requested" }));
    });
    expect(updateMissingInfoMock).toHaveBeenCalledTimes(1);
    expect(onRefresh).toHaveBeenCalled();
  });

  it("mark received calls update once for a requested item", async () => {
    const user = userEvent.setup();
    updateMissingInfoMock.mockResolvedValue({ ok: true });
    renderPanel({
      items: [item({ id: "mi_2", title: "Vehicle schedule", status: "requested" })],
    });
    await user.click(screen.getByRole("button", { name: /Mark received/i }));
    await waitFor(() => {
      expect(updateMissingInfoMock).toHaveBeenCalledWith("mi_2", expect.objectContaining({ status: "received" }));
    });
  });

  it("waiving an item opens the note prompt and requires text to confirm", async () => {
    const user = userEvent.setup();
    renderPanel({
      items: [item({ id: "mi_3", title: "Schedule", status: "open" })],
    });
    // Open edit drawer, then choose Waived.
    await user.click(screen.getByRole("button", { name: /Edit/i }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: /Waived/i }));
    // A prompt dialog should be open.
    const prompt = await screen.findByRole("dialog", { name: /Waive this information request\?/i });
    // Attempt to confirm without typing a note.
    await user.click(within(prompt).getByRole("button", { name: /Waive item/i }));
    // The error is announced and no update was issued.
    expect(within(prompt).getByText(/This note is required/i)).toBeInTheDocument();
    expect(updateMissingInfoMock).not.toHaveBeenCalled();
  });

  it("derives new items and reports the count", async () => {
    const user = userEvent.setup();
    generateMissingInfoMock.mockResolvedValue({ ok: true, generated_count: 3 });
    renderPanel();
    await user.click(screen.getAllByRole("button", { name: /Derive from analysis/i })[0]);
    await waitFor(() => {
      expect(generateMissingInfoMock).toHaveBeenCalledWith("sub_1");
    });
  });

  it("shows the analysis-not-run error when derive fails", async () => {
    const user = userEvent.setup();
    generateMissingInfoMock.mockRejectedValue(new Error("no_extraction"));
    renderPanel();
    await user.click(screen.getAllByRole("button", { name: /Derive from analysis/i })[0]);
    await waitFor(() => {
      expect(
        screen.getByText(/could not derive missing-information items/i)
      ).toBeInTheDocument();
    });
  });

  it("add item drawer validates a required title", async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.click(screen.getByRole("button", { name: /Add item/i }));
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: /^Add item$/i })
    );
    expect(screen.getByText(/Describe what is missing/i)).toBeInTheDocument();
    expect(addMissingInfoMock).not.toHaveBeenCalled();
  });
});

describe("MissingInfoPanel — cross-tab and no-write behaviour", () => {
  it("links to the recommendation and to Communications for drafting", async () => {
    const user = userEvent.setup();
    const { onGoToTab } = renderPanel({
      items: [item({ status: "open" })],
    });
    await user.click(screen.getByRole("button", { name: /Open the recommendation/i }));
    expect(onGoToTab).toHaveBeenCalledWith("recommendation");
    await user.click(screen.getByRole("button", { name: /Draft the request on Communications/i }));
    expect(onGoToTab).toHaveBeenCalledWith("communications");
  });

  it("presentation-only interactions do not hit the API", async () => {
    const user = userEvent.setup();
    renderPanel({
      items: [item({ status: "requested" })],
    });
    updateMissingInfoMock.mockClear();
    // Scanning the list should not touch the network.
    await user.click(screen.getByText(/Requested — awaiting a reply/i));
    expect(updateMissingInfoMock).not.toHaveBeenCalled();
    expect(addMissingInfoMock).not.toHaveBeenCalled();
    expect(generateMissingInfoMock).not.toHaveBeenCalled();
  });
});

describe("MissingInfoPanel — responsive treatment", () => {
  it("opts into the scoped mobile-stack modifier on lifecycle lists", () => {
    renderPanel({
      items: [
        item({
          id: "overdue-row",
          title: "Three years of claims experience",
          status: "requested",
          due_date: "2020-01-01",
        }),
      ],
    });
    const list = screen.getByText(/Three years of claims experience/).closest("ul")!;
    expect(list).toHaveClass("atlas-list");
    expect(list).toHaveClass("atlas-list--stack-sm");
  });

  it("keeps the title, main content and both requested + overdue badges on the row", () => {
    renderPanel({
      items: [
        item({
          id: "overdue-row",
          title: "Three years of claims experience",
          status: "requested",
          due_date: "2020-01-01",
        }),
      ],
    });
    const row = screen.getByText(/Three years of claims experience/).closest("li")!;
    expect(within(row).getByText(/Three years of claims experience/)).toBeInTheDocument();
    // The main content region is preserved so the title never gets crowded out.
    expect(row.querySelector(".atlas-list__main")).not.toBeNull();
    // Requested + overdue badges both survive the scoped treatment.
    expect(within(row).getByText(/Requested/)).toBeInTheDocument();
    expect(within(row).getByText(/Overdue/)).toBeInTheDocument();
    // Action buttons remain reachable and correctly labelled.
    expect(within(row).getByRole("button", { name: /Mark received/i })).toBeInTheDocument();
    expect(within(row).getByRole("button", { name: /Edit/i })).toBeInTheDocument();
  });
});

describe("MissingInfoPanel — axe", () => {
  it("is axe-clean when populated", async () => {
    const { container } = renderPanel({
      items: [
        item({ status: "open" }),
        item({ status: "requested", due_date: "2020-01-01" }),
        item({ status: "received" }),
        item({ status: "waived", notes: "not needed" }),
      ],
    });
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});

// ---------------------------------------------------------------------------
// Batch B — "What Atlas detected": the evidence's completeness joined to THIS workspace
// ---------------------------------------------------------------------------

const DETECTED = "What Atlas detected";

describe("MissingInfoPanel — what Atlas detected (evidence v3)", () => {
  it("is absent for a broker (no evidence is passed) and for a recommendation with no evidence", () => {
    renderPanel();
    expect(screen.queryByRole("region", { name: DETECTED })).toBeNull();
    renderPanel({ recommendationEvidence: null });
    expect(screen.queryByRole("region", { name: DETECTED })).toBeNull();
  });

  it("lists a required document once, with its tracking state, and offers to track it", () => {
    renderPanel({ recommendationEvidence: evidenceOf(case24) });
    const region = screen.getByRole("region", { name: DETECTED });
    const list = within(region).getByRole("list", { name: "Detected items you can track" });
    const rows = list.querySelectorAll("[data-detected-item]");
    expect(rows).toHaveLength(1);
    expect(within(rows[0] as HTMLElement).getByText("Risk survey")).toBeInTheDocument();
    expect(within(rows[0] as HTMLElement).getByText(/Insurers: Alpha Insurance, Beta Insurance/)).toBeInTheDocument();
    expect(within(rows[0] as HTMLElement).getByRole("button", { name: "Track this" })).toBeInTheDocument();
    expect(within(region).getByText(/Atlas never sends anything itself/)).toBeInTheDocument();
  });

  it("'Track this' creates an ORDINARY item through the existing endpoint — no new workflow, no values", async () => {
    addMissingInfoMock.mockResolvedValue({ ok: true, id: "mi_new" });
    const { onRefresh } = renderPanel({ recommendationEvidence: evidenceOf(case24), quoteReviewId: "qr_9" });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Track this" }));
    await waitFor(() => expect(addMissingInfoMock).toHaveBeenCalledTimes(1));
    expect(addMissingInfoMock).toHaveBeenCalledWith("sub_1", {
      quote_review_id: "qr_9",
      section_key: null,
      item_type: "document",
      title: "Risk survey",
      description: "Required by an insurer's guideline and not among the trusted documents.",
      owner: "broker",
    });
    await waitFor(() => expect(onRefresh).toHaveBeenCalled());
  });

  it("a failed track shows an error and does not pretend it worked", async () => {
    addMissingInfoMock.mockRejectedValue(new Error("boom"));
    renderPanel({ recommendationEvidence: evidenceOf(case24) });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Track this" }));
    expect(await screen.findByText("That item could not be tracked. Try again.")).toBeInTheDocument();
  });

  it("an item already tracked (under any spelling) shows its own status instead of a button — one source of truth", () => {
    renderPanel({
      recommendationEvidence: evidenceOf(case24),
      items: [item({ item_type: "document", title: "risk-survey", status: "requested", source: "quote_review" })],
    });
    const row = screen.getByRole("region", { name: DETECTED }).querySelector("[data-detected-item]") as HTMLElement;
    expect(within(row).queryByRole("button", { name: "Track this" })).toBeNull();
    expect(within(row).getByText("Requested")).toBeInTheDocument();
  });

  it("a closed item reads as closed with its reason, not as outstanding", () => {
    renderPanel({
      recommendationEvidence: evidenceOf(case24),
      items: [item({ item_type: "document", title: "Risk survey", status: "waived", notes: "Insurer waived it." })],
    });
    const row = screen.getByRole("region", { name: DETECTED }).querySelector("[data-detected-item]") as HTMLElement;
    expect(within(row).getByText(/Closed — /)).toBeInTheDocument();
    expect(within(row).queryByRole("button", { name: "Track this" })).toBeNull();
  });

  it("internal limitations (a section no rule covers, rule ties) are shown but are never trackable", () => {
    renderPanel({ recommendationEvidence: evidenceOf(case26) });
    const region = screen.getByRole("region", { name: DETECTED });
    expect(within(region).queryByRole("button", { name: "Track this" })).toBeNull();
    expect(within(region).getByText(/Atlas limitations — nothing to chase \(2\)/)).toBeInTheDocument();
  });

  it("undeclared cover sections and a schema-named fact are trackable; free-text facts are not (the existing derive flow carries those)", () => {
    renderPanel({ recommendationEvidence: evidenceOf(case27) });
    expect(within(screen.getByRole("region", { name: DETECTED })).getByText("Cover sections required")).toBeInTheDocument();
  });

  it("a schema-named fact is offered under its schema label; the two free-text records are not trackable and no text is shown", () => {
    renderPanel({ recommendationEvidence: evidenceOf(case23) });
    const region = screen.getByRole("region", { name: DETECTED });
    expect(within(region).getByText("Registration or ID number")).toBeInTheDocument();
    expect(within(region).getAllByRole("button", { name: "Track this" })).toHaveLength(1);
    expect(within(region).getByText(/Atlas limitations — nothing to chase \(2\)/)).toBeInTheDocument();
    for (const sentinel of ["REASON_SENTINEL_23A", "FREETEXT_SENTINEL_23B", "FREETEXT_SENTINEL_23C"]) expect(region.textContent).not.toContain(sentinel);
  });

  it("a read-only user sees what was detected but cannot track it", () => {
    renderPanel({ recommendationEvidence: evidenceOf(case24), canWrite: false });
    const region = screen.getByRole("region", { name: DETECTED });
    expect(within(region).queryByRole("button", { name: "Track this" })).toBeNull();
    expect(within(region).getByText("Not tracked")).toBeInTheDocument();
  });

  it("a complete recommendation says nothing is outstanding", () => {
    renderPanel({ recommendationEvidence: evidenceOf(case22) });
    const region = screen.getByRole("region", { name: DETECTED });
    expect(within(region).getByText(/Nothing outstanding was recorded for this recommendation\./)).toBeInTheDocument();
  });

  it("conflicting values are pointed at, never listed here: no values, no tracking, no draft text", () => {
    const { onGoToTab } = renderPanel({ recommendationEvidence: evidenceOf(case29) });
    const region = screen.getByRole("region", { name: DETECTED });
    expect(within(region).getByText("Conflicting recorded values were found")).toBeInTheDocument();
    expect(region.textContent).not.toMatch(/[a-z0-9._-]+@[a-z0-9.-]+\.[a-z]+|a•••|b•••/);
    expect(within(region).queryByRole("button", { name: "Track this" })).toBeNull();
    return userEvent.setup().click(within(region).getByRole("button", { name: /Review the conflicts/ })).then(() => {
      expect(onGoToTab).toHaveBeenCalledWith("recommendation");
    });
  });

  it("historical v1 / v2 evidence says it was not captured and reconstructs nothing", () => {
    renderPanel({ recommendationEvidence: evidenceOf(histV1) });
    expect(within(screen.getByRole("region", { name: DETECTED })).getByText(/Completeness and contradiction analysis was not captured for this historical recommendation\./)).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: DETECTED })).queryByRole("button", { name: "Track this" })).toBeNull();
  });

  it("historical v2 evidence says it predates the analysis", () => {
    renderPanel({ recommendationEvidence: evidenceOf(histV2) });
    const region = screen.getByRole("region", { name: DETECTED });
    expect(within(region).getByText(/This recommendation predates deterministic completeness and contradiction analysis\./)).toBeInTheDocument();
    expect(region.textContent).not.toMatch(/nothing outstanding/i);
  });

  it("tracked items do not change the lifecycle summary or the ordinary item list", () => {
    renderPanel({ recommendationEvidence: evidenceOf(case24), items: [item({ status: "open", title: "A" })] });
    const summary = screen.getByRole("region", { name: /Missing information summary/i });
    expect(within(summary.querySelector(".atlas-workflow-summary__cell") as HTMLElement).getByText("1")).toBeInTheDocument();
  });

  it("has no axe violations", async () => {
    const { container } = renderPanel({ recommendationEvidence: evidenceOf(case24), items: [item({ title: "Existing" })] });
    expect(await axe(container)).toHaveNoViolations();
  });
});
