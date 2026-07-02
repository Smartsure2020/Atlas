# Controlled Internal Pilot Readiness

## Assessment

Ready with conditions.

Atlas is ready for a controlled internal pilot with a small staff group, provided the pilot is framed as decision support and not as an automated underwriting authority. The core workflow has server-side role checks, audit records, durable review/decision snapshots, operational job visibility, and a working Windows build path.

## Pilot Scope

- New submission intake
- PDF upload and extraction
- Human extraction review/correction
- Recommendation run and review
- Quote review
- Missing-information workflow
- Saved communication drafts and manual lifecycle tracking
- Consultant decision capture
- Manager dashboard and operational status review

## Recommended Pilot Roles

- 1 admin for configuration and support
- 1-2 managers for extraction/guideline/appetite oversight
- 2-4 consultants for ordinary submission handling
- Optional readonly/auditor user for audit trail review

## Manual Tests Before Pilot

- Sign in as admin, manager, consultant, and readonly.
- Confirm readonly can view but cannot mutate workflow records.
- Create a submission, upload a PDF, run extraction, save corrections, run recommendation, run quote review, generate missing information, save/copy/mark sent communication, and record a decision.
- Re-run extraction/recommendation/quote review with unchanged inputs and confirm Atlas reports unchanged inputs.
- Force rerun recommendation and quote review.
- Confirm manager dashboard and operational status are manager/admin only.
- Confirm oversized and non-PDF uploads are rejected before storage upload.
- Apply migrations through `0013_phase7_jobs_assignment_ops.sql` in staging before production.

## Staff Communication

- Atlas is a decision-support tool only.
- It does not bind cover, accept risk, send broker emails automatically, or replace underwriting authority.
- Generated communications must be reviewed before sending.
- Assignment is visible ownership only; it does not restrict access during the pilot.
- Rerun warnings mean inputs appear unchanged, not that a human is blocked from rerunning.

## Do Not Rely On Yet

- Strict per-consultant access scoping
- Automatic malware scanning
- Automatic deletion of orphan storage objects
- A real background queue or retry worker
- Full production monitoring/alerting
- Direct email sending

## Rollback Plan

- Stop pilot use and remove the Worker route from staff navigation if severe issues appear.
- Preserve all audit, extraction, recommendation, quote review, decision, missing-info, and communication records.
- Do not delete data during rollback.
- Revert UI exposure first; database migrations are additive and can remain dormant.

## Production Checklist

- Configure `ATLAS_ENV=production`.
- Confirm Worker secrets are set only server-side.
- Apply all migrations in order.
- Confirm private storage buckets exist: `atlas-client-docs`, `atlas-insurer-docs`.
- Confirm allow-list roles use `admin`, `manager`, `consultant`, or `readonly`.
- Run Phase 1-7 tests and production build.
- Test Microsoft sign-in callback on the deployed URL.
- Review `/api/admin/system-status` as manager/admin.
- Agree retention and cleanup policy before wider rollout.
