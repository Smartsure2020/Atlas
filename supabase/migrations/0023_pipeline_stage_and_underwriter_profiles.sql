-- ============================================================================
-- Atlas — Phase 1 (Quote Pipeline foundation)
-- Migration 0023: pipeline_stage vocabulary + atlas_underwriter_profiles
-- ----------------------------------------------------------------------------
-- ADDITIVE ONLY. Foundation for the future Quote Pipeline; no operational
-- behaviour, no assignment logic, no intake, no UI change in this phase.
--
-- Historical-data rule (non-negotiable):
--   Every new column on atlas_submissions is added NULLABLE and WITHOUT a
--   DEFAULT at ADD-COLUMN time. Defaults are installed by a subsequent
--   ALTER COLUMN ... SET DEFAULT statement — Postgres applies those to
--   FUTURE inserts only, so existing historical rows remain NULL. The single
--   controlled backfill happens in Phase 6, not here.
--
-- Vocabulary added:
--   - atlas_pipeline_stage enum (commercial lifecycle only)
--   - atlas_submissions.pipeline_stage, received_at, source_type,
--     complexity, last_pipeline_stage_changed_at
--
-- Table added:
--   - atlas_underwriter_profiles (Atlas-specific capability/availability;
--     NOT identity — auth.users remains identity)
--
-- Security shipped with the table (no delete policy anywhere).
-- ============================================================================

-- ---------- Enum ------------------------------------------------------------

do $$
begin
  if not exists (select 1 from pg_type where typname = 'atlas_pipeline_stage') then
    create type atlas_pipeline_stage as enum (
      'new',
      'triaged',
      'assigned',
      'in_progress',
      'quoted',
      'bound',
      'declined',
      'lost'
    );
  end if;
end $$;

comment on type atlas_pipeline_stage is
  'Commercial quote lifecycle. Independent of queue_status (operational workflow) and legacy status. Terminal: bound, declined, lost.';

-- ---------- atlas_submissions: additive columns (all NULLABLE, no default) --

alter table atlas_submissions
  add column if not exists pipeline_stage                 atlas_pipeline_stage,
  add column if not exists received_at                    timestamptz,
  add column if not exists source_type                    text,
  add column if not exists complexity                     text,
  add column if not exists last_pipeline_stage_changed_at timestamptz;

-- Defaults installed AFTER add-column: future inserts get them; historical
-- rows keep their NULLs. received_at has no default in Phase 1 — the
-- ingest/manual-capture callers will set it explicitly in later phases.
alter table atlas_submissions
  alter column pipeline_stage                 set default 'new',
  alter column source_type                    set default 'manual',
  alter column complexity                     set default 'standard',
  alter column last_pipeline_stage_changed_at set default now();

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'atlas_submissions_source_type_check'
  ) then
    alter table atlas_submissions
      add constraint atlas_submissions_source_type_check
      check (source_type is null or source_type in ('manual', 'email', 'api'));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'atlas_submissions_complexity_check'
  ) then
    alter table atlas_submissions
      add constraint atlas_submissions_complexity_check
      check (complexity is null or complexity in ('standard', 'complex'));
  end if;
end $$;

comment on column atlas_submissions.pipeline_stage is
  'Commercial lifecycle: new|triaged|assigned|in_progress|quoted|bound|declined|lost. NULL on rows created before Phase 1. Backfill happens in Phase 6.';
comment on column atlas_submissions.received_at is
  'When the submission actually arrived (email receivedDateTime or manual capture). Distinct from created_at (row insert).';
comment on column atlas_submissions.source_type is
  'manual | email | api. NULL on historical rows.';
comment on column atlas_submissions.complexity is
  'standard | complex. Drives future capability-based assignment. NULL on historical rows.';
comment on column atlas_submissions.last_pipeline_stage_changed_at is
  'Stamped by the future pipeline-stage transition function. NULL on historical rows.';

-- ---------- Indexes ---------------------------------------------------------

-- Ordering by dwell time within a pipeline stage.
create index if not exists atlas_submissions_pipeline_stage_idx
  on atlas_submissions (pipeline_stage, last_pipeline_stage_changed_at desc)
  where pipeline_stage is not null;

-- Underwriter open-workload lookups. Terminal stages excluded so the index
-- stays small and matches the workload predicate used by the future
-- assignment function.
create index if not exists atlas_submissions_owner_open_pipeline_idx
  on atlas_submissions (assigned_to, pipeline_stage)
  where pipeline_stage is not null
    and pipeline_stage not in ('bound', 'declined', 'lost');

-- Reverse-chronological received-at scans for intake dashboards.
create index if not exists atlas_submissions_received_at_idx
  on atlas_submissions (received_at desc)
  where received_at is not null;

-- ---------- atlas_underwriter_profiles --------------------------------------
-- Capability + availability, NOT identity. auth.users remains identity.
-- Not auto-populated. Managers seed rows in a later phase.

create table if not exists atlas_underwriter_profiles (
  user_id                     uuid primary key references auth.users(id) on delete cascade,
  active_for_assignment       boolean       not null default true,
  can_take_personal           boolean       not null default true,
  can_take_commercial         boolean       not null default false,
  can_take_complex_commercial boolean       not null default false,
  weight                      numeric(4,2)  not null default 1.0,
  last_assigned_at            timestamptz,
  created_at                  timestamptz   not null default now(),
  updated_at                  timestamptz   not null default now()
);

comment on table atlas_underwriter_profiles is
  'Atlas-specific capability + availability per auth.users row. NOT an identity registry. Managers configure. Auto-assignment reads this in Phase 2.';
comment on column atlas_underwriter_profiles.weight is
  'Reserved for a future proportional-load assignment strategy. Not consumed in Phase 1 or Phase 2.';

do $$
begin
  if not exists (
    select 1 from pg_trigger where tgname = 'atlas_underwriter_profiles_touch'
  ) then
    create trigger atlas_underwriter_profiles_touch
      before update on atlas_underwriter_profiles
      for each row execute function atlas_touch_updated_at();
  end if;
end $$;

-- ---------- RLS (least-privilege; ships with the table) ---------------------

alter table atlas_underwriter_profiles enable row level security;

-- Any authenticated Atlas staff member (consultant/underwriter/manager/admin/
-- readonly/auditor) may read profiles — needed for the workload panel.
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'atlas_underwriter_profiles'
      and policyname = 'atlas_underwriter_profiles_staff_select'
  ) then
    create policy atlas_underwriter_profiles_staff_select on atlas_underwriter_profiles
      for select to authenticated using (atlas_is_staff());
  end if;
end $$;

-- Only manager/admin may write. atlas_can_manage() is the existing helper.
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'atlas_underwriter_profiles'
      and policyname = 'atlas_underwriter_profiles_manage_insert'
  ) then
    create policy atlas_underwriter_profiles_manage_insert on atlas_underwriter_profiles
      for insert to authenticated with check (atlas_can_manage());
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'atlas_underwriter_profiles'
      and policyname = 'atlas_underwriter_profiles_manage_update'
  ) then
    create policy atlas_underwriter_profiles_manage_update on atlas_underwriter_profiles
      for update to authenticated
      using (atlas_can_manage()) with check (atlas_can_manage());
  end if;
end $$;

-- Intentionally NO delete policy — profiles are deactivated via
-- active_for_assignment = false, never removed under RLS.
