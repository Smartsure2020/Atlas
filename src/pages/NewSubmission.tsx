/**
 * Atlas — new submission intake
 * ----------------------------------------------------------------------------
 * Captures the request, the broker's email, and the client documents, then
 * creates the submission and uploads each file.
 *
 * The upload area is a real drop zone with per-file classification and removal,
 * because misclassified documents are the most common cause of a poor
 * extraction. Nothing is created until the user commits.
 *
 * Note: no HTML <form> element — plain controlled inputs and an explicit
 * submit handler, matching the rest of the codebase.
 */

import { useRef, useState } from "react";
import { createSubmission, uploadDocument } from "../lib/atlas";
import {
  Button,
  Card,
  Field,
  IconButton,
  Notice,
  PageHeader,
  ProgressStages,
  SelectField,
  TextAreaField,
  TextField,
} from "../components/ui";
import { Icon } from "../components/Icon";
import { formatFileSize, truncateMiddle } from "../lib/format";
import { DOCUMENT_TYPE_OPTIONS, LINE_OF_BUSINESS_OPTIONS } from "../lib/status";
import { guessDocumentType } from "../lib/intake-intelligence";

const MAX_FILE_BYTES = 25 * 1024 * 1024;

interface PendingFile {
  file: File;
  type: string;
  /** Set when the file cannot be uploaded as-is. */
  problem?: string;
}

type UploadPhase =
  | { kind: "idle" }
  | { kind: "creating" }
  | { kind: "uploading"; index: number; total: number; name: string };

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
  const [phase, setPhase] = useState<UploadPhase>({ kind: "idle" });
  const [error, setError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const working = phase.kind !== "idle";
  const clientMissing = touched && !form.client_name.trim();

  function set<K extends keyof typeof form>(key: K, value: (typeof form)[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  function addFiles(list: FileList | null) {
    if (!list) return;
    const existing = new Set(files.map((item) => `${item.file.name}:${item.file.size}`));
    const added: PendingFile[] = [];
    for (const file of Array.from(list)) {
      const signature = `${file.name}:${file.size}`;
      if (existing.has(signature)) continue;
      existing.add(signature);
      added.push({
        file,
        type: guessDocumentType(file.name),
        problem:
          file.size > MAX_FILE_BYTES
            ? `Larger than the 25 MB limit (${formatFileSize(file.size)}).`
            : file.type && file.type !== "application/pdf"
            ? "Atlas reads PDF documents only."
            : undefined,
      });
    }
    if (added.length > 0) setFiles((current) => [...current, ...added]);
  }

  const blockingFiles = files.filter((item) => item.problem);

  async function onSubmit() {
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
    setPhase({ kind: "creating" });
    let submissionId: string | null = null;
    try {
      const { id } = await createSubmission(form);
      submissionId = id;
      for (let index = 0; index < files.length; index += 1) {
        const item = files[index];
        setPhase({ kind: "uploading", index: index + 1, total: files.length, name: item.file.name });
        await uploadDocument(id, item.file, item.type);
      }
      onCreated(id);
    } catch (cause) {
      const message = (cause as Error).message;
      setPhase({ kind: "idle" });
      if (submissionId) {
        // The record exists; only the attachments failed. Say so precisely,
        // and offer the way forward rather than stranding the user here.
        setError(
          "The submission was created, but one or more documents failed to upload. " +
            "Open the submission and add the remaining documents there."
        );
      } else {
        setError(
          message === "not_authenticated"
            ? "Your session has expired. Sign in again and re-enter the submission."
            : "The submission could not be created. The Atlas API rejected the request."
        );
      }
    }
  }

  return (
    <div>
      <PageHeader
        breadcrumbs={[{ label: "Work queue", onClick: onCancel }, { label: "New submission" }]}
        title="New submission"
        description="Capture the broker request and attach the client documents. Atlas reads them during extraction."
        actions={
          <>
            <Button onClick={onCancel} disabled={working}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={onSubmit}
              loading={working}
              loadingLabel={
                phase.kind === "uploading"
                  ? `Uploading ${phase.index} of ${phase.total}…`
                  : "Creating submission…"
              }
            >
              Create submission
            </Button>
          </>
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
                className="atlas-sr-only"
                onChange={(event) => {
                  addFiles(event.target.files);
                  event.target.value = "";
                }}
              />
            </div>

            {files.length > 0 && (
              <ul className="atlas-list" aria-label="Documents to upload">
                {files.map((item, index) => (
                  <li className="atlas-doc" key={`${item.file.name}-${index}`}>
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
                      </p>
                    </div>
                    <div className="atlas-doc__side">
                      <Field label="Document type" htmlFor={`doc-type-${index}`}>
                        <select
                          id={`doc-type-${index}`}
                          className="atlas-select atlas-select--sm"
                          value={item.type}
                          disabled={working}
                          onChange={(event) =>
                            setFiles((current) =>
                              current.map((entry, entryIndex) =>
                                entryIndex === index ? { ...entry, type: event.target.value } : entry
                              )
                            )
                          }
                        >
                          {DOCUMENT_TYPE_OPTIONS.map((option) => (
                            <option key={option.value} value={option.value}>
                              {option.label}
                            </option>
                          ))}
                        </select>
                      </Field>
                      <IconButton
                        icon="close"
                        label={`Remove ${item.file.name}`}
                        disabled={working}
                        onClick={() =>
                          setFiles((current) => current.filter((_, entryIndex) => entryIndex !== index))
                        }
                      />
                    </div>
                  </li>
                ))}
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
          <Button onClick={onCancel} disabled={working}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={onSubmit}
            loading={working}
            loadingLabel={
              phase.kind === "uploading"
                ? `Uploading ${phase.index} of ${phase.total}…`
                : "Creating submission…"
            }
          >
            Create submission
          </Button>
        </div>
      </div>
    </div>
  );
}

