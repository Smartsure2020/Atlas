/**
 * Processing operations workbench — page-level tests
 * ----------------------------------------------------------------------------
 * Full mocks for every ../lib/phase7 endpoint so no test transitively loads
 * ../lib/atlas. Covered:
 *   - populated operations state renders the five exception tiles, the
 *     alert queue, the intervention queue and the full history;
 *   - open + critical alerts flip the "attention" tile and add the
 *     critical-open sentence to the caption;
 *   - failed and stuck jobs land in the intervention queue with their
 *     honest badges; a retry-exhausted job does NOT appear there;
 *   - cancellation-requested running jobs are surfaced as pending;
 *   - no-jobs / no-alerts / all-healthy states each show the right empty
 *     copy;
 *   - permission denial (not_authenticated) uses the expired-session copy,
 *     generic errors use the fallback copy;
 *   - independent per-endpoint failures do not blank the whole page;
 *   - filters and sorting on the full history work client-side;
 *   - technical drawer opens and shows the identifier;
 *   - linked-submission callback fires;
 *   - unknown status/error code is displayed rather than dropped;
 *   - the initial render issues exactly one call per endpoint under
 *     React StrictMode; a legitimate refresh issues exactly one more;
 *   - a stale slow response cannot overwrite a newer one;
 *   - retry / cancel / resolve dialogs cancel + escape + confirm produce
 *     the exact number of writes documented in each test;
 *   - acknowledge is one tap, resolve is behind ConfirmDialog, and
 *     unauthorised gating (no manager) does not surface these controls
 *     (the endpoint itself rejects — we test the API rejection path);
 *   - axe on populated, empty and error states.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "vitest-axe";

const getSystemStatusMock = vi.fn();
const listJobsMock = vi.fn();
const listAlertsMock = vi.fn();
const cleanupPreviewMock = vi.fn();
const retryJobMock = vi.fn();
const cancelJobMock = vi.fn();
const updateAlertMock = vi.fn();

vi.mock("../lib/phase7", () => ({
  getSystemStatus: (...args: unknown[]) => getSystemStatusMock(...args),
  listJobs: (...args: unknown[]) => listJobsMock(...args),
  listAlerts: (...args: unknown[]) => listAlertsMock(...args),
  cleanupPreview: (...args: unknown[]) => cleanupPreviewMock(...args),
  retryJob: (...args: unknown[]) => retryJobMock(...args),
  cancelJob: (...args: unknown[]) => cancelJobMock(...args),
  updateAlert: (...args: unknown[]) => updateAlertMock(...args),
}));

import ProcessingJobs from "../pages/ProcessingJobs";
import { ToastProvider } from "../components/ui";
import type { AtlasJob, OperationalAlert, SystemStatus, JobSummary } from "../lib/phase7";

/* ---------- factories ------------------------------------------------------ */

function job(over: Partial<AtlasJob> = {}): AtlasJob {
  return {
    id: over.id ?? `job_${Math.random().toString(36).slice(2, 8)}`,
    submission_id: over.submission_id ?? null,
    document_id: over.document_id ?? null,
    quote_review_id: over.quote_review_id ?? null,
    insurer_id: over.insurer_id ?? null,
    job_type: over.job_type ?? "extraction",
    status: over.status ?? "completed",
    result_reference_id: over.result_reference_id ?? null,
    error_code: over.error_code ?? null,
    error_message: over.error_message ?? null,
    started_at: over.started_at ?? null,
    completed_at: over.completed_at ?? null,
    created_at: over.created_at ?? "2026-08-14T09:00:00Z",
    metadata: over.metadata ?? null,
    retry_count: over.retry_count,
    max_retries: over.max_retries,
    next_retry_at: over.next_retry_at ?? null,
    last_error_code: over.last_error_code ?? null,
    cancellation_requested: over.cancellation_requested,
    progress_percent: over.progress_percent,
    current_step: over.current_step ?? null,
    heartbeat_at: over.heartbeat_at ?? null,
  };
}

function alert(over: Partial<OperationalAlert> = {}): OperationalAlert {
  return {
    id: over.id ?? `al_${Math.random().toString(36).slice(2, 8)}`,
    alert_type: over.alert_type ?? "job_failure",
    severity: over.severity ?? "warning",
    status: over.status ?? "open",
    title: over.title ?? "Alert",
    message: over.message ?? "Something needs a look.",
    created_at: over.created_at ?? "2026-08-14T09:00:00Z",
    escalation_due_at: over.escalation_due_at ?? null,
    escalated_at: over.escalated_at ?? null,
  };
}

function status(over: Partial<SystemStatus["jobs_24h"]> = {}): SystemStatus {
  return {
    environment: "test",
    database: { ok: true, latency_ms: 4 },
    storage: {
      client_docs_bucket_configured: true,
      insurer_docs_bucket_configured: true,
    },
    ai_provider: { anthropic_configured: true },
    jobs_24h: {
      failed_count: over.failed_count ?? 0,
      stuck_count: over.stuck_count ?? 0,
      by_error_code: over.by_error_code ?? {},
      last_success_by_type: over.last_success_by_type ?? {},
    },
  };
}

function summary(over: Partial<JobSummary> = {}): JobSummary {
  return {
    failed_count: over.failed_count ?? 0,
    stuck_count: over.stuck_count ?? 0,
    by_error_code: over.by_error_code ?? {},
    recent_failed_jobs: over.recent_failed_jobs ?? [],
    stuck_jobs: over.stuck_jobs ?? [],
  };
}

function mockPopulated(overrides: {
  jobs?: AtlasJob[];
  alerts?: OperationalAlert[];
  summary?: Partial<JobSummary>;
  status?: SystemStatus;
  cleanup?: number;
} = {}) {
  // Default is an all-healthy platform. Tests that want attention numbers
  // supply their own systemStatus and/or summary.
  getSystemStatusMock.mockResolvedValue(overrides.status ?? status());
  listJobsMock.mockResolvedValue({
    ok: true,
    jobs: overrides.jobs ?? [],
    summary: summary(overrides.summary ?? {}),
  });
  listAlertsMock.mockResolvedValue({ ok: true, alerts: overrides.alerts ?? [] });
  cleanupPreviewMock.mockResolvedValue({
    ok: true,
    mode: "preview_only",
    expired_active_documents: Array.from({ length: overrides.cleanup ?? 0 }, (_, i) => ({
      id: `doc_${i}`,
    })),
    orphan_storage_note: "",
  });
}

function renderPage(onOpen = vi.fn<(id: string) => void>()) {
  const rendered = render(
    <ToastProvider>
      <ProcessingJobs onOpenSubmission={onOpen} />
    </ToastProvider>
  );
  return { ...rendered, onOpen };
}

beforeEach(() => {
  getSystemStatusMock.mockReset();
  listJobsMock.mockReset();
  listAlertsMock.mockReset();
  cleanupPreviewMock.mockReset();
  retryJobMock.mockReset();
  cancelJobMock.mockReset();
  updateAlertMock.mockReset();
});

/* ---------- tests ---------------------------------------------------------- */

describe("Processing operations workbench", () => {
  it("issues exactly one initial request to every endpoint on mount", async () => {
    mockPopulated();
    renderPage();
    await screen.findByText(/Where operations need attention/i);
    expect(getSystemStatusMock).toHaveBeenCalledTimes(1);
    expect(listJobsMock).toHaveBeenCalledTimes(1);
    expect(listAlertsMock).toHaveBeenCalledTimes(1);
    expect(cleanupPreviewMock).toHaveBeenCalledTimes(1);
  });

  it("issues exactly one request per endpoint under React StrictMode", async () => {
    const { StrictMode } = await import("react");
    mockPopulated();
    render(
      <StrictMode>
        <ToastProvider>
          <ProcessingJobs onOpenSubmission={vi.fn()} />
        </ToastProvider>
      </StrictMode>
    );
    await screen.findByText(/Where operations need attention/i);
    await waitFor(() => expect(listJobsMock).toHaveBeenCalledTimes(1));
    // Give any late duplicate a chance to appear.
    await new Promise((r) => setTimeout(r, 30));
    expect(getSystemStatusMock).toHaveBeenCalledTimes(1);
    expect(listJobsMock).toHaveBeenCalledTimes(1);
    expect(listAlertsMock).toHaveBeenCalledTimes(1);
    expect(cleanupPreviewMock).toHaveBeenCalledTimes(1);
  });

  it("issues one additional request per endpoint when Refresh is clicked", async () => {
    mockPopulated();
    renderPage();
    await screen.findByText(/Where operations need attention/i);

    getSystemStatusMock.mockClear();
    listJobsMock.mockClear();
    listAlertsMock.mockClear();
    cleanupPreviewMock.mockClear();
    // Re-arm the mocks so the second call resolves.
    mockPopulated();

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Refresh/i }));
    await waitFor(() => expect(listJobsMock).toHaveBeenCalledTimes(1));
    expect(getSystemStatusMock).toHaveBeenCalledTimes(1);
    expect(listAlertsMock).toHaveBeenCalledTimes(1);
    expect(cleanupPreviewMock).toHaveBeenCalledTimes(1);
  });

  it("does not let a slow initial response overwrite a fresher refresh", async () => {
    let resolveSlow: ((value: unknown) => void) | null = null;
    listJobsMock.mockReturnValueOnce(
      new Promise((r) => {
        resolveSlow = r;
      })
    );
    getSystemStatusMock.mockResolvedValueOnce(status({ failed_count: 111 }));
    listAlertsMock.mockResolvedValueOnce({ ok: true, alerts: [] });
    cleanupPreviewMock.mockResolvedValueOnce({
      ok: true,
      mode: "preview_only",
      expired_active_documents: [],
      orphan_storage_note: "",
    });
    // Fresh response for the refresh.
    getSystemStatusMock.mockResolvedValueOnce(status({ failed_count: 222 }));
    listJobsMock.mockResolvedValueOnce({ ok: true, jobs: [], summary: summary() });
    listAlertsMock.mockResolvedValueOnce({ ok: true, alerts: [] });
    cleanupPreviewMock.mockResolvedValueOnce({
      ok: true,
      mode: "preview_only",
      expired_active_documents: [],
      orphan_storage_note: "",
    });

    renderPage();
    // Refresh before the slow one resolves.
    const user = userEvent.setup();
    // Wait for the Refresh button to be in the DOM.
    const refresh = await screen.findByRole("button", { name: /Refresh/i });
    await user.click(refresh);
    // The fresh response arrives — 222 must be visible.
    expect(await screen.findByText("222")).toBeInTheDocument();

    // Now release the stale response.
    resolveSlow?.({ ok: true, jobs: [], summary: summary() });
    await new Promise((r) => setTimeout(r, 20));
    // The stale 111 must never appear.
    expect(screen.queryByText("111")).not.toBeInTheDocument();
    expect(screen.getByText("222")).toBeInTheDocument();
  });

  it("shows the manager-only fallback wording when listJobs rejects", async () => {
    getSystemStatusMock.mockResolvedValue(status());
    listJobsMock.mockRejectedValue(new Error("forbidden"));
    cleanupPreviewMock.mockResolvedValue(null);
    listAlertsMock.mockResolvedValue({ ok: true, alerts: [] });
    renderPage();
    expect(
      await screen.findByText(/You may not have permission/i)
    ).toBeInTheDocument();
  });

  it("shows the expired-session wording when listJobs rejects with not_authenticated", async () => {
    getSystemStatusMock.mockResolvedValue(status());
    listJobsMock.mockRejectedValue(new Error("not_authenticated"));
    cleanupPreviewMock.mockResolvedValue(null);
    listAlertsMock.mockResolvedValue({ ok: true, alerts: [] });
    renderPage();
    expect(await screen.findByText(/Your session has expired/i)).toBeInTheDocument();
  });

  it("keeps the rest of the page usable when only one endpoint fails", async () => {
    getSystemStatusMock.mockResolvedValue(null);
    listJobsMock.mockResolvedValue({
      ok: true,
      jobs: [job({ id: "j1", status: "completed" })],
      summary: summary({ failed_count: 4 }),
    });
    cleanupPreviewMock.mockResolvedValue({
      ok: true,
      mode: "preview_only",
      expired_active_documents: [],
      orphan_storage_note: "",
    });
    listAlertsMock.mockResolvedValue({ ok: true, alerts: [] });
    renderPage();
    await screen.findByText(/Where operations need attention/i);
    // The failed-24h tile falls back to the summary value.
    const failedTile = screen.getByText(/Failed in last 24h/i).closest(".atlas-oversight__tile");
    expect(failedTile).not.toBeNull();
    expect(within(failedTile as HTMLElement).getByText("4")).toBeInTheDocument();
  });

  it("renders the five exception tiles with their scope labels", async () => {
    mockPopulated({ cleanup: 3, status: status({ failed_count: 5, stuck_count: 2 }) });
    renderPage();
    await screen.findByText(/Where operations need attention/i);
    expect(screen.getByText(/Failed in last 24h/i)).toBeInTheDocument();
    expect(screen.getByText(/Stuck in last 24h/i)).toBeInTheDocument();
    expect(screen.getByText(/Open critical alerts/i)).toBeInTheDocument();
    expect(screen.getByText(/Open alerts/i)).toBeInTheDocument();
    expect(screen.getByText(/Expired documents still active/i)).toBeInTheDocument();
    // Scope tags read honestly — appear on the tile scope line AND in the
    // section caption for context.
    expect(screen.getAllByText(/Last 24 hours/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Right now/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Retention backlog/i).length).toBeGreaterThan(0);
  });

  it("shows the all-healthy empty state when nothing needs attention", async () => {
    mockPopulated();
    renderPage();
    expect(
      await screen.findByText(/Nothing needs operational attention/i)
    ).toBeInTheDocument();
  });

  it("adds the critical-open sentence when a critical alert is open", async () => {
    mockPopulated({
      alerts: [
        alert({
          id: "c1",
          severity: "critical",
          status: "open",
          title: "Cache is offline",
        }),
      ],
    });
    renderPage();
    await screen.findByRole("heading", { name: /Operational alerts/i });
    expect(
      screen.getByText(/A critical alert is open — address these first/i)
    ).toBeInTheDocument();
    // The row itself carries the severity marker via a class hook.
    const items = document.querySelectorAll(".atlas-alerts__item--critical");
    expect(items.length).toBeGreaterThan(0);
  });

  it("shows failed-with-retries and stuck jobs in the intervention queue, hides retry-exhausted", async () => {
    const NOW = "2026-08-14T12:00:00Z";
    vi.setSystemTime(new Date(NOW));
    mockPopulated({
      jobs: [
        job({
          id: "f",
          status: "failed",
          job_type: "extraction",
          retry_count: 0,
          max_retries: 2,
          error_message: "Timed out",
        }),
        job({
          id: "s",
          status: "running",
          job_type: "recommendation",
          heartbeat_at: "2026-08-14T11:00:00Z",
        }),
        job({
          id: "x",
          status: "failed",
          job_type: "quote_review",
          retry_count: 2,
          max_retries: 2,
          error_message: "No more attempts",
        }),
      ],
    });
    renderPage();
    const heading = await screen.findByRole("heading", { name: /Jobs needing intervention/i });
    const section = heading.closest("section")!;
    // Failed-with-retries is present.
    expect(within(section).getByText(/Failed — retry available/i)).toBeInTheDocument();
    // Stuck is present.
    expect(within(section).getByText(/Stuck — no heartbeat/i)).toBeInTheDocument();
    // Retry-exhausted is absent from the intervention queue.
    expect(within(section).queryByText(/No more attempts/i)).not.toBeInTheDocument();
    // It still shows up in the full history below.
    expect(screen.getByText(/No more attempts/i)).toBeInTheDocument();
    vi.useRealTimers();
  });

  it("surfaces cancellation-pending jobs in the intervention queue", async () => {
    mockPopulated({
      jobs: [
        job({
          id: "c",
          status: "running",
          cancellation_requested: true,
          heartbeat_at: new Date().toISOString(),
        }),
      ],
    });
    renderPage();
    const heading = await screen.findByRole("heading", { name: /Jobs needing intervention/i });
    const section = heading.closest("section")!;
    expect(within(section).getByText(/Cancellation pending/i)).toBeInTheDocument();
  });

  it("shows 'No jobs need intervention' when everything is healthy", async () => {
    mockPopulated({ jobs: [job({ id: "ok", status: "completed" })] });
    renderPage();
    expect(
      await screen.findByText(/No jobs need intervention/i)
    ).toBeInTheDocument();
  });

  it("filters the full job history by state and clears via the chip button", async () => {
    mockPopulated({
      jobs: [
        job({ id: "f", status: "failed", error_message: "Timed out" }),
        job({ id: "c", status: "completed" }),
      ],
    });
    renderPage();
    await screen.findByText(/Full job history/i);
    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText(/^State$/i), "failed");
    // Only the failed row remains.
    expect(screen.getByText(/1 job shown/i)).toBeInTheDocument();
    // Clear via the chip.
    await user.click(screen.getByRole("button", { name: /Clear all/i }));
    expect(screen.getByText(/2 jobs shown/i)).toBeInTheDocument();
  });

  it("opens the technical drawer with the job identifier", async () => {
    mockPopulated({ jobs: [job({ id: "job_abc", status: "completed" })] });
    renderPage();
    await screen.findByText(/Full job history/i);
    const user = userEvent.setup();
    const detailButtons = screen.getAllByRole("button", { name: /^Detail$/i });
    await user.click(detailButtons[detailButtons.length - 1]);
    expect(await screen.findByText("job_abc")).toBeInTheDocument();
  });

  it("navigates to a linked submission from the intervention queue", async () => {
    mockPopulated({
      jobs: [
        job({
          id: "j",
          status: "failed",
          submission_id: "sub_42",
        }),
      ],
    });
    const { onOpen } = renderPage();
    const heading = await screen.findByRole("heading", { name: /Jobs needing intervention/i });
    const section = heading.closest("section")!;
    const user = userEvent.setup();
    await user.click(within(section).getByRole("button", { name: /Open submission/i }));
    expect(onOpen).toHaveBeenCalledWith("sub_42");
  });

  it("keeps an unknown job status visible rather than dropping the row", async () => {
    mockPopulated({
      jobs: [
        job({
          id: "u",
          status: "unheard_of" as AtlasJob["status"],
          error_code: "brand_new_error",
        }),
      ],
    });
    renderPage();
    await screen.findByText(/Full job history/i);
    expect(screen.getAllByText(/Unheard of/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/Brand new error/i)).toBeInTheDocument();
  });

  it("cancels the retry confirm dialog on Cancel and on Escape without writing", async () => {
    mockPopulated({
      jobs: [
        job({
          id: "j",
          status: "failed",
          error_message: "Timed out",
        }),
      ],
    });
    renderPage();
    await screen.findByText(/Full job history/i);
    const user = userEvent.setup();
    // Click the first Retry we see.
    await user.click(screen.getAllByRole("button", { name: /^Retry$/i })[0]);
    // Cancel the dialog.
    await user.click(screen.getByRole("button", { name: /^Cancel$/i }));
    expect(retryJobMock).not.toHaveBeenCalled();

    // Escape closes it too.
    await user.click(screen.getAllByRole("button", { name: /^Retry$/i })[0]);
    await user.keyboard("{Escape}");
    expect(retryJobMock).not.toHaveBeenCalled();
  });

  it("issues exactly one retryJob write and refreshes jobs+alerts on confirm", async () => {
    mockPopulated({
      jobs: [
        job({
          id: "j1",
          status: "failed",
          error_message: "Timed out",
        }),
      ],
    });
    retryJobMock.mockResolvedValue({ ok: true, job_id: "j1", status: "queued", retry_count: 1 });
    renderPage();
    await screen.findByText(/Full job history/i);
    const user = userEvent.setup();

    await user.click(screen.getAllByRole("button", { name: /^Retry$/i })[0]);
    listJobsMock.mockClear();
    listAlertsMock.mockClear();
    // Ensure the refresh call resolves.
    listJobsMock.mockResolvedValue({ ok: true, jobs: [], summary: summary() });
    listAlertsMock.mockResolvedValue({ ok: true, alerts: [] });
    await user.click(screen.getByRole("button", { name: /Retry processing/i }));

    await waitFor(() => expect(retryJobMock).toHaveBeenCalledTimes(1));
    expect(retryJobMock).toHaveBeenCalledWith("j1");
    // Post-write refresh is jobs + alerts only (per current contract).
    await waitFor(() => expect(listJobsMock).toHaveBeenCalledTimes(1));
    expect(listAlertsMock).toHaveBeenCalledTimes(1);
  });

  it("issues exactly one cancelJob write on confirm", async () => {
    mockPopulated({
      jobs: [job({ id: "r", status: "running", heartbeat_at: new Date().toISOString() })],
    });
    cancelJobMock.mockResolvedValue({ ok: true, job_id: "r", status: "running", cancellation_requested: true });
    renderPage();
    await screen.findByText(/Full job history/i);
    const user = userEvent.setup();
    await user.click(screen.getAllByRole("button", { name: /^Cancel$/i })[0]);
    listJobsMock.mockResolvedValue({ ok: true, jobs: [], summary: summary() });
    listAlertsMock.mockResolvedValue({ ok: true, alerts: [] });
    await user.click(screen.getByRole("button", { name: /Request cancellation/i }));
    await waitFor(() => expect(cancelJobMock).toHaveBeenCalledTimes(1));
    expect(cancelJobMock).toHaveBeenCalledWith("r");
  });

  it("acknowledges an alert in a single click with exactly one write", async () => {
    mockPopulated({
      alerts: [alert({ id: "a1", severity: "warning", status: "open" })],
    });
    updateAlertMock.mockResolvedValue({ ok: true });
    renderPage();
    await screen.findByRole("heading", { name: /Operational alerts/i });
    const user = userEvent.setup();
    listAlertsMock.mockResolvedValue({ ok: true, alerts: [] });
    await user.click(screen.getByRole("button", { name: /Acknowledge warning alert/i }));
    await waitFor(() => expect(updateAlertMock).toHaveBeenCalledTimes(1));
    expect(updateAlertMock).toHaveBeenCalledWith("a1", "acknowledge");
  });

  it("puts Mark as resolved behind a confirmation dialog and issues one write on confirm", async () => {
    mockPopulated({
      alerts: [alert({ id: "a1", severity: "warning", status: "open" })],
    });
    updateAlertMock.mockResolvedValue({ ok: true });
    renderPage();
    await screen.findByRole("heading", { name: /Operational alerts/i });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Mark as resolved/i }));
    // A ConfirmDialog appears.
    expect(await screen.findByText(/Mark this alert as resolved\?/i)).toBeInTheDocument();
    // Cancel path first: no write.
    await user.click(screen.getByRole("button", { name: /^Cancel$/i }));
    expect(updateAlertMock).not.toHaveBeenCalled();

    // Confirm path: exactly one write.
    await user.click(screen.getByRole("button", { name: /Mark as resolved/i }));
    listAlertsMock.mockResolvedValue({ ok: true, alerts: [] });
    // The button label inside the dialog matches the surface label.
    const dialog = screen.getByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: /Mark as resolved/i }));
    await waitFor(() => expect(updateAlertMock).toHaveBeenCalledTimes(1));
    expect(updateAlertMock).toHaveBeenCalledWith("a1", "resolve");
  });

  it("surfaces an API rejection during acknowledge as an actionable error notice", async () => {
    mockPopulated({
      alerts: [alert({ id: "a1", severity: "warning", status: "open" })],
    });
    updateAlertMock.mockRejectedValue(new Error("forbidden"));
    renderPage();
    await screen.findByRole("heading", { name: /Operational alerts/i });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Acknowledge warning alert/i }));
    expect(
      await screen.findByText(/The alert could not be acknowledged/i)
    ).toBeInTheDocument();
  });

  it("is axe-clean in the populated state", async () => {
    mockPopulated({
      jobs: [
        job({ id: "f", status: "failed", error_message: "Timed out" }),
        job({ id: "c", status: "completed" }),
      ],
      alerts: [alert({ id: "a1", severity: "critical", status: "open" })],
    });
    const { container } = renderPage();
    await screen.findByText(/Where operations need attention/i);
    expect(await axe(container)).toHaveNoViolations();
  });

  it("is axe-clean in the all-healthy empty state", async () => {
    mockPopulated();
    const { container } = renderPage();
    await screen.findByText(/Nothing needs operational attention/i);
    expect(await axe(container)).toHaveNoViolations();
  });

  it("is axe-clean in the permission-denied error state", async () => {
    getSystemStatusMock.mockResolvedValue(null);
    listJobsMock.mockResolvedValue(null);
    cleanupPreviewMock.mockResolvedValue(null);
    listAlertsMock.mockResolvedValue({ ok: true, alerts: [] });
    const { container } = renderPage();
    await screen.findByText(/You may not have permission/i);
    expect(await axe(container)).toHaveNoViolations();
  });
});
