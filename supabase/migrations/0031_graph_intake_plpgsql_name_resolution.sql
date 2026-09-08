-- ============================================================================
-- Atlas — Phase 5A (Graph intake) — Checkpoint 5 corrective migration
-- Migration 0031
-- ----------------------------------------------------------------------------
-- Forward-only. Additive to 0028–0030. Does NOT rewrite migration history.
--
-- Problem
-- -------
-- Checkpoint 4 real-Postgres testing showed three RPCs raise SQLSTATE 42702
-- (column reference is ambiguous) because their `RETURNS TABLE (…)` OUT
-- column names collide with column references inside the plpgsql body:
--
--   atlas_intake_acquire_lease
--     "mailbox" ambiguous
--     (RETURNS TABLE (mailbox …)  vs  ON CONFLICT (mailbox))
--
--   atlas_intake_ingest_new_email
--     "submission_id" ambiguous
--     (RETURNS TABLE (…, submission_id, …)  vs
--      SELECT id, submission_id FROM atlas_submission_intake_messages)
--
--   atlas_intake_ingest_needs_review
--     "submission_id" ambiguous  (same shape as ingest_new_email)
--
-- The mocked-`admin.rpc` behavioural suite fabricated return payloads and
-- never invoked plpgsql, so the class of defect was invisible until staging.
--
-- Correction principle (per Checkpoint 5 §5)
-- ------------------------------------------
--   * EXPLICITLY QUALIFY every table column with a table alias.
--   * Do NOT introduce `#variable_conflict use_column`.
--   * Do NOT change the Worker-facing return column names.
--   * Do NOT change SECURITY INVOKER / search_path pinning.
--   * Do NOT change function signatures.
--
-- Additional per §7 for ON CONFLICT — a `(column)` conflict target inside
-- plpgsql cannot be aliased. Use the primary-key CONSTRAINT NAME instead:
--
--   ON CONFLICT ON CONSTRAINT atlas_intake_graph_state_pkey DO NOTHING
--
-- Audit
-- -----
-- Every effective Phase 5A RPC was inspected. The other three
-- (release_lease, release_lease_success, attach_message) already qualify
-- every column reference through explicit aliases, and their bodies were
-- exercised on staging with no 42702. Only the three above are recreated
-- here.
--
-- Post-recreate the migration reapplies REVOKE/GRANT for each recreated
-- function even though CREATE OR REPLACE preserves privileges when the
-- identity is unchanged — belt-and-braces per §10.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 1. atlas_intake_acquire_lease — fix ON CONFLICT + qualify with alias `gs`
-- ---------------------------------------------------------------------------

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
  -- First-time observation: create the state row.
  -- Use the primary-key CONSTRAINT NAME so plpgsql cannot mis-resolve the
  -- unqualified `mailbox` inside `ON CONFLICT (mailbox)` as the OUT column.
  insert into public.atlas_intake_graph_state as gs (mailbox)
  values (p_mailbox)
  on conflict on constraint atlas_intake_graph_state_pkey do nothing;

  -- Fenced CAS acquire. Alias `gs` everywhere; every column reference is
  -- fully qualified against the alias so it cannot collide with the OUT
  -- variables of the same names.
  return query
    update public.atlas_intake_graph_state as gs
       set poll_in_flight_since = p_now,
           last_polled_at       = p_now,
           lease_id             = p_new_lease_id
     where gs.mailbox = p_mailbox
       and (gs.poll_in_flight_since is null
            or gs.poll_in_flight_since < p_stale_cutoff_iso)
       and (gs.next_attempt_after   is null
            or gs.next_attempt_after <= p_now)
     returning gs.mailbox,
              gs.delta_link,
              gs.in_round_next_link,
              gs.last_polled_at,
              gs.last_success_at,
              gs.last_error,
              gs.consecutive_failures,
              gs.poll_in_flight_since,
              gs.lease_id,
              gs.breaker_opened_at,
              gs.last_failure_at,
              gs.next_attempt_after;
end;
$$;

comment on function public.atlas_intake_acquire_lease(text, timestamptz, uuid, timestamptz) is
  'Atomic fenced lease acquisition for Graph intake polling. Returns no rows '
  'if the mailbox is currently leased and the lease is not stale, or if the '
  'Retry-After boundary has not yet passed. Recreated in 0031 to eliminate '
  'plpgsql 42702 ambiguity on the ON CONFLICT target.';


-- ---------------------------------------------------------------------------
-- 2. atlas_intake_ingest_new_email — qualify intake queries with alias `im`
-- ---------------------------------------------------------------------------

create or replace function public.atlas_intake_ingest_new_email(
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
  p_processing_state      text,
  p_correlation_rule      text,
  p_mailbox_hash          text,
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
  v_existing_intake_id            uuid;
  v_existing_intake_submission_id uuid;
  v_new_submission_id             uuid;
  v_new_intake_id                 uuid;
begin
  -- Rule 2 short-circuit: cross-mailbox duplicate by RFC 5322 Message-Id.
  -- Alias `im`; qualify every column reference.
  if p_internet_message_id is not null then
    select im.id, im.submission_id
      into v_existing_intake_id, v_existing_intake_submission_id
      from public.atlas_submission_intake_messages as im
     where im.internet_message_id = p_internet_message_id
     limit 1;
    if found then
      outcome           := 'duplicate_internet_message_id';
      submission_id     := v_existing_intake_submission_id;
      intake_message_id := v_existing_intake_id;
      return next;
      return;
    end if;
  end if;

  -- Rule 1 short-circuit: per-mailbox duplicate by Graph message id.
  select im.id, im.submission_id
    into v_existing_intake_id, v_existing_intake_submission_id
    from public.atlas_submission_intake_messages as im
   where im.mailbox          = p_mailbox
     and im.graph_message_id = p_graph_message_id
   limit 1;
  if found then
    outcome           := 'duplicate_graph_message_id';
    submission_id     := v_existing_intake_submission_id;
    intake_message_id := v_existing_intake_id;
    return next;
    return;
  end if;

  insert into public.atlas_submissions (
    created_by, source_type, status, queue_status, pipeline_stage,
    received_at, last_pipeline_stage_changed_at, priority, next_action
  ) values (
    p_system_actor_id, p_source_type,
    p_status::atlas_submission_status,
    p_queue_status::atlas_queue_status,
    p_pipeline_stage::atlas_pipeline_stage,
    coalesce(p_received_at, now()), now(), p_priority, p_next_action
  )
  returning id into v_new_submission_id;

  insert into public.atlas_submission_intake_messages as im (
    submission_id, source, mailbox, graph_message_id, internet_message_id,
    conversation_id, sender_name, sender_address, recipients, subject,
    body_preview, received_at, has_attachments, processing_state
  ) values (
    v_new_submission_id, 'email', p_mailbox, p_graph_message_id, p_internet_message_id,
    p_conversation_id, p_sender_name, p_sender_address, p_recipients, p_subject,
    p_body_preview, p_received_at, coalesce(p_has_attachments, false), p_processing_state
  )
  returning im.id into v_new_intake_id;

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

  outcome           := 'created';
  submission_id     := v_new_submission_id;
  intake_message_id := v_new_intake_id;
  return next;
end;
$$;

comment on function public.atlas_intake_ingest_new_email(
  uuid, text, text, text, text, text, text, timestamptz,
  text, text, text, text, text, text, jsonb, text, text, boolean, text,
  text, text, text
) is
  'Transactional new-submission + first-intake insert + required audits. '
  'Duplicate detection is transactional. Recreated in 0031 to eliminate '
  'plpgsql 42702 ambiguity on submission_id.';


-- ---------------------------------------------------------------------------
-- 3. atlas_intake_ingest_needs_review — same fix
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
  v_existing_intake_id            uuid;
  v_existing_intake_submission_id uuid;
  v_new_submission_id             uuid;
  v_new_intake_id                 uuid;
  v_candidate_count               integer;
begin
  if p_internet_message_id is not null then
    select im.id, im.submission_id
      into v_existing_intake_id, v_existing_intake_submission_id
      from public.atlas_submission_intake_messages as im
     where im.internet_message_id = p_internet_message_id
     limit 1;
    if found then
      outcome           := 'duplicate_internet_message_id';
      submission_id     := v_existing_intake_submission_id;
      intake_message_id := v_existing_intake_id;
      return next;
      return;
    end if;
  end if;

  select im.id, im.submission_id
    into v_existing_intake_id, v_existing_intake_submission_id
    from public.atlas_submission_intake_messages as im
   where im.mailbox          = p_mailbox
     and im.graph_message_id = p_graph_message_id
   limit 1;
  if found then
    outcome           := 'duplicate_graph_message_id';
    submission_id     := v_existing_intake_submission_id;
    intake_message_id := v_existing_intake_id;
    return next;
    return;
  end if;

  insert into public.atlas_submissions (
    created_by, source_type, status, queue_status, pipeline_stage,
    received_at, last_pipeline_stage_changed_at, priority, next_action
  ) values (
    p_system_actor_id, p_source_type,
    p_status::atlas_submission_status,
    p_queue_status::atlas_queue_status,
    p_pipeline_stage::atlas_pipeline_stage,
    coalesce(p_received_at, now()), now(), p_priority, p_next_action
  )
  returning id into v_new_submission_id;

  insert into public.atlas_submission_intake_messages as im (
    submission_id, source, mailbox, graph_message_id, internet_message_id,
    conversation_id, sender_name, sender_address, recipients, subject,
    body_preview, received_at, has_attachments, processing_state
  ) values (
    v_new_submission_id, 'email', p_mailbox, p_graph_message_id, p_internet_message_id,
    p_conversation_id, p_sender_name, p_sender_address, p_recipients, p_subject,
    p_body_preview, p_received_at, coalesce(p_has_attachments, false), 'needs_review'
  )
  returning im.id into v_new_intake_id;

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

  outcome           := 'created';
  submission_id     := v_new_submission_id;
  intake_message_id := v_new_intake_id;
  return next;
end;
$$;

comment on function public.atlas_intake_ingest_needs_review(
  uuid, text, text, text, text, text, text, timestamptz,
  text, text, text, text, text, text, jsonb, text, text, boolean,
  text, text, text, jsonb, text, text
) is
  'Transactional review-container + intake + audit + alert. Recreated in '
  '0031 to eliminate plpgsql 42702 ambiguity on submission_id.';


-- ---------------------------------------------------------------------------
-- Reapply EXECUTE privileges. CREATE OR REPLACE with unchanged identity
-- should retain privileges, but Checkpoint 5 §10 requires an explicit
-- reapplication for defence in depth.
-- ---------------------------------------------------------------------------

revoke all on function public.atlas_intake_acquire_lease(
  text, timestamptz, uuid, timestamptz
) from public;
revoke all on function public.atlas_intake_acquire_lease(
  text, timestamptz, uuid, timestamptz
) from anon;
revoke all on function public.atlas_intake_acquire_lease(
  text, timestamptz, uuid, timestamptz
) from authenticated;
grant  execute on function public.atlas_intake_acquire_lease(
  text, timestamptz, uuid, timestamptz
) to service_role;

revoke all on function public.atlas_intake_ingest_new_email(
  uuid, text, text, text, text, text, text, timestamptz,
  text, text, text, text, text, text, jsonb, text, text, boolean, text,
  text, text, text
) from public;
revoke all on function public.atlas_intake_ingest_new_email(
  uuid, text, text, text, text, text, text, timestamptz,
  text, text, text, text, text, text, jsonb, text, text, boolean, text,
  text, text, text
) from anon;
revoke all on function public.atlas_intake_ingest_new_email(
  uuid, text, text, text, text, text, text, timestamptz,
  text, text, text, text, text, text, jsonb, text, text, boolean, text,
  text, text, text
) from authenticated;
grant  execute on function public.atlas_intake_ingest_new_email(
  uuid, text, text, text, text, text, text, timestamptz,
  text, text, text, text, text, text, jsonb, text, text, boolean, text,
  text, text, text
) to service_role;

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
