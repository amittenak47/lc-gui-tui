# lc — LeetCode CLI harness

A standalone Rust CLI that turns a local folder of 3000+ LeetCode-style problem
JSON files into a practice environment:

- **Index** the corpus into SQLite for instant search / random pick / lists
- **Load** a problem into a Python workspace (`README.md`, `solution.py`, `run_tests.py`)
- **Test** your solution per-case via a Python subprocess, results rendered in the terminal
- **Ask** an LLM tutor (local Qwen via Ollama, or Groq cloud) why a case fails —
  the corpus's reference solutions are **never** loaded, written, or sent anywhere

It complements the LLM Autocorrect extension in the parent repo: the extension
fixes your code line-by-line while you type; `lc` handles everything around it.

## Prerequisites

| Requirement | Why |
|---|---|
| Rust toolchain (stable, 1.75+) | Build the `lc` binary |
| Python 3.10+ on PATH (or configured) | Executes the generated `run_tests.py` |
| Ollama with a Qwen model *(optional)* | `lc ask --provider local` |
| `GROQ_API_KEY` env var *(optional)* | `lc ask --provider groq` |

## Build

```bash
cd lc
cargo build --release          # binary at target/release/lc(.exe)
# or install onto PATH:
cargo install --path .
```

`cargo test` runs the unit tests, including the redaction test that proves the
`completion` / `response` / `query` fields can never be deserialized.

## First-time setup

```bash
lc config set data-dir "D:\path\to\leetcode-json"   # folder with the JSON files
lc config set workspace "~/lc-workspace"            # where problems materialize (default)
lc config set python python                         # or a full path to python.exe
lc config set llm.provider local                    # or groq
lc index                                            # build the SQLite index (incremental after that)
```

Config lives at the path printed by `lc config path`
(on Windows: `%APPDATA%\lc\config.toml`). API keys are **never** stored in it —
Groq reads `GROQ_API_KEY` from the environment.

## Daily workflow

```bash
lc random --difficulty Medium --tag "Graph"
lc load shortest-distance-after-road-addition-queries-i --open
# ... edit solution.py in Cursor (autocorrect extension active) ...
lc test --verbose        # run every case, tracebacks for failures
lc test --case 8         # re-run just case 8
lc ask --case 8          # tutor hint from the default provider
lc ask --case 8 --provider groq
lc ask --clipboard       # copy the redacted prompt for Cursor chat instead
```

`lc test` exits 0 when everything passes, 1 otherwise, so it works in scripts.
`lc load` never overwrites an existing `solution.py` unless you pass `--force`.

## Commands

| Command | Purpose |
|---|---|
| `lc config set/get/show/path` | Manage `config.toml` |
| `lc index [--rebuild]` | Build/refresh the SQLite index (mtime-incremental) |
| `lc search [--difficulty] [--tag] [-q slug]` | Filter problems |
| `lc random [-n N] [--difficulty] [--tag]` | Random pick(s) |
| `lc load <id> [--open] [--force]` | Materialize a workspace; `<id>` = slug, question #, or unique prefix |
| `lc test [id] [--case N] [--full] [-v]` | Run tests (cwd workspace when `id` omitted) |
| `lc ask [id] [--case N] [--provider local\|groq] [--clipboard]` | LLM debugging help |
| `lc list create/add/remove/show/shuffle/export/import/ls/delete` | Named problem lists |
| `lc submit` | Stub — prints "not implemented" |

## LLM setup

### Local (Qwen on your GPU)

Works with any OpenAI-compatible server — Ollama, vLLM, LM Studio:

```bash
ollama pull qwen2.5-coder:7b
ollama serve                      # usually already running as a service
lc config set llm.local.base_url http://localhost:11434/v1
lc config set llm.local.model qwen2.5-coder:7b
lc ask --case 3 --provider local
```

If your server requires a key, set `LC_LOCAL_API_KEY` in the environment.

### Groq (cloud)

```bash
set GROQ_API_KEY=gsk_...          # PowerShell: $env:GROQ_API_KEY = "gsk_..."
lc config set llm.groq.model llama-3.1-8b-instant
lc ask --case 3 --provider groq
```

### What the LLM sees (and doesn't)

Sent: problem statement, tags/difficulty, **your** current `solution.py`, the
failing case's input/expected/actual, the traceback, and your debug prints.
Never sent: the corpus's `completion`, `response`, and `query` fields — the
`Problem` struct in [src/problem.rs](src/problem.rs) simply has no fields for
them, so serde drops them at parse time; they never reach the index, the
workspace, or a prompt. The system prompt additionally instructs the tutor to
coach without writing full solutions.

## How the pieces fit

```
JSON corpus ──lc index──▶ SQLite (problems.db, lists)
                              │
                        lc load <id>
                              ▼
        ~/lc-workspace/<task_id>/
        ├── README.md          statement + sample cases
        ├── solution.py        prompt + starter code (yours to edit)
        ├── run_tests.py       static Python runner
        └── .lc/meta.json      entry_point, cases, assert suite, source path
                              │
                        lc test ──▶ python run_tests.py ──▶ JSON lines ──▶ table
                              │
                        lc ask ──▶ redacted prompt ──▶ Ollama/Groq ──▶ tutor answer
```

Implementation notes:

- Templates in [templates/](templates/) are embedded into the binary at compile
  time and rendered with **minijinja** (chosen over askama so the Python
  template's braces need no escaping; the run_tests.py "template" is actually
  static — all per-problem data flows through `.lc/meta.json`).
- The test runner parses case inputs like `n = 7, queries = [[0,5]]` with
  Python's `ast` module (no arbitrary `eval` of inputs). When a problem's cases
  can't be parsed that way (e.g. linked-list helpers), `lc test --full` runs the
  original assert suite from the JSON's `test` field as a fallback — that also
  happens automatically when a problem has no `input_output` cases.
- The last run's results are cached in the config dir (`last_run.json`) so
  `lc ask` knows which cases failed without re-running anything.

## Troubleshooting

- **`failed to launch "python"`** — point at your interpreter:
  `lc config set python C:\Python312\python.exe`
- **`cannot reach the local LLM`** — start Ollama (`ollama serve`) and make sure
  the model is pulled; check `lc config get llm.local.base_url`
- **`GROQ_API_KEY is not set`** — export the key or switch `--provider local`
- **`no indexed problem matches`** — run `lc index` after adding/moving JSON files
- **Weird per-case failures on list-of-tuple answers** — outputs are normalized
  (tuples → lists, float tolerance 1e-6); if a problem accepts any-order answers,
  use `lc test --full`, which uses the problem's own assert logic

## Out of scope (v1)

- Submitting to leetcode.com (`lc submit` is a stub)
- Non-Python solution languages
- Importing lists from leetcode.com URLs (no stable public API)
