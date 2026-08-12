/**
 * Atlas — quote review and placement decision
 * ----------------------------------------------------------------------------
 * Two related but distinct jobs on the same tab, deliberately kept apart:
 *
 *   Atlas quote review     — a deterministic section-by-section check of the
 *                            quoted terms against the insurer's own rules,
 *                            with the evidence behind every finding.
 *
 *   Placement decision     — the audited human choice. Atlas's recommendation
 *                            is context; the decision on file is always the
 *                            underwriter's.
 *
 * At wide viewports the two sit side-by-side as a workbench: the review runs
 * down the main column, the decision form is a restrained right-hand rail.
 * At tablet/mobile the rail becomes normal document flow. Sticky rail
 * positioning is disabled below the workbench breakpoint so it can never
 * cover the tab rail, the context header, dialogs or focus targets.
 *
 * The decision form validates in the browser against the same rules the
 * Worker enforces so a missing override reason is caught before the round
 * trip. Every seeding, override-reason, ruled-out, prior-decision and
 * confirmation behaviour from Phase 2 is preserved.
 */

import { useEffect, useMemo, useState } from "react";
import {
  runQuoteReview,
  type QuoteReview,
  type QuoteReviewSection,
  type QuoteReviewSectionStatus,
} from "../lib/quote-reviews";
import { recordDecision, type OverrideReasonCode } from "../lib/decisions";
import { getQuoteReviewHistory, type ComparisonRow } from "../lib/phase4";
import {
  Button,
  Card,
  ConfirmDialog,
  Disclosure,
  EmptyState,
  KeyValue,
  Notice,
  SelectField,
  SourceReference,
  StatusBadge,
  TextAreaField,
  TextField,
  useToast,
} from "../components/ui";
import { DataTable, type Column } from "../components/DataTable";
import {
  DECISION_CHOICE_OPTIONS,
  OVERRIDE_REASON_OPTIONS,
  overrideReasonLabel,
  quoteReviewStatus,
  sectionStatus,
} from "../lib/status";
import { EMPTY, formatDateTime, formatZAR } from "../lib/format";
import type { WorkspaceData } from "./SubmissionDetail";
import type { ExtractionConfidenceState } from "../lib/extraction-confidence";
import type { SubmissionTab } from "../lib/router";
import {
  insurerChoiceList,
  toneToReasonKind,
  type InsurerChoiceEntry,
} from "../lib/decision-workbench";

type DecisionChoice = "proceed" | "refer" | "request_info" | "decline" | "override";

/**
 * Section severity ordering so declines and referrals surface before
 * "no issues" rows. Uses the Worker's own status enum — nothing invented.
 */
const SECTION_SEVERITY: Record<QuoteReviewSectionStatus, number> = {
  declined: 0,
  refer: 1,
  info_required: 2,
  caution: 3,
  insufficient_rule_match: 4,
  ok: 5,
};

function severityScore(status: string): number {
  return SECTION_SEVERITY[status as QuoteReviewSectionStatus] ?? 6;
}

export default function QuoteReviewPanel({
  submissionId,
  data,
  extractionReviewed,
  extractionConfidence,
  onRefresh,
  onGoToTab,
}: {
  submissionId: string;
  data: WorkspaceData;
  extractionReviewed: boolean;
  extractionConfidence: ExtractionConfidenceState;
  onRefresh: () => Promise<void> | void;
  onGoToTab: (tab: SubmissionTab) => void;
}) {
  const toast = useToast();
  const { quoteReview, quoteSections, recommendation, decision } = data;

  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [history, setHistory] = useState<{ reviews: QuoteReview[]; comparison: ComparisonRow[] }>({
    reviews: [],
    comparison: [],
  });

  // Decision form
  const [insurerId, setInsurerId] = useState("");
  const [choice, setChoice] = useState<DecisionChoice>("proceed");
  const [overrideCode, setOverrideCode] = useState<OverrideReasonCode>("other");
  const [reason, setReason] = useState("");
  const [notes, setNotes] = useState("");
  const [touched, setTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const insurerChoices = useMemo<InsurerChoiceEntry[]>(
    () => insurerChoiceList(recommendation),
    [recommendation]
  );

  const topInsurerId = recommendation?.reasoning_json.top?.insurer_id ?? "";
  const topInsurerName = recommendation?.reasoning_json.top?.insurer_name ?? null;

  // Seed the form from whatever is already on file. Unchanged from Phase 2.
  useEffect(() => {
    const saved = decision?.selected_insurer_id ?? quoteReview?.insurer_id ?? topInsurerId ?? "";
    setInsurerId(saved);
    if (quoteReview?.status === "refer") setChoice("refer");
    else if (quoteReview?.status === "declined") setChoice("decline");
    else if (quoteReview?.status === "info_required") setChoice("request_info");
    else setChoice("proceed");
  }, [decision?.selected_insurer_id, quoteReview?.insurer_id, quoteReview?.status, topInsurerId]);

  useEffect(() => {
    let live = true;
    getQuoteReviewHistory(submissionId)
      .then((result) => {
        if (live) setHistory({ reviews: result.reviews, comparison: result.comparison });
      })
      .catch(() => {
        // History is supporting context; its absence must not block the tab.
      });
    return () => {
      live = false;
    };
  }, [submissionId, quoteReview?.id, decision?.id]);

  const selectedInsurer = insurerChoices.find((item) => item.insurer.insurer_id === insurerId);
  const selectionIsOverride = Boolean(insurerId && topInsurerId && insurerId !== topInsurerId);
  const selectionIsRuledOut = Boolean(selectedInsurer?.ruledOut);
  const needsReason =
    choice === "refer" ||
    choice === "decline" ||
    choice === "override" ||
    selectionIsOverride ||
    (quoteReview?.status === "declined" && choice === "proceed");
  const reasonMissing = needsReason && reason.trim().length === 0;

  const sortedSections = useMemo(
    () =>
      [...quoteSections].sort(
        (a, b) => severityScore(a.status) - severityScore(b.status)
      ),
    [quoteSections]
  );

  const sectionCounts = useMemo(() => {
    const counts: Partial<Record<QuoteReviewSectionStatus, number>> = {};
    for (const section of quoteSections) {
      const key = section.status as QuoteReviewSectionStatus;
      counts[key] = (counts[key] ?? 0) + 1;
    }
    return counts;
  }, [quoteSections]);

  const priorDecisionForThisReview =
    decision && quoteReview && decision.quote_review_id === quoteReview.id
      ? decision
      : null;

  async function run(force = false) {
    setRunning(true);
    setError(null);
    setNotice(null);
    try {
      const result = await runQuoteReview(submissionId, {
        recommendation_id: recommendation?.id,
        insurer_id: insurerId || topInsurerId || null,
        force,
      });
      if (result.skipped && result.message) setNotice(result.message);
      else toast.notify("Quote review updated.", "success");
      await onRefresh();
    } catch (cause) {
      const message = (cause as Error).message;
      setError(
        message === "extraction_not_reviewed"
          ? "Review the extracted risk information before running a quote review."
          : message === "no_extraction"
          ? "Run the extraction before running a quote review."
          : message === "insurer_scope_required" || message.includes("Run a recommendation")
          ? "Run a recommendation first, or pick an insurer below, so the quote is checked against that insurer's rules only."
          : "The quote review could not be run. Check the processing screen for the failure reason, then try again."
      );
    } finally {
      setRunning(false);
    }
  }

  async function submitDecision() {
    if (!quoteReview) return;
    setTouched(true);
    if (!insurerId) {
      setError("Choose the insurer this decision applies to.");
      return;
    }
    if (reasonMissing) {
      setError(
        choice === "refer"
          ? "Add the referral reason before recording this decision."
          : "Add a reason before recording this decision. It goes into the audit history."
      );
      return;
    }
    setConfirmOpen(false);
    setSaving(true);
    setError(null);
    try {
      const acceptsRecommendation = Boolean(
        topInsurerId && insurerId === topInsurerId && choice !== "override"
      );
      await recordDecision(submissionId, {
        quote_review_id: quoteReview.id,
        recommendation_id: quoteReview.recommendation_id ?? recommendation?.id,
        selected_insurer: selectedInsurer?.insurer.insurer_name || undefined,
        selected_insurer_id: insurerId || null,
        decision_choice: choice,
        decision_reason: reason || undefined,
        ai_recommendation_accepted: acceptsRecommendation,
        override_reason_code: acceptsRecommendation ? undefined : overrideCode,
        override_reason: acceptsRecommendation ? undefined : reason || undefined,
        underwriter_notes: notes || undefined,
      });
      setReason("");
      setNotes("");
      setTouched(false);
      await onRefresh();
      toast.notify("Decision recorded.", "success");
    } catch (cause) {
      setError(decisionErrorMessage((cause as Error).message));
    } finally {
      setSaving(false);
    }
  }

  const reviewCard = (
    <Card
      title="Atlas quote review"
      description="A deterministic, section-by-section check of the quoted terms against the insurer's own rules."
      actions={
        <>
          {quoteReview && <StatusBadge status={quoteReviewStatus(quoteReview.status)} strong />}
          <Button
            variant="primary"
            size="sm"
            loading={running}
            loadingLabel="Reviewing…"
            disabled={!extractionReviewed}
            onClick={() => run()}
          >
            {quoteReview ? "Rerun quote review" : "Run quote review"}
          </Button>
          {quoteReview && (
            <Button
              size="sm"
              disabled={running || !extractionReviewed}
              onClick={() => run(true)}
              title="Force a fresh review even when Atlas believes the inputs are unchanged."
            >
              Force rerun
            </Button>
          )}
        </>
      }
    >
      {!quoteReview ? (
        <EmptyState
          inline
          title="No quote review yet"
          body="Once a quote is on file, Atlas checks its sections, limits, excesses and warranties against the insurer's own underwriting rules."
        />
      ) : (
        <>
          <KeyValue
            items={[
              {
                key: "Overall outcome",
                value: <StatusBadge status={quoteReviewStatus(quoteReview.status)} />,
              },
              {
                key: "Sections checked",
                value: `${quoteSections.length}`,
              },
              {
                key: "Human review",
                value: quoteReview.manual_review_required ? (
                  <StatusBadge
                    status={{
                      label: "Required",
                      tone: "warning",
                      description:
                        "Atlas could not check part of this quote confidently. A person must look at it.",
                    }}
                  />
                ) : (
                  <StatusBadge status={{ label: "Not flagged", tone: "success" }} />
                ),
              },
              { key: "Reviewed", value: formatDateTime(quoteReview.created_at) },
            ]}
          />

          <SectionStatusSummary counts={sectionCounts} total={quoteSections.length} />

          <div className="atlas-stack atlas-stack--tight" style={{ marginTop: "var(--atlas-space-5)" }}>
            {quoteSections.length === 0 ? (
              <EmptyState
                inline
                title="The review produced no sections"
                body="Atlas found no quoted sections to check. Confirm the quote document is attached and classified correctly."
              />
            ) : (
              sortedSections.map((section) => (
                <SectionBlock key={section.id} section={section} />
              ))
            )}
          </div>
        </>
      )}
    </Card>
  );

  const decisionCard = quoteReview && (
    <Card
      title="Your placement decision"
      description="Atlas's recommendation is context. The decision on file is always yours."
      as="section"
    >
      <DecisionContextStrip
        atlasRecommendedName={topInsurerName}
        currentSelectionName={selectedInsurer?.insurer.insurer_name ?? null}
        selectionIsOverride={selectionIsOverride}
        selectionIsRuledOut={selectionIsRuledOut}
      />

      {priorDecisionForThisReview && (
        <div style={{ marginBottom: "var(--atlas-space-5)" }}>
          <Notice
            tone={priorDecisionForThisReview.ai_recommendation_accepted ? "success" : "referral"}
            title="A decision is already recorded"
          >
            <KeyValue
              items={[
                { key: "Insurer", value: priorDecisionForThisReview.selected_insurer || EMPTY },
                {
                  key: "Outcome",
                  value:
                    DECISION_CHOICE_OPTIONS.find(
                      (option) => option.value === priorDecisionForThisReview.decision_choice
                    )?.label ??
                    priorDecisionForThisReview.decision_status.replace(/_/g, " "),
                },
                {
                  key: "Atlas recommendation",
                  value: priorDecisionForThisReview.ai_recommendation_accepted
                    ? "Accepted"
                    : `Overridden — ${overrideReasonLabel(priorDecisionForThisReview.override_reason_code)}`,
                },
                { key: "Reason", value: priorDecisionForThisReview.decision_reason || EMPTY },
                { key: "Recorded", value: formatDateTime(priorDecisionForThisReview.decided_at) },
              ]}
            />
            <p style={{ marginTop: 10 }}>
              Recording another decision creates a new audited entry — the previous one is kept.
            </p>
          </Notice>
        </div>
      )}

      <div className="atlas-form" aria-label="Placement decision form">
        <SelectField
          label="Insurer"
          required
          value={insurerId}
          placeholder="Choose the insurer"
          error={touched && !insurerId ? "Choose the insurer this decision applies to." : null}
          options={insurerChoices.map((item) => ({
            value: item.insurer.insurer_id,
            label: `${item.insurer.insurer_name} — ${item.group}`,
          }))}
          onChange={(event) => setInsurerId(event.target.value)}
          hint={
            insurerChoices.length === 0
              ? "Run a recommendation first so Atlas knows which insurers were considered."
              : undefined
          }
        />

        {selectionIsRuledOut && (
          <Notice tone="danger" title="This insurer was ruled out by appetite">
            Atlas found a hard appetite failure for this insurer. Only an underwriting manager can
            record a decision that routes here, and the reason below becomes part of the audit
            history.
          </Notice>
        )}

        {selectionIsOverride && !selectionIsRuledOut && (
          <Notice tone="warning" title="This differs from the Atlas recommendation">
            That is allowed. Record why, so the decision is defensible later.
          </Notice>
        )}

        <SelectField
          label="Decision"
          required
          value={choice}
          options={DECISION_CHOICE_OPTIONS.map((option) => ({
            value: option.value,
            label: option.label,
          }))}
          hint={DECISION_CHOICE_OPTIONS.find((option) => option.value === choice)?.description}
          onChange={(event) => setChoice(event.target.value as DecisionChoice)}
        />

        {(choice === "override" || selectionIsOverride) && (
          <SelectField
            label="Override reason"
            required
            value={overrideCode}
            options={OVERRIDE_REASON_OPTIONS}
            onChange={(event) => setOverrideCode(event.target.value as OverrideReasonCode)}
          />
        )}

        <TextField
          label="Reason"
          required={needsReason}
          optional={!needsReason}
          value={reason}
          placeholder={
            needsReason
              ? "Why you are taking this route"
              : "Optional context for the audit history"
          }
          error={touched && reasonMissing ? "Required for overrides, referrals and declines." : null}
          hint={
            needsReason
              ? "This is stored in the audit history and appears in the manager overview."
              : undefined
          }
          onChange={(event) => setReason(event.target.value)}
        />

        <TextAreaField
          label="Internal notes"
          optional
          rows={3}
          value={notes}
          hint="Visible to the underwriting team. Not included in broker communications."
          onChange={(event) => setNotes(event.target.value)}
        />

        <p className="atlas-text-dense atlas-text-muted">
          Changing a select above only stages your intent. The decision is recorded only after you
          confirm it below.
        </p>

        <div className="atlas-actions atlas-actions--end">
          <Button
            variant="primary"
            loading={saving}
            loadingLabel="Recording…"
            disabled={!insurerId}
            onClick={() => {
              setTouched(true);
              if (!insurerId || reasonMissing) {
                void submitDecision();
                return;
              }
              setConfirmOpen(true);
            }}
          >
            Record placement decision
          </Button>
        </div>
      </div>
    </Card>
  );

  return (
    <div className="atlas-stack">
      {!extractionReviewed && (
        <Notice tone="warning" title="Review the risk information first">
          The quote review compares the quote against the reviewed risk information. It stays locked
          until that review is saved.
          <div style={{ marginTop: 8 }}>
            <Button size="sm" iconAfter="arrow-right" onClick={() => onGoToTab("risk")}>
              Open risk information
            </Button>
          </div>
        </Notice>
      )}

      {extractionConfidence.state === "unavailable" && (
        <Notice tone="info" title="Extraction confidence is unavailable">
          The quote review uses the reviewed risk values and the insurer's own rule evidence. The
          extraction provider did not return an overall rating for this run, so the section outcomes
          below rely on the field-level evidence, not on an overall extraction percentage.
        </Notice>
      )}

      {error && <Notice tone="danger" title="That did not complete">{error}</Notice>}
      {notice && <Notice tone="info" title="Nothing changed">{notice}</Notice>}

      {quoteReview ? (
        <div className="atlas-decision-workbench">
          <div className="atlas-decision-workbench__main atlas-stack">{reviewCard}</div>
          <aside
            className="atlas-decision-workbench__rail"
            aria-label="Placement decision"
          >
            {decisionCard}
          </aside>
        </div>
      ) : (
        reviewCard
      )}

      {history.reviews.length > 0 && (
        <Card
          title="Previous reviews"
          description="Every quote review Atlas has run for this submission, newest first."
          flush
        >
          <ul className="atlas-list" style={{ padding: "0 var(--atlas-space-5)" }}>
            {history.reviews.map((review) => (
              <li className="atlas-list__item" key={review.id}>
                <div className="atlas-list__main">
                  <p className="atlas-list__title">
                    {review.id === quoteReview?.id ? "Current review" : "Earlier review"}
                  </p>
                  <p className="atlas-list__meta">{formatDateTime(review.created_at)}</p>
                </div>
                <div className="atlas-list__side">
                  <StatusBadge status={quoteReviewStatus(review.status)} />
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {history.comparison.length > 1 && <QuoteComparison rows={history.comparison} />}

      <ConfirmDialog
        open={confirmOpen}
        title="Record this placement decision?"
        confirmLabel="Record decision"
        working={saving}
        onCancel={() => setConfirmOpen(false)}
        onConfirm={submitDecision}
        body={
          <>
            <p>
              This writes an audited decision against{" "}
              <strong>{selectedInsurer?.insurer.insurer_name ?? "the selected insurer"}</strong> with
              the outcome{" "}
              <strong>
                {DECISION_CHOICE_OPTIONS.find((option) => option.value === choice)?.label ?? choice}
              </strong>
              .
            </p>
            {selectionIsOverride && (
              <p style={{ marginTop: 8 }}>
                It departs from the Atlas recommendation and will be reported as an override in the
                manager overview.
              </p>
            )}
          </>
        }
      />
    </div>
  );
}

function decisionErrorMessage(code: string): string {
  switch (code) {
    case "declined_override_reason_required":
      return "A declined review needs an escalation or override reason before you can proceed.";
    case "referral_notes_required":
      return "Add the referral reason before recording this decision.";
    case "declined_reason_required":
      return "Add a reason before recording a decline.";
    case "override_reason_required":
      return "Add a reason before recording an override.";
    case "override_reason_code_required":
      return "Choose an override reason.";
    case "override_reason_required_for_other":
      return "You chose 'Other' — describe the override reason in the reason field.";
    case "manager_required_for_ruled_out_override":
      return "Only an underwriting manager can route to an insurer that was ruled out by appetite.";
    default:
      return "The decision could not be recorded. Check the fields above and try again.";
  }
}

/* ===========================================================================
   Context strip that keeps Atlas's recommendation and the underwriter's
   pending selection visually separate at the top of the decision surface.
   =========================================================================== */

function DecisionContextStrip({
  atlasRecommendedName,
  currentSelectionName,
  selectionIsOverride,
  selectionIsRuledOut,
}: {
  atlasRecommendedName: string | null;
  currentSelectionName: string | null;
  selectionIsOverride: boolean;
  selectionIsRuledOut: boolean;
}) {
  const currentTone = selectionIsRuledOut
    ? "danger"
    : selectionIsOverride
    ? "referral"
    : "success";
  const currentLabel = selectionIsRuledOut
    ? "Routed to a ruled-out insurer"
    : selectionIsOverride
    ? "Override in progress"
    : currentSelectionName
    ? "Matches Atlas's recommendation"
    : "No insurer selected yet";

  return (
    <dl className="atlas-decision__context" aria-label="Decision context">
      <div className="atlas-decision__context-item">
        <dt>Atlas recommended</dt>
        <dd>
          {atlasRecommendedName ?? (
            <span className="atlas-text-muted">No insurer cleared appetite</span>
          )}
        </dd>
      </div>
      <div className="atlas-decision__context-item">
        <dt>Your current selection</dt>
        <dd>
          {currentSelectionName ?? <span className="atlas-text-muted">None</span>}
          <StatusBadge
            status={{ label: currentLabel, tone: currentTone }}
            className="atlas-decision__context-badge"
          />
        </dd>
      </div>
    </dl>
  );
}

/* ===========================================================================
   Compact status summary — a small strip above the section list so the
   worst-case actionable count is visible without scrolling.
   =========================================================================== */

function SectionStatusSummary({
  counts,
  total,
}: {
  counts: Partial<Record<QuoteReviewSectionStatus, number>>;
  total: number;
}) {
  if (total === 0) return null;
  const order: { status: QuoteReviewSectionStatus; label: string }[] = [
    { status: "declined", label: "Declined" },
    { status: "refer", label: "Referral" },
    { status: "info_required", label: "Information required" },
    { status: "caution", label: "Concern" },
    { status: "insufficient_rule_match", label: "No rule match" },
    { status: "ok", label: "No issues" },
  ];
  const shown = order.filter(({ status }) => (counts[status] ?? 0) > 0);
  if (shown.length === 0) return null;

  return (
    <div className="atlas-decision__section-counts" aria-label="Sections by outcome">
      {shown.map(({ status, label }) => {
        const meta = sectionStatus(status);
        return (
          <StatusBadge
            key={status}
            status={{ label: `${counts[status]} ${label}`, tone: meta.tone }}
          />
        );
      })}
    </div>
  );
}

/* ===========================================================================
   One review section
   =========================================================================== */

function SectionBlock({ section }: { section: QuoteReviewSection }) {
  const status = sectionStatus(section.status);
  const groups = (
    [
      { label: "Declined by the insurer's rules", items: section.declined_reasons ?? [] },
      { label: "Referral triggers", items: section.referral_triggers ?? [] },
      { label: "Documents outstanding", items: section.missing_documents ?? [] },
      { label: "Rating findings", items: section.rating_findings ?? [] },
      { label: "Excess findings", items: section.excess_findings ?? [] },
      { label: "Warranty findings", items: section.warranty_findings ?? [] },
      { label: "Other findings", items: section.findings ?? [] },
    ] satisfies { label: string; items: string[] }[]
  ).filter((group) => group.items.length > 0);

  const rule = section.source_evidence?.rule;

  return (
    <div className={`atlas-reason atlas-reason--${toneToReasonKind(status.tone)}`}>
      <div className="atlas-reason__head" style={{ justifyContent: "space-between" }}>
        <span className="atlas-reason__title">{section.section_name}</span>
        <StatusBadge status={status} />
      </div>

      {section.source_evidence?.consultant_explanation && (
        <p className="atlas-reason__text">{section.source_evidence.consultant_explanation}</p>
      )}

      {groups.length > 0 && (
        <div className="atlas-stack atlas-stack--tight" style={{ marginTop: "var(--atlas-space-3)" }}>
          {groups.map((group) => (
            <div key={group.label}>
              <p className="atlas-block__title">{group.label}</p>
              <ul className="atlas-rule__list">
                {group.items.map((item, index) => (
                  <li key={index}>{item}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}

      {rule && (
        <div style={{ marginTop: "var(--atlas-space-3)" }}>
          <Disclosure summary="The rule this was checked against">
            <SourceReference
              parts={[
                rule.source_file_name,
                rule.product_line ? `product: ${rule.product_line}` : null,
                rule.risk_type ? `risk type: ${rule.risk_type}` : null,
                rule.source_section,
                rule.source_page ? `page ${rule.source_page}` : null,
              ]}
              quote={rule.source_quote}
            />
          </Disclosure>
        </div>
      )}
    </div>
  );
}

/* ===========================================================================
   Quote comparison across reviews
   =========================================================================== */

function QuoteComparison({ rows }: { rows: ComparisonRow[] }) {
  const columns: Column<ComparisonRow>[] = [
    {
      id: "insurer",
      header: "Insurer",
      cell: (row) => <span style={{ fontWeight: 600 }}>{row.insurer}</span>,
      sortValue: (row) => row.insurer.toLowerCase(),
    },
    {
      id: "reference",
      header: "Quote reference",
      cell: (row) => <span className="atlas-mono">{row.quote_reference ?? EMPTY}</span>,
    },
    {
      id: "outcome",
      header: "Outcome",
      cell: (row) => (
        <div className="atlas-queue__tagcell">
          <StatusBadge
            status={
              row.operationally_ready
                ? { label: "Operationally ready", tone: "success" }
                : quoteReviewStatus(row.overall_status)
            }
          />
          {row.manual_review_required && (
            <StatusBadge status={{ label: "Manual review", tone: "warning" }} />
          )}
        </div>
      ),
    },
    {
      id: "premium",
      header: "Total premium",
      align: "right",
      sortValue: (row) => row.total_premium ?? Number.MAX_SAFE_INTEGER,
      cell: (row) => formatZAR(row.total_premium),
    },
    {
      id: "sections",
      header: "Sections",
      align: "right",
      cell: (row) => row.section_count,
    },
    {
      id: "open",
      header: "Open info",
      align: "right",
      cell: (row) => row.open_missing_info_count,
    },
    {
      id: "escalation",
      header: "Referrals / declines",
      align: "right",
      cell: (row) => `${row.referral_count} / ${row.declined_count}`,
    },
    {
      id: "decision",
      header: "Decision",
      cell: (row) => (
        <span className="atlas-table__cellstack">
          <span>{row.decision ?? "Not recorded"}</span>
          {row.decision_reason && <span className="atlas-table__sub">{row.decision_reason}</span>}
        </span>
      ),
    },
  ];

  const warnings = rows.filter((row) => row.comparability_warning);

  return (
    <Card
      title="Quote comparison"
      description="Every quote reviewed for this submission, side by side."
      flush
      footer={
        rows.some((row) => row.cheapest_comparable) ? (
          <p className="atlas-text-dense atlas-text-muted" style={{ marginRight: "auto" }}>
            The lowest premium is shown as a comparison input only, never as a recommendation.
          </p>
        ) : undefined
      }
    >
      {warnings.length > 0 && (
        <div style={{ padding: "var(--atlas-space-4) var(--atlas-space-5) 0" }}>
          <Notice tone="warning" title="Compare cover before comparing premium">
            Sections, sums insured, or review outcomes differ between these quotes. Read the cover
            differences before you look at the price column.
          </Notice>
        </div>
      )}
      <div style={{ padding: "var(--atlas-space-4)" }}>
        <DataTable
          caption="Quote comparison across insurers"
          columns={columns}
          rows={rows}
          rowKey={(row) => row.quote_review_id}
          dense
          empty={<EmptyState inline title="No comparable quotes yet" />}
        />
      </div>
    </Card>
  );
}
