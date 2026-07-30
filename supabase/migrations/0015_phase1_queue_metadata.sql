-- Phase 1: shared personal/commercial queue metadata.
-- The workflow remains the same for both lines. These fields only describe the
-- case and its operational state so the queue can filter and prioritise work.

alter table atlas_submissions
  add column if not exists line_of_business text,
  add column if not exists priority text not null default 'normal',
  add column if not exists next_action text,
  add column if not exists due_at timestamptz;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'atlas_submissions_line_of_business_check'
  ) then
    alter table atlas_submissions
      add constraint atlas_submissions_line_of_business_check
      check (line_of_business is null or line_of_business in ('personal', 'commercial'));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'atlas_submissions_priority_check'
  ) then
    alter table atlas_submissions
      add constraint atlas_submissions_priority_check
      check (priority in ('low', 'normal', 'high', 'urgent'));
  end if;
end $$;

create index if not exists atlas_submissions_line_of_business_idx
  on atlas_submissions (line_of_business);

create index if not exists atlas_submissions_priority_idx
  on atlas_submissions (priority, created_at desc);

create index if not exists atlas_submissions_due_at_idx
  on atlas_submissions (due_at)
  where due_at is not null;

comment on column atlas_submissions.line_of_business is
  'Shared workflow classification. Personal and commercial use the same UI and processing stages; insurer guidelines provide the difference.';

comment on column atlas_submissions.priority is
  'Operational queue priority, not underwriting appetite or authority.';

comment on column atlas_submissions.next_action is
  'Human-readable next action shown in the work queue.';

comment on column atlas_submissions.due_at is
  'Optional operational due date for SLA and workload visibility.';
