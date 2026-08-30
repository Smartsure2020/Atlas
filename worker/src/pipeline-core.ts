/**
 * Atlas — Quote Pipeline Worker-side pure helpers (Phase 4)
 * ---------------------------------------------------------------------------
 * Framework/DB-free helpers so the Phase 18 tests can exercise workload
 * semantics and the quick-drawer safe projection without booting Supabase.
 *
 * Workload semantics MUST match migration 0024's atlas_auto_assign_submission
 * exactly — "open workload" for an underwriter is submissions where
 *   assigned_to = user
 *   AND pipeline_stage IS NOT NULL
 *   AND pipeline_stage NOT IN ('bound', 'declined', 'lost').
 * Any drift here silently disagrees with auto-assignment.
 */

import {
  QUOTE_PIPELINE_TERMINAL_STAGES,
  type QuotePipelineStage,
} from "./quote-pipeline-types.js";

// Assignable trusted staff roles. Broker MUST NOT appear as underwriting
// capacity — Phase 3's target-not-assignable outcome mirrors this set.
export const ASSIGNABLE_ATLAS_ROLES: ReadonlySet<string> = new Set([
  "underwriter",
  "consultant",
  "manager",
  "admin",
]);

export function isAssignableAtlasRole(role: string | null | undefined): boolean {
  return typeof role === "string" && ASSIGNABLE_ATLAS_ROLES.has(role);
}

export function isOpenWorkloadStage(
  stage: QuotePipelineStage | string | null | undefined
): boolean {
  if (!stage) return false;
  return !(QUOTE_PIPELINE_TERMINAL_STAGES as readonly string[]).includes(stage);
}

/** Minimal submission-row shape needed for workload arithmetic. */
export interface WorkloadSubmissionRow {
  assigned_to: string | null;
  pipeline_stage: string | null;
  line_of_business: string | null;
}

export interface WorkloadUserInput {
  user_id: string;
  email: string | null;
  role: string | null;
  active_for_assignment: boolean;
}

export interface WorkloadEntry {
  user_id: string;
  email: string | null;
  active_for_assignment: boolean;
  open_count: number;
  by_stage: {
    new: number;
    triaged: number;
    assigned: number;
    in_progress: number;
    quoted: number;
  };
  by_line: {
    personal: number;
    commercial: number;
  };
}

/**
 * Compute workload entries from a raw list of assignable staff and the raw
 * submission rows returned by an admin fetch. The output is what
 * GET /api/pipeline/workload returns in `workload`.
 *
 * Only users whose role sits in ASSIGNABLE_ATLAS_ROLES are included, so a
 * stray broker profile cannot surface as underwriting capacity.
 */
export function computeWorkload(
  users: readonly WorkloadUserInput[],
  submissions: readonly WorkloadSubmissionRow[]
): WorkloadEntry[] {
  const entries = new Map<string, WorkloadEntry>();
  for (const u of users) {
    if (!isAssignableAtlasRole(u.role)) continue;
    entries.set(u.user_id, {
      user_id: u.user_id,
      email: u.email,
      active_for_assignment: u.active_for_assignment,
      open_count: 0,
      by_stage: { new: 0, triaged: 0, assigned: 0, in_progress: 0, quoted: 0 },
      by_line: { personal: 0, commercial: 0 },
    });
  }

  for (const row of submissions) {
    if (!row.assigned_to) continue;
    if (!isOpenWorkloadStage(row.pipeline_stage)) continue;
    const entry = entries.get(row.assigned_to);
    if (!entry) continue; // assigned to a non-assignable/absent user — do NOT invent capacity
    entry.open_count += 1;
    const stage = row.pipeline_stage as keyof WorkloadEntry["by_stage"];
    if (stage in entry.by_stage) entry.by_stage[stage] += 1;
    if (row.line_of_business === "personal") entry.by_line.personal += 1;
    else if (row.line_of_business === "commercial") entry.by_line.commercial += 1;
  }

  return [...entries.values()].sort((a, b) => {
    if (b.open_count !== a.open_count) return b.open_count - a.open_count;
    return (a.email ?? "").localeCompare(b.email ?? "");
  });
}

// ---------------------------------------------------------------------------
// Quick-drawer safe projection
// ---------------------------------------------------------------------------
// Explicit allow-list. Adding an atlas_submissions column later must NOT
// silently reach the drawer — a new field only appears here after review.

export interface RawQuickSubmissionRow {
  id: string;
  client_name: string | null;
  broker_name: string | null;
  broker_email: string | null;
  request_type: string | null;
  pipeline_stage: string | null;
  queue_status: string | null;
  line_of_business: string | null;
  complexity: string | null;
  priority: string | null;
  assigned_to: string | null;
  next_action: string | null;
  due_at: string | null;
  source_type: string | null;
  received_at: string | null;
  created_at: string | null;
  updated_at: string | null;
  last_pipeline_stage_changed_at: string | null;
  // Any additional column added later is intentionally IGNORED.
  [otherColumn: string]: unknown;
}

export interface QuickSubmissionProjection {
  id: string;
  client_name: string | null;
  broker_name: string | null;
  broker_email: string | null;
  request_type: string | null;
  pipeline_stage: string | null;
  queue_status: string | null;
  line_of_business: string | null;
  complexity: string | null;
  priority: string | null;
  assigned_to: string | null;
  assigned_to_email: string | null;
  next_action: string | null;
  due_at: string | null;
  source_type: string | null;
  received_at: string | null;
  created_at: string | null;
  updated_at: string | null;
  last_pipeline_stage_changed_at: string | null;
}

/**
 * Explicit allow-listed operational projection. Never spreads the raw row.
 * `assigned_to_email` is resolved by the endpoint and passed in.
 */
export function projectQuickSubmission(
  row: RawQuickSubmissionRow,
  assignedToEmail: string | null
): QuickSubmissionProjection {
  return {
    id: row.id,
    client_name: row.client_name ?? null,
    broker_name: row.broker_name ?? null,
    broker_email: row.broker_email ?? null,
    request_type: row.request_type ?? null,
    pipeline_stage: row.pipeline_stage ?? null,
    queue_status: row.queue_status ?? null,
    line_of_business: row.line_of_business ?? null,
    complexity: row.complexity ?? null,
    priority: row.priority ?? null,
    assigned_to: row.assigned_to ?? null,
    assigned_to_email: assignedToEmail,
    next_action: row.next_action ?? null,
    due_at: row.due_at ?? null,
    source_type: row.source_type ?? null,
    received_at: row.received_at ?? null,
    created_at: row.created_at ?? null,
    updated_at: row.updated_at ?? null,
    last_pipeline_stage_changed_at: row.last_pipeline_stage_changed_at ?? null,
  };
}

// ---------------------------------------------------------------------------
// Document summary
// ---------------------------------------------------------------------------

export interface RawDocumentRow {
  id: string;
  status: string | null;
  scan_status: string | null;
}

export interface DocumentSummary {
  total: number;
  active: number;
  pending_scan: number;
  clean: number;
  failed: number;
}

export function summariseDocuments(rows: readonly RawDocumentRow[]): DocumentSummary {
  const out: DocumentSummary = {
    total: rows.length,
    active: 0,
    pending_scan: 0,
    clean: 0,
    failed: 0,
  };
  for (const r of rows) {
    if (r.status === "active") out.active += 1;
    if (r.scan_status === "pending") out.pending_scan += 1;
    if (r.scan_status === "clean") out.clean += 1;
    if (r.scan_status === "failed" || r.scan_status === "infected") out.failed += 1;
  }
  return out;
}
