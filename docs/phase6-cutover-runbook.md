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

Run against production Supabase read-only:

```sql
select version from public.supabase_migrations order by version desc;
```

Confirm 0028, 0029, 0030, 0031, 0032, 0033, 0034, 0035 are all present.

### If any of 0028–0035 are missing

Apply the missing files in numeric order, in ONE maintenance window,
using the same Supabase migration tooling the team normally uses.
No manual SQL. No ad-hoc DDL.

After each migration:

```sql
select count(*) from public.atlas_submission_intake_messages;
select count(*) from public.atlas_intake_graph_state;
select count(*) from public.atlas_intake_graph_attachments;
```

Every one must return `0`. A non-zero count on the intake tables at this
point means someone has already been writing to them — STOP and
investigate before continuing.

Also confirm RLS is enabled and policies are attached (spot check):

```sql
select tablename, rowsecurity
  from pg_tables
  where tablename in (
    'atlas_submission_intake_messages',
    'atlas_intake_graph_state',
    'atlas_intake_graph_attachments'
  );
```

All three must show `rowsecurity = true`.

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

Microsoft Graph filtered `messages/delta` initial enumerations using
`$filter=receivedDateTime ge …` are documented to return at most ~5,000
messages before the caller is expected to switch to the unfiltered
delta continuation. Atlas honours this in two ways:

1. **First sync** for a mailbox uses the configured cutover verbatim.
   For a busy mailbox where >5,000 messages have accumulated since
   that timestamp, the initial enumeration may not surface everything
   in one page cycle. Atlas paginates safely via `@odata.nextLink` and
   resumes across ticks via `in_round_next_link`; no data is lost, but
   the round takes more than one tick to complete on that mailbox.

2. **Delta-token resets** (HTTP 410, `syncStateNotFound` /
   `syncStateInvalid`) no longer replay from the original cutover
   forever. Migration 0036 adds a durable per-mailbox `reset_floor`
   that is monotonically advanced ONLY after a fully-completed delta
   round to `poll_start_time - 24h` (never derived from `Date.now()`
   at the reset itself, never advanced on `ok_resumable` partial
   rounds). On a 410, Atlas restarts from
   `max(configured_cutover, reset_floor)`. The configured cutover
   remains the immutable earliest boundary; the floor never precedes
   it. See `computeResetFloorAdvance` in `worker/src/graph-intake.ts`.

Pick the cutover accordingly. For a mailbox that carries substantial
recent traffic, picking a cutover only a few days back keeps the very
first enumeration within one comfortable working set.

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

Set the remaining secrets (individually, one at a time so each write is
confirmable):

```
wrangler secret put ATLAS_GRAPH_TENANT_ID          --env production
wrangler secret put ATLAS_GRAPH_CLIENT_ID          --env production
wrangler secret put ATLAS_GRAPH_CLIENT_SECRET      --env production
wrangler secret put ATLAS_GRAPH_MAILBOXES_JSON     --env production   # ["canary@yourdomain.co.za"]
```

Turn LEVEL 2 attachment processing on (also a wrangler var/secret):

```
wrangler secret put ATLAS_GRAPH_JOB_PROCESSING_ENABLED --env production   # value: "true"
```

Finally, turn LEVEL 1 intake on:

```
wrangler secret put ATLAS_GRAPH_INTAKE_ENABLED --env production   # value: "true"
```

Redeploy so the new env takes effect: `wrangler deploy --env production`.

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

```
wrangler secret put ATLAS_GRAPH_INTAKE_ENABLED --env production   # value: "false"
# no redeploy required; the value is read live by graphIntakeEnabled()
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

Staging is a deployed environment. As of Checkpoint 1A,
`graphJobProcessingEnabled` fails closed in both production AND staging:
`ATLAS_GRAPH_JOB_PROCESSING_ENABLED` must be exactly `"true"` for
attachment jobs to be claimed and processed. Any staging exercise of
Phase 5B Graph-job processing must set the flag intentionally with
`wrangler secret put ATLAS_GRAPH_JOB_PROCESSING_ENABLED --env staging`
(value: `"true"`) and remove / flip back to `"false"` at the end of
that test window. Development and test environments continue to
default enabled so local test suites work unchanged.

## LEVEL 2 — STOP ALL GRAPH TRAFFIC

Use when Atlas must contact Graph zero times: an outage, a security
incident, a token compromise, or when the operator needs the queue to
freeze completely.

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
