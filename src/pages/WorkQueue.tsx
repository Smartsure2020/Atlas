/**
 * Atlas — Quote pipeline
 * ----------------------------------------------------------------------------
 * (Route name remains "queue" and the hash remains #submissions so old
 * bookmarks keep working. The user-facing name is now "Quote pipeline".)
 *
 * Answers, in order: what's coming in, what's mine, and what's waiting on
 * someone else. The lifecycle metric tiles double as pipeline-stage filters;
 * a saved view scopes the visible list without re-defining those numbers.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listSubmissions, type SubmissionListItem } from "../lib/atlas";
import {
  Button,
  EmptyState,
  ErrorState,
  FilterChips,
  PageHeader,
  StatusBadge,
  type ActiveFilter,
} from "../components/ui";
import { DataTable, type Column, type SortState } from "../components/DataTable";
import ColumnPicker from "../components/ColumnPicker";
import { Icon } from "../components/Icon";
import PipelineStats, {
  type PipelineStageFilter,
} from "../components/PipelineStats";
import WorkloadPanel from "../components/WorkloadPanel";
import PipelineQuickDrawer from "../components/PipelineQuickDrawer";
import QuickCapture from "../components/QuickCapture";
import { canCreateSubmission, canManage, type AtlasUiRole } from "../components/AppShell";
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
  PIPELINE_STAGE,
  PRIORITY_ORDER,
  QUEUE_STATUS_OPTIONS,
  lineOfBusinessLabel,
  pipelineStage,
  priority as priorityStatus,
  queueStatus,
} from "../lib/status";
import {
  defaultViewForRole,
  filterPipelineView,
  needsAttention as pipelineNeedsAttention,
  stageAgeMs,
  type PipelineSavedView,
  type AtlasRoleForView,
} from "../lib/pipeline";

type ViewMode = "list" | "board";

type Filters = {
  queue_status: string;
  line_of_business: "" | "personal" | "commercial";
  priority: "" | "low" | "normal" | "high" | "urgent";
  pilot: boolean;
};

const EMPTY_FILTERS: Filters = {
  queue_status: "",
  line_of_business: "",
  priority: "",
  pilot: false,
};

interface SavedViewDef {
  key: PipelineSavedView;
  label: string;
}

function savedViewsForRole(role: AtlasUiRole): SavedViewDef[] {
  if (role === "broker") {
    return [
      { key: "all", label: "My submissions" },
      { key: "needs_attention", label: "Needs attention" },
      { key: "waiting_info", label: "Waiting for information" },
      { key: "referred", label: "Referred" },
      { key: "quoted", label: "Quoted" },
    ];
  }
  if (role === "readonly") {
    return [
      { key: "all", label: "All" },
      { key: "needs_attention", label: "Needs attention" },
      { key: "waiting_info", label: "Waiting for information" },
      { key: "referred", label: "Referred" },
      { key: "quoted", label: "Quoted" },
    ];
  }
  if (role === "consultant" || role === "underwriter") {
    return [
      { key: "mine", label: "Mine" },
      { key: "all", label: "All accessible" },
      { key: "unassigned", label: "Unassigned" },
      { key: "needs_attention", label: "Needs attention" },
      { key: "waiting_info", label: "Waiting for information" },
      { key: "referred", label: "Referred" },
      { key: "quoted", label: "Quoted" },
    ];
  }
  // manager / admin
  return [
    { key: "all", label: "All" },
    { key: "mine", label: "Mine" },
    { key: "unassigned", label: "Unassigned" },
    { key: "needs_attention", label: "Needs attention" },
    { key: "waiting_info", label: "Waiting for information" },
    { key: "referred", label: "Referred" },
    { key: "quoted", label: "Quoted" },
  ];
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

function formatStageAge(ms: number | null): string {
  if (ms == null) return "";
  const days = Math.floor(ms / (1000 * 60 * 60 * 24));
  if (days > 1) return `In this stage for ${days} days`;
  if (days === 1) return "In this stage for 1 day";
  const hours = Math.floor(ms / (1000 * 60 * 60));
  if (hours >= 1) return `In this stage for ${hours}h`;
  return "In this stage for under 1h";
}

const PIPELINE_BOARD_LANES: { key: string; title: string; match: (row: SubmissionListItem) => boolean }[] = [
  { key: "new", title: "New", match: (r) => r.pipeline_stage === "new" },
  { key: "triaged", title: "Triaged", match: (r) => r.pipeline_stage === "triaged" },
  { key: "assigned", title: "Assigned", match: (r) => r.pipeline_stage === "assigned" },
  { key: "in_progress", title: "In progress", match: (r) => r.pipeline_stage === "in_progress" },
  { key: "quoted", title: "Quoted", match: (r) => r.pipeline_stage === "quoted" },
  { key: "not_initialised", title: "Not initialised", match: (r) => (r.pipeline_stage ?? null) === null },
  { key: "bound", title: "Bound", match: (r) => r.pipeline_stage === "bound" },
  { key: "declined", title: "Declined", match: (r) => r.pipeline_stage === "declined" },
  { key: "lost", title: "Lost", match: (r) => r.pipeline_stage === "lost" },
];

export default function WorkQueue({
  role,
  currentUserId,
  search,
  onSearchChange,
  onNew,
  onOpen,
}: {
  role: AtlasUiRole;
  currentUserId?: string | null;
  search: string;
  onSearchChange: (value: string) => void;
  onNew: () => void;
  onOpen: (id: string) => void;
}) {
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [savedView, setSavedView] = useState<PipelineSavedView>(() =>
    defaultViewForRole(role as AtlasRoleForView)
  );
  const [stageFilter, setStageFilter] = useState<PipelineStageFilter>(null);
  const [mode, setMode] = useState<ViewMode>("list");
  const [items, setItems] = useState<SubmissionListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sort, setSort] = useState<SortState>({ columnId: "updated", direction: "desc" });
  const [hiddenColumns, setHiddenColumns] = useState<string[]>(["created", "line"]);
  const [reloadToken, setReloadToken] = useState(0);
  const [drawerId, setDrawerId] = useState<string | null>(null);
  const [captureOpen, setCaptureOpen] = useState(false);

  const savedViews = savedViewsForRole(role);
  const savedViewLabel =
    savedViews.find((v) => v.key === savedView)?.label ?? savedViews[0]?.label ?? "";

  const reload = useCallback(() => setReloadToken((token) => token + 1), []);

  const hasActiveJobs = items.some((item) => item.active_job);
  useEffect(() => {
    if (!hasActiveJobs) return;
    let timer: number | null = null;
    const start = () => {
      if (timer !== null) return;
      timer = window.setInterval(() => setReloadToken((t) => t + 1), 5000);
    };
    const stop = () => {
      if (timer === null) return;
      window.clearInterval(timer);
      timer = null;
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") start();
      else stop();
    };
    if (document.visibilityState === "visible") start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [hasActiveJobs]);

  // Snapshot the initial load state so debounce doesn't inflate the search delay
  // beyond 220ms — matches the pre-Phase-4 behaviour the existing tests pin.
  const itemsRef = useRef(items);
  itemsRef.current = items;

  useEffect(() => {
    let live = true;
    const timer = window.setTimeout(
      () => {
        if (itemsRef.current.length === 0) setLoading(true);
        listSubmissions({
          q: search || undefined,
          queue_status: filters.queue_status || undefined,
          line_of_business: filters.line_of_business || undefined,
          priority: filters.priority || undefined,
          pilot: filters.pilot || undefined,
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
                ? "Your session has expired. Sign in again to load the quote pipeline."
                : "The quote pipeline could not be loaded. The Atlas API did not respond."
            );
          })
          .finally(() => {
            if (live) setLoading(false);
          });
      },
      search || reloadToken > 0 ? 220 : 0
    );
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [search, filters, reloadToken]);

  // Filter order (deterministic, documented for downstream readers):
  //   1. BASE ITEMS = server-scoped + search + queue_status/priority/line filters
  //   2. saved view
  //   3. local pipeline stage filter
  // PipelineStats always counts BASE ITEMS — never the visible slice.
  const afterSavedView = useMemo(
    () =>
      filterPipelineView(items, savedView, {
        currentUserId: currentUserId ?? null,
      }),
    [items, savedView, currentUserId]
  );

  const visible = useMemo(() => {
    if (!stageFilter) return afterSavedView;
    if (stageFilter === "not_initialised") {
      return afterSavedView.filter((r) => (r.pipeline_stage ?? null) === null);
    }
    return afterSavedView.filter((r) => r.pipeline_stage === stageFilter);
  }, [afterSavedView, stageFilter]);

  const activeFilters: ActiveFilter[] = [];
  if (search) {
    activeFilters.push({
      key: "q",
      label: "Search",
      value: search,
      onRemove: () => onSearchChange(""),
    });
  }
  if (filters.queue_status) {
    activeFilters.push({
      key: "queue_status",
      label: "Queue state",
      value: queueStatus(filters.queue_status).label,
      onRemove: () => setFilters((c) => ({ ...c, queue_status: "" })),
    });
  }
  if (filters.line_of_business) {
    activeFilters.push({
      key: "line",
      label: "Line",
      value: lineOfBusinessLabel(filters.line_of_business),
      onRemove: () => setFilters((c) => ({ ...c, line_of_business: "" })),
    });
  }
  if (filters.priority) {
    activeFilters.push({
      key: "priority",
      label: "Priority",
      value: priorityStatus(filters.priority).label,
      onRemove: () => setFilters((c) => ({ ...c, priority: "" })),
    });
  }
  if (filters.pilot && role !== "broker") {
    activeFilters.push({
      key: "pilot",
      label: "Pilot",
      value: "Pilot cases only",
      onRemove: () => setFilters((c) => ({ ...c, pilot: false })),
    });
  }
  if (stageFilter) {
    activeFilters.push({
      key: "stage",
      label: "Pipeline stage",
      value:
        stageFilter === "not_initialised" ? "Not initialised" : pipelineStage(stageFilter).label,
      onRemove: () => setStageFilter(null),
    });
  }
  if (savedView !== defaultViewForRole(role as AtlasRoleForView)) {
    activeFilters.push({
      key: "view",
      label: "View",
      value: savedViewLabel,
      onRemove: () => setSavedView(defaultViewForRole(role as AtlasRoleForView)),
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
          <div style={{ display: "flex", alignItems: "center", gap: "var(--atlas-space-2)" }}>
            <button
              type="button"
              className="atlas-table__primary atlas-truncate"
              onClick={() => onOpen(row.id)}
              title={row.client_name ?? "Untitled submission"}
            >
              {row.client_name || "Untitled submission"}
            </button>
            {row.pilot_flag && role !== "broker" && (
              <span className="atlas-badge atlas-badge--info" style={{ flexShrink: 0 }}>
                <span className="atlas-badge__label">Pilot</span>
              </span>
            )}
          </div>
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
      header: "Pipeline stage",
      sortValue: (row) => pipelineStage(row.pipeline_stage).label,
      cell: (row) => {
        const stage = row.pipeline_stage ?? null;
        const age = stage != null ? stageAgeMs(row) : null;
        return (
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            {stage == null ? (
              <span className="atlas-text-muted">Not initialised</span>
            ) : (
              <StatusBadge status={pipelineStage(stage)} />
            )}
            {stage != null && age != null && (
              <span className="atlas-text-muted" style={{ fontSize: 12 }}>
                {formatStageAge(age)}
              </span>
            )}
            {row.active_job &&
              (row.active_job.cancellation_requested ? (
                <span className="atlas-badge atlas-badge--warning" style={{ fontSize: 11 }}>
                  <span className="atlas-badge__label">Cancelling</span>
                </span>
              ) : (
                <span
                  className="atlas-badge atlas-badge--info"
                  style={{ fontSize: 11, display: "inline-flex", alignItems: "center", gap: 4 }}
                >
                  <span className="atlas-pulse-dot" />
                  <span className="atlas-badge__label">
                    {row.active_job.job_type === "extraction"
                      ? "Extracting"
                      : row.active_job.job_type === "recommendation"
                      ? "Recommending"
                      : row.active_job.job_type === "quote_review"
                      ? "Reviewing"
                      : "Processing"}
                    {row.active_job.progress_percent != null
                      ? ` ${Math.round(row.active_job.progress_percent)}%`
                      : "…"}
                  </span>
                </span>
              ))}
          </div>
        );
      },
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
          <span
            className="atlas-truncate"
            style={{ display: "block", maxWidth: "20ch" }}
            title={row.assigned_to_email}
          >
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
      srHeader: "Actions",
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

  const isBroker = role === "broker";
  const showWorkload = canManage(role);
  const showPilot = !isBroker;

  const description = isBroker
    ? "Track the quote requests you've submitted to Atlas."
    : "Track every quote request from intake through assignment, underwriting and outcome.";

  return (
    <div>
      <PageHeader
        eyebrow="Underwriting operations"
        title="Quote pipeline"
        description={description}
        actions={
          <>
            <div className="atlas-btn-group" role="group" aria-label="Pipeline view">
              <button
                type="button"
                className={`atlas-btn atlas-btn--sm atlas-btn--ghost ${
                  mode === "list" ? "atlas-btn--pressed" : ""
                }`}
                aria-pressed={mode === "list"}
                onClick={() => setMode("list")}
              >
                <Icon name="queue" size={13} />
                List
              </button>
              <button
                type="button"
                className={`atlas-btn atlas-btn--sm atlas-btn--ghost ${
                  mode === "board" ? "atlas-btn--pressed" : ""
                }`}
                aria-pressed={mode === "board"}
                onClick={() => setMode("board")}
              >
                <Icon name="oversight" size={13} />
                Board
              </button>
            </div>
            {canCreateSubmission(role) && (
              <>
                <Button variant="primary" icon="plus" onClick={() => setCaptureOpen(true)}>
                  Quick capture
                </Button>
                <Button variant="ghost" onClick={onNew}>
                  Full intake
                </Button>
              </>
            )}
          </>
        }
      />

      <PipelineStats
        items={items}
        loading={loading}
        active={stageFilter}
        onToggle={setStageFilter}
        scope={isBroker ? "broker" : "internal"}
      />

      <section
        className="atlas-toolbar"
        aria-label="Saved views"
        style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: "var(--atlas-space-3)" }}
      >
        {savedViews.map((v) => (
          <button
            key={v.key}
            type="button"
            className={`atlas-btn atlas-btn--sm ${
              savedView === v.key ? "atlas-btn--pressed" : "atlas-btn--ghost"
            }`}
            aria-pressed={savedView === v.key}
            onClick={() => setSavedView(v.key)}
          >
            {v.label}
          </button>
        ))}
      </section>

      <section
        className="atlas-toolbar atlas-queue__controls"
        aria-label="Filter the quote pipeline"
      >
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
              onChange={(e) => onSearchChange(e.target.value)}
            />
          </div>
        </div>

        <div className="atlas-toolbar__field">
          <label htmlFor="queue-pipeline-stage">Pipeline stage</label>
          <select
            id="queue-pipeline-stage"
            className="atlas-select"
            value={stageFilter ?? ""}
            onChange={(e) => {
              const v = e.target.value;
              setStageFilter(
                (v === "" ? null : (v as PipelineStageFilter)) as PipelineStageFilter
              );
            }}
          >
            <option value="">All stages</option>
            {Object.entries(PIPELINE_STAGE).map(([value, meta]) => (
              <option key={value} value={value}>
                {meta.label}
              </option>
            ))}
            <option value="not_initialised">Not initialised</option>
          </select>
        </div>

        <div className="atlas-toolbar__field">
          <label htmlFor="queue-state">Queue state</label>
          <select
            id="queue-state"
            className="atlas-select"
            value={filters.queue_status}
            onChange={(e) =>
              setFilters((c) => ({ ...c, queue_status: e.target.value }))
            }
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
            onChange={(e) =>
              setFilters((c) => ({
                ...c,
                line_of_business: e.target.value as Filters["line_of_business"],
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
            onChange={(e) =>
              setFilters((c) => ({ ...c, priority: e.target.value as Filters["priority"] }))
            }
          >
            <option value="">All priorities</option>
            <option value="urgent">Urgent</option>
            <option value="high">High</option>
            <option value="normal">Normal</option>
            <option value="low">Low</option>
          </select>
        </div>

        {showPilot && (
          <div className="atlas-toolbar__field" style={{ alignSelf: "flex-end" }}>
            <button
              type="button"
              className={`atlas-btn atlas-btn--sm ${
                filters.pilot ? "atlas-btn--pressed" : "atlas-btn--ghost"
              }`}
              aria-pressed={filters.pilot}
              onClick={() => setFilters((c) => ({ ...c, pilot: !c.pilot }))}
              title="Show only submissions flagged as pilot cases"
            >
              Pilot only
            </button>
          </div>
        )}

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
          setSavedView(defaultViewForRole(role as AtlasRoleForView));
          setStageFilter(null);
          onSearchChange("");
        }}
        resultLabel={loading ? "Loading…" : `${pluralise(visible.length, "submission")} shown`}
      />
      <span className="atlas-sr-only" role="status" aria-live="polite">
        {loading ? "" : `${pluralise(visible.length, "submission")} shown`}
      </span>

      <div style={{ marginTop: "var(--atlas-space-4)" }}>
        {error ? (
          <ErrorState
            title="The quote pipeline could not be loaded"
            message={error}
            onRetry={reload}
            retryLabel="Retry"
          />
        ) : mode === "list" ? (
          <DataTable
            caption="Submissions in the quote pipeline"
            columns={columns}
            hiddenColumns={hiddenColumns}
            rows={visible}
            rowKey={(row) => row.id}
            loading={loading}
            sort={sort}
            onSortChange={setSort}
            onRowActivate={(row) => setDrawerId(row.id)}
            selectedKey={drawerId}
            rowAttention={pipelineNeedsAttention}
            stickyFirstColumn
            empty={
              activeFilters.length > 0 ? (
                <EmptyState
                  title="No submissions match these filters"
                  body="Nothing in the pipeline matches the current search and filters. Clear one to widen the view."
                  actions={
                    <Button
                      onClick={() => {
                        setFilters(EMPTY_FILTERS);
                        setSavedView(defaultViewForRole(role as AtlasRoleForView));
                        setStageFilter(null);
                        onSearchChange("");
                      }}
                    >
                      Clear all filters
                    </Button>
                  }
                />
              ) : (
                <EmptyState
                  title="The quote pipeline is empty"
                  body="No submissions have been captured yet. Create one to start the underwriting workflow."
                  actions={
                    canCreateSubmission(role) ? (
                      <Button variant="primary" icon="plus" onClick={() => setCaptureOpen(true)}>
                        Quick capture
                      </Button>
                    ) : undefined
                  }
                />
              )
            }
          />
        ) : (
          <PipelineBoard items={visible} loading={loading} onOpen={(id) => setDrawerId(id)} />
        )}
      </div>

      {showWorkload && (
        <div style={{ marginTop: "var(--atlas-space-4)" }}>
          <WorkloadPanel reloadToken={reloadToken} />
        </div>
      )}

      <PipelineQuickDrawer
        submissionId={drawerId}
        role={role}
        onClose={() => setDrawerId(null)}
        onOpenFull={(id) => {
          setDrawerId(null);
          onOpen(id);
        }}
      />

      {canCreateSubmission(role) && (
        <QuickCapture
          open={captureOpen}
          onClose={() => setCaptureOpen(false)}
          onCreated={(id) => {
            setCaptureOpen(false);
            reload();
            setDrawerId(id);
          }}
        />
      )}
    </div>
  );
}

function PipelineBoard({
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
        {PIPELINE_BOARD_LANES.slice(0, 5).map((column) => (
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

  const lanes = PIPELINE_BOARD_LANES.filter((lane) => {
    // Always show the five active lanes; only render terminal / not_initialised
    // if there are rows for them so the board isn't cluttered.
    if (["new", "triaged", "assigned", "in_progress", "quoted"].includes(lane.key)) return true;
    return items.some((r) => lane.match(r));
  });

  return (
    <div className="atlas-board">
      {lanes.map((column) => {
        const cards = items.filter((item) => column.match(item));
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
                      {item.assigned_to_email && (
                        <span
                          className="atlas-text-muted"
                          style={{ fontSize: 11 }}
                          title={item.assigned_to_email}
                        >
                          {item.assigned_to_email}
                        </span>
                      )}
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
export { pipelineNeedsAttention as submissionNeedsAttention, defaultNextAction };
