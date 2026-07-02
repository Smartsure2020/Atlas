/**
 * Atlas Blueprint — Audit timeline panel
 * ----------------------------------------------------------------------------
 * Per-submission timeline. Read-only. Renders the audit_logs rows in
 * chronological order with friendly labels per action type, the actor email
 * (or "system" for cron/automation rows), a timestamp, and a metadata
 * one-liner where helpful.
 *
 * The timeline lives in a collapsed `<details>` element by default — it
 * shouldn't dominate the page, but it should be one click away when a
 * manager wants to understand how a routing decision came to be.
 */

import { useEffect, useState } from "react";
import { getAuditTimeline, type AuditEvent } from "../lib/decisions";

/** Human-readable label for each action type. */
const ACTION_LABELS: Record<string, string> = {
  submission_created: "Submission created",
  document_uploaded: "Document uploaded",
  extraction_run: "Extraction run",
  extraction_denied: "Extraction denied (not a manager)",
  extraction_reviewed: "Extraction reviewed",
  recommendation_run: "Recommendation run",
  decision_accepted: "AI recommendation accepted",
  decision_overridden: "AI recommendation overridden",
  decision_override_ruled_out: "Overridden to a ruled-out insurer",
  decision_blocked_ruled_out_override: "Decision blocked (manager required)",
  email_draft_generated: "Email draft generated",
  insurer_created: "Insurer added",
  insurer_edited: "Insurer edited",
  insurer_document_uploaded: "Insurer guideline uploaded",
  insurer_document_processed: "Insurer guideline processed",
  appetite_confirmed: "Appetite rule confirmed",
  appetite_edited: "Appetite rule edited",
  appetite_deactivated: "Appetite rule deactivated",
  appetite_manual_added: "Manual appetite rule added",
  sign_in: "Signed in",
  dev_sign_in: "Dev sign-in",
};

const FRIENDLY = (action: string) => ACTION_LABELS[action] ?? action;

interface Props {
  submissionId: string;
  /** Bumps when the user does something that produces audit rows; refreshes
   *  the timeline without a manual reload. */
  refreshVersion?: number;
}

export default function AuditTimeline({ submissionId, refreshVersion = 0 }: Props) {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    (async () => {
      setLoading(true);
      try {
        const r = await getAuditTimeline(submissionId);
        if (active) setEvents(r.events);
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, [submissionId, refreshVersion]);

  return (
    <details className="atlas-card atlas-audit">
      <summary className="atlas-audit__summary">
        <span className="atlas-h3" style={{ margin: 0 }}>Audit timeline</span>
        <span className="atlas-muted" style={{ fontSize: 12 }}>
          {loading ? "…" : `${events.length} event${events.length === 1 ? "" : "s"}`}
        </span>
      </summary>

      {loading ? (
        <p className="atlas-muted">Loading…</p>
      ) : events.length === 0 ? (
        <p className="atlas-muted">No audit events for this submission yet.</p>
      ) : (
        <ol className="atlas-audit__list">
          {events.map((e) => (
            <li key={e.id} className="atlas-audit__item">
              <div className="atlas-audit__action">{FRIENDLY(e.action)}</div>
              <div className="atlas-audit__meta">
                <span>{e.actor_email ?? (e.actor_id ? "user" : "system")}</span>
                <span> · </span>
                <span>{new Date(e.created_at).toLocaleString()}</span>
              </div>
              {e.metadata !== null && typeof e.metadata === "object" &&
                Object.keys(e.metadata as object).length > 0 && (
                <details className="atlas-audit__meta-detail">
                  <summary>details</summary>
                  <pre>{JSON.stringify(e.metadata, null, 2)}</pre>
                </details>
              )}
            </li>
          ))}
        </ol>
      )}
    </details>
  );
}
