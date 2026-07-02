/**
 * Atlas Blueprint — Submission Detail screen
 * ----------------------------------------------------------------------------
 * The Phase 1 centrepiece. Shows the extracted risk summary with per-field
 * confidence flags, the missing-info checklist, red flags, and the documents
 * list. A MANAGER sees the "Run extraction" button (the endpoint enforces this
 * regardless of UI). ANY underwriter can correct fields; saving writes
 * reviewed_json. Once a reviewed version exists, it is what's shown and edited.
 */

import { useEffect, useState } from "react";
import {
  getSubmission,
  runExtraction,
  saveReview,
} from "../lib/atlas";
import { parseReviewFieldValue, reviewValueToEditorText } from "../lib/review-edit";
import AuditTimeline from "./AuditTimeline";
import EmailDraftsPanel from "./EmailDraftsPanel";
import QuoteReviewPanel from "./QuoteReviewPanel";
import RecommendationPanel from "./RecommendationPanel";
import { updateAssignment } from "../lib/phase7";

type FieldSource = {
  document_id?: string | null;
  file_name?: string | null;
  page?: number | null;
  section?: string | null;
  snippet?: string | null;
};
type Field = {
  value: unknown;
  status?: string;
  confidence: number;
  source?: FieldSource;
  notes?: string | null;
};
type AtlasUiRole = "underwriter" | "consultant" | "manager" | "admin" | "readonly";

const LOW_CONF = 0.5; // at or below this, flag the field for scrutiny

function isField(x: unknown): x is Field {
  return !!x && typeof x === "object" && "value" in (x as object) && "confidence" in (x as object);
}

function formatFieldValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value) || (typeof value === "object" && value !== null)) {
    return JSON.stringify(value, null, 2);
  }
  return formatOne(value);
}

function formatOne(item: unknown): string {
  if (item === null || item === undefined) return "";
  if (typeof item === "object") {
    return Object.entries(item as Record<string, unknown>)
      .filter(([, v]) => v !== null && v !== undefined && v !== "")
      .map(([k, v]) => `${k}: ${String(v)}`)
      .join(" · ");
  }
  return String(item);
}

/** Render a single extracted field: label, editable value, confidence flag. */
function FieldRow({
  label,
  field,
  editing,
  onChange,
  error,
}: {
  label: string;
  field: Field;
  editing: boolean;
  onChange: (v: string) => string | null;
  error?: string;
}) {
  const low = field.confidence <= LOW_CONF;
  const display = formatFieldValue(field.value);
  const [editText, setEditText] = useState(reviewValueToEditorText(field.value));

  useEffect(() => {
    setEditText(reviewValueToEditorText(field.value));
  }, [field.value, editing]);

  const sourceBits = [
    field.source?.file_name,
    typeof field.source?.page === "number" ? `page ${field.source.page}` : null,
    field.source?.section,
  ].filter(Boolean);

  return (
    <div className={`atlas-field ${low ? "atlas-field--low" : ""}`}>
      <div className="atlas-field__label">
        {label}
        {field.status && (
          <span className={`atlas-field__status atlas-field__status--${field.status}`}>
            {field.status.replace(/_/g, " ")}
          </span>
        )}
        {low && (
          <span className="atlas-field__flag" title="Low confidence — please verify">
            low confidence
          </span>
        )}
        <span className="atlas-field__confidence">
          {Math.round(field.confidence * 100)}%
        </span>
      </div>
      {editing ? (
        reviewValueToEditorText(field.value).includes("\n") ? (
          <textarea
            className="atlas-field__input"
            rows={Math.min(10, editText.split("\n").length + 1)}
            value={editText}
            placeholder="—"
            onChange={(e) => {
              setEditText(e.target.value);
              onChange(e.target.value);
            }}
          />
        ) : (
          <input
            className="atlas-field__input"
            value={editText}
            placeholder="—"
            onChange={(e) => {
              setEditText(e.target.value);
              onChange(e.target.value);
            }}
          />
        )
      ) : (
        <div className="atlas-field__value" style={{ whiteSpace: "pre-line" }}>
          {display || <span className="atlas-muted-dash">—</span>}
        </div>
      )}
      {error && <div className="atlas-field__error">{error}</div>}
      {(sourceBits.length > 0 || field.source?.snippet || field.notes) && (
        <div className="atlas-field__evidence">
          {sourceBits.length > 0 && <div>{sourceBits.join(" · ")}</div>}
          {field.source?.snippet && <blockquote>{field.source.snippet}</blockquote>}
          {field.notes && <div>{field.notes}</div>}
        </div>
      )}
    </div>
  );
}

export default function SubmissionDetail({
  submissionId,
  role,
  onBack,
}: {
  submissionId: string;
  role: AtlasUiRole;
  onBack: () => void;
}) {
  const canManage = role === "admin" || role === "manager";
  const canWrite = role !== "readonly";
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<any>(null);
  const [editing, setEditing] = useState(false);
  const [working, setWorking] = useState(false);
  const [draft, setDraft] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [reviewVersion, setReviewVersion] = useState(0);
  const [decisionVersion] = useState(0);
  const [assignmentDraft, setAssignmentDraft] = useState({ assigned_to: "", queue_status: "new" });
  const [assignmentSaving, setAssignmentSaving] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const res = await getSubmission(submissionId);
      setData(res);
      // The summary we show/edit: reviewed_json if present, else extracted_json.
      const ex = res.extraction;
      setDraft(ex ? (ex.reviewed_json ?? ex.extracted_json) : null);
      setAssignmentDraft({
        assigned_to: res.submission.assigned_to ?? res.submission.assigned_underwriter ?? "",
        queue_status: res.submission.queue_status ?? "new",
      });
      setFieldErrors({});
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [submissionId]);

  async function onExtract() {
    setWorking(true);
    setError(null);
    try {
      await runExtraction(submissionId);
      await load();
    } catch (e) {
      setError(
        (e as Error).message === "manager_only"
          ? "Only an underwriting manager can run extractions."
          : "Extraction failed. Please try again."
      );
    } finally {
      setWorking(false);
    }
  }

  async function onSaveReview() {
    if (!draft || !data?.extraction) return;
    if (Object.keys(fieldErrors).length > 0) {
      setError("Please fix invalid JSON fields before saving corrections.");
      return;
    }
    setWorking(true);
    setError(null);
    try {
      await saveReview(submissionId, data.extraction.id, draft);
      setEditing(false);
      await load();
      setReviewVersion((v) => v + 1);
    } catch (e) {
      setError("Could not save corrections.");
    } finally {
      setWorking(false);
    }
  }

  async function onSaveAssignment() {
    setAssignmentSaving(true);
    setError(null);
    try {
      await updateAssignment(submissionId, {
        assigned_to: assignmentDraft.assigned_to.trim() || null,
        queue_status: assignmentDraft.queue_status as any,
      });
      await load();
    } catch {
      setError("Could not update assignment.");
    } finally {
      setAssignmentSaving(false);
    }
  }

  /** Update a nested field's value inside the draft summary. */
  function setFieldValue(section: string, key: string, v: string): string | null {
    const fieldKey = `${section}.${key}`;
    let parseError: string | null = null;
    setDraft((prev) => {
      if (!prev) return prev;
      const next = structuredClone(prev) as any;
      if (next[section]?.[key] && isField(next[section][key])) {
        const parsed = parseReviewFieldValue(next[section][key].value, v);
        if (!parsed.ok) {
          parseError = parsed.error;
          return prev;
        }
        next[section][key].value = parsed.value;
      }
      return next;
    });
    setFieldErrors((prev) => {
      const next = { ...prev };
      if (parseError) next[fieldKey] = parseError;
      else delete next[fieldKey];
      return next;
    });
    return parseError;
  }

  if (loading) return <div className="atlas-card">Loading…</div>;
  if (error && !data) return <div className="atlas-card">{error}</div>;

  const submission = data.submission;
  const extraction = data.extraction;
  const summary = draft as any;
  const sections: { key: string; title: string; fields: [string, string][] }[] = [
    {
      key: "extracted_client",
      title: "Client",
      fields: [
        ["name", "Name"],
        ["entity_type", "Entity type"],
        ["registration_or_id_number", "Registration / ID"],
        ["occupation_or_business_description", "Occupation / business"],
        ["contact_details", "Contact details"],
        ["risk_address", "Risk address"],
      ],
    },
    {
      key: "broker",
      title: "Broker",
      fields: [
        ["name", "Name"],
        ["email", "Email"],
        ["brokerage", "Brokerage"],
      ],
    },
    {
      key: "current_cover",
      title: "Current cover",
      fields: [
        ["current_insurer", "Current insurer"],
        ["renewal_date", "Renewal date"],
        ["current_premium", "Current premium"],
        ["cover_sections", "Cover sections"],
        ["sums_insured", "Sums insured"],
        ["excesses", "Excesses"],
        ["warranties", "Warranties"],
        ["endorsements", "Endorsements"],
        ["exclusions", "Exclusions"],
        ["required_documents", "Required documents"],
      ],
    },
    {
      key: "risk_classification",
      title: "Risk classification",
      fields: [
        ["primary_risk_type", "Primary risk type"],
        ["product_line", "Product line"],
        ["risk_type", "Risk type"],
        ["secondary_risk_types", "Secondary risk types"],
        ["business_sector", "Business sector"],
        ["complexity_level", "Complexity"],
      ],
    },
    {
      key: "claims",
      title: "Claims",
      fields: [
        ["claims_history_available", "Claims history available"],
        ["claims_summary", "Claims summary"],
        ["loss_ratio_available", "Loss ratio available"],
      ],
    },
    {
      key: "quote_terms",
      title: "Quote terms",
      fields: [
        ["insurer_name", "Quote insurer"],
        ["quote_reference", "Quote reference"],
        ["quote_date", "Quote date"],
        ["quote_expiry_date", "Quote expiry / validity"],
        ["insured_name", "Insured name"],
        ["risk_address", "Risk address"],
        ["sections", "Quoted sections"],
        ["required_documents", "Required documents"],
        ["notes", "Quote notes"],
      ],
    },
  ];

  return (
    <div>
      <button className="atlas-btn" onClick={onBack} style={{ marginBottom: 16 }}>
        ← Back to submissions
      </button>

      <div className="atlas-page-head">
        <h1>{submission.client_name || "Untitled submission"}</h1>
        <p>
          {submission.request_type || "—"} · {submission.broker_name || "—"} ·{" "}
          <span className="atlas-status-tag">{submission.status.replace(/_/g, " ")}</span>
        </p>
      </div>

      <div className="atlas-card atlas-form" style={{ marginBottom: 16 }}>
        <h3 className="atlas-h3">Queue assignment</h3>
        <div className="atlas-form__two">
          <div className="atlas-form__row">
            <label>Assigned user id</label>
            <input
              value={assignmentDraft.assigned_to}
              onChange={(e) => setAssignmentDraft({ ...assignmentDraft, assigned_to: e.target.value })}
              placeholder="Shared queue"
              disabled={!canWrite}
            />
          </div>
          <div className="atlas-form__row">
            <label>Queue status</label>
            <select
              value={assignmentDraft.queue_status}
              onChange={(e) => setAssignmentDraft({ ...assignmentDraft, queue_status: e.target.value })}
              disabled={!canWrite}
            >
              <option value="new">New</option>
              <option value="in_review">In review</option>
              <option value="waiting_info">Waiting info</option>
              <option value="referred">Referred</option>
              <option value="completed">Completed</option>
              <option value="archived">Archived</option>
            </select>
          </div>
        </div>
        <p className="atlas-muted">
          Shared queue remains enabled. Assignment is visible ownership, not access restriction.
        </p>
        {canWrite && (
          <div className="atlas-form__actions">
            <button className="atlas-btn" onClick={onSaveAssignment} disabled={assignmentSaving}>
              {assignmentSaving ? "Saving..." : "Save assignment"}
            </button>
          </div>
        )}
      </div>

      {data.jobs && (
        <div className="atlas-card" style={{ marginBottom: 16 }}>
          <h3 className="atlas-h3">Last expensive runs</h3>
          <ul className="atlas-checklist">
            {(["extraction", "recommendation", "quote_review"] as const).map((key) => {
              const job = data.jobs[key];
              return (
                <li key={key}>
                  <span className={`atlas-pri atlas-pri--${job?.status === "failed" ? "high" : "low"}`}>
                    {job?.status ?? "none"}
                  </span>
                  <span>
                    {key.replace("_", " ")}
                    {job?.completed_at || job?.created_at
                      ? ` - ${new Date(job.completed_at ?? job.created_at).toLocaleString()}`
                      : " - no job recorded yet"}
                    {job?.status === "skipped" ? " - inputs appear unchanged since the last run" : ""}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {/* Documents */}
      <div className="atlas-card" style={{ marginBottom: 16 }}>
        <h3 className="atlas-h3">Documents</h3>
        {data.documents.length === 0 ? (
          <p className="atlas-muted">No documents attached.</p>
        ) : (
          <ul className="atlas-doclist">
            {data.documents.map((d: any) => (
              <li key={d.id}>
                <span>{d.file_name}</span>
                <span className="atlas-doc-meta">
                  {d.document_type || "—"} ·{" "}
                  {d.status === "expired" ? "file expired" : "active"}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Extraction */}
      {!extraction ? (
        <div className="atlas-card">
          <h3 className="atlas-h3">Risk summary</h3>
          <p className="atlas-muted">
            No extraction yet.{" "}
            {canManage
              ? "Run extraction to read the attached documents into a structured summary."
              : "An underwriting manager needs to run the extraction for this submission."}
          </p>
          {canManage && (
            <button
              className="atlas-btn atlas-btn--primary"
              onClick={onExtract}
              disabled={working}
            >
              {working ? "Extracting…" : "Run extraction"}
            </button>
          )}
          {error && <div className="atlas-inline-error">{error}</div>}
        </div>
      ) : (
        <>
          <div className="atlas-card" style={{ marginBottom: 16 }}>
            <div className="atlas-card__head">
              <h3 className="atlas-h3">Risk summary</h3>
              <div className="atlas-card__actions">
                {extraction.reviewed_json ? (
                  <span className="atlas-reviewed-tag">Reviewed</span>
                ) : (
                  <span className="atlas-ai-tag">AI extraction · unreviewed</span>
                )}
                {!editing ? (
                  <button className="atlas-btn" onClick={() => setEditing(true)} disabled={!canWrite}>
                    Correct
                  </button>
                ) : (
                  <>
                    <button className="atlas-btn" onClick={() => { setEditing(false); load(); }}>
                      Cancel
                    </button>
                    <button
                      className="atlas-btn atlas-btn--primary"
                      onClick={onSaveReview}
                      disabled={working}
                    >
                      {working ? "Saving…" : "Save corrections"}
                    </button>
                  </>
                )}
              </div>
            </div>

            {sections.map((sec) => (
              <div key={sec.key} className="atlas-section">
                <div className="atlas-section__title">{sec.title}</div>
                <div className="atlas-section__grid">
                  {sec.fields.map(([k, label]) => {
                    const f = summary?.[sec.key]?.[k];
                    if (!isField(f)) return null;
                    return (
                      <FieldRow
                        key={k}
                        label={label}
                        field={f}
                        editing={editing}
                        onChange={(v) => setFieldValue(sec.key, k, v)}
                        error={fieldErrors[`${sec.key}.${k}`]}
                      />
                    );
                  })}
                </div>
              </div>
            ))}
          </div>

          {/* Missing info */}
          <div className="atlas-card" style={{ marginBottom: 16 }}>
            <h3 className="atlas-h3">Missing information</h3>
            {(summary?.missing_information ?? []).length === 0 ? (
              <p className="atlas-muted">Nothing flagged as missing.</p>
            ) : (
              <ul className="atlas-checklist">
                {summary.missing_information.map((m: any, i: number) => (
                  <li key={i}>
                    <span className={`atlas-pri atlas-pri--${m.priority}`}>{m.priority}</span>
                    <span><strong>{m.field}</strong> — {m.reason_required}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Red flags */}
          <div className="atlas-card">
            <h3 className="atlas-h3">Red flags</h3>
            {(summary?.red_flags ?? []).length === 0 ? (
              <p className="atlas-muted">No red flags raised.</p>
            ) : (
              <ul className="atlas-checklist">
                {summary.red_flags.map((r: any, i: number) => (
                  <li key={i}>
                    <span className={`atlas-pri atlas-pri--${r.severity}`}>{r.severity}</span>
                    <span><strong>{r.issue}</strong> — {r.reason}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <RecommendationPanel
            submissionId={submissionId}
            extractionExists={!!extraction}
            extractionReviewed={!!extraction?.reviewed_json}
            reviewVersion={reviewVersion}
          />

          <QuoteReviewPanel
            submissionId={submissionId}
            extractionReviewed={!!extraction?.reviewed_json}
            reviewVersion={reviewVersion}
          />

          <EmailDraftsPanel
            submissionId={submissionId}
            decisionVersion={decisionVersion}
          />

          <AuditTimeline
            submissionId={submissionId}
            refreshVersion={reviewVersion}
          />
        </>
      )}
    </div>
  );
}
