-- ============================================================================
-- Atlas — Phase 5B (Graph attachment ingestion) — Checkpoint 4 corrective
-- Migration 0035
-- ----------------------------------------------------------------------------
-- Forward-only. Additive to 0032/0033/0034. Does NOT rewrite migration history.
--
-- Problem
-- -------
-- Independent security review identified that Phase 5B's storage upload
-- happens before the deterministic path is persisted on the attachment
-- tracking row. That gives cleanup detection a window in which the
-- newly-uploaded object has no atlas_intake_graph_attachments.storage_path
-- reference and no atlas_documents row, so it looks orphaned. Any concurrent
-- cleanup approval could then delete the object mid-flight.
--
-- Correction
-- ----------
-- Add a new fenced RPC that persists the deterministic storage_path on the
-- attachment tracking row WHILE state remains 'downloading'. The runtime
-- calls this immediately after the hash claim resolves as owner, BEFORE
-- issuing the storage upload. Cleanup detection (updated in phase4-background)
-- now protects rows in downloading/uploaded/ingested states that carry a
-- non-null storage_path.
--
-- The existing mark_uploaded RPC keeps its role as the state fence
-- downloading -> uploaded; on re-entry we still detect an already-set
-- storage_path and either idempotently no-op (state=uploaded) or accept the
-- resume (state=downloading with path pre-set).
--
-- Security posture identical to 0033: SECURITY INVOKER, pinned search_path,
-- service_role-only EXECUTE.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- New: atlas_intake_attachment_set_planned_path
--
-- Behaviour
-- ---------
--   * Row must exist. Not-found → raise no_data_found.
--   * Row is expected to be in state 'downloading'; a row in 'uploaded' or
--     'ingested' whose storage_path matches p_storage_path is treated as an
--     idempotent no-op (crash-recovery resume).
--   * Row already carrying a DIFFERENT storage_path -> return
--     ok=false, reason='storage_path_conflict'. Never overwrite a path once
--     persisted.
--   * Row already carrying the SAME storage_path -> ok=true, reason=
--     'idempotent_noop'.
--   * Row in 'downloading' without a persisted path -> set path, ok=true,
--     reason='persisted'.
--   * Any other state (pending / skipped / unsupported / failed_permanent)
--     is rejected with ok=false, reason='unexpected_state'.
-- ---------------------------------------------------------------------------

create or replace function public.atlas_intake_attachment_set_planned_path(
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
  v_current_state text;
  v_current_path  text;
begin
  if p_storage_path is null or length(p_storage_path) = 0 then
    ok := false; reason := 'storage_path_required'; return next; return;
  end if;

  select att.state::text, att.storage_path
    into v_current_state, v_current_path
    from public.atlas_intake_graph_attachments as att
   where att.id = p_id
   for update;
  if not found then
    raise exception 'phase5b: attachment_id % not found', p_id
      using errcode = 'no_data_found';
  end if;

  -- Resume paths.
  if v_current_state in ('uploaded', 'ingested') then
    if v_current_path is distinct from p_storage_path then
      ok := false; reason := 'storage_path_conflict'; return next; return;
    end if;
    ok := true; reason := 'idempotent_noop'; return next; return;
  end if;

  if v_current_state <> p_expected_state then
    ok := false; reason := 'unexpected_state'; return next; return;
  end if;

  -- Already persisted for this row → idempotent or conflict.
  if v_current_path is not null then
    if v_current_path = p_storage_path then
      ok := true; reason := 'idempotent_noop'; return next; return;
    end if;
    ok := false; reason := 'storage_path_conflict'; return next; return;
  end if;

  update public.atlas_intake_graph_attachments as att
     set storage_path    = p_storage_path,
         last_attempt_at = now()
   where att.id = p_id
     and att.state = p_expected_state::atlas_intake_attachment_state
     and att.storage_path is null;

  if not found then
    -- Lost a race to another writer that also just set the path (or moved
    -- the state on). Refuse rather than silently continue.
    ok := false; reason := 'racing_writer'; return next; return;
  end if;

  ok := true; reason := 'persisted'; return next;
end;
$$;


-- ---------------------------------------------------------------------------
-- Privilege hardening — service_role only.
-- ---------------------------------------------------------------------------

revoke all on function public.atlas_intake_attachment_set_planned_path(
  uuid, text, text
) from public;
revoke all on function public.atlas_intake_attachment_set_planned_path(
  uuid, text, text
) from anon;
revoke all on function public.atlas_intake_attachment_set_planned_path(
  uuid, text, text
) from authenticated;
grant  execute on function public.atlas_intake_attachment_set_planned_path(
  uuid, text, text
) to service_role;


comment on function public.atlas_intake_attachment_set_planned_path(
  uuid, text, text
) is
  'Phase 5B — persists the deterministic storage_path on an attachment row '
  'while state remains ''downloading'', so cleanup detection sees the '
  'reference before the storage object exists. Idempotent on same-path replay; '
  'refuses conflicting paths. Service-role only.';


-- ---------------------------------------------------------------------------
-- Body replacement of atlas_intake_attachment_create_document
--
-- Independent security review (Checkpoint 4 §13): Phase 5B-created malware
-- scan job metadata must not duplicate the attachment's original filename —
-- that filename can carry PII. Rewrite the RPC body so:
--
--   * atlas_documents.file_name  = v_row.filename        (unchanged; existing
--                                                         access controls)
--   * atlas_jobs.metadata.file_name = 'attachment.pdf'    (generic scanner
--                                                         label, always)
--
-- Identity args UNCHANGED so the Worker's RPC call keeps working.
-- Same security posture: SECURITY INVOKER, pinned search_path, service_role
-- only. Retains the audit-safe metadata format (sha256_prefix12 only).
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
  v_scanner_name    text := 'attachment.pdf';
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
    'not_scanned'
  )
  returning id into v_new_document_id;

  update public.atlas_documents
     set scan_status = 'pending'
   where id = v_new_document_id;

  -- PII: malware scan metadata uses the GENERIC scanner name — never the
  -- attachment's original filename. atlas_documents.file_name is retained
  -- for RLS-protected UI display; atlas_jobs.metadata is operational and
  -- fanned out to alerts, so it stays anonymous.
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
      'file_name',    v_scanner_name,
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

comment on function public.atlas_intake_attachment_create_document(
  uuid, uuid, integer
) is
  'Phase 5B — atomic uploaded → ingested transition: inserts atlas_documents + '
  'malware_scan atlas_jobs + safe audit under one transaction. Rewritten in '
  '0035 so the malware_scan metadata uses a generic filename (''attachment.pdf'') '
  'rather than the attachment''s original name; atlas_documents.file_name still '
  'carries the original for RLS-protected UI display. Service-role only.';

-- Belt-and-braces reapply privileges (CREATE OR REPLACE preserves them, but
-- Phase 5A precedent explicitly reapplies).
revoke all on function public.atlas_intake_attachment_create_document(
  uuid, uuid, integer
) from public;
revoke all on function public.atlas_intake_attachment_create_document(
  uuid, uuid, integer
) from anon;
revoke all on function public.atlas_intake_attachment_create_document(
  uuid, uuid, integer
) from authenticated;
grant  execute on function public.atlas_intake_attachment_create_document(
  uuid, uuid, integer
) to service_role;
