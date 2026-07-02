# Atlas Phase 8 Operations Notes

Phase 8 adds recovery and monitoring foundations for controlled internal use.
It does not introduce a full background worker fleet yet.

## Async Job Groundwork

- Expensive workflows should continue to create `atlas_jobs` records before work starts.
- Phase 8 adds retry metadata, cancellation request fields, and alert hooks to `atlas_jobs`.
- A future worker loop can safely pick jobs where `status = 'queued'` or where a failed job has `next_retry_at <= now()`.
- Running jobs should periodically check `cancellation_requested` before expensive provider calls and before writing final outputs.

## Retry Policy

- Transient infrastructure/provider failures can be retried.
- Validation, permission, missing-input, and unchanged-input failures are intentionally not retryable.
- Manual retry is manager/admin only and increments `retry_count`.
- Automatic retry execution is intentionally deferred until Atlas has a dedicated queue/worker runner.

## Cancellation

- Queued, failed, or skipped jobs can move directly to `cancelled`.
- Running jobs are marked with `cancellation_requested`; the active worker must observe that flag.
- Cancellation does not delete historical outputs or audit records.

## File Fingerprints

- Browser uploads send a SHA-256 `file_hash` when Web Crypto is available.
- Client documents and insurer guideline documents store file hash, size, and content type.
- Extraction fingerprints use `file_hash` when present and fall back to legacy storage-path metadata for older rows.

## Cleanup Controls

- Cleanup preview records candidates in `atlas_cleanup_candidates`.
- Managers/admins can approve or dismiss cleanup candidates.
- Phase 8 does not automatically delete storage objects. Deletion should be implemented as a separate audited cleanup worker after a retention policy is approved.

## Operational Alerts

- Failed jobs create `atlas_operational_alerts` rows where the migration is present.
- Alerts are manager/admin visible and can be acknowledged or resolved.
- Alert payloads should contain safe operational context only: job id, submission id, document id, safe error code, retryability, and timestamps.

## Canary Checks

- The canary endpoint checks database reachability, job table readability, storage bucket configuration, and AI provider configuration presence.
- Canary responses must not include secrets, raw documents, extracted contents, or PII.

## Pilot Support

- `atlas_submissions.pilot_flag` and `pilot_notes` are available for controlled internal pilots.
- Pilot filtering/UI is not yet exposed. Prefer a manager-only pilot queue in the next UI increment.

## Retention

- Do not automatically delete uploaded documents, quote reviews, decisions, communications, or audit logs.
- Old quote reviews and consultant decisions are part of the underwriting record and should remain available.
- Recommended follow-up: define retention classes for failed uploads, orphaned storage objects, active submission documents, communications, and audit logs before enabling destructive cleanup.
