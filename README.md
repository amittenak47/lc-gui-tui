<p align="center">
  <img src="docs/icons/icon-512.png" alt="Whiteboard" width="128">
</p>

# Whiteboard

Handwrite your way through a problem on a tablet — sketch the approach, mark up a
PDF, or think on a blank page — with an agent reading the board over your
shoulder.

**Tested on:** XPPen Magic Note Pad (MNP1095), Android 14 (API 34). APK built with Android NDK **29.0.13846066**.

If you run into any bugs, [please let me know](https://github.com/amittenak47/lc-gui-tui/issues) so I can fix it ASAP. I only have this one Android device so I'm not sure what compatibility issues people may encounter.

The app is free. Feel free to tip if you like it. Most of my repo is lazy documented with Cursor/Claude because I spent more time adding+finalizing features and fixing small bugs than actually using the app, so I will improve documentation with more of my own language in the near future.

[![ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/amittenak47)

`5 problem sets` · `local or Groq` · `tablet or desktop` · `PolyForm Noncommercial`

---

## Upcoming

The terminal UI (`lc`) is still on an earlier build. Its agent endpoints need
updating now that the GUI has moved on. Planned, in rough order:

1. **TUI agent chat** — the same Review / Ask / Draw pipeline the GUI has.
   Today the TUI's chat is a single blocking text card.
2. **Open the canvas from the TUI** — "Open in Canvas" currently just prints a
   status. It should launch the desktop window on the current workspace, with
   the board and the agent but not Annotate or Browse.
3. **TUI corpora from `corpora-v1`** — the TUI still wants
   `scripts/fetch_dataset.py` plus `whiteboard index`. The GUI already installs
   datasets from the GitHub release; the TUI should use the same source.
4. **"Coach" becomes "Agent" everywhere you can see it** — the TUI menu, the
   board region, the "Coach LLM offline" notice. Config keys and HTTP routes
   stay as they are.

Not planned for the TUI: tabs and split panes, PDF annotation, web browsing,
and the notebook library internals. Those are canvas features and the terminal
is the wrong shape for them.

---

## What it is

Two ways in, sharing one engine.

**The canvas app** (tablet or desktop) is the main one. Four things you can
open, each in its own tab:

| | |
| --- | --- |
| **Whiteboard** | A blank page. Sketches, notes, diagrams. |
| **Annotate** | Write on top of a PDF, a document, or source code. |
| **Browse** | Open a web page, then write straight onto the snapshot. |
| **Practice** | Pick a problem, work it out by hand, run the tests. |

**The terminal UI** (`lc`) is a keyboard-driven version of Practice alone —
browse the problem sets, generate a workspace, run tests, ask for a hint. See
[Upcoming](#upcoming) for where it stands.

Problems come from **local JSON corpora** you install yourself. Nothing is
fetched from a judge site, and the agent never sees the reference solution that
ships with a dataset — it works from your board and the sample cases only.

---

## Which build do I want?

Two APKs. Same app, one difference.

| Build | You get | Left out |
| --- | --- | --- |
| **Practice** *(default)* | Whiteboard, Annotate, Browse, Agent, **and Practice with its test runner** | — |
| **Whiteboard-only** | Whiteboard, Annotate, Browse, Agent | Practice, and the Python engine that runs tests |

Take **Practice** unless you want a smaller app and know you will never run a
test. Whiteboard-only leaves out RustPython, which is most of the download.

Both share the app id `dev.lc.whiteboard`, so Android treats them as the same
app. To switch:

```bash
adb uninstall dev.lc.whiteboard
```

then install the other one.

---

## Install

### Android — no build tools

[Releases](https://github.com/amittenak47/lc-gui-tui/releases) → the newest
version tag → download `whiteboard-practice-debug.apk` or
`whiteboard-only-debug.apk` → open it on the tablet and allow installs from
unknown apps.

Or, for the newest build of `main` rather than the newest release: the
[Actions tab](https://github.com/amittenak47/lc-gui-tui/actions) → the latest
**Build Android APK** run → **Artifacts**.

### Android — building it yourself

Needs the Android SDK, an NDK, and JDK 17+. First run generates
`app/src-tauri/gen/android`, which is not in git.

```cmd
REM Windows, from the repo root. Device serial is optional.
app\scripts\android-install-practice.cmd
app\scripts\android-install-whiteboard.cmd <your-device-serial>
```

```bash
# Linux / macOS
./app/scripts/android-install-practice.sh
./app/scripts/android-install-whiteboard.sh <device-serial>
```

Both scripts build the APK and `adb install -r` it. PATH, NDK, and driver
troubleshooting: [`app/docs/ANDROID_SETUP.md`](app/docs/ANDROID_SETUP.md).

### Desktop

```bash
cd app
npm install
npm run tauri dev
```

For the Whiteboard-only desktop window, both flags have to be set together —
the Vite flag hides the Practice card, the Cargo flag leaves the test engine
out of the binary:

```bash
# Linux / macOS
VITE_FEATURE_LEETCODE=0 npm run tauri -- dev -- --no-default-features
```

```powershell
# Windows PowerShell
$env:VITE_FEATURE_LEETCODE = "0"
npm run tauri -- dev -- --no-default-features
```

`npm run dev` on its own opens the client in a browser with no backend behind
it. That is not a supported way to run the app.

### Terminal UI

```bash
cargo install --path .   # installs `lc`
lc                       # or: lc tui
```

---

## Problem sets are a separate download

The APK does not contain any problems — it would be several times the size if
it did. Datasets are installed from inside the app:

**Settings → Datasets → Install**, which pulls from the
[`corpora-v1`](https://github.com/amittenak47/lc-gui-tui/releases/tag/corpora-v1)
release. That tag is permanent and separate from app releases, so updating the
app does not disturb your datasets and vice versa.

Until you install one, Practice opens to an empty table. Everything else works
without it.

| Set | Source | What you get |
| --- | --- | --- |
| `leetcode` *(default)* | [newfacade/LeetCodeDataset](https://huggingface.co/datasets/newfacade/LeetCodeDataset) | ~2.9k Python LeetCode problems |
| `kodcode` | [KodCode/KodCode-V1](https://huggingface.co/datasets/KodCode/KodCode-V1) | Large synthetic set — **Complete** style only |
| `ms-python-q` | [morganstanley/sft-python-q-problems](https://huggingface.co/datasets/morganstanley/sft-python-q-problems) | Structured `test_cases` |
| `deepseek-leetcode` | [davidheineman/deepseek-leetcode](https://huggingface.co/datasets/davidheineman/deepseek-leetcode) | DeepSeek contest benchmark |
| `leetcode-with-tests` | [kr4t0n/leetcode-with-tests](https://huggingface.co/datasets/kr4t0n/leetcode-with-tests) | Community pack with pytest-style checks |

Your pass/fail marks survive removing and reinstalling a set.

For the TUI, which does not use `corpora-v1` yet, fetch and index by hand:

```bash
pip install -U huggingface_hub pyarrow
python scripts/fetch_dataset.py leetcode --data-dir ~/lc-data
whiteboard config set data-dir ~/lc-data
whiteboard index
```

---

## Pointing it at a model

**Settings → LLM**, in the app. It talks to anything OpenAI-compatible —
llama.cpp, Ollama, LM Studio, vLLM — or to Groq.

`localhost` in that box means the machine the app is running on. On a tablet
that is the tablet, so a model running on your PC needs the PC's address (or
something like Tailscale), not `localhost`.

On desktop, environment variables win over whatever is in Settings:
`GROQ_API_KEY`, `OPENAI_API_KEY`, `LC_LOCAL_API_KEY`. On Android there are no
env vars, so Settings is the only route.

From the CLI:

```bash
whiteboard config set llm.provider local
whiteboard config set llm.local.base_url http://127.0.0.1:8000/v1
whiteboard config set llm.local.model qwen3-vl-8b
whiteboard config path        # where config.toml lives
```

---

## What the agent does

Draw your approach, then tap **Submit**.

- **Review** — reads the board, says what it thinks your approach is, and
  checks it against the real sample cases. You get a verdict, what is strong,
  what is missing, and a question back. When it is wrong, it names the specific
  case that breaks it rather than saying "this fails on edge cases".
- **Draw it** — answers with a diagram instead of a paragraph. Multi-step
  traces get a scrubber.
- **Reveal** — a stepwise path onward from where you actually are. You have to
  ask for it and confirm, it never dumps a solution, and it is recorded.
- **Lazy** — turns a board you have justified into `solution.py`, implementing
  the parts you earned and stubbing the rest.

Review arrives in stages — reading the board, naming the approach, checking the
cases — rather than in one silent lump. It also holds **one approach per
board**: most problems admit several, and an agent that quietly switches
between them ends up arguing with itself. If your board changes enough to
change the answer, it says so and says why.

Two extras are off until you turn them on in **Settings → AI Behavior**: a
**planner** (worth pointing at a larger model) that works out which approach
families a problem admits before the local agent reads your board, and a
**diagram check** that looks at each rendered diagram and redraws it once if the
picture does not show what it claims.

---

## Terminal UI keys

```bash
lc
```

| Key | Action |
| --- | --- |
| **W / S** (↑ / ↓) | Move selection |
| **A / D** | Previous / next page |
| **/** | Search |
| **G** | Cycle problem set |
| **T** / **E** | Cycle tag / difficulty |
| **O** | Cycle sort |
| **Enter** | Actions — load workspace, open in editor, run tests, send to whiteboard |
| **Q** | Quit |

### Working in an editor instead

```bash
whiteboard load two-sum --open      # opens in Cursor, or VS Code
whiteboard test two-sum --verbose
whiteboard ask two-sum --case 3
```

Pairs with [LLM Autocorrect](https://github.com/amittenak47/LLM-AutoCorrect),
which fixes code as you type while `whiteboard` handles problems, workspaces,
and tests.

---

## Commands

| Command | Purpose |
| --- | --- |
| `lc` / `lc tui` | Interactive practice UI |
| `whiteboard index [--rebuild] [--dataset S]` | Build or refresh the SQLite index |
| `whiteboard datasets [--inspect]` | Problem sets and indexed counts |
| `whiteboard search` / `whiteboard random` | Filter or pick (`--dataset`, `--difficulty`, `--tag`, `-q`, `--sort`) |
| `whiteboard load <id> [--open] [--force]` | Generate a workspace; id = slug, question #, or prefix |
| `whiteboard test [id] [--case N] [--full] [-v]` | Run tests — exits `0` when every case passes |
| `whiteboard ask [id] [--case N] [--provider local\|groq]` | LLM debugging help |
| `whiteboard stats` · `whiteboard session reset` · `whiteboard list …` | Progress, session, named lists |
| `whiteboard config set/get/show/path` | Manage `config.toml` |

Defaults: workspaces in `~/lc-workspace`, data in `~/lc-data`, config under the
OS config directory named `lc`.

---

## Building, contributing, internals

How the pieces fit together — the in-process router, where notebooks are
stored, what syncs and what does not — is in
[ARCHITECTURE.md](ARCHITECTURE.md). Android specifics are in
[`app/docs/ANDROID_SETUP.md`](app/docs/ANDROID_SETUP.md), and the client's own
notes are in [`app/README.md`](app/README.md).

---

## License and references

[PolyForm Noncommercial 1.0.0](https://polyformproject.org/licenses/noncommercial/1.0.0) — free for personal, educational, and other noncommercial use; commercial use needs a separate license. See [LICENSE](LICENSE).

Problem corpus licensing is separate and differs per dataset: [LeetCodeDataset](https://huggingface.co/datasets/newfacade/LeetCodeDataset) is Apache 2.0; [KodCode-V1](https://huggingface.co/datasets/KodCode/KodCode-V1) is CC BY-NC 4.0 (non-commercial).

Release notes: [CHANGELOG.md](CHANGELOG.md).

### References

- [ascii-morph](https://github.com/tholman/ascii-morph) (Tim Holman) — dissolve morph between ASCII stills; the TUI coach viz player is a Rust/ratatui take on that idea (`src/tui/ascii_morph.rs`)
- [LLM Autocorrect](https://github.com/amittenak47/LLM-AutoCorrect) — editor companion for fixing code as you type
