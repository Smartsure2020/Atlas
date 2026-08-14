/**
 * Submission audit timeline — page-level tests
 * ----------------------------------------------------------------------------
 * Every network call routes through getAuditTimeline; the mock is fully
 * self-contained so ../lib/atlas is never loaded. Covered:
 *   - loading, empty, populated and error states;
 *   - known events surface their group label and human-decision styling;
 *   - unknown event codes are retained in the "Other activity" group and
 *     are never mislabelled with a fabricated actor;
 *   - person / system / unknown actor lines read honestly;
 *   - client-side filtering never issues a new request;
 *   - StrictMode issues exactly one request per submission;
 *   - the metadata disclosure renders humanised values, and long payloads
 *     land inside a scrollable pre;
 *   - there are no write actions anywhere on the timeline;
 *   - axe-clean populated, filtered, empty and error surfaces.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "vitest-axe";

const getAuditTimelineMock = vi.fn();
vi.mock("../lib/decisions", () => ({
  getAuditTimeline: (...args: unknown[]) => getAuditTimelineMock(...args),
}));

import AuditTimeline from "../pages/AuditTimeline";
import type { AuditEvent } from "../lib/decisions";

function event(over: Partial<AuditEvent> = {}): AuditEvent {
  return {
    id: over.id ?? `ev_${Math.random().toString(36).slice(2, 8)}`,
    action: over.action ?? "submission_created",
    actor_id: over.actor_id ?? null,
    actor_email: over.actor_email ?? null,
    metadata: over.metadata ?? null,
    created_at: over.created_at ?? "2026-08-14T10:00:00Z",
  };
}

beforeEach(() => {
  getAuditTimelineMock.mockReset();
});

describe("Audit timeline", () => {
  it("shows the empty state when no events have been recorded", async () => {
    getAuditTimelineMock.mockResolvedValue({ ok: true, events: [] });
    render(<AuditTimeline submissionId="sub_1" />);
    expect(await screen.findByText(/No activity recorded yet/i)).toBeInTheDocument();
    expect(getAuditTimelineMock).toHaveBeenCalledWith("sub_1");
  });

  it("groups events into calendar-day buckets", async () => {
    getAuditTimelineMock.mockResolvedValue({
      ok: true,
      events: [
        event({ id: "a", action: "submission_created", created_at: "2026-01-10T09:00:00Z" }),
        event({ id: "b", action: "extraction_run", created_at: "2026-01-11T09:00:00Z" }),
      ],
    });
    render(<AuditTimeline submissionId="sub_1" />);
    await screen.findByText(/Submission created/i);
    // Two calendar-day sections must exist.
    const dayHeadings = screen.getAllByRole("heading", { level: 3 });
    expect(dayHeadings.length).toBeGreaterThanOrEqual(2);
  });

  it("filters events client-side and issues no new request", async () => {
    getAuditTimelineMock.mockResolvedValue({
      ok: true,
      events: [
        event({ id: "a", action: "decision_accepted", actor_email: "u@example.com" }),
        event({ id: "b", action: "extraction_run" }),
      ],
    });
    render(<AuditTimeline submissionId="sub_1" />);
    await screen.findByText(/Decision recorded — Atlas recommendation accepted/i);
    expect(getAuditTimelineMock).toHaveBeenCalledTimes(1);

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /^Processing$/i }));
    // The decision event is hidden by the processing filter.
    expect(
      screen.queryByText(/Decision recorded — Atlas recommendation accepted/i)
    ).not.toBeInTheDocument();
    // Extraction run is a processing event.
    expect(screen.getByText(/Extraction run/i)).toBeInTheDocument();
    // No new request.
    expect(getAuditTimelineMock).toHaveBeenCalledTimes(1);
  });

  it("returns the full list when the All activity filter is chosen", async () => {
    getAuditTimelineMock.mockResolvedValue({
      ok: true,
      events: [
        event({ id: "a", action: "decision_accepted", actor_email: "u@example.com" }),
        event({ id: "b", action: "extraction_run" }),
      ],
    });
    render(<AuditTimeline submissionId="sub_1" />);
    await screen.findByText(/Decision recorded — Atlas recommendation accepted/i);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /^Processing$/i }));
    await user.click(screen.getByRole("button", { name: /All activity/i }));
    expect(
      screen.getByText(/Decision recorded — Atlas recommendation accepted/i)
    ).toBeInTheDocument();
    expect(screen.getByText(/Extraction run/i)).toBeInTheDocument();
  });

  it("keeps unknown event codes visible under the Other activity filter", async () => {
    getAuditTimelineMock.mockResolvedValue({
      ok: true,
      events: [
        event({ id: "u1", action: "some_new_action" }),
        event({ id: "e", action: "extraction_run" }),
      ],
    });
    render(<AuditTimeline submissionId="sub_1" />);
    // The humanised label is visible on the default (All) filter.
    await screen.findByText(/Some new action/i);

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Other activity/i }));
    expect(screen.getByText(/Some new action/i)).toBeInTheDocument();
    // Actor line reads "Actor not recorded" — never a fabricated "Atlas
    // (automated)" fallback.
    expect(screen.getByText(/Actor not recorded/i)).toBeInTheDocument();
    // The extraction event (known, system-authored) is not part of "Other".
    expect(screen.queryByText(/Extraction run/i)).not.toBeInTheDocument();
  });

  it("distinguishes person, system and unknown actors", async () => {
    getAuditTimelineMock.mockResolvedValue({
      ok: true,
      events: [
        event({
          id: "p",
          action: "decision_accepted",
          actor_email: "u@example.com",
        }),
        event({ id: "s", action: "extraction_run" }),
        event({ id: "u", action: "brand_new_code" }),
      ],
    });
    render(<AuditTimeline submissionId="sub_1" />);
    await screen.findByText(/Decision recorded — Atlas recommendation accepted/i);
    expect(screen.getByText("u@example.com")).toBeInTheDocument();
    expect(screen.getByText(/Atlas automation/i)).toBeInTheDocument();
    expect(screen.getByText(/Actor not recorded/i)).toBeInTheDocument();
  });

  it("renders a metadata disclosure with humanised entries", async () => {
    getAuditTimelineMock.mockResolvedValue({
      ok: true,
      events: [
        event({
          id: "d",
          action: "decision_overridden",
          actor_email: "u@example.com",
          metadata: { reason_code: "client_preference", note: "asked by broker" },
        }),
      ],
    });
    render(<AuditTimeline submissionId="sub_1" />);
    const disclosure = await screen.findByText(/Recorded detail/i);
    const user = userEvent.setup();
    await user.click(disclosure);
    expect(screen.getByText("Reason code")).toBeInTheDocument();
    expect(screen.getByText("client_preference")).toBeInTheDocument();
    expect(screen.getByText("Note")).toBeInTheDocument();
    expect(screen.getByText("asked by broker")).toBeInTheDocument();
  });

  it("renders object metadata values inside a scrollable pre", async () => {
    getAuditTimelineMock.mockResolvedValue({
      ok: true,
      events: [
        event({
          id: "m",
          action: "extraction_run",
          metadata: { detail: { pages: 12, source: "pdf" } },
        }),
      ],
    });
    render(<AuditTimeline submissionId="sub_1" />);
    const disclosure = await screen.findByText(/Recorded detail/i);
    const user = userEvent.setup();
    await user.click(disclosure);
    const pre = document.querySelector("pre");
    expect(pre).not.toBeNull();
    expect(pre?.textContent).toContain("pages");
    expect(pre?.textContent).toContain("12");
  });

  it("renders the skeleton while loading", async () => {
    let resolve: (value: { ok: true; events: AuditEvent[] }) => void = () => undefined;
    getAuditTimelineMock.mockReturnValue(
      new Promise((r) => {
        resolve = r;
      })
    );
    render(<AuditTimeline submissionId="sub_1" />);
    // At least one skeleton block is present while the fetch is pending.
    await waitFor(() => {
      expect(document.querySelectorAll(".atlas-skeleton").length).toBeGreaterThan(0);
    });
    resolve({ ok: true, events: [] });
  });

  it("shows a recoverable error state with retry that issues exactly one new request", async () => {
    getAuditTimelineMock.mockRejectedValueOnce(new Error("boom"));
    render(<AuditTimeline submissionId="sub_1" />);
    await screen.findByText(/The activity history could not be loaded/i);

    const user = userEvent.setup();
    getAuditTimelineMock.mockClear();
    getAuditTimelineMock.mockResolvedValue({
      ok: true,
      events: [event({ id: "a", action: "submission_created" })],
    });
    await user.click(screen.getByRole("button", { name: /try again/i }));
    await waitFor(() => expect(getAuditTimelineMock).toHaveBeenCalledTimes(1));
  });

  it("issues exactly one initial request under React StrictMode", async () => {
    const { StrictMode } = await import("react");
    getAuditTimelineMock.mockResolvedValue({ ok: true, events: [] });
    render(
      <StrictMode>
        <AuditTimeline submissionId="sub_1" />
      </StrictMode>
    );
    await screen.findByText(/No activity recorded yet/i);
    await waitFor(() => expect(getAuditTimelineMock).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 30));
    expect(getAuditTimelineMock).toHaveBeenCalledTimes(1);
  });

  it("exposes no write action anywhere on the page", async () => {
    getAuditTimelineMock.mockResolvedValue({
      ok: true,
      events: [
        event({ id: "a", action: "decision_accepted", actor_email: "u@example.com" }),
        event({ id: "b", action: "extraction_run" }),
      ],
    });
    render(<AuditTimeline submissionId="sub_1" />);
    await screen.findByText(/Decision recorded — Atlas recommendation accepted/i);
    // Only filter toggles + the "Recorded detail" disclosure summary are
    // interactive controls. There must be no Delete / Save / Edit / Publish
    // affordance anywhere.
    for (const label of ["Delete", "Save", "Edit", "Publish", "Send", "Export"]) {
      expect(
        screen.queryByRole("button", { name: new RegExp(`^${label}`, "i") })
      ).not.toBeInTheDocument();
    }
  });

  it("is axe-clean in the populated state", async () => {
    getAuditTimelineMock.mockResolvedValue({
      ok: true,
      events: [
        event({ id: "a", action: "decision_accepted", actor_email: "u@example.com" }),
        event({ id: "b", action: "extraction_run" }),
      ],
    });
    const { container } = render(<AuditTimeline submissionId="sub_1" />);
    await screen.findByText(/Decision recorded — Atlas recommendation accepted/i);
    expect(await axe(container)).toHaveNoViolations();
  });

  it("is axe-clean in a filtered view", async () => {
    getAuditTimelineMock.mockResolvedValue({
      ok: true,
      events: [event({ id: "a", action: "decision_accepted", actor_email: "u@example.com" })],
    });
    const { container } = render(<AuditTimeline submissionId="sub_1" />);
    await screen.findByText(/Decision recorded — Atlas recommendation accepted/i);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /^Decisions$/i }));
    expect(await axe(container)).toHaveNoViolations();
  });

  it("is axe-clean in the empty state", async () => {
    getAuditTimelineMock.mockResolvedValue({ ok: true, events: [] });
    const { container } = render(<AuditTimeline submissionId="sub_1" />);
    await screen.findByText(/No activity recorded yet/i);
    expect(await axe(container)).toHaveNoViolations();
  });

  it("is axe-clean in the error state", async () => {
    getAuditTimelineMock.mockRejectedValue(new Error("boom"));
    const { container } = render(<AuditTimeline submissionId="sub_1" />);
    await screen.findByText(/The activity history could not be loaded/i);
    expect(await axe(container)).toHaveNoViolations();
  });
});
