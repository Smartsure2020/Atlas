# Phase 5B — Microsoft Graph Attachment Ingestion

**Checkpoint 1 — Architecture / Repository-Reality Audit**

Baseline commit: `60fed8b3620fd459883f6f651948a8a5372a5e41` (main).
Branch: `feat/atlas-quote-pipeline-phase5b-attachment-ingestion`.
Microsoft Graph: **remains disabled** for the duration of this checkpoint. No
live Graph calls, no Worker cron enablement, no Microsoft provisioning.

---

## A. Current document pipeline (repository reality)

Two-step upload, direct-to-storage, followed by a durable scan job.

1. **`POST /api/uploads/sign`** — [worker/src/index.ts:804](worker/src/index.ts:804)
   - Auth: staff (`roleCanUploadClientDocument`, incl. broker).
   - Confirms submission access via `canAccessSubmission`.
   - `validateUploadInput` enforces `.pdf` + `application/pdf` +
     `MAX_CLIENT_UPLOAD_BYTES = 15 MB` ([worker/src/phase6-hardening.ts:34](worker/src/phase6-hardening.ts:34)).
   - Object path is `${submission_id}/${uuid}-${safeFilename}` in
     `atlas-client-docs`.
   - Returns a short-lived Supabase signed upload URL (`createSignedUploadUrl`).
     Client `PUT`s bytes directly to storage ([src/lib/upload.ts:7](src/lib/upload.ts:7));
     the Worker never proxies file bytes on the upload path.

2. **`POST /api/uploads/confirm`** — [worker/src/index.ts:868](worker/src/index.ts:868)
   - Re-checks submission access and `validateUploadInput` (client-supplied
     `size_bytes`/`content_type` are re-validated server-side).
   - Requires `storage_path` to start with `${submission_id}/`.
   - Sets `expires_at = now + retentionDays * 24h` (default 7 days,
     `ATLAS_DOC_RETENTION_DAYS`).
   - Inserts `atlas_documents` with `status='active'`, `scan_status='pending'`,
     recording `file_hash`, `file_size_bytes`, `content_type`.
   - Immediately enqueues an `atlas_jobs` row of type `malware_scan` via
     `beginJob` with `metadata = { bucket, storage_path, file_name,
     content_type }`.
   - If job enqueue fails, the storage object AND the `atlas_documents` row
     are both removed (best-effort cleanup — cross-service, not atomic).
   - Audit event: `document_uploaded` (IDs and filename only, never bytes).

3. **UI** — [src/pages/SubmissionDocuments.tsx](src/pages/SubmissionDocuments.tsx)
   and `DocumentsPanel.tsx` render the atlas_documents rows and surface
   `scan_status` badges.

Downstream gating (extraction) requires
`scan_status IN ('clean','not_scanned')` explicitly at query time
([worker/src/extract-endpoint.ts:88-91](worker/src/extract-endpoint.ts:88)).

## B. Current malware pipeline (repository reality)

Fully database-driven; **no Cloudflare Queues** for malware. The shadow-
pipeline queue (`ATLAS_SHADOW_QUEUE`) exists only for the hybrid extraction
pipeline; it is not used for malware.

1. **Producer** — `beginJob(admin, { jobType: 'malware_scan', documentId,
   submissionId, metadata })` writes a row into `atlas_jobs` with
   `status='queued'` ([worker/src/phase7-jobs.ts:56](worker/src/phase7-jobs.ts:56)).
2. **Cron trigger** — `crons = ["* * * * *"]` (dev + production) invokes
   `scheduled()` which calls `runBackgroundMaintenance` and
   `runGraphIntakeCycleForEnv` in parallel ([worker/src/index.ts:151](worker/src/index.ts:151),
   [worker/wrangler.toml:82](worker/wrangler.toml:82)).
3. **`processQueuedJobs`** — [worker/src/phase4-background.ts:237](worker/src/phase4-background.ts:237)
   selects `queued` + retry-due `failed` jobs, batches to
   `ATLAS_WORKER_BATCH_SIZE` (default 5, capped at 20), then calls `claimJob`
   which does a conditional UPDATE `SET status='running'` with
   `.in('status',['queued','failed'])` — this is the cross-isolate fence.
4. **`scanJob`** — [worker/src/phase4-background.ts:110](worker/src/phase4-background.ts:110)
   downloads the object, calls `scanStorageObject`
   ([worker/src/malware-scan.ts:14](worker/src/malware-scan.ts:14)) → external scanner (`ATLAS_MALWARE_SCANNER_URL/TOKEN`).
   - **`clean`** → update `atlas_documents.scan_status='clean'`, write audit
     `malware_scan_completed`, `completeJob`.
   - **`infected`** → storage `.remove([path])`, set
     `scan_status='infected'`, `status='expired'`, `expired_at=now()`,
     insert `atlas_operational_alerts` (`malware_detected`, critical),
     throw `malware_detected` → job marked `failed` (no retry).
   - **error** → `scan_status='failed'`, `failJob` (retryable via
     `isRetryableError`, backoff by `nextRetryAt`).
5. **Fail-closed in production** — missing scanner env fails the environment
   validation ([worker/src/phase6-hardening.ts:146](worker/src/phase6-hardening.ts:146));
   dev bypass is `verdict:'clean', bypassed:true`.
6. **Alerts** — `atlas_operational_alerts` (`malware_detected`, `job_failed`,
   `job_stuck`) with `escalation_due_at`; `atlas_alert_webhook_url` optional
   escalation. Stuck-job recovery via `heartbeat_at` timeout
   (`ATLAS_STUCK_JOB_MINUTES`, default 20).

## C. Current storage model

- **Bucket:** `atlas-client-docs` (private; string constant is repeated in
  [worker/src/index.ts:142](worker/src/index.ts:142),
  [worker/src/extract-endpoint.ts:52](worker/src/extract-endpoint.ts:52),
  [worker/src/hybrid-orchestrator.ts:75](worker/src/hybrid-orchestrator.ts:75),
  [worker/src/phase4-background.ts:20](worker/src/phase4-background.ts:20),
  [worker/src/phase7-endpoints.ts:7](worker/src/phase7-endpoints.ts:7),
  [worker/src/phase8-endpoints.ts:12](worker/src/phase8-endpoints.ts:12)).
- **Path convention:** `${submission_id}/${uuid}-${safeFilename}`.
- **MIME/type:** only `application/pdf` with `.pdf` extension.
- **Size limit:** 15 MiB (`MAX_CLIENT_UPLOAD_BYTES`).
- **Ownership:** enforced by `canAccessSubmission` before signing / before
  confirming; the storage-path prefix `${submission_id}/` is re-validated on
  confirm.
- **Retention:** `atlas_documents.expires_at` set from `ATLAS_DOC_RETENTION_DAYS`
  (default 7). Cleanup is a two-stage manager-approved flow
  (`detectCleanupCandidates` + `processApprovedCleanup`) — production requires
  `ATLAS_CLEANUP_APPROVED=true`. Orphan storage objects also become cleanup
  candidates.
- **Insurer bucket (`atlas-insurer-docs`):** parallel structure with its own
  25 MiB cap (`MAX_GUIDELINE_UPLOAD_BYTES`) — **out of scope for 5B**;
  Phase 5B touches only client documents.

## D. Existing hash / idempotency mechanisms

- `atlas_documents.file_hash text` + partial index
  `atlas_documents_file_hash_idx WHERE file_hash IS NOT NULL`
  ([migration 0014:46](supabase/migrations/0014_phase8_recovery_monitoring.sql:46)).
- `file_hash` is **currently optional and client-supplied** by the UI
  (`sha256File` in [src/lib/upload.ts:23](src/lib/upload.ts:23)); Worker just
  persists whatever the client sends. **There is no server-side rehash on
  upload today.**
- **No enforced uniqueness on `file_hash`** — the index is non-unique. No
  dedup logic executes on confirm. The hash is currently only referenced as
  read-through metadata in extraction / cleanup flows.
- Jobs deduplicate on `atlas_jobs.input_fingerprint` (Phase 7 helpers),
  which is set by the caller. `malware_scan` jobs in the confirm path do
  **not** currently pass an `inputFingerprint` — every confirm creates a
  fresh scan job.
- Intake-message idempotency (Phase 5A) is enforced at the DB layer via
  partial unique indexes on `atlas_submission_intake_messages(mailbox,
  graph_message_id)` and `(internet_message_id)`
  ([migration 0028:104-111](supabase/migrations/0028_graph_intake_and_correlation.sql:104)).

## E. Proposed Phase 5B durable model

**Verdict on reuse:** neither `atlas_documents` alone nor `atlas_jobs` alone
provides sufficient retry safety for the Graph→storage→DB→scan chain. A
`malware_scan` job cannot be enqueued until an `atlas_documents` row exists,
and an `atlas_documents` row cannot be inserted until bytes are in storage.
That two-step chain, run under at-least-once Graph delivery, needs a durable
"work item" that survives crashes at *any* step.

**Proposed:** one new tracking table, `atlas_intake_graph_attachments`. This
is the smallest model that guarantees per-attachment retry, exactly-once
document creation, and operator visibility. Fields:

| column | type | notes |
| --- | --- | --- |
| `id` | `uuid pk default gen_random_uuid()` | |
| `intake_message_id` | `uuid not null references atlas_submission_intake_messages(id) on delete cascade` | parent email row (Phase 5A) |
| `submission_id` | `uuid not null references atlas_submissions(id) on delete cascade` | mirrored for cheap RLS + queries |
| `mailbox` | `text not null` | duplicated for operator queries — mailbox is not in atlas_documents |
| `graph_message_id` | `text not null` | Graph mailbox-scoped id |
| `graph_attachment_id` | `text not null` | Graph attachment id |
| `attachment_type` | `text not null check in ('fileAttachment','itemAttachment','referenceAttachment')` | |
| `filename` | `text` | *sensitive PII — inherits parent submission RLS* |
| `mime_type` | `text` | |
| `size_bytes` | `bigint` | from Graph metadata |
| `is_inline` | `boolean not null default false` | |
| `content_id` | `text` | for signature dedup + reply threading |
| `state` | `atlas_intake_attachment_state not null default 'pending'` | see state machine (§G) |
| `skip_reason` | `text` | classified reason for `skipped` / `unsupported` |
| `document_id` | `uuid references atlas_documents(id) on delete set null` | populated after successful ingest |
| `sha256` | `text` | *server-computed* after download |
| `scan_job_id` | `uuid references atlas_jobs(id) on delete set null` | link to malware_scan job |
| `attempt_count` | `integer not null default 0` | |
| `last_error_code` | `text` | classified only, never bytes |
| `last_attempt_at` | `timestamptz` | |
| `next_attempt_after` | `timestamptz` | backoff |
| `created_at` | `timestamptz not null default now()` | |
| `updated_at` | `timestamptz not null default now()` | |

**Uniqueness (mandatory):**

- `unique (mailbox, graph_message_id, graph_attachment_id)` — the fundamental
  idempotency key for Graph replay.
- Partial unique `(submission_id, sha256) where sha256 is not null` — per-
  submission byte-level dedup once we've hashed. This deliberately does NOT
  index across submissions (per §12 of the checkpoint spec: no cross-customer
  dedup).

**Indexes:** `(state, next_attempt_after)`, `(submission_id, created_at desc)`,
`(intake_message_id)`.

**Does `atlas_documents` need new columns?** No new columns are strictly
required. `content_type`, `file_hash`, `file_size_bytes`, `scan_status` all
exist and are already handled by the malware pipeline. The `document_type`
enum-string currently accepts `'broker_email' | 'policy_schedule' |
'proposal_form' | 'claims_history' | 'vehicle_schedule' | 'building_schedule'
| 'supporting'`; Phase 5B attachments default to `'supporting'` unless the
filename gives us a stronger classification signal (not proposed in this
phase — no LLM classification for 5B).

**What we do NOT add:** no attachment bytes in Postgres, no cached headers,
no Graph internal URLs stored anywhere except transiently inside the
worker call. `graph_message_id` and `mailbox` are stored but only readable
by service-role (RLS gate below).

## F. Graph attachment-type handling

Support matrix for the first release:

| Graph `@odata.type` | Phase 5B behaviour |
| --- | --- |
| `#microsoft.graph.fileAttachment` | **Eligible.** Subject to filters (§H). |
| `#microsoft.graph.itemAttachment` | **Unsupported.** Persist row with `state='unsupported', skip_reason='item_attachment'`. No download attempted. |
| `#microsoft.graph.referenceAttachment` | **Unsupported.** Same treatment; `skip_reason='reference_attachment'`. Reference/cloud URLs are NEVER fetched — the URL points to a third-party origin and would leak the bearer token / be an SSRF sink. |
| `unknown / missing @odata.type` | Treat as unsupported; `skip_reason='unknown_attachment_type'`. |

Rationale: `itemAttachment` (an embedded email/calendar item) requires the
`$expand` sub-graph and its own serialization decision; `referenceAttachment`
points off-Microsoft (OneDrive/SharePoint URL) and would require a second
authenticated transport plane. Both are out of scope for 5B and the checkpoint
spec explicitly wants them recorded and skipped.

## G. State machine (per `atlas_intake_graph_attachments` row)

```
       (poller sees hasAttachments)
                  │
                  ▼
              [pending]────────────────────────────────────┐
                  │                                        │ oversize / inline / unsupported
                  │ eligible fileAttachment                │ (decided from metadata only)
                  ▼                                        ▼
             [downloading]                            [skipped]  or  [unsupported]
                  │
                  │ bytes fetched + sha256 hashed
                  ▼
             [uploading]     (put into atlas-client-docs)
                  │
                  │ storage_path known, atlas_documents insert succeeds
                  ▼
             [document_created]
                  │
                  │ malware_scan job enqueued
                  ▼
             [scanning]      (mirror of atlas_documents.scan_status='pending')
                  │
        ┌─────────┼──────────┐
        │         │          │
        ▼         ▼          ▼
     [clean]  [infected]  [scan_failed]
                  │            │
                  ▼            ▼ (retryable)  → back to [pending] with attempt_count++
             [quarantined]     └── (max attempts) → [failed_permanent]
```

Terminal states: `clean`, `quarantined`, `skipped`, `unsupported`,
`failed_permanent`.

**All state transitions are effected by SECURITY DEFINER RPCs** (same pattern
as Phase 5A's `atlas_intake_ingest_new_email` / `atlas_intake_attach_message`
/ `atlas_intake_release_lease_success`). Each RPC does a conditional UPDATE
gated on the current `state` value, so two isolates racing the same row
converge to a single authoritative transition.

## H. Filtering (deterministic — no LLM)

Decided from Graph metadata alone, before any download:

- `attachment_type != 'fileAttachment'` → `unsupported`.
- `isInline = true` AND `contentId` present AND `size_bytes < 100 KiB` →
  `skipped` (`skip_reason='inline_signature'`). Rationale: covers logos and
  signature images. Non-inline attachments never hit this rule regardless of
  size.
- `isInline = true` AND `mime_type` starts with `image/` AND `size_bytes <
  200 KiB` → `skipped` (`skip_reason='inline_image'`).
- `mime_type` in `{ 'text/calendar', 'application/ics' }` OR extension
  `.ics` → `skipped` (`skip_reason='calendar_invite'`).
- `size_bytes > ATLAS_INTAKE_ATTACHMENT_MAX_BYTES` (see §I) → `skipped`
  (`skip_reason='oversize'`). **No download issued.**
- MIME whitelist (initial): `application/pdf` only (matches existing upload
  path). Everything else → `skipped` (`skip_reason='unsupported_mime'`).
  This deliberately mirrors the current strict PDF-only stance of
  `validateUploadInput` — broadening MIME support is a separate review.

Filename is never used as the sole gate; it is only used to sanitize via
`safeFilename` before storage-path composition.

## I. Size limit

`ATLAS_INTAKE_ATTACHMENT_MAX_BYTES` env var, defaulting to
`MAX_CLIENT_UPLOAD_BYTES` (15 MiB). Rationale:

- Existing Atlas upload cap: 15 MiB.
- Cloudflare Workers request-body cap: 100 MiB (free), 500 MiB (paid) — well
  above our 15 MiB.
- Supabase Storage default per-file: 50 MiB (server-configurable) — above.
- Microsoft Graph attachment endpoint hard limit: 4 MB for single-shot GET;
  attachments above ~3 MB require the *upload/download session* pattern.
  **First release will not implement the >4 MB session pattern** —
  `size_bytes > 3_000_000` currently rejected in Phase 5B *even under the
  15 MiB env cap* until the session pattern is added (a follow-up).

Env resolution: `min(env_configured, MAX_CLIENT_UPLOAD_BYTES,
GRAPH_SINGLESHOT_LIMIT)`. Oversize is skipped **from metadata alone** — the
GET is never issued.

## J. Transaction / recovery boundaries

Storage and Postgres are separate services. We cannot make them one
transaction; we compensate with a strict state machine and idempotency keys.

Per-attachment authoritative sequence:

1. **`pending → downloading`** — DB RPC, conditional on `state='pending'`.
   Idempotent: if two isolates race, one wins the fence and the other sees
   `state != 'pending'` and returns.
2. **Fetch bytes from Graph** — In-memory only. On failure, RPC
   `atlas_intake_attachment_fail(attempt, code, next_attempt_after)` sets
   `state='pending'` (retryable) or `state='failed_permanent'` (exhausted).
3. **SHA-256 in-memory.** Per-submission dedup lookup:
   `select id from atlas_intake_graph_attachments where submission_id=$1
   and sha256=$2 and state in ('clean','quarantined','document_created',
   'scanning') limit 1`. If hit, mark current row `skipped`
   (`skip_reason='duplicate_hash'`) and link `document_id` to the sibling.
4. **`downloading → uploading`** — DB RPC guard.
5. **Storage `.upload(storage_path, bytes)`** with a deterministic path
   `${submission_id}/graph/${attachment_row_id}-${safeFilename}` (the
   subfolder `graph/` distinguishes intake-sourced objects for operator /
   forensic use; still under the same `submission_id/` prefix so all
   existing per-submission access checks keep working).
6. **`uploading → document_created`** — Single atomic RPC
   `atlas_intake_attachment_create_document` that:
   - inserts `atlas_documents` row (`scan_status='pending'`, `status='active'`,
     `uploaded_by=SYSTEM_ACTOR_ID`, `expires_at=now + retention`, `file_hash=sha256`,
     `file_size_bytes`, `content_type`),
   - inserts `atlas_jobs` row (`job_type='malware_scan'`, `metadata={
     bucket:'atlas-client-docs', storage_path, file_name, content_type }`,
     `input_fingerprint=sha256`),
   - updates the attachment row to `state='document_created',
     document_id=<new>, scan_job_id=<new>`,
   - writes `atlas_audit_logs` (`intake_attachment_ingested`,
     metadata: `document_id`, `intake_message_id`, `mailbox_hash`, `sha256`,
     `size_bytes`).
   All under one Postgres transaction. If it fails, the storage object is
   orphaned — the existing `detectCleanupCandidates` pass will find it and
   mark it a manager-approved cleanup candidate. There is **no** compensating
   storage delete inside the attachment worker: the cleanup pipeline is
   already the correct home for orphaned objects and doing it inline risks
   race deletion of a sibling upload.
7. **`document_created → scanning`** — trivial state mirror once the
   existing `atlas_jobs` cron picks up the malware_scan job.
8. **Scan verdict propagation** — a DB trigger on `atlas_documents.scan_status`
   changes propagates `clean/infected/failed` into
   `atlas_intake_graph_attachments.state`. Reason to use a trigger rather
   than teaching `scanJob` about the new table: `scanJob` should stay generic
   over `atlas_documents` regardless of source. The trigger fires only for
   rows that have a matching attachment row and is idempotent.

## K. Queue / job design

**No new Cloudflare Queue.** Phase 5B extends the existing `atlas_jobs`
cron-driven executor rather than introducing a second dispatch surface.

New `atlas_job_type` enum value: `graph_attachment_ingest`. Each row on
`atlas_intake_graph_attachments` in state `pending` corresponds to one job
row. Job metadata carries the attachment row id only — never bytes, mailbox,
or filenames.

`processQueuedJobs` gets one new branch that dispatches
`graph_attachment_ingest` → new module `worker/src/graph-attachment-ingest.ts`.
That module runs steps 1–6 above, honoring the same `claimJob` fence,
`heartbeat_at`, `next_retry_at`, and `isRetryableError` semantics as the
malware pipeline. Reuses `nextRetryAt` / `buildAlert` / stuck-recovery
plumbing so operators see the same shape.

**Producer boundary.** The Phase 5A poll (`pollMailbox` /
`processSingleMessage` in [worker/src/graph-intake.ts](worker/src/graph-intake.ts))
only inserts intake-message rows today. Phase 5B adds a **strictly
transactional side-effect** to the ingest RPCs (`ingest_new_email`,
`attach_message`, `ingest_needs_review`): when `p_has_attachments=true`, the
RPC also enumerates a caller-supplied `p_attachment_stub` JSONB array (Graph
attachment list *metadata only* — id, type, name, contentType, size, isInline,
contentId — no bytes) and creates one `atlas_intake_graph_attachments` row +
one `atlas_jobs` row per attachment, atomically with the intake row. The Graph
`list attachments` call is added to the poll (one lightweight `$select` GET
per message with `hasAttachments=true` — no bytes downloaded during the
poll). If that list call fails (429/5xx), the *whole message* falls under the
existing Phase 5A failure path (delta cursor does not advance for this
message; message replays on next tick); the intake-message row is NOT
persisted yet, so there is no orphaned message-without-attachments.

**Consequence for §19 (Phase 5A cursor).** The delta poll's *per-message*
work grows by one small Graph `$select=id,name,contentType,size,isInline,
contentId,contentBytes:false` GET (Graph enforces its own size cap on the
list endpoint; bytes are NOT included). Bytes are NEVER fetched inside the
delta poll. Attachment download happens in the **separate** `atlas_jobs` cron
tick that already runs on the same `* * * * *` schedule. This satisfies §19's
required separation.

## L. RLS / access boundary

- `atlas_intake_graph_attachments`: **RLS enabled**; SELECT policy
  `atlas_is_staff() AND atlas_can_access_submission(submission_id)`. Broker
  MUST NOT see this table — mailbox, graph_message_id, graph_attachment_id,
  content_id are operational integration state. No INSERT / UPDATE / DELETE
  policies (service-role only).
- Broker access to the produced `atlas_documents` row is unchanged: the
  existing `atlas_documents_scoped_select` policy (which uses only
  `atlas_can_access_submission`) already permits broker to see documents on
  their own submission. Attachments correctly inherit this behaviour — the
  broker uploaded the email that carried them, they should see the artefacts.
- Broker API responses (`GET /api/submissions/:id`) must NEVER echo any
  `atlas_intake_graph_attachments` fields — only `atlas_documents` rows are
  serialised. This is enforced by not joining the table into any broker-
  visible endpoint; belt-and-braces is that RLS would block it anyway.

## M. Retention integration

Attachment `atlas_documents` rows are created with `expires_at = now +
retentionDays * 24h`, identical to the current UI upload path. The existing
`detectCleanupCandidates` / `processApprovedCleanup` pass already handles:

- expired document rows → storage removed, `atlas_documents.status='expired'`;
- orphan storage objects → cleanup candidates.

**One addition:** when a cleanup pass expires a document that has a matching
`atlas_intake_graph_attachments.document_id`, a trigger clears the
`document_id` FK (already `on delete set null`) and sets the attachment row
to `state='clean'` unchanged — the intake row itself persists as history
(per Phase 5A's audit-preservation principle). No permanent storage of email
attachments is introduced.

## N. Failure matrix

| Failure | Handling |
| --- | --- |
| Graph list-attachments 401/403 | Whole message re-queues via existing 5A failure path; per-attachment rows never created. Alert `graph_intake_auth_failure`. |
| Graph list-attachments 404 (message) | Treated as removed; existing 5A `isRemovedEvent` semantics. |
| Graph list-attachments 429 | Retry-After honored via 5A `recordFailure` → `next_attempt_after`. |
| Graph list-attachments 5xx / network | 5A per-message failure — cursor does not advance for this message. |
| Attachment GET 401/403 | Attachment row `state='pending'`, `last_error_code='graph_unauthorized'`, retry with backoff; alert on 5 consecutive auth failures across the mailbox. |
| Attachment GET 404 | `state='failed_permanent'`, `last_error_code='graph_attachment_gone'`. No retry (attachment deleted upstream). |
| Attachment GET 410 (delta expired) | Not applicable to attachment fetch (delta is for messages); if returned, treated as 404. |
| Attachment GET 429 Retry-After | `next_attempt_after` honored. |
| Attachment GET 5xx / transport | Retryable up to `max_retries`. |
| Malformed attachment response | `state='failed_permanent'`, `last_error_code='attachment_malformed'`. |
| Oversize (pre-download from metadata) | `state='skipped', skip_reason='oversize'`. Never downloaded. |
| Unsupported attachment type | `state='unsupported', skip_reason='item_attachment' / 'reference_attachment' / 'unknown_attachment_type'`. Never downloaded. |
| Storage upload failure | Bytes discarded; `state='downloading'`, retry. Object either wasn't created or is orphaned; existing cleanup pass reclaims. |
| Postgres RPC failure creating document | Orphan storage object left in place — existing cleanup detects. Attachment row stays in prior state, retryable. |
| Scanner unavailable in production | Existing `scanStorageObject` throws `scanner_unconfigured` → env validation catches at request time; runtime scan job fails; the produced document stays `scan_status='pending'` — extraction is already gated on `scan_status IN ('clean','not_scanned')`. **Fail closed by construction.** |
| Malicious verdict | Existing malware pipeline quarantines the document; trigger sets `atlas_intake_graph_attachments.state='quarantined'`; audit + alert already fire. |
| Two isolates race the same attachment | DB uniqueness on `(mailbox, graph_message_id, graph_attachment_id)` — one wins the insert; the other sees `state != 'pending'` and returns. |
| Same SHA-256 twice within a submission | `unique (submission_id, sha256) where sha256 is not null` — new attempt marks `state='skipped', skip_reason='duplicate_hash', document_id=<sibling>`. |
| Delta replay of the same message | 5A's unique indexes prevent duplicate intake rows; the RPC also idempotently upserts attachment stubs on `(mailbox, graph_message_id, graph_attachment_id)`. |

## O. Proposed migrations

Next migration number is **`0032`** (last existing:
`0031_graph_intake_plpgsql_name_resolution.sql`).

1. `0032_phase5b_attachment_ingest.sql`
   - `create type atlas_intake_attachment_state as enum ('pending',
     'downloading', 'uploading', 'document_created', 'scanning', 'clean',
     'quarantined', 'skipped', 'unsupported', 'failed_permanent')`.
   - `alter type atlas_job_type add value if not exists
     'graph_attachment_ingest'`.
   - `create table atlas_intake_graph_attachments (…)` per §E.
   - Indexes and unique constraints per §E.
   - RLS enabled; single scoped-select policy (staff only).
   - Trigger `atlas_intake_attachment_scan_sync()` on
     `atlas_documents` AFTER UPDATE of `scan_status` that propagates
     `clean|infected|failed` into the attachment row's `state`.
2. `0033_phase5b_attachment_rpcs.sql` (kept as a second migration so the
   RPCs land in an isolated review even though they could technically live
   in the same file):
   - `atlas_intake_attachment_upsert_stubs(p_intake_message_id, p_submission_id,
     p_mailbox, p_graph_message_id, p_stubs jsonb)` — called from the 5A
     ingest RPCs when `p_has_attachments=true`.
   - `atlas_intake_attachment_claim(p_id, p_expected_state)` — conditional
     `pending → downloading` transition.
   - `atlas_intake_attachment_fail(p_id, p_expected_state, p_next_state,
     p_error_code, p_retry_after)` — DRY error transitions.
   - `atlas_intake_attachment_mark_skipped(p_id, p_reason)`.
   - `atlas_intake_attachment_create_document(p_id, p_bucket, p_storage_path,
     p_file_name, p_content_type, p_size_bytes, p_sha256, p_expires_at,
     p_system_actor_id)` — the atomic document+job+attachment write of §J.6.
   - REVOKE ALL from `PUBLIC`, `anon`, `authenticated`; GRANT EXECUTE only to
     `service_role`.

## P. Files expected to change

Worker (new + edited):

- **NEW** `worker/src/graph-attachment-ingest.ts` — the job processor
  (steps 1–6 of §J), Graph attachment metadata/list/GET wrappers, filter
  application, SHA-256, storage upload, atomic RPC invocation, classified
  error handling.
- **NEW** `worker/src/graph-client.ts` additions — `listMessageAttachments`,
  `fetchAttachmentBytes` — both routed through the existing
  `fetchWithAllowlist` and `assertAllowedGraphUrl`. NO new origin allowed.
- **EDIT** `worker/src/graph-intake.ts` — extend `ingestNewEmail` /
  `attachIntakeMessage` / `ingestNeedsReview` call sites to pass a
  `p_attachment_stubs` JSONB param (only when `hasAttachments=true`), sourced
  from a lightweight `listMessageAttachments` GET made after correlation but
  before the atomic RPC. No behavioural change when `hasAttachments=false`.
- **EDIT** `worker/src/phase4-background.ts` — one new dispatch branch in
  `processJob` for `job_type='graph_attachment_ingest'`.
- **EDIT** `worker/src/phase7-jobs.ts` — extend `AtlasJobType` union.
- **EDIT** `worker/src/config.ts` — new env
  `ATLAS_INTAKE_ATTACHMENT_MAX_BYTES` (optional, defaults to 15 MiB).
- **NO EDIT** to `worker/src/malware-scan.ts`.
- **NO EDIT** to the upload / confirm HTTP endpoints.

DB:

- `supabase/migrations/0032_phase5b_attachment_ingest.sql`
- `supabase/migrations/0033_phase5b_attachment_rpcs.sql`

UI:

- `src/pages/DocumentsPanel.tsx` (or equivalent) — no schema changes required
  since attachments materialise as normal `atlas_documents` rows. A minor
  read enhancement (source badge) is deferred to a separate task and is NOT
  part of Phase 5B implementation.

Tests: new files under `tests/` mirroring the pattern of Phase 5A intake
tests. See §O below (test plan).

## Q. Test plan (Graph mocked; no live network)

All Graph HTTP is provided via `GraphClientDeps.fetchImpl` (already the
Phase 5A injection surface). Test doubles:

1. **No attachments** — poll message with `hasAttachments=false`; no
   attachment row created, no jobs, intake row unchanged from 5A behaviour.
2. **Single safe PDF** — happy path through `pending → clean`;
   `atlas_documents` row present, `atlas_jobs` malware_scan enqueued.
3. **Multiple attachments in one message** — per-attachment idempotency;
   each terminal-states independently.
4. **Duplicate graph_attachment_id** — replay poll; second attempt hits
   uniqueness index; no duplicate row, no duplicate job.
5. **Same SHA-256 across two messages in same submission** — first ingests,
   second `skipped(duplicate_hash)` with `document_id=<sibling>`.
6. **Cross-submission same SHA-256** — no dedup; both ingested separately.
7. **Race: two isolates same attachment** — one wins the claim RPC; other
   returns `state != 'pending'`.
8. **Inline signature image (size 12 KB, isInline, contentId)** —
   `skipped(inline_signature)`. No download attempted.
9. **Inline image (size 180 KB, isInline)** — `skipped(inline_image)`.
10. **Attachment size 20 MB (metadata)** — `skipped(oversize)`. Assert the
    injected fetch was NEVER called for that attachment id.
11. **Attachment size 3.5 MB (metadata)** — Graph singleshot cap enforced,
    `skipped(oversize)` for first release; test documents the cutover
    threshold.
12. **`itemAttachment`** — `unsupported(item_attachment)`; no download.
13. **`referenceAttachment`** — `unsupported(reference_attachment)`; no
    download; assert the reference URL is NEVER fetched.
14. **Attachment MIME `image/png` (non-inline, 500 KB)** —
    `skipped(unsupported_mime)`.
15. **Graph GET 429 with Retry-After** — `next_attempt_after` honored.
16. **Graph GET 503** — retried up to `max_retries`.
17. **Graph GET network drop** — retryable; classified `network_error`.
18. **Malformed attachment response** — `failed_permanent(attachment_malformed)`.
19. **Storage `.upload` failure** — retried; no `atlas_documents` row created;
    no `atlas_jobs` row created; assert absence in DB.
20. **`atlas_intake_attachment_create_document` RPC failure** — orphan
    storage object present; cleanup pass detects; attachment row still in
    `uploading` state and retryable.
21. **Malware `infected` verdict** — trigger flips attachment to
    `quarantined`; storage removed; alert fired (reusing 4A malware alert).
22. **Malware `scan_failed` (retryable)** — attachment `state='scanning'`
    stays; existing malware retry advances it eventually.
23. **Scanner unavailable in production** — env validation blocks upstream;
    if injected mid-run, `scanStorageObject` throws → job fails →
    `atlas_documents.scan_status='pending'` → extraction gated (no bytes
    exposed downstream).
24. **PII leak canary** — vitest assertion that no attachment `filename`,
    `subject`, `body_preview`, `sender_address`, `mailbox`,
    `graph_message_id`, or `graph_attachment_id` appears in any
    `console.log/warn/error` call (`vi.spyOn(console,...)`) OR in any
    `atlas_operational_alerts.metadata` insert OR in any HTTP error response
    body. Uses the same pattern as 5A's `logIntakeError` PII test.
25. **Broker RLS** — an `authenticated` client with role `broker` performing
    `select * from atlas_intake_graph_attachments where submission_id=<own>`
    returns zero rows. Broker `GET /api/submissions/:own` returns the
    `atlas_documents` row but NO attachment-tracking fields.
26. **Staff RLS** — consultant on their own submission can `select` the
    attachment row; consultant on another submission cannot.
27. **`hasAttachments=true` with zero returned attachments** — treated as
    metadata inconsistency; intake row is written normally, no attachment
    rows created, no crash.
28. **Delta replay of a message that already produced attachments** —
    idempotent through both the intake unique indexes AND the attachment
    unique index.

Test data uses realistic Microsoft Graph JSON shapes from the Graph docs
(pinned as fixtures under `tests/fixtures/graph-attachments/`).

## R. Real staging (later, no Microsoft credentials)

Per §26 of the checkpoint spec, the DB / storage / hash / malware / RLS /
retention paths can be validated against staging Supabase using
locally-synthesised bytes injected into the `fetchAttachmentBytes` seam. A
staging harness will:

- feed synthetic PDF bytes through the ingest path;
- exercise the malware pipeline (dev bypass); optionally point at the
  configured staging scanner;
- confirm expected `atlas_documents` / `atlas_intake_graph_attachments` /
  `atlas_jobs` / audit / alert rows;
- confirm retention cleanup removes storage + expires document.

**Production Supabase remains forbidden.**

## S. Phase 5A.1 dependency

- **Phase 5B implementation:** NOT BLOCKED by Phase 5A.1 (Microsoft
  provisioning). All development, tests, and staging synthetic runs proceed
  under mocks / dependency injection.
- **Phase 5B live Microsoft acceptance:** BLOCKED until Phase 5A.1 completes
  and Graph is enabled in a controlled environment.
- **Phase 5B final merge to main:** DEFAULT HOLD until live Graph
  attachment acceptance is completed, unless a later explicit review
  authorises a dormant merge (feature flag off, no cron enablement, no
  binding change).

## T. Risks / blockers

1. **Graph `>4 MB` attachments** need the download-session pattern.
   First-release rejects them via oversize gate (documented). If pilot
   partners routinely send larger attachments, we add a follow-up to
   implement the session download inside `graph-attachment-ingest.ts`.
2. **Trigger vs teach-scanJob-about-attachments** — using a trigger keeps
   the malware scanner generic but adds one more moving piece to review.
   Alternative is a small explicit `attachment_id` field in the malware_scan
   job metadata and an update-through in `scanJob`. Prefer the trigger for
   coupling reasons; either is acceptable and does not change the
   architecture.
3. **`atlas_documents.uploaded_by`** is `not null`. Graph-sourced rows will
   use the same `ATLAS_INTAKE_SYSTEM_ACTOR_ID` UUID that Phase 5A already
   uses for `atlas_submissions.created_by`. This is a UUID with no FK; safe.
4. **List-attachments extra Graph call inside the poll** adds one GET per
   `hasAttachments=true` message. Under the existing per-tick page budget
   (50 pages × 5 messages = 250 messages theoretical max) the additional
   traffic is bounded and honors the same failure envelope as the poll.
5. **`content_id` collisions across submissions** — content-ids are only
   locally unique within a message; they are stored per row and never used
   as a global key. No risk.
6. **Second attachment table means one more RLS surface** to review; kept
   deliberately narrow (staff-only SELECT, service-role writes) to reduce
   exposure.

## U. Verdict

**PHASE 5B ARCHITECTURE APPROVED FOR IMPLEMENTATION**

Contingent on the above scope: mocks only during development, staging
synthetic bytes for DB/storage/malware/retention/RLS proof, and
merge-to-main held until Phase 5A.1 completes and live Graph attachment
acceptance is performed.

---

*Author: Claude Opus 4.7*
*Baseline: 60fed8b*
*Branch: feat/atlas-quote-pipeline-phase5b-attachment-ingestion*
