/**
 * Atlas — submission activity history
 * ----------------------------------------------------------------------------
 * Read-only. The record of how this submission came to be where it is, which
 * is what makes a decision defensible months later.
 *
 * Two deliberate choices:
 *  - human decisions are visually louder than system events, because when you
 *    scan a history you are looking for who decided what;
 *  - technical metadata stays behind a disclosure, so the timeline reads as
 *    prose rather than as a JSON dump.
 */

import { useEffect, useMemo, useState } from "react";
import { getAuditTimeline, type AuditEvent } from "../lib/decisions";
import { Button, Card, EmptyState, ErrorState, Skeleton } from "../components/ui";
import { Icon, type IconName } from "../components/Icon";
import { formatDateTime, formatDayHeading, humanise } from "../lib/format";

type EventGroup = "decisions" | "processing" | "documents" | "communications" | "changes";

interface EventMeta {
  label: string;
  group: EventGroup;
  /** Human decisions read louder than automated steps. */
  actor: "human" | "system";
  tone?: "danger";
  icon: IconName;
}

const EVENTS: Record<string, EventMeta> = {
  submission_created: { label: "Submission created", group: "changes", actor: "human", icon: "plus" },
  document_uploaded: { label: "Document uploaded", group: "documents", actor: "human", icon: "upload" },
  extraction_run: { label: "Extraction run", group: "processing", actor: "system", icon: "refresh" },
  extraction_denied: {
    label: "Extraction refused — not an underwriting manager",
    group: "processing",
    actor: "system",
    tone: "danger",
    icon: "x-circle",
  },
  extraction_reviewed: {
    label: "Risk information reviewed and corrected",
    group: "decisions",
    actor: "human",
    icon: "check-circle",
  },
  recommendation_run: {
    label: "Insurer recommendation run",
    group: "processing",
    actor: "system",
    icon: "refresh",
  },
  decision_accepted: {
    label: "Decision recorded — Atlas recommendation accepted",
    group: "decisions",
    actor: "human",
    icon: "check-circle",
  },
  decision_overridden: {
    label: "Decision recorded — Atlas recommendation overridden",
    group: "decisions",
    actor: "human",
    icon: "arrow-up-right",
  },
  decision_override_ruled_out: {
    label: "Decision recorded — routed to an insurer that was ruled out",
    group: "decisions",
    actor: "human",
    tone: "danger",
    icon: "alert-triangle",
  },
  decision_blocked_ruled_out_override: {
    label: "Decision blocked — a manager is required for this override",
    group: "decisions",
    actor: "system",
    tone: "danger",
    icon: "x-circle",
  },
  email_draft_generated: {
    label: "Communication drafted",
    group: "communications",
    actor: "human",
    icon: "copy",
  },
  insurer_created: { label: "Insurer added", group: "changes", actor: "human", icon: "plus" },
  insurer_edited: { label: "Insurer edited", group: "changes", actor: "human", icon: "edit" },
  insurer_document_uploaded: {
    label: "Insurer guideline uploaded",
    group: "documents",
    actor: "human",
    icon: "upload",
  },
  insurer_document_processed: {
    label: "Insurer guideline processed",
    group: "processing",
    actor: "system",
    icon: "refresh",
  },
  appetite_confirmed: { label: "Appetite rule confirmed", group: "changes", actor: "human", icon: "check" },
  appetite_edited: { label: "Appetite rule edited", group: "changes", actor: "human", icon: "edit" },
  appetite_deactivated: {
    label: "Appetite rule deactivated",
    group: "changes",
    actor: "human",
    icon: "minus-circle",
  },
  appetite_manual_added: {
    label: "Appetite rule added manually",
    group: "changes",
    actor: "human",
    icon: "plus",
  },
  sign_in: { label: "Signed in", group: "changes", actor: "human", icon: "user" },
  dev_sign_in: { label: "Development sign-in", group: "changes", actor: "human", icon: "user" },
};

function metaFor(action: string): EventMeta {
  return (
    EVENTS[action] ?? {
      label: humanise(action, "Activity"),
      group: "changes",
      actor: "system",
      icon: "info",
    }
  );
}

const FILTERS: { id: "all" | EventGroup; label: string }[] = [
  { id: "all", label: "All activity" },
  { id: "decisions", label: "Decisions" },
  { id: "processing", label: "Processing" },
  { id: "documents", label: "Documents" },
  { id: "communications", label: "Communications" },
  { id: "changes", label: "Changes" },
];

export default function AuditTimeline({ submissionId }: { submissionId: string }) {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | EventGroup>("all");
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let live = true;
    setLoading(true);
    getAuditTimeline(submissionId)
      .then((result) => {
        if (!live) return;
        setEvents(result.events);
        setError(null);
      })
      .catch(() => {
        if (live) setError("The activity history could not be loaded.");
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [submissionId, reloadToken]);

  const visible = useMemo(
    () => (filter === "all" ? events : events.filter((event) => metaFor(event.action).group === filter)),
    [events, filter]
  );

  // Group by calendar day once the history is long enough for it to help.
  const days = useMemo(() => {
    const buckets = new Map<string, AuditEvent[]>();
    for (const event of visible) {
      const key = formatDayHeading(event.created_at);
      const bucket = buckets.get(key);
      if (bucket) bucket.push(event);
      else buckets.set(key, [event]);
    }
    return Array.from(buckets.entries());
  }, [visible]);

  return (
    <Card
      title="Activity history"
      description="Every recorded action on this submission, newest first. This is the audit trail."
      actions={
        <div className="atlas-actions">
          {FILTERS.map((option) => (
            <Button
              key={option.id}
              size="sm"
              variant={filter === option.id ? "primary" : "ghost"}
              onClick={() => setFilter(option.id)}
            >
              {option.label}
            </Button>
          ))}
        </div>
      }
    >
      {loading ? (
        <div aria-hidden="true">
          <Skeleton width="30%" />
          <Skeleton />
          <Skeleton width="70%" />
          <Skeleton width="55%" />
        </div>
      ) : error ? (
        <ErrorState
          title="The activity history could not be loaded"
          message="Atlas could not read the audit log for this submission. The rest of the record is unaffected."
          onRetry={() => setReloadToken((token) => token + 1)}
        />
      ) : visible.length === 0 ? (
        <EmptyState
          inline
          title={filter === "all" ? "No activity recorded yet" : "No activity in this category"}
          body={
            filter === "all"
              ? "Actions are recorded here as the submission moves through extraction, recommendation, review and decision."
              : "Nothing in this category has happened on this submission. Switch to all activity to see the full history."
          }
        />
      ) : (
        <div>
          {days.map(([day, dayEvents]) => (
            <section key={day}>
              <h3 className="atlas-timeline__daygroup">{day}</h3>
              <ol className="atlas-timeline">
                {dayEvents.map((event) => {
                  const meta = metaFor(event.action);
                  const metadata =
                    event.metadata !== null &&
                    typeof event.metadata === "object" &&
                    Object.keys(event.metadata as object).length > 0
                      ? (event.metadata as Record<string, unknown>)
                      : null;
                  return (
                    <li
                      className={`atlas-event atlas-event--${meta.actor}${
                        meta.tone === "danger" ? " atlas-event--danger" : ""
                      }`}
                      key={event.id}
                    >
                      <span className="atlas-event__mark">
                        <Icon name={meta.icon} size={14} />
                      </span>
                      <div>
                        <p className="atlas-event__title">{meta.label}</p>
                        <p className="atlas-event__meta">
                          {event.actor_email ?? (event.actor_id ? "A user" : "Atlas (automated)")}
                        </p>
                        {metadata && (
                          <details className="atlas-disclosure" style={{ marginTop: 4 }}>
                            <summary>Recorded detail</summary>
                            <div className="atlas-disclosure__body">
                              <dl className="atlas-kv">
                                {Object.entries(metadata).map(([key, value]) => (
                                  <div className="atlas-kv__item" key={key}>
                                    <dt className="atlas-kv__key">{humanise(key)}</dt>
                                    <dd className="atlas-kv__value atlas-text-dense">
                                      {typeof value === "object" && value !== null
                                        ? JSON.stringify(value)
                                        : String(value)}
                                    </dd>
                                  </div>
                                ))}
                              </dl>
                            </div>
                          </details>
                        )}
                      </div>
                      <time className="atlas-event__time" dateTime={event.created_at}>
                        {formatDateTime(event.created_at)}
                      </time>
                    </li>
                  );
                })}
              </ol>
            </section>
          ))}
        </div>
      )}
    </Card>
  );
}
