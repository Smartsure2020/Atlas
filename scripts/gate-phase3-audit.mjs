// Phase 3 corrective staging gate — broker audit history sanitisation.
//
// Creates a temporary broker-owned submission with audit rows covering:
//   - safe operational events
//   - recommendation_run (with top_insurer metadata)
//   - quote_review_run
//   - decision_accepted
//   - extraction_run
//   - communication_saved
//   - future_synthetic_action (unknown / not yet allow-listed)
//
// Then asserts:
//   - Direct Data API as broker A sees ONLY safe rows (not the unsafe ones).
//   - Worker GET /audit as broker A: same allow-list, metadata scrubbed,
//     no forbidden tokens, another broker's case still 404.
//   - Manager control (Worker) still receives every row with raw metadata.
//
// Refuses to run against the production Supabase project.

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
  ATLAS_STAGING_EMAIL_DOMAIN = 'example.test',
} = process.env;

for (const [k, v] of Object.entries({
  SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, PASSWORD, WORKER_URL,
  MANAGER, UW_A, BROKER_A, BROKER_B,
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

// ---------------------------------------------------------------------------
// Setup: broker A owns SUB_A; broker B owns SUB_B (for negative test)
// ---------------------------------------------------------------------------

async function createSubmission(created_by, label) {
  const { data, error } = await svc.from('atlas_submissions').insert({
    created_by,
    client_name: `GATE-P3-AUDIT-${label}`,
    line_of_business: 'commercial',
    complexity: 'standard',
    pipeline_stage: 'triaged',
    broker_email: `gate-audit+${label.toLowerCase()}@${ATLAS_STAGING_EMAIL_DOMAIN}`,
  }).select('id').single();
  if (error) throw new Error(`submission ${label}: ${error.message}`);
  return data.id;
}

async function seedAudit(submissionId, actor, action, metadata) {
  const { error } = await svc.from('atlas_audit_logs').insert({
    submission_id: submissionId,
    actor,
    action,
    metadata_json: metadata,
  });
  if (error) throw new Error(`audit ${action}: ${error.message}`);
}

const cleanup = [];

try {
  console.log('\nSeeding fixtures...');
  const SUB_A = await createSubmission(BROKER_A, 'A');
  const SUB_B = await createSubmission(BROKER_B, 'B');
  cleanup.push(SUB_A, SUB_B);

  // Safe operational events on SUB_A
  await seedAudit(SUB_A, BROKER_A, 'submission_created', { has_pasted_email: true });
  await seedAudit(SUB_A, BROKER_A, 'document_uploaded', {
    document_id: 'doc-1', document_type: 'policy', file_name: 'policy.pdf',
    expires_at: '2026-09-30T09:00:00Z', file_hash_present: true, scan_status: 'pending',
  });
  await seedAudit(SUB_A, MANAGER, 'submission_queue_status_changed', { queue_status: 'waiting_info' });
  await seedAudit(SUB_A, UW_A, 'missing_info_added', {
    item_id: 'mi-1', quote_review_id: 'qr-1', item_type: 'underwriting_info', owner: 'broker',
  });
  // Unsafe underwriting-intelligence events on SUB_A
  await seedAudit(SUB_A, UW_A, 'extraction_run', {
    extraction_id: 'ext-42', overall_confidence: 0.82, pipeline_mode: 'hybrid',
    route: 'azure', escalated_field_count: 3,
  });
  await seedAudit(SUB_A, UW_A, 'recommendation_run', {
    recommendation_id: 'rec-9', extraction_id: 'ext-42', top_insurer: 'Bryte Insurance',
    top_score: 0.91, referral_required: false, senior_review_required: false,
    manual_review_required: false, insurers_considered: 6, reasoning_source: 'deterministic',
  });
  await seedAudit(SUB_A, UW_A, 'quote_review_run', {
    quote_review_id: 'qr-11', recommendation_id: 'rec-9', insurer_id: 'ins-3', status: 'draft',
  });
  await seedAudit(SUB_A, UW_A, 'decision_accepted', {
    selected_insurer: 'Bryte Insurance', selected_insurer_id: 'ins-3',
    recommendation_id: 'rec-9', quote_review_id: 'qr-11',
    decision_status: 'ready_for_quote', decision_choice: 'accepted',
    ai_recommendation_was: 'Bryte Insurance',
  });
  await seedAudit(SUB_A, UW_A, 'communication_saved', {
    communication_type: 'internal_note', audience: 'internal', quote_review_id: 'qr-11',
  });
  await seedAudit(SUB_A, UW_A, 'future_new_underwriting_event_v2', {
    top_insurer: 'Naked', overall_confidence: 0.55, selected_insurer: 'Naked',
  });

  // -----------------------------------------------------------------------
  // Direct Data API as broker A
  // -----------------------------------------------------------------------
  console.log('\nDirect Data API — broker A:');
  const { client: brokerAClient, token: brokerAToken } = await signIn(`broker-a+staging@${ATLAS_STAGING_EMAIL_DOMAIN}`);
  const { data: rows, error: rowsErr } = await brokerAClient
    .from('atlas_audit_logs')
    .select('id, action, actor, metadata_json')
    .eq('submission_id', SUB_A);
  if (rowsErr) throw new Error(`broker A audit select: ${rowsErr.message}`);
  const seenActions = new Set((rows ?? []).map((r) => r.action));

  const mustSee = ['submission_created', 'document_uploaded', 'submission_queue_status_changed', 'missing_info_added'];
  const mustNotSee = ['extraction_run', 'recommendation_run', 'quote_review_run',
    'decision_accepted', 'communication_saved', 'future_new_underwriting_event_v2'];
  for (const a of mustSee) record(`direct: broker sees ${a}`, seenActions.has(a));
  for (const a of mustNotSee) record(`direct: broker cannot see ${a}`, !seenActions.has(a));

  // -----------------------------------------------------------------------
  // Worker GET /audit — broker A
  // -----------------------------------------------------------------------
  console.log('\nWorker GET /audit — broker A:');
  const workerRes = await api(brokerAToken, `/api/submissions/${SUB_A}/audit`);
  record('broker A GET /audit returns 200', workerRes.status === 200);
  const events = workerRes.body?.events ?? [];
  const workerActions = new Set(events.map((e) => e.action));
  for (const a of mustSee) record(`worker: broker sees ${a}`, workerActions.has(a));
  for (const a of mustNotSee) record(`worker: broker cannot see ${a}`, !workerActions.has(a));

  const workerBodyText = JSON.stringify(workerRes.body ?? {});
  const forbiddenTokens = [
    'top_insurer', 'top_score', 'selected_insurer', 'insurer_id', 'recommendation_id',
    'quote_review_id', 'overall_confidence', 'pipeline_mode', 'reasoning_source',
    'extraction_id', 'ai_recommendation_was', 'decision_status', 'decision_choice',
    'Bryte Insurance', 'Naked',
  ];
  for (const t of forbiddenTokens) {
    record(`worker: no leak "${t}"`, !workerBodyText.includes(t));
  }
  record('worker: every broker event has metadata=null',
    events.length > 0 && events.every((e) => e.metadata === null),
    `n=${events.length}`);

  // Another broker's case must remain 404
  const other = await api(brokerAToken, `/api/submissions/${SUB_B}/audit`);
  record('broker A GET other case /audit returns 404', other.status === 404);

  // -----------------------------------------------------------------------
  // Manager control
  // -----------------------------------------------------------------------
  console.log('\nWorker GET /audit — manager control:');
  const { token: mgrToken } = await signIn(`manager+staging@${ATLAS_STAGING_EMAIL_DOMAIN}`);
  const mgrRes = await api(mgrToken, `/api/submissions/${SUB_A}/audit`);
  record('manager GET /audit returns 200', mgrRes.status === 200);
  const mgrEvents = mgrRes.body?.events ?? [];
  const mgrActions = new Set(mgrEvents.map((e) => e.action));
  for (const a of [...mustSee, ...mustNotSee]) {
    record(`manager sees ${a}`, mgrActions.has(a));
  }
  const rec = mgrEvents.find((e) => e.action === 'recommendation_run');
  record('manager sees recommendation_run.metadata.top_insurer',
    rec?.metadata?.top_insurer === 'Bryte Insurance',
    JSON.stringify(rec?.metadata ?? null).slice(0, 100));

  // -----------------------------------------------------------------------
  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\nGate P3 audit hardening: ${passed} passed, ${failed} failed out of ${results.length}`);

  console.log('\nCleaning up GATE-P3-AUDIT fixtures...');
  for (const id of cleanup) {
    await svc.from('atlas_audit_logs').delete().eq('submission_id', id);
    await svc.from('atlas_submissions').delete().eq('id', id);
  }
  console.log('  done.');
  process.exit(failed > 0 ? 1 : 0);
} catch (err) {
  console.error('\nFAILED:', err.message);
  for (const id of cleanup) {
    await svc.from('atlas_audit_logs').delete().eq('submission_id', id).catch(() => {});
    await svc.from('atlas_submissions').delete().eq('id', id).catch(() => {});
  }
  process.exit(1);
}
