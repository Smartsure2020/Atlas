/**
 * Pure OAuth redirect helpers — extracted from oauth.ts so tests can exercise
 * the actual production implementation without pulling the Worker's runtime
 * module graph (Supabase client, Microsoft JWKS, user directory) into the
 * test compiler. Contains no side-effectful imports; only the `Env` type.
 */

import type { Env } from "./config";

const SAFE_RETURN_PATH_RE = /^\/[a-zA-Z0-9/_-]*$/;

/**
 * Restrict a caller-supplied return path to a safe internal path. Anything
 * that could be interpreted as an absolute URL, protocol-relative URL,
 * javascript:/data: scheme, or that carries query/hash/whitespace/dot-dot is
 * collapsed to "/". Doubled slashes anywhere are also rejected.
 */
export function safeReturnPath(input: string | null | undefined): string {
  if (!input) return "/";
  const trimmed = input.trim();
  if (!SAFE_RETURN_PATH_RE.test(trimmed)) return "/";
  if (trimmed.includes("//")) return "/";
  return trimmed || "/";
}

/**
 * Build the browser destination Supabase should redirect to after it verifies
 * the magiclink. Composed from CORS_ORIGIN's origin (scheme + host + optional
 * port) plus safeReturnPath(returnPath). Returns null when no acceptable
 * frontend origin is configured — the caller then falls back to the legacy
 * JSON response, which is safe because there is no attacker-controlled URL to
 * redirect to. Production requires HTTPS; local (http://localhost) is accepted
 * only in non-production environments.
 */
export function resolveFrontendRedirectTarget(
  env: Env,
  returnPath: string,
): string | null {
  const raw = env.CORS_ORIGIN;
  if (!raw) return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  if (env.ATLAS_ENV === "production" && parsed.protocol !== "https:") return null;
  return `${parsed.origin}${safeReturnPath(returnPath)}`;
}
