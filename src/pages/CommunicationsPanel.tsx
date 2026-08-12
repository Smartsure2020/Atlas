/**
 * Atlas — communications workbench
 * ----------------------------------------------------------------------------
 * A strict three-part hierarchy:
 *
 *   1. Safety boundary — Atlas never sends anything on your behalf.
 *   2. Draft workspace — pick a draft type, generate, review, copy, save.
 *   3. Communication record — history of what has been drafted, copied and
 *      recorded as sent manually.
 *
 * Nothing here sends a message. "Generate", "Save to record", "Copy" and
 * "Record manual send" are the four explicit actions; the confirmation for
 * recording a manual send names the consequence before it happens, including
 * whether it will mark linked missing-information items as requested through
 * the existing server-side flag.
 */

import { useEffect, useMemo, useState } from "react";
import { generateEmail, type EmailDraft } from "../lib/decisions";
import {
  generateDraft,
  listCommunications,
  saveCommunication,
  updateCommunication,
  type CommunicationRecord,
  type CommunicationType,
} from "../lib/phase4";
import {
  Button,
  Card,
  ConfirmDialog,
  Disclosure,
  EmptyState,
  MetaTag,
  Notice,
  StatusBadge,
  useToast,
} from "../components/ui";
import { Icon } from "../components/Icon";
import { COMMUNICATION_TYPE_LABELS, communicationStatus } from "../lib/status";
import { formatDateTime } from "../lib/format";
import type { WorkspaceData } from "./SubmissionDetail";
import {
  countLinkedMissing,
  EMAIL_DRAFT_CATALOGUE,
  groupCommunications,
  referralNeededFor,
  referralReadinessChecks,
  relatedSectionsLabel,
  WORKFLOW_DRAFT_CATALOGUE,
  type EmailDraftType,
  type WorkflowDraftType,
} from "../lib/workflow";

type DraftKind =
  | { source: "email"; type: EmailDraftType }
  | { source: "workflow"; type: WorkflowDraftType };

const WORKFLOW_DRAFT_TYPES = Object.keys(WORKFLOW_DRAFT_CATALOGUE) as WorkflowDraftType[];
const EMAIL_DRAFT_TYPES = Object.keys(EMAIL_DRAFT_CATALOGUE) as EmailDraftType[];

const DRAFT_TYPE_MAP: Record<WorkflowDraftType, CommunicationType> = {
  "missing-info": "missing_info_request",
  "referral-pack": "referral_pack",
  "quote-summary": "review_summary",
};

const WORKFLOW_SAVE_SUBJECT: Record<WorkflowDraftType, string> = {
  "missing-info": "Outstanding information request",
  "referral-pack": "Referral pack",
  "quote-summary": "Quote review summary",
};

export default function CommunicationsPanel({
  submissionId,
  data,
  canWrite,
  onRefresh,
}: {
  submissionId: string;
  data: WorkspaceData;
  canWrite: boolean;
  onRefresh: () => Promise<void> | void;
}) {
  const toast = useToast();
  const [records, setRecords] = useState<CommunicationRecord[]>([]);
  const [loadingRecords, setLoadingRecords] = useState(true);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [active, setActive] = useState<DraftKind | null>(null);
  const [draft, setDraft] = useState<{ subject: string | null; body: string } | null>(null);
  const [generating, setGenerating] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmSent, setConfirmSent] = useState<CommunicationRecord | null>(null);
  // Email drafts are always persisted server-side on generation (the endpoint
  // inserts into atlas_communications before returning). When Supabase insert
  // fails the response carries draft_persisted:false; recovery is to
  // regenerate, which the warning below already asks the user to do. This
  // flag drives the "already saved" hint on email drafts and is not a save
  // gate — the Save-to-record action only exists for workflow drafts, which
  // are the only source without server-side persistence at generation time.
  const [emailPersistedByServer, setEmailPersistedByServer] = useState(false);
  // Workflow drafts have no server-side persistence at generation. Track a
  // per-draft persisted flag locally so the Save-to-record action disappears
  // after a successful save — this both signals success and prevents a
  // double-save if the user re-clicks.
  const [activeWorkflowPersisted, setActiveWorkflowPersisted] = useState(false);

  const openMissing = useMemo(
    () => data.missingInfo.filter((item) => item.status === "open" || item.status === "requested"),
    [data.missingInfo]
  );
  const openMissingIds = useMemo(() => new Set(openMissing.map((item) => item.id)), [openMissing]);
  const activeDocumentCount = useMemo(
    () => data.payload.documents.filter((document) => document.status !== "expired").length,
    [data.payload.documents]
  );

  async function loadRecords() {
    setLoadingRecords(true);
    setHistoryError(null);
    try {
      const result = await listCommunications(submissionId);
      setRecords(result.communications);
    } catch {
      setHistoryError("The communication record could not be loaded. The drafting tools still work.");
    } finally {
      setLoadingRecords(false);
    }
  }

  useEffect(() => {
    void loadRecords();
    // Load once per clean mount; polling is owned by SubmissionDetail.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [submissionId]);

  async function onGenerateEmail(type: EmailDraftType) {
    setGenerating(type);
    setError(null);
    setWarning(null);
    try {
      const result: EmailDraft & { draft_persisted?: boolean; based_on?: string } =
        (await generateEmail(submissionId, type)) as never;
      setActive({ source: "email", type });
      setDraft({ subject: result.subject, body: result.body });
      setEmailPersistedByServer(result.draft_persisted !== false);
      setActiveWorkflowPersisted(false);
      if (result.based_on === "raw_extraction") {
        setWarning(
          "This draft was built from an unreviewed extraction. Verify every fact in it before copying or sending."
        );
      } else if (result.draft_persisted === false) {
        setWarning(
          "The draft could not be saved to the communication record. Copy it now if you need it, then regenerate to retry saving."
        );
      }
      await loadRecords();
    } catch {
      setError("The draft could not be generated. Try again in a moment.");
    } finally {
      setGenerating(null);
    }
  }

  async function onGenerateWorkflowDraft(type: WorkflowDraftType) {
    setGenerating(type);
    setError(null);
    setWarning(null);
    try {
      const result = await generateDraft(submissionId, type, { recipient: "broker" });
      setActive({ source: "workflow", type });
      setDraft({ subject: null, body: result.draft });
      // Workflow drafts are not persisted by the generation endpoint; the
      // explicit Save to record is what stores them. Reset both persistence
      // flags so the fresh draft starts in the not-yet-saved state.
      setEmailPersistedByServer(false);
      setActiveWorkflowPersisted(false);
    } catch {
      setError("The draft could not be generated. Run the extraction and quote review first.");
    } finally {
      setGenerating(null);
    }
  }

  async function onSaveDraft() {
    if (!draft || !active || active.source !== "workflow") return;
    setSaving(true);
    setError(null);
    try {
      await saveCommunication(submissionId, {
        quote_review_id: data.quoteReview?.id ?? null,
        communication_type: DRAFT_TYPE_MAP[active.type],
        audience: active.type === "referral-pack" ? "senior_underwriter" : "broker",
        subject: WORKFLOW_SAVE_SUBJECT[active.type],
        body: draft.body,
        related_missing_info_item_ids: openMissing.map((item) => item.id),
        related_section_keys: data.quoteSections.map((section) => section.section_key),
      });
      setActiveWorkflowPersisted(true);
      await loadRecords();
      toast.notify("Draft saved to the communication record.", "success");
    } catch {
      setError("The draft could not be saved to the communication record.");
    } finally {
      setSaving(false);
    }
  }

  async function copy(text: string, label: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast.notify(`${label} copied to the clipboard.`, "success");
    } catch {
      toast.notify("Copying failed. Select the text and copy it manually.", "warning");
    }
  }

  async function recordManualSend(record: CommunicationRecord) {
    try {
      await updateCommunication(record.id, {
        status: "sent_manually",
        mark_related_missing_requested: true,
      });
      await loadRecords();
      await onRefresh();
      toast.notify("Recorded as sent manually.", "success");
    } catch {
      setError("The communication record could not be updated.");
    } finally {
      setConfirmSent(null);
    }
  }

  const referralNeeded = referralNeededFor({
    recommendation: data.recommendation,
    quoteReview: data.quoteReview,
    decision: data.decision,
  });
  const readinessChecks = useMemo(
    () =>
      referralReadinessChecks({
        extraction: data.payload.extraction,
        recommendation: data.recommendation,
        quoteReview: data.quoteReview,
        openMissing: openMissing.length,
        activeDocumentCount,
      }),
    [data.payload.extraction, data.recommendation, data.quoteReview, openMissing.length, activeDocumentCount]
  );
  const recordGroups = useMemo(() => groupCommunications(records), [records]);

  // Only workflow drafts are missing server-side persistence; email drafts
  // are already stored on generation (or, if that insert failed, the fix is
  // to regenerate — surfacing a separate Save-to-record path for them would
  // duplicate the endpoint's own responsibility). Once a workflow draft has
  // been saved this session, the action disappears too.
  const canSaveToRecord =
    active?.source === "workflow" && !activeWorkflowPersisted;

  return (
    <div className="atlas-stack">
      <Notice tone="info" title="Atlas never sends anything on your behalf">
        Every draft below is copyable text. Review and edit it, paste it into your mail client, then
        record the manual send here so the audit history stays accurate.
      </Notice>

      {error && <Notice tone="danger" title="That did not complete">{error}</Notice>}

      {referralNeeded && (
        <ReferralReadiness checks={readinessChecks} />
      )}

      <Card
        title="Draft a communication"
        description="Atlas builds each draft from the current reviewed information. Selecting a type does not send or save anything."
      >
        <div className="atlas-draft-chooser">
          <div className="atlas-draft-chooser__group">
            <p className="atlas-draft-chooser__group-title">Workflow drafts</p>
            <p className="atlas-draft-chooser__group-hint">
              Built from tracked Atlas records. Use Save to record to store the reviewed draft alongside
              the submission.
            </p>
            <div className="atlas-draft-chooser__grid">
              {WORKFLOW_DRAFT_TYPES.map((type) => {
                const item = WORKFLOW_DRAFT_CATALOGUE[type];
                return (
                  <DraftCard
                    key={type}
                    label={item.label}
                    description={item.description}
                    audience={item.audience}
                    loading={generating === type}
                    disabled={!canWrite || generating !== null}
                    active={active?.source === "workflow" && active.type === type}
                    onClick={() => onGenerateWorkflowDraft(type)}
                  />
                );
              })}
            </div>
          </div>

          <div className="atlas-draft-chooser__group">
            <p className="atlas-draft-chooser__group-title">Email drafts</p>
            <p className="atlas-draft-chooser__group-hint">
              Composed via the email-draft endpoint. Atlas saves these to the communication record when
              it can — copy them into your mail client to send.
            </p>
            <div className="atlas-draft-chooser__grid">
              {EMAIL_DRAFT_TYPES.map((type) => {
                const item = EMAIL_DRAFT_CATALOGUE[type];
                return (
                  <DraftCard
                    key={type}
                    label={item.label}
                    description={item.description}
                    audience={item.audience}
                    loading={generating === type}
                    disabled={!canWrite || generating !== null}
                    active={active?.source === "email" && active.type === type}
                    onClick={() => onGenerateEmail(type)}
                  />
                );
              })}
            </div>
          </div>
        </div>

        {draft && active && (
          <div className="atlas-draft" style={{ marginTop: "var(--atlas-space-5)" }}>
            <div className="atlas-draft__head">
              <div>
                <p
                  className="atlas-title-sub"
                  style={{ fontSize: "var(--atlas-fs-body)", margin: 0 }}
                >
                  {activeLabel(active)}
                </p>
                <p className="atlas-text-dense atlas-text-muted" style={{ margin: "2px 0 0" }}>
                  For {audienceOf(active)} · {purposeOf(active)}
                </p>
              </div>
              <div className="atlas-actions">
                {canSaveToRecord && (
                  <Button size="sm" loading={saving} loadingLabel="Saving…" onClick={onSaveDraft}>
                    Save to record
                  </Button>
                )}
                <Button
                  size="sm"
                  icon="refresh"
                  disabled={generating !== null}
                  onClick={() => {
                    if (active.source === "email") void onGenerateEmail(active.type);
                    else void onGenerateWorkflowDraft(active.type);
                  }}
                >
                  Regenerate
                </Button>
              </div>
            </div>

            <div className="atlas-draft__body">
              {warning && <Notice tone="warning">{warning}</Notice>}

              {active.source === "email" && emailPersistedByServer && (
                <p className="atlas-text-dense atlas-text-muted">
                  This draft is already saved to the communication record. Copy it into your mail
                  client, send it there, then record the manual send below.
                </p>
              )}

              {active.source === "workflow" && activeWorkflowPersisted && (
                <p className="atlas-text-dense atlas-text-muted">
                  This draft is saved to the communication record. Copy it into your mail client,
                  send it there, then record the manual send below.
                </p>
              )}

              {draft.subject !== null && (
                <div className="atlas-field">
                  <div
                    className="atlas-field__label"
                    style={{ justifyContent: "space-between", width: "100%" }}
                  >
                    <span>Subject</span>
                    <Button size="sm" variant="ghost" icon="copy" onClick={() => copy(draft.subject!, "Subject")}>
                      Copy subject
                    </Button>
                  </div>
                  <input
                    className="atlas-input"
                    readOnly
                    value={draft.subject}
                    aria-label="Draft subject"
                    onFocus={(event) => event.currentTarget.select()}
                  />
                </div>
              )}

              <div className="atlas-field">
                <div
                  className="atlas-field__label"
                  style={{ justifyContent: "space-between", width: "100%" }}
                >
                  <span>Message</span>
                  <Button size="sm" variant="ghost" icon="copy" onClick={() => copy(draft.body, "Message")}>
                    Copy message
                  </Button>
                </div>
                <textarea
                  className="atlas-textarea atlas-draft__textarea"
                  readOnly
                  value={draft.body}
                  aria-label="Draft message"
                />
              </div>

            </div>
          </div>
        )}
      </Card>

      <Card
        title="Communication record"
        description="What has been drafted, copied and recorded as sent for this submission."
        flush={records.length > 0}
      >
        {loadingRecords ? (
          <p className="atlas-text-dense atlas-text-muted">Loading the communication record…</p>
        ) : historyError ? (
          <Notice tone="warning" title="The communication record could not be loaded">
            {historyError}
            <div style={{ marginTop: 8 }}>
              <Button size="sm" icon="refresh" onClick={() => void loadRecords()}>
                Try again
              </Button>
            </div>
          </Notice>
        ) : records.length === 0 ? (
          <EmptyState
            inline
            title="Nothing has been recorded yet"
            body="Saved drafts, copied messages and manual-send records appear here and form part of the submission's audit history."
          />
        ) : (
          <div style={{ padding: "0 var(--atlas-space-5) var(--atlas-space-3)" }}>
            {recordGroups.map((group) => (
              <section
                key={group.key}
                aria-labelledby={`comm-group-${group.key}`}
                style={{ marginBottom: "var(--atlas-space-5)" }}
              >
                <h3
                  id={`comm-group-${group.key}`}
                  className="atlas-title-sub"
                  style={{ fontSize: "var(--atlas-fs-body)" }}
                >
                  {group.title}
                  <span className="atlas-text-muted" style={{ fontWeight: 400, marginLeft: 8 }}>
                    ({group.items.length})
                  </span>
                </h3>
                <ul className="atlas-list atlas-list--stack-sm">
                  {group.items.map((record) => (
                    <CommunicationRow
                      key={record.id}
                      record={record}
                      canWrite={canWrite}
                      linkedMissing={countLinkedMissing(record, openMissingIds)}
                      onCopy={() => copy(record.body, "Message")}
                      onRecordSend={() => setConfirmSent(record)}
                    />
                  ))}
                </ul>
              </section>
            ))}
          </div>
        )}
      </Card>

      <ConfirmDialog
        open={confirmSent !== null}
        title="Record this communication as sent manually?"
        confirmLabel="Record manual send"
        onCancel={() => setConfirmSent(null)}
        onConfirm={() => confirmSent && recordManualSend(confirmSent)}
        body={
          <>
            <p>
              This records that you already sent this message yourself, outside Atlas. Atlas does
              not send anything — the record simply reflects what you did.
            </p>
            {confirmSent && countLinkedMissing(confirmSent, openMissingIds) > 0 && (
              <p style={{ marginTop: 8 }}>
                {countLinkedMissing(confirmSent, openMissingIds)} linked missing-information item
                {countLinkedMissing(confirmSent, openMissingIds) === 1 ? " will" : "s will"} also be
                marked as requested.
              </p>
            )}
          </>
        }
      />
    </div>
  );
}

/* ===========================================================================
   Communication row
   =========================================================================== */

function CommunicationRow({
  record,
  canWrite,
  linkedMissing,
  onCopy,
  onRecordSend,
}: {
  record: CommunicationRecord;
  canWrite: boolean;
  linkedMissing: number;
  onCopy: () => void;
  onRecordSend: () => void;
}) {
  const audienceLabel = record.audience.replace(/_/g, " ");
  const sections = relatedSectionsLabel(record);
  return (
    <li className="atlas-list__item">
      <div className="atlas-list__main">
        <p className="atlas-list__title">
          {record.subject ??
            COMMUNICATION_TYPE_LABELS[record.communication_type] ??
            "Communication"}
        </p>
        <p className="atlas-list__meta">
          To {audienceLabel} · created {formatDateTime(record.created_at)}
          {record.sent_at ? ` · recorded sent ${formatDateTime(record.sent_at)}` : ""}
        </p>
        {(linkedMissing > 0 || sections) && (
          <p className="atlas-list__meta" style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {linkedMissing > 0 && (
              <MetaTag>
                {linkedMissing} linked missing item{linkedMissing === 1 ? "" : "s"}
              </MetaTag>
            )}
            {sections && <MetaTag>Sections: {sections}</MetaTag>}
          </p>
        )}
        <Disclosure summary="Show message body">
          <pre
            style={{
              margin: 0,
              padding: "var(--atlas-space-3)",
              background: "var(--atlas-surface-muted)",
              borderRadius: "var(--atlas-radius)",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              fontFamily: "var(--atlas-font-mono)",
              fontSize: "var(--atlas-fs-dense)",
              lineHeight: 1.5,
            }}
          >
            {record.body}
          </pre>
        </Disclosure>
      </div>
      <div className="atlas-list__side">
        <StatusBadge status={communicationStatus(record.status)} />
        <Button size="sm" icon="copy" onClick={onCopy}>
          Copy message
        </Button>
        {canWrite && record.status !== "sent_manually" && (
          <Button size="sm" onClick={onRecordSend}>
            Record manual send
          </Button>
        )}
      </div>
    </li>
  );
}

/* ===========================================================================
   Draft card
   =========================================================================== */

function DraftCard({
  label,
  description,
  audience,
  loading,
  disabled,
  active,
  onClick,
}: {
  label: string;
  description: string;
  audience: string;
  loading: boolean;
  disabled: boolean;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="atlas-draft-card"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
    >
      <span className="atlas-draft-card__label">
        {loading ? "Drafting…" : label}
      </span>
      <span className="atlas-draft-card__description">{description}</span>
      <span className="atlas-draft-card__audience">
        <Icon name="arrow-up-right" size={11} /> {audience}
      </span>
    </button>
  );
}

function activeLabel(active: DraftKind): string {
  return active.source === "email"
    ? EMAIL_DRAFT_CATALOGUE[active.type].label
    : WORKFLOW_DRAFT_CATALOGUE[active.type].label;
}

function audienceOf(active: DraftKind): string {
  return active.source === "email"
    ? EMAIL_DRAFT_CATALOGUE[active.type].audience
    : WORKFLOW_DRAFT_CATALOGUE[active.type].audience;
}

function purposeOf(active: DraftKind): string {
  return active.source === "email"
    ? EMAIL_DRAFT_CATALOGUE[active.type].purpose
    : WORKFLOW_DRAFT_CATALOGUE[active.type].purpose;
}

/* ===========================================================================
   Referral pack readiness
   =========================================================================== */

function ReferralReadiness({
  checks,
}: {
  checks: ReturnType<typeof referralReadinessChecks>;
}) {
  const blocked = checks.filter((check) => check.requirement === "required" && !check.met);

  return (
    <Card
      title="Referral pack readiness"
      description="This submission needs a referral. Check the pack is complete before you draft or send it."
    >
      {blocked.length === 0 ? (
        <Notice tone="success" title="The required content is in place">
          Everything a referral pack must contain is on the record. Draft the pack below, review it,
          and send it from your mail client.
        </Notice>
      ) : (
        <Notice tone="warning" title={`${blocked.length} required item${blocked.length === 1 ? "" : "s"} outstanding`}>
          Sending now risks a round trip with the insurer. Resolve the items marked required below
          first.
        </Notice>
      )}

      <ul className="atlas-list atlas-list--stack-sm" style={{ marginTop: "var(--atlas-space-4)" }}>
        {checks.map((check) => (
          <li className="atlas-list__item" key={check.label}>
            <div className="atlas-list__main">
              <p className="atlas-list__title">
                <Icon
                  name={check.met ? "check-circle" : check.requirement === "required" ? "x-circle" : "alert-triangle"}
                  size={13}
                />{" "}
                {check.label}
              </p>
              <p className="atlas-list__meta">{check.why}</p>
            </div>
            <div className="atlas-list__side">
              <StatusBadge
                status={
                  check.met
                    ? { label: "Ready", tone: "success" }
                    : check.requirement === "required"
                    ? { label: "Required", tone: "danger" }
                    : { label: "Recommended", tone: "warning" }
                }
              />
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}
