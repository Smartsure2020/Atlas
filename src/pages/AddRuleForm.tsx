/**
 * Atlas Blueprint — manual "Add rule" form
 * ----------------------------------------------------------------------------
 * Drops into InsurerDetail's Active tab. A self-contained inline form that
 * supports both product-specific rules (real product_line/risk_type) and
 * portfolio rules (product_line="*" AND risk_type="*"). A toggle picks which.
 *
 * Designed to add minimal surface to InsurerDetail.tsx — just one import,
 * one piece of state, one render line.
 */

import { useState } from "react";
import { addAppetiteRule } from "../lib/insurers";

interface Props {
  insurerId: string;
  onAdded: () => void;
  onCancel: () => void;
}

type Level = "preferred" | "standard" | "caution" | "declined";

export function AddRuleForm({ insurerId, onAdded, onCancel }: Props) {
  const [isPortfolio, setIsPortfolio] = useState(false);
  const [draft, setDraft] = useState({
    product_line: "",
    risk_type: "",
    appetite_level: "standard" as Level,
    preferred_risks: "",
    caution_risks: "",
    declined_risks: "",
    required_documents: "",
    referral_triggers: "",
    notes: "",
  });
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const csv = (s: string) =>
    s.split(",").map((x) => x.trim()).filter(Boolean);

  async function onSave() {
    setWorking(true);
    setError(null);
    try {
      await addAppetiteRule(insurerId, {
        product_line: isPortfolio ? "*" : draft.product_line.trim(),
        risk_type: isPortfolio ? "*" : draft.risk_type.trim(),
        appetite_level: draft.appetite_level,
        preferred_risks: csv(draft.preferred_risks),
        caution_risks: csv(draft.caution_risks),
        declined_risks: csv(draft.declined_risks),
        required_documents: csv(draft.required_documents),
        referral_triggers: csv(draft.referral_triggers),
        notes: draft.notes || undefined,
      });
      onAdded();
    } catch (e) {
      setError(
        (e as Error).message === "manager_only"
          ? "Only an underwriting manager can add rules."
          : "Could not save the rule."
      );
      setWorking(false);
    }
  }

  const canSave =
    isPortfolio || (draft.product_line.trim() && draft.risk_type.trim());

  return (
    <div className="atlas-card atlas-form" style={{ marginBottom: 16 }}>
      <div className="atlas-card__head">
        <h3 className="atlas-h3">Add appetite rule</h3>
        <div className="atlas-card__actions">
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
            <input
              type="checkbox"
              checked={isPortfolio}
              onChange={(e) => setIsPortfolio(e.target.checked)}
            />
            Portfolio rule (applies across all products)
          </label>
        </div>
      </div>

      {!isPortfolio ? (
        <div className="atlas-form__two">
          <div className="atlas-form__row">
            <label>Product line</label>
            <input
              value={draft.product_line}
              placeholder="e.g. buildings, motor, sectional_title"
              onChange={(e) => setDraft({ ...draft, product_line: e.target.value })}
            />
          </div>
          <div className="atlas-form__row">
            <label>Risk type</label>
            <input
              value={draft.risk_type}
              placeholder="e.g. body_corporate, commercial_building"
              onChange={(e) => setDraft({ ...draft, risk_type: e.target.value })}
            />
          </div>
        </div>
      ) : (
        <p className="atlas-muted" style={{ marginTop: 0 }}>
          Portfolio rules apply across every product / risk for this insurer —
          good for territorial limits, blanket exclusions, referral controls,
          and new-business requirements.
        </p>
      )}

      <div className="atlas-form__row">
        <label>Appetite level</label>
        <select
          value={draft.appetite_level}
          onChange={(e) => setDraft({ ...draft, appetite_level: e.target.value as Level })}
        >
          <option value="preferred">preferred</option>
          <option value="standard">standard</option>
          <option value="caution">caution</option>
          <option value="declined">declined</option>
        </select>
      </div>

      <div className="atlas-form__row">
        <label>Preferred risks (comma-separated)</label>
        <input
          value={draft.preferred_risks}
          onChange={(e) => setDraft({ ...draft, preferred_risks: e.target.value })}
        />
      </div>
      <div className="atlas-form__row">
        <label>Caution risks (comma-separated)</label>
        <input
          value={draft.caution_risks}
          onChange={(e) => setDraft({ ...draft, caution_risks: e.target.value })}
        />
      </div>
      <div className="atlas-form__row">
        <label>Declined risks (comma-separated)</label>
        <input
          value={draft.declined_risks}
          onChange={(e) => setDraft({ ...draft, declined_risks: e.target.value })}
          placeholder="war, nuclear, pandemic, etc."
        />
      </div>
      <div className="atlas-form__row">
        <label>Referral triggers (comma-separated)</label>
        <input
          value={draft.referral_triggers}
          onChange={(e) => setDraft({ ...draft, referral_triggers: e.target.value })}
          placeholder="backdated endorsement, credit over R5,000"
        />
      </div>
      <div className="atlas-form__row">
        <label>Required documents (comma-separated)</label>
        <input
          value={draft.required_documents}
          onChange={(e) => setDraft({ ...draft, required_documents: e.target.value })}
          placeholder="proposal form, 3-year claims history"
        />
      </div>
      <div className="atlas-form__row">
        <label>Notes</label>
        <textarea
          rows={2}
          value={draft.notes}
          onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
        />
      </div>

      {error && <div className="atlas-inline-error">{error}</div>}

      <div className="atlas-form__actions">
        <button className="atlas-btn" onClick={onCancel}>Cancel</button>
        <button
          className="atlas-btn atlas-btn--primary"
          onClick={onSave}
          disabled={working || !canSave}
        >
          {working ? "Saving…" : "Save rule"}
        </button>
      </div>
    </div>
  );
}
