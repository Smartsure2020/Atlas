// Phase 3 staging seeder — broker A, broker B, and readonly.
//
// Idempotent. Complements scripts/seed-staging-users.mjs (Phase 2 manager +
// UW_A/B/C/D). Never prints passwords, tokens, or keys.
//
// Required env (loaded from .env.staging):
//   SUPABASE_URL                 e.g. https://mnehddylkeelojsnkdtx.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY    staging service-role key
//   ATLAS_STAGING_USER_PASSWORD  shared throwaway password for staging test
//                                users (must match the password already on
//                                Phase 2 users so a single sign-in works).
//   ATLAS_STAGING_EMAIL_DOMAIN   default 'example.test'
//
// Hard rule: refuses execution if the resolved SUPABASE_URL is production.

import { createClient } from '@supabase/supabase-js';

const PROD_ATLAS_REF = 'algenlnxagpxzsgaworz';
const STAGING_ATLAS_REF = 'mnehddylkeelojsnkdtx';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const PASSWORD = process.env.ATLAS_STAGING_USER_PASSWORD;
const EMAIL_DOMAIN = process.env.ATLAS_STAGING_EMAIL_DOMAIN || 'example.test';

if (!SUPABASE_URL || !SERVICE_ROLE || !PASSWORD) {
  console.error(
    'Missing env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ATLAS_STAGING_USER_PASSWORD.',
  );
  process.exit(1);
}

if (SUPABASE_URL.includes(PROD_ATLAS_REF)) {
  console.error(
    `Refusing to run: SUPABASE_URL points at the production Atlas project ` +
      `(${PROD_ATLAS_REF}). This seeder is staging-only.`,
  );
  process.exit(1);
}

if (!SUPABASE_URL.includes(STAGING_ATLAS_REF)) {
  console.error(
    `Refusing to run: SUPABASE_URL does not name the expected staging ref ` +
      `(${STAGING_ATLAS_REF}). Aborting rather than seeding an unknown project.`,
  );
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const users = [
  {
    key: 'BROKER_A',
    email: `broker-a+staging@${EMAIL_DOMAIN}`,
    role: 'broker',
  },
  {
    key: 'BROKER_B',
    email: `broker-b+staging@${EMAIL_DOMAIN}`,
    role: 'broker',
  },
  {
    key: 'READONLY',
    email: `readonly+staging@${EMAIL_DOMAIN}`,
    role: 'readonly',
  },
];

async function findUserByEmail(email) {
  let page = 1;
  const perPage = 200;
  while (true) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage });
    if (error) throw error;
    const hit = data.users.find((u) => u.email?.toLowerCase() === email.toLowerCase());
    if (hit) return hit;
    if (data.users.length < perPage) return null;
    page += 1;
  }
}

async function ensureUser(spec) {
  const existing = await findUserByEmail(spec.email);
  if (existing) {
    const { error } = await supabase.auth.admin.updateUserById(existing.id, {
      password: PASSWORD,
      email_confirm: true,
      // atlas_role goes into app_metadata, which is trusted server-side
      // (the JWT carries it; the Worker + RLS read it there). Never write
      // authorisation to user_metadata — user_metadata is caller-writable
      // and MUST NOT be trusted.
      app_metadata: { atlas_role: spec.role, seeded_by: 'gate-phase3-seed' },
    });
    if (error) throw error;
    return { id: existing.id, created: false };
  }
  const { data, error } = await supabase.auth.admin.createUser({
    email: spec.email,
    password: PASSWORD,
    email_confirm: true,
    app_metadata: { atlas_role: spec.role, seeded_by: 'gate-phase3-seed' },
  });
  if (error) throw error;
  return { id: data.user.id, created: true };
}

const results = {};
for (const spec of users) {
  process.stdout.write(`  ${spec.key.padEnd(10)} ${spec.email.padEnd(40)} `);
  const { id, created } = await ensureUser(spec);
  results[spec.key] = id;
  console.log(`${created ? 'created' : 'updated'}  ${id}`);
}

console.log('\nDone.\n');
console.log('Paste into .env.staging:\n');
console.log(`ATLAS_STAGING_BROKER_A_USER_ID=${results.BROKER_A}`);
console.log(`ATLAS_STAGING_BROKER_B_USER_ID=${results.BROKER_B}`);
console.log(`ATLAS_STAGING_READONLY_USER_ID=${results.READONLY}`);
console.log('');
console.log('Ensure ATLAS_ALLOWLIST_JSON (staging Worker) includes:');
for (const spec of users) {
  console.log(`  "${spec.email}": "${spec.role}"`);
}
