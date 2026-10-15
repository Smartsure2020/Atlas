/**
 * Test-only Node ESM resolve hook.
 *
 * Several Worker endpoint modules use extensionless relative imports
 * (`from "./auth"`), which the Worker bundler and TypeScript's "Bundler"
 * resolution accept but Node's native ESM loader rejects. The compiled output
 * the test suites run (`.test-dist`) is plain ESM, so a suite that imports
 * those modules directly would fail with ERR_MODULE_NOT_FOUND.
 *
 * Rather than rewriting production imports to `.js` solely for a test harness,
 * suites that need those modules load this hook (see register-...mjs): when a
 * relative specifier has no extension and does not resolve, retry it as
 * `<specifier>.js`. It changes nothing for specifiers that already resolve,
 * and it is never loaded by the Worker, the frontend build or any other suite.
 */
const RELATIVE_NO_EXTENSION = /^\.{1,2}\/(?:[^/?#]+\/)*[^/.?#]+$/;

export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    if (error?.code === "ERR_MODULE_NOT_FOUND" && RELATIVE_NO_EXTENSION.test(specifier)) {
      return nextResolve(`${specifier}.js`, context);
    }
    throw error;
  }
}
