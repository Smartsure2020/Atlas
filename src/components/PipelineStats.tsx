/**
 * PipelineStats — lifecycle-first metric strip for the Quote Pipeline.
 *
 * Counts are calculated from the ALREADY-FETCHED, security-scoped `items`
 * (not from `visible`) so a saved-view or stage-filter selection never
 * silently zeroes the other lifecycle numbers. Server-side search/filter
 * scope is still reflected because it happens upstream.
 */

import { useMemo } from "react";
import { Metric } from "./ui";
import type { SubmissionListItem } from "../lib/atlas";
import {
  countPipelineStages,
  countUnassigned,
  countWaitingInfo,
  type PipelineStage,
} from "../lib/pipeline";

export type PipelineStageFilter = PipelineStage | "not_initialised" | null;

interface Props {
  items: readonly SubmissionListItem[];
  loading: boolean;
  active: PipelineStageFilter;
  onToggle: (stage: PipelineStageFilter) => void;
  /** Broker sees fewer operational tiles. */
  scope: "internal" | "broker";
}

export default function PipelineStats({ items, loading, active, onToggle, scope }: Props) {
  const stageCounts = useMemo(() => countPipelineStages(items), [items]);
  const unassigned = useMemo(() => countUnassigned(items), [items]);
  const waiting = useMemo(() => countWaitingInfo(items), [items]);

  const toggle = (stage: PipelineStageFilter) => () =>
    onToggle(active === stage ? null : stage);

  return (
    <section
      className="atlas-metrics atlas-queue__metrics"
      aria-label="Quote pipeline lifecycle summary"
    >
      <Metric
        label="New"
        value={stageCounts.new}
        loading={loading}
        hint="Received but not yet triaged."
        active={active === "new"}
        onClick={toggle("new")}
      />
      <Metric
        label="Triaged"
        value={stageCounts.triaged}
        loading={loading}
        hint="Classified and ready for assignment."
        active={active === "triaged"}
        onClick={toggle("triaged")}
      />
      <Metric
        label="Assigned"
        value={stageCounts.assigned}
        loading={loading}
        hint="Assigned to an underwriter; work not yet started."
        active={active === "assigned"}
        onClick={toggle("assigned")}
      />
      <Metric
        label="In progress"
        value={stageCounts.in_progress}
        loading={loading}
        hint="Underwriting work is in progress."
        active={active === "in_progress"}
        onClick={toggle("in_progress")}
      />
      <Metric
        label="Quoted"
        value={stageCounts.quoted}
        loading={loading}
        hint="An insurer quote has been received."
        active={active === "quoted"}
        onClick={toggle("quoted")}
      />
      <Metric
        label="Waiting"
        value={waiting}
        loading={loading}
        hint="Parked until the broker or client replies."
      />
      {scope === "internal" && (
        <Metric
          label="Unassigned"
          value={unassigned}
          loading={loading}
          hint="Open, initialised cases with no named owner."
        />
      )}
      {stageCounts.not_initialised > 0 && (
        <Metric
          label="Not initialised"
          value={stageCounts.not_initialised}
          loading={loading}
          hint="Historical records without a pipeline stage."
          active={active === "not_initialised"}
          onClick={toggle("not_initialised")}
        />
      )}
      <Metric
        label="Bound"
        value={stageCounts.bound}
        loading={loading}
        hint="Business placed / bound."
      />
      <Metric
        label="Declined"
        value={stageCounts.declined}
        loading={loading}
        hint="Opportunity declined."
      />
      <Metric
        label="Lost"
        value={stageCounts.lost}
        loading={loading}
        hint="Opportunity did not proceed."
      />
    </section>
  );
}
