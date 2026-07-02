-- ============================================================================
-- Atlas Blueprint — Phase 0, Migration 0005
-- updated_at maintenance triggers
-- ----------------------------------------------------------------------------
-- Keep updated_at honest at the database level so it cannot drift if an app
-- write forgets to set it.
-- ============================================================================

create or replace function atlas_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger atlas_insurers_touch
  before update on atlas_insurers
  for each row execute function atlas_touch_updated_at();

create trigger atlas_submissions_touch
  before update on atlas_submissions
  for each row execute function atlas_touch_updated_at();

create trigger atlas_appetite_touch
  before update on atlas_insurer_appetite
  for each row execute function atlas_touch_updated_at();
