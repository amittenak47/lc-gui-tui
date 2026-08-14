<p align="center">
  <img src="docs/icons/icon-512.png" alt="lc" width="128">
</p>

# lc

A Rust CLI and terminal UI for practicing LeetCode-style problems from **local JSON corpora**. Index thousands of problems into SQLite, browse and filter them, generate Python workspaces, run tests, and ask an LLM tutor for hints — **without ever loading or sending reference solutions** from the dataset.

There is a second path: sketch the approach by hand on a tablet or desktop canvas while a coach watches, grills you, and points at the sample case your approach breaks on.

`5 problem sets` · `local or Groq` · `tablet or desktop` · `PolyForm Noncommercial`

---

## 0. Overview

| Surface | What it is |
| --- | --- |
| **CLI** | Index corpora, search, load workspaces, run tests, ask the tutor |
| **TUI** | Full-screen practice UI in the terminal (`lc` / `lc tui`) |
| **IDE** | Edit `solution.py` in Cursor or VS Code; optional LLM Autocorrect |
| **GUI** | Whiteboard app (`app/`) talking to `whiteboard serve` over HTTP/WS |

```
JSON corpora ─lc index──▶ SQLite (problems.db)
                              │
                        lc load <id>
                              ▼
        ~/lc-workspace/[<dataset>/]<task_id>/
        ├── solution.py
        ├── board.json          ← whiteboard, when kept
        ├── run_tests.py
        └── .lc/meta.json       ← cases / entry point (no reference solution)
                              │
                        whiteboard test · whiteboard ask · whiteboard serve → app/
```

---

## 1. Installation, dataset downloads, model config, and setup

**Needs:** Rust 1.75+, Python 3.10+, and for the whiteboard client Node 20+.

```bash
cargo install --path .
pip install -U huggingface_hub pyarrow

python scripts/fetch_dataset.py leetcode --data-dir ~/lc-data
# or: python scripts/fetch_dataset.py --all --data-dir ~/lc-data

lc config set data-dir ~/lc-data
lc index
lc                                  # TUI
```

Client internals, Android sideload, and cleartext-HTTP notes → [`app/README.md`](app/README.md).

### Model config

Point `lc` at any OpenAI-compatible endpoint (vLLM, llama.cpp, Ollama, LM Studio) or Groq:

```bash
lc config set llm.provider local
lc config set llm.local.base_url http://127.0.0.1:8000/v1
lc config set llm.local.model qwen3-vl-8b
lc config set llm.local.vision_model qwen3-vl-8b
```

API keys stay in the environment (`GROQ_API_KEY`, optional `LC_LOCAL_API_KEY`) — not in the TOML. Config path: `lc config path`.

---

## 2. TUI usage

```bash
lc                  # or: lc tui
```

On the browse screen:

| Key | Action |
| --- | --- |
| **W / S** (↑ / ↓) | Move selection |
| **A / D** | Previous / next page |
| **/** | Search |
| **G** | Cycle problem set |
| **T** / **E** | Cycle tag / difficulty |
| **O** | Cycle sort |
| **Enter** | Actions (load workspace, open in editor, run tests, send to whiteboard, …) |
| **Q** | Quit |

Coach chat in the TUI can play structure traces as an **ASCII morph** between keyframes (see [License and references](#7-license-and-references)).

---

## 3. IDE usage

Generate a workspace, then open it in Cursor or VS Code:

```bash
lc load two-sum --open
# or from the TUI action menu → open in editor
```

`lc` looks for `cursor` then `code` on your PATH (`-r` reuses a window). You edit `solution.py`; tests stay local:

```bash
lc test two-sum --verbose
lc ask two-sum --case 3        # tutor never sees corpus solutions
```

Pairs well with **[LLM Autocorrect](https://github.com/amittenak47/LLM-AutoCorrect)**: `lc` handles problem selection, workspaces, and testing; the extension fixes code as you type.

---

## 4. GUI usage

The canvas lives in [`app/`](app/). The corpus, workspaces, and Python runner stay on the PC behind `whiteboard serve`.

```bash
whiteboard serve --lan          # daemon (prints Host / Port / 6-digit Code)
cd app && npm install && npm run tauri dev
# Android APK: cd app && npm run android:apk
```

On desktop the app defaults to `http://127.0.0.1:7878` (no pairing). On a tablet, start with `--lan`, then enter **Host**, **Port**, and **Code** in the header.

**Review** — draw, tap **Submit**. Verdict, ratings, strengths, gaps, a Socratic question, and — when wrong — a counterexample citing a real sample case.

**Draw it** — diagram answer instead of prose (multi-frame traces share one scrubber).

**Reveal** — explicit, confirmed opt-in for a stepwise path from your approach; never a solution dump; logged in `lc stats`.

**Lazy** — turns a justified board into `solution.py` (earned steps implemented, the rest stubbed).

The agent answers over the session WebSocket, so each stage of a review — reading
the board, naming your approach, checking it against the cases — shows up in the
chat as it happens rather than after. It also sticks to **one approach per
board**: several approaches are usually valid, and an agent that quietly switches
between them contradicts its own advice. A change of board that changes the
answer is announced, with a reason.

Two extras are off until you turn them on in **Settings → Agent**: a **planner**
(`llm.modes.planner`, point it at a frontier model) that catalogs the approach
families a problem admits before the local agent reads your board, and a
**drawn-diagram check** that looks at each rendered diagram and redraws it once
if the picture does not show what it claims.

How the agent works, and why — redaction, diagrams as programs rather than
pictures, the approach commitment model, and the socket frame contract →
[`docs/coach.md`](docs/coach.md).

Browser-over-LAN, spacedesk, and Android build details → [`app/README.md`](app/README.md).

---

## 5. Commands

| Command | Purpose |
| --- | --- |
| `lc` / `lc tui` | Interactive practice UI |
| `lc index [--rebuild] [--dataset S]` | Build or refresh the SQLite index |
| `lc datasets [--inspect]` | Problem sets and indexed counts; `--inspect` reports corpus columns |
| `lc search` / `lc random` | Filter or pick (`--dataset`, `--difficulty`, `--tag`, `-q`, `--sort`) |
| `lc load <id> [--open] [--force]` | Generate a workspace; id = slug, question #, or prefix |
| `lc test [id] [--case N] [--full] [-v]` | Run Python tests — exits `0` when every case passes |
| `lc ask [id] [--case N] [--provider local\|groq]` | LLM debugging help |
| `whiteboard serve [--port N] [--lan]` | Daemon for the whiteboard client |
| `lc stats` · `lc session reset` · `lc list …` | Progress, session, named lists |
| `lc config set/get/show/path` | Manage `config.toml` |

Coach modes are per-provider (`llm.modes.<ambient\|review\|bridge\|viz\|planner>`) and
the coach feature flags are `coach.<ws_runs\|process_events_ui\|approach_commitment\|planner_enabled\|draw_review_enabled>`.

---

## 6. Datasets

| Slug | Hugging Face | What you get |
| --- | --- | --- |
| `leetcode` *(default)* | [newfacade/LeetCodeDataset](https://huggingface.co/datasets/newfacade/LeetCodeDataset) | ~2.9k Python LeetCode problems |
| `kodcode` | [KodCode/KodCode-V1](https://huggingface.co/datasets/KodCode/KodCode-V1) | Large synthetic set — `lc` indexes **Complete** style only |
| `ms-python-q` | [morganstanley/sft-python-q-problems](https://huggingface.co/datasets/morganstanley/sft-python-q-problems) | Structured `test_cases` |
| `deepseek-leetcode` | [davidheineman/deepseek-leetcode](https://huggingface.co/datasets/davidheineman/deepseek-leetcode) | DeepSeek contest benchmark |
| `leetcode-with-tests` | [kr4t0n/leetcode-with-tests](https://huggingface.co/datasets/kr4t0n/leetcode-with-tests) | Community pack with pytest-style checks |

```bash
python scripts/fetch_dataset.py <slug> --data-dir ~/lc-data
lc index --dataset <slug>
```

Adapters: [`src/datasets/`](src/datasets/). After adapter changes: `lc index --dataset <slug> --rebuild`.

---

## Upcoming changes

- Desktop scrolling page indicator
- Chat improvements
- Untether from LAN-only: today the app is semi-tethered to a local network where the runtime and LLM share the same LAN. Plan combinations of on-device-only (LLM maybe), remote, and local configs.
- Optional bundling of dataset + index with the app on device
- Optional hosting of the dataset in a remote location
- On-device Python interpreter when possible (for on-device testing)
- Optional remote runtime via microVM
- After the above: optionally enable the server on device

---

## 7. License and references

[PolyForm Noncommercial 1.0.0](https://polyformproject.org/licenses/noncommercial/1.0.0) — free for personal, educational, and other noncommercial use; commercial use needs a separate license. See [LICENSE](LICENSE).

Problem corpus licensing is separate and differs per dataset: [LeetCodeDataset](https://huggingface.co/datasets/newfacade/LeetCodeDataset) is Apache 2.0; [KodCode-V1](https://huggingface.co/datasets/KodCode/KodCode-V1) is CC BY-NC 4.0 (non-commercial).

Release notes: [CHANGELOG.md](CHANGELOG.md).

### References

- [ascii-morph](https://github.com/tholman/ascii-morph) (Tim Holman) — dissolve morph between ASCII stills; the TUI coach viz player is a Rust/ratatui take on that idea (`src/tui/ascii_morph.rs`)
- [LLM Autocorrect](https://github.com/amittenak47/LLM-AutoCorrect) — editor companion for fixing code as you type
