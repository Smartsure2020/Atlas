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

import { useMemo, useState, type ReactNode } from "react";
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
            <p className="atlas-reco__headline">{recommendation.reasoning_json.headline}</p>

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

function ruleListMeta(list: string) {
  switch (list) {
    case "preferred":
      return { label: "Preferred", tone: "success" as const };
    case "declined":
    case "portfolio_declined":
      return { label: "Declined", tone: "danger" as const };
    case "referral":
    case "portfolio_referral":
      return { label: "Referral trigger", tone: "referral" as const };
    case "caution":
    case "portfolio_caution":
      return { label: "Caution", tone: "warning" as const };
    default:
      return { label: "Base rule", tone: "neutral" as const };
  }
}

/**
 * Turn the matcher's flat arrays into the structured reason shape the design
 * system uses: what the issue is, why it matters, and what happens next.
 */
function groupFindings(insurer: ScoredInsurer): {
  kind: "blocker" | "referral" | "concern" | "strength" | "info";
  title: string;
  body: string;
  nextAction?: string;
}[] {
  const groups: ReturnType<typeof groupFindings> = [];

  if (insurer.ruled_out) {
    const declined = (insurer.matched_rules ?? []).filter(
      (rule) => rule.list === "declined" || rule.list === "portfolio_declined"
    );
    groups.push({
      kind: "blocker",
      title: "Hard appetite failure",
      body: declined.length
        ? `The insurer's guideline declines this risk. Matched: ${declined
            .flatMap((rule) => rule.matched_strings)
            .join("; ")}.`
        : "This risk falls outside the insurer's stated appetite, so Atlas cannot recommend it.",
      nextAction:
        "Placing here would need the insurer to make an exception. Record an override reason if a manager approves it.",
    });
  }

  if (insurer.referral_required) {
    const triggers = (insurer.matched_rules ?? [])
      .filter((rule) => rule.list === "referral" || rule.list === "portfolio_referral")
      .flatMap((rule) => rule.matched_strings);
    groups.push({
      kind: "referral",
      title: "Referral required",
      body: triggers.length
        ? `The guideline requires a referral because of: ${triggers.join("; ")}.`
        : "The guideline requires the insurer or a senior underwriter to approve this risk before you proceed.",
      nextAction: "Prepare a referral pack with the risk summary, claims experience and mitigating factors.",
    });
  }

  const caution = (insurer.matched_rules ?? [])
    .filter((rule) => rule.list === "caution" || rule.list === "portfolio_caution")
    .flatMap((rule) => rule.matched_strings);
  if (caution.length > 0) {
    groups.push({
      kind: "concern",
      title: "Written with caution",
      body: `The guideline flags this risk for care: ${caution.join("; ")}.`,
      nextAction: "Expect tighter terms, higher excesses, or additional warranties on this risk.",
    });
  }

  const preferred = (insurer.matched_rules ?? [])
    .filter((rule) => rule.list === "preferred")
    .flatMap((rule) => rule.matched_strings);
  if (preferred.length > 0) {
    groups.push({
      kind: "strength",
      title: "Inside preferred appetite",
      body: `The guideline actively wants this business: ${preferred.join("; ")}.`,
    });
  }

  if ((insurer.missing_required_documents ?? []).length > 0) {
    groups.push({
      kind: "concern",
      title: "Documents this insurer requires",
      body: (insurer.missing_required_documents ?? []).join("; "),
      nextAction: "Request these from the broker before submitting to this insurer.",
    });
  }

  const unmatched = [
    ...(insurer.unmatched_sections ?? []).map((item) => `section "${item}"`),
    ...(insurer.unmatched_product_candidates ?? []).map((item) => `product "${item}"`),
  ];
  if (unmatched.length > 0) {
    groups.push({
      kind: "info",
      title: "Not covered by any rule on file",
      body: `Atlas found no guideline rule for ${unmatched.join(", ")}.`,
      nextAction:
        "Confirm the insurer's position on these directly, or ask a manager to add the missing appetite rules.",
    });
  }

  return groups;
}

/* ===========================================================================
   Comparison matrix
   =========================================================================== */

const MATRIX_ROWS: {
  key: string;
  label: string;
  render: (insurer: ScoredInsurer) => ReactNode;
}[] = [
  {
    key: "band",
    label: "Appetite",
    render: (insurer) => <StatusBadge status={appetiteBand(insurer.band)} />,
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
  },
  {
    key: "reasoning",
    label: "Atlas reasoning",
    render: (insurer) => <span className="atlas-matrix__note">{insurer.reasoning || "—"}</span>,
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

  return (
    <div style={{ marginTop: "var(--atlas-space-4)" }}>
      <fieldset style={{ border: 0, padding: 0, margin: "0 0 var(--atlas-space-4)" }}>
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
        <div className="atlas-table-wrap">
          <div className="atlas-table-scroll">
            <table className="atlas-matrix">
              <caption className="atlas-sr-only">
                Insurer comparison across appetite, blockers, referrals and documentation
              </caption>
              <thead>
                <tr>
                  <th scope="col" style={{ minWidth: 170 }}>
                    Criterion
                  </th>
                  {shown.map((insurer) => (
                    <th
                      scope="col"
                      key={insurer.insurer_id}
                      data-pinned={insurer.insurer_id === topId ? "true" : undefined}
                    >
                      <span className="atlas-matrix__insurer">{insurer.insurer_name}</span>
                      {insurer.insurer_id === topId ? "Recommended" : "Alternative"}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {MATRIX_ROWS.map((row) => (
                  <tr key={row.key}>
                    <th scope="row">{row.label}</th>
                    {shown.map((insurer) => (
                      <td key={insurer.insurer_id}>
                        <div className="atlas-matrix__cell">{row.render(insurer)}</div>
                      </td>
                    ))}
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
