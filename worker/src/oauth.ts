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
 * Security:
 *   - id_token signature is verified against Microsoft's JWKS (RS256).
 *   - OAuth state is stored in an HMAC-signed, HttpOnly, short-lived cookie
 *     so login and callback can be served by different Worker isolates.
 *   - Token claims (iss, aud, exp, nbf) are validated.
 */

import { adminClient, audit, json } from "./auth";
import { resolveRoleFromAllowlist, type Env } from "./config";
import { generateOAuthState, verifyMicrosoftIdToken } from "./jwks";
import { findUserByEmail } from "./user-directory";

const MS_AUTHORIZE = (env: Env) =>
  `https://login.microsoftonline.com/${env.AZURE_TENANT_ID}/oauth2/v2.0/authorize`;
const MS_TOKEN = (env: Env) =>
  `https://login.microsoftonline.com/${env.AZURE_TENANT_ID}/oauth2/v2.0/token`;

const STATE_TTL_MS = 10 * 60 * 1000;
const STATE_COOKIE_NAME = "atlas_oauth_state";

const SAFE_RETURN_PATH_RE = /^\/[a-zA-Z0-9/_-]*$/;

function isProductionEnv(env: Env): boolean {
  return env.ATLAS_ENV === "production";
}

async function hmacSign(data: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function hmacVerify(data: string, signature: string, secret: string): Promise<boolean> {
  const expected = await hmacSign(data, secret);
  if (expected.length !== signature.length) return false;
  let mismatch = 0;
  for (let i = 0; i < expected.length; i++) {
    mismatch |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  }
  return mismatch === 0;
}

function hmacSecret(env: Env): string {
  return env.ATLAS_OAUTH_STATE_SECRET || env.AZURE_CLIENT_SECRET;
}

function buildStateCookieValue(
  state: string, expiresAt: number, returnPath: string,
  nonce: string, codeVerifier: string,
): string {
  return `${state}|${expiresAt}|${returnPath}|${nonce}|${codeVerifier}`;
}

function parseStateCookieValue(value: string): {
  state: string; expiresAt: number; returnPath: string;
  nonce: string; codeVerifier: string;
} | null {
  const parts = value.split("|");
  if (parts.length < 5) return null;
  const state = parts[0];
  const expiresAt = Number(parts[1]);
  const returnPath = parts[2];
  const nonce = parts[3];
  const codeVerifier = parts[4];
  if (!state || !Number.isFinite(expiresAt) || !nonce || !codeVerifier) return null;
  return { state, expiresAt, returnPath, nonce, codeVerifier };
}

function stateCookieHeader(value: string, signature: string, env: Env, maxAge: number): string {
  const secure = isProductionEnv(env) ? "; Secure" : "";
  return `${STATE_COOKIE_NAME}=${encodeURIComponent(`${value}|${signature}`)}; HttpOnly; SameSite=Lax; Path=/auth/callback; Max-Age=${maxAge}${secure}`;
}

function clearStateCookieHeader(env: Env): string {
  const secure = isProductionEnv(env) ? "; Secure" : "";
  return `${STATE_COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/auth/callback; Max-Age=0${secure}`;
}

function parseCookies(cookieHeader: string | null): Map<string, string> {
  const cookies = new Map<string, string>();
  if (!cookieHeader) return cookies;
  for (const pair of cookieHeader.split(";")) {
    const eqIdx = pair.indexOf("=");
    if (eqIdx < 0) continue;
    const name = pair.slice(0, eqIdx).trim();
    const value = pair.slice(eqIdx + 1).trim();
    cookies.set(name, decodeURIComponent(value));
  }
  return cookies;
}

async function computeS256Challenge(verifier: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(hash)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function safeReturnPath(input: string | null | undefined): string {
  if (!input) return "/";
  const trimmed = input.trim();
  if (!SAFE_RETURN_PATH_RE.test(trimmed)) return "/";
  if (trimmed.includes("//")) return "/";
  return trimmed || "/";
}

/** Step 1: build the Microsoft sign-in URL and redirect the user to it. */
export async function handleLogin(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const returnPath = safeReturnPath(url.searchParams.get("return"));
  const state = generateOAuthState();
  const nonce = generateOAuthState();
  const codeVerifier = generateOAuthState();
  const codeChallenge = await computeS256Challenge(codeVerifier);
  const expiresAt = Date.now() + STATE_TTL_MS;
  const cookiePayload = buildStateCookieValue(state, expiresAt, returnPath, nonce, codeVerifier);
  const signature = await hmacSign(cookiePayload, hmacSecret(env));

  const params = new URLSearchParams({
    client_id: env.AZURE_CLIENT_ID,
    response_type: "code",
    redirect_uri: env.AZURE_REDIRECT_URI,
    response_mode: "query",
    scope: "openid email profile",
    state,
    nonce,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });
  const authorizeUrl = `${MS_AUTHORIZE(env)}?${params.toString()}`;
  const maxAgeSec = Math.ceil(STATE_TTL_MS / 1000);

  return new Response(null, {
    status: 302,
    headers: {
      Location: authorizeUrl,
      "Set-Cookie": stateCookieHeader(cookiePayload, signature, env, maxAgeSec),
      "Cache-Control": "no-store",
    },
  });
}

interface TokenExchangeResult {
  email: string;
  idTokenNonce: string | null;
}

/** Step 3: exchange the auth code for the verified Microsoft identity. */
async function exchangeCodeForEmail(
  code: string,
  env: Env,
  codeVerifier: string,
): Promise<TokenExchangeResult | null> {
  const body = new URLSearchParams({
    client_id: env.AZURE_CLIENT_ID,
    client_secret: env.AZURE_CLIENT_SECRET,
    code,
    redirect_uri: env.AZURE_REDIRECT_URI,
    grant_type: "authorization_code",
    scope: "openid email profile",
    code_verifier: codeVerifier,
  });

  const res = await fetch(MS_TOKEN(env), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) return null;

  const tokens = (await res.json()) as { id_token?: string };
  if (!tokens.id_token) return null;

  const verified = await verifyMicrosoftIdToken(
    tokens.id_token,
    env.AZURE_TENANT_ID,
    env.AZURE_CLIENT_ID,
  );

  if (!verified) return null;

  const payload = verified.payload;
  const email =
    (payload?.email as string) ||
    (payload?.preferred_username as string) ||
    null;
  if (!email) return null;

  return {
    email: email.toLowerCase(),
    idTokenNonce: typeof payload.nonce === "string" ? payload.nonce : null,
  };
}

/** Steps 3–5: the callback Microsoft redirects back to. */
export async function handleCallback(
  request: Request,
  env: Env
): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  if (!code) return withClearCookie(json({ error: "missing_code" }, 400), env);

  const state = url.searchParams.get("state");
  if (!state) return withClearCookie(json({ error: "missing_state" }, 400), env);

  const cookies = parseCookies(request.headers.get("Cookie"));
  const rawCookie = cookies.get(STATE_COOKIE_NAME);
  if (!rawCookie) return withClearCookie(json({ error: "missing_state_cookie" }, 400), env);

  const lastPipe = rawCookie.lastIndexOf("|");
  if (lastPipe < 0) return withClearCookie(json({ error: "malformed_state_cookie" }, 400), env);
  const cookiePayload = rawCookie.slice(0, lastPipe);
  const cookieSignature = rawCookie.slice(lastPipe + 1);

  const signatureValid = await hmacVerify(cookiePayload, cookieSignature, hmacSecret(env));
  if (!signatureValid) return withClearCookie(json({ error: "invalid_state_signature" }, 400), env);

  const parsed = parseStateCookieValue(cookiePayload);
  if (!parsed) return withClearCookie(json({ error: "malformed_state_cookie" }, 400), env);
  if (parsed.expiresAt < Date.now()) return withClearCookie(json({ error: "expired_state" }, 400), env);
  if (parsed.state !== state) return withClearCookie(json({ error: "state_mismatch" }, 400), env);

  const tokenResult = await exchangeCodeForEmail(code, env, parsed.codeVerifier);
  if (!tokenResult) return json({ error: "auth_failed" }, 401);

  if (tokenResult.idTokenNonce !== parsed.nonce) {
    return withClearCookie(json({ error: "nonce_mismatch" }, 400), env);
  }

  const email = tokenResult.email;

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

  let userId: string | null = null;
  const created = await admin.auth.admin.createUser({
    email,
    email_confirm: true,
    app_metadata: { atlas_role: role, provider: "azure" },
  });
  if (created.data?.user) {
    userId = created.data.user.id;
  } else {
    const existing = await findUserByEmail(admin, email);
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

  const { data: link } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email,
  });

  const returnPath = parsed.returnPath || "/";

  return withClearCookie(json({
    ok: true,
    user: { id: userId, email, role },
    action_link: link?.properties?.action_link ?? null,
    return_path: returnPath,
  }), env);
}

function withClearCookie(response: Response, env: Env): Response {
  const headers = new Headers(response.headers);
  headers.set("Set-Cookie", clearStateCookieHeader(env));
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/** POST /auth/sign-out — invalidate the user's Supabase session. */
export async function handleSignOut(
  request: Request,
  env: Env,
): Promise<Response> {
  const auth = request.headers.get("Authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return json({ error: "missing_token" }, 400);

  const admin = adminClient(env);
  const { data, error: userErr } = await admin.auth.getUser(token);
  if (userErr || !data?.user) return json({ error: "invalid_session" }, 401);

  await admin.auth.admin.signOut(token, "local");

  await audit(env, {
    action: "sign_out",
    actorId: data.user.id,
  });

  return json({ ok: true });
}
