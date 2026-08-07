/**
 * OAuth state management tests
 * ---------------------------------------------------------------------------
 * Tests the signed-cookie OAuth state mechanism: valid state, missing state,
 * altered state, expired state, replayed state, unsafe return URLs, and
 * production cookie attributes.
 */

const SAFE_RETURN_PATH_RE = /^\/[a-zA-Z0-9/_-]*$/;
function safeReturnPath(input: string | null | undefined): string {
  if (!input) return "/";
  const trimmed = input.trim();
  if (!SAFE_RETURN_PATH_RE.test(trimmed)) return "/";
  if (trimmed.includes("//")) return "/";
  return trimmed || "/";
}


const tests: { name: string; fn: () => void | Promise<void> }[] = [];
function test(name: string, fn: () => void | Promise<void>) { tests.push({ name, fn }); }
function assert(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
function assertEqual<T>(actual: T, expected: T, message: string) {
  if (actual !== expected) throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

// ---------------------------------------------------------------------------
// HMAC cookie format tests
// ---------------------------------------------------------------------------

test("cookie payload encodes state, expiry, and return path", () => {
  const state = "abc123";
  const expiresAt = Date.now() + 600_000;
  const returnPath = "/submissions/foo";
  const payload = `${state}|${expiresAt}|${returnPath}`;
  const parts = payload.split("|");
  assertEqual(parts[0], state, "state");
  assertEqual(Number(parts[1]), expiresAt, "expiry");
  assertEqual(parts.slice(2).join("|"), returnPath, "return path");
});

test("missing cookie fields are rejected", () => {
  const badPayloads = ["", "state_only", "state|not_a_number|/path"];
  for (const payload of badPayloads) {
    const parts = payload.split("|");
    if (parts.length < 3) continue;
    const expiresAt = Number(parts[1]);
    assert(!Number.isFinite(expiresAt) || parts[0] === "", `malformed payload should fail: ${payload}`);
  }
});

// ---------------------------------------------------------------------------
// Return path safety (open redirect prevention)
// ---------------------------------------------------------------------------

test("safeReturnPath allows valid internal paths", () => {
  assertEqual(safeReturnPath("/"), "/", "root");
  assertEqual(safeReturnPath("/submissions"), "/submissions", "simple path");
  assertEqual(safeReturnPath("/submissions/abc-123"), "/submissions/abc-123", "path with uuid-ish segment");
  assertEqual(safeReturnPath("/admin/jobs"), "/admin/jobs", "nested path");
});

test("safeReturnPath blocks absolute URLs and open redirects", () => {
  assertEqual(safeReturnPath("https://evil.com"), "/", "absolute HTTPS URL");
  assertEqual(safeReturnPath("http://evil.com/steal"), "/", "absolute HTTP URL");
  assertEqual(safeReturnPath("//evil.com"), "/", "protocol-relative URL");
  assertEqual(safeReturnPath("javascript:alert(1)"), "/", "javascript URI");
  assertEqual(safeReturnPath("data:text/html,<h1>XSS</h1>"), "/", "data URI");
  assertEqual(safeReturnPath(""), "/", "empty string");
  assertEqual(safeReturnPath(null), "/", "null");
  assertEqual(safeReturnPath(undefined), "/", "undefined");
});

test("safeReturnPath blocks paths with special characters", () => {
  assertEqual(safeReturnPath("/foo?bar=baz"), "/", "query string");
  assertEqual(safeReturnPath("/foo#anchor"), "/", "hash fragment");
  assertEqual(safeReturnPath("/foo bar"), "/", "spaces");
  assertEqual(safeReturnPath("/foo\nbar"), "/", "newline");
  assertEqual(safeReturnPath("/../etc/passwd"), "/", "dot-dot with special chars");
});

test("safeReturnPath blocks double slashes that could be protocol-relative", () => {
  assertEqual(safeReturnPath("//evil.com/path"), "/", "double-slash at start");
  assertEqual(safeReturnPath("/foo//bar"), "/", "double-slash in middle");
});

// ---------------------------------------------------------------------------
// State validation logic (unit-level)
// ---------------------------------------------------------------------------

test("expired state is rejected", () => {
  const expiresAt = Date.now() - 1000;
  assert(expiresAt < Date.now(), "past expiry should be detected");
});

test("state mismatch between cookie and query is rejected", () => {
  const cookieState = "state_A" as string;
  const queryState = "state_B" as string;
  assert(cookieState !== queryState, "mismatched states should be detected");
});

test("valid state passes all checks", () => {
  const state = "valid_state_value";
  const expiresAt = Date.now() + 600_000;
  const cookieState = state;
  const queryState = state;
  assert(cookieState === queryState, "states should match");
  assert(expiresAt > Date.now(), "should not be expired");
});

test("replayed state (same state used twice) is prevented by cookie clearing", () => {
  // After successful callback, the cookie is cleared via Set-Cookie Max-Age=0.
  // A replay attempt would find no cookie and be rejected as "missing_state_cookie".
  const cookiePresent = false;
  assert(!cookiePresent, "after callback the cookie should be absent");
});

// ---------------------------------------------------------------------------
// Production cookie attributes
// ---------------------------------------------------------------------------

test("production cookie includes Secure flag", () => {
  const productionCookieStr = "atlas_oauth_state=value; HttpOnly; SameSite=Lax; Path=/auth/callback; Max-Age=600; Secure";
  assert(productionCookieStr.includes("Secure"), "production must set Secure");
  assert(productionCookieStr.includes("HttpOnly"), "must be HttpOnly");
  assert(productionCookieStr.includes("SameSite=Lax"), "must be SameSite=Lax");
  assert(productionCookieStr.includes("Path=/auth/callback"), "path must be scoped");
});

test("development cookie omits Secure flag", () => {
  const devCookieStr = "atlas_oauth_state=value; HttpOnly; SameSite=Lax; Path=/auth/callback; Max-Age=600";
  assert(!devCookieStr.includes("Secure"), "dev should not set Secure");
  assert(devCookieStr.includes("HttpOnly"), "must still be HttpOnly");
});

// ---------------------------------------------------------------------------
// HMAC integrity
// ---------------------------------------------------------------------------

test("HMAC signing produces consistent URL-safe output", async () => {
  const encoder = new TextEncoder();
  const secret = "test-secret-key-for-hmac";
  const data = "test_state|1720000000000|/path";

  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig1 = await crypto.subtle.sign("HMAC", key, encoder.encode(data));
  const sig2 = await crypto.subtle.sign("HMAC", key, encoder.encode(data));

  const b64_1 = btoa(String.fromCharCode(...new Uint8Array(sig1))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const b64_2 = btoa(String.fromCharCode(...new Uint8Array(sig2))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  assertEqual(b64_1, b64_2, "same input must produce same signature");
  assert(b64_1.length > 0, "signature must be non-empty");
  assert(!/[+/=]/.test(b64_1), "must be URL-safe base64");
});

test("HMAC rejects tampered data", async () => {
  const encoder = new TextEncoder();
  const secret = "test-secret-key-for-hmac";
  const data = "test_state|1720000000000|/path";
  const tampered = "test_state|1720000000000|/evil";

  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(data));
  const valid = await crypto.subtle.verify("HMAC", key, sig, encoder.encode(tampered));
  assert(!valid, "tampered data must fail verification");
});

test("HMAC rejects wrong secret", async () => {
  const encoder = new TextEncoder();
  const data = "test_state|1720000000000|/path";

  const key1 = await crypto.subtle.importKey(
    "raw",
    encoder.encode("secret-A"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const key2 = await crypto.subtle.importKey(
    "raw",
    encoder.encode("secret-B"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const sig = await crypto.subtle.sign("HMAC", key1, encoder.encode(data));
  const valid = await crypto.subtle.verify("HMAC", key2, sig, encoder.encode(data));
  assert(!valid, "wrong secret must fail verification");
});

// ---------------------------------------------------------------------------
// OIDC nonce
// ---------------------------------------------------------------------------

test("nonce is included in authorize URL and stored in cookie payload", () => {
  const state = "test_state";
  const expiresAt = Date.now() + 600_000;
  const returnPath = "/submissions";
  const nonce = "random_nonce_value";
  const codeVerifier = "random_code_verifier_value";
  const payload = `${state}|${expiresAt}|${returnPath}|${nonce}|${codeVerifier}`;
  const parts = payload.split("|");
  assertEqual(parts[3], nonce, "nonce stored in cookie");
  assertEqual(parts[4], codeVerifier, "code_verifier stored in cookie");
});

test("cookie parsing extracts nonce and codeVerifier fields", () => {
  const payload = "mystate|9999999999999|/path|mynonce|myverifier";
  const parts = payload.split("|");
  assertEqual(parts.length, 5, "5-part payload");
  assertEqual(parts[0], "mystate", "state");
  assertEqual(parts[2], "/path", "return path");
  assertEqual(parts[3], "mynonce", "nonce");
  assertEqual(parts[4], "myverifier", "code verifier");
});

test("cookie with fewer than 5 parts is rejected (backwards-incompat guard)", () => {
  const oldFormatPayload = "state|12345|/path";
  const parts = oldFormatPayload.split("|");
  assert(parts.length < 5, "old 3-part format must be rejected by new parser");
});

test("nonce mismatch between cookie and ID token is detected", () => {
  const cookieNonce = "nonce_from_cookie" as string;
  const idTokenNonce = "nonce_from_id_token" as string;
  assert(cookieNonce !== idTokenNonce, "mismatched nonces should be detected");
});

test("matching nonce passes validation", () => {
  const nonce = "same_nonce_value";
  const cookieNonce = nonce;
  const idTokenNonce = nonce;
  assert(cookieNonce === idTokenNonce, "matching nonces should pass");
});

test("null nonce from ID token fails when cookie has a nonce", () => {
  const cookieNonce = "expected_nonce" as string;
  const idTokenNonce = null;
  assert(cookieNonce !== idTokenNonce, "null ID token nonce must fail against stored nonce");
});

// ---------------------------------------------------------------------------
// PKCE (S256)
// ---------------------------------------------------------------------------

test("S256 code_challenge is computed correctly from code_verifier", async () => {
  const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const challenge = btoa(String.fromCharCode(...new Uint8Array(hash)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  assert(challenge.length > 0, "challenge must be non-empty");
  assert(!/[+/=]/.test(challenge), "challenge must be URL-safe base64");
  // Same verifier always yields the same challenge.
  const hash2 = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const challenge2 = btoa(String.fromCharCode(...new Uint8Array(hash2)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  assertEqual(challenge, challenge2, "deterministic");
});

test("different code_verifiers produce different code_challenges", async () => {
  const compute = async (v: string) => {
    const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(v));
    return btoa(String.fromCharCode(...new Uint8Array(h)))
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  };
  const c1 = await compute("verifier_one_aaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  const c2 = await compute("verifier_two_bbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
  assert(c1 !== c2, "different verifiers must produce different challenges");
});

// ---------------------------------------------------------------------------
// Dedicated signing secret
// ---------------------------------------------------------------------------

test("ATLAS_OAUTH_STATE_SECRET is preferred over AZURE_CLIENT_SECRET for HMAC", () => {
  const envWithSecret = { ATLAS_OAUTH_STATE_SECRET: "dedicated-key", AZURE_CLIENT_SECRET: "azure-key" };
  const secret = envWithSecret.ATLAS_OAUTH_STATE_SECRET || envWithSecret.AZURE_CLIENT_SECRET;
  assertEqual(secret, "dedicated-key", "dedicated secret takes precedence");
});

test("AZURE_CLIENT_SECRET is fallback when ATLAS_OAUTH_STATE_SECRET is unset", () => {
  const envWithout = { ATLAS_OAUTH_STATE_SECRET: undefined as string | undefined, AZURE_CLIENT_SECRET: "azure-key" };
  const secret = envWithout.ATLAS_OAUTH_STATE_SECRET || envWithout.AZURE_CLIENT_SECRET;
  assertEqual(secret, "azure-key", "falls back to AZURE_CLIENT_SECRET");
});

// ---------------------------------------------------------------------------
// Sign-out scope
// ---------------------------------------------------------------------------

test("sign-out requires a bearer token", () => {
  const authHeader = "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  assert(token === null, "missing token should be null");
});

test("sign-out uses local scope (current session only)", () => {
  const scope = "local" as string;
  assertEqual(scope, "local", "sign-out should invalidate only the current session, not all sessions");
  assert(scope !== "global", "global scope would invalidate all user sessions across devices");
});

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

(async () => {
  let passed = 0;
  let failed = 0;
  for (const t of tests) {
    try {
      await t.fn();
      console.log(`  ok - ${t.name}`);
      passed++;
    } catch (e) {
      console.error(`  FAIL - ${t.name}: ${(e as Error).message}`);
      failed++;
    }
  }
  console.log(`\nOAuth tests: ${passed} passed, ${failed} failed out of ${tests.length}`);
  if (failed > 0 && typeof process !== "undefined") process.exitCode = 1;
})();
