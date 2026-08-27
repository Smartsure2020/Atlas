/**
 * Atlas — Quote Pipeline vocabulary (Phase 1)
 * ----------------------------------------------------------------------------
 * Small, self-contained type module for the future Quote Pipeline. Named
 * `quote-pipeline-types` because `pipeline-types` is already occupied by the
 * hybrid document-extraction pipeline (ParsedDocument, CanonicalField, …).
 *
 * Phase 1 provides vocabulary only. No transition engine, no permissions, no
 * assignment, no workload calculation, no aging, no intake, no classification.
 * Those arrive in later phases and re-import from here.
 *
 * These arrays / unions mirror the enum values and CHECK constraints in
 * supabase/migrations/0023_pipeline_stage_and_underwriter_profiles.sql. Keep
 * both sides in sync — the phase15-pipeline-foundations test asserts them.
 */

export const QUOTE_PIPELINE_STAGES = [
  "new",
  "triaged",
  "assigned",
  "in_progress",
  "quoted",
  "bound",
  "declined",
  "lost",
] as const;
export type QuotePipelineStage = (typeof QUOTE_PIPELINE_STAGES)[number];

export const QUOTE_PIPELINE_TERMINAL_STAGES = [
  "bound",
  "declined",
  "lost",
] as const;
export type QuotePipelineTerminalStage =
  (typeof QUOTE_PIPELINE_TERMINAL_STAGES)[number];

/** Non-terminal stages count toward an underwriter's open workload in Phase 2. */
export function isOpenPipelineStage(
  stage: QuotePipelineStage | null | undefined
): boolean {
  if (!stage) return false;
  return !(QUOTE_PIPELINE_TERMINAL_STAGES as readonly string[]).includes(stage);
}

export const QUOTE_SOURCE_TYPES = ["manual", "email", "api"] as const;
export type QuoteSourceType = (typeof QUOTE_SOURCE_TYPES)[number];

export const QUOTE_COMPLEXITIES = ["standard", "complex"] as const;
export type QuoteComplexity = (typeof QUOTE_COMPLEXITIES)[number];

/**
 * The five columns migration 0023 adds to atlas_submissions. Every field is
 * nullable to preserve the historical-data rule (pre-migration rows keep
 * NULL). Future phases will tighten selected fields via CHECK or code paths.
 */
export interface QuotePipelineSubmissionFields {
  pipeline_stage: QuotePipelineStage | null;
  received_at: string | null;
  source_type: QuoteSourceType | null;
  complexity: QuoteComplexity | null;
  last_pipeline_stage_changed_at: string | null;
}

// ---------------------------------------------------------------------------
// Phase 2 — assignment engine vocabulary
// ---------------------------------------------------------------------------
// Mirrors migration 0024:
//   - assignment_source: 'auto' | 'manual'
//   - event_type:        'auto_assigned' | 'manual_assigned' | 'reassigned' | 'unassigned'
// Assignment RPC outcomes below mirror the JSONB `outcome` string the SQL
// functions return; the Worker maps them to HTTP responses.

export const ASSIGNMENT_SOURCES = ["auto", "manual"] as const;
export type AssignmentSource = (typeof ASSIGNMENT_SOURCES)[number];

export const ASSIGNMENT_EVENT_TYPES = [
  "auto_assigned",
  "manual_assigned",
  "reassigned",
  "unassigned",
] as const;
export type AssignmentEventType = (typeof ASSIGNMENT_EVENT_TYPES)[number];

export const ASSIGNMENT_OUTCOMES = [
  "assigned",
  "already_assigned",
  "unchanged",
  "no_eligible_underwriter",
  "pipeline_not_initialized",
  "not_triaged",
  "terminal_submission",
  "classification_required",
  "submission_not_found",
  "target_user_not_found",
  "actor_required",
] as const;
export type AssignmentOutcome = (typeof ASSIGNMENT_OUTCOMES)[number];

/** One row of public.atlas_assignment_events. */
export interface AssignmentEventRecord {
  id: string;
  submission_id: string;
  assignment_source: AssignmentSource;
  event_type: AssignmentEventType;
  from_user_id: string | null;
  to_user_id: string | null;
  actor_user_id: string | null;
  selected_open_count: number | null;
  eligible_candidate_count: number | null;
  created_at: string;
}

/** Shape returned by the canonical assignment SECURITY DEFINER functions. */
export interface AssignmentRpcResult {
  outcome: AssignmentOutcome;
  submission_id: string;
  assigned_to?: string | null;
  from_user_id?: string | null;
  event_type?: AssignmentEventType;
  pipeline_stage?: QuotePipelineStage | null;
  event_id?: string;
  selected_open_count?: number | null;
  eligible_candidate_count?: number | null;
  line_of_business?: string | null;
  complexity?: string | null;
}
