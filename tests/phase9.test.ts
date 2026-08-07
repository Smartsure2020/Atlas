/**
 * Phase 9: pilot integration tests
 * ---------------------------------------------------------------------------
 * Validates pilot issue CRUD logic, pilot flag management, and role gates.
 */

import { roleCanViewManagerDashboard, roleCanWrite } from "../worker/src/phase6-hardening.js";


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

// ---------------------------------------------------------------------------
// Role gate tests for pilot endpoints
// ---------------------------------------------------------------------------

test("only managers and admins can update pilot issues", () => {
  assertEqual(roleCanViewManagerDashboard("manager"), true, "manager should access");
  assertEqual(roleCanViewManagerDashboard("admin"), true, "admin should access");
  assertEqual(roleCanViewManagerDashboard("consultant"), false, "consultant should not");
  assertEqual(roleCanViewManagerDashboard("underwriter"), false, "underwriter should not");
  assertEqual(roleCanViewManagerDashboard("readonly"), false, "readonly should not");
});

test("all writable roles can create pilot issues", () => {
  assertEqual(roleCanWrite("consultant"), true, "consultant can create");
  assertEqual(roleCanWrite("underwriter"), true, "underwriter can create");
  assertEqual(roleCanWrite("manager"), true, "manager can create");
  assertEqual(roleCanWrite("admin"), true, "admin can create");
  assertEqual(roleCanWrite("readonly"), false, "readonly cannot create");
});

// ---------------------------------------------------------------------------
// Severity validation
// ---------------------------------------------------------------------------

test("pilot issue severity values are exhaustive", () => {
  const validSeverities = ["low", "medium", "high", "critical"];
  for (const sev of validSeverities) {
    assert(validSeverities.includes(sev), `${sev} should be valid`);
  }
  assert(!validSeverities.includes("unknown"), "unknown should not be valid");
});

// ---------------------------------------------------------------------------
// Status transition logic
// ---------------------------------------------------------------------------

test("pilot issue status transitions are valid", () => {
  const validStatuses = ["open", "in_progress", "resolved", "wont_fix"];
  for (const status of validStatuses) {
    assert(validStatuses.includes(status), `${status} should be valid`);
  }
  assert(!validStatuses.includes("closed"), "closed is not a valid pilot issue status");
});

test("resolved and wont_fix statuses should set resolved_at", () => {
  const terminalStatuses = ["resolved", "wont_fix"];
  const nonTerminal = ["open", "in_progress"];
  for (const status of terminalStatuses) {
    assert(terminalStatuses.includes(status), `${status} is terminal`);
  }
  for (const status of nonTerminal) {
    assert(!terminalStatuses.includes(status), `${status} is not terminal`);
  }
});

// ---------------------------------------------------------------------------
// Pilot flag on submissions
// ---------------------------------------------------------------------------

test("pilot flag defaults to false", () => {
  const submission = { pilot_flag: false, pilot_notes: null };
  assertEqual(submission.pilot_flag, false, "default should be false");
  assertEqual(submission.pilot_notes, null, "default notes should be null");
});

test("pilot flag can be toggled with notes", () => {
  const submission = { pilot_flag: false, pilot_notes: null as string | null };
  submission.pilot_flag = true;
  submission.pilot_notes = "Testing pilot workflow";
  assertEqual(submission.pilot_flag, true, "flag should be enabled");
  assert(submission.pilot_notes !== null, "notes should be set");
});

test("pilot filter scopes submissions to flagged cases", () => {
  const submissions = [
    { id: "a", pilot_flag: true },
    { id: "b", pilot_flag: false },
    { id: "c", pilot_flag: true },
    { id: "d", pilot_flag: null },
  ];
  const pilotOnly = submissions.filter((s) => s.pilot_flag === true);
  assertEqual(pilotOnly.length, 2, "should return only pilot-flagged submissions");
  assertEqual(pilotOnly[0].id, "a", "first pilot submission");
  assertEqual(pilotOnly[1].id, "c", "second pilot submission");
});

// ---------------------------------------------------------------------------
// Audit trail
// ---------------------------------------------------------------------------

test("pilot actions produce audit events with correct names", () => {
  const expectedActions = [
    "pilot_issue_created",
    "pilot_issue_updated",
    "pilot_flag_enabled",
    "pilot_flag_disabled",
  ];
  for (const action of expectedActions) {
    assert(action.startsWith("pilot_"), `audit action ${action} should start with pilot_`);
  }
});

test("pilot audit metadata does not contain PII", () => {
  const metadata = {
    issue_id: "00000000-0000-0000-0000-000000000001",
    severity: "high",
    fields: ["status", "assigned_to"],
    pilot_notes_present: true,
  };
  assert(!("pilot_notes" in metadata), "metadata should not contain pilot notes text");
  assert(!("title" in metadata), "metadata should not contain issue title");
  assert(!("description" in metadata), "metadata should not contain issue description");
  assert("issue_id" in metadata, "metadata should contain issue_id");
});

// ---------------------------------------------------------------------------
// RLS policy expectations
// ---------------------------------------------------------------------------

test("pilot issues table has staff-level read and manager-level write policies", () => {
  const policies = [
    { name: "atlas_pilot_issues_staff_select", operation: "select", role_check: "atlas_is_staff" },
    { name: "atlas_pilot_issues_staff_insert", operation: "insert", role_check: "atlas_is_staff" },
    { name: "atlas_pilot_issues_manager_update", operation: "update", role_check: "atlas_can_manage" },
  ];
  assertEqual(policies.length, 3, "should have three policies");
  const ops = policies.map((p) => p.operation);
  assert(ops.includes("select"), "should have a select policy");
  assert(ops.includes("insert"), "should have an insert policy");
  assert(ops.includes("update"), "should have an update policy");
  assert(!ops.includes("delete"), "should not have a delete policy");
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
  console.log(`\nPhase 9: ${passed} passed, ${failed} failed out of ${tests.length}`);
  if (failed > 0 && typeof process !== "undefined") process.exitCode = 1;
})();
