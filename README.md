# lc — stylus whiteboard for LeetCode practice

**Sketch an approach by hand. Run real tests. Ask a vision coach — without ever sending a reference solution.**

A stylus-first practice app for **Android tablets**, **desktop**, and the **browser**, backed by a Rust daemon that indexes local problem corpora, generates Python workspaces, and runs tests. The coach sees *your* board (and optional region screenshots) plus *your* code — never the dataset’s reference solutions.

A terminal UI and CLI are still there for keyboard-first days. Pairs with **[LLM Autocorrect](https://github.com/amittenak47/llm-autocorrect)** when you finish `solution.py` in Cursor or VS Code.

<!-- Drop a short demo under docs/demo/ and uncomment:
![lc demo](docs/demo/lc-demo.gif)
or embed an MP4: <video src="docs/demo/lc-demo.mp4" controls width="720"></video>
-->

---

## Features

| Feature | Summary |
| --- | --- |
| **Whiteboard coach** | Excalidraw-style board on Android, desktop, or browser. Sketch Approach / Complexity / Walkthrough; the coach reviews, cites real sample cases, and can draw diagrams. |
| **Vision LLM** | Built for multimodal coaches that can read the board PNG — not text-only stubs. |
| **Five problem sets** | Tab strip across LeetCode, KodCode, MS Python-Q, DeepSeek LC, LC-with-tests. Separate SQLite tables and pass/fail badges per corpus. |
| **Local LLM (today)** | OpenAI-compatible endpoint — vLLM, llama.cpp, Ollama, LM Studio — or Groq. |
| **Remote LLM** | *Coming soon* — point the coach at a hosted OpenAI-compatible API without running a GPU at home. |
| **Session queue** | Start / Random builds a practice queue; hold-to-confirm when leaving so you don’t wipe a board by accident. |
| **Tablet pairing** | `lc serve --lan` prints Host / Port / Code once; the app keeps a token after that. |
| **CLI + TUI** | `lc load` / `lc test` / `lc ask` and an optional terminal browser when you’re not on the pen. |

---

## My setup (what this README assumes)

This is the loop I actually use. Yours can be simpler (desktop-only + a smaller model).

| Piece | What I run |
| --- | --- |
| **PC** | Windows 11, Rust + Node, corpus under `~/lc-data` (WSL) |
| **Coach model** | [Qwen3-VL-8B-Instruct-FP8](https://huggingface.co/Qwen/Qwen3-VL-8B-Instruct-FP8) — vision-language, served as `qwen3-vl-8b` |
| **Serving** | **vLLM** in WSL2 with **CUDA 12.8** (`CUDA_HOME=/usr/local/cuda-12.8`) |
| **Client** | Android stylus tablet (XPPen Magic Note Pad) APK, or browser / desktop Tauri, paired to `lc serve --lan` |
| **Editor** | Cursor + [LLM Autocorrect](https://github.com/amittenak47/llm-autocorrect) for finishing code off the board |

```
┌─ Drawing device ─────────────────┐          ┌─ Windows PC ──────────────────────┐
│  Android / browser / desktop      │◄── LAN ──►│  lc serve                         │
│  Whiteboard + coach chat          │          │  SQLite · workspaces · pytest     │
│  Pair once: Host / Port / Code    │          │  → WSL: vLLM (Qwen3-VL-8B FP8)    │
└───────────────────────────────────┘          └───────────────────────────────────┘
```

### vLLM (coach)

```bash
vllm serve /mnt/c/Users/Amit/models/Qwen3-VL-8B-Instruct-FP8 \
  --host 0.0.0.0 \
  --port 8000 \
  --limit-mm-per-prompt.video 0 \
  --served-model-name qwen3-vl-8b \
  --max-model-len 32768 \
  --gpu-memory-utilization 0.90
```

Weights: [Qwen/Qwen3-VL-8B-Instruct-FP8](https://huggingface.co/Qwen/Qwen3-VL-8B-Instruct-FP8) (or a local checkout under `/mnt/c/Users/…/models/`).

Point `lc` at it (Settings in the app, or CLI):

```bash
lc config set llm.provider local
lc config set llm.local.base_url http://127.0.0.1:8000/v1
lc config set llm.local.model qwen3-vl-8b
# optional: same id for vision captures
lc config set llm.local.vision_model qwen3-vl-8b
```

From the tablet, use the PC’s LAN IP in `base_url` if the daemon proxies differently — usually the app talks to `lc serve`, and the PC reaches vLLM on localhost.

Older system `nvcc` (CUDA 10.x on PATH) breaks FlashInfer JIT. Put CUDA 12.8 first in WSL `~/.bashrc`:

```bash
export CUDA_HOME=/usr/local/cuda-12.8
export PATH="$CUDA_HOME/bin:$PATH"
export LD_LIBRARY_PATH="$CUDA_HOME/lib64:${LD_LIBRARY_PATH:-}"
```

---

## Quick start

### 1. Install the daemon

```bash
git clone https://github.com/amittenak47/leetcode-tui.git
cd leetcode-tui
cargo install --path .
```

Needs **Rust** (1.75+), **Python 3.10+**, and for the whiteboard client: **Node 20+**.

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

### 4. Practice on a drawing device

Start the coach model (see [vLLM](#vllm-coach) above), then:

```bash
# terminal 1 — daemon (use --lan for a tablet / phone on Wi‑Fi)
lc serve --lan

# terminal 2 — desktop window (mouse check)
cd app && npm install && npm run tauri dev

# or build / sideload the Android APK
cd app && npm run android:apk
```

Type the printed **Host / Port / Code** into the app header once. Full Android / cleartext-HTTP notes: [`app/README.md`](app/README.md).

**Optional — terminal UI** (no pen):

```bash
lc
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

---

## CLI cheatsheet

```bash
lc search --difficulty Medium --tag graph
lc random -n 3 --tag "Dynamic Programming"
lc load two-sum --open          # workspace + Cursor/VS Code
lc test two-sum --verbose
lc ask --case 3 --provider local
lc stats
lc serve --lan                  # drawing-device daemon
```

| Command | Purpose |
| --- | --- |
| `lc serve [--lan] [--port N]` | Whiteboard daemon (the main path) |
| `lc` / `lc tui` | Optional terminal practice UI |
| `lc index [--dataset S] [--rebuild]` | Build SQLite index |
| `lc datasets [--inspect]` | Counts + corpus column report |
| `lc load <id> [--dataset S] [--open]` | Generate workspace |
| `lc test [id] [-v] [--full]` | Run `run_tests.py` |
| `lc ask` | LLM help on a failing case |

Config path: `lc config path`  
(Windows: `%APPDATA%\lc\config\config.toml` · Linux/macOS: `~/.config/lc/config.toml`)

API keys stay in the environment (`GROQ_API_KEY`, optional `LC_LOCAL_API_KEY`) — not in the TOML.

**What the LLM sees:** problem statement, tags, difficulty, *your* `solution.py` / board PNGs, failing I/O.  
**What it never sees:** corpus `completion` / `response` / reference solutions — dropped at parse time in [`src/problem.rs`](src/problem.rs).

---

## Troubleshooting

| Problem | Try |
| --- | --- |
| `problem data dir not configured` | `lc config set data-dir <path>` then `lc index` |
| Dataset tab shows 0 | `python scripts/fetch_dataset.py <slug>` then `lc index --dataset <slug>` |
| `cannot reach the local LLM` | Confirm vLLM is up on `:8000`; check `llm.local.base_url` and `model` = `qwen3-vl-8b` |
| FlashInfer / `nvcc` errors in WSL | Put CUDA 12.x first — see [My setup](#my-setup-what-this-readme-assumes) |
| Tablet `pair first` / 401 | Re-enter Host/Port/Code from the current `lc serve --lan` banner |
| Android connects on desktop but not device | Cleartext HTTP — see `app/src-tauri/android-overlay/` |
| Board review ignores the image | Confirm a **vision** model (Qwen3-VL) and that Review board is on |

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
