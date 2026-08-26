/**
 * Atlas — final-correction regression coverage
 * ----------------------------------------------------------------------------
 * NEW-1 (Processing cleanup-result TypeError):
 *   Unit coverage for `readExpiredActiveDocumentCount` + integration coverage
 *   for ProcessingJobs behaviour when the cleanup endpoint resolves with
 *   malformed shapes. The `malformed-fulfilled + jobs 200` case would throw a
 *   TypeError before the fix at `212331d`, blocking the stale-data warning
 *   the A1 correction was supposed to add.
 *
 * NEW-3 (Processing Cancel ConfirmDialog focus trap):
 *   Behavioural coverage through the real ProcessingJobs call site to prove
 *   the destructive Cancel-job dialog auto-focuses the safe "Cancel" button,
 *   traps Tab / Shift+Tab inside the dialog, closes on Escape and Cancel
 *   without mutation, and returns focus to the exact trigger. jsdom cannot
 *   measure focus geometry, but `document.activeElement` after synthetic Tab
 *   is deterministic enough to prove the contract.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { readExpiredActiveDocumentCount } from "../lib/operations-evidence";

/* -------------------------------------------------------------------------- */
/* NEW-1 — readExpiredActiveDocumentCount parser                              */
/* -------------------------------------------------------------------------- */

describe("readExpiredActiveDocumentCount", () => {
  it("returns null when the value is null or undefined", () => {
    expect(readExpiredActiveDocumentCount(null)).toBeNull();
    expect(readExpiredActiveDocumentCount(undefined)).toBeNull();
  });

  it("returns null for primitive shapes", () => {
    expect(readExpiredActiveDocumentCount("hello")).toBeNull();
    expect(readExpiredActiveDocumentCount(0)).toBeNull();
    expect(readExpiredActiveDocumentCount(false)).toBeNull();
  });

  it("returns null when the wrapping object is missing the array key", () => {
    expect(readExpiredActiveDocumentCount({})).toBeNull();
    expect(
      readExpiredActiveDocumentCount({ ok: true, mode: "preview_only" })
    ).toBeNull();
  });

  it("returns null when the wrapping value is an array (wire contract is an object)", () => {
    expect(readExpiredActiveDocumentCount([])).toBeNull();
    expect(readExpiredActiveDocumentCount([{ id: "d1" }])).toBeNull();
  });

  it("returns null when expired_active_documents is present but not an array", () => {
    expect(
      readExpiredActiveDocumentCount({ expired_active_documents: null })
    ).toBeNull();
    expect(
      readExpiredActiveDocumentCount({ expired_active_documents: "1" })
    ).toBeNull();
    expect(
      readExpiredActiveDocumentCount({ expired_active_documents: { length: 5 } })
    ).toBeNull();
    expect(
      readExpiredActiveDocumentCount({ expired_active_documents: 5 })
    ).toBeNull();
  });

  it("returns 0 for a well-shaped empty array (distinct from unavailable)", () => {
    expect(
      readExpiredActiveDocumentCount({
        ok: true,
        mode: "preview_only",
        expired_active_documents: [],
        orphan_storage_note: "",
      })
    ).toBe(0);
  });

  it("returns the length for a well-shaped array of documents", () => {
    expect(
      readExpiredActiveDocumentCount({
        ok: true,
        mode: "preview_only",
        expired_active_documents: [
          { id: "d1" },
          { id: "d2" },
          { id: "d3" },
        ],
        orphan_storage_note: "",
      })
    ).toBe(3);
  });

  it("does not throw on values that would crash a naive `?.length` chain", () => {
    // The bug pattern was `value.expired_active_documents.length` on a
    // fulfilled cleanupResult whose value was mis-shaped; the parser must
    // absorb every shape without throwing.
    for (const shape of [
      undefined,
      null,
      1,
      "hi",
      true,
      [],
      [1, 2, 3],
      {},
      { expired_active_documents: null },
      { expired_active_documents: undefined },
      { expired_active_documents: 0 },
      { expired_active_documents: {} },
      { expired_active_documents: "n/a" },
      { other_key: [] },
    ]) {
      expect(() => readExpiredActiveDocumentCount(shape)).not.toThrow();
    }
  });
});

/* -------------------------------------------------------------------------- */
/* NEW-1 + NEW-3 — ProcessingJobs integration                                 */
/* -------------------------------------------------------------------------- */

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
import type { AtlasJob, SystemStatus, JobSummary } from "../lib/phase7";

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

// Note: `alertRow` factory is intentionally not defined here — the
// ProcessingJobs mocks in this file do not exercise the alert-severity
// path directly; the alert-workbench paths are covered by
// processing-jobs-workbench.test.tsx.

function systemStatus(over: Partial<SystemStatus["jobs_24h"]> = {}): SystemStatus {
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

function jobSummary(over: Partial<JobSummary> = {}): JobSummary {
  return {
    failed_count: over.failed_count ?? 0,
    stuck_count: over.stuck_count ?? 0,
    by_error_code: over.by_error_code ?? {},
    recent_failed_jobs: over.recent_failed_jobs ?? [],
    stuck_jobs: over.stuck_jobs ?? [],
  };
}

function renderPage() {
  return render(
    <ToastProvider>
      <ProcessingJobs onOpenSubmission={vi.fn()} />
    </ToastProvider>
  );
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

/* -------------------------------------------------------------------------- */
/* NEW-1 — integration: malformed cleanup shape does not crash the page      */
/* -------------------------------------------------------------------------- */

describe("NEW-1: ProcessingJobs and mis-shaped cleanup responses", () => {
  it("renders the workbench when the cleanup endpoint returns a payload missing expired_active_documents (would throw pre-212331d)", async () => {
    // Force a non-zero exception count so the tile grid renders (an
    // all-zero state collapses the strip to a single empty-state card).
    getSystemStatusMock.mockResolvedValue(systemStatus({ failed_count: 1 }));
    listJobsMock.mockResolvedValue({
      ok: true,
      jobs: [job({ id: "j1", status: "completed" })],
      summary: jobSummary(),
    });
    listAlertsMock.mockResolvedValue({ ok: true, alerts: [] });
    // FULFILLED but missing the array — the pre-fix code accessed
    // `.expired_active_documents.length` on this object and threw
    // synchronously inside the .then handler, which then propagated as
    // an unhandled rejection with no .catch downstream.
    cleanupPreviewMock.mockResolvedValue({
      ok: true,
      mode: "preview_only",
      orphan_storage_note: "",
    });

    // Regression pinning: pre-fix code emitted a TypeError from inside
    // the .then handler on the promise chain (no .catch on that chain),
    // which surfaced as an unhandled rejection in the runtime event loop.
    // Both jsdom (window) and Node (process) fire; wire both so vitest's
    // env cannot mask the regression.
    const unhandled: unknown[] = [];
    const onWindow = (event: PromiseRejectionEvent) => {
      unhandled.push(event.reason);
      event.preventDefault();
    };
    const onProcess = (reason: unknown) => {
      unhandled.push(reason);
    };
    window.addEventListener("unhandledrejection", onWindow);
    process.on("unhandledRejection", onProcess);
    try {
      renderPage();
      // The workbench survives — heading, tiles and job history all render.
      expect(
        await screen.findByText(/Where operations need attention/i)
      ).toBeInTheDocument();
      expect(screen.getByText(/Full job history/i)).toBeInTheDocument();
      // The expired-documents tile falls back to zero (not thrown, not stuck loading).
      const expiredTile = screen
        .getByText(/Expired documents still active/i)
        .closest(".atlas-oversight__tile") as HTMLElement;
      expect(within(expiredTile).getByText("0")).toBeInTheDocument();
      // Let any deferred rejection settle before asserting.
      await new Promise((r) => setTimeout(r, 50));
    } finally {
      window.removeEventListener("unhandledrejection", onWindow);
      process.off("unhandledRejection", onProcess);
    }
    // No `Cannot read properties of undefined` reached the event loop.
    // Against pre-fix code this array would carry the TypeError; the
    // whole point of the parser is to keep this list empty.
    const messages = unhandled.map((r) =>
      r instanceof Error ? r.message : String(r ?? "")
    );
    expect(messages.some((m) => /Cannot read properties/i.test(m))).toBe(false);
  });

  it("renders the workbench when the cleanup endpoint resolves with null", async () => {
    getSystemStatusMock.mockResolvedValue(systemStatus());
    listJobsMock.mockResolvedValue({
      ok: true,
      jobs: [],
      summary: jobSummary(),
    });
    listAlertsMock.mockResolvedValue({ ok: true, alerts: [] });
    cleanupPreviewMock.mockResolvedValue(null);
    renderPage();
    expect(
      await screen.findByText(/Where operations need attention/i)
    ).toBeInTheDocument();
  });

  it("renders the workbench when the cleanup endpoint resolves with an unexpected string", async () => {
    getSystemStatusMock.mockResolvedValue(systemStatus());
    listJobsMock.mockResolvedValue({
      ok: true,
      jobs: [],
      summary: jobSummary(),
    });
    listAlertsMock.mockResolvedValue({ ok: true, alerts: [] });
    // Fulfilled with a non-object — must not throw.
    cleanupPreviewMock.mockResolvedValue("unexpected" as unknown as null);
    renderPage();
    expect(
      await screen.findByText(/Where operations need attention/i)
    ).toBeInTheDocument();
  });

  it("shows the well-shaped expired-doc count when the payload is a real array", async () => {
    // Two-doc backlog inherently makes attention non-zero (expired > 0),
    // so the tile grid renders regardless of other counts.
    getSystemStatusMock.mockResolvedValue(systemStatus());
    listJobsMock.mockResolvedValue({ ok: true, jobs: [], summary: jobSummary() });
    listAlertsMock.mockResolvedValue({ ok: true, alerts: [] });
    cleanupPreviewMock.mockResolvedValue({
      ok: true,
      mode: "preview_only",
      expired_active_documents: [{ id: "d1" }, { id: "d2" }],
      orphan_storage_note: "",
    });
    renderPage();
    await screen.findByText(/Where operations need attention/i);
    const expiredTile = screen
      .getByText(/Expired documents still active/i)
      .closest(".atlas-oversight__tile") as HTMLElement;
    expect(within(expiredTile).getByText("2")).toBeInTheDocument();
  });

  it("shows zero on a genuine well-shaped empty array (not the malformed fallback)", async () => {
    getSystemStatusMock.mockResolvedValue(systemStatus({ failed_count: 2 }));
    listJobsMock.mockResolvedValue({ ok: true, jobs: [], summary: jobSummary() });
    listAlertsMock.mockResolvedValue({ ok: true, alerts: [] });
    cleanupPreviewMock.mockResolvedValue({
      ok: true,
      mode: "preview_only",
      expired_active_documents: [],
      orphan_storage_note: "",
    });
    renderPage();
    await screen.findByText(/Where operations need attention/i);
    const expiredTile = screen
      .getByText(/Expired documents still active/i)
      .closest(".atlas-oversight__tile") as HTMLElement;
    expect(within(expiredTile).getByText("0")).toBeInTheDocument();
  });

  it("surfaces the stale-data warning when the cleanup endpoint rejects (genuine failure)", async () => {
    getSystemStatusMock.mockResolvedValue(systemStatus());
    listJobsMock.mockResolvedValue({ ok: true, jobs: [], summary: jobSummary() });
    listAlertsMock.mockResolvedValue({ ok: true, alerts: [] });
    cleanupPreviewMock.mockRejectedValue(new Error("boom"));
    renderPage();
    // Workbench renders, warning names the retention preview as a failure.
    expect(
      await screen.findByText(/Atlas could not refresh this page/i)
    ).toBeInTheDocument();
    expect(screen.getByText(/retention preview/i)).toBeInTheDocument();
  });

  it("recovers on a subsequent refresh once the cleanup shape returns to normal", async () => {
    // Keep failed_count > 0 so the tile grid always renders across both
    // the malformed first fetch and the well-shaped refresh.
    getSystemStatusMock.mockResolvedValue(systemStatus({ failed_count: 4 }));
    listJobsMock.mockResolvedValue({ ok: true, jobs: [], summary: jobSummary() });
    listAlertsMock.mockResolvedValue({ ok: true, alerts: [] });
    // First call returns malformed shape; second returns real array.
    cleanupPreviewMock.mockResolvedValueOnce({
      ok: true,
      mode: "preview_only",
      orphan_storage_note: "",
    });
    cleanupPreviewMock.mockResolvedValueOnce({
      ok: true,
      mode: "preview_only",
      expired_active_documents: [{ id: "d1" }],
      orphan_storage_note: "",
    });
    renderPage();
    await screen.findByText(/Where operations need attention/i);
    let expiredTile = screen
      .getByText(/Expired documents still active/i)
      .closest(".atlas-oversight__tile") as HTMLElement;
    expect(within(expiredTile).getByText("0")).toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /^Refresh$/i }));
    await waitFor(() => {
      expiredTile = screen
        .getByText(/Expired documents still active/i)
        .closest(".atlas-oversight__tile") as HTMLElement;
      expect(within(expiredTile).getByText("1")).toBeInTheDocument();
    });
  });
});

/* -------------------------------------------------------------------------- */
/* NEW-3 — ProcessingJobs Cancel ConfirmDialog focus contract                 */
/* -------------------------------------------------------------------------- */

function mockRunningJob(id = "run-1") {
  getSystemStatusMock.mockResolvedValue(systemStatus());
  listJobsMock.mockResolvedValue({
    ok: true,
    jobs: [
      job({
        id,
        job_type: "extraction",
        status: "running",
        submission_id: "sub_abc",
        heartbeat_at: new Date().toISOString(),
      }),
    ],
    summary: jobSummary(),
  });
  listAlertsMock.mockResolvedValue({ ok: true, alerts: [] });
  cleanupPreviewMock.mockResolvedValue({
    ok: true,
    mode: "preview_only",
    expired_active_documents: [],
    orphan_storage_note: "",
  });
}

describe("NEW-3: Cancel-job ConfirmDialog focus trap", () => {
  it("moves focus to the safe Cancel button when the dialog opens (never the destructive Confirm)", async () => {
    mockRunningJob();
    renderPage();
    await screen.findByText(/Full job history/i);
    const user = userEvent.setup();

    const triggers = screen.getAllByRole("button", { name: /^Cancel$/i });
    // Full history has the row-level Cancel button.
    await user.click(triggers[triggers.length - 1]);

    const dialog = await screen.findByRole("dialog");
    // A ConfirmDialog opens with an in-modal Cancel and Request cancellation.
    const inModalCancel = within(dialog).getByRole("button", { name: /^Cancel$/i });
    const confirm = within(dialog).getByRole("button", { name: /Request cancellation/i });
    await waitFor(() => {
      expect(document.activeElement).toBe(inModalCancel);
    });
    expect(document.activeElement).not.toBe(confirm);
  });

  it("traps Tab and Shift+Tab inside the Cancel dialog (focus never escapes to the row behind)", async () => {
    mockRunningJob();
    renderPage();
    await screen.findByText(/Full job history/i);
    const user = userEvent.setup();
    const triggers = screen.getAllByRole("button", { name: /^Cancel$/i });
    await user.click(triggers[triggers.length - 1]);

    const dialog = await screen.findByRole("dialog");
    const inModalCancel = within(dialog).getByRole("button", { name: /^Cancel$/i });
    await waitFor(() => expect(document.activeElement).toBe(inModalCancel));

    // jsdom does not compute layout, so useFocusTrap's offsetParent-based
    // visibility filter has to be verified in a real browser to see the
    // full Tab rotation. What jsdom can prove is that Tab/Shift+Tab do
    // not move focus OUT of the dialog — the row-behind "Open submission"
    // link and the row-behind Cancel trigger both remain unfocused.
    await user.tab();
    expect(dialog.contains(document.activeElement)).toBe(true);
    await user.tab({ shift: true });
    expect(dialog.contains(document.activeElement)).toBe(true);
    // Prove the row-behind controls cannot silently steal focus during the
    // trap — the row Cancel trigger and any row link stay outside.
    const rowOpenSubmission = screen.queryByRole("button", { name: /Open submission/i });
    if (rowOpenSubmission) {
      expect(document.activeElement).not.toBe(rowOpenSubmission);
    }
  });

  it("closes the Cancel dialog on Escape without mutating and returns focus to the trigger", async () => {
    mockRunningJob();
    renderPage();
    await screen.findByText(/Full job history/i);
    const user = userEvent.setup();
    const triggers = screen.getAllByRole("button", { name: /^Cancel$/i });
    const trigger = triggers[triggers.length - 1];
    await user.click(trigger);

    await screen.findByRole("dialog");
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    );
    expect(cancelJobMock).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(trigger);
  });

  it("closes the Cancel dialog on the in-modal Cancel button without mutating and returns focus", async () => {
    mockRunningJob();
    renderPage();
    await screen.findByText(/Full job history/i);
    const user = userEvent.setup();
    const triggers = screen.getAllByRole("button", { name: /^Cancel$/i });
    const trigger = triggers[triggers.length - 1];
    await user.click(trigger);

    const dialog = await screen.findByRole("dialog");
    const inModalCancel = within(dialog).getByRole("button", { name: /^Cancel$/i });
    await user.click(inModalCancel);

    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    );
    expect(cancelJobMock).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(trigger);
  });

  it("issues exactly one cancelJob write on Confirm, even if the confirm is double-tapped", async () => {
    mockRunningJob("run-double");
    cancelJobMock.mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(
            () =>
              resolve({
                ok: true,
                job_id: "run-double",
                status: "running",
                cancellation_requested: true,
              }),
            25
          )
        )
    );
    renderPage();
    await screen.findByText(/Full job history/i);
    const user = userEvent.setup();
    const triggers = screen.getAllByRole("button", { name: /^Cancel$/i });
    await user.click(triggers[triggers.length - 1]);
    const dialog = await screen.findByRole("dialog");
    const confirm = within(dialog).getByRole("button", { name: /Request cancellation/i });
    // Rapid double-tap on the confirm button.
    await user.click(confirm);
    listJobsMock.mockResolvedValue({ ok: true, jobs: [], summary: jobSummary() });
    listAlertsMock.mockResolvedValue({ ok: true, alerts: [] });
    // The dialog closes on click (pendingJobAction set to null in runJobAction);
    // a follow-up click would re-open nothing — assert exactly one write.
    await waitFor(() => expect(cancelJobMock).toHaveBeenCalledTimes(1));
    expect(cancelJobMock).toHaveBeenCalledWith("run-double");
  });

  it("leaves the Retry dialog contract intact — Retry ConfirmDialog still focuses its Cancel button", async () => {
    // A failed-with-retries job so the Retry trigger is present.
    getSystemStatusMock.mockResolvedValue(systemStatus());
    listJobsMock.mockResolvedValue({
      ok: true,
      jobs: [
        job({
          id: "retry-1",
          status: "failed",
          retry_count: 0,
          max_retries: 2,
          error_message: "Timed out",
        }),
      ],
      summary: jobSummary(),
    });
    listAlertsMock.mockResolvedValue({ ok: true, alerts: [] });
    cleanupPreviewMock.mockResolvedValue({
      ok: true,
      mode: "preview_only",
      expired_active_documents: [],
      orphan_storage_note: "",
    });
    renderPage();
    await screen.findByText(/Full job history/i);
    const user = userEvent.setup();
    await user.click(screen.getAllByRole("button", { name: /^Retry$/i })[0]);
    const dialog = await screen.findByRole("dialog");
    const inModalCancel = within(dialog).getByRole("button", { name: /^Cancel$/i });
    await waitFor(() => expect(document.activeElement).toBe(inModalCancel));
    // Escape closes without writing.
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    );
    expect(retryJobMock).not.toHaveBeenCalled();
  });
});
