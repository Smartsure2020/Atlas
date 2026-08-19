/**
 * Atlas — insurer guideline documents
 * ----------------------------------------------------------------------------
 * Upload a guideline, watch Atlas read it, retry when it fails.
 *
 * Progress here is genuinely unknowable: reading a PDF is a single call to the
 * AI provider that does not stream progress back. Rather than inventing a
 * percentage, the UI names the stage and shows elapsed time, which is the honest
 * signal that something is still alive.
 *
 * The list polls only while a document is actually queued or processing.
 */

import { useEffect, useRef, useState } from "react";
import { processInsurerDocument, uploadGuideline, type InsurerDocument } from "../lib/insurers";
import { presentGuidelineResult } from "../lib/intake-intelligence";
import {
  Button,
  Card,
  EmptyState,
  Notice,
  ProgressStages,
  SelectField,
  StatusBadge,
  useToast,
} from "../components/ui";
import { Icon } from "../components/Icon";
import { documentProcessing, scanStatus } from "../lib/status";
import { formatDateTime, formatElapsed, formatFileSize, pluralise, truncateMiddle } from "../lib/format";

const DOCUMENT_KINDS = [
  { value: "guideline", label: "Underwriting guideline" },
  { value: "wording", label: "Policy wording" },
  { value: "appetite", label: "Appetite document" },
  { value: "other", label: "Other" },
];

const MAX_FILE_BYTES = 25 * 1024 * 1024;

/** Ticks an elapsed counter while `active` is true. */
function useElapsed(active: boolean): number {
  const [elapsed, setElapsed] = useState(0);
  const startedAt = useRef<number | null>(null);

  useEffect(() => {
    if (!active) {
      startedAt.current = null;
      setElapsed(0);
      return;
    }
    startedAt.current = Date.now();
    const timer = window.setInterval(() => {
      if (startedAt.current) setElapsed(Date.now() - startedAt.current);
    }, 500);
    return () => window.clearInterval(timer);
  }, [active]);

  return elapsed;
}

export function DocumentsPanel({
  insurerId,
  canManage,
  documents,
  onChanged,
}: {
  insurerId: string;
  canManage: boolean;
  documents: InsurerDocument[];
  onChanged: () => void;
}) {
  const toast = useToast();
  const [pending, setPending] = useState<File | null>(null);
  const [kind, setKind] = useState("guideline");
  const [phase, setPhase] = useState<"idle" | "uploading" | "processing">("idle");
  const [retrying, setRetrying] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const busy = phase !== "idle" || retrying !== null;
  const elapsed = useElapsed(phase === "processing" || retrying !== null);

  // Poll only while the server says something is in flight.
  useEffect(() => {
    const inFlight = documents.some(
      (document) =>
        document.processing_status === "awaiting_processing" ||
        document.processing_status === "processing"
    );
    if (!inFlight) return;
    const timer = window.setInterval(onChanged, 3000);
    return () => window.clearInterval(timer);
  }, [documents, onChanged]);

  function chooseFile(file: File | null) {
    setError(null);
    if (!file) {
      setPending(null);
      return;
    }
    if (file.size > MAX_FILE_BYTES) {
      setError(`That file is ${formatFileSize(file.size)}. The limit is 25 MB.`);
      setPending(null);
      return;
    }
    if (file.type && file.type !== "application/pdf") {
      setError("Atlas reads PDF guidelines only. Convert the document and try again.");
      setPending(null);
      return;
    }
    const duplicate = documents.find((document) => document.file_name === file.name);
    if (duplicate) {
      setError(
        `A document called "${file.name}" is already on file for this insurer. Uploading it again will propose the same rules a second time.`
      );
    }
    setPending(file);
  }

  async function onUpload() {
    if (!pending) return;
    setError(null);
    setPhase("uploading");
    try {
      const { document_id } = await uploadGuideline(insurerId, pending, kind);
      setPending(null);
      // Surface the new row immediately, before the slow AI step starts.
      onChanged();

      setPhase("processing");
      try {
        const response = await processInsurerDocument(document_id);
        const presentation = presentGuidelineResult(response);
        toast.notify(presentation.message, toastToneFor(presentation.tone));
      } catch {
        // The failure is recorded on the document row; the list offers a retry.
        setError(
          "The document uploaded, but Atlas could not read it. Use Read again on the row below, or check the file is not a scan without text."
        );
      }
      setPhase("idle");
      onChanged();
    } catch (cause) {
      setError(
        (cause as Error).message === "manager_only"
          ? "Only an underwriting manager can upload guidelines."
          : "The upload failed before the file reached storage. Check your connection and try again."
      );
      setPhase("idle");
    }
  }

  async function onRetry(documentId: string) {
    setRetrying(documentId);
    setError(null);
    try {
      const response = await processInsurerDocument(documentId);
      const presentation = presentGuidelineResult(response);
      toast.notify(presentation.message, toastToneFor(presentation.tone));
    } catch {
      setError(
        "Atlas could not read that document. The failure reason is on the row below — a scanned PDF without a text layer is the usual cause."
      );
    } finally {
      setRetrying(null);
      onChanged();
    }
  }

  const failed = documents.filter((document) => document.processing_status === "failed");

  return (
    <div className="atlas-stack">
      {error && (
        <Notice
          tone={phase === "idle" ? "warning" : "danger"}
          title="About this upload"
          actions={
            <Button size="sm" onClick={() => setError(null)}>
              Dismiss
            </Button>
          }
        >
          {error}
        </Notice>
      )}

      {failed.length > 0 && (
        <Notice tone="warning" title={`${pluralise(failed.length, "document")} could not be read`}>
          Any appetite rules in {failed.length === 1 ? "it" : "them"} are missing from the matrix, so
          recommendations may be scored against an incomplete picture of this insurer's appetite.
        </Notice>
      )}

      {canManage && (
        <Card
          title="Upload a guideline"
          description="Atlas reads the document once and proposes appetite rules for you to confirm. Reading typically takes 30 seconds to 2 minutes."
        >
          <div className="atlas-form">
            <div
              className={`atlas-filedrop ${dragging ? "atlas-filedrop--over" : ""}`}
              onDragOver={(event) => {
                event.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(event) => {
                event.preventDefault();
                setDragging(false);
                chooseFile(event.dataTransfer.files?.[0] ?? null);
              }}
            >
              <Icon name="upload" size={22} />
              <p className="atlas-filedrop__title">
                {pending ? truncateMiddle(pending.name, 48) : "Drop a PDF guideline here"}
              </p>
              <p className="atlas-filedrop__hint">
                {pending
                  ? formatFileSize(pending.size)
                  : "Underwriting guidelines, policy wordings, or appetite documents. PDF, up to 25 MB."}
              </p>
              <div className="atlas-actions">
                <Button onClick={() => fileInput.current?.click()} disabled={busy}>
                  {pending ? "Choose a different file" : "Choose file"}
                </Button>
                {pending && (
                  <Button variant="ghost" onClick={() => setPending(null)} disabled={busy}>
                    Remove
                  </Button>
                )}
              </div>
              <input
                ref={fileInput}
                type="file"
                accept="application/pdf"
                className="atlas-sr-only"
                onChange={(event) => {
                  chooseFile(event.target.files?.[0] ?? null);
                  event.target.value = "";
                }}
              />
            </div>

            <SelectField
              label="Document type"
              value={kind}
              options={DOCUMENT_KINDS}
              hint="Helps Atlas interpret the document's structure when it extracts rules."
              onChange={(event) => setKind(event.target.value)}
            />

            {phase !== "idle" && (
              <ProgressStages
                percent={null}
                caption={
                  phase === "uploading"
                    ? "Uploading the file to storage"
                    : `Atlas is reading the document — ${formatElapsed(elapsed)} elapsed`
                }
              />
            )}

            <div className="atlas-actions atlas-actions--end">
              <Button
                variant="primary"
                disabled={!pending || busy}
                loading={phase !== "idle"}
                loadingLabel={phase === "uploading" ? "Uploading…" : "Reading document…"}
                onClick={onUpload}
              >
                Upload and read guideline
              </Button>
            </div>
          </div>
        </Card>
      )}

      <Card
        title="Guideline documents"
        description="Everything on file for this insurer, and whether Atlas managed to read it."
      >
        {documents.length === 0 ? (
          <EmptyState
            inline
            title="No guidelines have been uploaded"
            body={
              canManage
                ? "Atlas cannot recommend this insurer until it has read a guideline and a manager has confirmed the resulting rules."
                : "Ask an underwriting manager to upload this insurer's guideline before running recommendations."
            }
          />
        ) : (
          <ul className="atlas-list" aria-label="Guideline documents">
            {documents.map((document) => {
              const isRetrying = retrying === document.id;
              const canRead =
                canManage &&
                (document.processing_status === "failed" ||
                  document.processing_status === "awaiting_processing") &&
                document.scan_status !== "pending" &&
                document.scan_status !== "infected";
              return (
                <li className="atlas-doc" key={document.id}>
                  <Icon name="document" size={18} className="atlas-doc__icon" />
                  <div className="atlas-doc__main">
                    <p className="atlas-doc__name" title={document.file_name}>
                      {truncateMiddle(document.file_name, 56)}
                    </p>
                    <p className="atlas-doc__meta">
                      <span>
                        {DOCUMENT_KINDS.find((item) => item.value === document.document_kind)?.label ??
                          "Guideline"}
                      </span>
                      <span>Added {formatDateTime(document.created_at)}</span>
                      {document.processing_status === "processed" && (
                        <span>{pluralise(document.proposed_count, "rule")} proposed</span>
                      )}
                      {document.processed_at && document.processing_status === "processed" && (
                        <span>Read {formatDateTime(document.processed_at)}</span>
                      )}
                    </p>
                    {isRetrying && (
                      <div style={{ marginTop: 6, maxWidth: 320 }}>
                        <ProgressStages
                          percent={null}
                          caption={`Reading the document — ${formatElapsed(elapsed)} elapsed`}
                        />
                      </div>
                    )}
                    {document.processing_status === "failed" && document.processing_error && (
                      <p className="atlas-jobrow__error" style={{ marginTop: 4 }}>
                        {document.processing_error}
                      </p>
                    )}
                  </div>
                  <div className="atlas-doc__side">
                    {document.scan_status &&
                      document.scan_status !== "clean" &&
                      document.scan_status !== "not_scanned" && (
                        <StatusBadge status={scanStatus(document.scan_status)} />
                      )}
                    <StatusBadge
                      status={
                        isRetrying
                          ? { label: "Reading document", tone: "info" }
                          : documentProcessing(document.processing_status)
                      }
                    />
                    {canRead && (
                      <Button
                        size="sm"
                        icon="refresh"
                        disabled={busy}
                        loading={isRetrying}
                        loadingLabel="Reading…"
                        onClick={() => onRetry(document.id)}
                      >
                        {document.processing_status === "failed" ? "Read again" : "Read now"}
                      </Button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </div>
  );
}

/**
 * Toast tones support "default", not "info", so map the neutral guideline
 * presentations onto the platform's toast palette.
 */
function toastToneFor(
  tone: "success" | "info" | "warning" | "danger"
): "default" | "success" | "warning" | "danger" {
  return tone === "info" ? "default" : tone;
}
