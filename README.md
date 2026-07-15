# lc — LeetCode practice harness

A Rust CLI and terminal UI for practicing LeetCode-style problems from a **local JSON corpus**. Index thousands of problems into SQLite, browse and filter them interactively, generate Python workspaces, run tests, track session progress, and ask an LLM tutor for hints — **without ever loading or sending reference solutions** from the dataset.

Pairs well with **[LLM Autocorrect](https://github.com/amittenak47/LLM-AutoCorrect)**: `lc` handles problem selection, workspaces, and testing; the extension fixes your code as you type in Cursor or VS Code.

---

## Quick start

1. **Install** the binary:

   ```bash
   git clone https://github.com/amittenak47/leetcode-tui.git
   cd leetcode-tui
   cargo install --path .
   ```

2. **Download the problem corpus** (see [Dataset](#dataset) below) into a folder, e.g. `~/lc-data/`.

3. **Configure** and **index**:

   ```bash
   lc config set data-dir ~/lc-data
   lc config set workspace ~/lc-workspace
   lc index
   ```

4. **Launch** the interactive UI (default when no subcommand is given):

   ```bash
   lc
   ```

   Or use the CLI directly:

   ```bash
   lc random --difficulty Medium --tag graph
   lc load two-sum --open
   lc test --verbose
   ```

---

## Requirements

| Requirement | Why |
| --- | --- |
| **Rust** (stable, 1.75+) | Build and run `lc` |
| **Python 3.10+** | Runs generated `run_tests.py` |
| **Cursor or VS Code** *(optional)* | Edit `solution.py`; `--open` reuses the current window |
| **Ollama** *(optional)* | Local LLM tutor (`lc ask --provider local`) |
| **`GROQ_API_KEY`** *(optional)* | Cloud LLM tutor (`lc ask --provider groq`) |

---

## Dataset

`lc` does **not** ship problem data. It indexes JSON files from a folder you provide.

The recommended corpus is **[LeetCodeDataset](https://huggingface.co/datasets/newfacade/LeetCodeDataset)** on Hugging Face (~2,869 Python problems). See the upstream [dataset README](https://huggingface.co/datasets/newfacade/LeetCodeDataset/blob/main/README.md) for citation and license details (Apache 2.0).

### Download

**Option A — Hugging Face CLI** (recommended):

```bash
pip install -U huggingface_hub
huggingface-cli download newfacade/LeetCodeDataset \
  --repo-type dataset \
  --local-dir ~/lc-data
```

**Option B — clone the dataset repo:**

```bash
git clone https://huggingface.co/datasets/newfacade/LeetCodeDataset ~/lc-data
```

**Option C — download individual files** from the [dataset files browser](https://huggingface.co/datasets/newfacade/LeetCodeDataset/tree/main) (`train.json`, `test.json`, etc.) into one folder.

### Point `lc` at the folder

`lc` accepts per-file JSON objects, **JSON arrays** (`train.json` / `test.json`), and `.jsonl` files. If both `.json` and `.jsonl` exist for the same split, only the `.json` is indexed.

```bash
lc config set data-dir ~/lc-data
lc index          # incremental — only changed files are re-read
lc index --rebuild   # full rebuild
```

After indexing, `lc search` and the TUI browse view should show your problem count (typically ~2,800+).

---

## Interactive TUI

Run `lc` with no arguments to open the menu-driven terminal UI.

### Main flow

| Menu | What it does |
| --- | --- |
| **Start new session** | Reset session counters; browse, randomize, or load a list |
| **Browse problems** | Paginated table of the full index |
| **Settings** | Config path, session reset |
| **Help** | CLI command reminders |

### Browse controls

| Key | Action |
| --- | --- |
| **W / S** | Move selection |
| **A / D** | Previous / next page (15 problems per page) |
| **/** | Text search (slug, question #, or tag) — **Enter** to apply |
| **T** | Cycle tag filter |
| **E** | Cycle difficulty (any → Easy → Medium → Hard) |
| **O** | Cycle sort order |
| **L** | Add highlighted problem to a named list |
| **R** | Random problem from **current filters** → add to a list |
| **I** | Jump to add-by-id |
| **Enter** | Open problem actions |
| **Esc** | Back · **Q** quit from main menu |

Columns resize to fit your terminal width.

### Problem actions

| Action | Description |
| --- | --- |
| **Work on problem** | Generate workspace and open `solution.py` in the **current** Cursor/VS Code window |
| **Run tests** | Execute `run_tests.py` and update session stats |
| **AI overview** | LLM tutoring summary (hints only, no full solution) |
| **View my solution** | Show your `solution.py` |
| **Submit locally** | Save pass/fail results to the local SQLite `submissions` table |
| **Add to list** | Append to a named problem list |

---

## CLI workflow

```bash
# Search and pick
lc search --difficulty Medium --tag "Dynamic Programming" --sort question
lc random -n 3 --tag graph

# Materialize a workspace
lc load two-sum --open        # opens solution.py with cursor -r / code -r
lc load 1 --open              # by LeetCode question number

# Test
lc test two-sum --verbose
lc test --case 3
lc test --full                # fallback assert suite from corpus

# Session stats
lc stats
lc stats --corpus
lc session reset

# Named lists
lc list create grind
lc list add grind two-sum 3
lc list show grind
lc list stats grind
```

`lc test` exits `0` when all cases pass, `1` otherwise — suitable for scripts.

`lc load` never overwrites an existing `solution.py` unless you pass `--force`.

---

## Commands

| Command | Purpose |
| --- | --- |
| `lc` / `lc tui` | Interactive practice UI |
| `lc config set/get/show/path` | Manage `config.toml` |
| `lc index [--rebuild]` | Build or refresh the SQLite index |
| `lc search` | Filter problems (`--difficulty`, `--tag`, `-q`, `--sort`) |
| `lc random` | Random pick (`-n`, `--difficulty`, `--tag`) |
| `lc load <id> [--open] [--force]` | Generate workspace; id = slug, question #, or prefix |
| `lc test [id] [--case N] [--full] [-v]` | Run Python tests |
| `lc ask [id] [--case N] [--provider local\|groq] [--clipboard]` | LLM debugging help |
| `lc stats [--corpus]` | Session or corpus progress |
| `lc session reset` | Clear session counters |
| `lc list …` | Create, add, remove, show, shuffle, export, import lists |
| `lc submit` | Stub (local submit is in the TUI) |

Config file path: `lc config path`  
(Windows: `%APPDATA%\lc\config.toml` · Linux/macOS: `~/.config/lc/config.toml`)

API keys are **not** stored in config — Groq reads `GROQ_API_KEY` from the environment.

---

## LLM tutor

### Local (Ollama, vLLM, LM Studio, …)

```bash
ollama pull qwen2.5-coder:7b
lc config set llm.provider local
lc config set llm.local.base_url http://localhost:11434/v1
lc config set llm.local.model qwen2.5-coder:7b
lc ask --case 3 --provider local
```

Set `LC_LOCAL_API_KEY` if your server requires a key.

### Groq (cloud)

```bash
export GROQ_API_KEY=gsk_...     # PowerShell: $env:GROQ_API_KEY = "gsk_..."
lc config set llm.provider groq
lc config set llm.groq.model llama-3.1-8b-instant
lc ask --case 3 --provider groq
```

### What the LLM sees (and does not)

**Sent:** problem statement, tags, difficulty, **your** `solution.py`, failing case I/O, traceback, debug output.

**Never sent:** corpus fields `completion`, `response`, and `query`. The `Problem` struct in [`src/problem.rs`](src/problem.rs) has no fields for them — serde drops them at parse time. They never reach the index, workspace, or prompts.

---

## How it works

```
JSON corpus ──lc index──▶ SQLite (problems.db)
                              │
                        lc load <id>
                              ▼
        ~/lc-workspace/<task_id>/
        ├── README.md
        ├── solution.py        ← you edit this
        ├── run_tests.py
        └── .lc/meta.json      ← cases, entry_point (no reference solution)
                              │
                        lc test ──▶ python run_tests.py ──▶ results table
                              │
                        lc ask  ──▶ redacted prompt ──▶ LLM tutor
```

- Templates in [`templates/`](templates/) are embedded at compile time (minijinja).
- Per-problem test data flows through `.lc/meta.json`; `run_tests.py` is static.
- Last test run is cached as `last_run.json` in the config dir for `lc ask`.

---

## Troubleshooting

| Problem | Try |
| --- | --- |
| `problem data dir not configured` | `lc config set data-dir <path>` then `lc index` |
| `no indexed problem matches` | Re-run `lc index` after adding or moving JSON files |
| `failed to launch "python"` | `lc config set python C:\Python312\python.exe` |
| `cannot reach the local LLM` | Start Ollama; check `lc config get llm.local.base_url` |
| `GROQ_API_KEY is not set` | Export the key or use `--provider local` |
| Editor opens a new window | Rebuild latest `lc`; `load --open` uses `cursor -r` / `code -r` |
| TUI keystrokes duplicated | Fixed in recent builds (ignores key-repeat events) |
| Weird failures on tuple/list answers | `lc test --full` uses the corpus assert suite |

---

## Pairing with LLM Autocorrect

1. Run `lc load <id> --open` (or **Work on problem** in the TUI).
2. Edit `solution.py` in Cursor with [LLM Autocorrect](https://github.com/amittenak47/LLM-AutoCorrect) enabled.
3. Run `lc test` or **Run tests** in the TUI.
4. On failure, use `lc ask --case N` or **AI overview** for coaching.

---

## Development

```bash
cargo build --release
cargo test
```

See [CHANGELOG.md](CHANGELOG.md) for release notes.

---

## License

[PolyForm Noncommercial 1.0.0](https://polyformproject.org/licenses/noncommercial/1.0.0) — free for personal, educational, and other noncommercial use; commercial use needs a separate license. See [LICENSE](LICENSE).

Problem corpus licensing is separate; see the [LeetCodeDataset](https://huggingface.co/datasets/newfacade/LeetCodeDataset) card (Apache 2.0).
