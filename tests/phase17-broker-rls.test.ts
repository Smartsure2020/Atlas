/**
 * Phase 17 (Quote Pipeline — broker role) — RLS + frontend structural tests
 * ---------------------------------------------------------------------------
 * Static assertions over migration 0025 and the SPA role gates. The live RLS
 * matrix + Worker API matrix run in the Phase 3 staging gate against the
 * (non-production) staging Supabase project.
 *
 * Migration 0025 must:
 *   - be forward-only (no drop of historical data)
 *   - not backfill pipeline_stage
 *   - not create a team_id / broker teams model
 *   - not add broker to atlas_can_write / manager helpers
 *   - keep audit append-only for broker (no INSERT/UPDATE/DELETE policy added)
 *   - keep assignment events immutable (no INSERT/UPDATE/DELETE added)
 *   - not introduce Graph / intake / email-sync objects
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const tests: { name: string; fn: () => void | Promise<void> }[] = [];
function test(name: string, fn: () => void | Promise<void>) {
  tests.push({ name, fn });
}
function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

const SRC = readFileSync(
  resolve(process.cwd(), "supabase/migrations/0025_broker_role_and_rls.sql"),
  "utf8"
);
const APPSHELL = readFileSync(resolve(process.cwd(), "src/components/AppShell.tsx"), "utf8");
const APP = readFileSync(resolve(process.cwd(), "src/App.tsx"), "utf8");
const WORKQUEUE = readFileSync(resolve(process.cwd(), "src/pages/WorkQueue.tsx"), "utf8");
const SUBDETAIL = readFileSync(
  resolve(process.cwd(), "src/pages/SubmissionDetail.tsx"),
  "utf8"
);
const ATLAS_LIB = readFileSync(resolve(process.cwd(), "src/lib/atlas.ts"), "utf8");

// ---------------------------------------------------------------------------
// Migration 0025 — forward-only invariants
// ---------------------------------------------------------------------------

test("0025 does not DROP a table", () => {
  assert(!/\bdrop\s+table\b/i.test(SRC), "must not drop tables");
});

test("0025 does not TRUNCATE data", () => {
  assert(!/\btruncate\b/i.test(SRC), "must not truncate");
});

test("0025 does not backfill pipeline_stage on historical rows", () => {
  assert(!/update\s+public\.atlas_submissions\s+set\s+pipeline_stage/i.test(SRC),
    "must not backfill pipeline_stage");
});

test("0025 does not introduce a team_id / team model", () => {
  assert(!/\bteam_id\b/i.test(SRC), "must not introduce team_id");
  assert(!/create\s+table[\s\S]*?team/i.test(SRC), "must not create team table");
});

test("0025 does not add broker to atlas_can_write body", () => {
  // atlas_can_write is not replaced here at all. If it were, it must not name broker.
  const canWriteReplacements = SRC.match(/create or replace function public\.atlas_can_write[\s\S]*?\$function\$/gi);
  if (canWriteReplacements) {
    for (const body of canWriteReplacements) {
      assert(!/'broker'/.test(body), "atlas_can_write must not include broker");
    }
  }
});

test("0025 does not add broker to manager helpers", () => {
  const helpers = ["atlas_is_manager", "atlas_can_manage"];
  for (const h of helpers) {
    const re = new RegExp(`create or replace function public\\.${h}[\\s\\S]*?\\$function\\$`, "gi");
    const found = SRC.match(re);
    if (found) {
      for (const body of found) {
        assert(!/'broker'/.test(body), `${h} must not include broker`);
      }
    }
  }
});

test("0025 keeps audit append-only for broker (no INSERT policy added for broker)", () => {
  // The migration adds no INSERT/UPDATE/DELETE policy on atlas_audit_logs.
  const audit = SRC.match(/on public\.atlas_audit_logs[\s\S]*?;/gi) || [];
  for (const clause of audit) {
    assert(!/for\s+insert/i.test(clause), "must not add insert policy on audit");
    assert(!/for\s+update/i.test(clause), "must not add update policy on audit");
    assert(!/for\s+delete/i.test(clause), "must not add delete policy on audit");
  }
});

test("0025 keeps assignment events immutable (no INSERT/UPDATE/DELETE policy added)", () => {
  const ev = SRC.match(/on public\.atlas_assignment_events[\s\S]*?;/gi) || [];
  for (const clause of ev) {
    assert(!/for\s+insert/i.test(clause), "must not add insert policy on assignment_events");
    assert(!/for\s+update/i.test(clause), "must not add update policy on assignment_events");
    assert(!/for\s+delete/i.test(clause), "must not add delete policy on assignment_events");
  }
});

test("0025 does not introduce Graph / intake / email-sync objects", () => {
  const forbidden = [
    "microsoft_graph",
    "outlook",
    "delta_link",
    "conversation_id",
    "internetmessageid",
    "intake_message",
    "graph_sync",
    "sync_state",
  ];
  for (const w of forbidden) {
    assert(!new RegExp(w, "i").test(SRC), `must not mention ${w}`);
  }
});

test("0025 does not touch enum vocabulary for pipeline_stage", () => {
  assert(!/alter\s+type\s+atlas_pipeline_stage/i.test(SRC),
    "pipeline_stage enum must be untouched");
});

// ---------------------------------------------------------------------------
// Frontend role model
// ---------------------------------------------------------------------------

test("AppShell.AtlasUiRole includes broker", () => {
  assert(/AtlasUiRole[\s\S]*?"broker"/.test(APPSHELL), "AtlasUiRole must include broker");
});

test("AppShell.canWrite is an explicit underwriting allow-list (not role !== readonly)", () => {
  // The comment above the helper is allowed to quote the forbidden pattern
  // (it explains why NOT to use it). Assert that the exported helper's
  // body is the enumeration rather than the negation shortcut.
  const m = APPSHELL.match(/export const canWrite[\s\S]*?;/);
  assert(m, "canWrite export not found");
  assert(!/role !== "readonly"/.test(m![0]),
    'canWrite body must NOT use `role !== "readonly"` — broker would leak through');
  assert(/"admin"[\s\S]*?"manager"[\s\S]*?"consultant"[\s\S]*?"underwriter"/.test(m![0]),
    "canWrite must enumerate the underwriting-writer set");
});

test("AppShell exports canCreateSubmission and includes broker", () => {
  assert(/export const canCreateSubmission/.test(APPSHELL), "helper missing");
  assert(/canCreateSubmission[\s\S]*?"broker"/.test(APPSHELL),
    "canCreateSubmission must include broker");
});

test("AppShell.canViewUnderwritingIntelligence excludes broker", () => {
  const m = APPSHELL.match(/export const canViewUnderwritingIntelligence[\s\S]*?;/);
  assert(m, "canViewUnderwritingIntelligence helper missing");
  assert(/role !== "broker"/.test(m![0]), "must exclude broker");
});

test("AppShell nav hides Insurers / Oversight / Processing for broker", () => {
  // Match up to ~250 chars after each label (spans nested `route: {...}` braces).
  const insurers = APPSHELL.match(/label: "Insurers"[\s\S]{0,250}/);
  const oversight = APPSHELL.match(/label: "Manager overview"[\s\S]{0,250}/);
  const jobs = APPSHELL.match(/label: "Processing & alerts"[\s\S]{0,250}/);
  assert(insurers && /hideForBroker: true/.test(insurers[0]), "Insurers must set hideForBroker");
  assert(oversight && /hideForBroker: true/.test(oversight[0]),
    "Manager overview must set hideForBroker");
  assert(jobs && /hideForBroker: true/.test(jobs[0]),
    "Processing & alerts must set hideForBroker");
  assert(/role === "broker"[\s\S]*?return false/.test(APPSHELL),
    "nav filter must short-circuit broker on hideForBroker items");
});

// ---------------------------------------------------------------------------
// Direct route guards
// ---------------------------------------------------------------------------

test('App.tsx: broker on route "insurers" redirects to queue', () => {
  const s = APP.match(/case "insurers":[\s\S]{0,300}/);
  assert(s, "case insurers not found");
  assert(/role === "broker"[\s\S]*?navigate\({ name: "queue" }/.test(s![0]),
    "insurers route must redirect broker to queue");
});

test('App.tsx: broker on route "insurer" redirects to queue', () => {
  const s = APP.match(/case "insurer":[\s\S]{0,300}/);
  assert(s, "case insurer not found");
  assert(/role === "broker"[\s\S]*?navigate\({ name: "queue" }/.test(s![0]),
    "insurer route must redirect broker to queue");
});

test('App.tsx: broker on route "oversight" redirects to queue', () => {
  const s = APP.match(/case "oversight":[\s\S]{0,300}/);
  assert(s, "case oversight not found");
  assert(/role === "broker"[\s\S]*?navigate\({ name: "queue" }/.test(s![0]),
    "oversight route must redirect broker to queue");
});

test('App.tsx: broker on route "jobs" redirects to queue', () => {
  const s = APP.match(/case "jobs":[\s\S]{0,300}/);
  assert(s, "case jobs not found");
  assert(/role === "broker"[\s\S]*?navigate\({ name: "queue" }/.test(s![0]),
    "jobs route must redirect broker to queue");
});

// ---------------------------------------------------------------------------
// WorkQueue create action
// ---------------------------------------------------------------------------

test("WorkQueue: new-submission button uses canCreateSubmission (not canWrite)", () => {
  assert(/import[\s\S]*?canCreateSubmission[\s\S]*?from "\.\.\/components\/AppShell"/.test(WORKQUEUE),
    "WorkQueue must import canCreateSubmission");
  assert(!/canWrite/.test(WORKQUEUE),
    "WorkQueue must not use canWrite for the create button");
  assert(/canCreateSubmission\(role\)/.test(WORKQUEUE),
    "WorkQueue must gate the create button on canCreateSubmission");
});

// ---------------------------------------------------------------------------
// SubmissionDetail broker-safe mode
// ---------------------------------------------------------------------------

test("SubmissionDetail: broker skips getRecommendation / getQuoteReview / getDecision", () => {
  const load = SUBDETAIL.match(/const load = useCallback[\s\S]*?\[submissionId, role\]/);
  assert(load, "load callback not found");
  assert(/isBroker = role === "broker"/.test(load![0]),
    "broker flag must be derived");
  assert(/dependents && !isBroker[\s\S]*?getRecommendation/.test(load![0]),
    "getRecommendation must be skipped for broker");
  assert(/dependents && !isBroker[\s\S]*?getQuoteReview/.test(load![0]),
    "getQuoteReview must be skipped for broker");
  assert(/dependents && !isBroker[\s\S]*?getDecision/.test(load![0]),
    "getDecision must be skipped for broker");
});

test("SubmissionDetail: broker tabs = Overview, Missing information, Documents, History", () => {
  const tabs = SUBDETAIL.match(/isBroker[\s\S]*?\?[\s\S]*?\[[\s\S]*?"history"[\s\S]*?\]/);
  assert(tabs, "broker tab set not found");
  const brokerTabs = tabs![0];
  assert(/"overview"/.test(brokerTabs), "overview missing");
  assert(/"missing-information"/.test(brokerTabs), "missing-information missing");
  assert(/"documents"/.test(brokerTabs), "documents missing");
  assert(/"history"/.test(brokerTabs), "history missing");
  assert(!/"risk"[\s\S]{0,300}"history"/.test(brokerTabs), "risk must NOT be in broker tabs");
  assert(!/"recommendation"[\s\S]{0,300}"history"/.test(brokerTabs),
    "recommendation must NOT be in broker tabs");
  assert(!/"quote-review"[\s\S]{0,300}"history"/.test(brokerTabs),
    "quote-review must NOT be in broker tabs");
  assert(!/"communications"[\s\S]{0,300}"history"/.test(brokerTabs),
    "communications must NOT be in broker tabs");
});

test("SubmissionDetail: broker never renders underwriting panels", () => {
  assert(/!isBroker && \(\s*<TabPanel id="risk"/.test(SUBDETAIL),
    "risk tab must be gated on !isBroker");
  assert(/!isBroker && \(\s*<TabPanel id="recommendation"/.test(SUBDETAIL),
    "recommendation tab must be gated on !isBroker");
  assert(/!isBroker && \(\s*<TabPanel id="quote-review"/.test(SUBDETAIL),
    "quote-review tab must be gated on !isBroker");
  assert(/!isBroker && \(\s*<TabPanel id="communications"/.test(SUBDETAIL),
    "communications tab must be gated on !isBroker");
});

test("SubmissionDetail: broker does not see AssignmentDrawer or PilotRailCard", () => {
  assert(/!isBroker && \(\s*<AssignmentDrawer/.test(SUBDETAIL),
    "AssignmentDrawer must be gated on !isBroker");
  assert(/!isBroker && \(\s*<PilotRailCard/.test(SUBDETAIL),
    "PilotRailCard must be gated on !isBroker");
});

test("SubmissionDetail: broker overview is a safe short-circuit", () => {
  assert(/if \(isBroker\)[\s\S]{0,1200}Case status/.test(SUBDETAIL),
    "broker overview must return an operational-only view");
  const scope = SUBDETAIL.split(/if \(isBroker\)/)[1]?.split(/^\}\s*$/m)[0] ?? "";
  // The broker overview branch must not reference the recommendation/decision/insurer objects.
  assert(!/recommendation\.reasoning_json/.test(scope),
    "broker overview must not read recommendation.reasoning_json");
  assert(!/top\?\.\s*insurer_name/.test(scope),
    "broker overview must not surface top insurer");
  assert(!/decision\?/.test(scope) || !/decision\?\.\s*selected_insurer/.test(scope),
    "broker overview must not surface decision.selected_insurer");
});

// ---------------------------------------------------------------------------
// Frontend atlas.ts: currentRole recognises broker
// ---------------------------------------------------------------------------

test("atlas.currentRole includes broker", () => {
  assert(/currentRole[\s\S]*?"broker"/.test(ATLAS_LIB),
    "currentRole must include broker in the accepted set");
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
  console.log(`\nPhase 17 broker RLS/frontend: ${passed} passed, ${failed} failed out of ${tests.length}`);
  if (failed > 0 && typeof process !== "undefined") process.exitCode = 1;
})();
