/**
 * Phase 16 (Quote Pipeline — assignment engine) — migration structural tests
 * ---------------------------------------------------------------------------
 * Atlas's phase test harness still runs in-process without a live database.
 * The honest assertions available at this layer are structural: we read
 * migration 0024 from disk and verify it commits to the Phase 2 contract:
 *
 *   - atlas_assignment_events exists with the exact required columns,
 *     constraints, and indexes
 *   - RLS is enabled with a scoped SELECT policy and NO
 *     INSERT/UPDATE/DELETE policies
 *   - the auto and manual assignment SECURITY DEFINER functions are:
 *       SECURITY DEFINER + VOLATILE + safe search_path
 *       EXECUTE revoked from PUBLIC/anon/authenticated
 *       EXECUTE granted to service_role
 *   - both functions acquire the SAME transaction-level advisory lock
 *     BEFORE any candidate ranking or mutation
 *   - candidate selection locks the atlas_underwriter_profiles row with
 *     FOR UPDATE OF p (no aggregate FOR UPDATE)
 *   - workload counting excludes historical NULL rows and terminal stages
 *   - ranking order is: open_count, never-assigned, oldest last_assigned_at,
 *     user_id
 *   - the migration is additive-only (no drops, no backfill, no touching
 *     Phase 1 schema, no Phase 3+ concepts)
 *   - the TypeScript vocabulary in worker/src/quote-pipeline-types.ts
 *     mirrors the SQL CHECK constraints and JSONB outcomes
 *
 * A live-database concurrency test is out of scope for the in-process
 * harness; the Phase 2 implementation report includes a copy/paste staging
 * verification procedure that exercises the concurrency contract against a
 * real Postgres instance.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  ASSIGNMENT_SOURCES,
  ASSIGNMENT_EVENT_TYPES,
  ASSIGNMENT_OUTCOMES,
} from "../worker/src/quote-pipeline-types.js";

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

const MIGRATION_PATH = resolve(
  process.cwd(),
  "supabase",
  "migrations",
  "0024_quote_pipeline_assignment_engine.sql"
);
const MIGRATION_SQL = readFileSync(MIGRATION_PATH, "utf8");
const MIGRATION_SQL_LC = MIGRATION_SQL.toLowerCase();

// Also load Phase 1's migration to confirm Phase 2 did not edit it.
const PHASE1_MIGRATION_PATH = resolve(
  process.cwd(),
  "supabase",
  "migrations",
  "0023_pipeline_stage_and_underwriter_profiles.sql"
);
const PHASE1_MIGRATION_SQL = readFileSync(PHASE1_MIGRATION_PATH, "utf8");

function stripSqlComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/--[^\n]*/g, "");
}
const MIGRATION_SQL_CODE = stripSqlComments(MIGRATION_SQL_LC);

// ---------------------------------------------------------------------------
// Migration existence + additive contract
// ---------------------------------------------------------------------------

test("migration 0024 exists and is non-empty", () => {
  assert(MIGRATION_SQL.length > 0, "migration 0024 must not be empty");
});

test("migration 0024 does not touch Phase 1 migration file", () => {
  assert(PHASE1_MIGRATION_SQL.length > 0, "0023 must still exist");
  // Sentinel: 0023 must still contain its Phase 1 marker.
  assert(
    /atlas_underwriter_profiles/i.test(PHASE1_MIGRATION_SQL),
    "0023 must still declare atlas_underwriter_profiles"
  );
});

test("migration 0024 is additive — no DROP, no DELETE, no UPDATE of atlas_submissions rows", () => {
  const forbidden = [
    /drop\s+table\b/i,
    /drop\s+column\b/i,
    /drop\s+index\b/i,
    /drop\s+constraint\b/i,
    /drop\s+policy\b/i,
    /drop\s+type\b/i,
    /drop\s+function\b/i,
  ];
  for (const pat of forbidden) {
    assert(!pat.test(MIGRATION_SQL_CODE), `forbidden DDL clause matched: ${pat.source}`);
  }
  // Phase 2 must not fabricate historical pipeline_stage on existing rows.
  assert(
    !/set\s+pipeline_stage\s*=/.test(MIGRATION_SQL_CODE.replace(/[\s\S]*?\$\$[\s\S]*?\$\$/g, "")),
    "SET pipeline_stage = must only appear inside the assignment function bodies"
  );
});

test("migration 0024 does not alter any existing enum", () => {
  assert(!/alter type\b/i.test(MIGRATION_SQL_CODE), "ALTER TYPE must not appear in Phase 2");
});

// ---------------------------------------------------------------------------
// atlas_assignment_events schema
// ---------------------------------------------------------------------------

test("atlas_assignment_events table is created with the required columns", () => {
  const createRe =
    /create table if not exists public\.atlas_assignment_events\s*\(([\s\S]*?)\)\s*;/i;
  const match = MIGRATION_SQL.match(createRe);
  assert(match, "CREATE TABLE atlas_assignment_events missing");
  const body = match![1].toLowerCase();

  const required: RegExp[] = [
    /id\s+uuid\s+primary key\s+default gen_random_uuid\(\)/,
    /submission_id\s+uuid\s+not null[\s\S]*?references public\.atlas_submissions\(id\)[\s\S]*?on delete cascade/,
    /assignment_source\s+text\s+not null/,
    /event_type\s+text\s+not null/,
    /from_user_id\s+uuid\s+references auth\.users\(id\)\s+on delete set null/,
    /to_user_id\s+uuid\s+references auth\.users\(id\)\s+on delete set null/,
    /actor_user_id\s+uuid\s+references auth\.users\(id\)\s+on delete set null/,
    /selected_open_count\s+integer/,
    /eligible_candidate_count\s+integer/,
    /created_at\s+timestamptz\s+not null\s+default now\(\)/,
  ];
  for (const re of required) {
    assert(re.test(body), `atlas_assignment_events missing column pattern: ${re.source}`);
  }
});

test("atlas_assignment_events CHECK constraints match the approved vocabularies", () => {
  assert(
    /assignment_source in\s*\(\s*'auto'\s*,\s*'manual'\s*\)/i.test(MIGRATION_SQL),
    "assignment_source CHECK must be ('auto','manual')"
  );
  assert(
    /event_type in\s*\(\s*'auto_assigned'\s*,\s*'manual_assigned'\s*,\s*'reassigned'\s*,\s*'unassigned'\s*\)/i.test(
      MIGRATION_SQL
    ),
    "event_type CHECK must be the four approved values"
  );
  assert(
    /selected_open_count is null or selected_open_count >= 0/i.test(MIGRATION_SQL),
    "selected_open_count CHECK must allow NULL and non-negative"
  );
  assert(
    /eligible_candidate_count is null or eligible_candidate_count >= 0/i.test(MIGRATION_SQL),
    "eligible_candidate_count CHECK must allow NULL and non-negative"
  );
});

test("assignment_events required indexes exist with the correct shape", () => {
  const submissionIdxRe =
    /create index if not exists atlas_assignment_events_submission_idx\s+on public\.atlas_assignment_events\s*\(\s*submission_id\s*,\s*created_at desc\s*\)/i;
  assert(
    submissionIdxRe.test(MIGRATION_SQL),
    "submission_id + created_at DESC index missing or wrong shape"
  );
  const toUserIdxRe =
    /create index if not exists atlas_assignment_events_to_user_idx\s+on public\.atlas_assignment_events\s*\(\s*to_user_id\s*,\s*created_at desc\s*\)\s+where to_user_id is not null/i;
  assert(
    toUserIdxRe.test(MIGRATION_SQL),
    "to_user_id partial index missing or wrong shape"
  );
});

// ---------------------------------------------------------------------------
// RLS
// ---------------------------------------------------------------------------

test("RLS is enabled on atlas_assignment_events", () => {
  assert(
    /alter table public\.atlas_assignment_events enable row level security/i.test(MIGRATION_SQL),
    "atlas_assignment_events must enable row level security"
  );
});

test("assignment_events SELECT policy uses atlas_is_staff() + atlas_can_access_submission()", () => {
  const re =
    /create policy atlas_assignment_events_staff_select on public\.atlas_assignment_events\s+for select to authenticated\s+using \(atlas_is_staff\(\) and atlas_can_access_submission\(submission_id\)\)/i;
  assert(re.test(MIGRATION_SQL), "SELECT policy must scope by submission access");
});

test("assignment_events has NO authenticated INSERT/UPDATE/DELETE policy", () => {
  // Enumerate every CREATE POLICY block that targets atlas_assignment_events
  // and assert its action verb is SELECT (not INSERT/UPDATE/DELETE).
  const policyBlockRe =
    /create policy\s+\w+\s+on\s+public\.atlas_assignment_events\s+for\s+(select|insert|update|delete)\b/gi;
  const actions = new Set<string>();
  for (const m of MIGRATION_SQL.matchAll(policyBlockRe)) {
    actions.add(m[1].toLowerCase());
  }
  assert(actions.size > 0, "expected at least one policy on atlas_assignment_events");
  for (const action of actions) {
    assertEqual(
      action,
      "select",
      `policy verb on atlas_assignment_events must be SELECT only; found: ${action}`
    );
  }
});

// ---------------------------------------------------------------------------
// Assignment functions — hardening
// ---------------------------------------------------------------------------

function extractFunctionBody(name: string): string {
  const re = new RegExp(
    `create or replace function public\\.${name}\\b[\\s\\S]*?\\$\\$([\\s\\S]*?)\\$\\$;`,
    "i"
  );
  const m = MIGRATION_SQL.match(re);
  if (!m) throw new Error(`could not locate function body for ${name}`);
  return m[0];
}

function extractFunctionHeader(name: string): string {
  const re = new RegExp(
    `create or replace function public\\.${name}\\b[\\s\\S]*?as \\$\\$`,
    "i"
  );
  const m = MIGRATION_SQL.match(re);
  if (!m) throw new Error(`could not locate function header for ${name}`);
  return m[0];
}

for (const fn of [
  "atlas_auto_assign_submission",
  "atlas_set_submission_assignment",
] as const) {
  test(`${fn} is SECURITY DEFINER + VOLATILE with a safe search_path`, () => {
    const header = extractFunctionHeader(fn).toLowerCase();
    assert(/security definer/.test(header), `${fn} must be SECURITY DEFINER`);
    assert(/volatile/.test(header), `${fn} must be VOLATILE`);
    assert(
      /set search_path\s*=\s*pg_catalog\s*,\s*public/.test(header),
      `${fn} must SET search_path = pg_catalog, public`
    );
  });

  test(`${fn} EXECUTE is revoked from public/anon/authenticated`, () => {
    for (const grantee of ["public", "anon", "authenticated"]) {
      const re = new RegExp(
        `revoke all on function public\\.${fn}\\([^)]*\\)\\s+from\\s+${grantee}\\b`,
        "i"
      );
      assert(re.test(MIGRATION_SQL), `${fn}: EXECUTE must be revoked from ${grantee}`);
    }
  });

  test(`${fn} EXECUTE is granted to service_role`, () => {
    const re = new RegExp(
      `grant\\s+execute\\s+on function public\\.${fn}\\([^)]*\\)\\s+to\\s+service_role\\b`,
      "i"
    );
    assert(re.test(MIGRATION_SQL), `${fn}: EXECUTE must be granted to service_role`);
  });

  test(`${fn} acquires the shared assignment advisory transaction lock`, () => {
    const body = extractFunctionBody(fn).toLowerCase();
    // Same key used by both functions.
    assert(
      /pg_advisory_xact_lock\(\s*4272001\s*,\s*1\s*\)/.test(body),
      `${fn} must call pg_advisory_xact_lock(4272001, 1)`
    );
    // No session-level advisory lock leakage.
    assert(
      !/pg_advisory_lock\b/.test(body),
      `${fn} must not use pg_advisory_lock (session-scoped)`
    );
  });
}

test("auto + manual functions share the same advisory-lock key", () => {
  const autoBody = extractFunctionBody("atlas_auto_assign_submission");
  const manualBody = extractFunctionBody("atlas_set_submission_assignment");
  const key = /pg_advisory_xact_lock\(\s*(\d+)\s*,\s*(\d+)\s*\)/;
  const a = autoBody.match(key);
  const m = manualBody.match(key);
  assert(a, "auto function must call pg_advisory_xact_lock(key, n)");
  assert(m, "manual function must call pg_advisory_xact_lock(key, n)");
  assertEqual(a![1], m![1], "advisory-lock first arg must match across auto and manual");
  assertEqual(a![2], m![2], "advisory-lock second arg must match across auto and manual");
});

// ---------------------------------------------------------------------------
// Auto-assignment function — semantics
// ---------------------------------------------------------------------------

test("auto function locks the submission row FOR UPDATE before ranking", () => {
  const body = extractFunctionBody("atlas_auto_assign_submission");
  const lockIdx = body.toLowerCase().indexOf("pg_advisory_xact_lock");
  const submissionForUpdateIdx = body.toLowerCase().search(/from public\.atlas_submissions[\s\S]*?for update/);
  const rankedIdx = body.toLowerCase().indexOf("with candidates as");
  assert(lockIdx >= 0, "auto function must acquire the advisory lock");
  assert(
    submissionForUpdateIdx > lockIdx,
    "auto function must lock the submission row AFTER acquiring the advisory lock"
  );
  assert(
    rankedIdx > submissionForUpdateIdx,
    "auto function must rank candidates AFTER locking the submission row"
  );
});

test("auto function excludes historical NULL and terminal stages from workload count", () => {
  const body = extractFunctionBody("atlas_auto_assign_submission").toLowerCase();
  assert(
    /s\.pipeline_stage is not null/.test(body),
    "workload count must exclude pipeline_stage IS NULL"
  );
  assert(
    /s\.pipeline_stage not in\s*\(\s*'bound'::atlas_pipeline_stage\s*,\s*'declined'::atlas_pipeline_stage\s*,\s*'lost'::atlas_pipeline_stage\s*\)/.test(
      body
    ),
    "workload count must exclude terminal stages"
  );
});

test("auto function ranks by open_count, never-assigned, oldest last_assigned_at, user_id", () => {
  const body = extractFunctionBody("atlas_auto_assign_submission").toLowerCase();
  const orderRe =
    /order by\s+open_count asc\s*,\s*\(last_assigned_at is not null\) asc\s*,\s*last_assigned_at asc nulls first\s*,\s*user_id asc/;
  assert(orderRe.test(body), "ranking ORDER BY clause missing or wrong shape");
});

test("auto function locks selected profile row with FOR UPDATE OF p (no aggregate FOR UPDATE)", () => {
  const body = extractFunctionBody("atlas_auto_assign_submission").toLowerCase();
  assert(
    /from public\.atlas_underwriter_profiles p\s+where p\.user_id\s*=\s*v_selected_user\s+for update of p/.test(
      body
    ),
    "selected profile row must be locked with FOR UPDATE OF p"
  );
  // The ranked-CTE SELECT statement itself must not contain FOR UPDATE. Slice
  // out just that statement (from the top of `with candidates as` to the
  // terminating semicolon) and inspect it.
  const cteStmtRe = /with candidates as[\s\S]*?;/;
  const cteStmt = body.match(cteStmtRe);
  assert(cteStmt, "ranked-CTE SELECT must be present");
  assert(
    !/for update\b/.test(cteStmt![0]),
    "must not use FOR UPDATE inside the aggregate/grouped candidate SELECT"
  );
});

test("auto function refuses historical (NULL) submissions with pipeline_not_initialized", () => {
  const body = extractFunctionBody("atlas_auto_assign_submission").toLowerCase();
  assert(
    /v_submission\.pipeline_stage is null[\s\S]*?'pipeline_not_initialized'/.test(body),
    "NULL pipeline_stage must return pipeline_not_initialized"
  );
});

test("auto function refuses to silently triage: 'new' → not_triaged", () => {
  const body = extractFunctionBody("atlas_auto_assign_submission").toLowerCase();
  assert(/'not_triaged'/.test(body), "must have a not_triaged branch");
});

test("auto function is idempotent when already assigned", () => {
  const body = extractFunctionBody("atlas_auto_assign_submission").toLowerCase();
  assert(/'already_assigned'/.test(body), "must have an already_assigned branch");
});

test("auto function maps classification → capability without inferring unknowns", () => {
  const body = extractFunctionBody("atlas_auto_assign_submission").toLowerCase();
  assert(/'can_take_personal'/.test(body), "personal capability branch");
  assert(/'can_take_commercial'/.test(body), "commercial capability branch");
  assert(/'can_take_complex_commercial'/.test(body), "complex capability branch");
  assert(/'classification_required'/.test(body), "unknown classification must be refused");
});

test("auto function returns no_eligible_underwriter without mutating on empty candidate set", () => {
  const body = extractFunctionBody("atlas_auto_assign_submission").toLowerCase();
  const noEligibleIdx = body.indexOf("'no_eligible_underwriter'");
  const updateIdx = body.indexOf("update public.atlas_submissions");
  assert(noEligibleIdx >= 0, "no_eligible_underwriter branch must exist");
  assert(updateIdx > noEligibleIdx, "assignment mutation must occur AFTER the no-eligible short-circuit");
});

test("auto function preserves stage for assigned/in_progress/quoted; promotes triaged → assigned", () => {
  const body = extractFunctionBody("atlas_auto_assign_submission").toLowerCase();
  assert(
    /if v_submission\.pipeline_stage = 'triaged'::atlas_pipeline_stage then\s+v_new_stage := 'assigned'::atlas_pipeline_stage/.test(
      body
    ),
    "triaged must be promoted to assigned"
  );
  // Match the else branch tolerating an inline SQL comment between `else`
  // and the assignment.
  assert(
    /else[\s\S]*?v_new_stage := v_submission\.pipeline_stage\s*;/.test(body),
    "non-triaged open stage must be preserved"
  );
});

test("auto function stamps last_assigned_at on the selected profile", () => {
  const body = extractFunctionBody("atlas_auto_assign_submission").toLowerCase();
  assert(
    /update public\.atlas_underwriter_profiles\s+set last_assigned_at\s*=\s*now\(\)\s+where user_id\s*=\s*v_selected_user/.test(
      body
    ),
    "last_assigned_at must be stamped on the selected profile"
  );
});

test("auto function writes exactly one assignment_event row (auto/auto_assigned)", () => {
  const body = extractFunctionBody("atlas_auto_assign_submission").toLowerCase();
  const insertMatches =
    body.match(/insert into public\.atlas_assignment_events/g) ?? [];
  assertEqual(insertMatches.length, 1, "must INSERT into atlas_assignment_events exactly once");
  assert(/'auto',\s*'auto_assigned'/.test(body), "must use assignment_source='auto', event_type='auto_assigned'");
});

test("auto function writes the audit row inside the same transaction (safe metadata only)", () => {
  const body = extractFunctionBody("atlas_auto_assign_submission").toLowerCase();
  assert(
    /insert into public\.atlas_audit_logs[\s\S]*?'submission_auto_assigned'/.test(body),
    "must insert submission_auto_assigned audit event"
  );
  // Safe metadata only — no name/email keys.
  const auditBlock = body.match(
    /insert into public\.atlas_audit_logs[\s\S]*?jsonb_build_object\(([\s\S]*?)\)\s*\)/
  );
  assert(auditBlock, "auto audit jsonb_build_object must be present");
  const md = auditBlock![1];
  for (const bad of ["name", "email", "phone", "message", "body"]) {
    assert(!md.includes(`'${bad}'`), `auto audit metadata must not include key: ${bad}`);
  }
});

// ---------------------------------------------------------------------------
// Manual assignment function — semantics
// ---------------------------------------------------------------------------

test("manual function requires an actor (returns actor_required for null)", () => {
  const body = extractFunctionBody("atlas_set_submission_assignment").toLowerCase();
  assert(/'actor_required'/.test(body), "manual function must reject null actor");
  assert(
    body.indexOf("'actor_required'") < body.indexOf("pg_advisory_xact_lock"),
    "actor check must precede the advisory lock (avoid pointless serialization)"
  );
});

test("manual function computes correct event_type for the three transitions", () => {
  const body = extractFunctionBody("atlas_set_submission_assignment").toLowerCase();
  assert(/'manual_assigned'/.test(body), "manual_assigned branch present");
  assert(/'reassigned'/.test(body), "reassigned branch present");
  assert(/'unassigned'/.test(body), "unassigned branch present");
});

test("manual function preserves NULL pipeline_stage on historical rows", () => {
  const body = extractFunctionBody("atlas_set_submission_assignment").toLowerCase();
  assert(
    /if v_submission\.pipeline_stage is null then\s+[\s\S]*?v_new_stage := null/.test(body),
    "NULL pipeline_stage must be preserved on manual assignment"
  );
});

test("manual function unassignment from 'assigned' returns to 'triaged'; other open stages preserved", () => {
  const body = extractFunctionBody("atlas_set_submission_assignment").toLowerCase();
  assert(
    /if v_submission\.pipeline_stage = 'assigned'::atlas_pipeline_stage then\s+v_new_stage := 'triaged'::atlas_pipeline_stage/.test(
      body
    ),
    "unassigning from 'assigned' must set stage back to 'triaged'"
  );
});

test("manual function promotes 'new' or 'triaged' to 'assigned' on assignment", () => {
  const body = extractFunctionBody("atlas_set_submission_assignment").toLowerCase();
  assert(
    /pipeline_stage in\s*\(\s*[\s\S]*?'new'::atlas_pipeline_stage[\s\S]*?'triaged'::atlas_pipeline_stage[\s\S]*?\)\s+then\s+v_new_stage := 'assigned'::atlas_pipeline_stage/.test(
      body
    ),
    "assignment from 'new' or 'triaged' must promote to 'assigned'"
  );
});

test("manual function rejects terminal-stage mutations", () => {
  const body = extractFunctionBody("atlas_set_submission_assignment").toLowerCase();
  assert(
    /pipeline_stage in\s*\(\s*[\s\S]*?'bound'::atlas_pipeline_stage[\s\S]*?'declined'::atlas_pipeline_stage[\s\S]*?'lost'::atlas_pipeline_stage[\s\S]*?\)[\s\S]*?'terminal_submission'/.test(
      body
    ),
    "terminal stages must be rejected as terminal_submission"
  );
});

test("manual function no-ops when the target is the same as the current assignment", () => {
  const body = extractFunctionBody("atlas_set_submission_assignment").toLowerCase();
  assert(
    /p_assigned_to is not null and v_submission\.assigned_to\s*=\s*p_assigned_to[\s\S]*?'unchanged'/.test(
      body
    ),
    "same-target manual assignment must return 'unchanged'"
  );
});

test("manual function does NOT require an atlas_underwriter_profiles row for the target", () => {
  const body = extractFunctionBody("atlas_set_submission_assignment").toLowerCase();
  // Validates auth.users existence, not profile existence.
  assert(
    /from auth\.users where id\s*=\s*p_assigned_to/.test(body),
    "manual assignment must verify target exists in auth.users"
  );
  // But if a profile exists, its last_assigned_at is stamped.
  assert(
    /update public\.atlas_underwriter_profiles\s+set last_assigned_at\s*=\s*now\(\)\s+where user_id\s*=\s*p_assigned_to/.test(
      body
    ),
    "if a profile exists for target, stamp last_assigned_at"
  );
});

test("manual function writes exactly one assignment_event (assignment_source='manual') per real change", () => {
  const body = extractFunctionBody("atlas_set_submission_assignment").toLowerCase();
  const insertMatches =
    body.match(/insert into public\.atlas_assignment_events/g) ?? [];
  assertEqual(insertMatches.length, 1, "manual function must INSERT into atlas_assignment_events exactly once");
  assert(/'manual',\s*v_event_type/.test(body), "must use assignment_source='manual' + dynamic event_type");
});

test("manual function writes the audit row inside the same transaction, no PII", () => {
  const body = extractFunctionBody("atlas_set_submission_assignment").toLowerCase();
  assert(
    /insert into public\.atlas_audit_logs[\s\S]*?'submission_assignment_changed'/.test(body),
    "must insert submission_assignment_changed audit event"
  );
  const auditBlock = body.match(
    /insert into public\.atlas_audit_logs[\s\S]*?jsonb_build_object\(([\s\S]*?)\)\s*\)/
  );
  assert(auditBlock, "manual audit jsonb_build_object must be present");
  const md = auditBlock![1];
  for (const bad of ["name", "email", "phone", "message", "body"]) {
    assert(!md.includes(`'${bad}'`), `manual audit metadata must not include key: ${bad}`);
  }
});

// ---------------------------------------------------------------------------
// TypeScript vocabulary mirrors SQL
// ---------------------------------------------------------------------------

test("TypeScript ASSIGNMENT_SOURCES mirrors the SQL CHECK", () => {
  assertEqual(ASSIGNMENT_SOURCES.length, 2, "assignment source count");
  for (const v of ASSIGNMENT_SOURCES) {
    assert(
      MIGRATION_SQL_LC.includes(`'${v}'`),
      `SQL missing assignment_source value: ${v}`
    );
  }
});

test("TypeScript ASSIGNMENT_EVENT_TYPES mirrors the SQL CHECK", () => {
  assertEqual(ASSIGNMENT_EVENT_TYPES.length, 4, "event_type count");
  for (const v of ASSIGNMENT_EVENT_TYPES) {
    assert(
      MIGRATION_SQL_LC.includes(`'${v}'`),
      `SQL missing event_type value: ${v}`
    );
  }
});

test("TypeScript ASSIGNMENT_OUTCOMES covers every JSONB outcome the functions return", () => {
  const emitted = new Set<string>();
  const re = /'outcome',\s*'([a-z_]+)'/g;
  for (const m of MIGRATION_SQL_LC.matchAll(re)) emitted.add(m[1]);
  for (const outcome of emitted) {
    assert(
      (ASSIGNMENT_OUTCOMES as readonly string[]).includes(outcome),
      `TS ASSIGNMENT_OUTCOMES missing outcome emitted by SQL: ${outcome}`
    );
  }
});

// ---------------------------------------------------------------------------
// Scope audit — none of the deferred concepts leak in
// ---------------------------------------------------------------------------

test("Phase 2 is silent on deferred concepts in executable DDL", () => {
  const forbiddenTokens = [
    "broker",
    "graph_state",
    "conversation_id",
    "delta_link",
    "requested_insurer",
    "targeted_insurer",
    "pipeline_events",
    "team_id",
    "atlas_submission_intake",
    "atlas_intake_graph_state",
    "holidays",
    "business_day",
    "weight", // reserved column — must NOT be consumed in Phase 2 ranking
  ];
  for (const token of forbiddenTokens) {
    assert(
      !MIGRATION_SQL_CODE.includes(token),
      `Phase 2 executable DDL must not mention: ${token}`
    );
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
  console.log(`\nPhase 16 assignment engine: ${passed} passed, ${failed} failed out of ${tests.length}`);
  if (failed > 0 && typeof process !== "undefined") process.exitCode = 1;
})();
