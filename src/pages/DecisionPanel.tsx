/**
 * Atlas Blueprint — Decision panel
 * ----------------------------------------------------------------------------
 * Drops into SubmissionDetail beneath the RecommendationPanel. Two modes:
 *
 *   1. No decision yet  → choose accept / override, pick insurer, status,
 *                         optional notes, submit. Validation reflects the
 *                         server's rules so failures aren't surprising.
 *   2. Decision recorded → show a read-only summary (insurer, status,
 *                          accepted vs overridden, reason, notes, who/when).
 *                          A "Change decision" button reveals the form
 *                          again — recording a new decision (a new row;
 *                          history preserved).
 *
 * The "manager required for ruled-out override" gate is enforced server-side.
 * The UI surfaces this clearly: ruled-out insurers in the picker are tagged
 * "manager only" for non-admin users so they know what to expect.
 */

import { useEffect, useState } from "react";
import {
  recordDecision,
  getDecision,
  type Decision,
  type OverrideReasonCode,
} from "../lib/decisions";
import { getRecommendation, type Recommendation, type ScoredInsurer } from "../lib/recommendations";

const REASON_LABELS: Record<OverrideReasonCode, string> = {
  client_preference: "Client preference",
  broker_relationship: "Broker relationship",
  claims_history_factor: "Claims history factor",
  pricing_factor: "Pricing factor",
  capacity_constraint: "Capacity constraint",
  client_request: "Client request",
  other: "Other (specify in notes)",
};

interface Props {
  submissionId: string;
  role: "underwriter" | "consultant" | "manager" | "admin" | "readonly";
  reviewVersion?: number;
}

export default function DecisionPanel({ submissionId, role, reviewVersion = 0 }: Props) {
  const canManage = role === "admin" || role === "manager";
  const [loading, setLoading] = useState(true);
  const [recommendation, setRecommendation] = useState<Recommendation | null>(null);
  const [decision, setDecision] = useState<Decision | null>(null);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Form state
  const [insurerName, setInsurerName] = useState<string>("");
  const [insurerId, setInsurerId] = useState<string | null>(null);
  const [decisionStatus, setDecisionStatus] = useState<"ready_for_quote" | "referred" | "closed">(
    "ready_for_quote"
  );
  const [reasonCode, setReasonCode] = useState<OverrideReasonCode | "">("");
  const [reasonText, setReasonText] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const [r, d] = await Promise.all([
        getRecommendation(submissionId),
        getDecision(submissionId),
      ]);
      setRecommendation(r.recommendation);
      setDecision(d.decision);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [submissionId, reviewVersion]);

  // When editing opens, default to accepting the recommendation's top.
  useEffect(() => {
    if (editing && recommendation?.reasoning_json.top) {
      const top = recommendation.reasoning_json.top;
      setInsurerName(top.insurer_name);
      setInsurerId(top.insurer_id);
    }
  }, [editing, recommendation]);

  if (loading) return null;
  if (!recommendation) {
    return (
      <div className="atlas-card" style={{ marginTop: 16 }}>
        <h3 className="atlas-h3">Underwriter decision</h3>
        <p className="atlas-muted">Run a recommendation first to capture a decision.</p>
      </div>
    );
  }

  // Build the picker list: top + secondaries (free) + ruled-out (admin only).
  const top = recommendation.reasoning_json.top;
  const allChoices: Array<ScoredInsurer & { ruled_out: boolean }> = [
    ...(top ? [{ ...top, ruled_out: false }] : []),
    ...recommendation.secondary_options_json.map((i) => ({ ...i, ruled_out: false })),
    ...recommendation.not_recommended_json.map((i) => ({ ...i, ruled_out: true })),
  ];

  // Helper: is the currently picked insurer one the matcher ruled out?
  const selectionIsRuledOut = allChoices.some(
    (c) => c.ruled_out && c.insurer_name === insurerName
  );

  const isAcceptingTop = !!top && insurerName === top.insurer_name;

  // ---- Saved-decision view ----
  if (decision && !editing) {
    return (
      <div className="atlas-card atlas-decision" style={{ marginTop: 16 }}>
        <div className="atlas-card__head">
          <h3 className="atlas-h3">Underwriter decision</h3>
          <div className="atlas-card__actions">
            <span
              className={`atlas-decision__status atlas-decision__status--${decision.decision_status}`}
            >
              {decision.decision_status.replace("_", " ")}
            </span>
            <button className="atlas-btn atlas-btn--small" onClick={() => setEditing(true)}>
              Change decision
            </button>
          </div>
        </div>
        <div className="atlas-decision__summary">
          <div>
            <div className="atlas-decision__label">Selected insurer</div>
            <div className="atlas-decision__value">{decision.selected_insurer ?? "—"}</div>
          </div>
          <div>
            <div className="atlas-decision__label">AI recommendation</div>
            <div className="atlas-decision__value">
              {decision.ai_recommendation_accepted ? "Accepted" : "Overridden"}
            </div>
          </div>
          {!decision.ai_recommendation_accepted && (
            <div>
              <div className="atlas-decision__label">Override reason</div>
              <div className="atlas-decision__value">
                {decision.override_reason_code
                  ? REASON_LABELS[decision.override_reason_code]
                  : "—"}
                {decision.override_reason ? ` — ${decision.override_reason}` : ""}
              </div>
            </div>
          )}
          {decision.underwriter_notes && (
            <div style={{ gridColumn: "1 / -1" }}>
              <div className="atlas-decision__label">Notes</div>
              <div className="atlas-decision__value">{decision.underwriter_notes}</div>
            </div>
          )}
          <div style={{ gridColumn: "1 / -1", fontSize: 12, color: "var(--atlas-muted)" }}>
            Recorded {new Date(decision.decided_at).toLocaleString()}
          </div>
        </div>
      </div>
    );
  }

  // ---- Editing view ----
  async function onSubmit() {
    setSaving(true);
    setError(null);
    try {
      await recordDecision(submissionId, {
        recommendation_id: recommendation!.id,
        selected_insurer: insurerName || undefined,
        selected_insurer_id: insurerId,
        decision_status: decisionStatus,
        ai_recommendation_accepted: isAcceptingTop,
        override_reason_code: isAcceptingTop ? undefined : (reasonCode || undefined) as OverrideReasonCode | undefined,
        override_reason: isAcceptingTop ? undefined : reasonText || undefined,
        underwriter_notes: notes || undefined,
      });
      setEditing(false);
      // Reset form state for safety in case the user reopens edit.
      setReasonCode("");
      setReasonText("");
      setNotes("");
      await load();
    } catch (e) {
      const msg = (e as Error).message;
      setError(
        msg === "manager_required_for_ruled_out_override"
          ? "Only an underwriting manager can route to an insurer the matcher ruled out."
          : msg === "override_reason_code_required"
          ? "Please choose an override reason."
          : msg === "override_reason_required_for_other"
          ? "When the reason is ‘Other’, please describe it in the reason text."
          : "Could not save the decision. Please try again."
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="atlas-card" style={{ marginTop: 16 }}>
      <h3 className="atlas-h3">Underwriter decision</h3>

      <div className="atlas-form__row">
        <label>Selected insurer</label>
        <select
          value={insurerName}
          onChange={(e) => {
            const v = e.target.value;
            setInsurerName(v);
            const found = allChoices.find((c) => c.insurer_name === v);
            setInsurerId(found?.insurer_id ?? null);
          }}
        >
          <option value="">Select an insurer…</option>
          {allChoices.map((c) => (
            <option key={c.insurer_id} value={c.insurer_name}>
              {c.insurer_name}
              {top && c.insurer_name === top.insurer_name ? "  (top recommendation)" : ""}
              {c.ruled_out ? "  — ruled out" : ""}
              {c.ruled_out && !canManage ? "  (manager only)" : ""}
            </option>
          ))}
        </select>
      </div>

      {selectionIsRuledOut && (
        <div className="atlas-inline-error" style={{ marginTop: 0 }}>
          You’ve selected an insurer the matcher ruled out. This requires a
          manager (admin) — the request will fail at the server if you’re not
          an admin.
        </div>
      )}

      {!isAcceptingTop && insurerName && (
        <>
          <div className="atlas-form__row">
            <label>Override reason</label>
            <select
              value={reasonCode}
              onChange={(e) => setReasonCode(e.target.value as OverrideReasonCode | "")}
            >
              <option value="">Choose a reason…</option>
              {Object.entries(REASON_LABELS).map(([code, label]) => (
                <option key={code} value={code}>{label}</option>
              ))}
            </select>
          </div>
          {reasonCode && (
            <div className="atlas-form__row">
              <label>
                Reason detail{reasonCode === "other" ? "" : " (optional)"}
              </label>
              <input
                value={reasonText}
                onChange={(e) => setReasonText(e.target.value)}
                placeholder={
                  reasonCode === "other"
                    ? "Describe the reason"
                    : "Optional additional context"
                }
              />
            </div>
          )}
        </>
      )}

      <div className="atlas-form__row">
        <label>Submission outcome</label>
        <select
          value={decisionStatus}
          onChange={(e) => setDecisionStatus(e.target.value as typeof decisionStatus)}
        >
          <option value="ready_for_quote">Ready for quote</option>
          <option value="referred">Referred to insurer</option>
          <option value="closed">Closed</option>
        </select>
      </div>

      <div className="atlas-form__row">
        <label>Internal notes (optional)</label>
        <textarea
          rows={3}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />
      </div>

      {error && <div className="atlas-inline-error">{error}</div>}

      <div className="atlas-form__actions">
        {decision && (
          <button className="atlas-btn" onClick={() => { setEditing(false); setError(null); }}>
            Cancel
          </button>
        )}
        <button
          className="atlas-btn atlas-btn--primary"
          onClick={onSubmit}
          disabled={saving || !insurerName}
        >
          {saving ? "Saving…" : decision ? "Record new decision" : "Record decision"}
        </button>
      </div>
    </div>
  );
}
