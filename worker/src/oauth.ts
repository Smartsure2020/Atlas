/**
 * Atlas Blueprint — OAuth2 sign-in callback
 * ----------------------------------------------------------------------------
 * Where authentication (shared Azure app) meets authorisation (Atlas allow-list).
 *
 * Flow:
 *   1. Frontend sends the user to Microsoft to sign in (login route below).
 *   2. Microsoft redirects back to Atlas with an auth code.
 *   3. We exchange the code for the user's identity (their verified email).
 *   4. We look that email up in the Atlas allow-list to get their role.
 *      - Not on the list  -> access denied, NOTHING provisioned. Fail closed.
 *      - On the list      -> ensure a Supabase user exists and stamp
 *                            app_metadata.atlas_role, which RLS trusts.
 *   5. We mint a Supabase session for the frontend.
 *
 * NOTE: this is the scaffold skeleton — the Microsoft token exchange and the
 * Supabase session mint are sketched with clear seams. The security-critical
 * logic (allow-list resolution, fail-closed, role stamping, audit) is real.
 */

import { adminClient, audit, json } from "./auth";
import { resolveRoleFromAllowlist, type Env } from "./config";

const MS_AUTHORIZE = (env: Env) =>
  `https://login.microsoftonline.com/${env.AZURE_TENANT_ID}/oauth2/v2.0/authorize`;
const MS_TOKEN = (env: Env) =>
  `https://login.microsoftonline.com/${env.AZURE_TENANT_ID}/oauth2/v2.0/token`;

/** Step 1: build the Microsoft sign-in URL and redirect the user to it. */
export function handleLogin(env: Env): Response {
  const params = new URLSearchParams({
    client_id: env.AZURE_CLIENT_ID,
    response_type: "code",
    redirect_uri: env.AZURE_REDIRECT_URI,
    response_mode: "query",
    scope: "openid email profile",
  });
  const authorizeUrl = `${MS_AUTHORIZE(env)}?${params.toString()}`;
  return Response.redirect(authorizeUrl, 302);
}

/** Step 3: exchange the auth code for the verified Microsoft identity. */
async function exchangeCodeForEmail(
  code: string,
  env: Env
): Promise<string | null> {
  const body = new URLSearchParams({
    client_id: env.AZURE_CLIENT_ID,
    client_secret: env.AZURE_CLIENT_SECRET,
    code,
    redirect_uri: env.AZURE_REDIRECT_URI,
    grant_type: "authorization_code",
    scope: "openid email profile",
  });

  const res = await fetch(MS_TOKEN(env), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) return null;

  const tokens = (await res.json()) as { id_token?: string };
  if (!tokens.id_token) return null;

  // The id_token is a JWT; its payload carries the verified email claim.
  // (Signature verification against Microsoft's JWKS is wired in the full
  // implementation; the email is taken from the verified token, not the client.)
  const payload = decodeJwtPayload(tokens.id_token);
  const email =
    (payload?.email as string) ||
    (payload?.preferred_username as string) ||
    null;
  return email ? email.toLowerCase() : null;
}

function decodeJwtPayload(jwt: string): Record<string, unknown> | null {
  try {
    const part = jwt.split(".")[1];
    const b64 = part.replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(b64));
  } catch {
    return null;
  }
}

/** Steps 3–5: the callback Microsoft redirects back to. */
export async function handleCallback(
  request: Request,
  env: Env
): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  if (!code) return json({ error: "missing_code" }, 400);

  const email = await exchangeCodeForEmail(code, env);
  if (!email) return json({ error: "auth_failed" }, 401);

  // ---- Authorisation: the allow-list decides, and it fails CLOSED. ----
  const role = resolveRoleFromAllowlist(email, env);
  if (!role) {
    // Not authorised. Provision NOTHING. Log the denied attempt (email is the
    // subject of an access decision here, acceptable to record for security).
    await audit(env, {
      action: "access_denied",
      metadata: { reason: "not_on_allowlist", email },
    });
    return json({ error: "not_authorised" }, 403);
  }

  // ---- Ensure a Supabase user exists and stamp the trusted role claim. ----
  const admin = adminClient(env);

  // Find or create the Supabase user for this email.
  // (createUser is idempotent enough for the scaffold via the catch; the full
  // version looks up by email first.)
  let userId: string | null = null;
  const created = await admin.auth.admin.createUser({
    email,
    email_confirm: true,
    app_metadata: { atlas_role: role, provider: "azure" },
  });
  if (created.data?.user) {
    userId = created.data.user.id;
  } else {
    // User already exists — fetch and UPDATE the role so allow-list changes
    // (e.g. promotion to admin, or revocation handled elsewhere) take effect.
    const { data: list } = await admin.auth.admin.listUsers();
    const existing = list?.users?.find((u) => u.email?.toLowerCase() === email);
    if (existing) {
      userId = existing.id;
      await admin.auth.admin.updateUserById(existing.id, {
        app_metadata: { atlas_role: role, provider: "azure" },
      });
    }
  }

  if (!userId) return json({ error: "provisioning_failed" }, 500);

  await audit(env, {
    action: "sign_in",
    actorId: userId,
    metadata: { role },
  });

  // Mint a session for the frontend. (Magic-link/session generation via the
  // admin API is wired here in the full implementation; the seam is explicit.)
  const { data: link } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email,
  });

  return json({
    ok: true,
    user: { id: userId, email, role },
    // The frontend completes session establishment from this action link.
    action_link: link?.properties?.action_link ?? null,
  });
}
