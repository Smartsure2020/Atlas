-- Phase 9: pilot issue tracking.
-- Additive only. pilot_flag and pilot_notes already exist on atlas_submissions
-- from migration 0014.

create type atlas_pilot_issue_severity as enum (
  'low',
  'medium',
  'high',
  'critical'
);

create type atlas_pilot_issue_status as enum (
  'open',
  'in_progress',
  'resolved',
  'wont_fix'
);

create table atlas_pilot_issues (
  id uuid primary key default gen_random_uuid(),
  submission_id uuid references atlas_submissions(id) on delete set null,
  title text not null,
  description text,
  severity atlas_pilot_issue_severity not null default 'medium',
  status atlas_pilot_issue_status not null default 'open',
  reported_by uuid not null,
  assigned_to uuid,
  resolved_at timestamptz,
  resolved_by uuid,
  resolution_notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index atlas_pilot_issues_submission_idx
  on atlas_pilot_issues (submission_id)
  where submission_id is not null;

create index atlas_pilot_issues_status_idx
  on atlas_pilot_issues (status, created_at desc);

create trigger set_atlas_pilot_issues_updated_at
  before update on atlas_pilot_issues
  for each row execute function atlas_touch_updated_at();

alter table atlas_pilot_issues enable row level security;

create policy atlas_pilot_issues_staff_select on atlas_pilot_issues
  for select to authenticated using (atlas_is_staff());
create policy atlas_pilot_issues_staff_insert on atlas_pilot_issues
  for insert to authenticated with check (atlas_is_staff());
create policy atlas_pilot_issues_manager_update on atlas_pilot_issues
  for update to authenticated using (atlas_can_manage()) with check (atlas_can_manage());

comment on table atlas_pilot_issues is
  'Pilot-phase issue tracker. All staff can create and view; only managers can update status.';
