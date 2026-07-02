/**
 * Atlas Blueprint — router patch for the DEV SIGN-IN SHORTCUT
 * ----------------------------------------------------------------------------
 * Two-line addition to worker/src/index.ts. To revert later, just delete
 * these lines and delete `worker/src/dev-sign-in.ts`.
 *
 * The route sits with the other PUBLIC routes (no bearer token needed) —
 * BEFORE the `const user = await authorise(...)` line. The endpoint's own
 * three guards (dev-only, allow-list, audit) provide the security.
 * ============================================================================
 */

// ----- 1. Import (alongside the other handler imports) -----

// import { handleDevSignIn } from "./dev-sign-in";


// ----- 2. Route block — add BEFORE the `authorise(...)` line, alongside the
//          existing public routes (/auth/login, /auth/callback, /api/health) -----

/*

if (pathname === "/dev/sign-in" && request.method === "GET") {
  return handleDevSignIn(request, env);
}

*/

export {}; // documentation file
