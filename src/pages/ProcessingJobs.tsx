/**
 * Atlas — processing operations workbench
 * ----------------------------------------------------------------------------
 * This screen answers the three questions an operations lead comes here for:
 *   - Where does the pipeline need attention right now?
 *   - Which alerts and jobs actually block work if nobody acts?
 *   - What is the underlying state of the platform Atlas depends on?
 *
 * The old page mixed everything into one dense scroll. Phase 6 rebuilds it as
 * an exception-first hierarchy identical in shape to the Phase 5 manager
 * overview: a five-tile summary, then the two focused workqueues (alerts and
 * jobs-needing-intervention), then the supporting platform status, then the
 * full job history. Every actionable tile and section says whether it is a
 * last-24h window count, a current-state count, or a retention backlog, so a
 * zero is never mistaken for "nothing is happening".
 *
 * The lifecycle guards mirror the manager overview:
 *   1. Cancellation gate — the load call is deferred by one microtask and
 *      cancelled by the effect cleanup, so React StrictMode's discarded mount
 *      never issues a duplicate request.
 *   2. Sequence guard — if a slow response outraces a newer one, its
 *      setState calls are dropped.
 *
 * Retry, cancel and resolve all confirm first through the same dialog
 * primitive; acknowledge is a low-consequence read-model transition and
 * stays a single click.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  cancelJob,
  cleanupPreview,
  getSystemStatus,
  listAlerts,
  listJobs,
  retryJob,
  updateAlert,
  type AtlasJob,
  type JobSummary,
  type OperationalAlert,
  type SystemStatus,
} from "../lib/phase7";
import {
  Button,
  Card,
  CardSkeleton,
  ConfirmDialog,
  Drawer,
  EmptyState,
  ErrorState,
  FilterChips,
  KeyValue,
  Notice,
  PageHeader,
  StatusBadge,
  useToast,
  type ActiveFilter,
} from "../components/ui";
import { DataTable, type Column, type SortState } from "../components/DataTable";
import {
  alertSeverity,
  alertStatus,
  JOB_STATUS,
  jobStatus,
  jobTypeLabel,
  JOB_TYPE_LABELS,
} from "../lib/status";
import { EMPTY, formatDateTime, formatDuration, formatRelative, humanise, pluralise } from "../lib/format";
import {
  hasCriticalOpenAlert,
  jobsNeedingIntervention,
  orderAlerts,
  processingExceptionMetrics,
  readExpiredActiveDocumentCount,
  redactJobMetadata,
  summariseJob,
  type AlertPresentation,
  type JobPresentation,
  type ProcessingExceptionMetric,
} from "../lib/operations-evidence";

type JobAction = { job: AtlasJob; action: "retry" | "cancel" };
type AlertAction = { alert: OperationalAlert; action: "resolve" };

export default function ProcessingJobs({
  onOpenSubmission,
}: {
  onOpenSubmission: (id: string) => void;
}) {
  const toast = useToast();
  const [systemStatus, setSystemStatus] = useState<SystemStatus | null>(null);
  const [jobs, setJobs] = useState<AtlasJob[]>([]);
  const [summary, setSummary] = useState<JobSummary | null>(null);
  const [alerts, setAlerts] = useState<OperationalAlert[]>([]);
  const [expiredDocuments, setExpiredDocuments] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [hydrated, setHydrated] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Post-hydration refresh failures live in a separate slot so the full
  // error state stays reserved for the "no trustworthy data at all" case
  // while a stale-data warning surfaces alongside the previously loaded
  // counters, alerts and jobs.
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const requestSeq = useRef(0);
  // Stable refs for the ConfirmDialog cancel-button focus targets. These
  // live at the component top level so the trap installs against the same
  // ref object across renders — the previous per-render pattern let the
  // Cancel-job dialog open with focus outside the modal because the ref
  // that arrived at useFocusTrap was `null` on first commit. Initial focus
  // deliberately targets the safest control (Cancel, not the destructive
  // Confirm) so a mistrigger cannot be double-tapped into a real
  // cancellation. See NEW-3 in the correction pass report.
  const jobActionCancelRef = useRef<HTMLButtonElement | null>(null);
  const alertActionCancelRef = useRef<HTMLButtonElement | null>(null);

  const [statusFilter, setStatusFilter] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const [sort, setSort] = useState<SortState>({ columnId: "created", direction: "desc" });
  const [inspecting, setInspecting] = useState<AtlasJob | null>(null);
  const [pendingJobAction, setPendingJobAction] = useState<JobAction | null>(null);
  const [pendingAlertAction, setPendingAlertAction] = useState<AlertAction | null>(null);
  const [working, setWorking] = useState<string | null>(null);
  const [alertWorking, setAlertWorking] = useState<string | null>(null);

  useEffect(() => {
    // See ManagerDashboard for the reasoning behind cancellation +
    // sequence guards. `listJobs` is the essential call — but we cannot
    // let a supporting endpoint's failure decide whether the workbench is
    // shown, and we cannot let `listJobs` be classified from anything
    // other than its own outcome. Promise.allSettled runs every request
    // to completion; each result is inspected on its own, so a jobs=200
    // + alerts=401 combination keeps the workbench alive and only warns
    // that the supporting data is stale.
    let cancelled = false;
    const seq = ++requestSeq.current;
    queueMicrotask(() => {
      if (cancelled) return;
      setLoading(true);
      Promise.allSettled([
        getSystemStatus(),
        listJobs(),
        cleanupPreview(),
        listAlerts(),
      ])
        .then(([statusResult, jobResult, cleanupResult, alertResult]) => {
          if (requestSeq.current !== seq) return;

          // Jobs is the workbench-defining call. Its outcome — and only
          // its outcome — decides whether we render the full page or a
          // permission/error state. A 200 on jobs guarantees the workbench
          // renders, even if every supporting call failed. A resolved-null
          // (endpoint reachable but returned nothing) is treated the same
          // way a network failure would be: the workbench cannot render
          // without a jobs payload.
          const jobsFailed =
            jobResult.status === "rejected" || jobResult.value == null;
          if (jobsFailed) {
            const cause =
              jobResult.status === "rejected" ? (jobResult.reason as Error | undefined) : undefined;
            const message =
              cause?.message === "not_authenticated"
                ? "Your session has expired. Sign in again to view processing health."
                : cause?.message === "manager_only" || cause?.message === "forbidden"
                  ? "This screen requires an administrator or manager account. You may not have permission to view it."
                  : "You may not have permission, or the server may be temporarily unavailable — try again in a moment.";
            if (hydrated) {
              setRefreshError(
                cause?.message === "not_authenticated"
                  ? "Your session has expired, so Atlas could not refresh the operational data. The information shown may be outdated. Sign in again to reload."
                  : "Atlas could not refresh the operational data. The information shown may be outdated."
              );
            } else {
              setLoadError(message);
            }
            return;
          }

          const jobs = jobResult.value;
          setJobs(jobs.jobs);
          setSummary(jobs.summary);

          // Supporting endpoints — set only the values that came back;
          // failures on any single one drop that slice of context but
          // never blank the page. A 401/403 on a supporting endpoint
          // surfaces as a refresh warning so the reader knows part of
          // the picture is missing without losing the workbench.
          if (statusResult.status === "fulfilled" && statusResult.value) {
            setSystemStatus(statusResult.value);
          } else if (statusResult.status === "fulfilled") {
            // A resolved-null system status means the endpoint reported
            // nothing rather than throwing — treat that as "no data" but
            // do not classify it as a refresh failure.
            setSystemStatus(null);
          }
          if (cleanupResult.status === "fulfilled") {
            // A fulfilled cleanup can still carry a mis-shaped body — the
            // parser distinguishes malformed/absent (null) from a
            // well-shaped empty backlog (0). A naive `.length` here throws
            // a TypeError when the wrapping object is missing, halting the
            // rest of this handler before the stale-data warning can be
            // set. See readExpiredActiveDocumentCount for the accepted
            // shapes.
            setExpiredDocuments(readExpiredActiveDocumentCount(cleanupResult.value));
          } else {
            setExpiredDocuments(null);
          }
          if (alertResult.status === "fulfilled" && alertResult.value) {
            setAlerts(alertResult.value.alerts);
          } else if (alertResult.status === "fulfilled") {
            setAlerts([]);
          }

          const supportingFailures: string[] = [];
          if (statusResult.status === "rejected") supportingFailures.push("platform status");
          if (alertResult.status === "rejected") supportingFailures.push("operational alerts");
          if (cleanupResult.status === "rejected") supportingFailures.push("retention preview");

          setLoadError(null);
          if (supportingFailures.length === 0) {
            setRefreshError(null);
          } else {
            setRefreshError(
              `The processing job list loaded, but Atlas could not refresh ${supportingFailures.join(", ")}. Those sections may be missing or outdated.`
            );
          }
          setHydrated(true);
        })
        .catch(() => {
          // Defence-in-depth: if the .then handler itself throws
          // (unexpected shape from a supporting endpoint, a Response
          // parser bug, etc.), the workbench must still tell the reader
          // its supporting context could not be refreshed rather than
          // silently keeping stale numbers on screen. `listJobs` outcome
          // has already been classified above, so any throw here is a
          // supporting-endpoint or presentation-layer problem — surface
          // it as a refresh warning without escalating to a full error
          // state.
          if (requestSeq.current !== seq) return;
          if (hydrated) {
            setRefreshError(
              "Atlas could not refresh the operational data. The information shown may be outdated."
            );
          } else {
            setLoadError(
              "You may not have permission, or the server may be temporarily unavailable — try again in a moment."
            );
          }
        })
        .finally(() => {
          if (requestSeq.current === seq) setLoading(false);
        });
    });
    return () => {
      cancelled = true;
    };
  }, [reloadToken]);

  const refresh = useCallback(() => setReloadToken((token) => token + 1), []);

  const exceptionTiles = useMemo<ProcessingExceptionMetric[]>(
    () =>
      processingExceptionMetrics({
        systemStatus,
        summary,
        alerts,
        expiredDocumentCount: expiredDocuments,
      }),
    [systemStatus, summary, alerts, expiredDocuments]
  );

  const orderedAlerts = useMemo<AlertPresentation[]>(() => orderAlerts(alerts), [alerts]);
  const visibleAlerts = useMemo(
    () => orderedAlerts.filter((entry) => entry.alert.status !== "resolved"),
    [orderedAlerts]
  );
  const criticalAlertPresent = useMemo(() => hasCriticalOpenAlert(alerts), [alerts]);

  const attentionJobs = useMemo<JobPresentation[]>(() => jobsNeedingIntervention(jobs), [jobs]);

  const visibleJobs = useMemo(
    () =>
      jobs.filter(
        (job) =>
          (!statusFilter || job.status === statusFilter) && (!typeFilter || job.job_type === typeFilter)
      ),
    [jobs, statusFilter, typeFilter]
  );

  const activeFilters: ActiveFilter[] = [];
  if (statusFilter) {
    activeFilters.push({
      key: "status",
      label: "State",
      value: jobStatus(statusFilter).label,
      onRemove: () => setStatusFilter(""),
    });
  }
  if (typeFilter) {
    activeFilters.push({
      key: "type",
      label: "Job",
      value: jobTypeLabel(typeFilter),
      onRemove: () => setTypeFilter(""),
    });
  }

  const runJobAction = useCallback(
    async ({ job, action }: JobAction) => {
      setWorking(job.id);
      setActionError(null);
      setPendingJobAction(null);
      try {
        if (action === "retry") await retryJob(job.id);
        else await cancelJob(job.id);
        const [jobResult, alertResult] = await Promise.all([listJobs(), listAlerts()]);
        setJobs(jobResult.jobs);
        setSummary(jobResult.summary);
        setAlerts(alertResult.alerts);
        toast.notify(
          action === "retry"
            ? `${jobTypeLabel(job.job_type)} queued for another attempt.`
            : `Cancellation requested for ${jobTypeLabel(job.job_type)}.`,
          "success"
        );
      } catch (cause) {
        setActionError(
          `The ${action} could not be applied to this ${jobTypeLabel(job.job_type).toLowerCase()} job. ` +
            ((cause as Error).message === "job_not_retryable"
              ? "It has already used its retry allowance."
              : "The Atlas API rejected the request.")
        );
      } finally {
        setWorking(null);
      }
    },
    [toast]
  );

  const acknowledgeAlert = useCallback(
    async (alert: OperationalAlert) => {
      setAlertWorking(alert.id);
      setActionError(null);
      try {
        await updateAlert(alert.id, "acknowledge");
        const result = await listAlerts();
        setAlerts(result.alerts);
        toast.notify("Alert acknowledged.", "success");
      } catch {
        setActionError("The alert could not be acknowledged.");
      } finally {
        setAlertWorking(null);
      }
    },
    [toast]
  );

  const resolveAlert = useCallback(
    async (alert: OperationalAlert) => {
      setAlertWorking(alert.id);
      setActionError(null);
      setPendingAlertAction(null);
      try {
        await updateAlert(alert.id, "resolve");
        const result = await listAlerts();
        setAlerts(result.alerts);
        toast.notify("Alert resolved.", "success");
      } catch {
        setActionError("The alert could not be resolved.");
      } finally {
        setAlertWorking(null);
      }
    },
    [toast]
  );

  const canRetry = (job: AtlasJob) =>
    job.status === "failed" && (job.retry_count ?? 0) < (job.max_retries ?? 2);
  const canCancel = (job: AtlasJob) =>
    (job.status === "queued" || job.status === "running") && !job.cancellation_requested;

  const columns: Column<AtlasJob>[] = [
    {
      id: "job",
      header: "Job",
      sortValue: (row) => jobTypeLabel(row.job_type),
      cell: (row) => (
        <div className="atlas-table__cellstack">
          <span style={{ fontWeight: 600, color: "var(--atlas-ink)" }}>{jobTypeLabel(row.job_type)}</span>
          <span className="atlas-table__sub">
            {row.submission_id ? (
              <button
                type="button"
                className="atlas-btn atlas-btn--link"
                onClick={() => onOpenSubmission(row.submission_id!)}
              >
                Open submission
              </button>
            ) : row.insurer_id ? (
              "Insurer guideline"
            ) : (
              "No linked record"
            )}
          </span>
        </div>
      ),
    },
    {
      id: "state",
      header: "State",
      sortValue: (row) => jobStatus(row.status).label,
      cell: (row) => (
        <div className="atlas-queue__tagcell">
          <StatusBadge status={jobStatus(row.status)} />
          {row.cancellation_requested && (
            <StatusBadge status={{ label: "Cancelling", tone: "warning" }} />
          )}
        </div>
      ),
    },
    {
      id: "step",
      header: "Stage",
      cell: (row) => {
        const presentation = summariseJob(row);
        const isMoving = row.status === "running" || row.status === "queued";
        if (!row.current_step && !isMoving) {
          return <span className="atlas-text-muted">{EMPTY}</span>;
        }
        return (
          <span>
            {presentation.stageLabel}
            {isMoving ? ` · ${presentation.progressLabel}` : ""}
          </span>
        );
      },
    },
    {
      id: "attempt",
      header: "Attempt",
      align: "right",
      sortValue: (row) => row.retry_count ?? 0,
      cell: (row) => summariseJob(row).attemptLabel,
    },
    {
      id: "started",
      header: "Started",
      align: "right",
      optional: true,
      sortValue: (row) => new Date(row.started_at ?? row.created_at).getTime(),
      cell: (row) => (
        <span title={formatDateTime(row.started_at ?? row.created_at)}>
          {formatRelative(row.started_at ?? row.created_at)}
        </span>
      ),
    },
    {
      id: "duration",
      header: "Duration",
      align: "right",
      cell: (row) => formatDuration(row.started_at ?? row.created_at, row.completed_at),
    },
    {
      id: "created",
      header: "Queued",
      align: "right",
      sortValue: (row) => new Date(row.created_at).getTime(),
      cell: (row) => <span title={formatDateTime(row.created_at)}>{formatRelative(row.created_at)}</span>,
    },
    {
      id: "problem",
      header: "Problem",
      cell: (row) => {
        const cause = summariseJob(row).causeLabel;
        return cause ? (
          <span className="atlas-jobrow__error atlas-clamp-2">{cause}</span>
        ) : (
          <span className="atlas-text-muted">None</span>
        );
      },
    },
    {
      id: "actions",
      header: "",
      align: "right",
      cell: (row) => (
        <div className="atlas-table__rowactions">
          <Button size="sm" onClick={() => setInspecting(row)}>
            Detail
          </Button>
          {canRetry(row) && (
            <Button
              size="sm"
              icon="refresh"
              disabled={working === row.id}
              onClick={() => setPendingJobAction({ job: row, action: "retry" })}
            >
              Retry
            </Button>
          )}
          {canCancel(row) && (
            <Button
              size="sm"
              variant="danger"
              disabled={working === row.id}
              onClick={() => setPendingJobAction({ job: row, action: "cancel" })}
            >
              Cancel
            </Button>
          )}
        </div>
      ),
    },
  ];

  if (loadError && !hydrated) {
    return (
      <div>
        <PageHeader
          eyebrow="Oversight"
          title="Processing and alerts"
          description="Health of the expensive work Atlas runs in the background."
        />
        <ErrorState
          title="Processing health could not be loaded"
          message={loadError}
          onRetry={refresh}
        />
      </div>
    );
  }

  return (
    <div className="atlas-oversight">
      <PageHeader
        eyebrow="Oversight"
        title="Processing and alerts"
        description="Extraction, appetite matching, quote review and guideline ingestion all run as background jobs. This is where failures surface."
        actions={
          // Refresh is intentionally not disabled while a fetch is in
          // flight — the sequence guard drops stale responses, and a
          // user who wants a re-fetch after a click has taken too long
          // should not be blocked from asking.
          <Button icon="refresh" onClick={refresh} aria-busy={loading || undefined}>
            {loading ? "Refreshing…" : "Refresh"}
          </Button>
        }
      />

      {actionError && (
        <div style={{ marginBottom: "var(--atlas-space-4)" }}>
          <Notice
            tone="danger"
            title="That operation did not complete"
            actions={
              <Button size="sm" onClick={() => setActionError(null)}>
                Dismiss
              </Button>
            }
          >
            {actionError}
          </Notice>
        </div>
      )}

      {refreshError && (
        <div style={{ marginBottom: "var(--atlas-space-4)" }}>
          {/* Persistent stale-data warning. `role="status"` announces once
              politely and does not interrupt with every re-render; the
              notice is only removed by a successful refresh, so a fresh
              failure alongside unchanged copy will not double-announce. */}
          <Notice
            tone="warning"
            role="status"
            title="Atlas could not refresh this page"
            actions={
              <Button size="sm" icon="refresh" onClick={refresh} aria-busy={loading || undefined}>
                {loading ? "Refreshing…" : "Try again"}
              </Button>
            }
          >
            {refreshError}
          </Notice>
        </div>
      )}

      {loading && !hydrated ? (
        <div className="atlas-stack" style={{ marginTop: "var(--atlas-space-4)" }}>
          <CardSkeleton lines={2} />
          <CardSkeleton lines={4} />
        </div>
      ) : (
        <div className="atlas-oversight__body" aria-busy={loading ? true : undefined}>
          <ExceptionStrip tiles={exceptionTiles} />

          {visibleAlerts.length > 0 && (
            <OperationalAlerts
              alerts={visibleAlerts}
              working={alertWorking}
              criticalAlertPresent={criticalAlertPresent}
              onAcknowledge={acknowledgeAlert}
              onRequestResolve={(alert) => setPendingAlertAction({ alert, action: "resolve" })}
            />
          )}

          <InterventionQueue
            jobs={attentionJobs}
            working={working}
            onInspect={setInspecting}
            onRequestRetry={(job) => setPendingJobAction({ job, action: "retry" })}
            onRequestCancel={(job) => setPendingJobAction({ job, action: "cancel" })}
            onOpenSubmission={onOpenSubmission}
          />

          {systemStatus && <PlatformStatus status={systemStatus} />}

          <JobHistory
            columns={columns}
            visibleJobs={visibleJobs}
            statusFilter={statusFilter}
            typeFilter={typeFilter}
            setStatusFilter={setStatusFilter}
            setTypeFilter={setTypeFilter}
            sort={sort}
            setSort={setSort}
            loading={loading}
            activeFilters={activeFilters}
          />
        </div>
      )}

      <JobDetailDrawer job={inspecting} onClose={() => setInspecting(null)} onOpenSubmission={onOpenSubmission} />

      <ConfirmDialog
        open={pendingJobAction !== null}
        destructive={pendingJobAction?.action === "cancel"}
        initialFocusRef={jobActionCancelRef}
        title={
          pendingJobAction?.action === "retry"
            ? `Retry this ${jobTypeLabel(pendingJobAction.job.job_type).toLowerCase()} job?`
            : `Cancel this ${pendingJobAction ? jobTypeLabel(pendingJobAction.job.job_type).toLowerCase() : ""} run?`
        }
        confirmLabel={pendingJobAction?.action === "retry" ? "Retry processing" : "Request cancellation"}
        working={working !== null}
        onCancel={() => setPendingJobAction(null)}
        onConfirm={() => pendingJobAction && void runJobAction(pendingJobAction)}
        body={
          pendingJobAction?.action === "retry" ? (
            <>
              <p>
                Atlas will queue attempt {(pendingJobAction.job.retry_count ?? 0) + 2} of{" "}
                {(pendingJobAction.job.max_retries ?? 2) + 1}. This calls the AI provider again and counts
                towards the retry allowance.
              </p>
              <p style={{ marginTop: 8 }}>
                Existing results are not deleted — a successful retry supersedes them.
              </p>
            </>
          ) : (
            <p>
              Atlas will ask the running job to stop at its next checkpoint. Work already completed is
              kept, and no partial result is written. The job may take a few seconds to acknowledge the
              request.
            </p>
          )
        }
      />

      <ConfirmDialog
        open={pendingAlertAction !== null}
        initialFocusRef={alertActionCancelRef}
        title="Mark this alert as resolved?"
        confirmLabel="Mark as resolved"
        working={alertWorking !== null}
        onCancel={() => setPendingAlertAction(null)}
        onConfirm={() => pendingAlertAction && void resolveAlert(pendingAlertAction.alert)}
        body={
          <>
            <p>
              Resolving records this alert as handled. It is removed from the open list, but the audit
              history keeps the raise and resolution events.
            </p>
            <p style={{ marginTop: 8 }}>
              Only resolve when the underlying condition is actually cleared — a resolved alert will not
              re-raise itself.
            </p>
          </>
        }
      />
    </div>
  );
}

/* ===========================================================================
   Exception strip — the five-tile "where operations need attention" row.
   Reuses the visual pattern established by the manager overview.
   =========================================================================== */

function ExceptionStrip({ tiles }: { tiles: ProcessingExceptionMetric[] }) {
  const nothingOutstanding = tiles.every((tile) => tile.value === 0);
  return (
    <section className="atlas-oversight__section" aria-labelledby="processing-exceptions">
      <header className="atlas-oversight__section-head">
        <h2 id="processing-exceptions" className="atlas-title-sub">
          Where operations need attention
        </h2>
        <p className="atlas-oversight__caption">
          Last-24h tiles cover the most recent day of background work. Current-state tiles reflect right
          now. Retention backlog covers documents whose retention window has closed but the cleanup job
          has not yet removed.
        </p>
      </header>

      {nothingOutstanding ? (
        <EmptyState
          inline
          title="Nothing needs operational attention"
          body="No failed or stuck jobs in the last 24 hours, no open alerts, and no retention backlog."
        />
      ) : (
        <div className="atlas-oversight__exception-grid">
          {tiles.map((tile) => (
            <div
              key={tile.key}
              className={[
                "atlas-oversight__tile",
                tile.attention ? "atlas-oversight__tile--attention" : "",
              ]
                .filter(Boolean)
                .join(" ")}
            >
              <div className="atlas-oversight__tile-head">
                <span className="atlas-oversight__tile-label">{tile.label}</span>
                {tile.attention && (
                  <StatusBadge status={{ label: "Attention", tone: "warning" }} quiet />
                )}
              </div>
              <span
                className={[
                  "atlas-oversight__tile-value",
                  tile.attention ? "atlas-oversight__tile-value--attention" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
              >
                {tile.value}
              </span>
              <span className="atlas-oversight__tile-scope">{scopeLabel(tile.scope)}</span>
              <span className="atlas-oversight__tile-hint">{tile.hint}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function scopeLabel(scope: ProcessingExceptionMetric["scope"]): string {
  switch (scope) {
    case "last_24h":
      return "Last 24 hours";
    case "current":
      return "Right now";
    case "retention_backlog":
      return "Retention backlog";
  }
}

/* ===========================================================================
   Operational alerts — the second focused workqueue.
   =========================================================================== */

function OperationalAlerts({
  alerts,
  working,
  criticalAlertPresent,
  onAcknowledge,
  onRequestResolve,
}: {
  alerts: AlertPresentation[];
  working: string | null;
  criticalAlertPresent: boolean;
  onAcknowledge: (alert: OperationalAlert) => void;
  onRequestResolve: (alert: OperationalAlert) => void;
}) {
  return (
    <section className="atlas-oversight__section" aria-labelledby="processing-alerts">
      <header className="atlas-oversight__section-head">
        <h2 id="processing-alerts" className="atlas-title-sub">
          Operational alerts
        </h2>
        <p className="atlas-oversight__caption">
          Raised automatically when Atlas detects a condition that needs a person. Acknowledge to signal
          you're on it; resolve when the underlying condition is cleared.
          {criticalAlertPresent
            ? " A critical alert is open — address these first."
            : ""}
        </p>
      </header>

      <ul className="atlas-alerts" aria-label="Operational alerts">
        {alerts.map(({ alert, actionability, escalationHint, ageHint }) => (
          <li className={`atlas-alerts__item atlas-alerts__item--${alert.severity}`} key={alert.id}>
            <div className="atlas-alerts__main">
              <p className="atlas-alerts__title">{alert.title}</p>
              <p className="atlas-alerts__meta">{alert.message}</p>
              <p className="atlas-alerts__meta">
                {`Raised ${formatDateTime(alert.created_at)} · ${ageHint}`}
                {escalationHint ? ` · ${escalationHint}` : ""}
              </p>
            </div>
            <div className="atlas-alerts__side">
              <StatusBadge status={alertSeverity(alert.severity)} />
              <StatusBadge status={alertStatus(alert.status)} />
              {actionability === "acknowledge_and_resolve" && (
                <Button
                  size="sm"
                  disabled={working === alert.id}
                  onClick={() => onAcknowledge(alert)}
                  aria-label={`Acknowledge ${alert.severity} alert`}
                >
                  Acknowledge
                </Button>
              )}
              {actionability !== "read_only" && (
                <Button
                  size="sm"
                  disabled={working === alert.id}
                  onClick={() => onRequestResolve(alert)}
                >
                  Mark as resolved
                </Button>
              )}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

/* ===========================================================================
   Intervention queue — failed-with-retries, stuck and cancel-pending jobs.
   =========================================================================== */

function InterventionQueue({
  jobs,
  working,
  onInspect,
  onRequestRetry,
  onRequestCancel,
  onOpenSubmission,
}: {
  jobs: JobPresentation[];
  working: string | null;
  onInspect: (job: AtlasJob) => void;
  onRequestRetry: (job: AtlasJob) => void;
  onRequestCancel: (job: AtlasJob) => void;
  onOpenSubmission: (id: string) => void;
}) {
  const columns: Column<JobPresentation>[] = useMemo(
    () => [
      {
        id: "job",
        header: "Job",
        cell: (row) => (
          <div className="atlas-table__cellstack">
            <span style={{ fontWeight: 600, color: "var(--atlas-ink)" }}>
              {jobTypeLabel(row.job.job_type)}
            </span>
            <span className="atlas-table__sub">
              {row.submissionContext === "submission" && row.job.submission_id ? (
                <button
                  type="button"
                  className="atlas-btn atlas-btn--link"
                  onClick={() => onOpenSubmission(row.job.submission_id!)}
                >
                  Open submission
                </button>
              ) : row.submissionContext === "insurer_guideline" ? (
                "Insurer guideline"
              ) : (
                "No linked record"
              )}
            </span>
          </div>
        ),
      },
      {
        id: "intervention",
        header: "Why",
        cell: (row) => <StatusBadge status={interventionBadge(row.intervention)} />,
      },
      {
        id: "attempt",
        header: "Attempt",
        cell: (row) => row.attemptLabel,
      },
      {
        id: "cause",
        header: "Cause",
        cell: (row) =>
          row.causeLabel ? (
            <span className="atlas-clamp-2">{row.causeLabel}</span>
          ) : (
            <span className="atlas-text-muted">Not recorded</span>
          ),
      },
      {
        id: "queued",
        header: "Queued",
        align: "right",
        cell: (row) => (
          <span title={formatDateTime(row.job.created_at)}>{formatRelative(row.job.created_at)}</span>
        ),
      },
      {
        id: "actions",
        header: "",
        align: "right",
        cell: (row) => (
          <div className="atlas-table__rowactions">
            <Button size="sm" onClick={() => onInspect(row.job)}>
              Detail
            </Button>
            {row.intervention === "retry_available" && (
              <Button
                size="sm"
                icon="refresh"
                disabled={working === row.job.id}
                onClick={() => onRequestRetry(row.job)}
              >
                Retry
              </Button>
            )}
            {row.intervention === "cancel_available" && (
              <Button
                size="sm"
                variant="danger"
                disabled={working === row.job.id}
                onClick={() => onRequestCancel(row.job)}
              >
                Cancel
              </Button>
            )}
          </div>
        ),
      },
    ],
    [onInspect, onOpenSubmission, onRequestCancel, onRequestRetry, working]
  );

  return (
    <section className="atlas-oversight__section" aria-labelledby="processing-intervention">
      <header className="atlas-oversight__section-head">
        <h2 id="processing-intervention" className="atlas-title-sub">
          Jobs needing intervention
        </h2>
        <p className="atlas-oversight__caption">
          Failed jobs that still have retries available, running jobs whose heartbeat has stopped, and
          any run whose cancellation is still pending. The full history is below.
        </p>
      </header>

      <Card flush ariaLabel="Jobs needing intervention table">
        <div className="atlas-oversight__attention">
          <DataTable
            caption="Jobs needing operational intervention"
            columns={columns}
            rows={jobs}
            rowKey={(row) => row.job.id}
            dense
            empty={
              <EmptyState
                title="No jobs need intervention"
                body="Nothing has failed with retries left, stopped sending a heartbeat, or requested a cancellation that has not yet completed."
                inline
              />
            }
          />
        </div>
      </Card>
    </section>
  );
}

function interventionBadge(kind: JobPresentation["intervention"]) {
  switch (kind) {
    case "retry_available":
      return { label: "Failed — retry available", tone: "danger" as const };
    case "retry_exhausted":
      return { label: "Failed — no retries left", tone: "danger" as const };
    case "cancel_available":
      return { label: "Stuck — no heartbeat", tone: "warning" as const };
    case "cancel_pending":
      return { label: "Cancellation pending", tone: "warning" as const };
    case "none":
      return { label: "Healthy", tone: "success" as const };
  }
}

/* ===========================================================================
   Platform status — supporting context, demoted below the two workqueues.
   =========================================================================== */

function PlatformStatus({ status }: { status: SystemStatus }) {
  const storageOk =
    status.storage.client_docs_bucket_configured && status.storage.insurer_docs_bucket_configured;
  return (
    <section className="atlas-oversight__section" aria-labelledby="processing-platform">
      <header className="atlas-oversight__section-head">
        <h2 id="processing-platform" className="atlas-title-sub">
          Platform status
        </h2>
        <p className="atlas-oversight__caption">
          Configuration and connectivity Atlas depends on. If any of these are red, the exception tiles
          above will show why work is not moving.
        </p>
      </header>

      <Card ariaLabel="Platform status details">
        <KeyValue
          items={[
            { key: "Environment", value: humanise(status.environment) },
            {
              key: "Database",
              value: (
                <StatusBadge
                  status={
                    status.database.ok
                      ? { label: `Reachable · ${status.database.latency_ms} ms`, tone: "success" }
                      : { label: "Not reachable", tone: "danger" }
                  }
                />
              ),
            },
            {
              key: "Document storage",
              value: (
                <StatusBadge
                  status={
                    storageOk
                      ? { label: "Both buckets configured", tone: "success" }
                      : {
                          label: "Configuration missing",
                          tone: "danger",
                          description: `Client documents: ${
                            status.storage.client_docs_bucket_configured ? "configured" : "missing"
                          }. Insurer guidelines: ${
                            status.storage.insurer_docs_bucket_configured ? "configured" : "missing"
                          }.`,
                        }
                  }
                />
              ),
            },
            {
              key: "AI provider",
              value: (
                <StatusBadge
                  status={
                    status.ai_provider.anthropic_configured
                      ? { label: "Configured", tone: "success" }
                      : {
                          label: "Not configured",
                          tone: "danger",
                          description: "Extraction and recommendations cannot run without it.",
                        }
                  }
                />
              ),
            },
          ]}
        />

        {Object.keys(status.jobs_24h.by_error_code).length > 0 && (
          <div style={{ marginTop: "var(--atlas-space-5)" }}>
            <p className="atlas-block__title" style={{ marginBottom: 8 }}>
              Failures in the last 24 hours, by cause
            </p>
            <ul className="atlas-rank">
              {Object.entries(status.jobs_24h.by_error_code).map(([code, count]) => (
                <li className="atlas-rank__item" key={code}>
                  <span className="atlas-rank__label">{humanise(code)}</span>
                  <span className="atlas-rank__count">{count}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </Card>
    </section>
  );
}

/* ===========================================================================
   Full job history — the exhaustive table, unchanged in shape.
   =========================================================================== */

function JobHistory({
  columns,
  visibleJobs,
  statusFilter,
  typeFilter,
  setStatusFilter,
  setTypeFilter,
  sort,
  setSort,
  loading,
  activeFilters,
}: {
  columns: Column<AtlasJob>[];
  visibleJobs: AtlasJob[];
  statusFilter: string;
  typeFilter: string;
  setStatusFilter: (value: string) => void;
  setTypeFilter: (value: string) => void;
  sort: SortState;
  setSort: (sort: SortState) => void;
  loading: boolean;
  activeFilters: ActiveFilter[];
}) {
  return (
    <section className="atlas-oversight__section" aria-labelledby="processing-history">
      <header className="atlas-oversight__section-head">
        <h2 id="processing-history" className="atlas-title-sub">
          Full job history
        </h2>
        <p className="atlas-oversight__caption">
          Every recent job Atlas has recorded. Filter by state or job type — the row actions match the
          ones above, so anything actionable can be handled from either place.
        </p>
      </header>

      <section className="atlas-toolbar" aria-label="Filter jobs">
        <div className="atlas-toolbar__field">
          <label htmlFor="job-state">State</label>
          <select
            id="job-state"
            className="atlas-select"
            value={statusFilter}
            onChange={(event) => setStatusFilter(event.target.value)}
          >
            <option value="">All states</option>
            {Object.entries(JOB_STATUS).map(([value, meta]) => (
              <option key={value} value={value}>
                {meta.label}
              </option>
            ))}
          </select>
        </div>
        <div className="atlas-toolbar__field">
          <label htmlFor="job-type">Job</label>
          <select
            id="job-type"
            className="atlas-select"
            value={typeFilter}
            onChange={(event) => setTypeFilter(event.target.value)}
          >
            <option value="">All jobs</option>
            {Object.entries(JOB_TYPE_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>
      </section>

      <FilterChips
        filters={activeFilters}
        onClearAll={() => {
          setStatusFilter("");
          setTypeFilter("");
        }}
        resultLabel={loading ? "Loading…" : `${pluralise(visibleJobs.length, "job")} shown`}
      />

      <DataTable
        caption="Background processing jobs"
        columns={columns}
        rows={visibleJobs}
        rowKey={(row) => row.id}
        loading={loading}
        sort={sort}
        onSortChange={setSort}
        rowAttention={(row) => row.status === "failed"}
        dense
        empty={
          activeFilters.length > 0 ? (
            <EmptyState
              title="No jobs match these filters"
              body="Nothing in the recent job history matches the current state and job type."
              actions={
                <Button
                  onClick={() => {
                    setStatusFilter("");
                    setTypeFilter("");
                  }}
                >
                  Clear all filters
                </Button>
              }
            />
          ) : (
            <EmptyState
              title="No background jobs recorded"
              body="Jobs appear here as soon as an extraction, recommendation, quote review or guideline ingestion runs."
            />
          )
        }
      />
    </section>
  );
}

function JobDetailDrawer({
  job,
  onClose,
  onOpenSubmission,
}: {
  job: AtlasJob | null;
  onClose: () => void;
  onOpenSubmission: (id: string) => void;
}) {
  if (!job) return null;
  const presentation = summariseJob(job);
  const safeMetadata = redactJobMetadata(job.metadata);
  return (
    <Drawer
      open
      title={jobTypeLabel(job.job_type)}
      description="Technical detail for this run."
      onClose={onClose}
      size="md"
      footer={
        job.submission_id ? (
          <Button
            iconAfter="arrow-right"
            onClick={() => {
              onOpenSubmission(job.submission_id!);
              onClose();
            }}
          >
            Open the submission
          </Button>
        ) : undefined
      }
    >
      <div className="atlas-stack">
        <KeyValue
          items={[
            { key: "State", value: <StatusBadge status={jobStatus(job.status)} /> },
            { key: "Stage", value: presentation.stageLabel },
            {
              key: "Progress",
              value:
                job.status === "running" || job.status === "queued"
                  ? presentation.progressLabel
                  : EMPTY,
            },
            { key: "Attempt", value: presentation.attemptLabel },
            { key: "Queued", value: formatDateTime(job.created_at) },
            { key: "Started", value: job.started_at ? formatDateTime(job.started_at) : "Not started" },
            {
              key: "Finished",
              value: job.completed_at ? formatDateTime(job.completed_at) : "Still running or abandoned",
            },
            { key: "Duration", value: formatDuration(job.started_at ?? job.created_at, job.completed_at) },
            {
              key: "Last heartbeat",
              value: job.heartbeat_at ? formatRelative(job.heartbeat_at) : EMPTY,
            },
            {
              key: "Cancellation",
              value: job.cancellation_requested ? "Requested" : "Not requested",
            },
            { key: "Next retry", value: job.next_retry_at ? formatDateTime(job.next_retry_at) : EMPTY },
            { key: "Job identifier", value: <span className="atlas-mono">{job.id}</span> },
          ]}
        />

        {presentation.causeLabel && (
          <Notice
            tone="danger"
            title={job.error_code ? humanise(job.error_code) : "The job failed"}
            detail={safeMetadata}
          >
            {job.error_message ?? "Atlas did not record a message for this failure."}
          </Notice>
        )}

        {job.result_reference_id && (
          <Notice tone="info" title="Result on file">
            This run produced a result with reference{" "}
            <span className="atlas-mono">{job.result_reference_id}</span>.
          </Notice>
        )}
      </div>
    </Drawer>
  );
}
