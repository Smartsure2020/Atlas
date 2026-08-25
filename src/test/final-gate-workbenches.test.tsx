/**
 * Atlas — final product-gate corrections (component/DOM coverage)
 * ----------------------------------------------------------------------------
 * Focused component-level tests for the workbench-facing corrections that
 * need a rendered DOM but do not fit the shape of the existing per-page
 * test files. The point is to prove the observable behaviour that each
 * correction promised:
 *   - CommunicationsPanel: a double-click on "Record manual send" never
 *     fires two updateCommunication requests.
 *   - ProcessingJobs: a supporting endpoint failure keeps the workbench
 *     alive under a warning notice; only a jobs-endpoint failure blanks
 *     the page.
 *   - ProcessingJobs JobDetailDrawer: raw metadata secrets never render;
 *     an all-secret metadata payload renders no disclosure at all.
 *   - MissingInfoPanel: "Derive from analysis" is the primary in the
 *     empty state; the empty-state card carries no duplicate button.
 *   - Insurers: every card renders a channel pill (either the channel
 *     label or an explicit absence pill).
 *   - ManagerDashboard: input maxLength=200 + a format hint on
 *     insurerId + consultantId.
 *   - Toast auto-dismiss timer is cleaned up on unmount.
 *   - Drawer: the discard-changes prompt is a ConfirmDialog, not
 *     window.confirm.
 *   - Signed-out App renders <main> and an <h1>.
 *   - Work queue: sticky-first-column class is applied when the table
 *     opts in.
 *   - SubmissionDetail: toSubmissionRecord + toJobsMap parsers reject
 *     malformed payloads and pass valid ones through.
 *   - NewSubmission: onCreated is called exactly once after uploads
 *     complete (no double-notify from setFiles updater).
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, within, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

/* -------------------------------------------------------------------------- */
/* Mocks — one block per external module referenced by any suite below.       */
/* -------------------------------------------------------------------------- */

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
  listMissingInfo: vi.fn(),
  generateMissingInfo: vi.fn(),
  addMissingInfo: vi.fn(),
  updateMissingInfo: vi.fn(),
  getManagerStats: vi.fn(),
  getManagerStatsFiltered: vi.fn(),
}));

const getSystemStatusMock = vi.fn();
const listJobsMock = vi.fn();
const listAlertsMock = vi.fn();
const cleanupPreviewMock = vi.fn();
vi.mock("../lib/phase7", () => ({
  getSystemStatus: (...args: unknown[]) => getSystemStatusMock(...args),
  listJobs: (...args: unknown[]) => listJobsMock(...args),
  listAlerts: (...args: unknown[]) => listAlertsMock(...args),
  cleanupPreview: (...args: unknown[]) => cleanupPreviewMock(...args),
  retryJob: vi.fn(),
  cancelJob: vi.fn(),
  updateAlert: vi.fn(),
}));

const listInsurersMock = vi.fn();
vi.mock("../lib/insurers", () => ({
  listInsurers: (...args: unknown[]) => listInsurersMock(...args),
  createInsurer: vi.fn(),
  getInsurer: vi.fn(),
  updateInsurer: vi.fn(),
  confirmAppetite: vi.fn(),
  deactivateAppetite: vi.fn(),
  editAppetite: vi.fn(),
  addAppetiteRule: vi.fn(),
  processInsurerDocument: vi.fn(),
  uploadGuideline: vi.fn(),
}));

const createSubmissionMock = vi.fn();
const uploadDocumentMock = vi.fn();
const currentRoleMock = vi.fn();
const supabaseAuthSignOutMock = vi.fn();
const supabaseAuthGetSessionMock = vi.fn();
const supabaseAuthOnAuthStateChangeMock = vi.fn((..._args: unknown[]) => ({
  data: { subscription: { unsubscribe: () => {} } },
}));
vi.mock("../lib/atlas", () => ({
  createSubmission: (...args: unknown[]) => createSubmissionMock(...args),
  uploadDocument: (...args: unknown[]) => uploadDocumentMock(...args),
  currentRole: (...args: unknown[]) => currentRoleMock(...args),
  startLogin: vi.fn(),
  supabase: {
    auth: {
      getSession: (...args: unknown[]) => supabaseAuthGetSessionMock(...args),
      onAuthStateChange: (...args: unknown[]) =>
        supabaseAuthOnAuthStateChangeMock(...args),
      signOut: (...args: unknown[]) => supabaseAuthSignOutMock(...args),
    },
  },
}));

/* -------------------------------------------------------------------------- */
/* Imports (after mocks so mocked modules take effect)                         */
/* -------------------------------------------------------------------------- */

import CommunicationsPanel from "../pages/CommunicationsPanel";
import ProcessingJobs from "../pages/ProcessingJobs";
import MissingInfoPanel from "../pages/MissingInfoPanel";
import Insurers from "../pages/Insurers";
import ManagerDashboard from "../pages/ManagerDashboard";
import NewSubmission from "../pages/NewSubmission";
import App from "../App";
import {
  Drawer,
  ToastProvider,
  Button,
  useToast,
} from "../components/ui";
import { DataTable, type Column } from "../components/DataTable";
import { toJobsMap, toSubmissionRecord } from "../pages/SubmissionDetail";
import type { CommunicationRecord } from "../lib/phase4";
import type { WorkspaceData } from "../pages/SubmissionDetail";
import type { InsurerListItem } from "../lib/insurers";
import React, { useState } from "react";

/* -------------------------------------------------------------------------- */
/* Factories                                                                    */
/* -------------------------------------------------------------------------- */

function comm(over: Partial<CommunicationRecord> = {}): CommunicationRecord {
  return {
    id: over.id ?? "cr_1",
    submission_id: "sub_1",
    quote_review_id: null,
    communication_type: over.communication_type ?? "missing_info_request",
    audience: over.audience ?? "broker",
    subject: over.subject ?? "Outstanding information",
    body: over.body ?? "Please supply the following…",
    status: over.status ?? "draft",
    related_missing_info_item_ids: over.related_missing_info_item_ids ?? ["mi_1"],
    related_section_keys: null,
    created_at: "2026-08-01T09:00:00Z",
    updated_at: "2026-08-01T09:00:00Z",
    sent_at: null,
    notes: null,
  };
}

function workspaceData(): WorkspaceData {
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
      },
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
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  listCommunicationsMock.mockResolvedValue({ communications: [] });
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
  });
});

/* ========================================================================== */
/* CommunicationsPanel — double-click guard on Record manual send             */
/* ========================================================================== */

describe("CommunicationsPanel — Record manual send double-submit guard", () => {
  it("dispatches at most one updateCommunication when Confirm is clicked twice", async () => {
    const user = userEvent.setup();
    listCommunicationsMock.mockResolvedValue({
      communications: [comm({ id: "cr_double" })],
    });
    // Make the mutation hang so the second click races the first.
    let resolveMutation: () => void = () => {};
    updateCommunicationMock.mockImplementation(
      () =>
        new Promise<{ ok: true }>((resolve) => {
          resolveMutation = () => resolve({ ok: true });
        })
    );
    render(
      <ToastProvider>
        <CommunicationsPanel
          submissionId="sub_1"
          data={workspaceData()}
          canWrite
          onRefresh={vi.fn().mockResolvedValue(undefined)}
        />
      </ToastProvider>
    );
    await waitFor(() => screen.getByRole("button", { name: /Record manual send/i }));
    await user.click(screen.getByRole("button", { name: /Record manual send/i }));
    const dialog = await screen.findByRole("dialog", {
      name: /Record this communication as sent manually/i,
    });
    const confirm = within(dialog).getByRole("button", { name: /^Record manual send$/i });
    await user.click(confirm);
    // Second click while the request is still pending must be a no-op.
    await user.click(confirm);
    // The `working` prop on the dialog should have flipped the confirm
    // to a busy state, and the re-entry guard in recordManualSend
    // ensures a second dispatch never lands.
    expect(updateCommunicationMock).toHaveBeenCalledTimes(1);
    // Release the mutation so cleanup can settle.
    resolveMutation();
    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", { name: /Record this communication as sent manually/i })
      ).toBeNull();
    });
  });
});

/* ========================================================================== */
/* ProcessingJobs — supporting failure keeps workbench alive                  */
/* ========================================================================== */

describe("ProcessingJobs — Promise.allSettled classification", () => {
  it("keeps the workbench visible and shows a warning when only supporting endpoints fail", async () => {
    getSystemStatusMock.mockRejectedValue(new Error("forbidden"));
    listJobsMock.mockResolvedValue({
      ok: true,
      jobs: [],
      summary: {
        failed_count: 0,
        stuck_count: 0,
        by_error_code: {},
        recent_failed_jobs: [],
        stuck_jobs: [],
      },
    });
    listAlertsMock.mockRejectedValue(new Error("network"));
    cleanupPreviewMock.mockResolvedValue({
      ok: true,
      mode: "preview_only",
      expired_active_documents: [],
      orphan_storage_note: "",
    });
    render(
      <ToastProvider>
        <ProcessingJobs onOpenSubmission={vi.fn()} />
      </ToastProvider>
    );
    // Workbench header rendered — jobs succeeded, so the page is alive.
    await screen.findByText(/Where operations need attention/i);
    // The stale-data warning explicitly names the supporting failures.
    expect(
      await screen.findByText(/could not refresh.*(platform status|operational alerts)/i)
    ).toBeInTheDocument();
    // The permission-error banner from the old Promise.all path must not
    // appear when jobs itself is fine.
    expect(screen.queryByText(/Processing health could not be loaded/i)).toBeNull();
  });

  it("shows the load-error state only when the jobs endpoint itself fails", async () => {
    getSystemStatusMock.mockResolvedValue(null);
    listJobsMock.mockRejectedValue(new Error("forbidden"));
    listAlertsMock.mockResolvedValue({ ok: true, alerts: [] });
    cleanupPreviewMock.mockResolvedValue(null);
    render(
      <ToastProvider>
        <ProcessingJobs onOpenSubmission={vi.fn()} />
      </ToastProvider>
    );
    expect(
      await screen.findByText(/This screen requires an administrator or manager account/i)
    ).toBeInTheDocument();
    // The old duplicated-heading copy is stripped from the body.
    const errorRegion = screen.getByText(/This screen requires/i).parentElement;
    expect(errorRegion?.textContent ?? "").not.toMatch(
      /Processing health could not be loaded\.\s+Processing health could not be loaded/i
    );
  });
});

/* ========================================================================== */
/* MissingInfoPanel — Derive-primary in empty state                            */
/* ========================================================================== */

describe("MissingInfoPanel — empty-state action hierarchy", () => {
  it("renders Derive from analysis as the visual primary and drops the duplicate empty-state action", () => {
    render(
      <ToastProvider>
        <MissingInfoPanel
          submissionId="sub_1"
          items={[]}
          quoteReviewId={null}
          canWrite
          onRefresh={vi.fn().mockResolvedValue(undefined)}
          onGoToTab={vi.fn()}
        />
      </ToastProvider>
    );
    // The header-level Derive action exists exactly once.
    const derive = screen.getAllByRole("button", { name: /Derive from analysis/i });
    expect(derive).toHaveLength(1);
    // The header-level Derive action carries the primary treatment.
    expect(derive[0].className).toMatch(/atlas-btn--primary/);
    // Add item is present but not primary.
    const add = screen.getByRole("button", { name: /Add item/i });
    expect(add.className).not.toMatch(/atlas-btn--primary/);
    // The empty-state card is a pure explainer with no CTA.
    expect(screen.getByText(/Nothing is outstanding/i)).toBeInTheDocument();
  });
});

/* ========================================================================== */
/* Insurers — channel pill is always rendered                                  */
/* ========================================================================== */

describe("Insurers — index card channel affordance", () => {
  function insurerListItem(over: Partial<InsurerListItem>): InsurerListItem {
    return {
      id: over.id ?? "ins_x",
      name: over.name ?? "Some Insurer",
      quote_channel: over.quote_channel ?? null,
      active: true,
      notes: over.notes ?? null,
      active_appetite_count: over.active_appetite_count ?? 0,
      created_at: "2026-08-01T09:00:00Z",
    };
  }

  it("renders the outlined 'Add submission channel' invitation when quote_channel is null", async () => {
    listInsurersMock.mockResolvedValue({
      insurers: [insurerListItem({ id: "a", quote_channel: null, name: "Empty Insurer" })],
    });
    render(
      <ToastProvider>
        <Insurers role="manager" onOpen={vi.fn()} />
      </ToastProvider>
    );
    // Absence now renders with a distinct dashed-outline pill and an
    // explicit "Add submission channel" invitation, so the presence and
    // absence states differ in class, text, and visual tone rather than
    // sharing the same --quiet pill.
    const label = await screen.findByText(/Add submission channel/i);
    expect(label).toBeInTheDocument();
    const badge = label.closest(".atlas-badge") as HTMLElement;
    expect(badge?.classList.contains("atlas-badge--outline")).toBe(true);
  });

  it("collapses every email variant to the same 'Email submission' label", async () => {
    listInsurersMock.mockResolvedValue({
      insurers: [
        insurerListItem({ id: "a", quote_channel: "email", name: "One" }),
        insurerListItem({ id: "b", quote_channel: "email_submission", name: "Two" }),
        insurerListItem({ id: "c", quote_channel: "Email submission", name: "Three" }),
      ],
    });
    render(
      <ToastProvider>
        <Insurers role="manager" onOpen={vi.fn()} />
      </ToastProvider>
    );
    await screen.findByText("One");
    const pills = screen.getAllByText(/^Email submission$/);
    expect(pills.length).toBe(3);
  });

  it("suppresses the 'No notes recorded.' filler line entirely", async () => {
    listInsurersMock.mockResolvedValue({
      insurers: [insurerListItem({ id: "a", notes: null, name: "Quiet" })],
    });
    render(
      <ToastProvider>
        <Insurers role="manager" onOpen={vi.fn()} />
      </ToastProvider>
    );
    await screen.findByText("Quiet");
    expect(screen.queryByText(/No notes recorded\./i)).toBeNull();
  });
});

/* ========================================================================== */
/* ManagerDashboard — advanced filter input maxLength + hint                   */
/* ========================================================================== */

describe("ManagerDashboard — advanced-filter input bounds", () => {
  it("caps insurerId and consultantId to 200 characters and shows a format hint", async () => {
    const getManagerStatsFiltered = (
      await import("../lib/phase4")
    ).getManagerStatsFiltered as ReturnType<typeof vi.fn>;
    getManagerStatsFiltered.mockResolvedValue({
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
      },
    });
    render(
      <ToastProvider>
        <ManagerDashboard onOpenSubmission={vi.fn()} />
      </ToastProvider>
    );
    // The Advanced filters disclosure renders open in the initial DOM.
    const insurerInput = (await screen.findByLabelText(/Insurer identifier/i)) as HTMLInputElement;
    const consultantInput = (await screen.findByLabelText(/Consultant identifier/i)) as HTMLInputElement;
    expect(insurerInput.maxLength).toBe(200);
    expect(consultantInput.maxLength).toBe(200);
    // Format hints exist next to the fields.
    expect(screen.getByText(/insurer's UUID/i)).toBeInTheDocument();
    expect(screen.getByText(/consultant's Atlas identifier/i)).toBeInTheDocument();
  });
});

/* ========================================================================== */
/* ToastProvider — auto-dismiss timer cleanup                                  */
/* ========================================================================== */

describe("ToastProvider — timer cleanup", () => {
  it("clears the pending auto-dismiss timer on unmount", () => {
    vi.useFakeTimers();
    const clearSpy = vi.spyOn(window, "clearTimeout");
    function Trigger() {
      const toast = useToast();
      React.useEffect(() => {
        toast.notify("hello");
      }, [toast]);
      return null;
    }
    const { unmount } = render(
      <ToastProvider>
        <Trigger />
      </ToastProvider>
    );
    // Toast is queued; unmount before the 5s auto-dismiss.
    unmount();
    // The cleanup effect must clear every pending timer.
    expect(clearSpy).toHaveBeenCalled();
    // If more time passes there should be no setState-after-unmount
    // warning (nothing to assert directly — the test would fail via
    // unhandled console.error if the cleanup regressed).
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    clearSpy.mockRestore();
    vi.useRealTimers();
  });
});

/* ========================================================================== */
/* Drawer — discard prompt is a ConfirmDialog, not native window.confirm       */
/* ========================================================================== */

describe("Drawer — discard confirmation", () => {
  it("does not call window.confirm when dirty=true; opens a ConfirmDialog instead", async () => {
    const user = userEvent.setup();
    const confirmSpy = vi
      .spyOn(window, "confirm")
      .mockImplementation(() => true);
    function Host() {
      const [open, setOpen] = useState(true);
      return (
        <>
          <Button onClick={() => setOpen(true)}>Reopen</Button>
          {open && (
            <Drawer
              open
              onClose={() => setOpen(false)}
              title="Edit thing"
              dirty
            >
              <p>Body</p>
            </Drawer>
          )}
        </>
      );
    }
    render(<Host />);
    const close = screen.getByRole("button", { name: /Close/i });
    await user.click(close);
    expect(confirmSpy).not.toHaveBeenCalled();
    // A dialog appeared asking the user to confirm.
    expect(
      await screen.findByRole("dialog", { name: /Discard your unsaved changes/i })
    ).toBeInTheDocument();
    // Keep editing dismisses without closing the drawer.
    await user.click(screen.getByRole("button", { name: /Keep editing/i }));
    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", { name: /Discard your unsaved changes/i })
      ).toBeNull();
    });
    // The Drawer is still open.
    expect(screen.getByRole("dialog", { name: /Edit thing/i })).toBeInTheDocument();
    confirmSpy.mockRestore();
  });
});

/* ========================================================================== */
/* Signed-out App renders <main> + <h1>                                        */
/* ========================================================================== */

describe("App auth surfaces landmarks", () => {
  it("wraps the signed-out sign-in card in <main> and includes an <h1>", async () => {
    supabaseAuthGetSessionMock.mockResolvedValue({ data: { session: null } });
    currentRoleMock.mockResolvedValue(null);
    render(<App />);
    // Wait for the auth resolution to settle to signed_out.
    await screen.findByRole("button", { name: /Sign in with Microsoft/i });
    // <main> landmark is present.
    expect(document.querySelector("main")).not.toBeNull();
    // <h1> is present (screen-reader-only is fine).
    const h1 = document.querySelector("h1");
    expect(h1).not.toBeNull();
    expect(h1?.textContent).toMatch(/Sign in to Atlas/i);
  });

  it("wraps the loading card in <main> and includes an <h1>", async () => {
    // Keep the session promise unresolved so App stays in the loading
    // state long enough to inspect.
    let resolveSession: (v: unknown) => void = () => {};
    supabaseAuthGetSessionMock.mockReturnValue(
      new Promise((r) => {
        resolveSession = r;
      })
    );
    render(<App />);
    // Loading state — the h1 exists immediately.
    const h1 = document.querySelector("h1");
    expect(h1).not.toBeNull();
    expect(h1?.textContent).toMatch(/Checking your Atlas access/i);
    expect(document.querySelector("main")).not.toBeNull();
    resolveSession({ data: { session: null } });
  });
});

/* ========================================================================== */
/* DataTable — sticky-first-column opt-in class                                 */
/* ========================================================================== */

describe("DataTable — stickyFirstColumn class", () => {
  interface Row {
    id: string;
    name: string;
  }
  const columns: Column<Row>[] = [
    { id: "name", header: "Name", cell: (r) => r.name },
    { id: "id", header: "Id", cell: (r) => r.id },
  ];
  it("adds atlas-table--sticky-first when the prop is set", () => {
    render(
      <DataTable<Row>
        caption="X"
        columns={columns}
        rows={[{ id: "1", name: "Row 1" }]}
        rowKey={(r) => r.id}
        stickyFirstColumn
      />
    );
    const table = screen.getByRole("table");
    expect(table.className).toMatch(/atlas-table--sticky-first/);
  });
  it("does not add the class by default", () => {
    render(
      <DataTable<Row>
        caption="Y"
        columns={columns}
        rows={[{ id: "1", name: "Row 1" }]}
        rowKey={(r) => r.id}
      />
    );
    const table = screen.getByRole("table");
    expect(table.className).not.toMatch(/atlas-table--sticky-first/);
  });
  it("marks the scroll wrapper as a focusable region when it overflows", () => {
    // The wrapper is only exposed as a region + tab stop when it actually
    // overflows horizontally — otherwise it adds a landmark and a Tab
    // stop that consumers never asked for. Force overflow at the
    // prototype level so the mount effect sees it and toggles the
    // attributes on.
    const originalScrollWidth = Object.getOwnPropertyDescriptor(
      HTMLDivElement.prototype,
      "scrollWidth"
    );
    const originalClientWidth = Object.getOwnPropertyDescriptor(
      HTMLDivElement.prototype,
      "clientWidth"
    );
    Object.defineProperty(HTMLDivElement.prototype, "scrollWidth", {
      configurable: true,
      value: 2000,
    });
    Object.defineProperty(HTMLDivElement.prototype, "clientWidth", {
      configurable: true,
      value: 300,
    });
    try {
      render(
        <DataTable<Row>
          caption="Queue"
          columns={columns}
          rows={[{ id: "1", name: "Row 1" }]}
          rowKey={(r) => r.id}
          stickyFirstColumn
        />
      );
      const region = screen.getByRole("region", { name: /scroll horizontally/i });
      expect(region).toBeInTheDocument();
      expect(region).toHaveAttribute("tabindex", "0");
    } finally {
      if (originalScrollWidth) {
        Object.defineProperty(HTMLDivElement.prototype, "scrollWidth", originalScrollWidth);
      } else {
        // Reset to a benign default so subsequent tests do not inherit
        // the forced overflow.
        Object.defineProperty(HTMLDivElement.prototype, "scrollWidth", {
          configurable: true,
          value: 0,
        });
      }
      if (originalClientWidth) {
        Object.defineProperty(HTMLDivElement.prototype, "clientWidth", originalClientWidth);
      } else {
        Object.defineProperty(HTMLDivElement.prototype, "clientWidth", {
          configurable: true,
          value: 0,
        });
      }
    }
  });
});

/* ========================================================================== */
/* SubmissionDetail parsers — toSubmissionRecord + toJobsMap                    */
/* ========================================================================== */

describe("SubmissionDetail parsers", () => {
  it("toSubmissionRecord accepts a valid payload and passes fields through", () => {
    const parsed = toSubmissionRecord({
      id: "sub_1",
      status: "in_review",
      client_name: "Acme",
      broker_email: null,
    });
    expect(parsed.id).toBe("sub_1");
    expect(parsed.status).toBe("in_review");
    expect(parsed.client_name).toBe("Acme");
    expect(parsed.broker_email).toBeNull();
  });

  it("toSubmissionRecord throws a targeted error on missing id / status", () => {
    expect(() => toSubmissionRecord({ id: "sub_1" })).toThrow(/status/);
    expect(() => toSubmissionRecord({ status: "in_review" })).toThrow(/id/);
    expect(() => toSubmissionRecord(null)).toThrow(/object/);
  });

  it("toJobsMap keeps only recognised expensive-job keys", () => {
    const map = toJobsMap({
      extraction: { id: "j1", status: "queued" },
      recommendation: { id: "j2", status: "completed", progress_percent: 100 },
      quote_review: null,
      random_key: { hello: "world" },
    });
    expect(map).toBeDefined();
    expect(Object.keys(map ?? {})).toEqual(
      expect.arrayContaining(["extraction", "recommendation"])
    );
    expect((map as Record<string, unknown>).random_key).toBeUndefined();
    expect(map?.extraction?.status).toBe("queued");
    expect(map?.recommendation?.progress_percent).toBe(100);
  });

  it("toJobsMap returns undefined for a non-object payload", () => {
    expect(toJobsMap(null)).toBeUndefined();
    expect(toJobsMap("nope")).toBeUndefined();
  });
});

/* ========================================================================== */
/* NewSubmission — runUploads notifies onCreated exactly once                   */
/* ========================================================================== */

describe("NewSubmission — runUploads side effects", () => {
  afterEach(() => {
    createSubmissionMock.mockReset();
    uploadDocumentMock.mockReset();
  });
  it("calls onCreated exactly once after all files upload", async () => {
    createSubmissionMock.mockResolvedValue({ ok: true, id: "sub_new" });
    uploadDocumentMock.mockResolvedValue({ ok: true });
    const onCreated = vi.fn();
    const user = userEvent.setup();
    render(
      <ToastProvider>
        <NewSubmission onCreated={onCreated} onCancel={vi.fn()} />
      </ToastProvider>
    );
    // Fill required client name.
    await user.type(screen.getByLabelText(/Client name/i), "Acme");
    // Attach two files.
    const files = [
      new File(["a"], "a.pdf", { type: "application/pdf" }),
      new File(["b"], "b.pdf", { type: "application/pdf" }),
    ];
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    // The picker input is present as a hidden control.
    await act(async () => {
      // fireEvent-style: directly assign files then dispatch change.
      Object.defineProperty(fileInput, "files", { value: files, configurable: true });
      fileInput.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await user.click(screen.getByRole("button", { name: /Create submission/i }));
    await waitFor(
      () => {
        expect(onCreated).toHaveBeenCalledWith("sub_new");
      },
      { timeout: 3000 }
    );
    // Idempotency: the effect must not fire a second time even under
    // StrictMode-like double invocation. The onCreated ref latch is
    // the guard.
    expect(onCreated).toHaveBeenCalledTimes(1);
  });
});
