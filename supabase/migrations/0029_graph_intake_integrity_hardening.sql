-- ============================================================================
-- Atlas — Phase 5A (Graph intake) — integrity hardening (Checkpoint 2)
-- Migration 0029
-- ----------------------------------------------------------------------------
-- Forward-only. Additive to 0028. Corrects the following independent-review
-- findings without weakening any 0028 constraint:
--
--   * lease ownership fencing (lease_id uuid)
--   * durable resumable next_link checkpoint (in_round_next_link)
--   * circuit-breaker state independent of last_polled_at
--     (breaker_opened_at, last_failure_at)
--   * Retry-After / throttling boundary (next_attempt_after)
--   * atomic new-submission + intake insert via SQL functions that either
--     commit the pair together or leave no rows behind
--   * fenced lease acquire/release helpers
-- ----------------------------------------------------------------------------
-- All new columns are NULLABLE. Existing 0028 rows (staging: none yet) stay
-- valid unchanged.
--
-- Every helper function is SECURITY INVOKER (default). The service-role
-- Worker is the only caller; PostgREST direct calls are blocked because the
-- functions live outside the exposed schema by omission and the Worker uses
-- the service-role key.
-- ============================================================================

-- ---------- graph_state new columns ----------------------------------------

alter table public.atlas_intake_graph_state
  add column if not exists lease_id             uuid,
  add column if not exists in_round_next_link   text,
  add column if not exists breaker_opened_at    timestamptz,
  add column if not exists last_failure_at      timestamptz,
  add column if not exists next_attempt_after   timestamptz;

comment on column public.atlas_intake_graph_state.lease_id is
  'Opaque per-acquisition token. Every release/success/failure update MUST '
  'require lease_id = expected_lease_id so a resumed slow worker cannot '
  'overwrite a newer acquirer''s state (fencing). Rotates on every acquire.';
comment on column public.atlas_intake_graph_state.in_round_next_link is
  'Intermediate resumable cursor persisted when a poll exhausts its page '
  'budget mid-round. The next poll starts here rather than at delta_link. '
  'Cleared on the tick that finally receives @odata.deltaLink.';
comment on column public.atlas_intake_graph_state.breaker_opened_at is
  'Set when consecutive_failures crosses the threshold. Distinct from '
  'last_polled_at (which the acquirer stamps unconditionally) so the '
  'cooldown anchor cannot be moved forward by acquisition alone.';
comment on column public.atlas_intake_graph_state.next_attempt_after is
  'Wall-clock earliest allowed next Graph attempt for this mailbox. Set from '
  'Retry-After on 429 responses; consulted before acquisition.';

-- ---------- Fenced lease acquire -------------------------------------------
-- Returns the acquired state row (or nothing when the mailbox is already
-- leased and not stale, or the throttling window is still active). The caller
-- passes in a fresh lease_id and every subsequent write for this poll must
-- present that value.

create or replace function public.atlas_intake_acquire_lease(
  p_mailbox           text,
  p_stale_cutoff_iso  timestamptz,
  p_new_lease_id      uuid,
  p_now               timestamptz
)
returns table (
  mailbox              text,
  delta_link           text,
  in_round_next_link   text,
  last_polled_at       timestamptz,
  last_success_at      timestamptz,
  last_error           text,
  consecutive_failures integer,
  poll_in_flight_since timestamptz,
  lease_id             uuid,
  breaker_opened_at    timestamptz,
  last_failure_at      timestamptz,
  next_attempt_after   timestamptz
)
language plpgsql
security invoker
set search_path to pg_catalog, public
as $$
begin
  -- Create the row if this is the first time we see the mailbox.
  insert into public.atlas_intake_graph_state (mailbox)
  values (p_mailbox)
  on conflict (mailbox) do nothing;

  return query
    update public.atlas_intake_graph_state s
       set poll_in_flight_since = p_now,
           last_polled_at       = p_now,
           lease_id             = p_new_lease_id
     where s.mailbox = p_mailbox
       and (s.poll_in_flight_since is null
            or s.poll_in_flight_since < p_stale_cutoff_iso)
       and (s.next_attempt_after   is null
            or s.next_attempt_after <= p_now)
     returning s.mailbox,
              s.delta_link,
              s.in_round_next_link,
              s.last_polled_at,
              s.last_success_at,
              s.last_error,
              s.consecutive_failures,
              s.poll_in_flight_since,
              s.lease_id,
              s.breaker_opened_at,
              s.last_failure_at,
              s.next_attempt_after;
end;
$$;

comment on function public.atlas_intake_acquire_lease(text, timestamptz, uuid, timestamptz) is
  'Atomic fenced lease acquisition for Graph intake polling. Returns no rows '
  'if the mailbox is currently leased and the lease is not stale, or if the '
  'Retry-After boundary has not yet passed.';

-- ---------- Fenced lease release / state update ----------------------------
-- Returns rows only when the presented lease_id still matches — that is, the
-- caller is still the rightful owner of the poll. When ownership was already
-- reclaimed by another isolate, no state is mutated and the caller must not
-- interpret its own success as a poll completion.

create or replace function public.atlas_intake_release_lease(
  p_mailbox                text,
  p_expected_lease_id      uuid,
  p_delta_link             text,
  p_delta_link_provided    boolean,
  p_in_round_next_link     text,
  p_in_round_provided      boolean,
  p_last_error             text,
  p_consecutive_failures   integer,
  p_last_success_at        timestamptz,
  p_last_failure_at        timestamptz,
  p_breaker_opened_at      timestamptz,
  p_breaker_provided       boolean,
  p_next_attempt_after     timestamptz,
  p_next_attempt_provided  boolean
)
returns table (mailbox text)
language plpgsql
security invoker
set search_path to pg_catalog, public
as $$
begin
  return query
    update public.atlas_intake_graph_state s
       set poll_in_flight_since = null,
           lease_id             = null,
           delta_link           = case when p_delta_link_provided then p_delta_link else s.delta_link end,
           in_round_next_link   = case when p_in_round_provided  then p_in_round_next_link else s.in_round_next_link end,
           last_error           = p_last_error,
           consecutive_failures = coalesce(p_consecutive_failures, s.consecutive_failures),
           last_success_at      = coalesce(p_last_success_at, s.last_success_at),
           last_failure_at      = coalesce(p_last_failure_at, s.last_failure_at),
           breaker_opened_at    = case when p_breaker_provided then p_breaker_opened_at else s.breaker_opened_at end,
           next_attempt_after   = case when p_next_attempt_provided then p_next_attempt_after else s.next_attempt_after end
     where s.mailbox  = p_mailbox
       and s.lease_id = p_expected_lease_id
     returning s.mailbox;
end;
$$;

comment on function public.atlas_intake_release_lease is
  'Fenced release. UPDATE runs only when the caller still owns the lease '
  '(lease_id equality). Returns no rows on lease_lost — the caller must not '
  'declare the poll complete.';

-- ---------- Atomic new-submission ingest -----------------------------------
-- Creates a fresh Atlas submission + first intake message inside a single
-- transaction. Duplicate detection is enforced via ON CONFLICT on the two
-- 0028 unique indexes so a race across mailboxes cannot leave an orphan
-- submission behind.

create or replace function public.atlas_intake_ingest_new_email(
  p_system_actor_id     uuid,
  p_source_type         text,
  p_pipeline_stage      text,
  p_queue_status        text,
  p_status              text,
  p_priority            text,
  p_next_action         text,
  p_received_at         timestamptz,
  p_mailbox             text,
  p_graph_message_id    text,
  p_internet_message_id text,
  p_conversation_id     text,
  p_sender_name         text,
  p_sender_address      text,
  p_recipients          jsonb,
  p_subject             text,
  p_body_preview        text,
  p_has_attachments     boolean,
  p_processing_state    text
)
returns table (
  outcome           text,
  submission_id     uuid,
  intake_message_id uuid
)
language plpgsql
security invoker
set search_path to pg_catalog, public
as $$
declare
  v_existing_intake   record;
  v_new_submission_id uuid;
  v_new_intake_id     uuid;
begin
  -- Rule 1 / Rule 2 short-circuit inside the same transaction so a racer
  -- committing between our lookup and insert still resolves consistently.
  if p_internet_message_id is not null then
    select id, submission_id
      into v_existing_intake
      from public.atlas_submission_intake_messages
     where internet_message_id = p_internet_message_id
     limit 1;
    if found then
      outcome := 'duplicate_internet_message_id';
      submission_id := v_existing_intake.submission_id;
      intake_message_id := v_existing_intake.id;
      return next;
      return;
    end if;
  end if;

  select id, submission_id
    into v_existing_intake
    from public.atlas_submission_intake_messages
   where mailbox = p_mailbox
     and graph_message_id = p_graph_message_id
   limit 1;
  if found then
    outcome := 'duplicate_graph_message_id';
    submission_id := v_existing_intake.submission_id;
    intake_message_id := v_existing_intake.id;
    return next;
    return;
  end if;

  insert into public.atlas_submissions (
    created_by, source_type, status, queue_status, pipeline_stage,
    received_at, last_pipeline_stage_changed_at, priority, next_action
  ) values (
    p_system_actor_id, p_source_type, p_status, p_queue_status, p_pipeline_stage::atlas_pipeline_stage,
    coalesce(p_received_at, now()), now(), p_priority, p_next_action
  )
  returning id into v_new_submission_id;

  begin
    insert into public.atlas_submission_intake_messages (
      submission_id, source, mailbox, graph_message_id, internet_message_id,
      conversation_id, sender_name, sender_address, recipients, subject,
      body_preview, received_at, has_attachments, processing_state
    ) values (
      v_new_submission_id, 'email', p_mailbox, p_graph_message_id, p_internet_message_id,
      p_conversation_id, p_sender_name, p_sender_address, p_recipients, p_subject,
      p_body_preview, p_received_at, coalesce(p_has_attachments, false), p_processing_state
    )
    returning id into v_new_intake_id;
  exception
    when unique_violation then
      -- A concurrent insert won the race between our short-circuit lookup and
      -- our INSERT. Roll back the new submission by RAISING; the transaction
      -- around this function ensures nothing is left behind. The caller
      -- re-runs correlation on the next tick.
      raise;
  end;

  outcome := 'created';
  submission_id := v_new_submission_id;
  intake_message_id := v_new_intake_id;
  return next;
end;
$$;

comment on function public.atlas_intake_ingest_new_email is
  'Transactional new-submission + first-intake insert. On duplicate '
  'internet_message_id or (mailbox, graph_message_id) the submission is '
  'NOT created — no orphan rows possible.';

-- ---------- Attach an intake row to an existing submission -----------------

create or replace function public.atlas_intake_attach_message(
  p_submission_id       uuid,
  p_mailbox             text,
  p_graph_message_id    text,
  p_internet_message_id text,
  p_conversation_id     text,
  p_sender_name         text,
  p_sender_address      text,
  p_recipients          jsonb,
  p_subject             text,
  p_body_preview        text,
  p_received_at         timestamptz,
  p_has_attachments     boolean,
  p_processing_state    text
)
returns table (
  outcome           text,
  intake_message_id uuid
)
language plpgsql
security invoker
set search_path to pg_catalog, public
as $$
declare
  v_existing_intake record;
  v_new_intake_id   uuid;
begin
  if p_internet_message_id is not null then
    select id
      into v_existing_intake
      from public.atlas_submission_intake_messages
     where internet_message_id = p_internet_message_id
     limit 1;
    if found then
      outcome := 'duplicate_internet_message_id';
      intake_message_id := v_existing_intake.id;
      return next;
      return;
    end if;
  end if;

  select id
    into v_existing_intake
    from public.atlas_submission_intake_messages
   where mailbox = p_mailbox
     and graph_message_id = p_graph_message_id
   limit 1;
  if found then
    outcome := 'duplicate_graph_message_id';
    intake_message_id := v_existing_intake.id;
    return next;
    return;
  end if;

  insert into public.atlas_submission_intake_messages (
    submission_id, source, mailbox, graph_message_id, internet_message_id,
    conversation_id, sender_name, sender_address, recipients, subject,
    body_preview, received_at, has_attachments, processing_state
  ) values (
    p_submission_id, 'email', p_mailbox, p_graph_message_id, p_internet_message_id,
    p_conversation_id, p_sender_name, p_sender_address, p_recipients, p_subject,
    p_body_preview, p_received_at, coalesce(p_has_attachments, false), p_processing_state
  )
  returning id into v_new_intake_id;

  outcome := 'attached';
  intake_message_id := v_new_intake_id;
  return next;
end;
$$;

comment on function public.atlas_intake_attach_message is
  'Idempotent single-message attach for existing submissions. Duplicate '
  'detection is transactional; no partial writes.';
