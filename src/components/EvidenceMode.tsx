/**
 * Atlas — Evidence Mode
 * ----------------------------------------------------------------------------
 * "Why did Atlas rank this insurer here — and how far can I rely on it?"
 *
 * Everything on this surface is READ from the persisted `evidence_json`
 * (recommendation-evidence-v1 or -v2) through lib/recommendation-evidence. It
 * never scores, ranks, classifies materiality or reconstructs history from
 * prose. Where the packet is silent the UI says so: a missing page, quote,
 * file or document is shown as "not recorded", never filled in.
 *
 *   • IntelligenceQualityPanel — recommendation-level reliance verdict.
 *   • EvidenceDrawer           — one insurer: ranking explanation, rules,
 *                                 requested sections, triggers, documents,
 *                                 trusted evidence, gaps, provenance, quality.
 *
 * Quality is presentation only: "Incomplete" never reads as a decline, and
 * nothing here blocks the underwriter.
 */

import type { ReactNode } from "react";
import { Block, Disclosure, Drawer, KeyValue, Notice, StatusBadge } from "./ui";
import {
  INTELLIGENCE_STATE,
  SEVERITY,
  insurerView,
  missingLabel,
  noDataInsurers,
  recommendationQuality,
  type ConsideredLine,
  type DocumentLine,
  type EvidenceView,
  type GapLine,
  type InsurerEvidenceView,
  type ProvenanceView,
  type RuleLine,
  type SectionLine,
} from "../lib/recommendation-evidence";
import type { QualitySeverity } from "../lib/recommendations";

/* ===========================================================================
   Small shared pieces
   =========================================================================== */

export const HISTORICAL_NOTICE =
  "Detailed evidence was not captured for this historical recommendation.";

function formatConfidenceDelta(value: number): string {
  if (value === 0) return "no confidence change";
  return `confidence ${value < 0 ? "−" : "+"}${Math.abs(value).toFixed(2)}`;
}

function SeverityBadge({ severity }: { severity: QualitySeverity }) {
  return <StatusBadge status={SEVERITY[severity]} />;
}

/**
 * Where a rule came from. Missing parts are stated, not hidden. The excerpt is
 * labelled as the rule's excerpt: Atlas does not claim it proves any single
 * matched term.
 */
export function ProvenanceBlock({ provenance }: { provenance: ProvenanceView }) {
  const where = [
    provenance.fileName,
    provenance.section,
    provenance.page !== null ? `page ${provenance.page}` : null,
  ].filter(Boolean) as string[];
  return (
    <div className="atlas-prov">
      <p className="atlas-prov__line">
        <span className="atlas-prov__label">Source</span>{" "}
        {where.length > 0 ? (
          <span>{where.join(" · ")}</span>
        ) : (
          <span className="atlas-prov__missing">Not recorded</span>
        )}
        {provenance.source === "manual" && <span className="atlas-prov__tag">Entered manually</span>}
        {provenance.source === "ai_extracted" && <span className="atlas-prov__tag">Extracted from a guideline</span>}
      </p>
      {provenance.quote ? (
        <blockquote
          className="atlas-prov__quote"
          title="The excerpt recorded with this rule. It is not proof of any single matched term."
        >
          <span className="atlas-prov__label">Source excerpt for this rule</span>
          {provenance.quote}
        </blockquote>
      ) : (
        <p className="atlas-prov__line">
          <span className="atlas-prov__label">Source excerpt</span>{" "}
          <span className="atlas-prov__missing">Not recorded</span>
        </p>
      )}
      {provenance.missing.length > 0 && (
        <p className="atlas-prov__incomplete">
          <StatusBadge status={{ label: "Provenance incomplete", tone: "warning" }} />{" "}
          <span>Not recorded: {provenance.missing.join(", ")}.</span>
        </p>
      )}
    </div>
  );
}

function Terms({ terms }: { terms: { term: string; source: string | null }[] }) {
  if (terms.length === 0) return null;
  return (
    <ul className="atlas-ev__terms" aria-label="Matched terms">
      {terms.map((pair, index) => (
        <li key={`${pair.term}:${pair.source ?? ""}:${index}`}>
          <q>{pair.term}</q>{" "}
          {pair.source ? (
            <span className="atlas-text-muted">matched in {pair.source}</span>
          ) : (
            <span className="atlas-prov__missing">matched — input source not recorded</span>
          )}
        </li>
      ))}
    </ul>
  );
}

function RuleRow({ rule }: { rule: RuleLine }) {
  return (
    <li className="atlas-ev__rule">
      <div className="atlas-ev__rule-head">
        <StatusBadge status={rule.effectMeta} />
        <span className="atlas-ev__rule-score">{rule.contributionLabel}</span>
      </div>
      <p className="atlas-list__title">
        {rule.componentLabel}
      </p>
      <p className="atlas-list__meta">
        {rule.productLine} × {rule.riskType} · rule appetite {rule.appetiteLevel}
      </p>
      <Terms terms={rule.terms} />
    </li>
  );
}

function RuleList({ rules, empty }: { rules: RuleLine[]; empty: string }) {
  if (rules.length === 0) return <p className="atlas-text-dense atlas-text-muted">{empty}</p>;
  return (
    <ul className="atlas-ev__rules">
      {rules.map((rule) => (
        <RuleRow key={rule.evidenceId} rule={rule} />
      ))}
    </ul>
  );
}

/** Compact "what moved the score" list; the full rule detail lives under "Rules applied". */
function ContributionList({ rules, empty }: { rules: RuleLine[]; empty: string }) {
  if (rules.length === 0) return <p className="atlas-text-dense atlas-text-muted">{empty}</p>;
  return (
    <ul className="atlas-list">
      {rules.map((rule) => (
        <li className="atlas-list__item" key={rule.evidenceId}>
          <div className="atlas-list__main">
            <p className="atlas-list__title">{rule.componentLabel}</p>
            <p className="atlas-list__meta">
              {rule.productLine} × {rule.riskType}
              {rule.terms.length > 0 && <> · {[...new Set(rule.terms.map((pair) => pair.term))].map((term) => `“${term}”`).join(", ")}</>}
            </p>
          </div>
          <div className="atlas-list__side">
            <span className="atlas-ev__rule-score">{rule.contributionLabel}</span>
          </div>
        </li>
      ))}
    </ul>
  );
}

function GapRow({ gap }: { gap: GapLine }) {
  return (
    <li className={`atlas-ev__gap atlas-ev__gap--${gap.severity ?? "unclassified"}`}>
      <div className="atlas-ev__gap-head">
        {gap.severity ? (
          <SeverityBadge severity={gap.severity} />
        ) : (
          <StatusBadge status={{ label: "Not classified (evidence v1)", tone: "neutral" }} quiet />
        )}
        <strong>{gap.copy.title}</strong>
      </div>
      <p className="atlas-text-dense">{gap.copy.body}</p>
      {(gap.insurerName || gap.section || gap.missing.length > 0) && (
        <p className="atlas-list__meta">
          {gap.insurerName && <>Insurer: {gap.insurerName}. </>}
          {gap.section && <>Section: {gap.section}. </>}
          {gap.missing.length > 0 && <>Missing: {gap.missing.map(missingLabel).join(", ")}.</>}
        </p>
      )}
    </li>
  );
}

/* ===========================================================================
   Recommendation-level panel
   =========================================================================== */

export function IntelligenceQualityPanel({ evidence }: { evidence: EvidenceView }) {
  if (evidence.kind === "absent") {
    return (
      <section className="atlas-ev__quality" aria-label="Intelligence quality">
        <Notice tone="info" title="Evidence not available">
          {HISTORICAL_NOTICE} The recommendation above is unchanged; Atlas does not rebuild evidence after the fact.
        </Notice>
      </section>
    );
  }
  if (evidence.kind === "unsupported") {
    return (
      <section className="atlas-ev__quality" aria-label="Intelligence quality">
        <Notice tone="warning" title="Evidence format not supported">
          This recommendation's evidence uses a format this version of Atlas cannot display
          {evidence.schemaVersion ? ` (${evidence.schemaVersion})` : ""}. The recommendation itself is unaffected.
        </Notice>
      </section>
    );
  }

  const quality = recommendationQuality(evidence)!;
  const noData = noDataInsurers(evidence);

  if (quality.mode === "v1") {
    return (
      <section className="atlas-ev__quality" aria-label="Intelligence quality">
        <div className="atlas-ev__quality-head">
          <div>
            <p className="atlas-reco__summary-eyebrow">Intelligence quality</p>
            <p className="atlas-reco__summary-title">
              {quality.legacyStatus === "complete" ? "Phase 1A evidence: complete" : "Phase 1A evidence: gaps present"}
            </p>
          </div>
          <StatusBadge
            status={{
              label: quality.legacyStatus === "complete" ? "No gaps recorded" : `${quality.gapCount} gap${quality.gapCount === 1 ? "" : "s"} recorded`,
              tone: quality.legacyStatus === "complete" ? "success" : "warning",
            }}
          />
        </div>
        <Notice tone="info" title="Recorded before the intelligence quality gate">
          This recommendation uses evidence v1. It did not record requested-section evaluations, rules that were
          considered but not used, or how serious each gap is, so Atlas does not show them.
          {quality.legacyStatus === "complete" && " “Complete” here only means the gaps v1 looked for were absent."}
        </Notice>
        {quality.gaps.length > 0 && (
          <Disclosure summary={`Evidence gaps recorded (${quality.gaps.length})`}>
            <ul className="atlas-ev__gaps">
              {quality.gaps.map((gap) => (
                <GapRow key={gap.gapId} gap={gap} />
              ))}
            </ul>
          </Disclosure>
        )}
        <NoDataList items={noData} />
      </section>
    );
  }

  const state = quality.state!;
  const meta = INTELLIGENCE_STATE[state];
  const notable = quality.gaps.filter((gap) => gap.severity !== "advisory");
  const advisory = quality.gaps.filter((gap) => gap.severity === "advisory");
  return (
    <section className="atlas-ev__quality" aria-label="Intelligence quality">
      <div className="atlas-ev__quality-head">
        <div>
          <p className="atlas-reco__summary-eyebrow">Intelligence quality</p>
          <p className="atlas-reco__summary-title">{meta.label}</p>
        </div>
        <div className="atlas-reco__summary-flags">
          <StatusBadge status={{ label: meta.label, tone: meta.tone }} strong />
          <StatusBadge status={{ label: `${quality.blockers} blocker${quality.blockers === 1 ? "" : "s"}`, tone: quality.blockers > 0 ? "danger" : "neutral" }} quiet={quality.blockers === 0} />
          <StatusBadge status={{ label: `${quality.material} material`, tone: quality.material > 0 ? "warning" : "neutral" }} quiet={quality.material === 0} />
          <StatusBadge status={{ label: `${quality.advisory} advisory`, tone: "neutral" }} quiet />
        </div>
      </div>
      <p className="atlas-text-dense">{meta.meaning}</p>
      {quality.scoringStatement && <p className="atlas-text-dense atlas-text-muted">{quality.scoringStatement}</p>}
      {quality.requestedSections.length > 0 && (
        <p className="atlas-text-dense atlas-text-muted">
          Requested cover sections: {quality.requestedSections.join(", ")}.
        </p>
      )}

      {notable.length > 0 && (
        <ul className="atlas-ev__gaps" aria-label="Limitations that affect reliance">
          {notable.map((gap) => (
            <GapRow key={gap.gapId} gap={gap} />
          ))}
        </ul>
      )}
      {advisory.length > 0 && (
        <Disclosure summary={`Advisory notes (${advisory.length})`}>
          <ul className="atlas-ev__gaps">
            {advisory.map((gap) => (
              <GapRow key={gap.gapId} gap={gap} />
            ))}
          </ul>
        </Disclosure>
      )}
      <NoDataList items={noData} />
    </section>
  );
}

function NoDataList({ items }: { items: { insurerId: string; insurerName: string }[] }) {
  if (items.length === 0) return null;
  return (
    <Disclosure summary={`Insurers without appetite data (${items.length})`}>
      <p className="atlas-text-dense atlas-text-muted">
        No active appetite data available for these insurers, so Atlas did not score or rank them. This is a gap in
        the guideline data, not a decline and not a score of zero.
      </p>
      <ul className="atlas-list">
        {items.map((item) => (
          <li key={item.insurerId} className="atlas-list__item">
            <div className="atlas-list__main">
              <p className="atlas-list__title">{item.insurerName}</p>
              <p className="atlas-list__meta">No active appetite data available</p>
            </div>
          </li>
        ))}
      </ul>
    </Disclosure>
  );
}

/* ===========================================================================
   Per-insurer evidence drawer
   =========================================================================== */

export function EvidenceDrawer({
  open,
  onClose,
  evidence,
  insurerId,
  canViewDiagnostics,
}: {
  open: boolean;
  onClose: () => void;
  evidence: EvidenceView;
  insurerId: string | null;
  canViewDiagnostics: boolean;
}) {
  const view = insurerId ? insurerView(evidence, insurerId) : null;
  const title = view ? `Why Atlas ranked ${view.insurerName}` : "Evidence";
  return (
    <Drawer
      open={open}
      onClose={onClose}
      size="lg"
      title={title}
      description="Everything below was recorded when this recommendation ran. Atlas shows it as recorded; nothing is recomputed here."
    >
      {evidence.kind !== "ready" ? (
        <Notice tone="info" title="Evidence not available">
          {evidence.kind === "absent"
            ? HISTORICAL_NOTICE
            : "This recommendation's evidence uses a format this version of Atlas cannot display."}
        </Notice>
      ) : !view ? (
        <Notice tone="warning" title="No evidence was recorded for this insurer">
          The recommendation's evidence packet has no outcome for this insurer, so Atlas shows nothing rather than
          guessing.
        </Notice>
      ) : view.status === "no_data" ? (
        <NoDataBody name={view.insurerName} message={view.message} />
      ) : (
        <InsurerEvidenceBody view={view} canViewDiagnostics={canViewDiagnostics} />
      )}
    </Drawer>
  );
}

function NoDataBody({ name, message }: { name: string; message: string }) {
  return (
    <div className="atlas-ev">
      <Notice tone="info" title={message}>
        Atlas has no active appetite rules for {name}, so it was not scored or ranked. This is a gap in the
        guideline data. It is not a decline, not a poor fit, and not a score of zero.
      </Notice>
    </div>
  );
}

function InsurerEvidenceBody({ view, canViewDiagnostics }: { view: InsurerEvidenceView; canViewDiagnostics: boolean }) {
  const isV2 = view.version === "v2";
  return (
    <div className="atlas-ev">
      <RankingExplanation view={view} />
      <Block title="Rules applied">
        <RuleList rules={view.rules} empty="No appetite rule matched this risk for this insurer." />
      </Block>
      {isV2 ? (
        <RequestedSections view={view} />
      ) : (
        <Block title="Requested sections">
          <Notice tone="info">
            Section-by-section evaluation was not captured for this recommendation (evidence v1). Atlas does not
            reconstruct it.
          </Notice>
        </Block>
      )}
      <Triggers view={view} />
      <RequiredDocuments view={view} />
      <TrustedEvidence view={view} />
      <EvidenceGaps view={view} />
      <Provenance view={view} />
      <InsurerQuality view={view} />
      {canViewDiagnostics && <Diagnostics view={view} />}
    </div>
  );
}

function RankingExplanation({ view }: { view: InsurerEvidenceView }) {
  const rec = view.scoreReconciliation;
  return (
    <Block title="Ranking explanation">
      <p className="atlas-text-dense">
        {view.flags.ruledOut
          ? `${view.insurerName} was ruled out by a hard decline, so it is not ranked among the viable options.`
          : `${view.insurerName} is ranked ${view.rank} among the insurers Atlas scored, with an internal score of ${view.score}.`}{" "}
        The score orders candidates; the reasons below are what to act on.
      </p>
      {view.scoringStatement && <p className="atlas-text-dense atlas-text-muted">{view.scoringStatement}</p>}
      <div className="atlas-ev__flags">
        {view.flags.referral && <StatusBadge status={{ label: "Referral required", tone: "referral" }} />}
        {view.flags.seniorReview && <StatusBadge status={{ label: "Senior review", tone: "referral" }} />}
        {view.flags.manualReview && <StatusBadge status={{ label: "Manual review", tone: "warning" }} />}
        {view.flags.ruledOut && <StatusBadge status={{ label: "Ruled out", tone: "danger" }} />}
      </div>

      <div className="atlas-ev__cols">
        <div>
          <p className="atlas-block__title">What strengthened this result</p>
          <ContributionList rules={view.ranking.strengthened} empty="Nothing added to the score." />
        </div>
        <div>
          <p className="atlas-block__title">What weakened it</p>
          <ContributionList rules={view.ranking.weakened} empty="Nothing reduced the score." />
        </div>
      </div>

      <KeyValue
        items={[
          { key: "Components added up", value: String(rec.component_subtotal) },
          { key: "Hard-decline adjustment", value: String(rec.hard_decline_adjustment) },
          { key: "Clamped to 0–100", value: String(rec.clamp_adjustment) },
          { key: "Final internal score", value: String(rec.final_score) },
          {
            key: "Extraction confidence",
            value:
              view.confidence === null
                ? "Not available"
                : `${Math.round(view.confidence * 100)}%`,
          },
        ]}
      />
    </Block>
  );
}

function RequestedSections({ view }: { view: InsurerEvidenceView }) {
  const sections = view.sections ?? [];
  const considered = view.considered ?? [];
  return (
    <Block title="Requested sections">
      {sections.length === 0 ? (
        <p className="atlas-text-dense atlas-text-muted">
          The reviewed submission recorded no requested cover sections, so there was nothing to evaluate section by
          section.
        </p>
      ) : (
        <ul className="atlas-ev__sections">
          {sections.map((section) => (
            <SectionRow key={section.sectionKey} section={section} />
          ))}
        </ul>
      )}
      {considered.length > 0 && (
        <Disclosure summary={`Rules Atlas considered (${considered.length})`}>
          <ul className="atlas-ev__rules">
            {considered.map((rule) => (
              <ConsideredRow key={rule.ruleId} rule={rule} />
            ))}
          </ul>
          {view.selection && view.selection.omitted_risk_only_rule_count > 0 && (
            <p className="atlas-text-dense atlas-text-muted">
              {view.selection.omitted_risk_only_rule_count} further rule
              {view.selection.omitted_risk_only_rule_count === 1 ? "" : "s"} matched only the risk type and are not
              listed.
            </p>
          )}
        </Disclosure>
      )}
    </Block>
  );
}

function SectionRow({ section }: { section: SectionLine }) {
  return (
    <li className="atlas-ev__section">
      <div className="atlas-ev__rule-head">
        <strong>{section.section}</strong>
        {section.outcomeMeta ? (
          <StatusBadge status={section.outcomeMeta} />
        ) : (
          <StatusBadge status={{ label: "No applicable rule", tone: "warning" }} />
        )}
        {section.status === "evaluated" &&
          (section.reflected ? (
            <StatusBadge status={{ label: "Reflected in the score", tone: "success" }} quiet />
          ) : (
            <StatusBadge status={{ label: "Not reflected in the score", tone: "warning" }} />
          ))}
      </div>
      {section.status === "no_applicable_rule" ? (
        <p className="atlas-text-dense">
          Atlas found no appetite rule for this section at this insurer, so the outcome says nothing about it.
        </p>
      ) : (
        <p className="atlas-list__meta">
          {section.selectedRule
            ? `Rule: ${section.selectedRule.productLine} × ${section.selectedRule.riskType}${
                section.selectedRule.appetiteLevel ? ` · appetite ${section.selectedRule.appetiteLevel}` : ""
              }`
            : null}
        </p>
      )}
      {section.tied && (
        <p className="atlas-text-dense">
          {section.tiedDisagree
            ? "Several equally good rules apply here and they disagree. Atlas used a fixed identity order to pick one; that is not an underwriting judgement."
            : "Several equally good rules apply here and they agree."}
        </p>
      )}
    </li>
  );
}

function ConsideredRow({ rule }: { rule: ConsideredLine }) {
  return (
    <li className="atlas-ev__rule">
      <div className="atlas-ev__rule-head">
        <strong>
          {rule.productLine} × {rule.riskType}
        </strong>
        {rule.scored ? (
          <StatusBadge status={{ label: "Set this insurer's score", tone: "info" }} />
        ) : (
          <StatusBadge
            status={{
              label: rule.notScoredReason === "lost_tie_canonical_order" ? "Considered — lost a tie" : "Considered — weaker match",
              tone: "neutral",
            }}
            quiet
          />
        )}
      </div>
      <p className="atlas-list__meta">
        Rule appetite {rule.appetiteLevel}
        {rule.sectionNames.length > 0 && <> · applies to {rule.sectionNames.join(", ")}</>}
      </p>
      {rule.conditions.length === 0 ? (
        <p className="atlas-text-dense atlas-text-muted">No preferred, caution, referral or decline terms matched.</p>
      ) : (
        <ul className="atlas-ev__conditions">
          {rule.conditions.map((condition, index) => (
            <li key={`${condition.kind}:${index}`}>
              <StatusBadge status={condition.meta} />
              {condition.fromRuleLevel ? (
                <span className="atlas-text-dense"> The rule itself is declined.</span>
              ) : (
                <Terms terms={condition.terms} />
              )}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

function Triggers({ view }: { view: InsurerEvidenceView }) {
  const { hardDeclines, softDeclines, referrals, cautions } = view.triggers;
  const none = hardDeclines.length + softDeclines.length + referrals.length + cautions.length === 0;
  return (
    <Block title="Referral and decline triggers">
      {none && (
        <p className="atlas-text-dense atlas-text-muted">
          No referral, decline or caution trigger fired in the rules that set this insurer's result.
        </p>
      )}
      {hardDeclines.length > 0 && (
        <>
          <p className="atlas-block__title">Hard decline</p>
          <RuleList rules={hardDeclines} empty="" />
        </>
      )}
      {softDeclines.length > 0 && (
        <>
          <p className="atlas-block__title">Possible decline — needs human confirmation</p>
          <p className="atlas-text-dense atlas-text-muted">
            These matched only in AI-inferred red flags, so Atlas treats them as a referral, never as a hard decline.
          </p>
          <RuleList rules={softDeclines} empty="" />
        </>
      )}
      {referrals.length > 0 && (
        <>
          <p className="atlas-block__title">Referral triggers</p>
          <RuleList rules={referrals} empty="" />
        </>
      )}
      {cautions.length > 0 && (
        <>
          <p className="atlas-block__title">Cautions</p>
          <RuleList rules={cautions} empty="" />
        </>
      )}
    </Block>
  );
}

function DocumentRow({ doc }: { doc: DocumentLine }) {
  return (
    <li className="atlas-list__item">
      <div className="atlas-list__main">
        <p className="atlas-list__title">{doc.documentType}</p>
        <p className="atlas-list__meta">
          Required by{" "}
          {doc.requiredBy.length === 0
            ? "a rule that is no longer in the recorded rule set"
            : doc.requiredBy
                .map((rule) => (rule.portfolio ? "the insurer's portfolio rules" : `the ${rule.productLine} × ${rule.riskType} rule`))
                .filter((value, index, all) => all.indexOf(value) === index)
                .join(" and ")}
          {!doc.present && <> · {formatConfidenceDelta(doc.confidenceAdjustment)}</>}
        </p>
      </div>
      <div className="atlas-list__side">
        <StatusBadge status={doc.present ? { label: "Present", tone: "success" } : { label: "Missing", tone: "warning" }} />
      </div>
    </li>
  );
}

function RequiredDocuments({ view }: { view: InsurerEvidenceView }) {
  const all = [...view.documents.missing, ...view.documents.present];
  return (
    <Block title="Required documents">
      {view.flags.ruledOut ? (
        <p className="atlas-text-dense atlas-text-muted">
          Required documents are not checked for an insurer that was ruled out.
        </p>
      ) : all.length === 0 ? (
        <p className="atlas-text-dense atlas-text-muted">No rule for this insurer requires a document.</p>
      ) : (
        <>
          <p className="atlas-text-dense atlas-text-muted">
            A missing document lowers confidence only. It never changes the score.
          </p>
          <ul className="atlas-list">
            {all.map((doc) => (
              <DocumentRow key={doc.documentType} doc={doc} />
            ))}
          </ul>
        </>
      )}
    </Block>
  );
}

function TrustedEvidence({ view }: { view: InsurerEvidenceView }) {
  return (
    <Block title="Trusted evidence">
      <p className="atlas-text-dense atlas-text-muted">
        Atlas counts only active documents with a clean scan as evidence that a required document is on file.
      </p>
      {view.trustedDocuments.length === 0 ? (
        <Notice tone="warning" title="No trusted documents were available">
          No active, clean-scanned document was on file when this recommendation ran, so no required document could
          be evidenced.
        </Notice>
      ) : (
        <ul className="atlas-ev__chips" aria-label="Trusted document types">
          {view.trustedDocuments.map((type) => (
            <li key={type}>
              <StatusBadge status={{ label: type, tone: "success" }} quiet />
            </li>
          ))}
        </ul>
      )}
    </Block>
  );
}

function EvidenceGaps({ view }: { view: InsurerEvidenceView }) {
  const unmatched = [
    ...view.unmatched.sections.map((item) => `section “${item}”`),
    ...view.unmatched.products.map((item) => `product “${item}”`),
  ];
  const sectionsNotEvaluated = (view.sections ?? []).filter((section) => section.status === "no_applicable_rule");
  return (
    <Block title="Evidence gaps — what Atlas does not know">
      {view.gaps.length === 0 && unmatched.length === 0 && sectionsNotEvaluated.length === 0 ? (
        <p className="atlas-text-dense atlas-text-muted">No evidence gap was recorded for this insurer.</p>
      ) : null}
      {view.gaps.length > 0 && (
        <ul className="atlas-ev__gaps">
          {view.gaps.map((gap) => (
            <GapRow key={gap.gapId} gap={gap} />
          ))}
        </ul>
      )}
      {view.version === "v1" && view.gaps.length > 0 && (
        <p className="atlas-text-dense atlas-text-muted">
          Evidence v1 recorded these gaps without a severity. Atlas does not classify them after the fact.
        </p>
      )}
      {unmatched.length > 0 && (
        <p className="atlas-text-dense">Atlas found no guideline rule for {unmatched.join(", ")}.</p>
      )}
      {view.unmatched.nearby.length > 0 && (
        <p className="atlas-text-dense atlas-text-muted">Nearby matrix terms to review: {view.unmatched.nearby.join("; ")}.</p>
      )}
    </Block>
  );
}

function Provenance({ view }: { view: InsurerEvidenceView }) {
  return (
    <Block title="Source guideline provenance">
      {view.provenanceRules.length === 0 ? (
        <p className="atlas-text-dense atlas-text-muted">No rule provenance was recorded for this insurer.</p>
      ) : (
        <ul className="atlas-ev__rules">
          {view.provenanceRules.map((item) => (
            <li key={item.ruleId} className="atlas-ev__rule">
              <p className="atlas-list__title">
                {item.productLine} × {item.riskType}
              </p>
              <ProvenanceBlock provenance={item.provenance} />
            </li>
          ))}
        </ul>
      )}
    </Block>
  );
}

function InsurerQuality({ view }: { view: InsurerEvidenceView }) {
  if (view.quality.mode === "v1") {
    return (
      <Block title="Intelligence quality">
        <p className="atlas-text-dense">
          Evidence v1 summary: {view.quality.status === "complete" ? "complete" : "gaps present"} (
          {view.quality.gapCount} gap{view.quality.gapCount === 1 ? "" : "s"} for this insurer). A severity-based
          quality state was not captured for this recommendation.
        </p>
      </Block>
    );
  }
  const meta = INTELLIGENCE_STATE[view.quality.state];
  return (
    <Block title="Intelligence quality">
      <div className="atlas-ev__flags">
        <StatusBadge status={{ label: meta.label, tone: meta.tone }} strong />
        <StatusBadge status={{ label: `${view.quality.blockers} blocker${view.quality.blockers === 1 ? "" : "s"}`, tone: view.quality.blockers > 0 ? "danger" : "neutral" }} quiet={view.quality.blockers === 0} />
        <StatusBadge status={{ label: `${view.quality.material} material`, tone: view.quality.material > 0 ? "warning" : "neutral" }} quiet={view.quality.material === 0} />
        <StatusBadge status={{ label: `${view.quality.advisory} advisory`, tone: "neutral" }} quiet />
      </div>
      <p className="atlas-text-dense">{meta.meaning}</p>
    </Block>
  );
}

function Diagnostics({ view }: { view: InsurerEvidenceView }) {
  const d = view.diagnostics;
  const rows: { key: string; value: ReactNode }[] = [
    { key: "Evidence schema", value: d.schemaVersion },
    { key: "Recommendation ID", value: d.recommendationId },
    { key: "Extraction ID", value: d.extractionId },
    { key: "Matcher version", value: d.matcherVersion },
    { key: "Taxonomy version", value: d.taxonomyVersion },
    { key: "Input fingerprint", value: d.fingerprint },
    { key: "Quality model", value: d.qualityModel ?? "—" },
    { key: "Scored rule ID", value: d.scoredRuleId ?? "—" },
    { key: "Unresolved rule IDs", value: d.unresolvedRuleIds.length ? d.unresolvedRuleIds.join(", ") : "none" },
    { key: "Evidence IDs", value: d.evidenceIds.length ? d.evidenceIds.join(", ") : "none" },
  ];
  return (
    <Disclosure summary="Diagnostics (internal staff)">
      <p className="atlas-text-dense atlas-text-muted">
        Technical identifiers for tracing this result. Shown to managers and administrators only.
      </p>
      <KeyValue items={rows} wide />
    </Disclosure>
  );
}
