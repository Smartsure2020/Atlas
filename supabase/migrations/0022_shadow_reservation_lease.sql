-- Phase 13.1: Owner-token + lease TTL on shadow reservations.
--
-- Before this migration the shadow-queue consumer identified a reservation
-- only by (input_fingerprint, pipeline_version). Two subtle failure modes
-- were possible:
--
--   1. releaseReservation() had no way to know it was releasing ITS OWN
--      reservation. A late or duplicate consumer could flip an active
--      "processing" row back to "queued" while another consumer was still
--      running against it.
--
--   2. If a consumer crashed after taking a reservation and before releasing
--      it, later deliveries of the same message either (a) hit the current
--      15-minute hardcoded reclaim window and had no atomic confirmation
--      they'd won the takeover, or (b) were silently ack'd as duplicates and
--      permanently lost.
--
-- We fix both by tracking:
--
--   attempt_owner_token   — random UUID minted per reservation attempt. Only
--                           the consumer holding this token may release the
--                           row via compare-and-set. The token is also cleared
--                           whenever the row is released back to "queued" so
--                           the next attempt starts clean.
--
--   lease_expires_at      — wall-clock deadline. While
--                           status='processing' AND lease_expires_at > now(),
--                           no other consumer may reclaim. After the lease
--                           expires, a later delivery may CAS the row from
--                           processing → processing (new owner) and take
--                           over.
--
-- Backwards compatibility: existing rows are left untouched. The columns are
-- nullable and the code path treats a NULL lease_expires_at as immediately
-- expired, so any reservation written by the old code is safely reclaimable.

alter table atlas_shadow_reservations
  add column if not exists attempt_owner_token text,
  add column if not exists lease_expires_at timestamptz;

comment on column atlas_shadow_reservations.attempt_owner_token is
  'Random per-attempt token. Only the consumer holding this token may release / mark the reservation completed. Cleared when the row is released back to queued so the next attempt starts clean.';

comment on column atlas_shadow_reservations.lease_expires_at is
  'Wall-clock deadline for the current processing lease. Consumers other than the token holder must treat a still-valid lease as "already processing" and delay-retry. Once the lease is past, another consumer may CAS to reclaim.';

-- Fast index for scanning expired-lease reservations (operational cleanup).
create index if not exists atlas_shadow_reservations_expired_lease_idx
  on atlas_shadow_reservations (lease_expires_at)
  where status = 'processing';
