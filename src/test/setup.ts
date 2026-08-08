import { expect, afterEach } from "vitest";
import { cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import * as axeMatchers from "vitest-axe/matchers";
// vitest-axe@0.1.0's own "extend-expect" types target an older Vitest
// typings API vitest 3 no longer honours, and that entry's runtime build is
// an empty file. Matcher runtime registration is manual here; the type
// augmentation (ambient, picked up automatically via tsconfig "include")
// lives in src/test/vitest-axe.d.ts.

expect.extend(axeMatchers);

afterEach(() => {
  cleanup();
});
