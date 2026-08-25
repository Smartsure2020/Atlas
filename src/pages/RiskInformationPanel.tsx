/**
 * Atlas — extracted risk information
 * ----------------------------------------------------------------------------
 * What Atlas read out of the documents, and how much of it can be trusted.
 *
 * Two things changed from the previous version, both about honesty:
 *
 *  1. Confidence is shown as a band ("Uncertain", "Conflicting", "Not provided")
 *     rather than "47%". The pipeline does not calibrate that number well
 *     enough to justify two significant figures, and a band is what an
 *     underwriter actually acts on.
 *  2. Provenance is available on every field — the file, page and section it
 *     came from, with the supporting quote — behind a per-field disclosure so
 *     the grid stays readable.
 *
 * Sections render only when the extraction actually produced them, so a
 * personal motor risk is not padded out with empty commercial fields.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ExtractionRecord } from "../lib/atlas";
import type { ExtractionConfidenceState } from "../lib/extraction-confidence";
import { parseReviewFieldValue, reviewValueToEditorText } from "../lib/review-edit";
import {
  Block,
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  Notice,
  SourceReference,
  StatusBadge,
  Disclosure,
} from "../components/ui";
import ExtractionTrustSummary from "../components/ExtractionTrustSummary";
import { Icon } from "../components/Icon";
import { confidenceBand, severity } from "../lib/status";
import { formatDateTime } from "../lib/format";
import { isExtractionField, type ExtractionField } from "../lib/extraction-fields";

/** The risk sections Atlas can produce, in underwriting reading order. */
const SECTIONS: { key: string; title: string; fields: [string, string][] }[] = [
  {
    key: "extracted_client",
    title: "Insured",
    fields: [
      ["name", "Insured name"],
      ["entity_type", "Entity type"],
      ["registration_or_id_number", "Registration / ID number"],
      ["occupation_or_business_description", "Occupation or business activity"],
      ["contact_details", "Contact details"],
      ["risk_address", "Risk address"],
    ],
  },
  {
    key: "broker",
    title: "Broker",
    fields: [
      ["name", "Broker"],
      ["email", "Broker email"],
      ["brokerage", "Brokerage"],
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
    key: "claims",
    title: "Claims history",
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
      ["insurer_name", "Quoting insurer"],
      ["quote_reference", "Quote reference"],
      ["quote_date", "Quote date"],
      ["quote_expiry_date", "Quote expiry"],
      ["insured_name", "Insured name on quote"],
      ["risk_address", "Risk address on quote"],
      ["sections", "Quoted sections"],
      ["required_documents", "Required documents"],
      ["notes", "Quote notes"],
    ],
  },
];

function isWideField(value: unknown): boolean {
  if (Array.isArray(value) && value.length > 2) return true;
  const text = formatFieldValue(value);
  return text.length > 120 || text.includes("\n");
}

function formatFieldValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.map(formatOne).filter(Boolean).join("\n");
  if (typeof value === "object") return formatOne(value);
  return String(value);
}

function formatOne(item: unknown): string {
  if (item === null || item === undefined) return "";
  if (typeof item === "object") {
    return Object.entries(item as Record<string, unknown>)
      .filter(([, value]) => value !== null && value !== undefined && value !== "")
      .map(([key, value]) => `${key.replace(/_/g, " ")}: ${String(value)}`)
      .join(" · ");
  }
  return String(item);
}

export default function RiskInformationPanel({
  extraction,
  extractionConfidence,
  canWrite,
  canManage,
  extracting,
  onExtract,
  onSave,
}: {
  submissionId: string;
  extraction: ExtractionRecord | null;
  /**
   * Pre-resolved confidence state from SubmissionDetail. Passing it down keeps
   * every trust surface on the page in lock-step with a single resolution.
   */
  extractionConfidence?: ExtractionConfidenceState;
  canWrite: boolean;
  canManage: boolean;
  extracting: boolean;
  onExtract: () => void;
  onSave: (extractionId: string, reviewedJson: Record<string, unknown>) => Promise<void>;
}) {
  const reviewed = Boolean(extraction?.reviewed_json);
  const source = (extraction?.reviewed_json ?? extraction?.extracted_json ?? null) as Record<
    string,
    unknown
  > | null;

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Record<string, unknown> | null>(source);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // Discard-confirmation state: when the user has typed corrections, the
  // "Discard changes" trigger no longer wipes them silently. It opens a
  // ConfirmDialog whose default focus lands on "Keep editing", so a
  // mistrigger loses no work.
  //
  // The pending state is a CONTEXT SNAPSHOT — the exact extraction id and
  // source object identity the confirmation was opened against — rather
  // than a boolean flag. The render-time dialog guard requires the
  // current extraction and source to be identity-equal to that snapshot,
  // so a mid-flight extraction swap (id change, reviewed_json refresh,
  // extracted_json refresh) closes the dialog on the very same render
  // that receives the new prop, before any effect fires. Boolean +
  // effect-based cleanup left a one-render window during which the old
  // dialog rendered against the new source; the context snapshot closes
  // that window at the render boundary. Lifecycle-cleanup effects still
  // clear the snapshot below as a belt-and-braces measure.
  const [discardContext, setDiscardContext] = useState<
    { extractionId: string; source: Record<string, unknown> } | null
  >(null);
  // Stable ref at the component top level so useFocusTrap installs against
  // the same ref object across renders (a per-render ref lands as null on
  // first commit and defeats the trap). Modal's own focus trap handles the
  // trigger-restore contract automatically via previouslyFocused, so no
  // trigger ref is needed here.
  const keepEditingRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    setDraft(source);
    setFieldErrors({});
    // A fresh extraction result replaces any in-progress edit. Belt-and-
    // braces cleanup of the pending discard context — the render-time
    // guard has already closed the dialog on this same commit; this
    // effect just prevents the stale snapshot from sitting on the panel
    // in case anything later re-references it.
    setDiscardContext(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [extraction?.id, extraction?.reviewed_json, extraction?.extracted_json]);

  // Whenever correction mode ends through any path (successful save,
  // external reset, extraction cleared), the pending snapshot must not
  // survive to resurface on the next reopen.
  useEffect(() => {
    if (!editing) setDiscardContext(null);
  }, [editing]);

  // Dirty predicate: identity-compare draft against source. Once the user
  // types into a RiskField, setFieldValue's structuredClone gives draft a
  // fresh identity; before then, useEffect keeps draft === source.
  const dirty = draft !== null && draft !== source;

  const applyDiscard = useCallback(() => {
    setEditing(false);
    setDraft(source);
    setFieldErrors({});
    setSaveError(null);
  }, [source]);

  const requestDiscard = useCallback(() => {
    if (dirty && source && extraction) {
      // Capture the exact correction context this confirmation was
      // opened against — extraction id and source reference. The
      // render-time guard below checks both by identity, so a
      // replacement extraction cannot satisfy the pending snapshot.
      setDiscardContext({ extractionId: extraction.id, source });
      return;
    }
    // No unsaved corrections — preserve the prior direct-close behaviour so
    // an untouched correction session exits without an unnecessary prompt.
    // Clean bypass does not create a pending context.
    applyDiscard();
  }, [dirty, applyDiscard, source, extraction]);

  const summary = (editing ? draft : source) as Record<string, unknown> | null;

  const visibleSections = useMemo(
    () =>
      SECTIONS.map((section) => ({
        ...section,
        present: section.fields.filter(([key]) =>
          isExtractionField((summary?.[section.key] as Record<string, unknown> | undefined)?.[key])
        ),
      })).filter((section) => section.present.length > 0),
    [summary]
  );

  const missingInformation = Array.isArray(summary?.missing_information)
    ? (summary!.missing_information as Record<string, unknown>[])
    : [];
  const redFlags = Array.isArray(summary?.red_flags)
    ? (summary!.red_flags as Record<string, unknown>[])
    : [];

  function setFieldValue(sectionKey: string, fieldKey: string, text: string) {
    const path = `${sectionKey}.${fieldKey}`;
    let parseError: string | null = null;
    setDraft((previous) => {
      if (!previous) return previous;
      const next = structuredClone(previous) as Record<string, Record<string, ExtractionField>>;
      const field = next[sectionKey]?.[fieldKey];
      if (field && isExtractionField(field)) {
        const parsed = parseReviewFieldValue(field.value, text);
        if (!parsed.ok) {
          parseError = parsed.error;
          return previous;
        }
        field.value = parsed.value;
      }
      return next as Record<string, unknown>;
    });
    setFieldErrors((previous) => {
      const next = { ...previous };
      if (parseError) next[path] = parseError;
      else delete next[path];
      return next;
    });
  }

  async function commit() {
    if (!draft || !extraction) return;
    if (Object.keys(fieldErrors).length > 0) {
      setSaveError("Fix the fields marked below before saving your corrections.");
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      await onSave(extraction.id, draft);
      setEditing(false);
    } catch {
      setSaveError("Your corrections could not be saved. Try again, or copy them somewhere safe first.");
    } finally {
      setSaving(false);
    }
  }

  // Render-time fail-closed guard bound to the correction context that
  // opened the confirmation. The dialog renders only when every one of
  // these holds at commit time:
  //   • a pending snapshot exists;
  //   • the panel is still in correction mode;
  //   • the draft is still dirty;
  //   • an extraction is still attached;
  //   • the current extraction id is IDENTITY-equal to the snapshot's;
  //   • the current source object is IDENTITY-equal to the snapshot's.
  // Reference equality on source (rather than JSON.stringify) means a
  // reviewed_json/extracted_json swap always changes the source's object
  // identity — the guard falls closed on the very same render that
  // receives the new prop, without waiting for the passive cleanup
  // effect to fire in a later commit.
  const discardDialogOpen =
    discardContext !== null &&
    editing &&
    dirty &&
    extraction !== null &&
    discardContext.extractionId === extraction.id &&
    discardContext.source === source;

  if (!extraction) {
    return (
      <Card>
        <EmptyState
          title="Atlas has not read the documents yet"
          body={
            canManage
              ? "Run the extraction to turn the attached documents and the broker email into a structured risk summary."
              : "An underwriting manager needs to run the extraction for this submission before the risk information appears here."
          }
          actions={
            canManage ? (
              <Button variant="primary" loading={extracting} loadingLabel="Extracting…" onClick={onExtract}>
                Run extraction
              </Button>
            ) : undefined
          }
        />
      </Card>
    );
  }

  return (
    <div className="atlas-stack">
      <ExtractionTrustSummary extraction={extraction} state={extractionConfidence} />

      {!reviewed && (
        <Notice tone="warning" title="This is an unreviewed extraction">
          Atlas read these values from the documents. They are not underwriting fact until a person has
          checked them. Correct anything wrong and save — the recommendation stays locked until you do.
        </Notice>
      )}

      {saveError && <Notice tone="danger">{saveError}</Notice>}

      <Card
        title="Extracted risk information"
        description={
          reviewed
            ? `Reviewed and confirmed by a person. Extracted ${formatDateTime(extraction.created_at)}.`
            : `Extracted ${formatDateTime(extraction.created_at)}. Not yet reviewed.`
        }
        actions={
          editing ? (
            <>
              <Button onClick={requestDiscard} disabled={saving}>
                Discard changes
              </Button>
              <Button variant="primary" onClick={commit} loading={saving} loadingLabel="Saving…">
                Save corrections
              </Button>
            </>
          ) : (
            <>
              <StatusBadge
                status={
                  reviewed
                    ? { label: "Reviewed", tone: "success", description: "Confirmed by an underwriter." }
                    : {
                        label: "Unreviewed",
                        tone: "warning",
                        description: "Read by Atlas, not yet confirmed by a person.",
                      }
                }
              />
              <Button icon="edit" onClick={() => setEditing(true)} disabled={!canWrite}>
                Correct values
              </Button>
            </>
          )
        }
      >
        {visibleSections.length === 0 ? (
          <EmptyState
            inline
            title="The extraction produced no structured fields"
            body="Atlas could not read usable risk information out of the attached documents. Check that the right documents are attached, then rerun the extraction."
          />
        ) : (
          visibleSections.map((section) => (
            <Block title={section.title} key={section.key}>
              <div className="atlas-fieldgrid">
                {section.present.map(([key, label]) => {
                  const field = (summary?.[section.key] as Record<string, ExtractionField>)[key];
                  return (
                    <RiskField
                      key={key}
                      label={label}
                      field={field}
                      reviewed={reviewed}
                      editing={editing}
                      error={fieldErrors[`${section.key}.${key}`]}
                      onChange={(text) => setFieldValue(section.key, key, text)}
                    />
                  );
                })}
              </div>
            </Block>
          ))
        )}
      </Card>

      {redFlags.length > 0 && (
        <Card
          title="Risk concerns"
          description="Raised by Atlas while reading the documents. Each one needs a human judgement."
        >
          <ul className="atlas-list">
            {redFlags.map((flag, index) => (
              <li className="atlas-list__item" key={index}>
                <div className="atlas-list__main">
                  <p className="atlas-list__title">{String(flag.issue ?? "Concern")}</p>
                  <p className="atlas-list__meta">{String(flag.reason ?? "")}</p>
                </div>
                <div className="atlas-list__side">
                  <StatusBadge status={severity(flag.severity as string | undefined)} />
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {missingInformation.length > 0 && (
        <Card
          title="Gaps identified during extraction"
          description="Information Atlas expected but could not find in the documents."
        >
          <ul className="atlas-list">
            {missingInformation.map((item, index) => (
              <li className="atlas-list__item" key={index}>
                <div className="atlas-list__main">
                  <p className="atlas-list__title">{String(item.field ?? "Missing information")}</p>
                  <p className="atlas-list__meta">{String(item.reason_required ?? "")}</p>
                </div>
                <div className="atlas-list__side">
                  <StatusBadge status={severity(item.priority as string | undefined)} />
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {/*
       * Discard-confirmation dialog. Only rendered when the user has typed
       * unsaved corrections and clicked "Discard changes". Initial focus
       * lands on "Keep editing" (the safe choice) so a mistrigger cannot be
       * doubled into an actual discard. On confirm, applyDiscard runs
       * exactly once — purely local state, no network — and Modal's focus
       * trap restores focus to whichever control opened the dialog. On
       * cancel or Escape, edits are preserved verbatim.
       */}
      <ConfirmDialog
        open={discardDialogOpen}
        title="Discard risk corrections?"
        destructive
        confirmLabel="Discard changes"
        cancelLabel="Keep editing"
        initialFocusRef={keepEditingRef}
        onCancel={() => setDiscardContext(null)}
        onConfirm={() => {
          // Clear the captured snapshot BEFORE applying the local revert
          // so a second Confirm press cannot fire against the closing
          // modal, and a stale callback cannot re-open against a
          // replacement source.
          setDiscardContext(null);
          applyDiscard();
        }}
        body={
          <p>Unsaved risk corrections will be lost. Previously saved values remain unchanged.</p>
        }
      />
    </div>
  );
}

function RiskField({
  label,
  field,
  reviewed,
  editing,
  error,
  onChange,
}: {
  label: string;
  field: ExtractionField;
  reviewed: boolean;
  editing: boolean;
  error?: string;
  onChange: (text: string) => void;
}) {
  const band = confidenceBand(field.status, field.confidence, reviewed);
  const display = formatFieldValue(field.value);
  const wide = isWideField(field.value);
  const isArray = Array.isArray(field.value) && field.value.length > 0;
  const [text, setText] = useState(() => reviewValueToEditorText(field.value));

  useEffect(() => {
    setText(reviewValueToEditorText(field.value));
  }, [field.value, editing]);

  const multiline = text.includes("\n");
  const hasEvidence = Boolean(
    field.source?.file_name || field.source?.snippet || field.source?.section || field.notes
  );

  return (
    <div className={`atlas-riskfield atlas-riskfield--${band.band}${wide ? " atlas-riskfield--wide" : ""}`}>
      <div className="atlas-riskfield__head">
        <span className="atlas-riskfield__label">{label}</span>
        <StatusBadge status={band} />
      </div>

      {editing ? (
        multiline ? (
          <textarea
            className={`atlas-textarea ${error ? "atlas-textarea--invalid" : ""}`}
            rows={Math.min(10, text.split("\n").length + 1)}
            value={text}
            aria-label={label}
            aria-invalid={error ? true : undefined}
            onChange={(event) => {
              setText(event.target.value);
              onChange(event.target.value);
            }}
          />
        ) : (
          <input
            className={`atlas-input ${error ? "atlas-input--invalid" : ""}`}
            value={text}
            aria-label={label}
            aria-invalid={error ? true : undefined}
            onChange={(event) => {
              setText(event.target.value);
              onChange(event.target.value);
            }}
          />
        )
      ) : isArray && !editing ? (
        <ul style={{ margin: 0, paddingLeft: 18, fontSize: "var(--atlas-fs-body)", color: "var(--atlas-ink)", lineHeight: 1.6 }}>
          {(field.value as unknown[]).map((item, i) => (
            <li key={i} style={{ marginBottom: 2 }}>{formatOne(item)}</li>
          ))}
        </ul>
      ) : (
        <p className={`atlas-riskfield__value ${display ? "" : "atlas-riskfield__value--empty"}`}>
          {display || "Not provided"}
        </p>
      )}

      {error && (
        <p className="atlas-field__error" role="alert">
          <Icon name="alert-triangle" size={13} />
          <span>{error}</span>
        </p>
      )}

      {hasEvidence && (
        <Disclosure summary="Where this came from">
          <SourceReference
            parts={[
              field.source?.file_name,
              field.source?.section,
              typeof field.source?.page === "number" ? `page ${field.source.page}` : null,
            ]}
            quote={field.source?.snippet}
            note={field.notes}
          />
        </Disclosure>
      )}
    </div>
  );
}
