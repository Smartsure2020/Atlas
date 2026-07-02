-- Phase 7: pilot readiness foundations.
-- Adds lightweight job tracking, rerun fingerprints, assignment groundwork,
-- and operational indexes. This does not introduce a background queue.

create type atlas_job_type as enum (
  'extraction',
  'guideline_ingestion',
  'recommendation',
  'quote_review',
  'communication_generation',
  'cleanup',
  'other'
);

create type atlas_job_status as enum (
  'queued',
  'running',
  'completed',
  'failed',
  'cancelled',
  'skipped'
);

create type atlas_queue_status as enum (
  'new',
  'in_review',
  'waiting_info',
  'referred',
  'completed',
  'archived'
);

create table atlas_jobs (
  id uuid primary key default gen_random_uuid(),
  submission_id uuid references atlas_submissions(id) on delete cascade,
  document_id uuid,
  quote_review_id uuid references atlas_quote_reviews(id) on delete set null,
  insurer_id uuid references atlas_insurers(id) on delete set null,
  job_type atlas_job_type not null,
  status atlas_job_status not null default 'queued',
  input_fingerprint text,
  result_reference_id uuid,
  error_code text,
  error_message text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid,
  metadata jsonb
);

create index atlas_jobs_submission_idx
  on atlas_jobs (submission_id, job_type, created_at desc);

create index atlas_jobs_document_idx
  on atlas_jobs (document_id, job_type, created_at desc);

create index atlas_jobs_status_idx
  on atlas_jobs (status, created_at desc);

create unique index atlas_jobs_running_unique_idx
  on atlas_jobs (
    job_type,
    coalesce(submission_id, '00000000-0000-0000-0000-000000000000'::uuid),
    coalesce(document_id, '00000000-0000-0000-0000-000000000000'::uuid),
    coalesce(insurer_id, '00000000-0000-0000-0000-000000000000'::uuid),
    coalesce(input_fingerprint, '')
  )
  where status in ('queued', 'running');

create trigger atlas_jobs_touch
  before update on atlas_jobs
  for each row execute function atlas_touch_updated_at();

comment on table atlas_jobs is
  'Lightweight operational record of expensive Atlas work. Phase 7 records synchronous work here but does not run a background queue.';

comment on column atlas_jobs.input_fingerprint is
  'Deterministic hash of non-secret input IDs/timestamps/versions used to detect unchanged reruns.';

alter table atlas_submissions
  add column assigned_to uuid,
  add column assigned_at timestamptz,
  add column assigned_by uuid,
  add column queue_status atlas_queue_status not null default 'new';

create index atlas_submissions_assigned_to_idx
  on atlas_submissions (assigned_to);

create index atlas_submissions_queue_status_idx
  on atlas_submissions (queue_status);

comment on column atlas_submissions.assigned_to is
  'Pilot assignment groundwork. Shared queue remains supported; this is visible ownership, not strict access scoping.';

comment on column atlas_submissions.queue_status is
  'Pilot queue status used for visibility. Existing submission status remains the primary workflow status for compatibility.';

alter table atlas_jobs enable row level security;

create policy atlas_jobs_staff_select on atlas_jobs
  for select to authenticated using (atlas_is_staff());

create policy atlas_jobs_write on atlas_jobs
  for insert to authenticated with check (atlas_can_write() or atlas_can_manage());

create policy atlas_jobs_update on atlas_jobs
  for update to authenticated using (atlas_can_write() or atlas_can_manage())
  with check (atlas_can_write() or atlas_can_manage());
