#!/usr/bin/env node
/**
 * Atlas — Phase 5A REAL-POSTGRES REGRESSION GATE
 * ----------------------------------------------------------------------------
 * Actually invokes every Phase 5A RPC against a non-production Supabase, so
 * PL/pgSQL name-resolution defects (the Checkpoint 4 class of bug — SQLSTATE
 * 42702) can never re-enter the codebase unnoticed.
 *
 * Not part of the default unit suite: this needs live credentials the CI
 * runner may not have. Run it manually or wire it behind a CI env-gate.
 *
 * Required env:
 *   ATLAS_PHASE5A_TEST_SUPABASE_URL       (e.g. https://<ref>.supabase.co)
 *   ATLAS_PHASE5A_TEST_SERVICE_ROLE_KEY
 *
 * Safety:
 *   * Hard allowlist of non-production project refs.
 *   * Hard forbidden ref: algenlnxagpxzsgaworz. A match refuses to run.
 *   * Service-role key value is never printed.
 *   * All fixtures are namespaced with a unique GATE-P5A-<ts> prefix and
 *     cleaned up on success (except audit rows, which are compliance-durable
 *     and reported by count only).
 */

const NON_PROD_ALLOWLIST = new Set([
  "mnehddylkeelojsnkdtx", // Atlas staging
]);
const FORBIDDEN_REF = "algenlnxagpxzsgaworz";

const URL_ = process.env.ATLAS_PHASE5A_TEST_SUPABASE_URL || "";
const KEY  = process.env.ATLAS_PHASE5A_TEST_SERVICE_ROLE_KEY || "";

const refMatch = URL_.match(/^https:\/\/([a-z0-9]+)\.supabase\.co/i);
const projectRef = refMatch ? refMatch[1].toLowerCase() : "";
if (!URL_ || !KEY) {
  console.error("phase5a-postgres: ATLAS_PHASE5A_TEST_SUPABASE_URL and ATLAS_PHASE5A_TEST_SERVICE_ROLE_KEY are required");
  process.exit(2);
}
if (!projectRef) {
  console.error("phase5a-postgres: could not parse Supabase project ref");
  process.exit(3);
}
if (projectRef === FORBIDDEN_REF) {
  console.error("phase5a-postgres: FORBIDDEN — this is the production project ref. Refusing.");
  process.exit(4);
}
if (!NON_PROD_ALLOWLIST.has(projectRef)) {
  console.error(`phase5a-postgres: project ref '${projectRef}' is not on the non-production allowlist`);
  process.exit(5);
}

const HEADERS = {
  apikey: KEY,
  Authorization: `Bearer ${KEY}`,
  "Content-Type": "application/json",
  Accept: "application/json",
};

async function rpc(name, args) {
  const res = await fetch(`${URL_}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify(args),
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
}

async function rest(path, opts = {}) {
  const res = await fetch(`${URL_}/rest/v1/${path}`, {
    ...opts,
    headers: { ...HEADERS, ...(opts.headers || {}) },
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
}

// ---------------------------------------------------------------------------
// Test runner (embedded — this script is self-contained)
// ---------------------------------------------------------------------------

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function eq(a, b, msg) { if (a !== b) throw new Error(`${msg}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }

const PREFIX = `GATE-P5A-${Date.now()}`;
const SYSTEM_ACTOR = "00000000-0000-0000-0000-00005a1a5a1a";
function u() { return crypto.randomUUID(); }

// Track fixtures for cleanup.
const state = {
  submissionIds: new Set(),
  intakeIds: new Set(),
  mailboxes: new Set(),
  alertIds: new Set(),
};

async function cleanup() {
  for (const mailbox of state.mailboxes) {
    await rest(`atlas_intake_graph_state?mailbox=eq.${encodeURIComponent(mailbox)}`, { method: "DELETE" });
  }
  for (const id of state.submissionIds) {
    // Cascade deletes atlas_submission_intake_messages via FK.
    await rest(`atlas_submissions?id=eq.${id}`, { method: "DELETE" });
  }
  for (const id of state.alertIds) {
    await rest(`atlas_operational_alerts?id=eq.${id}`, { method: "DELETE" });
  }
}

// ---------------------------------------------------------------------------
// 1. acquire/release lease — proves 42702 fix on the ON CONFLICT target.
// ---------------------------------------------------------------------------

test("acquire_lease executes cleanly (no 42702) and returns the new lease row", async () => {
  const mailbox = `${PREFIX}-lease-A@example.invalid`;
  state.mailboxes.add(mailbox);
  const leaseId = u();
  const now = new Date();
  const stale = new Date(now.getTime() - 60_000);
  const r = await rpc("atlas_intake_acquire_lease", {
    p_mailbox: mailbox,
    p_stale_cutoff_iso: stale.toISOString(),
    p_new_lease_id: leaseId,
    p_now: now.toISOString(),
  });
  eq(r.status, 200, "http 200");
  assert(Array.isArray(r.body) && r.body.length === 1, "one row returned");
  const row = r.body[0];
  eq(row.mailbox, mailbox, "mailbox echoed");
  eq(row.lease_id, leaseId, "lease_id matches");
  assert(row.poll_in_flight_since, "poll_in_flight_since populated");
});

test("release_lease with the owning lease clears state; wrong lease is a no-op", async () => {
  const mailbox = `${PREFIX}-lease-B@example.invalid`;
  state.mailboxes.add(mailbox);
  const leaseId = u();
  const now = new Date();
  await rpc("atlas_intake_acquire_lease", {
    p_mailbox: mailbox,
    p_stale_cutoff_iso: new Date(now.getTime() - 60_000).toISOString(),
    p_new_lease_id: leaseId,
    p_now: now.toISOString(),
  });
  // Wrong lease id → 0 rows.
  const bad = await rpc("atlas_intake_release_lease", {
    p_mailbox: mailbox,
    p_expected_lease_id: u(),
    p_delta_link: null, p_delta_link_provided: false,
    p_in_round_next_link: null, p_in_round_provided: false,
    p_last_error: null, p_consecutive_failures: 0,
    p_last_success_at: null, p_last_failure_at: null,
    p_breaker_opened_at: null, p_breaker_provided: false,
    p_next_attempt_after: null, p_next_attempt_provided: false,
  });
  eq(bad.status, 200, "bad release http 200");
  eq(Array.isArray(bad.body) ? bad.body.length : 0, 0, "wrong lease → 0 rows");
  // Correct lease id → 1 row.
  const good = await rpc("atlas_intake_release_lease", {
    p_mailbox: mailbox,
    p_expected_lease_id: leaseId,
    p_delta_link: null, p_delta_link_provided: false,
    p_in_round_next_link: null, p_in_round_provided: false,
    p_last_error: null, p_consecutive_failures: 0,
    p_last_success_at: new Date().toISOString(), p_last_failure_at: null,
    p_breaker_opened_at: null, p_breaker_provided: false,
    p_next_attempt_after: null, p_next_attempt_provided: false,
  });
  eq(good.status, 200, "good release http 200");
  eq(Array.isArray(good.body) ? good.body.length : 0, 1, "good release → 1 row");
});

// ---------------------------------------------------------------------------
// 2. Real lease fencing across simulated stale-cutoff.
// ---------------------------------------------------------------------------

test("A holds → B before stale gets 0 rows → B after stale acquires → A fenced release fails", async () => {
  const mailbox = `${PREFIX}-fence@example.invalid`;
  state.mailboxes.add(mailbox);
  const leaseA = u();
  const t0 = Date.now();
  const acqA = await rpc("atlas_intake_acquire_lease", {
    p_mailbox: mailbox,
    p_stale_cutoff_iso: new Date(t0 - 60_000).toISOString(),
    p_new_lease_id: leaseA,
    p_now: new Date(t0).toISOString(),
  });
  eq(Array.isArray(acqA.body) ? acqA.body.length : 0, 1, "A acquires");

  // B tries while A's lease is still fresh (stale cutoff = now - 10s).
  const acqBFresh = await rpc("atlas_intake_acquire_lease", {
    p_mailbox: mailbox,
    p_stale_cutoff_iso: new Date(t0 - 10_000).toISOString(),
    p_new_lease_id: u(),
    p_now: new Date(t0 + 5_000).toISOString(),
  });
  eq(Array.isArray(acqBFresh.body) ? acqBFresh.body.length : 0, 0, "B before stale → 0 rows");

  // B tries after simulated stale cutoff has passed A's acquisition time.
  const leaseB = u();
  const acqBStale = await rpc("atlas_intake_acquire_lease", {
    p_mailbox: mailbox,
    p_stale_cutoff_iso: new Date(t0 + 1000).toISOString(), // > A's acquire time
    p_new_lease_id: leaseB,
    p_now: new Date(t0 + 60_000).toISOString(),
  });
  eq(Array.isArray(acqBStale.body) ? acqBStale.body.length : 0, 1, "B after stale acquires");

  // A now tries to release (using its old, stale lease id).
  const staleReleaseA = await rpc("atlas_intake_release_lease", {
    p_mailbox: mailbox,
    p_expected_lease_id: leaseA,
    p_delta_link: "https://graph.microsoft.com/A-STALE",
    p_delta_link_provided: true,
    p_in_round_next_link: null, p_in_round_provided: false,
    p_last_error: null, p_consecutive_failures: 0,
    p_last_success_at: null, p_last_failure_at: null,
    p_breaker_opened_at: null, p_breaker_provided: false,
    p_next_attempt_after: null, p_next_attempt_provided: false,
  });
  eq(Array.isArray(staleReleaseA.body) ? staleReleaseA.body.length : 0, 0, "A fenced release → 0 rows");

  // A tries fenced success release too — must return lease_lost.
  const staleSuccessA = await rpc("atlas_intake_release_lease_success", {
    p_mailbox: mailbox,
    p_expected_lease_id: leaseA,
    p_delta_link: "https://graph.microsoft.com/A-STALE",
    p_delta_link_provided: true,
    p_in_round_next_link: null, p_in_round_provided: false,
    p_last_success_at: new Date().toISOString(),
    p_audit_metadata: {},
  });
  eq(staleSuccessA.status, 200, "success rpc http 200");
  assert(Array.isArray(staleSuccessA.body) && staleSuccessA.body.length === 1, "one row");
  eq(staleSuccessA.body[0].ok, false, "ok=false");
  eq(staleSuccessA.body[0].reason, "lease_lost", "reason=lease_lost");

  // Verify A did not clobber B's state.
  const stateRow = (await rest(`atlas_intake_graph_state?mailbox=eq.${encodeURIComponent(mailbox)}&select=lease_id,delta_link`)).body[0];
  eq(stateRow.lease_id, leaseB, "state still owned by B");
  assert(stateRow.delta_link !== "https://graph.microsoft.com/A-STALE", "A could not overwrite delta_link");

  // B releases cleanly.
  const rB = await rpc("atlas_intake_release_lease", {
    p_mailbox: mailbox,
    p_expected_lease_id: leaseB,
    p_delta_link: null, p_delta_link_provided: false,
    p_in_round_next_link: null, p_in_round_provided: false,
    p_last_error: null, p_consecutive_failures: 0,
    p_last_success_at: new Date().toISOString(), p_last_failure_at: null,
    p_breaker_opened_at: null, p_breaker_provided: false,
    p_next_attempt_after: null, p_next_attempt_provided: false,
  });
  eq(Array.isArray(rB.body) ? rB.body.length : 0, 1, "B valid release ok");
});

// ---------------------------------------------------------------------------
// 3. Real new-email ingest — proves 42702 fix + audit atomicity.
// ---------------------------------------------------------------------------

test("ingest_new_email executes cleanly and writes 1 sub + 1 intake + 2 audits atomically", async () => {
  const mailbox = `${PREFIX}-new@example.invalid`;
  const graphId = `${PREFIX}-graph-new`;
  const internetId = `${PREFIX}-imid-new`;
  const r = await rpc("atlas_intake_ingest_new_email", {
    p_system_actor_id: SYSTEM_ACTOR,
    p_source_type: "email",
    p_pipeline_stage: "new",
    p_queue_status: "new",
    p_status: "new",
    p_priority: "normal",
    p_next_action: "Review intake",
    p_received_at: new Date().toISOString(),
    p_mailbox: mailbox,
    p_graph_message_id: graphId,
    p_internet_message_id: internetId,
    p_conversation_id: `${PREFIX}-conv-new`,
    p_sender_name: `P5A-CANARY-SENDER-${PREFIX}`,
    p_sender_address: `p5a-canary-sender-${PREFIX}@example.invalid`,
    p_recipients: [],
    p_subject: `P5A-CANARY-SUBJECT-${PREFIX}`,
    p_body_preview: `P5A-CANARY-BODY-${PREFIX}`,
    p_has_attachments: false,
    p_processing_state: "processed",
    p_correlation_rule: "new_submission",
    p_mailbox_hash: "hash-new",
    p_graph_message_id_hash: "hash-graph-new",
  });
  eq(r.status, 200, "http 200 — 42702 no longer fires");
  assert(Array.isArray(r.body) && r.body.length === 1, "one row");
  eq(r.body[0].outcome, "created", "outcome=created");
  const subId = r.body[0].submission_id;
  const intakeId = r.body[0].intake_message_id;
  state.submissionIds.add(subId);
  state.intakeIds.add(intakeId);
  const sub = (await rest(`atlas_submissions?id=eq.${subId}&select=created_by,source_type,pipeline_stage,queue_status,status`)).body[0];
  eq(sub.created_by, SYSTEM_ACTOR, "created_by is system actor");
  eq(sub.source_type, "email", "source_type=email");
  eq(sub.pipeline_stage, "new", "pipeline_stage=new");
  const intake = (await rest(`atlas_submission_intake_messages?id=eq.${intakeId}&select=submission_id,mailbox,graph_message_id,processing_state`)).body[0];
  eq(intake.submission_id, subId, "intake linked to submission");
  eq(intake.processing_state, "processed", "processing_state=processed");
  const audits = (await rest(`atlas_audit_logs?submission_id=eq.${subId}&select=action,actor&order=created_at`)).body;
  const actions = audits.map((a) => a.action).sort();
  assert(actions.includes("submission_created_from_email"), "submission_created_from_email present");
  assert(actions.includes("intake_message_recorded"), "intake_message_recorded present");
  for (const a of audits) eq(a.actor, null, `${a.action} actor=null`);
});

// ---------------------------------------------------------------------------
// 4. attach_message — reaches full body cleanly.
// ---------------------------------------------------------------------------

test("attach_message on an existing submission adds 1 intake + 1 correlated audit", async () => {
  // Get one of the submissions created above.
  const parentId = [...state.submissionIds][0];
  assert(parentId, "have parent submission");
  const r = await rpc("atlas_intake_attach_message", {
    p_submission_id: parentId,
    p_mailbox: `${PREFIX}-attach@example.invalid`,
    p_graph_message_id: `${PREFIX}-graph-attach`,
    p_internet_message_id: `${PREFIX}-imid-attach`,
    p_conversation_id: `${PREFIX}-conv-attach`,
    p_sender_name: null,
    p_sender_address: null,
    p_recipients: [],
    p_subject: null,
    p_body_preview: null,
    p_received_at: null,
    p_has_attachments: false,
    p_processing_state: "processed",
    p_correlation_rule: "conversation_single_open",
    p_mailbox_hash: "hash-attach",
    p_graph_message_id_hash: "hash-graph-attach",
  });
  eq(r.status, 200, "http 200");
  assert(Array.isArray(r.body) && r.body.length === 1, "one row");
  eq(r.body[0].outcome, "attached", "outcome=attached");
  const intakeId = r.body[0].intake_message_id;
  state.intakeIds.add(intakeId);
  const audits = (await rest(`atlas_audit_logs?submission_id=eq.${parentId}&action=eq.intake_message_correlated&select=action,actor,metadata_json`)).body;
  assert(audits.length >= 1, "correlated audit exists");
  eq(audits[audits.length - 1].actor, null, "actor=null");
});

// ---------------------------------------------------------------------------
// 5. ingest_needs_review — proves 42702 fix + audit+alert atomicity.
// ---------------------------------------------------------------------------

test("ingest_needs_review executes cleanly and writes container+intake+audit+alert atomically", async () => {
  const mailbox = `${PREFIX}-nr@example.invalid`;
  const r = await rpc("atlas_intake_ingest_needs_review", {
    p_system_actor_id: SYSTEM_ACTOR,
    p_source_type: "email",
    p_pipeline_stage: "new",
    p_queue_status: "new",
    p_status: "new",
    p_priority: "normal",
    p_next_action: "Review intake",
    p_received_at: new Date().toISOString(),
    p_mailbox: mailbox,
    p_graph_message_id: `${PREFIX}-graph-nr`,
    p_internet_message_id: `${PREFIX}-imid-nr`,
    p_conversation_id: null,
    p_sender_name: null,
    p_sender_address: null,
    p_recipients: [],
    p_subject: null,
    p_body_preview: null,
    p_has_attachments: false,
    p_correlation_rule: "conversation_multiple_open_needs_review",
    p_mailbox_hash: "hash-nr",
    p_graph_message_id_hash: "hash-graph-nr",
    p_candidate_ids: [u(), u()],
    p_alert_title: "Ambiguous intake correlation",
    p_alert_message: "test",
  });
  eq(r.status, 200, "http 200 — 42702 no longer fires");
  assert(Array.isArray(r.body) && r.body.length === 1, "one row");
  eq(r.body[0].outcome, "created", "outcome=created");
  const subId = r.body[0].submission_id;
  state.submissionIds.add(subId);
  state.intakeIds.add(r.body[0].intake_message_id);
  const alerts = (await rest(`atlas_operational_alerts?related_submission_id=eq.${subId}&select=id,alert_type,severity,status,metadata`)).body;
  assert(alerts.length >= 1, "alert persisted");
  for (const a of alerts) state.alertIds.add(a.id);
  eq(alerts[0].alert_type, "intake_correlation_needs_review", "alert_type");
  const audits = (await rest(`atlas_audit_logs?submission_id=eq.${subId}&action=eq.intake_correlation_needs_review&select=action,actor`)).body;
  assert(audits.length >= 1, "needs_review audit persisted");
  eq(audits[0].actor, null, "actor=null");
});

// ---------------------------------------------------------------------------
// 6. Rollback: cause a safe late failure and prove nothing durable landed.
// ---------------------------------------------------------------------------

test("late constraint failure inside ingest_new_email rolls back submission + intake + audits", async () => {
  // Baseline deltas.
  const b = await rest(`atlas_submissions?created_by=eq.${SYSTEM_ACTOR}&select=id`);
  const beforeSubs = Array.isArray(b.body) ? b.body.length : 0;

  const badProcessingState = "processed_invalid_gate_probe";
  const r = await rpc("atlas_intake_ingest_new_email", {
    p_system_actor_id: SYSTEM_ACTOR,
    p_source_type: "email",
    p_pipeline_stage: "new",
    p_queue_status: "new",
    p_status: "new",
    p_priority: "normal",
    p_next_action: "Review intake",
    p_received_at: new Date().toISOString(),
    p_mailbox: `${PREFIX}-rollback@example.invalid`,
    p_graph_message_id: `${PREFIX}-graph-rollback`,
    p_internet_message_id: `${PREFIX}-imid-rollback`,
    p_conversation_id: null,
    p_sender_name: null,
    p_sender_address: null,
    p_recipients: [],
    p_subject: null,
    p_body_preview: null,
    p_has_attachments: false,
    p_processing_state: badProcessingState,      // CHECK constraint violation
    p_correlation_rule: "new_submission",
    p_mailbox_hash: "hash",
    p_graph_message_id_hash: "hash",
  });
  assert(r.status !== 200, "rpc must fail");
  const after = await rest(`atlas_submissions?created_by=eq.${SYSTEM_ACTOR}&select=id`);
  const afterSubs = Array.isArray(after.body) ? after.body.length : 0;
  eq(afterSubs, beforeSubs, "no orphan submission");
  // Intake row for that graph id must not exist.
  const orphanIntake = await rest(`atlas_submission_intake_messages?graph_message_id=eq.${PREFIX}-graph-rollback&select=id`);
  eq(Array.isArray(orphanIntake.body) ? orphanIntake.body.length : 0, 0, "no orphan intake");
});

// ---------------------------------------------------------------------------
// 7. Parallel same internet_message_id across mailboxes.
// ---------------------------------------------------------------------------

test("parallel ingest with same internetMessageId → exactly one durable intake", async () => {
  const im = `${PREFIX}-parallel-imid`;
  const g1 = `${PREFIX}-parallel-graph-A`;
  const g2 = `${PREFIX}-parallel-graph-B`;
  const mailboxA = `${PREFIX}-parallel-A@example.invalid`;
  const mailboxB = `${PREFIX}-parallel-B@example.invalid`;
  const call = (mailbox, graphId) => rpc("atlas_intake_ingest_new_email", {
    p_system_actor_id: SYSTEM_ACTOR,
    p_source_type: "email",
    p_pipeline_stage: "new",
    p_queue_status: "new",
    p_status: "new",
    p_priority: "normal",
    p_next_action: "Review intake",
    p_received_at: new Date().toISOString(),
    p_mailbox: mailbox,
    p_graph_message_id: graphId,
    p_internet_message_id: im,
    p_conversation_id: null,
    p_sender_name: null,
    p_sender_address: null,
    p_recipients: [],
    p_subject: null,
    p_body_preview: null,
    p_has_attachments: false,
    p_processing_state: "processed",
    p_correlation_rule: "new_submission",
    p_mailbox_hash: "hash",
    p_graph_message_id_hash: "hash",
  });
  const [a, b] = await Promise.all([call(mailboxA, g1), call(mailboxB, g2)]);
  // One created, one duplicate OR one created + one 23505/rollback.
  const outcomes = [a, b].map((r) => Array.isArray(r.body) && r.body[0]?.outcome).filter(Boolean);
  const createdCount = outcomes.filter((o) => o === "created").length;
  assert(createdCount === 1, `exactly one created (${JSON.stringify(outcomes)})`);
  const intakeCount = (await rest(`atlas_submission_intake_messages?internet_message_id=eq.${im}&select=id`)).body.length;
  eq(intakeCount, 1, "exactly one intake row with that internet_message_id");
  const winnerSubId = [a, b]
    .filter((r) => r.body?.[0]?.outcome === "created")
    .map((r) => r.body[0].submission_id)[0];
  state.submissionIds.add(winnerSubId);

  // Replay after the winner commits → duplicate.
  const replay = await call(mailboxA, `${g1}-replay`);
  eq(Array.isArray(replay.body) && replay.body[0]?.outcome, "duplicate_internet_message_id", "replay → duplicate");
});

// ---------------------------------------------------------------------------
// 8. Success cursor + audit atomicity.
// ---------------------------------------------------------------------------

test("release_lease_success with owning lease advances cursor AND writes audit atomically", async () => {
  const mailbox = `${PREFIX}-success@example.invalid`;
  state.mailboxes.add(mailbox);
  const leaseId = u();
  await rpc("atlas_intake_acquire_lease", {
    p_mailbox: mailbox,
    p_stale_cutoff_iso: new Date(Date.now() - 60_000).toISOString(),
    p_new_lease_id: leaseId,
    p_now: new Date().toISOString(),
  });
  const before = (await rest(`atlas_audit_logs?action=eq.graph_poll_success&metadata_json->>fixture_prefix=eq.${PREFIX}&select=id`)).body;
  const r = await rpc("atlas_intake_release_lease_success", {
    p_mailbox: mailbox,
    p_expected_lease_id: leaseId,
    p_delta_link: "https://graph.microsoft.com/gate-success",
    p_delta_link_provided: true,
    p_in_round_next_link: null,
    p_in_round_provided: true,
    p_last_success_at: new Date().toISOString(),
    p_audit_metadata: { fixture_prefix: PREFIX, gate: "phase5a" },
  });
  eq(r.body[0].ok, true, "ok=true");
  const stateRow = (await rest(`atlas_intake_graph_state?mailbox=eq.${encodeURIComponent(mailbox)}&select=delta_link,lease_id`)).body[0];
  eq(stateRow.delta_link, "https://graph.microsoft.com/gate-success", "delta_link advanced");
  eq(stateRow.lease_id, null, "lease cleared");
  const after = (await rest(`atlas_audit_logs?action=eq.graph_poll_success&metadata_json->>fixture_prefix=eq.${PREFIX}&select=id`)).body;
  eq(after.length, before.length + 1, "exactly one new graph_poll_success audit");
});

// ---------------------------------------------------------------------------
// 9. Full enumeration + privilege proof (structural finale)
// ---------------------------------------------------------------------------

test("all six Phase 5A RPCs exist and are all service-role-only", async () => {
  // Enumerating via HEAD listing is not possible via PostgREST; instead use
  // the discovery endpoint that lists exposed RPCs.
  const listing = await fetch(`${URL_}/rest/v1/`, { headers: HEADERS });
  const doc = await listing.json();
  const paths = Object.keys(doc.paths || {});
  const rpcs = paths
    .filter((p) => p.startsWith("/rpc/atlas_intake_"))
    .map((p) => p.slice("/rpc/".length));
  // Expected six (unordered).
  const expected = new Set([
    "atlas_intake_acquire_lease",
    "atlas_intake_release_lease",
    "atlas_intake_release_lease_success",
    "atlas_intake_ingest_new_email",
    "atlas_intake_attach_message",
    "atlas_intake_ingest_needs_review",
  ]);
  for (const e of expected) {
    assert(rpcs.includes(e), `RPC ${e} exposed via service_role`);
  }
  // No unexpected atlas_intake_* RPCs.
  for (const got of rpcs) {
    assert(expected.has(got), `unexpected RPC exposed: ${got}`);
  }
});

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

(async () => {
  console.log(`phase5a-postgres: project ref=${projectRef}`);
  console.log(`phase5a-postgres: fixture prefix=${PREFIX}`);
  let passed = 0;
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log(`  ✓ ${t.name}`); passed++; }
    catch (e) { console.error(`  ✗ ${t.name}: ${e.message}`); failed++; }
  }
  console.log(`\nphase5a-postgres: ${passed} passed, ${failed} failed out of ${tests.length}`);
  // Cleanup non-audit fixtures.
  try { await cleanup(); console.log("cleanup: done"); }
  catch (e) { console.warn("cleanup: skipped —", e.message); }
  if (failed > 0) process.exit(1);
})();
