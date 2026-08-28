// Phase 3 staging gate — live Worker API matrix for the broker role.
//
// Hits the deployed staging Worker as broker A / broker B / consultant /
// manager. Asserts the observable HTTP behaviour that the broker role
// contract promises.
//
// Refuses to run if the URL names the production Supabase ref or the
// production Worker.

import { createClient } from '@supabase/supabase-js';

const PROD_ATLAS_REF = 'algenlnxagpxzsgaworz';
const STAGING_ATLAS_REF = 'mnehddylkeelojsnkdtx';

const {
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
  ATLAS_STAGING_USER_PASSWORD: PASSWORD,
  ATLAS_STAGING_WORKER_URL: WORKER_URL,
  ATLAS_STAGING_EMAIL_DOMAIN = 'example.test',
  ATLAS_STAGING_BROKER_A_USER_ID: BROKER_A,
  ATLAS_STAGING_BROKER_B_USER_ID: BROKER_B,
  ATLAS_STAGING_UW_A_USER_ID: UW_A,
  ATLAS_STAGING_MANAGER_USER_ID: MANAGER,
} = process.env;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !PASSWORD || !WORKER_URL || !BROKER_A || !BROKER_B || !UW_A || !MANAGER) {
  console.error('Missing env: SUPABASE_URL/ANON, PASSWORD, WORKER_URL, and all *_USER_ID vars.');
  process.exit(1);
}
if (SUPABASE_URL.includes(PROD_ATLAS_REF)) {
  console.error(`Refusing: SUPABASE_URL is production (${PROD_ATLAS_REF}).`);
  process.exit(1);
}
if (!SUPABASE_URL.includes(STAGING_ATLAS_REF)) {
  console.error(`Refusing: SUPABASE_URL not staging (expected ${STAGING_ATLAS_REF}).`);
  process.exit(1);
}
if (/atlas-worker(?!-staging)/.test(WORKER_URL)) {
  console.error(`Refusing: WORKER_URL does not appear to be staging (${WORKER_URL}).`);
  process.exit(1);
}

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
  return data.session.access_token;
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
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

function leakCheck(body) {
  const text = JSON.stringify(body ?? {});
  // Adversarial substring check: no raw SQL/PostgREST/stack fragments.
  return !/PGRST|postgrest|syntax error|\bstack\b|at Object\./i.test(text);
}

// -----------------------------------------------------------------------
// Sessions
// -----------------------------------------------------------------------
const brokerAToken = await signIn(`broker-a+staging@${ATLAS_STAGING_EMAIL_DOMAIN}`);
const brokerBToken = await signIn(`broker-b+staging@${ATLAS_STAGING_EMAIL_DOMAIN}`);
const uwAToken = await signIn(`uw-a+staging@${ATLAS_STAGING_EMAIL_DOMAIN}`);
const mgrToken = await signIn(`manager+staging@${ATLAS_STAGING_EMAIL_DOMAIN}`);

// -----------------------------------------------------------------------
// Fixture submissions: create one owned by broker A, one by broker B,
// one owned by consultant (via broker B creation path won't work — use
// signed-in consultant instead).
// -----------------------------------------------------------------------

console.log('\nSeeding gate submissions via Worker POST...');

async function createOne(token, label) {
  const res = await api(token, '/api/submissions', {
    method: 'POST',
    body: JSON.stringify({
      broker_name: `GATE-P3-API-${label}`,
      client_name: `GATE-P3-API-${label} client`,
      request_type: 'Test',
      line_of_business: 'commercial',
    }),
  });
  if (res.status !== 201 || !res.body?.id) {
    throw new Error(`create ${label}: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body.id;
}

const SUB_A = await createOne(brokerAToken, 'A');
const SUB_B = await createOne(brokerBToken, 'B');
const SUB_C = await createOne(uwAToken, 'C');
console.log(`  A ${SUB_A}  B ${SUB_B}  C ${SUB_C}`);

const created = [SUB_A, SUB_B, SUB_C];

// -----------------------------------------------------------------------
// Broker A API matrix
// -----------------------------------------------------------------------
console.log('\nBroker A API:');

{
  const r = await api(brokerAToken, '/api/submissions');
  record('broker A GET /api/submissions returns 200', r.status === 200);
  const ids = (r.body?.submissions ?? []).map((s) => s.id);
  record('broker A list contains own case A', ids.includes(SUB_A));
  record('broker A list excludes broker B case', !ids.includes(SUB_B));
  record('broker A list excludes consultant case', !ids.includes(SUB_C));
  const activeJobs = (r.body?.submissions ?? []).map((s) => s.active_job);
  record('broker A list: every active_job is null', activeJobs.every((j) => j === null),
    activeJobs.length ? `n=${activeJobs.length}` : '');
  record('broker A list body is leak-free', leakCheck(r.body));
}
{
  const r = await api(brokerAToken, `/api/submissions/${SUB_A}`);
  record('broker A GET own submission returns 200', r.status === 200);
  record('broker A GET own: extraction=null', r.body?.extraction === null);
  record('broker A GET own: jobs=null', r.body?.jobs === null);
  record('broker A GET own: broker_email_body=null',
    r.body?.submission?.broker_email_body === null);
}
{
  const r = await api(brokerAToken, `/api/submissions/${SUB_B}`);
  record('broker A GET broker B submission returns 404', r.status === 404);
}
{
  const r = await api(brokerAToken, `/api/submissions/${SUB_C}`);
  record('broker A GET consultant submission returns 404', r.status === 404);
}
{
  // Broker cannot inject assignment fields.
  const r = await api(brokerAToken, '/api/submissions', {
    method: 'POST',
    body: JSON.stringify({
      broker_name: 'GATE-P3-inject',
      client_name: 'GATE-P3-inject',
      assigned_to: MANAGER,
      assigned_underwriter: MANAGER,
    }),
  });
  record('broker A cannot inject assigned_to on POST', r.status === 403,
    `status=${r.status}`);
}
{
  const r = await api(brokerAToken, '/api/uploads/sign', {
    method: 'POST',
    body: JSON.stringify({
      submission_id: SUB_A,
      file_name: 'gate.pdf',
      content_type: 'application/pdf',
      size_bytes: 1024,
    }),
  });
  record('broker A POST uploads/sign own case returns 200', r.status === 200);
}
{
  const r = await api(brokerAToken, '/api/uploads/sign', {
    method: 'POST',
    body: JSON.stringify({
      submission_id: SUB_B,
      file_name: 'gate.pdf',
      content_type: 'application/pdf',
      size_bytes: 1024,
    }),
  });
  record('broker A POST uploads/sign other case returns 404', r.status === 404);
}
{
  const r = await api(brokerAToken, '/api/uploads/confirm', {
    method: 'POST',
    body: JSON.stringify({
      submission_id: SUB_B,
      file_name: 'gate.pdf',
      storage_path: `${SUB_B}/gate.pdf`,
      content_type: 'application/pdf',
      size_bytes: 1024,
    }),
  });
  record('broker A POST uploads/confirm other case returns 404', r.status === 404);
}
{
  const r = await api(brokerAToken, `/api/submissions/${SUB_A}/assignment`, {
    method: 'PATCH',
    body: JSON.stringify({ assigned_to: BROKER_A }),
  });
  record('broker A PATCH assignment returns 403', r.status === 403);
}
{
  const r = await api(brokerAToken, `/api/submissions/${SUB_A}/assignment/auto`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
  record('broker A POST assignment/auto returns 403', r.status === 403);
}
for (const path of [
  ['/recommendation', 'recommendation'],
  ['/quote-review', 'quote review'],
  ['/quote-review-history', 'quote review history'],
  ['/decision', 'decision'],
  ['/communications', 'communications'],
]) {
  const r = await api(brokerAToken, `/api/submissions/${SUB_A}${path[0]}`);
  record(`broker A GET ${path[1]} returns 403`, r.status === 403);
}
{
  const r = await api(brokerAToken, '/api/insurers');
  record('broker A GET /api/insurers returns 403', r.status === 403);
}
{
  const r = await api(brokerAToken, `/api/submissions/${SUB_A}/pilot`, {
    method: 'PATCH',
    body: JSON.stringify({ pilot_flag: true }),
  });
  record('broker A PATCH pilot returns 403', r.status === 403);
}
{
  const r = await api(brokerAToken, `/api/submissions/${SUB_A}/pilot-issues`);
  record('broker A GET pilot-issues returns 403', r.status === 403);
}
{
  const r = await api(brokerAToken, `/api/submissions/${SUB_A}/missing-info`);
  record('broker A GET own missing-info returns 200', r.status === 200);
}
{
  const r = await api(brokerAToken, `/api/submissions/${SUB_A}/audit`);
  record('broker A GET own audit returns 200', r.status === 200);
}
{
  const r = await api(brokerAToken, `/api/submissions/${SUB_A}/assignment-history`);
  record('broker A GET own assignment-history returns 200', r.status === 200);
}
{
  const r = await api(brokerAToken, `/api/submissions/${SUB_B}/missing-info`);
  record('broker A GET other missing-info returns 404', r.status === 404);
}
{
  const r = await api(brokerAToken, `/api/submissions/${SUB_B}/audit`);
  record('broker A GET other audit returns 404', r.status === 404);
}
{
  const r = await api(brokerAToken, `/api/submissions/${SUB_B}/assignment-history`);
  record('broker A GET other assignment-history returns 404', r.status === 404);
}

// -----------------------------------------------------------------------
// Manager sanity — internal role must still see all + get active_job field
// -----------------------------------------------------------------------
console.log('\nManager regression:');
{
  const r = await api(mgrToken, '/api/submissions');
  record('manager GET /api/submissions returns 200', r.status === 200);
  const rows = r.body?.submissions ?? [];
  // active_job may be null (no in-flight job) but the FIELD must be present.
  const allHaveField = rows.every((row) => Object.prototype.hasOwnProperty.call(row, 'active_job'));
  record('manager list rows carry active_job field', allHaveField);
}
{
  const r = await api(mgrToken, `/api/submissions/${SUB_A}`);
  record('manager GET broker A submission returns 200', r.status === 200);
  record('manager GET has jobs field (may be null)',
    'jobs' in r.body || r.body?.jobs === null);
}

// -----------------------------------------------------------------------
// Broker B isolation via Worker
// -----------------------------------------------------------------------
console.log('\nBroker B API isolation:');
{
  const r = await api(brokerBToken, `/api/submissions/${SUB_A}`);
  record('broker B GET broker A submission returns 404', r.status === 404);
}

// -----------------------------------------------------------------------
// Cleanup (via service role, in a separate script; here we leave the
// GATE-P3-API-* rows and log ids so the RLS gate teardown can remove them.
// -----------------------------------------------------------------------
console.log('\nCreated ids to clean up (append to service-role cleanup):');
for (const id of created) console.log(`  ${id}`);

const passed = results.filter((r) => r.ok).length;
const failed = results.filter((r) => !r.ok).length;
console.log(`\nGate P3 Worker API: ${passed} passed, ${failed} failed out of ${results.length}`);
if (failed > 0) process.exit(1);
