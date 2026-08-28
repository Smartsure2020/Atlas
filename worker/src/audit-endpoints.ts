/**
 * Atlas Blueprint — submission audit timeline endpoint
 * ----------------------------------------------------------------------------
 * GET /api/submissions/:id/audit
 * Returns the chronological audit log for a single submission, with actor
 * email denormalised so the UI doesn't need a second round-trip.
 *
 * Internal roles (admin/manager/consultant/underwriter/readonly) receive the
 * full timeline with raw metadata — the audit trail is part of their job.
 *
 * Broker receives a deliberately curated operational history. The projection
 * lives in ./audit-projection so it can be tested without the whole Worker
 * module graph. RLS migration 0026 enforces the same positive action
 * allow-list at the Data API layer for defence in depth.
 */

import { adminClient, json, type AtlasUser } from "./auth";
import type { Env } from "./config";
import { emailsForUserIds } from "./user-directory";
import {
  projectAuditForBroker,
  projectAuditForStaff,
  type RawAuditRow,
} from "./audit-projection";

// Re-export the allow-list + pure predicate so callers wanting the
// server-side allow-list have a single import point.
export {
  BROKER_SAFE_AUDIT_ACTIONS,
  isBrokerSafeAuditAction,
} from "./audit-projection";

export async function handleGetAuditTimeline(
  submissionId: string,
  env: Env,
  user: AtlasUser
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

  const allRows = (rows ?? []) as RawAuditRow[];

  // Phase 3: broker projection. Allow-list, metadata scrub, internal actor
  // identity withheld. See ./audit-projection for the pure implementation.
  if (user.role === "broker") {
    const events = projectAuditForBroker(allRows, user.id, user.email ?? null);
    return json({ ok: true, events });
  }

  // Internal roles: preserve the existing response exactly.
  const actorIds = new Set<string>();
  for (const r of allRows) if (r.actor) actorIds.add(r.actor);

  let emailById = new Map<string, string>();
  try {
    emailById = await emailsForUserIds(admin, actorIds);
  } catch {
    // Non-fatal — UI just shows "system" / actor ID when email is unavailable.
  }

  const events = projectAuditForStaff(allRows, emailById);
  return json({ ok: true, events });
}
