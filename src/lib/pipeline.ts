/**
 * Atlas — Quote Pipeline pure helpers (Phase 4)
 * ----------------------------------------------------------------------------
 * Runtime-safe, framework-free helpers that operate over the already-fetched,
 * security-scoped submission list. Extracted here so behaviour can be tested
 * without booting React.
 *
 * Historical rule: rows with pipeline_stage IS NULL are pre-Phase-1 records
 * awaiting the future controlled backfill. They MUST NOT be silently counted
 * as "new" or reported as open workload. Callers surface them separately as
 * "Not initialised".
 *
 * SLA / aging is deliberately not modelled here. `stageAgeMs` returns honest
 * elapsed-calendar-time; nothing in this module implements business-day rules,
 * holidays, or waiting-info paused accumulators.
 */

// Type-only shape mirroring the fields these helpers touch on
// SubmissionListItem from ./atlas. Declared here instead of imported so the
// pure test harness (see tsconfig.test.json) does not have to type-check the
// full Supabase client module graph. Any drift is caught by the frontend TSC
// via SubmissionListItem's structural compatibility with this shape.
export type PipelineStage =
  | "new"
  | "triaged"
  | "assigned"
  | "in_progress"
  | "quoted"
  | "bound"
  | "declined"
  | "lost";

export interface SubmissionListItem {
  id: string;
  assigned_to: string | null;
  status: string;
  queue_status: string | null;
  pipeline_stage?: PipelineStage | null;
  priority: "low" | "normal" | "high" | "urgent" | null;
  due_at: string | null;
  last_pipeline_stage_changed_at?: string | null;
}

export type AtlasRoleForView =
  | "admin"
  | "manager"
  | "consultant"
  | "underwriter"
  | "readonly"
  | "broker";

export type PipelineSavedView =
  | "all"
  | "mine"
  | "unassigned"
  | "needs_attention"
  | "waiting_info"
  | "referred"
  | "quoted";

/**
 * Terminal stages a case is no longer commercially active in. Duplicated
 * locally so this module carries no runtime dependency on src/lib/status.ts
 * (which pulls in UI enum tables the Phase 18 domain tests do not need).
 * Canonical value: worker/src/quote-pipeline-types.ts.
 */
export const PIPELINE_TERMINAL_STAGES: readonly PipelineStage[] = [
  "bound",
  "declined",
  "lost",
];

export function isTerminalPipelineStage(
  stage: PipelineStage | string | null | undefined
): boolean {
  if (!stage) return false;
  return (PIPELINE_TERMINAL_STAGES as readonly string[]).includes(stage);
}

/**
 * A case is "open" when its lifecycle has been initialised AND has not yet
 * reached a terminal stage. Historical NULL rows are NOT open — they are
 * "not initialised" and reported separately.
 */
export function isOpenPipelineCase(row: Pick<SubmissionListItem, "pipeline_stage">): boolean {
  const stage = row.pipeline_stage ?? null;
  if (!stage) return false;
  return !isTerminalPipelineStage(stage);
}

export function isNotInitialisedCase(
  row: Pick<SubmissionListItem, "pipeline_stage">
): boolean {
  return (row.pipeline_stage ?? null) === null;
}

/**
 * Unassigned open case: no assignee AND the lifecycle is initialised and
 * non-terminal. Historical NULLs are intentionally excluded.
 */
export function isUnassignedPipelineCase(
  row: Pick<SubmissionListItem, "pipeline_stage" | "assigned_to">
): boolean {
  if (!isOpenPipelineCase(row)) return false;
  return !row.assigned_to;
}

export interface PipelineStageCounts {
  new: number;
  triaged: number;
  assigned: number;
  in_progress: number;
  quoted: number;
  bound: number;
  declined: number;
  lost: number;
  /** Historical rows with pipeline_stage NULL. Reported separately, never
   *  folded into any lifecycle stage. */
  not_initialised: number;
}

const EMPTY_STAGE_COUNTS: PipelineStageCounts = {
  new: 0,
  triaged: 0,
  assigned: 0,
  in_progress: 0,
  quoted: 0,
  bound: 0,
  declined: 0,
  lost: 0,
  not_initialised: 0,
};

export function countPipelineStages(
  rows: readonly Pick<SubmissionListItem, "pipeline_stage">[]
): PipelineStageCounts {
  const counts: PipelineStageCounts = { ...EMPTY_STAGE_COUNTS };
  for (const row of rows) {
    const stage = row.pipeline_stage ?? null;
    if (!stage) {
      counts.not_initialised += 1;
      continue;
    }
    if (stage in counts) {
      (counts as unknown as Record<string, number>)[stage] += 1;
    }
  }
  return counts;
}

export function countUnassigned(
  rows: readonly Pick<SubmissionListItem, "pipeline_stage" | "assigned_to">[]
): number {
  let n = 0;
  for (const row of rows) if (isUnassignedPipelineCase(row)) n += 1;
  return n;
}

export function countWaitingInfo(
  rows: readonly Pick<SubmissionListItem, "queue_status">[]
): number {
  let n = 0;
  for (const row of rows) if (row.queue_status === "waiting_info") n += 1;
  return n;
}

/**
 * The default saved view for a role. Deterministic — no localStorage read,
 * no user-agent sniffing. See §7 of the Phase 4 spec.
 */
export function defaultViewForRole(role: AtlasRoleForView): PipelineSavedView {
  switch (role) {
    case "manager":
    case "admin":
    case "readonly":
      return "all";
    case "consultant":
    case "underwriter":
      return "mine";
    case "broker":
      // Broker's list is already created_by-scoped on the server; "All"
      // inside their scope is their "My submissions".
      return "all";
  }
}

/**
 * Needs-attention: preserved from the pre-Phase-4 WorkQueue heuristic —
 * urgent priority OR overdue next_action. Deliberately NOT stage-aware and
 * NOT tied to any fake business-day SLA.
 */
export function needsAttention(
  row: Pick<SubmissionListItem, "priority" | "due_at">,
  now: Date = new Date()
): boolean {
  if (row.priority === "urgent") return true;
  if (row.due_at) {
    const due = new Date(row.due_at).getTime();
    if (!Number.isNaN(due) && due < now.getTime()) return true;
  }
  return false;
}

/**
 * Apply one saved view to the already security-scoped list. currentUserId is
 * the SIGNED-IN USER's UUID — never their email. Mine returns [] when it is
 * missing rather than silently degrading to All.
 */
export function filterPipelineView<T extends SubmissionListItem>(
  rows: readonly T[],
  view: PipelineSavedView,
  ctx: { currentUserId: string | null; now?: Date }
): T[] {
  switch (view) {
    case "all":
      return rows.slice();
    case "mine": {
      if (!ctx.currentUserId) return [];
      const uid = ctx.currentUserId;
      return rows.filter(
        (r) => r.assigned_to === uid && isOpenPipelineCase(r)
      );
    }
    case "unassigned":
      return rows.filter(isUnassignedPipelineCase);
    case "needs_attention":
      return rows.filter((r) => needsAttention(r, ctx.now));
    case "waiting_info":
      // Legacy compatibility: pre-Phase-1 rows may only carry `status`.
      return rows.filter(
        (r) => r.queue_status === "waiting_info" || r.status === "missing_info_requested"
      );
    case "referred":
      return rows.filter(
        (r) => r.queue_status === "referred" || r.status === "referred_to_insurer"
      );
    case "quoted":
      return rows.filter((r) => r.pipeline_stage === "quoted");
  }
}

/**
 * Elapsed milliseconds since the row last changed pipeline stage.
 * Returns null if the timestamp is missing (historical rows, unmigrated
 * databases). NEVER fabricates a date. Deliberately not called SLA.
 */
export function stageAgeMs(
  row: Pick<SubmissionListItem, "last_pipeline_stage_changed_at">,
  now: Date = new Date()
): number | null {
  const ts = row.last_pipeline_stage_changed_at;
  if (!ts) return null;
  const t = new Date(ts).getTime();
  if (Number.isNaN(t)) return null;
  return Math.max(0, now.getTime() - t);
}

