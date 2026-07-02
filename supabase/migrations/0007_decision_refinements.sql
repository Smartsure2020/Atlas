-- ============================================================================
-- Atlas Blueprint — Phase 3, Migration 0007
-- Decision capture refinements
-- ----------------------------------------------------------------------------
-- Additive only. No data migration. Three changes to atlas_decisions:
--
--   1. override_reason_code enum — a structured code alongside the existing
--      free-text override_reason. The code is what makes overrides reportable
--      ("how often do we override for pricing?"); the free text carries
--      nuance. The 'other' code requires the free text be supplied (enforced
--      in the app layer, not as a constraint, since requiredness depends on
--      whether ai_recommendation_accepted is false).
--
--   2. recommendation_id — links the decision to the specific recommendation
--      row it was made against. Audit gold: if a user re-runs a recommendation
--      and then decides, we know which version of the recommendation drove
--      the decision.
--
--   3. selected_insurer_id — optional reference to atlas_insurers when the
--      chosen insurer matches one on file. Lets us report on routing by
--      insurer without joining on string names.
-- ============================================================================

-- Reason codes — deliberately a small starter set. Add more later by altering
-- the enum (Postgres allows ALTER TYPE ... ADD VALUE without downtime).
create type atlas_override_reason_code as enum (
  'client_preference',
  'broker_relationship',
  'claims_history_factor',
  'pricing_factor',
  'capacity_constraint',
  'client_request',
  'other'
);

alter table atlas_decisions
  add column override_reason_code atlas_override_reason_code;

-- Audit linkage: which recommendation was this decision made against?
alter table atlas_decisions
  add column recommendation_id uuid references atlas_recommendations(id) on delete set null;

-- Optional insurer-table linkage for the selected insurer.
alter table atlas_decisions
  add column selected_insurer_id uuid references atlas_insurers(id) on delete set null;

comment on column atlas_decisions.override_reason_code is
  'Structured reason code for overrides. Free-text override_reason still supplements when the code is "other" or when more nuance is needed.';
comment on column atlas_decisions.recommendation_id is
  'The specific recommendation row this decision was made against. Critical when recommendations have been re-run multiple times.';
