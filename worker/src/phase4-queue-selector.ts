/**
 * Atlas Phase 6 (Checkpoint 1B) — background-job claim selector.
 * ----------------------------------------------------------------------------
 * Isolated from phase4-background.ts so the Phase 6 queue-starvation
 * regression can be unit-tested without pulling in every downstream job
 * handler (extraction, recommendation, quote-review, insurer-doc, …).
 *
 * When ATLAS_GRAPH_JOB_PROCESSING_ENABLED is off (production and staging
 * default closed), Phase 5B attachment jobs — graph_attachment_discovery
 * and graph_attachment_ingest — are excluded from candidate selection AT
 * THE DATABASE QUERY STAGE, before LIMIT applies. Filtering after LIMIT
 * would starve unrelated jobs (malware_scan, extraction, recommendation)
 * when a held Graph backlog fills the oldest slots.
 *
 * The excluded job rows remain in `queued` / `failed` state unchanged —
 * their retry_count and attempt_count are not touched while paused.
 */

import { graphJobProcessingEnabled, type Env } from "./config.js";

/**
 * Job types excluded from claim when LEVEL 2 is off. Formatted for
 * PostgREST `not("job_type", "in", ...)` syntax: parenthesised,
 * comma-separated identifier list. Exported for test coverage.
 */
export const LEVEL2_EXCLUDED_JOB_TYPES = "(graph_attachment_discovery,graph_attachment_ingest)";

/**
 * Minimal admin surface this helper needs. Kept narrow deliberately so a
 * unit test can supply an in-memory fake without pulling in the whole
 * Supabase client type.
 */
export interface QueueSelectorAdmin {
  from(table: string): {
    select(cols: string): {
      eq(field: string, value: unknown): unknown;
    };
  };
}

/**
 * Select the next batch of claimable background jobs (queued + retryable).
 * Returns at most `size` rows in total, drawn from both queues in the
 * documented preference order (queued first, oldest by created_at; then
 * retryable failed, earliest next_retry_at first).
 *
 * When LEVEL 2 is administratively off, both queries include a server-
 * side `.not("job_type", "in", LEVEL2_EXCLUDED_JOB_TYPES)` clause.
 *
 * Typed loosely because the real caller receives a fully-typed Supabase
 * chain and the test fake stubs only the exact methods used.
 */
export async function selectClaimableJobs<T = Record<string, unknown>>(
  admin: QueueSelectorAdmin,
  env: Env,
  nowIso: string,
  size: number,
): Promise<T[]> {
  const graphProcessingOn = graphJobProcessingEnabled(env);
  // Types are relaxed here because the real Supabase client and the
  // in-memory test fakes agree on the shape at runtime but diverge in
  // static declarations — both eventually resolve to
  // `Promise<{ data: T[] | null; error: unknown }>`.
  const buildQueuedQuery = () => {
    let q = admin
      .from("atlas_jobs")
      .select("*")
      .eq("status", "queued") as unknown as {
        eq: (f: string, v: unknown) => unknown;
        not: (f: string, op: string, v: string) => unknown;
        order: (f: string, o?: { ascending?: boolean }) => unknown;
        limit: (n: number) => Promise<{ data: T[] | null; error: unknown }>;
      };
    q = q.eq("cancellation_requested", false) as typeof q;
    if (!graphProcessingOn) q = q.not("job_type", "in", LEVEL2_EXCLUDED_JOB_TYPES) as typeof q;
    q = q.order("created_at", { ascending: true }) as typeof q;
    return q.limit(size);
  };
  const buildRetryableQuery = () => {
    let q = admin
      .from("atlas_jobs")
      .select("*")
      .eq("status", "failed") as unknown as {
        eq: (f: string, v: unknown) => unknown;
        not: (f: string, op: string, v: string) => unknown;
        lte: (f: string, v: unknown) => unknown;
        order: (f: string, o?: { ascending?: boolean }) => unknown;
        limit: (n: number) => Promise<{ data: T[] | null; error: unknown }>;
      };
    q = q.eq("cancellation_requested", false) as typeof q;
    q = q.lte("next_retry_at", nowIso) as typeof q;
    if (!graphProcessingOn) q = q.not("job_type", "in", LEVEL2_EXCLUDED_JOB_TYPES) as typeof q;
    q = q.order("next_retry_at", { ascending: true }) as typeof q;
    return q.limit(size);
  };
  const [queued, retryable] = await Promise.all([buildQueuedQuery(), buildRetryableQuery()]);
  const queuedRows = (queued.data ?? []) as T[];
  const retryableRows = (retryable.data ?? []) as T[];
  return [...queuedRows, ...retryableRows].slice(0, size);
}
