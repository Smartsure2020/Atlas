-- ============================================================================
-- Atlas Blueprint — Phase 2A, Migration 0006
-- Insurer-document processing status + proposed-row count
-- ----------------------------------------------------------------------------
-- Additive only — no changes to existing columns, no data migration needed.
--
-- Phase 0 modelled atlas_insurer_documents.processed_at as a timestamp that's
-- null until the AI has read the document. That works, but it cannot
-- distinguish "uploaded, never processed yet" from "processing failed mid-way".
-- Phase 2A's UX wants the retry-from-upload path: if the file is stored but the
-- Claude call failed (rate limit, parse error), we want the user to be able to
-- click "retry processing" rather than re-upload.
--
-- So we add an explicit processing_status. processed_at stays as-is (it's the
-- timestamp of the LAST successful processing run); the new column carries the
-- workflow state.
-- ============================================================================

create type atlas_insurer_doc_status as enum (
  'awaiting_processing',  -- uploaded; ingestion not yet attempted
  'processing',           -- ingestion in flight (defensive; sync flow is short)
  'processed',            -- ingestion succeeded; proposed rows created
  'failed'                -- ingestion attempted but failed; user can retry
);

alter table atlas_insurer_documents
  add column processing_status atlas_insurer_doc_status
    not null default 'awaiting_processing';

-- How many appetite rows the AI proposed from this document, set on success.
-- Lets the Insurers screen show "12 rules proposed" at a glance.
alter table atlas_insurer_documents
  add column proposed_count integer not null default 0;

-- Short error note when processing_status = 'failed'. Not a stack trace —
-- a one-line cause the user can see ("rate limited", "PDF unreadable").
alter table atlas_insurer_documents
  add column processing_error text;

comment on column atlas_insurer_documents.processing_status is
  'Workflow state distinct from processed_at: awaiting/processing/processed/failed. Enables retry-from-upload.';
comment on column atlas_insurer_documents.proposed_count is
  'Number of appetite rows the AI proposed from this document; set on successful ingestion.';
