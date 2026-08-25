/**
 * Atlas — manager oversight workbench
 * ----------------------------------------------------------------------------
 * This screen answers, in order, the questions an underwriting manager comes
 * here to answer:
 *   - What needs attention now?
 *   - Where is work getting stuck?
 *   - Which outcomes recur most often?
 *   - Where are staff departing from Atlas's recommendation?
 *   - What information gaps repeatedly delay underwriting?
 *   - Are communication drafts being followed through and recorded?
 *
 * ManagerStats has an important semantic split the old layout did not surface:
 * only some fields respect the toolbar filters (period, outcome, insurer,
 * consultant, line, decision outcome). Aggregate counts and pattern lists are
 * capped by a recent server-side limit and read "across recent activity"
 * regardless of the filter state. Every section here labels which scope it
 * belongs to, so a zero during a filtered view never reads as "nothing
 * happened".
 *
 * Filter interaction: Period is applied immediately (single select, one
 * request). Advanced filters — including the two opaque identifier fields —
 * live behind a disclosure and apply as one batch. That protects the API from
 * per-keystroke requests against an incomplete identifier, while keeping the
 * chip-remove and Clear-all affordances intact.
 */

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { getManagerStatsFiltered, type ManagerStats } from "../lib/phase4";
import {
  Button,
  Card,
  CardSkeleton,
  Disclosure,
  EmptyState,
  ErrorState,
  FilterChips,
  Notice,
  PageHeader,
  StatusBadge,
  type ActiveFilter,
} from "../components/ui";
import { DataTable, type Column, type SortState } from "../components/DataTable";
import type { QuoteReview } from "../lib/quote-reviews";
import {
  ATLAS_NEVER_SENDS_MESSAGE,
  LINE_OF_BUSINESS_OPTIONS,
  lineOfBusinessLabel,
  QUOTE_REVIEW_STATUS,
  quoteReviewStatus,
} from "../lib/status";
import { formatDateTime, formatRelative, humanise } from "../lib/format";
import {
  allPatternsEmpty,
  barWidth,
  communicationsSummary,
  dateRangeLabel,
  exceptionMetrics,
  exceptionScopeSuffix,
  maxCount,
  orderReviewOutcomes,
  OVERSIGHT_DATE_RANGES,
  workloadMetrics,
  type OversightDateRange,
} from "../lib/oversight";

/**
 * Kept in shape identical to the worker API contract so the mapping below
 * remains obviously 1:1 with what the endpoint accepts.
 */
interface Filters {
  dateRange: OversightDateRange;
  status: string;
  outcome: string;
  lineOfBusiness: string;
  insurerId: string;
  consultantId: string;
}

const EMPTY_FILTERS: Filters = {
  dateRange: "30d",
  status: "",
  outcome: "",
  lineOfBusiness: "",
  insurerId: "",
  consultantId: "",
};

function toApi(filters: Filters) {
  return {
    date_range: filters.dateRange,
    status: filters.status || undefined,
    outcome: filters.outcome || undefined,
    insurer_id: filters.insurerId || undefined,
    consultant_id: filters.consultantId || undefined,
    line_of_business: filters.lineOfBusiness || undefined,
  };
}

export default function ManagerDashboard({
  onOpenSubmission,
}: {
  onOpenSubmission: (id: string) => void;
}) {
  // `applied` is the filter state that has actually been sent to the API.
  // `draft` is what the disclosure form is currently editing. This split lets
  // an underwriter type a partial insurer identifier without triggering a
  // request on every keystroke, while keeping FilterChips and Clear all wired
  // to the applied state.
  const [applied, setApplied] = useState<Filters>(EMPTY_FILTERS);
  const [draft, setDraft] = useState<Filters>(EMPTY_FILTERS);
  const [stats, setStats] = useState<ManagerStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [hydrated, setHydrated] = useState(false);
  // Split the error slot the same way ProcessingJobs / Insurers /
  // InsurerDetail do. A silent refresh failure keeps the last-good stats
  // visible under a stale-data warning instead of blanking the whole page.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const requestSeq = useRef(0);
  // A raced older request that resolves after a newer one succeeds could
  // read a stale `hydrated=false` from its closure and drive the fetch
  // handler down the "no trustworthy data" branch — blanking freshly
  // hydrated stats. `hydratedRef` mirrors the state through the same
  // setState path so every handler reads the live value.
  const hydratedRef = useRef(false);

  useEffect(() => {
    // Two guards work together here.
    //
    // 1. Cancellation gate. The fetch call itself is deferred by one
    //    microtask, and the effect's cleanup flips `cancelled`. Under React
    //    18/19 StrictMode the mount effect runs, its cleanup runs, and the
    //    replacement mount effect runs — all synchronously, before any
    //    microtask drains. That means the discarded mount's fetch is
    //    cancelled *before* it is issued, and only the surviving mount
    //    reaches the network. Under a real remount or a genuine dependency
    //    change, the same mechanism cancels the previous in-flight
    //    scheduling and starts a fresh one, so refresh-with-existing-data
    //    and retry paths keep working.
    // 2. Sequence guard. If a request slips past the cancellation gate and
    //    is still resolving when a newer one has already landed, its
    //    setState calls are dropped so a stale response cannot overwrite
    //    the newer data.
    let cancelled = false;
    const seq = ++requestSeq.current;
    queueMicrotask(() => {
      if (cancelled) return;
      setLoading(true);
      getManagerStatsFiltered(toApi(applied))
        .then((result) => {
          if (requestSeq.current !== seq) return;
          setStats(result.stats);
          setLoadError(null);
          setRefreshError(null);
          hydratedRef.current = true;
          setHydrated(true);
        })
        .catch((cause: Error) => {
          if (requestSeq.current !== seq) return;
          const message =
            cause.message === "manager_only"
              ? "This overview is available to underwriting managers and administrators only."
              : cause.message === "not_authenticated"
                ? "Your session has expired. Sign in again to view the manager overview."
                : "The manager overview could not be loaded. The Atlas API did not respond.";
          if (hydratedRef.current) {
            // Keep the last-good stats visible under a stale-data warning
            // rather than blanking a filter change or a transient 500.
            setRefreshError(
              cause.message === "not_authenticated"
                ? "Your session has expired, so Atlas could not refresh the manager overview. The information shown may be outdated. Sign in again to reload."
                : "Atlas could not refresh the manager overview. The information shown may be outdated."
            );
          } else {
            setLoadError(message);
          }
        })
        .finally(() => {
          if (requestSeq.current === seq) setLoading(false);
        });
    });
    return () => {
      cancelled = true;
    };
  }, [applied, reloadToken]);

  const applyDraft = useCallback(
    (event?: FormEvent<HTMLFormElement>) => {
      event?.preventDefault();
      setApplied(draft);
    },
    [draft]
  );

  const clearAll = useCallback(() => {
    setDraft(EMPTY_FILTERS);
    setApplied(EMPTY_FILTERS);
  }, []);

  const activeFilters: ActiveFilter[] = useMemo(() => {
    const list: ActiveFilter[] = [];
    if (applied.dateRange !== "30d") {
      list.push({
        key: "range",
        label: "Period",
        value: dateRangeLabel(applied.dateRange),
        onRemove: () => {
          setDraft((current) => ({ ...current, dateRange: "30d" }));
          setApplied((current) => ({ ...current, dateRange: "30d" }));
        },
      });
    }
    if (applied.status) {
      list.push({
        key: "status",
        label: "Review outcome",
        value: quoteReviewStatus(applied.status).label,
        onRemove: () => {
          setDraft((current) => ({ ...current, status: "" }));
          setApplied((current) => ({ ...current, status: "" }));
        },
      });
    }
    if (applied.outcome) {
      list.push({
        key: "outcome",
        label: "Decision outcome",
        value: quoteReviewStatus(applied.outcome).label,
        onRemove: () => {
          setDraft((current) => ({ ...current, outcome: "" }));
          setApplied((current) => ({ ...current, outcome: "" }));
        },
      });
    }
    if (applied.lineOfBusiness) {
      list.push({
        key: "line",
        label: "Line",
        value: lineOfBusinessLabel(applied.lineOfBusiness),
        onRemove: () => {
          setDraft((current) => ({ ...current, lineOfBusiness: "" }));
          setApplied((current) => ({ ...current, lineOfBusiness: "" }));
        },
      });
    }
    if (applied.insurerId) {
      list.push({
        key: "insurer",
        label: "Insurer identifier",
        value: applied.insurerId,
        onRemove: () => {
          setDraft((current) => ({ ...current, insurerId: "" }));
          setApplied((current) => ({ ...current, insurerId: "" }));
        },
      });
    }
    if (applied.consultantId) {
      list.push({
        key: "consultant",
        label: "Consultant identifier",
        value: applied.consultantId,
        onRemove: () => {
          setDraft((current) => ({ ...current, consultantId: "" }));
          setApplied((current) => ({ ...current, consultantId: "" }));
        },
      });
    }
    return list;
  }, [applied]);

  if (loadError && !hydrated) {
    return (
      <div>
        <PageHeader
          eyebrow="Oversight"
          title="Manager overview"
          description="Review outcomes, outstanding information, referrals and overrides across the team."
        />
        <ErrorState
          title="The manager overview could not be loaded"
          message={loadError}
          onRetry={() => setReloadToken((token) => token + 1)}
        />
      </div>
    );
  }

  const draftDiffersFromApplied =
    draft.dateRange !== applied.dateRange ||
    draft.status !== applied.status ||
    draft.outcome !== applied.outcome ||
    draft.lineOfBusiness !== applied.lineOfBusiness ||
    draft.insurerId !== applied.insurerId ||
    draft.consultantId !== applied.consultantId;

  return (
    <div className="atlas-oversight">
      <PageHeader
        eyebrow="Oversight"
        title="Manager overview"
        description="Where work is getting stuck, which decisions departed from the Atlas recommendation, and what the team is waiting on."
      />

      {refreshError && (
        <div style={{ marginBottom: "var(--atlas-space-4)" }}>
          <Notice
            tone="warning"
            role="status"
            title="Atlas could not refresh the manager overview"
            actions={
              <Button
                size="sm"
                icon="refresh"
                onClick={() => setReloadToken((token) => token + 1)}
                aria-busy={loading || undefined}
              >
                {loading ? "Refreshing…" : "Try again"}
              </Button>
            }
          >
            {refreshError}
          </Notice>
        </div>
      )}

      <OversightFilterBar
        applied={applied}
        draft={draft}
        onDraftChange={setDraft}
        onApply={applyDraft}
        onPeriodChange={(next) => {
          // Period is a single-select — apply it in the same tick, and keep
          // the disclosure draft in sync so opening it does not show a stale
          // value. Applying through explicit setters avoids the stale-closure
          // trap of calling onApply after setDraft.
          const nextFilters = { ...applied, dateRange: next };
          setDraft(nextFilters);
          setApplied(nextFilters);
        }}
        onClearAll={clearAll}
        activeFilters={activeFilters}
        dirty={draftDiffersFromApplied}
        loading={loading}
      />

      {loading && !stats ? (
        <div className="atlas-stack" style={{ marginTop: "var(--atlas-space-4)" }}>
          <CardSkeleton lines={2} />
          <CardSkeleton lines={4} />
        </div>
      ) : !stats ? null : (
        <div className="atlas-oversight__body" aria-busy={loading ? true : undefined}>
          <ExceptionSummary stats={stats} periodLabel={dateRangeLabel(applied.dateRange)} />

          <AttentionQueue
            stats={stats}
            loading={loading}
            onOpenSubmission={onOpenSubmission}
            periodLabel={dateRangeLabel(applied.dateRange)}
          />

          <OutcomeDistribution stats={stats} periodLabel={dateRangeLabel(applied.dateRange)} />

          <RecurringPatterns stats={stats} />

          <CommunicationsFollowThrough stats={stats} />

          <SupportingWorkload stats={stats} periodLabel={dateRangeLabel(applied.dateRange)} />
        </div>
      )}
    </div>
  );
}

/* ===========================================================================
   Filter bar — Period is immediate; the rest apply as a batch.
   =========================================================================== */

function OversightFilterBar({
  applied,
  draft,
  onDraftChange,
  onApply,
  onPeriodChange,
  onClearAll,
  activeFilters,
  dirty,
  loading,
}: {
  applied: Filters;
  draft: Filters;
  onDraftChange: (next: Filters) => void;
  onApply: (event?: FormEvent<HTMLFormElement>) => void;
  onPeriodChange: (next: OversightDateRange) => void;
  onClearAll: () => void;
  activeFilters: ActiveFilter[];
  dirty: boolean;
  loading: boolean;
}) {
  const periodId = useId();
  const statusId = useId();
  const outcomeId = useId();
  const lineId = useId();
  const insurerId = useId();
  const consultantId = useId();

  return (
    <section
      className="atlas-oversight__filters"
      aria-labelledby="oversight-filters-heading"
    >
      <h2 id="oversight-filters-heading" className="atlas-sr-only">
        Filter the overview
      </h2>

      <div className="atlas-oversight__filters-row">
        <div className="atlas-toolbar__field atlas-oversight__period">
          <label htmlFor={periodId}>Period</label>
          <select
            id={periodId}
            className="atlas-select"
            value={applied.dateRange}
            onChange={(event) => onPeriodChange(event.target.value as OversightDateRange)}
          >
            {OVERSIGHT_DATE_RANGES.map((range) => (
              <option key={range.value} value={range.value}>
                {range.label}
              </option>
            ))}
          </select>
          <p className="atlas-oversight__hint">Applies to every count that respects the period.</p>
        </div>
      </div>

      <Disclosure summary="Advanced filters">
        <form
          className="atlas-oversight__advanced"
          onSubmit={onApply}
          aria-label="Advanced filters"
        >
          <div className="atlas-toolbar__field">
            <label htmlFor={statusId}>Review outcome</label>
            <select
              id={statusId}
              className="atlas-select"
              value={draft.status}
              onChange={(event) => onDraftChange({ ...draft, status: event.target.value })}
            >
              <option value="">All outcomes</option>
              {Object.entries(QUOTE_REVIEW_STATUS).map(([value, meta]) => (
                <option key={value} value={value}>
                  {meta.label}
                </option>
              ))}
            </select>
          </div>

          <div className="atlas-toolbar__field">
            <label htmlFor={outcomeId}>Decision outcome</label>
            <select
              id={outcomeId}
              className="atlas-select"
              value={draft.outcome}
              onChange={(event) => onDraftChange({ ...draft, outcome: event.target.value })}
            >
              <option value="">All decisions</option>
              {Object.entries(QUOTE_REVIEW_STATUS).map(([value, meta]) => (
                <option key={value} value={value}>
                  {meta.label}
                </option>
              ))}
            </select>
          </div>

          <div className="atlas-toolbar__field">
            <label htmlFor={lineId}>Line of business</label>
            <select
              id={lineId}
              className="atlas-select"
              value={draft.lineOfBusiness}
              onChange={(event) => onDraftChange({ ...draft, lineOfBusiness: event.target.value })}
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
            <label htmlFor={insurerId}>Insurer identifier</label>
            <input
              id={insurerId}
              className="atlas-input"
              value={draft.insurerId}
              placeholder="Insurer UUID"
              maxLength={200}
              aria-describedby={`${insurerId}-hint`}
              onChange={(event) =>
                onDraftChange({ ...draft, insurerId: event.target.value.slice(0, 200) })
              }
            />
            <p id={`${insurerId}-hint`} className="atlas-field__hint">
              The insurer's UUID from the insurer list. Up to 200 characters.
            </p>
          </div>

          <div className="atlas-toolbar__field">
            <label htmlFor={consultantId}>Consultant identifier</label>
            <input
              id={consultantId}
              className="atlas-input"
              value={draft.consultantId}
              placeholder="Consultant UUID or email"
              maxLength={200}
              aria-describedby={`${consultantId}-hint`}
              onChange={(event) =>
                onDraftChange({ ...draft, consultantId: event.target.value.slice(0, 200) })
              }
            />
            <p id={`${consultantId}-hint`} className="atlas-field__hint">
              The consultant's Atlas identifier. Up to 200 characters.
            </p>
          </div>

          <div className="atlas-oversight__apply">
            <Button type="submit" variant="primary" disabled={!dirty || loading}>
              Apply filters
            </Button>
          </div>
        </form>
      </Disclosure>

      <FilterChips filters={activeFilters} onClearAll={onClearAll} />
    </section>
  );
}

/* ===========================================================================
   Exception summary — the "what needs attention" strip.
   =========================================================================== */

function ExceptionSummary({
  stats,
  periodLabel,
}: {
  stats: ManagerStats;
  periodLabel: string;
}) {
  const tiles = exceptionMetrics(stats);
  const nothingOutstanding = tiles.every((tile) => tile.value === 0);

  return (
    <section className="atlas-oversight__section" aria-labelledby="oversight-exceptions">
      <header className="atlas-oversight__section-head">
        <h2 id="oversight-exceptions" className="atlas-title-sub">
          Where attention is needed
        </h2>
        <p className="atlas-oversight__caption">
          Period-scoped tiles reflect {periodLabel.toLowerCase()}. Outstanding information and
          recommendation overrides are counted across recent activity — they do not narrow with the
          period.
        </p>
      </header>

      {nothingOutstanding ? (
        <EmptyState
          title="Nothing outstanding right now"
          body={`No open exceptions across the team for ${periodLabel.toLowerCase()}. Recent aggregate counts are also zero.`}
          inline
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
                  <StatusBadge
                    status={{ label: "Attention", tone: "warning" }}
                    size="sm"
                    quiet
                  />
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
              <span className="atlas-oversight__tile-scope">
                {tile.scope === "period"
                  ? `In ${periodLabel.toLowerCase()}`
                  : tile.scope === "period_capped"
                    ? `Up to 10 in ${periodLabel.toLowerCase()}`
                    : "Across recent activity"}
              </span>
              <span className="atlas-oversight__tile-hint">{tile.hint}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

/* ===========================================================================
   Attention queue — the actionable review table.
   =========================================================================== */

function AttentionQueue({
  stats,
  loading,
  onOpenSubmission,
  periodLabel,
}: {
  stats: ManagerStats;
  loading: boolean;
  onOpenSubmission: (id: string) => void;
  periodLabel: string;
}) {
  const [sort, setSort] = useState<SortState>({ columnId: "reviewed", direction: "desc" });

  const columns: Column<QuoteReview>[] = useMemo(
    () => [
      {
        id: "outcome",
        header: "Review outcome",
        cell: (row) => <StatusBadge status={quoteReviewStatus(row.status)} />,
        sortValue: (row) => quoteReviewStatus(row.status).label,
      },
      {
        id: "confidence",
        header: "Human review",
        cell: (row) =>
          row.manual_review_required ? (
            <StatusBadge status={{ label: "Required", tone: "warning" }} />
          ) : (
            <StatusBadge status={{ label: "Not flagged", tone: "success" }} />
          ),
      },
      {
        id: "reviewed",
        header: "Reviewed",
        align: "right",
        sortValue: (row) => new Date(row.created_at).getTime(),
        cell: (row) => (
          <span title={formatDateTime(row.created_at)}>{formatRelative(row.created_at)}</span>
        ),
      },
      {
        id: "actions",
        header: "",
        srHeader: "Open submission",
        align: "right",
        cell: (row) => (
          <div className="atlas-table__rowactions">
            <Button
              size="sm"
              iconAfter="chevron-right"
              onClick={() => onOpenSubmission(row.submission_id)}
            >
              Open
            </Button>
          </div>
        ),
      },
    ],
    [onOpenSubmission]
  );

  return (
    <section className="atlas-oversight__section" aria-labelledby="oversight-attention">
      <header className="atlas-oversight__section-head">
        <h2 id="oversight-attention" className="atlas-title-sub">
          Reviews needing attention
        </h2>
        <p className="atlas-oversight__caption">
          The ten most recent reviews in {periodLabel.toLowerCase()} that were referred, declined,
          flagged for human review, or waiting on information. Open one to see the findings.
        </p>
      </header>

      <Card flush ariaLabel="Reviews needing attention table">
        <div className="atlas-oversight__attention">
          <DataTable
            caption="Quote reviews needing manager attention"
            columns={columns}
            rows={stats.recent_reviews_needing_attention}
            rowKey={(row) => row.id}
            loading={loading}
            dense
            sort={sort}
            onSortChange={setSort}
            onRowActivate={(row) => onOpenSubmission(row.submission_id)}
            rowAttention={() => true}
            empty={
              <EmptyState
                title="Nothing needs manager attention"
                body={`No quote review in ${periodLabel.toLowerCase()} was referred, declined, or flagged for human review.`}
              />
            }
          />
        </div>
      </Card>
    </section>
  );
}

/* ===========================================================================
   Outcome distribution — proportional bars, exact counts.
   =========================================================================== */

function OutcomeDistribution({
  stats,
  periodLabel,
}: {
  stats: ManagerStats;
  periodLabel: string;
}) {
  const rows = useMemo(() => orderReviewOutcomes(stats.reviews_by_status), [stats.reviews_by_status]);
  const max = useMemo(() => maxCount(rows), [rows]);
  const total = useMemo(() => rows.reduce((sum, row) => sum + row.count, 0), [rows]);

  return (
    <section className="atlas-oversight__section" aria-labelledby="oversight-outcomes">
      <header className="atlas-oversight__section-head">
        <h2 id="oversight-outcomes" className="atlas-title-sub">
          Reviews by outcome
        </h2>
        <p className="atlas-oversight__caption">
          How the team's completed quote reviews resolved in {periodLabel.toLowerCase()}. Bars
          compare counts within this period — they do not imply a share of any larger denominator.
        </p>
      </header>

      {total === 0 ? (
        <EmptyState
          title="No quote reviews in this period"
          body={`Nothing completed in ${periodLabel.toLowerCase()}. Widen the period or check the Work Queue for in-flight submissions.`}
          inline
        />
      ) : (
        <figure className="atlas-oversight__bars" aria-describedby="oversight-outcomes-legend">
          <figcaption id="oversight-outcomes-legend" className="atlas-sr-only">
            Bar chart comparing the count of reviews for each outcome. The longest bar represents
            the outcome with the most reviews in the period. Each row lists the outcome and its
            exact count.
          </figcaption>
          <ul className="atlas-oversight__bar-list">
            {rows.map((row) => {
              const width = barWidth(row.count, max);
              return (
                <li className="atlas-oversight__bar-row" key={row.status}>
                  <span className="atlas-oversight__bar-label">{row.label}</span>
                  <span className="atlas-oversight__bar-count">{row.count}</span>
                  <span className="atlas-oversight__bar-track" aria-hidden="true">
                    <span
                      className="atlas-oversight__bar-fill"
                      style={{ width: `${width}%` }}
                    />
                  </span>
                </li>
              );
            })}
          </ul>
        </figure>
      )}
    </section>
  );
}

/* ===========================================================================
   Recurring operational patterns — three ranked lists in a compact grid.
   =========================================================================== */

function RecurringPatterns({ stats }: { stats: ManagerStats }) {
  const empty = allPatternsEmpty(stats);

  return (
    <section className="atlas-oversight__section" aria-labelledby="oversight-patterns">
      <header className="atlas-oversight__section-head">
        <h2 id="oversight-patterns" className="atlas-title-sub">
          Recurring operational patterns
        </h2>
        <p className="atlas-oversight__caption">
          The most frequent items across recent activity — capped at the top five per list. These
          counts are aggregate; they do not narrow with the period or any advanced filter below.
        </p>
      </header>

      {empty ? (
        <EmptyState
          title="No recurring patterns yet"
          body="Once the team completes more reviews, common information gaps, referral triggers and decline reasons will surface here."
          inline
        />
      ) : (
        <div className="atlas-oversight__pattern-grid">
          <PatternCard
            title="Common information gaps"
            hint="Repeated gaps often point to an intake opportunity — an item to ask for at the door rather than mid-review."
            items={stats.common_missing_information}
            emptyLabel="No recurring information gaps recorded."
          />
          <PatternCard
            title="Common referral triggers"
            hint="Which appetite rules are most often sending work outside standard authority."
            items={stats.common_referral_triggers}
            emptyLabel="No referral triggers recorded."
          />
          <PatternCard
            title="Common decline reasons"
            hint="Which appetite conflicts are recurring most across recent quotes."
            items={stats.common_declined_reasons}
            emptyLabel="No decline reasons recorded."
          />
        </div>
      )}
    </section>
  );
}

/**
 * Turn raw pattern labels into a mixed-content span that renders long
 * numeric identifiers (10+ digits — quote IDs, claim IDs, policy IDs)
 * as a monospace pill instead of loose digits in the middle of a
 * sentence. The label reads humanised as before; only the identifier
 * segments get the distinct treatment so a reader can copy them or
 * distinguish them from prose. Non-string / empty labels fall back to
 * humanise() unchanged.
 */
function renderPatternLabel(raw: string): ReactNode {
  const humanised = humanise(raw);
  const parts = humanised.split(/(\b\d{10,}\b)/g);
  if (parts.length === 1) return humanised;
  return parts.map((part, index) =>
    /^\d{10,}$/.test(part) ? (
      <span
        key={index}
        className="atlas-badge atlas-badge--quiet atlas-mono"
        style={{ marginInline: 4, verticalAlign: "baseline" }}
      >
        <span className="atlas-badge__label">{part}</span>
      </span>
    ) : (
      <span key={index}>{part}</span>
    )
  );
}

function PatternCard({
  title,
  hint,
  items,
  emptyLabel,
}: {
  title: string;
  hint: string;
  items: { label: string; count: number }[];
  emptyLabel: string;
}) {
  const max = useMemo(() => maxCount(items), [items]);
  const headingId = useId();

  return (
    <article className="atlas-oversight__pattern" aria-labelledby={headingId}>
      <header className="atlas-oversight__pattern-head">
        <h3 id={headingId} className="atlas-oversight__pattern-title">
          {title}
        </h3>
        <p className="atlas-oversight__pattern-hint">{hint}</p>
      </header>
      {items.length === 0 ? (
        // Unified with the other empty states on the page — the plain
        // paragraph read as an unfinished section next to the
        // EmptyState-bordered blocks used elsewhere on the overview.
        <EmptyState inline title={emptyLabel} />
      ) : (
        <ul className="atlas-oversight__bar-list atlas-oversight__bar-list--compact">
          {items.map((item) => {
            const width = barWidth(item.count, max);
            return (
              <li className="atlas-oversight__bar-row" key={item.label}>
                <span className="atlas-oversight__bar-label">
                  {renderPatternLabel(item.label)}
                </span>
                <span className="atlas-oversight__bar-count">{item.count}</span>
                <span className="atlas-oversight__bar-track" aria-hidden="true">
                  <span
                    className="atlas-oversight__bar-fill"
                    style={{ width: `${width}%` }}
                  />
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </article>
  );
}

/* ===========================================================================
   Communications follow-through — honest count difference, safety copy.
   =========================================================================== */

function CommunicationsFollowThrough({ stats }: { stats: ManagerStats }) {
  const summary = communicationsSummary(stats);
  const showDifference = summary.difference > 0;

  return (
    <section className="atlas-oversight__section" aria-labelledby="oversight-communications">
      <header className="atlas-oversight__section-head">
        <h2 id="oversight-communications" className="atlas-title-sub">
          Communications follow-through
        </h2>
        <p className="atlas-oversight__caption">
          Drafts Atlas produced, and how many were recorded as sent by the team. Aggregate across
          recent activity — not narrowed by the filters above.
        </p>
      </header>

      <div className="atlas-oversight__comms">
        <div className="atlas-oversight__comms-pair">
          <div className="atlas-oversight__comms-cell">
            <span className="atlas-oversight__comms-label">Drafted by Atlas</span>
            <span className="atlas-oversight__comms-value">{summary.drafted}</span>
          </div>
          <div className="atlas-oversight__comms-cell">
            <span className="atlas-oversight__comms-label">Recorded as sent</span>
            <span className="atlas-oversight__comms-value">{summary.sent}</span>
          </div>
          {showDifference && (
            <div className="atlas-oversight__comms-cell atlas-oversight__comms-cell--muted">
              <span className="atlas-oversight__comms-label">Count difference</span>
              <span className="atlas-oversight__comms-value">{summary.difference}</span>
            </div>
          )}
        </div>
        <p className="atlas-oversight__comms-note">
          {`${ATLAS_NEVER_SENDS_MESSAGE}. A count difference does not prove a draft was not sent — the team may have sent it outside Atlas — but it does mean the audit history is incomplete for those items.`}
        </p>
      </div>
    </section>
  );
}

/* ===========================================================================
   Supporting workload — context metrics, kept visually secondary.
   =========================================================================== */

function SupportingWorkload({
  stats,
  periodLabel,
}: {
  stats: ManagerStats;
  periodLabel: string;
}) {
  const items = workloadMetrics(stats);

  return (
    <section className="atlas-oversight__section" aria-labelledby="oversight-workload">
      <header className="atlas-oversight__section-head">
        <h2 id="oversight-workload" className="atlas-title-sub">
          Supporting workload
        </h2>
        <p className="atlas-oversight__caption">
          Context, not exceptions. Numbers below are for reference; they are not weighted the same
          way as the attention tiles above.
        </p>
      </header>
      <ul className="atlas-oversight__workload">
        {items.map((item) => (
          <li className="atlas-oversight__workload-cell" key={item.key}>
            <span className="atlas-oversight__workload-label">{item.label}</span>
            <span className="atlas-oversight__workload-value">{item.value}</span>
            <span className="atlas-oversight__workload-scope">
              {exceptionScopeSuffix(item.scope, periodLabel)}
            </span>
            <span className="atlas-oversight__workload-hint">{item.hint}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
