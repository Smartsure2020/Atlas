/**
 * Atlas — work queue
 * ----------------------------------------------------------------------------
 * The screen an underwriter starts the day in. It answers, in this order:
 * what needs me, what is waiting on someone else, and what should I open next.
 *
 * The metric tiles are not decoration — each one is a filter. Clicking
 * "Needs attention" scopes the table below it, so a number never leads to a
 * dead end.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { listSubmissions, type SubmissionListItem } from "../lib/atlas";
import {
  Button,
  EmptyState,
  ErrorState,
  FilterChips,
  Metric,
  PageHeader,
  StatusBadge,
  type ActiveFilter,
} from "../components/ui";
import { ColumnPicker, DataTable, type Column, type SortState } from "../components/DataTable";
import { Icon } from "../components/Icon";
import { canWrite, type AtlasUiRole } from "../components/AppShell";
import {
  EMPTY,
  formatDate,
  formatDateTime,
  formatRelative,
  pluralise,
  submissionReference,
} from "../lib/format";
import {
  LINE_OF_BUSINESS_OPTIONS,
  PRIORITY_ORDER,
  QUEUE_STATUS_OPTIONS,
  WORKFLOW_COLUMNS,
  WORKFLOW_STATUS,
  lineOfBusinessLabel,
  priority as priorityStatus,
  queueStatus,
  workflowStatus,
} from "../lib/status";

type ViewMode = "list" | "board";

/** The saved views the metric tiles switch between. */
type Focus = "all" | "attention" | "waiting" | "referred" | "unassigned";

const FOCUS_LABELS: Record<Focus, string> = {
  all: "Everything",
  attention: "Needs attention",
  waiting: "Waiting for information",
  referred: "Referral required",
  unassigned: "Unassigned",
};

type Filters = {
  status: string;
  queue_status: string;
  line_of_business: "" | "personal" | "commercial";
  priority: "" | "low" | "normal" | "high" | "urgent";
};

const EMPTY_FILTERS: Filters = {
  status: "",
  queue_status: "",
  line_of_business: "",
  priority: "",
};

/** A submission wants a human when it is overdue, escalated, or parked. */
function needsAttention(item: SubmissionListItem): boolean {
  const overdue = Boolean(item.due_at && new Date(item.due_at).getTime() < Date.now());
  return (
    overdue ||
    item.priority === "urgent" ||
    item.priority === "high" ||
    ["waiting_info", "referred"].includes(item.queue_status ?? "") ||
    ["missing_info_requested", "referred_to_insurer"].includes(item.status)
  );
}

function isWaiting(item: SubmissionListItem): boolean {
  return item.queue_status === "waiting_info" || item.status === "missing_info_requested";
}

function isReferred(item: SubmissionListItem): boolean {
  return item.queue_status === "referred" || item.status === "referred_to_insurer";
}

function isUnassigned(item: SubmissionListItem): boolean {
  return !item.assigned_to && !item.assigned_underwriter;
}

/** The action the workflow status implies, when nobody has written one down. */
function defaultNextAction(item: SubmissionListItem): string {
  switch (item.status) {
    case "new":
      return "Review the intake and run extraction";
    case "in_review":
      return "Complete the underwriting review";
    case "missing_info_requested":
      return "Follow up the outstanding information";
    case "ready_for_quote":
      return "Confirm quote readiness";
    case "referred_to_insurer":
      return "Chase the referral outcome";
    default:
      return "Review the case history";
  }
}

export default function WorkQueue({
  role,
  search,
  onSearchChange,
  onNew,
  onOpen,
}: {
  role: AtlasUiRole;
  search: string;
  onSearchChange: (value: string) => void;
  onNew: () => void;
  onOpen: (id: string) => void;
}) {
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [focus, setFocus] = useState<Focus>("all");
  const [mode, setMode] = useState<ViewMode>("list");
  const [items, setItems] = useState<SubmissionListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sort, setSort] = useState<SortState>({ columnId: "updated", direction: "desc" });
  const [hiddenColumns, setHiddenColumns] = useState<string[]>(["created", "line"]);
  const [reloadToken, setReloadToken] = useState(0);

  const reload = useCallback(() => setReloadToken((token) => token + 1), []);

  useEffect(() => {
    let live = true;
    // Debounce only the free-text search; dropdown changes should feel instant.
    const timer = window.setTimeout(
      () => {
        setLoading(true);
        listSubmissions({
          q: search || undefined,
          status: filters.status || undefined,
          queue_status: filters.queue_status || undefined,
          line_of_business: filters.line_of_business || undefined,
          priority: filters.priority || undefined,
        })
          .then((res) => {
            if (!live) return;
            setItems(res.submissions);
            setError(null);
          })
          .catch((cause: Error) => {
            if (!live) return;
            setError(
              cause.message === "not_authenticated"
                ? "Your session has expired. Sign in again to load the work queue."
                : "The work queue could not be loaded. The Atlas API did not respond."
            );
          })
          .finally(() => {
            if (live) setLoading(false);
          });
      },
      search ? 220 : 0
    );
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [search, filters, reloadToken]);

  const counts = useMemo(
    () => ({
      total: items.length,
      attention: items.filter(needsAttention).length,
      waiting: items.filter(isWaiting).length,
      referred: items.filter(isReferred).length,
      unassigned: items.filter(isUnassigned).length,
    }),
    [items]
  );

  const visible = useMemo(() => {
    switch (focus) {
      case "attention":
        return items.filter(needsAttention);
      case "waiting":
        return items.filter(isWaiting);
      case "referred":
        return items.filter(isReferred);
      case "unassigned":
        return items.filter(isUnassigned);
      default:
        return items;
    }
  }, [focus, items]);

  const activeFilters: ActiveFilter[] = [];
  if (search) {
    activeFilters.push({
      key: "q",
      label: "Search",
      value: search,
      onRemove: () => onSearchChange(""),
    });
  }
  if (filters.status) {
    activeFilters.push({
      key: "status",
      label: "Stage",
      value: workflowStatus(filters.status).label,
      onRemove: () => setFilters((current) => ({ ...current, status: "" })),
    });
  }
  if (filters.queue_status) {
    activeFilters.push({
      key: "queue_status",
      label: "Queue state",
      value: queueStatus(filters.queue_status).label,
      onRemove: () => setFilters((current) => ({ ...current, queue_status: "" })),
    });
  }
  if (filters.line_of_business) {
    activeFilters.push({
      key: "line",
      label: "Line",
      value: lineOfBusinessLabel(filters.line_of_business),
      onRemove: () => setFilters((current) => ({ ...current, line_of_business: "" })),
    });
  }
  if (filters.priority) {
    activeFilters.push({
      key: "priority",
      label: "Priority",
      value: priorityStatus(filters.priority).label,
      onRemove: () => setFilters((current) => ({ ...current, priority: "" })),
    });
  }
  if (focus !== "all") {
    activeFilters.push({
      key: "focus",
      label: "View",
      value: FOCUS_LABELS[focus],
      onRemove: () => setFocus("all"),
    });
  }

  const columns: Column<SubmissionListItem>[] = [
    {
      id: "client",
      header: "Client",
      width: "26%",
      sortValue: (row) => (row.client_name ?? "").toLowerCase(),
      cell: (row) => (
        <div className="atlas-table__cellstack">
          <button
            type="button"
            className="atlas-table__primary atlas-truncate"
            onClick={() => onOpen(row.id)}
            title={row.client_name ?? "Untitled submission"}
          >
            {row.client_name || "Untitled submission"}
          </button>
          <span className="atlas-table__sub atlas-truncate" title={row.request_type ?? undefined}>
            {submissionReference(row.id)} · {row.request_type || "Risk type not captured"}
          </span>
        </div>
      ),
    },
    {
      id: "broker",
      header: "Broker",
      optional: true,
      sortValue: (row) => (row.broker_name ?? "").toLowerCase(),
      cell: (row) => (
        <span className="atlas-truncate" style={{ display: "block", maxWidth: "22ch" }}>
          {row.broker_name || EMPTY}
        </span>
      ),
    },
    {
      id: "line",
      header: "Line",
      optional: true,
      sortValue: (row) => row.line_of_business ?? "",
      cell: (row) =>
        row.line_of_business ? (
          <span className="atlas-badge atlas-badge--quiet">
            <span className="atlas-badge__label">{lineOfBusinessLabel(row.line_of_business)}</span>
          </span>
        ) : (
          <span className="atlas-text-muted">Unclassified</span>
        ),
    },
    {
      id: "stage",
      header: "Stage",
      sortValue: (row) => workflowStatus(row.status).label,
      cell: (row) => <StatusBadge status={workflowStatus(row.status)} />,
    },
    {
      id: "queue",
      header: "Queue state",
      sortValue: (row) => queueStatus(row.queue_status).label,
      cell: (row) => <StatusBadge status={queueStatus(row.queue_status)} />,
    },
    {
      id: "priority",
      header: "Priority",
      sortValue: (row) => PRIORITY_ORDER[row.priority ?? "normal"] ?? 9,
      cell: (row) => <StatusBadge status={priorityStatus(row.priority)} />,
    },
    {
      id: "owner",
      header: "Owner",
      sortValue: (row) => (row.assigned_to_email ?? "zzz").toLowerCase(),
      cell: (row) =>
        row.assigned_to_email ? (
          <span className="atlas-truncate" style={{ display: "block", maxWidth: "20ch" }} title={row.assigned_to_email}>
            {row.assigned_to_email}
          </span>
        ) : (
          <span className="atlas-text-muted">Shared queue</span>
        ),
    },
    {
      id: "next",
      header: "Next action",
      width: "22%",
      cell: (row) => (
        <div className="atlas-queue__next">
          <span className="atlas-queue__next-action atlas-clamp-2">
            {row.next_action || defaultNextAction(row)}
          </span>
          {row.due_at && (
            <span className="atlas-text-muted" style={{ fontSize: 12 }}>
              Due {formatDate(row.due_at)}
            </span>
          )}
        </div>
      ),
    },
    {
      id: "updated",
      header: "Last movement",
      align: "right",
      sortValue: (row) => new Date(row.updated_at || row.created_at).getTime(),
      cell: (row) => (
        <span title={formatDateTime(row.updated_at || row.created_at)}>
          {formatRelative(row.updated_at || row.created_at)}
        </span>
      ),
    },
    {
      id: "created",
      header: "Created",
      align: "right",
      optional: true,
      sortValue: (row) => new Date(row.created_at).getTime(),
      cell: (row) => <span title={formatDateTime(row.created_at)}>{formatDate(row.created_at)}</span>,
    },
    {
      id: "actions",
      header: "",
      align: "right",
      width: "1%",
      cell: (row) => (
        <div className="atlas-table__rowactions">
          <Button size="sm" iconAfter="chevron-right" onClick={() => onOpen(row.id)}>
            Open
          </Button>
        </div>
      ),
    },
  ];

  return (
    <div>
      <PageHeader
        eyebrow="Underwriting operations"
        title="Work queue"
        description="Every live submission, and the next human action each one is waiting on."
        actions={
          <>
            <div className="atlas-btn-group" role="group" aria-label="Queue view">
              <button
                type="button"
                className={`atlas-btn atlas-btn--sm atlas-btn--ghost ${mode === "list" ? "atlas-btn--pressed" : ""}`}
                aria-pressed={mode === "list"}
                onClick={() => setMode("list")}
              >
                <Icon name="queue" size={13} />
                List
              </button>
              <button
                type="button"
                className={`atlas-btn atlas-btn--sm atlas-btn--ghost ${mode === "board" ? "atlas-btn--pressed" : ""}`}
                aria-pressed={mode === "board"}
                onClick={() => setMode("board")}
              >
                <Icon name="oversight" size={13} />
                Board
              </button>
            </div>
            <Button
              variant="primary"
              icon="plus"
              onClick={onNew}
              disabled={!canWrite(role)}
              title={!canWrite(role) ? "Read-only accounts cannot create submissions." : undefined}
            >
              New submission
            </Button>
          </>
        }
      />

      <section className="atlas-metrics atlas-queue__metrics" aria-label="Queue summary">
        <Metric
          label="In the queue"
          value={counts.total}
          loading={loading}
          hint="Submissions matching the current filters."
          active={focus === "all"}
          onClick={() => setFocus("all")}
        />
        <Metric
          label="Needs attention"
          value={counts.attention}
          loading={loading}
          tone={counts.attention > 0 ? "warning" : "default"}
          hint="Overdue, high priority, waiting on information, or referred."
          active={focus === "attention"}
          onClick={() => setFocus(focus === "attention" ? "all" : "attention")}
        />
        <Metric
          label="Waiting for information"
          value={counts.waiting}
          loading={loading}
          hint="Parked until the broker or client replies."
          active={focus === "waiting"}
          onClick={() => setFocus(focus === "waiting" ? "all" : "waiting")}
        />
        <Metric
          label="Referral required"
          value={counts.referred}
          loading={loading}
          tone={counts.referred > 0 ? "warning" : "default"}
          hint="With the insurer or a senior underwriter for a decision."
          active={focus === "referred"}
          onClick={() => setFocus(focus === "referred" ? "all" : "referred")}
        />
        <Metric
          label="Unassigned"
          value={counts.unassigned}
          loading={loading}
          hint="Sitting on the shared queue with no named owner."
          active={focus === "unassigned"}
          onClick={() => setFocus(focus === "unassigned" ? "all" : "unassigned")}
        />
      </section>

      <section className="atlas-toolbar atlas-queue__controls" aria-label="Filter the work queue">
        <div className="atlas-toolbar__field atlas-toolbar__field--grow">
          <label htmlFor="queue-search">Search</label>
          <div className="atlas-search">
            <Icon name="search" size={15} className="atlas-search__icon" />
            <input
              id="queue-search"
              type="search"
              className="atlas-input"
              value={search}
              placeholder="Client, broker, or request type"
              onChange={(event) => onSearchChange(event.target.value)}
            />
          </div>
        </div>

        <div className="atlas-toolbar__field">
          <label htmlFor="queue-stage">Stage</label>
          <select
            id="queue-stage"
            className="atlas-select"
            value={filters.status}
            onChange={(event) => setFilters((current) => ({ ...current, status: event.target.value }))}
          >
            <option value="">All stages</option>
            {Object.entries(WORKFLOW_STATUS).map(([value, meta]) => (
              <option key={value} value={value}>
                {meta.label}
              </option>
            ))}
          </select>
        </div>

        <div className="atlas-toolbar__field">
          <label htmlFor="queue-state">Queue state</label>
          <select
            id="queue-state"
            className="atlas-select"
            value={filters.queue_status}
            onChange={(event) => setFilters((current) => ({ ...current, queue_status: event.target.value }))}
          >
            <option value="">All queue states</option>
            {QUEUE_STATUS_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>

        <div className="atlas-toolbar__field">
          <label htmlFor="queue-line">Line of business</label>
          <select
            id="queue-line"
            className="atlas-select"
            value={filters.line_of_business}
            onChange={(event) =>
              setFilters((current) => ({
                ...current,
                line_of_business: event.target.value as Filters["line_of_business"],
              }))
            }
          >
            <option value="">All lines</option>
            {LINE_OF_BUSINESS_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>

        <div className="atlas-toolbar__field">
          <label htmlFor="queue-priority">Priority</label>
          <select
            id="queue-priority"
            className="atlas-select"
            value={filters.priority}
            onChange={(event) =>
              setFilters((current) => ({ ...current, priority: event.target.value as Filters["priority"] }))
            }
          >
            <option value="">All priorities</option>
            <option value="urgent">Urgent</option>
            <option value="high">High</option>
            <option value="normal">Normal</option>
            <option value="low">Low</option>
          </select>
        </div>

        {mode === "list" && (
          <div className="atlas-toolbar__field" style={{ alignSelf: "flex-end" }}>
            <ColumnPicker columns={columns} hidden={hiddenColumns} onChange={setHiddenColumns} />
          </div>
        )}
      </section>

      <FilterChips
        filters={activeFilters}
        onClearAll={() => {
          setFilters(EMPTY_FILTERS);
          setFocus("all");
          onSearchChange("");
        }}
        resultLabel={
          loading ? "Loading…" : `${pluralise(visible.length, "submission")} shown`
        }
      />

      <div style={{ marginTop: "var(--atlas-space-4)" }}>
        {error ? (
          <ErrorState
            title="The work queue could not be loaded"
            message={error}
            onRetry={reload}
            retryLabel="Retry"
          />
        ) : mode === "list" ? (
          <DataTable
            caption="Submissions in the work queue"
            columns={columns}
            hiddenColumns={hiddenColumns}
            rows={visible}
            rowKey={(row) => row.id}
            loading={loading}
            sort={sort}
            onSortChange={setSort}
            onRowActivate={(row) => onOpen(row.id)}
            rowAttention={needsAttention}
            empty={
              activeFilters.length > 0 ? (
                <EmptyState
                  title="No submissions match these filters"
                  body="Nothing in the queue matches the current search and filters. Clear one to widen the view."
                  actions={
                    <Button
                      onClick={() => {
                        setFilters(EMPTY_FILTERS);
                        setFocus("all");
                        onSearchChange("");
                      }}
                    >
                      Clear all filters
                    </Button>
                  }
                />
              ) : (
                <EmptyState
                  title="The work queue is empty"
                  body="No submissions have been captured yet. Create one to start the underwriting workflow."
                  actions={
                    canWrite(role) ? (
                      <Button variant="primary" icon="plus" onClick={onNew}>
                        New submission
                      </Button>
                    ) : undefined
                  }
                />
              )
            }
          />
        ) : (
          <QueueBoard items={visible} loading={loading} onOpen={onOpen} />
        )}
      </div>
    </div>
  );
}

function QueueBoard({
  items,
  loading,
  onOpen,
}: {
  items: SubmissionListItem[];
  loading: boolean;
  onOpen: (id: string) => void;
}) {
  if (loading) {
    return (
      <div className="atlas-board" aria-hidden="true">
        {WORKFLOW_COLUMNS.map((column) => (
          <div className="atlas-board__col" key={column.key}>
            <div className="atlas-board__head">
              <span className="atlas-board__title">{column.title}</span>
            </div>
            <div className="atlas-board__body">
              <span className="atlas-skeleton atlas-skeleton--block" />
              <span className="atlas-skeleton atlas-skeleton--block" />
            </div>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="atlas-board">
      {WORKFLOW_COLUMNS.map((column) => {
        const cards = items.filter((item) => column.match(item.status));
        return (
          <section className="atlas-board__col" key={column.key} aria-label={column.title}>
            <div className="atlas-board__head">
              <span className="atlas-board__title">{column.title}</span>
              <span className="atlas-tab__count">{cards.length}</span>
            </div>
            <div className="atlas-board__body">
              {cards.length === 0 ? (
                <p className="atlas-board__empty">Nothing at this stage</p>
              ) : (
                cards.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className="atlas-board__card"
                    onClick={() => onOpen(item.id)}
                  >
                    <span className="atlas-board__card-client">
                      {item.client_name || "Untitled submission"}
                    </span>
                    <span className="atlas-board__card-meta">
                      {item.request_type || "Risk type not captured"}
                    </span>
                    <span className="atlas-queue__tagcell">
                      <StatusBadge status={priorityStatus(item.priority)} />
                      {needsAttention(item) && <StatusBadge status={queueStatus(item.queue_status)} />}
                    </span>
                    <span className="atlas-board__card-next">
                      {item.next_action || defaultNextAction(item)}
                    </span>
                  </button>
                ))
              )}
            </div>
          </section>
        );
      })}
    </div>
  );
}

/** Shared with the submission workspace so both agree on what "needs a human" means. */
export { needsAttention as submissionNeedsAttention, defaultNextAction };
