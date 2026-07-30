-- Phase 4: production controls for durable background processing.
-- Additive only. Existing Phase 7/8 job, alert, and cleanup records remain
-- compatible while the Worker moves expensive work off request paths.

alter type atlas_job_type add value if not exists 'malware_scan';

alter table atlas_jobs
  add column if not exists progress_percent integer not null default 0,
  add column if not exists current_step text,
  add column if not exists heartbeat_at timestamptz,
  add column if not exists claimed_at timestamptz,
  add column if not exists worker_name text,
  add column if not exists attempt_count integer not null default 0;

alter table atlas_documents
  add column if not exists scan_status text not null default 'not_scanned',
  add column if not exists scan_error text,
  add column if not exists scanned_at timestamptz;

alter table atlas_insurer_documents
  add column if not exists scan_status text not null default 'not_scanned',
  add column if not exists scan_error text,
  add column if not exists scanned_at timestamptz;

alter table atlas_extractions
  add column if not exists version_metadata jsonb not null default '{}'::jsonb;

alter table atlas_recommendations
  add column if not exists version_metadata jsonb not null default '{}'::jsonb;

alter table atlas_quote_reviews
  add column if not exists version_metadata jsonb not null default '{}'::jsonb;

alter table atlas_insurer_appetite
  add column if not exists version_metadata jsonb not null default '{}'::jsonb;

alter table atlas_insurer_documents
  add column if not exists version_metadata jsonb not null default '{}'::jsonb;

alter table atlas_operational_alerts
  add column if not exists escalation_due_at timestamptz,
  add column if not exists escalated_at timestamptz,
  add column if not exists escalated_to text;

create index if not exists atlas_jobs_heartbeat_idx
  on atlas_jobs (status, heartbeat_at)
  where status in ('queued', 'running');

create index if not exists atlas_documents_scan_idx
  on atlas_documents (scan_status, status, created_at desc);

create index if not exists atlas_insurer_documents_scan_idx
  on atlas_insurer_documents (scan_status, processing_status, created_at desc);

create index if not exists atlas_operational_alerts_escalation_idx
  on atlas_operational_alerts (status, escalation_due_at)
  where status in ('open', 'acknowledged') and escalation_due_at is not null;

alter table atlas_jobs enable row level security;
alter table atlas_documents enable row level security;
alter table atlas_extractions enable row level security;
alter table atlas_recommendations enable row level security;
alter table atlas_decisions enable row level security;
alter table atlas_quote_reviews enable row level security;
alter table atlas_quote_review_sections enable row level security;
alter table atlas_missing_info_items enable row level security;
alter table atlas_communications enable row level security;

create or replace function atlas_can_access_submission(p_submission_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    atlas_role() in ('manager', 'admin', 'readonly', 'auditor')
    or exists (
      select 1
      from atlas_submissions s
      where s.id = p_submission_id
        and auth.uid() is not null
        and auth.uid() in (s.created_by, s.assigned_to, s.assigned_underwriter)
    );
$$;

comment on function atlas_can_access_submission is
  'Strict pilot scoping: managers/admins/auditors can inspect all cases; consultants can inspect only cases they created or own.';

-- Direct Data API access follows the same ownership boundary as the Worker.
drop policy if exists atlas_submissions_staff_select on atlas_submissions;
drop policy if exists atlas_submissions_write on atlas_submissions;
drop policy if exists atlas_submissions_update on atlas_submissions;
create policy atlas_submissions_scoped_select on atlas_submissions
  for select to authenticated using (atlas_can_access_submission(id));
create policy atlas_submissions_scoped_insert on atlas_submissions
  for insert to authenticated with check (atlas_can_write() and created_by = auth.uid());
create policy atlas_submissions_scoped_update on atlas_submissions
  for update to authenticated
  using (atlas_can_write() and atlas_can_access_submission(id))
  with check (atlas_can_write() and atlas_can_access_submission(id));

drop policy if exists atlas_documents_staff_select on atlas_documents;
drop policy if exists atlas_documents_write on atlas_documents;
drop policy if exists atlas_documents_update on atlas_documents;
create policy atlas_documents_scoped_select on atlas_documents
  for select to authenticated using (atlas_can_access_submission(submission_id));
create policy atlas_documents_scoped_insert on atlas_documents
  for insert to authenticated with check (atlas_can_write() and atlas_can_access_submission(submission_id));
create policy atlas_documents_scoped_update on atlas_documents
  for update to authenticated
  using (atlas_can_write() and atlas_can_access_submission(submission_id))
  with check (atlas_can_write() and atlas_can_access_submission(submission_id));

drop policy if exists atlas_extractions_staff_select on atlas_extractions;
drop policy if exists atlas_extractions_write on atlas_extractions;
drop policy if exists atlas_extractions_update on atlas_extractions;
create policy atlas_extractions_scoped_select on atlas_extractions
  for select to authenticated using (atlas_can_access_submission(submission_id));
create policy atlas_extractions_scoped_insert on atlas_extractions
  for insert to authenticated with check (atlas_can_write() and atlas_can_access_submission(submission_id));
create policy atlas_extractions_scoped_update on atlas_extractions
  for update to authenticated
  using (atlas_can_write() and atlas_can_access_submission(submission_id))
  with check (atlas_can_write() and atlas_can_access_submission(submission_id));

drop policy if exists atlas_recommendations_staff_select on atlas_recommendations;
drop policy if exists atlas_recommendations_insert on atlas_recommendations;
create policy atlas_recommendations_scoped_select on atlas_recommendations
  for select to authenticated using (atlas_can_access_submission(submission_id));
create policy atlas_recommendations_scoped_insert on atlas_recommendations
  for insert to authenticated with check (atlas_can_write() and atlas_can_access_submission(submission_id));

drop policy if exists atlas_decisions_staff_select on atlas_decisions;
drop policy if exists atlas_decisions_insert on atlas_decisions;
create policy atlas_decisions_scoped_select on atlas_decisions
  for select to authenticated using (atlas_can_access_submission(submission_id));
create policy atlas_decisions_scoped_insert on atlas_decisions
  for insert to authenticated with check (atlas_can_write() and atlas_can_access_submission(submission_id));

drop policy if exists atlas_quote_reviews_staff_select on atlas_quote_reviews;
drop policy if exists atlas_quote_reviews_insert on atlas_quote_reviews;
drop policy if exists atlas_quote_reviews_update on atlas_quote_reviews;
create policy atlas_quote_reviews_scoped_select on atlas_quote_reviews
  for select to authenticated using (atlas_can_access_submission(submission_id));
create policy atlas_quote_reviews_scoped_insert on atlas_quote_reviews
  for insert to authenticated with check (atlas_can_write() and atlas_can_access_submission(submission_id));
create policy atlas_quote_reviews_scoped_update on atlas_quote_reviews
  for update to authenticated
  using (atlas_can_write() and atlas_can_access_submission(submission_id))
  with check (atlas_can_write() and atlas_can_access_submission(submission_id));

drop policy if exists atlas_quote_review_sections_staff_select on atlas_quote_review_sections;
drop policy if exists atlas_quote_review_sections_insert on atlas_quote_review_sections;
create policy atlas_quote_review_sections_scoped_select on atlas_quote_review_sections
  for select to authenticated using (
    exists (
      select 1 from atlas_quote_reviews qr
      where qr.id = quote_review_id and atlas_can_access_submission(qr.submission_id)
    )
  );
create policy atlas_quote_review_sections_scoped_insert on atlas_quote_review_sections
  for insert to authenticated with check (
    atlas_can_write()
    and exists (
      select 1 from atlas_quote_reviews qr
      where qr.id = quote_review_id and atlas_can_access_submission(qr.submission_id)
    )
  );

drop policy if exists atlas_missing_info_staff_select on atlas_missing_info_items;
drop policy if exists atlas_missing_info_insert on atlas_missing_info_items;
drop policy if exists atlas_missing_info_update on atlas_missing_info_items;
create policy atlas_missing_info_scoped_select on atlas_missing_info_items
  for select to authenticated using (atlas_can_access_submission(submission_id));
create policy atlas_missing_info_scoped_insert on atlas_missing_info_items
  for insert to authenticated with check (atlas_can_write() and atlas_can_access_submission(submission_id));
create policy atlas_missing_info_scoped_update on atlas_missing_info_items
  for update to authenticated
  using (atlas_can_write() and atlas_can_access_submission(submission_id))
  with check (atlas_can_write() and atlas_can_access_submission(submission_id));

drop policy if exists atlas_communications_staff_select on atlas_communications;
drop policy if exists atlas_communications_insert on atlas_communications;
drop policy if exists atlas_communications_update on atlas_communications;
create policy atlas_communications_scoped_select on atlas_communications
  for select to authenticated using (atlas_can_access_submission(submission_id));
create policy atlas_communications_scoped_insert on atlas_communications
  for insert to authenticated with check (atlas_can_write() and atlas_can_access_submission(submission_id));
create policy atlas_communications_scoped_update on atlas_communications
  for update to authenticated
  using (atlas_can_write() and atlas_can_access_submission(submission_id))
  with check (atlas_can_write() and atlas_can_access_submission(submission_id));

-- Jobs and alerts remain manager-only. Service-role background execution is
-- outside RLS and all user-facing control routes enforce the same role gate.
drop policy if exists atlas_jobs_staff_select on atlas_jobs;
drop policy if exists atlas_jobs_write on atlas_jobs;
drop policy if exists atlas_jobs_update on atlas_jobs;
create policy atlas_jobs_manager_select on atlas_jobs
  for select to authenticated using (atlas_can_manage());
create policy atlas_jobs_manager_insert on atlas_jobs
  for insert to authenticated with check (atlas_can_manage());
create policy atlas_jobs_manager_update on atlas_jobs
  for update to authenticated using (atlas_can_manage()) with check (atlas_can_manage());
