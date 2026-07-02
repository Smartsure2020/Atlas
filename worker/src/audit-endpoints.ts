/**
 * Atlas Blueprint — submission audit timeline endpoint
 * ----------------------------------------------------------------------------
 * GET /api/submissions/:id/audit
 * Returns the chronological audit log for a single submission, with actor
 * email denormalised so the UI doesn't need a second round-trip.
 *
 * Any underwriter can read — visibility of the trail for submissions they
 * work on is part of the job.
 */

import { adminClient, json, type AtlasUser } from "./auth";
import type { Env } from "./config";
import { emailsForUserIds } from "./user-directory";

export async function handleGetAuditTimeline(
  submissionId: string,
  env: Env,
  _user: AtlasUser
): Promise<Response> {
  const admin = adminClient(env);

  // Pull the audit rows for this submission, oldest first (timeline reads
  // top-to-bottom chronologically in the UI).
  const { data: rows, error } = await admin
    .from("atlas_audit_logs")
    .select("id, action, actor, metadata_json, created_at")
    .eq("submission_id", submissionId)
    .order("created_at", { ascending: true });
  if (error) return json({ error: "fetch_failed" }, 500);

  // Resolve actor IDs → emails, paginating the auth directory so actors
  // beyond the first page are never silently mislabelled.
  const actorIds = new Set<string>();
  for (const r of rows ?? []) if (r.actor) actorIds.add(r.actor);

  let emailById = new Map<string, string>();
  try {
    emailById = await emailsForUserIds(admin, actorIds);
  } catch {
    // Non-fatal — UI just shows "system" / actor ID when email is unavailable.
  }

  const enriched = (rows ?? []).map(
    (r: {
      id: string;
      action: string;
      actor: string | null;
      metadata_json: unknown;
      created_at: string;
    }) => ({
      id: r.id,
      action: r.action,
      actor_id: r.actor,
      actor_email: r.actor ? emailById.get(r.actor) ?? null : null,
      metadata: r.metadata_json,
      created_at: r.created_at,
    })
  );

  return json({ ok: true, events: enriched });
}
