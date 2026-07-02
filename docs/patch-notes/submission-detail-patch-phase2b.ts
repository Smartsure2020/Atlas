/**
 * Atlas Blueprint — SubmissionDetail patch for Phase 2B
 * ----------------------------------------------------------------------------
 * Documentation only. Three small additions to src/pages/SubmissionDetail.tsx.
 *
 * The RecommendationPanel is a self-contained section that handles its own
 * load/run/state — SubmissionDetail just needs to render it once and tell it
 * whether the extraction has been reviewed.
 * ============================================================================
 */

// ----- 1. ADD this import near the existing page imports -----

// import RecommendationPanel from "./RecommendationPanel";


// ----- 2. (Optional) ADD a tiny review-version counter, so the panel reloads
//          when the user saves a correction. The simplest version: a state int
//          you bump inside the existing onSaveReview() success path.
//
// At the top of SubmissionDetail, alongside the existing useState hooks:
//
//   const [reviewVersion, setReviewVersion] = useState(0);
//
// In onSaveReview(), after the existing `await load();`, add:
//
//   setReviewVersion((v) => v + 1);
//
// (If you don't add this, the panel will only refresh when the page reloads;
// users will be confused about why a re-run isn't enabled after they save a
// correction. So this small step is recommended.)


// ----- 3. ADD this render line at the BOTTOM of the existing extraction-
//          rendered branch, AFTER the "Red flags" card.
//
//   It must sit inside the `{extraction ? (...) : ...}` block so it only
//   appears once an extraction has happened.

/*

<RecommendationPanel
  submissionId={submissionId}
  extractionExists={!!extraction}
  extractionReviewed={!!extraction?.reviewed_json}
  reviewVersion={reviewVersion}
/>

*/

export {}; // documentation file
