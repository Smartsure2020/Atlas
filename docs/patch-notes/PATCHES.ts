/**
 * Atlas Blueprint — small Worker patches (max_tokens + insurer-edit route)
 * ----------------------------------------------------------------------------
 * Two surgical changes documented here:
 *
 *  A. Bump max_tokens on the appetite-ingestion call so larger guidelines
 *     don't get cut off mid-JSON ("parse_failed").
 *  B. Wire the new PATCH /api/insurers/:id route.
 * ============================================================================
 */

// ===========================================================================
// PATCH A — worker/src/insurer-endpoints.ts
// ---------------------------------------------------------------------------
// Find the Anthropic call inside `handleProcessInsurerDoc`. The body includes:
//
//     body: JSON.stringify({
//       model: APPETITE_MODEL,
//       max_tokens: 8192,        ← CHANGE THIS LINE
//       system: APPETITE_SYSTEM_PROMPT,
//       ...
//     }),
//
// Change `max_tokens: 8192` to `max_tokens: 16000`. That's the only change.
//
// Why: Claude's response on a meaty guideline (20+ proposed rules with full
// preferred/caution/declined/required/referral lists each) can run past 8192
// tokens. When it does, the response is truncated mid-JSON, the validator
// rejects it, and we get parse_failed. 16000 is roughly Claude's effective
// output ceiling on this model and clears the issue.
// ===========================================================================


// ===========================================================================
// PATCH B — worker/src/index.ts (add the rename/edit route)
// ---------------------------------------------------------------------------
//
// 1. ADD this import alongside the existing handler imports:

// import { handleEditInsurer } from "./insurer-edit";


// 2. EXTEND the existing /api/insurers/:id regex block (the one that already
//    handles /documents/sign and /appetite from the refinement) to also handle
//    the bare /:id with the PATCH method.
//
//    The regex itself does not need to change — bare /:id is already matched
//    by the existing pattern. Just add this branch alongside the existing GET:

/*

if (!sub && request.method === "PATCH") {
  return handleEditInsurer(insurerId, request, env, user);
}

*/

export {}; // documentation file
