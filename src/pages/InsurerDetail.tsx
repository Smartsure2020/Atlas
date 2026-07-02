/**
 * Atlas Blueprint — Insurer Detail screen
 * ----------------------------------------------------------------------------
 * Three concerns on one page, tab-organised:
 *   1. Documents — upload a guideline, click Process, see status/error.
 *   2. Proposed  — AI's proposed rules from a processed document. Review,
 *      edit, confirm (-> goes live) or deactivate (-> ignored).
 *   3. Active    — the live matrix the matcher will read in Phase 2B. Edit
 *      or deactivate (e.g. when a guideline is superseded).
 *
 * Every mutating action is admin-only server-side; the UI also hides the
 * controls for plain underwriters so they never see disabled buttons. Server-
 * side enforcement is the authoritative gate.
 */

import { useEffect, useMemo, useState } from "react";
import { AddRuleForm } from "./AddRuleForm";
import {
  getInsurer,
  updateInsurer,
  editAppetite,
  confirmAppetite,
  deactivateAppetite,
  type AppetiteRow,
  type InsurerDocument,
  type InsurerListItem,
} from "../lib/insurers";
import { DocumentsPanel } from "./DocumentsPanel";

type Tab = "documents" | "proposed" | "active";
type AtlasUiRole = "underwriter" | "consultant" | "manager" | "admin" | "readonly";
const canManage = (role: AtlasUiRole) => role === "admin" || role === "manager";

export default function InsurerDetail({
  insurerId,
  role,
  onBack,
}: {
  insurerId: string;
  role: AtlasUiRole;
  onBack: () => void;
}) {
  const [loading, setLoading] = useState(true);
  const [insurer, setInsurer] = useState<InsurerListItem | null>(null);
  const [isAdding, setIsAdding] = useState(false);
  const [documents, setDocuments] = useState<InsurerDocument[]>([]);
  const [appetite, setAppetite] = useState<AppetiteRow[]>([]);
  const [tab, setTab] = useState<Tab>("documents");
  const [error, setError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [renameWorking, setRenameWorking] = useState(false);

  async function onSaveName() {
    if (!nameDraft.trim() || !insurer) return;
    setRenameWorking(true);
    try {
      await updateInsurer(insurer.id, { name: nameDraft.trim() });
      setRenaming(false);
      await load();
    } catch {
      setError("Could not rename the insurer.");
    } finally {
      setRenameWorking(false);
    }
  }

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const res = await getInsurer(insurerId);
      setInsurer(res.insurer);
      setDocuments(res.documents);
      setAppetite(res.appetite);
    } catch (e) {
      setError(
        (e as Error).message === "manager_only"
          ? "This insurer's detail is manager-only."
          : "Could not load this insurer."
      );
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [insurerId]);

  const proposed = useMemo(() => appetite.filter((a) => !a.is_active), [appetite]);
  const active = useMemo(() => appetite.filter((a) => a.is_active), [appetite]);

  if (loading) return <div className="atlas-card">Loading…</div>;
  if (error) return <div className="atlas-card">{error}</div>;
  if (!insurer) return null;

  return (
    <div>
      <button className="atlas-btn" onClick={onBack} style={{ marginBottom: 16 }}>
        ← Back to insurers
      </button>

      <div className="atlas-page-head">
        {!renaming ? (
          <h1 style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
            {insurer.name}
            {canManage(role) && (
              <button
                className="atlas-btn atlas-btn--small atlas-btn--ghost"
                onClick={() => { setNameDraft(insurer.name); setRenaming(true); }}
              >
                Edit
              </button>
            )}
          </h1>
        ) : (
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              autoFocus
              style={{
                fontFamily: "var(--atlas-display)",
                fontWeight: 600,
                fontSize: 27,
                padding: "4px 8px",
                border: "1px solid var(--atlas-line)",
                borderRadius: 7,
              }}
            />
            <button className="atlas-btn atlas-btn--small" onClick={() => setRenaming(false)}>
              Cancel
            </button>
            <button
              className="atlas-btn atlas-btn--primary atlas-btn--small"
              onClick={onSaveName}
              disabled={renameWorking || !nameDraft.trim()}
            >
              {renameWorking ? "Saving…" : "Save"}
            </button>
          </div>
        )}
        <p>
          {insurer.quote_channel ?? "—"} ·{" "}
          {active.length} active {active.length === 1 ? "rule" : "rules"} ·{" "}
          {proposed.length} pending review
        </p>
      </div>

      <div className="atlas-tabs">
        <button
          className={`atlas-tab ${tab === "documents" ? "atlas-tab--on" : ""}`}
          onClick={() => setTab("documents")}
        >
          Documents <span className="atlas-tab__count">{documents.length}</span>
        </button>
        <button
          className={`atlas-tab ${tab === "proposed" ? "atlas-tab--on" : ""}`}
          onClick={() => setTab("proposed")}
        >
          Proposed <span className="atlas-tab__count">{proposed.length}</span>
        </button>
        <button
          className={`atlas-tab ${tab === "active" ? "atlas-tab--on" : ""}`}
          onClick={() => setTab("active")}
        >
          Active matrix <span className="atlas-tab__count">{active.length}</span>
        </button>
      </div>

      {tab === "documents" && (
        <DocumentsPanel
          insurerId={insurerId}
          role={role}
          documents={documents}
          onChanged={load}
        />
      )}
      {tab === "proposed" && (
        <AppetitePanel
          rows={proposed}
          role={role}
          showConfirm
          onChanged={load}
        />
      )}
      {tab === "active" && (
        <AppetitePanel
          rows={active}
          role={role}
          onChanged={() => { setIsAdding(false); load(); }}
          insurerId={insurerId}
          isAdding={isAdding}
          onStartAdd={() => setIsAdding(true)}
          onCancelAdd={() => setIsAdding(false)}
        />
      )}
    </div>
  );
}

// ----------------------------------------------------------------------------
// Appetite rule rows — used for both Proposed and Active tabs
// ----------------------------------------------------------------------------

function AppetitePanel({
  rows,
  role,
  showConfirm = false,
  onChanged,
  insurerId,
  isAdding,
  onStartAdd,
  onCancelAdd,
}: {
  rows: AppetiteRow[];
  role: AtlasUiRole;
  showConfirm?: boolean;
  onChanged: () => void;
  insurerId?: string;
  isAdding?: boolean;
  onStartAdd?: () => void;
  onCancelAdd?: () => void;
}) {
  if (rows.length === 0 && !isAdding) {
    return (
      <div className="atlas-card">
        <p className="atlas-muted">
          {showConfirm
            ? "No proposed rules awaiting review. Upload and process a guideline document to populate this."
            : "No active rules yet. Confirm proposed rules to bring them into the live matrix."}
        </p>
      </div>
    );
  }

  return (
    <div className="atlas-rules">
      {insurerId && canManage(role) && !showConfirm && (
        isAdding ? (
          <AddRuleForm
            insurerId={insurerId}
            onAdded={() => onChanged()}
            onCancel={() => onCancelAdd?.()}
          />
        ) : (
          <div style={{ marginBottom: 12, textAlign: "right" }}>
            <button
              className="atlas-btn atlas-btn--small"
              onClick={() => onStartAdd?.()}
            >
              + Add rule
            </button>
          </div>
        )
      )}
      {rows.map((r) => (
        <RuleCard
          key={r.id}
          row={r}
          role={role}
          showConfirm={showConfirm}
          onChanged={onChanged}
        />
      ))}
    </div>
  );
}

function RuleCard({
  row,
  role,
  showConfirm,
  onChanged,
}: {
  row: AppetiteRow;
  role: AtlasUiRole;
  showConfirm: boolean;
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(row);
  const [working, setWorking] = useState(false);

  async function onSave() {
    setWorking(true);
    try {
      await editAppetite(row.id, {
        product_line: draft.product_line,
        risk_type: draft.risk_type,
        appetite_level: draft.appetite_level,
        preferred_risks: draft.preferred_risks,
        caution_risks: draft.caution_risks,
        declined_risks: draft.declined_risks,
        required_documents: draft.required_documents,
        referral_triggers: draft.referral_triggers,
        notes: draft.notes,
        rating_notes: draft.rating_notes,
        line_of_business: draft.line_of_business,
        source_quote: draft.source_quote,
        source_page: draft.source_page,
        source_section: draft.source_section,
        source_file_name: draft.source_file_name,
        ingestion_confidence: draft.ingestion_confidence,
      });
      setEditing(false);
      onChanged();
    } finally {
      setWorking(false);
    }
  }

  async function onConfirm() {
    setWorking(true);
    try {
      await confirmAppetite(row.id);
      onChanged();
    } finally {
      setWorking(false);
    }
  }

  async function onDeactivate() {
    setWorking(true);
    try {
      await deactivateAppetite(row.id);
      onChanged();
    } finally {
      setWorking(false);
    }
  }

  const setList = (k: keyof AppetiteRow, v: string) =>
    setDraft({ ...draft, [k]: v.split(",").map((x) => x.trim()).filter(Boolean) });

  return (
    <div className={`atlas-card atlas-rule atlas-rule--${row.appetite_level}`}>
      <div className="atlas-rule__head">
        {!editing ? (
          <>
            <div className="atlas-rule__title">
              <span className="atlas-rule__product">{row.product_line}</span>
              <span className="atlas-rule__sep">·</span>
              <span className="atlas-rule__risk">{row.risk_type}</span>
            </div>
            <span className={`atlas-level atlas-level--${row.appetite_level}`}>
              {row.appetite_level}
            </span>
            {row.line_of_business && (
              <span className="atlas-level atlas-level--standard">
                {row.line_of_business}
              </span>
            )}
          </>
        ) : (
          <div className="atlas-rule__edit-head">
            <input
              value={draft.product_line}
              onChange={(e) => setDraft({ ...draft, product_line: e.target.value })}
              placeholder="product_line"
            />
            <input
              value={draft.risk_type}
              onChange={(e) => setDraft({ ...draft, risk_type: e.target.value })}
              placeholder="risk_type"
            />
            <select
              value={draft.appetite_level}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  appetite_level: e.target.value as AppetiteRow["appetite_level"],
                })
              }
            >
              <option value="preferred">preferred</option>
              <option value="standard">standard</option>
              <option value="caution">caution</option>
              <option value="declined">declined</option>
            </select>
          </div>
        )}
      </div>

      <RuleLists row={draft} editing={editing} setList={setList} />

      {!editing ? (
        <>
          {row.notes && <p className="atlas-rule__notes">{row.notes}</p>}
          {row.rating_notes && <p className="atlas-rule__notes">{row.rating_notes}</p>}
          <RuleEvidence row={row} />
        </>
      ) : (
        <>
          <select
            className="atlas-rule__notes-edit"
            value={draft.line_of_business ?? ""}
            onChange={(e) =>
              setDraft({
                ...draft,
                line_of_business: (e.target.value || null) as AppetiteRow["line_of_business"],
              })
            }
          >
            <option value="">line of business</option>
            <option value="personal">personal</option>
            <option value="commercial">commercial</option>
            <option value="both">both</option>
          </select>
          <textarea
            className="atlas-rule__notes-edit"
            rows={2}
            value={draft.notes ?? ""}
            placeholder="notes"
            onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
          />
          <textarea
            className="atlas-rule__notes-edit"
            rows={2}
            value={draft.rating_notes ?? ""}
            placeholder="rating notes"
            onChange={(e) => setDraft({ ...draft, rating_notes: e.target.value })}
          />
          <input
            className="atlas-rule__notes-edit"
            value={draft.source_quote ?? ""}
            placeholder="source quote"
            onChange={(e) => setDraft({ ...draft, source_quote: e.target.value || null })}
          />
          <div className="atlas-rule__edit-head">
            <input
              value={draft.source_file_name ?? ""}
              placeholder="source file"
              onChange={(e) => setDraft({ ...draft, source_file_name: e.target.value || null })}
            />
            <input
              value={draft.source_section ?? ""}
              placeholder="source section"
              onChange={(e) => setDraft({ ...draft, source_section: e.target.value || null })}
            />
            <input
              type="number"
              min="1"
              value={draft.source_page ?? ""}
              placeholder="page"
              onChange={(e) =>
                setDraft({
                  ...draft,
                  source_page: e.target.value ? Number(e.target.value) : null,
                })
              }
            />
          </div>
        </>
      )}

      {canManage(role) && (
        <div className="atlas-rule__actions">
          {!editing ? (
            <>
              <button className="atlas-btn atlas-btn--small" onClick={() => setEditing(true)}>
                Edit
              </button>
              {showConfirm && (
                <button
                  className="atlas-btn atlas-btn--primary atlas-btn--small"
                  onClick={onConfirm}
                  disabled={working}
                >
                  Confirm
                </button>
              )}
              <button
                className="atlas-btn atlas-btn--small atlas-btn--ghost"
                onClick={onDeactivate}
                disabled={working}
              >
                {row.is_active ? "Deactivate" : "Reject"}
              </button>
            </>
          ) : (
            <>
              <button
                className="atlas-btn atlas-btn--small"
                onClick={() => { setEditing(false); setDraft(row); }}
              >
                Cancel
              </button>
              <button
                className="atlas-btn atlas-btn--primary atlas-btn--small"
                onClick={onSave}
                disabled={working}
              >
                {working ? "Saving…" : "Save"}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function RuleEvidence({ row }: { row: AppetiteRow }) {
  const sourceBits = [
    row.source_file_name,
    row.source_section,
    row.source_page ? `page ${row.source_page}` : null,
  ].filter(Boolean);
  const hasEvidence =
    sourceBits.length > 0 || !!row.source_quote || row.ingestion_confidence !== null;

  if (!hasEvidence) {
    return <div className="atlas-rule__evidence atlas-muted">No source evidence stored.</div>;
  }

  return (
    <div className="atlas-rule__evidence">
      {sourceBits.length > 0 && <div>Source: {sourceBits.join(" / ")}</div>}
      {row.source_quote && <blockquote>{row.source_quote}</blockquote>}
      {row.ingestion_confidence !== null && (
        <div>Rule confidence: {Math.round(row.ingestion_confidence * 100)}%</div>
      )}
    </div>
  );
}

function RuleLists({
  row,
  editing,
  setList,
}: {
  row: AppetiteRow;
  editing: boolean;
  setList: (k: keyof AppetiteRow, v: string) => void;
}) {
  const groups: { key: keyof AppetiteRow; label: string; tone: string }[] = [
    { key: "preferred_risks", label: "Preferred", tone: "ok" },
    { key: "caution_risks", label: "Caution", tone: "warn" },
    { key: "declined_risks", label: "Declined", tone: "danger" },
    { key: "referral_triggers", label: "Referral triggers", tone: "warn" },
    { key: "required_documents", label: "Required docs", tone: "neutral" },
  ];
  return (
    <div className="atlas-rule__lists">
      {groups.map((g) => {
        const arr = (row[g.key] as string[]) ?? [];
        if (!editing && arr.length === 0) return null;
        return (
          <div className="atlas-rule__list" key={g.key}>
            <div className={`atlas-rule__list-label atlas-tone--${g.tone}`}>
              {g.label}
            </div>
            {!editing ? (
              <ul>
                {arr.map((x, i) => (
                  <li key={i}>{x}</li>
                ))}
              </ul>
            ) : (
              <input
                value={arr.join(", ")}
                placeholder="comma, separated, list"
                onChange={(e) => setList(g.key, e.target.value)}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
