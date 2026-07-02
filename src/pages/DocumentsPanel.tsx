/**
 * Atlas Blueprint — improved DocumentsPanel
 * ----------------------------------------------------------------------------
 * REPLACE the existing DocumentsPanel function inside InsurerDetail.tsx with
 * this version. Same props, same name — drop-in. Three improvements:
 *
 *  1. Calls onChanged() immediately after upload completes (before processing
 *     starts), so the new document appears in the list without a manual
 *     refresh.
 *  2. Live elapsed-time counter while processing — "Reading the document —
 *     0:34 elapsed…" instead of a static "this can take a minute". Reassures
 *     the user it's still working.
 *  3. Per-document live timer when retry-processing too.
 *
 * Why not a true progress bar: Claude doesn't stream progress signals back
 * over a single /v1/messages call, so we have no actual progress %. An elapsed
 * counter is the honest equivalent — it shows the operation is alive.
 */

import { useEffect, useRef, useState } from "react";
import { uploadGuideline, processInsurerDocument, type InsurerDocument } from "../lib/insurers";

interface Props {
  insurerId: string;
  role: "underwriter" | "consultant" | "manager" | "admin" | "readonly";
  documents: InsurerDocument[];
  onChanged: () => void;
}

/** Format ms as M:SS for the live timer. */
function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r.toString().padStart(2, "0")}`;
}

/** Hook that ticks an elapsed timer while `active` is true. */
function useElapsed(active: boolean): number {
  const [now, setNow] = useState(0);
  const startedAt = useRef<number | null>(null);
  useEffect(() => {
    if (!active) { startedAt.current = null; setNow(0); return; }
    startedAt.current = Date.now();
    const id = window.setInterval(() => {
      if (startedAt.current) setNow(Date.now() - startedAt.current);
    }, 250);
    return () => window.clearInterval(id);
  }, [active]);
  return now;
}

export function DocumentsPanel({
  insurerId,
  role,
  documents,
  onChanged,
}: Props) {
  const canManage = role === "admin" || role === "manager";
  const [pending, setPending] = useState<File | null>(null);
  const [kind, setKind] = useState("guideline");
  const [phase, setPhase] = useState<"idle" | "uploading" | "processing">("idle");
  const [busy, setBusy] = useState<string | null>(null); // docId being processed via retry
  const [error, setError] = useState<string | null>(null);

  // Single elapsed clock used for whichever AI step is in flight.
  const processingActive = phase === "processing" || busy !== null;
  const elapsedMs = useElapsed(processingActive);

  async function onUpload() {
    if (!pending) return;
    setError(null);
    setPhase("uploading");
    try {
      const { document_id } = await uploadGuideline(insurerId, pending, kind);
      setPending(null);
      // (1) IMMEDIATELY refresh the document list so the new row appears
      // as "awaiting" / "processing" rather than waiting on the AI step.
      onChanged();

      setPhase("processing");
      try {
        await processInsurerDocument(document_id);
      } catch {
        // Failure is recorded on the document row; user can retry from the list.
      }
      setPhase("idle");
      onChanged();
    } catch {
      setError("Upload failed. Please try again.");
      setPhase("idle");
    }
  }

  async function onRetry(docId: string) {
    setBusy(docId);
    setError(null);
    try {
      await processInsurerDocument(docId);
    } catch {
      // ignore — the doc row will carry the failure reason
    }
    setBusy(null);
    onChanged();
  }

  const elapsedLabel = formatElapsed(elapsedMs);

  return (
    <>
      {canManage && (
        <div className="atlas-card atlas-form" style={{ marginBottom: 16 }}>
          <h3 className="atlas-h3">Upload guideline / wording</h3>
          <p className="atlas-muted">
            Atlas reads the PDF once and proposes appetite rules. Typical
            processing time: 30 seconds to 2 minutes depending on document size.
          </p>
          <div className="atlas-form__two">
            <div className="atlas-form__row">
              <label>Document kind</label>
              <select value={kind} onChange={(e) => setKind(e.target.value)}>
                <option value="guideline">Underwriting guideline</option>
                <option value="wording">Policy wording</option>
                <option value="appetite">Appetite document</option>
                <option value="other">Other</option>
              </select>
            </div>
            <div className="atlas-form__row">
              <label>File (PDF)</label>
              <input
                type="file"
                accept="application/pdf"
                onChange={(e) => setPending(e.target.files?.[0] ?? null)}
              />
            </div>
          </div>
          {error && <div className="atlas-inline-error">{error}</div>}
          <div className="atlas-form__actions">
            <button
              className="atlas-btn atlas-btn--primary"
              onClick={onUpload}
              disabled={!pending || phase !== "idle" || !!busy}
            >
              {phase === "uploading"
                ? "Uploading file…"
                : phase === "processing"
                ? `Reading the document — ${elapsedLabel} elapsed…`
                : busy
                ? `Reading another document — ${elapsedLabel} elapsed…`
                : "Upload and process"}
            </button>
          </div>
        </div>
      )}

      <div className="atlas-card">
        <h3 className="atlas-h3">Uploaded documents</h3>
        {documents.length === 0 ? (
          <p className="atlas-muted">No documents uploaded for this insurer yet.</p>
        ) : (
          <ul className="atlas-doclist">
            {documents.map((d) => (
              <li key={d.id} className="atlas-doclist__item">
                <div className="atlas-doclist__main">
                  <span className="atlas-doclist__name">{d.file_name}</span>
                  <span className="atlas-doc-meta">
                    {d.document_kind ?? "—"} ·{" "}
                    <DocStatusTag d={d} liveLabel={busy === d.id ? `processing · ${elapsedLabel}` : null} />
                    {d.processing_status === "processed" &&
                      ` · ${d.proposed_count} rules proposed`}
                    {d.processing_status === "failed" &&
                      d.processing_error &&
                      ` · ${d.processing_error}`}
                  </span>
                </div>
                {canManage &&
                  (d.processing_status === "failed" ||
                    d.processing_status === "awaiting_processing") && (
                    <button
                      className="atlas-btn atlas-btn--small"
                      onClick={() => onRetry(d.id)}
                      disabled={busy === d.id || phase !== "idle"}
                    >
                      {busy === d.id ? `Processing · ${elapsedLabel}` : "Process"}
                    </button>
                  )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}

function DocStatusTag({
  d,
  liveLabel,
}: {
  d: InsurerDocument;
  liveLabel: string | null;
}) {
  // If this document is the one being actively processed, override the static
  // label with the live one carrying the elapsed timer.
  if (liveLabel) {
    return <span className="atlas-doc-status atlas-doc-status--processing">{liveLabel}</span>;
  }
  const map: Record<InsurerDocument["processing_status"], { label: string; cls: string }> = {
    awaiting_processing: { label: "awaiting", cls: "atlas-doc-status--awaiting" },
    processing: { label: "processing…", cls: "atlas-doc-status--processing" },
    processed: { label: "processed", cls: "atlas-doc-status--processed" },
    failed: { label: "failed", cls: "atlas-doc-status--failed" },
  };
  const m = map[d.processing_status];
  return <span className={`atlas-doc-status ${m.cls}`}>{m.label}</span>;
}
