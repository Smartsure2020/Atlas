/**
 * Phase 19d — PL/pgSQL name-resolution corrections (Checkpoint 5)
 * ---------------------------------------------------------------------------
 * Structural asserts against migration 0031. These are *supplemental only* —
 * they do not replace the real-Postgres integration gate at
 * `scripts/gate-phase5a-postgres.mjs`.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const tests: { name: string; fn: () => void | Promise<void> }[] = [];
function test(name: string, fn: () => void | Promise<void>) { tests.push({ name, fn }); }
function assert(cond: unknown, message: string): asserts cond { if (!cond) throw new Error(message); }

const M31 = readFileSync(
  resolve("supabase/migrations/0031_graph_intake_plpgsql_name_resolution.sql"),
  "utf8",
);

test("migration 0031 exists and recreates the three affected functions", () => {
  assert(/create or replace function public\.atlas_intake_acquire_lease\b/.test(M31), "acquire_lease recreated");
  assert(/create or replace function public\.atlas_intake_ingest_new_email\b/.test(M31), "ingest_new_email recreated");
  assert(/create or replace function public\.atlas_intake_ingest_needs_review\b/.test(M31), "ingest_needs_review recreated");
});

test("acquire_lease uses ON CONFLICT ON CONSTRAINT (not bare column)", () => {
  const fn = M31.match(/create or replace function public\.atlas_intake_acquire_lease[\s\S]*?\$\$;/);
  assert(fn, "function block");
  const body = fn![0];
  assert(/on conflict on constraint atlas_intake_graph_state_pkey do nothing/.test(body),
    "must use ON CONFLICT ON CONSTRAINT ... DO NOTHING");
  assert(!/on conflict \(mailbox\)/.test(body), "must not use ON CONFLICT (mailbox)");
});

test("acquire_lease qualifies every column with the alias `gs`", () => {
  const fn = M31.match(/create or replace function public\.atlas_intake_acquire_lease[\s\S]*?\$\$;/);
  const body = fn![0];
  // The UPDATE ... RETURNING list must qualify each column with `gs.`.
  const returning = body.match(/returning[\s\S]*?;/);
  assert(returning, "returning present");
  const cols = ["mailbox", "delta_link", "in_round_next_link", "last_polled_at", "last_success_at",
                "last_error", "consecutive_failures", "poll_in_flight_since", "lease_id",
                "breaker_opened_at", "last_failure_at", "next_attempt_after"];
  for (const c of cols) {
    assert(new RegExp(`gs\\.${c}\\b`).test(returning![0]),
      `RETURNING must reference gs.${c}`);
  }
});

test("ingest_new_email aliases intake queries with `im` and qualifies submission_id/id", () => {
  const fn = M31.match(/create or replace function public\.atlas_intake_ingest_new_email[\s\S]*?\$\$;/);
  assert(fn, "function block");
  const body = fn![0];
  // Both duplicate-check queries must use the alias.
  const dupeInternetId = body.match(/from public\.atlas_submission_intake_messages as im[\s\S]*?im\.internet_message_id/);
  assert(dupeInternetId, "duplicate internet_message_id lookup uses `im` alias");
  const dupeMailbox = body.match(/from public\.atlas_submission_intake_messages as im[\s\S]*?im\.mailbox[\s\S]*?im\.graph_message_id/);
  assert(dupeMailbox, "duplicate (mailbox, graph_message_id) lookup uses `im` alias");
  // Column projections must be qualified.
  assert(/im\.id\s*,\s*im\.submission_id/.test(body),
    "select list uses im.id, im.submission_id (never bare)");
  // No bare unqualified SELECT of submission_id.
  assert(!/select id, submission_id\s+from public\.atlas_submission_intake_messages(?!\s+as)/.test(body),
    "no unqualified SELECT id, submission_id FROM atlas_submission_intake_messages");
});

test("ingest_needs_review applies the same qualification rule", () => {
  const fn = M31.match(/create or replace function public\.atlas_intake_ingest_needs_review[\s\S]*?\$\$;/);
  const body = fn![0];
  assert(/from public\.atlas_submission_intake_messages as im/.test(body),
    "intake queries use `im` alias");
  assert(/im\.id\s*,\s*im\.submission_id/.test(body),
    "select list uses im.id, im.submission_id (never bare)");
});

test("no #variable_conflict directive is introduced (per §5)", () => {
  // A real plpgsql directive is a bare `#variable_conflict …` statement in
  // the function body (typically first line of the block). Comment references
  // that explain the rejected alternative are fine.
  const directive = /^\s*#variable_conflict\b/m;
  const commentOnly = /(--[^\n]*#variable_conflict|\/\*[\s\S]*?#variable_conflict[\s\S]*?\*\/)/;
  const hasDirective = directive.test(M31) && !commentOnly.test(M31.match(directive)?.[0] ?? "");
  assert(!hasDirective,
    "must not introduce #variable_conflict as a global workaround (comment references are fine)");
});

test("recreated functions preserve SECURITY INVOKER and search_path pinning", () => {
  const blocks = M31.match(/create or replace function public\.atlas_intake_[a-z_]+[\s\S]*?\$\$;/g) ?? [];
  assert(blocks.length === 3, "three functions recreated");
  for (const b of blocks) {
    assert(/security invoker/.test(b), "SECURITY INVOKER retained");
    assert(/set search_path to pg_catalog, public/.test(b), "search_path pinned");
    assert(!/security definer/.test(b), "no SECURITY DEFINER introduced");
  }
});

test("worker-facing return column names are unchanged", () => {
  // acquire_lease: mailbox, delta_link, in_round_next_link, last_polled_at,
  // last_success_at, last_error, consecutive_failures, poll_in_flight_since,
  // lease_id, breaker_opened_at, last_failure_at, next_attempt_after.
  const acq = M31.match(/create or replace function public\.atlas_intake_acquire_lease[\s\S]*?\$\$;/)?.[0] ?? "";
  const acqReturns = acq.match(/returns table \(([\s\S]*?)\)\s+language/);
  assert(acqReturns, "acquire returns table");
  const acqList = acqReturns![1];
  for (const c of ["mailbox", "delta_link", "in_round_next_link", "last_polled_at",
                   "last_success_at", "last_error", "consecutive_failures",
                   "poll_in_flight_since", "lease_id", "breaker_opened_at",
                   "last_failure_at", "next_attempt_after"]) {
    assert(new RegExp(`\\b${c}\\s+(?:text|timestamptz|integer|uuid)`).test(acqList),
      `acquire_lease returns ${c}`);
  }
  // ingest_new_email: outcome, submission_id, intake_message_id.
  const ing = M31.match(/create or replace function public\.atlas_intake_ingest_new_email[\s\S]*?\$\$;/)?.[0] ?? "";
  const ingReturns = ing.match(/returns table \(([\s\S]*?)\)\s+language/);
  const ingList = ingReturns![1];
  assert(/outcome\s+text/.test(ingList), "ingest returns outcome");
  assert(/submission_id\s+uuid/.test(ingList), "ingest returns submission_id");
  assert(/intake_message_id\s+uuid/.test(ingList), "ingest returns intake_message_id");
});

test("REVOKE/GRANT statements reapplied for the three recreated functions", () => {
  for (const fn of ["atlas_intake_acquire_lease", "atlas_intake_ingest_new_email", "atlas_intake_ingest_needs_review"]) {
    assert(new RegExp(`revoke\\s+all\\s+on\\s+function\\s+public\\.${fn}\\b[\\s\\S]*?from\\s+public`, "i").test(M31),
      `${fn}: REVOKE FROM public`);
    assert(new RegExp(`revoke\\s+all\\s+on\\s+function\\s+public\\.${fn}\\b[\\s\\S]*?from\\s+anon`, "i").test(M31),
      `${fn}: REVOKE FROM anon`);
    assert(new RegExp(`revoke\\s+all\\s+on\\s+function\\s+public\\.${fn}\\b[\\s\\S]*?from\\s+authenticated`, "i").test(M31),
      `${fn}: REVOKE FROM authenticated`);
    assert(new RegExp(`grant\\s+execute\\s+on\\s+function\\s+public\\.${fn}\\b[\\s\\S]*?to\\s+service_role`, "i").test(M31),
      `${fn}: GRANT EXECUTE service_role`);
  }
});

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

(async () => {
  let passed = 0;
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log(`  ✓ ${t.name}`); passed++; }
    catch (e) { console.error(`  ✗ ${t.name}: ${(e as Error).message}`); failed++; }
  }
  console.log(`\nPhase 19d name-resolution: ${passed} passed, ${failed} failed out of ${tests.length}`);
  if (failed > 0 && typeof process !== "undefined") process.exitCode = 1;
})();
