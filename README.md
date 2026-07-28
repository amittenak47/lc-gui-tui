# lc — LeetCode practice harness

A Rust CLI and terminal UI for practicing LeetCode-style problems from **local JSON corpora**. Index thousands of problems into SQLite, browse and filter them interactively, generate Python workspaces, run tests, track session progress, and ask an LLM tutor for hints — **without ever loading or sending reference solutions** from the dataset.

Five problem sets are supported, each indexed into its own tables and switchable from a tab above the problem table. See [Datasets](#datasets).

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

## Datasets

`lc` does **not** ship problem data. It indexes JSON/JSONL files from folders you provide.

Each problem set lives in **its own SQLite tables**, because they are separate corpora: their ids collide (`two-sum` exists in three of them), their difficulty scales are unrelated, and rebuilding one must not touch another. A pass/fail badge is likewise per problem set.

| Slug | Corpus | Notes |
| --- | --- | --- |
| `leetcode` *(default)* | [newfacade/LeetCodeDataset](https://huggingface.co/datasets/newfacade/LeetCodeDataset) | ~2,869 Python problems. Already in `lc`'s field names. |
| `kodcode` | [KodCode/KodCode-V1](https://huggingface.co/datasets/KodCode/KodCode-V1) | 447k synthetic problems. Ships pytest suites, not per-case I/O — `Run tests` runs the suite. |
| `ms-python-q` | [morganstanley/sft-python-q-problems](https://huggingface.co/datasets/morganstanley/sft-python-q-problems) | LeetCode-style with structured `test_cases`. |
| `deepseek-leetcode` | [davidheineman/deepseek-leetcode](https://huggingface.co/datasets/davidheineman/deepseek-leetcode) | DeepSeek-Coder's contest benchmark. Cases are extracted from its assert suite. |
| `leetcode-with-tests` | [kr4t0n/leetcode-with-tests](https://huggingface.co/datasets/kr4t0n/leetcode-with-tests) | Community re-packaging; read through tolerant column-name candidates. |

Adapters that reshape each corpus into `lc`'s field names live in [`src/datasets/`](src/datasets/), one module per dataset, each documenting its column mapping.

### Folder layout

Each dataset reads `<data-dir>/<slug>/`. The default corpus also falls back to `<data-dir>` itself, so an existing single-corpus install keeps working with no changes.

```
~/lc-data/
├── train.json                 # leetcode (legacy location, still works)
├── leetcode/                  # …or here
├── kodcode/
├── ms-python-q/
├── deepseek-leetcode/
└── leetcode-with-tests/
```

Override a folder with `lc config set data.datasets.<slug> <path>` (or Settings → Datasets in the whiteboard).

### Download

Hugging Face ships most of these as Parquet, which the Rust indexer cannot read, so a helper converts them to `.jsonl` without touching the columns:

```bash
pip install -U huggingface_hub pyarrow
python scripts/fetch_dataset.py kodcode                 # one dataset
python scripts/fetch_dataset.py --all --data-dir ~/lc-data
```

Or download by hand into the folder above — `lc` accepts per-file JSON objects, JSON arrays (`train.json` / `test.json`), and `.jsonl`. If both `.json` and `.jsonl` exist for the same split, only the `.json` is indexed.

### Index

```bash
lc config set data-dir ~/lc-data
lc index                        # every dataset that has a corpus folder
lc index --dataset kodcode      # just one
lc index --rebuild              # full rebuild
lc datasets                     # what is indexed, and where each corpus lives
```

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
| **G** | Switch problem set (dataset) |
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
lc search --dataset kodcode -q "linked list"

# Materialize a workspace
lc load two-sum --open        # opens solution.py with cursor -r / code -r
lc load 1 --open              # by LeetCode question number
lc load running-max --dataset kodcode

# Test
lc test two-sum --verbose
lc test --case 3
lc test --full                # fallback assert suite from corpus
lc test running-max --dataset kodcode

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
| `lc index [--rebuild] [--dataset S]` | Build or refresh the SQLite index |
| `lc datasets` | Problem sets, indexed counts, and corpus folders |
| `lc search` | Filter problems (`--dataset`, `--difficulty`, `--tag`, `-q`, `--sort`) |
| `lc random` | Random pick (`-n`, `--dataset`, `--difficulty`, `--tag`) |
| `lc load <id> [--dataset S] [--open] [--force]` | Generate workspace; id = slug, question #, or prefix |
| `lc test [id] [--dataset S] [--case N] [--full] [-v]` | Run Python tests |
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

**Shared with the TUI:** the gear in the whiteboard edits the same `config.toml` (paths, datasets, test mode, Local/Ollama/OpenAI/Groq, vision model). Session queue / reset / random session use the same `session.json`. Prev/next walks the session queue when non-empty, otherwise the filtered problem bank. Open a problem from the TUI via **Open in Canvas** (deep link `?task=…&dataset=…`), **Open in IDE**, or stay in the TUI. Start/stop the local LLM (`ollama serve`) from Settings in either UI.

**Problem sets** are a tab strip above the table. Every table and session control works the same on any tab; filters reset when you switch, because a KodCode tag means nothing in the LeetCode tables. A tab with nothing indexed still appears, and its empty table tells you how to fetch that corpus.

**Run tests / Submit** open the results in a modal over the board. The same run is also posted into the coach thread as an `app` turn and attached to the next question on its own channel, so *"why did case 3 fail?"* needs no copy-paste — the daemon tells the model to read that channel as fact. Settings → Tests chooses between running every case and stopping at the first failure.

**Leaving a problem** asks what to keep, and asks a different question depending on whether it is solved:

| | layout | code | coach session |
| --- | --- | --- | --- |
| unsolved, **save** | resumes | resumes | resumes |
| unsolved, **discard** | cleared | reset to starter | cleared |
| solved, **save attempt** | archived | kept | archived |
| solved, **clear attempt** | cleared | reset to starter | archived |

The coach session is always saved once a problem is solved, and re-attempting a solved problem always starts from a fresh board and a fresh session — the rules live in [`src/attempt.rs`](src/attempt.rs).

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

`--lan` binds all interfaces and prints three short lines:

```
  Pair the tablet — type these into the app's header:
    Host: 192.168.1.20
    Port: 7878
    Code: 482917
```

In the app, tap the host name in the header and type those three. The code buys one `POST /pair`, which hands back the long token every later request carries; the token is stored locally, so pairing is a once-ever step per device. A new code is generated on every `lc serve --lan` start — devices already paired keep working, because they hold the token, not the code.

The QR and the full `http://192.168.1.20:7878?token=…` URL are still printed underneath for anyone who would rather scan or paste. Settings → Serve shows the current code too, so you don't have to go back to the terminal.

> `--lan` means anyone on your network holding the token can drive your workspaces. Prefer plain `lc serve` when you're at the desk.

Android:

```bash
cd app
npm run android:init      # tauri android init + the cleartext-HTTP overlay
npm run android:dev       # or: npm run android:apk  → sideloadable debug APK
```

`android:init` also applies [`app/src-tauri/android-overlay/network_security_config.xml`](app/src-tauri/android-overlay/network_security_config.xml) to the generated Gradle project — Android 9+ blocks the cleartext HTTP the daemon speaks on the LAN. Full sideload instructions (Android 12 / 14, `adb install`, unknown sources) are in [`app/README.md`](app/README.md).

### Modes

| Mode | What it does |
| --- | --- |
| **Review** | Draw, tap **Submit** → verdict, ratings, gaps, a Socratic question, and a counterexample citing one of the problem's real sample cases |
| **Ambient** | *Off.* The 60-second polling loop re-asked itself on slowly-changing boards and blocked the pen on local models. One flag (`AMBIENT_ENABLED` in `app/src/modes/AgentSidePanel.tsx`) brings it back |
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
curl "localhost:7878/datasets"
curl "localhost:7878/problems?difficulty=Easy&q=two-sum"
curl "localhost:7878/problems?dataset=kodcode&limit=5"
curl -X POST localhost:7878/problems/two-sum/load
curl -X POST localhost:7878/workspace/two-sum/test
curl -X POST localhost:7878/coach/review -H 'Content-Type: application/json' \
  -d '{"task_id":"two-sum","recognized_text":"sort, then two pointers inward"}'
```

| Route | Backed by |
| --- | --- |
| `GET /health` | Unauthenticated, so a client can find the daemon before pairing |
| `POST /pair` | Unauthenticated: six-digit session code in, serve token out (rate-limited) |
| `GET /datasets` | Problem sets and indexed counts, for the tab strip |
| `GET /problems?dataset=&difficulty=&tag=&q=&limit=&sort=` | `index::search` |
| `GET /problems/:id?dataset=` | Redacted problem detail |
| `POST /problems/:id/load?dataset=` | `generator::generate`, plus what a previous visit kept |
| `GET /workspace/:id/meta?dataset=` | `.lc/meta.json` |
| `POST /workspace/:id/test?dataset=` | `runner::cmd_test_quiet_in` → `CaseResult` JSON |
| `GET`/`PUT /workspace/:id/solution?dataset=` | Read/write `solution.py` |
| `GET`/`PUT /workspace/:id/agent?dataset=` | Read/write the coach transcript |
| `POST /workspace/:id/attempt?dataset=` | Save or discard on leaving — see `src/attempt.rs` |
| `POST /coach/review` | Mode A |
| `POST /coach/viz` | Diagram tool calls |
| `WS /coach/session` | Ambient loop |
| `POST /coach/reveal` | **Gated** — requires `"confirm_reveal": true` |

With `--lan`, every route except `/health` and `/pair` needs the token as an `X-LC-Token` header, or `?token=` for the WebSocket (browsers can't set headers on `WebSocket`).

### What the coach is not trusted with

The daemon **verifies cited test cases rather than trusting them**. When the coach cites a sample case, `lc` checks the index exists and overwrites the quoted input/expected with the corpus's own text, so a model that cites a real case but misquotes it cannot show you a fabricated one. A citation to a case that doesn't exist is dropped and reported.

This matters with small local models. Tested against `granite-4.1-8b` (llama.cpp): review, ambient, and the reveal bridge are solid; diagram tool calls needed schema tuning and remain hit-or-miss — point `llm.modes.viz` at a stronger model if diagrams matter to you.

---

## How it works

```
JSON corpora ─lc index──▶ SQLite (problems.db)
  per dataset                 │  problems, problems_kodcode, … (one table pair each)
                        lc load <id> --dataset <slug>
                              ▼
        ~/lc-workspace/[<dataset>/]<task_id>/
        ├── README.md
        ├── solution.py        ← you edit this
        ├── board.json         ← the whiteboard, when kept
        ├── run_tests.py
        └── .lc/
            ├── meta.json      ← cases, entry_point (no reference solution)
            ├── agent.json     ← coach transcript, when kept
            ├── attempt.json   ← solved / saved
            └── attempts/…     ← archived attempts
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
- The default corpus keeps `~/lc-workspace/<task_id>` so existing solve folders are found unchanged; other datasets are namespaced.

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
| Tablet gets `pair first` (401) | Re-pair with the Host/Port/Code from the `lc serve --lan` banner (or Settings → Serve) |
| `that code doesn't match` | The code rotates every `serve --lan` start — read the current one off the banner |
| Tablet connects on desktop but not Android | Cleartext HTTP — see `app/src-tauri/android-overlay/network_security_config.xml` |
| `produced nothing drawable` | Both the tool-call and JSON fallback came back empty; try `lc config set llm.modes.viz groq` |
| vLLM 400: `"auto" tool choice requires --enable-auto-tool-choice` | Handled — Draw falls back to plain JSON. Start vLLM with `--enable-auto-tool-choice --tool-call-parser <parser>` for the faster path |
| A dataset tab shows 0 problems | Download its corpus (`python scripts/fetch_dataset.py <slug>`) then `lc index --dataset <slug>` |
| A pass/fail badge is on the wrong problem | Fixed — progress is keyed `dataset/task_id`; older `session.json` files are migrated on load |
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

Problem corpus licensing is separate and differs per dataset — check each card before redistributing. [LeetCodeDataset](https://huggingface.co/datasets/newfacade/LeetCodeDataset) is Apache 2.0; [KodCode-V1](https://huggingface.co/datasets/KodCode/KodCode-V1) is CC BY-NC 4.0 (non-commercial).
