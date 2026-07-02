import { useEffect, useState } from "react";
import {
  getQuoteReview,
  runQuoteReview,
  type QuoteReview,
  type QuoteReviewSection,
} from "../lib/quote-reviews";
import { getRecommendation, type Recommendation } from "../lib/recommendations";
import {
  getDecision,
  recordDecision,
  type Decision,
  type OverrideReasonCode,
} from "../lib/decisions";
import {
  addMissingInfo,
  generateDraft,
  generateMissingInfo,
  getQuoteReviewHistory,
  listCommunications,
  listMissingInfo,
  saveCommunication,
  updateMissingInfo,
  updateCommunication,
  type ComparisonRow,
  type CommunicationRecord,
  type CommunicationType,
  type MissingInfoItem,
  type MissingInfoStatus,
} from "../lib/phase4";

interface Props {
  submissionId: string;
  extractionReviewed: boolean;
  reviewVersion?: number;
}

const OUTCOME_LABEL: Record<string, string> = {
  can_proceed: "Can proceed",
  review_required: "Review required",
  refer: "Refer",
  declined: "Declined",
  info_required: "Information required",
  overridden: "Overridden",
  draft: "Draft",
};

export default function QuoteReviewPanel({
  submissionId,
  extractionReviewed,
  reviewVersion = 0,
}: Props) {
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [quoteReview, setQuoteReview] = useState<QuoteReview | null>(null);
  const [sections, setSections] = useState<QuoteReviewSection[]>([]);
  const [recommendation, setRecommendation] = useState<Recommendation | null>(null);
  const [decision, setDecision] = useState<Decision | null>(null);
  const [decisionChoice, setDecisionChoice] = useState<"proceed" | "refer" | "request_info" | "decline" | "override">("proceed");
  const [decisionReason, setDecisionReason] = useState("");
  const [overrideCode, setOverrideCode] = useState<OverrideReasonCode>("other");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [missingItems, setMissingItems] = useState<MissingInfoItem[]>([]);
  const [manualTitle, setManualTitle] = useState("");
  const [manualDescription, setManualDescription] = useState("");
  const [draftText, setDraftText] = useState("");
  const [draftType, setDraftType] = useState<"missing-info" | "referral-pack" | "quote-summary" | null>(null);
  const [history, setHistory] = useState<QuoteReview[]>([]);
  const [comparison, setComparison] = useState<ComparisonRow[]>([]);
  const [communications, setCommunications] = useState<CommunicationRecord[]>([]);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const [qr, rec, dec, mi, hist, comm] = await Promise.all([
        getQuoteReview(submissionId),
        getRecommendation(submissionId).catch(() => ({ recommendation: null })),
        getDecision(submissionId).catch(() => ({ decision: null })),
        listMissingInfo(submissionId).catch(() => ({ items: [] })),
        getQuoteReviewHistory(submissionId).catch(() => ({ reviews: [], comparison: [], sections_by_review: {}, decisions_by_review: {} })),
        listCommunications(submissionId).catch(() => ({ communications: [] })),
      ]);
      setQuoteReview(qr.quote_review);
      setSections(qr.sections);
      setRecommendation(rec.recommendation);
      setDecision(dec.decision);
      setMissingItems(mi.items);
      setHistory(hist.reviews);
      setComparison(hist.comparison);
      setCommunications(comm.communications);
      if (qr.quote_review?.status === "refer") setDecisionChoice("refer");
      else if (qr.quote_review?.status === "declined") setDecisionChoice("decline");
      else if (qr.quote_review?.status === "info_required") setDecisionChoice("request_info");
      else setDecisionChoice("proceed");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [submissionId, reviewVersion]);

  async function onRun(force = false) {
    setRunning(true);
    setError(null);
    try {
      const res = await runQuoteReview(submissionId, {
        recommendation_id: recommendation?.id,
        insurer_id: recommendation?.reasoning_json.top?.insurer_id ?? null,
        force,
      });
      if (res.skipped && res.message) setError(res.message);
      await load();
    } catch (e) {
      const msg = (e as Error).message;
      setError(
        msg === "extraction_not_reviewed"
          ? "Review the extraction before running quote review."
          : msg === "no_extraction"
          ? "Run the extraction first."
          : msg === "insurer_scope_required" || msg.includes("Run a recommendation")
          ? "Run a recommendation (or select an insurer) first, so the quote is checked against that insurer's rules only."
          : "Could not run the quote review."
      );
    } finally {
      setRunning(false);
    }
  }

  async function onDecision() {
    if (!quoteReview) return;
    setError(null);
    try {
      const top = recommendation?.reasoning_json.top;
      await recordDecision(submissionId, {
        quote_review_id: quoteReview.id,
        recommendation_id: quoteReview.recommendation_id ?? recommendation?.id,
        selected_insurer: top?.insurer_name,
        selected_insurer_id: top?.insurer_id ?? null,
        decision_choice: decisionChoice,
        decision_reason: decisionReason || undefined,
        ai_recommendation_accepted: decisionChoice !== "override",
        override_reason_code: decisionChoice === "override" ? overrideCode : undefined,
        override_reason: decisionChoice === "override" ? decisionReason || undefined : undefined,
        underwriter_notes: notes || undefined,
      });
      await load();
      setDecisionReason("");
      setNotes("");
    } catch (e) {
      const msg = (e as Error).message;
      setError(
        msg === "declined_override_reason_required"
          ? "A declined review needs an override or escalation reason before proceeding."
          : msg === "referral_notes_required"
          ? "Please add referral notes before recording a referral decision."
          : msg === "override_reason_code_required"
          ? "Please choose an override reason."
          : msg === "override_reason_required_for_other"
          ? "Please describe the override reason."
          : "Could not record the quote review decision."
      );
    }
  }

  async function onGenerateMissingInfo() {
    setError(null);
    try {
      await generateMissingInfo(submissionId);
      await load();
    } catch {
      setError("Could not generate missing information items.");
    }
  }

  async function onAddManualItem() {
    if (!manualTitle.trim()) return;
    setError(null);
    try {
      await addMissingInfo(submissionId, {
        quote_review_id: quoteReview?.id,
        title: manualTitle.trim(),
        description: manualDescription.trim() || null,
        item_type: "other",
        owner: "broker",
      });
      setManualTitle("");
      setManualDescription("");
      await load();
    } catch {
      setError("Could not add the missing information item.");
    }
  }

  async function onStatus(item: MissingInfoItem, status: MissingInfoStatus) {
    const notes =
      status === "waived" || status === "not_required"
        ? window.prompt("Please add a note explaining this status change.") ?? ""
        : item.notes;
    setError(null);
    try {
      await updateMissingInfo(item.id, { status, notes });
      await load();
    } catch (e) {
      setError((e as Error).message === "notes_required" ? "Notes are required when waiving or marking not required." : "Could not update item.");
    }
  }

  async function onDraft(type: "missing-info" | "referral-pack" | "quote-summary") {
    setError(null);
    try {
      const res = await generateDraft(submissionId, type, { recipient: "broker", notes });
      setDraftText(res.draft);
      setDraftType(type);
    } catch {
      setError("Could not generate the draft.");
    }
  }

  async function onSaveDraft() {
    if (!draftText || !draftType) return;
    const typeMap: Record<typeof draftType, CommunicationType> = {
      "missing-info": "missing_info_request",
      "referral-pack": "referral_pack",
      "quote-summary": "review_summary",
    };
    try {
      await saveCommunication(submissionId, {
        quote_review_id: quoteReview?.id,
        communication_type: typeMap[draftType],
        audience: draftType === "referral-pack" ? "senior_underwriter" : "broker",
        subject:
          draftType === "missing-info"
            ? "Outstanding information request"
            : draftType === "referral-pack"
            ? "Referral pack"
            : "Quote review summary",
        body: draftText,
        related_missing_info_item_ids: missingItems.filter((i) => i.status === "open" || i.status === "requested").map((i) => i.id),
        related_section_keys: sections.map((s) => s.section_key),
      });
      await load();
    } catch {
      setError("Could not save the communication draft.");
    }
  }

  async function onCopyDraft() {
    if (!draftText) return;
    await navigator.clipboard?.writeText(draftText);
    if (communications[0]?.body === draftText) {
      await updateCommunication(communications[0].id, { status: "copied" }).catch(() => undefined);
      await load();
    }
  }

  async function onCommunicationStatus(record: CommunicationRecord, status: "copied" | "sent_manually" | "archived") {
    try {
      await updateCommunication(record.id, {
        status,
        mark_related_missing_requested: status === "sent_manually",
      });
      await load();
    } catch {
      setError("Could not update communication status.");
    }
  }

  if (loading) return null;

  return (
    <div className="atlas-card atlas-quote-review">
      <div className="atlas-card__head">
        <h3 className="atlas-h3">Quote review</h3>
        <div className="atlas-card__actions">
          {quoteReview && (
            <span className={`atlas-quote-review__status atlas-quote-review__status--${quoteReview.status}`}>
              {OUTCOME_LABEL[quoteReview.status] ?? quoteReview.status}
            </span>
          )}
          <button
            className="atlas-btn atlas-btn--primary atlas-btn--small"
            onClick={() => onRun()}
            disabled={running || !extractionReviewed}
            title={!extractionReviewed ? "Review the extraction before running quote review." : ""}
          >
            {running ? "Reviewing..." : quoteReview ? "Re-run quote review" : "Run quote review"}
          </button>
          {quoteReview && (
            <button
              className="atlas-btn atlas-btn--small"
              onClick={() => onRun(true)}
              disabled={running || !extractionReviewed}
              title="Force a new quote review even if inputs appear unchanged."
            >
              Force rerun
            </button>
          )}
        </div>
      </div>

      {!extractionReviewed && (
        <p className="atlas-muted">Review the extraction before running quote review.</p>
      )}
      {error && <div className="atlas-inline-error">{error}</div>}

      {!quoteReview ? (
        <p className="atlas-muted">
          No quote review yet. Atlas will compare quote terms, matched appetite rules, and uploaded documents.
        </p>
      ) : (
        <>
          <div className="atlas-quote-review__summary">
            <div>
              <span>Overall outcome</span>
              <strong>{OUTCOME_LABEL[quoteReview.status] ?? quoteReview.status}</strong>
            </div>
            <div>
              <span>Confidence</span>
              <strong>{Math.round(quoteReview.overall_confidence * 100)}%</strong>
            </div>
            <div>
              <span>Manual review</span>
              <strong>{quoteReview.manual_review_required ? "Required" : "Not required"}</strong>
            </div>
          </div>

          <div className="atlas-quote-review__sections">
            {sections.map((section) => (
              <SectionBlock key={section.id} section={section} />
            ))}
          </div>

          <div className="atlas-quote-review__decision">
            <h4>Consultant decision</h4>
            {decision?.quote_review_id === quoteReview.id && (
              <div className="atlas-quote-review__saved">
                Latest decision: {decision.decision_choice ?? decision.decision_status}
                {decision.decision_reason ? ` - ${decision.decision_reason}` : ""}
              </div>
            )}
            <div className="atlas-form__row">
              <label>Decision</label>
              <select value={decisionChoice} onChange={(e) => setDecisionChoice(e.target.value as typeof decisionChoice)}>
                <option value="proceed">Proceed</option>
                <option value="refer">Refer to senior/insurer</option>
                <option value="request_info">Request missing information</option>
                <option value="decline">Decline / do not proceed</option>
                <option value="override">Override Atlas recommendation</option>
              </select>
            </div>
            {decisionChoice === "override" && (
              <div className="atlas-form__row">
                <label>Override reason code</label>
                <select value={overrideCode} onChange={(e) => setOverrideCode(e.target.value as OverrideReasonCode)}>
                  <option value="client_preference">Client preference</option>
                  <option value="broker_relationship">Broker relationship</option>
                  <option value="claims_history_factor">Claims history factor</option>
                  <option value="pricing_factor">Pricing factor</option>
                  <option value="capacity_constraint">Capacity constraint</option>
                  <option value="client_request">Client request</option>
                  <option value="other">Other</option>
                </select>
              </div>
            )}
            <div className="atlas-form__row">
              <label>Reason</label>
              <input
                value={decisionReason}
                onChange={(e) => setDecisionReason(e.target.value)}
                placeholder="Required for overrides and declined/referred outcomes"
              />
            </div>
            <div className="atlas-form__row">
              <label>Notes</label>
              <textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />
            </div>
            <button className="atlas-btn atlas-btn--primary" onClick={onDecision}>
              Record quote decision
            </button>
          </div>

          <div className="atlas-quote-review__phase4">
            <h4>Next actions</h4>
            <div className="atlas-card__actions" style={{ justifyContent: "flex-start", marginBottom: 10 }}>
              <button className="atlas-btn atlas-btn--small" onClick={onGenerateMissingInfo}>Generate missing info</button>
              <button className="atlas-btn atlas-btn--small" onClick={() => onDraft("missing-info")}>Request draft</button>
              <button className="atlas-btn atlas-btn--small" onClick={() => onDraft("referral-pack")}>Referral pack</button>
              <button className="atlas-btn atlas-btn--small" onClick={() => onDraft("quote-summary")}>Review summary</button>
            </div>
            <div className="atlas-form__row">
              <label>Add manual missing item</label>
              <input value={manualTitle} onChange={(e) => setManualTitle(e.target.value)} placeholder="Item title" />
            </div>
            <div className="atlas-form__row">
              <label>Description</label>
              <input value={manualDescription} onChange={(e) => setManualDescription(e.target.value)} placeholder="Why it is needed" />
            </div>
            <button className="atlas-btn atlas-btn--small" onClick={onAddManualItem} disabled={!manualTitle.trim()}>
              Add item
            </button>

            <MissingInfoList items={missingItems} onStatus={onStatus} />

            {draftText && (
              <div className="atlas-quote-review__draft">
                <div className="atlas-card__head">
                  <h4>Copyable draft</h4>
                  <button className="atlas-btn atlas-btn--small" onClick={onSaveDraft}>
                    Save draft
                  </button>
                  <button className="atlas-btn atlas-btn--small" onClick={onCopyDraft}>
                    Copy
                  </button>
                </div>
                <textarea readOnly value={draftText} rows={12} />
              </div>
            )}

            <CommunicationHistory records={communications} onStatus={onCommunicationStatus} />
          </div>

          <HistoryComparison history={history} comparison={comparison} latestId={quoteReview.id} />
        </>
      )}
    </div>
  );
}

function MissingInfoList({
  items,
  onStatus,
}: {
  items: MissingInfoItem[];
  onStatus: (item: MissingInfoItem, status: MissingInfoStatus) => void;
}) {
  if (items.length === 0) return <p className="atlas-muted">No missing information items captured yet.</p>;
  return (
    <div className="atlas-missing-info">
      {items.map((item) => (
        <div key={item.id} className={`atlas-missing-info__item atlas-missing-info__item--${item.status}`}>
          <div>
            <strong>{item.title}</strong>
            <div>{item.description}</div>
            <span>{item.section_key ?? "General"} / {item.item_type} / {item.source}</span>
          </div>
          <select value={item.status} onChange={(e) => onStatus(item, e.target.value as MissingInfoStatus)}>
            <option value="open">open</option>
            <option value="requested">requested</option>
            <option value="received">received</option>
            <option value="waived">waived</option>
            <option value="not_required">not required</option>
          </select>
        </div>
      ))}
    </div>
  );
}

function HistoryComparison({
  history,
  comparison,
  latestId,
}: {
  history: QuoteReview[];
  comparison: ComparisonRow[];
  latestId: string;
}) {
  if (history.length === 0) return null;
  return (
    <div className="atlas-quote-history">
      <h4>Quote review history</h4>
      <div className="atlas-quote-history__list">
        {history.map((review) => (
          <div key={review.id} className="atlas-quote-history__row">
            <strong>{review.id === latestId ? "Latest review" : "Previous review"}</strong>
            <span>{new Date(review.created_at).toLocaleString()}</span>
            <span>{OUTCOME_LABEL[review.status] ?? review.status}</span>
            <span>{review.recommendation_id ? `Recommendation ${review.recommendation_id.slice(0, 8)}` : "No recommendation"}</span>
          </div>
        ))}
      </div>
      {comparison.length > 1 && (
        <div className="atlas-quote-comparison">
          <h4>Basic comparison</h4>
          <table>
            <thead>
              <tr>
                <th>Insurer</th>
                <th>Quote ref</th>
                <th>Status</th>
                <th>Total premium</th>
                <th>Sections</th>
                <th>Open info</th>
                <th>Refer / declined</th>
                <th>Major issues</th>
                <th>Decision</th>
              </tr>
            </thead>
            <tbody>
              {comparison.map((row) => (
                <tr key={row.quote_review_id}>
                  <td>{row.insurer}</td>
                  <td>{row.quote_reference ?? "-"}</td>
                  <td>
                    {row.operationally_ready ? "Operationally ready" : row.overall_status}
                    {row.manual_review_required ? " / manual review" : ""}
                  </td>
                  <td>{row.total_premium ?? "-"}</td>
                  <td>{row.section_count}</td>
                  <td>{row.open_missing_info_count}</td>
                  <td>{row.referral_count} / {row.declined_count}</td>
                  <td>{row.major_issue_count}</td>
                  <td>{row.decision ?? "-"}{row.decision_reason ? ` - ${row.decision_reason}` : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {comparison.some((row) => row.cheapest_comparable) && (
            <p className="atlas-muted">Lowest premium is shown only as a comparison input, not a recommendation.</p>
          )}
          {comparison.some((row) => row.comparability_warning) && (
            <div className="atlas-inline-error">
              Premiums may not be comparable because sections, sums insured, or outcomes differ.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function CommunicationHistory({
  records,
  onStatus,
}: {
  records: CommunicationRecord[];
  onStatus: (record: CommunicationRecord, status: "copied" | "sent_manually" | "archived") => void;
}) {
  if (records.length === 0) {
    return <p className="atlas-muted">No saved communication records yet.</p>;
  }
  return (
    <div className="atlas-communications">
      <h4>Communication history</h4>
      {records.map((record) => (
        <div key={record.id} className={`atlas-communications__row atlas-communications__row--${record.status}`}>
          <div>
            <strong>{record.subject ?? record.communication_type}</strong>
            <div>{record.audience} / {record.status} / {new Date(record.created_at).toLocaleString()}</div>
            {record.sent_at && <span>Sent manually {new Date(record.sent_at).toLocaleString()}</span>}
          </div>
          <div className="atlas-card__actions">
            <button className="atlas-btn atlas-btn--small" onClick={() => navigator.clipboard?.writeText(record.body)}>
              Copy body
            </button>
            <button className="atlas-btn atlas-btn--small" onClick={() => onStatus(record, "copied")}>
              Mark copied
            </button>
            <button className="atlas-btn atlas-btn--small" onClick={() => onStatus(record, "sent_manually")}>
              Mark sent
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

function SectionBlock({ section }: { section: QuoteReviewSection }) {
  const groups: { label: string; items: string[]; tone: string }[] = [
    { label: "Missing documents", items: section.missing_documents ?? [], tone: "warn" },
    { label: "Referral triggers", items: section.referral_triggers ?? [], tone: "warn" },
    { label: "Declined reasons", items: section.declined_reasons ?? [], tone: "danger" },
    { label: "Rating findings", items: section.rating_findings ?? [], tone: "warn" },
    { label: "Excess findings", items: section.excess_findings ?? [], tone: "warn" },
    { label: "Warranty findings", items: section.warranty_findings ?? [], tone: "warn" },
    { label: "Other findings", items: section.findings ?? [], tone: "neutral" },
  ];
  const rule = section.source_evidence?.rule;
  return (
    <div className={`atlas-quote-review__section atlas-quote-review__section--${section.status}`}>
      <div className="atlas-quote-review__section-head">
        <strong>{section.section_name}</strong>
        <span className={`atlas-level atlas-level--${section.status}`}>{section.status}</span>
      </div>
      {rule && (
        <div className="atlas-quote-review__evidence">
          Matched rule: {rule.product_line ?? "rule"} / {rule.risk_type ?? "rule"}
          {rule.source_quote && <blockquote>{rule.source_quote}</blockquote>}
        </div>
      )}
      {section.source_evidence?.consultant_explanation && (
        <p>{section.source_evidence.consultant_explanation}</p>
      )}
      {groups.map((group) =>
        group.items.length === 0 ? null : (
          <div key={group.label} className={`atlas-quote-review__findings atlas-tone--${group.tone}`}>
            <strong>{group.label}</strong>
            <ul>
              {group.items.map((item, i) => <li key={i}>{item}</li>)}
            </ul>
          </div>
        )
      )}
    </div>
  );
}
