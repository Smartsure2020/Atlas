/**
 * Atlas — insurer detail
 * ----------------------------------------------------------------------------
 * Three concerns, tab-organised and URL-independent (this is a nested view of
 * one record, not a route in its own right):
 *   1. Guidelines — upload a document, watch Atlas read it, retry on failure.
 *   2. Proposed   — the rules Atlas extracted, awaiting a human decision.
 *   3. Active     — the live matrix the recommendation engine reads.
 *
 * Every mutating action is manager-only server-side. The UI hides those controls
 * for other roles so nobody is shown a button that will fail, but the server
 * remains the authoritative gate.
 *
 * The important framing: a proposed rule is a machine reading of a PDF. It does
 * not affect a single recommendation until a person confirms it. The screen says
 * so, because the previous version made "Confirm" look like a formality.
 */

import { useEffect, useMemo, useState } from "react";
import {
  confirmAppetite,
  deactivateAppetite,
  editAppetite,
  getInsurer,
  updateInsurer,
  type AppetiteRow,
  type InsurerDocument,
  type InsurerListItem,
} from "../lib/insurers";
import { AddRuleForm } from "./AddRuleForm";
import { DocumentsPanel } from "./DocumentsPanel";
import {
  Button,
  Card,
  CardSkeleton,
  ConfirmDialog,
  Disclosure,
  Drawer,
  EmptyState,
  ErrorState,
  Notice,
  PageHeader,
  SelectField,
  SourceReference,
  StatusBadge,
  TabPanel,
  Tabs,
  TextAreaField,
  TextField,
  useToast,
} from "../components/ui";
import { canManage as roleCanManage, type AtlasUiRole } from "../components/AppShell";
import { APPETITE_LEVEL_OPTIONS, appetiteBand } from "../lib/status";
import { formatDateTime, humanise, pluralise } from "../lib/format";

type Tab = "guidelines" | "proposed" | "active";

const LINE_OPTIONS = [
  { value: "", label: "Not specified" },
  { value: "personal", label: "Personal lines" },
  { value: "commercial", label: "Commercial lines" },
  { value: "both", label: "Both lines" },
];

export default function InsurerDetail({
  insurerId,
  role,
  onBack,
}: {
  insurerId: string;
  role: AtlasUiRole;
  onBack: () => void;
}) {
  const canManage = roleCanManage(role);
  const toast = useToast();
  const [loading, setLoading] = useState(true);
  const [insurer, setInsurer] = useState<InsurerListItem | null>(null);
  const [documents, setDocuments] = useState<InsurerDocument[]>([]);
  const [appetite, setAppetite] = useState<AppetiteRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("guidelines");
  const [renameOpen, setRenameOpen] = useState(false);
  const [addingRule, setAddingRule] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const result = await getInsurer(insurerId);
      setInsurer(result.insurer);
      setDocuments(result.documents);
      setAppetite(result.appetite);
      setError(null);
    } catch (cause) {
      setError(
        (cause as Error).message === "manager_only"
          ? "Insurer guidelines and appetite rules are available to underwriting managers only."
          : "This insurer could not be loaded. It may have been removed, or the Atlas API did not respond."
      );
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [insurerId]);

  const proposed = useMemo(() => appetite.filter((row) => !row.is_active), [appetite]);
  const active = useMemo(() => appetite.filter((row) => row.is_active), [appetite]);

  // Land the manager where the work is: unreviewed proposals first.
  useEffect(() => {
    if (loading) return;
    if (proposed.length > 0) setTab("proposed");
    else if (active.length > 0) setTab("active");
    else setTab("guidelines");
    // Only on first load of a given insurer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, insurerId]);

  if (loading && !insurer) {
    return (
      <div className="atlas-stack">
        <CardSkeleton lines={2} />
        <CardSkeleton lines={4} />
      </div>
    );
  }

  if (error) {
    return (
      <div className="atlas-stack">
        <PageHeader
          breadcrumbs={[{ label: "Insurers", onClick: onBack }, { label: "Insurer" }]}
          title="Insurer"
        />
        <ErrorState title="This insurer could not be opened" message={error} onRetry={() => void load()} />
      </div>
    );
  }

  if (!insurer) return null;

  return (
    <div>
      <PageHeader
        breadcrumbs={[{ label: "Insurers", onClick: onBack }, { label: insurer.name }]}
        eyebrow="Intelligence"
        title={insurer.name}
        description={
          active.length > 0
            ? `Atlas scores this insurer against ${pluralise(active.length, "active rule")}.`
            : "Atlas cannot recommend this insurer yet — no appetite rule has been confirmed."
        }
        badges={
          active.length > 0 ? (
            <StatusBadge
              status={{
                label: pluralise(active.length, "active rule"),
                tone: "success",
                description: "These rules are read on every recommendation.",
              }}
            />
          ) : (
            <StatusBadge
              status={{
                label: "Not in the matrix",
                tone: "warning",
                description: "Confirm at least one rule to bring this insurer into recommendations.",
              }}
            />
          )
        }
        actions={
          canManage ? (
            <Button icon="edit" onClick={() => setRenameOpen(true)}>
              Edit insurer
            </Button>
          ) : undefined
        }
      />

      {actionError && (
        <div style={{ marginBottom: "var(--atlas-space-4)" }}>
          <Notice
            tone="danger"
            title="That change did not save"
            actions={
              <Button size="sm" onClick={() => setActionError(null)}>
                Dismiss
              </Button>
            }
          >
            {actionError}
          </Notice>
        </div>
      )}

      {proposed.length > 0 && (
        <div style={{ marginBottom: "var(--atlas-space-4)" }}>
          <Notice tone="warning" title={`${pluralise(proposed.length, "rule")} awaiting review`}>
            Atlas read these out of a guideline document. They do not affect any recommendation until a
            manager confirms them, so nothing is scored against an unverified reading of a PDF.
          </Notice>
        </div>
      )}

      <div style={{ marginBottom: "var(--atlas-space-4)" }}>
        <Tabs
          label="Insurer sections"
          active={tab}
          onChange={(id) => setTab(id as Tab)}
          tabs={[
            { id: "guidelines", label: "Guidelines", count: documents.length },
            {
              id: "proposed",
              label: "Awaiting review",
              count: proposed.length,
              attention: proposed.length > 0,
            },
            { id: "active", label: "Active matrix", count: active.length },
          ]}
        />
      </div>

      <TabPanel id="guidelines" active={tab}>
        <DocumentsPanel
          insurerId={insurerId}
          canManage={canManage}
          documents={documents}
          onChanged={load}
        />
      </TabPanel>

      <TabPanel id="proposed" active={tab}>
        <RuleList
          rows={proposed}
          canManage={canManage}
          mode="proposed"
          onChanged={load}
          onError={setActionError}
          emptyTitle="No rules are awaiting review"
          emptyBody="Upload a guideline on the guidelines tab. Atlas reads it and proposes appetite rules here for you to confirm or reject."
        />
      </TabPanel>

      <TabPanel id="active" active={tab}>
        <div className="atlas-stack">
          {canManage && (
            <div className="atlas-actions atlas-actions--end">
              {addingRule ? null : (
                <Button icon="plus" onClick={() => setAddingRule(true)}>
                  Add rule manually
                </Button>
              )}
            </div>
          )}

          {addingRule && (
            <AddRuleForm
              insurerId={insurerId}
              onAdded={() => {
                setAddingRule(false);
                void load();
                toast.notify("Rule added to the active matrix.", "success");
              }}
              onCancel={() => setAddingRule(false)}
            />
          )}

          <RuleList
            rows={active}
            canManage={canManage}
            mode="active"
            onChanged={load}
            onError={setActionError}
            emptyTitle="The active matrix is empty"
            emptyBody="Atlas skips this insurer on every recommendation until at least one rule is active. Confirm a proposed rule, or add one manually."
          />
        </div>
      </TabPanel>

      <EditInsurerDrawer
        open={renameOpen}
        insurer={insurer}
        onClose={() => setRenameOpen(false)}
        onSaved={async () => {
          setRenameOpen(false);
          await load();
          toast.notify("Insurer updated.", "success");
        }}
      />
    </div>
  );
}

/* ===========================================================================
   Rule list
   =========================================================================== */

function RuleList({
  rows,
  canManage,
  mode,
  onChanged,
  onError,
  emptyTitle,
  emptyBody,
}: {
  rows: AppetiteRow[];
  canManage: boolean;
  mode: "proposed" | "active";
  onChanged: () => void;
  onError: (message: string) => void;
  emptyTitle: string;
  emptyBody: string;
}) {
  const [editing, setEditing] = useState<AppetiteRow | null>(null);

  if (rows.length === 0) {
    return (
      <Card>
        <EmptyState title={emptyTitle} body={emptyBody} />
      </Card>
    );
  }

  return (
    <>
      <div className="atlas-stack atlas-stack--tight">
        {rows.map((row) => (
          <RuleCard
            key={row.id}
            row={row}
            canManage={canManage}
            mode={mode}
            onChanged={onChanged}
            onError={onError}
            onEdit={() => setEditing(row)}
          />
        ))}
      </div>

      <EditRuleDrawer
        row={editing}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          onChanged();
        }}
        onError={onError}
      />
    </>
  );
}

const RULE_LISTS: { key: keyof AppetiteRow; label: string; tone: "ok" | "warn" | "danger" | "neutral" }[] = [
  { key: "preferred_risks", label: "Preferred", tone: "ok" },
  { key: "caution_risks", label: "Caution", tone: "warn" },
  { key: "declined_risks", label: "Declined", tone: "danger" },
  { key: "referral_triggers", label: "Referral triggers", tone: "warn" },
  { key: "required_documents", label: "Required documents", tone: "neutral" },
];

function RuleCard({
  row,
  canManage,
  mode,
  onChanged,
  onError,
  onEdit,
}: {
  row: AppetiteRow;
  canManage: boolean;
  mode: "proposed" | "active";
  onChanged: () => void;
  onError: (message: string) => void;
  onEdit: () => void;
}) {
  const toast = useToast();
  const [working, setWorking] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);

  const isPortfolio = row.product_line === "*" && row.risk_type === "*";

  async function onConfirm() {
    setWorking(true);
    try {
      await confirmAppetite(row.id);
      onChanged();
      toast.notify("Rule confirmed and now active in the matrix.", "success");
    } catch {
      onError("The rule could not be confirmed. Try again.");
    } finally {
      setWorking(false);
    }
  }

  async function onRemove() {
    setWorking(true);
    setConfirmRemove(false);
    try {
      await deactivateAppetite(row.id);
      onChanged();
      toast.notify(
        mode === "active" ? "Rule removed from the active matrix." : "Proposed rule rejected.",
        "success"
      );
    } catch {
      onError(
        mode === "active"
          ? "The rule could not be deactivated. Try again."
          : "The proposed rule could not be rejected. Try again."
      );
    } finally {
      setWorking(false);
    }
  }

  const lists = RULE_LISTS.map((group) => ({
    ...group,
    items: (row[group.key] as string[] | null) ?? [],
  })).filter((group) => group.items.length > 0);

  return (
    <article className={`atlas-rule atlas-rule--${row.appetite_level}`}>
      <header className="atlas-rule__head">
        <div style={{ minWidth: 0 }}>
          <h3 className="atlas-rule__title">
            {isPortfolio ? "Portfolio-wide rule" : humanise(row.product_line, "Product not specified")}
          </h3>
          <p className="atlas-rule__subtitle">
            {isPortfolio
              ? "Applies to every product and risk type unless a more specific rule matches."
              : humanise(row.risk_type, "Risk type not specified")}
            {row.line_of_business ? ` · ${humanise(row.line_of_business)} lines` : ""}
            {row.source === "manual" ? " · added manually" : " · read from a guideline"}
          </p>
        </div>
        <div className="atlas-actions">
          <StatusBadge status={appetiteBand(row.appetite_level)} strong />
          {mode === "proposed" && (
            <StatusBadge
              status={{
                label: "Not yet active",
                tone: "warning",
                description: "This rule is not used in any recommendation until it is confirmed.",
              }}
            />
          )}
        </div>
      </header>

      <div className="atlas-rule__body">
        {lists.length > 0 ? (
          <div className="atlas-rule__lists">
            {lists.map((group) => (
              <div className="atlas-rule__list" key={String(group.key)}>
                <p className={`atlas-rule__list-label atlas-rule__list-label--${group.tone}`}>
                  {group.label}
                </p>
                <ul>
                  {group.items.map((item, index) => (
                    <li key={index}>{item}</li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        ) : (
          <p className="atlas-text-dense atlas-text-muted">
            This rule sets an appetite level but lists no specific risks, triggers or documents.
          </p>
        )}

        {row.notes && <p className="atlas-rule__notes">{row.notes}</p>}
        {row.rating_notes && <p className="atlas-rule__notes">Rating: {row.rating_notes}</p>}

        <div style={{ marginTop: "var(--atlas-space-3)" }}>
          <Disclosure summary="Where this rule came from">
            {row.source_file_name || row.source_quote || row.source_section ? (
              <SourceReference
                parts={[
                  row.source_file_name,
                  row.source_section,
                  row.source_page ? `page ${row.source_page}` : null,
                ]}
                quote={row.source_quote}
                note={
                  row.ingestion_confidence !== null
                    ? `Atlas read this with ${
                        row.ingestion_confidence >= 0.85
                          ? "high"
                          : row.ingestion_confidence > 0.5
                          ? "moderate"
                          : "low"
                      } confidence.`
                    : null
                }
              />
            ) : (
              <p className="atlas-text-dense atlas-text-muted">
                No source evidence is stored for this rule
                {row.source === "manual" ? " — it was added by hand." : "."}
              </p>
            )}
            {row.confirmed_at && (
              <p className="atlas-text-muted" style={{ fontSize: 12, marginTop: 8 }}>
                Confirmed {formatDateTime(row.confirmed_at)}
                {row.confirmed_by ? ` by ${row.confirmed_by}` : ""}.
              </p>
            )}
          </Disclosure>
        </div>
      </div>

      {canManage && (
        <div className="atlas-rule__actions">
          <Button size="sm" icon="edit" onClick={onEdit} disabled={working}>
            Edit rule
          </Button>
          {mode === "proposed" && (
            <Button size="sm" variant="primary" onClick={onConfirm} loading={working} loadingLabel="Confirming…">
              Confirm and activate
            </Button>
          )}
          <Button
            size="sm"
            variant={mode === "active" ? "danger" : "secondary"}
            onClick={() => setConfirmRemove(true)}
            disabled={working}
          >
            {mode === "active" ? "Deactivate" : "Reject"}
          </Button>
        </div>
      )}

      <ConfirmDialog
        open={confirmRemove}
        destructive={mode === "active"}
        title={
          mode === "active"
            ? "Remove this rule from the active matrix?"
            : "Reject this proposed rule?"
        }
        confirmLabel={mode === "active" ? "Deactivate rule" : "Reject rule"}
        working={working}
        onCancel={() => setConfirmRemove(false)}
        onConfirm={onRemove}
        body={
          mode === "active" ? (
            <p>
              Atlas will stop scoring this insurer against this rule from the next recommendation
              onwards. Recommendations already on file are not changed — rerun a submission to reflect
              the new matrix.
            </p>
          ) : (
            <p>
              The proposed rule is discarded and will not appear again unless the guideline is
              reprocessed. Nothing that Atlas has already recommended is affected.
            </p>
          )
        }
      />
    </article>
  );
}

/* ===========================================================================
   Drawers
   =========================================================================== */

function EditRuleDrawer({
  row,
  onClose,
  onSaved,
  onError,
}: {
  row: AppetiteRow | null;
  onClose: () => void;
  onSaved: () => void;
  onError: (message: string) => void;
}) {
  // Remounting on a new row is deliberate: it resets the draft without an
  // effect, and keeps the body free of null checks.
  if (!row) return null;
  return <EditRuleDrawerBody key={row.id} row={row} onClose={onClose} onSaved={onSaved} onError={onError} />;
}

function EditRuleDrawerBody({
  row,
  onClose,
  onSaved,
  onError,
}: {
  row: AppetiteRow;
  onClose: () => void;
  onSaved: () => void;
  onError: (message: string) => void;
}) {
  const [draft, setDraft] = useState<AppetiteRow>(row);
  const [saving, setSaving] = useState(false);

  const setList = (key: keyof AppetiteRow, value: string) =>
    setDraft({
      ...draft,
      [key]: value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
    });

  async function save() {
    setSaving(true);
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
      onSaved();
    } catch {
      onError("The rule could not be saved. Check the values and try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Drawer
      open
      title="Edit appetite rule"
      description="Corrections here change what every future recommendation is scored against."
      onClose={onClose}
      size="lg"
      dirty={JSON.stringify(draft) !== JSON.stringify(row) && !saving}
      footer={
        <>
          <Button onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button variant="primary" onClick={save} loading={saving} loadingLabel="Saving…">
            Save rule
          </Button>
        </>
      }
    >
      <div className="atlas-form">
        <div className="atlas-form__grid">
          <TextField
            label="Product line"
            required
            value={draft.product_line}
            hint="Use * for a rule that applies across the whole portfolio."
            onChange={(event) => setDraft({ ...draft, product_line: event.target.value })}
          />
          <TextField
            label="Risk type"
            required
            value={draft.risk_type}
            onChange={(event) => setDraft({ ...draft, risk_type: event.target.value })}
          />
        </div>

        <div className="atlas-form__grid">
          <SelectField
            label="Appetite level"
            required
            value={draft.appetite_level}
            options={APPETITE_LEVEL_OPTIONS}
            hint="Declined means Atlas rules this insurer out for matching risks."
            onChange={(event) =>
              setDraft({ ...draft, appetite_level: event.target.value as AppetiteRow["appetite_level"] })
            }
          />
          <SelectField
            label="Line of business"
            value={draft.line_of_business ?? ""}
            options={LINE_OPTIONS}
            onChange={(event) =>
              setDraft({
                ...draft,
                line_of_business: (event.target.value || null) as AppetiteRow["line_of_business"],
              })
            }
          />
        </div>

        {RULE_LISTS.map((group) => (
          <TextField
            key={String(group.key)}
            label={group.label}
            optional
            value={((draft[group.key] as string[] | null) ?? []).join(", ")}
            placeholder="Comma-separated list"
            hint={
              group.key === "declined_risks"
                ? "A match here rules the insurer out entirely for that risk."
                : group.key === "referral_triggers"
                ? "A match here requires insurer or senior approval before proceeding."
                : undefined
            }
            onChange={(event) => setList(group.key, event.target.value)}
          />
        ))}

        <TextAreaField
          label="Notes"
          optional
          rows={3}
          value={draft.notes ?? ""}
          onChange={(event) => setDraft({ ...draft, notes: event.target.value })}
        />
        <TextAreaField
          label="Rating notes"
          optional
          rows={2}
          value={draft.rating_notes ?? ""}
          onChange={(event) => setDraft({ ...draft, rating_notes: event.target.value })}
        />

        <div className="atlas-form__section">
          <p className="atlas-block__title" style={{ marginBottom: 12 }}>
            Source evidence
          </p>
          <div className="atlas-form">
            <TextAreaField
              label="Quote from the guideline"
              optional
              rows={3}
              value={draft.source_quote ?? ""}
              hint="Shown to underwriters as the evidence behind this rule."
              onChange={(event) => setDraft({ ...draft, source_quote: event.target.value || null })}
            />
            <div className="atlas-form__grid">
              <TextField
                label="Source document"
                optional
                value={draft.source_file_name ?? ""}
                onChange={(event) => setDraft({ ...draft, source_file_name: event.target.value || null })}
              />
              <TextField
                label="Section"
                optional
                value={draft.source_section ?? ""}
                onChange={(event) => setDraft({ ...draft, source_section: event.target.value || null })}
              />
              <TextField
                label="Page"
                optional
                type="number"
                min={1}
                value={draft.source_page ?? ""}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    source_page: event.target.value ? Number(event.target.value) : null,
                  })
                }
              />
            </div>
          </div>
        </div>
      </div>
    </Drawer>
  );
}

function EditInsurerDrawer({
  open,
  insurer,
  onClose,
  onSaved,
}: {
  open: boolean;
  insurer: InsurerListItem;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(insurer.name);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName(insurer.name);
    setError(null);
  }, [open, insurer.name]);

  async function save() {
    if (!name.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await updateInsurer(insurer.id, { name: name.trim() });
      onSaved();
    } catch {
      setError("The insurer could not be renamed. Check the name is not already in use.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Drawer
      open={open}
      title="Edit insurer"
      onClose={onClose}
      size="sm"
      dirty={name !== insurer.name && !saving}
      footer={
        <>
          <Button onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button variant="primary" onClick={save} loading={saving} loadingLabel="Saving…">
            Save changes
          </Button>
        </>
      }
    >
      <div className="atlas-form">
        {error && <Notice tone="danger">{error}</Notice>}
        <TextField
          label="Insurer name"
          required
          value={name}
          error={!name.trim() ? "The insurer needs a name." : null}
          onChange={(event) => setName(event.target.value)}
        />
      </div>
    </Drawer>
  );
}
