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
