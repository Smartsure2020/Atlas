-- Phase 3: Quote review and decision workflow.
-- Additive only. Quote terms are stored in the review snapshot for this first
-- implementation; section rows hold the durable review outputs.

create type atlas_quote_review_status as enum (
  'draft',
  'review_required',
  'can_proceed',
  'refer',
  'declined',
  'info_required',
  'overridden'
);

create type atlas_quote_review_section_status as enum (
  'ok',
  'caution',
  'refer',
  'declined',
  'info_required',
  'insufficient_rule_match'
);

create table atlas_quote_reviews (
  id uuid primary key default gen_random_uuid(),
  submission_id uuid not null references atlas_submissions(id) on delete cascade,
  recommendation_id uuid references atlas_recommendations(id) on delete set null,
  insurer_id uuid references atlas_insurers(id) on delete set null,
  status atlas_quote_review_status not null default 'draft',
  overall_outcome text not null,
  overall_confidence numeric(4,3) not null default 0,
  manual_review_required boolean not null default false,
  created_by uuid,
  reviewed_by uuid,
  review_snapshot jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index atlas_quote_reviews_submission_idx
  on atlas_quote_reviews (submission_id, created_at desc);

create index atlas_quote_reviews_recommendation_idx
  on atlas_quote_reviews (recommendation_id);

create table atlas_quote_review_sections (
  id uuid primary key default gen_random_uuid(),
  quote_review_id uuid not null references atlas_quote_reviews(id) on delete cascade,
  section_key text not null,
  section_name text not null,
  matched_rule_id uuid references atlas_insurer_appetite(id) on delete set null,
  status atlas_quote_review_section_status not null,
  confidence numeric(4,3) not null default 0,
  findings jsonb not null default '[]'::jsonb,
  missing_documents jsonb not null default '[]'::jsonb,
  referral_triggers jsonb not null default '[]'::jsonb,
  declined_reasons jsonb not null default '[]'::jsonb,
  rating_findings jsonb not null default '[]'::jsonb,
  excess_findings jsonb not null default '[]'::jsonb,
  warranty_findings jsonb not null default '[]'::jsonb,
  source_evidence jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index atlas_quote_review_sections_review_idx
  on atlas_quote_review_sections (quote_review_id);

alter table atlas_decisions
  add column quote_review_id uuid references atlas_quote_reviews(id) on delete set null,
  add column decision_choice text,
  add column decision_reason text,
  add column decision_snapshot jsonb;

comment on table atlas_quote_reviews is
  'Durable quote/schedule review created from reviewed extraction, recommendation output, and matched appetite rules.';

comment on table atlas_quote_review_sections is
  'Section-by-section quote review results, including missing documents, referral triggers, declined reasons, and rating/excess/warranty findings.';

comment on column atlas_quote_reviews.review_snapshot is
  'Point-in-time snapshot of reviewed extraction, quote terms, recommendation, and review result.';

comment on column atlas_decisions.quote_review_id is
  'Quote review this consultant decision was made against, when available.';

comment on column atlas_decisions.decision_snapshot is
  'Point-in-time snapshot of quote review and recommendation at the time of the consultant decision.';

create trigger atlas_quote_reviews_touch
  before update on atlas_quote_reviews
  for each row execute function atlas_touch_updated_at();
