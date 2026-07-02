/**
 * Atlas Blueprint — Worker config & types
 * ----------------------------------------------------------------------------
 * The Worker is the ONLY privileged path in Atlas. The browser never talks to
 * Claude, never talks to storage directly with privileged rights, and never
 * computes a recommendation. Everything sensitive routes through here, which is
 * what makes audit logging structural rather than something a dev must remember.
 *
 * AUTH MODEL (decided with the team):
 *   * Authentication reuses Scout's Azure app registration (same tenant, same
 *     Microsoft accounts, same login). Atlas only needed its redirect URI added
 *     to that registration.
 *   * Authorisation (who is an underwriter/admin) is an ALLOW-LIST the Worker
 *     controls — NOT Azure groups. Adding an underwriter is an allow-list edit,
 *     no Azure/IT change. The Worker writes the resolved role into the Supabase
 *     user's app_metadata.atlas_role, which the RLS policies trust.
 */

export interface Env {
  // --- Supabase ---
  SUPABASE_URL: string;
  // Service-role key. Server-side ONLY. Bypasses RLS by design; never exposed
  // to the browser. Used for admin tasks (setting app_metadata) and privileged
  // server-side data work behind our own authorisation checks.
  SUPABASE_SERVICE_ROLE_KEY: string;
  // Anon key — handed to the frontend for user-context (RLS-enforced) calls.
  SUPABASE_ANON_KEY: string;

  // --- Azure / Microsoft OAuth2 (reused from Scout's app registration) ---
  AZURE_TENANT_ID: string;
  AZURE_CLIENT_ID: string;
  AZURE_CLIENT_SECRET: string;
  // Atlas's own callback URL, added to the shared registration's redirect URIs.
  AZURE_REDIRECT_URI: string;

  // --- Anthropic (extraction + reasoning; used in later phases) ---
  ANTHROPIC_API_KEY: string;

  // --- Atlas authorisation allow-list ---
  // JSON mapping of lower-cased email -> 'consultant' | 'manager' | 'admin'
  // | 'readonly'. Legacy 'underwriter' is still accepted as consultant-level
  // access so existing local allow-lists do not fail closed during upgrade.
  // Kept as a secret/env value so access changes need no redeploy of code,
  // only an env update. (Could move to a table later without touching callers.)
  ATLAS_ALLOWLIST_JSON: string;

  // --- Document retention (configurable; NOT hard-coded) ---
  // Days a client document file is kept before the expiry cron deletes it.
  // The extraction persists regardless. Default applied if unset.
  ATLAS_DOC_RETENTION_DAYS?: string;

  // --- CORS (local dev only) ---
  // Set to the Vite dev origin if it differs from the default localhost:5173.
  CORS_ORIGIN?: string;

  // Explicit environment guard for dev-only routes and production validation.
  ATLAS_ENV?: "development" | "staging" | "production" | string;
}

export type AtlasRole = "underwriter" | "consultant" | "manager" | "admin" | "readonly";

/** Default retention window if ATLAS_DOC_RETENTION_DAYS is unset. */
export const DEFAULT_RETENTION_DAYS = 7;

/**
 * Resolve a signed-in user's Atlas role from the allow-list.
 * Returns null when the email is not on the list — i.e. access denied.
 * Email comparison is case-insensitive and trimmed.
 */
export function resolveRoleFromAllowlist(
  email: string | null | undefined,
  env: Env
): AtlasRole | null {
  if (!email) return null;

  let allow: Record<string, string>;
  try {
    allow = JSON.parse(env.ATLAS_ALLOWLIST_JSON || "{}");
  } catch {
    // A malformed allow-list must fail CLOSED, never open.
    return null;
  }

  const key = email.trim().toLowerCase();
  const role = allow[key];
  return role === "admin" ||
    role === "manager" ||
    role === "consultant" ||
    role === "readonly" ||
    role === "underwriter"
    ? role
    : null;
}

/** Days to retain client document files, from config or the safe default. */
export function retentionDays(env: Env): number {
  const n = Number(env.ATLAS_DOC_RETENTION_DAYS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_RETENTION_DAYS;
}
