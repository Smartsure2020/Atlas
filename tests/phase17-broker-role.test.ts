/**
 * Phase 17 (Quote Pipeline — broker role) — role model + capability tests
 * ---------------------------------------------------------------------------
 * In-process assertions against the Worker's role parsing, narrow capability
 * helpers, access-scope semantics, and the assignment RPC HTTP mapping for
 * target_not_assignable. The corresponding live RLS matrix is exercised in
 * the staging Phase 3 gate (production is not touched).
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  ROLE_LABELS,
  normalizeAtlasRole,
  roleCanCreateSubmission,
  roleCanManageAppetite,
  roleCanRunExtraction,
  roleCanUploadClientDocument,
  roleCanViewManagerDashboard,
  roleCanViewUnderwritingIntelligence,
  roleCanWrite,
} from "../worker/src/phase6-hardening.js";
import { resolveRoleFromAllowlist, type AtlasRole, type Env } from "../worker/src/config.js";
import { mapAssignmentRpcResult } from "../worker/src/assignment-helpers.js";
import type { AssignmentRpcResult } from "../worker/src/quote-pipeline-types.js";
import { ASSIGNMENT_OUTCOMES } from "../worker/src/quote-pipeline-types.js";

const tests: { name: string; fn: () => void | Promise<void> }[] = [];
function test(name: string, fn: () => void | Promise<void>) {
  tests.push({ name, fn });
}
function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

// ---------------------------------------------------------------------------
// resolveRoleFromAllowlist
// ---------------------------------------------------------------------------

function envWithAllowlist(map: Record<string, string>): Env {
  return { ATLAS_ALLOWLIST_JSON: JSON.stringify(map) } as unknown as Env;
}

test("allowlist accepts broker", () => {
  const env = envWithAllowlist({ "broker@example.com": "broker" });
  assert(resolveRoleFromAllowlist("broker@example.com", env) === "broker", "broker not resolved");
});

test("allowlist accepts existing internal roles unchanged", () => {
  const env = envWithAllowlist({
    "mgr@example.com": "manager",
    "ux@example.com": "underwriter",
    "cs@example.com": "consultant",
    "ad@example.com": "admin",
    "ro@example.com": "readonly",
  });
  assert(resolveRoleFromAllowlist("mgr@example.com", env) === "manager", "manager");
  assert(resolveRoleFromAllowlist("ux@example.com", env) === "underwriter", "underwriter");
  assert(resolveRoleFromAllowlist("cs@example.com", env) === "consultant", "consultant");
  assert(resolveRoleFromAllowlist("ad@example.com", env) === "admin", "admin");
  assert(resolveRoleFromAllowlist("ro@example.com", env) === "readonly", "readonly");
});

test("allowlist rejects unknown role", () => {
  const env = envWithAllowlist({ "x@example.com": "super_admin" });
  assert(resolveRoleFromAllowlist("x@example.com", env) === null, "unknown must be null");
});

test("allowlist rejects missing email", () => {
  const env = envWithAllowlist({});
  assert(resolveRoleFromAllowlist("nobody@example.com", env) === null, "missing must be null");
});

test("allowlist fails closed on malformed JSON", () => {
  const env = { ATLAS_ALLOWLIST_JSON: "{not json" } as unknown as Env;
  assert(resolveRoleFromAllowlist("anyone@example.com", env) === null, "malformed must be null");
});

// ---------------------------------------------------------------------------
// normalizeAtlasRole
// ---------------------------------------------------------------------------

test('normalizeAtlasRole("broker") returns broker', () => {
  assert(normalizeAtlasRole("broker") === "broker", "broker not normalised");
});

test("normalizeAtlasRole preserves existing internal roles", () => {
  assert(normalizeAtlasRole("admin") === "admin", "admin");
  assert(normalizeAtlasRole("manager") === "manager", "manager");
  assert(normalizeAtlasRole("consultant") === "consultant", "consultant");
  assert(normalizeAtlasRole("readonly") === "readonly", "readonly");
  assert(normalizeAtlasRole("auditor") === "readonly", "auditor→readonly");
  assert(normalizeAtlasRole("underwriter") === "underwriter", "underwriter");
});

test("normalizeAtlasRole returns null on unknown", () => {
  assert(normalizeAtlasRole("intern") === null, "intern");
  assert(normalizeAtlasRole(undefined) === null, "undefined");
  assert(normalizeAtlasRole(null) === null, "null");
  assert(normalizeAtlasRole({}) === null, "object");
});

// ---------------------------------------------------------------------------
// ROLE_LABELS
// ---------------------------------------------------------------------------

test("ROLE_LABELS covers every role including broker", () => {
  const roles: AtlasRole[] = ["admin", "manager", "consultant", "readonly", "underwriter", "broker"];
  for (const r of roles) assert(typeof ROLE_LABELS[r] === "string", `missing label for ${r}`);
});

// ---------------------------------------------------------------------------
// Capability truth table
// ---------------------------------------------------------------------------

test("roleCanWrite excludes broker AND readonly", () => {
  assert(roleCanWrite("admin") === true, "admin");
  assert(roleCanWrite("manager") === true, "manager");
  assert(roleCanWrite("consultant") === true, "consultant");
  assert(roleCanWrite("underwriter") === true, "underwriter");
  assert(roleCanWrite("readonly") === false, "readonly");
  assert(roleCanWrite("broker") === false, "broker MUST NOT be a generic writer");
});

test("roleCanManageAppetite is manager/admin only", () => {
  assert(roleCanManageAppetite("admin") === true, "admin");
  assert(roleCanManageAppetite("manager") === true, "manager");
  for (const r of ["consultant", "underwriter", "readonly", "broker"] as AtlasRole[]) {
    assert(roleCanManageAppetite(r) === false, `${r} must be blocked`);
  }
});

test("roleCanRunExtraction is manager/admin only", () => {
  assert(roleCanRunExtraction("admin") === true, "admin");
  assert(roleCanRunExtraction("manager") === true, "manager");
  for (const r of ["consultant", "underwriter", "readonly", "broker"] as AtlasRole[]) {
    assert(roleCanRunExtraction(r) === false, `${r} must be blocked`);
  }
});

test("roleCanViewManagerDashboard is manager/admin only", () => {
  assert(roleCanViewManagerDashboard("admin") === true, "admin");
  assert(roleCanViewManagerDashboard("manager") === true, "manager");
  for (const r of ["consultant", "underwriter", "readonly", "broker"] as AtlasRole[]) {
    assert(roleCanViewManagerDashboard(r) === false, `${r} must be blocked`);
  }
});

test("roleCanCreateSubmission includes broker + internal writers, excludes readonly", () => {
  for (const r of ["admin", "manager", "consultant", "underwriter", "broker"] as AtlasRole[]) {
    assert(roleCanCreateSubmission(r) === true, `${r} must be allowed`);
  }
  assert(roleCanCreateSubmission("readonly") === false, "readonly must be blocked");
});

test("roleCanUploadClientDocument includes broker + internal writers, excludes readonly", () => {
  for (const r of ["admin", "manager", "consultant", "underwriter", "broker"] as AtlasRole[]) {
    assert(roleCanUploadClientDocument(r) === true, `${r} must be allowed`);
  }
  assert(roleCanUploadClientDocument("readonly") === false, "readonly must be blocked");
});

test("roleCanViewUnderwritingIntelligence excludes broker; includes readonly", () => {
  for (const r of ["admin", "manager", "consultant", "underwriter", "readonly"] as AtlasRole[]) {
    assert(roleCanViewUnderwritingIntelligence(r) === true, `${r} must be allowed`);
  }
  assert(
    roleCanViewUnderwritingIntelligence("broker") === false,
    "broker MUST NOT see underwriting intelligence"
  );
});

// ---------------------------------------------------------------------------
// Assignment outcome mapping
// ---------------------------------------------------------------------------

test("target_not_assignable is present in ASSIGNMENT_OUTCOMES", () => {
  assert(
    (ASSIGNMENT_OUTCOMES as readonly string[]).includes("target_not_assignable"),
    "outcome missing"
  );
});

test("mapAssignmentRpcResult(target_not_assignable) returns HTTP 409", () => {
  const r: AssignmentRpcResult = { outcome: "target_not_assignable", submission_id: "s" };
  const mapped = mapAssignmentRpcResult(r);
  assert(mapped.status === 409, `expected 409 got ${mapped.status}`);
  assert(mapped.body.ok === false, "ok must be false");
  assert(mapped.body.error === "validation_failed", "error code");
});

test("mapAssignmentRpcResult never leaks role/email in target_not_assignable body", () => {
  const r: AssignmentRpcResult = { outcome: "target_not_assignable", submission_id: "s" };
  const body = JSON.stringify(mapAssignmentRpcResult(r).body);
  assert(!/broker|underwriter|consultant|readonly|manager|admin|@/i.test(body),
    "body must not leak role or email fragments");
});

// ---------------------------------------------------------------------------
// Migration 0025 must exist and declare the expected guarantees
// ---------------------------------------------------------------------------

const SRC = readFileSync(
  resolve(process.cwd(), "supabase/migrations/0025_broker_role_and_rls.sql"),
  "utf8"
);

test("migration 0025 exists and is broker-role migration", () => {
  assert(/broker/.test(SRC), "must mention broker");
  assert(/create or replace function public.atlas_is_broker/i.test(SRC), "atlas_is_broker helper");
  assert(/create or replace function public.atlas_is_atlas_user/i.test(SRC), "atlas_is_atlas_user helper");
});

test("migration 0025 replaces atlas_can_access_submission with broker branch", () => {
  const fn = SRC.split("atlas_can_access_submission(p_submission_id uuid)")[1] ?? "";
  assert(fn.length > 0, "atlas_can_access_submission not replaced");
  assert(/'broker'/.test(fn), "broker branch not present");
  assert(/s\.created_by\s*=\s*\(select uid from r\)/.test(fn) || /created_by\s*=\s*\(select uid from r\)/.test(fn), "broker branch must check created_by only");
});

test("migration 0025 tightens SELECT policies on underwriting-intelligence tables", () => {
  const tables = [
    "atlas_extractions",
    "atlas_recommendations",
    "atlas_decisions",
    "atlas_quote_reviews",
    "atlas_quote_review_sections",
    "atlas_communications",
  ];
  for (const t of tables) {
    const re = new RegExp(`create policy [a-z_]*_scoped_select on public\\.${t}[\\s\\S]*?public\\.atlas_is_staff\\(\\)[\\s\\S]*?atlas_can_access_submission`, "i");
    assert(re.test(SRC), `${t} SELECT policy must require atlas_is_staff()`);
  }
});

test("migration 0025 does NOT add broker to atlas_can_write / staff manager helpers", () => {
  // Function bodies for atlas_can_write / atlas_is_staff must not appear as
  // replacements in this migration; if they do, they must not include broker.
  assert(!/create or replace function public\.atlas_can_write/i.test(SRC),
    "atlas_can_write must NOT be replaced in this migration");
});

test("migration 0025 hardens assignment target with target_not_assignable outcome", () => {
  assert(/target_not_assignable/.test(SRC), "target_not_assignable outcome missing");
  assert(/atlas_set_submission_assignment/.test(SRC), "manual RPC not replaced");
  assert(/raw_app_meta_data\s*->>\s*'atlas_role'/.test(SRC), "trusted role read missing");
  assert(/underwriter[',\s]+.*consultant[',\s]+.*manager[',\s]+.*admin/is.test(SRC),
    "assignable role set must be underwriter|consultant|manager|admin");
});

test("migration 0025 filters auto-assignment candidates by trusted role", () => {
  const chunk = SRC.split("atlas_auto_assign_submission")[1] ?? "";
  assert(/from auth\.users u/i.test(chunk), "candidate role subquery must reference auth.users");
  assert(/atlas_role/i.test(chunk) && /raw_app_meta_data/i.test(chunk),
    "candidate role subquery must read raw_app_meta_data->>atlas_role");
});

// ---------------------------------------------------------------------------
// Worker router / access-scope structural checks
// ---------------------------------------------------------------------------

const WORKER_INDEX = readFileSync(resolve(process.cwd(), "worker/src/index.ts"), "utf8");
const ACCESS_SCOPE = readFileSync(resolve(process.cwd(), "worker/src/access-scope.ts"), "utf8");

test("access-scope: broker never in canViewAllSubmissions", () => {
  assert(/user\.role === "broker"[\s\S]*?return false/.test(ACCESS_SCOPE),
    "canViewAllSubmissions must short-circuit broker to false");
});

test("access-scope: broker canAccessSubmission is created_by only", () => {
  assert(/user\.role === "broker"[\s\S]*?data\.created_by === user\.id/.test(ACCESS_SCOPE),
    "broker branch must check created_by only");
});

test("access-scope: scopedSubmissionOr for broker excludes assigned_to and assigned_underwriter", () => {
  assert(/user\.role === "broker"[\s\S]*?return `created_by\.eq\.\$\{user\.id\}`/.test(ACCESS_SCOPE),
    "broker scope filter must be created_by only");
});

test("router: POST /api/submissions gated by roleCanCreateSubmission", () => {
  const match = WORKER_INDEX.match(/pathname === "\/api\/submissions" && request\.method === "POST"[\s\S]{0,300}/);
  assert(match && /roleCanCreateSubmission/.test(match[0]),
    "POST /api/submissions must use roleCanCreateSubmission");
});

test("router: broker explicitly rejected on assignment mutation + auto-assign", () => {
  assert(/sub === "\/assignment" && request\.method === "PATCH"[\s\S]{0,400}user\.role === "broker"/.test(WORKER_INDEX),
    "PATCH /assignment must explicitly reject broker");
  assert(/sub === "\/assignment\/auto" && request\.method === "POST"[\s\S]{0,400}user\.role === "broker"/.test(WORKER_INDEX),
    "POST /assignment/auto must explicitly reject broker");
});

test("router: underwriting-intelligence GET routes gated", () => {
  const routes = ["/recommendation", "/quote-review", "/decision", "/communications"];
  for (const r of routes) {
    const idx = WORKER_INDEX.indexOf(`sub === "${r}" && request.method === "GET"`);
    assert(idx >= 0, `route ${r} GET missing`);
    const slice = WORKER_INDEX.slice(idx, idx + 400);
    assert(/roleCanViewUnderwritingIntelligence/.test(slice),
      `GET ${r} must be gated by roleCanViewUnderwritingIntelligence`);
  }
});

test("router: GET /api/insurers gated for underwriting intelligence", () => {
  const match = WORKER_INDEX.match(/pathname === "\/api\/insurers" && request\.method === "GET"[\s\S]{0,400}/);
  assert(match && /roleCanViewUnderwritingIntelligence/.test(match[0]),
    "GET /api/insurers must be gated");
});

test("router: pilot sub-routes explicitly reject broker", () => {
  assert(/sub === "\/pilot" && request\.method === "PATCH"[\s\S]{0,400}user\.role === "broker"/.test(WORKER_INDEX),
    "PATCH /pilot must reject broker");
});

// ---------------------------------------------------------------------------
// createSubmission handler surgery
// ---------------------------------------------------------------------------

test("createSubmission: broker cannot inject assignment", () => {
  const s = WORKER_INDEX.split("async function createSubmission")[1] ?? "";
  assert(/isBroker && \(body\.assigned_to != null \|\| body\.assigned_underwriter != null\)/.test(s),
    "broker with non-null assignment must be rejected");
});

test("createSubmission: broker path forces created_by from user.id", () => {
  const s = WORKER_INDEX.split("async function createSubmission")[1] ?? "";
  assert(/created_by: user\.id/.test(s), "created_by must be user.id (not from body)");
});

test("createSubmission: broker path forces null assignment fields", () => {
  const s = WORKER_INDEX.split("async function createSubmission")[1] ?? "";
  assert(/assigned_underwriter: isBroker \? null/.test(s), "assigned_underwriter must be null for broker");
  assert(/assigned_to: isBroker \? null/.test(s), "assigned_to must be null for broker");
  assert(/assigned_at: isBroker[\s\S]{0,50}null/.test(s), "assigned_at must be null for broker");
  assert(/assigned_by: isBroker[\s\S]{0,50}null/.test(s), "assigned_by must be null for broker");
});

test("createSubmission: broker identity prefers user.email over body.broker_email", () => {
  const s = WORKER_INDEX.split("async function createSubmission")[1] ?? "";
  assert(/isBroker \? \(user\.email/.test(s),
    "broker email must be derived from user.email first");
});

// ---------------------------------------------------------------------------
// handleGetSubmission broker-safe projection
// ---------------------------------------------------------------------------

const SUB_ENDPOINT = readFileSync(resolve(process.cwd(), "worker/src/submission-endpoints.ts"), "utf8");

test("handleGetSubmission: broker projection returns extraction:null and jobs:null", () => {
  assert(/user\.role === "broker"/.test(SUB_ENDPOINT), "broker branch missing");
  assert(/extraction: null/.test(SUB_ENDPOINT), "extraction must be nullified for broker");
  assert(/jobs: null/.test(SUB_ENDPOINT), "jobs must be nullified for broker");
});

test("handleGetSubmission: broker projection scrubs broker_email_body", () => {
  const m = SUB_ENDPOINT.match(/user\.role === "broker"[\s\S]{0,700}/);
  assert(m && /broker_email_body: null/.test(m[0]),
    "broker_email_body (raw pasted broker email) must be scrubbed");
});

// ---------------------------------------------------------------------------
// List projection: broker list responses MUST NOT expose active_job
// ---------------------------------------------------------------------------

test("withAssigneeEmails: broker branch nullifies active_job at the response boundary", () => {
  const s = WORKER_INDEX.split("async function withAssigneeEmails")[1] ?? "";
  assert(s.length > 0, "withAssigneeEmails not found");
  // The helper must derive an isBroker flag from the passed user.role.
  assert(/user\.role === "broker"/.test(s),
    "withAssigneeEmails must branch on user.role === \"broker\"");
  // Broker path must not run the atlas_jobs SELECT query (skip the join).
  assert(/!isBroker && submissionIds\.length > 0[\s\S]*?from\("atlas_jobs"\)/.test(s),
    "broker path must skip the atlas_jobs SELECT join entirely");
  // Broker path must never attach an active_job payload to any row.
  assert(/isBroker \? undefined : jobsBySubmission\.get/.test(s),
    "broker rows must never receive an active_job lookup result");
});

test("listSubmissions: every withAssigneeEmails call passes the user through", () => {
  // Grep withAssigneeEmails call sites — each must include the user arg so
  // the broker projection is enforced regardless of which fallback tier was
  // taken (phase15, phase1, or the pre-phase7 shape). Use a paren-balancing
  // walk instead of a naive regex — some call sites span nested parens
  // across multiple lines (e.g. `phase1Data ?? []`).
  const indexes: number[] = [];
  const needle = "withAssigneeEmails(";
  for (let i = 0; ; ) {
    const at = WORKER_INDEX.indexOf(needle, i);
    if (at < 0) break;
    // Skip the function DEFINITION site (immediately preceded by `function`).
    const before = WORKER_INDEX.slice(Math.max(0, at - 32), at);
    if (/function\s+$/.test(before)) {
      i = at + needle.length;
      continue;
    }
    indexes.push(at);
    i = at + needle.length;
  }
  assert(indexes.length >= 3, `expected at least 3 call sites, got ${indexes.length}`);
  for (const start of indexes) {
    let depth = 0;
    let end = -1;
    for (let i = start + needle.length - 1; i < WORKER_INDEX.length; i++) {
      const ch = WORKER_INDEX[i];
      if (ch === "(") depth++;
      else if (ch === ")") {
        depth--;
        if (depth === 0) { end = i + 1; break; }
      }
    }
    assert(end > 0, "withAssigneeEmails call not paren-balanced");
    const call = WORKER_INDEX.slice(start, end);
    assert(/\buser\b/.test(call),
      `withAssigneeEmails call missing user arg (chars ${start}..${end}):\n${call}`);
  }
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
      console.log(`  ✓ ${t.name}`);
      passed++;
    } catch (e) {
      console.error(`  ✗ ${t.name}: ${(e as Error).message}`);
      failed++;
    }
  }
  console.log(`\nPhase 17 broker role: ${passed} passed, ${failed} failed out of ${tests.length}`);
  if (failed > 0 && typeof process !== "undefined") process.exitCode = 1;
})();
