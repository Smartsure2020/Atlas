/**
 * Phase 18 — Quote Pipeline Worker API surface (Phase 4)
 * ---------------------------------------------------------------------------
 * Structural + pure-helper checks for:
 *   GET /api/pipeline/workload
 *   GET /api/submissions/:id/quick
 *
 * Behavioural DB checks live in the staging regression pack; this file asserts
 * what the plain-node harness can verify honestly:
 *   1. router wiring (paths, methods, gating)
 *   2. workload predicate matches Phase 2 auto-assignment exactly
 *   3. workload computation excludes historical NULL and stray broker profiles
 *   4. quick-drawer projection is an explicit allow-list — no spread of the
 *      raw row, no extraction/decision/recommendation content
 *   5. document summariser shape
 *   6. GET verbs never mutate lifecycle state
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  ASSIGNABLE_ATLAS_ROLES,
  computeWorkload,
  isAssignableAtlasRole,
  isOpenWorkloadStage,
  projectQuickSubmission,
  summariseDocuments,
  type RawQuickSubmissionRow,
  type WorkloadSubmissionRow,
} from "../worker/src/pipeline-core.js";
import { QUOTE_PIPELINE_TERMINAL_STAGES } from "../worker/src/quote-pipeline-types.js";

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
const UID_BROKER = "00000000-0000-0000-0000-00000000000c";

// ---------------------------------------------------------------------------
// Assignable role gate — must match target_not_assignable semantics
// ---------------------------------------------------------------------------

test("ASSIGNABLE_ATLAS_ROLES is exactly {underwriter, consultant, manager, admin}", () => {
  const expected = ["underwriter", "consultant", "manager", "admin"].sort();
  const actual = [...ASSIGNABLE_ATLAS_ROLES].sort();
  eq(actual.join("|"), expected.join("|"), "assignable roles set");
});

test("broker and readonly are not assignable capacity", () => {
  eq(isAssignableAtlasRole("broker"), false, "broker");
  eq(isAssignableAtlasRole("readonly"), false, "readonly");
  eq(isAssignableAtlasRole(null), false, "null");
  eq(isAssignableAtlasRole(undefined), false, "undefined");
  eq(isAssignableAtlasRole("underwriter"), true, "underwriter");
});

// ---------------------------------------------------------------------------
// Open workload stage predicate — MUST match migration 0024 exactly
// ---------------------------------------------------------------------------

test("isOpenWorkloadStage excludes bound/declined/lost and NULL", () => {
  for (const s of QUOTE_PIPELINE_TERMINAL_STAGES) {
    eq(isOpenWorkloadStage(s), false, `terminal ${s} excluded`);
  }
  eq(isOpenWorkloadStage(null), false, "NULL excluded");
  for (const s of ["new", "triaged", "assigned", "in_progress", "quoted"]) {
    eq(isOpenWorkloadStage(s), true, `open ${s}`);
  }
});

// ---------------------------------------------------------------------------
// computeWorkload — Phase 2 semantics
// ---------------------------------------------------------------------------

test("computeWorkload counts open non-terminal rows only, excludes historical NULL", () => {
  const users = [
    {
      user_id: UID_A,
      email: "a@example.com",
      role: "underwriter",
      active_for_assignment: true,
    },
    {
      user_id: UID_B,
      email: "b@example.com",
      role: "consultant",
      active_for_assignment: false,
    },
  ];
  const subs: WorkloadSubmissionRow[] = [
    { assigned_to: UID_A, pipeline_stage: "in_progress", line_of_business: "commercial" },
    { assigned_to: UID_A, pipeline_stage: "quoted", line_of_business: "personal" },
    { assigned_to: UID_A, pipeline_stage: "bound", line_of_business: "commercial" }, // terminal
    { assigned_to: UID_A, pipeline_stage: null, line_of_business: null }, // historical
    { assigned_to: null, pipeline_stage: "new", line_of_business: "personal" }, // unassigned
    { assigned_to: UID_B, pipeline_stage: "assigned", line_of_business: "personal" },
  ];
  const workload = computeWorkload(users, subs);
  eq(workload.length, 2, "two entries");
  const a = workload.find((w) => w.user_id === UID_A)!;
  const b = workload.find((w) => w.user_id === UID_B)!;
  eq(a.open_count, 2, "A open count: in_progress + quoted only");
  eq(a.by_stage.in_progress, 1, "A in_progress");
  eq(a.by_stage.quoted, 1, "A quoted");
  eq(a.by_line.commercial, 1, "A commercial");
  eq(a.by_line.personal, 1, "A personal");
  eq(b.open_count, 1, "B open count");
  eq(b.active_for_assignment, false, "B inactive surfaced truthfully");
});

test("computeWorkload never grants a broker profile underwriting capacity", () => {
  const users = [
    {
      user_id: UID_BROKER,
      email: "broker@example.com",
      role: "broker",
      active_for_assignment: true,
    },
  ];
  const subs: WorkloadSubmissionRow[] = [
    // Even if a broker were mistakenly assigned, they must not appear.
    { assigned_to: UID_BROKER, pipeline_stage: "assigned", line_of_business: "personal" },
  ];
  const workload = computeWorkload(users, subs);
  eq(workload.length, 0, "broker filtered out");
});

test("computeWorkload silently ignores assignments to unknown users (no invented capacity)", () => {
  const users = [
    {
      user_id: UID_A,
      email: "a@example.com",
      role: "underwriter",
      active_for_assignment: true,
    },
  ];
  const subs: WorkloadSubmissionRow[] = [
    { assigned_to: UID_B, pipeline_stage: "assigned", line_of_business: "personal" },
  ];
  const workload = computeWorkload(users, subs);
  eq(workload.length, 1, "only A entry");
  eq(workload[0]!.open_count, 0, "no invented count for missing user");
});

test("computeWorkload does not surface weight", () => {
  const users = [
    {
      user_id: UID_A,
      email: "a@example.com",
      role: "underwriter",
      active_for_assignment: true,
    },
  ];
  const [entry] = computeWorkload(users, []);
  assert(!("weight" in (entry as object)), "weight must not leak");
});

// ---------------------------------------------------------------------------
// Quick-drawer projection — explicit allow-list, no leaks
// ---------------------------------------------------------------------------

const FORBIDDEN_QUICK_FIELDS = [
  "extraction",
  "reviewed_json",
  "extracted_json",
  "recommendation",
  "recommendation_json",
  "quote_review",
  "decision",
  "decision_json",
  "communications",
  "broker_email_body",
  "signed_url",
  "raw",
  "appetite",
  "insurer",
  "jobs",
];

test("projectQuickSubmission returns only the allow-listed fields", () => {
  const raw = {
    id: "s1",
    client_name: "Client",
    broker_name: "Broker",
    broker_email: "b@e.com",
    request_type: "New",
    pipeline_stage: "assigned",
    queue_status: "new",
    line_of_business: "commercial",
    complexity: "standard",
    priority: "normal",
    assigned_to: UID_A,
    next_action: "Review intake",
    due_at: null,
    source_type: "manual",
    received_at: "2026-08-01T00:00:00Z",
    created_at: "2026-08-01T00:00:00Z",
    updated_at: "2026-08-02T00:00:00Z",
    last_pipeline_stage_changed_at: "2026-08-02T00:00:00Z",
    // The dangerous "future columns" case:
    broker_email_body: "SHOULD NOT LEAK — this is raw broker content",
    extracted_json: { risk: "secret" },
    reviewed_json: { risk: "secret" },
    recommendation_json: { winner: "insurer" },
    decision_json: { outcome: "declined" },
    quote_review: { finding: "leak" },
    communications: [{ body: "internal note" }],
    signed_url: "https://storage.example/secret",
    jobs: [{ id: "j1", status: "running" }],
    appetite: { band: "declined" },
  } as unknown as RawQuickSubmissionRow;
  const proj = projectQuickSubmission(raw, "a@example.com");
  for (const forbidden of FORBIDDEN_QUICK_FIELDS) {
    assert(
      !(forbidden in (proj as object)),
      `field ${forbidden} must NOT be in the quick projection`
    );
  }
  eq(proj.pipeline_stage, "assigned", "stage preserved");
  eq(proj.assigned_to_email, "a@example.com", "email projected in");
  eq(proj.assigned_to, UID_A, "assignee preserved");
});

test("projectQuickSubmission never spreads unknown columns (defence for future schema drift)", () => {
  const raw = {
    id: "s1",
    client_name: null,
    broker_name: null,
    broker_email: null,
    request_type: null,
    pipeline_stage: null,
    queue_status: null,
    line_of_business: null,
    complexity: null,
    priority: null,
    assigned_to: null,
    next_action: null,
    due_at: null,
    source_type: null,
    received_at: null,
    created_at: null,
    updated_at: null,
    last_pipeline_stage_changed_at: null,
    _hypothetical_future_secret: "must never leak",
  } as unknown as RawQuickSubmissionRow;
  const proj = projectQuickSubmission(raw, null);
  assert(
    !("_hypothetical_future_secret" in (proj as object)),
    "unknown column must not appear"
  );
});

// ---------------------------------------------------------------------------
// Document summary
// ---------------------------------------------------------------------------

test("summariseDocuments tallies status + scan buckets", () => {
  const summary = summariseDocuments([
    { id: "1", status: "active", scan_status: "clean" },
    { id: "2", status: "active", scan_status: "pending" },
    { id: "3", status: "deleted", scan_status: "infected" },
    { id: "4", status: "active", scan_status: "failed" },
  ]);
  eq(summary.total, 4, "total");
  eq(summary.active, 3, "active");
  eq(summary.clean, 1, "clean");
  eq(summary.pending_scan, 1, "pending_scan");
  eq(summary.failed, 2, "failed (infected + failed)");
});

// ---------------------------------------------------------------------------
// Router wiring (structural)
// ---------------------------------------------------------------------------

const INDEX_TS = readFileSync(
  resolve(process.cwd(), "worker", "src", "index.ts"),
  "utf8"
);
const PIPELINE_ENDPOINTS_TS = readFileSync(
  resolve(process.cwd(), "worker", "src", "pipeline-endpoints.ts"),
  "utf8"
);

test("router wires GET /api/pipeline/workload", () => {
  const p =
    /pathname === "\/api\/pipeline\/workload"[\s\S]*?request\.method === "GET"[\s\S]*?handleGetWorkload\(/;
  assert(p.test(INDEX_TS), "GET /api/pipeline/workload must be wired to handleGetWorkload");
});

test("router wires GET /api/submissions/:id/quick behind canAccessSubmission", () => {
  const p =
    /canAccessSubmission[\s\S]*?sub === "\/quick" && request\.method === "GET"[\s\S]*?handleGetSubmissionQuick\(/;
  assert(p.test(INDEX_TS), "GET /quick must be wired behind canAccessSubmission");
});

test("workload endpoint gates on roleCanViewManagerDashboard", () => {
  const p =
    /handleGetWorkload[\s\S]*?roleCanViewManagerDashboard\(user\.role\)[\s\S]*?permission_denied/;
  assert(p.test(PIPELINE_ENDPOINTS_TS), "workload must be manager/admin only");
});

test("workload endpoint enforces the auto-assignment predicate at the DB filter", () => {
  // The SQL predicate is: assigned_to IS NOT NULL AND pipeline_stage IS NOT NULL
  // AND pipeline_stage NOT IN ('bound','declined','lost'). Enforce it exactly.
  assert(
    /\.not\("assigned_to", "is", null\)/.test(PIPELINE_ENDPOINTS_TS),
    "assigned_to IS NOT NULL"
  );
  assert(
    /\.not\("pipeline_stage", "is", null\)/.test(PIPELINE_ENDPOINTS_TS),
    "pipeline_stage IS NOT NULL"
  );
  assert(
    /\.not\("pipeline_stage", "in", "\(bound,declined,lost\)"\)/.test(
      PIPELINE_ENDPOINTS_TS
    ),
    "pipeline_stage NOT IN terminal set"
  );
});

test("quick endpoint uses the broker-safe audit projection for broker", () => {
  const p =
    /user\.role === "broker"[\s\S]*?projectAuditForBroker\(/;
  assert(p.test(PIPELINE_ENDPOINTS_TS), "broker path must use projectAuditForBroker");
});

test("quick endpoint hides assignment events from broker", () => {
  const p =
    /if \(user\.role !== "broker"\)[\s\S]*?atlas_assignment_events/;
  assert(p.test(PIPELINE_ENDPOINTS_TS), "broker must not receive assignment_events");
});

test("quick endpoint never issues a mutating verb (no update/insert/rpc/delete)", () => {
  // Constrain to the two handlers rather than the whole module.
  const handlerRegion = PIPELINE_ENDPOINTS_TS.split(
    "export async function handleGetSubmissionQuick"
  )[1];
  assert(handlerRegion, "handleGetSubmissionQuick block must be present");
  const mut = /\.update\(|\.insert\(|\.rpc\(|\.delete\(/;
  assert(!mut.test(handlerRegion!), "quick handler must not mutate");
  const workloadRegion = PIPELINE_ENDPOINTS_TS.split(
    "export async function handleGetWorkload"
  )[1]?.split("export async function handleGetSubmissionQuick")[0];
  assert(workloadRegion, "handleGetWorkload block must be present");
  assert(!mut.test(workloadRegion!), "workload handler must not mutate");
});

test("router-level broker/readonly checks for /assignment survive (Phase 3 guard)", () => {
  // Sanity: /assignment PATCH remains broker-forbidden — Phase 4 must not
  // regress the guard.
  assert(
    /sub === "\/assignment" && request\.method === "PATCH"[\s\S]*?user\.role === "broker"/.test(
      INDEX_TS
    ),
    "PATCH /assignment must still refuse broker"
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
    `\nPhase 18 pipeline API: ${passed} passed, ${failed} failed out of ${tests.length}`
  );
  if (failed > 0 && typeof process !== "undefined") process.exitCode = 1;
})();
