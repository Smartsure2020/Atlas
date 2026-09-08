-- ============================================================================
-- Atlas — Phase 5A (Outlook / Microsoft Graph intake + deterministic correlation)
-- Migration 0028
-- ----------------------------------------------------------------------------
-- Forward-only. Additive. Does NOT change any existing tables or policies.
--
-- Scope
-- -----
-- Adds the durable model that backs Phase 5A email intake:
--
--   * public.atlas_submission_intake_messages
--       One row per email observed and successfully attached / merged into an
--       Atlas submission (or moved to needs_review). Preserves per-submission
--       message history for reply chains without ever storing attachment bytes.
--
--   * public.atlas_intake_graph_state
--       One row per configured mailbox. Holds the Microsoft Graph delta cursor,
--       a cross-isolate lease (poll_in_flight_since) that prevents two Workers
--       from polling the same mailbox concurrently, and the failure counter that
--       lets the poller back off on persistent errors.
--
-- Boundaries (see checkpoint spec)
-- --------------------------------
--   * NO attachment metadata columns. Phase 5B territory.
--   * NO classification behaviour. The `processing_state` column exists so a
--     needs-review message can be persisted safely; it is not used for LLM
--     classification in this phase.
--   * Intake rows contain PII (sender address, subject, body_preview). RLS
--     ensures they are readable only through the parent submission's normal
--     access-scoping helper (atlas_can_access_submission). Direct writes are
--     denied to every authenticated role: only the service-role Worker inserts.
--   * atlas_intake_graph_state is operational integration state and is NEVER
--     readable by any authenticated Supabase role — service-role only.
--
-- Rationale for the phase-safe deduplication indexes
-- --------------------------------------------------
-- The spec calls for cross-mailbox duplicate delivery keyed by
-- internet_message_id to be idempotent.
--
-- A partial UNIQUE index on the non-null internet_message_id column is the
-- strongest safe enforcement consistent with the existing schema:
--   * historical rows (before this migration) do not exist for this table;
--   * Microsoft Graph guarantees internet_message_id per RFC 5322;
--   * a NULL internet_message_id (unusual, e.g. a stripped MAPI message)
--     must not fail closed — the partial index allows that row through but
--     the application-side lookup still runs.
--
-- The uniqueness is intentionally NOT scoped by mailbox: the whole point of
-- this constraint is to catch cross-mailbox duplicates.
-- ============================================================================

-- ---------- atlas_submission_intake_messages --------------------------------

create table if not exists public.atlas_submission_intake_messages (
  id                    uuid primary key default gen_random_uuid(),
  submission_id         uuid not null
                          references public.atlas_submissions(id) on delete cascade,
  -- 'email' today. Future intake channels will live under this same table.
  source                text not null,
  mailbox               text,
  graph_message_id      text,
  internet_message_id   text,
  conversation_id       text,
  sender_name           text,
  sender_address        text,
  recipients            jsonb,
  subject               text,
  body_preview          text,
  received_at           timestamptz,
  has_attachments       boolean not null default false,
  -- Lifecycle marker.
  --   'processed'    — attached to the submission cleanly.
  --   'needs_review' — persisted for operator review because deterministic
  --                    correlation was ambiguous (rule 4 or 5). Never
  --                    auto-attached to a specific case beyond the intake
  --                    review container the Worker created.
  processing_state      text not null default 'processed',
  ingested_at           timestamptz not null default now(),

  constraint atlas_intake_messages_source_check
    check (source in ('email')),
  constraint atlas_intake_messages_processing_state_check
    check (processing_state in ('processed', 'needs_review'))
);

comment on table public.atlas_submission_intake_messages is
  'Atlas Phase 5A: durable record of every intake message merged into an Atlas '
  'submission. Contains PII (sender/subject/body_preview); read access is derived '
  'from the parent submission via atlas_can_access_submission. Writes are '
  'service-role only.';
comment on column public.atlas_submission_intake_messages.processing_state is
  'processed | needs_review. needs_review indicates deterministic correlation '
  'was ambiguous; never auto-attached to a specific candidate submission.';
comment on column public.atlas_submission_intake_messages.graph_message_id is
  'Microsoft Graph message id (mailbox-scoped). Used with mailbox for '
  'per-mailbox duplicate suppression.';
comment on column public.atlas_submission_intake_messages.internet_message_id is
  'RFC 5322 Message-Id. Used for cross-mailbox duplicate suppression.';

-- ---------- Indexes / dedup ---------------------------------------------------

-- Per-mailbox duplicate suppression: same message re-delivered by a delta
-- replay must be a no-op.
create unique index if not exists atlas_intake_messages_mailbox_graph_uidx
  on public.atlas_submission_intake_messages (mailbox, graph_message_id)
  where mailbox is not null and graph_message_id is not null;

-- Cross-mailbox duplicate suppression by RFC 5322 Message-Id.
create unique index if not exists atlas_intake_messages_internet_id_uidx
  on public.atlas_submission_intake_messages (internet_message_id)
  where internet_message_id is not null;

-- Reply-header / conversation lookups.
create index if not exists atlas_intake_messages_conversation_idx
  on public.atlas_submission_intake_messages (conversation_id, received_at desc)
  where conversation_id is not null;

-- Submission-scoped fetch (read endpoint).
create index if not exists atlas_intake_messages_submission_idx
  on public.atlas_submission_intake_messages (submission_id, received_at desc);

-- ---------- RLS: read via parent submission; writes service-role only -------

alter table public.atlas_submission_intake_messages enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename  = 'atlas_submission_intake_messages'
      and policyname = 'atlas_intake_messages_scoped_select'
  ) then
    create policy atlas_intake_messages_scoped_select
      on public.atlas_submission_intake_messages
      for select
      to authenticated
      using (public.atlas_can_access_submission(submission_id));
  end if;
end $$;

-- NO insert/update/delete policies for authenticated. Absence of a policy on
-- a table with RLS enabled denies the operation entirely for non-service-role
-- callers. Only the service-role Worker writes intake rows.

-- ---------- atlas_intake_graph_state ----------------------------------------

create table if not exists public.atlas_intake_graph_state (
  mailbox                text primary key,
  delta_link             text,
  last_polled_at         timestamptz,
  last_success_at        timestamptz,
  last_error             text,
  consecutive_failures   integer not null default 0,
  -- Cross-isolate poll lease. When non-null and recent, another Worker is
  -- currently polling this mailbox. The application acquires the lease with a
  -- conditional UPDATE and releases it at the end of the poll.
  poll_in_flight_since   timestamptz
);

comment on table public.atlas_intake_graph_state is
  'Atlas Phase 5A: Microsoft Graph delta cursor and cross-isolate poll lease '
  'per configured mailbox. Operational integration state — service-role only, '
  'no authenticated read/write.';
comment on column public.atlas_intake_graph_state.delta_link is
  'Full @odata.deltaLink URL persisted verbatim after a successful poll. '
  'Treated as sensitive operational state and never logged or returned to '
  'authenticated callers.';
comment on column public.atlas_intake_graph_state.poll_in_flight_since is
  'Wall-clock timestamp at which the current poll lease was acquired. '
  'Bounded lease — see worker/src/graph-intake.ts (POLL_LEASE_STALE_MS).';

alter table public.atlas_intake_graph_state enable row level security;

-- Intentionally NO policies for authenticated/anon. RLS with no policy denies
-- all access; only the service-role Worker (which bypasses RLS by design)
-- reads/writes this table.
