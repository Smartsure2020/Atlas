-- ---------------------------------------------------------------------------
-- Migration 0025: broker role + RLS hardening + assignment target filter
-- ---------------------------------------------------------------------------
-- Forward-only. Do NOT edit 0012 / 0016 / 0023 / 0024 in place.
--
-- Introduces the authenticated internal `broker` role and:
--
-- 1. Adds atlas_is_broker() and atlas_is_atlas_user() helper functions.
-- 2. Extends atlas_can_access_submission() so a broker can access ONLY the
--    submissions they created (never assigned_to / assigned_underwriter).
-- 3. Tightens SELECT policies on the underwriting-intelligence tables so
--    they REQUIRE atlas_is_staff() in addition to atlas_can_access_submission.
--    Without this step, expanding atlas_can_access_submission would silently
--    grant brokers read access to their own submission's extractions,
--    recommendations, decisions, quote reviews and communications — the
--    exact underwriting output broker must never see.
-- 4. Updates atlas_assignment_events SELECT so broker can read the history
--    on their own submission (but not underwriting intelligence).
-- 5. Updates atlas_audit_logs SELECT so broker can read submission-scoped
--    audit rows on their own case, and their own actor-scoped rows,
--    without seeing system-wide audit history.
-- 6. Hardens atlas_set_submission_assignment: an assignment target must
--    have a trusted app_metadata.atlas_role in
--    {underwriter, consultant, manager, admin}. Anything else — broker,
--    readonly, auditor, missing role — returns target_not_assignable.
-- 7. Hardens atlas_auto_assign_submission candidate ranking so a profile
--    row alone is not enough — the candidate auth.users row must also
--    carry an assignable trusted role. Advisory lock, workload semantics,
--    deterministic ranking, historical NULL exclusion and event/audit
--    atomicity are preserved unchanged.
--
-- No table drops, no data backfill, no team model, no Graph/intake work.
-- ---------------------------------------------------------------------------

-- ---------- 1. atlas_is_broker / atlas_is_atlas_user -----------------------

create or replace function public.atlas_is_broker()
returns boolean
language sql
stable
as $$
  select atlas_role() = 'broker';
$$;

comment on function public.atlas_is_broker() is
  'True when the JWT app_metadata.atlas_role resolves to the authenticated broker role. Independent of atlas_is_staff() — broker is NOT staff.';

create or replace function public.atlas_is_atlas_user()
returns boolean
language sql
stable
as $$
  select public.atlas_is_staff() or public.atlas_is_broker();
$$;

comment on function public.atlas_is_atlas_user() is
  'True when the caller is any authorised Atlas identity (staff or broker). Use where broker access is EXPLICITLY intended alongside staff.';


-- ---------- 2. atlas_can_access_submission with broker branch --------------
-- Signature is unchanged. Behaviour:
--   * manager / admin / readonly / auditor:
--       any submission (existing all-view semantics preserved)
--   * broker:
--       ONLY submissions where created_by = auth.uid()
--       — assignment fields are IGNORED for broker
--   * consultant / underwriter:
--       existing scope: created_by / assigned_to / assigned_underwriter
--   * unknown / missing role:
--       false

create or replace function public.atlas_can_access_submission(p_submission_id uuid)
returns boolean
language sql
stable
security definer
set search_path to pg_catalog, public
as $$
  with r as (select public.atlas_role() as role, auth.uid() as uid)
  select
    (select role in ('manager', 'admin', 'readonly', 'auditor') from r)
    or (
      (select role = 'broker' from r)
      and exists (
        select 1
        from public.atlas_submissions s
        where s.id = p_submission_id
          and (select uid from r) is not null
          and s.created_by = (select uid from r)
      )
    )
    or (
      (select role in ('consultant', 'underwriter') from r)
      and exists (
        select 1
        from public.atlas_submissions s
        where s.id = p_submission_id
          and (select uid from r) is not null
          and (select uid from r) in (s.created_by, s.assigned_to, s.assigned_underwriter)
      )
    );
$$;

comment on function public.atlas_can_access_submission(uuid) is
  'Authoritative submission-access helper. Broker access is created_by-only; assigned_to/assigned_underwriter are intentionally NOT considered for broker so a broker cannot gain access merely because they were mistakenly assigned.';


-- ---------- 3. Tighten underwriting-intelligence SELECT policies -----------
-- These tables MUST NOT expose data to broker even for the broker's own
-- submission. Existing policies only checked atlas_can_access_submission(),
-- which now returns true for a broker's own case. Add the atlas_is_staff()
-- guard so broker fails at policy evaluation time.
--
-- No behavioural change for internal staff.
-- INSERT / UPDATE policies already require atlas_can_write() (which excludes
-- broker) and are left unchanged.

drop policy if exists atlas_extractions_scoped_select on public.atlas_extractions;
create policy atlas_extractions_scoped_select on public.atlas_extractions
  for select
  using (public.atlas_is_staff() and public.atlas_can_access_submission(submission_id));

drop policy if exists atlas_recommendations_scoped_select on public.atlas_recommendations;
create policy atlas_recommendations_scoped_select on public.atlas_recommendations
  for select
  using (public.atlas_is_staff() and public.atlas_can_access_submission(submission_id));

drop policy if exists atlas_decisions_scoped_select on public.atlas_decisions;
create policy atlas_decisions_scoped_select on public.atlas_decisions
  for select
  using (public.atlas_is_staff() and public.atlas_can_access_submission(submission_id));

drop policy if exists atlas_quote_reviews_scoped_select on public.atlas_quote_reviews;
create policy atlas_quote_reviews_scoped_select on public.atlas_quote_reviews
  for select
  using (public.atlas_is_staff() and public.atlas_can_access_submission(submission_id));

drop policy if exists atlas_quote_review_sections_scoped_select on public.atlas_quote_review_sections;
create policy atlas_quote_review_sections_scoped_select on public.atlas_quote_review_sections
  for select
  using (
    public.atlas_is_staff()
    and exists (
      select 1
      from public.atlas_quote_reviews qr
      where qr.id = atlas_quote_review_sections.quote_review_id
        and public.atlas_can_access_submission(qr.submission_id)
    )
  );

drop policy if exists atlas_communications_scoped_select on public.atlas_communications;
create policy atlas_communications_scoped_select on public.atlas_communications
  for select
  using (public.atlas_is_staff() and public.atlas_can_access_submission(submission_id));


-- ---------- 4. Assignment events: allow broker on own submission -----------
-- Broker MAY read the assignment history of a submission they created (so
-- they can see who owns / has owned their case). Table remains immutable
-- to non-service-role callers.

drop policy if exists atlas_assignment_events_staff_select on public.atlas_assignment_events;
create policy atlas_assignment_events_scoped_select on public.atlas_assignment_events
  for select
  using (public.atlas_is_atlas_user() and public.atlas_can_access_submission(submission_id));


-- ---------- 5. Audit: allow broker to see own case + own actor rows --------
-- Broker MUST NOT see system-wide audit history. Broker sees:
--   * audit rows whose submission_id is a submission the broker created
--   * audit rows the broker themselves emitted as actor
-- Staff visibility (manager/admin/readonly/auditor and access-scoped staff)
-- is preserved.

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
    -- Broker sees rows on their own submissions.
    or (
      public.atlas_is_broker()
      and submission_id is not null
      and public.atlas_can_access_submission(submission_id)
    )
    -- Broker also sees their own actor-scoped rows.
    or (public.atlas_is_broker() and actor = auth.uid())
  );

-- No INSERT / UPDATE / DELETE policy is added for broker. Audit rows are
-- written by the Worker under service_role and remain append-only.


-- ---------- 6. Assignment target role hardening ---------------------------
-- Existing target-user existence check accepted ANY row in auth.users. That
-- is unsafe once broker identities exist because a broker profile row could
-- otherwise become the assignment target. Add trusted-role validation.

create or replace function public.atlas_set_submission_assignment(
  p_submission_id uuid,
  p_assigned_to uuid,
  p_actor uuid
)
returns jsonb
language plpgsql
security definer
volatile
set search_path = pg_catalog, public
as $$
declare
  v_submission record;
  v_event_type text;
  v_new_stage atlas_pipeline_stage;
  v_event_id uuid;
  v_target_exists boolean;
  v_target_role text;
begin
  if p_actor is null then
    return jsonb_build_object(
      'outcome', 'actor_required',
      'submission_id', p_submission_id
    );
  end if;

  perform pg_advisory_xact_lock(4272001, 1);

  select id, pipeline_stage, assigned_to
    into v_submission
    from public.atlas_submissions
   where id = p_submission_id
   for update;

  if not found then
    return jsonb_build_object(
      'outcome', 'submission_not_found',
      'submission_id', p_submission_id
    );
  end if;

  -- Same-target no-op (both directions).
  if p_assigned_to is not null and v_submission.assigned_to = p_assigned_to then
    return jsonb_build_object(
      'outcome', 'unchanged',
      'submission_id', p_submission_id,
      'assigned_to', v_submission.assigned_to,
      'pipeline_stage', v_submission.pipeline_stage::text
    );
  end if;

  if p_assigned_to is null and v_submission.assigned_to is null then
    return jsonb_build_object(
      'outcome', 'unchanged',
      'submission_id', p_submission_id,
      'assigned_to', null,
      'pipeline_stage', v_submission.pipeline_stage::text
    );
  end if;

  if v_submission.pipeline_stage in (
       'bound'::atlas_pipeline_stage,
       'declined'::atlas_pipeline_stage,
       'lost'::atlas_pipeline_stage
     ) then
    return jsonb_build_object(
      'outcome', 'terminal_submission',
      'submission_id', p_submission_id,
      'pipeline_stage', v_submission.pipeline_stage::text
    );
  end if;

  -- Target must exist AND carry a trusted role that can own underwriting
  -- work. A profile row is NOT required (human override still allowed for
  -- any staff user), but the role trapdoor is enforced.
  if p_assigned_to is not null then
    select true, coalesce(u.raw_app_meta_data ->> 'atlas_role', '')
      into v_target_exists, v_target_role
      from auth.users u
     where u.id = p_assigned_to;

    if v_target_exists is null then
      return jsonb_build_object(
        'outcome', 'target_user_not_found',
        'submission_id', p_submission_id,
        'assigned_to', p_assigned_to
      );
    end if;

    if v_target_role not in ('underwriter', 'consultant', 'manager', 'admin') then
      return jsonb_build_object(
        'outcome', 'target_not_assignable',
        'submission_id', p_submission_id,
        'assigned_to', p_assigned_to
      );
    end if;
  end if;

  if v_submission.assigned_to is null and p_assigned_to is not null then
    v_event_type := 'manual_assigned';
  elsif v_submission.assigned_to is not null and p_assigned_to is not null
        and v_submission.assigned_to <> p_assigned_to then
    v_event_type := 'reassigned';
  else
    v_event_type := 'unassigned';
  end if;

  if v_submission.pipeline_stage is null then
    v_new_stage := null;
  elsif p_assigned_to is null then
    if v_submission.pipeline_stage = 'assigned'::atlas_pipeline_stage then
      v_new_stage := 'triaged'::atlas_pipeline_stage;
    else
      v_new_stage := v_submission.pipeline_stage;
    end if;
  else
    if v_submission.pipeline_stage in (
         'new'::atlas_pipeline_stage,
         'triaged'::atlas_pipeline_stage
       ) then
      v_new_stage := 'assigned'::atlas_pipeline_stage;
    else
      v_new_stage := v_submission.pipeline_stage;
    end if;
  end if;

  update public.atlas_submissions
     set assigned_to             = p_assigned_to,
         assigned_underwriter    = p_assigned_to,
         assigned_at             = case when p_assigned_to is not null then now() else null end,
         assigned_by             = case when p_assigned_to is not null then p_actor else null end,
         pipeline_stage          = v_new_stage,
         last_pipeline_stage_changed_at =
           case when v_new_stage is distinct from v_submission.pipeline_stage
                then now()
                else last_pipeline_stage_changed_at
           end
   where id = p_submission_id;

  if p_assigned_to is not null then
    update public.atlas_underwriter_profiles
       set last_assigned_at = now()
     where user_id = p_assigned_to;
  end if;

  insert into public.atlas_assignment_events (
    submission_id, assignment_source, event_type,
    from_user_id, to_user_id, actor_user_id,
    selected_open_count, eligible_candidate_count
  ) values (
    p_submission_id, 'manual', v_event_type,
    v_submission.assigned_to, p_assigned_to, p_actor,
    null, null
  ) returning id into v_event_id;

  insert into public.atlas_audit_logs (submission_id, action, actor, metadata_json)
  values (
    p_submission_id,
    'submission_assignment_changed',
    p_actor,
    jsonb_build_object(
      'from_user_id', v_submission.assigned_to,
      'to_user_id', p_assigned_to,
      'event_type', v_event_type,
      'pipeline_stage', case when v_new_stage is null then null else v_new_stage::text end
    )
  );

  return jsonb_build_object(
    'outcome', 'assigned',
    'submission_id', p_submission_id,
    'assigned_to', p_assigned_to,
    'from_user_id', v_submission.assigned_to,
    'event_type', v_event_type,
    'pipeline_stage', case when v_new_stage is null then null else v_new_stage::text end,
    'event_id', v_event_id
  );
end;
$$;

comment on function public.atlas_set_submission_assignment(uuid, uuid, uuid) is
  'Canonical Atlas manual assignment. Adds target-role filter (Phase 3): target must have app_metadata.atlas_role in (underwriter, consultant, manager, admin). Preserves Phase 2 concurrency, stage matrix, idempotency and audit atomicity.';


-- ---------- 7. Auto-assignment candidate role filter ---------------------
-- A profile row alone is not enough. The candidate auth.users row must
-- carry a trusted app_metadata.atlas_role in the assignable set. This
-- prevents an accidentally created broker profile from ever being auto-
-- picked. Advisory lock, workload counts (which STILL exclude historical
-- NULL rows), deterministic ranking and event/audit atomicity are unchanged.

-- Preserve the default parameter value from migration 0024 so CREATE OR REPLACE
-- does not attempt to remove it (Postgres refuses that with SQLSTATE 42P13).
-- The Worker always passes p_actor explicitly; the default is kept purely so
-- the function signature is byte-identical to 0024's.
create or replace function public.atlas_auto_assign_submission(
  p_submission_id uuid,
  p_actor uuid default null
)
returns jsonb
language plpgsql
security definer
volatile
set search_path = pg_catalog, public
as $$
declare
  v_submission record;
  v_capability text;
  v_selected_user uuid;
  v_selected_open_count int;
  v_eligible_count int;
  v_new_stage atlas_pipeline_stage;
  v_event_id uuid;
begin
  if p_actor is null then
    return jsonb_build_object(
      'outcome', 'actor_required',
      'submission_id', p_submission_id
    );
  end if;

  perform pg_advisory_xact_lock(4272001, 1);

  select id,
         pipeline_stage,
         line_of_business,
         complexity,
         assigned_to
    into v_submission
    from public.atlas_submissions
   where id = p_submission_id
   for update;

  if not found then
    return jsonb_build_object(
      'outcome', 'submission_not_found',
      'submission_id', p_submission_id
    );
  end if;

  if v_submission.pipeline_stage is null then
    return jsonb_build_object(
      'outcome', 'pipeline_not_initialized',
      'submission_id', p_submission_id
    );
  end if;

  if v_submission.pipeline_stage = 'new'::atlas_pipeline_stage then
    return jsonb_build_object(
      'outcome', 'not_triaged',
      'submission_id', p_submission_id,
      'pipeline_stage', v_submission.pipeline_stage::text
    );
  end if;

  if v_submission.pipeline_stage in (
       'bound'::atlas_pipeline_stage,
       'declined'::atlas_pipeline_stage,
       'lost'::atlas_pipeline_stage
     ) then
    return jsonb_build_object(
      'outcome', 'terminal_submission',
      'submission_id', p_submission_id,
      'pipeline_stage', v_submission.pipeline_stage::text
    );
  end if;

  if v_submission.assigned_to is not null then
    return jsonb_build_object(
      'outcome', 'already_assigned',
      'submission_id', p_submission_id,
      'assigned_to', v_submission.assigned_to,
      'pipeline_stage', v_submission.pipeline_stage::text
    );
  end if;

  if v_submission.line_of_business = 'personal' then
    v_capability := 'can_take_personal';
  elsif v_submission.line_of_business = 'commercial'
    and v_submission.complexity = 'standard' then
    v_capability := 'can_take_commercial';
  elsif v_submission.line_of_business = 'commercial'
    and v_submission.complexity = 'complex' then
    v_capability := 'can_take_complex_commercial';
  else
    return jsonb_build_object(
      'outcome', 'classification_required',
      'submission_id', p_submission_id,
      'line_of_business', v_submission.line_of_business,
      'complexity', v_submission.complexity
    );
  end if;

  with candidates as (
    select p.user_id,
           p.last_assigned_at,
           coalesce((
             select count(*)::int
               from public.atlas_submissions s
              where s.assigned_to = p.user_id
                and s.pipeline_stage is not null
                and s.pipeline_stage not in (
                  'bound'::atlas_pipeline_stage,
                  'declined'::atlas_pipeline_stage,
                  'lost'::atlas_pipeline_stage
                )
           ), 0) as open_count
      from public.atlas_underwriter_profiles p
     where p.active_for_assignment = true
       and (
         (v_capability = 'can_take_personal'           and p.can_take_personal = true)
         or (v_capability = 'can_take_commercial'      and p.can_take_commercial = true)
         or (v_capability = 'can_take_complex_commercial' and p.can_take_complex_commercial = true)
       )
       -- Phase 3: candidate's underlying auth.users identity MUST also carry
       -- a trusted assignable role. Prevents an accidentally created broker
       -- profile row from being selected.
       and exists (
         select 1
         from auth.users u
         where u.id = p.user_id
           and coalesce(u.raw_app_meta_data ->> 'atlas_role', '') in
               ('underwriter', 'consultant', 'manager', 'admin')
       )
  ),
  ranked as (
    select user_id, last_assigned_at, open_count,
           row_number() over (
             order by
               open_count asc,
               (last_assigned_at is not null) asc,
               last_assigned_at asc nulls first,
               user_id asc
           ) as rk
      from candidates
  )
  select r.user_id, r.open_count, (select count(*)::int from candidates)
    into v_selected_user, v_selected_open_count, v_eligible_count
    from ranked r
   where r.rk = 1;

  if v_selected_user is null then
    v_eligible_count := coalesce(v_eligible_count, 0);
    return jsonb_build_object(
      'outcome', 'no_eligible_underwriter',
      'submission_id', p_submission_id,
      'eligible_candidate_count', v_eligible_count,
      'pipeline_stage', v_submission.pipeline_stage::text
    );
  end if;

  perform 1
    from public.atlas_underwriter_profiles p
   where p.user_id = v_selected_user
   for update of p;

  if v_submission.pipeline_stage = 'triaged'::atlas_pipeline_stage then
    v_new_stage := 'assigned'::atlas_pipeline_stage;
  else
    v_new_stage := v_submission.pipeline_stage;
  end if;

  update public.atlas_submissions
     set assigned_to             = v_selected_user,
         assigned_underwriter    = v_selected_user,
         assigned_at             = now(),
         assigned_by             = p_actor,
         pipeline_stage          = v_new_stage,
         last_pipeline_stage_changed_at =
           case when v_new_stage is distinct from v_submission.pipeline_stage
                then now()
                else last_pipeline_stage_changed_at
           end
   where id = p_submission_id;

  update public.atlas_underwriter_profiles
     set last_assigned_at = now()
   where user_id = v_selected_user;

  insert into public.atlas_assignment_events (
    submission_id, assignment_source, event_type,
    from_user_id, to_user_id, actor_user_id,
    selected_open_count, eligible_candidate_count
  ) values (
    p_submission_id, 'auto', 'auto_assigned',
    null, v_selected_user, p_actor,
    v_selected_open_count, v_eligible_count
  ) returning id into v_event_id;

  insert into public.atlas_audit_logs (submission_id, action, actor, metadata_json)
  values (
    p_submission_id,
    'submission_auto_assigned',
    p_actor,
    jsonb_build_object(
      'assigned_to', v_selected_user,
      'selected_open_count', v_selected_open_count,
      'eligible_candidate_count', v_eligible_count,
      'pipeline_stage', v_new_stage::text
    )
  );

  return jsonb_build_object(
    'outcome', 'assigned',
    'submission_id', p_submission_id,
    'assigned_to', v_selected_user,
    'pipeline_stage', v_new_stage::text,
    'event_id', v_event_id,
    'selected_open_count', v_selected_open_count,
    'eligible_candidate_count', v_eligible_count
  );
end;
$$;

comment on function public.atlas_auto_assign_submission(uuid, uuid) is
  'Canonical Atlas auto-assignment. Adds Phase 3 candidate-role filter (auth.users.atlas_role must be assignable) on top of Phase 2 semantics. Same advisory lock, same workload rules, same historical NULL exclusion, same atomic event + audit. Weight remains unused.';
