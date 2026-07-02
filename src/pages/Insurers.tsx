/**
 * Atlas Blueprint — Insurers index
 * ----------------------------------------------------------------------------
 * Lists every insurer with its active appetite-rule count. Managers click in
 * to manage guidelines and the appetite matrix; underwriters see the list
 * read-only as reference (the rules edit is admin-gated server-side).
 */

import { useEffect, useState } from "react";
import { listInsurers, createInsurer, type InsurerListItem } from "../lib/insurers";

export default function Insurers({
  role,
  onOpen,
  onBack,
}: {
  role: "underwriter" | "consultant" | "manager" | "admin" | "readonly";
  onOpen: (id: string) => void;
  onBack: () => void;
}) {
  const canManage = role === "admin" || role === "manager";
  const [items, setItems] = useState<InsurerListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({ name: "", quote_channel: "", notes: "" });
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    try {
      const res = await listInsurers();
      setItems(res.insurers);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  async function onAdd() {
    if (!draft.name.trim()) return;
    setWorking(true);
    setError(null);
    try {
      const { id } = await createInsurer({
        name: draft.name.trim(),
        quote_channel: draft.quote_channel || undefined,
        notes: draft.notes || undefined,
      });
      setAdding(false);
      setDraft({ name: "", quote_channel: "", notes: "" });
      await load();
      onOpen(id);
    } catch (e) {
      setError(
        (e as Error).message === "manager_only"
          ? "Only an underwriting manager can add insurers."
          : "Could not create the insurer."
      );
    } finally {
      setWorking(false);
    }
  }

  return (
    <div>
      <button className="atlas-btn" onClick={onBack} style={{ marginBottom: 16 }}>
        ← Back to submissions
      </button>

      <div className="atlas-page-head atlas-page-head--row">
        <div>
          <h1>Insurers</h1>
          <p>Guideline documents and the configurable appetite matrix.</p>
        </div>
        {canManage && !adding && (
          <button
            className="atlas-btn atlas-btn--primary"
            onClick={() => setAdding(true)}
          >
            + Add insurer
          </button>
        )}
      </div>

      {adding && (
        <div className="atlas-card atlas-form" style={{ marginBottom: 16 }}>
          <h3 className="atlas-h3">Add insurer</h3>
          <div className="atlas-form__row">
            <label>Name</label>
            <input
              value={draft.name}
              placeholder="e.g. CIB, ONE, Alpha, Infiniti"
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
          </div>
          <div className="atlas-form__row">
            <label>Quote channel (informational)</label>
            <input
              value={draft.quote_channel}
              placeholder="cardinal | own_portal | email_submission"
              onChange={(e) => setDraft({ ...draft, quote_channel: e.target.value })}
            />
          </div>
          <div className="atlas-form__row">
            <label>Notes</label>
            <textarea
              rows={3}
              value={draft.notes}
              onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
            />
          </div>
          {error && <div className="atlas-inline-error">{error}</div>}
          <div className="atlas-form__actions">
            <button className="atlas-btn" onClick={() => { setAdding(false); setError(null); }}>
              Cancel
            </button>
            <button
              className="atlas-btn atlas-btn--primary"
              onClick={onAdd}
              disabled={working || !draft.name.trim()}
            >
              {working ? "Creating…" : "Create insurer"}
            </button>
          </div>
        </div>
      )}

      {loading ? (
        <div className="atlas-card">Loading…</div>
      ) : items.length === 0 ? (
        <div className="atlas-card">
          <p className="atlas-muted">
            No insurers yet. {canManage ? "Add your first insurer to start uploading guidelines." : "Ask a manager to add insurers."}
          </p>
        </div>
      ) : (
        <ul className="atlas-insurerlist">
          {items.map((i) => (
            <li key={i.id}>
              <button className="atlas-insurer-card" onClick={() => onOpen(i.id)}>
                <div className="atlas-insurer-card__name">{i.name}</div>
                <div className="atlas-insurer-card__meta">
                  <span>{i.active_appetite_count} active {i.active_appetite_count === 1 ? "rule" : "rules"}</span>
                  {i.quote_channel && <span> · {i.quote_channel}</span>}
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
