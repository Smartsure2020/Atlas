-- Phase 1A: deterministic recommendation evidence contract.
--
-- Additive and nullable by design:
--   * historical recommendations remain readable with evidence_json = NULL;
--   * no historical rows are rewritten;
--   * existing RLS policies continue to govern the parent recommendation row;
--   * evidence is a point-in-time snapshot, never reconstructed from current
--     appetite rows.

alter table public.atlas_recommendations
  add column if not exists evidence_json jsonb;

comment on column public.atlas_recommendations.evidence_json is
  'Versioned point-in-time snapshot of reviewed matcher inputs, trusted clean document labels, exact appetite rule provenance, deterministic outcomes, and evidence-quality gaps. NULL on historical recommendations.';
