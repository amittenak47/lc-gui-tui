<p align="center">
  <img src="docs/icons/icon-512.png" alt="Whiteboard" width="128">
</p>

# Whiteboard

A Rust CLI and terminal UI for practicing LeetCode-style problems from **local JSON corpora**. Index thousands of problems into SQLite, browse and filter them, generate Python workspaces, run tests, and ask an LLM tutor for hints — **without ever loading or sending reference solutions** from the dataset.

There is a second path: sketch the approach by hand on a tablet or desktop canvas while an agent watches, grills you, and points at the sample case your approach breaks on.

`5 problem sets` · `local or Groq` · `tablet or desktop` · `PolyForm Noncommercial`

---

## 0. Overview

| Surface | What it is |
| --- | --- |
| **CLI** | Index corpora, search, load workspaces, run tests, ask the tutor |
| **TUI** | Full-screen practice UI in the terminal (`lc` / `lc tui`) |
| **IDE** | Edit `solution.py` in Cursor or VS Code; optional LLM Autocorrect |
| **GUI** | Whiteboard app (`app/`). Desktop and APK run an in-process axum router — no TCP bind, no `127.0.0.1:7878` daemon |

```
JSON corpora ─whiteboard index──▶ SQLite (problems.db)
                              │
                        whiteboard load <id>
                              ▼
        ~/lc-workspace/[<dataset>/]<task_id>/
        ├── solution.py
        ├── board.json          ← whiteboard, when kept
        ├── run_tests.py
        └── .lc/meta.json       ← cases / entry point (no reference solution)
                              │
                        whiteboard test · whiteboard ask · GUI (in-process daemon)
```

The crate stays `whiteboard`; the CLI binary is `lc`. Config still lives under the OS project dir named `lc` (`lc config path`). Workspace and data defaults (`~/lc-workspace`, `~/lc-data`) and env vars (`GROQ_API_KEY`, `LC_LOCAL_API_KEY`, `OPENAI_API_KEY`) are unchanged.

---

## 1. Installation, dataset downloads, model config, and setup

**Needs:** Rust 1.93+, and for the whiteboard client Node 20+. Tests run in-process via RustPython (no CPython). Dataset fetch scripts still use Python.

```bash
cargo install --path .
pip install -U huggingface_hub pyarrow

python scripts/fetch_dataset.py leetcode --data-dir ~/lc-data
# or: python scripts/fetch_dataset.py --all --data-dir ~/lc-data

whiteboard config set data-dir ~/lc-data
whiteboard index
lc                            # TUI
```

Client internals, Android sideload, and cleartext-HTTP notes → [`app/README.md`](app/README.md).

### Model config

Point `whiteboard` at any OpenAI-compatible endpoint (vLLM, llama.cpp, Ollama, LM Studio) or Groq:

```bash
whiteboard config set llm.provider local
whiteboard config set llm.local.base_url http://127.0.0.1:8000/v1
whiteboard config set llm.local.model qwen3-vl-8b
whiteboard config set llm.local.vision_model qwen3-vl-8b
```

API keys stay in the environment (`GROQ_API_KEY`, optional `LC_LOCAL_API_KEY`) — not in the TOML. Config path: `whiteboard config path`.

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
whiteboard load two-sum --open
# or from the TUI action menu → open in editor
```

`whiteboard` looks for `cursor` then `code` on your PATH (`-r` reuses a window). You edit `solution.py`; tests stay local:

```bash
whiteboard test two-sum --verbose
whiteboard ask two-sum --case 3        # tutor never sees corpus solutions
```

Pairs well with **[LLM Autocorrect](https://github.com/amittenak47/LLM-AutoCorrect)**: `whiteboard` handles problem selection, workspaces, and testing; the extension fixes code as you type.

---

## 4. GUI usage

The canvas lives in [`app/`](app/). The desktop window **is** the router: Tauri holds axum in-process (no TCP bind) and runs tests with RustPython. There is no separate `lc serve` step.

Landing is a home chooser: **Practice** (corpus + tests), **Whiteboard**, **Annotate**. Back from a session returns home, not the problem table. Hide Practice with `VITE_FEATURE_LEETCODE=0` (frontend) and a pads-only Tauri build (`--no-default-features`, omits the `leetcode` Cargo feature / RustPython).

```bash
cd app && npm install && npm run tauri dev
# Android APK: cd app && npm run android:apk
```

Use the Tauri app (`npm run tauri dev`) or the Android APK — Vite-only (`npm run dev`) in a browser is not a supported path. LLM config is **Settings → LLM**. `localhost` there is this machine.

**Review** — draw, tap **Submit**. Verdict, ratings, strengths, gaps, a Socratic question, and — when wrong — a counterexample citing a real sample case.

**Draw it** — diagram answer instead of prose (multi-frame traces share one scrubber).

**Reveal** — explicit, confirmed opt-in for a stepwise path from your approach; never a solution dump; logged in `whiteboard stats`.

**Lazy** — turns a justified board into `solution.py` (earned steps implemented, the rest stubbed).

The agent answers over Tauri events (`lc-coach-frame`), so each stage of a review — reading
the board, naming your approach, checking it against the cases — shows up in the
chat as it happens rather than after. It also sticks to **one approach per
board**: several approaches are usually valid, and an agent that quietly switches
between them contradicts its own advice. A change of board that changes the
answer is announced, with a reason.

Two extras are off until you turn them on in **Settings → AI Behavior**: a **planner**
(`llm.modes.planner`, point it at a frontier model) that catalogs the approach
families a problem admits before the local agent reads your board, and a
**drawn-diagram check** that looks at each rendered diagram and redraws it once
if the picture does not show what it claims.

How the agent works: redaction, diagrams as programs rather than pictures, the
approach commitment model, and the coach frame contract live under
`src/llm/coach/` (HTTP routes stay `/coach/*`; the GUI delivers frames via Tauri events).

spacedesk and Android build details → [`app/README.md`](app/README.md).
Older Android notes → [`app/docs/ANDROID_SETUP.md`](app/docs/ANDROID_SETUP.md).

---

## Where the work lives

Three layers. They move independently.

| Layer | What | Where (this branch) | “Anywhere” means |
| --- | --- | --- | --- |
| **Pad UI** | Canvas, ink, footnotes | Device (`app/`) | Already on the device |
| **Agent / LLM** | Chat HTTP | Same process as the GUI daemon, then out to the model URL | The model URL must be reachable from this machine |
| **Daemon extras** | Corpus, `solution.py`, RustPython tests, document index | Inside the GUI process (in-process axum) | Workspaces + `problems.db` on this machine |

The desktop GUI embeds the daemon. Tests are RustPython in-process, not a `python` executable. The stripped sibling branch below is a different product (Ask-only, no corpus).

```mermaid
flowchart LR
  subgraph gui [Desktop_GUI]
    UI[Pad_UI]
    Axum[in_process_axum]
    RP[RustPython]
    Corpus[SQLite_corpus]
    WS[lc_workspace]
    UI -->|"HTTP_WS loopback"| Axum
    Axum --> RP
    Axum --> Corpus
    Axum --> WS
    Axum -->|"chat completions"| LLM[Ollama_Groq_OpenAI]
  end
```

### Problems vs pads vs offline pack

```mermaid
flowchart TD
  subgraph pads [Pads_always_local]
    WB[Whiteboard_IndexedDB]
    AN[Annotate_IndexedDB]
  end
  subgraph problems [Problems]
    Online[Online_loadProblem]
    Offline[Offline_pack_IndexedDB]
    Online --> Workspace[lc-workspace]
    Offline --> ReadOnly[Read_statement_and_draw]
    Workspace --> Tests[Run_tests]
  end
```

| Surface | Offline | Sync |
| --- | --- | --- |
| **Whiteboard / annotate** | Full. Working copy is IndexedDB on the device. | Dual-write to the daemon (`pads.db` + `pad-blobs/`). Tombstone hides a pad on every device that shares that daemon; snapshots and PDF bytes stay with it. Sidecar `.lc-ink.json` is backup, not the sync path. |
| **Problems (online)** | Autosave parks the board in IndexedDB when the daemon is down. | Same machine as the GUI daemon shares `~/lc-workspace`. On reconnect, Personalise `offlineMerge` (ask / prefer-local / prefer-server) decides which board wins. |
| **Problems (offline pack)** | Settings can download statements (~100–250 MB). Browse and open a local board. Tests and coach need the in-process daemon (and a configured LLM for coach). | Same merge pref as above once the daemon is up. |

Tests run in-process via RustPython (`src/workspace/runner.rs`). Coach Review (perceive → claim → verdict) always runs inside the daemon.

### Pad library vs sidecar

The device IndexedDB is the working copy. The daemon’s `pads.db` is a redundant historical copy: a missing or corrupt local row must not delete the on-disk copy. Delete is hold-to-confirm and only tombstones the live list; restore from archive or from the 2h / 24h / 7d snapshots.

Personalise (handedness, theme, capture folder, …) is a **per-device** blob on the daemon.

### Desktop, browser, Android

Same React client. Desktop Tauri and the APK both start the harness router in-process — no separate daemon process and no LAN pairing. Vite-in-Chrome (`npm run dev` in a browser) is not supported.

To drive the *desktop* window from a tablet, use **spacedesk** (pixels only).

### Fully untethered LeetCode (remaining gaps)

The judge is already in the binary (RustPython). What is not done:

1. **LLM** — Groq/OpenAI, or a local llama.cpp URL this machine can reach.
2. **Corpus on device** — index + workspaces are still files on this machine; the offline pack is statements only.
3. **APK size** — embedding the daemon + VM is a later packaging pass.

### Stripped branch (whiteboard + documents)

[`claude/strip-harness-ask-tauri-jeebbu`](https://github.com/amittenak47/lc-gui-tui/tree/claude/strip-harness-ask-tauri-jeebbu) is a **sibling product**, not a merge. No corpus, no RustPython runner, no problem browser. This tree gates Practice with `VITE_FEATURE_LEETCODE` + Cargo `leetcode` instead of forking.

Tauri depends on the crate with `default-features = false`: **agent in the APK**, no axum. Ask talks to `llm.local.base_url` from the device (Tailscale llama.cpp, or Groq). Browser builds still have no Tauri, so they still need a small daemon for Ask.

**Staged Review is gone there.** Ask is one model call. Draw/Viz still has a tool loop (diagrams), which is not perceive → claim → verdict.

Do not merge the two products. Main stays the harness.

---

## 5. Commands

| Command | Purpose |
| --- | --- |
| `lc` / `lc tui` | Interactive practice UI |
| `whiteboard index [--rebuild] [--dataset S]` | Build or refresh the SQLite index |
| `whiteboard datasets [--inspect]` | Problem sets and indexed counts; `--inspect` reports corpus columns |
| `whiteboard search` / `whiteboard random` | Filter or pick (`--dataset`, `--difficulty`, `--tag`, `-q`, `--sort`) |
| `whiteboard load <id> [--open] [--force]` | Generate a workspace; id = slug, question #, or prefix |
| `whiteboard test [id] [--case N] [--full] [-v]` | Run tests via RustPython — exits `0` when every case passes |
| `whiteboard ask [id] [--case N] [--provider local\|groq]` | LLM debugging help |
| `whiteboard stats` · `whiteboard session reset` · `whiteboard list …` | Progress, session, named lists |
| `whiteboard config set/get/show/path` | Manage `config.toml` |

Coach modes are per-provider (`llm.modes.<ambient\|review\|bridge\|viz\|planner>`) and
the coach feature flags are `coach.<ws_runs\|process_events_ui\|approach_commitment\|planner_enabled\|draw_review_enabled>`. Those TOML keys are unchanged.

---

## 6. Datasets

| Slug | Hugging Face | What you get |
| --- | --- | --- |
| `leetcode` *(default)* | [newfacade/LeetCodeDataset](https://huggingface.co/datasets/newfacade/LeetCodeDataset) | ~2.9k Python LeetCode problems |
| `kodcode` | [KodCode/KodCode-V1](https://huggingface.co/datasets/KodCode/KodCode-V1) | Large synthetic set — `whiteboard` indexes **Complete** style only |
| `ms-python-q` | [morganstanley/sft-python-q-problems](https://huggingface.co/datasets/morganstanley/sft-python-q-problems) | Structured `test_cases` |
| `deepseek-leetcode` | [davidheineman/deepseek-leetcode](https://huggingface.co/datasets/davidheineman/deepseek-leetcode) | DeepSeek contest benchmark |
| `leetcode-with-tests` | [kr4t0n/leetcode-with-tests](https://huggingface.co/datasets/kr4t0n/leetcode-with-tests) | Community pack with pytest-style checks |

```bash
python scripts/fetch_dataset.py <slug> --data-dir ~/lc-data
whiteboard index --dataset <slug>
```

Adapters: [`src/datasets/`](src/datasets/). After adapter changes: `whiteboard index --dataset <slug> --rebuild`.

---

## Upcoming changes

- Desktop scrolling page indicator
- Chat improvements
- Optional corpus bundle / hosted dataset (see [Where the work lives](#where-the-work-lives))

---

## 7. License and references

[PolyForm Noncommercial 1.0.0](https://polyformproject.org/licenses/noncommercial/1.0.0) — free for personal, educational, and other noncommercial use; commercial use needs a separate license. See [LICENSE](LICENSE).

Problem corpus licensing is separate and differs per dataset: [LeetCodeDataset](https://huggingface.co/datasets/newfacade/LeetCodeDataset) is Apache 2.0; [KodCode-V1](https://huggingface.co/datasets/KodCode/KodCode-V1) is CC BY-NC 4.0 (non-commercial).

Release notes: [CHANGELOG.md](CHANGELOG.md).

### References

- [ascii-morph](https://github.com/tholman/ascii-morph) (Tim Holman) — dissolve morph between ASCII stills; the TUI coach viz player is a Rust/ratatui take on that idea (`src/tui/ascii_morph.rs`)
- [LLM Autocorrect](https://github.com/amittenak47/LLM-AutoCorrect) — editor companion for fixing code as you type
