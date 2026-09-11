# Atlas — Phase 6 production cutover runbook

Purpose: bring Microsoft Graph mailbox intake into production for a single
canary mailbox, then extend cautiously. Everything in this runbook is
**operator-run**. Nothing here is automated by Atlas.

Read this end-to-end before executing any step. Every gate lists a
verification and a rollback; do not advance without both.

---

## 0. Prerequisites

1. `main` at or newer than the Phase 6 Checkpoint 1 merge SHA.
2. `worker/wrangler.toml` production section does NOT contain
   `ATLAS_MALWARE_SCANNER_URL` as a var. If it does, stop — a placeholder
   was re-introduced. Fix in-repo before continuing.
3. Snapshots (or a verified backup) of both Supabase projects taken
   immediately before the window:
   - production: `algenlnxagpxzsgaworz`
   - staging:    `mnehddylkeelojsnkdtx`
4. Nobody else is deploying `atlas-worker-production` during the window.
5. On-call engineer standing by. `ATLAS_ALERT_WEBHOOK_URL` wired to the
   real paging destination (verify a manual test alert lands).

## 1. Production migration inventory

Confirm every Phase 5A/5B/6 migration is applied to production BEFORE
enabling anything.

### Read-only inventory (preferred: Supabase CLI, deliberately linked)

```
supabase link --project-ref algenlnxagpxzsgaworz
supabase migration list
```

Confirm the remote column lists 0028, 0029, 0030, 0031, 0032, 0033,
0034, 0035, 0036. `supabase migration list` reads the CLI's own remote
history table (`supabase_migrations.schema_migrations`) — the correct
source of truth. Do NOT rely on ad-hoc `select version from
public.supabase_migrations`; that table name is not part of the
supported inventory contract.

### Read-only inventory (equivalent SQL, if the CLI is unavailable)

```sql
select version
  from supabase_migrations.schema_migrations
 order by version;
```

Confirm 0028–0036 all present.

### If any of 0028–0036 are missing

Apply the missing files in numeric order, in ONE maintenance window,
using `supabase db push` (or the team's normal Supabase migration
tooling). No manual SQL. No ad-hoc DDL. No mutation of migration
history — forward-only.

### Migration-aware post-apply validation

Every check below runs read-only. Skip any check whose migration is
not yet applied.

**After 0028 (intake schema baseline):**

```sql
select count(*) from public.atlas_submission_intake_messages;
select count(*) from public.atlas_intake_graph_state;
```

Both must return `0`. Non-zero would mean someone has written to the
intake tables before Graph is enabled — STOP and investigate.

Confirm RLS is enabled:

```sql
select tablename, rowsecurity
  from pg_tables
 where schemaname = 'public'
   and tablename in ('atlas_submission_intake_messages',
                     'atlas_intake_graph_state');
```

Both rows must show `rowsecurity = true`.

**After 0032 (Phase 5B attachment schema):**

```sql
select count(*) from public.atlas_intake_graph_attachments;

select tablename, rowsecurity
  from pg_tables
 where schemaname = 'public'
   and tablename = 'atlas_intake_graph_attachments';
```

Count = 0; `rowsecurity = true`.

**After 0036 (Phase 6 reset floor):**

```sql
-- reset_floor column present on state row
select column_name, data_type, is_nullable
  from information_schema.columns
 where table_schema = 'public'
   and table_name   = 'atlas_intake_graph_state'
   and column_name  = 'reset_floor';

-- atomic success RPC present with expected signature
select p.proname, pg_get_function_identity_arguments(p.oid) as args
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and p.proname = 'atlas_intake_release_lease_success_with_floor';

-- service_role holds EXECUTE; public / authenticated / anon must NOT
select r.rolname,
       has_function_privilege(r.rolname,
         'public.atlas_intake_release_lease_success_with_floor(text,uuid,text,boolean,text,boolean,timestamptz,jsonb,timestamptz,boolean)',
         'EXECUTE') as can_exec
  from pg_roles r
 where r.rolname in ('service_role', 'authenticated', 'anon', 'public');
```

Expected: reset_floor column present as `timestamp with time zone`,
nullable. The RPC row must be present exactly once. Only `service_role`
returns `can_exec = true`; the others must be false.

### Rollback (migrations)

If a migration errors, the DBA restores from the snapshot taken in §0.
The intake tables are additive — no user data lives there yet.

## 2. Malware scanner acceptance in STAGING

Do this BEFORE turning anything on in production. The Phase 5B staging
acceptance ran under `scanner = development_bypass`; that is not proof
the pipeline works with a real scanner.

1. Point staging's `ATLAS_MALWARE_SCANNER_URL` + `ATLAS_MALWARE_SCANNER_TOKEN`
   at the real scanner via `wrangler secret put --env staging`.
2. Upload one clean PDF via `/api/uploads/sign` → `/api/uploads/confirm`.
   Expected:
   - `atlas_documents.scan_status = 'clean'`
   - `atlas_audit_logs.action = 'malware_scan_completed'` with
     `metadata_json.bypassed = false`
3. Upload one EICAR-in-PDF (or the scanner vendor's approved test file).
   Expected:
   - `atlas_documents.scan_status = 'infected'`, `status = 'expired'`
   - Storage object removed from `atlas-client-docs`
   - `atlas_operational_alerts` row of type `malware_detected` created

Only after BOTH pass do we authorise the production scanner secret.

## 3. Production Worker deploy — Graph OFF

Before running `wrangler deploy --env production`:

1. Set the real production scanner secrets:
   ```
   wrangler secret put ATLAS_MALWARE_SCANNER_URL   --env production
   wrangler secret put ATLAS_MALWARE_SCANNER_TOKEN --env production
   ```
   Both must resolve to a real hostname. Atlas refuses to serve requests
   if the URL contains a placeholder token (`yourcompany`, `example.com`,
   `placeholder`, `changeme`, `todo`, `replace-me`) — see
   `phase6-hardening.validateEnv`.

2. Confirm the following secrets are NOT set in production (Graph must
   stay off):
   - `ATLAS_GRAPH_INTAKE_ENABLED`
   - `ATLAS_GRAPH_TENANT_ID`
   - `ATLAS_GRAPH_CLIENT_ID`
   - `ATLAS_GRAPH_CLIENT_SECRET`
   - `ATLAS_GRAPH_MAILBOXES_JSON`
   - `ATLAS_GRAPH_MAILBOX_CUTOVERS_JSON`

3. `wrangler deploy --env production`.

Verification:

- `GET https://<prod-origin>/api/health` returns 200.
- No `atlas_operational_alerts` rows created in the 30 minutes after deploy.
- Cron runs every minute but does no Graph work (see `scheduled()` handler:
  `runGraphIntakeCycleForEnv` returns immediately when the flag is off).

Rollback: `wrangler rollback --env production` (previous Worker version).

## 4. Production malware smoke test

With the Worker deployed and Graph still off, perform ONE end-to-end
upload through the staff UI:

1. Sign in as an admin.
2. Create a submission.
3. Upload a small clean PDF.
4. Wait for the scheduled malware_scan job to complete.

Expected: `scan_status = 'clean'`, `metadata_json.bypassed = false` in the
malware_scan_completed audit event. If `bypassed = true` appears at any
point in production, STOP — the scanner env fell through the
development-bypass path, which Phase 6 forbids.

## 5. Exchange App RBAC — canary mailbox scoping

This step is IT/Exchange work, not Atlas work. Atlas cannot verify it
itself; the operator must obtain authoritative proof from Exchange
Online RBAC for Applications that the intake service principal can
reach only the approved resources.

Requirements:

- The Atlas Graph intake service principal must have ONLY the
  Application `Mail.Read` role (not `Mail.ReadWrite`, not `Mail.Send`).
- The role assignment must use an Exchange Online RBAC for Applications
  resource scope. This may be the existing scoped structure IT has
  already approved for Atlas — direct mailbox, management scope, or
  scoped role group are all acceptable, as long as the effective set of
  addressable recipients is only the approved canary target(s).
- Do NOT grant tenant-wide Entra `Mail.Read` application consent (no
  `resource.grant` at directory level, no admin consent broadening the
  scope beyond the mailboxes IT has approved).

Authoritative scope proof (Exchange administrator to perform):

Run `Test-ServicePrincipalAuthorization` from the Exchange Online
management shell for both the approved resource and a known
out-of-scope resource. Confirm the expected in-scope decision:

```
Test-ServicePrincipalAuthorization -Identity <atlas-intake-sp> -Resource <canary mailbox>
    -> Application Mail.Read : InScope = True

Test-ServicePrincipalAuthorization -Identity <atlas-intake-sp> -Resource <known out-of-scope mailbox>
    -> Application Mail.Read : InScope = False
```

Both lines are required.

Optional direct Graph proof:

- Using the intake service principal, request a message list for the
  approved canary mailbox via the Graph API sandbox. Expected: HTTP 2xx.
- Repeat for a known out-of-scope mailbox. Expected: ANY inaccessible /
  non-2xx outcome (403 OR 404, or an equivalent scope-rejection error).
  Do not assume a specific status code — Microsoft's response varies
  depending on the tenant configuration and the scope shape in use.

If either the InScope test or the Graph proof shows unexpected access,
STOP. Do not configure Atlas.

## 6. Set the forward-only cutover timestamp

Choose a fixed UTC ISO 8601 timestamp AFTER the moment the canary
mailbox is ready to be watched — typically the start of the next
business day. This becomes the boundary Atlas never crosses backwards.

### Microsoft Graph 5,000-message filtered-delta consideration

Microsoft Graph documents that applying `$filter` to `messages/delta`
returns **at most ~5,000 messages total** for that filtered
enumeration. `@odata.nextLink` continues **within** the filtered result
set, but pagination does **not** raise the total ceiling. If the
filter would match more than ~5,000 messages, results beyond the
ceiling are not returned.

Operational rule — the operator picks the cutover so that the number
of Inbox messages received since that timestamp is comfortably below
the ceiling. Conservative preflight before setting the secret:

```
# Adjust <mailbox> and <cutover> to the intended values. Requires an
# authenticated Graph session with Mail.Read on the mailbox.
GET https://graph.microsoft.com/v1.0/users/<mailbox>/mailFolders/Inbox/messages/$count
    ?$filter=receivedDateTime ge <cutover>
```

- Result ≤ ~3,000 → safe. Proceed to §7.
- Result 3,000 – 5,000 → borderline. Prefer a later cutover with
  operational headroom.
- Result > 5,000 → STOP. Do NOT enable Graph for that mailbox with the
  planned cutover; pick a later timestamp. Do NOT attempt to work
  around the ceiling with historical backfill — Phase 6 policy is
  forward-only.

**Delta-token resets** (HTTP 410, `syncStateNotFound` /
`syncStateInvalid`) do not replay from the original cutover forever.
Migration 0036 adds a durable per-mailbox `reset_floor` that is
monotonically advanced — atomically, in the same Postgres transaction
as the delta cursor commit — after each fully-completed delta round to
`poll_start_time - 24h`. It is never advanced on `ok_resumable`
partial rounds, and is never derived from `Date.now()` at the reset
itself. On a 410, Atlas restarts the initial URL from:

```
effective_reset_boundary = max(configured_cutover, reset_floor)
```

The configured cutover is immutable; the reset floor may advance only
after a fully-committed complete round. The floor never precedes the
configured cutover. See `computeResetFloorAdvance` and
`readResetFloor` in `worker/src/graph-intake.ts`.

If a subsequent 410 recovery window would still exceed the ~5,000-
message ceiling after the floor has advanced, the operator should
pause polling and reassess. The reset-floor design keeps the recovery
window bounded but does not remove Microsoft's ceiling.

```
wrangler secret put ATLAS_GRAPH_MAILBOX_CUTOVERS_JSON --env production
```

Value (single-line JSON):

```json
{"canary@yourdomain.co.za":"2026-09-20T06:00:00.000Z"}
```

Contract:
- Value MUST be strict ISO 8601 UTC form: `YYYY-MM-DDTHH:MM:SS(.sss)Z`.
  Timezone offsets and locale strings are refused by `isValidCutoverIso`.
- Missing or malformed entries in production cause `pollMailbox` to
  return `status="skipped_cutover_missing"` and raise
  `atlas_operational_alerts.alert_type = graph_intake_cutover_missing`.
- On delta-token reset the same timestamp is reused. Atlas never uses
  `Date.now()` as a boundary.

## 7. Enable Graph intake for the canary mailbox

`wrangler secret put` creates a new Worker version AND deploys it
immediately. Using it for INITIAL enablement would activate Graph
piecewise — the first LEVEL 2 or LEVEL 1 secret write would deploy a
half-configured Worker. Phase 6 initial enablement uses Cloudflare
**versioned secrets** so all Graph configuration is staged on a new
version and activated in a single deliberate step.

### Stage every Graph secret on a new (non-active) version

```
wrangler versions secret put ATLAS_GRAPH_TENANT_ID                  --env production
wrangler versions secret put ATLAS_GRAPH_CLIENT_ID                  --env production
wrangler versions secret put ATLAS_GRAPH_CLIENT_SECRET              --env production
wrangler versions secret put ATLAS_GRAPH_MAILBOXES_JSON             --env production   # ["canary@yourdomain.co.za"]
wrangler versions secret put ATLAS_GRAPH_MAILBOX_CUTOVERS_JSON      --env production   # from §6
wrangler versions secret put ATLAS_GRAPH_JOB_PROCESSING_ENABLED     --env production   # value: "true"
wrangler versions secret put ATLAS_GRAPH_INTAKE_ENABLED             --env production   # value: "true"
```

Each `wrangler versions secret put` command uploads a secret to a new,
staged Worker version — it does NOT redeploy the live version. The
Cloudflare dashboard "Save Version → Deploy Version" workflow is
equivalent for operators who prefer the UI. Confirm with:

```
wrangler versions list --env production
```

The new version should show every ATLAS_GRAPH_* secret bound, alongside
the previously-active version which has none of them.

### Verify secret NAMES only

Do not print or read secret values. Ensure the new version's bindings
list contains all seven names above. Verify the cutover value shape by
having the operator who set it re-confirm they used the exact JSON
computed in §6 — Atlas does not surface secret values back.

### One deliberate activation

```
wrangler versions deploy --env production
```

Select the newly-staged version and confirm activation. This is the
SINGLE moment at which Graph intake becomes live in production; every
other command up to this point has been staging.

Verification within the first 10 minutes:

- New row appears in `atlas_intake_graph_state` for the canary mailbox.
- `atlas_audit_logs.action = 'graph_poll_success'` appears at least
  once with `metadata_json.mailbox_hash` matching the canary.
- No `atlas_operational_alerts` of type
  `graph_intake_auth_failure`, `graph_intake_failure_repeated`,
  `graph_intake_misconfigured`, or `graph_intake_cutover_missing`.

## 8. Observation window

24–72 hours passive observation. Real broker email is expected to arrive
during this window.

Watch signals:

| Table / metric | Healthy | Investigate if |
|---|---|---|
| `atlas_intake_graph_state.consecutive_failures` | 0 | ≥ 3 |
| `atlas_intake_graph_state.breaker_opened_at` | null | non-null |
| `atlas_submission_intake_messages` rows for canary | growing steadily | 0 for 24h with known inbound traffic |
| `atlas_intake_graph_attachments` state distribution | `pending → downloading → uploaded → ingested` | rows stuck in `downloading` > 30 min |
| `atlas_jobs` where `job_type IN ('graph_attachment_discovery','graph_attachment_ingest')` | queued → running → completed | more than a handful `failed` |
| `atlas_operational_alerts.alert_type = 'malware_detected'` on real intake | 0 during canary | ≥ 1 → confirm quarantine |
| DLQ depth for `atlas-shadow-pipeline-production-dlq` | 0 | growing (this is unrelated to Graph but worth watching) |
| `atlas_audit_logs.action = 'graph_poll_failed'` | 0 or 1 transient | sustained |

Correlation spot-check every 2 hours: for the 10 most recent intake
rows, does each map to the expected submission by the intended
correlation rule (per `metadata_json.correlation_rule`)? Any `needs_review`
row deserves inspection.

## 9. Additional mailboxes

Only after the canary observation is clean.

1. Extend the `ATLAS_GRAPH_MAILBOXES_JSON` value by ONE mailbox.
2. Extend `ATLAS_GRAPH_MAILBOX_CUTOVERS_JSON` with a fresh cutover for
   the new mailbox (typically "now, rounded to top of the hour").
3. Extend the Exchange RBAC role assignment resource scope by the same
   mailbox. Repeat §5 positive/negative tests for the new mailbox.
4. Redeploy.
5. Repeat §7 verification + §8 observation for the new mailbox.

Do this one mailbox at a time.

---

# Kill procedures

## LEVEL 1 — STOP NEW INTAKE / DRAIN

Use when you want to stop new emails from being pulled in, but let the
attachments already discovered for existing intakes finish processing.

Emergency kill uses `wrangler secret put`, which deploys the change
immediately — the desirable behaviour for a kill switch.

```
wrangler secret put ATLAS_GRAPH_INTAKE_ENABLED --env production   # value: "false"
```

Expected behaviour:

- On the next cron tick, `runGraphIntakeCycle` returns `[]` immediately.
  Zero Graph token acquisition, zero delta requests, zero writes to
  `atlas_intake_graph_state`.
- `atlas_jobs` rows of type `graph_attachment_discovery` and
  `graph_attachment_ingest` that were already queued CONTINUE to be
  claimed and processed. Those processors DO contact Graph to fetch
  attachment bytes for already-observed messages. This is intentional —
  it lets in-flight submissions complete.
- Delta cursor for each mailbox is untouched. When the flag is turned
  back on, polling resumes exactly where it left off.

Use LEVEL 1 for: mailbox misconfiguration, correlation concerns,
maintenance window on Exchange, or any time the operator wants to hold
new intake while letting existing work drain.

## Staging note — Phase 5B Graph-job processing is CLOSED by default

Staging is a deployed environment. `graphJobProcessingEnabled` fails
closed in code for both production AND staging when the flag is unset
or not exactly `"true"`. Any staging exercise of Phase 5B Graph-job
processing must set the flag intentionally via versioned secret upload
plus a deliberate version deploy (matching the production initial-
cutover pattern in §7):

```
wrangler versions secret put ATLAS_GRAPH_JOB_PROCESSING_ENABLED --env staging   # value: "true"
wrangler versions deploy --env staging
```

To end the staging test window (or as an emergency staging kill), use
the immediate-deploy form:

```
wrangler secret put ATLAS_GRAPH_JOB_PROCESSING_ENABLED --env staging   # value: "false"
```

Development and test environments continue to default enabled so local
test suites work unchanged.

The flag is NOT declared as a plaintext `[vars]` entry in either
`worker/wrangler.toml` or `worker/wrangler.staging.toml`. The
operational binding (wrangler secret) is the single source of truth so
there is no ambiguity about which value takes effect at runtime.

## LEVEL 2 — STOP ALL GRAPH TRAFFIC

Use when Atlas must contact Graph zero times: an outage, a security
incident, a token compromise, or when the operator needs the queue to
freeze completely.

Emergency kill uses `wrangler secret put`, which deploys each change
immediately — the desirable behaviour for a kill switch.

```
# 1. Stop new polling.
wrangler secret put ATLAS_GRAPH_INTAKE_ENABLED --env production          # value: "false"
# 2. Stop attachment-job Graph traffic.
wrangler secret put ATLAS_GRAPH_JOB_PROCESSING_ENABLED --env production  # value: "false"
```

Expected behaviour:

- No Graph delta requests (LEVEL 1 semantics).
- The background worker SKIPS claim for `graph_attachment_discovery`
  and `graph_attachment_ingest` jobs. Those rows stay in `queued`
  (or wherever the retry cycle had them). Their `retry_count` is NOT
  incremented while paused.
- The processor functions themselves check the flag before token
  acquisition — defence in depth. A direct/legacy caller that reaches
  the processor sees `outcome = "processing_paused"` and the wrapper
  releases the row back to `queued` without consuming retry budget.
- `atlas_intake_graph_attachments.state` is UNCHANGED. A row in
  `downloading` at pause time remains resumable.
- Malware scans for already-ingested Graph attachments STILL RUN
  (they are scoped to Supabase storage, not Graph).

When resuming: flip `ATLAS_GRAPH_JOB_PROCESSING_ENABLED` back to
`"true"` first (jobs will start draining), and only then flip
`ATLAS_GRAPH_INTAKE_ENABLED` back to `"true"` (new polling resumes).
This ordering avoids piling new work on top of a drained backlog.

## Non-destructive rollback default

The kill switches above are strictly reversible via wrangler secret
update. There is NO destructive rollback in Phase 6 — no `DROP TABLE`,
no truncation, no bulk delete. If a data-corruption incident is
suspected, LEVEL 2 kill and then engage the DBA for a targeted
investigation.

---

## Non-recovery: what NOT to do

- Do not backfill historical Inbox contents. Phase 6 policy is
  forward-only. The `$filter=receivedDateTime ge <cutover>` on the
  initial delta URL is Atlas's contract with Graph on this point.
- Do not run `wrangler secret delete` on the cutover value in
  production — a subsequent poll will refuse (skipped_cutover_missing).
  Update the value in place instead.
- Do not enable ATLAS_DOCUMENT_PIPELINE_MODE beyond `legacy` in the
  same window. Hybrid pipeline consolidation is out of Phase 6 scope.
- Do not add `Mail.ReadWrite` or `Mail.Send` to the intake app. Atlas
  is Mail.Read only.
