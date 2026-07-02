/**
 * Atlas Blueprint — router patch for Phase 3
 * ----------------------------------------------------------------------------
 * Documentation only. Additions to worker/src/index.ts to wire Phase 3 routes.
 * ============================================================================
 */

// ----- 1. ADD these imports alongside the existing handler imports -----

// import { handleRecordDecision, handleGetDecision } from "./decision-endpoints";
// import { handleGenerateEmail, emailTypeFromPath } from "./email-endpoints";
// import { handleGetAuditTimeline } from "./audit-endpoints";


// ----- 2. EXTEND the regex on the /api/submissions/:id... block to match
//          the new sub-paths, and add the handler branches.
//
// The Phase 2B version had:
//   /^\/api\/submissions\/([0-9a-fA-F-]{36})(\/[a-z]+)?$/
//
// Phase 3 needs to ALSO match `/emails/broker-missing-info` etc., which have
// a hyphenated second segment. Update the regex to:
//
//   /^\/api\/submissions\/([0-9a-fA-F-]{36})(\/[a-z-]+(?:\/[a-z-]+)?)?$/
//
// Then add the new sub-route branches alongside the existing /extract,
// /review, /recommend, /recommendation:

/*

if (sub === "/decision" && request.method === "POST") {
  return handleRecordDecision(id, request, env, user);
}
if (sub === "/decision" && request.method === "GET") {
  return handleGetDecision(id, env, user);
}
if (sub === "/audit" && request.method === "GET") {
  return handleGetAuditTimeline(id, env, user);
}

// Email drafts: /emails/<type>
if (sub && sub.startsWith("/emails/") && request.method === "POST") {
  const emailType = emailTypeFromPath(sub.slice("/emails".length));
  if (!emailType) return json({ error: "unknown_email_type" }, 400);
  return handleGenerateEmail(id, emailType, env, user);
}

*/

export {}; // documentation file
