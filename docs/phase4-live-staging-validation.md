# Phase 4 live staging validation

Runs the Phase 4 API and security gate against an operator-pinned, immutable
staging Worker version. Emits a concise human summary and a JSON report at
`.test-artifacts/phase4-live-staging-report.json`.

**Staging only.** The validator refuses to run if any URL supplied via env
resolves to the production Supabase project.

## What it verifies

- Environment / project binding proof (JWT `iss` matches staging; Worker
  accepts a staging-validated manager JWT on `/api/submissions`)
- Six-role token preflight (`atlas_role` claim matches the JWT's env slot)
- Workload access matrix (manager 200; consultant / underwriter / readonly /
  brokers 403) and workload semantics (`by_line` sums, terminal exclusions,
  no `weight`, no raw `app_metadata`)
- Quick endpoint scope matrix (internal roles reach the internal fixture;
  brokers only reach their own record; cross-owner reads return 404, never
  a body that discloses another submission)
- Read-only invariant on the internal fixture across repeated
  `GET /api/submissions/:id/quick` and `GET /api/pipeline/workload`
  (requires service-role read)
- Quick Capture API smoke (create as manager, create as broker A, uniqueness,
  broker B cannot preview broker A's new case, readonly rejected)
- Adversarial field protection on quick-capture create (server refuses
  caller-forced `created_by` and `pipeline_stage`; DB-verified when
  service-role is available)
- Adversarial HTTP (broker workload spoofs, malformed IDs, non-existent
  stage-mutation routes)
- Cleanup of the validator's own `GATE-P4-<runId>-*` fixtures
- Fatal / overall-result consistency (any preflight, safety, gate, or
  cleanup failure forces `overall_api_gate=FAIL` with a matching non-zero
  `process_exit_code`, `fatal_stage`, and `fatal_error_class`)

Browser-only guarantees (Quick Capture double-click / cancel-reset,
responsive layout, keyboard a11y, console/network review) are validated
separately in a real browser against the same immutable Worker version.

## Required env

Names only — never commit or paste the values.

- `ATLAS_CANDIDATE_SHA` — full SHA of the Worker source under test
- `ATLAS_WORKER_URL` — Worker preview URL for that exact version
- `ATLAS_STAGING_SUPABASE_URL` — must be `https://mnehddylkeelojsnkdtx.supabase.co`
- `ATLAS_STAGING_SUPABASE_ANON_KEY` — staging anon key
- `ATLAS_JWT_MANAGER`
- `ATLAS_JWT_CONSULTANT`
- `ATLAS_JWT_UNDERWRITER`
- `ATLAS_JWT_READONLY`
- `ATLAS_JWT_BROKER_A`
- `ATLAS_JWT_BROKER_B`

## Optional env

- `ATLAS_JWT_ADMIN` — enables the admin row of the workload access matrix
- `ATLAS_STAGING_SERVICE_ROLE_KEY` — enables the read-only invariant and the
  adversarial-persistence verification (`SKIPPED_NEEDS_STAGING_SERVICE_ROLE`
  otherwise)
- `ATLAS_FIXTURE_INTERNAL_ID` — an internal-owned staging submission whose
  `assigned_to` and `assigned_underwriter` match the consultant and
  underwriter JWTs (skipped otherwise: `SKIPPED_NO_INTERNAL_FIXTURE` for the
  invariant, `SKIPPED_NO_FIXTURES` for the quick matrix)
- `ATLAS_FIXTURE_BROKER_A_ID` — a `created_by=broker_a` staging submission
- `ATLAS_FIXTURE_BROKER_B_ID` — a `created_by=broker_b` staging submission

Fixture identity variables are supplied only when the operator has already
seeded controlled `GATE-P4-*` synthetic submissions. Do not guess. Do not
point them at real business records.

## Staging Worker requirements

The pinned Worker version must be uploaded with these `[vars]` (see
`worker/wrangler.staging.toml`):

```toml
ATLAS_ENV = "staging"
ATLAS_STRICT_ACCESS_SCOPING = "true"
```

`ATLAS_STRICT_ACCESS_SCOPING="true"` is required for production-like
non-broker scoping — without it, `canViewAllSubmissions()` returns `true`
for internal roles and cross-owner reads leak, which fails the quick
endpoint matrix's `consultant -> unrelated broker_a` assertion.

The five Cloudflare secrets — `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
`SUPABASE_ANON_KEY`, `ANTHROPIC_API_KEY`, `ATLAS_ALLOWLIST_JSON` — must be
bound on the Worker; the validator's environment-proof stage returns 503 if
any is missing.

## Running

```bash
node scripts/gate-phase4-live-staging.mjs
```

Every required variable is read from `process.env`. Pass them in through a
wrapper (never on argv). The validator prints a summary and writes the
report; it never prints tokens or keys.

## Safety

- Never run against production Supabase. The forbidden project ref
  (`algenlnxagpxzsgaworz`) is checked on every URL-shaped env, on the JWT
  `iss` claim, and on the report itself; any hit is a hard refusal with
  exit code `2`.
- Never commit JWTs, refresh tokens, magic-link URLs, anon keys,
  service-role keys, or `ATLAS_JWT_*` values.
- Use only `GATE-P4-*` synthetic submissions as test fixtures. The
  validator cleans its own `GATE-P4-<runId>-*` records; pre-seeded fixtures
  supplied via `ATLAS_FIXTURE_*` are the operator's responsibility.

## Exit codes

- `0` — all runnable API gates pass; only `SKIPPED_NEEDS_STAGING_SERVICE_ROLE`
  or browser-only items were skipped
- `1` — test failure
- `2` — environment or production-safety refusal
- `3` — credential preflight failure
- `4` — cleanup incomplete

Exit code and `overall_api_gate` are always consistent: any non-zero exit
sets `overall_api_gate=FAIL` in the report, and any failing runnable gate
raises the exit code to at least `1`.
