-- Phase 2 reliability: keep appetite recommendations defensible.
-- Additive only; existing appetite rows remain valid and are simply treated as
-- lower-evidence rows until a manager updates or re-ingests guideline material.

alter table public.atlas_insurer_appetite
  add column if not exists line_of_business text,
  add column if not exists rating_notes text,
  add column if not exists source_quote text,
  add column if not exists source_page integer,
  add column if not exists source_section text,
  add column if not exists source_file_name text,
  add column if not exists ingestion_confidence numeric(4,3);

alter table public.atlas_insurer_appetite
  add constraint atlas_insurer_appetite_line_of_business_check
  check (
    line_of_business is null
    or line_of_business in ('personal', 'commercial', 'both')
  ) not valid;

alter table public.atlas_insurer_appetite
  add constraint atlas_insurer_appetite_ingestion_confidence_check
  check (
    ingestion_confidence is null
    or (ingestion_confidence >= 0 and ingestion_confidence <= 1)
  ) not valid;

comment on column public.atlas_insurer_appetite.line_of_business is
  'AI/manual classification of whether the appetite rule applies to personal, commercial, or both lines.';

comment on column public.atlas_insurer_appetite.rating_notes is
  'Rating or underwriting nuance extracted from the guideline that should not drive hard matching by itself.';

comment on column public.atlas_insurer_appetite.source_quote is
  'Short supporting quote from the guideline or manager entry for defensibility.';

comment on column public.atlas_insurer_appetite.source_page is
  'Page number in the source document where the supporting rule was found, when known.';

comment on column public.atlas_insurer_appetite.source_section is
  'Guideline heading or section where the supporting rule was found, when known.';

comment on column public.atlas_insurer_appetite.source_file_name is
  'Original guideline filename for the supporting rule, when known.';

comment on column public.atlas_insurer_appetite.ingestion_confidence is
  '0..1 confidence assigned by the ingestion engine for this proposed rule.';
