/**
 * Phase 18 — Quote Pipeline domain helpers (Phase 4)
 * ---------------------------------------------------------------------------
 * Exercises the pure browser-side helpers in src/lib/pipeline.ts. No React,
 * no network — the tests run in the plain-node phase harness.
 */

import {
  countPipelineStages,
  countUnassigned,
  countWaitingInfo,
  defaultViewForRole,
  filterPipelineView,
  isNotInitialisedCase,
  isOpenPipelineCase,
  isTerminalPipelineStage,
  isUnassignedPipelineCase,
  needsAttention,
  stageAgeMs,
  type SubmissionListItem,
} from "../src/lib/pipeline.js";

const tests: { name: string; fn: () => void | Promise<void> }[] = [];
function test(name: string, fn: () => void | Promise<void>) {
  tests.push({ name, fn });
}
function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}
function eq<T>(actual: T, expected: T, message: string) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

const UID_A = "00000000-0000-0000-0000-00000000000a";
const UID_B = "00000000-0000-0000-0000-00000000000b";

function row(over: Partial<SubmissionListItem>): SubmissionListItem {
  return {
    id: over.id ?? crypto.randomUUID(),
    assigned_to: over.assigned_to ?? null,
    status: over.status ?? "new",
    queue_status: over.queue_status ?? "new",
    pipeline_stage: over.pipeline_stage ?? null,
    priority: over.priority ?? "normal",
    due_at: over.due_at ?? null,
    last_pipeline_stage_changed_at: over.last_pipeline_stage_changed_at ?? null,
  };
}

// ---------------------------------------------------------------------------
// isTerminalPipelineStage / isOpenPipelineCase / isNotInitialisedCase
// ---------------------------------------------------------------------------

test("terminal stages are bound/declined/lost only", () => {
  eq(isTerminalPipelineStage("bound"), true, "bound");
  eq(isTerminalPipelineStage("declined"), true, "declined");
  eq(isTerminalPipelineStage("lost"), true, "lost");
  for (const s of ["new", "triaged", "assigned", "in_progress", "quoted"]) {
    eq(isTerminalPipelineStage(s), false, `open stage ${s}`);
  }
  eq(isTerminalPipelineStage(null), false, "null");
  eq(isTerminalPipelineStage(undefined), false, "undefined");
});

test("historical NULL stage is not open and is not terminal", () => {
  const r = row({ pipeline_stage: null });
  eq(isOpenPipelineCase(r), false, "NULL is not open");
  eq(isNotInitialisedCase(r), true, "NULL is not initialised");
});

test("triaged is open, bound is not", () => {
  eq(isOpenPipelineCase(row({ pipeline_stage: "triaged" })), true, "triaged open");
  eq(isOpenPipelineCase(row({ pipeline_stage: "bound" })), false, "bound not open");
});

// ---------------------------------------------------------------------------
// countPipelineStages — historical NULL is separate, never folded into "new"
// ---------------------------------------------------------------------------

test("countPipelineStages tallies each stage without folding NULL into new", () => {
  const counts = countPipelineStages([
    row({ pipeline_stage: null }),
    row({ pipeline_stage: null }),
    row({ pipeline_stage: "new" }),
    row({ pipeline_stage: "triaged" }),
    row({ pipeline_stage: "assigned" }),
    row({ pipeline_stage: "in_progress" }),
    row({ pipeline_stage: "quoted" }),
    row({ pipeline_stage: "bound" }),
    row({ pipeline_stage: "declined" }),
    row({ pipeline_stage: "lost" }),
  ]);
  eq(counts.not_initialised, 2, "not_initialised count");
  eq(counts.new, 1, "new");
  eq(counts.triaged, 1, "triaged");
  eq(counts.assigned, 1, "assigned");
  eq(counts.in_progress, 1, "in_progress");
  eq(counts.quoted, 1, "quoted");
  eq(counts.bound, 1, "bound");
  eq(counts.declined, 1, "declined");
  eq(counts.lost, 1, "lost");
});

// ---------------------------------------------------------------------------
// Unassigned / waiting_info counters
// ---------------------------------------------------------------------------

test("unassigned counts only open cases with no assignee (excludes NULL and terminal)", () => {
  const rows = [
    row({ pipeline_stage: null, assigned_to: null }), // excluded (historical)
    row({ pipeline_stage: "new", assigned_to: null }), // COUNTED
    row({ pipeline_stage: "triaged", assigned_to: UID_A }), // has owner
    row({ pipeline_stage: "assigned", assigned_to: null }), // COUNTED
    row({ pipeline_stage: "bound", assigned_to: null }), // terminal
  ];
  eq(countUnassigned(rows), 2, "unassigned count");
  eq(isUnassignedPipelineCase(rows[0]!), false, "historical NULL not unassigned");
  eq(isUnassignedPipelineCase(rows[4]!), false, "terminal not unassigned");
});

test("waiting_info counts queue_status === waiting_info exactly", () => {
  const rows = [
    row({ queue_status: "waiting_info" }),
    row({ queue_status: "waiting_info" }),
    row({ queue_status: "in_review" }),
    row({ queue_status: null }),
  ];
  eq(countWaitingInfo(rows), 2, "waiting_info count");
});

// ---------------------------------------------------------------------------
// Default views by role
// ---------------------------------------------------------------------------

test("defaultViewForRole is deterministic", () => {
  eq(defaultViewForRole("manager"), "all", "manager");
  eq(defaultViewForRole("admin"), "all", "admin");
  eq(defaultViewForRole("readonly"), "all", "readonly");
  eq(defaultViewForRole("consultant"), "mine", "consultant");
  eq(defaultViewForRole("underwriter"), "mine", "underwriter");
  eq(defaultViewForRole("broker"), "all", "broker (already server-scoped)");
});

// ---------------------------------------------------------------------------
// filterPipelineView — Mine, Unassigned, Waiting, Referred, Quoted
// ---------------------------------------------------------------------------

test("Mine uses the UUID and excludes terminal", () => {
  const rows = [
    row({ id: "1", assigned_to: UID_A, pipeline_stage: "in_progress" }),
    row({ id: "2", assigned_to: UID_A, pipeline_stage: "bound" }), // terminal
    row({ id: "3", assigned_to: UID_B, pipeline_stage: "in_progress" }),
    row({ id: "4", assigned_to: UID_A, pipeline_stage: null }), // historical
  ];
  const mine = filterPipelineView(rows, "mine", { currentUserId: UID_A });
  eq(mine.length, 1, "one open row for A");
  eq(mine[0]!.id, "1", "matched by UUID");
});

test("Mine returns [] when the current user UUID is missing (never silently All)", () => {
  const rows = [row({ assigned_to: UID_A, pipeline_stage: "assigned" })];
  const mine = filterPipelineView(rows, "mine", { currentUserId: null });
  eq(mine.length, 0, "no UUID -> empty");
});

test("Unassigned excludes historical NULL and terminal", () => {
  const rows = [
    row({ pipeline_stage: null, assigned_to: null }),
    row({ pipeline_stage: "new", assigned_to: null }),
    row({ pipeline_stage: "assigned", assigned_to: UID_A }),
    row({ pipeline_stage: "lost", assigned_to: null }),
  ];
  const result = filterPipelineView(rows, "unassigned", { currentUserId: UID_A });
  eq(result.length, 1, "only the new unassigned open row");
  eq(result[0]!.pipeline_stage, "new", "stage");
});

test("Quoted view matches pipeline_stage exactly", () => {
  const rows = [
    row({ pipeline_stage: "quoted" }),
    row({ pipeline_stage: "assigned" }),
    row({ pipeline_stage: null }),
  ];
  eq(
    filterPipelineView(rows, "quoted", { currentUserId: UID_A }).length,
    1,
    "one quoted row"
  );
});

test("Waiting view uses queue_status (and legacy status compatibility)", () => {
  const rows = [
    row({ queue_status: "waiting_info", status: "in_review" }),
    row({ queue_status: null, status: "missing_info_requested" }), // legacy
    row({ queue_status: "in_review", status: "in_review" }),
  ];
  const waiting = filterPipelineView(rows, "waiting_info", { currentUserId: UID_A });
  eq(waiting.length, 2, "queue_status + legacy status");
});

test("Referred view uses queue_status (and legacy status compatibility)", () => {
  const rows = [
    row({ queue_status: "referred", status: "in_review" }),
    row({ queue_status: null, status: "referred_to_insurer" }),
    row({ queue_status: "in_review", status: "in_review" }),
  ];
  eq(
    filterPipelineView(rows, "referred", { currentUserId: UID_A }).length,
    2,
    "queue_status + legacy status"
  );
});

test("Needs-attention preserves urgent + overdue heuristic", () => {
  const now = new Date("2026-08-28T12:00:00Z");
  const urgent = row({ priority: "urgent" });
  const overdue = row({ due_at: "2026-08-27T00:00:00Z" });
  const calm = row({ priority: "normal", due_at: "2027-01-01T00:00:00Z" });
  eq(needsAttention(urgent, now), true, "urgent");
  eq(needsAttention(overdue, now), true, "overdue");
  eq(needsAttention(calm, now), false, "calm");
});

// ---------------------------------------------------------------------------
// stageAgeMs — honest elapsed calendar time, no fabricated dates
// ---------------------------------------------------------------------------

test("stageAgeMs returns elapsed ms from timestamp", () => {
  const now = new Date("2026-08-28T12:00:00Z");
  const rowWithTs = row({
    last_pipeline_stage_changed_at: "2026-08-28T10:00:00Z",
  });
  eq(stageAgeMs(rowWithTs, now), 2 * 60 * 60 * 1000, "2 hours");
});

test("stageAgeMs returns null when timestamp is missing (never fabricates)", () => {
  eq(stageAgeMs(row({ last_pipeline_stage_changed_at: null })), null, "null ts");
  eq(
    stageAgeMs(row({ last_pipeline_stage_changed_at: "not-a-date" })),
    null,
    "bad ts"
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
  console.log(
    `\nPhase 18 pipeline domain: ${passed} passed, ${failed} failed out of ${tests.length}`
  );
  if (failed > 0 && typeof process !== "undefined") process.exitCode = 1;
})();
