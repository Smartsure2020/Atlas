/**
 * Atlas — missing information workbench
 * ----------------------------------------------------------------------------
 * The operational path from "we know something is missing" through to
 * "somebody has been asked and we are waiting on them". The lifecycle groups
 * stay in job order (outstanding → requested → received → closed), each item
 * shows the metadata a person needs to act (owner, due date, source, notes),
 * and the summary line at the top names the next operational job in words —
 * derived from the items on file, never from an invented priority or SLA.
 *
 * The tab tracks the requirement. Drafting the outward-facing message and
 * recording that it went happens on the Communications tab; a cross-tab
 * pointer here makes that relationship explicit without merging the two.
 */

import { useEffect, useMemo, useState } from "react";
import {
  addMissingInfo,
  generateMissingInfo,
  updateMissingInfo,
  type MissingInfoItem,
  type MissingInfoOwner,
  type MissingInfoStatus,
} from "../lib/phase4";
import {
  Button,
  Card,
  Disclosure,
  Drawer,
  EmptyState,
  MetaTag,
  Notice,
  PromptDialog,
  SelectField,
  StatusBadge,
  TextAreaField,
  TextField,
  useToast,
} from "../components/ui";
import {
  completenessView,
  contradictionsView,
  resolveEvidence,
  trackedStateFor,
  type CompletenessLine,
  type EvidenceView,
} from "../lib/recommendation-evidence";
import { Icon } from "../components/Icon";
import {
  MISSING_INFO_OWNER_OPTIONS,
  MISSING_INFO_STATUS_OPTIONS,
  missingInfoStatus,
} from "../lib/status";
import { formatDate, humanise } from "../lib/format";
import type { SubmissionTab } from "../lib/router";
import {
  groupMissingInfo,
  isOverdue,
  NOTE_REQUIRED_STATUSES,
  summariseMissingInfo,
} from "../lib/workflow";

const NOTE_REQUIRED: readonly MissingInfoStatus[] = NOTE_REQUIRED_STATUSES;

const ITEM_TYPE_OPTIONS = [
  { value: "document", label: "Document" },
  { value: "quote_term", label: "Quote term" },
  { value: "underwriting_info", label: "Underwriting information" },
  { value: "referral_info", label: "Referral information" },
  { value: "other", label: "Other" },
];

export default function MissingInfoPanel({
  submissionId,
  items,
  quoteReviewId,
  canWrite,
  onRefresh,
  onGoToTab,
  recommendationEvidence,
}: {
  submissionId: string;
  items: MissingInfoItem[];
  quoteReviewId: string | null;
  canWrite: boolean;
  onRefresh: () => Promise<void> | void;
  onGoToTab: (tab: SubmissionTab) => void;
  /**
   * The latest recommendation's persisted `evidence_json`, exactly as stored.
   * Passed only to staff who may see underwriting intelligence; omitted for
   * brokers, who then see exactly the workspace they always did.
   */
  recommendationEvidence?: unknown;
}) {
  const evidence = useMemo<EvidenceView | null>(
    () => (recommendationEvidence === undefined ? null : resolveEvidence(recommendationEvidence)),
    [recommendationEvidence]
  );
  const toast = useToast();
  const [error, setError] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState<MissingInfoItem | null>(null);
  const [notePrompt, setNotePrompt] = useState<{
    item: MissingInfoItem;
    status: MissingInfoStatus;
  } | null>(null);
  const [working, setWorking] = useState<string | null>(null);

  // Day-level overdue derivation: a single `now` per render keeps the summary
  // and each row consistent within one paint. The previous shape
  // `useMemo(() => new Date(), [items])` was misleading — the callback never
  // reads `items`, so the memo neither invalidates when items change nor
  // computes anything the const wouldn't. A per-render Date is trivial and
  // the derived summary is a small O(items) reduction.
  const now = new Date();
  const summary = summariseMissingInfo(items, now);
  const groups = useMemo(() => groupMissingInfo(items), [items]);
  const blocking = summary.outstanding + summary.awaiting_reply;

  async function changeStatus(item: MissingInfoItem, status: MissingInfoStatus, notes?: string) {
    setWorking(item.id);
    setError(null);
    try {
      await updateMissingInfo(item.id, { status, notes: notes ?? item.notes });
      await onRefresh();
      toast.notify(`Marked "${item.title}" as ${missingInfoStatus(status).label.toLowerCase()}.`, "success");
    } catch (cause) {
      setError(
        (cause as Error).message === "notes_required"
          ? "A note is required when waiving an item or marking it not required."
          : "That item could not be updated. Try again."
      );
    } finally {
      setWorking(null);
      setNotePrompt(null);
    }
  }

  async function onGenerate() {
    setGenerating(true);
    setError(null);
    try {
      const result = await generateMissingInfo(submissionId);
      await onRefresh();
      toast.notify(
        result.generated_count > 0
          ? `Added ${result.generated_count} item${result.generated_count === 1 ? "" : "s"} from the analysis.`
          : "No new gaps were found beyond the items already tracked.",
        "success"
      );
    } catch {
      setError(
        "Atlas could not derive missing-information items. Run the extraction and quote review first, then try again."
      );
    } finally {
      setGenerating(false);
    }
  }

  return (
    <div className="atlas-stack">
      {error && <Notice tone="danger" title="That action did not complete">{error}</Notice>}

      {blocking > 0 && (
        <Notice tone="warning" title={`${blocking} item${blocking === 1 ? "" : "s"} still outstanding`}>
          Outstanding information can change the recommendation. Rerun the analysis once it arrives.
          <div style={{ marginTop: 8 }}>
            <Button size="sm" onClick={() => onGoToTab("recommendation")}>
              Open the recommendation
            </Button>
          </div>
        </Notice>
      )}

      {items.length > 0 && (
        <ActionSummary
          summary={summary}
          canWrite={canWrite}
          onGoToTab={onGoToTab}
        />
      )}

      {evidence && evidence.kind === "ready" && (
        <DetectedByAtlas
          evidence={evidence}
          items={items}
          canWrite={canWrite}
          submissionId={submissionId}
          quoteReviewId={quoteReviewId}
          onRefresh={onRefresh}
          onGoToTab={onGoToTab}
        />
      )}

      <Card
        title="Missing information"
        description="What Atlas still needs, why it needs it, and who owes it. Draft the request itself on the Communications tab."
        actions={
          canWrite ? (
            // While there are no items on file, "Derive from analysis"
            // is the primary — write-by-hand should not be the visual
            // default before Atlas has been asked to derive anything.
            // Once there is at least one item, "Add item" resumes its
            // usual primary role because the reader is now curating an
            // existing list rather than starting from empty.
            items.length === 0 ? (
              <>
                <Button
                  size="sm"
                  variant="primary"
                  icon="refresh"
                  loading={generating}
                  loadingLabel="Deriving…"
                  onClick={onGenerate}
                  title="Derive items from the extraction and quote review findings."
                >
                  Derive from analysis
                </Button>
                <Button size="sm" icon="plus" onClick={() => setAddOpen(true)}>
                  Add item
                </Button>
              </>
            ) : (
              <>
                <Button
                  size="sm"
                  icon="refresh"
                  loading={generating}
                  loadingLabel="Deriving…"
                  onClick={onGenerate}
                  title="Derive items from the extraction and quote review findings."
                >
                  Derive from analysis
                </Button>
                <Button size="sm" variant="primary" icon="plus" onClick={() => setAddOpen(true)}>
                  Add item
                </Button>
              </>
            )
          ) : undefined
        }
        flush={items.length > 0}
      >
        {items.length === 0 ? (
          // Empty state stays as a pure explainer — the header action
          // group already carries the primary "Derive from analysis"
          // affordance, so a duplicate button inside the card would
          // just be repetition.
          <EmptyState
            inline
            title="Nothing is outstanding"
            body="Atlas has not identified any gaps, and nobody has added one manually. Use “Derive from analysis” above once the extraction and quote review have run."
          />
        ) : (
          <div style={{ padding: "var(--atlas-space-5)" }}>
            {groups.map((group) => (
              <section
                key={group.key}
                style={{ marginBottom: "var(--atlas-space-6)" }}
                aria-labelledby={`missing-group-${group.key}`}
              >
                <h3
                  id={`missing-group-${group.key}`}
                  className="atlas-title-sub"
                  style={{ fontSize: "var(--atlas-fs-body)" }}
                >
                  {group.title}
                  <span
                    className="atlas-text-muted"
                    style={{ fontWeight: 400, marginLeft: 8 }}
                  >
                    ({group.items.length})
                  </span>
                </h3>
                <p className="atlas-text-dense atlas-text-muted" style={{ margin: "2px 0 12px" }}>
                  {group.body}
                </p>
                <ul className="atlas-list atlas-list--stack-sm">
                  {group.items.map((item) => {
                    const overdue = isOverdue(item, now);
                    return (
                      <li className="atlas-list__item" key={item.id}>
                        <div className="atlas-list__main">
                          <p className="atlas-list__title">{item.title}</p>
                          {item.description && <p className="atlas-list__meta">{item.description}</p>}
                          <p className="atlas-list__meta">
                            {[
                              item.section_key ? `Section: ${humanise(item.section_key)}` : null,
                              `Type: ${humanise(item.item_type)}`,
                              `Owed by: ${humanise(item.owner)}`,
                              item.due_date ? `Due ${formatDate(item.due_date)}` : null,
                              `Source: ${humanise(item.source)}`,
                            ]
                              .filter(Boolean)
                              .join(" · ")}
                          </p>
                          {item.notes && (
                            <p className="atlas-list__meta">
                              <Icon name="info" size={12} /> {item.notes}
                            </p>
                          )}
                        </div>
                        <div className="atlas-list__side">
                          <StatusBadge status={missingInfoStatus(item.status)} />
                          {overdue && (
                            <StatusBadge
                              status={{
                                label: "Overdue",
                                tone: "danger",
                                description: "The recorded due date has passed.",
                              }}
                            />
                          )}
                          {canWrite && (
                            <>
                              {item.status === "open" && (
                                <Button
                                  size="sm"
                                  disabled={working === item.id}
                                  onClick={() => changeStatus(item, "requested")}
                                >
                                  Mark requested
                                </Button>
                              )}
                              {item.status === "requested" && (
                                <Button
                                  size="sm"
                                  disabled={working === item.id}
                                  onClick={() => changeStatus(item, "received")}
                                >
                                  Mark received
                                </Button>
                              )}
                              <Button size="sm" icon="edit" onClick={() => setEditing(item)}>
                                Edit
                              </Button>
                            </>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))}
          </div>
        )}
      </Card>

      <AddItemDrawer
        open={addOpen}
        submissionId={submissionId}
        quoteReviewId={quoteReviewId}
        onClose={() => setAddOpen(false)}
        onAdded={async () => {
          setAddOpen(false);
          await onRefresh();
          toast.notify("Item added.", "success");
        }}
      />

      <EditItemDrawer
        item={editing}
        working={working !== null}
        onClose={() => setEditing(null)}
        onStatusChange={(item, status) => {
          if (NOTE_REQUIRED.includes(status)) {
            setEditing(null);
            setNotePrompt({ item, status });
            return;
          }
          setEditing(null);
          void changeStatus(item, status);
        }}
        onSave={async (item, patch) => {
          setWorking(item.id);
          try {
            await updateMissingInfo(item.id, patch);
            setEditing(null);
            await onRefresh();
            toast.notify("Item updated.", "success");
          } catch {
            setError("That item could not be updated. Try again.");
          } finally {
            setWorking(null);
          }
        }}
      />

      <PromptDialog
        open={notePrompt !== null}
        title={
          notePrompt?.status === "waived"
            ? "Waive this information request?"
            : "Mark this information as not required?"
        }
        body={
          notePrompt
            ? `"${notePrompt.item.title}" will be closed without being supplied. The note below is kept in the audit history.`
            : undefined
        }
        label="Why is this no longer needed?"
        confirmLabel={notePrompt?.status === "waived" ? "Waive item" : "Mark not required"}
        working={working !== null}
        onCancel={() => setNotePrompt(null)}
        onConfirm={(note) => {
          if (notePrompt) void changeStatus(notePrompt.item, notePrompt.status, note);
        }}
      />
    </div>
  );
}

/* ===========================================================================
   What Atlas detected (evidence v3 completeness)
   ---------------------------------------------------------------------------
   Detection lives in the recommendation's evidence; THIS tab remains the one
   place a person acts on it. Nothing is duplicated into a second workflow: a
   detected item is matched against the items already tracked (documents by the
   matcher's canonical document key, others by type + deterministic title), and
   "Track" creates an ordinary item through the existing endpoint.
   =========================================================================== */

export const DETECTED_HEADING = "What Atlas detected";

function DetectedByAtlas({
  evidence,
  items,
  canWrite,
  submissionId,
  quoteReviewId,
  onRefresh,
  onGoToTab,
}: {
  evidence: EvidenceView;
  items: MissingInfoItem[];
  canWrite: boolean;
  submissionId: string;
  quoteReviewId: string | null;
  onRefresh: () => Promise<void> | void;
  onGoToTab: (tab: SubmissionTab) => void;
}) {
  const toast = useToast();
  const completeness = completenessView(evidence);
  const conflicts = contradictionsView(evidence);
  const [working, setWorking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!completeness) return null;

  async function track(line: CompletenessLine) {
    setWorking(line.itemId);
    setError(null);
    try {
      await addMissingInfo(submissionId, {
        quote_review_id: quoteReviewId,
        section_key: line.tracking.sectionKey,
        item_type: line.tracking.type,
        title: line.tracking.title,
        description: line.tracking.description,
        owner: line.tracking.owner,
      });
      await onRefresh();
      toast.notify(`Tracking "${line.tracking.title}".`, "success");
    } catch {
      setError("That item could not be tracked. Try again.");
    } finally {
      setWorking(null);
    }
  }

  const all =
    completeness.mode === "captured"
      ? [...completeness.caseLines, ...completeness.documentLines, ...completeness.insurerGroups.flatMap((group) => group.lines)]
      : [];
  const trackable = all.filter((line) => line.tracking.trackable);
  const limitations = all.filter((line) => !line.tracking.trackable);
  const conflictCount = conflicts && conflicts.mode === "captured" ? conflicts.conflicts.length : 0;

  return (
    <Card
      title={DETECTED_HEADING}
      description="From the latest recommendation's evidence. Track an item to follow it up here. Atlas never sends anything itself."
    >
      <div className="atlas-stack">
        {error && <Notice tone="danger" title="That action did not complete">{error}</Notice>}
        {completeness.mode === "not_captured" ? (
          <Notice tone="info" title="Not captured for this recommendation">
            {completeness.message} Run the recommendation again to see what Atlas detects. Atlas does not rebuild it from current data.
          </Notice>
        ) : (
          <>
            <p className="atlas-text-dense">
              <strong>{completeness.stateMeta.label}.</strong> {completeness.stateMeta.meaning}
            </p>
            {trackable.length > 0 && (
              <ul className="atlas-list atlas-list--stack-sm" aria-label="Detected items you can track">
                {trackable.map((line) => {
                  const tracked = trackedStateFor(line, items);
                  return (
                    <li className="atlas-list__item" key={line.itemId} data-detected-item={line.itemId}>
                      <div className="atlas-list__main">
                        <p className="atlas-list__title">{line.tracking.title}</p>
                        <p className="atlas-list__meta">
                          {line.copy.title}
                          {line.insurers.length > 0 && <> · Insurers: {line.insurers.map((i) => i.insurerName).join(", ")}</>}
                          {" · "}
                          {line.materialityMeta.label}
                        </p>
                      </div>
                      <div className="atlas-list__side">
                        {tracked.state === "untracked" ? (
                          canWrite ? (
                            <Button size="sm" icon="plus" disabled={working === line.itemId} onClick={() => track(line)}>
                              Track this
                            </Button>
                          ) : (
                            <StatusBadge status={{ label: "Not tracked", tone: "neutral" }} quiet />
                          )
                        ) : tracked.state === "tracked_open" ? (
                          <StatusBadge status={missingInfoStatus(tracked.status as MissingInfoStatus)} />
                        ) : (
                          <StatusBadge
                            status={{
                              label: `Closed — ${missingInfoStatus(tracked.status as MissingInfoStatus).label.toLowerCase()}`,
                              tone: "success",
                            }}
                          />
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
            {limitations.length > 0 && (
              <Disclosure summary={`Atlas limitations — nothing to chase (${limitations.length})`}>
                <p className="atlas-text-dense atlas-text-muted">
                  These describe what Atlas could not evaluate. No broker can supply them, so they are not tracked here.
                </p>
                <ul className="atlas-list">
                  {limitations.map((line) => (
                    <li className="atlas-list__item" key={line.itemId}>
                      <div className="atlas-list__main">
                        <p className="atlas-list__title">{line.copy.title}</p>
                        <p className="atlas-list__meta">
                          {line.insurers.length > 0 && <>Insurers: {line.insurers.map((i) => i.insurerName).join(", ")}. </>}
                          {line.sections.length > 0 && <>Sections: {line.sections.join(", ")}.</>}
                        </p>
                      </div>
                    </li>
                  ))}
                </ul>
              </Disclosure>
            )}
            {trackable.length === 0 && limitations.length === 0 && (
              <p className="atlas-text-dense atlas-text-muted">Nothing outstanding was recorded for this recommendation.</p>
            )}
          </>
        )}
        {conflictCount > 0 && (
          <Notice tone="warning" title="Conflicting recorded values were found">
            {conflictCount} recorded fact{conflictCount === 1 ? " has" : "s have"} conflicting values. Atlas does not say which is correct.
            <div style={{ marginTop: 8 }}>
              <Button size="sm" onClick={() => onGoToTab("recommendation")}>
                Review the conflicts on the recommendation
              </Button>
            </div>
          </Notice>
        )}
      </div>
    </Card>
  );
}

/* ===========================================================================
   Action summary
   =========================================================================== */

function ActionSummary({
  summary,
  canWrite,
  onGoToTab,
}: {
  summary: ReturnType<typeof summariseMissingInfo>;
  canWrite: boolean;
  onGoToTab: (tab: SubmissionTab) => void;
}) {
  const rows: { label: string; value: number; hint: string; tone?: "warning" | "danger" | "info" | "success" }[] = [
    {
      label: "Not yet requested",
      value: summary.outstanding,
      hint: "Identified but not asked for yet.",
      tone: summary.outstanding > 0 ? "warning" : undefined,
    },
    {
      label: "Awaiting a reply",
      value: summary.awaiting_reply,
      hint: "Already requested. Follow up if it is overdue.",
      tone: summary.awaiting_reply > 0 ? "info" : undefined,
    },
    {
      label: "Awaiting review",
      value: summary.awaiting_review,
      hint: "Arrived but not yet acted on.",
      tone: summary.awaiting_review > 0 ? "success" : undefined,
    },
    {
      label: "Deliberately closed",
      value: summary.closed,
      hint: "Waived or not required, with a note.",
    },
  ];
  return (
    <section
      className="atlas-workflow-summary"
      aria-label="Missing information summary"
    >
      <div className="atlas-workflow-summary__row">
        {rows.map((row) => (
          <div
            key={row.label}
            className={`atlas-workflow-summary__cell${
              row.tone ? ` atlas-workflow-summary__cell--${row.tone}` : ""
            }`}
          >
            <span className="atlas-workflow-summary__label">{row.label}</span>
            <span className="atlas-workflow-summary__value">{row.value}</span>
            <span className="atlas-workflow-summary__hint">{row.hint}</span>
          </div>
        ))}
      </div>
      <div className="atlas-workflow-summary__foot">
        {summary.overdue > 0 && (
          <StatusBadge
            status={{
              label: `${summary.overdue} past due date`,
              tone: "danger",
              description: "Requested items whose recorded due date has passed.",
            }}
          />
        )}
        {summary.active_owners.length > 0 && (
          <span className="atlas-workflow-summary__owners">
            <span className="atlas-workflow-summary__owners-label">Owed by</span>
            {summary.active_owners.map((owner) => (
              <MetaTag key={owner}>{humanise(owner)}</MetaTag>
            ))}
          </span>
        )}
        {canWrite && (summary.outstanding + summary.awaiting_reply) > 0 && (
          <Button
            size="sm"
            variant="link"
            iconAfter="arrow-right"
            onClick={() => onGoToTab("communications")}
          >
            Draft the request on Communications
          </Button>
        )}
      </div>
    </section>
  );
}

function AddItemDrawer({
  open,
  submissionId,
  quoteReviewId,
  onClose,
  onAdded,
}: {
  open: boolean;
  submissionId: string;
  quoteReviewId: string | null;
  onClose: () => void;
  onAdded: () => void;
}) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [itemType, setItemType] = useState("other");
  const [owner, setOwner] = useState<MissingInfoOwner>("broker");
  const [dueDate, setDueDate] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    if (!open) return;
    setTitle("");
    setDescription("");
    setItemType("other");
    setOwner("broker");
    setDueDate("");
    setError(null);
    setTouched(false);
  }, [open]);

  async function save() {
    setTouched(true);
    if (!title.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await addMissingInfo(submissionId, {
        quote_review_id: quoteReviewId,
        title: title.trim(),
        description: description.trim() || null,
        item_type: itemType as "document" | "quote_term" | "underwriting_info" | "referral_info" | "other",
        owner,
        due_date: dueDate || null,
      });
      onAdded();
    } catch {
      setError("The item could not be added. Try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Drawer
      open={open}
      title="Add missing information"
      description="Track something the analysis did not pick up."
      onClose={onClose}
      dirty={Boolean(title || description) && !saving}
      size="sm"
      footer={
        <>
          <Button onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button variant="primary" onClick={save} loading={saving} loadingLabel="Adding…">
            Add item
          </Button>
        </>
      }
    >
      <div className="atlas-form">
        {error && <Notice tone="danger">{error}</Notice>}
        <TextField
          label="What is missing"
          required
          value={title}
          placeholder="Three years of claims experience"
          error={touched && !title.trim() ? "Describe what is missing." : null}
          onChange={(event) => setTitle(event.target.value)}
        />
        <TextAreaField
          label="Why it is needed"
          optional
          rows={3}
          value={description}
          placeholder="Which part of the recommendation or quote depends on it"
          onChange={(event) => setDescription(event.target.value)}
        />
        <SelectField
          label="Type"
          value={itemType}
          options={ITEM_TYPE_OPTIONS}
          onChange={(event) => setItemType(event.target.value)}
        />
        <SelectField
          label="Owed by"
          value={owner}
          options={MISSING_INFO_OWNER_OPTIONS}
          onChange={(event) => setOwner(event.target.value as MissingInfoOwner)}
        />
        <TextField
          label="Due date"
          optional
          type="date"
          value={dueDate}
          onChange={(event) => setDueDate(event.target.value)}
        />
      </div>
    </Drawer>
  );
}

function EditItemDrawer({
  item,
  working,
  onClose,
  onStatusChange,
  onSave,
}: {
  item: MissingInfoItem | null;
  working: boolean;
  onClose: () => void;
  onStatusChange: (item: MissingInfoItem, status: MissingInfoStatus) => void;
  onSave: (
    item: MissingInfoItem,
    patch: { owner?: MissingInfoOwner; due_date?: string | null; notes?: string | null }
  ) => Promise<void>;
}) {
  const [owner, setOwner] = useState<MissingInfoOwner>("broker");
  const [dueDate, setDueDate] = useState("");
  const [notes, setNotes] = useState("");

  useEffect(() => {
    if (!item) return;
    setOwner(item.owner);
    setDueDate(item.due_date ?? "");
    setNotes(item.notes ?? "");
  }, [item]);

  if (!item) return null;

  const dirty = owner !== item.owner || dueDate !== (item.due_date ?? "") || notes !== (item.notes ?? "");

  return (
    <Drawer
      open
      title={item.title}
      description={item.description ?? undefined}
      onClose={onClose}
      dirty={dirty && !working}
      size="sm"
      footer={
        <>
          <Button onClick={onClose} disabled={working}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={working}
            loadingLabel="Saving…"
            onClick={() => onSave(item, { owner, due_date: dueDate || null, notes: notes || null })}
          >
            Save changes
          </Button>
        </>
      }
    >
      <div className="atlas-form">
        <div>
          <p className="atlas-block__title" style={{ marginBottom: 8 }}>
            Status
          </p>
          <div className="atlas-actions">
            {MISSING_INFO_STATUS_OPTIONS.map((option) => (
              <Button
                key={option.value}
                size="sm"
                variant={item.status === option.value ? "primary" : "secondary"}
                disabled={working || item.status === option.value}
                onClick={() => onStatusChange(item, option.value as MissingInfoStatus)}
              >
                {option.label}
              </Button>
            ))}
          </div>
          <p className="atlas-field__hint" style={{ marginTop: 8 }}>
            {missingInfoStatus(item.status).description}
          </p>
        </div>

        <SelectField
          label="Owed by"
          value={owner}
          options={MISSING_INFO_OWNER_OPTIONS}
          onChange={(event) => setOwner(event.target.value as MissingInfoOwner)}
        />
        <TextField
          label="Due date"
          optional
          type="date"
          value={dueDate}
          onChange={(event) => setDueDate(event.target.value)}
        />
        <TextAreaField
          label="Note"
          optional
          rows={3}
          value={notes}
          hint="Kept in the audit history alongside the item."
          onChange={(event) => setNotes(event.target.value)}
        />
      </div>
    </Drawer>
  );
}
