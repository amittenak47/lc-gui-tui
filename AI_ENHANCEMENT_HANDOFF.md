# Shapes and visualization handoff

Updated September 10, 2026. Continue on **`ai-enhancement`**, kept local.

## Scope and branch state

Original plan: `.cursor/plans/shapes_viz_whiteboards_6039fc16.plan.md`.
Phases 1–2 are implemented. Their stale local checklist is now marked completed.
The plan is gitignored; this tracked handoff records the implementation and verification state.

At the user's request, all ten commits from `origin/fix/split-sync-ink-layout`
were fast-forwarded into `main` and pushed. Local and remote `main` are
`7f7bcece`. The eleven existing `ai-enhancement` commits were rebased onto it.
One Board conflict was resolved by retaining both the ink attachment waiters
from main and the scene overlay from this branch. No ai-enhancement commits
have been pushed. No APK was rebuilt.

**Do not begin Phase 3** (chat-owned whiteboards, thumbnails, attachment picker)
until the user verifies phases 1–2. Continue to keep new source edits inside
this project and on `ai-enhancement`. Avoid mixing in ink-lab experiments.

## Implemented

- Shared live/export painter for rectangles, ellipses, diamonds, lines,
  arrows, text and decoded images; centered multiline bound labels;
  rotated bounds and backwards-arrow culling.
- Gesture primitives, text editing, selection handles, free rotation, flips,
  aspect-locked corner resizing (touch toggle or Shift), direct bend dragging
  and curved arrows. Drag previews retain the pre-gesture undo baseline;
  cancellation restores the original geometry.
- Stamp library built from the shared layouts, with actual rendered thumbnails
  and a live configuration preview. Placement now closes the picker, centers
  and selects the stamp, and sizes it for the visible camera. Labels scale
  during subsequent resizing, including rotated text.
- Timeline playback, pause/replay, speed selection, frame scrubbing and step
  descriptions. Geometry/highlight transitions are presentation-only;
  saved scenes and exports contain the exact selected frame. Reduced motion
  bypasses animation; backgrounding pauses playback.
- Trie, union-find, DP list/table, segment tree, call tree, composite and bits
  in TypeScript/Rust; 40-frame rejection at both gates; per-kind construction
  tests and offline Dirk-Qwen3.8 golden fixtures.
- Pad/document Ask drawing tools, programs in Ask responses and pad Draw UI.
  `cite_test_case` remains problem-only. LeetCode diagrams retain the Coach
  lane; pad diagrams use the current viewport, preserve their placement while
  stepping, and account for notebook zoom. Mobile pad playback no longer
  switches to the nonexistent Coach page.
- Tree roots clear their headings; union-find arrows point to parents;
  array/grid/DP values use stable column spacing across frames; DP predecessor
  arrowheads terminate outside filled cells.

## Latest commits

| Commit | Change |
| --- | --- |
| `cabff4f4` | Fixed the reported rotation-label drift: icon and angle crossfade in one fixed centered grid cell, with no positional morph. Also prevented flyout padding from clipping the last option. |
| `2d100598` | DP cell spacing and visible predecessor arrowheads. |
| `57a30c5c` | Readable stamp/diagram placement at notebook zoom, immediate stamp selection and mobile pad routing. |
| `ccb959be` | Scale label fonts with shapes and rotated text. |
| `182aafde` | Real Chrome checks for notebook entry, placement and rotation-label alignment; DP visual example. |

The earlier checkpoint is `cfb1e2c2` after rebase. `ASTRA_LAST_STATUS.txt`
is historical; use this document for current status.

## Verification

- TypeScript check passed after the final label-scaling change.
- Production frontend build passed (existing mixed static/dynamic import warnings).
- Full frontend suite: **3,089 passed, 7 skipped, 1 failed** across 279 files.
  The remaining failure is
  `src/canvas/inkMarkCompositing.test.ts`: “puts a dwell blot down as one blit,
  not as fills on the destination.” It expects a destination `drawImage` call
  and receives none. This test and `rasterInk.ts`/inkLab code match `main`;
  this is the previously observed ink failure, not a new shape assertion.
- Rust `llm::viz`: **16 passed**. Rust `llm::docs`: **8 passed**.
- Headless Chrome review passed: desktop diagrams, dark controls, 390px mobile
  viewport without horizontal overflow, actual new-notebook entry, library,
  configuration, readable stamp placement and rotation. The angle center is
  checked against its button during the transition and pointer drag.
  No uncaught browser exceptions were recorded.

Commands from `app/` (PowerShell):

```powershell
$env:NODE_OPTIONS='--no-experimental-webstorage'
node node_modules/vitest/vitest.mjs run
npm.cmd run build
npm.cmd run dev -- --host 127.0.0.1 --port 1427
# In another project terminal, with Vite running:
node scripts/viz-review.mjs
```

The NODE_OPTIONS flag must reach Vitest's workers on Node 26; setting only
the parent node argument caused unrelated jsdom localStorage failures.
From the repository root:

```powershell
cargo test --lib --no-default-features llm::viz --offline
cargo test --lib --no-default-features llm::docs --offline
```

Review artifacts are ignored under `app/.tmp-viz-review/`, including
`app-array-stamp.png`, `app-rotating.png`, `app-rotated.png`,
`desktop-dptable.png`, `mobile.png`, `browser-errors.json`, and `full-tests.log`.
The review uses an isolated browser profile inside that same project directory.

## Remaining verification and follow-up

1. **User/tablet pass:** place and rotate stamps with pen and touch; resize a
   rotated label; add arrow bends; cancel a gesture; undo/redo; save/reopen and
   export. Check the rotation icon-to-angle transition on the physical display.
   Browser mouse checks do not substitute for pen/tablet verification.
2. **Live Dirk Ask/Draw:** when the configured Dirk-Qwen3.8-27B endpoint is up,
   request the trie, union-find and edit-distance fixtures on a pad and on a
   LeetCode problem. Check frame playback, placement, collapsed/reopened
   drawings and saved conversations. The endpoint was unavailable during this
   run; golden tests exercise intermediate programs, not live model output.
3. **Ink test:** investigate the dwell-blot compositing failure separately from
   shape work. Reproduce with the single test above before changing renderer
   behavior or its expectation. Scene and ink undo still have separate history
   stacks; interleaved global undo ordering is not redesigned here.
4. **Phase 3 stays paused.** After user verification, resume the original plan's
   association rules, saved whiteboard cards and attachment-picker work.

## Preserved work

Existing temporary directories and earlier stashes were left intact. In
particular, the stash descriptions for Astra captures, tmp viz-review leftovers,
and pre-takeover astra edits remain available. The additional
`ai-enhancement paused drawing fix and review diagnostics` stash was applied;
its source changes are now incorporated above, so do not reapply it blindly.
The `preserve split-sync inkTiles before ai-enhancement resume` stash preserves
the previous checkout state. Untracked `.tmp-unix/`, `app/tmp-scribble-review/`
and `app/tmp-wat-frames/` are unrelated and were not committed.
