-- Phase 10 hybrid pipeline (pre-pilot): version the shadow comparisons.
--
-- The previous unique index was on (input_fingerprint) alone. That prevents a
-- newer pipeline VERSION from being benchmarked against a document that was
-- already shadowed. We keep idempotency within a single pipeline version but
-- allow later versions to record their own comparison for the same document.

alter table atlas_pipeline_shadow_comparisons
  add column if not exists pipeline_version text not null default 'legacy-shadow-v0';

alter table atlas_pipeline_shadow_comparisons
  add column if not exists extraction_schema_version text;

alter table atlas_pipeline_shadow_comparisons
  add column if not exists parser_version text;

alter table atlas_pipeline_shadow_comparisons
  add column if not exists normalisation_model text;

alter table atlas_pipeline_shadow_comparisons
  add column if not exists azure_model text;

-- Replace the fingerprint-only unique index with a (fingerprint, version) one.
-- The `if exists` guard keeps this migration re-runnable in dev.
drop index if exists atlas_pipeline_shadow_comparisons_fp_idx;

create unique index if not exists atlas_pipeline_shadow_comparisons_fp_ver_idx
  on atlas_pipeline_shadow_comparisons (input_fingerprint, pipeline_version);

comment on column atlas_pipeline_shadow_comparisons.pipeline_version is
  'Version tag from PIPELINE_VERSION in hybrid-orchestrator.ts. Bump whenever parser/prompt/model/validation semantics change.';
