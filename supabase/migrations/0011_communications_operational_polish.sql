-- Phase 5: saved communication records and operational tracking.
-- Additive only. Atlas still does not send email automatically; this records
-- generated/copyable consultant communications and their manual lifecycle.

create type atlas_communication_type as enum (
  'missing_info_request',
  'referral_pack',
  'review_summary',
  'broker_note',
  'internal_note',
  'other'
);

create type atlas_communication_audience as enum (
  'broker',
  'client',
  'insurer',
  'senior_underwriter',
  'internal',
  'unknown'
);

create type atlas_communication_status as enum (
  'draft',
  'copied',
  'sent_manually',
  'archived'
);

create table atlas_communications (
  id uuid primary key default gen_random_uuid(),
  submission_id uuid not null references atlas_submissions(id) on delete cascade,
  quote_review_id uuid references atlas_quote_reviews(id) on delete set null,
  communication_type atlas_communication_type not null,
  audience atlas_communication_audience not null default 'unknown',
  subject text,
  body text not null,
  status atlas_communication_status not null default 'draft',
  related_missing_info_item_ids jsonb,
  related_section_keys jsonb,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  sent_at timestamptz,
  notes text
);

create index atlas_communications_submission_idx
  on atlas_communications (submission_id, created_at desc);

create index atlas_communications_quote_review_idx
  on atlas_communications (quote_review_id);

create index atlas_communications_status_idx
  on atlas_communications (status, created_at desc);

comment on table atlas_communications is
  'Saved generated communication drafts and manual lifecycle tracking. Atlas does not send messages automatically.';

comment on column atlas_communications.status is
  'draft/copied/sent_manually/archived lifecycle for manually handled communications.';

create trigger atlas_communications_touch
  before update on atlas_communications
  for each row execute function atlas_touch_updated_at();
