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
  },
});
