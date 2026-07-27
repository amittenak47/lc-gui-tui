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
| **Ollama / llama.cpp** *(optional)* | Local LLM tutor (`lc ask --provider local`) |
| **`GROQ_API_KEY`** *(optional)* | Cloud LLM tutor (`lc ask --provider groq`) |
| **Node 20+** *(whiteboard only)* | Build the canvas client in [`app/`](app/) |
| **Android SDK + NDK** *(tablet only)* | `npm run tauri android dev` |

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
| **Settings** | Paths, local LLM start/stop, session reset (same `config.toml` as GUI) |
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
| **Open in Canvas / IDE / stay in TUI** | Generate workspace; open whiteboard (`?task=`), Cursor/VS Code, or stay here |
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
| `lc serve [--port N] [--lan]` | Daemon for the whiteboard coach client |
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

## Whiteboard coach

Practice by *sketching* an approach by hand while a coach watches, grills you, and points at the specific test case your approach breaks on. The canvas runs on a tablet; the corpus, workspaces, and Python runner stay on this machine behind `lc serve`.

**Shared with the TUI:** the gear in the whiteboard edits the same `config.toml` (paths, Local/Ollama/OpenAI/Groq, vision model). Session queue / reset / random session use the same `session.json`. Prev/next walks the session queue when non-empty, otherwise the filtered problem bank. Open a problem from the TUI via **Open in Canvas** (deep link `?task=`), **Open in IDE**, or stay in the TUI. Start/stop the local LLM (`ollama serve`) from Settings in either UI.

Full client docs: **[`app/README.md`](app/README.md)**.

### Build and run

**1. Start the daemon** (loopback only — this is all you need on a desktop):

```bash
cargo run -- serve
```

**2. Build and launch the canvas** in a second terminal:

```bash
cd app && npm install && npm run tauri dev
```

That opens a desktop window pointed at `http://127.0.0.1:7878`. Validate the whole loop with a mouse here before touching Android.

To build release artifacts instead of running:

```bash
cargo build --release                 # the lc binary, including `lc serve`
cd app && npm run build               # typecheck + bundle the canvas to app/dist
cd app && npm run tauri build         # packaged desktop app
```

### Connecting a tablet

```bash
cargo run -- serve --lan
```

`--lan` binds all interfaces, generates a pairing token once, and prints it as a QR code plus a URL like `http://192.168.1.20:7878?token=…`. In the app, tap the host name in the header and paste that URL. The token is stored locally, so pairing is a once-ever step.

> `--lan` means anyone on your network holding the token can drive your workspaces. Prefer plain `lc serve` when you're at the desk.

Android:

```bash
cd app
npm run tauri android init
npm run tauri android dev
```

After `init`, copy [`app/src-tauri/android-overlay/network_security_config.xml`](app/src-tauri/android-overlay/network_security_config.xml) into the generated project — Android 9+ blocks the cleartext HTTP the daemon speaks on the LAN. Instructions are in that file.

### Modes

| Mode | What it does |
| --- | --- |
| **Review** | Draw, tap **Submit** → verdict, ratings, gaps, a Socratic question, and a counterexample citing one of the problem's real sample cases |
| **Ambient** | The coach glances every 15s, stays silent while nothing changes, and escalates rather than repeating itself. Replies land in a side panel, never on the canvas |
| **Draw it** | The coach answers with a diagram. Multi-frame traces are *one* diagram with a scrubber, not five copies of the same array |
| **Reveal** | Explicit, confirmed opt-in → a stepwise path from *your* approach to a working one. Never a solution dump; logged so `lc stats` shows how often you tapped out |

### Per-mode models

Each coach mode picks its own provider, so the cheap 15-second loop can stay local while deeper analysis goes to a stronger model:

```bash
lc config set llm.modes.ambient local    # runs every 15s — keep it cheap
lc config set llm.modes.review  groq     # deeper analysis on submit
lc config set llm.modes.bridge  local
lc config set llm.modes.viz     groq     # tool-calling for diagrams
```

All four default to `local`. Values are `local` or `groq`; the underlying URL/model come from `llm.local.*` / `llm.groq.*`.

### Daemon API

Useful for testing the coach without a tablet:

```bash
curl "localhost:7878/problems?difficulty=Easy&q=two-sum"
curl -X POST localhost:7878/problems/two-sum/load
curl -X POST localhost:7878/workspace/two-sum/test
curl -X POST localhost:7878/coach/review -H 'Content-Type: application/json' \
  -d '{"task_id":"two-sum","recognized_text":"sort, then two pointers inward"}'
```

| Route | Backed by |
| --- | --- |
| `GET /health` | Unauthenticated, so a client can find the daemon before pairing |
| `GET /problems?difficulty=&tag=&q=&limit=&sort=` | `index::search` |
| `GET /problems/:id` | Redacted problem detail |
| `POST /problems/:id/load` | `generator::generate` |
| `GET /workspace/:id/meta` | `.lc/meta.json` |
| `POST /workspace/:id/test` | `runner::cmd_test_quiet` → `CaseResult` JSON |
| `GET`/`PUT /workspace/:id/solution` | Read/write `solution.py` |
| `POST /coach/review` | Mode A |
| `POST /coach/viz` | Diagram tool calls |
| `WS /coach/session` | Ambient loop |
| `POST /coach/reveal` | **Gated** — requires `"confirm_reveal": true` |

With `--lan`, every route except `/health` needs the token as an `X-LC-Token` header, or `?token=` for the WebSocket (browsers can't set headers on `WebSocket`).

### What the coach is not trusted with

The daemon **verifies cited test cases rather than trusting them**. When the coach cites a sample case, `lc` checks the index exists and overwrites the quoted input/expected with the corpus's own text, so a model that cites a real case but misquotes it cannot show you a fabricated one. A citation to a case that doesn't exist is dropped and reported.

This matters with small local models. Tested against `granite-4.1-8b` (llama.cpp): review, ambient, and the reveal bridge are solid; diagram tool calls needed schema tuning and remain hit-or-miss — point `llm.modes.viz` at a stronger model if diagrams matter to you.

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
                              │
                        lc serve ──▶ HTTP + WS ──▶ whiteboard canvas (app/)
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
| `cannot bind 127.0.0.1:7878` | Another `lc serve` is running, or pick `--port` |
| Canvas says `cannot reach lc serve` | Start `lc serve`; on a tablet you need `--lan` and the same network |
| Tablet gets `pair first` (401) | Re-scan the QR from `lc serve --lan`, or `lc config get serve.token` |
| Tablet connects on desktop but not Android | Cleartext HTTP — see `app/src-tauri/android-overlay/network_security_config.xml` |
| `produced nothing drawable` | The `viz` model can't tool-call; try `lc config set llm.modes.viz groq` |
| Editor opens a new window | Rebuild latest `lc`; `load --open` uses `cursor -r` / `code -r` |
| TUI keystrokes duplicated | Fixed in recent builds (ignores key-repeat events) |
| Weird failures on tuple/list answers | `lc test --full` uses the corpus assert suite |

---

## Pairing with LLM Autocorrect

1. Run `lc load <id> --open` (or **Open in IDE** in the TUI).
2. Edit `solution.py` in Cursor with [LLM Autocorrect](https://github.com/amittenak47/LLM-AutoCorrect) enabled.
3. Run `lc test` or **Run tests** in the TUI.
4. On failure, use `lc ask --case N` or **AI overview** for coaching.

---

## Development

```bash
cargo build --release      # CLI, TUI, and the `lc serve` daemon
cargo test                 # includes the redaction-invariant tests
cargo clippy --all-targets
```

Whiteboard client:

```bash
cd app
npm install
npm test                   # renderers, capture, ambient loop, local-model fixtures
npm run build              # tsc --noEmit + vite build
cd src-tauri && cargo test  # Tauri shell
```

See [CHANGELOG.md](CHANGELOG.md) for release notes and [`app/README.md`](app/README.md) for client internals.

---

## License

[PolyForm Noncommercial 1.0.0](https://polyformproject.org/licenses/noncommercial/1.0.0) — free for personal, educational, and other noncommercial use; commercial use needs a separate license. See [LICENSE](LICENSE).

Problem corpus licensing is separate; see the [LeetCodeDataset](https://huggingface.co/datasets/newfacade/LeetCodeDataset) card (Apache 2.0).
