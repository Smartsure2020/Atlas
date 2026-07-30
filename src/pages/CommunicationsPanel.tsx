/**
 * Atlas — communications
 * ----------------------------------------------------------------------------
 * Everything Atlas can draft, and the record of what was actually sent.
 * Two previously separate surfaces (the Phase 3 email drafts and the Phase 4
 * communication records) now sit together, because from the user's point of
 * view they are one job: get the right message out and record that it went.
 *
 * Nothing is ever sent automatically. Atlas produces copyable drafts; a person
 * pastes them into their mail client and marks the record as sent.
 *
 * The referral pack gets its own readiness checklist, because a pack that goes
 * out incomplete costs a full round trip with the insurer.
 */

import { useEffect, useState } from "react";
import { generateEmail, type EmailDraft, type EmailType } from "../lib/decisions";
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
  EmptyState,
  Notice,
  StatusBadge,
  useToast,
} from "../components/ui";
import { Icon } from "../components/Icon";
import { COMMUNICATION_TYPE_LABELS, communicationStatus } from "../lib/status";
import { formatDateTime } from "../lib/format";
import type { WorkspaceData } from "./SubmissionDetail";

type DraftKind =
  | { source: "email"; type: EmailType }
  | { source: "workflow"; type: "missing-info" | "referral-pack" | "quote-summary" };

const EMAIL_DRAFTS: { type: EmailType; label: string; description: string }[] = [
  {
    type: "broker-missing-info",
    label: "Request information from the broker",
    description: "Lists the outstanding items and why each one is needed.",
  },
  {
    type: "broker-acknowledgement",
    label: "Acknowledge the submission",
    description: "Confirms receipt and sets expectations on timing.",
  },
  {
    type: "insurer-submission",
    label: "Submit to the insurer",
    description: "Presents the risk to the selected insurer.",
  },
  {
    type: "internal-summary",
    label: "Internal handover summary",
    description: "Brings a colleague up to speed on the submission.",
  },
];

const WORKFLOW_DRAFTS: {
  type: "missing-info" | "referral-pack" | "quote-summary";
  label: string;
  description: string;
}[] = [
  {
    type: "missing-info",
    label: "Outstanding information request",
    description: "Built from the tracked missing-information items.",
  },
  {
    type: "referral-pack",
    label: "Referral pack",
    description: "Assembles the risk summary, findings and mitigating factors for the insurer.",
  },
  {
    type: "quote-summary",
    label: "Quote review summary",
    description: "Summarises the review outcome and the conditions attached to it.",
  },
];

const DRAFT_TYPE_MAP: Record<"missing-info" | "referral-pack" | "quote-summary", CommunicationType> = {
  "missing-info": "missing_info_request",
  "referral-pack": "referral_pack",
  "quote-summary": "review_summary",
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
  const [active, setActive] = useState<DraftKind | null>(null);
  const [draft, setDraft] = useState<{ subject: string | null; body: string } | null>(null);
  const [generating, setGenerating] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmSent, setConfirmSent] = useState<CommunicationRecord | null>(null);

  const openMissing = data.missingInfo.filter(
    (item) => item.status === "open" || item.status === "requested"
  );

  async function loadRecords() {
    setLoadingRecords(true);
    try {
      const result = await listCommunications(submissionId);
      setRecords(result.communications);
    } catch {
      // The drafting tools still work without the history.
    } finally {
      setLoadingRecords(false);
    }
  }

  useEffect(() => {
    void loadRecords();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [submissionId]);

  async function onGenerateEmail(type: EmailType) {
    setGenerating(type);
    setError(null);
    setWarning(null);
    try {
      const result: EmailDraft & { draft_persisted?: boolean; based_on?: string } =
        (await generateEmail(submissionId, type)) as never;
      setActive({ source: "email", type });
      setDraft({ subject: result.subject, body: result.body });
      if (result.based_on === "raw_extraction") {
        setWarning(
          "This draft was built from an unreviewed extraction. Verify every fact in it before sending."
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

  async function onGenerateWorkflowDraft(type: "missing-info" | "referral-pack" | "quote-summary") {
    setGenerating(type);
    setError(null);
    setWarning(null);
    try {
      const result = await generateDraft(submissionId, type, { recipient: "broker" });
      setActive({ source: "workflow", type });
      setDraft({ subject: null, body: result.draft });
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
        subject:
          active.type === "missing-info"
            ? "Outstanding information request"
            : active.type === "referral-pack"
            ? "Referral pack"
            : "Quote review summary",
        body: draft.body,
        related_missing_info_item_ids: openMissing.map((item) => item.id),
        related_section_keys: data.quoteSections.map((section) => section.section_key),
      });
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

  async function markStatus(record: CommunicationRecord, status: "copied" | "sent_manually" | "archived") {
    try {
      await updateCommunication(record.id, {
        status,
        mark_related_missing_requested: status === "sent_manually",
      });
      await loadRecords();
      if (status === "sent_manually") await onRefresh();
      toast.notify(`Marked as ${communicationStatus(status).label.toLowerCase()}.`, "success");
    } catch {
      setError("The communication record could not be updated.");
    } finally {
      setConfirmSent(null);
    }
  }

  const referralNeeded =
    data.recommendation?.referral_required ||
    data.quoteReview?.status === "refer" ||
    data.decision?.decision_choice === "refer";

  return (
    <div className="atlas-stack">
      <Notice tone="info" title="Atlas never sends anything on your behalf">
        Every draft below is copyable text. Review and edit it, paste it into your mail client, then
        mark the record as sent so the audit history stays accurate.
      </Notice>

      {error && <Notice tone="danger" title="That did not complete">{error}</Notice>}

      {referralNeeded && <ReferralReadiness data={data} openMissing={openMissing.length} />}

      <Card
        title="Draft a communication"
        description="Atlas builds each draft from the current reviewed information and the decision on file."
      >
        <div className="atlas-draft__grid">
          {WORKFLOW_DRAFTS.map((item) => (
            <DraftButton
              key={item.type}
              label={item.label}
              description={item.description}
              loading={generating === item.type}
              disabled={!canWrite || generating !== null}
              active={active?.source === "workflow" && active.type === item.type}
              onClick={() => onGenerateWorkflowDraft(item.type)}
            />
          ))}
          {EMAIL_DRAFTS.map((item) => (
            <DraftButton
              key={item.type}
              label={item.label}
              description={item.description}
              loading={generating === item.type}
              disabled={!canWrite || generating !== null}
              active={active?.source === "email" && active.type === item.type}
              onClick={() => onGenerateEmail(item.type)}
            />
          ))}
        </div>

        {draft && (
          <div className="atlas-draft" style={{ marginTop: "var(--atlas-space-5)" }}>
            <div className="atlas-draft__head">
              <span className="atlas-title-sub" style={{ fontSize: "var(--atlas-fs-body)" }}>
                {activeLabel(active)}
              </span>
              <div className="atlas-actions">
                {active?.source === "workflow" && (
                  <Button size="sm" loading={saving} loadingLabel="Saving…" onClick={onSaveDraft}>
                    Save to record
                  </Button>
                )}
                <Button
                  size="sm"
                  icon="refresh"
                  disabled={generating !== null}
                  onClick={() => {
                    if (!active) return;
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

              {draft.subject !== null && (
                <div className="atlas-field">
                  <div
                    className="atlas-field__label"
                    style={{ justifyContent: "space-between", width: "100%" }}
                  >
                    <span>Subject</span>
                    <Button size="sm" variant="ghost" icon="copy" onClick={() => copy(draft.subject!, "Subject")}>
                      Copy
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
                    Copy
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
        description="What has been drafted, copied and sent for this submission."
        flush={records.length > 0}
      >
        {loadingRecords ? (
          <p className="atlas-text-dense atlas-text-muted">Loading the communication record…</p>
        ) : records.length === 0 ? (
          <EmptyState
            inline
            title="Nothing has been recorded yet"
            body="Saved drafts and sent communications appear here, and form part of the submission's audit history."
          />
        ) : (
          <ul className="atlas-list" style={{ padding: "0 var(--atlas-space-5)" }}>
            {records.map((record) => (
              <li className="atlas-list__item" key={record.id}>
                <div className="atlas-list__main">
                  <p className="atlas-list__title">
                    {record.subject ??
                      COMMUNICATION_TYPE_LABELS[record.communication_type] ??
                      "Communication"}
                  </p>
                  <p className="atlas-list__meta">
                    To {record.audience.replace(/_/g, " ")} · created{" "}
                    {formatDateTime(record.created_at)}
                    {record.sent_at ? ` · sent ${formatDateTime(record.sent_at)}` : ""}
                  </p>
                </div>
                <div className="atlas-list__side">
                  <StatusBadge status={communicationStatus(record.status)} />
                  <Button size="sm" icon="copy" onClick={() => copy(record.body, "Message")}>
                    Copy
                  </Button>
                  {canWrite && record.status !== "sent_manually" && (
                    <Button size="sm" onClick={() => setConfirmSent(record)}>
                      Mark sent
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <ConfirmDialog
        open={confirmSent !== null}
        title="Mark this communication as sent?"
        confirmLabel="Mark as sent"
        onCancel={() => setConfirmSent(null)}
        onConfirm={() => confirmSent && markStatus(confirmSent, "sent_manually")}
        body={
          <>
            <p>
              This records that you sent the message yourself. Atlas does not send anything — the
              record simply reflects what you did.
            </p>
            {openMissing.length > 0 && (
              <p style={{ marginTop: 8 }}>
                Any outstanding information items linked to this message will also be marked as
                requested.
              </p>
            )}
          </>
        }
      />
    </div>
  );
}

function activeLabel(active: DraftKind | null): string {
  if (!active) return "Draft";
  if (active.source === "email") {
    return EMAIL_DRAFTS.find((item) => item.type === active.type)?.label ?? "Draft";
  }
  return WORKFLOW_DRAFTS.find((item) => item.type === active.type)?.label ?? "Draft";
}

function DraftButton({
  label,
  description,
  loading,
  disabled,
  active,
  onClick,
}: {
  label: string;
  description: string;
  loading: boolean;
  disabled: boolean;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="atlas-board__card"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      style={
        active
          ? { borderColor: "var(--atlas-primary)", background: "var(--atlas-primary-surface)" }
          : undefined
      }
    >
      <span className="atlas-board__card-client">
        {loading ? "Drafting…" : label}
      </span>
      <span className="atlas-board__card-meta">{description}</span>
    </button>
  );
}

/* ===========================================================================
   Referral pack readiness
   =========================================================================== */

function ReferralReadiness({ data, openMissing }: { data: WorkspaceData; openMissing: number }) {
  const checks: { label: string; met: boolean; requirement: "required" | "recommended"; why: string }[] = [
    {
      label: "Risk information reviewed by a person",
      met: Boolean(data.payload.extraction?.reviewed_json),
      requirement: "required",
      why: "The insurer will act on what you send. It must be confirmed, not an unreviewed extraction.",
    },
    {
      label: "Recommendation run against current information",
      met: Boolean(data.recommendation),
      requirement: "required",
      why: "The referral needs the appetite position it is asking the insurer to reconsider.",
    },
    {
      label: "Quote review complete",
      met: Boolean(data.quoteReview),
      requirement: "recommended",
      why: "The section findings tell the insurer exactly which terms are in question.",
    },
    {
      label: "No outstanding information",
      met: openMissing === 0,
      requirement: "recommended",
      why: "A pack sent with known gaps usually comes back with questions.",
    },
    {
      label: "Supporting documents on file",
      met: data.payload.documents.some((document) => document.status !== "expired"),
      requirement: "required",
      why: "The insurer needs the schedules and claims experience behind the referral.",
    },
  ];

  const blocked = checks.filter((check) => check.requirement === "required" && !check.met);

  return (
    <Card
      title="Referral pack readiness"
      description="This submission needs a referral. Check the pack is complete before it goes out."
    >
      {blocked.length === 0 ? (
        <Notice tone="success" title="The required content is in place">
          Everything a referral pack must contain is on the record. Generate the pack below, review it,
          and send it from your mail client.
        </Notice>
      ) : (
        <Notice tone="warning" title={`${blocked.length} required item${blocked.length === 1 ? "" : "s"} outstanding`}>
          Sending now risks a round trip with the insurer. Resolve the items marked required below
          first.
        </Notice>
      )}

      <ul className="atlas-list" style={{ marginTop: "var(--atlas-space-4)" }}>
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
