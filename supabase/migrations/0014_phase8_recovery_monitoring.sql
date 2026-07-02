-- Phase 8: async/recovery controls and production monitoring groundwork.
-- Additive only. Existing synchronous Worker flows continue to work.

create type atlas_cleanup_candidate_type as enum (
  'expired_document_row',
  'orphan_storage_path',
  'orphan_document_row',
  'manual_review'
);

create type atlas_cleanup_candidate_status as enum (
  'pending',
  'approved',
  'completed',
  'dismissed',
  'failed'
);

create type atlas_operational_alert_severity as enum (
  'info',
  'warning',
  'critical'
);

create type atlas_operational_alert_status as enum (
  'open',
  'acknowledged',
  'resolved'
);

alter table atlas_jobs
  add column retry_count integer not null default 0,
  add column max_retries integer not null default 2,
  add column next_retry_at timestamptz,
  add column last_error_code text,
  add column last_error_message text,
  add column cancellation_requested boolean not null default false,
  add column cancellation_requested_at timestamptz,
  add column cancellation_requested_by uuid;

create index atlas_jobs_next_retry_idx
  on atlas_jobs (status, next_retry_at)
  where status = 'failed' and next_retry_at is not null;

alter table atlas_documents
  add column file_hash text,
  add column file_size_bytes bigint,
  add column content_type text;

create index atlas_documents_file_hash_idx
  on atlas_documents (file_hash)
  where file_hash is not null;

alter table atlas_insurer_documents
  add column file_hash text,
  add column file_size_bytes bigint,
  add column content_type text;

create index atlas_insurer_documents_file_hash_idx
  on atlas_insurer_documents (file_hash)
  where file_hash is not null;

alter table atlas_submissions
  add column pilot_flag boolean not null default false,
  add column pilot_notes text;

create index atlas_submissions_pilot_idx
  on atlas_submissions (pilot_flag, created_at desc)
  where pilot_flag = true;

create table atlas_cleanup_candidates (
  id uuid primary key default gen_random_uuid(),
  candidate_type atlas_cleanup_candidate_type not null,
  status atlas_cleanup_candidate_status not null default 'pending',
  storage_bucket text,
  storage_path text,
  document_id uuid,
  submission_id uuid references atlas_submissions(id) on delete set null,
  reason text not null,
  detected_at timestamptz not null default now(),
  approved_by uuid,
  approved_at timestamptz,
  completed_at timestamptz,
  error_code text,
  error_message text,
  metadata jsonb
);

create index atlas_cleanup_candidates_status_idx
  on atlas_cleanup_candidates (status, detected_at desc);

create table atlas_operational_alerts (
  id uuid primary key default gen_random_uuid(),
  alert_type text not null,
  severity atlas_operational_alert_severity not null default 'warning',
  status atlas_operational_alert_status not null default 'open',
  title text not null,
  message text not null,
  related_job_id uuid references atlas_jobs(id) on delete set null,
  related_submission_id uuid references atlas_submissions(id) on delete set null,
  related_document_id uuid,
  created_at timestamptz not null default now(),
  acknowledged_at timestamptz,
  acknowledged_by uuid,
  resolved_at timestamptz,
  resolved_by uuid,
  metadata jsonb
);

create index atlas_operational_alerts_status_idx
  on atlas_operational_alerts (status, severity, created_at desc);

alter table atlas_cleanup_candidates enable row level security;
alter table atlas_operational_alerts enable row level security;

create policy atlas_cleanup_candidates_manager_select on atlas_cleanup_candidates
  for select to authenticated using (atlas_can_manage());
create policy atlas_cleanup_candidates_manager_insert on atlas_cleanup_candidates
  for insert to authenticated with check (atlas_can_manage());
create policy atlas_cleanup_candidates_manager_update on atlas_cleanup_candidates
  for update to authenticated using (atlas_can_manage()) with check (atlas_can_manage());

create policy atlas_operational_alerts_manager_select on atlas_operational_alerts
  for select to authenticated using (atlas_can_manage());
create policy atlas_operational_alerts_manager_insert on atlas_operational_alerts
  for insert to authenticated with check (atlas_can_manage());
create policy atlas_operational_alerts_manager_update on atlas_operational_alerts
  for update to authenticated using (atlas_can_manage()) with check (atlas_can_manage());

comment on column atlas_jobs.cancellation_requested is
  'True when a running job cannot be stopped immediately but should not continue/retry if the worker supports interruption later.';

comment on column atlas_documents.file_hash is
  'Optional SHA-256 hash supplied by client upload flow. Old documents may be null and remain processable.';

comment on table atlas_cleanup_candidates is
  'Manager-approved cleanup candidate list. Phase 8 does not automatically delete active documents.';

comment on table atlas_operational_alerts is
  'Internal operational alerts for job failures, stuck jobs, cleanup thresholds, and canary failures. No secrets or raw client data.';
