-- ============================================================================
-- Atlas — Phase 6 (Checkpoint 1A) durable delta-reset floor
-- Migration 0036
-- ----------------------------------------------------------------------------
-- Forward-only. Additive to 0028–0031 (Phase 5A) and 0032–0035 (Phase 5B).
-- Does NOT rewrite migration history or edit any existing table/function.
--
-- Problem
-- -------
-- Microsoft Graph filtered message-delta queries using $filter=receivedDateTime
-- ge <cutover> are documented as limited to ~5,000 messages per initial
-- enumeration. The Phase 6 initial cutover we introduced in 0033-era code is
-- the immutable earliest boundary for the FIRST-ever sync of a mailbox.
-- Reusing that same original boundary on EVERY delta-token reset (syncStateNot
-- Found / syncStateInvalid, HTTP 410) would eventually produce an unbounded
-- historic reset window as the mailbox accumulates new messages.
--
-- Correction
-- ----------
-- Introduce a durable per-mailbox `reset_floor`:
--
--   * NULL by default (new column, additive).
--   * Advanced monotonically ONLY after a FULLY COMPLETED delta round
--     (i.e. Atlas persisted a fresh deltaLink from Microsoft Graph).
--     Never advanced on `ok_resumable` / partial-round exits.
--   * Advanced value = poll-start time (from that completed round) MINUS a
--     conservative replay overlap the runtime picks (currently 24h).
--   * On a 410 reset, the initial URL boundary is:
--         effective_cutover = greatest(configured_cutover, reset_floor)
--     The floor is never derived from Date.now() at reset time — it is the
--     already-persisted value from a prior completed round.
--
-- Invariants (mirrored by tests in tests/phase21-cutover-safety.test.ts and
-- tests/phase19b-graph-intake-behavioural.test.ts):
--
--   * effective_cutover ≥ configured_cutover  (the immutable earliest bound)
--   * effective_cutover is only advanced by a persisted advance_reset_floor
--     call; a resumable round makes no such call
--   * no message that arrived AFTER the last completed round can be skipped:
--     the overlap makes the replay window bounded but non-empty
--   * no nextLink/deltaLink rewriting — the runtime forwards Graph's opaque
--     continuation URLs verbatim
--
-- Security posture identical to 0033–0035: SECURITY INVOKER, pinned
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


-- ---------- Function: atlas_intake_reset_floor_advance ---------------------
--
-- Behaviour
-- ---------
--   * NULL p_new_reset_floor → no-op (safe idempotent call).
--   * p_new_reset_floor ≤ current reset_floor → no-op (monotonic guard).
--   * p_new_reset_floor > current reset_floor OR reset_floor IS NULL → advance.
--   * Missing mailbox row → silent no-op (never fabricates a state row from
--     an advance path; pollMailbox owns row creation via acquire_lease).
-- ---------------------------------------------------------------------------

create or replace function public.atlas_intake_reset_floor_advance(
  p_mailbox           text,
  p_new_reset_floor   timestamptz
)
returns void
language plpgsql
security invoker
set search_path to pg_catalog, public
as $$
begin
  if p_new_reset_floor is null then
    return;
  end if;
  update public.atlas_intake_graph_state as s
     set reset_floor = greatest(coalesce(s.reset_floor, '-infinity'::timestamptz), p_new_reset_floor)
   where s.mailbox = p_mailbox
     and (s.reset_floor is null or s.reset_floor < p_new_reset_floor);
end
$$;

revoke all on function public.atlas_intake_reset_floor_advance(text, timestamptz) from public;
revoke all on function public.atlas_intake_reset_floor_advance(text, timestamptz) from authenticated;
revoke all on function public.atlas_intake_reset_floor_advance(text, timestamptz) from anon;
grant execute on function public.atlas_intake_reset_floor_advance(text, timestamptz) to service_role;

comment on function public.atlas_intake_reset_floor_advance(text, timestamptz) is
  'Phase 6 monotonic advance for atlas_intake_graph_state.reset_floor. '
  'No-op on NULL argument or when the proposed floor is not greater than the '
  'persisted one. service_role EXECUTE only.';
