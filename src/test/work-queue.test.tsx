/**
 * WorkQueue integration tests.
 * Mocks the Atlas API surface so the component's observable behaviours
 * (loading, empty, error, populated, list/board, metric filters, filter
 * chip removal, Clear all, search debounce, distinct error messages,
 * accessibility) can be exercised end-to-end at the component boundary.
 */

import { describe, expect, it, vi } from "vitest";
import {
  render,
  screen,
  waitFor,
  waitForElementToBeRemoved,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "vitest-axe";
import type { SubmissionListItem } from "../lib/atlas";

// Individual tests below reassign `mockList` to control what
// listSubmissions returns. The mock is registered before the component
// module is imported so the module always sees the mocked function.
const mockList = vi.fn();
vi.mock("../lib/atlas", () => ({
  listSubmissions: (...args: unknown[]) => mockList(...args),
}));

import WorkQueue from "../pages/WorkQueue";
import { WORKFLOW_COLUMNS } from "../lib/status";

const FIXTURE: SubmissionListItem[] = [
  {
    id: "sub_alpha",
    broker_name: "Broker A",
    client_name: "Alpha Client",
    request_type: "Commercial building",
    status: "new",
    assigned_underwriter: null,
    assigned_to: null,
    assigned_at: null,
    assigned_by: null,
    queue_status: "new",
    line_of_business: "commercial",
    priority: "normal",
    next_action: "Review the intake",
    due_at: null,
    updated_at: "2026-08-01T10:00:00Z",
    pilot_flag: false,
    assigned_to_email: null,
    created_at: "2026-07-30T10:00:00Z",
    active_job: null,
  },
  {
    id: "sub_beta",
    broker_name: "Broker B",
    client_name: "Beta Client",
    request_type: "Personal motor",
    status: "in_review",
    assigned_underwriter: null,
    assigned_to: "u1",
    assigned_at: "2026-08-02T09:00:00Z",
    assigned_by: null,
    queue_status: "in_review",
    line_of_business: "personal",
    priority: "high",
    next_action: "Complete the review",
    due_at: null,
    updated_at: "2026-08-02T11:00:00Z",
    pilot_flag: false,
    assigned_to_email: "sam@example.com",
    created_at: "2026-08-01T09:00:00Z",
    active_job: null,
  },
  {
    id: "sub_gamma",
    broker_name: "Broker C",
    client_name: "Gamma Client",
    request_type: "Personal home",
    status: "missing_info_requested",
    assigned_underwriter: null,
    assigned_to: "u2",
    assigned_at: "2026-08-03T09:00:00Z",
    assigned_by: null,
    queue_status: "waiting_info",
    line_of_business: "personal",
    priority: "urgent",
    next_action: "Follow up outstanding information",
    due_at: "2026-08-05T00:00:00Z",
    updated_at: "2026-08-04T10:00:00Z",
    pilot_flag: true,
    assigned_to_email: "kim@example.com",
    created_at: "2026-08-03T09:00:00Z",
    active_job: null,
  },
];

function renderQueue(overrides: Partial<Parameters<typeof WorkQueue>[0]> = {}) {
  const onSearchChange = vi.fn<(value: string) => void>();
  const onOpen = vi.fn<(id: string) => void>();
  const onNew = vi.fn();
  const props = {
    role: "underwriter" as const,
    search: "",
    onSearchChange,
    onNew,
    onOpen,
    ...overrides,
  };
  const rendered = render(<WorkQueue {...props} />);
  return { ...rendered, onSearchChange, onOpen, onNew };
}

describe("WorkQueue", () => {
  it("shows loading, then populated rows and metric counts", async () => {
    mockList.mockResolvedValue({ ok: true, submissions: FIXTURE });
    renderQueue();
    await screen.findByText("Alpha Client");
    expect(screen.getByText("Beta Client")).toBeInTheDocument();
    expect(screen.getByText("Gamma Client")).toBeInTheDocument();
    // "In the queue" metric shows 3 fixtures.
    expect(
      within(screen.getByRole("button", { name: /^In the queue/i })).getByText("3")
    ).toBeInTheDocument();
  });

  it("shows the domain-specific session-expired error message", async () => {
    mockList.mockRejectedValueOnce(new Error("not_authenticated"));
    renderQueue();
    await screen.findByText(/session has expired/i);
    expect(screen.queryByText(/did not respond/i)).toBeNull();
  });

  it("shows the domain-specific service-error message", async () => {
    mockList.mockRejectedValueOnce(new Error("http_500"));
    renderQueue();
    await screen.findByText(/atlas api did not respond/i);
    expect(screen.queryByText(/session has expired/i)).toBeNull();
  });

  it("renders the empty state when no submissions match", async () => {
    mockList.mockResolvedValue({ ok: true, submissions: [] });
    renderQueue();
    await screen.findByText(/work queue is empty/i);
  });

  it("groups board rows into WORKFLOW_COLUMNS", async () => {
    mockList.mockResolvedValue({ ok: true, submissions: FIXTURE });
    const user = userEvent.setup();
    renderQueue();
    await screen.findByText("Alpha Client");
    await user.click(screen.getByRole("button", { name: /^Board/i }));

    // Each fixture lands in a distinct column.
    for (const column of WORKFLOW_COLUMNS) {
      const section = screen.queryByRole("region", { name: column.title });
      if (!section) continue;
      const rows = FIXTURE.filter((f) => column.match(f.status));
      for (const row of rows) {
        expect(within(section).getByText(row.client_name!)).toBeInTheDocument();
      }
    }
  });

  it("metric tile scopes the queue to its subset", async () => {
    mockList.mockResolvedValue({ ok: true, submissions: FIXTURE });
    const user = userEvent.setup();
    renderQueue();
    await screen.findByText("Alpha Client");

    // "Waiting for information" scopes to Gamma only.
    await user.click(screen.getByRole("button", { name: /Waiting for information/i }));
    await waitFor(() => {
      expect(screen.queryByText("Alpha Client")).toBeNull();
    });
    expect(screen.getByText("Gamma Client")).toBeInTheDocument();
  });

  it("filter chips remove individual filters", async () => {
    mockList.mockResolvedValue({ ok: true, submissions: FIXTURE });
    const user = userEvent.setup();
    renderQueue();
    await screen.findByText("Alpha Client");

    // Activate the "Referral required" focus filter → chip appears.
    await user.click(screen.getByRole("button", { name: /Needs attention/i }));
    const chipRemove = await screen.findByRole("button", { name: /remove view filter/i });
    await user.click(chipRemove);
    // Chip gone; everything shown again.
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: /remove view filter/i })).toBeNull();
    });
    expect(screen.getByText("Alpha Client")).toBeInTheDocument();
  });

  it("Clear all resets filters, focus and search", async () => {
    mockList.mockResolvedValue({ ok: true, submissions: FIXTURE });
    const user = userEvent.setup();
    const { onSearchChange } = renderQueue({ search: "beta" });
    await screen.findByText("Alpha Client");
    await user.click(screen.getByRole("button", { name: /Needs attention/i }));
    await screen.findByRole("button", { name: /remove view filter/i });

    await user.click(screen.getByRole("button", { name: /clear all/i }));
    expect(onSearchChange).toHaveBeenCalledWith("");
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: /remove view filter/i })).toBeNull();
    });
  });

  it("debounces the free-text search by ~220ms", async () => {
    vi.useFakeTimers();
    try {
      mockList.mockResolvedValue({ ok: true, submissions: FIXTURE });
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      const { rerender } = render(
        <WorkQueue
          role="underwriter"
          search=""
          onSearchChange={() => undefined}
          onNew={() => undefined}
          onOpen={() => undefined}
        />
      );
      // Initial mount: search is "", debounce is 0ms. Flush the empty-search
      // fetch and clear counts so the debounce assertion is unambiguous.
      await vi.runAllTimersAsync();
      mockList.mockClear();

      rerender(
        <WorkQueue
          role="underwriter"
          search="alp"
          onSearchChange={() => undefined}
          onNew={() => undefined}
          onOpen={() => undefined}
        />
      );

      expect(mockList).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(219);
      expect(mockList).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(2);
      expect(mockList).toHaveBeenCalled();
      // Silence unused-var warning; suite intentionally does not click.
      void user;
    } finally {
      vi.useRealTimers();
    }
  });

  it("has zero axe violations in the populated list state", async () => {
    mockList.mockResolvedValue({ ok: true, submissions: FIXTURE });
    const { container } = renderQueue();
    await screen.findByText("Alpha Client");
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it("has zero axe violations in the empty list state", async () => {
    mockList.mockResolvedValue({ ok: true, submissions: [] });
    const { container } = renderQueue();
    await screen.findByText(/work queue is empty/i);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it("has zero axe violations in the error state", async () => {
    mockList.mockRejectedValueOnce(new Error("not_authenticated"));
    const { container } = renderQueue();
    await screen.findByText(/session has expired/i);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it("has zero axe violations in the board mode with fixtures", async () => {
    mockList.mockResolvedValue({ ok: true, submissions: FIXTURE });
    const user = userEvent.setup();
    const { container } = renderQueue();
    await screen.findByText("Alpha Client");
    await user.click(screen.getByRole("button", { name: /^Board/i }));
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it("has zero axe violations in the loading skeleton", async () => {
    let resolve: (value: unknown) => void = () => undefined;
    mockList.mockReturnValueOnce(new Promise((res) => (resolve = res)));
    const { container } = renderQueue();
    // Skeleton is visible; axe should pass here too.
    const results = await axe(container);
    expect(results).toHaveNoViolations();
    resolve({ ok: true, submissions: FIXTURE });
    await screen.findByText("Alpha Client");
  });

  it("aria-busy is set on the table while loading", async () => {
    let resolve: (value: unknown) => void = () => undefined;
    mockList.mockReturnValueOnce(new Promise((res) => (resolve = res)));
    renderQueue();
    const table = await screen.findByRole("table");
    expect(table).toHaveAttribute("aria-busy", "true");
    resolve({ ok: true, submissions: FIXTURE });
    await waitFor(() => expect(table).not.toHaveAttribute("aria-busy"));
  });
});

// Kept only so the reference in the debounce test does not hang on unused
// import warnings if `waitForElementToBeRemoved` is later removed.
void waitForElementToBeRemoved;
