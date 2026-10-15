/**
 * Atlas — scheduled background runner: cadence + strict sequencing.
 * ----------------------------------------------------------------------------
 * Isolated from phase4-background.ts (like phase4-queue-selector.ts) so the
 * scheduling contract can be unit-tested without importing every downstream
 * job handler.
 *
 * Why this exists (Phase 6 production incident): the Worker cron fires every
 * minute and ALL background workloads shared that one invocation's CPU
 * budget. They were started concurrently, so the heavy cleanup scan (recursive
 * bucket listing + per-object reference lookups) competed with job processing
 * and every scheduled invocation was terminated with "Exceeded CPU Limit"
 * before the malware scanner was ever called.
 *
 * Contract enforced here:
 *   1. job_processing runs on EVERY invocation and ALWAYS runs first.
 *   2. No maintenance stage starts until job_processing has settled
 *      (resolved OR rejected). Stages are awaited one at a time — nothing is
 *      ever started eagerly or run concurrently.
 *   3. Maintenance stages run on a deterministic, stateless cadence derived
 *      only from the scheduled time (no persistence, no last-run table), and
 *      are staggered onto different minutes so a single invocation carries at
 *      most one maintenance stage.
 *   4. Every stage is failure-isolated: a rejected or synchronously-throwing
 *      stage is logged safely and never prevents a later due stage, and never
 *      throws out of the runner.
 *
 * Why attempting maintenance after a FAILED job stage is safe: by then the
 * job stage has settled, so there is nothing left for maintenance to starve.
 * Priority is about ordering and non-overlap, not about skipping.
 */

export type BackgroundStageName =
  | "job_processing"
  | "signal_monitoring"
  | "alert_escalation"
  | "approved_cleanup"
  | "cleanup_detection";

export type MaintenanceStageName = Exclude<BackgroundStageName, "job_processing">;

/**
 * Execution order within one invocation: jobs first, then maintenance from
 * cheapest to heaviest so that if a heavier stage is ever killed by the CPU
 * limit, the lighter stages that share its minute have already completed.
 */
export const BACKGROUND_STAGE_ORDER: readonly BackgroundStageName[] = [
  "job_processing",
  "signal_monitoring",
  "alert_escalation",
  "approved_cleanup",
  "cleanup_detection",
];

export interface StageCadence {
  /** Period in minutes. MUST divide 60 so the pattern repeats every hour. */
  everyMinutes: number;
  /** The stage fires when (UTC minute-of-hour) % everyMinutes === offsetMinute. */
  offsetMinute: number;
}

/**
 * Cron fires every minute. The 5-minute stages fire on minutes that are
 * 1 and 3 mod 5; the hourly stages fire on :17 and :47, both 2 mod 5. The
 * four firing sets are therefore disjoint, so no default-cadence invocation
 * ever carries more than one maintenance stage.
 *
 *   signal_monitoring  every 5 min at :01 :06 :11 ...
 *   alert_escalation   every 5 min at :03 :08 :13 ...
 *   cleanup_detection  hourly at :17
 *   approved_cleanup   hourly at :47
 */
export const MAINTENANCE_CADENCE: Readonly<Record<MaintenanceStageName, StageCadence>> = {
  signal_monitoring: { everyMinutes: 5, offsetMinute: 1 },
  alert_escalation: { everyMinutes: 5, offsetMinute: 3 },
  cleanup_detection: { everyMinutes: 60, offsetMinute: 17 },
  approved_cleanup: { everyMinutes: 60, offsetMinute: 47 },
};

/**
 * Pure cadence predicate. `now` is the scheduled time of the cron tick.
 * An invalid Date yields `false` for every maintenance stage (fail quiet) —
 * job processing is unconditional so the queue still drains.
 */
export function isStageDue(stage: BackgroundStageName, now: Date): boolean {
  if (stage === "job_processing") return true;
  const minute = now.getUTCMinutes();
  if (!Number.isInteger(minute)) return false;
  const cadence = MAINTENANCE_CADENCE[stage];
  return minute % cadence.everyMinutes === cadence.offsetMinute;
}

/** Stages due at `now`, in execution order (job_processing is always first). */
export function dueStages(now: Date): BackgroundStageName[] {
  return BACKGROUND_STAGE_ORDER.filter((stage) => isStageDue(stage, now));
}

/**
 * Resolve the cron tick time. Cloudflare's `event.scheduledTime` is the
 * minute the trigger was scheduled for, which is more deterministic than the
 * wall clock when an invocation starts late. Falls back to the current time
 * if it is missing or not a finite timestamp.
 */
export function toScheduledAt(value?: Date | number | null, fallback: () => Date = () => new Date()): Date {
  const date = value instanceof Date ? value : typeof value === "number" ? new Date(value) : null;
  return date && Number.isFinite(date.getTime()) ? date : fallback();
}

export type StageRunners = Record<BackgroundStageName, () => unknown>;

export interface BackgroundRunSummary {
  /** Stages that were started, in the order they ran. */
  attempted: BackgroundStageName[];
  /** Subset of `attempted` that rejected or threw. */
  failed: BackgroundStageName[];
  /** Stages not due at this tick. */
  skipped: BackgroundStageName[];
}

export interface RunStagesOptions {
  /** Test seam: override the cadence predicate. Defaults to {@link isStageDue}. */
  isDue?: (stage: BackgroundStageName, now: Date) => boolean;
  /** Test seam: override failure reporting. Defaults to {@link logStageFailure}. */
  onFailure?: (stage: BackgroundStageName, error: unknown) => void;
}

/**
 * Safe stage-failure log. Emits the stage, the error class and a short
 * truncated message — never the raw error object, stack or cause chain.
 */
export function logStageFailure(stage: BackgroundStageName, error: unknown): void {
  const err = error as { name?: unknown; message?: unknown } | null;
  console.error("atlas_background_stage_failed", {
    stage,
    error_name: typeof err?.name === "string" ? err.name : "UnknownError",
    error_message: typeof err?.message === "string" ? err.message.slice(0, 120) : undefined,
  });
}

/**
 * Run the due stages strictly one after another, in
 * {@link BACKGROUND_STAGE_ORDER}. Runners are lazy thunks: nothing executes
 * until its turn, so no stage can be "already running" while an earlier one
 * is still pending. Never throws.
 */
export async function runBackgroundStages(
  runners: StageRunners,
  now: Date,
  options: RunStagesOptions = {},
): Promise<BackgroundRunSummary> {
  const isDue = options.isDue ?? isStageDue;
  const onFailure = options.onFailure ?? logStageFailure;
  const summary: BackgroundRunSummary = { attempted: [], failed: [], skipped: [] };
  for (const stage of BACKGROUND_STAGE_ORDER) {
    if (!isDue(stage, now)) {
      summary.skipped.push(stage);
      continue;
    }
    summary.attempted.push(stage);
    try {
      await runners[stage]();
    } catch (error) {
      summary.failed.push(stage);
      try {
        onFailure(stage, error);
      } catch {
        // Failure reporting must never break the run.
      }
    }
  }
  return summary;
}
