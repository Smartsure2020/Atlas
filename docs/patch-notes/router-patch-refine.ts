/**
 * Atlas Blueprint — router patch for the refinement
 * ----------------------------------------------------------------------------
 * Documentation only. One import + one sub-route to add to worker/src/index.ts.
 * ============================================================================
 */

// ----- 1. ADD this import, alongside the existing handler imports -----

// import { handleAddAppetiteRule } from "./manual-appetite";


// ----- 2. EXTEND the existing /api/insurers/:id... regex block.
//
// The existing block (from Phase 2A) currently handles:
//   - /api/insurers/:id                   GET  → handleGetInsurer
//   - /api/insurers/:id/documents/sign    POST → handleSignInsurerDoc
//
// Update the regex to also recognise /appetite, and add the route handler.
// The exact change:
//
//   - Find:    /^\/api\/insurers\/([0-9a-fA-F-]{36})(\/documents\/sign)?$/
//   - Replace: /^\/api\/insurers\/([0-9a-fA-F-]{36})(\/documents\/sign|\/appetite)?$/
//
// Then inside the matching if-block, add the appetite branch:

/*

if (sub === "/appetite" && request.method === "POST") {
  return handleAddAppetiteRule(insurerId, request, env, user);
}

*/

export {}; // documentation file
