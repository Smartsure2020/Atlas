/**
 * Atlas — frontend component test configuration
 * ----------------------------------------------------------------------------
 * Separate from the existing worker/phase test chain (tsconfig.test.json +
 * `npm test`), which stays untouched. This config only ever sees `src/`.
 */

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
    css: false,
    // Phase 6 Checkpoint 1A — vitest-axe accessibility scans can legitimately
    // exceed vitest's default 5s per-test timeout on a full-page container
    // (~50 axe rules × jsdom walk). Raising the per-test budget to 30 s here
    // is targeted: it applies to any test, so the axe-heavy Phase 4 dashboard
    // suite runs to completion on slower CI hardware while all other tests
    // finish long before the new ceiling.
    testTimeout: 30_000,
  },
});
