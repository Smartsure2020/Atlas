/**
 * Atlas — Microsoft JWKS verification for id_tokens
 * ---------------------------------------------------------------------------
 * Verifies RS256 JWT signatures against Microsoft's published JWKS endpoint.
 * Runs in Cloudflare Workers using the Web Crypto API — no Node.js dependencies.
 *
 * The JWKS keys are cached in-memory for the lifetime of the worker isolate
 * (typically minutes). A cache miss fetches fresh keys from Microsoft.
 */

const MS_JWKS_URI = (tenantId: string) =>
  `https://login.microsoftonline.com/${tenantId}/discovery/v2.0/keys`;

interface JwkKey {
  kid: string;
  kty: string;
  use: string;
  n: string;
  e: string;
  x5c?: string[];
}

interface JwksResponse {
  keys: JwkKey[];
}

let cachedKeys: Map<string, CryptoKey> | null = null;
let cacheExpiry = 0;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

async function getSigningKeys(tenantId: string): Promise<Map<string, CryptoKey>> {
  if (cachedKeys && Date.now() < cacheExpiry) return cachedKeys;

  const res = await fetch(MS_JWKS_URI(tenantId));
  if (!res.ok) throw new Error("jwks_fetch_failed");

  const jwks = (await res.json()) as JwksResponse;
  const keys = new Map<string, CryptoKey>();

  for (const key of jwks.keys) {
    if (key.kty !== "RSA" || key.use !== "sig") continue;
    const cryptoKey = await crypto.subtle.importKey(
      "jwk",
      { kty: key.kty, n: key.n, e: key.e, alg: "RS256", ext: true },
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"]
    );
    keys.set(key.kid, cryptoKey);
  }

  cachedKeys = keys;
  cacheExpiry = Date.now() + CACHE_TTL_MS;
  return keys;
}

function base64UrlDecode(input: string): Uint8Array {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export interface VerifiedToken {
  payload: Record<string, unknown>;
}

/**
 * Verify an RS256-signed JWT against Microsoft's JWKS.
 * Returns the decoded payload on success, null on any failure.
 */
export async function verifyMicrosoftIdToken(
  idToken: string,
  tenantId: string,
  clientId: string,
): Promise<VerifiedToken | null> {
  try {
    const parts = idToken.split(".");
    if (parts.length !== 3) return null;

    const headerJson = new TextDecoder().decode(base64UrlDecode(parts[0]));
    const header = JSON.parse(headerJson) as { kid?: string; alg?: string };
    if (header.alg !== "RS256" || !header.kid) return null;

    const keys = await getSigningKeys(tenantId);
    const key = keys.get(header.kid);
    if (!key) {
      // Key rotation: clear cache and refetch once
      cachedKeys = null;
      const freshKeys = await getSigningKeys(tenantId);
      const freshKey = freshKeys.get(header.kid);
      if (!freshKey) return null;
      return verifyWithKey(parts, freshKey, tenantId, clientId);
    }

    return verifyWithKey(parts, key, tenantId, clientId);
  } catch {
    return null;
  }
}

async function verifyWithKey(
  parts: string[],
  key: CryptoKey,
  tenantId: string,
  clientId: string,
): Promise<VerifiedToken | null> {
  const signatureInput = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  const signature = base64UrlDecode(parts[2]);

  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    signature.buffer as ArrayBuffer,
    signatureInput,
  );
  if (!valid) return null;

  const payloadJson = new TextDecoder().decode(base64UrlDecode(parts[1]));
  const payload = JSON.parse(payloadJson) as Record<string, unknown>;

  // Validate standard claims
  const now = Math.floor(Date.now() / 1000);
  const clockSkew = 300; // 5 minutes

  if (typeof payload.exp === "number" && payload.exp + clockSkew < now) return null;
  if (typeof payload.nbf === "number" && payload.nbf - clockSkew > now) return null;

  const issuer = `https://login.microsoftonline.com/${tenantId}/v2.0`;
  if (payload.iss !== issuer) return null;

  if (payload.aud !== clientId) return null;

  return { payload };
}

/**
 * Generate a cryptographically random state parameter for CSRF protection.
 * Returns a URL-safe base64-encoded string.
 */
export function generateOAuthState(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
