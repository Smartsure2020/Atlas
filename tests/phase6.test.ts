import {
  MAX_CLIENT_UPLOAD_BYTES,
  PHASE6_AUDIT_EVENTS,
  PHASE6_RLS_TABLES,
  isDevSignInAllowed,
  normalizeAtlasRole,
  roleCanManageAppetite,
  roleCanViewManagerDashboard,
  roleCanWrite,
  safeErrorBody,
  validateEnv,
  validateUploadInput,
} from "../worker/src/phase6-hardening.js";


const tests: { name: string; fn: () => void | Promise<void> }[] = [];

function test(name: string, fn: () => void | Promise<void>) {
  tests.push({ name, fn });
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEqual<T>(actual: T, expected: T, message: string) {
  if (actual !== expected) throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
}

const env = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "service",
  SUPABASE_ANON_KEY: "anon",
  AZURE_TENANT_ID: "tenant",
  AZURE_CLIENT_ID: "client",
  AZURE_CLIENT_SECRET: "secret",
  AZURE_REDIRECT_URI: "http://localhost:8787/auth/callback",
  ANTHROPIC_API_KEY: "anthropic",
  ATLAS_ALLOWLIST_JSON: "{}",
  CORS_ORIGIN: "http://localhost:5173",
};

test("unauthorised role cannot access manager stats", () => {
  assertEqual(roleCanViewManagerDashboard("consultant"), false, "consultants should not see manager stats");
  assertEqual(roleCanViewManagerDashboard("readonly"), false, "readonly should not see manager stats");
  assertEqual(roleCanViewManagerDashboard("manager"), true, "manager should see manager stats");
});

test("non-manager cannot manage appetite or guideline rules", () => {
  assertEqual(roleCanManageAppetite("consultant"), false, "consultant cannot manage appetite");
  assertEqual(roleCanManageAppetite("readonly"), false, "readonly cannot manage appetite");
  assertEqual(roleCanManageAppetite("admin"), true, "admin can manage appetite");
});

test("readonly/auditor cannot update operational records", () => {
  assertEqual(roleCanWrite("readonly"), false, "readonly cannot write");
  assertEqual(roleCanWrite("consultant"), true, "consultant can write workflow records");
});

test("legacy underwriter claim remains consultant-compatible", () => {
  assertEqual(normalizeAtlasRole("underwriter"), "underwriter", "legacy role should be accepted");
  assertEqual(roleCanWrite("underwriter"), true, "legacy underwriter can still write consultant workflows");
});

test("upload rejects unsupported file type", () => {
  const result = validateUploadInput({
    fileName: "claims-history.docx",
    contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    sizeBytes: 1000,
  });
  assert(!result.ok && result.reason === "unsupported_file_type", "docx should be rejected");
});

test("upload rejects oversized file", () => {
  const result = validateUploadInput({
    fileName: "large.pdf",
    contentType: "application/pdf",
    sizeBytes: MAX_CLIENT_UPLOAD_BYTES + 1,
  });
  assert(!result.ok && result.reason === "file_too_large", "oversized PDF should be rejected");
});

test("API errors return consistent safe shape", () => {
  const body = safeErrorBody("permission_denied", "No access.");
  assertEqual(body.ok, false, "error ok should be false");
  assertEqual(body.error, "permission_denied", "error code should be stable");
  assert(Boolean(body.request_id), "request id should be present");
  assert(!("stack" in body), "stack should not be exposed");
});

test("production/dev environment guard works for dev-only sign-in", () => {
  assertEqual(
    isDevSignInAllowed({ ...env, ATLAS_ENV: "development" }),
    true,
    "explicit development env with local redirect should allow dev sign-in"
  );
  assertEqual(isDevSignInAllowed(env), false, "unset ATLAS_ENV must fail closed");
  assertEqual(isDevSignInAllowed({ ...env, ATLAS_ENV: "staging" }), false, "staging should block dev sign-in");
  assertEqual(isDevSignInAllowed({ ...env, ATLAS_ENV: "production" }), false, "production should block dev sign-in");
  assertEqual(
    isDevSignInAllowed({ ...env, ATLAS_ENV: "development", AZURE_REDIRECT_URI: "https://atlas.example.com/auth/callback" }),
    false,
    "development with a non-local redirect URI should block dev sign-in"
  );
  assert(validateEnv({ ...env, ATLAS_ENV: "production" }).includes("production_redirect_uri_is_local"), "production local redirect should be flagged");
  assert(validateEnv({ ...env, ATLAS_ENV: "production" }).includes("production_oauth_state_secret_missing"), "missing ATLAS_OAUTH_STATE_SECRET in production should be flagged");
});

test("all RLS-enabled tables are listed in PHASE6_RLS_TABLES (static registry check)", () => {
  // NOTE: This is a STATIC policy registry check — it verifies that the code
  // tracks the expected set of RLS-enabled tables, NOT that the database
  // policies actually enforce the expected access boundaries. For behavioural
  // RLS verification against a live database, run scripts/rls-validation.sql
  // against a local or staging Supabase instance.
  const allRlsTables = [
    "atlas_submissions", "atlas_documents", "atlas_extractions",
    "atlas_insurer_appetite", "atlas_appetite_history",
    "atlas_recommendations", "atlas_decisions", "atlas_audit_logs",
    "atlas_insurers", "atlas_insurer_documents",
    "atlas_quote_reviews", "atlas_quote_review_sections",
    "atlas_missing_info_items", "atlas_communications",
    "atlas_jobs", "atlas_cleanup_candidates", "atlas_operational_alerts",
    "atlas_pilot_issues",
  ];
  for (const table of allRlsTables) {
    assert(PHASE6_RLS_TABLES.includes(table as (typeof PHASE6_RLS_TABLES)[number]), `${table} should be covered`);
  }
  assertEqual(PHASE6_RLS_TABLES.length, allRlsTables.length, "no extra or missing tables");
});

test("audit events are tracked for decision, missing-info, and communication changes", () => {
  for (const event of ["decision_accepted", "missing_info_updated", "communication_updated", "communication_saved"]) {
    assert(PHASE6_AUDIT_EVENTS.includes(event as (typeof PHASE6_AUDIT_EVENTS)[number]), `${event} should be listed`);
  }
});

let failures = 0;
for (const t of tests) {
  try {
    await t.fn();
    console.log(`ok - ${t.name}`);
  } catch (err) {
    failures++;
    console.error(`not ok - ${t.name}`);
    console.error((err as Error).message);
  }
}

if (failures > 0) process.exitCode = 1;
