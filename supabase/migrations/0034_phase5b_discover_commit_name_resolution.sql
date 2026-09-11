-- ============================================================================
-- Atlas — Phase 5B (Graph attachment ingestion) — Checkpoint 3 corrective
-- Migration 0034
-- ----------------------------------------------------------------------------
-- Forward-only. Additive to 0032/0033. Does NOT rewrite migration history.
--
-- Problem
-- -------
-- Real-Postgres staging discovered that atlas_intake_attachment_discover_commit
-- raises SQLSTATE 42702 (column reference is ambiguous) on the
--
--   ON CONFLICT (mailbox, graph_message_id, graph_attachment_id) DO NOTHING
--
-- clause: `graph_attachment_id` (and, transitively, `state`) can be either the
-- table column or the RETURNS TABLE OUT variable. plpgsql refuses to guess.
-- The mocked-`admin.rpc` behavioural suite fabricated return payloads and
-- never invoked plpgsql, so the class of defect was invisible until staging —
-- the exact failure pattern Phase 5A Checkpoint 5 already exposed for the
-- three ingest RPCs (see 0031).
--
-- Correction principle (per 0031)
-- -------------------------------
--   * Prefer explicit constraint targeting over unqualified column ON CONFLICT
--     when OUT names collide with column names.
--   * Do NOT introduce `#variable_conflict use_column` (breaks the OUT
--     assignments at the end of the function).
--   * Do NOT change the Worker-facing return column names.
--   * Do NOT change SECURITY INVOKER / search_path pinning.
--   * Do NOT change the function's IDENTITY arguments (Worker code compatible).
--
-- Fix
-- ---
-- 1. Attach the existing unique index atlas_intake_attachments_graph_uidx to a
--    named UNIQUE CONSTRAINT via ALTER TABLE ... ADD CONSTRAINT ... USING
--    INDEX. This creates a constraint plpgsql can reference by name; the
--    underlying index rows are untouched.
-- 2. CREATE OR REPLACE atlas_intake_attachment_discover_commit with
--    `ON CONFLICT ON CONSTRAINT atlas_intake_attachments_graph_uniq DO NOTHING`.
--    Every column reference remains fully qualified with the `att` alias.
--
-- No signature change.
-- ============================================================================


-- ---------- 1. Attach index to a named constraint --------------------------

do $$
begin
  -- Idempotent: on re-run the constraint already exists.
  if not exists (
    select 1 from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    where t.relname = 'atlas_intake_graph_attachments'
      and c.conname = 'atlas_intake_attachments_graph_uniq'
  ) then
    alter table public.atlas_intake_graph_attachments
      add constraint atlas_intake_attachments_graph_uniq
      unique using index atlas_intake_attachments_graph_uidx;
  end if;
end $$;


-- ---------- 2. Recreate discover_commit ------------------------------------

create or replace function public.atlas_intake_attachment_discover_commit(
  p_intake_message_id  uuid,
  p_system_actor_id    uuid,
  p_mailbox            text,
  p_graph_message_id   text,
  p_stubs              jsonb
)
returns table (
  attachment_id       uuid,
  graph_attachment_id text,
  state               text,
  ingest_job_id       uuid
)
language plpgsql
security invoker
set search_path to pg_catalog, public
as $$
declare
  v_submission_id uuid;
  v_stub          jsonb;
  v_att_id        uuid;
  v_state         text;
  v_initial       text;
  v_skip_reason   text;
  v_job_id        uuid;
  v_fingerprint   text;
begin
  select im.submission_id
    into v_submission_id
    from public.atlas_submission_intake_messages as im
   where im.id = p_intake_message_id
   limit 1;
  if v_submission_id is null then
    raise exception 'phase5b: intake_message_id % not found', p_intake_message_id
      using errcode = 'no_data_found';
  end if;

  for v_stub in select * from jsonb_array_elements(coalesce(p_stubs, '[]'::jsonb))
  loop
    v_initial     := coalesce(v_stub->>'initial_state', 'pending');
    v_skip_reason := v_stub->>'skip_reason';

    -- Upsert on the Graph identity triple. Named CONSTRAINT target avoids
    -- plpgsql 42702 ambiguity on ON CONFLICT column names.
    insert into public.atlas_intake_graph_attachments as att (
      intake_message_id, submission_id,
      mailbox, graph_message_id, graph_attachment_id,
      attachment_type, filename, mime_type, size_bytes,
      is_inline, content_id,
      state, skip_reason
    ) values (
      p_intake_message_id, v_submission_id,
      p_mailbox, p_graph_message_id, v_stub->>'graph_attachment_id',
      coalesce(v_stub->>'attachment_type', 'unknown'),
      v_stub->>'filename',
      v_stub->>'mime_type',
      nullif(v_stub->>'size_bytes', '')::bigint,
      coalesce((v_stub->>'is_inline')::boolean, false),
      v_stub->>'content_id',
      v_initial::atlas_intake_attachment_state,
      v_skip_reason
    )
    on conflict on constraint atlas_intake_attachments_graph_uniq do nothing
    returning att.id, att.state::text into v_att_id, v_state;

    if v_att_id is null then
      -- Existing row wins. Read its identifiers to report back.
      select att.id, att.state::text
        into v_att_id, v_state
        from public.atlas_intake_graph_attachments as att
       where att.mailbox             = p_mailbox
         and att.graph_message_id    = p_graph_message_id
         and att.graph_attachment_id = v_stub->>'graph_attachment_id'
       limit 1;
    end if;

    v_job_id := null;
    if v_state = 'pending' then
      -- Enqueue exactly one ingest job for this attachment. Discovery
      -- transactions do not race each other for the same attachment row
      -- (the discovery job itself is serialised by atlas_jobs' claim
      -- fence), so SELECT-then-INSERT is safe here and avoids fragile
      -- ON CONFLICT inference against a partial index.
      v_fingerprint := 'graph-attachment-ingest:' || v_att_id::text;
      select j.id
        into v_job_id
        from public.atlas_jobs as j
       where j.job_type          = 'graph_attachment_ingest'
         and j.input_fingerprint = v_fingerprint
         and j.status in ('queued', 'running')
       order by j.created_at desc
       limit 1;
      if v_job_id is null then
        insert into public.atlas_jobs (
          submission_id, document_id, quote_review_id, insurer_id,
          job_type, status, input_fingerprint, created_by, metadata
        ) values (
          v_submission_id, null, null, null,
          'graph_attachment_ingest', 'queued', v_fingerprint, p_system_actor_id,
          jsonb_build_object('attachment_id', v_att_id)
        )
        returning id into v_job_id;
      end if;
    end if;

    attachment_id       := v_att_id;
    graph_attachment_id := v_stub->>'graph_attachment_id';
    state               := v_state;
    ingest_job_id       := v_job_id;
    return next;
  end loop;
end;
$$;

comment on function public.atlas_intake_attachment_discover_commit(
  uuid, uuid, text, text, jsonb
) is
  'Atomic per-message attachment upsert + eligible ingest-job enqueue. '
  'Recreated in 0034 to eliminate plpgsql 42702 ambiguity on the '
  'ON CONFLICT target by naming the graph-identity constraint explicitly.';


-- ---------- Reapply privileges ---------------------------------------------

revoke all on function public.atlas_intake_attachment_discover_commit(
  uuid, uuid, text, text, jsonb
) from public;
revoke all on function public.atlas_intake_attachment_discover_commit(
  uuid, uuid, text, text, jsonb
) from anon;
revoke all on function public.atlas_intake_attachment_discover_commit(
  uuid, uuid, text, text, jsonb
) from authenticated;
grant  execute on function public.atlas_intake_attachment_discover_commit(
  uuid, uuid, text, text, jsonb
) to service_role;
