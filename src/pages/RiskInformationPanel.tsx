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

import { useEffect, useMemo, useState } from "react";
import { parseReviewFieldValue, reviewValueToEditorText } from "../lib/review-edit";
import {
  Block,
  Button,
  Card,
  EmptyState,
  Notice,
  SourceReference,
  StatusBadge,
  Disclosure,
} from "../components/ui";
import { Icon } from "../components/Icon";
import { CONFIDENCE_BAND, confidenceBand, severity, type ConfidenceBand } from "../lib/status";
import { formatDateTime } from "../lib/format";

export interface ExtractionFieldSource {
  document_id?: string | null;
  file_name?: string | null;
  page?: number | null;
  section?: string | null;
  snippet?: string | null;
}

export interface ExtractionField {
  value: unknown;
  status?: string;
  confidence: number;
  source?: ExtractionFieldSource;
  notes?: string | null;
}

interface ExtractionRecord {
  id: string;
  extracted_json: Record<string, unknown> | null;
  reviewed_json: Record<string, unknown> | null;
  overall_confidence?: number;
  created_at?: string;
}

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

export function isExtractionField(value: unknown): value is ExtractionField {
  return (
    !!value &&
    typeof value === "object" &&
    "value" in (value as object) &&
    "confidence" in (value as object)
  );
}

/** Count fields whose confidence band falls into any of `bands`. */
export function countByBand(
  summary: Record<string, unknown> | null,
  reviewed: boolean,
  bands: ConfidenceBand[]
): number {
  if (!summary) return 0;
  let total = 0;
  const walk = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    if (isExtractionField(node)) {
      const { band } = confidenceBand(node.status, node.confidence, reviewed);
      if (bands.includes(band)) total += 1;
      return;
    }
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    Object.values(node as Record<string, unknown>).forEach(walk);
  };
  walk(summary);
  return total;
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
  canWrite,
  canManage,
  extracting,
  onExtract,
  onSave,
}: {
  submissionId: string;
  extraction: ExtractionRecord | null;
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

  useEffect(() => {
    setDraft(source);
    setFieldErrors({});
    // A fresh extraction result replaces any in-progress edit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [extraction?.id, extraction?.reviewed_json, extraction?.extracted_json]);

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

  const bandCounts = useMemo(() => {
    if (!summary) return {} as Record<ConfidenceBand, number>;
    const bands: ConfidenceBand[] = ["confirmed", "likely", "uncertain", "conflicting", "missing"];
    return Object.fromEntries(
      bands.map((band) => [band, countByBand(summary, reviewed, [band])])
    ) as Record<ConfidenceBand, number>;
  }, [summary, reviewed]);

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
              <Button
                onClick={() => {
                  setEditing(false);
                  setDraft(source);
                  setFieldErrors({});
                  setSaveError(null);
                }}
                disabled={saving}
              >
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
        <div className="atlas-actions" style={{ marginBottom: "var(--atlas-space-5)" }}>
          {(["confirmed", "likely", "uncertain", "conflicting", "missing"] as ConfidenceBand[])
            .filter((band) => (bandCounts[band] ?? 0) > 0)
            .map((band) => (
              <StatusBadge
                key={band}
                status={{
                  ...CONFIDENCE_BAND[band],
                  label: `${bandCounts[band]} ${CONFIDENCE_BAND[band].label.toLowerCase()}`,
                }}
              />
            ))}
        </div>

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
  const [text, setText] = useState(() => reviewValueToEditorText(field.value));

  useEffect(() => {
    setText(reviewValueToEditorText(field.value));
  }, [field.value, editing]);

  const multiline = text.includes("\n");
  const hasEvidence = Boolean(
    field.source?.file_name || field.source?.snippet || field.source?.section || field.notes
  );

  return (
    <div className={`atlas-riskfield atlas-riskfield--${band.band}`}>
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
