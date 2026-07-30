/**
 * Atlas — documents attached to a submission
 * ----------------------------------------------------------------------------
 * What Atlas read, what it could not read, and what has since expired. The
 * upload endpoints for client documents are exercised at intake; this tab is
 * the record of what is on file and the state of each item.
 */

import { Button, Card, EmptyState, Notice, StatusBadge } from "../components/ui";
import { Icon } from "../components/Icon";
import { EMPTY, formatDateTime, formatFileSize, truncateMiddle } from "../lib/format";
import { documentTypeLabel, scanStatus } from "../lib/status";

interface SubmissionDocument {
  id?: string;
  file_name?: string;
  document_type?: string | null;
  status?: string | null;
  scan_status?: string | null;
  size_bytes?: number | null;
  created_at?: string;
  expires_at?: string | null;
  uploaded_by_email?: string | null;
}

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
  const rows = documents as SubmissionDocument[];
  const active = rows.filter((document) => document.status !== "expired");
  const expired = rows.filter((document) => document.status === "expired");
  const quarantined = rows.filter((document) => document.scan_status === "infected");

  return (
    <div className="atlas-stack">
      {quarantined.length > 0 && (
        <Notice tone="danger" title="Some documents were quarantined">
          {quarantined.length} document{quarantined.length === 1 ? " was" : "s were"} flagged by the
          malware scan and cannot be read. Ask the broker to resend them.
        </Notice>
      )}

      <Card
        title="Client documents"
        description="Everything attached to this submission. Atlas reads active documents during extraction."
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
        {active.length === 0 ? (
          <EmptyState
            inline
            title="No documents are attached"
            body="Atlas has nothing to read for this submission. Documents are attached when the submission is created."
          />
        ) : (
          <ul className="atlas-list" aria-label="Attached documents">
            {active.map((document, index) => (
              <li className="atlas-doc" key={document.id ?? index}>
                <Icon name="document" size={18} className="atlas-doc__icon" />
                <div className="atlas-doc__main">
                  <p className="atlas-doc__name" title={document.file_name}>
                    {truncateMiddle(document.file_name ?? "Unnamed document", 60)}
                  </p>
                  <p className="atlas-doc__meta">
                    <span>{documentTypeLabel(document.document_type)}</span>
                    {document.size_bytes ? <span>{formatFileSize(document.size_bytes)}</span> : null}
                    <span>Added {formatDateTime(document.created_at)}</span>
                    {document.uploaded_by_email && <span>by {document.uploaded_by_email}</span>}
                  </p>
                </div>
                <div className="atlas-doc__side">
                  {document.scan_status && document.scan_status !== "clean" && (
                    <StatusBadge status={scanStatus(document.scan_status)} />
                  )}
                  <StatusBadge status={{ label: "On file", tone: "success" }} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {expired.length > 0 && (
        <Card
          title="Expired documents"
          description="Retention has removed the stored file. The extracted information stays on the record."
        >
          <ul className="atlas-list">
            {expired.map((document, index) => (
              <li className="atlas-doc" key={document.id ?? `expired-${index}`}>
                <Icon name="document" size={18} className="atlas-doc__icon" />
                <div className="atlas-doc__main">
                  <p className="atlas-doc__name" title={document.file_name}>
                    {truncateMiddle(document.file_name ?? "Unnamed document", 60)}
                  </p>
                  <p className="atlas-doc__meta">
                    <span>{documentTypeLabel(document.document_type)}</span>
                    <span>Expired {document.expires_at ? formatDateTime(document.expires_at) : EMPTY}</span>
                  </p>
                </div>
                <div className="atlas-doc__side">
                  <StatusBadge
                    status={{
                      label: "File expired",
                      tone: "neutral",
                      description: "The stored file has been removed under the retention policy.",
                    }}
                  />
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
