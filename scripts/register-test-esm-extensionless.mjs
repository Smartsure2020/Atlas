// Preload for test suites that import Worker modules with extensionless
// relative imports:  node --import ./scripts/register-test-esm-extensionless.mjs <suite>.js
// See test-esm-extensionless-hooks.mjs for why this exists.
import { register } from "node:module";

register("./test-esm-extensionless-hooks.mjs", import.meta.url);
