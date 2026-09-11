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

-- service_role holds EXECUTE; public / authenticated / anon must NOT.
--
-- PUBLIC is a PostgreSQL pseudo-role rather than an ordinary pg_roles
-- row, so a WHERE rolname IN (...) filter over pg_roles would silently
-- omit it. Drive the query from a VALUES list so all four labels are
-- always evaluated:
select roles.role_name,
       has_function_privilege(
         roles.role_name,
         'public.atlas_intake_release_lease_success_with_floor(text,uuid,text,boolean,text,boolean,timestamptz,jsonb,timestamptz,boolean)',
         'EXECUTE'
       ) as can_exec
  from (values
          ('service_role'),
          ('authenticated'),
          ('anon'),
          ('public')
       ) as roles(role_name);
```

Expected: reset_floor column present as `timestamp with time zone`,
nullable. The RPC row must be present exactly once. Exactly:

| role_name      | can_exec |
|----------------|----------|
| service_role   | true     |
| authenticated  | false    |
| anon           | false    |
| public         | false    |

The migration's REVOKE/GRANT statements are unchanged — the query above
is verification only.

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

## 3. Production Worker deploy — Graph OFF, single staged version

Ordinary `wrangler secret put` creates a new Worker version AND deploys
it immediately. Doing the malware secret writes before the intended
Phase 6 deploy would create two interim production deployments (once
per secret write) with mismatched code / config states. Stage
everything on a single non-active candidate version and activate it in
one deliberate step.

1. Off-git secrets file — plaintext file OUTSIDE the repo, matching
   `.gitignore`. Never paste its contents into reports, terminals that
   log to disk, or chat. Example location: `~/atlas/phase6-prod-scanner.secrets`.
   File contents (dotenv shape — do NOT commit):

   ```
   ATLAS_MALWARE_SCANNER_URL=<real production scanner URL>
   ATLAS_MALWARE_SCANNER_TOKEN=<real production scanner token>
   ```

   The URL must resolve to a real hostname; Atlas refuses to serve
   requests if it contains a placeholder token (`yourcompany`,
   `example.com`, `placeholder`, `changeme`, `todo`, `replace-me`,
   `your-domain`) — see `phase6-hardening.validateEnv`.

2. Confirm the following Graph secrets are NOT set on production or any
   staged production candidate version (Graph must stay off):
   - `ATLAS_GRAPH_INTAKE_ENABLED`
   - `ATLAS_GRAPH_TENANT_ID`
   - `ATLAS_GRAPH_CLIENT_ID`
   - `ATLAS_GRAPH_CLIENT_SECRET`
   - `ATLAS_GRAPH_MAILBOXES_JSON`
   - `ATLAS_GRAPH_MAILBOX_CUTOVERS_JSON`
   - `ATLAS_GRAPH_JOB_PROCESSING_ENABLED`

3. Upload the Phase 6 Worker code + scanner secrets onto ONE new
   NON-ACTIVE candidate version:

   ```
   wrangler versions upload --env production \
     --secrets-file ~/atlas/phase6-prod-scanner.secrets
   ```

   `wrangler versions upload` does not redeploy the live version. It
   returns a `VERSION_ID` — copy it and keep it for §5.

4. Securely remove the temporary secrets file:

   ```
   shred -u ~/atlas/phase6-prod-scanner.secrets    # Linux
   # or: srm ~/atlas/phase6-prod-scanner.secrets   # macOS with srm installed
   ```

   (On systems where `shred` is unavailable, use whatever secure-delete
   utility the team has approved. Do NOT rely on plain `rm`.)

5. Inspect the exact candidate WITHOUT activating it. See §5 for the
   verification pattern (binding NAMES only). For this Graph-OFF deploy
   the required check is:
   - `ATLAS_MALWARE_SCANNER_URL` and `ATLAS_MALWARE_SCANNER_TOKEN`
     bound on the candidate.
   - None of the seven Graph names present on the candidate.

6. Deploy the exact candidate at 100% only after §5 verification:

   ```
   wrangler versions deploy <VERSION_ID>@100% --env production -y
   ```

   Dashboard Save Version → Deploy Version of that same version id is
   equivalent. This is a SINGLE production deployment.

Verification:

- `GET https://<prod-origin>/api/health` returns 200.
- No `atlas_operational_alerts` rows created in the 30 minutes after deploy.
- Cron runs every minute but does no Graph work (`runGraphIntakeCycleForEnv`
  returns immediately when the flag is off).

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

## 6. Choose the forward-only cutover timestamp

**§6 is planning + preflight only. No Cloudflare mutation happens here.**
The chosen cutover is written to production in §7 as part of the single
staged candidate version.

Choose a fixed UTC ISO 8601 timestamp AFTER the moment the canary
mailbox is ready to be watched — typically the start of the next
business day. This becomes the boundary Atlas never crosses backwards
for THAT mailbox.

Record the chosen cutover privately (e.g. the operator's encrypted
notes) so it can be pasted verbatim into the §7 local secrets file. Do
NOT commit it to git. Do NOT paste it into terminals that log to disk.
The value shape:

```json
{"canary@yourdomain.co.za":"2026-09-20T06:00:00.000Z"}
```

Contract:
- Value MUST be strict ISO 8601 UTC form: `YYYY-MM-DDTHH:MM:SS(.sss)Z`.
  Timezone offsets and locale strings are refused by `isValidCutoverIso`.
- Missing or malformed entries in production cause `pollMailbox` to
  return `status="skipped_cutover_missing"` and raise
  `atlas_operational_alerts.alert_type = graph_intake_cutover_missing`.
- On a 410 delta-token reset Atlas restarts the initial URL from
  `max(configured_cutover, reset_floor)`. The configured cutover is
  immutable earliest boundary; the reset floor may advance only after a
  fully-committed complete round.

### Configured cutovers are operationally IMMUTABLE

Once a mailbox has entered production intake:

- Its configured cutover timestamp MUST NOT be changed.
- Do not move it earlier.
- Do not move it later.
- Do not regenerate it from "now" during a subsequent tick or when
  editing the JSON to add another mailbox.

When adding another mailbox (§9), the operator preserves every
existing mailbox→cutover pair BYTE FOR BYTE and appends only the new
mailbox's entry.

Reason: `effective_reset_boundary = max(configured_cutover, reset_floor)`.
`reset_floor` advances only after fully-completed rounds keyed against
the original boundary. Altering an established cutover would change
the replay / skip semantics of any future 410 reset for that mailbox
and could unintentionally re-enumerate messages already processed, or
skip a window between the old and new boundary. The immutability rule
keeps intake deterministic and auditable.

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

## 7. Enable Graph intake for the canary mailbox — one staged version

Initial Graph enablement stages ALL seven bindings on a single
non-active Worker candidate version and activates that exact version
in one deliberate step. Ordinary `wrangler secret put` would deploy on
every write and produce piecewise activations.

### Stage seven bindings on ONE candidate version

Local off-git secrets file, matching `.gitignore`, e.g.
`~/atlas/phase6-prod-graph.secrets`. Never commit; never paste
contents into reports, terminals that log to disk, or chat. The two
flags MUST both be exactly `"true"`.

```
ATLAS_GRAPH_TENANT_ID=<tenant id>
ATLAS_GRAPH_CLIENT_ID=<client id>
ATLAS_GRAPH_CLIENT_SECRET=<client secret>
ATLAS_GRAPH_MAILBOXES_JSON=["canary@yourdomain.co.za"]
ATLAS_GRAPH_MAILBOX_CUTOVERS_JSON={"canary@yourdomain.co.za":"<cutover from §6, verbatim>"}
ATLAS_GRAPH_JOB_PROCESSING_ENABLED=true
ATLAS_GRAPH_INTAKE_ENABLED=true
```

Stage them onto a NON-ACTIVE candidate version in ONE command:

```
wrangler versions secret bulk ~/atlas/phase6-prod-graph.secrets --env production
```

The command uploads all seven secrets onto a single new candidate
version and returns a `VERSION_ID`. Copy it — it is required for
verification (§5 pattern) and for the final activation below.

Then securely remove the temporary file:

```
shred -u ~/atlas/phase6-prod-graph.secrets     # Linux
# or the team's approved secure-delete utility
```

Do NOT activate the candidate yet. Do NOT echo any secret value into
logs, reports, or the report file. If a value shape needs to be
checked, the operator who set it re-confirms locally from the removed
file before running `shred` — Atlas does not surface secret values
back.

### Verify the exact candidate version (see §5 pattern)

Identify the candidate via:

```
wrangler versions list --env production
```

Confirm the returned `VERSION_ID` matches the one from
`wrangler versions secret bulk`.

Then inspect that EXACT candidate:

```
wrangler versions view <VERSION_ID> --env production --json
```

(Or open the Cloudflare dashboard version-details view for the same
`VERSION_ID`.)

Check BINDING NAMES only. Required — all seven names must appear on
the same candidate version:

- `ATLAS_GRAPH_TENANT_ID`
- `ATLAS_GRAPH_CLIENT_ID`
- `ATLAS_GRAPH_CLIENT_SECRET`
- `ATLAS_GRAPH_MAILBOXES_JSON`
- `ATLAS_GRAPH_MAILBOX_CUTOVERS_JSON`
- `ATLAS_GRAPH_JOB_PROCESSING_ENABLED`
- `ATLAS_GRAPH_INTAKE_ENABLED`

Alongside the pre-existing scanner names from §3
(`ATLAS_MALWARE_SCANNER_URL`, `ATLAS_MALWARE_SCANNER_TOKEN`) which
continue to be bound on this version.

Never print or record any secret VALUE. Never claim
`wrangler versions list` proves the bindings — it only identifies
versions; `wrangler versions view <VERSION_ID>` (or the dashboard
details view) is the authoritative inspection.

### One deliberate activation

```
wrangler versions deploy <VERSION_ID>@100% --env production -y
```

(Dashboard Save Version → Deploy Version of the same version id is
equivalent.) This is the SINGLE moment at which Graph intake becomes
live in production; every other command up to this point has been
staging.

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

Only after the canary observation is clean. Do this one mailbox at a
time. Use the same staged candidate-version pattern as §7 — never edit
the live version with `wrangler secret put`.

1. **Preserve every existing entry byte-for-byte.** Both JSON secrets
   must retain every previously-configured mailbox and its cutover
   unchanged:
   - `ATLAS_GRAPH_MAILBOXES_JSON` gets the new mailbox address APPENDED.
   - `ATLAS_GRAPH_MAILBOX_CUTOVERS_JSON` gets the new mailbox→cutover
     pair APPENDED. Never mutate an existing pair.

2. Choose the new mailbox's cutover per §6 (preflight $count check,
   record privately). The cutover for that mailbox becomes immutable
   from the moment it enters production intake.

3. Extend the Exchange App RBAC resource scope by the same mailbox.
   Repeat §5 InScope=True / InScope=False proofs for the new mailbox
   (existing mailboxes should still show InScope=True).

4. Local off-git secrets file containing only the two updated JSONs:

   ```
   ATLAS_GRAPH_MAILBOXES_JSON=<full existing array + new address>
   ATLAS_GRAPH_MAILBOX_CUTOVERS_JSON=<full existing object + new entry>
   ```

   Stage onto ONE non-active candidate version:

   ```
   wrangler versions secret bulk ~/atlas/phase6-add-mailbox.secrets --env production
   ```

   `shred -u` the file. Capture the returned `VERSION_ID`.

5. Verify the exact candidate via
   `wrangler versions view <VERSION_ID> --env production --json`
   (or the dashboard). Confirm BINDING NAMES only. Both JSON binding
   names must be present on the candidate; the other five Graph names
   (`ATLAS_GRAPH_TENANT_ID`, `ATLAS_GRAPH_CLIENT_ID`,
   `ATLAS_GRAPH_CLIENT_SECRET`, `ATLAS_GRAPH_JOB_PROCESSING_ENABLED`,
   `ATLAS_GRAPH_INTAKE_ENABLED`) and the scanner names should all
   remain bound from the previously-active version.

6. Activate the exact candidate:

   ```
   wrangler versions deploy <VERSION_ID>@100% --env production -y
   ```

7. Repeat §8 observation for the new mailbox. Existing mailboxes MUST
   continue polling unaffected — their cutovers were preserved
   verbatim, their `atlas_intake_graph_state.delta_link` values are
   untouched, and their `reset_floor` values remain what the previous
   completed rounds advanced them to.

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
- **Authoritative counter-preservation:** the background worker's job
  selector (`selectClaimableJobs` in
  `worker/src/phase4-queue-selector.ts`) EXCLUDES
  `graph_attachment_discovery` and `graph_attachment_ingest` at the
  database query stage, BEFORE `LIMIT`. Those rows are never claimed
  while LEVEL 2 is off, so `claimJob` is never called for them — their
  `retry_count`, `attempt_count`, and `next_retry_at` values are
  untouched.
- **Defence in depth (Graph traffic only, NOT counter-preservation):**
  the processors themselves (`handleGraphAttachmentDiscoveryJob`,
  `handleGraphAttachmentIngestJob`) check the flag BEFORE Graph token
  acquisition. If a direct/legacy caller ever reaches the processor
  bypassing the selector, no Graph request is issued. In that
  fallback path `claimJob` has already run and already incremented
  `attempt_count` (and possibly `retry_count`); the wrapper releases
  the row back to `queued` via `releaseClaimToQueued` but does NOT
  roll back those counters. This is acceptable because the normal
  scheduled path never reaches it — the selector is where budget
  preservation is enforced.
- `atlas_intake_graph_attachments.state` is UNCHANGED. A row in
  `downloading` at pause time remains resumable.
- Malware scans for already-ingested Graph attachments STILL RUN
  (they are scoped to Supabase storage, not Graph). Extraction,
  recommendation, insurer-doc, and every other non-Graph job type
  continues to be claimed and processed normally.

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
  Configured cutovers are operationally IMMUTABLE per §6: once a
  mailbox has entered production intake, do not move its cutover
  earlier, later, or regenerate it from "now". When adding another
  mailbox, preserve every existing pair byte-for-byte and append the
  new one (§9).
- Do not enable ATLAS_DOCUMENT_PIPELINE_MODE beyond `legacy` in the
  same window. Hybrid pipeline consolidation is out of Phase 6 scope.
- Do not add `Mail.ReadWrite` or `Mail.Send` to the intake app. Atlas
  is Mail.Read only.
