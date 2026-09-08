-- ============================================================================
-- Atlas — Phase 5B (Microsoft Graph attachment ingestion)
-- Migration 0033 — RPCs + same-signature body replacement of the three
-- Phase 5A ingest RPCs.
-- ----------------------------------------------------------------------------
-- Companion to 0032 (schema). All new RPCs use the same security posture as
-- Phase 5A:
--
--   * language plpgsql
--   * security INVOKER  (not DEFINER)
--   * set search_path to pg_catalog, public
--   * REVOKE ALL from public, anon, authenticated
--   * GRANT EXECUTE to service_role only
--
-- The service-role Worker already has the table authority required. We do not
-- introduce SECURITY DEFINER on any Phase 5B RPC — same rationale as the
-- Phase 5A checkpoint 5 review (0030/0031).
--
-- Phase 5A ingest bodies are REPLACED at the EXACT existing identity
-- arguments so that has_attachments=true also enqueues exactly one
-- graph_attachment_discovery atlas_jobs row atomically with the new intake
-- row. Signatures unchanged.
--
-- End of migration: a to_regprocedure() guard asserts each of the six
-- Phase 5A functions still exists at exactly its expected identity args,
-- and that no obsolete overload of those six names remains. Phase 5B's
-- own atlas_intake_attachment_* functions are intentionally excluded from
-- the guard.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- New: atlas_intake_attachment_discover_commit
--
-- Called by the graph_attachment_discovery job processor after listing
-- attachments and applying deterministic filters. Atomically upserts one
-- tracking row per attachment and inserts one graph_attachment_ingest
-- atlas_jobs row per row whose initial_state = 'pending'.
--
-- Uses ON CONFLICT on the (mailbox, graph_message_id, graph_attachment_id)
-- unique index so replay is idempotent. Existing rows are NEVER downgraded
-- (a row already at state='ingested' stays ingested; only truly-new rows
-- get their metadata written).
-- ---------------------------------------------------------------------------

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

    -- Upsert on the Graph identity triple. Explicit ON CONFLICT columns
    -- infer the unique index atlas_intake_attachments_graph_uidx.
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
    on conflict (mailbox, graph_message_id, graph_attachment_id) do nothing
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
      -- (see architecture v2 §C — the discovery job itself is serialised
      -- by atlas_jobs' claim fence), so SELECT-then-INSERT is safe here
      -- and avoids fragile ON CONFLICT inference against a partial index.
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


-- ---------------------------------------------------------------------------
-- New: atlas_intake_attachment_claim
--
-- Conditional pending → downloading transition. Returns the row if the fence
-- matched, empty otherwise (another isolate got there first, or the row is
-- already past pending).
-- ---------------------------------------------------------------------------

create or replace function public.atlas_intake_attachment_claim(
  p_id             uuid,
  p_expected_state text
)
returns table (
  id                          uuid,
  intake_message_id           uuid,
  submission_id               uuid,
  mailbox                     text,
  graph_message_id            text,
  graph_attachment_id         text,
  filename                    text,
  mime_type                   text,
  size_bytes                  bigint,
  state                       text,
  storage_path                text,
  sha256                      text,
  duplicate_of_attachment_id  uuid
)
language plpgsql
security invoker
set search_path to pg_catalog, public
as $$
begin
  return query
    update public.atlas_intake_graph_attachments as att
       set state          = 'downloading',
           last_attempt_at = now()
     where att.id    = p_id
       and att.state = p_expected_state::atlas_intake_attachment_state
    returning att.id,
             att.intake_message_id,
             att.submission_id,
             att.mailbox,
             att.graph_message_id,
             att.graph_attachment_id,
             att.filename,
             att.mime_type,
             att.size_bytes,
             att.state::text,
             att.storage_path,
             att.sha256,
             att.duplicate_of_attachment_id;
end;
$$;


-- ---------------------------------------------------------------------------
-- New: atlas_intake_attachment_register_hash
--
-- Atomic, idempotent, concurrency-safe SHA-256 owner claim.
--
--   * self-owner idempotent: same row + same sha → OWNER (SELF_OWNER outcome).
--   * changed-hash fails closed: same row + different sha → 'attachment_hash_changed'.
--   * cross-row collision: sets duplicate_of_attachment_id + state='skipped'
--     + skip_reason='duplicate_hash'; copies document_id if owner is ingested.
--
-- Serialisation: pg_advisory_xact_lock keyed on hashtext(submission_id || '|' || sha)
-- BEFORE the owner lookup. Two isolates presenting the same bytes converge
-- on one owner without triggering a unique-violation.
-- ---------------------------------------------------------------------------

create or replace function public.atlas_intake_attachment_register_hash(
  p_id             uuid,
  p_expected_state text,
  p_sha256         text,
  p_size_bytes     bigint
)
returns table (
  outcome     text,
  owner_id    uuid,
  document_id uuid
)
language plpgsql
security invoker
set search_path to pg_catalog, public
as $$
declare
  v_row            public.atlas_intake_graph_attachments%rowtype;
  v_owner          public.atlas_intake_graph_attachments%rowtype;
  v_lock_key       bigint;
begin
  if p_sha256 is null or length(p_sha256) <> 64 then
    raise exception 'phase5b: invalid sha256 argument (expected 64 hex chars)'
      using errcode = 'invalid_parameter_value';
  end if;

  -- Read-then-lock. The row lock is a defence against another isolate
  -- concurrently completing document creation for this same row.
  select * into v_row
    from public.atlas_intake_graph_attachments as att
   where att.id = p_id
   for update;
  if not found then
    raise exception 'phase5b: attachment_id % not found', p_id
      using errcode = 'no_data_found';
  end if;

  -- Idempotency: same row already registered.
  if v_row.sha256 is not null then
    if v_row.sha256 <> p_sha256 then
      -- Someone attempted to overwrite the hash claim with different bytes.
      -- Fail closed rather than silently changing ownership.
      raise exception 'attachment_hash_changed'
        using errcode = 'assert_failure';
    end if;
    if v_row.duplicate_of_attachment_id is null then
      outcome := 'owner';
      owner_id := v_row.id;
      document_id := v_row.document_id;
    else
      outcome := 'duplicate';
      owner_id := v_row.duplicate_of_attachment_id;
      select att.document_id
        into document_id
        from public.atlas_intake_graph_attachments as att
       where att.id = v_row.duplicate_of_attachment_id
       limit 1;
    end if;
    return next;
    return;
  end if;

  -- Fresh claim path. State fence must match.
  if v_row.state::text <> p_expected_state then
    raise exception 'phase5b: unexpected state for hash registration (was %, expected %)',
      v_row.state, p_expected_state
      using errcode = 'assert_failure';
  end if;

  -- Serialise per (submission_id, sha) so the owner search + insert cannot
  -- race another isolate presenting the same bytes.
  v_lock_key := hashtextextended(v_row.submission_id::text || '|' || p_sha256, 0);
  perform pg_advisory_xact_lock(v_lock_key);

  select * into v_owner
    from public.atlas_intake_graph_attachments as att
   where att.submission_id              = v_row.submission_id
     and att.sha256                     = p_sha256
     and att.duplicate_of_attachment_id is null
     and att.id                         <> p_id
   limit 1;

  if found then
    update public.atlas_intake_graph_attachments as att
       set sha256                     = p_sha256,
           size_bytes                 = coalesce(p_size_bytes, att.size_bytes),
           duplicate_of_attachment_id = v_owner.id,
           state                      = 'skipped',
           skip_reason                = 'duplicate_hash',
           document_id                = coalesce(att.document_id, v_owner.document_id),
           last_attempt_at            = now()
     where att.id = p_id;

    outcome := 'duplicate';
    owner_id := v_owner.id;
    document_id := v_owner.document_id;
    return next;
    return;
  end if;

  -- No existing owner: we become the owner.
  update public.atlas_intake_graph_attachments as att
     set sha256          = p_sha256,
         size_bytes      = coalesce(p_size_bytes, att.size_bytes),
         last_attempt_at = now()
   where att.id = p_id;

  outcome := 'owner';
  owner_id := p_id;
  document_id := null;
  return next;
end;
$$;


-- ---------------------------------------------------------------------------
-- New: atlas_intake_attachment_mark_uploaded
--
-- Records the deterministic storage_path and transitions to state='uploaded'.
-- Idempotent: if the row is already at 'uploaded' or 'ingested' with the
-- same storage_path, returns ok=true without changing state.
-- ---------------------------------------------------------------------------

create or replace function public.atlas_intake_attachment_mark_uploaded(
  p_id             uuid,
  p_expected_state text,
  p_storage_path   text
)
returns table (
  ok      boolean,
  reason  text
)
language plpgsql
security invoker
set search_path to pg_catalog, public
as $$
declare
  v_current_state       text;
  v_current_path        text;
begin
  select att.state::text, att.storage_path
    into v_current_state, v_current_path
    from public.atlas_intake_graph_attachments as att
   where att.id = p_id
   for update;
  if not found then
    ok := false; reason := 'not_found'; return next; return;
  end if;

  if v_current_state in ('uploaded', 'ingested') then
    if v_current_path is distinct from p_storage_path then
      ok := false; reason := 'storage_path_mismatch'; return next; return;
    end if;
    ok := true; reason := 'idempotent_noop'; return next; return;
  end if;

  if v_current_state <> p_expected_state then
    ok := false; reason := 'unexpected_state'; return next; return;
  end if;

  update public.atlas_intake_graph_attachments as att
     set state           = 'uploaded',
         storage_path    = p_storage_path,
         last_attempt_at = now()
   where att.id = p_id;

  ok := true; reason := 'transitioned'; return next;
end;
$$;


-- ---------------------------------------------------------------------------
-- New: atlas_intake_attachment_create_document
--
-- Atomic uploaded → ingested transition: inserts atlas_documents, inserts
-- malware_scan atlas_jobs, links both onto the attachment row, writes safe
-- audit. Idempotent — replays after a lost response return the same IDs.
-- ---------------------------------------------------------------------------

create or replace function public.atlas_intake_attachment_create_document(
  p_id                uuid,
  p_system_actor_id   uuid,
  p_retention_days    integer
)
returns table (
  outcome      text,
  document_id  uuid,
  scan_job_id  uuid
)
language plpgsql
security invoker
set search_path to pg_catalog, public
as $$
declare
  v_row             public.atlas_intake_graph_attachments%rowtype;
  v_new_document_id uuid;
  v_new_job_id      uuid;
  v_expires_at      timestamptz;
  v_content_type    text := 'application/pdf';
  v_bucket          text := 'atlas-client-docs';
begin
  if p_retention_days is null or p_retention_days < 1 then
    raise exception 'phase5b: retention_days must be positive'
      using errcode = 'invalid_parameter_value';
  end if;

  select * into v_row
    from public.atlas_intake_graph_attachments as att
   where att.id = p_id
   for update;
  if not found then
    raise exception 'phase5b: attachment_id % not found', p_id
      using errcode = 'no_data_found';
  end if;

  -- Idempotent replay: already done.
  if v_row.state = 'ingested'
     and v_row.document_id is not null
     and v_row.scan_job_id is not null then
    outcome := 'idempotent_noop';
    document_id := v_row.document_id;
    scan_job_id := v_row.scan_job_id;
    return next;
    return;
  end if;

  if v_row.state <> 'uploaded' then
    raise exception 'phase5b: expected state=uploaded (was %)', v_row.state
      using errcode = 'assert_failure';
  end if;
  if v_row.storage_path is null or v_row.sha256 is null then
    raise exception 'phase5b: storage_path/sha256 must be set before create_document'
      using errcode = 'assert_failure';
  end if;
  if v_row.duplicate_of_attachment_id is not null then
    raise exception 'phase5b: duplicate rows must not create documents'
      using errcode = 'assert_failure';
  end if;

  v_expires_at := now() + (p_retention_days || ' days')::interval;

  insert into public.atlas_documents (
    submission_id, file_name, storage_path, document_type,
    status, uploaded_by, expires_at,
    file_hash, file_size_bytes, content_type,
    scan_status
  ) values (
    v_row.submission_id,
    coalesce(v_row.filename, 'attachment.pdf'),
    v_row.storage_path,
    'supporting',
    'active',
    p_system_actor_id,
    v_expires_at,
    v_row.sha256,
    v_row.size_bytes,
    v_content_type,
    'not_scanned'  -- overwritten to 'pending' by explicit update below to
                   -- match the malware pipeline's expected initial state.
  )
  returning id into v_new_document_id;

  update public.atlas_documents
     set scan_status = 'pending'
   where id = v_new_document_id;

  insert into public.atlas_jobs (
    submission_id, document_id, quote_review_id, insurer_id,
    job_type, status, input_fingerprint, created_by, metadata
  ) values (
    v_row.submission_id,
    v_new_document_id,
    null, null,
    'malware_scan',
    'queued',
    'malware_scan:' || v_new_document_id::text,
    p_system_actor_id,
    jsonb_build_object(
      'bucket',       v_bucket,
      'storage_path', v_row.storage_path,
      'file_name',    coalesce(v_row.filename, 'attachment.pdf'),
      'content_type', v_content_type
    )
  )
  returning id into v_new_job_id;

  update public.atlas_intake_graph_attachments as att
     set state           = 'ingested',
         document_id     = v_new_document_id,
         scan_job_id     = v_new_job_id,
         last_attempt_at = now()
   where att.id = p_id;

  -- Safe audit. Never bytes, filename, mailbox, or graph identifiers.
  insert into public.atlas_audit_logs (
    submission_id, action, actor, metadata_json
  ) values (
    v_row.submission_id,
    'intake_attachment_ingested',
    null,
    jsonb_build_object(
      'attachment_id',     v_row.id,
      'document_id',       v_new_document_id,
      'intake_message_id', v_row.intake_message_id,
      'sha256_prefix12',   left(v_row.sha256, 12),
      'size_bytes',        v_row.size_bytes
    )
  );

  outcome := 'created';
  document_id := v_new_document_id;
  scan_job_id := v_new_job_id;
  return next;
end;
$$;


-- ---------------------------------------------------------------------------
-- New: atlas_intake_attachment_mark_skipped
-- ---------------------------------------------------------------------------

create or replace function public.atlas_intake_attachment_mark_skipped(
  p_id             uuid,
  p_next_state     text,
  p_skip_reason    text
)
returns table (
  ok boolean
)
language plpgsql
security invoker
set search_path to pg_catalog, public
as $$
declare
  v_match integer;
begin
  if p_next_state not in ('skipped', 'unsupported') then
    raise exception 'phase5b: mark_skipped next_state must be skipped or unsupported'
      using errcode = 'invalid_parameter_value';
  end if;
  if p_skip_reason is null or length(p_skip_reason) = 0 then
    raise exception 'phase5b: mark_skipped requires a reason'
      using errcode = 'invalid_parameter_value';
  end if;

  update public.atlas_intake_graph_attachments as att
     set state           = p_next_state::atlas_intake_attachment_state,
         skip_reason     = p_skip_reason,
         last_attempt_at = now()
   where att.id = p_id
     and att.state in ('pending', 'downloading');
  get diagnostics v_match = row_count;

  ok := (v_match = 1);
  return next;
end;
$$;


-- ---------------------------------------------------------------------------
-- New: atlas_intake_attachment_fail
--
-- Records a classified failure. p_next_state is one of the resumable states
-- ('pending', 'downloading') for retryable failures, or 'failed_permanent'
-- for non-retryable. Attachment table stores last_error_code for operator
-- visibility only — the retry clock lives on atlas_jobs.
-- ---------------------------------------------------------------------------

create or replace function public.atlas_intake_attachment_fail(
  p_id             uuid,
  p_expected_state text,
  p_next_state     text,
  p_error_code     text
)
returns table (
  ok boolean
)
language plpgsql
security invoker
set search_path to pg_catalog, public
as $$
declare
  v_match integer;
begin
  if p_next_state not in ('pending', 'downloading', 'failed_permanent') then
    raise exception 'phase5b: fail next_state must be pending, downloading, or failed_permanent'
      using errcode = 'invalid_parameter_value';
  end if;

  update public.atlas_intake_graph_attachments as att
     set state           = p_next_state::atlas_intake_attachment_state,
         last_error_code = p_error_code,
         last_attempt_at = now()
   where att.id    = p_id
     and att.state = p_expected_state::atlas_intake_attachment_state;
  get diagnostics v_match = row_count;

  ok := (v_match = 1);
  return next;
end;
$$;


-- ===========================================================================
-- Phase 5A body replacements — SAME identity args as 0030/0031.
-- Body change only: when a NEW intake row is created and has_attachments=true,
-- also insert exactly one graph_attachment_discovery atlas_jobs row.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- Replace: atlas_intake_ingest_new_email (22-arg identity from 0030/0031)
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
  if p_internet_message_id is not null then
    select im.id, im.submission_id
      into v_existing_intake_id, v_existing_intake_submission_id
      from public.atlas_submission_intake_messages as im
     where im.internet_message_id = p_internet_message_id
     limit 1;
    if found then
      outcome := 'duplicate_internet_message_id';
      submission_id := v_existing_intake_submission_id;
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
    outcome := 'duplicate_graph_message_id';
    submission_id := v_existing_intake_submission_id;
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

  -- Phase 5B: atomically enqueue the discovery job when attachments are
  -- signalled. Metadata carries the intake_message_id ONLY — never mailbox,
  -- Graph identifiers, or any PII. The intake row was just created (unique
  -- constraints above guarantee this transaction won a race), so no
  -- pre-existing discovery job can exist for this fingerprint — a plain
  -- INSERT is safe. The partial atlas_jobs_running_unique_idx remains the
  -- final backstop against any future caller.
  if coalesce(p_has_attachments, false) then
    insert into public.atlas_jobs (
      submission_id, document_id, quote_review_id, insurer_id,
      job_type, status, input_fingerprint, created_by, metadata
    ) values (
      v_new_submission_id, null, null, null,
      'graph_attachment_discovery', 'queued',
      'graph-attachment-discovery:' || v_new_intake_id::text,
      p_system_actor_id,
      jsonb_build_object('intake_message_id', v_new_intake_id)
    );
  end if;

  outcome := 'created';
  submission_id := v_new_submission_id;
  intake_message_id := v_new_intake_id;
  return next;
end;
$$;


-- ---------------------------------------------------------------------------
-- Replace: atlas_intake_attach_message (16-arg identity from 0030)
-- ---------------------------------------------------------------------------

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
    select im.id
      into v_existing_intake
      from public.atlas_submission_intake_messages as im
     where im.internet_message_id = p_internet_message_id
     limit 1;
    if found then
      outcome := 'duplicate_internet_message_id';
      intake_message_id := v_existing_intake.id;
      return next;
      return;
    end if;
  end if;

  select im.id
    into v_existing_intake
    from public.atlas_submission_intake_messages as im
   where im.mailbox = p_mailbox
     and im.graph_message_id = p_graph_message_id
   limit 1;
  if found then
    outcome := 'duplicate_graph_message_id';
    intake_message_id := v_existing_intake.id;
    return next;
    return;
  end if;

  insert into public.atlas_submission_intake_messages as im (
    submission_id, source, mailbox, graph_message_id, internet_message_id,
    conversation_id, sender_name, sender_address, recipients, subject,
    body_preview, received_at, has_attachments, processing_state
  ) values (
    p_submission_id, 'email', p_mailbox, p_graph_message_id, p_internet_message_id,
    p_conversation_id, p_sender_name, p_sender_address, p_recipients, p_subject,
    p_body_preview, p_received_at, coalesce(p_has_attachments, false), p_processing_state
  )
  returning im.id into v_new_intake_id;

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

  -- Phase 5B discovery enqueue. created_by intentionally NULL — attach_message
  -- has no p_system_actor_id argument and we do not want to invent one. The
  -- intake row was just created (unique constraint above), so no pre-existing
  -- discovery job can exist for this fingerprint.
  if coalesce(p_has_attachments, false) then
    insert into public.atlas_jobs (
      submission_id, document_id, quote_review_id, insurer_id,
      job_type, status, input_fingerprint, created_by, metadata
    ) values (
      p_submission_id, null, null, null,
      'graph_attachment_discovery', 'queued',
      'graph-attachment-discovery:' || v_new_intake_id::text,
      null,
      jsonb_build_object('intake_message_id', v_new_intake_id)
    );
  end if;

  outcome := 'attached';
  intake_message_id := v_new_intake_id;
  return next;
end;
$$;


-- ---------------------------------------------------------------------------
-- Replace: atlas_intake_ingest_needs_review (24-arg identity from 0030/0031)
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
      outcome := 'duplicate_internet_message_id';
      submission_id := v_existing_intake_submission_id;
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
    outcome := 'duplicate_graph_message_id';
    submission_id := v_existing_intake_submission_id;
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

  if coalesce(p_has_attachments, false) then
    insert into public.atlas_jobs (
      submission_id, document_id, quote_review_id, insurer_id,
      job_type, status, input_fingerprint, created_by, metadata
    ) values (
      v_new_submission_id, null, null, null,
      'graph_attachment_discovery', 'queued',
      'graph-attachment-discovery:' || v_new_intake_id::text,
      p_system_actor_id,
      jsonb_build_object('intake_message_id', v_new_intake_id)
    );
  end if;

  outcome := 'created';
  submission_id := v_new_submission_id;
  intake_message_id := v_new_intake_id;
  return next;
end;
$$;


-- ===========================================================================
-- Privilege hardening for every new Phase 5B RPC.
-- Service-role only; PUBLIC/anon/authenticated denied.
-- ===========================================================================

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

revoke all on function public.atlas_intake_attachment_claim(uuid, text) from public;
revoke all on function public.atlas_intake_attachment_claim(uuid, text) from anon;
revoke all on function public.atlas_intake_attachment_claim(uuid, text) from authenticated;
grant  execute on function public.atlas_intake_attachment_claim(uuid, text) to service_role;

revoke all on function public.atlas_intake_attachment_register_hash(uuid, text, text, bigint) from public;
revoke all on function public.atlas_intake_attachment_register_hash(uuid, text, text, bigint) from anon;
revoke all on function public.atlas_intake_attachment_register_hash(uuid, text, text, bigint) from authenticated;
grant  execute on function public.atlas_intake_attachment_register_hash(uuid, text, text, bigint) to service_role;

revoke all on function public.atlas_intake_attachment_mark_uploaded(uuid, text, text) from public;
revoke all on function public.atlas_intake_attachment_mark_uploaded(uuid, text, text) from anon;
revoke all on function public.atlas_intake_attachment_mark_uploaded(uuid, text, text) from authenticated;
grant  execute on function public.atlas_intake_attachment_mark_uploaded(uuid, text, text) to service_role;

revoke all on function public.atlas_intake_attachment_create_document(uuid, uuid, integer) from public;
revoke all on function public.atlas_intake_attachment_create_document(uuid, uuid, integer) from anon;
revoke all on function public.atlas_intake_attachment_create_document(uuid, uuid, integer) from authenticated;
grant  execute on function public.atlas_intake_attachment_create_document(uuid, uuid, integer) to service_role;

revoke all on function public.atlas_intake_attachment_mark_skipped(uuid, text, text) from public;
revoke all on function public.atlas_intake_attachment_mark_skipped(uuid, text, text) from anon;
revoke all on function public.atlas_intake_attachment_mark_skipped(uuid, text, text) from authenticated;
grant  execute on function public.atlas_intake_attachment_mark_skipped(uuid, text, text) to service_role;

revoke all on function public.atlas_intake_attachment_fail(uuid, text, text, text) from public;
revoke all on function public.atlas_intake_attachment_fail(uuid, text, text, text) from anon;
revoke all on function public.atlas_intake_attachment_fail(uuid, text, text, text) from authenticated;
grant  execute on function public.atlas_intake_attachment_fail(uuid, text, text, text) to service_role;

-- Belt-and-braces reapply of the three replaced Phase 5A ingest RPC privileges.
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


-- ===========================================================================
-- Phase 5A signature preservation guard.
--
-- Verifies each of the six expected Phase 5A functions exists at exactly
-- the identity arguments Worker code passes today, AND that no obsolete
-- overload for any of those SIX names remains. Phase 5B's own
-- atlas_intake_attachment_* functions are intentionally excluded — the
-- guard is scoped to the six Phase 5A names by exact-name match.
-- ===========================================================================

do $$
declare
  v_expected constant text[] := array[
    'public.atlas_intake_acquire_lease(text, timestamptz, uuid, timestamptz)',
    'public.atlas_intake_release_lease(text, uuid, text, boolean, text, boolean, text, integer, timestamptz, timestamptz, timestamptz, boolean, timestamptz, boolean)',
    'public.atlas_intake_release_lease_success(text, uuid, text, boolean, text, boolean, timestamptz, jsonb)',
    'public.atlas_intake_ingest_new_email(uuid, text, text, text, text, text, text, timestamptz, text, text, text, text, text, text, jsonb, text, text, boolean, text, text, text, text)',
    'public.atlas_intake_attach_message(uuid, text, text, text, text, text, text, jsonb, text, text, timestamptz, boolean, text, text, text, text)',
    'public.atlas_intake_ingest_needs_review(uuid, text, text, text, text, text, text, timestamptz, text, text, text, text, text, text, jsonb, text, text, boolean, text, text, text, jsonb, text, text)'
  ];
  v_names constant text[] := array[
    'atlas_intake_acquire_lease',
    'atlas_intake_release_lease',
    'atlas_intake_release_lease_success',
    'atlas_intake_ingest_new_email',
    'atlas_intake_attach_message',
    'atlas_intake_ingest_needs_review'
  ];
  v_sig     text;
  v_name    text;
  v_count   integer;
begin
  foreach v_sig in array v_expected loop
    if to_regprocedure(v_sig) is null then
      raise exception 'phase5b guard: expected Phase 5A signature missing: %', v_sig;
    end if;
  end loop;

  foreach v_name in array v_names loop
    select count(*) into v_count
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname = v_name;
    if v_count <> 1 then
      raise exception 'phase5b guard: name % has % overloads (expected 1)', v_name, v_count;
    end if;
  end loop;
end $$;
