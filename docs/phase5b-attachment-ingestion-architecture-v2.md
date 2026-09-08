# Phase 5B — Microsoft Graph Attachment Ingestion (v2)

**Checkpoint 1B — Architecture Correction**

Baseline commit: `60fed8b3620fd459883f6f651948a8a5372a5e41`.
Branch: `feat/atlas-quote-pipeline-phase5b-attachment-ingestion`.
Supersedes: [docs/phase5b-attachment-ingestion-architecture.md](docs/phase5b-attachment-ingestion-architecture.md)
(v1). Deviations from v1 are called out inline as **CHANGE**.

Microsoft Graph remains disabled; no live Graph calls; no Worker cron
enablement; no Microsoft provisioning. Do not implement in this checkpoint.

---

## A. Graph metadata / read contract

**CHANGE.** v1 conflated Graph's *upload* size cap with the *read* path.

**Metadata listing (no bytes):**

```
GET https://graph.microsoft.com/v1.0/users/{mailbox}/messages/{message-id}/attachments
    ?$select=id,name,contentType,size,isInline,contentId
Authorization: Bearer <graph token>
```

Explicitly do NOT request `contentBytes`, and do not use invented shapes
like `contentBytes:false`. The `@odata.type` field is returned by Graph
without needing to be listed in `$select`, so `attachment_type` is still
available from this response.

**Byte fetch for `fileAttachment` only:**

```
GET https://graph.microsoft.com/v1.0/users/{mailbox}/messages/{message-id}/attachments/{attachment-id}/$value
Authorization: Bearer <graph token>
Accept: application/octet-stream
```

`/$value` returns the raw attachment bytes as an unstructured octet-stream —
no base64 wrapping, no JSON envelope. Response is read as an `ArrayBuffer` /
`ReadableStream`. This is the ONLY byte-download path in Phase 5B.

Both endpoints are routed through the existing Phase 5A
`fetchWithAllowlist` in [worker/src/graph-client.ts:153](worker/src/graph-client.ts:153):
exact `https://graph.microsoft.com` origin, `redirect:'manual'`, no
userinfo, no non-default port, classified `GraphError` on non-2xx. Adding
these two request URLs is the only new transport surface.

Reference and item attachment URLs from `@odata.type` other than
`#microsoft.graph.fileAttachment` are NEVER fetched.

## B. Size policy

**CHANGE.** v1 imposed an artificial 3 MB / 4 MB Graph-read cap. Correct
policy:

```
ATTACHMENT_MAX_BYTES = min(
    env.ATLAS_INTAKE_ATTACHMENT_MAX_BYTES  (optional, default = below),
    MAX_CLIENT_UPLOAD_BYTES  (15 MiB, worker/src/phase6-hardening.ts:34)
)
```

Default: 15 MiB. Existing Atlas client-document ceiling is authoritative;
Phase 5B does not raise it and there is no Graph-read boundary below it.

Enforcement:

- **Metadata-only skip:** `size > ATTACHMENT_MAX_BYTES` (from the list
  response) → tracking row `state='skipped', skip_reason='oversize'`. No
  `/$value` GET is issued.
- **Post-download safety net:** actual byte length re-checked; violation is
  `failed_permanent(size_mismatch)`. Guards against a mismatched metadata
  claim.
- MIME whitelist remains `application/pdf` only (matching the existing
  upload path).

## C. Discovery-job architecture

**CHANGE.** v1 attached a `listMessageAttachments` call to
`processSingleMessage` inside the Phase 5A poll. That coupling is removed.

New job type: **`graph_attachment_discovery`**.

The Phase 5A ingest RPCs (`ingest_new_email`, `attach_message`,
`ingest_needs_review`) already receive `p_has_attachments`. Migration 0033
**replaces their bodies at the SAME signatures** so that, when a NEW intake
row is created / attached / needs-review-created with `p_has_attachments =
true`, the same DB transaction also inserts exactly one `atlas_jobs` row:

| field | value |
| --- | --- |
| `job_type` | `graph_attachment_discovery` |
| `submission_id` | parent submission id |
| `document_id` | `NULL` |
| `input_fingerprint` | deterministic from `intake_message_id` (e.g. `sha256('discovery:'\|\|intake_message_id::text)`), so a delta-replay ingest that finds an existing intake row does not enqueue a duplicate discovery job |
| `metadata` | `{ "intake_message_id": "<uuid>" }` **only** — no mailbox, no graph message id, no filename, no PII |
| `status` | `queued` |
| `created_by` | `ATLAS_INTAKE_SYSTEM_ACTOR_ID` |

No attachment-stub arguments are added to any Phase 5A RPC signature.

**Cursor independence:** the delta cursor advances the moment the intake
RPC commits. A downstream discovery outage cannot block Phase 5A intake or
the cursor. §4 satisfied.

**Signature audit gate.** After 0033 runs, the following six Phase 5A
functions must exist and be the only `atlas_intake_*` overloads. The
migration ends with a `DO $$ ... $$` block that asserts this against
`pg_proc` and raises if any obsolete overload remains:

1. `public.atlas_intake_acquire_lease(text, text, text, timestamptz)`
2. `public.atlas_intake_release_lease(...)` (existing 0029 signature)
3. `public.atlas_intake_release_lease_success(...)` (existing 0030 signature)
4. `public.atlas_intake_ingest_new_email(...)` (existing 0031 signature —
   replaced body, same signature)
5. `public.atlas_intake_attach_message(...)` (existing 0030 signature —
   replaced body, same signature)
6. `public.atlas_intake_ingest_needs_review(...)` (existing 0031 signature —
   replaced body, same signature)

## D. Ingest-job architecture

New job type: **`graph_attachment_ingest`** — one per eligible attachment
row, enqueued by the discovery processor.

Job metadata carries `{ "attachment_id": "<uuid>" }` only. The processor
does the Graph `/$value` GET, hashes bytes, uploads to storage, runs the
document-creation RPC (§I), and completes the job. All retry, heartbeat,
backoff, and stuck-recovery is owned by `atlas_jobs` (§J).

Discovery processor responsibilities:

1. Load intake row by `intake_message_id` (service role). Verify
   `has_attachments = true`. If not, complete the discovery job as no-op
   (defensive; treat as `unchanged_completed`).
2. Acquire Graph token via existing `acquireGraphToken`.
3. Perform metadata list GET (§A). Classify failures (§L).
4. For each returned attachment:
   - Apply filters (§18 of the spec; unchanged from v1).
   - Atomically upsert the tracking row on the unique key
     `(mailbox, graph_message_id, graph_attachment_id)` with the initial
     state:
     - `unsupported` for `itemAttachment`, `referenceAttachment`, unknown
       type, or unsupported MIME.
     - `skipped` for inline signature, inline image, calendar invite,
       oversize.
     - `pending` for eligible `fileAttachment` + `application/pdf` +
       `size <= ATTACHMENT_MAX_BYTES`.
   - For rows in initial state `pending`, also insert one
     `graph_attachment_ingest` job whose `input_fingerprint` is
     deterministic on the attachment row id (so a re-fired discovery does
     not duplicate ingest jobs).
5. `completeJob` on the discovery job.

All of step 4 happens inside a single RPC
`atlas_intake_attachment_discover_commit(p_intake_message_id, p_stubs
jsonb)` — one Postgres transaction upserts every attachment row and every
eligible ingest job together. A partial discovery on error leaves the whole
transaction rolled back; the job retries.

## E. Revised tracking table `atlas_intake_graph_attachments`

**CHANGE.** Retry-schedule columns removed (§J). Malware-lifecycle states
removed (§G, §M). `duplicate_of_attachment_id` added (§H).

| column | type | notes |
| --- | --- | --- |
| `id` | `uuid pk default gen_random_uuid()` | |
| `intake_message_id` | `uuid not null references atlas_submission_intake_messages(id) on delete cascade` | |
| `submission_id` | `uuid not null references atlas_submissions(id) on delete cascade` | mirrored for RLS + queries |
| `mailbox` | `text not null` | integration state; staff-only visibility |
| `graph_message_id` | `text not null` | integration state |
| `graph_attachment_id` | `text not null` | integration state |
| `attachment_type` | `text not null check (attachment_type in ('fileAttachment','itemAttachment','referenceAttachment','unknown'))` | |
| `filename` | `text` | PII — inherits parent-submission RLS |
| `mime_type` | `text` | |
| `size_bytes` | `bigint` | Graph metadata |
| `is_inline` | `boolean not null default false` | |
| `content_id` | `text` | |
| `state` | `atlas_intake_attachment_state not null default 'pending'` | see §F |
| `skip_reason` | `text` | classified reason |
| `last_error_code` | `text` | operator visibility only |
| `last_attempt_at` | `timestamptz` | operator visibility only |
| `storage_path` | `text` | deterministic; see §H |
| `sha256` | `text` | server-computed after `/$value` |
| `duplicate_of_attachment_id` | `uuid references atlas_intake_graph_attachments(id) on delete set null` | |
| `document_id` | `uuid references atlas_documents(id) on delete set null` | |
| `scan_job_id` | `uuid references atlas_jobs(id) on delete set null` | |
| `created_at` | `timestamptz not null default now()` | |
| `updated_at` | `timestamptz not null default now()` | |

**Removed vs v1:** `attempt_count`, `next_attempt_after`. Those live only on
`atlas_jobs`.

**Uniqueness / indexes.** See §G for the hash constraint.
- `unique (mailbox, graph_message_id, graph_attachment_id)` — Graph replay
  idempotency.
- Index `(submission_id, created_at desc)` for submission-scoped reads.
- Index `(intake_message_id)`.
- Partial unique `(submission_id, sha256) where sha256 is not null and
  duplicate_of_attachment_id is null` — one hash-owner per submission
  (§G).

## F. Revised state machine

```
                      (discovery job enumerates attachments)
                                    │
                          ┌─────────┼──────────────────────────┐
                          │         │                          │
                          ▼         ▼                          ▼
                     [unsupported] [skipped]                [pending]
                    (item / ref /  (inline / calendar /       │  ingest job queued
                     unknown /      duplicate hash /          │
                     unsupported    oversize)                 │
                     MIME)                                    ▼
                                                        [downloading]
                                                              │
                                                       /$value fetched
                                                       + SHA-256 hashed
                                                       + hash registered
                                                       ─── owner? ───▶ (loser row → [skipped])
                                                              │ owner
                                                              ▼
                                                        (storage put)
                                                              │
                                                              ▼
                                                          [uploaded]      ◀── durable resume point
                                                              │
                                                       create-document RPC
                                                              │
                                                              ▼
                                                          [ingested]      ◀── Phase 5B done
                                                                                (malware pipeline takes over
                                                                                 via atlas_documents.scan_status)
```

Terminal states for Phase 5B: `ingested`, `skipped`, `unsupported`,
`failed_permanent`. The old v1 states `document_created`, `scanning`,
`clean`, `quarantined`, `scan_failed` are removed — those belong to
`atlas_documents.scan_status`, not to this table.

All transitions are effected by SECURITY DEFINER RPCs with conditional
UPDATEs gated on the current `state` (identical fencing pattern to Phase
5A). §10 and §15 satisfied.

## G. Hash ownership / dedup design

**CHANGE.** v1 proposed a naive unique index; that violates the "duplicates
retain the same sha256" property this checkpoint requires. Corrected model:

- Owner row: `sha256 IS NOT NULL AND duplicate_of_attachment_id IS NULL`.
- Duplicate row: `sha256 IS NOT NULL AND duplicate_of_attachment_id IS NOT
  NULL`, `state='skipped'`, `skip_reason='duplicate_hash'`.
- Partial unique index enforces one owner per `(submission_id, sha256)`:

  ```sql
  create unique index atlas_intake_attachments_hash_owner_uidx
    on atlas_intake_graph_attachments (submission_id, sha256)
    where sha256 is not null and duplicate_of_attachment_id is null;
  ```

**Atomic hash claim RPC.**

```
atlas_intake_attachment_register_hash(
    p_attachment_id uuid,
    p_expected_state text,     -- must be 'downloading'
    p_sha256         text,     -- 64 hex chars
    p_size_bytes     bigint
) returns (
    outcome text,              -- 'owner' | 'duplicate'
    owner_id uuid,             -- self if owner, existing owner otherwise
    document_id uuid           -- non-null iff owner already reached [ingested]
)
```

Behaviour (single transaction, `SERIALIZABLE` isolation OR advisory lock
keyed on `hash_bigint(submission_id, sha256)` to avoid unique-violation
retries):

1. Verify `p_attachment_id`'s current row is in `p_expected_state` and
   still `sha256 IS NULL` (fence).
2. Attempt `UPDATE ... SET sha256=$3, size_bytes=$4 WHERE id=$1`.
3. If the resulting row (a) has no rival owner in the partial unique index
   → outcome `owner`; return `owner_id=self`, `document_id=NULL`.
4. If it collides → set `duplicate_of_attachment_id=<existing owner id>`,
   `state='skipped'`, `skip_reason='duplicate_hash'`, and if the existing
   owner has `state='ingested'` also copy `document_id`. Return outcome
   `duplicate`.

Two isolates presenting the same bytes converge on exactly one owner. The
Serializable/advisory-lock guarantee removes the SELECT-then-INSERT race
v1 was vulnerable to. §12 satisfied.

## H. Duplicate before owner document exists

**Race:** A hashes first, registers as owner in state `downloading`; A then
crashes before reaching `ingested`. B hashes the same bytes.

Behaviour:

- B's hash-register RPC returns `outcome='duplicate', owner_id=A,
  document_id=NULL`. B sets `state='skipped',
  skip_reason='duplicate_hash', duplicate_of_attachment_id=A`.
- B does NOT block, does NOT wait for A's malware scan, and does NOT
  create its own `atlas_documents` row.
- If A eventually reaches `ingested`, B is left as-is by default. Its
  `document_id` may lag behind or stay NULL — that is safe, because B is
  a *duplicate marker*, not a source of truth. If operators need a
  resolved link, a small backfill RPC
  `atlas_intake_attachment_resolve_duplicate_documents(p_owner_id)` can be
  invoked from an existing housekeeping tick to copy `document_id` from
  the owner to its duplicates once the owner reaches `ingested`. This is a
  read-optimisation only; nothing downstream depends on it.
- If A fails permanently before reaching `ingested`, the duplicates remain
  attached to a permanently-failed owner. Operator response: retry A (a
  manual retry via existing job-retry surface will re-run through the
  state machine); on success the backfill RPC resolves duplicates. This is
  the same pattern the existing job pipeline uses for permanent failures.

§13 satisfied.

## I. Document + malware atomic boundary

**RPC:** `atlas_intake_attachment_create_document(p_attachment_id uuid,
p_system_actor_id uuid, p_retention_days integer)`.

Preconditions (verified inside the RPC):

- Row exists and `state='uploaded'`.
- `storage_path`, `sha256`, `size_bytes` all NOT NULL.
- Caller is service-role (function `security definer`, granted to
  `service_role` only).

Single transaction:

1. If `document_id IS NOT NULL AND scan_job_id IS NOT NULL AND
   state='ingested'` → **idempotent no-op return**: return the existing
   IDs. Satisfies §14's "retried after success" contract.
2. Insert `atlas_documents`:
   - `submission_id`, `file_name = filename`, `storage_path`, `document_type
     = 'supporting'`, `status='active'`, `scan_status='pending'`,
     `uploaded_by = p_system_actor_id`, `expires_at = now() +
     p_retention_days * interval '1 day'`, `file_hash = sha256`,
     `file_size_bytes = size_bytes`, `content_type = 'application/pdf'`.
3. Insert `atlas_jobs`:
   - `job_type='malware_scan'`, `submission_id`, `document_id=<new>`,
     `created_by = p_system_actor_id`, `status='queued'`,
     `input_fingerprint = sha256('malware_scan:' || <new document_id>)`,
     `metadata = { bucket: 'atlas-client-docs', storage_path, file_name,
     content_type: 'application/pdf' }`.
4. Update attachment row: `state='ingested'`, `document_id=<new>`,
   `scan_job_id=<new>`.
5. Insert audit row: `intake_attachment_ingested`, metadata
   `{ document_id, intake_message_id, mailbox_hash, sha256_prefix12,
   size_bytes }` — never bytes, filename, mailbox, or graph ids.

All five steps commit together or none do.

## J. Retry ownership

`atlas_jobs` is the sole retry scheduler.

`atlas_intake_graph_attachments` retains:

- `last_error_code` — most recent classified failure (operator readability).
- `last_attempt_at` — most recent claim attempt (operator readability).

It does NOT retain `attempt_count` or `next_attempt_after`. §9 satisfied.

The ingest-job processor writes those two fields as a side-effect of its
own state transitions — never as an independent scheduling clock. When
operators need the retry timeline they read the linked `atlas_jobs` row.

## K. RLS

- `atlas_intake_graph_attachments`:
  - RLS enabled.
  - SELECT policy: `atlas_is_staff() AND
    atlas_can_access_submission(submission_id)`. Broker denied by
    construction (staff check).
  - No INSERT / UPDATE / DELETE policies → service-role only.
- `atlas_documents` policy is unchanged; broker still sees their own
  submission's documents including Phase 5B-produced ones. This is
  intentional: the broker sent the email, they should see the artefact.
- API serialisation: broker-visible endpoints never join
  `atlas_intake_graph_attachments`. Only staff endpoints may surface
  attachment provenance.

## L. Failure matrix

Discovery-job failures (`graph_attachment_discovery`):

| Failure | Handling |
| --- | --- |
| Graph 401 | Classified `graph_unauthorized`. Retryable at most 2 times (existing `max_retries`); alert `graph_intake_auth_failure` after threshold. Intake + cursor unaffected. |
| Graph 403 | Classified `graph_forbidden`. **Non-retryable** — configuration/scope; `failJob` with `errorCode='graph_forbidden'`, critical alert. Prevents unbounded retry storms. |
| Graph 404 (message gone) | Discovery ends `failed_permanent` with `errorCode='graph_message_gone_before_attachment_discovery'`. Intake row is retained. **Not** re-interpreted as an `@removed` event. |
| Graph 429 with Retry-After | Retryable; existing `nextRetryAt` respects `retry_after` when we propagate it (thread the value through `failJob`). |
| Graph 5xx / transport | Retryable through `atlas_jobs`. |
| Malformed metadata payload | `failed_permanent(discovery_malformed)`. |
| RPC (`discover_commit`) failure | Retryable; whole transaction rolled back, next attempt reprocesses cleanly. |

Ingest-job failures (`graph_attachment_ingest`):

| Failure | Handling |
| --- | --- |
| Graph 401 on `/$value` | Retryable (bounded), alert threshold as above. |
| Graph 403 on `/$value` | `failed_permanent(graph_forbidden)`. |
| Graph 404 on `/$value` | `failed_permanent(graph_attachment_gone)`. |
| Graph 429 | Retryable; Retry-After respected. |
| Graph 5xx / transport | Retryable. |
| Hash size / length mismatch after download | `failed_permanent(size_mismatch)`. |
| Storage `.upload` failure | Retryable. If a previous attempt left an orphan object at this row's deterministic path (§H below), the retry is idempotent (see §H recovery). |
| `register_hash` returns `duplicate` | Row becomes `skipped(duplicate_hash)`; job completes successfully (not a failure). |
| `create_document` RPC failure | Retryable. If it succeeded but the response was lost, the idempotent no-op branch in the RPC (§I.1) returns the existing IDs. |
| Cross-service crash before `create_document` | On retry, state is still `uploaded`; the RPC picks up from there. Storage object is not re-uploaded (§H). |

No discovery or ingest failure can advance or reset the Phase 5A delta
cursor.

## M. Migrations

Next numbers: **0032** and **0033**. No edits to 0028–0031.

**0032_phase5b_attachment_ingest.sql** — schema only.

- `create type atlas_intake_attachment_state as enum ('pending',
  'downloading', 'uploaded', 'ingested', 'skipped', 'unsupported',
  'failed_permanent')`.
- `alter type atlas_job_type add value if not exists
  'graph_attachment_discovery'`.
- `alter type atlas_job_type add value if not exists
  'graph_attachment_ingest'`.
- `create table atlas_intake_graph_attachments (...)` per §E.
- Indexes and unique constraints per §E + §G.
- RLS enabled; single scoped-select policy (staff only).
- Pinned `search_path = public, pg_temp` on any helper functions;
  `revoke all from public, anon, authenticated`; `grant execute` to
  `service_role` only.

**0033_phase5b_attachment_rpcs.sql** — RPCs + same-signature replacement
of the three Phase 5A ingest bodies.

New RPCs:

- `atlas_intake_attachment_discover_commit(p_intake_message_id uuid,
  p_system_actor_id uuid, p_stubs jsonb)` — upsert attachment rows, insert
  eligible ingest jobs, all atomic.
- `atlas_intake_attachment_claim(p_id uuid, p_expected_state text)` —
  `pending → downloading` fence.
- `atlas_intake_attachment_register_hash(...)` per §G.
- `atlas_intake_attachment_mark_uploaded(p_id, p_expected_state,
  p_storage_path)` — `downloading → uploaded`, records `storage_path`
  durably.
- `atlas_intake_attachment_create_document(...)` per §I.
- `atlas_intake_attachment_mark_skipped(p_id, p_reason)`.
- `atlas_intake_attachment_fail(p_id, p_expected_state, p_next_state,
  p_error_code)` — DRY error transitions; writes `last_error_code` and
  `last_attempt_at` for operator visibility (never scheduling).
- `atlas_intake_attachment_resolve_duplicate_documents(p_owner_id uuid)` —
  optional housekeeping; copies `document_id` from owner to its duplicates.

Same-signature replacement of Phase 5A ingest RPCs (bodies only; parameter
lists identical to what worker/src/graph-intake.ts passes today):

- `atlas_intake_ingest_new_email(...)` — replace body per §C.
- `atlas_intake_attach_message(...)` — replace body per §C.
- `atlas_intake_ingest_needs_review(...)` — replace body per §C.

The migration ends with:

```sql
do $$
declare
  intake_fn_count int;
begin
  select count(*) into intake_fn_count
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname like 'atlas_intake_%';
  if intake_fn_count <> 6 then
    raise exception 'phase5b: atlas_intake_* signature count is %, expected 6', intake_fn_count;
  end if;
end $$;
```

so any obsolete overload left behind fails the migration loudly. §5 last
sentence satisfied.

All new RPCs: `security definer`, pinned `search_path`, `revoke all from
public, anon, authenticated`, `grant execute to service_role`. Identical
security posture to Phase 5A.

## N. Files to change

Worker:

- **NEW** `worker/src/graph-attachment.ts` — the two job processors
  (discovery + ingest), the two new Graph fetchers
  (`listMessageAttachments`, `fetchAttachmentBytes`), filter application,
  SHA-256, storage upload, RPC invocations, classified error handling.
- **EDIT** `worker/src/graph-client.ts` — add `listMessageAttachments` and
  `fetchAttachmentBytes` (both routed through the existing
  `fetchWithAllowlist`; no new origin allowed).
- **EDIT** `worker/src/phase4-background.ts` — two new dispatch branches in
  `processJob` (`graph_attachment_discovery`, `graph_attachment_ingest`).
  Reuses `claimJob`, `heartbeat`, `nextRetryAt`, `buildAlert`,
  `recoverStuckJobs` unchanged.
- **EDIT** `worker/src/phase7-jobs.ts` — extend `AtlasJobType` union with
  the two new values.
- **EDIT** `worker/src/config.ts` — optional
  `ATLAS_INTAKE_ATTACHMENT_MAX_BYTES` env (default 15 MiB via
  `MAX_CLIENT_UPLOAD_BYTES`).
- **NO CHANGE** to `worker/src/graph-intake.ts` — Phase 5A poll behaviour
  is preserved; the DB does the new atomic side-effect via replaced RPC
  bodies.
- **NO CHANGE** to `worker/src/malware-scan.ts`, the upload / confirm HTTP
  endpoints, or existing extraction gating.

DB:

- `supabase/migrations/0032_phase5b_attachment_ingest.sql`
- `supabase/migrations/0033_phase5b_attachment_rpcs.sql`

Tests: new files under `tests/` — see §O.

## O. Corrected test plan

Graph HTTP mocked via `GraphClientDeps.fetchImpl`. No live network.

Discovery / cursor separation:

- **`no_attachments_no_discovery_job`** — poll message
  `hasAttachments=false`; no `graph_attachment_discovery` job, no
  attachment rows; cursor advances.
- **`has_attachments_intake_and_discovery_atomic`** — poll message with
  `hasAttachments=true`; intake row and one discovery job appear in the
  same commit; cursor advances.
- **`discovery_429_does_not_stall_cursor`** — mock list attachments 429;
  the discovery `atlas_jobs` row retries per `next_retry_at`; the Phase 5A
  cursor and intake row are unaffected; no delta re-poll of the message.
- **`discovery_503_only_discovery_retries`** — same as above with 503.
- **`discovery_404_message_gone`** — mock 404 on list; discovery job ends
  `failed_permanent` with
  `errorCode='graph_message_gone_before_attachment_discovery'`; intake
  row remains; no attachment rows.
- **`discovery_403_non_retryable`** — mock 403; job goes straight to
  `failed_permanent(graph_forbidden)` with a critical alert; no retry
  storm.

Size boundaries (v1 corrections):

- **`14mib_pdf_eligible`** — 14 MiB PDF → ingested end-to-end.
- **`15mib_pdf_eligible`** — 15 MiB PDF → eligible (inclusive; matches
  `sizeBytes > MAX_CLIENT_UPLOAD_BYTES` semantics of
  `validateUploadInput`).
- **`over_15mib_skipped_pre_download`** — 15 MiB + 1 byte → skipped
  before any `/$value` GET. Assert `fetchImpl` never called for that
  attachment id.

Graph byte fetch shape:

- **`byte_fetch_uses_value_endpoint`** — assert the URL is
  `.../attachments/{id}/$value`; assert `Accept: application/octet-stream`;
  assert body is read as bytes, never JSON.

Filter tests (unchanged from v1 §H):

- Inline signature (12 KB, contentId) → `skipped(inline_signature)`.
- Inline image (180 KB) → `skipped(inline_image)`.
- Calendar `.ics` / `text/calendar` → `skipped(calendar_invite)`.
- `image/png` non-inline → `skipped(unsupported_mime)`.
- `itemAttachment` → `unsupported(item_attachment)`.
- `referenceAttachment` → `unsupported(reference_attachment)`; reference
  URL never fetched.

Crash recovery / storage-path durability:

- **`upload_succeeds_then_worker_crashes_before_document_rpc`** —
  attachment left in `state='uploaded'` with `storage_path` populated;
  retry job re-enters `create_document` (skips re-upload); ends
  `ingested`; no duplicate object, no duplicate document row.
- **`create_document_succeeds_then_response_lost`** — retry hits the
  idempotent no-op branch; same `document_id` and `scan_job_id` returned.
- **`retry_after_upload_never_reuploads_bytes`** — assert storage
  `.upload` call count == 1 across retries once `state='uploaded'`.

Hash ownership:

- **`same_sha_concurrent_owners_exactly_one`** — two isolates concurrently
  present same bytes for same submission; exactly one becomes owner; loser
  is `skipped(duplicate_hash)` with `duplicate_of_attachment_id=owner`.
- **`duplicate_before_owner_ingested_no_wait`** — B duplicates before A
  reaches `ingested`; B does not block; B's `document_id` may be NULL;
  B stays `skipped`. Optional housekeeping RPC backfills after A
  completes.
- **`cross_submission_same_sha_both_ingested`** — no cross-submission
  dedup; both submissions get their own `atlas_documents` row.

Retry authority:

- **`no_second_backoff_clock`** — assert attachment row never has
  `attempt_count` or `next_attempt_after` columns; retry timing is
  observable ONLY on the linked `atlas_jobs` row.
- **`operator_error_visibility`** — `last_error_code` and
  `last_attempt_at` on attachment row match latest job attempt.

Malware boundary (source of truth):

- **`ingested_then_scan_infected_no_state_copy`** — attachment stays at
  `state='ingested'`; the malware pipeline flips
  `atlas_documents.scan_status='infected'`; no trigger, no mirror; extraction
  remains blocked because it gates on `scan_status`.
- **`ingested_then_scan_clean_extraction_permitted`** —
  `atlas_documents.scan_status='clean'` makes the row visible to
  `extract-endpoint`'s `.in('scan_status',['clean','not_scanned'])`.

PII canary:

- **`no_pii_in_logs_or_alerts_or_error_bodies`** — vitest spy on
  `console.log/warn/error` and on inserts into `atlas_operational_alerts`
  and on all HTTP responses. Assert that `filename`, `subject`,
  `body_preview`, `sender_address`, `mailbox`, `graph_message_id`,
  `graph_attachment_id`, `content_id`, and the raw `sha256` never appear.
  Hashes and prefixes are permitted per Phase 5A `logIntakeError` /
  `safeHash` convention.

RLS:

- **`broker_cannot_read_attachment_rows`** — authenticated client with
  role `broker` gets zero rows from `atlas_intake_graph_attachments`
  regardless of ownership; `GET /api/submissions/:own` never surfaces
  attachment tracking fields.
- **`staff_can_read_own_scope`** — consultant on their own submission
  reads the row; consultant on another submission cannot.

Migration signature guard:

- **`no_orphan_intake_overloads`** — post-migration integration test
  queries `pg_proc` and asserts exactly the six Phase 5A functions listed
  in §C.

## P. Phase 5A.1 dependency

Unchanged from v1:

- **Phase 5B implementation:** NOT BLOCKED.
- **Phase 5B live Microsoft acceptance:** BLOCKED until 5A.1.
- **Phase 5B merge to main:** DEFAULT HOLD until live Graph attachment
  acceptance completes, unless a later review authorises dormant merge
  (feature flag off, no cron enablement, no binding change).

## Q. Risks

1. **RPC-body replacement of three Phase 5A signatures.** Getting the
   parameter lists byte-identical to the current 0031 (`ingest_new_email`,
   `ingest_needs_review`) and 0030 (`attach_message`) bodies is a
   correctness prerequisite. The end-of-migration `pg_proc` guard catches
   any drift.
2. **Discovery job may repeatedly retry against 401 auth failures.** The
   Phase 5A pattern accepts this and produces a `graph_intake_auth_failure`
   alert once thresholds trigger. We keep 401 retryable to match; 403 is
   non-retryable because it is almost always a persistent scope/permission
   error.
3. **Duplicate rows may lag on `document_id`.** Documented as a read-
   optimisation (not correctness): duplicates are safe with NULL
   `document_id` — they simply mark that the bytes were seen before. The
   optional resolver RPC backfills on a housekeeping tick.
4. **Serializable isolation for `register_hash`.** Using `SERIALIZABLE` can
   raise serialization failures under high concurrency, which the caller
   must retry. Advisory-lock (`pg_advisory_xact_lock(hashtext(...))`) is
   the fallback and avoids the retry class entirely. We ship with the
   advisory-lock design as the primary; the code path is a single narrow
   RPC so the choice is contained.
5. **Storage-path collision after crash.** Deterministic path
   `${submission_id}/graph/${attachment_row_id}-${safeFilename}` +
   Supabase `.upload(...)` semantics: an existing object at the same path
   returns a duplicate-key error unless `upsert:true` is set. We use
   `upsert:true` **only** on the ingest re-attempt path (state is
   `downloading` and `storage_path` matches this row's deterministic
   value), so the operation is scoped to bytes uniquely owned by this
   attachment row. Never used for arbitrary overwrites.
6. **Malware pipeline responsibility.** Phase 5B ingest can produce
   `atlas_documents` rows faster than the scanner can process them under
   burst load. This is an operational scaling question, not a correctness
   one — the existing `atlas_jobs` batch size and stuck-recovery
   already backpressure it. Track scanner queue depth as a follow-up
   metric, not a Phase 5B blocker.
7. **Item / reference attachments in real traffic.** If pilot senders
   frequently use `referenceAttachment` for OneDrive-linked PDFs, we will
   see a lot of `unsupported` rows without ingest. Follow-up phase, not
   Phase 5B.

---

## Verdict

**PHASE 5B ARCHITECTURE CORRECTED — READY FOR IMPLEMENTATION**

Corrections landed on all five review areas: Graph read semantics (§A);
attachment discovery decoupled from Phase 5A poll (§C); SHA dedup made
concurrency-safe with owner/duplicate ownership (§G, §H); `atlas_jobs`
is the single retry authority (§J); malware state is not duplicated on
the attachment table (§F, §I, §M).

Scope caveats remain: mocks only during development, staging synthetic
bytes for storage/DB/malware/retention/RLS proof, merge-to-main held
until Phase 5A.1 completes and live Graph attachment acceptance is
performed.

---

*Author: Claude Opus 4.7*
*Baseline: 60fed8b*
*Branch: feat/atlas-quote-pipeline-phase5b-attachment-ingestion*
*Supersedes: docs/phase5b-attachment-ingestion-architecture.md*
