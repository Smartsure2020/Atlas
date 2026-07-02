/**
 * Atlas Blueprint — New Submission screen
 * ----------------------------------------------------------------------------
 * Captures intake details, the pasted broker email, and document uploads, then
 * creates the submission and uploads each file. After this the submission sits
 * in the dashboard's "new" column awaiting a manager extraction.
 *
 * Note: no HTML <form> element (per the React artifact constraints) — plain
 * controlled inputs and an onClick handler.
 */

import { useState } from "react";
import { createSubmission, uploadDocument } from "../lib/atlas";

const DOC_TYPES = [
  ["broker_email", "Broker email"],
  ["policy_schedule", "Policy schedule"],
  ["proposal_form", "Proposal form"],
  ["claims_history", "Claims history"],
  ["vehicle_schedule", "Vehicle schedule"],
  ["building_schedule", "Building schedule"],
  ["supporting", "Supporting document"],
];

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
  });
  const [files, setFiles] = useState<{ file: File; type: string }[]>([]);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function set<K extends keyof typeof form>(k: K, v: string) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  function addFiles(list: FileList | null) {
    if (!list) return;
    const added = Array.from(list).map((file) => ({ file, type: "supporting" }));
    setFiles((prev) => [...prev, ...added]);
  }

  async function onSubmit() {
    setWorking(true);
    setError(null);
    try {
      const { id } = await createSubmission(form);
      for (const f of files) {
        await uploadDocument(id, f.file, f.type);
      }
      onCreated(id);
    } catch (e) {
      const msg = (e as Error).message;
      setError(
        msg.startsWith("upload_failed")
          ? "The submission was created, but a document upload failed. Please try uploading the document again."
          : "Could not create the submission. Please try again."
      );
      setWorking(false);
    }
  }

  return (
    <div>
      <button className="atlas-btn" onClick={onCancel} style={{ marginBottom: 16 }}>
        ← Cancel
      </button>

      <div className="atlas-page-head">
        <h1>New submission</h1>
        <p>Capture the request and attach the broker’s documents.</p>
      </div>

      <div className="atlas-card atlas-form">
        <div className="atlas-form__row">
          <label>Client name</label>
          <input value={form.client_name} onChange={(e) => set("client_name", e.target.value)} />
        </div>
        <div className="atlas-form__row">
          <label>Request type</label>
          <input
            value={form.request_type}
            placeholder="e.g. Buildings, Motor fleet, Sectional title"
            onChange={(e) => set("request_type", e.target.value)}
          />
        </div>
        <div className="atlas-form__two">
          <div className="atlas-form__row">
            <label>Broker name</label>
            <input value={form.broker_name} onChange={(e) => set("broker_name", e.target.value)} />
          </div>
          <div className="atlas-form__row">
            <label>Broker email</label>
            <input value={form.broker_email} onChange={(e) => set("broker_email", e.target.value)} />
          </div>
        </div>
        <div className="atlas-form__row">
          <label>Broker email (paste the message)</label>
          <textarea
            rows={6}
            value={form.broker_email_body}
            placeholder="Paste the broker’s email here — it’s read alongside the documents during extraction."
            onChange={(e) => set("broker_email_body", e.target.value)}
          />
        </div>

        <div className="atlas-form__row">
          <label>Documents (PDF)</label>
          <input type="file" multiple accept="application/pdf" onChange={(e) => addFiles(e.target.files)} />
          {files.length > 0 && (
            <ul className="atlas-uploadlist">
              {files.map((f, i) => (
                <li key={i}>
                  <span>{f.file.name}</span>
                  <select
                    value={f.type}
                    onChange={(e) =>
                      setFiles((prev) =>
                        prev.map((x, xi) => (xi === i ? { ...x, type: e.target.value } : x))
                      )
                    }
                  >
                    {DOC_TYPES.map(([v, label]) => (
                      <option key={v} value={v}>{label}</option>
                    ))}
                  </select>
                  <button
                    className="atlas-btn atlas-btn--small"
                    onClick={() => setFiles((prev) => prev.filter((_, xi) => xi !== i))}
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {error && <div className="atlas-inline-error">{error}</div>}

        <div className="atlas-form__actions">
          <button className="atlas-btn" onClick={onCancel}>Cancel</button>
          <button
            className="atlas-btn atlas-btn--primary"
            onClick={onSubmit}
            disabled={working || !form.client_name}
          >
            {working ? "Creating…" : "Create submission"}
          </button>
        </div>
      </div>
    </div>
  );
}
