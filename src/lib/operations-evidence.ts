/**
 * Atlas — operations & evidence presentation helpers
 * ----------------------------------------------------------------------------
 * Pure, deterministic helpers used by the three Phase 6 surfaces:
 *   - Processing & alerts (operational health + intervention queue)
 *   - Submission documents (trust groups)
 *   - Submission audit history (categorised timeline)
 *
 * Nothing here fetches, mutates or reinterprets a wire contract: the worker
 * decides what is failing, what is quarantined, what a decision was — these
 * helpers only decide how to say it. Every helper that touches "now" or
 * "today" accepts an injectable `now: Date` so tests are deterministic and
 * module-load order can never leak a stale clock into a rendered timeline.
 *
 * Design principles carried over from Phase 5 (see src/lib/oversight.ts):
 *   1. Filter honesty — a screen labels the scope of every count it shows
 *      (period-window vs current-state vs retention-backlog), so a zero can
 *      never be mistaken for "nothing is happening".
 *   2. Never fabricate — an unknown enum, an unknown event action, an
 *      unrecorded actor and a missing progress reading all reach the UI as
 *      themselves. The helpers surface them, they do not invent a
 *      fallback that could mislead a reader downstream.
 *   3. Input immutability — helpers never mutate their inputs. Ordering
 *      helpers copy the array before sorting so a caller passing a frozen
 *      list is safe.
 */

import type { AuditEvent } from "./decisions";
import type {
  AtlasJob,
  JobSummary,
  OperationalAlert,
  SystemStatus,
} from "./phase7";
import { formatDate, formatDateTime, formatRelative, humanise, EMPTY } from "./format";

/* ===========================================================================
   Operational alerts
   =========================================================================== */

const SEVERITY_RANK: Record<OperationalAlert["severity"], 0 | 1 | 2> = {
  critical: 0,
  warning: 1,
  info: 2,
};

const STATUS_RANK: Record<OperationalAlert["status"], 0 | 1 | 2> = {
  open: 0,
  acknowledged: 1,
  resolved: 2,
};

export type AlertActionability =
  | "acknowledge_and_resolve"
  | "resolve_only"
  | "read_only";

export interface AlertPresentation {
  alert: OperationalAlert;
  severityRank: 0 | 1 | 2;
  statusRank: 0 | 1 | 2;
  actionability: AlertActionability;
  escalationHint: string | null;
  ageHint: string;
}

function severityRankOf(severity: string): 0 | 1 | 2 {
  return (SEVERITY_RANK as Record<string, 0 | 1 | 2>)[severity] ?? 2;
}

function statusRankOf(status: string): 0 | 1 | 2 {
  return (STATUS_RANK as Record<string, 0 | 1 | 2>)[status] ?? 2;
}

/**
 * Stable ordering of operational alerts: critical before warning before
 * info; within a severity, open before acknowledged before resolved; within
 * a status, newest first by created_at. Order is deterministic even when
 * two alerts collide on all three keys because sort() is stable in ES2019+
 * and we always compare in the same direction. Unknown severities or
 * statuses land at the bottom of their bucket rather than being dropped.
 */
export function orderAlerts(
  alerts: readonly OperationalAlert[],
  now: Date = new Date()
): AlertPresentation[] {
  const copy = alerts.slice();
  copy.sort((a, b) => {
    const sev = severityRankOf(a.severity) - severityRankOf(b.severity);
    if (sev !== 0) return sev;
    const st = statusRankOf(a.status) - statusRankOf(b.status);
    if (st !== 0) return st;
    return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
  });
  return copy.map((alert) => presentAlert(alert, now));
}

function presentAlert(alert: OperationalAlert, now: Date): AlertPresentation {
  const actionability: AlertActionability =
    alert.status === "resolved"
      ? "read_only"
      : alert.status === "acknowledged"
        ? "resolve_only"
        : "acknowledge_and_resolve";
  const escalationHint = describeEscalation(alert, now);
  const ageHint = describeAge(alert.created_at, now);
  return {
    alert,
    severityRank: severityRankOf(alert.severity),
    statusRank: statusRankOf(alert.status),
    actionability,
    escalationHint,
    ageHint,
  };
}

function describeEscalation(alert: OperationalAlert, now: Date): string | null {
  if (alert.escalated_at) {
    return `Escalated ${formatDateTime(alert.escalated_at)}`;
  }
  if (!alert.escalation_due_at) return null;
  const due = new Date(alert.escalation_due_at).getTime();
  if (!Number.isFinite(due)) return null;
  const nowMs = now.getTime();
  if (due <= nowMs) return "Escalation overdue";
  return `Escalates ${formatRelative(alert.escalation_due_at)}`;
}

function describeAge(created_at: string, now: Date): string {
  const then = new Date(created_at).getTime();
  if (!Number.isFinite(then)) return EMPTY;
  const elapsed = Math.max(0, now.getTime() - then);
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return "raised just now";
  if (minutes < 60) return `raised ${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `raised ${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 31) return `raised ${days}d ago`;
  return `raised ${formatDate(created_at)}`;
}

/**
 * True when there is at least one alert that is both critical and not
 * resolved. Used to attention-flag the alert section headline without
 * counting acknowledged criticals twice.
 */
export function hasCriticalOpenAlert(alerts: readonly OperationalAlert[]): boolean {
  for (const alert of alerts) {
    if (alert.severity === "critical" && alert.status !== "resolved") return true;
  }
  return false;
}

/* ===========================================================================
   Background jobs
   =========================================================================== */

export type JobIntervention =
  | "retry_available"
  | "retry_exhausted"
  | "cancel_available"
  | "cancel_pending"
  | "none";

export type SubmissionContext = "submission" | "insurer_guideline" | "unlinked";

export interface JobPresentation {
  job: AtlasJob;
  intervention: JobIntervention;
  attemptLabel: string;
  /** "45%" for in-flight jobs, EMPTY when progress is unknown. */
  progressLabel: string;
  /** Humanised current_step, or EMPTY when no stage was recorded. */
  stageLabel: string;
  /** error_message ?? humanised error_code ?? null. */
  causeLabel: string | null;
  submissionContext: SubmissionContext;
}

const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_STUCK_THRESHOLD_MS = 15 * 60 * 1000;

function retryBudget(job: AtlasJob): { used: number; total: number; hasBudget: boolean } {
  const used = job.retry_count ?? 0;
  const max = job.max_retries ?? DEFAULT_MAX_RETRIES;
  return { used, total: max, hasBudget: used < max };
}

function interventionOf(job: AtlasJob): JobIntervention {
  if (job.status === "failed") {
    return retryBudget(job).hasBudget ? "retry_available" : "retry_exhausted";
  }
  if (job.status === "running" || job.status === "queued") {
    if (job.cancellation_requested) return "cancel_pending";
    return "cancel_available";
  }
  return "none";
}

function submissionContextOf(job: AtlasJob): SubmissionContext {
  if (job.submission_id) return "submission";
  if (job.insurer_id) return "insurer_guideline";
  return "unlinked";
}

/**
 * Presentation slice for a single job — every field is a display string or
 * a small enum, never a raw code. Callers render this shape directly.
 */
export function summariseJob(job: AtlasJob): JobPresentation {
  const budget = retryBudget(job);
  const attemptLabel = `${budget.used + 1} of ${budget.total + 1}`;
  const progressLabel =
    typeof job.progress_percent === "number" ? `${job.progress_percent}%` : EMPTY;
  const stageLabel = job.current_step ? humanise(job.current_step) : EMPTY;
  const cause = job.error_message?.trim()
    ? job.error_message
    : job.error_code
      ? humanise(job.error_code)
      : null;
  return {
    job,
    intervention: interventionOf(job),
    attemptLabel,
    progressLabel,
    stageLabel,
    causeLabel: cause,
    submissionContext: submissionContextOf(job),
  };
}

export interface JobsNeedingInterventionOptions {
  /** Milliseconds after the last heartbeat before a running job is stuck. */
  stuckThresholdMs?: number;
  now?: Date;
}

/**
 * Focused list of jobs a person needs to look at right now:
 *  - failed jobs with retries left, so a retry actually helps;
 *  - running jobs whose last heartbeat is older than the stuck threshold,
 *    or whose heartbeat was never recorded — those need a cancel + retry;
 *  - running or queued jobs where a cancellation has been requested but
 *    the worker has not acknowledged it yet.
 *
 * Order: failed-with-retries first, then stuck, then cancel-pending;
 * within each bucket, newest queued first so the top of the list is what
 * a person most recently added to the backlog.
 */
export function jobsNeedingIntervention(
  jobs: readonly AtlasJob[],
  opts: JobsNeedingInterventionOptions = {}
): JobPresentation[] {
  const stuckThresholdMs = opts.stuckThresholdMs ?? DEFAULT_STUCK_THRESHOLD_MS;
  const now = opts.now ?? new Date();
  const nowMs = now.getTime();

  const buckets: JobPresentation[][] = [[], [], []];
  for (const job of jobs) {
    const presentation = summariseJob(job);
    if (job.status === "failed" && retryBudget(job).hasBudget) {
      buckets[0].push(presentation);
      continue;
    }
    if (job.status === "running" && !job.cancellation_requested) {
      const beat = job.heartbeat_at ? new Date(job.heartbeat_at).getTime() : NaN;
      const stale = !Number.isFinite(beat) || nowMs - beat >= stuckThresholdMs;
      if (stale) {
        buckets[1].push(presentation);
        continue;
      }
    }
    if (job.cancellation_requested && (job.status === "running" || job.status === "queued")) {
      buckets[2].push(presentation);
    }
  }

  const byCreatedDesc = (a: JobPresentation, b: JobPresentation) =>
    new Date(b.job.created_at).getTime() - new Date(a.job.created_at).getTime();
  for (const bucket of buckets) bucket.sort(byCreatedDesc);
  return buckets[0].concat(buckets[1], buckets[2]);
}

/* ===========================================================================
   Exception summary — the "where operations need attention" strip
   =========================================================================== */

export type ProcessingExceptionScope = "last_24h" | "current" | "retention_backlog";

export interface ProcessingExceptionMetric {
  key: string;
  label: string;
  value: number;
  scope: ProcessingExceptionScope;
  hint: string;
  attention: boolean;
}

export interface ProcessingExceptionInputs {
  systemStatus: SystemStatus | null;
  summary: JobSummary | null;
  alerts: readonly OperationalAlert[];
  expiredDocumentCount: number | null;
}

/**
 * Five tiles that describe the operational-exception surface. Each value is
 * a number the worker already calculated, or a straight count of a list —
 * nothing here derives a rate or invents a denominator. The `scope` tag lets
 * the UI group time-windowed tiles apart from current-state tiles without
 * the two reading as directly comparable.
 */
export function processingExceptionMetrics({
  systemStatus,
  summary,
  alerts,
  expiredDocumentCount,
}: ProcessingExceptionInputs): ProcessingExceptionMetric[] {
  const failed24h = systemStatus?.jobs_24h.failed_count ?? summary?.failed_count ?? 0;
  const stuck24h = systemStatus?.jobs_24h.stuck_count ?? summary?.stuck_count ?? 0;

  let openTotal = 0;
  let openCritical = 0;
  for (const alert of alerts) {
    if (alert.status === "resolved") continue;
    openTotal += 1;
    if (alert.severity === "critical") openCritical += 1;
  }
  const expiredValue = expiredDocumentCount ?? 0;

  return [
    {
      key: "failed_24h",
      label: "Failed in last 24h",
      value: failed24h,
      scope: "last_24h",
      hint: "Jobs that ended in failure and may need a retry.",
      attention: failed24h > 0,
    },
    {
      key: "stuck_24h",
      label: "Stuck in last 24h",
      value: stuck24h,
      scope: "last_24h",
      hint: "Started but stopped sending a heartbeat. Usually needs cancelling and retrying.",
      attention: stuck24h > 0,
    },
    {
      key: "open_critical_alerts",
      label: "Open critical alerts",
      value: openCritical,
      scope: "current",
      hint: "Unresolved alerts flagged as critical. Address these first.",
      attention: openCritical > 0,
    },
    {
      key: "open_alerts",
      label: "Open alerts",
      value: openTotal,
      scope: "current",
      hint: "Operational alerts that nobody has resolved yet, including those that have been acknowledged.",
      attention: openTotal > 0,
    },
    {
      key: "expired_documents",
      label: "Expired documents still active",
      value: expiredValue,
      scope: "retention_backlog",
      hint: "Past their retention date but not yet cleaned up. Cleanup runs on a schedule.",
      attention: expiredValue > 0,
    },
  ];
}

/* ===========================================================================
   Submission documents — trust grouping
   =========================================================================== */

export type DocumentGroupKey = "quarantined" | "scan_pending" | "active" | "expired";

export interface DocumentRow {
  id?: string;
  file_name?: string;
  document_type?: string | null;
  status?: string | null;
  scan_status?: string | null;
  size_bytes?: number | null;
  created_at?: string;
  expires_at?: string | null;
  uploaded_by_email?: string | null;
  [key: string]: unknown;
}

export interface DocumentGroup {
  key: DocumentGroupKey;
  documents: DocumentRow[];
}

/**
 * Split every document into exactly one bucket. Quarantine wins over
 * expiry — a document that was quarantined and then had its retention
 * date pass is still a quarantine problem, not an expiry problem.
 * Scan-in-progress wins over active so a document Atlas has not yet
 * scanned is never presented as "on file". Order of returned groups is
 * fixed (quarantined → scan_pending → active → expired) so the caller can
 * loop without a secondary sort.
 */
export function groupDocuments(documents: readonly DocumentRow[]): DocumentGroup[] {
  const groups: Record<DocumentGroupKey, DocumentRow[]> = {
    quarantined: [],
    scan_pending: [],
    active: [],
    expired: [],
  };
  for (const document of documents) {
    if (document.scan_status === "infected") {
      groups.quarantined.push(document);
      continue;
    }
    if (document.scan_status === "pending" && document.status !== "expired") {
      groups.scan_pending.push(document);
      continue;
    }
    if (document.status === "expired") {
      groups.expired.push(document);
      continue;
    }
    groups.active.push(document);
  }
  return [
    { key: "quarantined", documents: groups.quarantined },
    { key: "scan_pending", documents: groups.scan_pending },
    { key: "active", documents: groups.active },
    { key: "expired", documents: groups.expired },
  ];
}

export interface DocumentsTrustSummary {
  total: number;
  quarantinedCount: number;
  scanPendingCount: number;
  activeCount: number;
  expiredCount: number;
  scanFailedCount: number;
  /**
   * True when the reader must look at something before they act — a
   * quarantined file or a scan that failed outright. A scan still running
   * is not blocking; it is progress.
   */
  hasBlockingIssue: boolean;
}

export function documentsTrustSummary(
  documents: readonly DocumentRow[]
): DocumentsTrustSummary {
  let quarantined = 0;
  let scanPending = 0;
  let active = 0;
  let expired = 0;
  let scanFailed = 0;
  for (const document of documents) {
    if (document.scan_status === "failed") scanFailed += 1;
    if (document.scan_status === "infected") {
      quarantined += 1;
      continue;
    }
    if (document.scan_status === "pending" && document.status !== "expired") {
      scanPending += 1;
      continue;
    }
    if (document.status === "expired") {
      expired += 1;
      continue;
    }
    active += 1;
  }
  return {
    total: documents.length,
    quarantinedCount: quarantined,
    scanPendingCount: scanPending,
    activeCount: active,
    expiredCount: expired,
    scanFailedCount: scanFailed,
    hasBlockingIssue: quarantined > 0 || scanFailed > 0,
  };
}

/* ===========================================================================
   Audit timeline
   =========================================================================== */

export type AuditGroup =
  | "decisions"
  | "processing"
  | "documents"
  | "communications"
  | "changes"
  | "other";

export type AuditActorKind = "person" | "system" | "unknown";

export interface AuditPresentation {
  event: AuditEvent;
  group: AuditGroup;
  label: string;
  icon: string;
  actorKind: AuditActorKind;
  actorLabel: string;
  tone: "neutral" | "danger";
  metadataEntries: [string, string][] | null;
}

interface AuditEventMeta {
  label: string;
  group: AuditGroup;
  actorKind: AuditActorKind;
  icon: string;
  tone?: "danger";
}

/**
 * Known audit event vocabulary. The keys are the exact `action` codes the
 * worker records. Any code not listed lands in the "other" group with the
 * humanised action label and an "unknown" actor kind — so a newer backend
 * that adds a code never causes a row to be dropped from the timeline or
 * mislabelled with a fabricated actor.
 */
const AUDIT_EVENTS: Record<string, AuditEventMeta> = {
  submission_created: { label: "Submission created", group: "changes", actorKind: "person", icon: "plus" },
  document_uploaded: { label: "Document uploaded", group: "documents", actorKind: "person", icon: "upload" },
  extraction_run: { label: "Extraction run", group: "processing", actorKind: "system", icon: "refresh" },
  extraction_denied: {
    label: "Extraction refused — not an underwriting manager",
    group: "processing",
    actorKind: "system",
    tone: "danger",
    icon: "x-circle",
  },
  extraction_reviewed: {
    label: "Risk information reviewed and corrected",
    group: "decisions",
    actorKind: "person",
    icon: "check-circle",
  },
  recommendation_run: {
    label: "Insurer recommendation run",
    group: "processing",
    actorKind: "system",
    icon: "refresh",
  },
  decision_accepted: {
    label: "Decision recorded — Atlas recommendation accepted",
    group: "decisions",
    actorKind: "person",
    icon: "check-circle",
  },
  decision_overridden: {
    label: "Decision recorded — Atlas recommendation overridden",
    group: "decisions",
    actorKind: "person",
    icon: "arrow-up-right",
  },
  decision_override_ruled_out: {
    label: "Decision recorded — routed to an insurer that was ruled out",
    group: "decisions",
    actorKind: "person",
    tone: "danger",
    icon: "alert-triangle",
  },
  decision_blocked_ruled_out_override: {
    label: "Decision blocked — a manager is required for this override",
    group: "decisions",
    actorKind: "system",
    tone: "danger",
    icon: "x-circle",
  },
  email_draft_generated: {
    label: "Communication drafted",
    group: "communications",
    actorKind: "person",
    icon: "copy",
  },
  insurer_created: { label: "Insurer added", group: "changes", actorKind: "person", icon: "plus" },
  insurer_edited: { label: "Insurer edited", group: "changes", actorKind: "person", icon: "edit" },
  insurer_document_uploaded: {
    label: "Insurer guideline uploaded",
    group: "documents",
    actorKind: "person",
    icon: "upload",
  },
  insurer_document_processed: {
    label: "Insurer guideline processed",
    group: "processing",
    actorKind: "system",
    icon: "refresh",
  },
  appetite_confirmed: { label: "Appetite rule confirmed", group: "changes", actorKind: "person", icon: "check" },
  appetite_edited: { label: "Appetite rule edited", group: "changes", actorKind: "person", icon: "edit" },
  appetite_deactivated: {
    label: "Appetite rule deactivated",
    group: "changes",
    actorKind: "person",
    icon: "minus-circle",
  },
  appetite_manual_added: {
    label: "Appetite rule added manually",
    group: "changes",
    actorKind: "person",
    icon: "plus",
  },
  sign_in: { label: "Signed in", group: "changes", actorKind: "person", icon: "user" },
  dev_sign_in: { label: "Development sign-in", group: "changes", actorKind: "person", icon: "user" },
};

function metaFor(action: string): AuditEventMeta {
  return (
    AUDIT_EVENTS[action] ?? {
      label: humanise(action, "Activity"),
      group: "other",
      actorKind: "unknown",
      icon: "info",
    }
  );
}

function actorLabelFor(kind: AuditActorKind, event: AuditEvent): string {
  if (event.actor_email) return event.actor_email;
  if (event.actor_id) return "Signed-in user (identifier withheld)";
  if (kind === "system") return "Atlas automation";
  return "Actor not recorded";
}

/**
 * Turn a raw audit event into the shape the timeline renders. Never
 * fabricates an actor — an unknown event with no actor attribution reads
 * as "Actor not recorded", not as "Atlas (automated)" which would tell
 * the reader an untrue thing about who acted.
 */
export function describeAuditEvent(event: AuditEvent): AuditPresentation {
  const meta = metaFor(event.action);
  const kind =
    meta.actorKind === "person" && !event.actor_email && !event.actor_id
      ? "unknown"
      : meta.actorKind;
  return {
    event,
    group: meta.group,
    label: meta.label,
    icon: meta.icon,
    actorKind: kind,
    actorLabel: actorLabelFor(kind, event),
    tone: meta.tone ?? "neutral",
    metadataEntries: extractMetadataEntries(event.metadata),
  };
}

function extractMetadataEntries(raw: unknown): [string, string][] | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) return null;
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length === 0) return null;
  return entries.map(([key, value]) => [humanise(key), humaniseValue(value)]);
}

/**
 * Render any metadata value to a stable, non-empty string. Objects and
 * arrays pretty-print as JSON so the caller can detect the newlines and
 * wrap them in a scroll container. Nullish and empty values return the
 * em-dash placeholder rather than the string literals "null" or
 * "undefined".
 */
export function humaniseValue(value: unknown): string {
  if (value === null || value === undefined) return EMPTY;
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : EMPTY;
  if (typeof value === "string") return value.trim() === "" ? EMPTY : value;
  if (typeof value === "object") {
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return EMPTY;
    }
  }
  return String(value);
}

export function filterAuditEvents(
  events: readonly AuditEvent[],
  group: AuditGroup | "all"
): AuditEvent[] {
  if (group === "all") return events.slice();
  return events.filter((event) => metaFor(event.action).group === group);
}

export interface AuditDayBucket {
  /** Stable calendar key: YYYY-MM-DD in the resolved timezone. */
  key: string;
  /** Human heading: "Today", "Yesterday", or a formatted date. */
  heading: string;
  events: AuditEvent[];
}

export interface GroupAuditByDayOptions {
  now?: Date;
  /** IANA timezone name; defaults to browser-local. */
  timeZone?: string;
}

/**
 * Group events into calendar-day buckets using the caller's timezone so
 * "Today" and "Yesterday" are correct across a midnight boundary. Events
 * with an unparseable timestamp are grouped under an "Unknown date"
 * bucket rather than dropped — the audit trail must never silently lose
 * an event.
 */
export function groupAuditByDay(
  events: readonly AuditEvent[],
  opts: GroupAuditByDayOptions = {}
): AuditDayBucket[] {
  const now = opts.now ?? new Date();
  const timeZone = opts.timeZone;
  const today = calendarKey(now, timeZone);
  const yesterdayDate = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const yesterday = calendarKey(yesterdayDate, timeZone);

  const buckets = new Map<string, AuditEvent[]>();
  const order: string[] = [];
  for (const event of events) {
    const parsed = new Date(event.created_at);
    const key = Number.isNaN(parsed.getTime()) ? "unknown" : calendarKey(parsed, timeZone);
    if (!buckets.has(key)) {
      buckets.set(key, []);
      order.push(key);
    }
    buckets.get(key)!.push(event);
  }

  return order.map((key) => ({
    key,
    heading: headingFor(key, today, yesterday),
    events: buckets.get(key)!,
  }));
}

function calendarKey(date: Date, timeZone: string | undefined): string {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(date);
    // en-CA locale renders as "YYYY-MM-DD" which is already the key we want.
    return parts;
  } catch {
    // An invalid timezone name falls back to browser-local; a bad Date is
    // already handled by the caller.
    return new Intl.DateTimeFormat("en-CA", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(date);
  }
}

function headingFor(key: string, today: string, yesterday: string): string {
  if (key === "unknown") return "Unknown date";
  if (key === today) return "Today";
  if (key === yesterday) return "Yesterday";
  // The key already resolves to one calendar day in the caller's timezone
  // (see calendarKey). Format it with an explicit UTC anchor so the
  // browser's local timezone cannot shift the displayed day — e.g.
  // "2026-08-13" must read as "13 Aug 2026" in Africa/Johannesburg, UTC
  // and America/Los_Angeles alike.
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!match) return formatDate(key);
  const [, y, m, d] = match;
  const utc = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  return new Intl.DateTimeFormat("en-ZA", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(utc);
}
