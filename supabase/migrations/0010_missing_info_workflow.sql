-- Phase 4: missing-information workflow and consultant action visibility.
-- Additive only. Items can be generated from quote review findings or added
-- manually by a consultant.

create type atlas_missing_info_item_type as enum (
  'document',
  'quote_term',
  'underwriting_info',
  'referral_info',
  'other'
);

create type atlas_missing_info_status as enum (
  'open',
  'requested',
  'received',
  'waived',
  'not_required'
);

create type atlas_missing_info_source as enum (
  'extraction',
  'quote_review',
  'manual',
  'rule'
);

create type atlas_missing_info_owner as enum (
  'broker',
  'client',
  'consultant',
  'insurer',
  'senior_underwriter',
  'unknown'
);

create table atlas_missing_info_items (
  id uuid primary key default gen_random_uuid(),
  submission_id uuid not null references atlas_submissions(id) on delete cascade,
  quote_review_id uuid references atlas_quote_reviews(id) on delete set null,
  section_key text,
  item_type atlas_missing_info_item_type not null default 'other',
  title text not null,
  description text,
  status atlas_missing_info_status not null default 'open',
  required_by_rule_id uuid references atlas_insurer_appetite(id) on delete set null,
  source atlas_missing_info_source not null default 'manual',
  owner atlas_missing_info_owner not null default 'unknown',
  due_date date,
  notes text,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  resolved_at timestamptz
);

create index atlas_missing_info_submission_idx
  on atlas_missing_info_items (submission_id, status, created_at desc);

create index atlas_missing_info_quote_review_idx
  on atlas_missing_info_items (quote_review_id);

comment on table atlas_missing_info_items is
  'Actionable outstanding information items generated from extraction/quote review/rules or added manually by consultants.';

comment on column atlas_missing_info_items.status is
  'Open workflow status. waived and not_required require notes in app logic.';

create trigger atlas_missing_info_items_touch
  before update on atlas_missing_info_items
  for each row execute function atlas_touch_updated_at();
