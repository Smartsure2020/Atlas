# Atlas Blueprint — Phase 0 schema

Decision-support tooling for the underwriting team. **Atlas recommends and explains; a human decides and acts.** Nothing in this schema calculates premiums, applies discounts, issues quotes, or binds cover.

## How to apply

Run the migrations in order against the dedicated Atlas Supabase project:

```
0001_enums_and_insurers.sql
0002_submissions_documents_extractions.sql
0003_appetite_recommendations_decisions_audit.sql
0004_rls_policies.sql
0005_updated_at_triggers.sql
```

Either `supabase db push` with these in `supabase/migrations`, or apply them in sequence via the SQL editor for the first cut. They are written to be reproducible, not hand-tweaked in the dashboard.

## The decisions this schema encodes

**Standalone, own project.** Atlas lives in its own Supabase project for blast-radius isolation — its RLS, storage, and auth can't tangle with Scout or anything else.

**Documents are transient; extractions are permanent.** The system of record for client documents is Cardinal / the insurer portals. Atlas only needs a file long enough to extract it and have a human review. `atlas_documents.expires_at` (app-set, configurable window — default intent 7 days) marks when the file may be deleted; a daily cron deletes the file, sets `status = 'expired'` and `expired_at`, and leaves the row as audit history. `atlas_extractions` persists forever — losing the file never means losing the risk summary.

**Raw vs. reviewed extraction.** `extracted_json` is what the AI originally found and is never overwritten. `reviewed_json` is what the underwriter corrected/approved; when present it is the authoritative input to the matcher. This is the human-in-the-loop rule made concrete and keeps the AI's original output for audit.

**Appetite lives in data, not code.** `atlas_insurer_appetite` is the configurable matrix the deterministic matcher reads. Guidelines change → edit rows, no redeploy. Rows are typically AI-proposed from an uploaded guideline doc (`source = 'ai_extracted'`, `source_document_id` set) then confirmed by an underwriter (`is_active` flips true). `atlas_appetite_history` snapshots every change so a recommendation made months ago can be explained against the rules of its day.

**Deterministic score, LLM explanation.** `atlas_recommendations` stores scores computed by code against the matrix, plus LLM-written reasoning that references the matched/violated appetite rules. The model explains the maths; it never produces the score. `extraction_id` records which extraction version the matcher ran against.

**The human decision is authoritative.** `atlas_decisions` — not the recommendation — is the routing outcome. `override_reason` is captured whenever the human goes against the AI (enforced in app logic).

**Audit is structural and append-only.** Every privileged action routes through the Worker, so `atlas_audit_logs` is written by construction, not by a developer remembering to. `metadata_json` holds IDs and field names only — never document bodies or PII. RLS gives the log insert + select but no update/delete, so history can't be quietly rewritten.

## Security

RLS is on for every table, default-deny, gated on an `atlas_role` JWT claim of `underwriter` or `admin` (`atlas_is_staff()`). The role is provisioned at the auth layer in the scaffold step (custom claim from an allow-list / Azure group); the schema trusts and checks that claim. The Worker uses the service role for server-side work and is the only path to Claude, storage, and recommendation logic. Client documents live in a private bucket reached only via short-lived signed URLs (configured in the scaffold step).

## Tables at a glance

| Table | Persists? | Purpose |
|---|---|---|
| `atlas_insurers` | yes | Insurer/facility reference list |
| `atlas_insurer_documents` | yes | Uploaded guideline/wording docs (reference data) |
| `atlas_submissions` | yes | One underwriting intake |
| `atlas_documents` | row yes, file no | Transient client files; file auto-expires |
| `atlas_extractions` | yes | Risk summary: `extracted_json` (AI) + `reviewed_json` (human) |
| `atlas_insurer_appetite` | yes | Configurable appetite matrix (matcher reads this) |
| `atlas_appetite_history` | yes | Point-in-time appetite snapshots |
| `atlas_recommendations` | yes | Deterministic scores + LLM reasoning |
| `atlas_decisions` | yes | The authoritative human decision |
| `atlas_audit_logs` | yes | Permanent, append-only audit trail |

## Not in this schema (by design, MVP exclusions)

No premium/rating fields, no discount logic, no quote/bind state, no Cardinal or insurer-portal integration, no automatic email send. These are parked future phases, deliberately absent so there's nothing to drift into.
