// Phase 3 final corrective staging gate — broker audit is Worker-only.
//
// After migration 0027 a broker signed in directly against Supabase must
// receive ZERO atlas_audit_logs rows regardless of submission ownership,
// actor identity, action, or metadata.
//
// Worker GET /audit for broker must continue returning approved operational
// events with metadata:null and internal actor identity withheld. Internal
// roles (manager/consultant/readonly) keep their existing behaviour.
//
// Refuses to run against production.

import { createClient } from '@supabase/supabase-js';

const PROD_ATLAS_REF = 'algenlnxagpxzsgaworz';
const STAGING_ATLAS_REF = 'mnehddylkeelojsnkdtx';

const {
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
  SUPABASE_SERVICE_ROLE_KEY,
  ATLAS_STAGING_USER_PASSWORD: PASSWORD,
  ATLAS_STAGING_WORKER_URL: WORKER_URL,
  ATLAS_STAGING_MANAGER_USER_ID: MANAGER,
  ATLAS_STAGING_UW_A_USER_ID: UW_A,
  ATLAS_STAGING_BROKER_A_USER_ID: BROKER_A,
  ATLAS_STAGING_BROKER_B_USER_ID: BROKER_B,
  ATLAS_STAGING_READONLY_USER_ID: READONLY,
  ATLAS_STAGING_EMAIL_DOMAIN = 'example.test',
} = process.env;

for (const [k, v] of Object.entries({
  SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, PASSWORD, WORKER_URL,
  MANAGER, UW_A, BROKER_A, BROKER_B, READONLY,
})) {
  if (!v) { console.error(`Missing env: ${k}`); process.exit(1); }
}
if (SUPABASE_URL.includes(PROD_ATLAS_REF)) {
  console.error(`Refusing: production project ${PROD_ATLAS_REF}.`); process.exit(1);
}
if (!SUPABASE_URL.includes(STAGING_ATLAS_REF)) {
  console.error(`Refusing: not staging ref ${STAGING_ATLAS_REF}.`); process.exit(1);
}
if (/atlas-worker(?!-staging)/.test(WORKER_URL)) {
  console.error(`Refusing: not staging worker (${WORKER_URL}).`); process.exit(1);
}

const svc = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const results = [];
function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}
async function signIn(email) {
  const c = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data, error } = await c.auth.signInWithPassword({ email, password: PASSWORD });
  if (error) throw new Error(`sign-in ${email}: ${error.message}`);
  return { client: c, token: data.session.access_token };
}
async function api(token, path, init = {}) {
  const res = await fetch(`${WORKER_URL}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...(init.headers || {}),
    },
  });
  let body = null;
  try { body = await res.json(); } catch {}
  return { status: res.status, body };
}

async function createSubmission(created_by, label) {
  const { data, error } = await svc.from('atlas_submissions').insert({
    created_by,
    client_name: `GATE-P3-AUDIT2-${label}`,
    line_of_business: 'commercial',
    complexity: 'standard',
    pipeline_stage: 'triaged',
    broker_email: `gate-audit2+${label.toLowerCase()}@${ATLAS_STAGING_EMAIL_DOMAIN}`,
  }).select('id').single();
  if (error) throw new Error(`submission ${label}: ${error.message}`);
  return data.id;
}

async function seedAudit(submissionId, actor, action, metadata) {
  const { data, error } = await svc.from('atlas_audit_logs').insert({
    submission_id: submissionId,
    actor,
    action,
    metadata_json: metadata,
  }).select('id').single();
  if (error) throw new Error(`audit ${action}: ${error.message}`);
  return data.id;
}

const cleanupSubs = [];
const cleanupAuditIds = [];

try {
  console.log('\nSeeding fixtures...');
  const SUB_A = await createSubmission(BROKER_A, 'A');
  const SUB_B = await createSubmission(BROKER_B, 'B');
  const SUB_C = await createSubmission(UW_A, 'C');
  cleanupSubs.push(SUB_A, SUB_B, SUB_C);

  // Full row set on SUB_A — allow-listed + unsafe + unknown
  // NB: internal-role fixture rows use MANAGER as the actor so the
  // consultant regression below tests submission-scope only (UW_A is not
  // the actor, so the staff own-actor branch does not fire).
  const seeded = [
    ['submission_created', BROKER_A, { has_pasted_email: true }],
    ['document_uploaded', BROKER_A, {
      document_id: 'doc-1', document_type: 'policy', file_name: 'policy.pdf', scan_status: 'pending',
    }],
    ['submission_queue_status_changed', MANAGER, { queue_status: 'waiting_info' }],
    ['missing_info_added', MANAGER, {
      item_id: 'mi-1', quote_review_id: 'qr-1', item_type: 'underwriting_info', owner: 'broker',
    }],
    ['extraction_run', MANAGER, {
      extraction_id: 'ext-42', overall_confidence: 0.82, pipeline_mode: 'hybrid',
    }],
    ['recommendation_run', MANAGER, {
      recommendation_id: 'rec-9', top_insurer: 'Bryte Insurance', top_score: 0.91,
    }],
    ['quote_review_run', MANAGER, {
      quote_review_id: 'qr-11', recommendation_id: 'rec-9', insurer_id: 'ins-3',
    }],
    ['decision_accepted', MANAGER, {
      selected_insurer: 'Bryte Insurance', decision_status: 'ready_for_quote',
    }],
    ['communication_saved', MANAGER, {
      communication_type: 'internal_note', audience: 'internal', quote_review_id: 'qr-11',
    }],
    ['future_new_underwriting_event_v2', MANAGER, { top_insurer: 'Naked' }],
  ];
  for (const [action, actor, meta] of seeded) {
    await seedAudit(SUB_A, actor, action, meta);
  }
  // Also seed an actor-owned NON-submission audit row where broker A is the actor
  // (some other case's row). This tests the actor-scoped branch is also gone.
  const nonSubId = await seedAudit(SUB_C, BROKER_A, 'sign_in', { source: 'gate-audit2' });
  cleanupAuditIds.push(nonSubId);

  // -----------------------------------------------------------------------
  // Direct Data API — broker MUST see ZERO rows
  // -----------------------------------------------------------------------
  console.log('\nDirect Data API — broker A (expect zero rows):');
  const { client: brokerAClient, token: brokerAToken } = await signIn(`broker-a+staging@${ATLAS_STAGING_EMAIL_DOMAIN}`);
  {
    const { data, error } = await brokerAClient
      .from('atlas_audit_logs')
      .select('id, action, actor, metadata_json')
      .eq('submission_id', SUB_A);
    record('broker A cannot SELECT own-case audit rows', !error && (data?.length ?? 0) === 0,
      error ? error.message : `n=${data?.length}`);
  }
  {
    // Try filtering by actor = own id (broker A's sign_in row)
    const { data, error } = await brokerAClient
      .from('atlas_audit_logs')
      .select('id, action')
      .eq('actor', BROKER_A);
    record('broker A cannot SELECT own actor-scoped audit rows', !error && (data?.length ?? 0) === 0,
      error ? error.message : `n=${data?.length}`);
  }
  {
    // Unbounded query — full RLS block check
    const { data, error } = await brokerAClient
      .from('atlas_audit_logs')
      .select('id')
      .limit(1);
    record('broker A cannot SELECT any atlas_audit_logs rows', !error && (data?.length ?? 0) === 0,
      error ? error.message : `n=${data?.length}`);
  }

  // Broker mutations still forbidden (invariant preservation)
  {
    const { error } = await brokerAClient.from('atlas_audit_logs').insert({
      submission_id: SUB_A, action: 'gate_p3_hack', actor: BROKER_A,
    });
    record('broker A cannot INSERT into atlas_audit_logs', Boolean(error), error?.code ?? '');
  }
  {
    // Same as DELETE — without an UPDATE policy the rows are invisible to
    // UPDATE too, so the statement no-ops silently. Verify by reading a
    // canonical row's action back via service role after the attempt.
    const sentinelAction = 'submission_created';
    const { error } = await brokerAClient
      .from('atlas_audit_logs').update({ action: 'x' })
      .eq('submission_id', SUB_A).eq('action', sentinelAction);
    const { data: check } = await svc
      .from('atlas_audit_logs').select('action')
      .eq('submission_id', SUB_A).eq('action', sentinelAction).limit(1).maybeSingle();
    record('broker A UPDATE against atlas_audit_logs mutates zero rows',
      !error && check?.action === sentinelAction,
      `check_action=${check?.action ?? 'null'} err=${error?.code ?? ''}`);
  }
  {
    // Without a DELETE policy the row is invisible to the DELETE too, so
    // Postgres returns "0 rows affected" with no error. The invariant is
    // "broker cannot remove rows", so verify row count via service role.
    const before = await svc.from('atlas_audit_logs').select('id', { count: 'exact', head: true }).eq('submission_id', SUB_A);
    const { error } = await brokerAClient.from('atlas_audit_logs').delete().eq('submission_id', SUB_A);
    const after = await svc.from('atlas_audit_logs').select('id', { count: 'exact', head: true }).eq('submission_id', SUB_A);
    record('broker A DELETE against atlas_audit_logs removes zero rows',
      !error && (before.count ?? 0) === (after.count ?? -1) && (after.count ?? 0) > 0,
      `before=${before.count} after=${after.count} err=${error?.code ?? ''}`);
  }

  // -----------------------------------------------------------------------
  // Worker GET /audit — broker A must still receive approved history
  // -----------------------------------------------------------------------
  console.log('\nWorker GET /audit — broker A (approved history preserved):');
  const workerRes = await api(brokerAToken, `/api/submissions/${SUB_A}/audit`);
  record('broker A Worker GET /audit returns 200', workerRes.status === 200);
  const events = workerRes.body?.events ?? [];
  const workerActions = new Set(events.map((e) => e.action));

  const mustSee = ['submission_created', 'document_uploaded', 'submission_queue_status_changed', 'missing_info_added'];
  const mustNotSee = ['extraction_run', 'recommendation_run', 'quote_review_run',
    'decision_accepted', 'communication_saved', 'future_new_underwriting_event_v2'];
  for (const a of mustSee) record(`worker: broker sees ${a}`, workerActions.has(a));
  for (const a of mustNotSee) record(`worker: broker cannot see ${a}`, !workerActions.has(a));

  const workerBodyText = JSON.stringify(workerRes.body ?? {});
  const forbidden = [
    'top_insurer', 'top_score', 'selected_insurer', 'insurer_id', 'recommendation_id',
    'quote_review_id', 'overall_confidence', 'pipeline_mode', 'reasoning_source',
    'extraction_id', 'ai_recommendation_was', 'decision_status', 'Bryte Insurance', 'Naked',
  ];
  for (const t of forbidden) {
    record(`worker: no leak "${t}"`, !workerBodyText.includes(t));
  }
  record('worker: every broker event has metadata=null',
    events.length > 0 && events.every((e) => e.metadata === null),
    `n=${events.length}`);
  record('worker: internal-staff actor withheld',
    events.filter((e) => e.action === 'submission_queue_status_changed' || e.action === 'missing_info_added')
      .every((e) => e.actor_id === null && e.actor_email === null),
    `n_internal=${events.filter((e) => e.action === 'submission_queue_status_changed' || e.action === 'missing_info_added').length}`);
  record("worker: broker's own actor stays identifiable",
    events.filter((e) => e.action === 'submission_created' || e.action === 'document_uploaded')
      .every((e) => e.actor_id === BROKER_A),
    `n_own=${events.filter((e) => e.action === 'submission_created' || e.action === 'document_uploaded').length}`);

  const other = await api(brokerAToken, `/api/submissions/${SUB_B}/audit`);
  record('broker A GET other case /audit returns 404', other.status === 404);

  // -----------------------------------------------------------------------
  // Manager control — full audit unchanged (Worker and direct)
  // -----------------------------------------------------------------------
  console.log('\nManager control:');
  const { client: mgrClient, token: mgrToken } = await signIn(`manager+staging@${ATLAS_STAGING_EMAIL_DOMAIN}`);
  const mgrWorker = await api(mgrToken, `/api/submissions/${SUB_A}/audit`);
  const mgrEvents = mgrWorker.body?.events ?? [];
  const mgrActions = new Set(mgrEvents.map((e) => e.action));
  for (const a of [...mustSee, ...mustNotSee]) {
    record(`manager Worker sees ${a}`, mgrActions.has(a));
  }
  const rec = mgrEvents.find((e) => e.action === 'recommendation_run');
  record('manager Worker sees recommendation_run.metadata.top_insurer',
    rec?.metadata?.top_insurer === 'Bryte Insurance');

  {
    const { data, error } = await mgrClient
      .from('atlas_audit_logs')
      .select('id, action, metadata_json')
      .eq('submission_id', SUB_A);
    record('manager direct Data API still sees all rows', !error && (data?.length ?? 0) >= 10,
      error ? error.message : `n=${data?.length}`);
    const gotRec = data?.find((r) => r.action === 'recommendation_run');
    record('manager direct: recommendation metadata still present',
      gotRec?.metadata_json?.top_insurer === 'Bryte Insurance');
  }

  // -----------------------------------------------------------------------
  // Consultant control — existing submission-scope semantics
  // -----------------------------------------------------------------------
  console.log('\nConsultant control:');
  const { client: uwAClient } = await signIn(`uw-a+staging@${ATLAS_STAGING_EMAIL_DOMAIN}`);
  {
    const { data, error } = await uwAClient
      .from('atlas_audit_logs')
      .select('id, action')
      .eq('submission_id', SUB_C);
    record('consultant sees own-scoped submission audit rows', !error && (data?.length ?? 0) >= 1,
      error ? error.message : `n=${data?.length}`);
  }
  {
    // Consultant cannot see broker A's submission (they are not created_by / assigned)
    const { data, error } = await uwAClient
      .from('atlas_audit_logs')
      .select('id, action')
      .eq('submission_id', SUB_A);
    record('consultant cannot see out-of-scope submission audit rows',
      !error && (data?.length ?? 0) === 0,
      error ? error.message : `n=${data?.length}`);
  }

  // -----------------------------------------------------------------------
  // Readonly control — full audit visibility unchanged (in atlas_role IN clause)
  // -----------------------------------------------------------------------
  console.log('\nReadonly control:');
  const { client: roClient } = await signIn(`readonly+staging@${ATLAS_STAGING_EMAIL_DOMAIN}`);
  {
    const { data, error } = await roClient
      .from('atlas_audit_logs')
      .select('id, action')
      .eq('submission_id', SUB_A);
    record('readonly still reads audit rows on SUB_A', !error && (data?.length ?? 0) >= 10,
      error ? error.message : `n=${data?.length}`);
  }
  {
    const { error } = await roClient.from('atlas_audit_logs').insert({
      submission_id: SUB_A, action: 'gate_p3_hack', actor: READONLY,
    });
    record('readonly cannot INSERT audit rows', Boolean(error), error?.code ?? '');
  }

  // -----------------------------------------------------------------------
  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\nGate P3 audit-lockdown: ${passed} passed, ${failed} failed out of ${results.length}`);

  console.log('\nCleaning up GATE-P3-AUDIT2 fixtures...');
  for (const id of cleanupAuditIds) {
    await svc.from('atlas_audit_logs').delete().eq('id', id);
  }
  for (const id of cleanupSubs) {
    await svc.from('atlas_audit_logs').delete().eq('submission_id', id);
    await svc.from('atlas_submissions').delete().eq('id', id);
  }
  console.log('  done.');
  process.exit(failed > 0 ? 1 : 0);
} catch (err) {
  console.error('\nFAILED:', err.message);
  for (const id of cleanupAuditIds) {
    await svc.from('atlas_audit_logs').delete().eq('id', id).catch(() => {});
  }
  for (const id of cleanupSubs) {
    await svc.from('atlas_audit_logs').delete().eq('submission_id', id).catch(() => {});
    await svc.from('atlas_submissions').delete().eq('id', id).catch(() => {});
  }
  process.exit(1);
}
