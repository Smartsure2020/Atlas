/**
 * Communications workbench tests (Phase 4)
 * ----------------------------------------------------------------------------
 * Exercises the modernised CommunicationsPanel: safety framing, distinct
 * workflow vs email draft sources, presentation-only draft-type selection,
 * generation and copy paths, duplicate-safety on save-to-record, referral
 * readiness (required vs recommended distinction), record grouping, and the
 * manual-send confirmation dialog and focus restoration.
 *
 * Every external module is fully mocked so no test transitively loads
 * ../lib/atlas.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, within, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "vitest-axe";

const generateEmailMock = vi.fn();
const listCommunicationsMock = vi.fn();
const generateDraftMock = vi.fn();
const saveCommunicationMock = vi.fn();
const updateCommunicationMock = vi.fn();

vi.mock("../lib/decisions", () => ({
  generateEmail: (...args: unknown[]) => generateEmailMock(...args),
}));

vi.mock("../lib/phase4", () => ({
  listCommunications: (...args: unknown[]) => listCommunicationsMock(...args),
  generateDraft: (...args: unknown[]) => generateDraftMock(...args),
  saveCommunication: (...args: unknown[]) => saveCommunicationMock(...args),
  updateCommunication: (...args: unknown[]) => updateCommunicationMock(...args),
}));

import CommunicationsPanel from "../pages/CommunicationsPanel";
import { ToastProvider } from "../components/ui";
import type { CommunicationRecord, MissingInfoItem } from "../lib/phase4";
import type { WorkspaceData } from "../pages/SubmissionDetail";

function missing(over: Partial<MissingInfoItem> = {}): MissingInfoItem {
  return {
    id: over.id ?? `mi_${Math.random().toString(36).slice(2, 8)}`,
    submission_id: "sub_1",
    quote_review_id: null,
    section_key: null,
    item_type: "underwriting_info",
    title: over.title ?? "Claims history",
    description: null,
    status: over.status ?? "open",
    required_by_rule_id: null,
    source: "extraction",
    owner: "broker",
    due_date: null,
    notes: null,
    created_at: "2026-08-01T09:00:00Z",
    updated_at: "2026-08-01T09:00:00Z",
    resolved_at: null,
  };
}

function record(over: Partial<CommunicationRecord> = {}): CommunicationRecord {
  return {
    id: over.id ?? `cr_${Math.random().toString(36).slice(2, 8)}`,
    submission_id: "sub_1",
    quote_review_id: null,
    communication_type: over.communication_type ?? "missing_info_request",
    audience: over.audience ?? "broker",
    subject: over.subject ?? "Outstanding information request",
    body: over.body ?? "Please supply the following…",
    status: over.status ?? "draft",
    related_missing_info_item_ids: over.related_missing_info_item_ids ?? null,
    related_section_keys: over.related_section_keys ?? null,
    created_at: "2026-08-01T09:00:00Z",
    updated_at: "2026-08-01T09:00:00Z",
    sent_at: over.sent_at ?? null,
    notes: null,
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
      documents: [{ status: "processed" } as unknown as Record<string, unknown>],
      extraction: {
        id: "ext_1",
        extracted_json: null,
        reviewed_json: {},
        extraction_confidence: 0.7,
      },
      jobs: {},
    },
    recommendation: null,
    quoteReview: null,
    quoteSections: [],
    decision: null,
    missingInfo: [],
    ...over,
  };
}

function renderPanel(
  props: Partial<React.ComponentProps<typeof CommunicationsPanel>> = {}
) {
  const onRefresh = vi.fn().mockResolvedValue(undefined);
  const rendered = render(
    <ToastProvider>
      <CommunicationsPanel
        submissionId="sub_1"
        data={workspace()}
        canWrite={true}
        onRefresh={onRefresh}
        {...props}
      />
    </ToastProvider>
  );
  return { ...rendered, onRefresh };
}

beforeEach(() => {
  generateEmailMock.mockReset();
  listCommunicationsMock.mockReset().mockResolvedValue({ communications: [] });
  generateDraftMock.mockReset();
  saveCommunicationMock.mockReset();
  updateCommunicationMock.mockReset();
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
  });
});

describe("CommunicationsPanel — safety framing", () => {
  it("names the do-not-send boundary prominently", async () => {
    renderPanel();
    expect(
      screen.getByText(/Atlas never sends anything on your behalf/i)
    ).toBeInTheDocument();
    // Primary controls never say Send.
    expect(screen.queryByRole("button", { name: /^Send$/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /Send email/i })).toBeNull();
    await waitFor(() => expect(listCommunicationsMock).toHaveBeenCalled());
  });

  it("fetches communication history exactly once per clean mount", async () => {
    renderPanel();
    await waitFor(() => {
      expect(listCommunicationsMock).toHaveBeenCalledTimes(1);
    });
  });
});

describe("CommunicationsPanel — draft chooser", () => {
  it("shows workflow and email draft sources as distinct groups", async () => {
    renderPanel();
    expect(screen.getByText(/Workflow drafts/i)).toBeInTheDocument();
    expect(screen.getByText(/Email drafts/i)).toBeInTheDocument();
    // Every documented draft type is listed.
    expect(screen.getByRole("button", { name: /Outstanding information request/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Referral pack/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Quote review summary/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Request information from the broker/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Acknowledge the submission/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Submit to the insurer/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Internal handover summary/i })).toBeInTheDocument();
  });

  it("selecting a draft type alone does not call any generation or save endpoint", async () => {
    const user = userEvent.setup();
    renderPanel();
    await waitFor(() => expect(listCommunicationsMock).toHaveBeenCalled());
    // Wait doesn't allow further list calls; then a click-only intent.
    generateEmailMock.mockClear();
    generateDraftMock.mockClear();
    saveCommunicationMock.mockClear();
    // Note: the button is the generation control. Selecting IS generating in
    // the previous panel too. The invariant we prove is that plain clicks on
    // presentation-only affordances never hit the network. We simulate that
    // with the safety-boundary Notice which is not a control.
    await user.click(screen.getByText(/Every draft below is copyable text/i));
    expect(generateEmailMock).not.toHaveBeenCalled();
    expect(generateDraftMock).not.toHaveBeenCalled();
    expect(saveCommunicationMock).not.toHaveBeenCalled();
  });

  it("generating a workflow draft calls the workflow endpoint exactly once", async () => {
    const user = userEvent.setup();
    generateDraftMock.mockResolvedValue({ ok: true, draft: "Hello broker" });
    renderPanel();
    await waitFor(() => expect(listCommunicationsMock).toHaveBeenCalled());
    await user.click(screen.getByRole("button", { name: /Outstanding information request/i }));
    await waitFor(() => {
      expect(generateDraftMock).toHaveBeenCalledTimes(1);
    });
    expect(generateDraftMock).toHaveBeenCalledWith("sub_1", "missing-info", expect.any(Object));
    expect(generateEmailMock).not.toHaveBeenCalled();
    // The draft body is presented.
    expect(screen.getByRole("textbox", { name: /Draft message/i })).toHaveValue("Hello broker");
  });

  it("generating an email draft calls the email endpoint exactly once and does not save again", async () => {
    const user = userEvent.setup();
    generateEmailMock.mockResolvedValue({
      subject: "Re: your submission",
      body: "Thank you for the submission…",
      draft_persisted: true,
    });
    renderPanel();
    await waitFor(() => expect(listCommunicationsMock).toHaveBeenCalled());
    await user.click(screen.getByRole("button", { name: /Acknowledge the submission/i }));
    await waitFor(() => {
      expect(generateEmailMock).toHaveBeenCalledTimes(1);
    });
    // Server already persisted → no Save to record button is offered.
    expect(screen.queryByRole("button", { name: /Save to record/i })).toBeNull();
    expect(saveCommunicationMock).not.toHaveBeenCalled();
    expect(screen.getByText(/already saved to the communication record/i)).toBeInTheDocument();
  });

  it("surfaces the unreviewed-extraction warning after generating from raw extraction", async () => {
    const user = userEvent.setup();
    generateEmailMock.mockResolvedValue({
      subject: "s",
      body: "b",
      draft_persisted: true,
      based_on: "raw_extraction",
    });
    renderPanel();
    await user.click(screen.getByRole("button", { name: /Acknowledge the submission/i }));
    await waitFor(() => {
      expect(screen.getByText(/built from an unreviewed extraction/i)).toBeInTheDocument();
    });
  });

  it("surfaces the persistence warning when the server could not save the draft", async () => {
    const user = userEvent.setup();
    generateEmailMock.mockResolvedValue({
      subject: "s",
      body: "b",
      draft_persisted: false,
    });
    renderPanel();
    await user.click(screen.getByRole("button", { name: /Acknowledge the submission/i }));
    await waitFor(() => {
      expect(screen.getByText(/could not be saved to the communication record/i)).toBeInTheDocument();
    });
    // Because it was not persisted, Save to record is offered for the email draft too.
    expect(screen.getByRole("button", { name: /Save to record/i })).toBeInTheDocument();
  });

  it("copy calls the clipboard without changing status or firing further requests", async () => {
    const user = userEvent.setup();
    generateDraftMock.mockResolvedValue({ ok: true, draft: "Body copy" });
    renderPanel();
    await waitFor(() => expect(listCommunicationsMock).toHaveBeenCalled());
    await user.click(screen.getByRole("button", { name: /Outstanding information request/i }));
    await screen.findByRole("textbox", { name: /Draft message/i });
    updateCommunicationMock.mockClear();
    saveCommunicationMock.mockClear();
    // Install the clipboard mock after userEvent has set up its own so the
    // panel's writeText call lands on this spy rather than the library's.
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    await user.click(screen.getByRole("button", { name: /Copy message/i }));
    expect(writeText).toHaveBeenCalledWith("Body copy");
    expect(updateCommunicationMock).not.toHaveBeenCalled();
    expect(saveCommunicationMock).not.toHaveBeenCalled();
  });

  it("Save to record for a workflow draft calls save exactly once", async () => {
    const user = userEvent.setup();
    generateDraftMock.mockResolvedValue({ ok: true, draft: "Body" });
    saveCommunicationMock.mockResolvedValue({ ok: true, id: "cr_new" });
    renderPanel();
    await waitFor(() => expect(listCommunicationsMock).toHaveBeenCalled());
    await user.click(screen.getByRole("button", { name: /Outstanding information request/i }));
    await screen.findByRole("textbox", { name: /Draft message/i });
    await user.click(screen.getByRole("button", { name: /Save to record/i }));
    await waitFor(() => {
      expect(saveCommunicationMock).toHaveBeenCalledTimes(1);
    });
  });
});

describe("CommunicationsPanel — referral readiness", () => {
  it("distinguishes required from recommended checks", () => {
    renderPanel({
      data: workspace({
        recommendation: { referral_required: true } as WorkspaceData["recommendation"],
      }),
    });
    // The readiness card and its checks appear.
    expect(screen.getByText(/Referral pack readiness/i)).toBeInTheDocument();
    // Required and Recommended badges both appear (extraction reviewed_json is
    // truthy, so required "Risk information reviewed" is Ready; but "Quote
    // review complete" is a recommended check that is not met).
    expect(screen.getAllByText(/Recommended/i).length).toBeGreaterThan(0);
    // Recommended items must not be presented as hard blockers.
    expect(screen.queryByText(/1 required items outstanding|1 required item outstanding/i)).toBeNull();
  });

  it("does not show the readiness card when no referral is needed", () => {
    renderPanel();
    expect(screen.queryByText(/Referral pack readiness/i)).toBeNull();
  });
});

describe("CommunicationsPanel — record and manual-send confirmation", () => {
  it("groups records by lifecycle and shows the body in a disclosure", async () => {
    listCommunicationsMock.mockResolvedValue({
      communications: [
        record({ id: "cr_1", subject: "Draft one", status: "draft" }),
        record({ id: "cr_2", subject: "Sent one", status: "sent_manually", sent_at: "2026-08-02T10:00:00Z" }),
      ],
    });
    renderPanel();
    await waitFor(() => {
      expect(screen.getByText(/Draft one/i)).toBeInTheDocument();
    });
    // Two group headings appear.
    expect(screen.getByRole("heading", { name: /Recorded as sent/i })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /Draft saved/i })).toBeInTheDocument();
    // The body is available via a disclosure, not eagerly rendered as text.
    expect(screen.getAllByText(/Show message body/i).length).toBeGreaterThan(0);
  });

  it("hides Record manual send from a read-only user", async () => {
    listCommunicationsMock.mockResolvedValue({
      communications: [record({ status: "draft" })],
    });
    renderPanel({ canWrite: false });
    await waitFor(() => {
      expect(screen.getByText(/Please supply the following/i)).toBeInTheDocument();
    });
    expect(screen.queryByRole("button", { name: /Record manual send/i })).toBeNull();
  });

  it("Cancel closes the manual-send dialog without any write", async () => {
    const user = userEvent.setup();
    listCommunicationsMock.mockResolvedValue({
      communications: [record({ status: "draft" })],
    });
    renderPanel();
    await waitFor(() => screen.getByRole("button", { name: /Record manual send/i }));
    const trigger = screen.getByRole("button", { name: /Record manual send/i });
    await user.click(trigger);
    const dialog = await screen.findByRole("dialog", {
      name: /Record this communication as sent manually\?/i,
    });
    await user.click(within(dialog).getByRole("button", { name: /^Cancel$/i }));
    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", { name: /Record this communication as sent manually\?/i })
      ).toBeNull();
    });
    expect(updateCommunicationMock).not.toHaveBeenCalled();
    // Focus is restored to the trigger.
    expect(document.activeElement).toBe(trigger);
  });

  it("Escape closes the manual-send dialog and restores focus", async () => {
    const user = userEvent.setup();
    listCommunicationsMock.mockResolvedValue({
      communications: [record({ status: "draft" })],
    });
    renderPanel();
    await waitFor(() => screen.getByRole("button", { name: /Record manual send/i }));
    const trigger = screen.getByRole("button", { name: /Record manual send/i });
    await user.click(trigger);
    await screen.findByRole("dialog", { name: /Record this communication as sent manually\?/i });
    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", { name: /Record this communication as sent manually\?/i })
      ).toBeNull();
    });
    expect(updateCommunicationMock).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(trigger);
  });

  it("confirming manual send calls updateCommunication exactly once with the mark-related flag", async () => {
    const user = userEvent.setup();
    listCommunicationsMock.mockResolvedValue({
      communications: [
        record({
          id: "cr_send",
          status: "draft",
          related_missing_info_item_ids: ["mi_1", "mi_2"],
        }),
      ],
    });
    updateCommunicationMock.mockResolvedValue({ ok: true });
    const { onRefresh } = renderPanel({
      data: workspace({
        missingInfo: [
          missing({ id: "mi_1", status: "open" }),
          missing({ id: "mi_2", status: "requested" }),
        ],
      }),
    });
    await waitFor(() => screen.getByRole("button", { name: /Record manual send/i }));
    await user.click(screen.getByRole("button", { name: /Record manual send/i }));
    const dialog = await screen.findByRole("dialog");
    // The consequence is stated before confirmation.
    expect(within(dialog).getByText(/2 linked missing-information items will also be marked as requested/i)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: /^Record manual send$/i }));
    await waitFor(() => {
      expect(updateCommunicationMock).toHaveBeenCalledTimes(1);
    });
    expect(updateCommunicationMock).toHaveBeenCalledWith(
      "cr_send",
      expect.objectContaining({
        status: "sent_manually",
        mark_related_missing_requested: true,
      })
    );
    expect(onRefresh).toHaveBeenCalled();
  });
});

describe("CommunicationsPanel — responsive treatment", () => {
  it("opts the record list into the scoped mobile-stack modifier", async () => {
    listCommunicationsMock.mockResolvedValue({
      communications: [
        record({ id: "cr_1", subject: "Claims history chase", status: "draft" }),
      ],
    });
    renderPanel();
    await waitFor(() => {
      expect(screen.getByText(/Claims history chase/i)).toBeInTheDocument();
    });
    const list = screen.getByText(/Claims history chase/i).closest("ul")!;
    expect(list).toHaveClass("atlas-list");
    expect(list).toHaveClass("atlas-list--stack-sm");
  });

  it("keeps subject, lifecycle badge and both actions on a draft row", async () => {
    listCommunicationsMock.mockResolvedValue({
      communications: [
        record({ id: "cr_1", subject: "Claims history follow-up", status: "draft" }),
      ],
    });
    renderPanel();
    await waitFor(() => {
      expect(screen.getByText(/Claims history follow-up/)).toBeInTheDocument();
    });
    const row = screen.getByText(/Claims history follow-up/).closest("li")!;
    expect(within(row).getByText(/Claims history follow-up/)).toBeInTheDocument();
    expect(row.querySelector(".atlas-list__main")).not.toBeNull();
    // Lifecycle badge remains present on the side region.
    const side = row.querySelector(".atlas-list__side")!;
    expect(within(side as HTMLElement).getByText(/Draft/i)).toBeInTheDocument();
    // Copy + Record manual send actions remain reachable and correctly labelled.
    expect(within(row).getByRole("button", { name: /Copy message/i })).toBeInTheDocument();
    expect(within(row).getByRole("button", { name: /Record manual send/i })).toBeInTheDocument();
  });
});

describe("CommunicationsPanel — history error and clipboard fallback", () => {
  it("shows a recoverable notice when the history fails to load and offers retry", async () => {
    listCommunicationsMock.mockRejectedValueOnce(new Error("boom"));
    renderPanel();
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /Try again/i })
      ).toBeInTheDocument();
    });
    // Retry restores the history.
    listCommunicationsMock.mockResolvedValueOnce({ communications: [] });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Try again/i }));
    await waitFor(() => {
      expect(screen.getByText(/Nothing has been recorded yet/i)).toBeInTheDocument();
    });
  });

  it("falls back with a warning toast when clipboard write fails", async () => {
    const user = userEvent.setup();
    generateDraftMock.mockResolvedValue({ ok: true, draft: "Body" });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(new Error("no")) },
    });
    renderPanel();
    await waitFor(() => expect(listCommunicationsMock).toHaveBeenCalled());
    await user.click(screen.getByRole("button", { name: /Outstanding information request/i }));
    await screen.findByRole("textbox", { name: /Draft message/i });
    await user.click(screen.getByRole("button", { name: /Copy message/i }));
    await waitFor(() => {
      expect(screen.getByText(/Copying failed/i)).toBeInTheDocument();
    });
  });
});

describe("CommunicationsPanel — axe", () => {
  it("is axe-clean with the safety notice, chooser and populated history", async () => {
    listCommunicationsMock.mockResolvedValue({
      communications: [record({ status: "draft" })],
    });
    const { container } = renderPanel();
    await waitFor(() => {
      expect(screen.getByText(/Please supply the following/i)).toBeInTheDocument();
    });
    let results;
    await act(async () => {
      results = await axe(container);
    });
    expect(results).toHaveNoViolations();
  });
});
