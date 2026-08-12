/**
 * Atlas — insurer recommendation
 * ----------------------------------------------------------------------------
 * The surface where the matcher's output lands. Its job is to make a complex
 * appetite decision legible at a glance while keeping every piece of evidence
 * one click away.
 *
 * The structural change from the previous version: a hard appetite failure no
 * longer looks like a soft concern. Blockers, referral triggers, concerns and
 * strengths are separate, differently-weighted groups, each stating the issue,
 * why it matters, and what to do about it.
 *
 * The governance disclaimer renders unconditionally, above everything.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { GovernanceDisclaimer } from "../components/GovernanceDisclaimer";
import {
  Button,
  Card,
  Disclosure,
  EmptyState,
  Notice,
  Reason,
  SourceReference,
  StatusBadge,
  useToast,
} from "../components/ui";
import {
  runRecommendation,
  type Recommendation,
  type ScoredInsurer,
} from "../lib/recommendations";
import type { ExtractionConfidenceState } from "../lib/extraction-confidence";
import type { MissingInfoItem } from "../lib/phase4";
import { appetiteBand } from "../lib/status";
import { formatDateTime } from "../lib/format";
import type { SubmissionTab } from "../lib/router";
import {
  classifyComparisonRow,
  groupFindings,
  ruleListMeta,
  summariseRecommendation,
} from "../lib/decision-workbench";

export default function RecommendationPanel({
  submissionId,
  recommendation,
  extractionExists,
  extractionReviewed,
  extractionConfidence,
  openMissingInfo,
  onRefresh,
  onGoToTab,
}: {
  submissionId: string;
  recommendation: Recommendation | null;
  extractionExists: boolean;
  extractionReviewed: boolean;
  extractionConfidence: ExtractionConfidenceState;
  openMissingInfo: MissingInfoItem[];
  onRefresh: () => Promise<void> | void;
  onGoToTab: (tab: SubmissionTab) => void;
}) {
  const toast = useToast();
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [view, setView] = useState<"ranked" | "compare">("ranked");

  async function run(force = false) {
    setRunning(true);
    setError(null);
    setNotice(null);
    try {
      const result = await runRecommendation(submissionId, { force });
      if (result.skipped && result.message) {
        setNotice(result.message);
      } else {
        toast.notify("Recommendation updated.", "success");
      }
      await onRefresh();
    } catch (cause) {
      const message = (cause as Error).message;
      setError(
        message === "extraction_not_reviewed"
          ? "Review the extracted risk information before running a recommendation."
          : message === "no_extraction"
          ? "Run the extraction before running a recommendation."
          : message === "matrix_empty"
          ? "There are no active appetite rules in the matrix. A manager needs to add insurer guidelines before Atlas can recommend anything."
          : "The recommendation could not be computed. Check the processing screen for the failure reason, then try again."
      );
    } finally {
      setRunning(false);
    }
  }

  if (!extractionExists) {
    return (
      <Card>
        <EmptyState
          title="No recommendation yet"
          body="Atlas needs an extraction before it can check the risk against insurer appetite. Start on the risk information tab."
          actions={
            <Button iconAfter="arrow-right" onClick={() => onGoToTab("risk")}>
              Open risk information
            </Button>
          }
        />
      </Card>
    );
  }

  const secondary = recommendation?.secondary_options_json ?? [];
  const ruledOut = recommendation?.not_recommended_json ?? [];
  const top = recommendation?.reasoning_json.top ?? null;
  const allInsurers = [...(top ? [top] : []), ...secondary, ...ruledOut];

  return (
    <div className="atlas-stack">
      <GovernanceDisclaimer />

      {!extractionReviewed && (
        <Notice tone="warning" title="Review the risk information first">
          Atlas will not run a recommendation against an unreviewed extraction. Open the risk
          information tab, correct anything it misread, and save your corrections — this button
          unlocks as soon as you do.
          <div style={{ marginTop: 8 }}>
            <Button size="sm" iconAfter="arrow-right" onClick={() => onGoToTab("risk")}>
              Open risk information
            </Button>
          </div>
        </Notice>
      )}

      {extractionConfidence.state === "unavailable" && (
        <Notice tone="info" title="Extraction confidence is unavailable">
          The ranking below reflects appetite matching against the human-reviewed risk information.
          The extraction provider did not return an overall rating for this run, so no percentage is
          shown alongside the ranking.
        </Notice>
      )}

      {error && <Notice tone="danger" title="The recommendation did not run">{error}</Notice>}
      {notice && <Notice tone="info" title="Nothing changed">{notice}</Notice>}

      <Card
        title="Insurer recommendation"
        description={
          recommendation
            ? `Computed ${formatDateTime(recommendation.created_at)} against the reviewed risk information.`
            : "Atlas checks the reviewed risk information against every active appetite rule in the matrix."
        }
        actions={
          <>
            {recommendation && allInsurers.length > 1 && (
              <div className="atlas-btn-group" role="group" aria-label="Recommendation view">
                <button
                  type="button"
                  className={`atlas-btn atlas-btn--sm atlas-btn--ghost ${view === "ranked" ? "atlas-btn--pressed" : ""}`}
                  aria-pressed={view === "ranked"}
                  onClick={() => setView("ranked")}
                >
                  Ranked
                </button>
                <button
                  type="button"
                  className={`atlas-btn atlas-btn--sm atlas-btn--ghost ${view === "compare" ? "atlas-btn--pressed" : ""}`}
                  aria-pressed={view === "compare"}
                  onClick={() => setView("compare")}
                >
                  Compare
                </button>
              </div>
            )}
            <Button
              variant="primary"
              size="sm"
              loading={running}
              loadingLabel="Checking appetite…"
              disabled={!extractionReviewed}
              onClick={() => run()}
              title={
                !extractionReviewed
                  ? "Review the risk information before running a recommendation."
                  : undefined
              }
            >
              {recommendation ? "Rerun recommendation" : "Run recommendation"}
            </Button>
            {recommendation && (
              <Button
                size="sm"
                disabled={running || !extractionReviewed}
                onClick={() => run(true)}
                title="Force a fresh run even when Atlas believes the inputs are unchanged."
              >
                Force rerun
              </Button>
            )}
          </>
        }
      >
        {!recommendation ? (
          <EmptyState
            inline
            title="Atlas has not produced a recommendation yet"
            body={
              extractionReviewed
                ? "Run the recommendation to score every insurer with active appetite rules against this risk."
                : "The recommendation unlocks once the extracted risk information has been reviewed."
            }
          />
        ) : (
          <>
            <RecommendationSummary
              recommendation={recommendation}
              openMissingInfoCount={openMissingInfo.length}
            />

            {openMissingInfo.length > 0 && (
              <div style={{ marginTop: "var(--atlas-space-4)" }}>
                <Notice tone="warning" title="Outstanding information may change this result">
                  {openMissingInfo.length} item
                  {openMissingInfo.length === 1 ? " is" : "s are"} still outstanding. Rerun the
                  recommendation once the information arrives.
                  <div style={{ marginTop: 8 }}>
                    <Button size="sm" onClick={() => onGoToTab("missing-information")}>
                      Review outstanding information
                    </Button>
                  </div>
                </Notice>
              </div>
            )}

            {view === "compare" ? (
              <ComparisonMatrix insurers={allInsurers} topId={top?.insurer_id ?? null} />
            ) : (
              <div style={{ marginTop: "var(--atlas-space-5)" }}>
                {top ? (
                  <InsurerBlock insurer={top} variant="top" rank={1} />
                ) : (
                  <Notice tone="danger" title="No insurer cleared appetite for this risk">
                    Every insurer with appetite rules on file was ruled out. Review the failures below —
                    a referral, or a correction to the risk information, may change the outcome.
                  </Notice>
                )}

                {secondary.length > 0 && (
                  <>
                    <Divider label="Other viable options" />
                    {secondary.map((insurer, index) => (
                      <InsurerBlock
                        key={insurer.insurer_id}
                        insurer={insurer}
                        variant="secondary"
                        rank={index + 2}
                      />
                    ))}
                  </>
                )}

                {ruledOut.length > 0 && (
                  <>
                    <Divider label="Ruled out by appetite" />
                    {ruledOut.map((insurer) => (
                      <InsurerBlock key={insurer.insurer_id} insurer={insurer} variant="ruled-out" />
                    ))}
                  </>
                )}
              </div>
            )}

            {recommendation.reasoning_json.no_data_for?.length > 0 && (
              <div style={{ marginTop: "var(--atlas-space-5)" }}>
                <Notice tone="info" title="Insurers Atlas could not consider">
                  {recommendation.reasoning_json.no_data_for.map((item) => item.insurer_name).join(", ")}
                  {" have no active appetite rules in the matrix, so Atlas could not score them. "}
                  This is a gap in the guideline data, not a rejection of the risk.
                </Notice>
              </div>
            )}
          </>
        )}
      </Card>
    </div>
  );
}

/* ===========================================================================
   Decision-oriented recommendation summary
   ---------------------------------------------------------------------------
   A compact snapshot above the ranked view. Communicates the top-level
   answer, the review/referral flags and the counts an underwriter needs to
   decide whether to keep reading. Nothing here is invented — every value is
   derived from the recommendation payload the Worker already returns.
   =========================================================================== */

function RecommendationSummary({
  recommendation,
  openMissingInfoCount,
}: {
  recommendation: Recommendation;
  openMissingInfoCount: number;
}) {
  const summary = summariseRecommendation(recommendation);
  const top = recommendation.reasoning_json.top ?? null;

  return (
    <section className="atlas-reco__summary" aria-label="Recommendation summary">
      <div className="atlas-reco__summary-head">
        <div>
          <p className="atlas-reco__summary-eyebrow">Atlas recommendation</p>
          <p className="atlas-reco__summary-title">
            {summary.hasViableTop
              ? summary.topInsurerName
              : "No insurer cleared appetite"}
          </p>
        </div>
        <div className="atlas-reco__summary-flags">
          {top ? (
            <StatusBadge status={appetiteBand(top.band)} strong />
          ) : (
            <StatusBadge status={{ label: "Ruled out across the panel", tone: "danger" }} strong />
          )}
          {summary.requiresReferral && (
            <StatusBadge
              status={{
                label: "Referral required",
                tone: "referral",
                description: "At least one recommended insurer requires a referral.",
              }}
            />
          )}
          {summary.requiresSeniorReview && (
            <StatusBadge
              status={{
                label: "Senior review",
                tone: "referral",
                description: "A senior underwriter must sign this off.",
              }}
            />
          )}
          {summary.requiresManualReview && (
            <StatusBadge
              status={{
                label: "Manual review",
                tone: "warning",
                description:
                  "Atlas could not match a reliable product-level rule for the top pick. Treat the ranking as provisional.",
              }}
            />
          )}
        </div>
      </div>

      <p className="atlas-reco__headline">{recommendation.reasoning_json.headline}</p>

      <dl className="atlas-reco__summary-counts" aria-label="Recommendation counts">
        <SummaryCount
          label="Viable insurers"
          value={summary.viableCount}
          hint="Insurers Atlas can recommend, including the top pick."
        />
        <SummaryCount
          label="Ruled out"
          value={summary.ruledOutCount}
          hint="Insurers ruled out by a hard appetite failure."
          emphasise={summary.ruledOutCount > 0}
        />
        <SummaryCount
          label="Matched rules"
          value={summary.matchedRuleCount}
          hint="Appetite rules Atlas matched across the viable insurers."
        />
        <SummaryCount
          label="Required documents"
          value={summary.missingDocumentsCount}
          hint="Distinct required documents outstanding across the viable insurers."
          emphasise={summary.missingDocumentsCount > 0}
        />
        <SummaryCount
          label="Unmatched coverage"
          value={summary.unmatchedCoverageCount}
          hint="Sections or products with no guideline rule on file."
          emphasise={summary.unmatchedCoverageCount > 0}
        />
        {openMissingInfoCount > 0 && (
          <SummaryCount
            label="Outstanding information"
            value={openMissingInfoCount}
            hint="Tracked information items still outstanding on this submission."
            emphasise
          />
        )}
      </dl>

      {summary.computedAt && (
        <p className="atlas-reco__summary-meta">
          Computed {formatDateTime(summary.computedAt)} against the reviewed risk information.
        </p>
      )}
    </section>
  );
}

function SummaryCount({
  label,
  value,
  hint,
  emphasise,
}: {
  label: string;
  value: number;
  hint: string;
  emphasise?: boolean;
}) {
  return (
    <div
      className={`atlas-reco__summary-count${emphasise ? " atlas-reco__summary-count--emphasise" : ""}`}
      title={hint}
    >
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function Divider({ label }: { label: string }) {
  return (
    <div className="atlas-reco__divider">
      <span className="atlas-reco__divider-label">{label}</span>
      <span className="atlas-reco__divider-rule" />
    </div>
  );
}

/* ===========================================================================
   One insurer
   =========================================================================== */

function InsurerBlock({
  insurer,
  variant,
  rank,
}: {
  insurer: ScoredInsurer;
  variant: "top" | "secondary" | "ruled-out";
  rank?: number;
}) {
  const band = appetiteBand(insurer.band);
  const groups = groupFindings(insurer);

  return (
    <article className={`atlas-insurer atlas-insurer--${variant}`}>
      <header className="atlas-insurer__head">
        <div>
          {rank !== undefined && (
            <p className="atlas-insurer__rank">
              {variant === "top" ? "Recommended" : `Ranked ${rank}`}
            </p>
          )}
          {variant === "ruled-out" && <p className="atlas-insurer__rank">Not available for this risk</p>}
          <h3 className="atlas-insurer__name">{insurer.insurer_name}</h3>
        </div>
        <div className="atlas-insurer__flags">
          <StatusBadge status={band} strong={variant === "top"} />
          {insurer.referral_required && (
            <StatusBadge
              status={{
                label: "Referral required",
                tone: "referral",
                description: "This insurer's guideline requires approval before you can proceed.",
              }}
            />
          )}
          {insurer.senior_review_required && (
            <StatusBadge
              status={{
                label: "Senior review",
                tone: "referral",
                description: "A senior underwriter must sign this off.",
              }}
            />
          )}
          {insurer.manual_review_required && (
            <StatusBadge
              status={{
                label: "Manual review",
                tone: "warning",
                description:
                  "Atlas could not match a reliable product-level rule. Treat the ranking as provisional.",
              }}
            />
          )}
        </div>
      </header>

      <div className="atlas-insurer__body">
        {insurer.reasoning && <p className="atlas-insurer__reasoning">{insurer.reasoning}</p>}

        {insurer.manual_review_required && (
          <div style={{ marginTop: "var(--atlas-space-3)" }}>
            <Reason
              kind="concern"
              title="No reliable product-level rule matched"
              nextAction="Check the unmatched sections below against the insurer's guideline before treating this as a recommendation."
            >
              The matrix did not contain a rule Atlas could confidently apply to this risk. The ranking
              is based on partial information.
            </Reason>
          </div>
        )}

        {groups.length > 0 && (
          <div className="atlas-reasons" style={{ marginTop: "var(--atlas-space-4)" }}>
            {groups.map((group, index) => (
              <Reason key={index} kind={group.kind} title={group.title} nextAction={group.nextAction}>
                {group.body}
              </Reason>
            ))}
          </div>
        )}

        <div style={{ marginTop: "var(--atlas-space-3)" }}>
          <Disclosure summary={`Matched rules and scoring detail (${(insurer.matched_rules ?? []).length})`}>
            {(insurer.matched_rules ?? []).length === 0 ? (
              <p className="atlas-text-dense atlas-text-muted">
                No appetite rule matched this risk for {insurer.insurer_name}.
              </p>
            ) : (
              <ul className="atlas-list">
                {(insurer.matched_rules ?? []).map((rule, index) => (
                  <li className="atlas-list__item" key={index}>
                    <div className="atlas-list__main">
                      <p className="atlas-list__title">
                        {rule.matched_strings.join("; ") ||
                          `${rule.rule_product_line ?? "Rule"} · ${rule.rule_risk_type ?? ""}`}
                      </p>
                      <SourceReference
                        parts={[
                          rule.source_file_name,
                          rule.source_section,
                          rule.source_page ? `page ${rule.source_page}` : null,
                        ]}
                        quote={rule.source_quote}
                      />
                    </div>
                    <div className="atlas-list__side">
                      <StatusBadge status={ruleListMeta(rule.list)} />
                    </div>
                  </li>
                ))}
              </ul>
            )}

            {(insurer.scoring_notes ?? []).length > 0 && (
              <div style={{ marginTop: "var(--atlas-space-3)" }}>
                <p className="atlas-block__title">Scoring notes</p>
                <ul className="atlas-rule__list">
                  {(insurer.scoring_notes ?? []).map((note, index) => (
                    <li key={index} className="atlas-text-dense atlas-text-muted">
                      {note}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <p className="atlas-text-muted" style={{ fontSize: 12, marginTop: 12 }}>
              Internal score {insurer.score}. The score orders candidates; the reasons above are what
              you should act on.
            </p>
          </Disclosure>
        </div>
      </div>
    </article>
  );
}

/* ===========================================================================
   Comparison matrix
   =========================================================================== */

/**
 * A comparison row. `signature` reduces each insurer's cell to a comparable
 * value so the row can be classified as uniform, having a strict majority, or
 * having no majority at all.
 */
interface MatrixRow {
  key: string;
  label: string;
  render: (insurer: ScoredInsurer) => ReactNode;
  signature: (insurer: ScoredInsurer) => string;
}

/**
 * Track whether a horizontally-overflowing element actually overflows right
 * now, so the comparison scroll region is only a keyboard tab stop when there
 * is something to scroll. Re-measures on the supplied dependencies (insurer
 * selection) and on element resize; degrades to a window-resize listener where
 * `ResizeObserver` is unavailable (e.g. jsdom).
 */
function useHorizontalOverflow(
  ref: React.RefObject<HTMLElement>,
  deps: unknown[]
): boolean {
  const [overflowing, setOverflowing] = useState(false);

  useEffect(() => {
    const node = ref.current;
    if (!node) {
      setOverflowing(false);
      return;
    }
    const measure = () => setOverflowing(node.scrollWidth > node.clientWidth + 1);
    measure();

    if (typeof ResizeObserver === "undefined") {
      if (typeof window === "undefined") return;
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }

    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
    // `measure` closes over the current node; deps drive re-measurement on
    // selection change. ref identity is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return overflowing;
}

const MATRIX_ROWS: MatrixRow[] = [
  {
    key: "band",
    label: "Appetite",
    render: (insurer) => <StatusBadge status={appetiteBand(insurer.band)} />,
    signature: (insurer) => insurer.band ?? "unknown",
  },
  {
    key: "blocker",
    label: "Hard failure",
    render: (insurer) =>
      insurer.ruled_out ? (
        <StatusBadge status={{ label: "Ruled out", tone: "danger" }} />
      ) : (
        <StatusBadge status={{ label: "None", tone: "success" }} />
      ),
    signature: (insurer) => (insurer.ruled_out ? "ruled_out" : "none"),
  },
  {
    key: "referral",
    label: "Referral",
    render: (insurer) =>
      insurer.referral_required ? (
        <StatusBadge status={{ label: "Required", tone: "referral" }} />
      ) : (
        <StatusBadge status={{ label: "Not required", tone: "success" }} />
      ),
    signature: (insurer) => (insurer.referral_required ? "required" : "none"),
  },
  {
    key: "documents",
    label: "Documents outstanding",
    render: (insurer) => {
      const documents = insurer.missing_required_documents ?? [];
      return documents.length === 0 ? (
        <StatusBadge status={{ label: "None", tone: "success" }} />
      ) : (
        <>
          <StatusBadge status={{ label: `${documents.length} required`, tone: "warning" }} />
          <span className="atlas-matrix__note">{documents.join("; ")}</span>
        </>
      );
    },
    signature: (insurer) => `${(insurer.missing_required_documents ?? []).length}`,
  },
  {
    key: "coverage",
    label: "Rule coverage",
    render: (insurer) => {
      const unmatched = [
        ...(insurer.unmatched_sections ?? []),
        ...(insurer.unmatched_product_candidates ?? []),
      ];
      return unmatched.length === 0 ? (
        <StatusBadge status={{ label: "Fully matched", tone: "success" }} />
      ) : (
        <>
          <StatusBadge status={{ label: `${unmatched.length} unmatched`, tone: "warning" }} />
          <span className="atlas-matrix__note">{unmatched.join("; ")}</span>
        </>
      );
    },
    signature: (insurer) => {
      const count =
        (insurer.unmatched_sections ?? []).length +
        (insurer.unmatched_product_candidates ?? []).length;
      return `${count}`;
    },
  },
  {
    key: "reasoning",
    label: "Atlas reasoning",
    render: (insurer) => <span className="atlas-matrix__note">{insurer.reasoning || "—"}</span>,
    signature: (insurer) => (insurer.reasoning || "").trim().toLowerCase(),
  },
];

function ComparisonMatrix({
  insurers,
  topId,
}: {
  insurers: ScoredInsurer[];
  topId: string | null;
}) {
  // Default to the recommended insurer plus the next few viable options, so a
  // long ruled-out tail does not swamp the comparison.
  const [selected, setSelected] = useState<string[]>(() =>
    insurers.filter((insurer) => !insurer.ruled_out).slice(0, 4).map((insurer) => insurer.insurer_id)
  );

  const shown = useMemo(
    () => insurers.filter((insurer) => selected.includes(insurer.insurer_id)),
    [insurers, selected]
  );

  // For every row, classify it as uniform, strict-majority or no-majority so
  // the matrix highlights only genuine outliers and never invents a "majority"
  // from a tie or an all-distinct row.
  const rowMeta = useMemo(() => {
    return MATRIX_ROWS.map((row) => {
      const signatures = shown.map((insurer) => row.signature(insurer));
      return { row, signatures, state: classifyComparisonRow(signatures) };
    });
  }, [shown]);

  // The scroll region is only a tab stop when it can actually scroll.
  const scrollRef = useRef<HTMLDivElement>(null);
  const scrollable = useHorizontalOverflow(scrollRef, [shown]);

  // Keyboard scrolling for the overflowing comparison region. Only intercept
  // when the region itself is focused: `target !== currentTarget` means the
  // key originated inside an interactive descendant (a button, input, select,
  // textarea, link or disclosure control), and we must not hijack it.
  //
  // Atlas currently ships LTR only — no `dir="rtl"` in the tree, no logical
  // scroll properties in the design system. If RTL support is ever added,
  // ArrowLeft/ArrowRight should swap based on the region's computed direction.
  const onScrollKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (event.target !== event.currentTarget) return;
      const node = event.currentTarget;
      // ~80% of the visible width — one page, minus a sliver of context so the
      // reader keeps their bearings. Floor guarantees movement on very narrow
      // viewports where 80% would otherwise round to zero.
      const step = Math.max(40, Math.round(node.clientWidth * 0.8));
      switch (event.key) {
        case "ArrowRight":
          node.scrollBy({ left: step, behavior: "auto" });
          break;
        case "ArrowLeft":
          node.scrollBy({ left: -step, behavior: "auto" });
          break;
        case "Home":
          node.scrollTo({ left: 0, behavior: "auto" });
          break;
        case "End":
          node.scrollTo({ left: node.scrollWidth, behavior: "auto" });
          break;
        default:
          return;
      }
      event.preventDefault();
    },
    []
  );

  return (
    <div style={{ marginTop: "var(--atlas-space-4)" }}>
      <fieldset className="atlas-matrix__picker">
        <legend className="atlas-block__title" style={{ marginBottom: 8 }}>
          Insurers in the comparison
        </legend>
        <div className="atlas-actions">
          {insurers.map((insurer) => (
            <label className="atlas-checkbox" key={insurer.insurer_id} style={{ minHeight: 28 }}>
              <input
                type="checkbox"
                checked={selected.includes(insurer.insurer_id)}
                onChange={() =>
                  setSelected((current) =>
                    current.includes(insurer.insurer_id)
                      ? current.filter((id) => id !== insurer.insurer_id)
                      : [...current, insurer.insurer_id]
                  )
                }
              />
              <span>
                {insurer.insurer_name}
                {insurer.insurer_id === topId ? " (recommended)" : ""}
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      {shown.length === 0 ? (
        <EmptyState
          inline
          title="No insurers selected"
          body="Tick at least one insurer above to build the comparison."
        />
      ) : (
        <div className="atlas-table-wrap atlas-matrix-wrap">
          <div
            ref={scrollRef}
            className="atlas-table-scroll atlas-matrix-scroll"
            {...(scrollable
              ? {
                  role: "region",
                  "aria-label":
                    "Insurer comparison — scroll to see every criterion and insurer",
                  tabIndex: 0,
                  onKeyDown: onScrollKeyDown,
                }
              : {})}
          >
            <table className="atlas-matrix">
              <caption className="atlas-sr-only">
                Insurer comparison across appetite, blockers, referrals and documentation.
                Where a strict majority of the shown insurers share a value, the cells that
                differ from it are marked "differs"; rows that are tied or all-distinct are
                left unmarked so you can compare the values directly.
              </caption>
              <thead>
                <tr>
                  <th scope="col" style={{ minWidth: 170 }}>
                    Criterion
                  </th>
                  {shown.map((insurer) => {
                    const isTop = insurer.insurer_id === topId;
                    return (
                      <th
                        scope="col"
                        key={insurer.insurer_id}
                        data-pinned={isTop ? "true" : undefined}
                      >
                        <span className="atlas-matrix__insurer">{insurer.insurer_name}</span>
                        <span className="atlas-matrix__role">
                          {isTop ? "Atlas recommended" : "Alternative"}
                        </span>
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {rowMeta.map(({ row, signatures, state }) => (
                  <tr key={row.key} data-uniform={state.kind === "uniform" ? "true" : undefined}>
                    <th scope="row">{row.label}</th>
                    {shown.map((insurer, index) => {
                      const differs =
                        state.kind === "majority" && signatures[index] !== state.signature;
                      return (
                        <td
                          key={insurer.insurer_id}
                          data-differs={differs ? "true" : undefined}
                        >
                          <div className="atlas-matrix__cell">
                            {/* Real per-cell insurer label: hidden on desktop (the column
                                header carries it) and shown at the stacked breakpoint where
                                the header is dropped, so mobile screen readers still get the
                                value↔insurer association without relying on CSS content. */}
                            <span className="atlas-matrix__mobile-insurer">
                              {insurer.insurer_name}
                            </span>
                            {row.render(insurer)}
                            {differs && (
                              <span className="atlas-sr-only"> (differs from the majority)</span>
                            )}
                          </div>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
