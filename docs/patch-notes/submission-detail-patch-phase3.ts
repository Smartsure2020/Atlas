/**
 * Atlas Blueprint — SubmissionDetail patch for Phase 3
 * ----------------------------------------------------------------------------
 * Documentation only. Drops three new panels into the existing extraction-
 * present branch of SubmissionDetail.tsx, beneath the RecommendationPanel.
 * ============================================================================
 */

// ----- 1. ADD these imports alongside the existing page imports -----

// import DecisionPanel from "./DecisionPanel";
// import EmailDraftsPanel from "./EmailDraftsPanel";
// import AuditTimeline from "./AuditTimeline";


// ----- 2. (Optional but recommended) ADD a decisionVersion counter near the
//          existing reviewVersion, so the email panel can refresh stale
//          drafts when a decision is recorded. In SubmissionDetail's state:
//
//   const [decisionVersion, setDecisionVersion] = useState(0);
//
// In the future, you can wire setDecisionVersion to bump after any decision
// save. For now it's fine to leave at 0 — drafts stay until regenerated.


// ----- 3. ADD these renders directly AFTER the existing RecommendationPanel
//          line, INSIDE the {extraction ? (...) : ...} branch: -----

/*

<DecisionPanel
  submissionId={submissionId}
  role={role}
  reviewVersion={reviewVersion}
/>

<EmailDraftsPanel
  submissionId={submissionId}
  decisionVersion={decisionVersion}
/>

<AuditTimeline
  submissionId={submissionId}
  refreshVersion={reviewVersion}
/>

*/

// ============================================================================
// That's it. The three panels handle their own data loading, error states,
// and Worker calls.
// ============================================================================

export {}; // documentation file
