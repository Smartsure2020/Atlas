-- ============================================================================
-- Atlas — Phase 5A (Graph intake) — Checkpoint 3 corrections
-- Migration 0030
-- ----------------------------------------------------------------------------
-- Forward-only. Additive to 0028/0029. Does two things:
--
-- 1. EXECUTE-privilege lockdown for every Phase 5A RPC, using the exact
--    revoke/grant pattern established in 0024. All Phase 5A functions live in
--    the `public` schema (the Data API's exposed schema), so relying on
--    Postgres/Supabase default privileges is unsafe. After this migration:
--       anon           → REVOKED
--       authenticated  → REVOKED
--       PUBLIC role    → REVOKED
--       service_role   → EXECUTE granted
--
--    (0029's earlier comment incorrectly implied the functions were outside
--    the exposed schema. They are not; this migration hardens them.)
--
-- 2. Extends the four transactional intake RPCs so that each logical intake
--    mutation atomically includes its required audit rows (and, for the
--    needs_review path, the required operational alert). This removes the
--    checkpoint-2 window in which committed data could exist without its
--    required audit / alert:
--
--       new email       → atlas_intake_ingest_new_email
--                          + submission_created_from_email audit
--                          + intake_message_recorded audit
--       attach          → atlas_intake_attach_message
--                          + intake_message_correlated audit
--       needs_review    → new atlas_intake_ingest_needs_review
--                          → review container + intake + audit + alert
--       poll success    → new atlas_intake_release_lease_success
--                          → fenced state advance + graph_poll_success audit
--                            (atomic)
--
-- Every audit metadata field passed into SQL is safe: intake_message_id,
-- correlation_rule_matched, mailbox_hash, graph_message_id_hash, candidate
-- submission UUIDs, aggregate counters. Raw sender / subject / body preview
-- are NEVER passed as audit metadata. RLS/permissions on atlas_audit_logs and
-- atlas_operational_alerts remain unchanged.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- Redeclare atlas_intake_ingest_new_email with atomic audit rows.
-- ---------------------------------------------------------------------------

drop function if exists public.atlas_intake_ingest_new_email(
  uuid, text, text, text, text, text, text, timestamptz,
  text, text, text, text, text, text, jsonb, text, text, boolean, text
);

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
  p_processing_state    text,
  p_correlation_rule    text,
  p_mailbox_hash        text,
  p_graph_message_id_hash text
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

  -- Atomic audits — safe metadata only.
  insert into public.atlas_audit_logs (submission_id, action, actor, metadata_json)
  values (
    v_new_submission_id,
    'submission_created_from_email',
    null,
    jsonb_build_object(
      'intake_message_id',        v_new_intake_id,
      'correlation_rule_matched', p_correlation_rule,
      'graph_message_id_hash',    p_graph_message_id_hash,
      'mailbox_hash',             p_mailbox_hash
    )
  );
  insert into public.atlas_audit_logs (submission_id, action, actor, metadata_json)
  values (
    v_new_submission_id,
    'intake_message_recorded',
    null,
    jsonb_build_object(
      'intake_message_id', v_new_intake_id,
      'mailbox_hash',      p_mailbox_hash
    )
  );

  outcome := 'created';
  submission_id := v_new_submission_id;
  intake_message_id := v_new_intake_id;
  return next;
end;
$$;


-- ---------------------------------------------------------------------------
-- Redeclare atlas_intake_attach_message with atomic audit row.
-- ---------------------------------------------------------------------------

drop function if exists public.atlas_intake_attach_message(
  uuid, text, text, text, text, text, text, jsonb, text, text, timestamptz, boolean, text
);

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
  p_processing_state    text,
  p_correlation_rule    text,
  p_mailbox_hash        text,
  p_graph_message_id_hash text
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

  insert into public.atlas_audit_logs (submission_id, action, actor, metadata_json)
  values (
    p_submission_id,
    'intake_message_correlated',
    null,
    jsonb_build_object(
      'intake_message_id',        v_new_intake_id,
      'correlation_rule_matched', p_correlation_rule,
      'graph_message_id_hash',    p_graph_message_id_hash,
      'mailbox_hash',             p_mailbox_hash
    )
  );

  outcome := 'attached';
  intake_message_id := v_new_intake_id;
  return next;
end;
$$;


-- ---------------------------------------------------------------------------
-- New atlas_intake_ingest_needs_review: container submission + intake +
-- audit + operational alert, all-or-nothing.
-- ---------------------------------------------------------------------------

create or replace function public.atlas_intake_ingest_needs_review(
  p_system_actor_id       uuid,
  p_source_type           text,
  p_pipeline_stage        text,
  p_queue_status          text,
  p_status                text,
  p_priority              text,
  p_next_action           text,
  p_received_at           timestamptz,
  p_mailbox               text,
  p_graph_message_id      text,
  p_internet_message_id   text,
  p_conversation_id       text,
  p_sender_name           text,
  p_sender_address        text,
  p_recipients            jsonb,
  p_subject               text,
  p_body_preview          text,
  p_has_attachments       boolean,
  p_correlation_rule      text,
  p_mailbox_hash          text,
  p_graph_message_id_hash text,
  p_candidate_ids         jsonb,
  p_alert_title           text,
  p_alert_message         text
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
  v_candidate_count   integer;
begin
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

  insert into public.atlas_submission_intake_messages (
    submission_id, source, mailbox, graph_message_id, internet_message_id,
    conversation_id, sender_name, sender_address, recipients, subject,
    body_preview, received_at, has_attachments, processing_state
  ) values (
    v_new_submission_id, 'email', p_mailbox, p_graph_message_id, p_internet_message_id,
    p_conversation_id, p_sender_name, p_sender_address, p_recipients, p_subject,
    p_body_preview, p_received_at, coalesce(p_has_attachments, false), 'needs_review'
  )
  returning id into v_new_intake_id;

  v_candidate_count := coalesce(jsonb_array_length(p_candidate_ids), 0);

  insert into public.atlas_audit_logs (submission_id, action, actor, metadata_json)
  values (
    v_new_submission_id,
    'intake_correlation_needs_review',
    null,
    jsonb_build_object(
      'intake_message_id',        v_new_intake_id,
      'correlation_rule_matched', p_correlation_rule,
      'graph_message_id_hash',    p_graph_message_id_hash,
      'mailbox_hash',             p_mailbox_hash,
      'candidate_submission_ids', p_candidate_ids
    )
  );

  insert into public.atlas_operational_alerts (
    alert_type, severity, status, title, message,
    related_submission_id, metadata
  ) values (
    'intake_correlation_needs_review',
    'warning',
    'open',
    p_alert_title,
    p_alert_message,
    v_new_submission_id,
    jsonb_build_object(
      'intake_message_id', v_new_intake_id,
      'candidate_count',   v_candidate_count,
      'rule',              p_correlation_rule
    )
  );

  outcome := 'created';
  submission_id := v_new_submission_id;
  intake_message_id := v_new_intake_id;
  return next;
end;
$$;


-- ---------------------------------------------------------------------------
-- Fenced success-completion RPC.
--
-- Advances the delta cursor + clears failure/breaker/throttle state + writes
-- the required graph_poll_success audit, ALL under one transaction and only
-- when the caller still owns the lease.
--
-- Returns { ok: true } when the fence matched and the transaction committed,
-- { ok: false, reason: 'lease_lost' } otherwise. The state is untouched on a
-- lost fence; the caller must not report a false poll success.
-- ---------------------------------------------------------------------------

create or replace function public.atlas_intake_release_lease_success(
  p_mailbox              text,
  p_expected_lease_id    uuid,
  p_delta_link           text,
  p_delta_link_provided  boolean,
  p_in_round_next_link   text,
  p_in_round_provided    boolean,
  p_last_success_at      timestamptz,
  p_audit_metadata       jsonb
)
returns table (
  ok     boolean,
  reason text
)
language plpgsql
security invoker
set search_path to pg_catalog, public
as $$
declare
  v_match integer;
begin
  update public.atlas_intake_graph_state s
     set poll_in_flight_since = null,
         lease_id             = null,
         delta_link           = case when p_delta_link_provided then p_delta_link else s.delta_link end,
         in_round_next_link   = case when p_in_round_provided  then p_in_round_next_link else s.in_round_next_link end,
         last_error           = null,
         consecutive_failures = 0,
         last_success_at      = coalesce(p_last_success_at, s.last_success_at),
         breaker_opened_at    = null,
         next_attempt_after   = null
   where s.mailbox  = p_mailbox
     and s.lease_id = p_expected_lease_id;
  get diagnostics v_match = row_count;

  if v_match = 0 then
    ok := false;
    reason := 'lease_lost';
    return next;
    return;
  end if;

  insert into public.atlas_audit_logs (submission_id, action, actor, metadata_json)
  values (null, 'graph_poll_success', null, p_audit_metadata);

  ok := true;
  reason := null;
  return next;
end;
$$;


-- ---------------------------------------------------------------------------
-- Function EXECUTE hardening — mirror 0024's pattern for every Phase 5A RPC.
-- ---------------------------------------------------------------------------

-- 0029 lease acquire
revoke all on function public.atlas_intake_acquire_lease(text, timestamptz, uuid, timestamptz) from public;
revoke all on function public.atlas_intake_acquire_lease(text, timestamptz, uuid, timestamptz) from anon;
revoke all on function public.atlas_intake_acquire_lease(text, timestamptz, uuid, timestamptz) from authenticated;
grant  execute on function public.atlas_intake_acquire_lease(text, timestamptz, uuid, timestamptz) to service_role;

-- 0029 generic lease release (still used for the failure/skip paths)
revoke all on function public.atlas_intake_release_lease(
  text, uuid, text, boolean, text, boolean, text, integer, timestamptz, timestamptz, timestamptz, boolean, timestamptz, boolean
) from public;
revoke all on function public.atlas_intake_release_lease(
  text, uuid, text, boolean, text, boolean, text, integer, timestamptz, timestamptz, timestamptz, boolean, timestamptz, boolean
) from anon;
revoke all on function public.atlas_intake_release_lease(
  text, uuid, text, boolean, text, boolean, text, integer, timestamptz, timestamptz, timestamptz, boolean, timestamptz, boolean
) from authenticated;
grant  execute on function public.atlas_intake_release_lease(
  text, uuid, text, boolean, text, boolean, text, integer, timestamptz, timestamptz, timestamptz, boolean, timestamptz, boolean
) to service_role;

-- New (this migration) fenced success-completion RPC
revoke all on function public.atlas_intake_release_lease_success(
  text, uuid, text, boolean, text, boolean, timestamptz, jsonb
) from public;
revoke all on function public.atlas_intake_release_lease_success(
  text, uuid, text, boolean, text, boolean, timestamptz, jsonb
) from anon;
revoke all on function public.atlas_intake_release_lease_success(
  text, uuid, text, boolean, text, boolean, timestamptz, jsonb
) from authenticated;
grant  execute on function public.atlas_intake_release_lease_success(
  text, uuid, text, boolean, text, boolean, timestamptz, jsonb
) to service_role;

-- Redeclared ingest_new_email (extended signature)
revoke all on function public.atlas_intake_ingest_new_email(
  uuid, text, text, text, text, text, text, timestamptz,
  text, text, text, text, text, text, jsonb, text, text, boolean, text, text, text, text
) from public;
revoke all on function public.atlas_intake_ingest_new_email(
  uuid, text, text, text, text, text, text, timestamptz,
  text, text, text, text, text, text, jsonb, text, text, boolean, text, text, text, text
) from anon;
revoke all on function public.atlas_intake_ingest_new_email(
  uuid, text, text, text, text, text, text, timestamptz,
  text, text, text, text, text, text, jsonb, text, text, boolean, text, text, text, text
) from authenticated;
grant  execute on function public.atlas_intake_ingest_new_email(
  uuid, text, text, text, text, text, text, timestamptz,
  text, text, text, text, text, text, jsonb, text, text, boolean, text, text, text, text
) to service_role;

-- Redeclared attach_message (extended signature)
revoke all on function public.atlas_intake_attach_message(
  uuid, text, text, text, text, text, text, jsonb, text, text, timestamptz, boolean, text, text, text, text
) from public;
revoke all on function public.atlas_intake_attach_message(
  uuid, text, text, text, text, text, text, jsonb, text, text, timestamptz, boolean, text, text, text, text
) from anon;
revoke all on function public.atlas_intake_attach_message(
  uuid, text, text, text, text, text, text, jsonb, text, text, timestamptz, boolean, text, text, text, text
) from authenticated;
grant  execute on function public.atlas_intake_attach_message(
  uuid, text, text, text, text, text, text, jsonb, text, text, timestamptz, boolean, text, text, text, text
) to service_role;

-- New (this migration) needs_review ingest
revoke all on function public.atlas_intake_ingest_needs_review(
  uuid, text, text, text, text, text, text, timestamptz,
  text, text, text, text, text, text, jsonb, text, text, boolean,
  text, text, text, jsonb, text, text
) from public;
revoke all on function public.atlas_intake_ingest_needs_review(
  uuid, text, text, text, text, text, text, timestamptz,
  text, text, text, text, text, text, jsonb, text, text, boolean,
  text, text, text, jsonb, text, text
) from anon;
revoke all on function public.atlas_intake_ingest_needs_review(
  uuid, text, text, text, text, text, text, timestamptz,
  text, text, text, text, text, text, jsonb, text, text, boolean,
  text, text, text, jsonb, text, text
) from authenticated;
grant  execute on function public.atlas_intake_ingest_needs_review(
  uuid, text, text, text, text, text, text, timestamptz,
  text, text, text, text, text, text, jsonb, text, text, boolean,
  text, text, text, jsonb, text, text
) to service_role;
