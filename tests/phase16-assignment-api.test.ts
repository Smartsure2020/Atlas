/**
 * Phase 16 (Quote Pipeline — assignment engine) — Worker API tests
 * ---------------------------------------------------------------------------
 * Atlas's phase test harness runs in-process without live Supabase; these
 * tests focus on what can be honestly asserted in-process:
 *
 *   - mapAssignmentRpcResult correctly translates every SQL outcome into a
 *     safe (status, body) pair — no raw SQL/PostgREST text may leak
 *   - QUEUE_STATUS_VALUES matches the historical PATCH /assignment contract
 *   - the router regex in worker/src/index.ts accepts the two new subpaths
 *     (/assignment/auto POST, /assignment-history GET) and preserves the
 *     existing /assignment PATCH shape
 *
 * A live-DB regression pack for the concurrency and RLS contract is in the
 * Phase 2 implementation report; this file does not attempt to fake it.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  QUEUE_STATUS_VALUES,
  isQueueStatus,
  isUuid,
  mapAssignmentRpcResult,
} from "../worker/src/assignment-helpers.js";
import type { AssignmentRpcResult } from "../worker/src/quote-pipeline-types.js";

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

// ---------------------------------------------------------------------------
// mapAssignmentRpcResult — safe error mapping
// ---------------------------------------------------------------------------

const OUTCOME_TO_EXPECTED_STATUS: Array<{
  outcome: AssignmentRpcResult["outcome"];
  status: number;
}> = [
  { outcome: "assigned", status: 200 },
  { outcome: "already_assigned", status: 200 },
  { outcome: "unchanged", status: 200 },
  { outcome: "submission_not_found", status: 404 },
  { outcome: "target_user_not_found", status: 404 },
  { outcome: "actor_required", status: 400 },
  { outcome: "pipeline_not_initialized", status: 409 },
  { outcome: "not_triaged", status: 409 },
  { outcome: "terminal_submission", status: 409 },
  { outcome: "classification_required", status: 409 },
  { outcome: "no_eligible_underwriter", status: 409 },
];

for (const { outcome, status } of OUTCOME_TO_EXPECTED_STATUS) {
  test(`mapAssignmentRpcResult(${outcome}) returns HTTP ${status}`, () => {
    const mapped = mapAssignmentRpcResult({
      outcome,
      submission_id: "00000000-0000-0000-0000-000000000001",
      pipeline_stage: "assigned",
      eligible_candidate_count: 3,
    });
    assertEqual(mapped.status, status, `outcome ${outcome} status`);
  });
}

test("mapAssignmentRpcResult 'assigned' body echoes the assignment identity", () => {
  const mapped = mapAssignmentRpcResult({
    outcome: "assigned",
    submission_id: "00000000-0000-0000-0000-000000000001",
    assigned_to: "00000000-0000-0000-0000-000000000002",
    pipeline_stage: "assigned",
    event_id: "00000000-0000-0000-0000-000000000003",
  });
  assertEqual(mapped.status, 200, "status");
  assertEqual(mapped.body.ok, true, "ok:true present");
  assertEqual(mapped.body.assigned_to, "00000000-0000-0000-0000-000000000002", "assigned_to echoed");
});

test("mapAssignmentRpcResult never returns raw SQL/PostgREST text", () => {
  for (const { outcome } of OUTCOME_TO_EXPECTED_STATUS) {
    const mapped = mapAssignmentRpcResult({
      outcome,
      submission_id: "00000000-0000-0000-0000-000000000001",
    });
    const bodyStr = JSON.stringify(mapped.body).toLowerCase();
    assert(!bodyStr.includes("sqlstate"), `outcome ${outcome}: must not leak sqlstate`);
    assert(!bodyStr.includes("postgres"), `outcome ${outcome}: must not leak postgres text`);
    assert(!bodyStr.includes("permission denied for"), `outcome ${outcome}: must not leak raw RLS message`);
  }
});

test("mapAssignmentRpcResult on an unknown outcome falls back to 500 internal_error", () => {
  // Unknown outcomes should never happen — but defence in depth demands a
  // safe generic response, not a leaked shape.
  const mapped = mapAssignmentRpcResult({
    outcome: "some_new_outcome" as unknown as AssignmentRpcResult["outcome"],
    submission_id: "00000000-0000-0000-0000-000000000001",
  });
  assertEqual(mapped.status, 500, "unknown outcome -> 500");
  assertEqual((mapped.body as Record<string, unknown>).error, "internal_error", "error code");
});

// ---------------------------------------------------------------------------
// isQueueStatus / QUEUE_STATUS_VALUES — historical contract preservation
// ---------------------------------------------------------------------------

test("QUEUE_STATUS_VALUES matches Atlas's pre-Phase-2 operational vocabulary", () => {
  const expected = [
    "new",
    "in_review",
    "waiting_info",
    "referred",
    "completed",
    "archived",
  ];
  assertEqual(QUEUE_STATUS_VALUES.length, expected.length, "queue_status count");
  for (const v of expected) {
    assert(
      (QUEUE_STATUS_VALUES as readonly string[]).includes(v),
      `QUEUE_STATUS_VALUES missing ${v}`
    );
  }
});

test("isQueueStatus rejects unknown values", () => {
  assertEqual(isQueueStatus("bogus"), false, "unknown value");
  assertEqual(isQueueStatus(""), false, "empty string");
  assertEqual(isQueueStatus(null), false, "null");
  assertEqual(isQueueStatus(undefined), false, "undefined");
});

// ---------------------------------------------------------------------------
// isUuid — basic guard
// ---------------------------------------------------------------------------

test("isUuid accepts canonical UUIDs and rejects garbage", () => {
  assertEqual(isUuid("00000000-0000-0000-0000-000000000000"), true, "canonical uuid");
  assertEqual(isUuid("not-a-uuid"), false, "garbage");
  assertEqual(isUuid(""), false, "empty");
  assertEqual(isUuid(null), false, "null");
});

// ---------------------------------------------------------------------------
// Router — regex must accept the new subpaths and preserve the existing one
// ---------------------------------------------------------------------------

const INDEX_TS_PATH = resolve(process.cwd(), "worker", "src", "index.ts");
const INDEX_TS = readFileSync(INDEX_TS_PATH, "utf8");

// Pull the regex literal used by the /api/submissions/:id[/sub[/sub]] route.
function loadRouterRegex(): RegExp {
  const re =
    /const m = pathname\.match\(\s*([\s\S]*?)\s*\);/;
  const m = INDEX_TS.match(re);
  if (!m) throw new Error("could not locate router regex in worker/src/index.ts");
  // Extract the raw JS regex literal `/^\/api\/submissions\/.../` from the arg.
  const src = m[1].trim();
  const regexLiteralRe = /\/(.+)\/([a-z]*)/s;
  const rm = src.match(regexLiteralRe);
  if (!rm) throw new Error("could not extract regex literal from router match call");
  return new RegExp(rm[1], rm[2]);
}

const ROUTER_RE = loadRouterRegex();

test("router regex matches the historical /assignment PATCH path", () => {
  const m = "/api/submissions/00000000-0000-0000-0000-000000000001/assignment".match(ROUTER_RE);
  assert(m, "regex must match /assignment");
  assertEqual(m![2], "/assignment", "sub segment");
});

test("router regex matches the new /assignment/auto POST path", () => {
  const m = "/api/submissions/00000000-0000-0000-0000-000000000001/assignment/auto".match(ROUTER_RE);
  assert(m, "regex must match /assignment/auto");
  assertEqual(m![2], "/assignment/auto", "sub segment");
});

test("router regex matches the new /assignment-history GET path", () => {
  const m = "/api/submissions/00000000-0000-0000-0000-000000000001/assignment-history".match(ROUTER_RE);
  assert(m, "regex must match /assignment-history");
  assertEqual(m![2], "/assignment-history", "sub segment");
});

test("router wires POST /assignment/auto behind roleCanWrite", () => {
  const patch =
    /if \(sub === "\/assignment\/auto" && request\.method === "POST"\)\s*\{[\s\S]*?roleCanWrite\(user\.role\)[\s\S]*?handleAutoAssignSubmission\(/;
  assert(patch.test(INDEX_TS), "POST /assignment/auto must be gated by roleCanWrite + handler");
});

test("router wires GET /assignment-history to the assignment handler", () => {
  const patch =
    /if \(sub === "\/assignment-history" && request\.method === "GET"\)\s*\{[\s\S]*?handleGetAssignmentHistory\(/;
  assert(patch.test(INDEX_TS), "GET /assignment-history must be wired to handleGetAssignmentHistory");
});

test("router preserves the existing PATCH /assignment shape", () => {
  const patch =
    /if \(sub === "\/assignment" && request\.method === "PATCH"\)\s*\{[\s\S]*?roleCanWrite\(user\.role\)[\s\S]*?handleUpdateAssignment\(/;
  assert(patch.test(INDEX_TS), "PATCH /assignment must remain gated by roleCanWrite + handleUpdateAssignment");
});

// ---------------------------------------------------------------------------
// phase7-endpoints.ts still exports handleUpdateAssignment (backwards compat)
// but now delegates through the canonical assignment module.
// ---------------------------------------------------------------------------

const PHASE7_PATH = resolve(process.cwd(), "worker", "src", "phase7-endpoints.ts");
const PHASE7_SRC = readFileSync(PHASE7_PATH, "utf8");

test("phase7-endpoints.ts still exports handleUpdateAssignment", () => {
  assert(
    /export async function handleUpdateAssignment\b/.test(PHASE7_SRC),
    "handleUpdateAssignment must still be exported for legacy callers"
  );
});

test("phase7-endpoints.ts routes handleUpdateAssignment to the canonical module", () => {
  assert(
    /canonicalHandleUpdateAssignment\(submissionId, request, env, user\)/.test(PHASE7_SRC),
    "handleUpdateAssignment must delegate to the canonical module"
  );
  // And must NOT still write assignment fields directly on atlas_submissions.
  assert(
    !/atlas_submissions[\s\S]*?assigned_underwriter[\s\S]*?assigned_at[\s\S]*?assigned_by/.test(
      PHASE7_SRC
    ),
    "phase7-endpoints.ts must NOT still write assignment columns directly on atlas_submissions"
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
  console.log(`\nPhase 16 assignment API: ${passed} passed, ${failed} failed out of ${tests.length}`);
  if (failed > 0 && typeof process !== "undefined") process.exitCode = 1;
})();
