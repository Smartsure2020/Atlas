-- ---------------------------------------------------------------------------
-- Migration 0027: broker audit history is Worker-only (Data API lockdown)
-- ---------------------------------------------------------------------------
-- Forward-only. Do NOT edit 0025 or 0026 in place — both are applied to
-- staging.
--
-- Context
-- -------
-- After 0026, broker direct SELECT on public.atlas_audit_logs was filtered
-- by an explicit positive action allow-list. That filter is a ROW filter
-- only; PostgreSQL row-level security cannot sanitise individual COLUMN
-- values (metadata_json, actor) in the SELECT payload. For allow-listed
-- rows a broker signed into Supabase directly could therefore obtain the
-- raw metadata_json — e.g. quote_review_id on missing_info_added, or the
-- internal actor UUID for any row an internal staff member wrote.
--
-- Decision
-- --------
-- Broker audit / History access is now WORKER-ONLY. The Worker already:
--   * gates the request behind canAccessSubmission()
--   * filters by BROKER_SAFE_AUDIT_ACTIONS
--   * returns metadata: null for every event
--   * withholds internal actor_id / actor_email; broker's own actor stays
--     identifiable
-- (See worker/src/audit-projection.ts + worker/src/audit-endpoints.ts.)
--
-- This is simpler and safer than attempting column sanitisation via RLS.
-- Broker authenticated directly through Supabase must now receive ZERO
-- atlas_audit_logs rows regardless of submission ownership, actor
-- identity, action, or metadata contents.
--
-- Scope
-- -----
-- Replace atlas_audit_select. Preserve every internal (manager/admin/
-- readonly/auditor + consultant/underwriter) semantics exactly. Delete
-- the broker branch entirely.
--
-- Do NOT add broker INSERT/UPDATE/DELETE. Audit remains append-only.
--
-- The helper public.atlas_broker_audit_action_allowed(text) introduced in
-- 0026 is intentionally LEFT IN PLACE. It is no longer authoritative for
-- Data API access, but dropping it purely for cleanup would touch history
-- unnecessarily. Treat it as a legacy artefact of forward migration.
-- ---------------------------------------------------------------------------

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
    -- No broker branch. Broker audit visibility is Worker-only — see
    -- worker/src/audit-endpoints.ts. A broker authenticated directly
    -- through Supabase must receive zero atlas_audit_logs rows.
  );

comment on policy atlas_audit_select on public.atlas_audit_logs is
  'Broker audit / History access is intentionally Worker-only (0027). RLS '
  'cannot sanitise metadata_json / actor columns on SELECT, so direct Data '
  'API broker access is denied entirely. The Worker (audit-projection.ts) '
  'enforces the operational allow-list, metadata scrub, and actor '
  'withholding when the History tab is served.';
