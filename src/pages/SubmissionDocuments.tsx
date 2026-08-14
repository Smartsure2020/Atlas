/**
 * Atlas — documents attached to a submission
 * ----------------------------------------------------------------------------
 * What Atlas read, what it could not read, and what has since expired. The
 * upload endpoints for client documents are exercised at intake; this tab is
 * the record of what is on file and the state of each item.
 *
 * Phase 6 re-groups the list by trust rather than presenting one flat table.
 * The order of concerns matters: a quarantined file is a security decision, a
 * scan still in progress is not yet decisive, an active document is what the
 * pipeline actually reads, and an expired document has lost its stored file
 * but keeps its extracted information on the record. Reading the sections
 * top-to-bottom should teach a person what state the submission's evidence
 * is in without them clicking on any row.
 */

import { useId, useMemo } from "react";
import { Button, Card, EmptyState, Notice, StatusBadge } from "../components/ui";
import { Icon } from "../components/Icon";
import { EMPTY, formatDateTime, formatFileSize, pluralise, truncateMiddle } from "../lib/format";
import { documentTypeLabel, scanStatus } from "../lib/status";
import {
  documentsTrustSummary,
  groupDocuments,
  type DocumentRow,
  type DocumentsTrustSummary,
} from "../lib/operations-evidence";

export default function DocumentsTab({
  documents,
  extraction,
  canManage,
  extracting,
  onExtract,
}: {
  documents: Record<string, unknown>[];
  extraction: { id: string; reviewed_json: Record<string, unknown> | null } | null;
  canManage: boolean;
  extracting: boolean;
  onExtract: () => void;
}) {
  const rows = documents as DocumentRow[];
  const groups = useMemo(() => groupDocuments(rows), [rows]);
  const summary = useMemo(() => documentsTrustSummary(rows), [rows]);

  const quarantined = groups.find((g) => g.key === "quarantined")?.documents ?? [];
  const pending = groups.find((g) => g.key === "scan_pending")?.documents ?? [];
  const active = groups.find((g) => g.key === "active")?.documents ?? [];
  const expired = groups.find((g) => g.key === "expired")?.documents ?? [];

  const headingId = useId();
  const showTrustStrip = summary.hasBlockingIssue || summary.scanPendingCount > 0;

  return (
    <section className="atlas-doc-groups" aria-labelledby={headingId}>
      <Card
        title="Client documents"
        description="Everything attached to this submission. Atlas reads active documents during extraction; quarantined and pending files are excluded until they clear."
        actions={
          canManage ? (
            <Button
              size="sm"
              icon="refresh"
              loading={extracting}
              loadingLabel="Extracting…"
              onClick={onExtract}
            >
              {extraction ? "Rerun extraction" : "Run extraction"}
            </Button>
          ) : undefined
        }
      >
        <span id={headingId} className="atlas-sr-only">
          Documents attached to this submission
        </span>

        {summary.total === 0 ? (
          <EmptyState
            inline
            title="No documents are attached"
            body="Atlas has nothing to read for this submission. Documents are attached when the submission is created."
          />
        ) : (
          <>
            {showTrustStrip && <TrustStrip summary={summary} />}

            {quarantined.length > 0 && (
              <QuarantineGroup documents={quarantined} />
            )}

            {pending.length > 0 && <ScanPendingGroup documents={pending} />}

            <ActiveGroup documents={active} />

            {expired.length > 0 && <ExpiredGroup documents={expired} />}
          </>
        )}
      </Card>
    </section>
  );
}

/* ===========================================================================
   Trust strip — a compact banner when evidence trust is imperfect.
   =========================================================================== */

function TrustStrip({ summary }: { summary: DocumentsTrustSummary }) {
  const parts: string[] = [];
  if (summary.quarantinedCount > 0) {
    parts.push(
      `${pluralise(summary.quarantinedCount, "document")} quarantined by malware scan`
    );
  }
  if (summary.scanFailedCount > 0) {
    parts.push(
      `${pluralise(summary.scanFailedCount, "document")} whose scan failed and needs a rerun`
    );
  }
  if (summary.scanPendingCount > 0) {
    parts.push(
      `${pluralise(summary.scanPendingCount, "scan")} still in progress`
    );
  }
  return (
    <Notice
      tone={summary.hasBlockingIssue ? "danger" : "warning"}
      title={
        summary.hasBlockingIssue
          ? "Some documents cannot be read yet"
          : "Some documents are still being scanned"
      }
    >
      {parts.join(". ") + "."}
    </Notice>
  );
}

/* ===========================================================================
   Section renderers — one per trust group.
   Copy is deliberately explicit about what Atlas has and has not done.
   =========================================================================== */

function QuarantineGroup({ documents }: { documents: DocumentRow[] }) {
  const n = documents.length;
  const noun = n === 1 ? "document" : "documents";
  const pronoun = n === 1 ? "it" : "them";
  const beVerb = n === 1 ? "is" : "are";
  return (
    <section className="atlas-doc-groups__section" aria-label="Quarantined documents">
      <h3 className="atlas-doc-groups__heading atlas-doc-groups__heading--danger">
        Quarantined by malware scan
      </h3>
      <p className="atlas-doc-groups__hint">
        {`${n} ${noun} could not be read because Atlas's malware scan flagged ${pronoun}. The ${
          n === 1 ? "file is" : "files are"
        } isolated; no extraction has run against ${pronoun}. Ask the broker to resend a clean copy.`}
        {` The stored ${noun} ${beVerb} kept out of the pipeline.`}
      </p>
      <DocumentList documents={documents} statusTone="quarantined" />
    </section>
  );
}

function ScanPendingGroup({ documents }: { documents: DocumentRow[] }) {
  const n = documents.length;
  const noun = n === 1 ? "document" : "documents";
  return (
    <section className="atlas-doc-groups__section" aria-label="Documents pending malware scan">
      <h3 className="atlas-doc-groups__heading atlas-doc-groups__heading--warning">
        Scan in progress
      </h3>
      <p className="atlas-doc-groups__hint">
        {`Atlas is still scanning ${n} ${noun} for malware. Extraction will run once the scan finishes.`}
      </p>
      <DocumentList documents={documents} statusTone="pending" />
    </section>
  );
}

function ActiveGroup({ documents }: { documents: DocumentRow[] }) {
  return (
    <section className="atlas-doc-groups__section" aria-label="Active documents">
      <h3 className="atlas-doc-groups__heading">Active documents</h3>
      {documents.length === 0 ? (
        <EmptyState
          inline
          title="No active documents are on file"
          body="Nothing here is currently readable — the sections above list the documents Atlas cannot use."
        />
      ) : (
        <DocumentList documents={documents} statusTone="active" />
      )}
    </section>
  );
}

function ExpiredGroup({ documents }: { documents: DocumentRow[] }) {
  return (
    <section className="atlas-doc-groups__section" aria-label="Expired documents">
      <h3 className="atlas-doc-groups__heading">
        Expired documents (file removed under retention)
      </h3>
      <p className="atlas-doc-groups__hint">
        The stored file is no longer available under the retention policy. Any information Atlas
        extracted from it before expiry is retained on the submission record.
      </p>
      <DocumentList documents={documents} statusTone="expired" />
    </section>
  );
}

/* ===========================================================================
   Row renderer — one implementation for every group, with the visible
   badge chosen from the semantic tone the group carries.
   =========================================================================== */

type StatusTone = "active" | "pending" | "quarantined" | "expired";

function DocumentList({
  documents,
  statusTone,
}: {
  documents: DocumentRow[];
  statusTone: StatusTone;
}) {
  return (
    <ul className="atlas-list" aria-label="Documents">
      {documents.map((document, index) => (
        <li className="atlas-doc" key={document.id ?? `${statusTone}-${index}`}>
          <Icon name="document" size={18} className="atlas-doc__icon" />
          <div className="atlas-doc__main">
            <p className="atlas-doc__name" title={document.file_name}>
              {truncateMiddle(document.file_name ?? "Unnamed document", 60)}
            </p>
            <p className="atlas-doc__meta">
              <span>{documentTypeLabel(document.document_type)}</span>
              {document.size_bytes ? <span>{formatFileSize(document.size_bytes)}</span> : null}
              <span>{addedLabel(document, statusTone)}</span>
              {document.uploaded_by_email && <span>by {document.uploaded_by_email}</span>}
            </p>
          </div>
          <div className="atlas-doc__side">
            <RowStatus document={document} tone={statusTone} />
          </div>
        </li>
      ))}
    </ul>
  );
}

function addedLabel(document: DocumentRow, tone: StatusTone): string {
  if (tone === "expired") {
    return document.expires_at
      ? `Expired ${formatDateTime(document.expires_at)}`
      : "Retention date not recorded";
  }
  return document.created_at ? `Added ${formatDateTime(document.created_at)}` : `Added ${EMPTY}`;
}

/**
 * Group tone decides the badge on the row — never invent a green "On file"
 * badge for a document Atlas has not actually scanned clean, and never show
 * "on file" for a document whose stored file is gone.
 */
function RowStatus({ document, tone }: { document: DocumentRow; tone: StatusTone }) {
  if (tone === "quarantined") {
    return <StatusBadge status={scanStatus("infected")} />;
  }
  if (tone === "pending") {
    return <StatusBadge status={scanStatus("pending")} />;
  }
  if (tone === "expired") {
    return (
      <StatusBadge
        status={{
          label: "File expired",
          tone: "neutral",
          description: "The stored file is no longer available under the retention policy.",
        }}
      />
    );
  }
  // Active tone: only claim "On file" when the scan says clean or was not
  // reported at all. A "failed" scan is surfaced explicitly rather than
  // silently promoted to green — the reader must decide whether to trust it.
  const scan = document.scan_status;
  if (!scan || scan === "clean") {
    return <StatusBadge status={{ label: "On file", tone: "success" }} />;
  }
  return <StatusBadge status={scanStatus(scan)} />;
}
