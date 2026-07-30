<p align="center">
  <img src="docs/icons/icon-512.png" alt="lc" width="128">
</p>

# lc

A Rust CLI and terminal UI for practicing LeetCode-style problems from **local JSON corpora**. Index thousands of problems into SQLite, browse and filter them interactively, generate Python workspaces, run tests, and ask an LLM tutor for hints — **without ever loading or sending reference solutions** from the dataset.

There is a second way to practise: sketch the approach by hand on a tablet while a coach watches, grills you, and points at the specific test case your approach breaks on.

`5 problem sets` · `local or Groq` · `tablet or desktop` · `PolyForm Noncommercial`

---

## Browse the corpus, then work the problem

**W/S** selects, **A/D** pages, **/** searches, **G** switches problem set, **T** and **E** cycle tag and difficulty. Enter opens the actions: generate a workspace, open it in Cursor, run the tests, or send it to the whiteboard.

```bash
lc                                  # the TUI
lc search --difficulty Medium --tag graph
lc load two-sum --open
lc test two-sum --verbose
```

## Or sketch it, and let the coach find the case you break on

Draw, tap **Submit**, and the coach returns a verdict, ratings, strengths, gaps, a Socratic question and — when your approach is wrong — a counterexample citing one of the problem's real sample cases. **Draw it** answers with a diagram instead of prose. **Reveal** is an explicit, confirmed opt-in that produces a stepwise path from your approach to a working one; it is never a solution dump, and it is logged so `lc stats` shows how often you tapped out.

**Lazy** turns a justified board into `solution.py`: it implements what you already earned and leaves the rest as stubs. Pair a tablet with `lc serve --lan`, or run the canvas on desktop / in the browser.

```bash
cargo run -- serve --lan            # daemon for the whiteboard…
cd app && npm install && npm run tauri dev    # …and the canvas
# Android: cd app && npm run android:apk
```

---

## Four decisions the rest of it hangs off

**Reference solutions never load.** The `Problem` struct in [`src/problem.rs`](src/problem.rs) has no fields for the corpus's `completion`, `response` and `query`, so serde drops them at parse time. They never reach the index, the workspace or a prompt, and `cargo test` asserts it.

**Cited test cases are verified, not trusted.** When the coach cites a sample case the daemon checks the index exists and overwrites the quoted input/expected with the corpus's own text, so a model that cites a real case but misquotes it cannot show you a fabricated one. A citation to a case that doesn't exist is dropped and reported.

**The model never emits coordinates.** LLMs are unreliable at coordinate geometry and reliable at structured semantic state, so the coach emits a *viz program* — full state per frame — and `viz/render/<kind>.ts` lays it out deterministically into a reserved agent lane on the right of the board.

**The coach never reads its own output back.** Injected diagrams are tagged and excluded from capture; otherwise the coach starts agreeing with itself. Test results travel on their own `app_messages` channel and the prompt tells the model to read them as fact — a real run is not something the student claimed.

---

## Try it

```bash
cargo install --path .
python scripts/fetch_dataset.py leetcode --data-dir ~/lc-data
lc config set data-dir ~/lc-data && lc index
lc                                  # the TUI

lc serve --lan                      # the whiteboard: daemon…
cd app && npm install && npm run tauri dev    # …and the canvas
```

Needs **Rust** (1.75+), **Python 3.10+**, and for the whiteboard client **Node 20+**.

Client internals and Android / cleartext-HTTP notes → [`app/README.md`](app/README.md).

### Local vision coach (optional)

Point `lc` at any OpenAI-compatible endpoint (vLLM, llama.cpp, Ollama, LM Studio) or Groq:

```bash
lc config set llm.provider local
lc config set llm.local.base_url http://127.0.0.1:8000/v1
lc config set llm.local.model qwen3-vl-8b
lc config set llm.local.vision_model qwen3-vl-8b
```

API keys stay in the environment (`GROQ_API_KEY`, optional `LC_LOCAL_API_KEY`) — not in the TOML. Config path: `lc config path`.

---

## How it works

```
JSON corpora ─lc index──▶ SQLite (problems.db)
  per dataset                 │  problems, problems_kodcode, … (one table pair each)
                        lc load <id> --dataset <slug>
                              ▼
        ~/lc-workspace/[<dataset>/]<task_id>/
        ├── solution.py        ← you edit this
        ├── board.json         ← the whiteboard, when kept
        ├── run_tests.py
        └── .lc/meta.json      ← cases, entry_point (no reference solution)
                              │
                        lc test ──▶ python run_tests.py ──▶ results table
                        lc ask  ──▶ redacted prompt ──▶ LLM tutor
                        lc serve ──▶ HTTP + WS ──▶ whiteboard canvas (app/)
```

### Coach review (staged)

Board review is split so the stage that says “this is enough” is never asked to invent gaps:

1. **Perceive** — describe the board (vision only; skipped for text-only builds).
2. **Claim** — name the approach, the steps it justifies, and whether that claim already decides the answer.
3. **Verdict** — runs only when the claim is insufficient. On-track cards are synthesized from the frozen claim.

Falls back to a single-call review if a stage returns nothing usable.

---

## Commands

| Command | Purpose |
| --- | --- |
| `lc` / `lc tui` | Interactive practice UI |
| `lc index [--rebuild] [--dataset S]` | Build or refresh the SQLite index |
| `lc datasets [--inspect]` | Problem sets and indexed counts; `--inspect` reports each corpus file's real columns |
| `lc search` / `lc random` | Filter or pick (`--dataset`, `--difficulty`, `--tag`, `-q`, `--sort`) |
| `lc load <id> [--open] [--force]` | Generate a workspace; id = slug, question #, or prefix |
| `lc test [id] [--case N] [--full] [-v]` | Run the Python tests — exits `0` when every case passes |
| `lc ask [id] [--case N] [--provider local\|groq]` | LLM debugging help |
| `lc serve [--port N] [--lan]` | Daemon for the whiteboard client |
| `lc stats` · `lc session reset` · `lc list …` | Progress, session, named lists |
| `lc config set/get/show/path` | Manage `config.toml` |

### Datasets

| Slug | Hugging Face | What you get |
| --- | --- | --- |
| `leetcode` *(default)* | [newfacade/LeetCodeDataset](https://huggingface.co/datasets/newfacade/LeetCodeDataset) | ~2.9k Python LeetCode problems |
| `kodcode` | [KodCode/KodCode-V1](https://huggingface.co/datasets/KodCode/KodCode-V1) | Large synthetic set — `lc` indexes **Complete** style only |
| `ms-python-q` | [morganstanley/sft-python-q-problems](https://huggingface.co/datasets/morganstanley/sft-python-q-problems) | Structured `test_cases` |
| `deepseek-leetcode` | [davidheineman/deepseek-leetcode](https://huggingface.co/datasets/davidheineman/deepseek-leetcode) | DeepSeek contest benchmark |
| `leetcode-with-tests` | [kr4t0n/leetcode-with-tests](https://huggingface.co/datasets/kr4t0n/leetcode-with-tests) | Community pack with pytest-style checks |

Adapters: [`src/datasets/`](src/datasets/). After adapter changes: `lc index --dataset <slug> --rebuild`.

---

Pairs well with **[LLM Autocorrect](https://github.com/amittenak47/LLM-AutoCorrect)**: `lc` handles problem selection, workspaces and testing; the extension fixes your code as you type in Cursor or VS Code.

[PolyForm Noncommercial 1.0.0](https://polyformproject.org/licenses/noncommercial/1.0.0) — free for personal, educational, and other noncommercial use; commercial use needs a separate license. See [LICENSE](LICENSE). Problem corpus licensing is separate and differs per dataset: [LeetCodeDataset](https://huggingface.co/datasets/newfacade/LeetCodeDataset) is Apache 2.0; [KodCode-V1](https://huggingface.co/datasets/KodCode/KodCode-V1) is CC BY-NC 4.0 (non-commercial). Release notes: [CHANGELOG.md](CHANGELOG.md).
