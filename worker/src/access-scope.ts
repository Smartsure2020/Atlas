import { adminClient, type AtlasUser } from "./auth";
import type { Env } from "./config";
import { strictAccessScoping } from "./config";
import { roleCanViewManagerDashboard } from "./phase6-hardening";

export function canViewAllSubmissions(env: Env, user: AtlasUser): boolean {
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
  return [data.created_by, data.assigned_to, data.assigned_underwriter].includes(user.id);
}

export function scopedSubmissionOr(user: AtlasUser): string {
  return `created_by.eq.${user.id},assigned_to.eq.${user.id},assigned_underwriter.eq.${user.id}`;
}
