// Phase 3 staging gate — direct Supabase Data API RLS matrix for broker role.
//
// Creates GATE-prefixed fixtures (submission A owned by broker A,
// submission B owned by broker B, submission C owned/assigned to
// consultant) with enough related rows to test every table the broker
// role must not see, then asserts visibility as broker A, broker B,
// consultant, manager, and readonly.
//
// Runs against STAGING ONLY — hard production refusal on the URL ref.

import { createClient } from '@supabase/supabase-js';

const PROD_ATLAS_REF = 'algenlnxagpxzsgaworz';
const STAGING_ATLAS_REF = 'mnehddylkeelojsnkdtx';

const {
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
  SUPABASE_SERVICE_ROLE_KEY,
  ATLAS_STAGING_USER_PASSWORD: PASSWORD,
  ATLAS_STAGING_MANAGER_USER_ID: MANAGER,
  ATLAS_STAGING_UW_A_USER_ID: UW_A,
  ATLAS_STAGING_BROKER_A_USER_ID: BROKER_A,
  ATLAS_STAGING_BROKER_B_USER_ID: BROKER_B,
  ATLAS_STAGING_READONLY_USER_ID: READONLY,
  ATLAS_STAGING_EMAIL_DOMAIN = 'example.test',
} = process.env;

if (
  !SUPABASE_URL ||
  !SUPABASE_ANON_KEY ||
  !SUPABASE_SERVICE_ROLE_KEY ||
  !PASSWORD ||
  !MANAGER ||
  !UW_A ||
  !BROKER_A ||
  !BROKER_B ||
  !READONLY
) {
  console.error('Missing env: SUPABASE_URL/ANON/SERVICE_ROLE + PASSWORD + all *_USER_ID vars.');
  process.exit(1);
}

if (SUPABASE_URL.includes(PROD_ATLAS_REF)) {
  console.error(`Refusing to run against production project ${PROD_ATLAS_REF}.`);
  process.exit(1);
}
if (!SUPABASE_URL.includes(STAGING_ATLAS_REF)) {
  console.error(`Refusing to run against unknown project (expected ${STAGING_ATLAS_REF}).`);
  process.exit(1);
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
  return c;
}

// ---------------------------------------------------------------------------
// Fixture setup — service role
// ---------------------------------------------------------------------------

async function createSubmission(created_by, assigned_to, label) {
  const { data, error } = await svc
    .from('atlas_submissions')
    .insert({
      created_by,
      assigned_to,
      client_name: `GATE-P3-${label}`,
      line_of_business: 'commercial',
      complexity: 'standard',
      pipeline_stage: 'triaged',
      broker_email: `gate-p3+${label.toLowerCase()}@${ATLAS_STAGING_EMAIL_DOMAIN}`,
      broker_email_body: `GATE-P3 raw broker email body ${label}`,
    })
    .select('id')
    .single();
  if (error) throw new Error(`fixture ${label}: ${error.message}`);
  return data.id;
}

async function seedChildRows(SUB, actor, label) {
  const rows = [];
  const push = async (table, values) => {
    const { data, error } = await svc.from(table).insert(values).select('id').single();
    if (error) throw new Error(`${table} for ${label}: ${error.message}`);
    rows.push({ table, id: data.id });
    return data.id;
  };
  await push('atlas_documents', {
    submission_id: SUB,
    file_name: `GATE-P3-${label}.pdf`,
    storage_path: `${SUB}/gate.pdf`,
    document_type: 'other',
    status: 'active',
    scan_status: 'clean',
    uploaded_by: actor,
    file_size_bytes: 100,
    content_type: 'application/pdf',
  });
  const extId = await push('atlas_extractions', {
    submission_id: SUB,
    extracted_json: { GATE_P3: label, secret: 'internal-underwriting' },
    reviewed_json: null,
    extraction_confidence: 0.8,
    missing_fields_json: [],
    red_flags_json: [],
  });
  const recId = await push('atlas_recommendations', {
    submission_id: SUB,
    extraction_id: extId,
    recommended_insurer: `GATE-P3-${label}`,
    secondary_options_json: [],
    not_recommended_json: [],
    reasoning_json: { top: { insurer_name: `GATE-P3-${label}` } },
    confidence_score: 0.9,
    referral_required: false,
    senior_review_required: false,
  });
  const qrId = await push('atlas_quote_reviews', {
    submission_id: SUB,
    recommendation_id: recId,
    overall_outcome: `GATE-P3-${label}-outcome`,
    overall_confidence: 0.9,
    status: 'draft',
    review_snapshot: { gate: 'phase3', label },
    created_by: actor,
  });
  await push('atlas_quote_review_sections', {
    quote_review_id: qrId,
    section_key: 'coverage',
    section_name: 'Coverage',
    status: 'ok',
    confidence: 0.9,
  });
  await push('atlas_decisions', {
    submission_id: SUB,
    quote_review_id: qrId,
    selected_insurer: `GATE-P3-${label}`,
    decision_status: 'ready_for_quote',
    decided_by: actor,
    decided_at: new Date().toISOString(),
  });
  await push('atlas_communications', {
    submission_id: SUB,
    communication_type: 'internal_note',
    audience: 'internal',
    subject: `GATE-P3-${label}`,
    body: 'internal underwriting note',
    status: 'draft',
  });
  await push('atlas_missing_info_items', {
    submission_id: SUB,
    item_type: 'underwriting_info',
    title: `GATE-P3-${label} missing`,
    status: 'open',
    source: 'extraction',
    owner: 'broker',
  });
  await push('atlas_audit_logs', {
    submission_id: SUB,
    action: `gate_p3_${label.toLowerCase()}_seed`,
    actor,
    metadata_json: { gate: 'phase3' },
  });
  await push('atlas_assignment_events', {
    submission_id: SUB,
    from_user_id: null,
    to_user_id: actor,
    actor_user_id: MANAGER,
    event_type: 'manual_assigned',
    assignment_source: 'manual',
  });
  return rows;
}

const cleanup = [];
async function cleanupAll() {
  console.log('\nCleaning up GATE-P3 fixtures...');
  // Delete in reverse dependency order — child rows first.
  const childTables = [
    'atlas_assignment_events',
    'atlas_audit_logs',
    'atlas_missing_info_items',
    'atlas_communications',
    'atlas_quote_review_sections',
    'atlas_quote_reviews',
    'atlas_decisions',
    'atlas_recommendations',
    'atlas_extractions',
    'atlas_documents',
  ];
  for (const t of childTables) {
    for (const row of cleanup.filter((r) => r.table === t)) {
      await svc.from(t).delete().eq('id', row.id);
    }
  }
  for (const row of cleanup.filter((r) => r.table === 'atlas_submissions')) {
    await svc.from('atlas_submissions').delete().eq('id', row.id);
  }
  console.log('  GATE-P3 fixture rows removed.');
}

process.on('exit', () => {});
process.on('SIGINT', async () => { try { await cleanupAll(); } finally { process.exit(1); } });

// ---------------------------------------------------------------------------
// Live matrix
// ---------------------------------------------------------------------------

try {
  console.log('\nCreating fixtures...');
  const SUB_A = await createSubmission(BROKER_A, null, 'A');
  const SUB_B = await createSubmission(BROKER_B, null, 'B');
  const SUB_C = await createSubmission(UW_A, UW_A, 'C');
  cleanup.push({ table: 'atlas_submissions', id: SUB_A });
  cleanup.push({ table: 'atlas_submissions', id: SUB_B });
  cleanup.push({ table: 'atlas_submissions', id: SUB_C });
  console.log(`  A ${SUB_A}  B ${SUB_B}  C ${SUB_C}`);

  cleanup.push(...(await seedChildRows(SUB_A, BROKER_A, 'A')));
  cleanup.push(...(await seedChildRows(SUB_B, BROKER_B, 'B')));
  cleanup.push(...(await seedChildRows(SUB_C, UW_A, 'C')));

  // -------------------------------------------------------------------------
  // Broker A visibility
  // -------------------------------------------------------------------------
  console.log('\nBroker A direct Data API:');
  const brokerA = await signIn(`broker-a+staging@${ATLAS_STAGING_EMAIL_DOMAIN}`);

  async function count(client, table, filter = (q) => q) {
    const q = filter(client.from(table).select('id', { count: 'exact', head: true }));
    const { count: n, error } = await q;
    return { n: n ?? 0, error };
  }

  {
    const { n } = await count(brokerA, 'atlas_submissions', (q) => q.eq('id', SUB_A));
    record('broker A sees submission A', n === 1);
  }
  {
    const { n } = await count(brokerA, 'atlas_submissions', (q) => q.eq('id', SUB_B));
    record('broker A cannot see submission B', n === 0);
  }
  {
    const { n } = await count(brokerA, 'atlas_submissions', (q) => q.eq('id', SUB_C));
    record('broker A cannot see submission C', n === 0);
  }
  {
    const { n } = await count(brokerA, 'atlas_documents', (q) => q.eq('submission_id', SUB_A));
    record('broker A sees A documents', n >= 1);
  }
  {
    const { n } = await count(brokerA, 'atlas_missing_info_items', (q) => q.eq('submission_id', SUB_A));
    record('broker A sees A missing-info rows', n >= 1);
  }
  {
    const { n } = await count(brokerA, 'atlas_audit_logs', (q) => q.eq('submission_id', SUB_A));
    record('broker A sees A audit rows', n >= 1);
  }
  {
    const { n } = await count(brokerA, 'atlas_assignment_events', (q) => q.eq('submission_id', SUB_A));
    record('broker A sees A assignment events', n >= 1);
  }
  {
    const { n } = await count(brokerA, 'atlas_extractions', (q) => q.eq('submission_id', SUB_A));
    record('broker A cannot see A extraction', n === 0);
  }
  {
    const { n } = await count(brokerA, 'atlas_recommendations', (q) => q.eq('submission_id', SUB_A));
    record('broker A cannot see A recommendation', n === 0);
  }
  {
    const { n } = await count(brokerA, 'atlas_decisions', (q) => q.eq('submission_id', SUB_A));
    record('broker A cannot see A decision', n === 0);
  }
  {
    const { n } = await count(brokerA, 'atlas_quote_reviews', (q) => q.eq('submission_id', SUB_A));
    record('broker A cannot see A quote review', n === 0);
  }
  {
    const { n } = await count(brokerA, 'atlas_quote_review_sections');
    record('broker A cannot see any quote review section', n === 0);
  }
  {
    const { n } = await count(brokerA, 'atlas_communications', (q) => q.eq('submission_id', SUB_A));
    record('broker A cannot see A internal communications', n === 0);
  }
  {
    const { n } = await count(brokerA, 'atlas_insurers');
    record('broker A cannot see insurers', n === 0);
  }
  {
    const { n } = await count(brokerA, 'atlas_insurer_appetite');
    record('broker A cannot see insurer appetite', n === 0);
  }
  {
    const { n } = await count(brokerA, 'atlas_underwriter_profiles');
    record('broker A cannot see underwriter profiles', n === 0);
  }
  {
    const { n } = await count(brokerA, 'atlas_pilot_issues');
    record('broker A cannot see pilot issues', n === 0);
  }
  {
    const { n } = await count(brokerA, 'atlas_jobs');
    record('broker A cannot see jobs', n === 0);
  }
  {
    const { n } = await count(brokerA, 'atlas_operational_alerts');
    record('broker A cannot see operational alerts', n === 0);
  }
  {
    // Ensure broker A cannot see audit rows outside their own case.
    const { n } = await count(brokerA, 'atlas_audit_logs', (q) => q.eq('submission_id', SUB_B));
    record('broker A cannot see unrelated audit rows', n === 0);
  }
  {
    const { n } = await count(brokerA, 'atlas_assignment_events', (q) => q.eq('submission_id', SUB_B));
    record('broker A cannot see unrelated assignment events', n === 0);
  }

  // Broker mutations must fail on protected tables.
  {
    const { error } = await brokerA.from('atlas_extractions').insert({
      submission_id: SUB_A,
      extracted_json: { hack: true },
    });
    record('broker A cannot INSERT into atlas_extractions', Boolean(error), error?.code ?? '');
  }
  {
    const { error } = await brokerA.from('atlas_recommendations').insert({
      submission_id: SUB_A,
      extraction_id: null,
      ranked_json: [],
      reasoning_json: {},
      referral_required: false,
    });
    record('broker A cannot INSERT into atlas_recommendations', Boolean(error), error?.code ?? '');
  }
  {
    const { error } = await brokerA.from('atlas_decisions').insert({
      submission_id: SUB_A,
      selected_insurer: 'X',
      outcome: 'placed',
      decided_by: BROKER_A,
      decided_at: new Date().toISOString(),
    });
    record('broker A cannot INSERT into atlas_decisions', Boolean(error), error?.code ?? '');
  }
  {
    const { error } = await brokerA.from('atlas_insurers').insert({ name: 'GATE-P3' });
    record('broker A cannot INSERT into atlas_insurers', Boolean(error), error?.code ?? '');
  }
  {
    // Update on own submission — RLS UPDATE policy requires staff.
    const { error } = await brokerA
      .from('atlas_submissions')
      .update({ pipeline_stage: 'in_progress' })
      .eq('id', SUB_A);
    // Not all errors surface as `error`; if update silently no-ops, verify the row didn't change.
    const { data } = await svc.from('atlas_submissions').select('pipeline_stage').eq('id', SUB_A).single();
    record('broker A cannot UPDATE atlas_submissions', data?.pipeline_stage === 'triaged', `stage=${data?.pipeline_stage}`);
  }
  {
    const { error } = await brokerA.rpc('atlas_auto_assign_submission', {
      p_submission_id: SUB_A,
      p_actor: BROKER_A,
    });
    record('broker A cannot EXECUTE atlas_auto_assign_submission', Boolean(error), error?.code ?? '');
  }
  {
    const { error } = await brokerA.rpc('atlas_set_submission_assignment', {
      p_submission_id: SUB_A,
      p_assigned_to: BROKER_A,
      p_actor: BROKER_A,
    });
    record('broker A cannot EXECUTE atlas_set_submission_assignment', Boolean(error), error?.code ?? '');
  }

  // -------------------------------------------------------------------------
  // Broker B isolation
  // -------------------------------------------------------------------------
  console.log('\nBroker B direct Data API:');
  const brokerB = await signIn(`broker-b+staging@${ATLAS_STAGING_EMAIL_DOMAIN}`);
  {
    const { n } = await count(brokerB, 'atlas_submissions', (q) => q.eq('id', SUB_A));
    record('broker B cannot see broker A submission', n === 0);
  }
  {
    const { n } = await count(brokerB, 'atlas_submissions', (q) => q.eq('id', SUB_B));
    record('broker B sees own submission B', n === 1);
  }

  // -------------------------------------------------------------------------
  // Consultant regression
  // -------------------------------------------------------------------------
  console.log('\nConsultant regression:');
  const uwA = await signIn(`uw-a+staging@${ATLAS_STAGING_EMAIL_DOMAIN}`);
  {
    const { n } = await count(uwA, 'atlas_submissions', (q) => q.eq('id', SUB_C));
    record('consultant sees own submission C', n === 1);
  }
  {
    const { n } = await count(uwA, 'atlas_extractions', (q) => q.eq('submission_id', SUB_C));
    record('consultant sees underwriting intelligence on C', n >= 1);
  }

  // -------------------------------------------------------------------------
  // Manager regression
  // -------------------------------------------------------------------------
  console.log('\nManager regression:');
  const mgr = await signIn(`manager+staging@${ATLAS_STAGING_EMAIL_DOMAIN}`);
  {
    const { n } = await count(mgr, 'atlas_submissions', (q) => q.in('id', [SUB_A, SUB_B, SUB_C]));
    record('manager sees all three submissions', n === 3);
  }

  // -------------------------------------------------------------------------
  // Readonly regression
  // -------------------------------------------------------------------------
  console.log('\nReadonly regression:');
  const ro = await signIn(`readonly+staging@${ATLAS_STAGING_EMAIL_DOMAIN}`);
  {
    const { n } = await count(ro, 'atlas_submissions', (q) => q.in('id', [SUB_A, SUB_B, SUB_C]));
    record('readonly can read submissions', n === 3);
  }
  {
    const { error } = await ro.from('atlas_extractions').insert({
      submission_id: SUB_C,
      extracted_json: { hack: true },
    });
    record('readonly cannot INSERT into atlas_extractions', Boolean(error), error?.code ?? '');
  }

  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\nGate P3 RLS: ${passed} passed, ${failed} failed out of ${results.length}`);
  await cleanupAll();
  process.exit(failed > 0 ? 1 : 0);
} catch (err) {
  console.error('\nFAILED:', err.message);
  await cleanupAll();
  process.exit(1);
}
