-- ============================================================================
-- Atlas Blueprint — Phase 0, Migration 0001
-- Enums + insurer reference tables (the persisted "guidelines" side)
-- ----------------------------------------------------------------------------
-- Atlas is a decision-SUPPORT tool. Nothing in this schema computes premiums,
-- applies discounts, issues quotes, or binds cover. The data model exists to
-- (a) capture submissions, (b) hold AI extractions + human-reviewed versions,
-- (c) hold a database-configurable insurer appetite matrix, (d) hold ranked
-- recommendations with their reasoning, (e) capture the underwriter's decision,
-- and (f) keep a complete, permanent audit trail.
--
-- Design notes that recur throughout:
--   * Client submission DOCUMENTS are transient (they live in Cardinal / the
--     insurer portals as the system of record). They auto-expire here.
--   * EXTRACTIONS are permanent — the structured risk summary outlives the file.
--   * INSURER guideline documents are reference data and DO persist.
--   * Appetite lives in DATA (atlas_insurer_appetite rows), never in code, so
--     guidelines can change without a redeploy.
-- ============================================================================

-- ---------- Enums -----------------------------------------------------------

-- Lifecycle of a submission as it moves across the dashboard columns.
create type atlas_submission_status as enum (
  'new',
  'in_review',
  'missing_info_requested',
  'ready_for_quote',
  'referred_to_insurer',
  'completed',
  'closed'
);

-- How strongly an insurer wants a given risk. Drives the deterministic score.
--   preferred  -> actively wants it
--   standard   -> will write it
--   caution    -> will consider, with conditions / referral likely
--   declined   -> will not write it (hard zero in the matcher)
create type atlas_appetite_level as enum (
  'preferred',
  'standard',
  'caution',
  'declined'
);

-- Transient client documents flip from active -> expired when the retention
-- cron deletes the underlying file. The row stays so history shows it existed.
create type atlas_document_status as enum (
  'active',
  'expired'
);

-- The underwriter's final routing decision on a submission.
create type atlas_decision_status as enum (
  'ready_for_quote',
  'referred',
  'closed'
);

-- Source of an appetite record: extracted from a guideline doc by the AI, or
-- entered/edited by hand. Useful for the confirm-before-go-live workflow.
create type atlas_appetite_source as enum (
  'ai_extracted',
  'manual'
);

-- ---------- Insurers (parent of the guidelines area) ------------------------

-- One row per insurer/facility we can quote on (CIB, ONE, Alpha, Infiniti,
-- Hollard, Guardrisk, Paladin, Protocol, AC&E, TRA, F&I, Cross Country, ...).
-- This is the "section with all the applicable insurers" the underwriting team
-- pictured: each insurer gets guideline docs attached and appetite rows derived.
create table atlas_insurers (
  id           uuid primary key default gen_random_uuid(),
  name         text not null unique,
  -- How we transact with them — purely informational for the underwriter, e.g.
  -- 'cardinal', 'own_portal', 'email_submission' (ONE works this way). Not an
  -- integration flag; Atlas never submits anywhere in the MVP.
  quote_channel text,
  active       boolean not null default true,
  notes        text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

comment on table atlas_insurers is
  'Insurer/facility reference list. Parent of guideline documents and appetite rows.';
comment on column atlas_insurers.quote_channel is
  'Informational only (cardinal/own_portal/email_submission). Atlas never auto-submits in the MVP.';

-- ---------- Insurer guideline documents (persisted reference data) ----------

-- Uploaded underwriting guidelines / wordings / appetite docs per insurer.
-- These are NOT client data and do NOT expire. Atlas reads each ONCE at upload
-- time to PROPOSE appetite rows; an underwriter confirms them before they go
-- live. The stored file lets a human re-reference the source clause later.
create table atlas_insurer_documents (
  id            uuid primary key default gen_random_uuid(),
  insurer_id    uuid not null references atlas_insurers(id) on delete cascade,
  file_name     text not null,
  storage_path  text not null,         -- path in the (private) insurer-docs bucket
  document_kind text,                  -- 'guideline' | 'wording' | 'appetite' | 'other'
  uploaded_by   uuid not null,         -- auth.users id of the uploader
  -- Set once the AI has read this doc and proposed appetite records from it.
  processed_at  timestamptz,
  created_at    timestamptz not null default now()
);

create index atlas_insurer_documents_insurer_idx
  on atlas_insurer_documents (insurer_id);

comment on table atlas_insurer_documents is
  'Persisted insurer guideline/wording docs (reference data, not client data — these do not expire).';
