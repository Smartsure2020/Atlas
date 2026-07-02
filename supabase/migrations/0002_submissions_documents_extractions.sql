-- ============================================================================
-- Atlas Blueprint — Phase 0, Migration 0002
-- Submission flow: submissions, (transient) documents, extractions
-- ============================================================================

-- ---------- Submissions -----------------------------------------------------

create table atlas_submissions (
  id                   uuid primary key default gen_random_uuid(),
  broker_name          text,
  broker_email         text,
  client_name          text,
  -- Free text describing what the quote request is for (buildings, motor,
  -- sectional title, fleet, ...). The AI also classifies risk separately; this
  -- is the human's initial framing at intake.
  request_type         text,
  status               atlas_submission_status not null default 'new',
  -- Raw broker email pasted at intake, kept for extraction + reference. This is
  -- text the broker sent us, not a stored file, so it is not subject to the
  -- file-expiry cron — but it IS personal data, so it is RLS-protected like
  -- everything else and never written to logs.
  broker_email_body    text,
  assigned_underwriter uuid,           -- auth.users id
  created_by           uuid not null,  -- auth.users id
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

create index atlas_submissions_status_idx
  on atlas_submissions (status);
create index atlas_submissions_assigned_idx
  on atlas_submissions (assigned_underwriter);

comment on table atlas_submissions is
  'A single underwriting intake. Moves across dashboard statuses; never auto-decided.';

-- ---------- Documents (TRANSIENT client working material) -------------------

-- Client submission files: broker email attachments, policy schedules, proposal
-- forms, claims histories, vehicle/building schedules, supporting docs.
--
-- These are TRANSIENT. The system of record for the actual documents is
-- Cardinal / the insurer portals — Atlas only needs them long enough to extract
-- and have a human review. A daily cron deletes the underlying file after the
-- retention window; the row stays (status -> 'expired') so the audit history
-- still shows a document was attached.
create table atlas_documents (
  id            uuid primary key default gen_random_uuid(),
  submission_id uuid not null references atlas_submissions(id) on delete cascade,
  file_name     text not null,
  storage_path  text not null,         -- path in the private client-docs bucket
  document_type text,                  -- 'broker_email' | 'policy_schedule' | 'proposal_form' | 'claims_history' | 'vehicle_schedule' | 'building_schedule' | 'supporting'
  status        atlas_document_status not null default 'active',
  uploaded_by   uuid not null,         -- auth.users id
  -- When the file becomes eligible for deletion. Defaults to created_at + the
  -- configured retention window; set explicitly by the app so the window is
  -- configurable (we are NOT hard-coding 48h / 7d into the schema).
  expires_at    timestamptz,
  -- Stamped by the cron when the underlying file is actually deleted.
  expired_at    timestamptz,
  created_at    timestamptz not null default now()
);

create index atlas_documents_submission_idx
  on atlas_documents (submission_id);
-- Lets the retention cron cheaply find active files past their expiry.
create index atlas_documents_expiry_idx
  on atlas_documents (status, expires_at)
  where status = 'active';

comment on table atlas_documents is
  'Transient client documents. File auto-expires after a configurable window; row persists as audit history.';
comment on column atlas_documents.expires_at is
  'When the underlying file may be deleted. App-set so the retention window stays configurable.';

-- ---------- Extractions (PERMANENT structured risk summary) -----------------

-- The structured risk summary. extracted_json is what the AI originally found;
-- reviewed_json is what the underwriter corrected/approved and becomes the
-- record everything downstream uses. Both PERSIST permanently even after the
-- source file expires — losing the file must never mean losing the summary.
create table atlas_extractions (
  id                    uuid primary key default gen_random_uuid(),
  submission_id         uuid not null references atlas_submissions(id) on delete cascade,
  -- Raw AI output. Never overwritten by review — kept for audit/defensibility.
  extracted_json        jsonb not null,
  -- Underwriter-corrected/approved version. Null until a human touches it.
  -- Downstream (the matcher) uses reviewed_json when present, else extracted_json.
  reviewed_json         jsonb,
  -- Per-extraction overall confidence (0..1). Per-field confidence lives inside
  -- the JSON so low-confidence fields can be flagged individually in the UI.
  extraction_confidence numeric(4,3),
  -- Convenience mirrors of structures the UI reads constantly. Sourced from the
  -- extraction JSON; duplicated out for cheap querying/filtering.
  missing_fields_json   jsonb,
  red_flags_json        jsonb,
  -- Stamped when an underwriter first saves a reviewed version.
  reviewed_by           uuid,
  reviewed_at           timestamptz,
  created_at            timestamptz not null default now()
);

create index atlas_extractions_submission_idx
  on atlas_extractions (submission_id);

comment on table atlas_extractions is
  'Structured risk summary. extracted_json = AI original; reviewed_json = human-approved record. Both permanent.';
comment on column atlas_extractions.reviewed_json is
  'Underwriter-corrected version. When present, this is the authoritative input to the matcher.';
