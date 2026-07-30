/**
 * Atlas — manager overview
 * ----------------------------------------------------------------------------
 * Underwriting oversight, not platform operations — processing health now lives
 * on its own screen.
 *
 * What changed and why:
 *  - The filters were free-text boxes that expected internal enum values
 *    ("refer, declined…"). They are now proper selects built from the status
 *    taxonomy, so a manager cannot silently filter on a typo.
 *  - Twelve identical metric cards, one of which rendered a boolean as "1", are
 *    now a small set of counts that mean something operationally, followed by
 *    ranked breakdowns rather than more boxes.
 *  - Reviews needing attention are clickable through to the submission.
 */

import { useEffect, useMemo, useState } from "react";
import { getManagerStatsFiltered, type ManagerStats } from "../lib/phase4";
import {
  Button,
  Card,
  CardSkeleton,
  EmptyState,
  ErrorState,
  FilterChips,
  Metric,
  PageHeader,
  RankedList,
  StatusBadge,
  type ActiveFilter,
} from "../components/ui";
import { DataTable, type Column } from "../components/DataTable";
import type { QuoteReview } from "../lib/quote-reviews";
import {
  LINE_OF_BUSINESS_OPTIONS,
  lineOfBusinessLabel,
  QUOTE_REVIEW_STATUS,
  quoteReviewStatus,
} from "../lib/status";
import { formatDateTime, formatRelative, humanise } from "../lib/format";

type DateRange = "7d" | "30d" | "90d" | "all";

const DATE_RANGES: { value: DateRange; label: string }[] = [
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
  { value: "90d", label: "Last 90 days" },
  { value: "all", label: "All time" },
];

interface Filters {
  dateRange: DateRange;
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

export default function ManagerDashboard({
  onOpenSubmission,
}: {
  onOpenSubmission: (id: string) => void;
}) {
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [stats, setStats] = useState<ManagerStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let live = true;
    setLoading(true);
    getManagerStatsFiltered({
      date_range: filters.dateRange,
      status: filters.status || undefined,
      outcome: filters.outcome || undefined,
      insurer_id: filters.insurerId || undefined,
      consultant_id: filters.consultantId || undefined,
      line_of_business: filters.lineOfBusiness || undefined,
    })
      .then((result) => {
        if (!live) return;
        setStats(result.stats);
        setError(null);
      })
      .catch((cause: Error) => {
        if (!live) return;
        setError(
          cause.message === "manager_only"
            ? "This overview is available to underwriting managers and administrators only."
            : "The manager overview could not be loaded. The Atlas API did not respond."
        );
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [filters, reloadToken]);

  const activeFilters: ActiveFilter[] = useMemo(() => {
    const list: ActiveFilter[] = [];
    if (filters.dateRange !== "30d") {
      list.push({
        key: "range",
        label: "Period",
        value: DATE_RANGES.find((range) => range.value === filters.dateRange)?.label ?? "",
        onRemove: () => setFilters((current) => ({ ...current, dateRange: "30d" })),
      });
    }
    if (filters.status) {
      list.push({
        key: "status",
        label: "Review outcome",
        value: quoteReviewStatus(filters.status).label,
        onRemove: () => setFilters((current) => ({ ...current, status: "" })),
      });
    }
    if (filters.outcome) {
      list.push({
        key: "outcome",
        label: "Decision outcome",
        value: quoteReviewStatus(filters.outcome).label,
        onRemove: () => setFilters((current) => ({ ...current, outcome: "" })),
      });
    }
    if (filters.lineOfBusiness) {
      list.push({
        key: "line",
        label: "Line",
        value: lineOfBusinessLabel(filters.lineOfBusiness),
        onRemove: () => setFilters((current) => ({ ...current, lineOfBusiness: "" })),
      });
    }
    if (filters.insurerId) {
      list.push({
        key: "insurer",
        label: "Insurer",
        value: filters.insurerId,
        onRemove: () => setFilters((current) => ({ ...current, insurerId: "" })),
      });
    }
    if (filters.consultantId) {
      list.push({
        key: "consultant",
        label: "Consultant",
        value: filters.consultantId,
        onRemove: () => setFilters((current) => ({ ...current, consultantId: "" })),
      });
    }
    return list;
  }, [filters]);

  const attentionColumns: Column<QuoteReview>[] = [
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
      cell: (row) => <span title={formatDateTime(row.created_at)}>{formatRelative(row.created_at)}</span>,
    },
    {
      id: "actions",
      header: "",
      align: "right",
      cell: (row) => (
        <div className="atlas-table__rowactions">
          <Button size="sm" iconAfter="chevron-right" onClick={() => onOpenSubmission(row.submission_id)}>
            Open
          </Button>
        </div>
      ),
    },
  ];

  if (error) {
    return (
      <div>
        <PageHeader
          eyebrow="Oversight"
          title="Manager overview"
          description="Review outcomes, outstanding information, referrals and overrides across the team."
        />
        <ErrorState
          title="The manager overview could not be loaded"
          message={error}
          onRetry={() => setReloadToken((token) => token + 1)}
        />
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        eyebrow="Oversight"
        title="Manager overview"
        description="Where work is getting stuck, which decisions departed from the Atlas recommendation, and what the team is waiting on."
      />

      <section className="atlas-toolbar" aria-label="Filter the overview" style={{ marginBottom: "var(--atlas-space-4)" }}>
        <div className="atlas-toolbar__field">
          <label htmlFor="oversight-range">Period</label>
          <select
            id="oversight-range"
            className="atlas-select"
            value={filters.dateRange}
            onChange={(event) =>
              setFilters((current) => ({ ...current, dateRange: event.target.value as DateRange }))
            }
          >
            {DATE_RANGES.map((range) => (
              <option key={range.value} value={range.value}>
                {range.label}
              </option>
            ))}
          </select>
        </div>

        <div className="atlas-toolbar__field">
          <label htmlFor="oversight-status">Review outcome</label>
          <select
            id="oversight-status"
            className="atlas-select"
            value={filters.status}
            onChange={(event) => setFilters((current) => ({ ...current, status: event.target.value }))}
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
          <label htmlFor="oversight-outcome">Decision outcome</label>
          <select
            id="oversight-outcome"
            className="atlas-select"
            value={filters.outcome}
            onChange={(event) => setFilters((current) => ({ ...current, outcome: event.target.value }))}
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
          <label htmlFor="oversight-line">Line of business</label>
          <select
            id="oversight-line"
            className="atlas-select"
            value={filters.lineOfBusiness}
            onChange={(event) =>
              setFilters((current) => ({ ...current, lineOfBusiness: event.target.value }))
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
          <label htmlFor="oversight-insurer">Insurer identifier</label>
          <input
            id="oversight-insurer"
            className="atlas-input"
            value={filters.insurerId}
            placeholder="Optional"
            onChange={(event) => setFilters((current) => ({ ...current, insurerId: event.target.value }))}
          />
        </div>

        <div className="atlas-toolbar__field">
          <label htmlFor="oversight-consultant">Consultant identifier</label>
          <input
            id="oversight-consultant"
            className="atlas-input"
            value={filters.consultantId}
            placeholder="Optional"
            onChange={(event) =>
              setFilters((current) => ({ ...current, consultantId: event.target.value }))
            }
          />
        </div>
      </section>

      <FilterChips filters={activeFilters} onClearAll={() => setFilters(EMPTY_FILTERS)} />

      {loading && !stats ? (
        <div className="atlas-stack" style={{ marginTop: "var(--atlas-space-4)" }}>
          <CardSkeleton lines={2} />
          <CardSkeleton lines={4} />
        </div>
      ) : !stats ? null : (
        <>
          <section
            className="atlas-metrics"
            aria-label="Team workload"
            style={{ margin: "var(--atlas-space-4) 0" }}
          >
            <Metric
              label="Submissions"
              value={stats.total_submissions}
              loading={loading}
              hint="Submissions created in the selected period."
            />
            <Metric
              label="Quote reviews completed"
              value={stats.quote_reviews_completed}
              loading={loading}
              hint="Reviews Atlas finished against an insurer's rules."
            />
            <Metric
              label="Outstanding information"
              value={stats.missing_info_open_count}
              loading={loading}
              tone={stats.missing_info_open_count > 0 ? "warning" : "default"}
              hint="Items still open or awaiting a reply across the team."
            />
            <Metric
              label="Referrals"
              value={stats.referrals_count}
              loading={loading}
              tone={stats.referrals_count > 0 ? "warning" : "default"}
              hint="Reviews that required insurer or senior authority."
            />
            <Metric
              label="Declined"
              value={stats.declined_count}
              loading={loading}
              hint="Reviews where the quote conflicted with the insurer's appetite."
            />
            <Metric
              label="Recommendation overrides"
              value={stats.overrides_count}
              loading={loading}
              tone={stats.overrides_count > 0 ? "warning" : "default"}
              hint="Decisions that departed from the insurer Atlas ranked first. Each one carries a recorded reason."
            />
          </section>

          <div className="atlas-oversight__grid">
            <Card
              title="Reviews by outcome"
              description="How the team's quote reviews resolved in this period."
            >
              <RankedList
                items={Object.entries(stats.reviews_by_status).map(([status, count]) => ({
                  label: quoteReviewStatus(status).label,
                  count,
                }))}
                emptyLabel="No quote reviews completed in this period."
              />
            </Card>

            <Card
              title="Most common information gaps"
              description="What the team is most often waiting on. Recurring gaps are usually an intake problem."
            >
              <RankedList
                items={stats.common_missing_information.map((item) => ({
                  label: humanise(item.label),
                  count: item.count,
                }))}
                emptyLabel="No recurring information gaps in this period."
              />
            </Card>

            <Card
              title="Most common referral triggers"
              description="Which appetite rules are sending work outside standard authority."
            >
              <RankedList
                items={stats.common_referral_triggers.map((item) => ({
                  label: humanise(item.label),
                  count: item.count,
                }))}
                emptyLabel="No referral triggers recorded in this period."
              />
            </Card>

            <Card
              title="Most common decline reasons"
              description="Why quotes are failing against insurer appetite."
            >
              <RankedList
                items={stats.common_declined_reasons.map((item) => ({
                  label: humanise(item.label),
                  count: item.count,
                }))}
                emptyLabel="No declines recorded in this period."
              />
            </Card>
          </div>

          <div style={{ marginTop: "var(--atlas-space-4)" }}>
            <Card
              title="Reviews needing attention"
              description="Referred, declined, or flagged for human review. Open one to see the findings and act."
              flush
            >
              <div style={{ padding: "var(--atlas-space-4)" }}>
                <DataTable
                  caption="Quote reviews needing manager attention"
                  columns={attentionColumns}
                  rows={stats.recent_reviews_needing_attention}
                  rowKey={(row) => row.id}
                  loading={loading}
                  dense
                  onRowActivate={(row) => onOpenSubmission(row.submission_id)}
                  rowAttention={() => true}
                  empty={
                    <EmptyState
                      title="Nothing needs manager attention"
                      body="No quote review in this period was referred, declined, or flagged for human review."
                    />
                  }
                />
              </div>
            </Card>
          </div>

          <div className="atlas-oversight__grid" style={{ marginTop: "var(--atlas-space-4)" }}>
            <Card
              title="Communications"
              description="Drafts Atlas produced, and how many the team actually sent."
            >
              <RankedList
                items={[
                  { label: "Drafted", count: stats.communications_generated_count },
                  { label: "Sent by the team", count: stats.communications_sent_manually_count },
                ]}
              />
              <p className="atlas-field__hint" style={{ marginTop: 12 }}>
                Atlas never sends anything itself. A large gap between these two numbers usually means
                drafts are being rewritten outside Atlas, so the audit history is incomplete.
              </p>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
