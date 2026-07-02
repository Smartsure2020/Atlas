-- Phase 6: production hardening, role model, RLS coverage, and storage posture.
-- Worker/service-role remains the primary privileged path; these policies are
-- defense in depth for any direct Supabase Data API access.

create or replace function atlas_role()
returns text
language sql
stable
as $$
  select coalesce(auth.jwt() -> 'app_metadata' ->> 'atlas_role', '');
$$;

create or replace function atlas_is_staff()
returns boolean
language sql
stable
as $$
  select atlas_role() in ('underwriter', 'consultant', 'manager', 'admin', 'readonly', 'auditor');
$$;

create or replace function atlas_can_write()
returns boolean
language sql
stable
as $$
  select atlas_role() in ('underwriter', 'consultant', 'manager', 'admin');
$$;

create or replace function atlas_can_manage()
returns boolean
language sql
stable
as $$
  select atlas_role() in ('manager', 'admin');
$$;

create or replace function atlas_is_admin()
returns boolean
language sql
stable
as $$
  select atlas_role() = 'admin';
$$;

comment on function atlas_role is
  'Atlas role read from trusted app_metadata.atlas_role. user_metadata is never trusted for authorization.';
comment on function atlas_can_write is
  'True for consultant/legacy underwriter/manager/admin. False for readonly/auditor.';
comment on function atlas_can_manage is
  'True for manager/admin rule-management and reporting operations.';

-- Remove legacy broad policies before installing scoped policies.
drop policy if exists atlas_submissions_staff_all on atlas_submissions;
drop policy if exists atlas_documents_staff_all on atlas_documents;
drop policy if exists atlas_extractions_staff_all on atlas_extractions;
drop policy if exists atlas_recommendations_staff_all on atlas_recommendations;
drop policy if exists atlas_decisions_staff_all on atlas_decisions;
drop policy if exists atlas_insurers_staff_all on atlas_insurers;
drop policy if exists atlas_insurer_documents_staff_all on atlas_insurer_documents;
drop policy if exists atlas_appetite_staff_all on atlas_insurer_appetite;
drop policy if exists atlas_appetite_history_staff_read on atlas_appetite_history;
drop policy if exists atlas_audit_insert on atlas_audit_logs;
drop policy if exists atlas_audit_select on atlas_audit_logs;

-- Enable RLS on all Atlas public tables, including Phase 3-5 additions.
alter table atlas_insurers enable row level security;
alter table atlas_insurer_documents enable row level security;
alter table atlas_submissions enable row level security;
alter table atlas_documents enable row level security;
alter table atlas_extractions enable row level security;
alter table atlas_insurer_appetite enable row level security;
alter table atlas_appetite_history enable row level security;
alter table atlas_recommendations enable row level security;
alter table atlas_decisions enable row level security;
alter table atlas_audit_logs enable row level security;
alter table atlas_quote_reviews enable row level security;
alter table atlas_quote_review_sections enable row level security;
alter table atlas_missing_info_items enable row level security;
alter table atlas_communications enable row level security;

-- Shared-queue submission data. Direct reads are staff-only; writes exclude
-- readonly/auditor. The Worker also enforces route-level permissions.
create policy atlas_submissions_staff_select on atlas_submissions
  for select to authenticated using (atlas_is_staff());
create policy atlas_submissions_write on atlas_submissions
  for insert to authenticated with check (atlas_can_write());
create policy atlas_submissions_update on atlas_submissions
  for update to authenticated using (atlas_can_write()) with check (atlas_can_write());

create policy atlas_documents_staff_select on atlas_documents
  for select to authenticated using (atlas_is_staff());
create policy atlas_documents_write on atlas_documents
  for insert to authenticated with check (atlas_can_write());
create policy atlas_documents_update on atlas_documents
  for update to authenticated using (atlas_can_write()) with check (atlas_can_write());

create policy atlas_extractions_staff_select on atlas_extractions
  for select to authenticated using (atlas_is_staff());
create policy atlas_extractions_write on atlas_extractions
  for insert to authenticated with check (atlas_can_write());
create policy atlas_extractions_update on atlas_extractions
  for update to authenticated using (atlas_can_write()) with check (atlas_can_write());

create policy atlas_recommendations_staff_select on atlas_recommendations
  for select to authenticated using (atlas_is_staff());
create policy atlas_recommendations_insert on atlas_recommendations
  for insert to authenticated with check (atlas_can_write());

create policy atlas_decisions_staff_select on atlas_decisions
  for select to authenticated using (atlas_is_staff());
create policy atlas_decisions_insert on atlas_decisions
  for insert to authenticated with check (atlas_can_write());

-- Insurer and appetite configuration. All staff may read live/reference data;
-- only manager/admin can manage insurer records, guideline docs, appetite rows,
-- and appetite history.
create policy atlas_insurers_staff_select on atlas_insurers
  for select to authenticated using (atlas_is_staff());
create policy atlas_insurers_manage_insert on atlas_insurers
  for insert to authenticated with check (atlas_can_manage());
create policy atlas_insurers_manage_update on atlas_insurers
  for update to authenticated using (atlas_can_manage()) with check (atlas_can_manage());

create policy atlas_insurer_documents_staff_select on atlas_insurer_documents
  for select to authenticated using (atlas_is_staff());
create policy atlas_insurer_documents_manage_insert on atlas_insurer_documents
  for insert to authenticated with check (atlas_can_manage());
create policy atlas_insurer_documents_manage_update on atlas_insurer_documents
  for update to authenticated using (atlas_can_manage()) with check (atlas_can_manage());

create policy atlas_appetite_staff_select on atlas_insurer_appetite
  for select to authenticated using (atlas_is_staff());
create policy atlas_appetite_manage_insert on atlas_insurer_appetite
  for insert to authenticated with check (atlas_can_manage());
create policy atlas_appetite_manage_update on atlas_insurer_appetite
  for update to authenticated using (atlas_can_manage()) with check (atlas_can_manage());

create policy atlas_appetite_history_staff_select on atlas_appetite_history
  for select to authenticated using (atlas_is_staff());
create policy atlas_appetite_history_manage_insert on atlas_appetite_history
  for insert to authenticated with check (atlas_can_manage());

-- Audit logs are append-only. Staff can select/insert through controlled paths,
-- but there is intentionally no UPDATE or DELETE policy.
create policy atlas_audit_select on atlas_audit_logs
  for select to authenticated using (atlas_is_staff());
create policy atlas_audit_insert on atlas_audit_logs
  for insert to authenticated with check (atlas_can_write() or atlas_can_manage());

-- Phase 3 quote review tables. Snapshots remain durable; no delete policy.
create policy atlas_quote_reviews_staff_select on atlas_quote_reviews
  for select to authenticated using (atlas_is_staff());
create policy atlas_quote_reviews_insert on atlas_quote_reviews
  for insert to authenticated with check (atlas_can_write());
create policy atlas_quote_reviews_update on atlas_quote_reviews
  for update to authenticated using (atlas_can_write()) with check (atlas_can_write());

create policy atlas_quote_review_sections_staff_select on atlas_quote_review_sections
  for select to authenticated using (atlas_is_staff());
create policy atlas_quote_review_sections_insert on atlas_quote_review_sections
  for insert to authenticated with check (atlas_can_write());

-- Phase 4 missing-info workflow follows the parent submission access model.
create policy atlas_missing_info_staff_select on atlas_missing_info_items
  for select to authenticated using (atlas_is_staff());
create policy atlas_missing_info_insert on atlas_missing_info_items
  for insert to authenticated with check (atlas_can_write());
create policy atlas_missing_info_update on atlas_missing_info_items
  for update to authenticated using (atlas_can_write()) with check (atlas_can_write());

-- Phase 5 communication records are saved/manual lifecycle records. No direct
-- delete policy; archived status is the non-destructive lifecycle endpoint.
create policy atlas_communications_staff_select on atlas_communications
  for select to authenticated using (atlas_is_staff());
create policy atlas_communications_insert on atlas_communications
  for insert to authenticated with check (atlas_can_write());
create policy atlas_communications_update on atlas_communications
  for update to authenticated using (atlas_can_write()) with check (atlas_can_write());

-- Private storage posture. Signed URLs are minted by the Worker after its own
-- permission checks; buckets should not be public.
update storage.buckets
set public = false
where id in ('atlas-client-docs', 'atlas-insurer-docs');

comment on table atlas_quote_reviews is
  'Durable quote review snapshots. RLS allows staff read and consultant/manager/admin writes through controlled workflows.';
comment on table atlas_missing_info_items is
  'Missing-info workflow records. RLS follows shared submission access; waived/not_required notes are validated in Worker logic.';
comment on table atlas_communications is
  'Saved generated communication drafts and manual lifecycle tracking. No automatic email sending.';
