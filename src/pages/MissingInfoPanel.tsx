/**
 * Atlas — missing information and next actions
 * ----------------------------------------------------------------------------
 * Previously buried inside the quote-review card; now its own surface, because
 * chasing information is a distinct job that a different person often does.
 *
 * Items are grouped by what they block rather than by status alphabet, so the
 * things preventing a recommendation sit above the nice-to-haves. Editing an
 * item happens in a drawer so the list stays on screen, and waiving an item
 * asks for a note in a proper dialog rather than window.prompt().
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
  Drawer,
  EmptyState,
  Notice,
  PromptDialog,
  SelectField,
  StatusBadge,
  TextAreaField,
  TextField,
  useToast,
} from "../components/ui";
import { Icon } from "../components/Icon";
import {
  MISSING_INFO_OWNER_OPTIONS,
  MISSING_INFO_STATUS_OPTIONS,
  missingInfoStatus,
} from "../lib/status";
import { formatDate, humanise } from "../lib/format";
import type { SubmissionTab } from "../lib/router";

/** Items that need a note before the status change is allowed server-side. */
const NOTE_REQUIRED: MissingInfoStatus[] = ["waived", "not_required"];

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
}: {
  submissionId: string;
  items: MissingInfoItem[];
  quoteReviewId: string | null;
  canWrite: boolean;
  onRefresh: () => Promise<void> | void;
  onGoToTab: (tab: SubmissionTab) => void;
}) {
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

  const groups = useMemo(() => {
    const open = items.filter((item) => item.status === "open");
    const requested = items.filter((item) => item.status === "requested");
    const received = items.filter((item) => item.status === "received");
    const closed = items.filter((item) => item.status === "waived" || item.status === "not_required");
    return [
      {
        key: "open",
        title: "Outstanding — not yet requested",
        body: "Identified by Atlas or by the team, but nobody has asked for them yet.",
        items: open,
      },
      {
        key: "requested",
        title: "Requested — awaiting a reply",
        body: "Already asked for. Follow up if the reply is overdue.",
        items: requested,
      },
      {
        key: "received",
        title: "Received — awaiting review",
        body: "Arrived but not yet acted on. Rerun the analysis if any of this changes the risk.",
        items: received,
      },
      {
        key: "closed",
        title: "Waived or not required",
        body: "Deliberately closed. The note explains why.",
        items: closed,
      },
    ].filter((group) => group.items.length > 0);
  }, [items]);

  const blocking = items.filter((item) => item.status === "open" || item.status === "requested");

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

      {blocking.length > 0 && (
        <Notice tone="warning" title={`${blocking.length} item${blocking.length === 1 ? "" : "s"} still outstanding`}>
          Outstanding information can change the recommendation. Rerun the analysis once it arrives.
          <div style={{ marginTop: 8 }}>
            <Button size="sm" onClick={() => onGoToTab("recommendation")}>
              Open the recommendation
            </Button>
          </div>
        </Notice>
      )}

      <Card
        title="Missing information"
        description="What Atlas still needs, why it needs it, and who owes it."
        actions={
          canWrite ? (
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
          ) : undefined
        }
        flush={items.length > 0}
      >
        {items.length === 0 ? (
          <EmptyState
            inline
            title="Nothing is outstanding"
            body="Atlas has not identified any gaps, and nobody has added one manually. Derive items from the analysis once the extraction and quote review have run."
            actions={
              canWrite ? (
                <Button loading={generating} loadingLabel="Deriving…" onClick={onGenerate}>
                  Derive from analysis
                </Button>
              ) : undefined
            }
          />
        ) : (
          <div style={{ padding: "var(--atlas-space-5)" }}>
            {groups.map((group) => (
              <section
                key={group.key}
                style={{ marginBottom: "var(--atlas-space-6)" }}
                aria-label={group.title}
              >
                <h3 className="atlas-title-sub" style={{ fontSize: "var(--atlas-fs-body)" }}>
                  {group.title}
                </h3>
                <p className="atlas-text-dense atlas-text-muted" style={{ margin: "2px 0 12px" }}>
                  {group.body}
                </p>
                <ul className="atlas-list">
                  {group.items.map((item) => (
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
                  ))}
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
