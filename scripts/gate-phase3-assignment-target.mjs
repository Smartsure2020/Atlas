// Phase 3 staging gate — assignment target hardening.
//
// Tests the SECURITY DEFINER RPCs directly with service-role:
//   1. atlas_set_submission_assignment: broker/readonly targets return
//      target_not_assignable; consultant returns assigned; manager/admin
//      unchanged.
//   2. atlas_auto_assign_submission: an eligible broker profile must be
//      ignored (never selected); an eligible consultant profile IS selected.
//   3. Concurrency: two parallel auto_assign calls on the same submission
//      produce exactly one real assignment event; the second returns the
//      idempotent already_assigned or unchanged outcome.
//
// Refuses to run against production Supabase.

import { createClient } from '@supabase/supabase-js';

const PROD_ATLAS_REF = 'algenlnxagpxzsgaworz';
const STAGING_ATLAS_REF = 'mnehddylkeelojsnkdtx';

const {
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  ATLAS_STAGING_MANAGER_USER_ID: MANAGER,
  ATLAS_STAGING_UW_A_USER_ID: UW_A,
  ATLAS_STAGING_UW_B_USER_ID: UW_B,
  ATLAS_STAGING_UW_C_USER_ID: UW_C,
  ATLAS_STAGING_UW_D_USER_ID: UW_D,
  ATLAS_STAGING_BROKER_A_USER_ID: BROKER_A,
  ATLAS_STAGING_READONLY_USER_ID: READONLY,
} = process.env;

for (const [k, v] of Object.entries({ SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, MANAGER, UW_A, UW_B, BROKER_A, READONLY })) {
  if (!v) {
    console.error(`Missing env: ${k}`);
    process.exit(1);
  }
}
if (SUPABASE_URL.includes(PROD_ATLAS_REF)) {
  console.error(`Refusing: production project ${PROD_ATLAS_REF}.`);
  process.exit(1);
}
if (!SUPABASE_URL.includes(STAGING_ATLAS_REF)) {
  console.error(`Refusing: not staging ref ${STAGING_ATLAS_REF}.`);
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

const cleanup = [];

async function createSubmission(label, opts = {}) {
  const { data, error } = await svc
    .from('atlas_submissions')
    .insert({
      created_by: MANAGER,
      client_name: `GATE-P3-TARGET-${label}`,
      line_of_business: 'commercial',
      complexity: 'standard',
      pipeline_stage: 'triaged',
      broker_email: `gate-target+${label.toLowerCase()}@example.test`,
      ...opts,
    })
    .select('id')
    .single();
  if (error) throw new Error(`submission ${label}: ${error.message}`);
  cleanup.push({ table: 'atlas_submissions', id: data.id });
  return data.id;
}

async function upsertProfile(userId, profile) {
  const { error } = await svc
    .from('atlas_underwriter_profiles')
    .upsert({ user_id: userId, ...profile }, { onConflict: 'user_id' });
  if (error) throw error;
}

async function cleanupAll() {
  console.log('\nCleaning up GATE-P3-TARGET fixtures...');
  // Delete events/audit rows first
  for (const row of cleanup) {
    if (row.table !== 'atlas_submissions') continue;
    await svc.from('atlas_assignment_events').delete().eq('submission_id', row.id);
    await svc.from('atlas_audit_logs').delete().eq('submission_id', row.id);
    await svc.from('atlas_submissions').delete().eq('id', row.id);
  }
  // Restore broker profile removed at end (belt+braces)
  await svc.from('atlas_underwriter_profiles').delete().eq('user_id', BROKER_A);
  console.log('  done.');
}

process.on('SIGINT', async () => { try { await cleanupAll(); } finally { process.exit(1); } });

try {
  // -------------------------------------------------------------------------
  // Manual assignment targets
  // -------------------------------------------------------------------------
  console.log('\nManual assignment (atlas_set_submission_assignment):');

  {
    const SUB = await createSubmission('MANUAL-BROKER');
    const { data, error } = await svc.rpc('atlas_set_submission_assignment', {
      p_submission_id: SUB,
      p_assigned_to: BROKER_A,
      p_actor: MANAGER,
    });
    const outcome = data?.outcome ?? `error:${error?.code}`;
    record('broker target returns target_not_assignable', outcome === 'target_not_assignable', outcome);
  }
  {
    const SUB = await createSubmission('MANUAL-READONLY');
    const { data } = await svc.rpc('atlas_set_submission_assignment', {
      p_submission_id: SUB,
      p_assigned_to: READONLY,
      p_actor: MANAGER,
    });
    record('readonly target returns target_not_assignable',
      data?.outcome === 'target_not_assignable', data?.outcome);
  }
  {
    const SUB = await createSubmission('MANUAL-CONSULTANT');
    const { data } = await svc.rpc('atlas_set_submission_assignment', {
      p_submission_id: SUB,
      p_assigned_to: UW_A,
      p_actor: MANAGER,
    });
    record('consultant target returns assigned', data?.outcome === 'assigned', data?.outcome);
  }
  {
    const SUB = await createSubmission('MANUAL-MANAGER');
    const { data } = await svc.rpc('atlas_set_submission_assignment', {
      p_submission_id: SUB,
      p_assigned_to: MANAGER,
      p_actor: MANAGER,
    });
    record('manager target returns assigned (unchanged)',
      data?.outcome === 'assigned', data?.outcome);
  }

  // -------------------------------------------------------------------------
  // Auto-assignment: broker profile must be ignored
  // -------------------------------------------------------------------------
  console.log('\nAuto-assignment (atlas_auto_assign_submission):');

  // Seed an eligible broker profile that would otherwise rank first
  // (workload 0, capability match). If the broker filter works, it MUST
  // be ignored.
  await upsertProfile(BROKER_A, {
    active_for_assignment: true,
    can_take_personal: true,
    can_take_commercial: true,
    can_take_complex_commercial: true,
    weight: 10.0, // absurdly high — would win if considered
  });
  // Ensure a consultant is eligible too
  await upsertProfile(UW_A, {
    active_for_assignment: true,
    can_take_personal: true,
    can_take_commercial: true,
    can_take_complex_commercial: true,
    weight: 1.0,
  });

  {
    const SUB = await createSubmission('AUTO-1');
    const { data } = await svc.rpc('atlas_auto_assign_submission', {
      p_submission_id: SUB,
      p_actor: MANAGER,
    });
    record('auto-assign returns assigned', data?.outcome === 'assigned', data?.outcome);
    record('auto-assign never picks broker A',
      data?.assigned_to !== BROKER_A,
      `assigned_to=${data?.assigned_to}`);
    record('auto-assign picks a seeded consultant (UW_A/B/C/D)',
      [UW_A, UW_B, UW_C, UW_D].includes(data?.assigned_to),
      `assigned_to=${data?.assigned_to}`);
  }

  // -------------------------------------------------------------------------
  // Concurrency: two parallel auto-assign calls
  // -------------------------------------------------------------------------
  console.log('\nConcurrency:');
  {
    const SUB = await createSubmission('AUTO-CONCURRENT');
    const [r1, r2] = await Promise.all([
      svc.rpc('atlas_auto_assign_submission', { p_submission_id: SUB, p_actor: MANAGER }),
      svc.rpc('atlas_auto_assign_submission', { p_submission_id: SUB, p_actor: MANAGER }),
    ]);
    const outcomes = [r1.data?.outcome, r2.data?.outcome];
    const assignedCount = outcomes.filter((o) => o === 'assigned').length;
    const idempotentCount = outcomes.filter((o) => o === 'already_assigned' || o === 'unchanged').length;
    record('exactly one call returns assigned', assignedCount === 1, outcomes.join(','));
    record('the other returns already_assigned or unchanged', idempotentCount === 1, outcomes.join(','));

    // Verify exactly one auto_assigned event was recorded (advisory lock held).
    const { data: events } = await svc
      .from('atlas_assignment_events')
      .select('id, event_type')
      .eq('submission_id', SUB)
      .eq('event_type', 'auto_assigned');
    record('exactly one auto_assigned event exists',
      (events?.length ?? 0) === 1,
      `n=${events?.length}`);
  }

  // -------------------------------------------------------------------------
  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\nGate P3 assignment target: ${passed} passed, ${failed} failed out of ${results.length}`);
  await cleanupAll();
  process.exit(failed > 0 ? 1 : 0);
} catch (err) {
  console.error('\nFAILED:', err.message);
  await cleanupAll();
  process.exit(1);
}
