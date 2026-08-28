/**
 * Phase 17 (broker role — history hardening) — audit projection behavioural tests
 * ---------------------------------------------------------------------------
 * Exercises worker/src/audit-projection.ts (the pure sanitiser) with fixture
 * rows and asserts exactly what broker and staff receive. Complements the
 * migration + policy structural checks below.
 *
 * Also asserts migration 0026 shape — the allow-list on the RLS side stays
 * in sync with the Worker allow-list (any drift is caught here).
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  BROKER_SAFE_AUDIT_ACTIONS,
  isBrokerSafeAuditAction,
  projectAuditForBroker,
  projectAuditForStaff,
  type RawAuditRow,
} from "../worker/src/audit-projection.js";

const tests: { name: string; fn: () => void | Promise<void> }[] = [];
function test(name: string, fn: () => void | Promise<void>) {
  tests.push({ name, fn });
}
function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

// ---------------------------------------------------------------------------
// Fixture audit rows — every one is on the same submission (the router's
// canAccessSubmission() gate is tested elsewhere).
// ---------------------------------------------------------------------------

const BROKER_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const STAFF_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

const FIXTURE_ROWS: RawAuditRow[] = [
  {
    id: "r-1",
    action: "submission_created",
    actor: BROKER_ID,
    metadata_json: { has_pasted_email: true },
    created_at: "2026-08-28T09:00:00Z",
  },
  {
    id: "r-2",
    action: "document_uploaded",
    actor: BROKER_ID,
    metadata_json: {
      document_id: "doc-1",
      document_type: "policy",
      file_name: "policy.pdf",
      expires_at: "2026-09-30T09:00:00Z",
      file_hash_present: true,
      scan_status: "pending",
    },
    created_at: "2026-08-28T09:05:00Z",
  },
  {
    id: "r-3",
    action: "extraction_run",
    actor: STAFF_ID,
    metadata_json: {
      extraction_id: "ext-42",
      overall_confidence: 0.82,
      pipeline_mode: "hybrid",
      route: "azure",
      escalated_field_count: 3,
    },
    created_at: "2026-08-28T09:15:00Z",
  },
  {
    id: "r-4",
    action: "recommendation_run",
    actor: STAFF_ID,
    metadata_json: {
      recommendation_id: "rec-9",
      extraction_id: "ext-42",
      top_insurer: "Bryte Insurance",
      top_score: 0.91,
      referral_required: false,
      senior_review_required: false,
      manual_review_required: false,
      insurers_considered: 6,
      reasoning_source: "deterministic",
    },
    created_at: "2026-08-28T09:20:00Z",
  },
  {
    id: "r-5",
    action: "quote_review_run",
    actor: STAFF_ID,
    metadata_json: {
      quote_review_id: "qr-11",
      recommendation_id: "rec-9",
      insurer_id: "ins-3",
      status: "draft",
      sections: [{ section_key: "coverage", finding: "ok" }],
    },
    created_at: "2026-08-28T09:25:00Z",
  },
  {
    id: "r-6",
    action: "decision_accepted",
    actor: STAFF_ID,
    metadata_json: {
      selected_insurer: "Bryte Insurance",
      selected_insurer_id: "ins-3",
      recommendation_id: "rec-9",
      quote_review_id: "qr-11",
      decision_status: "ready_for_quote",
      decision_choice: "accepted",
      ai_recommendation_was: "Bryte Insurance",
    },
    created_at: "2026-08-28T09:30:00Z",
  },
  {
    id: "r-7",
    action: "communication_saved",
    actor: STAFF_ID,
    metadata_json: {
      communication_type: "internal_note",
      audience: "internal",
      quote_review_id: "qr-11",
    },
    created_at: "2026-08-28T09:35:00Z",
  },
  {
    id: "r-8",
    action: "missing_info_added",
    actor: STAFF_ID,
    metadata_json: {
      item_id: "mi-1",
      quote_review_id: "qr-11",
      item_type: "underwriting_info",
      owner: "broker",
    },
    created_at: "2026-08-28T09:40:00Z",
  },
  {
    id: "r-9",
    action: "submission_queue_status_changed",
    actor: STAFF_ID,
    metadata_json: { queue_status: "waiting_info" },
    created_at: "2026-08-28T09:45:00Z",
  },
  {
    id: "r-10",
    // Future / unknown audit action. It MUST NOT reach broker.
    action: "future_new_underwriting_event_v2",
    actor: STAFF_ID,
    metadata_json: {
      top_insurer: "Naked",
      overall_confidence: 0.55,
      selected_insurer: "Naked",
    },
    created_at: "2026-08-28T09:50:00Z",
  },
];

// ---------------------------------------------------------------------------
// Allow-list shape
// ---------------------------------------------------------------------------

test("BROKER_SAFE_AUDIT_ACTIONS contains exactly the documented operational events", () => {
  const expected = new Set([
    "submission_created",
    "document_uploaded",
    "submission_queue_status_changed",
    "missing_info_added",
    "missing_info_updated",
  ]);
  assert(BROKER_SAFE_AUDIT_ACTIONS.size === expected.size, "unexpected size");
  for (const a of expected) assert(BROKER_SAFE_AUDIT_ACTIONS.has(a), `missing ${a}`);
});

test("isBrokerSafeAuditAction rejects every underwriting-intelligence action", () => {
  const forbidden = [
    "extraction_run",
    "extraction_reviewed",
    "recommendation_run",
    "quote_review_run",
    "decision_accepted",
    "decision_overridden",
    "decision_override_ruled_out",
    "decision_blocked_ruled_out_override",
    "communication_saved",
    "communication_updated",
    "appetite_edited",
    "appetite_confirmed",
    "appetite_deactivated",
    "appetite_manual_added",
    "insurer_created",
    "insurer_edited",
    "insurer_document_uploaded",
    "insurer_document_processed",
    "email_draft_generated",
    "pilot_issue_created",
    "pilot_issue_updated",
    "cleanup_preview_run",
    "acknowledge",
    "submission_assignment_changed",
    "submission_auto_assigned",
    "malware_scan_completed",
    "future_new_underwriting_event_v2",
    "extraction_denied",
    "extraction_blocked_documents_unavailable",
  ];
  for (const a of forbidden) {
    assert(!isBrokerSafeAuditAction(a), `broker MUST NOT see ${a}`);
  }
});

// ---------------------------------------------------------------------------
// Behavioural: staff timeline is unchanged
// ---------------------------------------------------------------------------

test("staff projection returns every audit row with raw metadata preserved", () => {
  const emails = new Map<string, string>([[STAFF_ID, "staff@example.test"]]);
  const events = projectAuditForStaff(FIXTURE_ROWS, emails);
  assert(events.length === FIXTURE_ROWS.length, `expected ${FIXTURE_ROWS.length} got ${events.length}`);
  const rec = events.find((e) => e.action === "recommendation_run");
  assert(rec, "recommendation_run missing");
  const meta = rec!.metadata as Record<string, unknown>;
  assert(meta && meta.top_insurer === "Bryte Insurance", "staff metadata scrubbed unexpectedly");
  assert(rec!.actor_email === "staff@example.test", "staff actor_email lookup failed");
});

// ---------------------------------------------------------------------------
// Behavioural: broker allow-list + scrub
// ---------------------------------------------------------------------------

test("broker projection returns ONLY allow-listed operational events", () => {
  const events = projectAuditForBroker(FIXTURE_ROWS, BROKER_ID, "broker@example.test");
  const actions = new Set(events.map((e) => e.action));
  const mustInclude = [
    "submission_created",
    "document_uploaded",
    "submission_queue_status_changed",
    "missing_info_added",
  ];
  for (const a of mustInclude) assert(actions.has(a), `broker missing allow-listed ${a}`);
  const mustExclude = [
    "extraction_run",
    "recommendation_run",
    "quote_review_run",
    "decision_accepted",
    "communication_saved",
    "future_new_underwriting_event_v2",
  ];
  for (const a of mustExclude) assert(!actions.has(a), `broker MUST NOT receive ${a}`);
});

test("broker projection never leaks underwriting-intelligence tokens in the serialised body", () => {
  const events = projectAuditForBroker(FIXTURE_ROWS, BROKER_ID, "broker@example.test");
  const serialised = JSON.stringify({ ok: true, events });
  const forbidden = [
    "top_insurer",
    "top_score",
    "selected_insurer",
    "insurer_id",
    "recommendation_id",
    "quote_review_id",
    "overall_confidence",
    "pipeline_mode",
    "reasoning_source",
    "extraction_id",
    "referral_required",
    "senior_review_required",
    "manual_review_required",
    "insurers_considered",
    "route",
    "escalated_field_count",
    "ai_recommendation_was",
    "decision_status",
    "decision_choice",
    "Bryte Insurance",
    "Naked",
  ];
  for (const t of forbidden) {
    assert(!serialised.includes(t), `broker response leaks token "${t}"`);
  }
});

test("broker projection sets metadata: null on every event", () => {
  const events = projectAuditForBroker(FIXTURE_ROWS, BROKER_ID, "broker@example.test");
  for (const ev of events) {
    assert(ev.metadata === null, `event ${ev.action} has non-null metadata`);
  }
});

test("broker sees own actor email; internal staff actor id and email are withheld", () => {
  const events = projectAuditForBroker(FIXTURE_ROWS, BROKER_ID, "broker@example.test");
  const own = events.find((e) => e.action === "submission_created");
  assert(own, "own submission_created missing");
  assert(own!.actor_email === "broker@example.test", "broker's own email withheld unexpectedly");
  assert(own!.actor_id === BROKER_ID, "broker's own id missing");

  const staffAction = events.find((e) => e.action === "submission_queue_status_changed");
  assert(staffAction, "queue-status row missing");
  assert(staffAction!.actor_email === null, "staff actor_email must be null for broker");
  assert(staffAction!.actor_id === null, "staff actor_id must be nulled for broker");
});

test("broker projection is safe when broker email is null (session without email)", () => {
  const events = projectAuditForBroker(FIXTURE_ROWS, BROKER_ID, null);
  const own = events.find((e) => e.action === "submission_created");
  assert(own && own.actor_email === null, "actor_email must be null when broker email is null");
});

test("empty rows returns empty events for broker", () => {
  const events = projectAuditForBroker([], BROKER_ID, "broker@example.test");
  assert(events.length === 0, "empty broker projection must be empty");
});

test("broker projection preserves chronological order for allow-listed rows", () => {
  const events = projectAuditForBroker(FIXTURE_ROWS, BROKER_ID, "broker@example.test");
  for (let i = 1; i < events.length; i++) {
    assert(events[i - 1].created_at <= events[i].created_at, "order broken");
  }
});

// ---------------------------------------------------------------------------
// Migration 0026 structural checks
// ---------------------------------------------------------------------------

const MIGRATION_PATH = resolve(process.cwd(), "supabase/migrations/0026_broker_history_hardening.sql");
const SRC = readFileSync(MIGRATION_PATH, "utf8");

test("0026 does not DROP or TRUNCATE any table", () => {
  assert(!/\bdrop\s+table\b/i.test(SRC), "no DROP TABLE");
  assert(!/\btruncate\b/i.test(SRC), "no TRUNCATE");
});

test("0026 defines atlas_broker_audit_action_allowed as an immutable positive allow-list", () => {
  assert(/create or replace function public\.atlas_broker_audit_action_allowed/i.test(SRC),
    "helper missing");
  assert(/immutable/i.test(SRC), "helper must be marked immutable");
  const body = SRC.split("atlas_broker_audit_action_allowed")[1] ?? "";
  for (const a of [
    "submission_created",
    "document_uploaded",
    "submission_queue_status_changed",
    "missing_info_added",
    "missing_info_updated",
  ]) {
    assert(new RegExp(`'${a}'`).test(body), `helper missing '${a}'`);
  }
  assert(!/not\s+in\s*\(/i.test(body), "must not use NOT IN blocklist form");
});

// Note: the "SQL ⊇ Worker allow-list" parity assertion is intentionally
// removed. Migration 0027 makes broker direct SELECT on atlas_audit_logs
// impossible, so SQL/Worker action-set parity is no longer a security
// invariant. The 0026 helper survives as a legacy artefact; do not treat
// it as authoritative for broker Data API access.

test("0026 adds no INSERT/UPDATE/DELETE policy on atlas_audit_logs", () => {
  const clauses = SRC.match(/on public\.atlas_audit_logs[\s\S]*?;/gi) ?? [];
  for (const c of clauses) {
    assert(!/for\s+insert/i.test(c), "no INSERT policy");
    assert(!/for\s+update/i.test(c), "no UPDATE policy");
    assert(!/for\s+delete/i.test(c), "no DELETE policy");
  }
});

// ---------------------------------------------------------------------------
// Migration 0027 — broker audit Data API lockdown
// ---------------------------------------------------------------------------

const MIGRATION_0027_PATH = resolve(
  process.cwd(),
  "supabase/migrations/0027_broker_audit_data_api_lockdown.sql"
);
const SRC_0027 = readFileSync(MIGRATION_0027_PATH, "utf8");

test("0027 does not DROP or TRUNCATE any table", () => {
  assert(!/\bdrop\s+table\b/i.test(SRC_0027), "no DROP TABLE");
  assert(!/\btruncate\b/i.test(SRC_0027), "no TRUNCATE");
});

test("0027 replaces atlas_audit_select and preserves internal semantics", () => {
  assert(/drop policy if exists atlas_audit_select on public\.atlas_audit_logs/i.test(SRC_0027),
    "must drop existing policy");
  assert(/create policy atlas_audit_select on public\.atlas_audit_logs/i.test(SRC_0027),
    "must recreate policy");
  const policy = SRC_0027.split(/create policy atlas_audit_select/)[1] ?? "";
  assert(/atlas_role\(\)\s*in\s*\(\s*'manager'/.test(policy),
    "manager/admin/readonly/auditor branch missing");
  assert(/atlas_is_staff\(\)[\s\S]*?atlas_can_access_submission/.test(policy),
    "staff submission-scoped branch missing");
  assert(/atlas_is_staff\(\)\s+and\s+actor\s*=\s*auth\.uid\(\)/.test(policy),
    "staff own-actor branch missing");
});

test("0027 contains NO broker SELECT branch", () => {
  const policy = SRC_0027.split(/create policy atlas_audit_select/)[1] ?? "";
  // The policy body must not mention atlas_is_broker() at all — the
  // presence of that helper would re-open a broker Data API SELECT branch.
  assert(!/atlas_is_broker/i.test(policy),
    "atlas_audit_select must have zero broker branches");
});

test("0027 adds no INSERT/UPDATE/DELETE policy on atlas_audit_logs", () => {
  const clauses = SRC_0027.match(/on public\.atlas_audit_logs[\s\S]*?;/gi) ?? [];
  for (const c of clauses) {
    assert(!/for\s+insert/i.test(c), "no INSERT policy");
    assert(!/for\s+update/i.test(c), "no UPDATE policy");
    assert(!/for\s+delete/i.test(c), "no DELETE policy");
  }
});

test("0027 does not DROP the 0026 allow-list helper (legacy artefact retained)", () => {
  assert(!/drop\s+function[\s\S]*?atlas_broker_audit_action_allowed/i.test(SRC_0027),
    "helper must be left in place");
});

// ---------------------------------------------------------------------------
// Worker invariants — unchanged by 0027, restated as security assertions
// ---------------------------------------------------------------------------

test("Worker BROKER_SAFE_AUDIT_ACTIONS remains the explicit positive allow-list", () => {
  const expected = new Set([
    "submission_created",
    "document_uploaded",
    "submission_queue_status_changed",
    "missing_info_added",
    "missing_info_updated",
  ]);
  assert(BROKER_SAFE_AUDIT_ACTIONS.size === expected.size, "unexpected size after 0027");
  for (const a of expected) assert(BROKER_SAFE_AUDIT_ACTIONS.has(a), `missing ${a}`);
});

test("Worker: unknown future audit actions fail closed for broker", () => {
  const unknowns = [
    "some_new_underwriting_v3",
    "risk_reprice",
    "escalation_review",
    "shadow_pipeline_stage_ran",
    "operational_alert_fired",
  ];
  for (const u of unknowns) {
    assert(!isBrokerSafeAuditAction(u), `unknown action ${u} must NOT be broker-safe`);
  }
  const events = projectAuditForBroker(
    unknowns.map((action, i) => ({
      id: `u-${i}`,
      action,
      actor: STAFF_ID,
      metadata_json: { top_insurer: "leaked" },
      created_at: "2026-08-28T09:00:00Z",
    })),
    BROKER_ID,
    "broker@example.test"
  );
  assert(events.length === 0, "unknown actions must not appear in broker projection");
});

// ---------------------------------------------------------------------------
// audit-endpoints.ts structural check — Worker uses the projection module
// ---------------------------------------------------------------------------

const AUDIT_ENDPOINT = readFileSync(
  resolve(process.cwd(), "worker/src/audit-endpoints.ts"),
  "utf8"
);

test("audit-endpoints delegates broker projection to audit-projection.projectAuditForBroker", () => {
  assert(/from "\.\/audit-projection"/.test(AUDIT_ENDPOINT),
    "must import from ./audit-projection");
  assert(/user\.role === "broker"[\s\S]*?projectAuditForBroker\(/.test(AUDIT_ENDPOINT),
    "broker branch must call projectAuditForBroker");
});

test("audit-endpoints preserves staff projection call", () => {
  assert(/projectAuditForStaff\(/.test(AUDIT_ENDPOINT),
    "staff branch must call projectAuditForStaff");
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
  console.log(`\nPhase 17 broker audit: ${passed} passed, ${failed} failed out of ${tests.length}`);
  if (failed > 0 && typeof process !== "undefined") process.exitCode = 1;
})();
