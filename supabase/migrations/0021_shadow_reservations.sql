-- Phase 13: Cloudflare Queue-backed shadow pipeline.
--
-- The shadow queue consumer must prevent duplicate provider calls when
-- two consumers concurrently receive the same queue message. The unique
-- constraint on (input_fingerprint, pipeline_version) — combined with the
-- existing unique constraint on atlas_pipeline_shadow_comparisons — makes
-- concurrent duplicate reservations impossible: at most one insert wins.
--
-- States:
--   queued            — reservation exists (transient failure released it)
--   processing        — a consumer is actively running the shadow orchestrator
--   completed         — the comparison row has been written
--   failed_permanent  — a permanent failure; will not retry
--
-- A transient failure resets to queued and lets the queue's retry mechanism
-- redeliver the message. A permanent failure records failed_permanent so
-- subsequent redeliveries no-op quickly. A pipeline_version bump creates a
-- new reservation key, so the same fingerprint can be re-shadowed under a
-- new pipeline version.
--
-- Manager-only RLS matches every other shadow / pipeline metric table.

create table if not exists atlas_shadow_reservations (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  input_fingerprint text not null,
  pipeline_version text not null,
  submission_id uuid,
  legacy_job_id uuid,
  status text not null check (status in ('queued', 'processing', 'completed', 'failed_permanent')),
  started_at timestamptz,
  completed_at timestamptz
);

-- The reservation key. Concurrent inserts under the same key fail with a
-- unique-violation — that is what makes reservation strictly serial across
-- consumers even when Cloudflare Queues redelivers a message twice.
create unique index if not exists atlas_shadow_reservations_key_idx
  on atlas_shadow_reservations (input_fingerprint, pipeline_version);

create index if not exists atlas_shadow_reservations_status_idx
  on atlas_shadow_reservations (status, created_at desc);

comment on table atlas_shadow_reservations is
  'Reservation ledger for shadow-queue idempotency. One row per (input_fingerprint, pipeline_version). Prevents concurrent duplicate provider calls; states allow transient retry.';

alter table atlas_shadow_reservations enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'atlas_shadow_reservations'
      and policyname = 'atlas_shadow_reservations_manager_select'
  ) then
    create policy atlas_shadow_reservations_manager_select
      on atlas_shadow_reservations
      for select
      using (atlas_can_manage());
  end if;
end $$;
