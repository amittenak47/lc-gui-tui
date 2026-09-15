# Shapes and visualization handoff

## Current continuation — September 15, 2026

User confirmed Markdown scrolling and Agent Panel anchoring are fixed. Skip
the Markdown inspection in the continuation checklist. Finish sync verification
and the existing Agent chat enhancements before Phase 3: Markdown/math, word
reveal including Thinking/Reasoning, document drawing controls and persistence.
Drawings ride with messages in the containing document/notebook sync payload;
independent chat-owned whiteboards and attachments remain Phase 3 work.

Workspace is on `ai-enhancement`. The requested rebase onto `main` completed;
local and fetched remote branches already shared `547af22a`. Uncommitted work
was preserved. Detailed continuation: `docs/current-work-status.md` (gitignored).

### Verification and publication checkpoint

- Existing Agent UI capabilities are present: shared Markdown/KaTeX for chat,
  agent prompt instructions for inline/display math, presentation-only word
  reveal for answers and open Thinking/Reasoning details, and a bounded drawing
  viewer at the upper-right of annotated documents. The chat toggle shows
  “On page” or “Hidden”; chat and viewer use the same selected frame.
- 99 focused chat/drawing/sync tests pass. New tests serialize actual notebook
  and document upload bodies, discover them through a separate client fixture,
  and restore the threaded chat with its full program, selected frame, visibility,
  math, process details and reasoning. Both expanded and hidden drawings pass;
  pending response placeholders are excluded. This is fixture verification,
  not a fresh desktop/tablet or live-model acceptance run.
- Another 93 tests pass for tab reordering, Markdown DOM stability and live ink
  baking. TypeScript and the production frontend build pass (existing mixed
  static/dynamic import warnings).
- Isolated Chrome sync/Agent review passes: archive acknowledgements, no false
  conflict for unchanged ink, ruling-off reload with retained ink, three
  thread-return/close cycles, drawing frame selection and hide. No browser errors.
- Isolated Chrome tab/Markdown regression also passes: real pointer reordering
  and split swapping, zero DOM replacements across 20 unrelated updates, saved
  camera restoration, and released camera holds after hiding or closing the tab.
- User requested committing the accumulated work and pushing it to `main`.
  Included changes cover tab insertion/reordering, preserving Markdown DOM,
  releasing hidden/closed camera holds, preserving camera on tab return, the
  delayed-frame ink upload boundary, review scripts and the existing icon change.

Remaining: actual cross-device/live-model acceptance of the chat and sync paths,
then Phase 3 chat-owned whiteboards/cards/attachments and agent-created code or
Markdown attachments. Markdown scrolling and panel anchoring are user-confirmed;
do not reopen those investigations without a new reproduction.

## Previous checkpoint — September 14, 2026

The September 10 report below is historical. This checkpoint collects the
annotation, sync and Agent UI work after `7aac70fe`. The user requested that
the accumulated work be committed, pushed and merged into main.
Detailed local status: `docs/current-work-status.md` (intentionally gitignored).

This continuation fixed text wrapping/editing/font controls, eraser stacking,
split-layout settlement and cached pane offsets. It also reproduced and fixed
Markdown scrolling after restoring ink: non-PDF saves incorrectly carried
`pdfPage: 1`, causing the camera to wait forever for a PDF page. Non-PDF restores
now ignore that legacy marker, and new saves omit it. Ink is preserved.

TypeScript and 174 focused tests pass. Isolated Chrome checks pass for text,
eraser layers, split-to-full ink alignment across PDF/Markdown/EPUB/code/web,
and long Markdown scrolling after five strokes and save/restore. Actual user
desktop validation: the user reported the previous build appeared fixed.
No desktop/APK rebuild or install here.

Pre-commit verification: production frontend build and 93 Rust LLM tests pass.
Full frontend run: 3,236 passed, 7 skipped, 3 failures. One failure is the
previously documented tracked dwell-blot assertion in inkMarkCompositing.test.ts;
the other two came from the old untracked DocSelectionLayer.attached.test.mjs
experiment, whose implementation is absent. That experiment is preserved in
ignored `.tmp-attachment-experiment/`, outside the app suite. No assertion was
weakened or application behavior changed to silence those failures.
Generated screenshots, browser profiles, videos and temporary tools stay local
under ignored temporary paths; reusable review scripts are included.
The repaired `text-box-review.mjs --reopen` harness passes all five formats:
write in split, persist ink shards, unmount, reopen full-width, return to split,
then leave split again. Checks cover visible pixels, page-relative alignment
and preserved decoded ink coordinates (allowing existing save quantization).

Pause for the user's annotation check. Next verify/tighten the existing sync
changes. Agent Chat is not declared complete. Afterwards, Phase 3 covers
chat-owned whiteboards, thumbnail attachments and their sync; the user also
wants agent-created/saved code or Markdown files attachable to chat/footnotes
through existing Monaco/Markdown document support. That phase is not started.

## Historical shape/visualization checkpoint

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
