# Changelog

All notable changes to `lc` are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added — the coach shows its work, and stops changing its mind

- **Stages arrive as they happen.** Ask, Review, Draw and Lazy run over the
  session WebSocket, which now carries `run` / `cancel` frames and reports each
  pipeline stage and diagram tool call back to the chat turn that asked for it.
  The chat used to fill that silence with a timer guessing at phases; on a slow
  local model the guess was usually wrong. `POST /coach/*` still works and is
  what `coach.ws_runs = false` puts the UI back on.
- **One approach per board session.** Several approaches are valid on most of
  these problems, and a model that knows three of them could read a half-drawn
  board as a different one each turn. The session now commits to the approach
  the board argues for, and every stage after the claim coaches inside it. Only
  a board that actually changed can move the commitment — and when it does, the
  card says so, with a reason and what carries over. A student who asks to
  switch is honoured immediately.
- **An optional planner.** `llm.modes.planner` catalogs the approach families a
  problem admits, once, and the local coach uses it to recognize what the
  student drew — never to recommend from. It sees the same redacted problem
  `lc ask` does. Off unless `coach.planner_enabled`.
- **An optional check on drawn diagrams.** After a diagram renders, a vision
  model can look at the picture and redraw it once if it does not show what the
  program claims — catching the diagrams that type-check and are still wrong.
  One critique, one redraw, no loop. Off unless `coach.draw_review_enabled`.
- How the coach works, and why, is written down in
  [`docs/coach.md`](docs/coach.md).

### Fixed — the problem sets' empty columns

- **KodCode now fills every column in the browser.** Difficulty comes from its
  own `gpt_difficulty` rating; the name is the function under test rather than
  the opaque `Algorithm_1_C` id (`running-max-45219-i`), with the id's number
  reported on its own so `sort: q#` orders the corpus; and the cases column is
  read off the literal asserts in its pytest suite, so the runner reports case
  by case instead of pass/fail on the whole module. `lc test --full` still runs
  the module. What its two tags mean — seed family and phrasing style — is now
  documented in the README, in `src/datasets/kodcode.rs`, and in the tab's
  tooltip.
- **Nested columns stored as JSON strings are read.** A Parquet conversion
  stores a structure either as an object or as a string holding the same JSON,
  and only the first spelling was read — which is why DeepSeek LC had no q# or
  tags and Morgan Stanley had no test cases. Both spellings now work.
- **A corpus can no longer index as a single problem.** `task_id` is the index's
  primary key, so rows that slug to the same name silently replaced each other:
  a dump whose rows carry no id and whose statements all open with the same
  words collapsed to one entry. Ids are de-duplicated per file (`-2`, `-3`, …),
  and a row with no title is named after its entry point rather than the first
  words of a boilerplate preamble.
- **Indexing KodCode takes minutes, not hours.** `upsert` deletes a problem's
  old tags by `task_id`, but the tag table's primary key is `(tag, task_id)`, so
  every one of 487k problems scanned the whole tag table. Added the missing
  index. Import also streams the corpus instead of materialising 487k `Problem`s
  in memory, and opening one problem no longer parses the rest of the file.
- **`lc datasets --inspect`** reports what a downloaded corpus actually
  contains: the columns its rows have, which canonical fields came out empty,
  and which columns no adapter reads. It is the answer to "the tags column is
  blank" — the usual cause is a column nothing is mapped to. Values are never
  printed, since a row may hold a reference solution.
- **The workspace header no longer calls every question number a LeetCode
  one** — `question #45219` rather than `LeetCode #45219` on a synthetic corpus.

### Fixed — the tablet layout, and confirming destructive things

- **Coach is a bottom sheet on a tablet again.** Its sheet rules were behind a
  900px media query while the mobile class is set for any coarse pointer up to
  1280px, so an iPad got the class and the desktop panel geometry: the panel
  covered the canvas from the header down while the board was squeezed into the
  strip underneath. One height variable now drives the sheet and the room the
  canvas gives up, and opening it refits the open page.
- **A page is the only thing on the canvas.** Fitting the viewport to one frame
  left its neighbours peeking in, and zooming out brought the whole column back.
  Off-page elements are hidden (`app/src/canvas/pageView.ts`) with their real
  values parked in `customData`, and everything that reads the board — capture,
  thumbnails, `board.json` — sees an unpaged scene. Raster pen ink is clipped to
  the same box.
- **The fit is no longer half the size it asked for.** Excalidraw quantises
  `scrollToContent`'s zoom to 0.1 steps; on a ~3900-unit board an honest 0.19
  floored to 0.1, which is why a page landed as a stamp in the corner.
- **Appearance, the page turner and the zoom cluster share one row** instead of
  the pager floating over them.
- **The text tool places in one tap.** Excalidraw refuses to create a text
  element while another is being edited, so every box after the first cost two
  taps; the press is replayed once its own gesture finishes. The font-size
  slider no longer closes the box on desktop either — a native range input takes
  focus on mousedown, so it drives its own drag.
- **Excalidraw's single-key shortcuts are gone.** `handleKeyboardGlobally` made
  every bare letter live: `1`–`9` and a dozen letters swapped the tool under the
  pen, and `s` / `g` opened the colour pickers that appeared from nowhere.
  Unmodified single-character keys no longer reach it, typing is untouched, and
  a `?` in the toolbar lists what does work.
- **No more `window.confirm`.** Resetting the session and resetting the board
  ask in the app's own modal, and every destructive answer — including
  save-or-discard on leaving — is held for a second like Reveal
  (`app/src/components/HoldButton.tsx`).

### Added — multiple problem sets

- **Four more corpora**, each in its own SQLite tables rather than merged into
  one: [`KodCode-V1`](https://huggingface.co/datasets/KodCode/KodCode-V1),
  [`sft-python-q-problems`](https://huggingface.co/datasets/morganstanley/sft-python-q-problems),
  [`deepseek-leetcode`](https://huggingface.co/datasets/davidheineman/deepseek-leetcode),
  and [`leetcode-with-tests`](https://huggingface.co/datasets/kr4t0n/leetcode-with-tests).
  Separate tables because their ids collide — `two-sum` is in three of them —
  their difficulty scales are unrelated, and rebuilding one must not touch
  another. `src/dataset.rs` is the registry; `src/datasets/` holds one adapter
  per corpus, each documenting its column mapping.
- **A tab strip over the problem table** switches problem sets. Every table and
  session control works the same on any tab; filters reset on a switch, because
  a KodCode tag means nothing in the LeetCode tables. The TUI cycles the same
  choice with `G`.
- **Dataset-qualified progress.** `session.json` keys are now
  `dataset/task_id`, which is what stops a `failed` badge earned in one corpus
  from appearing on the same slug in another. Older session files are migrated
  on load rather than silently losing their history.
- **`lc datasets`**, `--dataset` on `index` / `search` / `random` / `load` /
  `test`, and `data.datasets.<slug>` config for a corpus that lives elsewhere.
- **`scripts/fetch_dataset.py`** converts a Hugging Face Parquet corpus to the
  `.jsonl` the indexer reads. It knows nothing about the schemas on purpose —
  that lives in `src/datasets/` where it is tested.
- **Adapters cannot leak a solution.** They build a `Problem` by hand, so
  serde's redaction guarantee does not cover them; `SOLUTION_FIELDS` lists the
  columns they must not read and a test feeds every adapter a record stuffed
  with marker solutions to prove none escapes.
- **`run_tests.py` runs pytest-style suites** (`test_*` functions, no fixtures),
  which is how KodCode ships its tests. DeepSeek's suite is rewritten at import
  time into the `check(candidate)` the runner calls, and read a second time to
  recover per-case sample I/O.

### Added — test results, and keeping (or dropping) your work

- **Run tests / Submit open a modal** over the board in the Settings panel's
  shell, instead of a card in the coach thread that the next message pushed out
  of sight.
- **Results reach the coach automatically.** The same run is posted into the
  thread as an `app` turn and attached to the next request on its own
  `app_messages` channel, which the daemon tells the model to read as fact —
  unlike everything else on the board, which is a claim the coach should
  question. Asking *"why did case 3 fail?"* needs no copy-paste.
- **Settings → Tests** chooses between running every case and stopping at the
  first failure (`tests.stop_on_first_failure`, off by default: the results
  panel and the coach's counterexample picking both want the whole picture).
- **Leaving a problem asks what to keep** — and asks a different question
  depending on whether it is solved. Unsolved, saving resumes the layout, the
  code, and the coach thread. Solved, the attempt is a record: it is archived
  and the next attempt still starts on a fresh board with a fresh session. The
  coach session is always saved once a problem is solved. Rules and their tests
  live in `src/attempt.rs`; `GET`/`PUT /workspace/:id/agent` and
  `POST /workspace/:id/attempt` are the wire.

### Fixed

- **Draw worked on no vLLM server.** A request carrying `tools` is a 400 unless
  vLLM was started with `--enable-auto-tool-choice` and a `--tool-call-parser`,
  which is not fixable from inside the app — and diagrams are the one coach mode
  built entirely on tool calls. `/coach/viz` now falls back to asking for the
  same calls as JSON, generated from the same schemas. A genuine failure still
  surfaces as itself rather than as a misleading "can't tool-call".
- **Ambient mode is off.** The 60-second loop re-asked itself on slowly-changing
  boards and blocked the pen on local models. The button stays, greyed, behind
  one flag (`AMBIENT_ENABLED`).
- `defaultOpen` on `<details>` is not a React prop, so the reveal bridge's fold
  never actually started open. It is `open`.


### Added — handwriting whiteboard coach

- **`lc` is now a library** (`src/lib.rs`) as well as a binary. `main.rs` swapped
  its `mod` declarations for `use lc::*`; nothing else moved.
- **`lc serve [--port] [--lan]`** — an axum daemon over the existing `index`,
  `loader`, `problem`, `generator`, and `runner` modules, so a tablet can drive
  workspaces that stay on the PC. Loopback by default; `--lan` requires a pairing
  token, generated once and printed as a QR code.
- **Whiteboard coach modes** (`src/llm/coach.rs`):
  - `POST /coach/review` — verdict, ratings, gaps, Socratic question, and a
    counterexample citing one of the problem's **real** sample cases.
  - `WS /coach/session` — 15-second ambient nudges with a server-side escalation
    ladder, so the coach escalates instead of repeating itself.
  - `POST /coach/viz` — diagrams and animations via tool calls.
  - `POST /coach/reveal` — opt-in reference-solution bridge (see below).
- **Cited test cases are verified, not trusted.** The daemon checks a cited index
  against the workspace's cases and overwrites the quoted input/expected with the
  corpus's own text; a fabricated citation is dropped and reported to the client.
- **Per-mode LLM config** — `llm.modes.{ambient,review,bridge,viz}`, each `local`
  or `groq`, so `review` can point at a stronger model while `ambient` stays
  local and cheap.
- **`chat_completions_ex`** — multi-turn calls with tool definitions, image
  parts, and JSON-object output, added alongside the existing
  `chat_completions` so `lc ask` is untouched.
- **`src/reveal.rs`** — the one deliberate exception to the redaction invariant.
  Reading the corpus's `completion` requires a `UserConsent` token that only
  `UserConsent::from_explicit_user_action()` can produce, and the `/coach/reveal`
  handler is the sole caller. Enforced by tests.
- **Reveal tracking** — `session.json` records tap-outs; `lc stats` reports them.
- **`src/coach.rs`** — a `CoachContext` trait (`system_prompt`, `ground_truth`,
  `verify`) with `LeetCodeContext` as the first implementation, so a future
  screen/camera context slots in without touching the canvas or transport.
- **`app/`** — Tauri v2 whiteboard client (React + Excalidraw), with deterministic
  renderers for nine data structures, a frame scrubber, and an ML Kit Digital Ink
  Kotlin plugin for on-device handwriting recognition. See `app/README.md`.
- **Config keys** — `serve.port`, `serve.token`, `llm.modes.*`.

### Added — tablet pass (mobile layout, Android sideload, short-code pairing)

- **Mobile region pages** — on a phone/tablet viewport the board pages through
  one template region at a time (constraints → code → approach → complexity →
  walkthrough) instead of asking for a pan across the whole column. The scene is
  unchanged, so `board.json`, healing and capture are identical to desktop; only
  the viewport moves. Desktop keeps the one wide canvas.
- **Compact mobile chrome** — smaller toolbar and zoom trays, Settings and
  *Open in IDE* behind a ⋯ menu, and Excalidraw's own docks hidden on touch.
- **`POST /pair`** — six-digit session code, generated on every `lc serve --lan`
  start, exchanged once for the long serve token. Pair a tablet by typing Host,
  Port and Code; the QR and token URL remain as a fallback. `GET /pair/code`
  (authenticated) backs Settings → Serve.
- **Android sideload** — `npm run android:init` / `android:apk` apply the
  cleartext-LAN `network_security_config.xml` to the generated Gradle project
  and build a debug-signed APK; `app/README.md` covers Android 12/14 install.

### Fixed

- **`length limit exceeded` on Share/Send** — the daemon's body limit was Axum's
  ~2MB default, which any board PNG exceeded. Now 32MB, with the export
  downscaled before it is sent and the review retried without the image if the
  body is still refused.
- **The coach calling a drawn board blank** — a browser build transcribes no ink,
  so a hand-drawn board arrived with empty `recognized_text` and the coach told
  the student to go implement a solution. The prompt now reads the canvas layout
  and the attached image, and a sparse board gets concrete opening hints instead.
- **Sluggish eraser rendering** — the brush ring updated React state on every
  `pointermove`, re-rendering the board at the pen's sample rate.
- **Pen ink the coach could not see** — the pen draws on the bitmap ink layer,
  not Excalidraw `freedraw`, so `captureStrokes` never saw it and a pen-only
  board submitted as blank. `buildSnapshot` now merges both stroke sources; ink
  the eraser removed is dropped, and a stroke the eraser cut through is split in
  two. Raster ink is repainted into the exported PNG at export scale (with a
  fallback to the ink-less export if bounds drift). Submit no longer rejects a
  legible pen-only board when a vision model will receive the picture.
- **`skeleton_hash` could not detect a skeleton edit** — it was the SHA-256 of
  the whole `solution.py`, taken once at problem load, so it never changed. It
  is now the hash of the skeleton as it currently stands, and a code delta goes
  out only while that still matches what the server acknowledged. Editing an
  import sends the full file, which is what the daemon needs: it refuses a delta
  it cannot anchor rather than reviewing the code it still holds.

### Added — board deltas and the split code editor

- **Server-side board state** (`src/serve/board_session.rs`) — the daemon keeps
  an element baseline per task, applies `board_ops` from the client, and
  reconstructs the full canvas layout before building any prompt. Deltas are a
  transport optimization; the model is never asked to merge them. A twelve-element
  board costs 1897 bytes on the first review and 364 on an unchanged second.
- **`code_mode`** — `unchanged` / `delta` / `full`. An unchanged solution is
  omitted from the review payload entirely.
- **Skeleton / Solution tabs** in the code editor. The entry-point signature and
  everything above it (header, imports, helper classes) is one tab; the method
  body is the other. Both editable — students add imports — and merged back into
  one file for disk. A file that does not match the corpus's `class Solution:`
  shape does not split, and the editor stays a single pane.
- **No-APK tablet paths** documented in `app/README.md`: the browser over the LAN
  (Vite on 1420, pairing to the daemon on 7878) and spacedesk screen mirroring,
  with what each one costs — ML Kit is Android-only, so both fall back to the
  board picture and a vision model.

### Added

- **Interactive TUI** (`lc` with no subcommand) — ASCII banner, menu-driven navigation, WASD controls.
- **Paginated browse** — 15 problems per page with dynamic column widths that fill the terminal.
- **Browse filters** — cycle tag (`T`), difficulty (`E`), sort (`O`); text search (`/`, applies on Enter).
- **Search scope** — matches `task_id` slug, LeetCode `question_id`, and tags (SQL `LIKE`, not per-keystroke reload).
- **Session tracking** — `session.json` records queue, loaded/passed/failed per problem; `lc stats` and TUI session stats.
- **Local submissions** — TUI **Submit locally** writes to SQLite `submissions` table.
- **List management in TUI** — `L` add highlighted problem to list; `R` random add from current filters; **Add to list** in problem actions; create new lists from picker.
- **Bulk corpus support** — index JSON arrays (`train.json`, `test.json`) and `.jsonl`; skip duplicate `.jsonl` when sibling `.json` exists.
- **`lc stats`** — session scope and `--corpus` flag; `lc list stats <name>`.
- **`lc search --sort`** — `question`, `difficulty`, `cases`, `tags`, `task_id`.
- **Editor reuse window** — `load --open` and TUI **Work on problem** use `cursor -r` / `code -r` on `solution.py`.
- **Quiet test runner** for TUI (`cmd_test_quiet`) so test output does not corrupt the terminal UI.
- **`.gitignore`** — excludes `target/`, workspaces, secrets, and local DB artifacts.

### Changed

- Default entry point is the TUI when no subcommand is given.
- **Start session → Browse** opens the paginated table directly (not add-by-id first).
- Replaced `j/k` navigation with **W/S**; selection uses cyan row highlight.
- Removed slow live `/` filter; search now runs one SQL query on Enter with pagination.
- `lists::add_tasks` / `lists::create` split for silent TUI use vs CLI printing.

### Fixed

- Duplicate keystrokes in TUI input (ignore `KeyEventKind::Repeat`; Press-only handling).
- Indexer failure on bulk JSON arrays (`invalid type: map, expected a string`).
- Borrow checker error in `reload_browse_page` when tag filter and count shared a borrow.
- Broken `trunc()` helper that prevented compilation after TUI rewrite.
- Browse table fixed at ~55 columns on wide terminals — now expands `task_id` column to fit.

## [0.1.0] - 2026-07-15

### Added

- Initial Rust CLI: `config`, `index`, `search`, `random`, `load`, `test`, `ask`, `list`.
- SQLite index with tags, difficulty, and full-text slug search.
- Python workspace generation (`README.md`, `solution.py`, `run_tests.py`, `.lc/meta.json`).
- LLM tutor via local OpenAI-compatible servers (Ollama) or Groq.
- Reference solution redaction — `completion` / `response` / `query` never deserialized.
- Named problem lists (create, add, remove, show, shuffle, export, import).
- Incremental indexing by file mtime.

[Unreleased]: https://github.com/amittenak47/leetcode-tui/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/amittenak47/leetcode-tui/releases/tag/v0.1.0
