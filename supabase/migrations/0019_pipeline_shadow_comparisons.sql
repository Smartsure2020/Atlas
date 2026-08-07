-- Phase 10 hybrid pipeline: shadow-mode comparison store.
-- Records field-level MATCH COUNTS only. No PII, no raw values.

create table if not exists atlas_pipeline_shadow_comparisons (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),

  submission_id uuid,
  legacy_job_id uuid,
  legacy_extraction_id uuid,

  -- Input fingerprint links this comparison to the extraction fingerprint the
  -- job used, so shadow rows are idempotent under retry.
  input_fingerprint text not null,

  -- Aggregate counts. Never values.
  critical_field_match_count integer not null default 0,
  critical_field_mismatch_count integer not null default 0,
  critical_field_missing_hybrid_count integer not null default 0,
  critical_field_missing_legacy_count integer not null default 0,
  noncritical_field_match_count integer not null default 0,
  noncritical_field_mismatch_count integer not null default 0,
  conflict_count integer not null default 0,
  unknown_taxonomy_count integer not null default 0,

  -- Set of dotted field names that hybrid escalated to Sonnet (names only,
  -- no values). Bounded via app-side truncation.
  escalated_fields jsonb,

  -- Route + fallback decision the hybrid pipeline made.
  hybrid_route text,
  hybrid_fallback_reason text,
  hybrid_would_require_review boolean not null default false,

  -- Duration and token totals for at-a-glance latency comparison.
  legacy_total_ms integer,
  hybrid_total_ms integer,
  legacy_input_tokens integer,
  legacy_output_tokens integer,
  hybrid_haiku_input_tokens integer,
  hybrid_haiku_output_tokens integer,
  hybrid_sonnet_input_tokens integer,
  hybrid_sonnet_output_tokens integer,

  metadata jsonb
);

create unique index if not exists atlas_pipeline_shadow_comparisons_fp_idx
  on atlas_pipeline_shadow_comparisons (input_fingerprint);

create index if not exists atlas_pipeline_shadow_comparisons_created_at_idx
  on atlas_pipeline_shadow_comparisons (created_at desc);

create index if not exists atlas_pipeline_shadow_comparisons_submission_idx
  on atlas_pipeline_shadow_comparisons (submission_id, created_at desc)
  where submission_id is not null;

comment on table atlas_pipeline_shadow_comparisons is
  'Field-level aggregate comparisons between legacy and hybrid pipelines. No PII, no raw field values — counts and enum-like tags only.';

alter table atlas_pipeline_shadow_comparisons enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'atlas_pipeline_shadow_comparisons'
      and policyname = 'atlas_pipeline_shadow_comparisons_manager_select'
  ) then
    create policy atlas_pipeline_shadow_comparisons_manager_select
      on atlas_pipeline_shadow_comparisons
      for select
      using (atlas_can_manage());
  end if;
end $$;
