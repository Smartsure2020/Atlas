/**
 * Atlas Blueprint — router patch for Phase 2B
 * ----------------------------------------------------------------------------
 * Documentation only. Add to worker/src/index.ts.
 * ============================================================================
 */

// ----- 1. ADD this import, alongside the existing handler imports -----

// import {
//   handleRunRecommendation,
//   handleGetRecommendation,
// } from "./recommendation-endpoints";


// ----- 2. EXTEND the existing /api/submissions/:id/... regex block to handle
//          /recommend (POST) and /recommendation (GET).
//
// The existing block (added in Phase 1) currently looks like:
//
//   const m = pathname.match(/^\/api\/submissions\/([0-9a-fA-F-]{36})(\/[a-z]+)?$/);
//   if (m) {
//     const id = m[1];
//     const sub = m[2];
//     if (!sub && request.method === "GET")   { ...handleGetSubmission... }
//     if (sub === "/extract" && request.method === "POST") { ...handleExtract... }
//     if (sub === "/review"  && request.method === "POST") { ...handleReview...  }
//   }
//
// Add these two more sub-route handlers inside that same if(m) block, AFTER
// the /review handler:

/*

if (sub === "/recommend" && request.method === "POST") {
  return handleRunRecommendation(id, env, user);
}
if (sub === "/recommendation" && request.method === "GET") {
  return handleGetRecommendation(id, env, user);
}

*/

export {}; // documentation file
