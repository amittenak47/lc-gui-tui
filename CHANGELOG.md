# Changelog

All notable changes to `lc` are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

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
