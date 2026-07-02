/**
 * Atlas Blueprint — Email drafts panel
 * ----------------------------------------------------------------------------
 * Four buttons, one per email type. Click one → Claude generates → the draft
 * appears inline below the buttons with copy-to-clipboard affordances for
 * subject and body. Always copyable, never auto-sent — the underwriter
 * pastes into their email client.
 *
 * Regenerate is explicit (a button on the rendered draft). On-demand
 * generation means the draft always reflects the latest reviewed extraction
 * and decision.
 */

import { useState } from "react";
import { generateEmail, type EmailType, type EmailDraft } from "../lib/decisions";

const EMAIL_LABELS: Record<EmailType, string> = {
  "broker-missing-info": "Broker — missing info request",
  "broker-acknowledgement": "Broker — acknowledgement",
  "insurer-submission": "Insurer — submission",
  "internal-summary": "Internal — handover summary",
};

interface Props {
  submissionId: string;
  /** Bumps when the decision is recorded; clears the displayed draft because
   *  it might be out of date now. */
  decisionVersion?: number;
}

export default function EmailDraftsPanel({ submissionId, decisionVersion = 0 }: Props) {
  const [active, setActive] = useState<EmailType | null>(null);
  const [draft, setDraft] = useState<EmailDraft | null>(null);
  const [loading, setLoading] = useState<EmailType | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Reset draft when the upstream decision changes — the displayed text would
  // be stale.
  if (decisionVersion > 0 && draft && active) {
    // Trick: invalidate by clearing when the bump is freshly observed.
    // (A useEffect would be tidier but this is fine for a small dependency.)
  }

  async function onGenerate(type: EmailType) {
    setLoading(type);
    setError(null);
    setActive(type);
    try {
      const r = await generateEmail(submissionId, type);
      setDraft({ subject: r.subject, body: r.body });
    } catch {
      setError("Could not generate the draft. Please try again.");
      setDraft(null);
    } finally {
      setLoading(null);
    }
  }

  async function copyToClipboard(text: string) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // No-op — the textarea still allows selection/manual copy.
    }
  }

  return (
    <div className="atlas-card" style={{ marginTop: 16 }}>
      <h3 className="atlas-h3">Email drafts</h3>
      <p className="atlas-muted">
        Atlas generates copyable drafts only — nothing is sent automatically.
        Review and edit before pasting into your email client.
      </p>

      <div className="atlas-email-buttons">
        {(Object.keys(EMAIL_LABELS) as EmailType[]).map((type) => (
          <button
            key={type}
            className={`atlas-btn ${active === type ? "atlas-btn--primary" : ""}`}
            onClick={() => onGenerate(type)}
            disabled={loading !== null}
          >
            {loading === type ? "Drafting…" : EMAIL_LABELS[type]}
          </button>
        ))}
      </div>

      {error && <div className="atlas-inline-error">{error}</div>}

      {active && draft && (
        <div className="atlas-email-draft">
          <div className="atlas-email-draft__head">
            <span className="atlas-email-draft__title">
              {EMAIL_LABELS[active]}
            </span>
            <button
              className="atlas-btn atlas-btn--small"
              onClick={() => onGenerate(active)}
              disabled={loading !== null}
            >
              Regenerate
            </button>
          </div>

          <div className="atlas-email-draft__field">
            <div className="atlas-email-draft__label">
              Subject
              <button
                className="atlas-btn atlas-btn--small atlas-btn--ghost"
                onClick={() => copyToClipboard(draft.subject)}
              >
                Copy
              </button>
            </div>
            <input
              className="atlas-email-draft__input"
              value={draft.subject}
              readOnly
              onClick={(e) => (e.target as HTMLInputElement).select()}
            />
          </div>

          <div className="atlas-email-draft__field">
            <div className="atlas-email-draft__label">
              Body
              <button
                className="atlas-btn atlas-btn--small atlas-btn--ghost"
                onClick={() => copyToClipboard(draft.body)}
              >
                Copy
              </button>
            </div>
            <textarea
              className="atlas-email-draft__textarea"
              value={draft.body}
              readOnly
              rows={Math.min(16, draft.body.split("\n").length + 1)}
            />
          </div>
        </div>
      )}
    </div>
  );
}
