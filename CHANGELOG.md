# Changelog

All notable changes to `lc` are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

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
