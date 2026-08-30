/**
 * PipelineQuickDrawer — read-only operational preview of a submission.
 *
 * Uses the existing accessible Drawer (focus trap + Escape via ui.tsx). Fires
 * getSubmissionQuick() only when opened with an id, and guards against races:
 * a slow response for a superseded id or a closed drawer never overwrites the
 * currently-visible content.
 *
 * Never mutates. Never calls underwriting endpoints. The full workspace
 * remains the place for assignment / lifecycle / decision changes.
 */

import { useEffect, useRef, useState } from "react";
import { Button, Drawer, KeyValue, Notice, Skeleton, StatusBadge } from "./ui";
import { getSubmissionQuick, type QuickSubmissionResponse } from "../lib/atlas";
import { pipelineStage, priority as priorityStatus, queueStatus, lineOfBusinessLabel } from "../lib/status";
import { formatDate, formatDateTime, submissionReference, EMPTY } from "../lib/format";
import { stageAgeMs } from "../lib/pipeline";
import type { AtlasUiRole } from "./AppShell";

interface Props {
  submissionId: string | null;
  role: AtlasUiRole;
  onClose: () => void;
  onOpenFull: (id: string) => void;
}

type State =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; data: QuickSubmissionResponse }
  | { kind: "error"; message: string; notFound?: boolean };

function friendlyAction(action: string): string {
  switch (action) {
    case "created":
      return "Created";
    case "assigned":
      return "Assigned";
    case "reassigned":
      return "Reassigned";
    case "unassigned":
      return "Unassigned";
    case "stage_changed":
    case "pipeline_stage_changed":
      return "Stage changed";
    case "document_uploaded":
      return "Document uploaded";
    case "extraction_completed":
      return "Extraction completed";
    default:
      return action.split("_").join(" ").replace(/^./, (c: string) => c.toUpperCase());
  }
}

function formatStageAge(ms: number | null): string {
  if (ms == null) return "";
  const days = Math.floor(ms / (1000 * 60 * 60 * 24));
  if (days > 1) return `In this stage for ${days} days`;
  if (days === 1) return "In this stage for 1 day";
  const hours = Math.floor(ms / (1000 * 60 * 60));
  if (hours >= 1) return `In this stage for ${hours}h`;
  return "In this stage for under 1h";
}

export default function PipelineQuickDrawer({ submissionId, role, onClose, onOpenFull }: Props) {
  const [state, setState] = useState<State>({ kind: "idle" });
  // A monotonically incrementing token guards against stale responses winning
  // a race after a later id supersedes them or the drawer is closed.
  const requestSeqRef = useRef(0);
  const currentIdRef = useRef<string | null>(null);

  useEffect(() => {
    currentIdRef.current = submissionId;
    if (!submissionId) {
      setState({ kind: "idle" });
      return;
    }
    const seq = ++requestSeqRef.current;
    setState({ kind: "loading" });
    getSubmissionQuick(submissionId)
      .then((data) => {
        if (seq !== requestSeqRef.current) return;
        if (currentIdRef.current !== submissionId) return;
        setState({ kind: "ready", data });
      })
      .catch((cause: Error) => {
        if (seq !== requestSeqRef.current) return;
        if (currentIdRef.current !== submissionId) return;
        const msg = cause.message || "";
        if (msg === "not_authenticated") {
          setState({
            kind: "error",
            message: "Your session has expired. Sign in again to preview the submission.",
          });
          return;
        }
        if (/^http_(404|403)/.test(msg)) {
          setState({ kind: "error", notFound: true, message: "Submission unavailable." });
          return;
        }
        setState({
          kind: "error",
          message: "The submission preview could not be loaded.",
        });
      });
  }, [submissionId]);

  const open = submissionId !== null;

  return (
    <Drawer
      open={open}
      title="Submission preview"
      description="Read-only pipeline snapshot. Use the full workspace to edit."
      onClose={onClose}
      size="md"
      footer={
        submissionId ? (
          <>
            <Button variant="ghost" onClick={onClose}>
              Close
            </Button>
            <Button
              variant="primary"
              iconAfter="chevron-right"
              onClick={() => onOpenFull(submissionId)}
            >
              Open full workspace
            </Button>
          </>
        ) : undefined
      }
    >
      {state.kind === "loading" && (
        <div className="atlas-stack">
          <Skeleton />
          <Skeleton />
          <Skeleton />
          <Skeleton />
        </div>
      )}
      {state.kind === "error" && (
        <Notice tone={state.notFound ? "warning" : "danger"} title={state.notFound ? "Submission unavailable" : "Preview failed"}>
          {state.message}
        </Notice>
      )}
      {state.kind === "ready" && (
        <QuickContent data={state.data} role={role} />
      )}
    </Drawer>
  );
}

function QuickContent({ data, role }: { data: QuickSubmissionResponse; role: AtlasUiRole }) {
  const s = data.submission;
  const ageMs = stageAgeMs({ last_pipeline_stage_changed_at: s.last_pipeline_stage_changed_at });
  const isBroker = role === "broker";

  const identityItems = [
    { key: "Client", value: s.client_name || "Untitled submission" },
    { key: "Reference", value: submissionReference(s.id) },
    { key: "Source", value: s.source_type ? s.source_type[0].toUpperCase() + s.source_type.slice(1) : EMPTY },
    { key: "Request type", value: s.request_type || EMPTY },
  ];

  const processItems = [
    {
      key: "Pipeline stage",
      value: (
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <StatusBadge status={pipelineStage(s.pipeline_stage)} />
          {s.pipeline_stage != null && ageMs != null && (
            <span className="atlas-text-muted" style={{ fontSize: 12 }}>
              {formatStageAge(ageMs)}
            </span>
          )}
          {s.pipeline_stage == null && (
            <span className="atlas-text-muted" style={{ fontSize: 12 }}>Not initialised</span>
          )}
        </div>
      ),
    },
    { key: "Queue state", value: <StatusBadge status={queueStatus(s.queue_status)} /> },
    { key: "Priority", value: <StatusBadge status={priorityStatus(s.priority)} /> },
    { key: "Line of business", value: s.line_of_business ? lineOfBusinessLabel(s.line_of_business) : "Unclassified" },
    { key: "Complexity", value: s.complexity ? (s.complexity === "complex" ? "Complex" : "Standard") : EMPTY },
  ];

  const ownershipItems = [
    {
      key: "Assigned to",
      value: s.assigned_to_email ? s.assigned_to_email : <span className="atlas-text-muted">Shared queue</span>,
    },
  ];

  const timingItems = [
    {
      key: "Received",
      value: s.received_at ? formatDateTime(s.received_at) : <span className="atlas-text-muted">Not recorded</span>,
    },
    {
      key: "Created",
      value: s.created_at ? formatDate(s.created_at) : EMPTY,
    },
    {
      key: "Due",
      value: s.due_at ? formatDate(s.due_at) : EMPTY,
    },
    {
      key: "Last movement",
      value: s.updated_at ? formatDateTime(s.updated_at) : EMPTY,
    },
    {
      key: "Stage age",
      value: ageMs == null ? EMPTY : formatStageAge(ageMs),
    },
  ];

  // Bounded history — max 8 entries in the drawer.
  const historyPreview = (data.history || []).slice(0, 8);

  return (
    <div className="atlas-stack">
      <section>
        <h3 className="atlas-title-sub">Identity</h3>
        <KeyValue items={identityItems} />
      </section>

      <section>
        <h3 className="atlas-title-sub">Process</h3>
        <KeyValue items={processItems} />
      </section>

      <section>
        <h3 className="atlas-title-sub">Ownership</h3>
        <KeyValue items={ownershipItems} />
      </section>

      <section>
        <h3 className="atlas-title-sub">Timing</h3>
        <KeyValue items={timingItems} />
      </section>

      <section>
        <h3 className="atlas-title-sub">Documents</h3>
        <p>
          <strong>{data.documents.total}</strong> total
        </p>
        <ul className="atlas-text-muted" style={{ margin: 0, paddingLeft: "1.2em" }}>
          {data.documents.clean > 0 && <li>{data.documents.clean} clean</li>}
          {data.documents.pending_scan > 0 && <li>{data.documents.pending_scan} scan pending</li>}
          {data.documents.failed > 0 && (
            <li style={{ color: "var(--atlas-color-danger)" }}>
              {data.documents.failed} failed scan (operational warning)
            </li>
          )}
          {data.documents.total === 0 && <li>No documents attached.</li>}
        </ul>
      </section>

      <section>
        <h3 className="atlas-title-sub">Recent history</h3>
        {historyPreview.length === 0 ? (
          <p className="atlas-text-muted">No recent activity.</p>
        ) : (
          <ul style={{ margin: 0, paddingLeft: "1.2em" }}>
            {historyPreview.map((h) => (
              <li key={h.id}>
                <span>{friendlyAction(h.action)}</span>
                <span className="atlas-text-muted" style={{ marginLeft: 6, fontSize: 12 }}>
                  {formatDateTime(h.created_at)}
                  {h.actor_email ? ` · ${h.actor_email}` : " · Actor not recorded"}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {!isBroker && data.assignment_events && data.assignment_events.length > 0 && (
        <section>
          <h3 className="atlas-title-sub">Assignment activity</h3>
          <ul style={{ margin: 0, paddingLeft: "1.2em" }}>
            {data.assignment_events.slice(0, 5).map((event) => (
              <li key={event.id}>
                <span>Assignment changed</span>
                <span className="atlas-text-muted" style={{ marginLeft: 6, fontSize: 12 }}>
                  {formatDateTime(event.created_at)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
