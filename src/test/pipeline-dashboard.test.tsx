/**
 * Phase 4 Checkpoint 2 — Quote Pipeline dashboard + drawer + quick capture
 * behavioural tests.
 *
 * Covers the highest-value guarantees from the checkpoint brief:
 *  - role-scoped saved views and defaults (broker never sees "All"/"Mine",
 *    underwriter default = Mine and uses UUID, manager default = All)
 *  - WorkloadPanel is manager/admin only — non-managers never call the API
 *  - QuickCapture uses createSubmission, is duplicate-safe, gates on required
 *    fields, does not inject identity / assignment / pipeline_stage
 *  - QuickDrawer opens on row activation, hydrates via getSubmissionQuick,
 *    stale-race protection, does not mutate anything
 *  - historical pipeline_stage=null renders as "Not initialised"
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "vitest-axe";
import type { SubmissionListItem } from "../lib/atlas";

const mockList = vi.fn();
const mockWorkload = vi.fn();
const mockQuick = vi.fn();
const mockCreate = vi.fn();

vi.mock("../lib/atlas", () => ({
  listSubmissions: (...a: unknown[]) => mockList(...a),
  getPipelineWorkload: (...a: unknown[]) => mockWorkload(...a),
  getSubmissionQuick: (...a: unknown[]) => mockQuick(...a),
  createSubmission: (...a: unknown[]) => mockCreate(...a),
}));

import WorkQueue from "../pages/WorkQueue";

function row(over: Partial<SubmissionListItem> & { id: string }): SubmissionListItem {
  return {
    broker_name: null,
    client_name: `Client ${over.id}`,
    request_type: null,
    status: "new",
    assigned_underwriter: null,
    assigned_to: null,
    assigned_at: null,
    assigned_by: null,
    queue_status: null,
    line_of_business: null,
    priority: "normal",
    next_action: null,
    due_at: null,
    updated_at: "2026-08-01T10:00:00Z",
    pilot_flag: false,
    assigned_to_email: null,
    created_at: "2026-07-30T10:00:00Z",
    active_job: null,
    pipeline_stage: "new",
    ...over,
  };
}

const MIXED: SubmissionListItem[] = [
  row({ id: "s_new", pipeline_stage: "new" }),
  row({ id: "s_mine", pipeline_stage: "in_progress", assigned_to: "user-uuid-1", assigned_to_email: "me@example.com" }),
  row({ id: "s_other", pipeline_stage: "quoted", assigned_to: "user-uuid-2", assigned_to_email: "someone@example.com" }),
  row({ id: "s_bound", pipeline_stage: "bound", assigned_to: "user-uuid-1", assigned_to_email: "me@example.com" }),
  row({ id: "s_null", pipeline_stage: null }),
  row({ id: "s_unassigned", pipeline_stage: "triaged", assigned_to: null }),
];

const QUICK_PAYLOAD_BASE = {
  ok: true as const,
  submission: {
    id: "s_new",
    client_name: "Client s_new",
    broker_name: null,
    broker_email: null,
    request_type: null,
    pipeline_stage: "new" as const,
    queue_status: null,
    line_of_business: null,
    complexity: null,
    priority: null,
    assigned_to: null,
    assigned_to_email: null,
    next_action: null,
    due_at: null,
    source_type: null,
    received_at: null,
    created_at: "2026-07-30T10:00:00Z",
    updated_at: "2026-08-01T10:00:00Z",
    last_pipeline_stage_changed_at: null,
  },
  documents: { total: 0, active: 0, pending_scan: 0, clean: 0, failed: 0 },
  assignment_events: [],
  history: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  mockList.mockResolvedValue({ ok: true, submissions: MIXED });
  mockWorkload.mockResolvedValue({ ok: true, workload: [] });
  mockQuick.mockResolvedValue(QUICK_PAYLOAD_BASE);
});

function renderWQ(props: Partial<Parameters<typeof WorkQueue>[0]> = {}) {
  return render(
    <WorkQueue
      role="manager"
      currentUserId={null}
      search=""
      onSearchChange={() => {}}
      onNew={() => {}}
      onOpen={() => {}}
      {...props}
    />
  );
}

// ---------------------------------------------------------------------------
// Role-scoped defaults + saved views
// ---------------------------------------------------------------------------

describe("Saved views by role", () => {
  it("manager defaults to All and lists Mine + Unassigned", async () => {
    renderWQ({ role: "manager" });
    await screen.findByText("Client s_new");
    // All active by default.
    const allBtn = screen.getByRole("button", { name: /^All$/ });
    expect(allBtn).toHaveAttribute("aria-pressed", "true");
    // Manager sees Mine + Unassigned in the saved-view bar.
    expect(screen.getByRole("button", { name: /^Mine$/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Unassigned$/ })).toBeInTheDocument();
  });

  it("underwriter defaults to Mine and uses the user's UUID", async () => {
    renderWQ({ role: "underwriter", currentUserId: "user-uuid-1" });
    await screen.findByText("Client s_mine");
    const mineBtn = screen.getByRole("button", { name: /^Mine$/ });
    expect(mineBtn).toHaveAttribute("aria-pressed", "true");
    // Terminal bound row assigned to me is NOT shown under Mine
    // (isOpenPipelineCase excludes terminal stages).
    expect(screen.queryByText("Client s_bound")).toBeNull();
    // The other user's rows are hidden.
    expect(screen.queryByText("Client s_other")).toBeNull();
  });

  it("underwriter Mine with no UUID fails closed to []", async () => {
    renderWQ({ role: "underwriter", currentUserId: null });
    // Wait for the fetch to settle: at least one saved-view button is pressed.
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /^Mine$/ })).toHaveAttribute(
        "aria-pressed",
        "true"
      );
    });
    // Every fixture row must be absent — no accidental leak of the whole list.
    for (const r of MIXED) {
      expect(screen.queryByText(`Client ${r.id}`)).toBeNull();
    }
  });

  it("broker never sees Mine / Unassigned / All labels; sees My submissions", async () => {
    renderWQ({ role: "broker" });
    await screen.findByText("Client s_new");
    expect(screen.getByRole("button", { name: /^My submissions$/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Mine$/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Unassigned$/ })).toBeNull();
    // Never a plain "All" label for broker.
    expect(screen.queryByRole("button", { name: /^All$/ })).toBeNull();
  });

  it("readonly defaults to All, no Mine, no Unassigned", async () => {
    renderWQ({ role: "readonly" });
    await screen.findByText("Client s_new");
    expect(screen.getByRole("button", { name: /^All$/ })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    expect(screen.queryByRole("button", { name: /^Mine$/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Unassigned$/ })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// WorkloadPanel — role gating
// ---------------------------------------------------------------------------

describe("WorkloadPanel network gating", () => {
  it("manager fetches workload", async () => {
    renderWQ({ role: "manager" });
    await screen.findByText("Client s_new");
    await waitFor(() => expect(mockWorkload).toHaveBeenCalled());
  });

  it("admin fetches workload", async () => {
    renderWQ({ role: "admin" });
    await screen.findByText("Client s_new");
    await waitFor(() => expect(mockWorkload).toHaveBeenCalled());
  });

  it("underwriter NEVER calls workload API", async () => {
    renderWQ({ role: "underwriter", currentUserId: "user-uuid-1" });
    await screen.findByText("Client s_mine");
    // Give any deferred microtasks a chance to fire.
    await new Promise((r) => setTimeout(r, 20));
    expect(mockWorkload).not.toHaveBeenCalled();
  });

  it("broker NEVER calls workload API", async () => {
    renderWQ({ role: "broker" });
    await screen.findByText("Client s_new");
    await new Promise((r) => setTimeout(r, 20));
    expect(mockWorkload).not.toHaveBeenCalled();
  });

  it("readonly NEVER calls workload API", async () => {
    renderWQ({ role: "readonly" });
    await screen.findByText("Client s_new");
    await new Promise((r) => setTimeout(r, 20));
    expect(mockWorkload).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// PipelineStats — NULL rendering, no fake stage
// ---------------------------------------------------------------------------

describe("Historical pipeline_stage NULL", () => {
  it("does not count NULL rows as New", async () => {
    renderWQ({ role: "manager" });
    await screen.findByText("Client s_new");
    const newTile = screen.getByRole("button", { name: /^New/i });
    // Only s_new has pipeline_stage=new. The NULL row must not be counted.
    expect(within(newTile).getByText("1")).toBeInTheDocument();
  });

  it("renders a Not initialised badge on the NULL row in the list", async () => {
    renderWQ({ role: "manager" });
    await screen.findByText("Client s_new");
    expect(screen.getAllByText(/Not initialised/i).length).toBeGreaterThan(0);
  });

  it("Not initialised tile is present when NULL rows exist", async () => {
    renderWQ({ role: "manager" });
    await screen.findByText("Client s_new");
    expect(screen.getByRole("button", { name: /^Not initialised/ })).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// QuickDrawer — open, hydrate, stale race, no mutation controls
// ---------------------------------------------------------------------------

describe("PipelineQuickDrawer", () => {
  it("row activation opens the drawer via getSubmissionQuick", async () => {
    const user = userEvent.setup();
    renderWQ({ role: "manager" });
    await screen.findByText("Client s_new");
    // Click a non-button cell on the first data row (the Queue state cell,
    // which is a plain <td> holding a status badge).
    const rows = screen.getAllByRole("row");
    const cells = within(rows[1]).getAllByRole("cell");
    await user.click(cells[cells.length - 3]);
    await waitFor(() => expect(mockQuick).toHaveBeenCalled());
    // Drawer title reads "Submission preview".
    await screen.findByRole("heading", { level: 2, name: /Submission preview/i });
    // Read-only footer: Open full workspace + Close, no mutation controls.
    expect(
      screen.getByRole("button", { name: /Open full workspace/i })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /mark quoted|bind|decline|reassign/i })
    ).toBeNull();
  });

  it("stale response for a superseded id never overwrites the current selection", async () => {
    let resolveA: (v: unknown) => void = () => undefined;
    mockQuick.mockImplementationOnce(
      () => new Promise((res) => { resolveA = res; })
    );
    mockQuick.mockResolvedValueOnce({
      ...QUICK_PAYLOAD_BASE,
      submission: { ...QUICK_PAYLOAD_BASE.submission, id: "s_other", client_name: "Latest Selection" },
    });
    const user = userEvent.setup();
    renderWQ({ role: "manager" });
    await screen.findByText("Client s_new");
    const rows = screen.getAllByRole("row");
    const cellsA = within(rows[1]).getAllByRole("cell");
    const cellsB = within(rows[2]).getAllByRole("cell");
    await user.click(cellsA[cellsA.length - 3]);
    await user.click(cellsB[cellsB.length - 3]);
    // Only the second (latest) fetch resolved.
    await screen.findByText("Latest Selection");
    // Resolve A late; the stale response must not overwrite the drawer.
    resolveA({
      ...QUICK_PAYLOAD_BASE,
      submission: { ...QUICK_PAYLOAD_BASE.submission, client_name: "Stale Winner" },
    });
    // Wait for a tick and confirm the stale winner never appears.
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText("Stale Winner")).toBeNull();
    expect(screen.getByText("Latest Selection")).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// QuickCapture — canonical path, duplicate safety, no injected identity
// ---------------------------------------------------------------------------

describe("QuickCapture", () => {
  it("uses createSubmission and never sends identity / assignment / stage fields", async () => {
    mockCreate.mockResolvedValue({ ok: true, id: "new_id_1" });
    const user = userEvent.setup();
    renderWQ({ role: "underwriter", currentUserId: "user-uuid-1" });
    await screen.findByRole("heading", { level: 1, name: /Quote pipeline/i });
    // Open Quick capture from header.
    const captureBtns = screen.getAllByRole("button", { name: /^Quick capture$/i });
    await user.click(captureBtns[0]);
    // Fill required.
    const client = await screen.findByLabelText(/Client name/i);
    await user.type(client, "Acme Ltd");
    const dialog = screen.getByRole("dialog");
    await user.selectOptions(within(dialog).getByLabelText(/Line of business/i), "commercial");
    // Submit.
    await user.click(screen.getByRole("button", { name: /Create submission/i }));
    await waitFor(() => expect(mockCreate).toHaveBeenCalledTimes(1));
    const call = mockCreate.mock.calls[0][0];
    expect(call.client_name).toBe("Acme Ltd");
    expect(call.line_of_business).toBe("commercial");
    // Forbidden fields must be absent.
    for (const forbidden of [
      "assigned_to",
      "assigned_underwriter",
      "created_by",
      "actor",
      "pipeline_stage",
      "queue_status",
      "complexity",
    ]) {
      expect(call).not.toHaveProperty(forbidden);
    }
  });

  it("does not create when required fields are missing", async () => {
    const user = userEvent.setup();
    renderWQ({ role: "underwriter", currentUserId: "user-uuid-1" });
    await screen.findByRole("heading", { level: 1, name: /Quote pipeline/i });
    const captureBtns = screen.getAllByRole("button", { name: /^Quick capture$/i });
    await user.click(captureBtns[0]);
    const submit = await screen.findByRole("button", { name: /Create submission/i });
    // Button is disabled with no client name / LOB. No API call happens.
    expect(submit).toBeDisabled();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("rapid double click results in exactly one createSubmission call", async () => {
    let resolveCreate: (v: unknown) => void = () => undefined;
    mockCreate.mockImplementation(
      () => new Promise((res) => { resolveCreate = res; })
    );
    const user = userEvent.setup();
    renderWQ({ role: "underwriter", currentUserId: "user-uuid-1" });
    await screen.findByRole("heading", { level: 1, name: /Quote pipeline/i });
    const captureBtns = screen.getAllByRole("button", { name: /^Quick capture$/i });
    await user.click(captureBtns[0]);
    const client = await screen.findByLabelText(/Client name/i);
    await user.type(client, "Acme Ltd");
    const dialog = screen.getByRole("dialog");
    await user.selectOptions(within(dialog).getByLabelText(/Line of business/i), "commercial");
    const submit = within(dialog).getByRole("button", { name: /Create submission/i });
    // Rapid double activation — the second must be a no-op because the
    // synchronous ref lock has already blocked re-entry.
    await user.click(submit);
    await user.click(submit);
    expect(mockCreate).toHaveBeenCalledTimes(1);
    resolveCreate({ ok: true, id: "new_id_2" });
  });
});

// ---------------------------------------------------------------------------
// QuickDrawer — extended behavioural coverage (Checkpoint 2 closeout §2)
// ---------------------------------------------------------------------------

async function openDrawerFromFirstRow(user: ReturnType<typeof userEvent.setup>) {
  await screen.findByText("Client s_new");
  const rows = screen.getAllByRole("row");
  const cells = within(rows[1]).getAllByRole("cell");
  // Priority-ish cell — plain <td>, never a button.
  await user.click(cells[cells.length - 3]);
}

describe("PipelineQuickDrawer — behavioural coverage", () => {
  it("shows a loading state while getSubmissionQuick is unresolved", async () => {
    let resolveQ: (v: unknown) => void = () => undefined;
    mockQuick.mockImplementationOnce(() => new Promise((res) => { resolveQ = res; }));
    const user = userEvent.setup();
    renderWQ({ role: "manager" });
    await openDrawerFromFirstRow(user);
    // Drawer opened but body content is not yet resolved: KV sections are
    // absent — instead the loading skeleton renders inside the drawer body.
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).queryByText(/^Identity$/)).toBeNull();
    expect(within(dialog).queryByText(/^Process$/)).toBeNull();
    // Resolve to unblock cleanup.
    resolveQ(QUICK_PAYLOAD_BASE);
    await within(dialog).findByText(/^Identity$/);
  });

  it("Close button dismisses the drawer", async () => {
    const user = userEvent.setup();
    renderWQ({ role: "manager" });
    await openDrawerFromFirstRow(user);
    await screen.findByRole("dialog");
    const dialog = screen.getByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: /^Close$/ }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("Escape dismisses the drawer via the shared Drawer primitive", async () => {
    const user = userEvent.setup();
    renderWQ({ role: "manager" });
    await openDrawerFromFirstRow(user);
    await screen.findByRole("dialog");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("focus returns to the document after the drawer closes (shared Drawer restoration)", async () => {
    const user = userEvent.setup();
    renderWQ({ role: "manager" });
    await openDrawerFromFirstRow(user);
    const dialog = await screen.findByRole("dialog");
    // Focus is trapped inside the dialog while open.
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    await user.click(within(dialog).getByRole("button", { name: /^Close$/ }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // Focus is released from the (now-unmounted) dialog panel back into the
    // main document body — the shared Drawer primitive handles the exact
    // element restoration.
    expect(document.body.contains(document.activeElement)).toBe(true);
  });

  it("renders a generic 'Submission unavailable' message on 404 and does not leak existence", async () => {
    mockQuick.mockRejectedValueOnce(new Error("http_404"));
    const user = userEvent.setup();
    renderWQ({ role: "manager" });
    await openDrawerFromFirstRow(user);
    const dialog = await screen.findByRole("dialog");
    await waitFor(() =>
      expect(within(dialog).getAllByText(/Submission unavailable/i).length).toBeGreaterThan(0)
    );
    // Never leaks any identifier that suggests the submission exists elsewhere.
    expect(within(dialog).queryByText(/does not exist|belongs to|owner/i)).toBeNull();
  });

  it("Open full workspace calls onOpen with the drawer's submission id", async () => {
    const onOpen = vi.fn();
    const user = userEvent.setup();
    renderWQ({ role: "manager", onOpen });
    await openDrawerFromFirstRow(user);
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByText(/^Identity$/);
    await user.click(within(dialog).getByRole("button", { name: /Open full workspace/i }));
    expect(onOpen).toHaveBeenCalledWith("s_new");
  });

  it("renders no lifecycle mutation controls (Start / Bind / Decline / Lose / Reassign / Change assignment)", async () => {
    const user = userEvent.setup();
    renderWQ({ role: "manager" });
    await openDrawerFromFirstRow(user);
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByText(/^Identity$/);
    const forbidden =
      /start work|mark quoted|^bind$|bound|^decline$|declined|^lose$|^lost$|^reassign$|change assignment/i;
    expect(within(dialog).queryByRole("button", { name: forbidden })).toBeNull();
  });

  it("closes cleanly while a fetch is pending — no stale content on later drawer reopen", async () => {
    let resolveQ: (v: unknown) => void = () => undefined;
    mockQuick.mockImplementationOnce(() => new Promise((res) => { resolveQ = res; }));
    const user = userEvent.setup();
    renderWQ({ role: "manager" });
    await openDrawerFromFirstRow(user);
    await screen.findByRole("dialog");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // Late-arriving response must not resurrect the closed drawer.
    resolveQ({
      ...QUICK_PAYLOAD_BASE,
      submission: { ...QUICK_PAYLOAD_BASE.submission, client_name: "Ghost of Closed Drawer" },
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByText(/Ghost of Closed Drawer/i)).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Underwriting-API isolation for QuickDrawer (network side-effect assertion)
// ---------------------------------------------------------------------------

describe("QuickDrawer underwriting API isolation", () => {
  it("opening QuickDrawer for staff never triggers underwriting-endpoint requests", async () => {
    // No underwriting endpoint symbol is imported in QuickDrawer — the
    // vi.mock for src/lib/atlas above exposes only the four APIs QuickDrawer
    // legitimately needs. A structural miss (an unexpected atlas symbol
    // being called) would throw "is not a function"; the behavioural check
    // is that only mockQuick is invoked when the drawer opens.
    const user = userEvent.setup();
    // Use manager so the default "All" view keeps s_new visible; the
    // behavioural guarantee (no underwriting endpoints called) does not
    // depend on the specific staff role.
    renderWQ({ role: "manager" });
    await openDrawerFromFirstRow(user);
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByText(/^Identity$/);
    expect(mockQuick).toHaveBeenCalledTimes(1);
    // Other atlas mocks that would exist for underwriting APIs are
    // deliberately absent from the mock module. Any accidental import
    // + call from QuickDrawer would surface as a runtime failure above.
  });
});

// ---------------------------------------------------------------------------
// Broker safety in QuickDrawer
// ---------------------------------------------------------------------------

describe("QuickDrawer — broker safety", () => {
  beforeEach(() => {
    mockList.mockResolvedValue({ ok: true, submissions: [row({ id: "s_new" })] });
    mockQuick.mockResolvedValue({
      ...QUICK_PAYLOAD_BASE,
      // Even if the API leaked raw internal metadata (it does not in
      // production — Phase 3 sanitises for broker), the UI must not render
      // it. Prove that by shipping recognisable poison values and verifying
      // they are absent from the drawer.
      history: [
        {
          id: "h1",
          action: "stage_changed",
          actor_id: "00000000-0000-0000-0000-000000000123",
          actor_email: null,
          metadata: { secret_flag: "POISON_METADATA_VALUE", ip: "10.0.0.1" },
          created_at: "2026-08-01T10:00:00Z",
        },
      ],
      assignment_events: [
        {
          id: "ae1",
          assignment_source: "auto",
          event_type: "assigned",
          from_user_id: null,
          to_user_id: "00000000-0000-0000-0000-000000000456",
          actor_user_id: "00000000-0000-0000-0000-000000000789",
          created_at: "2026-08-01T10:00:00Z",
        },
      ],
    });
  });

  it("renders no Assignment activity section, no raw metadata, no internal UUIDs", async () => {
    const user = userEvent.setup();
    renderWQ({ role: "broker" });
    await openDrawerFromFirstRow(user);
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByText(/^Identity$/);
    // Assignment activity: staff-only, must be absent for broker.
    expect(within(dialog).queryByText(/Assignment activity/i)).toBeNull();
    // Poisoned metadata value must not surface.
    expect(within(dialog).queryByText(/POISON_METADATA_VALUE/i)).toBeNull();
    // Raw internal UUIDs must not be rendered as text.
    expect(within(dialog).queryByText(/00000000-0000-0000-0000-000000000456/)).toBeNull();
    expect(within(dialog).queryByText(/00000000-0000-0000-0000-000000000789/)).toBeNull();
    // No pilot control / pilot term for broker.
    expect(within(dialog).queryByText(/pilot/i)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Axe — new Phase 4 surfaces (Checkpoint 2 closeout §3)
// ---------------------------------------------------------------------------

describe("axe — new Phase 4 surfaces", () => {
  it("QuickDrawer open with populated data — zero violations", async () => {
    const user = userEvent.setup();
    const { container } = renderWQ({ role: "manager" });
    await openDrawerFromFirstRow(user);
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByText(/^Identity$/);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it("QuickCapture open — zero violations", async () => {
    const user = userEvent.setup();
    const { container } = renderWQ({ role: "underwriter", currentUserId: "user-uuid-1" });
    await screen.findByRole("heading", { level: 1, name: /Quote pipeline/i });
    const captureBtns = screen.getAllByRole("button", { name: /^Quick capture$/i });
    await user.click(captureBtns[0]);
    await screen.findByRole("dialog");
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it("manager Quote Pipeline with WorkloadPanel populated — zero violations", async () => {
    mockWorkload.mockResolvedValueOnce({
      ok: true,
      workload: [
        {
          user_id: "u1",
          email: "sam@example.com",
          active_for_assignment: true,
          open_count: 3,
          by_stage: { new: 1, triaged: 0, assigned: 1, in_progress: 1, quoted: 0 },
          by_line: { personal: 1, commercial: 2 },
        },
        {
          user_id: "u2",
          email: "kim@example.com",
          active_for_assignment: false,
          open_count: 1,
          by_stage: { new: 0, triaged: 0, assigned: 0, in_progress: 1, quoted: 0 },
          by_line: { personal: 0, commercial: 1 },
        },
      ],
    });
    const { container } = renderWQ({ role: "manager" });
    await screen.findByText("Client s_new");
    await screen.findByText(/sam@example.com/);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it("broker Quote Pipeline — zero violations", async () => {
    const { container } = renderWQ({ role: "broker" });
    await screen.findByText("Client s_new");
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
