-- ============================================================================
-- Atlas Blueprint — Phase 0, Migration 0003
-- Appetite matrix (configurable), recommendations, decisions, audit log
-- ============================================================================

-- ---------- Insurer appetite matrix (DATABASE-CONFIGURABLE) -----------------

-- The heart of the recommendation engine. One row per insurer × product line ×
-- risk type. NOTHING about appetite lives in application code — the matcher
-- reads these rows. Adding "CIB cautions on thatch roof" is an INSERT/UPDATE
-- here, never a redeploy.
--
-- Rows are typically PROPOSED by the AI from an uploaded guideline doc, then
-- CONFIRMED by an underwriter before they go live (is_active). source_document_id
-- points back to the guideline so a recommendation can cite its source clause.
create table atlas_insurer_appetite (
  id               uuid primary key default gen_random_uuid(),
  insurer_id       uuid not null references atlas_insurers(id) on delete cascade,
  -- Denormalised insurer name for cheap reads/display in the matcher output.
  insurer_name     text not null,
  product_line     text not null,      -- e.g. 'buildings', 'motor_fleet', 'sectional_title'
  risk_type        text not null,      -- e.g. 'body_corporate', 'commercial_building', 'transport'
  appetite_level   atlas_appetite_level not null,
  -- The edges that make appetite data actually useful. JSON arrays of conditions.
  preferred_risks   jsonb,             -- characteristics that strengthen the match
  caution_risks     jsonb,             -- characteristics that add conditions/lower confidence
  declined_risks    jsonb,             -- characteristics that hard-disqualify this insurer
  required_documents jsonb,            -- docs this insurer needs to quote
  referral_triggers jsonb,             -- thresholds that force referral/senior review (not disqualify)
  notes            text,
  -- Provenance + confirm-before-go-live workflow.
  source           atlas_appetite_source not null default 'manual',
  source_document_id uuid references atlas_insurer_documents(id) on delete set null,
  is_active        boolean not null default false,  -- false until an underwriter confirms
  confirmed_by     uuid,
  confirmed_at     timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index atlas_appetite_insurer_idx
  on atlas_insurer_appetite (insurer_id);
-- The matcher filters on active rows by what they cover.
create index atlas_appetite_match_idx
  on atlas_insurer_appetite (is_active, product_line, risk_type)
  where is_active = true;

comment on table atlas_insurer_appetite is
  'Database-configurable appetite matrix. The deterministic matcher reads these rows. No appetite in code.';
comment on column atlas_insurer_appetite.is_active is
  'Appetite rows go live only after an underwriter confirms the AI-proposed (or manual) record.';
comment on column atlas_insurer_appetite.declined_risks is
  'Characteristics that HARD-disqualify the insurer (matcher zeroes the score).';
comment on column atlas_insurer_appetite.referral_triggers is
  'Thresholds that FLAG for referral/senior review — they do not disqualify.';

-- ---------- Appetite change history -----------------------------------------

-- Appetite rules change over time. To defend a recommendation made months ago
-- we must know what the rules WERE then, not just what they are now. Every
-- insert/update/confirm to the appetite matrix is snapshotted here.
create table atlas_appetite_history (
  id           uuid primary key default gen_random_uuid(),
  appetite_id  uuid not null references atlas_insurer_appetite(id) on delete cascade,
  change_type  text not null,          -- 'created' | 'updated' | 'confirmed' | 'deactivated'
  snapshot_json jsonb not null,        -- full state of the appetite row at this change
  changed_by   uuid not null,
  created_at   timestamptz not null default now()
);

create index atlas_appetite_history_appetite_idx
  on atlas_appetite_history (appetite_id);

comment on table atlas_appetite_history is
  'Point-in-time snapshots of appetite rows so a past recommendation can be explained against the rules of its day.';

-- ---------- Recommendations (deterministic score + LLM reasoning) -----------

-- Output of the matcher. Scores are computed by deterministic code against the
-- appetite matrix; the LLM only WRITES the human-readable reasoning around the
-- numbers it was handed. It never produces the score.
create table atlas_recommendations (
  id                    uuid primary key default gen_random_uuid(),
  submission_id         uuid not null references atlas_submissions(id) on delete cascade,
  recommended_insurer   text,
  -- Ranked alternatives, insurers ruled out, and the per-insurer reasoning —
  -- each entry carries the matched/violated appetite rule ids so the score is
  -- fully inspectable and can cite its source guideline.
  secondary_options_json jsonb,
  not_recommended_json   jsonb,
  reasoning_json         jsonb,
  confidence_score      numeric(4,3),
  referral_required     boolean not null default false,
  senior_review_required boolean not null default false,
  -- Which extraction version the matcher actually ran against (reviewed vs raw),
  -- captured for audit. The recommendation is only as good as its input.
  extraction_id         uuid references atlas_extractions(id) on delete set null,
  created_at            timestamptz not null default now()
);

create index atlas_recommendations_submission_idx
  on atlas_recommendations (submission_id);

comment on table atlas_recommendations is
  'Deterministic match results with LLM-written reasoning. Scores come from code, not the model.';

-- ---------- Decisions (the human in the loop) -------------------------------

-- The underwriter's call. This — not the recommendation — is the authoritative
-- routing outcome. AI recommends; a human decides and is recorded as deciding.
create table atlas_decisions (
  id                       uuid primary key default gen_random_uuid(),
  submission_id            uuid not null references atlas_submissions(id) on delete cascade,
  selected_insurer         text,
  decision_status          atlas_decision_status not null,
  underwriter_notes        text,
  ai_recommendation_accepted boolean,
  -- Required (enforced in app logic) when the human overrides the AI: we always
  -- want a recorded reason for going against the recommendation.
  override_reason          text,
  decided_by               uuid not null,
  decided_at               timestamptz not null default now()
);

create index atlas_decisions_submission_idx
  on atlas_decisions (submission_id);

comment on table atlas_decisions is
  'The authoritative human decision. AI recommends; the underwriter decides and is recorded.';

-- ---------- Audit log (PERMANENT, append-only) ------------------------------

-- Every meaningful action lands here: submission created, document uploaded,
-- extraction run, field corrected, recommendation generated, accepted/overridden,
-- email draft generated, status changed, appetite confirmed/edited, file expired.
--
-- metadata_json holds IDs and field NAMES only — NEVER full document contents
-- or personal data. This table is append-only by policy (no update/delete RLS).
create table atlas_audit_logs (
  id            uuid primary key default gen_random_uuid(),
  submission_id uuid references atlas_submissions(id) on delete set null,
  action        text not null,
  actor         uuid,                  -- auth.users id; null only for system/cron actions
  metadata_json jsonb,                 -- IDs + field names only, no PII, no document bodies
  created_at    timestamptz not null default now()
);

create index atlas_audit_logs_submission_idx
  on atlas_audit_logs (submission_id);
create index atlas_audit_logs_created_idx
  on atlas_audit_logs (created_at);

comment on table atlas_audit_logs is
  'Permanent append-only audit trail. metadata_json carries IDs/field names only — never PII or document bodies.';
