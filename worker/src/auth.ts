/**
 * Atlas Blueprint — Worker auth & audit helpers
 * ----------------------------------------------------------------------------
 * Server-side enforcement of the same rule the RLS enforces at the database:
 * only underwriter/admin staff get through. We check here too (defence in
 * depth) so a privileged Worker path can never act for a non-staff caller even
 * though it holds the service-role key.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Env, AtlasRole } from "./config";
import { normalizeAtlasRole, safeErrorBody, type SafeErrorCode } from "./phase6-hardening";

export interface AtlasUser {
  id: string;
  email: string | null;
  role: AtlasRole;
}

/** Service-role client: bypasses RLS. Server-side only, behind our own checks. */
export function adminClient(env: Env): SupabaseClient {
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

/**
 * Identify and authorise the caller from their bearer token.
 * Returns the AtlasUser when the token is valid AND the resolved role in their
 * app_metadata is staff. Returns null otherwise (caller should 401/403).
 *
 * We read the role from app_metadata (set at sign-in from the allow-list) — the
 * same claim the RLS trusts — rather than re-reading the allow-list here, so the
 * Worker and the database agree on exactly one source of truth per session.
 */
export async function authorise(
  request: Request,
  env: Env
): Promise<AtlasUser | null> {
  const auth = request.headers.get("Authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return null;

  const admin = adminClient(env);
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data?.user) return null;

  const role = normalizeAtlasRole((data.user.app_metadata as Record<string, unknown>)?.atlas_role);
  if (!role) return null;

  return {
    id: data.user.id,
    email: data.user.email ?? null,
    role,
  };
}

/**
 * Append an audit row. Called by every privileged action.
 *
 * IMPORTANT: metadata must carry IDs and field NAMES only — never document
 * bodies, never PII. Callers are responsible for passing safe metadata; this
 * helper does not serialise arbitrary payloads for that reason.
 */
export async function audit(
  env: Env,
  params: {
    submissionId?: string | null;
    action: string;
    actorId?: string | null;
    metadata?: Record<string, unknown>;
  }
): Promise<void> {
  const admin = adminClient(env);
  await admin.from("atlas_audit_logs").insert({
    submission_id: params.submissionId ?? null,
    action: params.action,
    actor: params.actorId ?? null,
    metadata_json: params.metadata ?? {},
  });
}

/** Standard JSON response helper. */
export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Standard safe error response. Messages are user-facing; internals stay in logs. */
export function jsonError(
  code: SafeErrorCode,
  status: number,
  message: string,
  fields: Record<string, unknown> = {}
): Response {
  return json(safeErrorBody(code, message, fields), status);
}
