/**
 * Atlas Blueprint — router patch for Phase 2A
 * ----------------------------------------------------------------------------
 * This file documents the EXACT additions to worker/src/index.ts to wire the
 * Phase 2A endpoints. It's not imported anywhere — it's a guide so you can do
 * the merge by hand without touching anything else.
 *
 * Two additions only:
 *   1. New import line at the top.
 *   2. A new route block to add inside the existing `fetch` handler, BEFORE
 *      the final `return json({ error: "not_found" }, 404);` line.
 *
 * Nothing in the existing router needs to change.
 * ============================================================================
 */

// ----- 1. ADD this import, alongside the existing handler imports -----

// import {
//   handleListInsurers,
//   handleCreateInsurer,
//   handleGetInsurer,
//   handleSignInsurerDoc,
//   handleProcessInsurerDoc,
//   handleEditAppetite,
//   handleConfirmAppetite,
//   handleDeactivateAppetite,
// } from "./insurer-endpoints";


// ----- 2. ADD this block inside `fetch`, after the existing /api/submissions
//          routes and BEFORE the final `return json({ error: "not_found" }, 404)`.
//
//          Notes on the regexes:
//           - All :id captures use the standard UUID shape [0-9a-fA-F-]{36}
//             matching how the existing /api/submissions/:id route is written.
//           - Order matters within each match block: longer / more specific
//             patterns are checked first.

/*

// --- Insurers (Phase 2A) ---

if (pathname === "/api/insurers" && request.method === "GET") {
  return handleListInsurers(env, user);
}
if (pathname === "/api/insurers" && request.method === "POST") {
  return handleCreateInsurer(request, env, user);
}

// /api/insurers/:id        GET (detail)
// /api/insurers/:id/documents/sign   POST (upload signed URL)
{
  const im = pathname.match(
    /^\/api\/insurers\/([0-9a-fA-F-]{36})(\/documents\/sign)?$/
  );
  if (im) {
    const insurerId = im[1];
    const sub = im[2];
    if (!sub && request.method === "GET") {
      return handleGetInsurer(insurerId, env, user);
    }
    if (sub === "/documents/sign" && request.method === "POST") {
      return handleSignInsurerDoc(insurerId, request, env, user);
    }
  }
}

// /api/insurer-documents/:id/process   POST (run the AI ingestion)
{
  const dm = pathname.match(
    /^\/api\/insurer-documents\/([0-9a-fA-F-]{36})\/process$/
  );
  if (dm && request.method === "POST") {
    return handleProcessInsurerDoc(dm[1], env, user);
  }
}

// /api/appetite/:id              PUT (edit)
// /api/appetite/:id/confirm      POST (flip is_active=true)
// /api/appetite/:id/deactivate   POST (flip is_active=false)
{
  const am = pathname.match(
    /^\/api\/appetite\/([0-9a-fA-F-]{36})(\/[a-z]+)?$/
  );
  if (am) {
    const appetiteId = am[1];
    const sub = am[2];
    if (!sub && request.method === "PUT") {
      return handleEditAppetite(appetiteId, request, env, user);
    }
    if (sub === "/confirm" && request.method === "POST") {
      return handleConfirmAppetite(appetiteId, env, user);
    }
    if (sub === "/deactivate" && request.method === "POST") {
      return handleDeactivateAppetite(appetiteId, env, user);
    }
  }
}

*/

export {}; // file is a guide, not a module
