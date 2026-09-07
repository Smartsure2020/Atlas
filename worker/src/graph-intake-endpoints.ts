/**
 * Atlas Phase 5A — HTTP entry points for Graph intake
 * ----------------------------------------------------------------------------
 * Thin layer that:
 *   * composes the service-role admin client via `adminClient(env)`,
 *   * translates results into safe JSON responses,
 *   * delegates every non-trivial decision to graph-intake.ts.
 *
 * Kept separate so `graph-intake.ts` has no runtime dependency on ./auth. That
 * lets behavioural tests import the orchestrator without pulling in
 * @supabase/supabase-js at module load.
 */

import { adminClient, json, jsonError, type AtlasUser } from "./auth";
import { graphIntakeEnabled, type Env } from "./config";
import {
  runGraphIntakeCycle,
  type IntakeDeps,
  type PollResult,
} from "./graph-intake";

export async function runGraphIntakeCycleForEnv(
  env: Env,
  deps: IntakeDeps = {},
): Promise<PollResult[]> {
  return runGraphIntakeCycle(env, adminClient(env), deps);
}

export async function handleGraphPollNow(
  env: Env,
  user: AtlasUser,
  deps: IntakeDeps = {},
): Promise<Response> {
  if (user.role !== "admin") {
    return jsonError("permission_denied", 403, "Only administrators may trigger an on-demand intake poll.");
  }
  if (env.ATLAS_ENV === "production") {
    return jsonError("permission_denied", 403, "Manual intake polling is disabled in production.");
  }
  if (!graphIntakeEnabled(env)) {
    return jsonError("validation_failed", 400, "Graph intake is not enabled in this environment.");
  }
  const results = await runGraphIntakeCycleForEnv(env, deps);
  return json({
    ok: true,
    polls: results.map((result) => ({
      status: result.status,
      pages_fetched: result.pagesFetched,
      messages_considered: result.messagesConsidered,
      duplicates: result.duplicates,
      attached: result.attached,
      needs_review: result.needsReview,
      new_submissions: result.newSubmissions,
      removed_events: result.removedEvents,
      error_code: result.errorCode ?? null,
    })),
  });
}

export async function handleListSubmissionIntakeMessages(
  submissionId: string,
  env: Env,
  _user: AtlasUser,
): Promise<Response> {
  const admin = adminClient(env);
  const { data, error } = await admin
    .from("atlas_submission_intake_messages")
    .select(
      "id, source, sender_name, sender_address, subject, body_preview, received_at, has_attachments, ingested_at, processing_state",
    )
    .eq("submission_id", submissionId)
    .order("received_at", { ascending: true })
    .limit(500);
  if (error) return jsonError("internal_error", 500, "Could not load intake messages.");
  const rows = (data ?? []) as Array<Record<string, unknown>>;
  return json({
    ok: true,
    intake_messages: rows.map((row) => ({
      id: row.id,
      source: row.source,
      sender: {
        name: row.sender_name ?? null,
        address: row.sender_address ?? null,
      },
      subject: row.subject ?? null,
      body_preview: row.body_preview ?? null,
      received_at: row.received_at ?? null,
      has_attachments: row.has_attachments ?? false,
      ingested_at: row.ingested_at ?? null,
      processing_state: row.processing_state ?? null,
    })),
  });
}
