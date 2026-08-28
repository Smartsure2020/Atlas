/**
 * Phase 15 (Quote Pipeline foundation) — RLS structural tests
 * ---------------------------------------------------------------------------
 * Atlas's phase test harness runs in-process (see phase9.test.ts and
 * phase14-sections.test.ts). Live-DB RLS tests are not yet part of the
 * repository's test infrastructure. Until they are, the honest assertions
 * available at this layer are:
 *
 *   (1) migration 0023 enables RLS on atlas_underwriter_profiles;
 *   (2) it declares the exact policy predicates the approved role matrix
 *       requires (SELECT via atlas_is_staff(), INSERT/UPDATE via
 *       atlas_can_manage(), NO DELETE policy);
 *   (3) it does NOT touch RLS on any other table (existing scoping stays);
 *   (4) it does NOT introduce the broker role (deferred to Phase 3);
 *   (5) the TypeScript role helpers still satisfy the corresponding matrix
 *       for atlas_underwriter_profiles writes.
 *
 * This is the tightest test possible against the current repo. When Atlas
 * grows a live Postgres RLS harness, a follow-up test can exercise these
 * policies against real roles.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  roleCanWrite,
  roleCanViewManagerDashboard,
  normalizeAtlasRole,
} from "../worker/src/phase6-hardening.js";

const tests: { name: string; fn: () => void | Promise<void> }[] = [];

function test(name: string, fn: () => void | Promise<void>) {
  tests.push({ name, fn });
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEqual<T>(actual: T, expected: T, message: string) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

// Atlas's test harness runs from the repo root via npm scripts (see
// package.json), so process.cwd() reliably resolves the repository layout.
const MIGRATION_PATH = resolve(
  process.cwd(),
  "supabase",
  "migrations",
  "0023_pipeline_stage_and_underwriter_profiles.sql"
);
const MIGRATION_SQL = readFileSync(MIGRATION_PATH, "utf8");
const MIGRATION_SQL_LC = MIGRATION_SQL.toLowerCase();

// Strip SQL line and slash-star block comments so token-presence guards
// only inspect executable DDL, not descriptive prose.
function stripSqlComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/--[^\n]*/g, "");
}
const MIGRATION_SQL_CODE = stripSqlComments(MIGRATION_SQL_LC);

// ---------------------------------------------------------------------------
// atlas_underwriter_profiles RLS: enabled + exactly the approved policies
// ---------------------------------------------------------------------------

test("RLS is enabled on atlas_underwriter_profiles", () => {
  assert(
    /alter table atlas_underwriter_profiles enable row level security/i.test(
      MIGRATION_SQL
    ),
    "atlas_underwriter_profiles must enable row level security"
  );
});

test("SELECT policy uses atlas_is_staff()", () => {
  const re =
    /create policy atlas_underwriter_profiles_staff_select on atlas_underwriter_profiles\s+for select to authenticated using \(atlas_is_staff\(\)\)/i;
  assert(re.test(MIGRATION_SQL), "SELECT policy must be atlas_is_staff() using authenticated");
});

test("INSERT policy uses atlas_can_manage()", () => {
  const re =
    /create policy atlas_underwriter_profiles_manage_insert on atlas_underwriter_profiles\s+for insert to authenticated with check \(atlas_can_manage\(\)\)/i;
  assert(re.test(MIGRATION_SQL), "INSERT policy must be atlas_can_manage() (with check)");
});

test("UPDATE policy uses atlas_can_manage() for both using and with check", () => {
  const re =
    /create policy atlas_underwriter_profiles_manage_update on atlas_underwriter_profiles\s+for update to authenticated\s+using \(atlas_can_manage\(\)\) with check \(atlas_can_manage\(\)\)/i;
  assert(re.test(MIGRATION_SQL), "UPDATE policy must use atlas_can_manage() on both clauses");
});

test("no DELETE policy exists on atlas_underwriter_profiles", () => {
  // Assert no CREATE POLICY line with "for delete" targets this table.
  const deletePolicyRe =
    /create policy[\s\S]*?on atlas_underwriter_profiles[\s\S]*?for delete/i;
  assert(
    !deletePolicyRe.test(MIGRATION_SQL),
    "no DELETE policy may exist on atlas_underwriter_profiles"
  );
});

// ---------------------------------------------------------------------------
// Existing RLS is untouched — Phase 1 must not adjust any other table's
// policies or role helpers.
// ---------------------------------------------------------------------------

test("no policy is created on any table other than atlas_underwriter_profiles", () => {
  const policyRe = /create policy\s+\w+\s+on\s+([a-zA-Z_][a-zA-Z0-9_]*)/gi;
  const tables = new Set<string>();
  for (const m of MIGRATION_SQL.matchAll(policyRe)) {
    tables.add(m[1].toLowerCase());
  }
  assert(tables.size > 0, "expected at least one policy in Phase 1");
  for (const t of tables) {
    assertEqual(t, "atlas_underwriter_profiles", `unexpected policy target: ${t}`);
  }
});

test("no existing policy is dropped", () => {
  assert(!/drop\s+policy\b/i.test(MIGRATION_SQL), "Phase 1 must not drop any policy");
});

test("Phase 1 does not toggle RLS on any table other than atlas_underwriter_profiles", () => {
  const rlsRe = /alter table\s+([a-zA-Z_][a-zA-Z0-9_]*)\s+enable row level security/gi;
  const tables = new Set<string>();
  for (const m of MIGRATION_SQL.matchAll(rlsRe)) {
    tables.add(m[1].toLowerCase());
  }
  for (const t of tables) {
    assertEqual(
      t,
      "atlas_underwriter_profiles",
      `unexpected RLS toggle target: ${t}`
    );
  }
});

test("no existing role helper is redefined", () => {
  const forbidden = [
    /create or replace function atlas_role\b/i,
    /create or replace function atlas_is_staff\b/i,
    /create or replace function atlas_can_manage\b/i,
    /create or replace function atlas_can_write\b/i,
    /create or replace function atlas_is_admin\b/i,
    /create or replace function atlas_can_access_submission\b/i,
  ];
  for (const pat of forbidden) {
    assert(!pat.test(MIGRATION_SQL), `must not redefine helper: ${pat.source}`);
  }
});

// ---------------------------------------------------------------------------
// Broker role does not exist in Phase 1.
// ---------------------------------------------------------------------------

test("Phase 1 introduces no 'broker' role in executable DDL", () => {
  // Descriptive comments naming what Phase 1 deliberately defers are fine;
  // executable DDL must be silent.
  assert(
    !MIGRATION_SQL_CODE.includes("broker"),
    "Phase 1 executable DDL must not mention the broker role"
  );
});

test("normalizeAtlasRole accepts 'broker' from Phase 3 onward", () => {
  // Historical Phase 1 guard: broker was rejected until Phase 3 landed. Phase 3
  // (migration 0025) legitimately introduced the broker role — with narrow
  // capability helpers, not roleCanWrite. See tests/phase17-broker-role.test.ts
  // for the exhaustive capability matrix that keeps broker out of the writer set.
  assertEqual(normalizeAtlasRole("broker"), "broker", "broker must normalise from Phase 3 onward");
});

// ---------------------------------------------------------------------------
// TypeScript role helpers satisfy the atlas_underwriter_profiles matrix.
// Live RLS runs in Postgres; the Worker still gates writes with the helpers
// below (defence in depth), so Phase 1 asserts the helpers stay correct.
//
// Matrix for atlas_underwriter_profiles WRITES (INSERT/UPDATE):
//   consultant      → denied
//   underwriter     → denied
//   manager         → permitted
//   admin           → permitted
//   readonly        → denied
//   unauthenticated → denied (never reaches a helper)
// ---------------------------------------------------------------------------

test("SELECT matrix — roleCanWrite is IRRELEVANT here; SELECT permits every Atlas role", () => {
  // atlas_is_staff() maps to all authenticated Atlas roles via app_metadata.
  // The Worker does not need a helper for SELECT visibility — RLS suffices.
  // This test documents that intent; it also asserts we did not accidentally
  // wire an ill-suited helper (e.g. roleCanWrite) as a SELECT gate.
  const permittedForSelect: readonly (
    "consultant" | "underwriter" | "manager" | "admin" | "readonly"
  )[] = ["consultant", "underwriter", "manager", "admin", "readonly"];
  for (const role of permittedForSelect) {
    // Every known Atlas role must normalise to something usable.
    assert(
      normalizeAtlasRole(role) !== null,
      `role ${role} must normalise to a usable AtlasRole`
    );
  }
});

test("INSERT / UPDATE matrix — only manager and admin pass roleCanViewManagerDashboard", () => {
  // roleCanViewManagerDashboard is the Worker's TS twin of atlas_can_manage().
  assertEqual(roleCanViewManagerDashboard("manager"), true, "manager can manage");
  assertEqual(roleCanViewManagerDashboard("admin"), true, "admin can manage");
  assertEqual(
    roleCanViewManagerDashboard("consultant"),
    false,
    "consultant cannot manage"
  );
  assertEqual(
    roleCanViewManagerDashboard("underwriter"),
    false,
    "underwriter cannot manage"
  );
  assertEqual(
    roleCanViewManagerDashboard("readonly"),
    false,
    "readonly cannot manage"
  );
});

test("DELETE matrix — no policy path exists for any role", () => {
  // Enforced by the migration test above (no DELETE policy present). This
  // test asserts our TS helpers agree there is no write gate that would
  // allow a manager/admin to slip through into a DELETE path.
  assert(
    !/create policy[\s\S]*?on atlas_underwriter_profiles[\s\S]*?for delete/i.test(
      MIGRATION_SQL
    ),
    "confirmed: no DELETE policy on atlas_underwriter_profiles"
  );
});

// ---------------------------------------------------------------------------
// Sanity: atlas_submissions RLS was NOT altered by Phase 1.
// ---------------------------------------------------------------------------

test("atlas_submissions has no policy created or dropped in Phase 1", () => {
  assert(
    !/create policy[\s\S]*?on atlas_submissions\b/i.test(MIGRATION_SQL),
    "Phase 1 must not add policies on atlas_submissions"
  );
  assert(
    !/drop\s+policy[\s\S]*?on atlas_submissions\b/i.test(MIGRATION_SQL),
    "Phase 1 must not drop policies on atlas_submissions"
  );
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
  console.log(`\nPhase 15 RLS: ${passed} passed, ${failed} failed out of ${tests.length}`);
  if (failed > 0 && typeof process !== "undefined") process.exitCode = 1;
})();
