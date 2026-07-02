# Patch notes (historical documentation)

These `.ts` files are **not code**. Each is a documentation-only file
(`export {}` and comments) that described a manual edit to apply to a real
source file during Atlas's phased build-out. The edits they describe have
already been applied to the codebase.

They were moved here from `src/` and `worker/src/` during Phase 1B repo
hygiene so the source trees contain only live code. They are kept for
historical context on why certain changes (candidate-list matching,
dev sign-in wiring, router additions, max_tokens bumps, etc.) were made.

Do not apply these again, and do not import them.
