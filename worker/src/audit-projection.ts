/**
 * Atlas Blueprint — audit history projection helpers
 * ----------------------------------------------------------------------------
 * Pure runtime helpers with no Supabase / Cloudflare dependencies. Extracted
 * from worker/src/audit-endpoints.ts so the Phase 17 broker-audit test can
 * exercise the sanitiser in the plain-node test harness without booting the
 * whole Worker module graph.
 *
 * Broker-safe audit projection: filter by an explicit positive action
 * allow-list, scrub metadata to null, and withhold internal actor email/id
 * so History cannot leak underwriting intelligence.
 */

// Explicit positive allow-list. MUST stay in sync with the equivalent
// SQL function `public.atlas_broker_audit_action_allowed` in migration
// 0026. Adding an action here without the matching migration widens
// broker visibility through the Worker but leaves the direct Data API
// unchanged (safe — RLS still blocks it). The reverse — a Worker-only
// blocklist — is unsafe and MUST NOT be relied on.
export const BROKER_SAFE_AUDIT_ACTIONS: ReadonlySet<string> = new Set([
  "submission_created",
  "document_uploaded",
  "submission_queue_status_changed",
  "missing_info_added",
  "missing_info_updated",
]);

export function isBrokerSafeAuditAction(action: string): boolean {
  return BROKER_SAFE_AUDIT_ACTIONS.has(action);
}

export interface RawAuditRow {
  id: string;
  action: string;
  actor: string | null;
  metadata_json: unknown;
  created_at: string;
}

export interface AuditEventResponse {
  id: string;
  action: string;
  actor_id: string | null;
  actor_email: string | null;
  metadata: unknown;
  created_at: string;
}

/**
 * Broker projection. Filter to allow-listed actions, scrub metadata to
 * null uniformly, and withhold internal-staff actor identity. The broker's
 * OWN actor keeps identifiable so the timeline still reads "you added the
 * missing-info item".
 */
export function projectAuditForBroker(
  rows: readonly RawAuditRow[],
  brokerId: string,
  brokerEmail: string | null
): AuditEventResponse[] {
  return rows
    .filter((r) => isBrokerSafeAuditAction(r.action))
    .map((r) => ({
      id: r.id,
      action: r.action,
      actor_id: r.actor === brokerId ? r.actor : null,
      actor_email: r.actor === brokerId && brokerEmail ? brokerEmail : null,
      metadata: null,
      created_at: r.created_at,
    }));
}

/**
 * Internal projection — preserves the existing shape exactly. `emailById`
 * is the resolved actor-id → email map the endpoint builds from
 * `emailsForUserIds`.
 */
export function projectAuditForStaff(
  rows: readonly RawAuditRow[],
  emailById: ReadonlyMap<string, string>
): AuditEventResponse[] {
  return rows.map((r) => ({
    id: r.id,
    action: r.action,
    actor_id: r.actor,
    actor_email: r.actor ? emailById.get(r.actor) ?? null : null,
    metadata: r.metadata_json,
    created_at: r.created_at,
  }));
}
