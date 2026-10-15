/**
 * SubmissionDetail — document counts tell the truth
 * ----------------------------------------------------------------------------
 * Two numbers on the submission page used to share one value:
 *   - the Documents tab badge  -> how many non-expired files are attached
 *     (a navigation count, not a trust claim);
 *   - every "Active documents" label (rail + Overview) -> how many of them
 *     are CONFIRMED CLEAN.
 * Counting every non-expired file as "active" made a failed or unconfirmed
 * scan read as an active document. These tests render the real page, for a
 * staff role and for a broker, and pin the split.
 *
 * Every atlas surface is mocked; nothing here boots the Supabase client.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";

const getSubmissionMock = vi.fn();
vi.mock("../lib/atlas", () => ({
  getSubmission: (...a: unknown[]) => getSubmissionMock(...a),
  runExtraction: vi.fn(),
  saveReview: vi.fn(),
  updatePilotFlag: vi.fn(),
  listPilotIssues: vi.fn(),
  createPilotIssue: vi.fn(),
  updatePilotIssue: vi.fn(),
  listSubmissions: vi.fn(),
  getPipelineWorkload: vi.fn(),
  getSubmissionQuick: vi.fn(),
  createSubmission: vi.fn(),
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

import SubmissionDetail from "../pages/SubmissionDetail";
import { ToastProvider } from "../components/ui";
import type { AtlasUiRole } from "../components/AppShell";

function document_(over: Record<string, unknown>) {
  return {
    id: `d_${Math.random().toString(36).slice(2, 8)}`,
    file_name: "file.pdf",
    document_type: "proposal_form",
    status: "active",
    scan_status: "clean",
    scanned_at: "2026-08-01T10:00:30Z",
    expires_at: null,
    created_at: "2026-08-01T10:00:00Z",
    ...over,
  };
}

function payload(documents: Record<string, unknown>[]) {
  return {
    ok: true,
    submission: {
      id: "sub_counts_1",
      client_name: "Counts Client",
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
    documents,
    extraction: null,
    jobs: null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  listMissingInfoMock.mockResolvedValue({ items: [] });
  getRecommendationMock.mockResolvedValue({ recommendation: null });
  getQuoteReviewMock.mockResolvedValue({ quote_review: null, sections: [] });
  getDecisionMock.mockResolvedValue({ decision: null });
});

async function renderDetail(role: AtlasUiRole, documents: Record<string, unknown>[]) {
  getSubmissionMock.mockResolvedValue(payload(documents));
  render(
    <ToastProvider>
      <SubmissionDetail
        submissionId="sub_counts_1"
        tab="overview"
        role={role}
        onTabChange={() => {}}
        onBack={() => {}}
      />
    </ToastProvider>
  );
  await screen.findByRole("heading", { level: 1, name: /Counts Client/ });
}

/** Every "Active documents" count on the page (rail + Overview metric). */
function activeDocumentCounts(): string[] {
  return Array.from(window.document.querySelectorAll("dt"))
    .filter((dt) => dt.textContent?.trim() === "Active documents")
    .map((dt) => dt.parentElement?.querySelector("dd")?.textContent?.trim() ?? "");
}

function documentsTabBadge(): string | undefined {
  const tabs = screen.getByRole("tablist", { name: /submission sections/i });
  const tab = within(tabs).getByRole("tab", { name: /Documents/i });
  return tab.querySelector(".atlas-tab__count")?.textContent?.trim();
}

const CLEAN_FAILED_NULL = () => [
  document_({ id: "d_clean", file_name: "clean.pdf", scan_status: "clean" }),
  document_({ id: "d_failed", file_name: "failed.pdf", scan_status: "failed" }),
  document_({ id: "d_null", file_name: "unconfirmed.pdf", scan_status: null }),
];

describe.each<[string, AtlasUiRole]>([
  ["staff (underwriter)", "underwriter"],
  ["broker", "broker"],
])("SubmissionDetail document counts — %s", (_label, role) => {
  it("labels only confirmed-clean documents as 'Active documents' (1 clean + 1 failed + 1 unconfirmed -> 1)", async () => {
    await renderDetail(role, CLEAN_FAILED_NULL());

    const counts = activeDocumentCounts();
    // The rail and the Overview metric both carry the label.
    expect(counts.length).toBeGreaterThanOrEqual(2);
    expect(counts.every((c) => c === "1")).toBe(true);
  });

  it("keeps the Documents tab badge as the count of all attached, non-expired documents (3)", async () => {
    await renderDetail(role, CLEAN_FAILED_NULL());
    expect(documentsTabBadge()).toBe("3");
  });

  it("the badge excludes expired files while 'Active documents' stays clean-only", async () => {
    await renderDetail(role, [
      ...CLEAN_FAILED_NULL(),
      document_({ id: "d_pending", file_name: "pending.pdf", scan_status: "pending" }),
      document_({ id: "d_old", file_name: "old.pdf", status: "expired", scan_status: "clean" }),
    ]);
    // 3 + pending = 4 attached and not expired; the expired clean file is not counted.
    expect(documentsTabBadge()).toBe("4");
    expect(activeDocumentCounts().every((c) => c === "1")).toBe(true);
  });

  it("reports zero active documents when nothing is confirmed clean, while the badge still shows what is attached", async () => {
    await renderDetail(role, [
      document_({ id: "d_failed", scan_status: "failed" }),
      document_({ id: "d_null", scan_status: null }),
    ]);
    expect(activeDocumentCounts().every((c) => c === "0")).toBe(true);
    expect(documentsTabBadge()).toBe("2");
  });
});
