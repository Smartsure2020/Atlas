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
  // | 'readonly' | 'broker'. Legacy 'underwriter' is still accepted as
  // consultant-level access so existing local allow-lists do not fail
  // closed during upgrade. 'broker' is the Phase 3 authenticated internal
  // broker role — deliberately narrow (own-case only, no underwriting).
  // Kept as a secret/env value so access changes need no redeploy of code,
  // only an env update. (Could move to a table later without touching callers.)
  ATLAS_ALLOWLIST_JSON: string;

  // --- OAuth state signing ---
  // HMAC key for signing the OAuth state cookie. Must NOT be AZURE_CLIENT_SECRET.
  // Set via: wrangler secret put ATLAS_OAUTH_STATE_SECRET
  ATLAS_OAUTH_STATE_SECRET?: string;

  // --- Document retention (configurable; NOT hard-coded) ---
  // Days a client document file is kept before the expiry cron deletes it.
  // The extraction persists regardless. Default applied if unset.
  ATLAS_DOC_RETENTION_DAYS?: string;

  // --- CORS (local dev only) ---
  // Set to the Vite dev origin if it differs from the default localhost:5173.
  CORS_ORIGIN?: string;

  // Explicit environment guard for dev-only routes and production validation.
  ATLAS_ENV?: "development" | "staging" | "production" | string;

  // Production controls. Scanner and webhook values are secrets/configured
  // outside source control; the background worker fails closed when scanning
  // is not configured in production.
  ATLAS_MALWARE_SCANNER_URL?: string;
  ATLAS_MALWARE_SCANNER_TOKEN?: string;
  ATLAS_ALERT_WEBHOOK_URL?: string;
  ATLAS_STRICT_ACCESS_SCOPING?: string;
  ATLAS_CLEANUP_APPROVED?: string;
  ATLAS_WORKER_BATCH_SIZE?: string;
  ATLAS_STUCK_JOB_MINUTES?: string;
  ATLAS_ALERT_ESCALATE_MINUTES?: string;

  // --- Hybrid document pipeline (phases 1-11 redesign) ---
  // Mode gate for the new pipeline. Defaults to "legacy" so nothing changes
  // until this env var is flipped. Values: legacy | hybrid | shadow.
  ATLAS_DOCUMENT_PIPELINE_MODE?: string;
  // Provider selector for the managed OCR/layout step. Currently only "azure".
  ATLAS_DOCUMENT_PROVIDER?: string;
  // Azure Document Intelligence (formerly Form Recognizer). Server-only.
  AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT?: string;
  AZURE_DOCUMENT_INTELLIGENCE_KEY?: string;
  AZURE_DOCUMENT_INTELLIGENCE_MODEL?: string;
  AZURE_DOCUMENT_INTELLIGENCE_API_VERSION?: string;
  // Fast-path page cap; text PDFs longer than this bypass the fast path.
  ATLAS_HYBRID_MAX_TEXT_FASTPATH_PAGES?: string;
  // Recommendation explanation mode. Values: deterministic (default) | polish.
  ATLAS_EXPLANATION_MODE?: string;
  // Email drafting mode. Values: template (default) | polish | legacy.
  ATLAS_EMAIL_MODE?: string;
  // Percent (0-100) of extraction jobs to run through the shadow pipeline.
  // Deterministic by input fingerprint. Default 0 = no shadow work.
  ATLAS_SHADOW_SAMPLE_PERCENT?: string;
  // Set to "true" to disable the emergency legacy fallback in hybrid mode.
  ATLAS_LEGACY_FALLBACK_DISABLED?: string;

  // --- Microsoft Graph intake (Phase 5A — email intake, READ ONLY) ---
  // Opt-in. When unset or not "true", the scheduled handler performs NO Graph
  // work and NO token acquisition. Missing Graph configuration must NOT break
  // normal Atlas Worker operation while intake is disabled.
  ATLAS_GRAPH_INTAKE_ENABLED?: string;
  // Isolated Graph-intake tenant/app credentials. Do NOT reuse the interactive
  // sign-in credentials (AZURE_*) — those are user-delegated for Atlas sign-in.
  // The intake poller uses a separate application-permission (client
  // credentials) principal, restricted to Mail.Read on the configured mailboxes.
  ATLAS_GRAPH_TENANT_ID?: string;
  ATLAS_GRAPH_CLIENT_ID?: string;
  ATLAS_GRAPH_CLIENT_SECRET?: string;
  // JSON string array of mailboxes to poll, e.g. '["intake@example.com"]'.
  // Empty/absent => intake is effectively disabled even if the flag is on.
  ATLAS_GRAPH_MAILBOXES_JSON?: string;

  // Cloudflare Queue binding for shadow-pipeline processing.
  //
  // Populated only after the operator runs the wrangler commands documented in
  // docs/HYBRID_PIPELINE.md. Absent binding => shadow is SKIPPED (never falls
  // back to ctx.waitUntil for document work) and a `shadow_enqueue_skipped`
  // metric is recorded with reason "queue_binding_missing".
  ATLAS_SHADOW_QUEUE?: {
    send(message: unknown, options?: { contentType?: "json" | "text" | "bytes" | "v8" }): Promise<void>;
  };
}

export type AtlasRole =
  | "underwriter"
  | "consultant"
  | "manager"
  | "admin"
  | "readonly"
  | "broker";

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
    role === "underwriter" ||
    role === "broker"
    ? role
    : null;
}

/** Days to retain client document files, from config or the safe default. */
export function retentionDays(env: Env): number {
  const n = Number(env.ATLAS_DOC_RETENTION_DAYS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_RETENTION_DAYS;
}

export function strictAccessScoping(env: Env): boolean {
  return env.ATLAS_STRICT_ACCESS_SCOPING === "true" || env.ATLAS_ENV === "production";
}

/**
 * Phase 5A — Graph intake feature flag.
 *
 * Fails CLOSED. Missing / unset / anything-but-"true" means the poller does
 * not run: no token acquisition, no Graph request, no state mutation. Every
 * other Atlas capability remains unaffected regardless of Graph configuration.
 */
export function graphIntakeEnabled(env: Env): boolean {
  return env.ATLAS_GRAPH_INTAKE_ENABLED === "true";
}

/**
 * Parse the configured mailbox list. Returns [] on absent / malformed input so
 * a mis-configured flag never triggers a poll for an unintended mailbox.
 */
export function graphIntakeMailboxes(env: Env): string[] {
  const raw = env.ATLAS_GRAPH_MAILBOXES_JSON;
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((v): v is string => typeof v === "string")
      .map((v) => v.trim())
      .filter((v) => v.length > 0);
  } catch {
    return [];
  }
}
