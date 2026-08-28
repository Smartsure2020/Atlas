import { adminClient, type AtlasUser } from "./auth";
import type { Env } from "./config";
import { strictAccessScoping } from "./config";
import { roleCanViewManagerDashboard } from "./phase6-hardening";

// Broker is never in the all-view set. Even under relaxed access-scoping
// (development), broker access remains created_by-only.
export function canViewAllSubmissions(env: Env, user: AtlasUser): boolean {
  if (user.role === "broker") return false;
  return !strictAccessScoping(env) || roleCanViewManagerDashboard(user.role) || user.role === "readonly";
}

export async function canAccessSubmission(
  env: Env,
  user: AtlasUser,
  submissionId: string
): Promise<boolean> {
  if (canViewAllSubmissions(env, user)) return true;
  const admin = adminClient(env);
  const { data } = await admin
    .from("atlas_submissions")
    .select("id, created_by, assigned_to, assigned_underwriter")
    .eq("id", submissionId)
    .maybeSingle();
  if (!data) return false;
  if (user.role === "broker") {
    // Broker access is created_by-only. assigned_to / assigned_underwriter
    // are intentionally ignored so a broker cannot gain access merely
    // because they were mistakenly assigned.
    return data.created_by === user.id;
  }
  return [data.created_by, data.assigned_to, data.assigned_underwriter].includes(user.id);
}

// PostgREST OR-filter fragment used when the caller's role does not have
// all-view semantics. Broker gets created_by only; internal roles keep the
// existing created_by/assigned_to/assigned_underwriter OR-scope.
export function scopedSubmissionOr(user: AtlasUser): string {
  if (user.role === "broker") {
    return `created_by.eq.${user.id}`;
  }
  return `created_by.eq.${user.id},assigned_to.eq.${user.id},assigned_underwriter.eq.${user.id}`;
}
