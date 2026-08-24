/**
 * Atlas — new submission intake
 * ----------------------------------------------------------------------------
 * Captures the request, the broker's email, and the client documents, then
 * creates the submission and uploads each file.
 *
 * The Phase 7 rewrite makes intake retry-safe. The old flow held the
 * submissionId in a local `let` inside onSubmit and dropped it whenever an
 * upload rejected, so a second click re-hit createSubmission and produced a
 * duplicate record. This version:
 *
 *   1. Anchors every create decision to `submissionIdRef` — the id lives in a
 *      ref (and its mirror state) that persists across renders. The moment
 *      createSubmission returns, the ref is populated; every subsequent
 *      click on the primary button routes to a retry loop over just the
 *      remaining files, and never touches createSubmission again.
 *   2. Tracks per-file upload status by a stable `clientId`, so a retry
 *      only re-tries what actually failed. React keys and remove-by-id
 *      match, so removing a file cannot steal focus from the row above.
 *   3. Presents the partial state honestly. The recovery notice says the
 *      submission was created and names how many files still need to
 *      upload — never "open the submission and add them there" (that
 *      screen has no upload control), and never labels the whole intake
 *      as failed while a submissionId exists.
 *
 * Note: no HTML <form> element — plain controlled inputs and an explicit
 * submit handler, matching the rest of the codebase.
 */

import { useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { createSubmission, uploadDocument } from "../lib/atlas";
import {
  Button,
  Card,
  ConfirmDialog,
  Field,
  IconButton,
  Notice,
  PageHeader,
  ProgressStages,
  SelectField,
  StatusBadge,
  TextAreaField,
  TextField,
} from "../components/ui";
import { Icon } from "../components/Icon";
import { formatFileSize, pluralise, truncateMiddle } from "../lib/format";
import { DOCUMENT_TYPE_OPTIONS, LINE_OF_BUSINESS_OPTIONS } from "../lib/status";
import {
  assignClientIds,
  intakePhaseSummary,
  remainingUploads,
  type IntakePhase,
  type PendingFile,
} from "../lib/intake-intelligence";

const MAX_FILE_BYTES = 25 * 1024 * 1024;

export default function NewSubmission({
  onCreated,
  onCancel,
}: {
  onCreated: (id: string) => void;
  onCancel: () => void;
}) {
  const [form, setForm] = useState({
    broker_name: "",
    broker_email: "",
    client_name: "",
    request_type: "",
    broker_email_body: "",
    line_of_business: "commercial" as "personal" | "commercial",
  });
  const [files, setFiles] = useState<PendingFile[]>([]);
  const [phase, setPhase] = useState<IntakePhase>({ kind: "idle" });
  const [error, setError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [leaveOpen, setLeaveOpen] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  // The submissionId lives here so a second click on the primary button
  // never re-hits createSubmission. Once set, the intake is committed;
  // only the uploads can retry. The mirrored state exists so a future
  // render branch (e.g. surfacing the id in a dev-only diagnostic) can
  // read it without reaching into a ref — the ref is the authoritative
  // guard against re-entrant creates.
  const submissionIdRef = useRef<string | null>(null);
  const [, setSubmissionId] = useState<string | null>(null);
  // Synchronous operation lock. Set BEFORE the first await inside
  // onSubmit and cleared in finally. This closes the pre-resolution
  // race a phase-state guard alone cannot: a second click that arrives
  // while createSubmission is still pending never enters the create
  // branch, so a duplicate submission is impossible even if the button
  // disabled state is bypassed. The disabled UI remains as a visible
  // secondary safeguard.
  const operationLockRef = useRef(false);
  // Guard against re-entrant onCreated calls: the effect that transitions
  // the phase to "complete" would otherwise call onCreated on every render
  // after the last upload landed.
  const notifiedRef = useRef(false);

  const working =
    phase.kind === "creating" || phase.kind === "uploading";
  const clientMissing = touched && !form.client_name.trim();
  const summary = useMemo(() => intakePhaseSummary(phase, files), [phase, files]);

  function set<K extends keyof typeof form>(key: K, value: (typeof form)[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  function addFiles(list: FileList | null) {
    if (!list) return;
    if (working) return;
    const existing = new Set(files.map((item) => `${item.file.name}:${item.file.size}`));
    const kept: File[] = [];
    for (const file of Array.from(list)) {
      const signature = `${file.name}:${file.size}`;
      if (existing.has(signature)) continue;
      existing.add(signature);
      kept.push(file);
    }
    if (kept.length === 0) return;
    const added = assignClientIds(kept).map((item) => ({
      ...item,
      problem: describeFileProblem(item.file),
    }));
    setFiles((current) => [...current, ...added]);
  }

  function removeFile(clientId: string) {
    setFiles((current) => current.filter((entry) => entry.clientId !== clientId));
  }

  function retypeFile(clientId: string, type: string) {
    setFiles((current) =>
      current.map((entry) => (entry.clientId === clientId ? { ...entry, type } : entry))
    );
  }

  function updateFile(clientId: string, patch: (entry: PendingFile) => PendingFile) {
    setFiles((current) => current.map((entry) => (entry.clientId === clientId ? patch(entry) : entry)));
  }

  const blockingFiles = files.filter((item) => item.problem);

  async function runUploads(id: string) {
    // Only touch files that actually still need to upload. A retry never
    // re-uploads a file that already landed.
    const queue = remainingUploads(files);
    let index = 0;
    let sawFailure = false;
    // Local snapshot of what happened this run, keyed by clientId. We
    // never re-derive counts from React state inside the updater callback
    // because that violates the "updaters must be pure" contract and
    // makes the side effects (setPhase, onCreated) run twice under
    // StrictMode. Instead the loop maintains the authoritative record
    // itself, and setPhase / onCreated are called from the effect body
    // after the loop.
    const outcomes = new Map<string, "uploaded" | "failed">();

    for (const entry of queue) {
      index += 1;
      setPhase({ kind: "uploading", index, total: queue.length, name: entry.file.name });
      updateFile(entry.clientId, (item) => ({ ...item, upload: { status: "uploading" } }));
      try {
        await uploadDocument(id, entry.file, entry.type);
        // flushSync so the row's "uploaded" badge appears before the
        // next iteration's "uploading" transition — the UI has always
        // looked committed step-by-step and we keep that behaviour.
        flushSync(() => {
          updateFile(entry.clientId, (item) => ({ ...item, upload: { status: "uploaded" } }));
        });
        outcomes.set(entry.clientId, "uploaded");
      } catch (cause) {
        sawFailure = true;
        const message =
          (cause as Error).message === "not_authenticated"
            ? "Your session expired mid-upload. Sign in again to retry."
            : "The upload failed. Try again.";
        flushSync(() => {
          updateFile(entry.clientId, (item) => ({
            ...item,
            upload: { status: "failed", error: message },
          }));
        });
        outcomes.set(entry.clientId, "failed");
        // Halt the loop — leave remaining files as pending so the retry
        // button attempts them together with the failed one on the next
        // click. This keeps the behaviour predictable when the network is
        // flapping.
        break;
      }
    }

    // Compute counts from the loop's authoritative record + the
    // pre-loop file list. `files` may still reflect earlier state, but
    // any file whose clientId is in `outcomes` has a known result;
    // anything else keeps its prior status. Everything below runs in
    // the effect body — no setState inside a setState updater.
    let failedCount = 0;
    let pendingCount = 0;
    for (const entry of files) {
      const outcome = outcomes.get(entry.clientId);
      if (outcome === "failed") {
        failedCount += 1;
        continue;
      }
      if (outcome === "uploaded") continue;
      if (entry.upload.status === "failed") failedCount += 1;
      else if (entry.upload.status === "pending") pendingCount += 1;
    }

    if (sawFailure || pendingCount > 0) {
      setPhase({
        kind: "partial",
        submissionId: id,
        failedCount,
        remainingCount: pendingCount,
      });
    } else {
      setPhase({ kind: "complete", submissionId: id });
      if (!notifiedRef.current) {
        notifiedRef.current = true;
        onCreated(id);
      }
    }
  }

  async function onSubmit() {
    // Synchronous lock: a second entry while any intake operation is in
    // flight returns immediately. This runs before any await, so it
    // closes the pre-resolution race that would otherwise let a second
    // click reach createSubmission a second time.
    if (operationLockRef.current) return;
    operationLockRef.current = true;
    try {
      setTouched(true);
      if (!form.client_name.trim()) {
        setError("Add the client name before creating the submission.");
        return;
      }
      if (blockingFiles.length > 0) {
        setError("Remove the documents flagged below before creating the submission.");
        return;
      }
      setError(null);

      // Entry guard: if the submission already exists, this is a retry —
      // never re-hit createSubmission.
      if (submissionIdRef.current !== null) {
        await runUploads(submissionIdRef.current);
        return;
      }

      setPhase({ kind: "creating" });
      try {
        const { id } = await createSubmission(form);
        submissionIdRef.current = id;
        setSubmissionId(id);
      } catch (cause) {
        const message = (cause as Error).message;
        setPhase({ kind: "idle" });
        setError(
          message === "not_authenticated"
            ? "Your session has expired. Sign in again and re-enter the submission."
            : "The submission could not be created. The Atlas API rejected the request."
        );
        return;
      }

      const id = submissionIdRef.current;
      if (!id) return;

      if (files.length === 0) {
        // No attachments — the submission exists, so we're done.
        setPhase({ kind: "complete", submissionId: id });
        if (!notifiedRef.current) {
          notifiedRef.current = true;
          onCreated(id);
        }
        return;
      }

      await runUploads(id);
    } finally {
      operationLockRef.current = false;
    }
  }

  function requestCancel() {
    if (phase.kind === "partial") {
      setLeaveOpen(true);
      return;
    }
    onCancel();
  }

  const primaryLabel =
    phase.kind === "partial" ? "Retry remaining uploads" : "Create submission";
  const primaryLoadingLabel =
    phase.kind === "uploading"
      ? `Uploading ${phase.index} of ${phase.total}…`
      : phase.kind === "creating"
      ? "Creating submission…"
      : "Uploading…";

  return (
    <div>
      {/*
       * The bottom action row is the true contextual pair for this
       * form. The header used to duplicate them ~120 px above the first
       * field, which read as two identical primary buttons on the same
       * page. Now the header only carries a back link so the origin
       * queue is one click away — the create/cancel controls sit next
       * to the form fields they belong to.
       */}
      <PageHeader
        breadcrumbs={[{ label: "Work queue", onClick: requestCancel }, { label: "New submission" }]}
        title="New submission"
        description="Capture the broker request and attach the client documents. Atlas reads them during extraction."
        actions={
          <Button variant="link" icon="arrow-right" onClick={requestCancel} disabled={working}>
            Back to work queue
          </Button>
        }
      />

      <div className="atlas-stack" style={{ maxWidth: 880 }}>
        {error && (
          <Notice
            tone="danger"
            title="The submission was not completed"
            actions={
              <Button size="sm" onClick={() => setError(null)}>
                Dismiss
              </Button>
            }
          >
            {error}
          </Notice>
        )}

        {phase.kind === "partial" && (
          <Notice
            tone="warning"
            title={summary.headline}
            actions={
              <Button
                size="sm"
                icon="refresh"
                variant="primary"
                onClick={onSubmit}
                loading={working}
                loadingLabel="Uploading…"
              >
                Retry remaining uploads
              </Button>
            }
          >
            The submission itself is on file — a fresh Create would only produce a duplicate.
            {phase.failedCount > 0 && (
              <>
                {" "}
                {pluralise(phase.failedCount, "document")} could not be uploaded.
              </>
            )}
            {phase.remainingCount > 0 && (
              <>
                {" "}
                {pluralise(phase.remainingCount, "document")}{" "}
                {phase.remainingCount === 1 ? "still needs" : "still need"} to upload.
              </>
            )}{" "}
            Only the outstanding files will be sent when you retry.
          </Notice>
        )}

        {phase.kind === "complete" && (
          <Notice tone="success" title={summary.headline}>
            The submission is on file and every document was uploaded.
          </Notice>
        )}

        <Card title="Request details">
          <div className="atlas-form">
            <div className="atlas-form__grid">
              <SelectField
                label="Line of business"
                required
                value={form.line_of_business}
                options={LINE_OF_BUSINESS_OPTIONS}
                hint="The workflow is the same for both. Insurer guidelines determine the underwriting rules."
                onChange={(event) =>
                  set("line_of_business", event.target.value as "personal" | "commercial")
                }
              />
              <TextField
                label="Request type"
                value={form.request_type}
                placeholder="Buildings, motor fleet, sectional title…"
                onChange={(event) => set("request_type", event.target.value)}
              />
            </div>

            <TextField
              label="Client name"
              required
              value={form.client_name}
              error={clientMissing ? "The client name identifies this submission everywhere in Atlas." : null}
              onChange={(event) => set("client_name", event.target.value)}
            />

            <div className="atlas-form__grid">
              <TextField
                label="Broker name"
                optional
                value={form.broker_name}
                onChange={(event) => set("broker_name", event.target.value)}
              />
              <TextField
                label="Broker email address"
                optional
                type="email"
                value={form.broker_email}
                onChange={(event) => set("broker_email", event.target.value)}
              />
            </div>

            <TextAreaField
              label="Broker email"
              optional
              rows={7}
              value={form.broker_email_body}
              placeholder="Paste the broker's message here."
              hint="Atlas reads the email alongside the documents during extraction, so paste it in full."
              onChange={(event) => set("broker_email_body", event.target.value)}
            />
          </div>
        </Card>

        <Card
          title="Client documents"
          description="PDF only, up to 25 MB each. Classify each document so extraction knows what it is reading."
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
                addFiles(event.dataTransfer.files);
              }}
            >
              <Icon name="upload" size={22} />
              <p className="atlas-filedrop__title">Drop PDF documents here</p>
              <p className="atlas-filedrop__hint">
                Policy schedules, proposal forms, claims histories, and supporting material.
              </p>
              <Button onClick={() => fileInput.current?.click()} disabled={working}>
                Choose files
              </Button>
              <input
                ref={fileInput}
                type="file"
                multiple
                accept="application/pdf"
                aria-label="Select submission documents"
                // Removed from sequential focus: the visible
                // "Choose files" Button is the only intended
                // keyboard entry point. Programmatic click via
                // fileInput.current?.click() still works, and
                // assistive tech can still discover the input by
                // its accessible name.
                tabIndex={-1}
                className="atlas-sr-only"
                onChange={(event) => {
                  addFiles(event.target.files);
                  event.target.value = "";
                }}
              />
            </div>

            {files.length > 0 && (
              <ul className="atlas-list" aria-label="Documents to upload">
                {files.map((item) => {
                  const uploaded = item.upload.status === "uploaded";
                  const failed = item.upload.status === "failed";
                  const uploading = item.upload.status === "uploading";
                  return (
                    <li
                      className="atlas-doc"
                      key={item.clientId}
                      aria-label={`${item.file.name} (${uploadStatusLabel(item.upload.status)})`}
                    >
                      <Icon name="document" size={18} className="atlas-doc__icon" />
                      <div className="atlas-doc__main">
                        <p className="atlas-doc__name" title={item.file.name}>
                          {truncateMiddle(item.file.name, 52)}
                        </p>
                        <p className="atlas-doc__meta">
                          <span>{formatFileSize(item.file.size)}</span>
                          {item.problem && (
                            <span style={{ color: "var(--atlas-danger-ink)" }}>{item.problem}</span>
                          )}
                          {failed && item.upload.status === "failed" && (
                            <span style={{ color: "var(--atlas-danger-ink)" }}>
                              {item.upload.error}
                            </span>
                          )}
                        </p>
                      </div>
                      <div className="atlas-doc__side">
                        <Field label="Document type" htmlFor={`doc-type-${item.clientId}`}>
                          <select
                            id={`doc-type-${item.clientId}`}
                            className="atlas-select atlas-select--sm"
                            value={item.type}
                            disabled={working || uploaded}
                            onChange={(event) => retypeFile(item.clientId, event.target.value)}
                          >
                            {DOCUMENT_TYPE_OPTIONS.map((option) => (
                              <option key={option.value} value={option.value}>
                                {option.label}
                              </option>
                            ))}
                          </select>
                        </Field>
                        <StatusBadge status={uploadStatusMeta(item.upload.status)} />
                        {!uploaded && (
                          <IconButton
                            icon="close"
                            label={`Remove ${item.file.name}`}
                            disabled={working || uploading}
                            onClick={() => removeFile(item.clientId)}
                          />
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}

            {phase.kind === "uploading" && (
              <ProgressStages
                percent={Math.round((phase.index / phase.total) * 100)}
                caption={`Uploading ${truncateMiddle(phase.name, 36)} (${phase.index} of ${phase.total})`}
              />
            )}
          </div>
        </Card>

        <div className="atlas-actions atlas-actions--end">
          <Button onClick={requestCancel} disabled={working}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={onSubmit}
            loading={working}
            loadingLabel={primaryLoadingLabel}
          >
            {primaryLabel}
          </Button>
        </div>
      </div>

      <ConfirmDialog
        open={leaveOpen && phase.kind === "partial"}
        destructive={false}
        title="Leave without retrying the outstanding uploads?"
        confirmLabel="Leave the intake"
        cancelLabel="Stay and retry"
        working={false}
        onCancel={() => setLeaveOpen(false)}
        onConfirm={() => {
          setLeaveOpen(false);
          onCancel();
        }}
        body={
          <>
            <p>
              The submission itself is safe — it has already been created and cannot be
              duplicated by leaving. Uploads that succeeded remain attached.
            </p>
            <p style={{ marginTop: 8 }}>
              Anything still failed or pending will not be sent when you leave, and this screen
              cannot be reopened to retry the same session's outstanding uploads. A manager can
              upload the missing documents later from the submission itself.
            </p>
          </>
        }
      />
    </div>
  );
}

function describeFileProblem(file: File): string | undefined {
  if (file.size > MAX_FILE_BYTES) {
    return `Larger than the 25 MB limit (${formatFileSize(file.size)}).`;
  }
  if (file.type && file.type !== "application/pdf") {
    return "Atlas reads PDF documents only.";
  }
  return undefined;
}

function uploadStatusMeta(status: PendingFile["upload"]["status"]) {
  switch (status) {
    case "uploaded":
      return { label: "Uploaded", tone: "success" as const };
    case "uploading":
      return { label: "Uploading…", tone: "info" as const };
    case "failed":
      return {
        label: "Upload failed",
        tone: "danger" as const,
        description: "Retry from the notice above.",
      };
    case "pending":
    default:
      return { label: "Not yet uploaded", tone: "neutral" as const };
  }
}

function uploadStatusLabel(status: PendingFile["upload"]["status"]): string {
  return uploadStatusMeta(status).label;
}

