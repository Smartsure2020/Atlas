-- Phase 10 hybrid pipeline: per-stage timing + routing telemetry.
-- Privacy-safe by construction: no document text, no PII, no client data.
-- Rows are append-only; managers inspect via the operational dashboard.

create table if not exists atlas_pipeline_metrics (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),

  -- Correlation. All optional so the emitter never blocks on a missing FK.
  job_id uuid,
  submission_id uuid,
  document_id uuid,

  -- Routing. What actually ran, not what was requested.
  pipeline_mode text not null default 'legacy',
  route text not null,
  provider text,
  model text,

  -- Document shape (numeric only).
  document_type text,
  document_hash_prefix text, -- first 12 chars of file_hash, for grouping
  page_count integer,
  file_size_bytes integer,

  -- Per-stage durations, milliseconds. NULL = stage skipped.
  queue_ms integer,
  download_ms integer,
  parse_ms integer,
  ocr_ms integer,
  llm_ttft_ms integer,
  llm_total_ms integer,
  validation_ms integer,
  matching_ms integer,
  total_ms integer,

  -- Token accounting (Anthropic; absent for non-LLM routes).
  input_tokens integer,
  cached_input_tokens integer,
  cache_write_tokens integer,
  output_tokens integer,

  -- Outcome signals.
  retry_count integer not null default 0,
  schema_failures integer not null default 0,
  fallback_reason text,
  escalated_to_sonnet boolean not null default false,
  final_status text not null,

  -- Free-form provider metadata (numbers/flags only; NEVER document text).
  metadata jsonb,

  constraint atlas_pipeline_metrics_mode_check
    check (pipeline_mode in ('legacy', 'hybrid', 'shadow')),
  constraint atlas_pipeline_metrics_final_status_check
    check (final_status in ('completed', 'failed', 'cancelled', 'skipped', 'shadow'))
);

create index if not exists atlas_pipeline_metrics_created_at_idx
  on atlas_pipeline_metrics (created_at desc);

create index if not exists atlas_pipeline_metrics_job_idx
  on atlas_pipeline_metrics (job_id)
  where job_id is not null;

create index if not exists atlas_pipeline_metrics_submission_idx
  on atlas_pipeline_metrics (submission_id, created_at desc)
  where submission_id is not null;

create index if not exists atlas_pipeline_metrics_route_idx
  on atlas_pipeline_metrics (route, pipeline_mode, created_at desc);

comment on table atlas_pipeline_metrics is
  'Per-job timing/routing telemetry for the hybrid document pipeline. Numeric only — no PII, no document text.';

comment on column atlas_pipeline_metrics.route is
  'text_fast_path | ocr_required | layout_required | large_model_fallback | legacy_full_sonnet | unsupported | encrypted | failed';

comment on column atlas_pipeline_metrics.pipeline_mode is
  'legacy = old path only; hybrid = new authoritative; shadow = new runs but not authoritative.';

-- RLS: only staff (manager+) can read metrics; the worker (service role) writes.
alter table atlas_pipeline_metrics enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'atlas_pipeline_metrics'
      and policyname = 'atlas_pipeline_metrics_manager_select'
  ) then
    create policy atlas_pipeline_metrics_manager_select
      on atlas_pipeline_metrics
      for select
      using (atlas_can_manage());
  end if;
end $$;
