/**
 * Phase 19 (Phase 5A) — concurrency & idempotency
 * ---------------------------------------------------------------------------
 * Structural tests that assert the shape of the concurrency guard, the
 * cursor-advancement contract, and the RLS boundary. We do not spin up a
 * real Postgres — instead we assert the SQL migration text encodes the
 * guarantees the spec requires and the orchestrator code contains the
 * cursor-safety invariants.
 *
 * The behavioural correctness of `correlate()` (idempotency by rule 1/2) is
 * covered in phase19-graph-intake-correlation.test.ts.
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

const MIGRATION = readFileSync(
  resolve("supabase/migrations/0028_graph_intake_and_correlation.sql"),
  "utf8",
);
const INTAKE_SRC = readFileSync(
  resolve("worker/src/graph-intake.ts"),
  "utf8",
);
const ENDPOINTS_SRC = readFileSync(
  resolve("worker/src/graph-intake-endpoints.ts"),
  "utf8",
);
const INDEX_SRC = readFileSync(
  resolve("worker/src/index.ts"),
  "utf8",
);
const CONFIG_SRC = readFileSync(
  resolve("worker/src/config.ts"),
  "utf8",
);

// ---------------------------------------------------------------------------
// Migration invariants
// ---------------------------------------------------------------------------

test("intake table has UNIQUE (mailbox, graph_message_id) partial index", () => {
  assert(
    /create unique index[^\n]*atlas_intake_messages_mailbox_graph_uidx[\s\S]*?\(mailbox, graph_message_id\)[\s\S]*?where mailbox is not null and graph_message_id is not null/.test(
      MIGRATION,
    ),
    "unique index over (mailbox, graph_message_id) is required for idempotent replays",
  );
});

test("intake table has UNIQUE partial index on internet_message_id", () => {
  assert(
    /create unique index[^\n]*atlas_intake_messages_internet_id_uidx[\s\S]*?\(internet_message_id\)[\s\S]*?where internet_message_id is not null/.test(
      MIGRATION,
    ),
    "unique index over internet_message_id catches cross-mailbox duplicate delivery",
  );
});

test("intake RLS: SELECT is scoped by atlas_can_access_submission", () => {
  assert(
    /atlas_intake_messages_scoped_select[\s\S]*?using \(public\.atlas_can_access_submission\(submission_id\)\)/.test(
      MIGRATION,
    ),
    "intake SELECT policy must derive from atlas_can_access_submission",
  );
});

test("intake RLS: no authenticated INSERT/UPDATE/DELETE policy exists", () => {
  assert(
    !/atlas_submission_intake_messages[\s\S]*?for insert to authenticated/.test(MIGRATION),
    "no authenticated INSERT policy",
  );
  assert(
    !/atlas_submission_intake_messages[\s\S]*?for update to authenticated/.test(MIGRATION),
    "no authenticated UPDATE policy",
  );
  assert(
    !/atlas_submission_intake_messages[\s\S]*?for delete to authenticated/.test(MIGRATION),
    "no authenticated DELETE policy",
  );
});

test("intake table RLS is enabled from creation", () => {
  assert(
    /alter table public\.atlas_submission_intake_messages enable row level security/.test(MIGRATION),
    "RLS must be enabled",
  );
});

test("graph_state table: RLS is enabled and there are NO policies", () => {
  assert(
    /alter table public\.atlas_intake_graph_state enable row level security/.test(MIGRATION),
    "RLS enabled",
  );
  // Restrict the search to text FOLLOWING the graph_state RLS enable — that
  // is the region a policy would be declared in. A comment reference at the
  // top of the file is data, not a policy.
  const enableMatch = MIGRATION.match(
    /alter table public\.atlas_intake_graph_state enable row level security;([\s\S]*)$/,
  );
  const tail = enableMatch?.[1] ?? "";
  assert(
    !/create policy[^;]*atlas_intake_graph_state/i.test(tail),
    "graph_state must have no authenticated policies — service-role only",
  );
});

test("intake source column check restricts to email", () => {
  assert(
    /atlas_intake_messages_source_check[\s\S]*?check \(source in \('email'\)\)/.test(MIGRATION),
    "source check exists",
  );
});

test("intake processing_state check restricts to processed | needs_review", () => {
  assert(
    /atlas_intake_messages_processing_state_check[\s\S]*?check \(processing_state in \('processed', 'needs_review'\)\)/.test(
      MIGRATION,
    ),
    "processing_state check exists",
  );
});

// ---------------------------------------------------------------------------
// Concurrency guard (CAS lease)
// ---------------------------------------------------------------------------

test("mailbox lease uses fenced RPC keyed on lease_id + poll_in_flight_since", () => {
  // After Checkpoint 2 the lease acquire/release runs as SQL functions that
  // include lease_id fencing. The Worker calls them via admin.rpc(). The
  // migration text encodes the CAS predicate; here we assert the Worker uses
  // the fenced RPC surface rather than an inline update.
  assert(
    /admin\.rpc\("atlas_intake_acquire_lease"/.test(INTAKE_SRC),
    "acquire uses fenced RPC",
  );
  assert(
    /admin\.rpc\("atlas_intake_release_lease"/.test(INTAKE_SRC),
    "release uses fenced RPC",
  );
});

test("mailbox lease has bounded stale duration", () => {
  assert(/POLL_LEASE_STALE_MS\s*=\s*5\s*\*\s*60_000/.test(INTAKE_SRC), "lease is bounded");
});

// ---------------------------------------------------------------------------
// Cursor advancement contract
// ---------------------------------------------------------------------------

test("delta cursor is not advanced when processing failed", () => {
  // Checkpoint 3: the fenced success RPC atomically advances delta_link AND
  // writes graph_poll_success. It only fires under `if (finalDeltaLink)`.
  assert(
    /if \(finalDeltaLink\) \{[\s\S]*?releaseLeaseSuccess\([^,]+, mailbox, leaseId, \{[\s\S]*?deltaLink: finalDeltaLink/.test(
      INTAKE_SRC,
    ),
    "durable deltaLink advance is gated on finalDeltaLink !== null AND uses the atomic RPC",
  );
});

test("failure path releases lease without advancing delta cursor", () => {
  assert(
    /recordFailure\(admin, mailbox, mailboxHash, leaseId, lease, err, nowFn\(\)\)/.test(INTAKE_SRC),
    "failure path calls recordFailure",
  );
  // recordFailure() calls releaseLease with NO delta_link_provided flag —
  // the state model preserves the existing cursor.
  assert(
    /async function recordFailure[\s\S]*?releaseLease\(admin, mailbox, leaseId, \{\s*lastError:/.test(INTAKE_SRC),
    "recordFailure releases lease WITHOUT passing deltaLink",
  );
});

// ---------------------------------------------------------------------------
// Idempotency at insert
// ---------------------------------------------------------------------------

test("atomic ingest RPC classifies duplicates by outcome, not by DB error code", () => {
  // The 23505 branch has moved into the SQL function; the Worker now
  // distinguishes "created" / "duplicate_*" outcomes from any DB error, and
  // a DB error is an IntakeDbError (poll fails, cursor unchanged).
  assert(/outcome !== "attached"/.test(INTAKE_SRC), "attach: outcome-driven duplicate check");
  assert(/outcome !== "created"/.test(INTAKE_SRC), "ingest: outcome-driven duplicate check");
  assert(/IntakeDbError/.test(INTAKE_SRC), "DB errors are a distinct class");
});

// ---------------------------------------------------------------------------
// Feature flag fails closed
// ---------------------------------------------------------------------------

test("graphIntakeEnabled defaults to false", () => {
  assert(
    /export function graphIntakeEnabled\(env: Env\): boolean \{[\s\S]*?return env\.ATLAS_GRAPH_INTAKE_ENABLED === "true";[\s\S]*?\}/.test(
      CONFIG_SRC,
    ),
    "explicit 'true' required",
  );
});

test("graphIntakeMailboxes fails closed on malformed JSON", () => {
  assert(/catch \{\s*return \[\];\s*\}/.test(CONFIG_SRC), "malformed JSON => empty");
});

test("runGraphIntakeCycle is a no-op when the flag is off", () => {
  assert(
    /if \(!graphIntakeEnabled\(env\)\) return \[\];/.test(INTAKE_SRC),
    "disabled => empty result, no Graph call",
  );
});

// ---------------------------------------------------------------------------
// Admin poll endpoint — narrow scope
// ---------------------------------------------------------------------------

test("handleGraphPollNow rejects non-admin", () => {
  assert(
    /if \(user\.role !== "admin"\)[\s\S]*?jsonError\("permission_denied"/.test(ENDPOINTS_SRC),
    "admin only",
  );
});

test("handleGraphPollNow rejects production", () => {
  assert(
    /if \(env\.ATLAS_ENV === "production"\)[\s\S]*?jsonError\("permission_denied"/.test(ENDPOINTS_SRC),
    "production disabled",
  );
});

test("router wires admin poll route + intake-messages route", () => {
  assert(
    /"\/api\/intake\/graph\/poll-now"[\s\S]*?handleGraphPollNow\(env, user\)/.test(INDEX_SRC),
    "poll-now route",
  );
  assert(
    /sub === "\/intake-messages"[\s\S]*?handleListSubmissionIntakeMessages\(id, env, user\)/.test(INDEX_SRC),
    "intake-messages route",
  );
});

// ---------------------------------------------------------------------------
// PII safety in audit metadata
// ---------------------------------------------------------------------------

test("intake audits never emit sender/subject/body_preview as raw text", () => {
  // Checkpoint 3: the audit rows are written by the SQL RPCs from only the
  // dedicated audit-metadata parameters (p_correlation_rule / p_mailbox_hash
  // / p_graph_message_id_hash / p_candidate_ids). The SQL migration is the
  // authoritative surface — assert its audit INSERTs never reference the
  // sender/subject/body_preview columns.
  const MIGRATION_0030 = readFileSync(
    resolve("supabase/migrations/0030_graph_intake_privilege_and_atomic_audits.sql"),
    "utf8",
  );
  const auditInserts = MIGRATION_0030.match(/insert into public\.atlas_audit_logs[\s\S]*?\);/g) ?? [];
  assert(auditInserts.length >= 3, "at least three audit inserts in migration 0030");
  for (const stmt of auditInserts) {
    assert(!/p_subject/.test(stmt), "audit metadata must not include subject");
    assert(!/p_body_preview/.test(stmt), "audit metadata must not include body_preview");
    assert(!/p_sender_address/.test(stmt), "audit metadata must not include sender_address");
    assert(!/p_sender_name/.test(stmt), "audit metadata must not include sender_name");
    assert(!/p_recipients/.test(stmt), "audit metadata must not include recipients");
  }
});

test("intake audits do NOT contain the raw delta link or tokens", () => {
  // Success metadata builder in the Worker never carries the deltaLink token
  // or access token.
  const buildFn = INTAKE_SRC.match(/const buildSuccessMetadata[\s\S]*?\}\);/);
  assert(buildFn, "buildSuccessMetadata present");
  const body = buildFn?.[0] ?? "";
  assert(!/delta_link:/.test(body), "no delta_link in success audit metadata");
  assert(!/deltaLink/.test(body), "no deltaLink in success audit metadata");
  assert(!/access_token/.test(body), "no access_token in success audit metadata");
});

test("mailbox identity is hashed in audit metadata", () => {
  assert(/mailbox_hash:/.test(INTAKE_SRC), "mailbox_hash present");
  assert(/safeHash\(mailbox\)/.test(INTAKE_SRC), "safeHash used for mailbox");
});

test("graph_message_id is hashed in audit metadata", () => {
  assert(/graph_message_id_hash:/.test(INTAKE_SRC), "graph_message_id_hash present");
});

// ---------------------------------------------------------------------------
// New-submission ownership
// ---------------------------------------------------------------------------

test("email-created submissions use the reserved system-actor UUID", () => {
  assert(
    /ATLAS_INTAKE_SYSTEM_ACTOR_ID\s*=\s*"00000000-0000-0000-0000-00005a1a5a1a"/.test(INTAKE_SRC),
    "system actor UUID is stable",
  );
  // Now passed via RPC arg `p_system_actor_id`.
  assert(
    /p_system_actor_id:\s*ATLAS_INTAKE_SYSTEM_ACTOR_ID/.test(INTAKE_SRC),
    "atomic ingest passes the system actor as created_by via RPC",
  );
});

test("email submission creation sets source_type + pipeline_stage + queue_status server-side", () => {
  assert(/p_source_type:\s*"email"/.test(INTAKE_SRC), "source_type email");
  assert(/p_pipeline_stage:\s*"new"/.test(INTAKE_SRC), "pipeline_stage new");
  assert(/p_queue_status:\s*"new"/.test(INTAKE_SRC), "queue_status new");
});

// ---------------------------------------------------------------------------
// Scheduled wiring
// ---------------------------------------------------------------------------

test("scheduled handler invokes runGraphIntakeCycleForEnv via waitUntil", () => {
  assert(
    /ctx\.waitUntil\(runGraphIntakeCycleForEnv\(env\)/.test(INDEX_SRC),
    "scheduled invokes intake cycle",
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
  console.log(`\nPhase 19 concurrency/security: ${passed} passed, ${failed} failed out of ${tests.length}`);
  if (failed > 0 && typeof process !== "undefined") process.exitCode = 1;
})();
