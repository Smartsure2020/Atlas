# Atlas Phase 6 Production Readiness Notes

## Intended Roles

- `admin`: full operational and configuration access.
- `manager`: operational management access, including extraction, manager reporting, insurer/guideline/appetite management, and ruled-out override approval.
- `consultant`: day-to-day submission workflow access, including create/upload, extraction review, recommendations, quote reviews, missing-info workflow, communications, and decisions within normal guardrails.
- `underwriter`: legacy claim accepted as consultant-level access for backward compatibility.
- `readonly` / `auditor`: read-only inspection access. The Worker blocks workflow writes and RLS blocks direct write access.

## Worker And RLS Interaction

The Worker uses the Supabase service-role key and is the primary privileged API boundary. Because service-role bypasses RLS, every sensitive Worker route must enforce permissions before data changes. RLS remains enabled as defense in depth for direct Supabase Data API access and local tooling.

Phase 6 migration `0012_phase6_security_hardening.sql` replaces broad staff-all policies with role-aware select/write/manage policies and adds RLS coverage for quote reviews, quote review sections, missing-info items, and communications.

## Storage

Client and insurer document buckets are expected to be private. Signed upload URLs are minted only by the Worker after role, file type, file size, and path-scope checks. Downloads should continue to flow through authorised Worker endpoints or service-role operations, never public bucket URLs.

Malware scanning is out of scope for Phase 6. Add scanning before broader external rollout.

## Expensive Workflow Candidates

These operations should become async jobs before higher-volume use:

- PDF extraction
- insurer guideline ingestion
- recommendation reasoning
- quote review generation
- future comparison/report generation

Phase 6 adds guards that reduce accidental reruns but does not introduce a full queue. A future job table should store operation type, input fingerprint, status, actor, started/completed timestamps, failure code, and result record id.

## Retention

No automatic deletion was added in Phase 6. Uploaded document files remain governed by the existing configurable retention window. Structured extractions, quote reviews, decisions, communications, and audit logs should remain available for underwriting audit unless a formal retention policy says otherwise.

Recommended cleanup work:

- expire orphaned signed uploads that were never confirmed
- mark expired file rows without deleting audit rows
- retain old quote reviews and decisions permanently or under an approved legal retention schedule
- archive communications instead of deleting them
