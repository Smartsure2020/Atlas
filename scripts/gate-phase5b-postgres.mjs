#!/usr/bin/env node
/**
 * Atlas — Phase 5B REAL-POSTGRES REGRESSION GATE (Checkpoint 3)
 * ---------------------------------------------------------------------------
 * Exercises every Phase 5B DDL object + RPC against a non-production Supabase.
 * Extends the Phase 5A gate pattern (scripts/gate-phase5a-postgres.mjs):
 * hard project-ref allowlist, service-role-only auth, unique GATE-P5B-<ts>
 * fixture prefix, cleanup on success.
 *
 * Required env:
 *   ATLAS_PHASE5B_TEST_SUPABASE_URL       (e.g. https://<ref>.supabase.co)
 *   ATLAS_PHASE5B_TEST_SERVICE_ROLE_KEY
 *   ATLAS_PHASE5B_TEST_MGMT_TOKEN         Supabase Management API access token
 *                                         (used for raw SQL required by RLS
 *                                         role-impersonation checks)
 *
 * Safety:
 *   * Hard allowlist of non-production project refs.
 *   * Hard forbidden ref: algenlnxagpxzsgaworz.
 *   * Service-role key value is never printed.
 *   * All fixtures are namespaced with GATE-P5B-<ts>-* strings and are
 *     cleaned up on success. Audit rows are compliance-durable and reported
 *     by count only.
 *
 * IMPORTANT: This script does not contact Microsoft Graph and MUST NOT
 * require any ATLAS_GRAPH_* env. It is Postgres-only.
 */

const NON_PROD_ALLOWLIST = new Set(["mnehddylkeelojsnkdtx"]);
const FORBIDDEN_REF = "algenlnxagpxzsgaworz";

const URL_ = process.env.ATLAS_PHASE5B_TEST_SUPABASE_URL || "";
const KEY  = process.env.ATLAS_PHASE5B_TEST_SERVICE_ROLE_KEY || "";
const MGMT = process.env.ATLAS_PHASE5B_TEST_MGMT_TOKEN || "";

const refMatch = URL_.match(/^https:\/\/([a-z0-9]+)\.supabase\.co/i);
const projectRef = refMatch ? refMatch[1].toLowerCase() : "";
if (!URL_ || !KEY) { console.error("phase5b: URL/KEY required"); process.exit(2); }
if (!projectRef)   { console.error("phase5b: unparseable project ref"); process.exit(3); }
if (projectRef === FORBIDDEN_REF) { console.error("phase5b: FORBIDDEN production ref — refusing"); process.exit(4); }
if (!NON_PROD_ALLOWLIST.has(projectRef)) { console.error(`phase5b: '${projectRef}' not in non-prod allowlist`); process.exit(5); }

const HEADERS = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json", Accept: "application/json" };

async function rpc(name, args) {
  const res = await fetch(`${URL_}/rest/v1/rpc/${name}`, {
    method: "POST", headers: HEADERS, body: JSON.stringify(args),
  });
  const text = await res.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
}

async function rest(path, opts = {}) {
  const res = await fetch(`${URL_}/rest/v1/${path}`, {
    ...opts, headers: { ...HEADERS, ...(opts.headers || {}) },
  });
  const text = await res.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
}

async function sqlAdmin(sql) {
  if (!MGMT) throw new Error("MGMT token missing for raw SQL");
  const res = await fetch(`https://api.supabase.com/v1/projects/${projectRef}/database/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${MGMT}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query: sql }),
  });
  const text = await res.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
}

// --- runner ---
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function eq(a, b, msg) { if (a !== b) throw new Error(`${msg}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }

const PREFIX = `GATE-P5B-${Date.now()}`;
const SYSTEM_ACTOR = "00000000-0000-0000-0000-00005a1a5a1a";
const state = {
  submissionIds: new Set(),
  intakeIds:     new Set(),
  attachmentIds: new Set(),
  jobIds:        new Set(),
  documentIds:   new Set(),
  mailboxes:     new Set(),
  alertIds:      new Set(),
  auditRetained: 0,
};

async function ingestNewEmail(overrides = {}) {
  const mailbox = overrides.mailbox ?? `${PREFIX}-mbx@example.com`;
  const graphMessageId = overrides.graphMessageId ?? `${PREFIX}-gm-${crypto.randomUUID()}`;
  const internetMessageId = overrides.internetMessageId ?? `${PREFIX}-im-${crypto.randomUUID()}@example.com`;
  state.mailboxes.add(mailbox);
  const args = {
    p_system_actor_id: SYSTEM_ACTOR,
    p_source_type: "email",
    p_pipeline_stage: "new",
    p_queue_status: "new",
    p_status: "new",
    p_priority: "normal",
    p_next_action: "Review intake",
    p_received_at: new Date().toISOString(),
    p_mailbox: mailbox,
    p_graph_message_id: graphMessageId,
    p_internet_message_id: internetMessageId,
    p_conversation_id: `${PREFIX}-conv-${crypto.randomUUID()}`,
    p_sender_name: "Sender Name",
    p_sender_address: "sender@example.com",
    p_recipients: [{ role: "to", name: "R", address: "r@example.com" }],
    p_subject: `${PREFIX} subject canary`,
    p_body_preview: `${PREFIX} body canary`,
    p_has_attachments: overrides.has_attachments ?? false,
    p_processing_state: "processed",
    p_correlation_rule: "rule_6_new",
    p_mailbox_hash: `${PREFIX}-mbxhash`,
    p_graph_message_id_hash: `${PREFIX}-gmhash`,
  };
  const r = await rpc("atlas_intake_ingest_new_email", args);
  if (r.status !== 200) throw new Error(`ingest_new_email HTTP ${r.status}: ${JSON.stringify(r.body)}`);
  const row = Array.isArray(r.body) ? r.body[0] : r.body;
  if (row?.submission_id) state.submissionIds.add(row.submission_id);
  if (row?.intake_message_id) state.intakeIds.add(row.intake_message_id);
  return { row, mailbox, graphMessageId, internetMessageId };
}

// ---------------------------------------------------------------------------
// §11: Discovery-job atomicity
// ---------------------------------------------------------------------------

test("§11a intake has_attachments=false: intake row created, NO discovery job", async () => {
  const { row } = await ingestNewEmail({ has_attachments: false });
  eq(row.outcome, "created", "outcome");
  const jobs = await rest(`atlas_jobs?submission_id=eq.${row.submission_id}&job_type=eq.graph_attachment_discovery&select=id`);
  eq(jobs.status, 200, "jobs HTTP");
  eq((jobs.body || []).length, 0, "no discovery job");
});

test("§11b intake has_attachments=true: intake row + exactly one discovery job", async () => {
  const { row } = await ingestNewEmail({ has_attachments: true });
  eq(row.outcome, "created", "outcome");
  const jobs = await rest(`atlas_jobs?submission_id=eq.${row.submission_id}&job_type=eq.graph_attachment_discovery&select=id,metadata,input_fingerprint`);
  eq(jobs.status, 200, "jobs HTTP");
  eq(jobs.body.length, 1, "exactly one discovery job");
  const j = jobs.body[0];
  state.jobIds.add(j.id);
  const meta = j.metadata;
  assert(meta && typeof meta === "object", "metadata object");
  // PII exclusion: only intake_message_id.
  const keys = Object.keys(meta).sort();
  eq(keys.length, 1, "single key");
  eq(keys[0], "intake_message_id", "only intake_message_id");
  eq(meta.intake_message_id, row.intake_message_id, "matches");
  eq(j.input_fingerprint, `graph-attachment-discovery:${row.intake_message_id}`, "fingerprint");
});

// ---------------------------------------------------------------------------
// §12: Replay does not create a second discovery job
// ---------------------------------------------------------------------------

test("§12 delta replay: same Graph message → same intake, same single discovery job", async () => {
  const first = await ingestNewEmail({ has_attachments: true });
  const replayArgs = {
    ...(await (async () => ({}))()),
  };
  const args = {
    p_system_actor_id: SYSTEM_ACTOR,
    p_source_type: "email", p_pipeline_stage: "new", p_queue_status: "new",
    p_status: "new", p_priority: "normal", p_next_action: "Review intake",
    p_received_at: new Date().toISOString(),
    p_mailbox: first.mailbox,
    p_graph_message_id: first.graphMessageId,
    p_internet_message_id: first.internetMessageId,
    p_conversation_id: null,
    p_sender_name: null, p_sender_address: null,
    p_recipients: [], p_subject: null, p_body_preview: null,
    p_has_attachments: true, p_processing_state: "processed",
    p_correlation_rule: "replay",
    p_mailbox_hash: `${PREFIX}-h`, p_graph_message_id_hash: `${PREFIX}-h`,
  };
  const r = await rpc("atlas_intake_ingest_new_email", args);
  eq(r.status, 200, "replay HTTP");
  const row = Array.isArray(r.body) ? r.body[0] : r.body;
  assert(
    row.outcome === "duplicate_internet_message_id" || row.outcome === "duplicate_graph_message_id",
    `replay dup outcome (got ${row.outcome})`,
  );
  eq(row.intake_message_id, first.row.intake_message_id, "same intake id");
  // Assert still exactly one queued/running discovery job.
  const jobs = await rest(`atlas_jobs?submission_id=eq.${first.row.submission_id}&job_type=eq.graph_attachment_discovery&status=in.(queued,running)&select=id`);
  eq(jobs.body.length, 1, "no second discovery job");
  void replayArgs;
});

// ---------------------------------------------------------------------------
// §13: discover_commit with mixed stubs + terminal-preservation on replay
// ---------------------------------------------------------------------------

test("§13 discover_commit: eligible/skipped/unsupported + terminal replay preserves state", async () => {
  const { row } = await ingestNewEmail({ has_attachments: true });
  const stubs = [
    { graph_attachment_id: `${PREFIX}-att-eligible`, attachment_type: "fileAttachment", filename: `${PREFIX}-fname-canary.pdf`, mime_type: "application/pdf", size_bytes: 42000, is_inline: false, content_id: null, initial_state: "pending", skip_reason: null },
    { graph_attachment_id: `${PREFIX}-att-inline`,   attachment_type: "fileAttachment", filename: `${PREFIX}-sig-canary.png`,   mime_type: "image/png",       size_bytes: 5000,  is_inline: true,  content_id: "sig-1", initial_state: "skipped", skip_reason: "inline_signature" },
    { graph_attachment_id: `${PREFIX}-att-item`,     attachment_type: "itemAttachment", filename: null,                          mime_type: null,               size_bytes: null,  is_inline: false, content_id: null,   initial_state: "unsupported", skip_reason: "item_attachment" },
    { graph_attachment_id: `${PREFIX}-att-ref`,      attachment_type: "referenceAttachment", filename: null,                     mime_type: null,               size_bytes: null,  is_inline: false, content_id: null,   initial_state: "unsupported", skip_reason: "reference_attachment" },
    { graph_attachment_id: `${PREFIX}-att-oversize`, attachment_type: "fileAttachment", filename: `${PREFIX}-big.pdf`,          mime_type: "application/pdf",  size_bytes: 99_000_000, is_inline: false, content_id: null, initial_state: "skipped", skip_reason: "oversize" },
  ];
  const r = await rpc("atlas_intake_attachment_discover_commit", {
    p_intake_message_id: row.intake_message_id,
    p_system_actor_id: SYSTEM_ACTOR,
    p_mailbox: `${PREFIX}-mbx@example.com`,
    p_graph_message_id: `${PREFIX}-gm-discover`,
    p_stubs: stubs,
  });
  eq(r.status, 200, "commit HTTP");
  eq(r.body.length, 5, "one row per stub");
  for (const b of r.body) state.attachmentIds.add(b.attachment_id);
  const eligible = r.body.find((b) => b.graph_attachment_id.endsWith("-eligible"));
  const inline   = r.body.find((b) => b.graph_attachment_id.endsWith("-inline"));
  const item     = r.body.find((b) => b.graph_attachment_id.endsWith("-item"));
  const ref      = r.body.find((b) => b.graph_attachment_id.endsWith("-ref"));
  const overs    = r.body.find((b) => b.graph_attachment_id.endsWith("-oversize"));
  eq(eligible.state, "pending", "eligible pending");
  assert(eligible.ingest_job_id, "ingest job for eligible");
  state.jobIds.add(eligible.ingest_job_id);
  eq(inline.state, "skipped", "inline skipped");
  eq(inline.ingest_job_id, null, "no ingest job for inline");
  eq(item.state, "unsupported", "item unsupported");
  eq(item.ingest_job_id, null, "no ingest job for item");
  eq(ref.state, "unsupported", "ref unsupported");
  eq(overs.state, "skipped", "oversize skipped");

  // Manually advance eligible → ingested (simulate a full ingest lifecycle
  // via the RPCs). This proves terminal-state preservation on replay below.
  // 1. claim
  const claim = await rpc("atlas_intake_attachment_claim", { p_id: eligible.attachment_id, p_expected_state: "pending" });
  eq(claim.status, 200, "claim HTTP");
  eq(claim.body.length, 1, "claimed");
  // 2. register_hash
  const sha = "e".repeat(64);
  const reg = await rpc("atlas_intake_attachment_register_hash", { p_id: eligible.attachment_id, p_expected_state: "downloading", p_sha256: sha, p_size_bytes: 42000 });
  eq(reg.status, 200, "register HTTP");
  eq(reg.body[0].outcome, "owner", "owner");
  // 3. mark_uploaded
  const path = `${row.submission_id}/graph/${eligible.attachment_id}.pdf`;
  const mk = await rpc("atlas_intake_attachment_mark_uploaded", { p_id: eligible.attachment_id, p_expected_state: "downloading", p_storage_path: path });
  eq(mk.status, 200, "mark_uploaded HTTP");
  eq(mk.body[0].ok, true, "marked");
  // 4. create_document
  const cd = await rpc("atlas_intake_attachment_create_document", { p_id: eligible.attachment_id, p_system_actor_id: SYSTEM_ACTOR, p_retention_days: 7 });
  eq(cd.status, 200, "create_document HTTP");
  eq(cd.body[0].outcome, "created", "document created");
  state.documentIds.add(cd.body[0].document_id);
  state.jobIds.add(cd.body[0].scan_job_id);

  // Replay discover_commit with the SAME stubs. Terminal states must not
  // regress: eligible=ingested stays ingested; skipped stays skipped;
  // unsupported stays unsupported.
  const r2 = await rpc("atlas_intake_attachment_discover_commit", {
    p_intake_message_id: row.intake_message_id,
    p_system_actor_id: SYSTEM_ACTOR,
    p_mailbox: `${PREFIX}-mbx@example.com`,
    p_graph_message_id: `${PREFIX}-gm-discover`,
    p_stubs: stubs,
  });
  eq(r2.status, 200, "replay HTTP");
  eq(r2.body.length, 5, "same 5 rows");
  const eligibleR = r2.body.find((b) => b.graph_attachment_id.endsWith("-eligible"));
  const inlineR   = r2.body.find((b) => b.graph_attachment_id.endsWith("-inline"));
  const itemR     = r2.body.find((b) => b.graph_attachment_id.endsWith("-item"));
  eq(eligibleR.state, "ingested", "ingested preserved");
  eq(inlineR.state, "skipped",   "skipped preserved");
  eq(itemR.state, "unsupported", "unsupported preserved");
  // No new ingest job for the already-ingested row.
  eq(eligibleR.ingest_job_id, null, "no ingest job on replay for terminal row");
  // Same attachment IDs on replay.
  const r2Eligible = r2.body.find((b) => b.graph_attachment_id.endsWith("-eligible")).attachment_id;
  eq(r2Eligible, eligible.attachment_id, "same attachment id on replay");
});

// ---------------------------------------------------------------------------
// §14 + §15: Hash owner concurrency + same-row idempotency + changed-sha fail-closed
// ---------------------------------------------------------------------------

test("§14 hash owner: two concurrent same-SHA claims → exactly one owner, one duplicate", async () => {
  const { row } = await ingestNewEmail({ has_attachments: true });
  const stubs = [
    { graph_attachment_id: `${PREFIX}-h-a`, attachment_type: "fileAttachment", filename: "a.pdf", mime_type: "application/pdf", size_bytes: 1000, is_inline: false, content_id: null, initial_state: "pending", skip_reason: null },
    { graph_attachment_id: `${PREFIX}-h-b`, attachment_type: "fileAttachment", filename: "b.pdf", mime_type: "application/pdf", size_bytes: 1000, is_inline: false, content_id: null, initial_state: "pending", skip_reason: null },
  ];
  const r = await rpc("atlas_intake_attachment_discover_commit", {
    p_intake_message_id: row.intake_message_id,
    p_system_actor_id: SYSTEM_ACTOR,
    p_mailbox: `${PREFIX}-mbx@example.com`,
    p_graph_message_id: `${PREFIX}-gm-hash`,
    p_stubs: stubs,
  });
  eq(r.status, 200, "commit HTTP");
  for (const b of r.body) { state.attachmentIds.add(b.attachment_id); if (b.ingest_job_id) state.jobIds.add(b.ingest_job_id); }
  const a = r.body.find((b) => b.graph_attachment_id.endsWith("-h-a"));
  const b = r.body.find((b) => b.graph_attachment_id.endsWith("-h-b"));
  // Claim both (transition pending → downloading) so register_hash is valid.
  await rpc("atlas_intake_attachment_claim", { p_id: a.attachment_id, p_expected_state: "pending" });
  await rpc("atlas_intake_attachment_claim", { p_id: b.attachment_id, p_expected_state: "pending" });
  const sha = "c".repeat(64);
  const [ra, rb] = await Promise.all([
    rpc("atlas_intake_attachment_register_hash", { p_id: a.attachment_id, p_expected_state: "downloading", p_sha256: sha, p_size_bytes: 1000 }),
    rpc("atlas_intake_attachment_register_hash", { p_id: b.attachment_id, p_expected_state: "downloading", p_sha256: sha, p_size_bytes: 1000 }),
  ]);
  eq(ra.status, 200, "ra HTTP");
  eq(rb.status, 200, "rb HTTP");
  const outcomes = [ra.body[0].outcome, rb.body[0].outcome].sort();
  eq(outcomes[0], "duplicate", "one duplicate");
  eq(outcomes[1], "owner", "one owner");
  // Verify the actual rows.
  const rowsResp = await rest(`atlas_intake_graph_attachments?submission_id=eq.${row.submission_id}&sha256=eq.${sha}&select=id,duplicate_of_attachment_id,state,skip_reason`);
  const owners = rowsResp.body.filter((r) => r.duplicate_of_attachment_id == null);
  const dups   = rowsResp.body.filter((r) => r.duplicate_of_attachment_id != null);
  eq(owners.length, 1, "one owner row");
  eq(dups.length, 1, "one duplicate row");
  eq(dups[0].state, "skipped", "duplicate state");
  eq(dups[0].skip_reason, "duplicate_hash", "duplicate reason");
  eq(dups[0].duplicate_of_attachment_id, owners[0].id, "linked");
});

test("§15 hash idempotency: owner + same-sha replay → same result; different-sha → fail_closed", async () => {
  const { row } = await ingestNewEmail({ has_attachments: true });
  const stubs = [{ graph_attachment_id: `${PREFIX}-idem`, attachment_type: "fileAttachment", filename: "x.pdf", mime_type: "application/pdf", size_bytes: 100, is_inline: false, content_id: null, initial_state: "pending", skip_reason: null }];
  const r = await rpc("atlas_intake_attachment_discover_commit", {
    p_intake_message_id: row.intake_message_id, p_system_actor_id: SYSTEM_ACTOR,
    p_mailbox: `${PREFIX}-mbx@example.com`, p_graph_message_id: `${PREFIX}-gm-idem`, p_stubs: stubs,
  });
  const att = r.body[0];
  state.attachmentIds.add(att.attachment_id);
  if (att.ingest_job_id) state.jobIds.add(att.ingest_job_id);
  await rpc("atlas_intake_attachment_claim", { p_id: att.attachment_id, p_expected_state: "pending" });
  const sha = "d".repeat(64);
  const first  = await rpc("atlas_intake_attachment_register_hash", { p_id: att.attachment_id, p_expected_state: "downloading", p_sha256: sha, p_size_bytes: 100 });
  eq(first.body[0].outcome, "owner", "first = owner");
  // Idempotent same-sha replay.
  const replay = await rpc("atlas_intake_attachment_register_hash", { p_id: att.attachment_id, p_expected_state: "downloading", p_sha256: sha, p_size_bytes: 100 });
  eq(replay.status, 200, "replay HTTP");
  eq(replay.body[0].outcome, "owner", "self_owner");
  // Different sha must fail_closed with attachment_hash_changed.
  const other = "9".repeat(64);
  const changed = await rpc("atlas_intake_attachment_register_hash", { p_id: att.attachment_id, p_expected_state: "downloading", p_sha256: other, p_size_bytes: 100 });
  assert(changed.status >= 400, `expected error status, got ${changed.status}`);
  const msg = JSON.stringify(changed.body);
  assert(msg.includes("attachment_hash_changed"), `message contains hash_changed (got ${msg})`);
  // Row's sha must NOT have changed.
  const check = await rest(`atlas_intake_graph_attachments?id=eq.${att.attachment_id}&select=sha256`);
  eq(check.body[0].sha256, sha, "sha unchanged after fail-closed");
});

// ---------------------------------------------------------------------------
// §16 cross-submission same SHA → separate owners
// ---------------------------------------------------------------------------

test("§16 cross-submission same SHA: both are owners (no global dedup)", async () => {
  const a = await ingestNewEmail({ has_attachments: true });
  const b = await ingestNewEmail({ has_attachments: true });
  async function attach(rowRef, tag) {
    const stubs = [{ graph_attachment_id: `${PREFIX}-x-${tag}`, attachment_type: "fileAttachment", filename: "y.pdf", mime_type: "application/pdf", size_bytes: 100, is_inline: false, content_id: null, initial_state: "pending", skip_reason: null }];
    const r = await rpc("atlas_intake_attachment_discover_commit", {
      p_intake_message_id: rowRef.intake_message_id, p_system_actor_id: SYSTEM_ACTOR,
      p_mailbox: `${PREFIX}-mbx@example.com`, p_graph_message_id: `${PREFIX}-gm-x-${tag}`, p_stubs: stubs,
    });
    const att = r.body[0];
    state.attachmentIds.add(att.attachment_id);
    if (att.ingest_job_id) state.jobIds.add(att.ingest_job_id);
    await rpc("atlas_intake_attachment_claim", { p_id: att.attachment_id, p_expected_state: "pending" });
    return att;
  }
  const attA = await attach(a.row, "a");
  const attB = await attach(b.row, "b");
  const sha = "1".repeat(64);
  const ra = await rpc("atlas_intake_attachment_register_hash", { p_id: attA.attachment_id, p_expected_state: "downloading", p_sha256: sha, p_size_bytes: 100 });
  const rb = await rpc("atlas_intake_attachment_register_hash", { p_id: attB.attachment_id, p_expected_state: "downloading", p_sha256: sha, p_size_bytes: 100 });
  eq(ra.body[0].outcome, "owner", "A owner");
  eq(rb.body[0].outcome, "owner", "B owner (separate submission)");
});

// ---------------------------------------------------------------------------
// §17 mark_uploaded fence
// ---------------------------------------------------------------------------

test("§17b set_planned_path: persists path while downloading; idempotent; conflict refused", async () => {
  const { row } = await ingestNewEmail({ has_attachments: true });
  const stubs = [{ graph_attachment_id: `${PREFIX}-spp`, attachment_type: "fileAttachment", filename: "p.pdf", mime_type: "application/pdf", size_bytes: 50, is_inline: false, content_id: null, initial_state: "pending", skip_reason: null }];
  const dr = await rpc("atlas_intake_attachment_discover_commit", {
    p_intake_message_id: row.intake_message_id, p_system_actor_id: SYSTEM_ACTOR,
    p_mailbox: `${PREFIX}-mbx@example.com`, p_graph_message_id: `${PREFIX}-gm-spp`, p_stubs: stubs,
  });
  const att = dr.body[0]; state.attachmentIds.add(att.attachment_id);
  if (att.ingest_job_id) state.jobIds.add(att.ingest_job_id);
  await rpc("atlas_intake_attachment_claim", { p_id: att.attachment_id, p_expected_state: "pending" });
  const path = `${row.submission_id}/graph/${att.attachment_id}.pdf`;
  const s1 = await rpc("atlas_intake_attachment_set_planned_path", {
    p_id: att.attachment_id, p_expected_state: "downloading", p_storage_path: path,
  });
  eq(s1.status, 200, "spp1 HTTP");
  eq(s1.body[0].ok, true, "persisted");
  eq(s1.body[0].reason, "persisted", "reason");
  // Row now carries the path while still downloading — the detection-protect
  // predicate the runtime uses must classify this as a legitimate reference.
  const seen = await rest(`atlas_intake_graph_attachments?id=eq.${att.attachment_id}&select=state,storage_path`);
  eq(seen.body[0].state, "downloading", "still downloading");
  eq(seen.body[0].storage_path, path, "path persisted");
  // Idempotent same-path replay.
  const s2 = await rpc("atlas_intake_attachment_set_planned_path", {
    p_id: att.attachment_id, p_expected_state: "downloading", p_storage_path: path,
  });
  eq(s2.body[0].ok, true, "idempotent");
  eq(s2.body[0].reason, "idempotent_noop", "reason");
  // Conflicting path refused.
  const s3 = await rpc("atlas_intake_attachment_set_planned_path", {
    p_id: att.attachment_id, p_expected_state: "downloading", p_storage_path: `${path}-DIFFERENT`,
  });
  eq(s3.body[0].ok, false, "conflict refused");
  eq(s3.body[0].reason, "storage_path_conflict", "reason");
});

test("§17c cleanup detection protects Phase 5B storage paths in active states", async () => {
  // For any of our attachment rows with state IN (downloading, uploaded, ingested)
  // AND a non-null storage_path, a SQL predicate identical to detectCleanupCandidates'
  // protection set must recognise the path as referenced.
  const anyAtt = [...state.attachmentIds][0];
  if (!anyAtt) throw new Error("need at least one attachment fixture");
  // Ensure at least one row is in a protected state via §13/§18 above.
  const check = await sqlAdmin(`
    SELECT storage_path
    FROM public.atlas_intake_graph_attachments
    WHERE state IN ('downloading', 'uploaded', 'ingested')
      AND storage_path IS NOT NULL
      AND storage_path LIKE '${PREFIX.replace(/'/g, "''")}%' OR storage_path LIKE '%/graph/%.pdf'
    LIMIT 5;
  `);
  assert(okMgmt(check.status), "protect SQL");
  assert(Array.isArray(check.body) && check.body.length > 0, "protection query returns Phase 5B rows");
});

test("§17d cleanup revalidation: stale orphan candidate is refused when attachment path is now referenced", async () => {
  const { row } = await ingestNewEmail({ has_attachments: true });
  const stubs = [{ graph_attachment_id: `${PREFIX}-race`, attachment_type: "fileAttachment", filename: "r.pdf", mime_type: "application/pdf", size_bytes: 50, is_inline: false, content_id: null, initial_state: "pending", skip_reason: null }];
  const dr = await rpc("atlas_intake_attachment_discover_commit", {
    p_intake_message_id: row.intake_message_id, p_system_actor_id: SYSTEM_ACTOR,
    p_mailbox: `${PREFIX}-mbx@example.com`, p_graph_message_id: `${PREFIX}-gm-race`, p_stubs: stubs,
  });
  const att = dr.body[0]; state.attachmentIds.add(att.attachment_id);
  if (att.ingest_job_id) state.jobIds.add(att.ingest_job_id);
  await rpc("atlas_intake_attachment_claim", { p_id: att.attachment_id, p_expected_state: "pending" });
  const path = `${row.submission_id}/graph/${att.attachment_id}.pdf`;
  // Stale approved candidate created BEFORE the Phase 5B path materialises.
  const insCand = await rest("atlas_cleanup_candidates", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({
      candidate_type: "orphan_storage_path",
      status: "approved",
      storage_bucket: "atlas-client-docs",
      storage_path: path,
      reason: "STALE — this candidate was created before Phase 5B's path materialised",
      metadata: { detected_by: "gate-phase5b" },
      approved_by: SYSTEM_ACTOR,
      approved_at: new Date().toISOString(),
    }),
  });
  eq(insCand.status, 201, "candidate inserted");
  const candidateId = insCand.body[0].id;
  // Now materialise the Phase 5B path.
  await rpc("atlas_intake_attachment_set_planned_path", {
    p_id: att.attachment_id, p_expected_state: "downloading", p_storage_path: path,
  });
  // The runtime-mirror revalidation predicate: any active attachment or
  // atlas_documents row that references this path must veto the deletion.
  const guard = await sqlAdmin(`
    SELECT
      (SELECT 1 FROM public.atlas_documents WHERE storage_path = '${path}' LIMIT 1) IS NOT NULL AS doc_ref,
      (SELECT 1 FROM public.atlas_intake_graph_attachments WHERE storage_path = '${path}'
         AND state IN ('downloading','uploaded','ingested') LIMIT 1) IS NOT NULL AS att_ref;
  `);
  assert(okMgmt(guard.status), "guard SQL");
  eq(guard.body[0].att_ref, true, "attachment reference present");
  // Cleanup the stale candidate directly (no runtime here).
  await rest(`atlas_cleanup_candidates?id=eq.${candidateId}`, { method: "DELETE" });
});

test("§17 mark_uploaded: valid transition + idempotent replay; invalid state fenced", async () => {
  const { row } = await ingestNewEmail({ has_attachments: true });
  const stubs = [{ graph_attachment_id: `${PREFIX}-mu`, attachment_type: "fileAttachment", filename: "z.pdf", mime_type: "application/pdf", size_bytes: 100, is_inline: false, content_id: null, initial_state: "pending", skip_reason: null }];
  const dr = await rpc("atlas_intake_attachment_discover_commit", {
    p_intake_message_id: row.intake_message_id, p_system_actor_id: SYSTEM_ACTOR,
    p_mailbox: `${PREFIX}-mbx@example.com`, p_graph_message_id: `${PREFIX}-gm-mu`, p_stubs: stubs,
  });
  const att = dr.body[0]; state.attachmentIds.add(att.attachment_id);
  if (att.ingest_job_id) state.jobIds.add(att.ingest_job_id);
  await rpc("atlas_intake_attachment_claim", { p_id: att.attachment_id, p_expected_state: "pending" });
  await rpc("atlas_intake_attachment_register_hash", { p_id: att.attachment_id, p_expected_state: "downloading", p_sha256: "2".repeat(64), p_size_bytes: 100 });
  const path = `${row.submission_id}/graph/${att.attachment_id}.pdf`;
  const m1 = await rpc("atlas_intake_attachment_mark_uploaded", { p_id: att.attachment_id, p_expected_state: "downloading", p_storage_path: path });
  eq(m1.body[0].ok, true, "transitioned");
  const m2 = await rpc("atlas_intake_attachment_mark_uploaded", { p_id: att.attachment_id, p_expected_state: "downloading", p_storage_path: path });
  eq(m2.body[0].ok, true, "idempotent replay ok");
  eq(m2.body[0].reason, "idempotent_noop", "reason");
  // Same-row wrong path on already-uploaded row → mismatch.
  const m3 = await rpc("atlas_intake_attachment_mark_uploaded", { p_id: att.attachment_id, p_expected_state: "downloading", p_storage_path: `${path}-DIFFERENT` });
  eq(m3.body[0].ok, false, "mismatch refused");
  eq(m3.body[0].reason, "storage_path_mismatch", "mismatch reason");
});

// ---------------------------------------------------------------------------
// §18 + §19 + §20: create_document real, idempotent, rollback
// ---------------------------------------------------------------------------

test("§18 create_document: atomic atlas_documents + malware_scan + attachment linkage + audit", async () => {
  const { row } = await ingestNewEmail({ has_attachments: true });
  const stubs = [{ graph_attachment_id: `${PREFIX}-cd`, attachment_type: "fileAttachment", filename: `${PREFIX}-cd.pdf`, mime_type: "application/pdf", size_bytes: 55555, is_inline: false, content_id: null, initial_state: "pending", skip_reason: null }];
  const dr = await rpc("atlas_intake_attachment_discover_commit", {
    p_intake_message_id: row.intake_message_id, p_system_actor_id: SYSTEM_ACTOR,
    p_mailbox: `${PREFIX}-mbx@example.com`, p_graph_message_id: `${PREFIX}-gm-cd`, p_stubs: stubs,
  });
  const att = dr.body[0]; state.attachmentIds.add(att.attachment_id);
  if (att.ingest_job_id) state.jobIds.add(att.ingest_job_id);
  await rpc("atlas_intake_attachment_claim", { p_id: att.attachment_id, p_expected_state: "pending" });
  await rpc("atlas_intake_attachment_register_hash", { p_id: att.attachment_id, p_expected_state: "downloading", p_sha256: "3".repeat(64), p_size_bytes: 55555 });
  const path = `${row.submission_id}/graph/${att.attachment_id}.pdf`;
  await rpc("atlas_intake_attachment_mark_uploaded", { p_id: att.attachment_id, p_expected_state: "downloading", p_storage_path: path });
  const cd = await rpc("atlas_intake_attachment_create_document", { p_id: att.attachment_id, p_system_actor_id: SYSTEM_ACTOR, p_retention_days: 7 });
  eq(cd.status, 200, "create_document HTTP");
  const out = cd.body[0];
  eq(out.outcome, "created", "created");
  state.documentIds.add(out.document_id);
  state.jobIds.add(out.scan_job_id);
  // Verify atlas_documents row.
  const doc = await rest(`atlas_documents?id=eq.${out.document_id}&select=submission_id,file_name,storage_path,document_type,status,scan_status,uploaded_by,file_hash,file_size_bytes,content_type,expires_at`);
  const d = doc.body[0];
  eq(d.submission_id, row.submission_id, "submission");
  eq(d.storage_path, path, "storage_path");
  eq(d.document_type, "supporting", "document_type");
  eq(d.status, "active", "status");
  eq(d.scan_status, "pending", "scan_status");
  eq(d.uploaded_by, SYSTEM_ACTOR, "uploaded_by");
  eq(d.file_hash, "3".repeat(64), "file_hash");
  eq(d.file_size_bytes, 55555, "file_size_bytes");
  eq(d.content_type, "application/pdf", "content_type");
  assert(d.expires_at, "expires_at populated");
  // Verify malware_scan job.
  const scan = await rest(`atlas_jobs?id=eq.${out.scan_job_id}&select=job_type,status,submission_id,document_id,metadata,input_fingerprint`);
  const sj = scan.body[0];
  eq(sj.job_type, "malware_scan", "job_type");
  eq(sj.status, "queued", "queued");
  eq(sj.document_id, out.document_id, "linked");
  eq(sj.metadata.bucket, "atlas-client-docs", "bucket");
  eq(sj.metadata.storage_path, path, "job path");
  eq(sj.input_fingerprint, `malware_scan:${out.document_id}`, "fingerprint");
  // Attachment linkage + state.
  const att2 = await rest(`atlas_intake_graph_attachments?id=eq.${att.attachment_id}&select=state,document_id,scan_job_id`);
  eq(att2.body[0].state, "ingested", "ingested");
  eq(att2.body[0].document_id, out.document_id, "doc linked");
  eq(att2.body[0].scan_job_id, out.scan_job_id, "job linked");
  // Audit event (safe metadata only).
  const audit = await rest(`atlas_audit_logs?submission_id=eq.${row.submission_id}&action=eq.intake_attachment_ingested&select=metadata_json`);
  eq(audit.body.length, 1, "one audit row");
  const meta = audit.body[0].metadata_json;
  eq(typeof meta.sha256_prefix12, "string", "prefix present");
  eq(meta.sha256_prefix12.length, 12, "prefix length 12");
  assert(!("filename" in meta), "no filename in audit");
  assert(!("mailbox" in meta), "no mailbox in audit");
  assert(!("graph_message_id" in meta), "no graph_message_id in audit");
  assert(!("graph_attachment_id" in meta), "no graph_attachment_id in audit");
});

test("§19 create_document idempotency: replay returns same document_id/scan_job_id, no duplicates", async () => {
  const { row } = await ingestNewEmail({ has_attachments: true });
  const stubs = [{ graph_attachment_id: `${PREFIX}-idemcd`, attachment_type: "fileAttachment", filename: "i.pdf", mime_type: "application/pdf", size_bytes: 200, is_inline: false, content_id: null, initial_state: "pending", skip_reason: null }];
  const dr = await rpc("atlas_intake_attachment_discover_commit", {
    p_intake_message_id: row.intake_message_id, p_system_actor_id: SYSTEM_ACTOR,
    p_mailbox: `${PREFIX}-mbx@example.com`, p_graph_message_id: `${PREFIX}-gm-idemcd`, p_stubs: stubs,
  });
  const att = dr.body[0]; state.attachmentIds.add(att.attachment_id);
  if (att.ingest_job_id) state.jobIds.add(att.ingest_job_id);
  await rpc("atlas_intake_attachment_claim", { p_id: att.attachment_id, p_expected_state: "pending" });
  await rpc("atlas_intake_attachment_register_hash", { p_id: att.attachment_id, p_expected_state: "downloading", p_sha256: "4".repeat(64), p_size_bytes: 200 });
  const path = `${row.submission_id}/graph/${att.attachment_id}.pdf`;
  await rpc("atlas_intake_attachment_mark_uploaded", { p_id: att.attachment_id, p_expected_state: "downloading", p_storage_path: path });
  const first = await rpc("atlas_intake_attachment_create_document", { p_id: att.attachment_id, p_system_actor_id: SYSTEM_ACTOR, p_retention_days: 7 });
  const f = first.body[0];
  state.documentIds.add(f.document_id); state.jobIds.add(f.scan_job_id);
  const second = await rpc("atlas_intake_attachment_create_document", { p_id: att.attachment_id, p_system_actor_id: SYSTEM_ACTOR, p_retention_days: 7 });
  const s = second.body[0];
  eq(s.outcome, "idempotent_noop", "idempotent");
  eq(s.document_id, f.document_id, "same document");
  eq(s.scan_job_id, f.scan_job_id, "same scan job");
  // Exactly one atlas_documents + one malware_scan for this submission from this attachment.
  const docs = await rest(`atlas_documents?storage_path=eq.${encodeURIComponent(path)}&select=id`);
  eq(docs.body.length, 1, "one document");
  const scan = await rest(`atlas_jobs?job_type=eq.malware_scan&document_id=eq.${f.document_id}&select=id`);
  eq(scan.body.length, 1, "one scan job");
  const audit = await rest(`atlas_audit_logs?submission_id=eq.${row.submission_id}&action=eq.intake_attachment_ingested&select=id`);
  eq(audit.body.length, 1, "one audit event (no duplicate)");
});

test("§20 create_document rollback: bad preconditions leave no partial writes", async () => {
  const { row } = await ingestNewEmail({ has_attachments: true });
  const stubs = [{ graph_attachment_id: `${PREFIX}-rb`, attachment_type: "fileAttachment", filename: "r.pdf", mime_type: "application/pdf", size_bytes: 300, is_inline: false, content_id: null, initial_state: "pending", skip_reason: null }];
  const dr = await rpc("atlas_intake_attachment_discover_commit", {
    p_intake_message_id: row.intake_message_id, p_system_actor_id: SYSTEM_ACTOR,
    p_mailbox: `${PREFIX}-mbx@example.com`, p_graph_message_id: `${PREFIX}-gm-rb`, p_stubs: stubs,
  });
  const att = dr.body[0]; state.attachmentIds.add(att.attachment_id);
  if (att.ingest_job_id) state.jobIds.add(att.ingest_job_id);
  // Attempt to create_document while state=pending (never uploaded). Must fail.
  const bad = await rpc("atlas_intake_attachment_create_document", { p_id: att.attachment_id, p_system_actor_id: SYSTEM_ACTOR, p_retention_days: 7 });
  assert(bad.status >= 400, `expected error, got ${bad.status}`);
  // Assert no partial rows exist.
  const docs = await rest(`atlas_documents?submission_id=eq.${row.submission_id}&document_type=eq.supporting&select=id`);
  eq(docs.body.length, 0, "no document rows");
  const scan = await rest(`atlas_jobs?job_type=eq.malware_scan&submission_id=eq.${row.submission_id}&select=id`);
  eq(scan.body.length, 0, "no malware_scan jobs");
  const audit = await rest(`atlas_audit_logs?submission_id=eq.${row.submission_id}&action=eq.intake_attachment_ingested&select=id`);
  eq(audit.body.length, 0, "no audit rows");
  const att2 = await rest(`atlas_intake_graph_attachments?id=eq.${att.attachment_id}&select=state,document_id,scan_job_id`);
  eq(att2.body[0].state, "pending", "attachment state unchanged");
  eq(att2.body[0].document_id, null, "no document linkage");
  eq(att2.body[0].scan_job_id, null, "no scan linkage");
});

// ---------------------------------------------------------------------------
// §21 Job enum / unique constraint proof (already exercised implicitly above)
// ---------------------------------------------------------------------------

test("§21 job enum values usable + running-unique behaviour", async () => {
  // Discovery + ingest job types persisted above (state.jobIds not empty).
  assert(state.jobIds.size > 0, "already exercised job types");
  // Try to insert a duplicate queued job with the same fingerprint — must
  // fail with a unique-violation.
  const anySub = [...state.submissionIds][0];
  const fp = `graph-attachment-discovery:${crypto.randomUUID()}`;
  const first = await rest("atlas_jobs", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({ submission_id: anySub, job_type: "graph_attachment_discovery", status: "queued", input_fingerprint: fp, metadata: {} }),
  });
  eq(first.status, 201, "first insert ok");
  state.jobIds.add(first.body[0].id);
  const dup = await rest("atlas_jobs", {
    method: "POST",
    body: JSON.stringify({ submission_id: anySub, job_type: "graph_attachment_discovery", status: "queued", input_fingerprint: fp, metadata: {} }),
  });
  assert(dup.status >= 400, `expected unique violation, got ${dup.status}`);
});

// ---------------------------------------------------------------------------
// §22 + §23: RLS impersonation + direct-write denial
// ---------------------------------------------------------------------------

async function selectAsRole(role, uid, sql) {
  const claims = JSON.stringify({ sub: uid, app_metadata: { atlas_role: role }, role: "authenticated" });
  const escapedClaims = claims.replace(/'/g, "''");
  const wrapped = `SET LOCAL role authenticated;
SET LOCAL "request.jwt.claims" = '${escapedClaims}';
${sql}`;
  return await sqlAdmin(wrapped);
}

function okMgmt(status) { return status === 200 || status === 201; }

test("§22 RLS: broker cannot see attachment rows for their own submission", async () => {
  const broker = process.env.ATLAS_STAGING_BROKER_A_USER_ID;
  if (!broker) throw new Error("ATLAS_STAGING_BROKER_A_USER_ID missing");
  const subId = [...state.submissionIds][0];
  const r = await selectAsRole("broker", broker, `SELECT count(*)::int AS c FROM public.atlas_intake_graph_attachments WHERE submission_id = '${subId}';`);
  assert(okMgmt(r.status), `SQL HTTP ${r.status}: ${JSON.stringify(r.body)}`);
  const rows = Array.isArray(r.body) ? r.body : [];
  eq(rows[0]?.c, 0, "broker sees zero rows");
});

test("§22 RLS: authenticated with no matching role sees zero rows", async () => {
  const readonly = process.env.ATLAS_STAGING_READONLY_USER_ID;
  if (!readonly) throw new Error("ATLAS_STAGING_READONLY_USER_ID missing");
  // readonly is NOT staff per atlas_is_staff() (staff = admin/manager/consultant/underwriter).
  const subId = [...state.submissionIds][0];
  const r = await selectAsRole("readonly", readonly, `SELECT count(*)::int AS c FROM public.atlas_intake_graph_attachments WHERE submission_id = '${subId}';`);
  assert(okMgmt(r.status), "SQL HTTP");
  eq(r.body[0]?.c, 0, "readonly sees zero rows (not staff)");
});

test("§22 RLS: manager sees the attachment rows we created", async () => {
  const mgr = process.env.ATLAS_STAGING_MANAGER_USER_ID;
  if (!mgr) throw new Error("ATLAS_STAGING_MANAGER_USER_ID missing");
  // Look across every submission we created — not [0], since §11a's submission
  // has no attachments by design.
  const subIds = [...state.submissionIds].map((s) => `'${s}'`).join(",");
  const r = await selectAsRole("manager", mgr, `SELECT count(*)::int AS c FROM public.atlas_intake_graph_attachments WHERE submission_id IN (${subIds});`);
  assert(okMgmt(r.status), "SQL HTTP");
  assert((r.body[0]?.c ?? 0) >= 1, `manager sees rows (got ${r.body[0]?.c})`);
});

test("§23 direct-write denial: authenticated INSERT/UPDATE/DELETE all fail", async () => {
  const mgr = process.env.ATLAS_STAGING_MANAGER_USER_ID;
  if (!mgr) throw new Error("manager id missing");
  const subId = [...state.submissionIds][0];
  const intId = [...state.intakeIds][0];
  // INSERT should be denied — RLS has no INSERT policy.
  const ins = await selectAsRole("manager", mgr,
    `INSERT INTO public.atlas_intake_graph_attachments (intake_message_id, submission_id, mailbox, graph_message_id, graph_attachment_id, attachment_type) VALUES ('${intId}','${subId}','mbx','gm','ga-tmp','fileAttachment') RETURNING id;`,
  );
  assert(ins.status >= 400 || (Array.isArray(ins.body) && ins.body.length === 0), `INSERT should be denied (got ${ins.status}: ${JSON.stringify(ins.body).slice(0,120)})`);
  // UPDATE should be denied.
  const upd = await selectAsRole("manager", mgr, `UPDATE public.atlas_intake_graph_attachments SET filename = 'HACKED' WHERE submission_id = '${subId}' RETURNING id;`);
  assert(upd.status >= 400 || (Array.isArray(upd.body) && upd.body.length === 0), `UPDATE should be denied (got ${upd.status})`);
  // DELETE should be denied.
  const del = await selectAsRole("manager", mgr, `DELETE FROM public.atlas_intake_graph_attachments WHERE submission_id = '${subId}' RETURNING id;`);
  assert(del.status >= 400 || (Array.isArray(del.body) && del.body.length === 0), `DELETE should be denied (got ${del.status})`);
  // Phase 5B RPC EXECUTE denied for authenticated.
  const rpcCall = await selectAsRole("manager", mgr, `SELECT public.atlas_intake_attachment_claim('00000000-0000-0000-0000-000000000000'::uuid, 'pending');`);
  assert(rpcCall.status >= 400 || (Array.isArray(rpcCall.body) && String(JSON.stringify(rpcCall.body)).includes("permission")), `RPC execute should be denied (got ${rpcCall.status}: ${JSON.stringify(rpcCall.body).slice(0,120)})`);
});

// ---------------------------------------------------------------------------
// §24 PII canary sweep
// ---------------------------------------------------------------------------

test("§24 PII canary sweep — searches SERIALISED VALUES for Phase 5B jobs (not just key names)", async () => {
  // Value-based canaries. Every fixture we created carried PREFIX in
  // multiple identifiers. If the runtime ever leaks any of them into a
  // Phase 5B-created atlas_jobs.metadata (e.g. as file_name, storage_path,
  // mailbox, graph_message_id, graph_attachment_id, content_id, subject,
  // sender, or body_preview), the substring appears in metadata::text and
  // this assertion fails. Checkpoint 4 §14 requires the gate to detect
  // leaks even when a leaking implementation uses the "correct" JSON key
  // name for a legitimate field but stuffs PII into it.
  const canary = PREFIX;

  // 1. Phase 5B-created atlas_jobs (discovery + ingest + the malware jobs
  //    they atomically enqueue). Ban ALL raw PII value fragments in
  //    metadata regardless of which key holds them.
  const badJobs = await sqlAdmin(`
    SELECT j.id, j.job_type, j.metadata
    FROM public.atlas_jobs j
    WHERE (
      -- Phase 5B-owned jobs by input_fingerprint namespace.
      j.job_type IN ('graph_attachment_discovery', 'graph_attachment_ingest')
      -- ...plus their downstream malware_scan jobs (fingerprint prefix).
      OR (j.job_type = 'malware_scan' AND j.input_fingerprint LIKE 'malware_scan:%'
          AND EXISTS (SELECT 1 FROM public.atlas_intake_graph_attachments a
                      WHERE a.scan_job_id = j.id))
    )
    AND (
      -- Any raw canary anywhere in the metadata blob (values or keys).
      j.metadata::text LIKE '%${canary}%'
      -- OR malware jobs whose file_name is anything other than the generic
      -- scanner label. Checkpoint 4 §13 fixes malware_scan metadata to
      -- always carry file_name = 'attachment.pdf'.
      OR (j.job_type = 'malware_scan' AND j.metadata->>'file_name' <> 'attachment.pdf')
    );
  `);
  assert(okMgmt(badJobs.status), "job metadata SQL");
  eq((badJobs.body || []).length, 0, `no PII in Phase 5B job metadata (got ${JSON.stringify(badJobs.body).slice(0,300)})`);

  // 2. atlas_audit_logs: raw canary substring must not appear inside any
  //    key that is legitimately allowed to carry text (subject, sender,
  //    body preview, filename, mailbox, Graph identifiers, content id).
  //    We still allow the canary inside *_hash keys (Phase 5A hashes carry
  //    the mailbox_hash seed by design).
  const nonHashHits = await sqlAdmin(`
    SELECT id FROM public.atlas_audit_logs
    WHERE (
      metadata_json ? 'subject'
      OR metadata_json ? 'body_preview'
      OR metadata_json ? 'sender_address'
      OR metadata_json ? 'sender_name'
      OR metadata_json ? 'filename'
      OR metadata_json ? 'file_name'
      OR metadata_json ? 'mailbox'
      OR metadata_json ? 'graph_message_id'
      OR metadata_json ? 'graph_attachment_id'
      OR metadata_json ? 'content_id'
    )
    AND metadata_json::text LIKE '%${canary}%';
  `);
  assert(okMgmt(nonHashHits.status), "non-hash audit SQL");
  eq((nonHashHits.body || []).length, 0, "no PII fields carry canary in audit");

  // 3. Alerts must not contain the canary at all — nothing we did should
  //    emit an alert.
  const alerts = await sqlAdmin(`SELECT id FROM public.atlas_operational_alerts WHERE metadata::text LIKE '%${canary}%';`);
  assert(okMgmt(alerts.status), "alerts SQL");
  eq((alerts.body || []).length, 0, "no PII in alert metadata");

  // 4. Raw sha256 hex must not appear anywhere in audit metadata — we only
  //    allow sha256_prefix12.
  const shaHits = await sqlAdmin(`SELECT count(*)::int AS c FROM public.atlas_audit_logs WHERE metadata_json::text ~* '[a-f0-9]{64}';`);
  assert(okMgmt(shaHits.status), "sha audit SQL");
  eq(shaHits.body[0]?.c, 0, "no raw sha256 in audit metadata");

  // 5. atlas_intake_graph_attachments.storage_path must NOT contain the
  //    original filename (§12). Storage path is ID-only.
  const badPaths = await sqlAdmin(`
    SELECT id FROM public.atlas_intake_graph_attachments
    WHERE storage_path IS NOT NULL
      AND storage_path LIKE '%${canary}%'
      AND storage_path NOT LIKE ('%/' || id::text || '.pdf');
  `);
  assert(okMgmt(badPaths.status), "storage_path SQL");
  eq((badPaths.body || []).length, 0, "storage_path is ID-only for Phase 5B rows");
});

// ---------------------------------------------------------------------------
// Cleanup + retained-audit report
// ---------------------------------------------------------------------------

async function cleanup() {
  // Attachment rows (cascade via submission delete would also do it, but be explicit).
  for (const id of state.attachmentIds) {
    await rest(`atlas_intake_graph_attachments?id=eq.${id}`, { method: "DELETE" });
  }
  // Jobs.
  for (const id of state.jobIds) {
    await rest(`atlas_jobs?id=eq.${id}`, { method: "DELETE" });
  }
  // Documents.
  for (const id of state.documentIds) {
    await rest(`atlas_documents?id=eq.${id}`, { method: "DELETE" });
  }
  // Submissions (cascades intake).
  for (const id of state.submissionIds) {
    await rest(`atlas_submissions?id=eq.${id}`, { method: "DELETE" });
  }
  // Retained audit count.
  const audit = await sqlAdmin(`SELECT count(*)::int AS c FROM public.atlas_audit_logs WHERE metadata_json::text LIKE '%${PREFIX}%';`);
  state.auditRetained = audit.body?.[0]?.c ?? 0;
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

let failed = 0;
for (const t of tests) {
  try { await t.fn(); console.log(`ok  ${t.name}`); }
  catch (err) { failed++; console.error(`FAIL ${t.name}`); console.error("  " + (err.message ?? err)); }
}

try {
  await cleanup();
  console.log(`\ncleanup: retained ${state.auditRetained} audit rows (compliance-durable)`);
} catch (err) {
  console.error(`cleanup error: ${err.message ?? err}`);
}

console.log(`\n${tests.length - failed}/${tests.length} passed`);
if (failed > 0) process.exit(1);
