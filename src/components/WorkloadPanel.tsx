/**
 * WorkloadPanel — manager/admin-only underwriter workload snapshot.
 *
 * Fires the /api/pipeline/workload request only when rendered. Callers MUST
 * gate on role so non-managers never even mount this component (the Worker
 * enforces the same rule; this keeps the network quiet as well).
 *
 * Failure is scoped to the panel itself: a workload outage never takes down
 * the pipeline list.
 */

import { useEffect, useState } from "react";
import { Card, ErrorState, Skeleton } from "./ui";
import { getPipelineWorkload, type WorkloadEntry } from "../lib/atlas";

interface Props {
  /** Bumped externally after a create → refetches. Optional. */
  reloadToken?: number;
}

export default function WorkloadPanel({ reloadToken = 0 }: Props) {
  const [workload, setWorkload] = useState<WorkloadEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [manualReload, setManualReload] = useState(0);

  useEffect(() => {
    let live = true;
    setLoading(true);
    setError(null);
    getPipelineWorkload()
      .then((res) => {
        if (!live) return;
        setWorkload(res.workload);
      })
      .catch((cause: Error) => {
        if (!live) return;
        setError(
          cause.message === "not_authenticated"
            ? "Your session has expired. Sign in again to load workload."
            : "The workload snapshot could not be loaded."
        );
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [reloadToken, manualReload]);

  const visible = (workload ?? []).filter(
    (entry) => entry.active_for_assignment || entry.open_count > 0
  );
  visible.sort((a, b) => {
    if (b.open_count !== a.open_count) return b.open_count - a.open_count;
    return (a.email ?? "").localeCompare(b.email ?? "");
  });

  return (
    <Card
      title="Underwriter workload"
      description="Open cases across the team. Inactive assignees remain visible while they still own work."
    >
      {loading ? (
        <div className="atlas-stack">
          <Skeleton />
          <Skeleton />
          <Skeleton />
        </div>
      ) : error ? (
        <ErrorState
          title="Workload unavailable"
          message={error}
          onRetry={() => setManualReload((n) => n + 1)}
          retryLabel="Retry"
        />
      ) : visible.length === 0 ? (
        <p className="atlas-text-muted">No underwriters currently hold open cases.</p>
      ) : (
        <table className="atlas-table" aria-label="Underwriter workload">
          <thead>
            <tr>
              <th scope="col">Underwriter</th>
              <th scope="col">Open</th>
              <th scope="col">Personal</th>
              <th scope="col">Commercial</th>
              <th scope="col">Stage mix</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((entry) => {
              const label = entry.email || "Unnamed user";
              const stageBits = [
                entry.by_stage.new > 0 ? `New ${entry.by_stage.new}` : null,
                entry.by_stage.triaged > 0 ? `Triaged ${entry.by_stage.triaged}` : null,
                entry.by_stage.assigned > 0 ? `Assigned ${entry.by_stage.assigned}` : null,
                entry.by_stage.in_progress > 0 ? `In progress ${entry.by_stage.in_progress}` : null,
                entry.by_stage.quoted > 0 ? `Quoted ${entry.by_stage.quoted}` : null,
              ].filter(Boolean);
              return (
                <tr key={entry.user_id}>
                  <td>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <span>{label}</span>
                      {!entry.active_for_assignment && (
                        <span
                          className="atlas-badge atlas-badge--warning"
                          title="This user is not currently accepting new assignments."
                        >
                          <span className="atlas-badge__label">Inactive for assignment</span>
                        </span>
                      )}
                    </div>
                  </td>
                  <td>{entry.open_count}</td>
                  <td>{entry.by_line.personal}</td>
                  <td>{entry.by_line.commercial}</td>
                  <td>
                    <span className="atlas-text-muted" style={{ fontSize: 12 }}>
                      {stageBits.length > 0 ? stageBits.join(" · ") : "—"}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </Card>
  );
}
