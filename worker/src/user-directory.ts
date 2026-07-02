/**
 * Atlas Blueprint — Supabase auth user lookups (paginated)
 * ----------------------------------------------------------------------------
 * admin.auth.admin.listUsers() returns ONE page (default ~50 users). The old
 * call sites took the first page and silently missed users beyond it — wrong
 * actor emails in the audit timeline and failed find-by-email once the tenant
 * grows. These helpers page through the directory with a hard cap.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

const PER_PAGE = 200;
const MAX_PAGES = 25; // 5,000 users — far beyond an internal underwriting team.

interface DirectoryUser {
  id: string;
  email: string | null;
}

/** Find a Supabase auth user by email (case-insensitive), across all pages. */
export async function findUserByEmail(
  admin: SupabaseClient,
  email: string
): Promise<DirectoryUser | null> {
  const target = email.trim().toLowerCase();
  if (!target) return null;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: PER_PAGE });
    const users = data?.users ?? [];
    if (error || users.length === 0) return null;
    const hit = users.find((u) => u.email?.toLowerCase() === target);
    if (hit) return { id: hit.id, email: hit.email ?? null };
    if (users.length < PER_PAGE) return null;
  }
  return null;
}

/** Resolve a set of user ids to emails, across all pages. Missing ids are
 *  simply absent from the map (callers already render a fallback). */
export async function emailsForUserIds(
  admin: SupabaseClient,
  ids: Iterable<string>
): Promise<Map<string, string>> {
  const wanted = new Set(ids);
  const out = new Map<string, string>();
  if (wanted.size === 0) return out;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: PER_PAGE });
    const users = data?.users ?? [];
    if (error || users.length === 0) break;
    for (const u of users) {
      if (u.email && wanted.has(u.id)) out.set(u.id, u.email);
    }
    if (out.size === wanted.size || users.length < PER_PAGE) break;
  }
  return out;
}
