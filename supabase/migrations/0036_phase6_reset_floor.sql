-- ============================================================================
-- Atlas — Phase 6 (Checkpoint 1B) durable delta-reset floor
-- Migration 0036
-- ----------------------------------------------------------------------------
-- Forward-only. Additive to 0028–0031 (Phase 5A) and 0032–0035 (Phase 5B).
-- Does NOT rewrite migration history or edit any existing table/function.
--
-- Problem
-- -------
-- Microsoft Graph filtered `messages/delta` initial enumerations using
-- `$filter=receivedDateTime ge <cutover>` return at most ~5,000 messages
-- and Microsoft does NOT lift that ceiling via `@odata.nextLink` pagination.
-- Reusing the configured cutover on EVERY delta-token reset (410
-- syncStateNotFound / syncStateInvalid) would eventually create an
-- unbounded historic reset window as the mailbox accumulates traffic —
-- and, past 5,000 messages since the cutover, would fail to complete.
--
-- Correction
-- ----------
-- Introduce a durable per-mailbox `reset_floor` (this migration), together
-- with a NEW atomic Phase 6 success RPC that in ONE Postgres transaction:
--
--   * fences the caller's lease (unchanged semantics)
--   * commits delta_link / in_round_next_link (unchanged semantics)
--   * clears breaker/failure state and next_attempt_after
--   * writes the graph_poll_success audit event
--   * when a FULL round completed (caller supplies the proposed floor),
--     monotonically advances reset_floor
--   * when only a partial round completed (caller supplies NULL floor),
--     leaves reset_floor unchanged
--
-- The old atlas_intake_release_lease_success RPC from 0030 remains present
-- for compatibility but is no longer called by the runtime. Every Phase 6
-- runtime code path uses the new atlas_intake_release_lease_success_with_
-- floor RPC.
--
-- Runtime contract when 0036 is missing
-- -------------------------------------
-- The runtime reads atlas_intake_graph_state.reset_floor BEFORE Graph token
-- acquisition. On any Supabase error (missing column, RLS, transport, …)
-- the runtime FAILS CLOSED: it releases the acquired mailbox lease safely
-- and returns `status="failed"` with a stable classified error code. It
-- does NOT degrade back to the configured cutover, and it does NOT issue
-- any Graph request. See worker/src/graph-intake.ts:readResetFloor and
-- pollMailbox.
--
-- Security posture identical to 0030 / 0033–0035: SECURITY INVOKER, pinned
-- search_path, service_role-only EXECUTE.
-- ============================================================================


-- ---------- Column: durable reset floor ------------------------------------

alter table public.atlas_intake_graph_state
  add column if not exists reset_floor timestamptz;

comment on column public.atlas_intake_graph_state.reset_floor is
  'Phase 6 durable delta-reset floor. NULL when never advanced. Set only after '
  'a fully-completed delta round; used together with the immutable configured '
  'cutover to derive the effective initial URL on a 410 reset (greatest of the '
  'two). Never derived from now() at reset time.';


-- ---------------------------------------------------------------------------
-- Function: atlas_intake_release_lease_success_with_floor
-- ---------------------------------------------------------------------------
--
-- Atomic Phase 6 success completion. Callers MUST pass:
--
--   p_reset_floor_provided = true, p_new_reset_floor = <iso>   -- full round
--   p_reset_floor_provided = false, p_new_reset_floor = null   -- resumable
--
-- Monotonic advance: the floor is only overwritten when the proposed value
-- is later than the persisted one. NULL persisted → any provided value wins.
-- Deliberate: `greatest(coalesce(s.reset_floor, '-infinity'::timestamptz),
-- p_new_reset_floor)` is idempotent under duplicate calls.
--
-- Never fabricates a state row. If the mailbox row is missing (should be
-- impossible after acquire_lease), the fence check falls through to
-- lease_lost and nothing is written.
-- ---------------------------------------------------------------------------

create or replace function public.atlas_intake_release_lease_success_with_floor(
  p_mailbox                text,
  p_expected_lease_id      uuid,
  p_delta_link             text,
  p_delta_link_provided    boolean,
  p_in_round_next_link     text,
  p_in_round_provided      boolean,
  p_last_success_at        timestamptz,
  p_audit_metadata         jsonb,
  p_new_reset_floor        timestamptz,
  p_reset_floor_provided   boolean
)
returns table (
  ok     boolean,
  reason text
)
language plpgsql
security invoker
set search_path to pg_catalog, public
as $$
declare
  v_match integer;
begin
  update public.atlas_intake_graph_state s
     set poll_in_flight_since = null,
         lease_id             = null,
         delta_link           = case when p_delta_link_provided then p_delta_link else s.delta_link end,
         in_round_next_link   = case when p_in_round_provided   then p_in_round_next_link else s.in_round_next_link end,
         last_error           = null,
         consecutive_failures = 0,
         last_success_at      = coalesce(p_last_success_at, s.last_success_at),
         breaker_opened_at    = null,
         next_attempt_after   = null,
         reset_floor          = case
                                  when p_reset_floor_provided and p_new_reset_floor is not null
                                    then greatest(coalesce(s.reset_floor, '-infinity'::timestamptz), p_new_reset_floor)
                                  else s.reset_floor
                                end
   where s.mailbox  = p_mailbox
     and s.lease_id = p_expected_lease_id;
  get diagnostics v_match = row_count;

  if v_match = 0 then
    ok := false;
    reason := 'lease_lost';
    return next;
    return;
  end if;

  insert into public.atlas_audit_logs (submission_id, action, actor, metadata_json)
  values (null, 'graph_poll_success', null, p_audit_metadata);

  ok := true;
  reason := null;
  return next;
end;
$$;

revoke all on function public.atlas_intake_release_lease_success_with_floor(
  text, uuid, text, boolean, text, boolean, timestamptz, jsonb, timestamptz, boolean
) from public;
revoke all on function public.atlas_intake_release_lease_success_with_floor(
  text, uuid, text, boolean, text, boolean, timestamptz, jsonb, timestamptz, boolean
) from anon;
revoke all on function public.atlas_intake_release_lease_success_with_floor(
  text, uuid, text, boolean, text, boolean, timestamptz, jsonb, timestamptz, boolean
) from authenticated;
grant  execute on function public.atlas_intake_release_lease_success_with_floor(
  text, uuid, text, boolean, text, boolean, timestamptz, jsonb, timestamptz, boolean
) to service_role;

comment on function public.atlas_intake_release_lease_success_with_floor(
  text, uuid, text, boolean, text, boolean, timestamptz, jsonb, timestamptz, boolean
) is
  'Phase 6 atomic success completion for Graph mailbox polling. Fences on '
  'lease_id, commits delta_link/in_round_next_link, clears breaker/failure '
  'state, writes graph_poll_success audit, and monotonically advances '
  'reset_floor when p_reset_floor_provided is true. Single Postgres '
  'transaction — a cursor/floor split-brain is not reachable. service_role '
  'EXECUTE only.';
