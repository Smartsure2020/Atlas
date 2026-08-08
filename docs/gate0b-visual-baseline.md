# Gate 0B visual/keyboard/accessibility baseline

Captured 2026-08-07, against `#submissions` on the pre-Phase-1 UI (commit
`b7f461f`). This is the reference point Phase 1 (Radix migration, token
work, Work Queue refactor) should be diffed against — both "does it still
look/behave the same where it's supposed to" and "did we fix the known
issues below."

## A known gap in this artifact

The 32 screenshots referenced below were captured in the Browser pane during
the Gate 0B session and shown inline in that conversation, but **no tool
available in that session (or this one) can export a Browser-pane
screenshot to a file on disk.** There is no raw-bytes/data-URL handle
exposed to the agent for a `computer{screenshot}` call — only a rendered
image in the response. So the pixels themselves live only in that
conversation's transcript, not as files in this repo.

What *is* durable, and is what this document provides instead:

- The exact, deterministic reproduction method (below) — re-running it
  produces the same 32 states and test conditions, since it doesn't depend
  on live production data. Pixel output itself may still vary by browser,
  installed fonts, OS rendering, and whatever real data happens to be
  populated at the time — the recipe pins the *states*, not the pixels.
- The findings each state surfaced (axe violations, layout notes), which
  are the part of a "baseline" that actually needs to survive Phase 1.

If you want real persisted pixel artifacts (e.g. for automated visual
regression), the natural fix is a Playwright (or Chromatic/Percy) snapshot
suite — that needs a new dependency and is a reasonable thing to add
*as part of* Phase 1 tooling, not retrofitted here. Until then, treat this
document as the QA baseline of record and re-run the recipe manually when
you need to compare.

## Reproduction recipe

1. `npm run dev` (Vite, port 5173) and `cd worker && npm run dev`
   (Wrangler, port 8787), signed in as staff on `#submissions`.
2. Install a `window.fetch` override in the page that matches only
   `GET .../api/submissions` (the list endpoint, not
   `/api/submissions/:id`) and, depending on `window.__atlasMock`:
   - `'loading'` → returns a promise that never resolves
   - `'empty'` → resolves `{ ok: true, submissions: [] }`
   - `'error'` → rejects with a `TypeError`
   - `'real'` → passes through to the actual Worker (real data, no
     fixtures inserted anywhere)
3. For each state, set `window.__atlasMock` and force a clean remount by
   changing the hash away (`#jobs`) and back (`#submissions`) — this
   re-triggers `WorkQueue`'s mount effect without a full page reload.
4. Screenshot in list mode, click the mode toggle, screenshot again in
   board mode.
5. Repeat for viewport widths **1440, 1280, 768, 375** (heights 900/800/
   1024/812).

## 32-state inventory

| Viewport | State | Mode | Notes |
|---|---|---|---|
| 1440 | loading | list/board | skeleton rows/columns, no violations beyond baseline |
| 1440 | empty | list/board | board shows `color-contrast` on 6 empty-column placeholders |
| 1440 | error | list = board | identical DOM — `WorkQueue` renders `ErrorState` before checking `mode` |
| 1440 | populated | list/board | list has horizontal overflow starting here (9-column table) |
| 1280 | loading/empty/error/populated | list/board | same pattern as 1440; list truncates to ~4 visible columns before scrolling |
| 768 | loading/empty/error/populated | list/board | sidebar collapses to icon rail; metric tiles wrap 3+2 |
| 375 | loading/empty/error/populated | list/board | list `EmptyState` text is clipped inside the horizontal-scroll table wrapper (board's empty state is not); Tab-to-last-column auto-scrolls the table (confirmed: `scrollLeft` 0→856) |

## Accessibility findings tied to this baseline (axe-core 4.13.0, local, no CDN)

- **`empty-table-header` (minor, pre-existing)** — list mode's "actions"
  column `<th>` has no header text, in every list-mode render. Fix:
  visually-hidden label on that column in `WorkQueue.tsx`.
- **`color-contrast` (serious, pre-existing)** — board mode's
  `.atlas-board__empty` ("Nothing at this stage") text fails contrast,
  in every empty board column.
- **ColumnPicker Escape does not close the panel** — no `keydown` handler
  exists on it at all (`DataTable.tsx`); confirmed live (`aria-expanded`
  stayed `"true"` after `Escape`). This is the pre-Radix-replacement
  before-state.
- **Search inputs and native `<select>`s have no visible focus
  indicator** — `outline: none`, transparent box-shadow, unchanged
  border/background focused vs. unfocused. Buttons/links correctly get a
  2px solid outline.

Full detail (including keyboard-order findings, focus-restoration, and the
duplicate-fetch investigation) is in the Gate 0B conversation this
document summarizes.
