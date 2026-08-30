/**
 * Phase 3 broker role — frontend behavioural tests
 * ----------------------------------------------------------------------------
 * Companion to the structural tests in tests/phase17-broker-*.ts. This file
 * renders the real components with a broker session and asserts what the
 * user sees / does NOT see, and — most importantly — mocks/spies prove
 * broker mode never calls getRecommendation / getQuoteReview / getDecision.
 *
 * Every atlas surface is fully mocked. No test transitively boots the
 * Supabase client.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, within, waitFor } from "@testing-library/react";

// ---------------------------------------------------------------------------
// Mocks — every API surface SubmissionDetail / WorkQueue / AppShell reach
// ---------------------------------------------------------------------------

const getSubmissionMock = vi.fn();
const runExtractionMock = vi.fn();
const saveReviewMock = vi.fn();
const updatePilotFlagMock = vi.fn();
const listPilotIssuesMock = vi.fn();
const createPilotIssueMock = vi.fn();
const updatePilotIssueMock = vi.fn();
const listSubmissionsMock = vi.fn();
const getPipelineWorkloadMock = vi.fn();
const getSubmissionQuickMock = vi.fn();
const createSubmissionMock = vi.fn();

vi.mock("../lib/atlas", () => ({
  getSubmission: (...a: unknown[]) => getSubmissionMock(...a),
  runExtraction: (...a: unknown[]) => runExtractionMock(...a),
  saveReview: (...a: unknown[]) => saveReviewMock(...a),
  updatePilotFlag: (...a: unknown[]) => updatePilotFlagMock(...a),
  listPilotIssues: (...a: unknown[]) => listPilotIssuesMock(...a),
  createPilotIssue: (...a: unknown[]) => createPilotIssueMock(...a),
  updatePilotIssue: (...a: unknown[]) => updatePilotIssueMock(...a),
  listSubmissions: (...a: unknown[]) => listSubmissionsMock(...a),
  getPipelineWorkload: (...a: unknown[]) => getPipelineWorkloadMock(...a),
  getSubmissionQuick: (...a: unknown[]) => getSubmissionQuickMock(...a),
  createSubmission: (...a: unknown[]) => createSubmissionMock(...a),
}));

const getRecommendationMock = vi.fn();
vi.mock("../lib/recommendations", () => ({
  getRecommendation: (...a: unknown[]) => getRecommendationMock(...a),
}));

const getQuoteReviewMock = vi.fn();
vi.mock("../lib/quote-reviews", () => ({
  getQuoteReview: (...a: unknown[]) => getQuoteReviewMock(...a),
}));

const getDecisionMock = vi.fn();
vi.mock("../lib/decisions", () => ({
  getDecision: (...a: unknown[]) => getDecisionMock(...a),
}));

const listMissingInfoMock = vi.fn();
vi.mock("../lib/phase4", () => ({
  listMissingInfo: (...a: unknown[]) => listMissingInfoMock(...a),
}));

vi.mock("../lib/phase7", () => ({
  cancelJob: vi.fn(),
  updateAssignment: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Real components under test (imported AFTER mocks)
// ---------------------------------------------------------------------------

import { AppShell, type AtlasUiRole } from "../components/AppShell";
import WorkQueue from "../pages/WorkQueue";
import SubmissionDetail from "../pages/SubmissionDetail";
import { ToastProvider } from "../components/ui";
import type { Route } from "../lib/router";

function submissionPayload(over: Record<string, unknown> = {}) {
  return {
    ok: true,
    submission: {
      id: "sub_broker_1",
      client_name: "Broker's Client",
      broker_name: "Broker A",
      broker_email: "broker@example.com",
      request_type: "Commercial building",
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
      updated_at: "2026-08-02T09:00:00Z",
    },
    documents: [],
    extraction: null,
    jobs: null,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  listMissingInfoMock.mockResolvedValue({ items: [] });
  getSubmissionMock.mockResolvedValue(submissionPayload());
  listSubmissionsMock.mockResolvedValue({ ok: true, submissions: [] });
});

// ---------------------------------------------------------------------------
// AppShell — broker navigation
// ---------------------------------------------------------------------------

function renderShell(role: AtlasUiRole, route: Route = { name: "queue" }) {
  return render(
    <AppShell
      route={route}
      role={role}
      email="broker@example.com"
      onNavigate={() => {}}
      onSignOut={() => {}}
      onSearch={() => {}}
      searchValue=""
    >
      <div>content</div>
    </AppShell>
  );
}

describe("AppShell (broker)", () => {
  it("shows Work queue and hides Insurers, Manager overview, Processing & alerts", () => {
    renderShell("broker");
    const sidebar = screen.getByRole("navigation", { name: /primary/i });
    expect(within(sidebar).getByRole("button", { name: /quote pipeline/i })).toBeInTheDocument();
    expect(within(sidebar).queryByRole("button", { name: /insurers/i })).toBeNull();
    expect(within(sidebar).queryByRole("button", { name: /manager overview/i })).toBeNull();
    expect(within(sidebar).queryByRole("button", { name: /processing & alerts/i })).toBeNull();
  });

  it("shows all groups for a manager (control case)", () => {
    renderShell("manager");
    const sidebar = screen.getByRole("navigation", { name: /primary/i });
    expect(within(sidebar).getByRole("button", { name: /quote pipeline/i })).toBeInTheDocument();
    expect(within(sidebar).getByRole("button", { name: /insurers/i })).toBeInTheDocument();
    expect(within(sidebar).getByRole("button", { name: /manager overview/i })).toBeInTheDocument();
    expect(within(sidebar).getByRole("button", { name: /processing & alerts/i })).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// WorkQueue — broker sees the "New submission" button
// ---------------------------------------------------------------------------

describe("WorkQueue (broker)", () => {
  it("shows Quick capture / Full intake actions for broker", async () => {
    listSubmissionsMock.mockResolvedValue({ ok: true, submissions: [] });
    const onNew = vi.fn();
    render(
      <WorkQueue
        role="broker"
        search=""
        onSearchChange={() => {}}
        onNew={onNew}
        onOpen={() => {}}
      />
    );
    await screen.findByText(/quote pipeline is empty/i);
    // At least one Quick capture control is present + enabled.
    const captures = screen.getAllByRole("button", { name: /^Quick capture$/i });
    expect(captures.some((b) => !(b as HTMLButtonElement).disabled)).toBe(true);
    // Full intake action is present.
    expect(screen.getAllByRole("button", { name: /^Full intake$/i }).length).toBeGreaterThan(0);
  });

  it("readonly has ZERO creation actions — no Quick capture, no Full intake, no New submission", async () => {
    listSubmissionsMock.mockResolvedValue({ ok: true, submissions: [] });
    render(
      <WorkQueue
        role="readonly"
        search=""
        onSearchChange={() => {}}
        onNew={() => {}}
        onOpen={() => {}}
      />
    );
    await screen.findByText(/quote pipeline is empty/i);
    expect(screen.queryByRole("button", { name: /^Quick capture$/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Full intake$/i })).toBeNull();
    // The disabled "New submission" placeholder from earlier iterations was
    // removed on the CEO's closeout — readonly must not even see the CTA.
    expect(screen.queryByRole("button", { name: /new submission/i })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// SubmissionDetail — broker network + tab + panel visibility
// ---------------------------------------------------------------------------

function renderDetail(role: AtlasUiRole, tab = "overview") {
  return render(
    <ToastProvider>
      <SubmissionDetail
        submissionId="sub_broker_1"
        tab={tab}
        role={role}
        onTabChange={() => {}}
        onBack={() => {}}
      />
    </ToastProvider>
  );
}

describe("SubmissionDetail (broker) — network isolation", () => {
  it("broker mode MUST NOT call getRecommendation / getQuoteReview / getDecision", async () => {
    renderDetail("broker");
    await screen.findByRole("heading", { level: 1, name: /Broker's Client/ });

    // Give any deferred microtasks a chance to fire.
    await waitFor(() => expect(getSubmissionMock).toHaveBeenCalled());

    expect(getRecommendationMock).not.toHaveBeenCalled();
    expect(getQuoteReviewMock).not.toHaveBeenCalled();
    expect(getDecisionMock).not.toHaveBeenCalled();
  });

  it("underwriter mode DOES call the intelligence endpoints (control case)", async () => {
    getRecommendationMock.mockResolvedValue({ recommendation: null });
    getQuoteReviewMock.mockResolvedValue({ quote_review: null, sections: [] });
    getDecisionMock.mockResolvedValue({ decision: null });

    renderDetail("underwriter");
    await screen.findByRole("heading", { level: 1, name: /Broker's Client/ });

    await waitFor(() => {
      expect(getRecommendationMock).toHaveBeenCalled();
      expect(getQuoteReviewMock).toHaveBeenCalled();
      expect(getDecisionMock).toHaveBeenCalled();
    });
  });
});

describe("SubmissionDetail (broker) — tab set", () => {
  it("renders exactly Overview, Missing information, Documents, History", async () => {
    renderDetail("broker");
    await screen.findByRole("heading", { level: 1, name: /Broker's Client/ });

    const tabs = screen.getByRole("tablist", { name: /submission sections/i });
    // Expected present
    expect(within(tabs).getByRole("tab", { name: /^Overview/i })).toBeInTheDocument();
    expect(within(tabs).getByRole("tab", { name: /Missing information/i })).toBeInTheDocument();
    expect(within(tabs).getByRole("tab", { name: /Documents/i })).toBeInTheDocument();
    expect(within(tabs).getByRole("tab", { name: /History/i })).toBeInTheDocument();

    // Expected absent (underwriting-intelligence surfaces)
    expect(within(tabs).queryByRole("tab", { name: /Risk information/i })).toBeNull();
    expect(within(tabs).queryByRole("tab", { name: /^Recommendation/i })).toBeNull();
    expect(within(tabs).queryByRole("tab", { name: /Quote review/i })).toBeNull();
    expect(within(tabs).queryByRole("tab", { name: /Communications/i })).toBeNull();
  });

  it("underwriter tab set includes intelligence tabs (control case)", async () => {
    getRecommendationMock.mockResolvedValue({ recommendation: null });
    getQuoteReviewMock.mockResolvedValue({ quote_review: null, sections: [] });
    getDecisionMock.mockResolvedValue({ decision: null });
    renderDetail("underwriter");
    await screen.findByRole("heading", { level: 1, name: /Broker's Client/ });
    const tabs = screen.getByRole("tablist", { name: /submission sections/i });
    expect(within(tabs).getByRole("tab", { name: /Risk information/i })).toBeInTheDocument();
    expect(within(tabs).getByRole("tab", { name: /^Recommendation/i })).toBeInTheDocument();
    expect(within(tabs).getByRole("tab", { name: /Quote review/i })).toBeInTheDocument();
    expect(within(tabs).getByRole("tab", { name: /Communications/i })).toBeInTheDocument();
  });
});

describe("SubmissionDetail (broker) — hidden panels + controls", () => {
  it("does not render the Change assignment button (AssignmentDrawer trigger)", async () => {
    renderDetail("broker");
    await screen.findByRole("heading", { level: 1, name: /Broker's Client/ });
    expect(screen.queryByRole("button", { name: /change assignment/i })).toBeNull();
  });

  it("does not render pilot controls, extraction / recommendation / decision actions", async () => {
    renderDetail("broker");
    await screen.findByRole("heading", { level: 1, name: /Broker's Client/ });

    // Pilot admin surface
    expect(screen.queryByRole("button", { name: /mark as pilot/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /remove pilot flag/i })).toBeNull();

    // Extraction action (manager-only, but must also be absent for broker)
    expect(screen.queryByRole("button", { name: /run extraction/i })).toBeNull();

    // Recommendation / decision / quote-review are not tabs, so no such controls.
    expect(screen.queryByRole("button", { name: /run recommendation/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /record decision/i })).toBeNull();
  });

  it("broker overview shows only operational status (no top insurer / decision surface)", async () => {
    renderDetail("broker");
    await screen.findByRole("heading", { level: 1, name: /Broker's Client/ });
    // Broker-only "Case status" label appears
    expect(screen.getByText(/case status/i)).toBeInTheDocument();
    // Underwriting summary heading must not render
    expect(screen.queryByText(/underwriting summary/i)).toBeNull();
    expect(screen.queryByText(/next action/i)).toBeNull();
  });
});
