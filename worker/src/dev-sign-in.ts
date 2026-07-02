/**
 * Atlas Blueprint — DEV SIGN-IN SHORTCUT (LOCAL DEV ONLY)
 * ----------------------------------------------------------------------------
 * **Temporary**: a parallel sign-in path for local development while waiting
 * on IT to register the production Microsoft redirect URI on the Scout Azure
 * app registration.
 *
 * Skips authentication (Microsoft) but NOT authorisation: the email it signs
 * in as must still be on the allow-list (same gate the real OAuth path uses).
 *
 * **Three independent guards** — all must pass:
 *   1. ENV check: only responds when ATLAS_ENV is explicitly "development"
 *      AND AZURE_REDIRECT_URI points at localhost/127.0.0.1. Both must hold —
 *      an unset ATLAS_ENV fails closed. In a deployed environment this
 *      endpoint returns 404.
 *   2. Allow-list check: the email parameter must resolve to a real Atlas role
 *      (underwriter/admin) via the SAME allow-list the real flow uses.
 *   3. Audit: every dev sign-in writes a 'dev_sign_in' audit row so the trail
 *      shows clearly when this shortcut is used.
 *
 * To remove this when IT registers the redirect URI:
 *   - Delete this file.
 *   - Remove the dev-route import + route block from index.ts.
 *   - Remove the dev-sign-in branch from App.tsx (the ?dev=1 handler).
 * No schema changes; no migrations to undo.
 */

import { adminClient, audit, json } from "./auth";
import { resolveRoleFromAllowlist, type Env } from "./config";
import { isDevSignInAllowed } from "./phase6-hardening";
import { findUserByEmail } from "./user-directory";

/**
 * GET /dev/sign-in?email=<allow-listed email>
 * Returns: { ok: true, action_link } when authorised.
 * Returns 404 in non-dev environments; 403 when email is not on the allow-list.
 */
export async function handleDevSignIn(
  request: Request,
  env: Env
): Promise<Response> {
  // Guard 1: must be local dev
  if (!isDevSignInAllowed(env)) {
    return json({ error: "not_found" }, 404);
  }

  const url = new URL(request.url);
  const email = (url.searchParams.get("email") || "").trim().toLowerCase();
  if (!email) return json({ error: "missing_email" }, 400);

  // Guard 2: allow-list must accept the email
  const role = resolveRoleFromAllowlist(email, env);
  if (!role) {
    await audit(env, {
      action: "dev_sign_in_denied",
      metadata: { reason: "not_on_allowlist", email },
    });
    return json({ error: "not_authorised" }, 403);
  }

  const admin = adminClient(env);

  // Step 1: find or create the Supabase user.
  let userId: string | null = null;
  const existing = await findUserByEmail(admin, email);
  if (existing) {
    userId = existing.id;
  } else {
    const { data: created, error: createErr } = await admin.auth.admin.createUser({
      email,
      email_confirm: true,
    });
    if (createErr || !created?.user) {
      return json({ error: "provisioning_failed", detail: createErr?.message }, 502);
    }
    userId = created.user.id;
  }
  if (!userId) return json({ error: "provisioning_failed" }, 502);

  // Step 2: stamp the Atlas role BEFORE generating the link.
  // Updating the user after generateLink invalidates the OTP token Supabase just minted.
  try {
    await admin.auth.admin.updateUserById(userId, {
      app_metadata: { atlas_role: role, provider: "dev_shortcut" },
      email_confirm: true,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return json({ error: "metadata_update_failed", detail: msg }, 502);
  }

  // Step 3: generate the magic link last so the token is never invalidated.
  let linkData: Awaited<ReturnType<typeof admin.auth.admin.generateLink>> | null = null;
  try {
    linkData = await admin.auth.admin.generateLink({
      type: "magiclink",
      email,
      options: { redirectTo: env.CORS_ORIGIN ?? "http://localhost:5173" },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return json({ error: "supabase_error", detail: msg }, 502);
  }

  if (linkData.error || !linkData.data?.user) {
    return json(
      { error: "provisioning_failed", detail: linkData.error?.message ?? "no user returned" },
      502
    );
  }

  // Guard 3: clearly named audit event — easy to spot if it ever appears in
  // production logs (it shouldn't, because guard 1 returns 404 there).
  await audit(env, {
    action: "dev_sign_in",
    actorId: userId,
    metadata: { role, email },
  });

  return json({
    ok: true,
    user: { id: userId, email, role },
    action_link: linkData.data.properties?.action_link ?? null,
    notice: "DEV SHORTCUT — not for production use.",
  });
}
