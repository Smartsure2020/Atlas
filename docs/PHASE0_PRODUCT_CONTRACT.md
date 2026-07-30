# Atlas Phase 0: Product Contract and Pilot Guardrails

Status: proposed contract for team approval

This document locks the first pilot boundary before UI and workflow changes begin.
It is intentionally narrower than the long-term Atlas vision.

## 1. Proposed pilot scope

### Target workflow

South African broker-submitted new-business risks across personal and commercial lines.
The workflow is shared. The difference between personal and commercial business comes
from the risk taxonomy, insurer appetite, authority rules, required documents, and
underwriting guidelines attached to the risk.

The product must not grow separate personal and commercial screens or duplicate the
workflow engine. A personal motor risk and a commercial building risk should move through
the same product stages, with different guideline evidence and controls appearing where
they apply.

### Primary users

- Consultants: capture submissions, review extraction, run recommendations, review quotes,
  request information, prepare communications, and record ordinary decisions.
- Managers: manage insurer appetite, run extraction, approve exceptional overrides, monitor
  queues, and review operational failures.
- Readonly/auditor users: inspect submissions, decisions, evidence, and audit history.
- Admin users: configure access and operational settings.

### Core success path

```text
Broker intake
    -> document upload
    -> extraction
    -> human extraction review
    -> insurer appetite recommendation
    -> quote review
    -> missing information or referral, if required
    -> human decision
    -> communication draft
    -> audit trail
```

### Explicitly out of scope for the pilot

- Binding cover or issuing policy documents
- Automatic submission to Cardinal, insurer portals, or email
- Premium calculation or pricing authority
- Claims handling or claims settlement
- Renewals, endorsements, cancellations, and mid-term adjustments
- Product lines not yet represented in the controlled golden data set
- Strict per-consultant data isolation, unless required by the pilot risk assessment

Atlas must continue to describe itself as decision support. A recommendation, quote review,
or generated communication must never imply that cover has been accepted.

## 2. Product promises

For the pilot, Atlas promises to:

1. Preserve the original extracted result and the human-reviewed result separately.
2. Block recommendations and quote reviews until extraction review is complete.
3. Show which appetite rules and source evidence influenced a recommendation.
4. Require a reason for overrides, referrals, declined outcomes, and waived information.
5. Keep durable decisions, review snapshots, communications, and audit events.
6. Make failed or stuck expensive work visible to a manager.
7. Make uncertainty visible. Confidence is not underwriting authority or certainty.

Atlas does not promise to make the underwriting decision automatically.

## 3. Pilot success measures

Capture a baseline during the first pilot week, then review these measures weekly.

| Measure | Pilot target | Guardrail |
|---|---:|---|
| Submissions with a complete audit path | >= 95% | No silent decision path failures |
| Recommendations run on reviewed extraction | 100% | Zero unreviewed recommendation runs |
| Overrides with an actor and reason | 100% | Manager approval where the insurer was ruled out |
| Quote reviews with visible evidence or an explicit data gap | >= 95% | No unsupported “pass” outcome |
| Failed/stuck jobs visible to a manager | 100% | Retry or escalation path exists |
| Required-information requests linked to a case | >= 95% | No loose spreadsheet-only tracking |
| Intake-to-first-underwriting-action time | Baseline first week | Target 25% improvement by pilot end |
| Consultant confidence in next action | Baseline and weekly pulse | Target >= 4/5 by pilot end |

The first five measures are release guardrails. If any fail, improve the control before
expanding the pilot.

## 4. Golden submission set

The pilot must be tested against the ten cases in
`tests/fixtures/phase0-golden-submissions.ts`.

The set covers both personal and commercial risks, with the same workflow controls applied
to each line. It currently contains thirteen scenarios so both line types and their
shared exception paths are represented.

The set covers:

- Clean personal risk
- Clean commercial-building risk
- Missing claims history
- Missing proposal or schedule information
- Sum insured above an appetite threshold
- Explicitly declined construction or exposure characteristic
- Ambiguous product or risk classification
- Low-confidence or conflicting extraction
- Missing warranty or endorsement
- Quote rate outside an expected band
- Multi-section quote with a business-exposure gap

Each fixture defines the expected control outcome, not a hard-coded insurer answer. Appetite
data is configuration and may differ between environments. Future matcher and quote-review
tests should consume these fixtures with an explicit appetite matrix.

## 5. Pilot guardrails

- Managers approve the pilot appetite matrix before staff use it.
- Generated broker and senior-underwriter communications are reviewed and sent manually.
- No production rollout until private storage, retention, upload scanning, and monitoring are
  confirmed for the selected environment.
- Every pilot incident gets a severity, owner, reproduction steps, and resolution status.
- A failed extraction, recommendation, or quote review must not silently leave a submission
  looking complete.
- The team preserves audit and decision records during rollback.

## 6. Phase 0 exit checklist

- [ ] Product owner confirms the personal and commercial pilot scope.
- [ ] Underwriting manager confirms the thirteen golden scenarios and expected control outcomes.
- [ ] Operations owner confirms the pilot roles and escalation path.
- [ ] Security owner confirms the private-storage and retention assumptions.
- [ ] Baseline measurement method is agreed.
- [ ] Phase 1 can begin without changing decision authority or appetite semantics.

## 7. Phase 1 dependency

Phase 1 should build the queue and application shell around these fields:

- Client and broker identity
- Product and risk type
- Submission status
- Queue status
- Assignee
- Created date and age
- Last activity
- Missing-information count
- Manual-review or referral flag
- Next action

Those fields should be returned by the server-side queue query, not reconstructed only in
the browser.

The queue and submission workspace must treat `line_of_business` as data displayed and
filtered by the user, not as a reason to render separate workflows.
