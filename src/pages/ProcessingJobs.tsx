/**
 * Atlas — processing and alerts
 * ----------------------------------------------------------------------------
 * Operational health, split out of the manager overview. Underwriting oversight
 * and platform operations are different jobs done at different moments, and
 * cramming both into one screen made neither legible.
 *
 * The job table shows what a person needs to triage a failure: what ran, on
 * which submission, how far it got, and how many attempts it has had. Stack
 * traces and error codes stay behind a drawer.
 *
 * Retry and cancel are real operational actions, so both confirm first, state
 * what will happen, and block duplicate clicks. The Worker's own idempotency
 * protections are unchanged.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
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
  ConfirmDialog,
  Drawer,
  EmptyState,
  ErrorState,
  FilterChips,
  KeyValue,
  Metric,
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

type JobAction = { job: AtlasJob; action: "retry" | "cancel" };

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
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const [statusFilter, setStatusFilter] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const [sort, setSort] = useState<SortState>({ columnId: "created", direction: "desc" });
  const [inspecting, setInspecting] = useState<AtlasJob | null>(null);
  const [pendingAction, setPendingAction] = useState<JobAction | null>(null);
  const [working, setWorking] = useState<string | null>(null);
  const [alertWorking, setAlertWorking] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [status, jobResult, cleanup, alertResult] = await Promise.all([
        getSystemStatus().catch(() => null),
        listJobs().catch(() => null),
        cleanupPreview().catch(() => null),
        listAlerts().catch(() => ({ alerts: [] })),
      ]);
      setSystemStatus(status);
      setJobs(jobResult?.jobs ?? []);
      setSummary(jobResult?.summary ?? null);
      setExpiredDocuments(cleanup ? cleanup.expired_active_documents.length : null);
      setAlerts(alertResult.alerts);
      setLoadError(jobResult ? null : "Job history could not be loaded. You may not have permission, or the server may be temporarily unavailable.");
    } catch (cause) {
      setLoadError(
        (cause as Error).message === "not_authenticated"
          ? "Your session has expired. Sign in again to view processing health."
          : "Processing health could not be loaded. This screen requires an administrator or manager account."
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const openAlerts = alerts.filter((alert) => alert.status !== "resolved");

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

  async function runAction({ job, action }: JobAction) {
    setWorking(job.id);
    setActionError(null);
    setPendingAction(null);
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
  }

  async function onAlertAction(alert: OperationalAlert, action: "acknowledge" | "resolve") {
    setAlertWorking(alert.id);
    setActionError(null);
    try {
      await updateAlert(alert.id, action);
      const result = await listAlerts();
      setAlerts(result.alerts);
      toast.notify(action === "acknowledge" ? "Alert acknowledged." : "Alert resolved.", "success");
    } catch {
      setActionError("The alert could not be updated.");
    } finally {
      setAlertWorking(null);
    }
  }

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
      cell: (row) =>
        row.current_step ? (
          <span>
            {humanise(row.current_step)}
            {row.status === "running" || row.status === "queued"
              ? ` · ${row.progress_percent ?? 0}%`
              : ""}
          </span>
        ) : (
          <span className="atlas-text-muted">{EMPTY}</span>
        ),
    },
    {
      id: "attempt",
      header: "Attempt",
      align: "right",
      sortValue: (row) => row.retry_count ?? 0,
      cell: (row) => `${(row.retry_count ?? 0) + 1} of ${(row.max_retries ?? 2) + 1}`,
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
      cell: (row) =>
        row.error_code || row.error_message ? (
          <span className="atlas-jobrow__error atlas-clamp-2">
            {row.error_message || humanise(row.error_code)}
          </span>
        ) : (
          <span className="atlas-text-muted">None</span>
        ),
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
              onClick={() => setPendingAction({ job: row, action: "retry" })}
            >
              Retry
            </Button>
          )}
          {canCancel(row) && (
            <Button
              size="sm"
              variant="danger"
              disabled={working === row.id}
              onClick={() => setPendingAction({ job: row, action: "cancel" })}
            >
              Cancel
            </Button>
          )}
        </div>
      ),
    },
  ];

  if (loadError) {
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
          onRetry={() => void load()}
        />
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        eyebrow="Oversight"
        title="Processing and alerts"
        description="Extraction, appetite matching, quote review and guideline ingestion all run as background jobs. This is where failures surface."
        actions={
          <Button icon="refresh" onClick={() => void load()} loading={loading} loadingLabel="Refreshing…">
            Refresh
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

      <section className="atlas-metrics" aria-label="Processing health" style={{ marginBottom: "var(--atlas-space-4)" }}>
        <Metric
          label="Failed in last 24h"
          value={systemStatus?.jobs_24h.failed_count ?? summary?.failed_count ?? 0}
          loading={loading}
          tone={(systemStatus?.jobs_24h.failed_count ?? 0) > 0 ? "danger" : "default"}
          hint="Jobs that ended in failure and may need a retry."
          active={statusFilter === "failed"}
          onClick={() => setStatusFilter(statusFilter === "failed" ? "" : "failed")}
        />
        <Metric
          label="Stuck"
          value={systemStatus?.jobs_24h.stuck_count ?? summary?.stuck_count ?? 0}
          loading={loading}
          tone={(systemStatus?.jobs_24h.stuck_count ?? 0) > 0 ? "warning" : "default"}
          hint="Started but stopped sending a heartbeat. Usually needs cancelling and retrying."
        />
        <Metric
          label="Open alerts"
          value={openAlerts.length}
          loading={loading}
          tone={openAlerts.some((alert) => alert.severity === "critical") ? "danger" : "default"}
          hint="Operational alerts that nobody has acknowledged or resolved."
        />
        <Metric
          label="Expired documents still active"
          value={expiredDocuments ?? 0}
          loading={loading}
          hint="Past their retention date but not yet cleaned up. Cleanup runs on a schedule."
        />
      </section>

      {systemStatus && <PlatformStatus status={systemStatus} />}

      {openAlerts.length > 0 && (
        <div style={{ marginTop: "var(--atlas-space-4)" }}>
          <Card
            title="Operational alerts"
            description="Raised automatically when Atlas detects a condition that needs a person."
            flush
          >
            <ul className="atlas-list" style={{ padding: "0 var(--atlas-space-5)" }}>
              {openAlerts.map((alert) => (
                <li className="atlas-list__item" key={alert.id}>
                  <div className="atlas-list__main">
                    <p className="atlas-list__title">{alert.title}</p>
                    <p className="atlas-list__meta">{alert.message}</p>
                    <p className="atlas-list__meta">
                      Raised {formatDateTime(alert.created_at)}
                      {alert.escalation_due_at
                        ? ` · escalates ${formatRelative(alert.escalation_due_at)}`
                        : ""}
                    </p>
                  </div>
                  <div className="atlas-list__side">
                    <StatusBadge status={alertSeverity(alert.severity)} />
                    <StatusBadge status={alertStatus(alert.status)} />
                    {alert.status === "open" && (
                      <Button
                        size="sm"
                        disabled={alertWorking === alert.id}
                        onClick={() => onAlertAction(alert, "acknowledge")}
                      >
                        Acknowledge
                      </Button>
                    )}
                    <Button
                      size="sm"
                      disabled={alertWorking === alert.id}
                      onClick={() => onAlertAction(alert, "resolve")}
                    >
                      Resolve
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      )}

      <section className="atlas-toolbar" style={{ margin: "var(--atlas-space-4) 0" }} aria-label="Filter jobs">
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

      <div style={{ marginTop: "var(--atlas-space-4)" }}>
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
      </div>

      <JobDetailDrawer job={inspecting} onClose={() => setInspecting(null)} onOpenSubmission={onOpenSubmission} />

      <ConfirmDialog
        open={pendingAction !== null}
        destructive={pendingAction?.action === "cancel"}
        title={
          pendingAction?.action === "retry"
            ? `Retry this ${jobTypeLabel(pendingAction.job.job_type).toLowerCase()} job?`
            : `Cancel this ${pendingAction ? jobTypeLabel(pendingAction.job.job_type).toLowerCase() : ""} run?`
        }
        confirmLabel={pendingAction?.action === "retry" ? "Retry processing" : "Request cancellation"}
        working={working !== null}
        onCancel={() => setPendingAction(null)}
        onConfirm={() => pendingAction && void runAction(pendingAction)}
        body={
          pendingAction?.action === "retry" ? (
            <>
              <p>
                Atlas will queue attempt {(pendingAction.job.retry_count ?? 0) + 2} of{" "}
                {(pendingAction.job.max_retries ?? 2) + 1}. This calls the AI provider again and counts
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
    </div>
  );
}

function PlatformStatus({ status }: { status: SystemStatus }) {
  const storageOk =
    status.storage.client_docs_bucket_configured && status.storage.insurer_docs_bucket_configured;
  return (
    <Card title="Platform status" description="Configuration and connectivity Atlas depends on.">
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
            { key: "Stage", value: job.current_step ? humanise(job.current_step) : EMPTY },
            {
              key: "Progress",
              value:
                job.status === "running" || job.status === "queued"
                  ? `${job.progress_percent ?? 0}%`
                  : EMPTY,
            },
            {
              key: "Attempt",
              value: `${(job.retry_count ?? 0) + 1} of ${(job.max_retries ?? 2) + 1}`,
            },
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

        {(job.error_code || job.error_message) && (
          <Notice
            tone="danger"
            title={job.error_code ? humanise(job.error_code) : "The job failed"}
            detail={
              job.metadata && Object.keys(job.metadata).length > 0
                ? JSON.stringify(job.metadata, null, 2)
                : null
            }
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
