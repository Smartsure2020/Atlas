/**
 * Operations & evidence presentation helpers — pure-function tests
 * ----------------------------------------------------------------------------
 * Nothing in this file touches the API surface. Covers:
 *   - stable alert ordering (severity, then status, then created_at desc)
 *   - equal-priority stability, and unknown severities/statuses kept
 *   - job-intervention ordering (failed → stuck → cancel-pending)
 *   - progress_percent = null renders as EMPTY, not "0%"
 *   - stuck heartbeat detection at the boundary and with a missing beat
 *   - document grouping — quarantine wins over expiry, scan_pending wins
 *     over active, every document reaches exactly one bucket
 *   - trust summary hasBlockingIssue semantics (scan-in-progress not blocking)
 *   - audit event descriptions, including the unknown-code catch-all in
 *     "other" and honest "Actor not recorded" attribution
 *   - metadata entries with humanised values and object serialisation
 *   - filter round-trips and empty results
 *   - calendar-day grouping across midnight in a supplied timezone
 *   - malformed timestamps and unknown timezones
 *   - input immutability under freeze
 */

import { describe, expect, it } from "vitest";
import type { AtlasJob, OperationalAlert, SystemStatus, JobSummary } from "../lib/phase7";
import type { AuditEvent } from "../lib/decisions";
import {
  describeAuditEvent,
  documentsTrustSummary,
  filterAuditEvents,
  groupAuditByDay,
  groupDocuments,
  hasCriticalOpenAlert,
  humaniseValue,
  jobsNeedingIntervention,
  orderAlerts,
  processingExceptionMetrics,
  summariseJob,
} from "../lib/operations-evidence";

/* ---------- factories ------------------------------------------------------ */

function alert(over: Partial<OperationalAlert> = {}): OperationalAlert {
  return {
    id: over.id ?? "al_" + Math.random().toString(36).slice(2, 8),
    alert_type: over.alert_type ?? "job_failure",
    severity: over.severity ?? "warning",
    status: over.status ?? "open",
    title: over.title ?? "Alert",
    message: over.message ?? "Something needs a look.",
    created_at: over.created_at ?? "2026-08-14T10:00:00Z",
    escalation_due_at: over.escalation_due_at ?? null,
    escalated_at: over.escalated_at ?? null,
  };
}

function job(over: Partial<AtlasJob> = {}): AtlasJob {
  return {
    id: over.id ?? "job_" + Math.random().toString(36).slice(2, 8),
    submission_id: over.submission_id ?? null,
    document_id: over.document_id ?? null,
    quote_review_id: over.quote_review_id ?? null,
    insurer_id: over.insurer_id ?? null,
    job_type: over.job_type ?? "extraction",
    status: over.status ?? "queued",
    result_reference_id: over.result_reference_id ?? null,
    error_code: over.error_code ?? null,
    error_message: over.error_message ?? null,
    started_at: over.started_at ?? null,
    completed_at: over.completed_at ?? null,
    created_at: over.created_at ?? "2026-08-14T10:00:00Z",
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

function event(over: Partial<AuditEvent> = {}): AuditEvent {
  return {
    id: over.id ?? "ev_" + Math.random().toString(36).slice(2, 8),
    action: over.action ?? "submission_created",
    actor_id: over.actor_id ?? null,
    actor_email: over.actor_email ?? null,
    metadata: over.metadata ?? null,
    created_at: over.created_at ?? "2026-08-14T10:00:00Z",
  };
}

/* ---------- orderAlerts ---------------------------------------------------- */

describe("orderAlerts", () => {
  const NOW = new Date("2026-08-14T12:00:00Z");

  it("orders critical before warning before info", () => {
    const rows = orderAlerts(
      [
        alert({ id: "a", severity: "info" }),
        alert({ id: "b", severity: "critical" }),
        alert({ id: "c", severity: "warning" }),
      ],
      NOW
    );
    expect(rows.map((r) => r.alert.id)).toEqual(["b", "c", "a"]);
  });

  it("orders open before acknowledged before resolved within a severity", () => {
    const rows = orderAlerts(
      [
        alert({ id: "a", severity: "critical", status: "resolved" }),
        alert({ id: "b", severity: "critical", status: "acknowledged" }),
        alert({ id: "c", severity: "critical", status: "open" }),
      ],
      NOW
    );
    expect(rows.map((r) => r.alert.id)).toEqual(["c", "b", "a"]);
  });

  it("orders newest first within an equal severity+status bucket", () => {
    const rows = orderAlerts(
      [
        alert({ id: "old", severity: "critical", status: "open", created_at: "2026-08-14T09:00:00Z" }),
        alert({ id: "new", severity: "critical", status: "open", created_at: "2026-08-14T11:00:00Z" }),
      ],
      NOW
    );
    expect(rows.map((r) => r.alert.id)).toEqual(["new", "old"]);
  });

  it("is stable when two alerts collide on every rank key", () => {
    const inputs = [
      alert({ id: "first", severity: "warning", status: "open", created_at: "2026-08-14T10:00:00Z" }),
      alert({ id: "second", severity: "warning", status: "open", created_at: "2026-08-14T10:00:00Z" }),
      alert({ id: "third", severity: "warning", status: "open", created_at: "2026-08-14T10:00:00Z" }),
    ];
    const rows = orderAlerts(inputs, NOW);
    expect(rows.map((r) => r.alert.id)).toEqual(["first", "second", "third"]);
  });

  it("keeps unknown severities and statuses instead of dropping them", () => {
    const rows = orderAlerts(
      [
        alert({ id: "mystery", severity: "chatter" as OperationalAlert["severity"] }),
        alert({ id: "known", severity: "critical" }),
      ],
      NOW
    );
    expect(rows.map((r) => r.alert.id)).toEqual(["known", "mystery"]);
  });

  it("returns [] for an empty input and never mutates its argument", () => {
    const empty: OperationalAlert[] = [];
    Object.freeze(empty);
    expect(orderAlerts(empty, NOW)).toEqual([]);
    const frozen = [alert({ id: "a", severity: "warning" }), alert({ id: "b", severity: "critical" })];
    Object.freeze(frozen);
    const rows = orderAlerts(frozen, NOW);
    expect(rows.map((r) => r.alert.id)).toEqual(["b", "a"]);
    expect(frozen.map((a) => a.id)).toEqual(["a", "b"]);
  });

  it("computes actionability from status", () => {
    const rows = orderAlerts(
      [
        alert({ id: "o", status: "open" }),
        alert({ id: "a", status: "acknowledged" }),
        alert({ id: "r", status: "resolved" }),
      ],
      NOW
    );
    const byId = Object.fromEntries(rows.map((r) => [r.alert.id, r.actionability]));
    expect(byId).toEqual({
      o: "acknowledge_and_resolve",
      a: "resolve_only",
      r: "read_only",
    });
  });

  it("describes escalation hints honestly", () => {
    const rows = orderAlerts(
      [
        alert({ id: "future", escalation_due_at: "2026-08-14T14:00:00Z" }),
        alert({ id: "overdue", escalation_due_at: "2026-08-14T09:00:00Z" }),
        alert({ id: "escalated", escalation_due_at: "2026-08-14T09:00:00Z", escalated_at: "2026-08-14T10:00:00Z" }),
        alert({ id: "none" }),
      ],
      NOW
    );
    const byId = Object.fromEntries(rows.map((r) => [r.alert.id, r.escalationHint]));
    expect(byId.none).toBeNull();
    expect(byId.overdue).toBe("Escalation overdue");
    expect(byId.escalated).toMatch(/^Escalated /);
    expect(byId.future).toMatch(/^Escalates /);
  });
});

describe("hasCriticalOpenAlert", () => {
  it("is true only when a critical alert is not resolved", () => {
    expect(hasCriticalOpenAlert([])).toBe(false);
    expect(
      hasCriticalOpenAlert([alert({ severity: "critical", status: "resolved" })])
    ).toBe(false);
    expect(
      hasCriticalOpenAlert([alert({ severity: "critical", status: "acknowledged" })])
    ).toBe(true);
    expect(
      hasCriticalOpenAlert([alert({ severity: "warning", status: "open" })])
    ).toBe(false);
  });
});

/* ---------- summariseJob / jobsNeedingIntervention ------------------------- */

describe("summariseJob", () => {
  it("returns EMPTY for progress when no progress_percent is recorded", () => {
    const presentation = summariseJob(job({ status: "running" }));
    expect(presentation.progressLabel).toBe("—");
  });

  it("does not render 0% for a missing progress reading", () => {
    const zeroReading = summariseJob(job({ status: "running", progress_percent: 0 }));
    expect(zeroReading.progressLabel).toBe("0%");
    const missing = summariseJob(job({ status: "running" }));
    expect(missing.progressLabel).not.toBe("0%");
  });

  it("uses default retry budget of two when the API omits it", () => {
    const presentation = summariseJob(job({ status: "failed" }));
    expect(presentation.attemptLabel).toBe("1 of 3");
    expect(presentation.intervention).toBe("retry_available");
  });

  it("marks retry as exhausted when the job is out of budget", () => {
    const presentation = summariseJob(
      job({ status: "failed", retry_count: 2, max_retries: 2 })
    );
    expect(presentation.intervention).toBe("retry_exhausted");
  });

  it("labels cancellation-pending running jobs", () => {
    const presentation = summariseJob(
      job({ status: "running", cancellation_requested: true })
    );
    expect(presentation.intervention).toBe("cancel_pending");
  });

  it("prefers error_message but falls back to a humanised error_code", () => {
    expect(summariseJob(job({ status: "failed", error_message: "Timed out" })).causeLabel).toBe("Timed out");
    expect(summariseJob(job({ status: "failed", error_code: "provider_timeout" })).causeLabel).toBe("Provider timeout");
    expect(summariseJob(job({ status: "failed" })).causeLabel).toBeNull();
  });

  it("classifies the submission context from linkage", () => {
    expect(summariseJob(job({ submission_id: "sub_1" })).submissionContext).toBe("submission");
    expect(summariseJob(job({ insurer_id: "ins_1" })).submissionContext).toBe("insurer_guideline");
    expect(summariseJob(job()).submissionContext).toBe("unlinked");
  });
});

describe("jobsNeedingIntervention", () => {
  const NOW = new Date("2026-08-14T12:00:00Z");
  const stuckThresholdMs = 15 * 60 * 1000;

  it("returns an empty list when nothing is failing or stuck", () => {
    expect(jobsNeedingIntervention([job({ status: "completed" })], { now: NOW })).toEqual([]);
  });

  it("orders failed-with-retries before stuck before cancel-pending", () => {
    const failed = job({ id: "f", status: "failed" });
    const stuck = job({
      id: "s",
      status: "running",
      heartbeat_at: "2026-08-14T11:00:00Z",
      created_at: "2026-08-14T09:00:00Z",
    });
    const cancelling = job({
      id: "c",
      status: "running",
      cancellation_requested: true,
      heartbeat_at: "2026-08-14T11:59:00Z",
    });
    const rows = jobsNeedingIntervention([cancelling, stuck, failed], { now: NOW, stuckThresholdMs });
    expect(rows.map((r) => r.job.id)).toEqual(["f", "s", "c"]);
  });

  it("treats a missing heartbeat as stuck", () => {
    const stuck = job({ id: "s", status: "running", heartbeat_at: null });
    const rows = jobsNeedingIntervention([stuck], { now: NOW, stuckThresholdMs });
    expect(rows.map((r) => r.job.id)).toEqual(["s"]);
  });

  it("respects the stuck threshold boundary", () => {
    // Exactly at threshold → stuck. One millisecond inside → not stuck.
    const atThreshold = job({
      id: "at",
      status: "running",
      heartbeat_at: new Date(NOW.getTime() - stuckThresholdMs).toISOString(),
    });
    const inside = job({
      id: "in",
      status: "running",
      heartbeat_at: new Date(NOW.getTime() - stuckThresholdMs + 1).toISOString(),
    });
    const rows = jobsNeedingIntervention([atThreshold, inside], { now: NOW, stuckThresholdMs });
    expect(rows.map((r) => r.job.id)).toEqual(["at"]);
  });

  it("excludes running jobs whose cancellation was requested from the stuck bucket", () => {
    const cancelling = job({
      id: "c",
      status: "running",
      cancellation_requested: true,
      heartbeat_at: null,
    });
    const rows = jobsNeedingIntervention([cancelling], { now: NOW, stuckThresholdMs });
    expect(rows.map((r) => r.job.id)).toEqual(["c"]);
    expect(rows[0].intervention).toBe("cancel_pending");
  });

  it("excludes retry-exhausted failed jobs", () => {
    const exhausted = job({
      id: "e",
      status: "failed",
      retry_count: 2,
      max_retries: 2,
    });
    expect(jobsNeedingIntervention([exhausted], { now: NOW, stuckThresholdMs })).toEqual([]);
  });

  it("does not mutate its inputs", () => {
    const jobs = [job({ status: "failed" }), job({ status: "completed" })];
    Object.freeze(jobs);
    jobsNeedingIntervention(jobs, { now: NOW, stuckThresholdMs });
    expect(jobs).toHaveLength(2);
  });
});

/* ---------- processingExceptionMetrics ------------------------------------ */

describe("processingExceptionMetrics", () => {
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

  it("uses systemStatus counts when present", () => {
    const tiles = processingExceptionMetrics({
      systemStatus: status({ failed_count: 3, stuck_count: 1 }),
      summary: null,
      alerts: [],
      expiredDocumentCount: 0,
    });
    expect(tiles.find((t) => t.key === "failed_24h")?.value).toBe(3);
    expect(tiles.find((t) => t.key === "stuck_24h")?.value).toBe(1);
    expect(tiles.find((t) => t.key === "expired_documents")?.attention).toBe(false);
  });

  it("falls back to job summary when systemStatus is missing", () => {
    const summary: JobSummary = {
      failed_count: 4,
      stuck_count: 2,
      by_error_code: {},
      recent_failed_jobs: [],
      stuck_jobs: [],
    };
    const tiles = processingExceptionMetrics({
      systemStatus: null,
      summary,
      alerts: [],
      expiredDocumentCount: null,
    });
    expect(tiles.find((t) => t.key === "failed_24h")?.value).toBe(4);
    expect(tiles.find((t) => t.key === "stuck_24h")?.value).toBe(2);
    expect(tiles.find((t) => t.key === "expired_documents")?.value).toBe(0);
  });

  it("counts open critical and open total separately", () => {
    const tiles = processingExceptionMetrics({
      systemStatus: null,
      summary: null,
      alerts: [
        alert({ severity: "critical", status: "open" }),
        alert({ severity: "critical", status: "acknowledged" }),
        alert({ severity: "warning", status: "open" }),
        alert({ severity: "critical", status: "resolved" }),
      ],
      expiredDocumentCount: 0,
    });
    expect(tiles.find((t) => t.key === "open_critical_alerts")?.value).toBe(2);
    expect(tiles.find((t) => t.key === "open_alerts")?.value).toBe(3);
  });

  it("labels every tile's scope tag", () => {
    const tiles = processingExceptionMetrics({
      systemStatus: null,
      summary: null,
      alerts: [],
      expiredDocumentCount: 0,
    });
    expect(tiles.map((t) => [t.key, t.scope])).toEqual([
      ["failed_24h", "last_24h"],
      ["stuck_24h", "last_24h"],
      ["open_critical_alerts", "current"],
      ["open_alerts", "current"],
      ["expired_documents", "retention_backlog"],
    ]);
  });
});

/* ---------- groupDocuments / documentsTrustSummary ------------------------ */

describe("groupDocuments", () => {
  it("returns four buckets in a fixed order even when empty", () => {
    const groups = groupDocuments([]);
    expect(groups.map((g) => g.key)).toEqual(["quarantined", "scan_pending", "active", "expired"]);
    for (const group of groups) expect(group.documents).toEqual([]);
  });

  it("routes quarantine ahead of expiry", () => {
    const doc = { id: "d1", scan_status: "infected", status: "expired" };
    const groups = groupDocuments([doc]);
    expect(groups.find((g) => g.key === "quarantined")?.documents).toEqual([doc]);
    expect(groups.find((g) => g.key === "expired")?.documents).toEqual([]);
  });

  it("routes scan-in-progress ahead of active", () => {
    const doc = { id: "d1", scan_status: "pending" };
    const groups = groupDocuments([doc]);
    expect(groups.find((g) => g.key === "scan_pending")?.documents).toEqual([doc]);
    expect(groups.find((g) => g.key === "active")?.documents).toEqual([]);
  });

  it("puts every document in exactly one bucket for a mixed input", () => {
    const rows = [
      { id: "a", scan_status: "clean" },
      { id: "b", scan_status: "pending" },
      { id: "c", scan_status: "infected" },
      { id: "d", status: "expired", scan_status: "clean" },
      { id: "e" }, // no scan status: treated as active
    ];
    const groups = groupDocuments(rows);
    const total = groups.reduce((sum, g) => sum + g.documents.length, 0);
    expect(total).toBe(rows.length);
  });
});

describe("documentsTrustSummary", () => {
  it("counts every classification and flags blocking issues honestly", () => {
    const summary = documentsTrustSummary([
      { id: "a", scan_status: "clean" },
      { id: "b", scan_status: "pending" },
      { id: "c", scan_status: "infected" },
      { id: "d", scan_status: "failed" },
      { id: "e", status: "expired" },
    ]);
    expect(summary.total).toBe(5);
    expect(summary.quarantinedCount).toBe(1);
    expect(summary.scanPendingCount).toBe(1);
    // A "failed" scan is a blocking-but-visible outcome: it is not quarantined
    // and not pending, so it lands in the active bucket alongside "clean".
    // scanFailedCount is the parallel signal that a page can use to warn.
    expect(summary.activeCount).toBe(2);
    expect(summary.expiredCount).toBe(1);
    expect(summary.scanFailedCount).toBe(1);
    expect(summary.hasBlockingIssue).toBe(true);
  });

  it("does not block on scan-in-progress alone", () => {
    const summary = documentsTrustSummary([{ id: "a", scan_status: "pending" }]);
    expect(summary.hasBlockingIssue).toBe(false);
    expect(summary.scanPendingCount).toBe(1);
  });
});

/* ---------- describeAuditEvent + filter + groupByDay ----------------------- */

describe("describeAuditEvent", () => {
  it("describes a known event with its group, label and person actor", () => {
    const presentation = describeAuditEvent(
      event({ action: "decision_accepted", actor_email: "u@example.com" })
    );
    expect(presentation.group).toBe("decisions");
    expect(presentation.label).toMatch(/Decision recorded/);
    expect(presentation.actorKind).toBe("person");
    expect(presentation.actorLabel).toBe("u@example.com");
  });

  it("routes unknown actions to the 'other' group with unknown actor and info icon", () => {
    const presentation = describeAuditEvent(event({ action: "some_new_action" }));
    expect(presentation.group).toBe("other");
    expect(presentation.icon).toBe("info");
    expect(presentation.actorKind).toBe("unknown");
    expect(presentation.actorLabel).toBe("Actor not recorded");
    // The humanised label preserves the original action code — never dropped.
    expect(presentation.label).toBe("Some new action");
  });

  it("distinguishes system automation from an unknown actor", () => {
    const system = describeAuditEvent(event({ action: "extraction_run" }));
    expect(system.actorKind).toBe("system");
    expect(system.actorLabel).toBe("Atlas automation");

    const unknown = describeAuditEvent(event({ action: "some_new_action" }));
    expect(unknown.actorLabel).toBe("Actor not recorded");
  });

  it("hides an actor id but does not invent an email", () => {
    const withId = describeAuditEvent(
      event({ action: "decision_accepted", actor_id: "u_abc" })
    );
    expect(withId.actorLabel).toBe("Signed-in user (identifier withheld)");
  });

  it("extracts metadata entries as humanised key/value pairs", () => {
    const presentation = describeAuditEvent(
      event({
        action: "decision_overridden",
        metadata: { reason_code: "client_preference", note: "escalated by broker" },
      })
    );
    expect(presentation.metadataEntries).toEqual([
      ["Reason code", "client_preference"],
      ["Note", "escalated by broker"],
    ]);
  });

  it("serialises object metadata values with newlines so the page can scroll them", () => {
    const presentation = describeAuditEvent(
      event({ action: "extraction_run", metadata: { detail: { pages: 3, source: "pdf" } } })
    );
    const value = presentation.metadataEntries?.[0][1] ?? "";
    expect(value).toContain("\n");
    expect(value).toContain("\"pages\"");
  });

  it("returns null metadata when the event has none or when it is an empty object", () => {
    expect(describeAuditEvent(event({ metadata: null })).metadataEntries).toBeNull();
    expect(describeAuditEvent(event({ metadata: {} })).metadataEntries).toBeNull();
  });

  it("keeps a danger tone for events flagged as dangerous", () => {
    expect(describeAuditEvent(event({ action: "decision_blocked_ruled_out_override" })).tone).toBe(
      "danger"
    );
  });
});

describe("humaniseValue", () => {
  it("returns EMPTY for null, undefined and empty strings", () => {
    expect(humaniseValue(null)).toBe("—");
    expect(humaniseValue(undefined)).toBe("—");
    expect(humaniseValue("")).toBe("—");
    expect(humaniseValue("   ")).toBe("—");
  });

  it("stringifies booleans as Yes/No, numbers as themselves, keeps strings intact", () => {
    expect(humaniseValue(true)).toBe("Yes");
    expect(humaniseValue(false)).toBe("No");
    expect(humaniseValue(42)).toBe("42");
    expect(humaniseValue("hello")).toBe("hello");
  });

  it("pretty-prints objects and arrays", () => {
    expect(humaniseValue({ a: 1 })).toBe(`{\n  "a": 1\n}`);
    expect(humaniseValue([1, 2])).toBe(`[\n  1,\n  2\n]`);
  });

  it("returns EMPTY for non-finite numbers", () => {
    expect(humaniseValue(Number.NaN)).toBe("—");
    expect(humaniseValue(Number.POSITIVE_INFINITY)).toBe("—");
  });
});

describe("filterAuditEvents", () => {
  it("returns a copy for 'all' rather than the same reference", () => {
    const events = [event({ action: "extraction_run" })];
    const result = filterAuditEvents(events, "all");
    expect(result).not.toBe(events);
    expect(result).toEqual(events);
  });

  it("filters by group and yields empty for a group with no matches", () => {
    const events = [
      event({ id: "a", action: "extraction_run" }),
      event({ id: "b", action: "decision_accepted" }),
      event({ id: "c", action: "some_new_action" }),
    ];
    expect(filterAuditEvents(events, "processing").map((e) => e.id)).toEqual(["a"]);
    expect(filterAuditEvents(events, "decisions").map((e) => e.id)).toEqual(["b"]);
    expect(filterAuditEvents(events, "other").map((e) => e.id)).toEqual(["c"]);
    expect(filterAuditEvents(events, "communications")).toEqual([]);
  });
});

describe("groupAuditByDay", () => {
  it("labels the same-day and yesterday buckets in the caller's timezone", () => {
    // Anchor "now" at 12:00 UTC on 14 Aug 2026. The 13 Aug 15:00 UTC event is
    // "yesterday" in UTC and the 08 Aug event is older still.
    const now = new Date("2026-08-14T12:00:00Z");
    const events = [
      event({ id: "today", created_at: "2026-08-14T09:00:00Z" }),
      event({ id: "yesterday", created_at: "2026-08-13T15:00:00Z" }),
      event({ id: "older", created_at: "2026-08-08T09:00:00Z" }),
    ];
    const buckets = groupAuditByDay(events, { now, timeZone: "UTC" });
    const byKey = Object.fromEntries(buckets.map((b) => [b.events[0].id, b.heading]));
    expect(byKey.today).toBe("Today");
    expect(byKey.yesterday).toBe("Yesterday");
    expect(byKey.older).toMatch(/2026/);
  });

  it("respects the timezone across a midnight boundary", () => {
    // 01:00 UTC on 14 Aug 2026 is 03:00 on 14 Aug in Europe/Berlin (CEST)
    // and 21:00 on 13 Aug in America/New_York — the same instant lands in
    // different calendar days depending on timezone.
    const eventUtc = event({ id: "boundary", created_at: "2026-08-14T01:00:00Z" });
    const nowUtc = new Date("2026-08-14T05:00:00Z");
    const berlin = groupAuditByDay([eventUtc], { now: nowUtc, timeZone: "Europe/Berlin" });
    const newYork = groupAuditByDay([eventUtc], { now: nowUtc, timeZone: "America/New_York" });
    expect(berlin[0].heading).toBe("Today");
    expect(newYork[0].heading).toBe("Yesterday");
  });

  it("groups unparseable timestamps under an Unknown date rather than dropping them", () => {
    const buckets = groupAuditByDay(
      [event({ id: "broken", created_at: "not-a-date" })],
      { now: new Date("2026-08-14T00:00:00Z"), timeZone: "UTC" }
    );
    expect(buckets).toHaveLength(1);
    expect(buckets[0].key).toBe("unknown");
    expect(buckets[0].heading).toBe("Unknown date");
    expect(buckets[0].events.map((e) => e.id)).toEqual(["broken"]);
  });

  it("falls back gracefully when the timezone is invalid", () => {
    const buckets = groupAuditByDay(
      [event({ created_at: "2026-08-14T09:00:00Z" })],
      { now: new Date("2026-08-14T09:00:00Z"), timeZone: "Not/AZone" }
    );
    // The exact heading depends on the runtime's local timezone, but the
    // function must not throw and must produce a single grouped bucket.
    expect(buckets).toHaveLength(1);
    expect(buckets[0].events).toHaveLength(1);
  });

  it("preserves first-seen order across buckets", () => {
    const events = [
      event({ id: "x", created_at: "2026-08-14T09:00:00Z" }),
      event({ id: "y", created_at: "2026-08-13T09:00:00Z" }),
      event({ id: "z", created_at: "2026-08-14T10:00:00Z" }),
    ];
    const buckets = groupAuditByDay(events, {
      now: new Date("2026-08-14T12:00:00Z"),
      timeZone: "UTC",
    });
    expect(buckets.map((b) => b.events.map((e) => e.id))).toEqual([["x", "z"], ["y"]]);
  });
});
