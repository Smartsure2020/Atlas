-- ============================================================================
-- Atlas — Phase 2 (Quote Pipeline assignment engine)
-- Migration 0024: atlas_assignment_events + canonical assignment functions
-- ----------------------------------------------------------------------------
-- ADDITIVE ONLY. Forward-only. This migration installs the canonical
-- assignment transaction Atlas will use from now on. It DOES NOT touch any
-- Phase 1 schema, does NOT redefine any existing role/access helper, does
-- NOT backfill historical rows, and does NOT introduce any Phase 3+ concept
-- (broker role, teams, Microsoft Graph, intake, pipeline events, targeted
-- insurers, etc.).
--
-- Introduced by this migration:
--   - public.atlas_assignment_events (immutable assignment history)
--   - RLS on atlas_assignment_events (SELECT via existing helpers; NO
--     authenticated INSERT/UPDATE/DELETE policies — assignment rows are
--     written exclusively by the canonical SECURITY DEFINER functions)
--   - public.atlas_auto_assign_submission(uuid, uuid)   -- deterministic
--     capability-based least-busy auto-assignment
--   - public.atlas_set_submission_assignment(uuid, uuid, uuid)  -- canonical
--     manual assign / reassign / unassign
--
-- Concurrency model:
--   Both functions acquire the SAME transaction-level advisory lock BEFORE
--   any workload counting, candidate ranking, or assignment mutation. This
--   serializes the whole assignment critical section so strict least-busy
--   fairness holds without needing SKIP LOCKED. Row-locking on the chosen
--   underwriter profile still uses FOR UPDATE.
--
-- Historical-data rule:
--   Historical atlas_submissions rows with pipeline_stage IS NULL remain
--   untouched. Auto-assignment refuses to initialize them ('pipeline_not
--   _initialized'). Manual assignment preserves their NULL stage.
-- ============================================================================


-- ---------- atlas_assignment_events ----------------------------------------

create table if not exists public.atlas_assignment_events (
  id                        uuid primary key default gen_random_uuid(),
  submission_id             uuid not null
                              references public.atlas_submissions(id)
                              on delete cascade,
  assignment_source         text not null,
  event_type                text not null,
  from_user_id              uuid references auth.users(id) on delete set null,
  to_user_id                uuid references auth.users(id) on delete set null,
  actor_user_id             uuid references auth.users(id) on delete set null,
  selected_open_count       integer,
  eligible_candidate_count  integer,
  created_at                timestamptz not null default now(),
  constraint atlas_assignment_events_assignment_source_check
    check (assignment_source in ('auto', 'manual')),
  constraint atlas_assignment_events_event_type_check
    check (event_type in ('auto_assigned', 'manual_assigned', 'reassigned', 'unassigned')),
  constraint atlas_assignment_events_selected_open_count_check
    check (selected_open_count is null or selected_open_count >= 0),
  constraint atlas_assignment_events_eligible_candidate_count_check
    check (eligible_candidate_count is null or eligible_candidate_count >= 0)
);

comment on table public.atlas_assignment_events is
  'Immutable Atlas assignment history. Written exclusively by the canonical assignment SECURITY DEFINER functions. Manual events leave workload-selection counts NULL.';

-- Submission-level history (newest first).
create index if not exists atlas_assignment_events_submission_idx
  on public.atlas_assignment_events (submission_id, created_at desc);

-- Underwriter-level history (newest first), partial to keep the index small.
create index if not exists atlas_assignment_events_to_user_idx
  on public.atlas_assignment_events (to_user_id, created_at desc)
  where to_user_id is not null;


-- ---------- RLS -------------------------------------------------------------
-- Enable RLS immediately. Only SELECT is exposed to authenticated staff, and
-- only for submissions they can already access via the existing helper. No
-- INSERT/UPDATE/DELETE policies exist — assignment rows are written by the
-- SECURITY DEFINER functions running as service_role.

alter table public.atlas_assignment_events enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'atlas_assignment_events'
      and policyname = 'atlas_assignment_events_staff_select'
  ) then
    create policy atlas_assignment_events_staff_select on public.atlas_assignment_events
      for select to authenticated
      using (atlas_is_staff() and atlas_can_access_submission(submission_id));
  end if;
end $$;

-- Intentionally NO insert/update/delete policies. Assignment events are
-- immutable and are written exclusively by the SECURITY DEFINER assignment
-- functions below (grant EXECUTE only to service_role).


-- ---------- Auto-assignment function ---------------------------------------
-- Deterministic capability-based least-busy assignment. Returns a JSONB
-- outcome the Worker maps to HTTP responses. Never raises for expected
-- domain conditions (pipeline_not_initialized, not_triaged, terminal_
-- submission, classification_required, no_eligible_underwriter, submission
-- _not_found, already_assigned).

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
  v_selected_open_count integer;
  v_eligible_count integer;
  v_new_stage atlas_pipeline_stage;
  v_event_id uuid;
begin
  -- 1. Serialize the whole assignment critical section. Same key used by the
  -- canonical manual assignment function below so auto vs manual cannot race.
  perform pg_advisory_xact_lock(4272001, 1);

  -- 2. Lock the submission row FOR UPDATE.
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

  -- 3. Refuse historical rows outside the Quote Pipeline.
  if v_submission.pipeline_stage is null then
    return jsonb_build_object(
      'outcome', 'pipeline_not_initialized',
      'submission_id', p_submission_id
    );
  end if;

  -- 4. Refuse to silently perform triage.
  if v_submission.pipeline_stage = 'new'::atlas_pipeline_stage then
    return jsonb_build_object(
      'outcome', 'not_triaged',
      'submission_id', p_submission_id,
      'pipeline_stage', v_submission.pipeline_stage::text
    );
  end if;

  -- 5. Refuse terminal cases.
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

  -- 6. Existing assignment is idempotent — do not pick another user, do not
  --    insert another event.
  if v_submission.assigned_to is not null then
    return jsonb_build_object(
      'outcome', 'already_assigned',
      'submission_id', p_submission_id,
      'assigned_to', v_submission.assigned_to,
      'pipeline_stage', v_submission.pipeline_stage::text
    );
  end if;

  -- 7. Map classification -> capability. Atlas's canonical
  --    line_of_business vocabulary is (personal | commercial | NULL);
  --    complexity is (standard | complex | NULL). Unknown/missing
  --    classification is refused rather than silently inferred.
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

  -- 8. Rank eligible candidates deterministically. Workload counts ONLY the
  --    submissions in the Quote Pipeline (pipeline_stage NOT NULL) that are
  --    still open (not in a terminal stage). Historical NULL rows are
  --    intentionally excluded.
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

  -- 9. Take a real row lock on the chosen profile.
  perform 1
    from public.atlas_underwriter_profiles p
   where p.user_id = v_selected_user
   for update of p;

  -- 10. Determine the resulting pipeline_stage.
  if v_submission.pipeline_stage = 'triaged'::atlas_pipeline_stage then
    v_new_stage := 'assigned'::atlas_pipeline_stage;
  else
    -- assigned / in_progress / quoted — preserved.
    v_new_stage := v_submission.pipeline_stage;
  end if;

  -- 11. Mutate assignment atomically. Mirror the legacy assignment fields.
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

  -- 12. Stamp last_assigned_at on the selected profile.
  update public.atlas_underwriter_profiles
     set last_assigned_at = now()
   where user_id = v_selected_user;

  -- 13. Insert the single canonical assignment event.
  insert into public.atlas_assignment_events (
    submission_id, assignment_source, event_type,
    from_user_id, to_user_id, actor_user_id,
    selected_open_count, eligible_candidate_count
  ) values (
    p_submission_id, 'auto', 'auto_assigned',
    null, v_selected_user, p_actor,
    v_selected_open_count, v_eligible_count
  ) returning id into v_event_id;

  -- 14. Atomic audit row (safe metadata only — no PII).
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
  'Canonical Atlas auto-assignment. Serialized under a transaction advisory lock; deterministic capability-based least-busy ranking; atomic submission + assignment event + audit write.';


-- ---------- Manual assignment function -------------------------------------
-- Canonical transaction behind PATCH /api/submissions/:id/assignment for
-- assigned_to changes. Handles assignment, reassignment and unassignment,
-- preserves historical NULL pipeline_stage rows, and does NOT require the
-- target to have an atlas_underwriter_profiles row (a human override may
-- pick anyone in auth.users). Manual events leave workload-selection
-- counts NULL.

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
begin
  if p_actor is null then
    return jsonb_build_object(
      'outcome', 'actor_required',
      'submission_id', p_submission_id
    );
  end if;

  -- 1. Same assignment advisory lock as the auto path.
  perform pg_advisory_xact_lock(4272001, 1);

  -- 2. Lock the submission row FOR UPDATE.
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

  -- 3. Same-target no-op. Reject terminal changes.
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

  -- 4. If assigning to someone, they must exist in auth.users. A profile row
  --    is NOT required for manual assignment (a human override may pick any
  --    staff user).
  if p_assigned_to is not null then
    select true into v_target_exists
      from auth.users where id = p_assigned_to;
    if v_target_exists is null then
      return jsonb_build_object(
        'outcome', 'target_user_not_found',
        'submission_id', p_submission_id,
        'assigned_to', p_assigned_to
      );
    end if;
  end if;

  -- 5. Compute event type + resulting stage.
  if v_submission.assigned_to is null and p_assigned_to is not null then
    v_event_type := 'manual_assigned';
  elsif v_submission.assigned_to is not null and p_assigned_to is not null
        and v_submission.assigned_to <> p_assigned_to then
    v_event_type := 'reassigned';
  else
    v_event_type := 'unassigned';
  end if;

  if v_submission.pipeline_stage is null then
    -- Historical row: preserve NULL. Do not fabricate Quote Pipeline history.
    v_new_stage := null;
  elsif p_assigned_to is null then
    -- Unassigning a Quote Pipeline case.
    if v_submission.pipeline_stage = 'assigned'::atlas_pipeline_stage then
      v_new_stage := 'triaged'::atlas_pipeline_stage;
    else
      v_new_stage := v_submission.pipeline_stage;
    end if;
  else
    -- Assigning / reassigning a Quote Pipeline case.
    if v_submission.pipeline_stage in (
         'new'::atlas_pipeline_stage,
         'triaged'::atlas_pipeline_stage
       ) then
      v_new_stage := 'assigned'::atlas_pipeline_stage;
    else
      v_new_stage := v_submission.pipeline_stage;
    end if;
  end if;

  -- 6. Mutate submission atomically. Mirror legacy assignment fields.
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

  -- 7. If the target has a profile row, stamp last_assigned_at. No profile
  --    row => still a valid manual assignment; simply no profile to update.
  if p_assigned_to is not null then
    update public.atlas_underwriter_profiles
       set last_assigned_at = now()
     where user_id = p_assigned_to;
  end if;

  -- 8. Immutable assignment event.
  insert into public.atlas_assignment_events (
    submission_id, assignment_source, event_type,
    from_user_id, to_user_id, actor_user_id,
    selected_open_count, eligible_candidate_count
  ) values (
    p_submission_id, 'manual', v_event_type,
    v_submission.assigned_to, p_assigned_to, p_actor,
    null, null
  ) returning id into v_event_id;

  -- 9. Atomic audit row (safe metadata only — no PII).
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
  'Canonical Atlas manual assignment / reassignment / unassignment. Serialized under the same transaction advisory lock as the auto path; atomic submission + assignment event + audit write. Does not require the target to have an underwriter profile.';


-- ---------- Function hardening: revoke default EXECUTE, grant service_role -

revoke all on function public.atlas_auto_assign_submission(uuid, uuid) from public;
revoke all on function public.atlas_auto_assign_submission(uuid, uuid) from anon;
revoke all on function public.atlas_auto_assign_submission(uuid, uuid) from authenticated;
grant  execute on function public.atlas_auto_assign_submission(uuid, uuid) to service_role;

revoke all on function public.atlas_set_submission_assignment(uuid, uuid, uuid) from public;
revoke all on function public.atlas_set_submission_assignment(uuid, uuid, uuid) from anon;
revoke all on function public.atlas_set_submission_assignment(uuid, uuid, uuid) from authenticated;
grant  execute on function public.atlas_set_submission_assignment(uuid, uuid, uuid) to service_role;
