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
 *
 * Phase 6 additions:
 *  - the filter row is a keyboard-navigable toggle group;
 *  - unknown events land in an "Other activity" group rather than being
 *    silently reclassified as "changes";
 *  - the actor line distinguishes "signed-in user (identifier withheld)"
 *    from "Atlas automation" from "Actor not recorded" — no fabricated
 *    attribution;
 *  - times carry an ISO dateTime for tooling plus a visible timezone suffix
 *    so a scrolled reader knows which clock they are reading.
 */

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { getAuditTimeline, type AuditEvent } from "../lib/decisions";
import { Card, EmptyState, ErrorState, Skeleton, useHorizontalFade } from "../components/ui";
import { Icon, type IconName } from "../components/Icon";
import { formatDateTime } from "../lib/format";
import {
  describeAuditEvent,
  filterAuditEvents,
  groupAuditByDay,
  type AuditGroup,
} from "../lib/operations-evidence";

type FilterId = "all" | AuditGroup;

const FILTERS: { id: FilterId; label: string }[] = [
  { id: "all", label: "All activity" },
  { id: "decisions", label: "Decisions" },
  { id: "processing", label: "Processing" },
  { id: "documents", label: "Documents" },
  { id: "communications", label: "Communications" },
  { id: "changes", label: "Changes" },
  { id: "other", label: "Other activity" },
];

const RESOLVED_TIME_ZONE = (() => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
})();

const TIME_ZONE_SUFFIX = (() => {
  try {
    const parts = new Intl.DateTimeFormat("en-ZA", {
      timeZoneName: "short",
    }).formatToParts(new Date());
    return parts.find((p) => p.type === "timeZoneName")?.value ?? "";
  } catch {
    return "";
  }
})();

export default function AuditTimeline({ submissionId }: { submissionId: string }) {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<FilterId>("all");
  const [reloadToken, setReloadToken] = useState(0);
  const requestSeq = useRef(0);

  useEffect(() => {
    // Same StrictMode-safe pattern the Phase 5 manager overview uses: a
    // deferred load, a per-instance sequence guard, and a cleanup flag
    // that runs before the microtask drains under a discarded mount.
    let cancelled = false;
    const seq = ++requestSeq.current;
    queueMicrotask(() => {
      if (cancelled) return;
      setLoading(true);
      getAuditTimeline(submissionId)
        .then((result) => {
          if (requestSeq.current !== seq) return;
          setEvents(result.events);
          setError(null);
        })
        .catch(() => {
          if (requestSeq.current !== seq) return;
          setError("The activity history could not be loaded.");
        })
        .finally(() => {
          if (requestSeq.current === seq) setLoading(false);
        });
    });
    return () => {
      cancelled = true;
    };
  }, [submissionId, reloadToken]);

  const visible = useMemo(() => filterAuditEvents(events, filter), [events, filter]);
  const days = useMemo(
    () => groupAuditByDay(visible, { timeZone: RESOLVED_TIME_ZONE }),
    [visible]
  );

  return (
    <Card
      title="Activity history"
      description="Every recorded action on this submission, newest first. This is the audit trail."
    >
      <FilterToggleGroup filter={filter} onChange={setFilter} />

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
          {days.map((day) => (
            <section key={day.key} aria-label={day.heading}>
              <h3 className="atlas-timeline__daygroup">{day.heading}</h3>
              <ol className="atlas-timeline">
                {day.events.map((event) => (
                  <TimelineRow key={event.id} event={event} />
                ))}
              </ol>
            </section>
          ))}
        </div>
      )}
    </Card>
  );
}

/* ===========================================================================
   Filter toggle group — one row of aria-pressed buttons, keyboard nav.
   =========================================================================== */

function FilterToggleGroup({
  filter,
  onChange,
}: {
  filter: FilterId;
  onChange: (next: FilterId) => void;
}) {
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});
  const filterbarRef = useRef<HTMLDivElement | null>(null);
  useHorizontalFade(filterbarRef);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const index = FILTERS.findIndex((f) => f.id === filter);
    if (index < 0) return;
    let next = index;
    if (event.key === "ArrowRight") next = (index + 1) % FILTERS.length;
    else if (event.key === "ArrowLeft") next = (index - 1 + FILTERS.length) % FILTERS.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = FILTERS.length - 1;
    else return;
    event.preventDefault();
    const target = FILTERS[next];
    onChange(target.id);
    refs.current[target.id]?.focus();
  }

  return (
    <nav aria-label="Filter activity by category">
      <div
        ref={filterbarRef}
        className="atlas-timeline__filterbar"
        role="group"
        aria-label="Activity filters"
        onKeyDown={onKeyDown}
      >
        {FILTERS.map((option) => {
          const active = filter === option.id;
          return (
            <button
              key={option.id}
              ref={(node) => {
                refs.current[option.id] = node;
              }}
              type="button"
              className={
                "atlas-btn atlas-btn--sm" +
                (active ? " atlas-btn--primary" : " atlas-btn--ghost")
              }
              aria-pressed={active}
              onClick={() => onChange(option.id)}
            >
              <span>{option.label}</span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}

/* ===========================================================================
   Timeline row — the presentation of one audit event.
   =========================================================================== */

function TimelineRow({ event }: { event: AuditEvent }) {
  const presentation = describeAuditEvent(event);
  const displayTime = TIME_ZONE_SUFFIX
    ? `${formatDateTime(event.created_at)} ${TIME_ZONE_SUFFIX}`
    : formatDateTime(event.created_at);
  const classes = [
    "atlas-event",
    `atlas-event--${presentation.actorKind === "person" ? "human" : presentation.actorKind}`,
    presentation.tone === "danger" ? "atlas-event--danger" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <li className={classes}>
      <span className="atlas-event__mark">
        <Icon name={presentation.icon as IconName} size={14} />
      </span>
      <div>
        <p className="atlas-event__title">{presentation.label}</p>
        <p className="atlas-event__meta">{presentation.actorLabel}</p>
        {presentation.metadataEntries && (
          <details className="atlas-disclosure" style={{ marginTop: 4 }}>
            <summary>Recorded detail</summary>
            <div className="atlas-disclosure__body">
              <dl className="atlas-kv">
                {presentation.metadataEntries.map(([key, value]) => (
                  <div className="atlas-kv__item" key={key}>
                    <dt className="atlas-kv__key">{key}</dt>
                    <dd className="atlas-kv__value atlas-text-dense">
                      <MetadataValue value={value} />
                    </dd>
                  </div>
                ))}
              </dl>
            </div>
          </details>
        )}
      </div>
      <time className="atlas-event__time" dateTime={event.created_at}>
        {displayTime}
      </time>
    </li>
  );
}

/**
 * Multi-line values (pretty-printed JSON from an object metadata entry) go
 * into a scrollable <pre> so a long payload never pushes the timeline
 * horizontally. Scalar values render inline. The incoming string was
 * already humanised by describeAuditEvent, so no further conversion is
 * needed here.
 */
function MetadataValue({ value }: { value: string }) {
  if (value.includes("\n")) {
    return (
      <pre style={{ overflowX: "auto", margin: 0, whiteSpace: "pre" }}>{value}</pre>
    );
  }
  return <span>{value}</span>;
}
