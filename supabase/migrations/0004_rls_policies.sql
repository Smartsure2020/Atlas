-- ============================================================================
-- Atlas Blueprint — Phase 0, Migration 0004
-- Row-Level Security: underwriting/admin access only, audit log append-only
-- ----------------------------------------------------------------------------
-- Security model:
--   * RLS is enabled on EVERY Atlas table. Default-deny.
--   * Access is gated on an 'atlas_role' claim being 'underwriter' or 'admin'.
--     The role is asserted server-side; the client cannot grant itself access.
--   * The Worker uses the service role for privileged server-side work (it
--     bypasses RLS by design) and is the ONLY path to Claude, storage, and
--     recommendation logic — so audit logging is structural.
--   * The audit log is APPEND-ONLY: insert/select allowed to staff, but no
--     update or delete policy exists, so history cannot be quietly rewritten.
--
-- NOTE: this helper reads the role from the JWT. The actual mapping of a user
-- to 'underwriter'/'admin' is provisioned at the auth layer in the scaffold
-- step (custom claim populated from an allow-list / Azure group). The schema
-- only needs to TRUST that claim and check it consistently.
-- ============================================================================

-- Helper: is the current request made by an Atlas staff member?
create or replace function atlas_is_staff()
returns boolean
language sql
stable
as $$
  select coalesce(
    (auth.jwt() -> 'app_metadata' ->> 'atlas_role') in ('underwriter', 'admin'),
    false
  );
$$;

comment on function atlas_is_staff is
  'True when the JWT carries an atlas_role of underwriter or admin. Used by every Atlas RLS policy.';

-- Helper: admin-only (reserved for appetite/insurer config if we later want to
-- restrict matrix edits to admins; defined now so policies can reference it).
create or replace function atlas_is_admin()
returns boolean
language sql
stable
as $$
  select coalesce(
    (auth.jwt() -> 'app_metadata' ->> 'atlas_role') = 'admin',
    false
  );
$$;

-- ---------- Enable RLS on every table ---------------------------------------

alter table atlas_insurers            enable row level security;
alter table atlas_insurer_documents   enable row level security;
alter table atlas_submissions         enable row level security;
alter table atlas_documents           enable row level security;
alter table atlas_extractions         enable row level security;
alter table atlas_insurer_appetite    enable row level security;
alter table atlas_appetite_history    enable row level security;
alter table atlas_recommendations     enable row level security;
alter table atlas_decisions           enable row level security;
alter table atlas_audit_logs          enable row level security;

-- ---------- Staff-full-access tables ----------------------------------------
-- For the MVP, any authenticated underwriter/admin may work any submission
-- (small team, shared queue). We can tighten to per-assignee later without
-- schema changes. Each policy re-checks atlas_is_staff() so a non-staff token
-- sees nothing.

-- Submissions
create policy atlas_submissions_staff_all on atlas_submissions
  for all to authenticated
  using (atlas_is_staff()) with check (atlas_is_staff());

-- Documents
create policy atlas_documents_staff_all on atlas_documents
  for all to authenticated
  using (atlas_is_staff()) with check (atlas_is_staff());

-- Extractions
create policy atlas_extractions_staff_all on atlas_extractions
  for all to authenticated
  using (atlas_is_staff()) with check (atlas_is_staff());

-- Recommendations
create policy atlas_recommendations_staff_all on atlas_recommendations
  for all to authenticated
  using (atlas_is_staff()) with check (atlas_is_staff());

-- Decisions
create policy atlas_decisions_staff_all on atlas_decisions
  for all to authenticated
  using (atlas_is_staff()) with check (atlas_is_staff());

-- Insurers + guideline docs + appetite matrix + appetite history.
-- Readable by all staff; the confirm-before-go-live workflow runs server-side.
create policy atlas_insurers_staff_all on atlas_insurers
  for all to authenticated
  using (atlas_is_staff()) with check (atlas_is_staff());

create policy atlas_insurer_documents_staff_all on atlas_insurer_documents
  for all to authenticated
  using (atlas_is_staff()) with check (atlas_is_staff());

create policy atlas_appetite_staff_all on atlas_insurer_appetite
  for all to authenticated
  using (atlas_is_staff()) with check (atlas_is_staff());

create policy atlas_appetite_history_staff_read on atlas_appetite_history
  for select to authenticated
  using (atlas_is_staff());
-- History is written server-side (service role); staff may read, not hand-edit.

-- ---------- Audit log: APPEND-ONLY ------------------------------------------
-- Staff may insert and read audit rows. No update or delete policy is defined,
-- so under RLS the log cannot be modified or erased through the client —
-- exactly what an audit trail requires.

create policy atlas_audit_insert on atlas_audit_logs
  for insert to authenticated
  with check (atlas_is_staff());

create policy atlas_audit_select on atlas_audit_logs
  for select to authenticated
  using (atlas_is_staff());

-- (Intentionally no UPDATE or DELETE policy on atlas_audit_logs.)
