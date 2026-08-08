/**
 * vitest-axe@0.1.0 targets an older Vitest typings API ("declare namespace
 * Vi") that Vitest 3's own Assertion/Matchers interfaces no longer honour —
 * its "extend-expect" entry ships that stale augmentation, and its runtime
 * build for that same entry is an empty file (see src/test/setup.ts). This
 * file bridges the gap locally, following the pattern
 * @testing-library/jest-dom/types/vitest.d.ts uses to augment Vitest 3.
 */

import "vitest";

interface NoViolationsMatcherResult {
  message(): string;
  pass: boolean;
  actual: import("axe-core").Result[];
}

declare module "vitest" {
  interface Assertion<T = any> {
    toHaveNoViolations(): NoViolationsMatcherResult;
  }
  interface AsymmetricMatchersContaining {
    toHaveNoViolations(): NoViolationsMatcherResult;
  }
}
