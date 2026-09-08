-- ============================================================================
-- Atlas — Phase 5B (Microsoft Graph attachment ingestion)
-- Migration 0032 — schema, enums, indexes, RLS.
-- ----------------------------------------------------------------------------
-- Forward-only. Additive to 0028–0031. Does NOT modify Phase 5A tables,
-- policies, or RPC signatures. Companion migration 0033 adds RPCs and
-- replaces the three Phase 5A ingest RPC BODIES at their exact identity
-- arguments so that has_attachments=true atomically enqueues a discovery
-- job.
--
-- Architecture: docs/phase5b-attachment-ingestion-architecture-v2.md
--
-- Boundaries
-- ----------
--   * Graph must remain disabled. This migration adds no cron, no producer
--     binding, no external side-effect.
--   * No attachment bytes are stored in Postgres. Bytes live in the existing
--     private `atlas-client-docs` bucket; this table stores only tracking
--     rows.
--   * No cross-submission SHA dedup. Per-submission owner uniqueness only.
--   * RLS: staff scoped SELECT only. Broker denied by construction. No
--     INSERT / UPDATE / DELETE policies — service-role only.
-- ============================================================================


-- ---------- Enums -----------------------------------------------------------

alter type atlas_job_type add value if not exists 'graph_attachment_discovery';
alter type atlas_job_type add value if not exists 'graph_attachment_ingest';

do $$
begin
  if not exists (select 1 from pg_type where typname = 'atlas_intake_attachment_state') then
    create type atlas_intake_attachment_state as enum (
      'pending',
      'downloading',
      'uploaded',
      'ingested',
      'skipped',
      'unsupported',
      'failed_permanent'
    );
  end if;
end $$;


-- ---------- Table -----------------------------------------------------------

create table if not exists public.atlas_intake_graph_attachments (
  id                          uuid primary key default gen_random_uuid(),
  intake_message_id           uuid not null
                                references public.atlas_submission_intake_messages(id) on delete cascade,
  submission_id               uuid not null
                                references public.atlas_submissions(id) on delete cascade,

  -- Graph integration state. Staff-only visibility via RLS below. NEVER
  -- surfaced through broker-facing API responses.
  mailbox                     text not null,
  graph_message_id            text not null,
  graph_attachment_id         text not null,

  attachment_type             text not null
                                check (attachment_type in (
                                  'fileAttachment', 'itemAttachment',
                                  'referenceAttachment', 'unknown'
                                )),
  -- Filename may itself contain PII (client/matter). Inherits parent
  -- submission RLS; never logged or alerted.
  filename                    text,
  mime_type                   text,
  size_bytes                  bigint,
  is_inline                   boolean not null default false,
  content_id                  text,

  state                       atlas_intake_attachment_state not null default 'pending',
  skip_reason                 text,

  -- Operator visibility only. Retry scheduling is owned by atlas_jobs; these
  -- columns are NOT used as a second backoff clock.
  last_error_code             text,
  last_attempt_at             timestamptz,

  storage_path                text,
  sha256                      text,
  duplicate_of_attachment_id  uuid
                                references public.atlas_intake_graph_attachments(id) on delete set null,

  document_id                 uuid
                                references public.atlas_documents(id) on delete set null,
  scan_job_id                 uuid
                                references public.atlas_jobs(id) on delete set null,

  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now(),

  -- Structural sanity: skipped/unsupported rows carry a reason; hash-owner
  -- rows do not point at another owner; a duplicate marker MUST carry a
  -- SHA (that is the whole point of duplicate detection).
  constraint atlas_intake_attachments_skip_reason_when_skipped
    check (
      (state in ('skipped', 'unsupported') and skip_reason is not null)
      or state not in ('skipped', 'unsupported')
    ),
  constraint atlas_intake_attachments_duplicate_shape
    check (
      duplicate_of_attachment_id is null
      or (sha256 is not null and duplicate_of_attachment_id <> id)
    )
);

comment on table public.atlas_intake_graph_attachments is
  'Atlas Phase 5B: durable per-attachment ingestion tracking. Contains Graph '
  'integration identifiers and optional PII (filename); staff-only RLS. Retry '
  'scheduling is NOT stored here — atlas_jobs is the single retry authority.';

comment on column public.atlas_intake_graph_attachments.state is
  'Ingestion lifecycle. Terminal states: ingested, skipped, unsupported, '
  'failed_permanent. Malware lifecycle is NOT mirrored here — after ingested, '
  'atlas_documents.scan_status is authoritative.';

comment on column public.atlas_intake_graph_attachments.storage_path is
  'Deterministic path inside atlas-client-docs. Set atomically with state=uploaded '
  'and never re-generated on retry. Enables safe resume after crash.';

comment on column public.atlas_intake_graph_attachments.sha256 is
  'Server-computed SHA-256 of downloaded bytes. Owner uniqueness is scoped to '
  'the same submission only — see partial unique index below.';

comment on column public.atlas_intake_graph_attachments.duplicate_of_attachment_id is
  'When non-null, this row is a duplicate of another attachment in the same '
  'submission and does NOT own an atlas_documents row of its own.';

comment on column public.atlas_intake_graph_attachments.last_error_code is
  'Most recent classified failure code. Operator visibility only — retry timing '
  'lives on the linked atlas_jobs row.';


-- ---------- Indexes ---------------------------------------------------------

-- Graph replay idempotency. The Graph message-id is mailbox-scoped, so
-- (mailbox, graph_message_id, graph_attachment_id) is the fundamental key.
create unique index if not exists atlas_intake_attachments_graph_uidx
  on public.atlas_intake_graph_attachments
    (mailbox, graph_message_id, graph_attachment_id);

-- Per-submission SHA owner uniqueness. Duplicates deliberately DO retain the
-- same sha256; only OWNER rows participate in this index. NO cross-submission
-- dedup.
create unique index if not exists atlas_intake_attachments_hash_owner_uidx
  on public.atlas_intake_graph_attachments (submission_id, sha256)
  where sha256 is not null and duplicate_of_attachment_id is null;

-- Submission- and message-scoped reads.
create index if not exists atlas_intake_attachments_submission_idx
  on public.atlas_intake_graph_attachments (submission_id, created_at desc);

create index if not exists atlas_intake_attachments_intake_message_idx
  on public.atlas_intake_graph_attachments (intake_message_id);

-- Operator visibility of pending / active work.
create index if not exists atlas_intake_attachments_state_idx
  on public.atlas_intake_graph_attachments (state, updated_at desc)
  where state in ('pending', 'downloading', 'uploaded');


-- ---------- updated_at trigger (reuse existing helper) ----------------------

do $$
begin
  if not exists (
    select 1 from pg_trigger
    where tgname = 'atlas_intake_graph_attachments_touch'
      and tgrelid = 'public.atlas_intake_graph_attachments'::regclass
  ) then
    create trigger atlas_intake_graph_attachments_touch
      before update on public.atlas_intake_graph_attachments
      for each row execute function public.atlas_touch_updated_at();
  end if;
end $$;


-- ---------- RLS -------------------------------------------------------------

alter table public.atlas_intake_graph_attachments enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename  = 'atlas_intake_graph_attachments'
      and policyname = 'atlas_intake_graph_attachments_scoped_select'
  ) then
    create policy atlas_intake_graph_attachments_scoped_select
      on public.atlas_intake_graph_attachments
      for select
      to authenticated
      using (
        public.atlas_is_staff()
        and public.atlas_can_access_submission(submission_id)
      );
  end if;
end $$;

-- Intentionally NO insert/update/delete policies for authenticated. RLS with
-- no policy denies the operation; only the service-role Worker writes.
