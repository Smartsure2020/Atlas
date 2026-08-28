-- ---------------------------------------------------------------------------
-- Migration 0026: broker history hardening — audit action allow-list
-- ---------------------------------------------------------------------------
-- Forward-only. Do NOT edit 0025 in place — it is already applied to staging.
--
-- Context: after 0025 the broker could SELECT any atlas_audit_logs row whose
-- submission was accessible to them (i.e. their own case). Several internal
-- audit actions carry underwriting-intelligence metadata — recommendation_run,
-- quote_review_run, decision_*, extraction_run, communication_saved, etc. —
-- which is exactly what the Phase 3 broker boundary must not disclose.
--
-- This migration tightens the atlas_audit_select policy so a broker sees ONLY
-- an explicit positive allow-list of operational actions. Anything else —
-- including any future action not yet named — fails closed for broker.
--
-- Direct broker Data API is the concern here; the Worker projection layer is
-- handled independently in worker/src/audit-endpoints.ts and returns a
-- sanitised, metadata-scrubbed shape (defence in depth).
--
-- Staff visibility (manager/admin/consultant/underwriter/readonly/auditor)
-- is unchanged. Audit remains append-only — no INSERT/UPDATE/DELETE policy
-- is added for broker, and none of the existing policies are altered.
-- ---------------------------------------------------------------------------

-- ---------- 1. Broker-safe audit action allow-list ------------------------
-- Positive allow-list. New actions default to NOT visible to broker.
-- Each entry is a submission-scoped operational action whose metadata is
-- either empty or trivially safe (submission id references, item counts,
-- queue-state labels, document filenames). Every action that references
-- underwriting intelligence (extraction, recommendation, quote review,
-- decision, communication, appetite, insurer, model / pipeline internals,
-- pilot admin) is DELIBERATELY excluded.

create or replace function public.atlas_broker_audit_action_allowed(
  p_action text
)
returns boolean
language sql
immutable
as $$
  -- Explicit positive list. Update this SET (via a new migration) to widen
  -- broker-visible audit history — never rely on an implicit include.
  select p_action in (
    'submission_created',
    'document_uploaded',
    'submission_queue_status_changed',
    'missing_info_added',
    'missing_info_updated'
  );
$$;

comment on function public.atlas_broker_audit_action_allowed(text) is
  'Broker direct-audit allow-list. Every unlisted action — including any new '
  'audit action added by future phases — is invisible to broker via the '
  'Data API. Widen through a new migration, never through code paths.';

-- ---------- 2. Replace atlas_audit_select --------------------------------
-- Same staff clauses as 0025; the broker branch now additionally requires
-- the action to appear in the allow-list. Broker's own actor-scoped rows
-- are also gated by the allow-list — they are still audit rows and the
-- same disclosure rules apply.

drop policy if exists atlas_audit_select on public.atlas_audit_logs;
create policy atlas_audit_select on public.atlas_audit_logs
  for select
  using (
    -- Managers / admins / readonly / auditor keep full visibility.
    public.atlas_role() in ('manager', 'admin', 'readonly', 'auditor')
    -- Staff (consultant / underwriter) see access-scoped submission-linked rows.
    or (
      public.atlas_is_staff()
      and submission_id is not null
      and public.atlas_can_access_submission(submission_id)
    )
    -- Staff also see their own actor-scoped non-submission rows.
    or (public.atlas_is_staff() and actor = auth.uid())
    -- Broker sees ONLY allow-listed operational actions on their own submission.
    or (
      public.atlas_is_broker()
      and submission_id is not null
      and public.atlas_can_access_submission(submission_id)
      and public.atlas_broker_audit_action_allowed(action)
    )
    -- Broker's own actor-scoped rows also require the action allow-list.
    or (
      public.atlas_is_broker()
      and actor = auth.uid()
      and public.atlas_broker_audit_action_allowed(action)
    )
  );

-- No INSERT / UPDATE / DELETE policy is added for broker. Audit rows are
-- written by the Worker under service_role and remain append-only.
