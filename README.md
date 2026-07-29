# lc — LeetCode practice harness

**Sketch an approach by hand. Run real tests. Ask a local coach — without ever sending a reference solution.**

A Rust CLI / TUI plus a stylus-first whiteboard app. Index local JSON corpora into SQLite, browse and filter problems, generate Python workspaces, run tests, track a practice session, and talk to an LLM tutor that only sees *your* board and *your* code.

Pairs with **[LLM Autocorrect](https://github.com/amittenak47/llm-autocorrect)**: `lc` picks the problem and runs the tests; the extension fixes typos as you type in Cursor or VS Code.

<!-- Drop a short demo under docs/demo/ and uncomment:
![lc demo](docs/demo/lc-demo.gif)
or embed an MP4: <video src="docs/demo/lc-demo.mp4" controls width="720"></video>
-->

---

## Features

| Feature | Summary |
| --- | --- |
| **Five problem sets** | Switch corpora from a tab strip — LeetCode, KodCode, MS Python-Q, DeepSeek LC, LC-with-tests. Each has its own SQLite tables and pass/fail badges. |
| **Whiteboard coach** | Excalidraw-style board on desktop or Android tablet. Sketch Approach / Complexity / Walkthrough; the coach reviews, cites real sample cases, and can draw diagrams. |
| **TUI + CLI** | Terminal browser (WASD / filters) and scriptable `lc load` / `lc test` / `lc ask` for keyboard-first practice. |
| **Local-first LLM** | OpenAI-compatible endpoint (vLLM, llama.cpp, Ollama, LM Studio) or Groq. Reference solutions in the corpus never reach the model. |
| **Session queue** | Start / Random builds a practice queue; hold-to-confirm when leaving so you don't wipe a board by accident. |
| **Tablet pairing** | `lc serve --lan` prints Host / Port / Code once; the app keeps a token after that. |

---

## My setup (what this README assumes)

This is the loop I actually use day to day. Yours can be simpler (desktop-only + Ollama).

| Piece | What I run |
| --- | --- |
| **PC** | Windows 11, Rust + Node, corpus under `~/lc-data` (WSL) / `C:\Users\…\lc_harness\data` |
| **Coach model** | [IBM Granite 4.1 8B](https://huggingface.co/ibm-granite/granite-4.1-8b) behind an OpenAI-compatible server on `localhost` |
| **Serving** | **vLLM** in WSL2 with **CUDA 12.8** (`CUDA_HOME=/usr/local/cuda-12.8`) — older system `nvcc` (10.x) breaks FlashInfer |
| **Tablet** | Android stylus tablet (XPPen Magic Note Pad) running the Tauri APK, paired over LAN to `lc serve --lan` |
| **Editor** | Cursor + [LLM Autocorrect](https://github.com/amittenak47/llm-autocorrect) when I leave the board and finish `solution.py` |

```
┌─ Android tablet (Tauri app) ─┐          ┌─ Windows PC ─────────────────────┐
│  Whiteboard + coach chat      │◄── LAN ──►│  lc serve                        │
│  Pair once with Host/Port/Code│          │  SQLite index · workspaces · tests│
└───────────────────────────────┘          │  → WSL: vLLM (Granite 4.1 8B)    │
                                           └───────────────────────────────────┘
```

Point `lc` at the model (Settings in the app, or CLI):

```bash
lc config set llm.provider local
lc config set llm.local.base_url http://127.0.0.1:8000/v1   # your vLLM / llama.cpp port
lc config set llm.local.model granite-4.1-8b                # whatever id the server exposes
```

Ollama instead:

```bash
ollama pull granite4:8b   # or qwen2.5-coder:7b, …
lc config set llm.local.base_url http://localhost:11434/v1
lc config set llm.local.model granite4:8b
```

---

## Quick start

### 1. Install

```bash
git clone https://github.com/amittenak47/leetcode-tui.git
cd leetcode-tui
cargo install --path .
```

Needs **Rust** (1.75+), **Python 3.10+**, and for the whiteboard: **Node 20+**.

### 2. Download problem data

`lc` does **not** ship problems. Fetch Hugging Face corpora to JSONL:

```bash
pip install -U huggingface_hub pyarrow
python scripts/fetch_dataset.py --all --data-dir ~/lc-data
# or one set:  python scripts/fetch_dataset.py kodcode --data-dir ~/lc-data
```

### 3. Index and configure

```bash
lc config set data-dir ~/lc-data
lc config set workspace ~/lc-workspace
lc index
lc datasets          # confirm counts per tab
```

### 4. Practice

**Terminal UI** (default):

```bash
lc
```

**Whiteboard on the PC** (validate with a mouse first):

```bash
# terminal 1
lc serve

# terminal 2
cd app && npm install && npm run tauri dev
```

**Tablet on the LAN**:

```bash
lc serve --lan
# type the printed Host / Port / Code into the app header once
cd app && npm run android:apk    # then adb install the debug APK
```

---

## Datasets

Each corpus lives under `<data-dir>/<slug>/` and gets its **own** SQLite tables (ids collide across sets).

| Slug | Hugging Face | What you get |
| --- | --- | --- |
| `leetcode` *(default)* | [newfacade/LeetCodeDataset](https://huggingface.co/datasets/newfacade/LeetCodeDataset) | ~2.9k Python LeetCode problems |
| `kodcode` | [KodCode/KodCode-V1](https://huggingface.co/datasets/KodCode/KodCode-V1) | Large synthetic set — `lc` indexes **Complete** style only (~168k after skipping Instruct / online_judge) |
| `ms-python-q` | [morganstanley/sft-python-q-problems](https://huggingface.co/datasets/morganstanley/sft-python-q-problems) | Structured `test_cases` |
| `deepseek-leetcode` | [davidheineman/deepseek-leetcode](https://huggingface.co/datasets/davidheineman/deepseek-leetcode) | DeepSeek contest benchmark; asserts → cases |
| `leetcode-with-tests` | [kr4t0n/leetcode-with-tests](https://huggingface.co/datasets/kr4t0n/leetcode-with-tests) | Community pack with pytest-style checks |

Adapters: [`src/datasets/`](src/datasets/). Inspect what a download actually contains:

```bash
lc datasets --inspect
lc index --dataset kodcode --rebuild   # after adapter changes
```

**KodCode note:** tags like `Algorithm, Complete` are seed family + style, not LeetCode topics. `Instruct` and `online_judge` rows are skipped at index time so the harness stays pytest-shaped.

Corpus licenses differ (e.g. LeetCodeDataset Apache-2.0, KodCode-V1 CC BY-NC 4.0). Check each card before redistributing.

---

## Whiteboard coach (short)

| Mode | What it does |
| --- | --- |
| **On ask** | You send a message; optionally attach **Review board** (region thumbnails + structure) or **Draw** (ask for a diagram). |
| **Copy / Quote** | Long-press or right-click a coach message → copy the bubble or quote it into the composer. |
| **Reveal** | Hold-to-confirm bridge from *your* approach toward a working one — never a silent solution dump. |
| **Ambient** | Off by default (`AMBIENT_ENABLED` in the client). |

Full tablet / Android / cleartext-HTTP notes: **[`app/README.md`](app/README.md)**.

---

## CLI cheatsheet

```bash
lc search --difficulty Medium --tag graph
lc random -n 3 --tag "Dynamic Programming"
lc load two-sum --open          # workspace + Cursor/VS Code
lc test two-sum --verbose
lc ask --case 3 --provider local
lc stats
lc serve --lan                  # tablet daemon
```

| Command | Purpose |
| --- | --- |
| `lc` / `lc tui` | Interactive practice UI |
| `lc index [--dataset S] [--rebuild]` | Build SQLite index |
| `lc datasets [--inspect]` | Counts + corpus column report |
| `lc load <id> [--dataset S] [--open]` | Generate workspace |
| `lc test [id] [-v] [--full]` | Run `run_tests.py` |
| `lc ask` | LLM help on a failing case |
| `lc serve [--lan] [--port N]` | Whiteboard daemon |

Config path: `lc config path`  
(Windows: `%APPDATA%\lc\config\config.toml` · Linux/macOS: `~/.config/lc/config.toml`)

API keys stay in the environment (`GROQ_API_KEY`, optional `LC_LOCAL_API_KEY`) — not in the TOML.

**What the LLM sees:** problem statement, tags, difficulty, *your* `solution.py` / board, failing I/O.  
**What it never sees:** corpus `completion` / `response` / reference solutions — dropped at parse time in [`src/problem.rs`](src/problem.rs).

---

## Troubleshooting

| Problem | Try |
| --- | --- |
| `problem data dir not configured` | `lc config set data-dir <path>` then `lc index` |
| Dataset tab shows 0 | `python scripts/fetch_dataset.py <slug>` then `lc index --dataset <slug>` |
| `cannot reach the local LLM` | Confirm vLLM/Ollama is up; check `llm.local.base_url` |
| FlashInfer / `nvcc` errors in WSL | Put CUDA 12.x first: `export CUDA_HOME=/usr/local/cuda-12.8` in `~/.bashrc` |
| Tablet `pair first` / 401 | Re-enter Host/Port/Code from the current `lc serve --lan` banner |
| Android connects on desktop but not device | Cleartext HTTP — see `app/src-tauri/android-overlay/` |
| Diagrams empty on small local models | Point viz at a stronger endpoint: `lc config set llm.modes.viz groq` |

---

## Development

```bash
cargo build --release
cargo test
cd app && npm install && npm test && npm run build
```

See [CHANGELOG.md](CHANGELOG.md) and [`app/README.md`](app/README.md).

---

## License

[PolyForm Noncommercial 1.0.0](https://polyformproject.org/licenses/noncommercial/1.0.0) — free for personal, educational, and other noncommercial use; commercial use needs a separate license. See [LICENSE](LICENSE).

Problem corpus licensing is separate per dataset — see the Hugging Face cards linked above.
