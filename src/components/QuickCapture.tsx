/**
 * QuickCapture — minimal broker/underwriter submission-create sheet.
 *
 * Uses the canonical createSubmission() helper (never a second POST path).
 * Never accepts identity/assignment/stage fields — the server owns those.
 *
 * Duplicate protection combines a synchronous ref lock (blocks re-entry
 * BEFORE the first await commits) with the visible disabled/loading state.
 */

import { useRef, useState } from "react";
import { Button, Modal, Notice, SelectField, TextField } from "./ui";
import { createSubmission } from "../lib/atlas";
import { LINE_OF_BUSINESS_OPTIONS } from "../lib/status";

interface Props {
  open: boolean;
  onClose: () => void;
  onCreated: (id: string) => void;
}

type LOB = "personal" | "commercial";

export default function QuickCapture({ open, onClose, onCreated }: Props) {
  const [clientName, setClientName] = useState("");
  const [lob, setLob] = useState<LOB | "">("");
  const [requestType, setRequestType] = useState("");
  const [brokerName, setBrokerName] = useState("");
  const [brokerEmail, setBrokerEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Synchronous lock so a double-activation cannot enter createSubmission
  // twice before React commits the disabled state.
  const inflightRef = useRef(false);

  function reset() {
    setClientName("");
    setLob("");
    setRequestType("");
    setBrokerName("");
    setBrokerEmail("");
    setError(null);
  }

  async function onSubmit() {
    if (inflightRef.current) return;
    if (!clientName.trim()) {
      setError("Client name is required.");
      return;
    }
    if (!lob) {
      setError("Line of business is required.");
      return;
    }
    inflightRef.current = true;
    setSubmitting(true);
    setError(null);
    try {
      const res = await createSubmission({
        client_name: clientName.trim(),
        line_of_business: lob,
        ...(requestType.trim() ? { request_type: requestType.trim() } : {}),
        ...(brokerName.trim() ? { broker_name: brokerName.trim() } : {}),
        ...(brokerEmail.trim() ? { broker_email: brokerEmail.trim() } : {}),
      });
      reset();
      onCreated(res.id);
    } catch (cause) {
      const msg = (cause as Error).message || "";
      if (msg === "not_authenticated") {
        setError("Your session has expired. Sign in again to submit.");
      } else {
        setError("The submission could not be created. Please try again.");
      }
    } finally {
      inflightRef.current = false;
      setSubmitting(false);
    }
  }

  // Single dismissal path: Cancel, X, Escape, and outside-click MUST all clear
  // entered values before firing onClose. Reopening a dismissed sheet must
  // start blank — anything else lets a broker's abandoned draft appear when
  // an underwriter opens the sheet on a shared device.
  const dismiss = () => {
    if (submitting) return;
    reset();
    onClose();
  };

  return (
    <Modal
      open={open}
      title="Quick capture"
      onClose={dismiss}
      footer={
        <>
          <Button variant="ghost" onClick={dismiss} disabled={submitting}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={onSubmit}
            loading={submitting}
            loadingLabel="Creating…"
            disabled={submitting || !clientName.trim() || !lob}
          >
            Create submission
          </Button>
        </>
      }
    >
      <div className="atlas-stack">
        {error && (
          <Notice tone="danger" title="Could not create submission">
            {error}
          </Notice>
        )}
        <TextField
          label="Client name"
          required
          value={clientName}
          onChange={(e) => setClientName(e.target.value)}
        />
        <SelectField
          label="Line of business"
          required
          value={lob}
          onChange={(e) => setLob(e.target.value as LOB | "")}
          options={[
            { value: "", label: "Select…" },
            ...LINE_OF_BUSINESS_OPTIONS.map((o) => ({ value: o.value, label: o.label })),
          ]}
        />
        <TextField
          label="Request type"
          optional
          value={requestType}
          onChange={(e) => setRequestType(e.target.value)}
        />
        <TextField
          label="Broker name"
          optional
          value={brokerName}
          onChange={(e) => setBrokerName(e.target.value)}
        />
        <TextField
          label="Broker email"
          optional
          type="email"
          value={brokerEmail}
          onChange={(e) => setBrokerEmail(e.target.value)}
        />
      </div>
    </Modal>
  );
}
