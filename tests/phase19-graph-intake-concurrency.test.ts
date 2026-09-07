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

test("mailbox lease uses conditional UPDATE keyed on poll_in_flight_since", () => {
  assert(
    /acquireMailboxLease[\s\S]*?\.update\(\{ poll_in_flight_since:[\s\S]*?\.or\(`poll_in_flight_since\.is\.null,poll_in_flight_since\.lt\.\$\{staleCutoffIso\}`\)/.test(
      INTAKE_SRC,
    ),
    "lease acquired via CAS on poll_in_flight_since",
  );
});

test("mailbox lease has bounded stale duration", () => {
  assert(/POLL_LEASE_STALE_MS\s*=\s*5\s*\*\s*60_000/.test(INTAKE_SRC), "lease is bounded");
});

// ---------------------------------------------------------------------------
// Cursor advancement contract
// ---------------------------------------------------------------------------

test("delta cursor is not advanced when processing failed", () => {
  assert(
    /processingHadFailure[\s\S]*?throw new Error\("intake_processing_failed"\)/.test(INTAKE_SRC),
    "processing failure prevents releaseMailboxLease from being called with deltaLink",
  );
  // The release with deltaLink is unreachable after the throw:
  assert(
    /if \(processingHadFailure\) \{\s*throw new Error\("intake_processing_failed"\);\s*\}\s*await releaseMailboxLease\(admin, mailbox, \{\s*deltaLink:/.test(
      INTAKE_SRC,
    ),
    "successful release only after processingHadFailure guard",
  );
});

test("failure path releases lease without advancing delta cursor", () => {
  assert(
    /recordFailure\(admin, mailbox, lease\.consecutive_failures, err, env\)/.test(INTAKE_SRC),
    "failure path calls recordFailure",
  );
  assert(
    /releaseMailboxLease\(admin, mailbox, \{\s*lastError: code,/.test(INTAKE_SRC),
    "recordFailure releases lease WITHOUT passing deltaLink",
  );
});

// ---------------------------------------------------------------------------
// Idempotency at insert
// ---------------------------------------------------------------------------

test("persistIntakeRow swallows unique-violation (23505) as duplicate", () => {
  assert(
    /if \(code === "23505"\) return null/.test(INTAKE_SRC),
    "unique violation must be treated as duplicate no-op",
  );
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
    /if \(user\.role !== "admin"\)[\s\S]*?jsonError\("permission_denied"/.test(INTAKE_SRC),
    "admin only",
  );
});

test("handleGraphPollNow rejects production", () => {
  assert(
    /if \(env\.ATLAS_ENV === "production"\)[\s\S]*?jsonError\("permission_denied"/.test(INTAKE_SRC),
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
  const auditCalls = INTAKE_SRC.match(/await audit\(env,[\s\S]*?\}\);/g) ?? [];
  for (const call of auditCalls) {
    assert(!/subject:/.test(call), "audit metadata must not include subject");
    assert(!/body_preview:/.test(call), "audit metadata must not include body_preview");
    assert(!/sender_address:/.test(call), "audit metadata must not include sender_address");
  }
  // At least one poll-success audit exists.
  assert(auditCalls.length >= 3, "at least three audit events must fire");
});

test("intake audits do NOT contain the raw delta link or tokens", () => {
  const auditCalls = INTAKE_SRC.match(/await audit\(env,[\s\S]*?\}\);/g) ?? [];
  for (const call of auditCalls) {
    assert(!/delta_link:/.test(call), "no delta_link");
    assert(!/deltaLink/.test(call), "no deltaLink token");
    assert(!/access_token/.test(call), "no access_token");
  }
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
  assert(
    /created_by: ATLAS_INTAKE_SYSTEM_ACTOR_ID/.test(INTAKE_SRC),
    "new submissions attribute created_by to the system actor",
  );
});

test("email submission creation sets source_type + pipeline_stage + queue_status server-side", () => {
  assert(/source_type: "email"/.test(INTAKE_SRC), "source_type email");
  assert(/pipeline_stage: "new"/.test(INTAKE_SRC), "pipeline_stage new");
  assert(/queue_status: "new"/.test(INTAKE_SRC), "queue_status new");
});

// ---------------------------------------------------------------------------
// Scheduled wiring
// ---------------------------------------------------------------------------

test("scheduled handler invokes runGraphIntakeCycle via waitUntil", () => {
  assert(
    /ctx\.waitUntil\(runGraphIntakeCycle\(env\)/.test(INDEX_SRC),
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
