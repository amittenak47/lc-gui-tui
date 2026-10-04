<p align="center">
  <img src="docs/icons/icon-512.png" alt="Pen Island" width="128">
</p>

# Pen Island

A handwriting workspace for a pen tablet. Sketch an approach, mark up a PDF, or
think on a blank page, with an AI agent that reads the board over your shoulder.
It runs on an Android tablet or a desktop, and it can work with a model running
on your own machine.

`Android tablet` · `desktop` · `local or cloud models` · `PolyForm Noncommercial`

> **Status, from the author.** Tested on an XPPen Magic Note Pad (MNP1095),
> Android 14 (API 34), with the APK built on Android NDK 29.0.13846066. It's the
> only Android device I have, so I don't know yet what breaks on others. If you
> hit a bug, [please open an issue](https://github.com/amittenak47/pen-island/issues)
> and I'll fix it as soon as I can.
>
> Most of these docs were written with Cursor and Claude, because I spent my time
> on features and bug fixes. I'll rewrite them in my own words over time.

<!-- TODO: screenshots (docs/screenshots/*.png): Whiteboard, Annotate, Browse, Practice, the Agent panel -->

---

## What's in it

Everything opens in tabs, and two tabs can sit side by side.

| Mode | What it's for |
| --- | --- |
| **Whiteboard** | A blank page for sketches, notes and diagrams. |
| **Annotate** | Write on top of a PDF, an EPUB, a Markdown document or source code. Export the marked-up file when you're done. |
| **Browse** | Open a web page and write straight onto a snapshot of it. |
| **Practice** | Pick a coding problem, work it out by hand, write the solution and run the tests in the app. |
| **Explore** *(work in progress)* | See how your files, notebooks and problems connect. |

The **Agent** panel sits beside every mode. Ask it about what's on the page, have
it draw a diagram instead of writing a paragraph, or, in Practice, have it
review your approach. On Android you can talk to it: the mic next to **+** in the
agent box dictates into the message ([Voice dictation](#voice-dictation)).

A few more things worth knowing about:

- **Footnotes** in a document can carry their own whiteboard, code or Markdown
  attachments.
- **Exports and backups.** Annotated PDF, EPUB and Markdown archives export;
  annotation and whiteboard backups import again.
- **A tablet and a PC together.** The desktop app can host a hub that keeps your
  notebooks in sync with the tablet over your home network
  ([Pad hub](#using-a-tablet-and-a-pc-together)).

The [client guide](app/README.md#documents-attachments-and-recovery) has the
details on reading modes, document search, recovery and the Android pen, capture
and gesture integrations.

---

## Which build do I want?

Two APKs. Same app, one difference.

| Build | You get | Left out |
| --- | --- | --- |
| **Practice** *(default)* | Every mode, the Agent, and Practice with its test runner | nothing |
| **Whiteboard-only** | Whiteboard, Annotate, Browse, Explore and the Agent | Practice, and the Python engine that runs its tests |

Take **Practice** unless you want a smaller app and know you'll never run a test.
Whiteboard-only leaves out RustPython, which is most of the download.

Both builds share the app id `dev.lc.whiteboard`, so switching between them, or
updating, is an install over the top:

```bash
adb install -r <path-to-apk>
```

That keeps your library and settings as long as the new APK is signed with the
same key. APKs from different build machines can have different keys. If Android
refuses the update, export your notebooks and documents first: uninstalling
deletes the app's local data.

---

## Install

### Android, no build tools

1. Open [Releases](https://github.com/amittenak47/pen-island/releases) and pick
   the newest version.
2. Download `pen-island-practice-debug.apk` or `pen-island-whiteboard-only-debug.apk`.
3. Open it on the tablet and allow installs from unknown apps.

For the newest build of `main` instead of the newest release, open the latest
**Build Android APK** run on the
[Actions tab](https://github.com/amittenak47/pen-island/actions) and download
the APK from **Artifacts**.

### Android, building it yourself

You need Rust **1.93+**, Node **22.13+**, the Android SDK and NDK, and JDK
**17–24**. On Windows, the Practice build also needs Git for Windows and GNU make
(`winget install -e --id ezwinports.make`) to compile RustPython. Whiteboard-only
doesn't.

Use the wrapper scripts. They set up the Android environment (and, on Windows,
the tool paths RustPython needs), build the APK, and `adb install -r` it. The
device serial is optional.

```cmd
REM Windows, from the repo root
app\scripts\android-install-practice.cmd
app\scripts\android-install-whiteboard.cmd <device-serial>
```

```bash
# Linux, from the repo root
./app/scripts/android-install-practice.sh
./app/scripts/android-install-whiteboard.sh <device-serial>
```

The first build generates `app/src-tauri/gen/android`, which isn't in git.
For PATH, NDK, driver and wireless-adb help, see
[`app/docs/ANDROID_SETUP.md`](app/docs/ANDROID_SETUP.md).

### Desktop

Rust **1.93+**, Node **22.13+**, and the
[Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for your
platform.

```bash
cd app
npm install
npm run tauri dev
```

For the Whiteboard-only build on desktop, set both flags together. The Vite flag
hides the Practice card; the Cargo flag leaves the test engine out of the binary.

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
it. That isn't a supported way to run the app.

---

## Problem sets

The APK ships without problems; it would be several times the size with them.
Install them from inside the app under **Settings → Workspace → Datasets**. They
download from the
[`corpora-v1`](https://github.com/amittenak47/pen-island/releases/tag/corpora-v1)
release, which is separate from app releases, so updating the app leaves your
problem sets alone and the other way round. Your pass/fail marks survive
removing and reinstalling a set.

Until you install one, Practice opens to an empty table. Everything else works
without it.

| Set | Source | What you get |
| --- | --- | --- |
| `leetcode` *(default)* | [newfacade/LeetCodeDataset](https://huggingface.co/datasets/newfacade/LeetCodeDataset) | ~2.9k Python LeetCode problems |
| `kodcode` | [KodCode/KodCode-V1](https://huggingface.co/datasets/KodCode/KodCode-V1) | Large synthetic set, **Complete** style only |
| `ms-python-q` | [morganstanley/sft-python-q-problems](https://huggingface.co/datasets/morganstanley/sft-python-q-problems) | Structured `test_cases` |
| `deepseek-leetcode` | [davidheineman/deepseek-leetcode](https://huggingface.co/datasets/davidheineman/deepseek-leetcode) | DeepSeek contest benchmark |
| `leetcode-with-tests` | [kr4t0n/leetcode-with-tests](https://huggingface.co/datasets/kr4t0n/leetcode-with-tests) | Community pack with pytest-style checks |

Nothing is fetched from a judge site. Ask, Review and planning never see the
dataset's reference solution. The one exception is **Reveal**, which you have to
ask for and confirm (see [the agent](#what-the-agent-does-in-practice)).

---

## Pointing it at a model

Open **Settings → LLM** in the app. It works with any OpenAI-compatible server
(llama.cpp, Ollama, LM Studio, vLLM) and with OpenAI and Groq directly.

`localhost` in that box means the machine the app is running on. On a tablet,
that's the tablet. For a model on your PC, use the PC's network address (or
something like Tailscale), not `localhost`.

API keys are stored in the device's `config.toml`. On desktop, environment
variables win over Settings: `OPENAI_API_KEY`, `GROQ_API_KEY`, `LC_LOCAL_API_KEY`.
Android has no environment variables, so Settings is the only route there.

---

## Voice dictation

On Android, tap the mic to the left of **+** in the agent box, talk, and tap it
again to stop. The words land where your cursor was. Pick the speech engine under
**Settings → LLM → Voice dictation**:

| Engine | Cost | How it works |
| --- | --- | --- |
| **Android** *(default)* | Free | The tablet's built-in recognizer. Words appear as you speak. |
| **Local** | Free | Your own Whisper server, such as [whisper.cpp](https://github.com/ggml-org/whisper.cpp)'s `whisper-server` or speaches. Enter its URL, using your PC's network address. |
| **OpenAI**, **Groq** | Your API key | Records a clip, then transcribes it. Uses the same keys as the LLM settings. |
| **Deepgram** | Your API key | Same idea, with its own key. |

The recording engines are better with technical words. List the ones you use under
**Vocabulary** (for example `memoization, heapq, BFS`) and they're passed to the
transcriber. An optional **Clean-up pass** sends the transcript to one of your
LLM providers (a local model keeps it free and private) to fix punctuation,
filler words and misheard terms.

On a Windows desktop, Windows' own voice typing (**Win + H**) works in the agent
box.

---

## What the agent does in Practice

Draw your approach, choose **Review** in the agent box, and tap **Send**.

- **Review** reads the board, says what it thinks your approach is, and checks it
  against the real sample cases. You get a verdict, what's strong, what's missing,
  and a question back. When it thinks you're wrong, it names the case that breaks
  your approach instead of saying "this fails on edge cases". It arrives in
  stages, so you watch it read the board, name the approach and check the cases.
- **Draw it** answers with a diagram instead of a paragraph. Multi-step traces get
  a scrubber.
- **Reveal** gives a stepwise path from where you actually are to a working
  approach. You have to ask for it and confirm, it may use the reference
  solution, and it goes in the record.
- **Lazy** turns a board you've justified into `solution.py`: it implements the
  parts you've earned and stubs the rest.

The agent holds one approach per board. Most problems admit several, and an agent
that quietly switches between them ends up arguing with itself. If your board
changes enough to change the answer, it says so and says why.

**Run tests** and **Submit** on the Practice toolbar both run your solution's tests
in the app and post the result to the agent thread. Submit doesn't send anything
to a judge site. **Settings → Practice → Test Cases** controls whether every case
runs and whether failures go to the agent automatically.

Two extras are off until you turn them on. **Settings → Practice → Agent Planning**
works out which approaches a problem admits before the agent reads your board,
and is worth pointing at a larger model. **Settings → Personalize → UI → Agent
behavior** has a diagram check, which looks at each diagram the agent draws and
redraws it once if the picture doesn't show what it claims.

---

## Using a tablet and a PC together

The desktop app hosts a **Pad hub** on your local network (port `7878` by
default). The tablet syncs its notebooks, documents and problem boards with it, so
you can write on the tablet and pick up on the PC.

1. On the PC, open **Settings → Personalize → Storage → Pad hub**. It shows the
   hub's address and a six-digit code.
2. On the tablet, enter both in the same place.

Each device keeps a full working copy and works offline; changes sync when the two
can reach each other. The hub works with either build. See
[storage and sync](ARCHITECTURE.md#notebooks-vs-problems) for exactly what syncs
and what stays on each device.

---

## Maintenance commands

The repo also builds a small command-line tool, `lc`, for working on problem sets
outside the app. Install it with `cargo install --path .` from the repo root.

| Command | Purpose |
| --- | --- |
| `lc index [--rebuild] [--dataset S]` | Build or refresh the problem-set index |
| `lc datasets [--inspect]` | List problem sets and what each one contains |
| `lc config set / get / show / path` | Read or change `config.toml` |

To index a problem set by hand instead of installing it from the app:

```bash
pip install -U huggingface_hub pyarrow
python scripts/fetch_dataset.py leetcode --data-dir ~/lc-data
lc config set data.json_dir ~/lc-data
lc index
```

Where things live: desktop config and indexes are under your OS config folder in
a directory named `lc`, and Practice working folders default to `~/lc-workspace`.
Android keeps both inside the app's private storage.

---

## Building and contributing

- [ARCHITECTURE.md](ARCHITECTURE.md): how the pieces fit together, the
  in-process router, where notebooks are stored, and what syncs.
- [app/README.md](app/README.md): the client: layout, tests and design notes.
- [app/docs/ANDROID_SETUP.md](app/docs/ANDROID_SETUP.md): Android builds, step
  by step.
- [CHANGELOG.md](CHANGELOG.md): release notes.

---

## License

[PolyForm Noncommercial 1.0.0](https://polyformproject.org/licenses/noncommercial/1.0.0):
free for personal, educational and other noncommercial use; commercial use needs
a separate license. See [LICENSE](LICENSE). Selling Pen Island or a modified copy,
in an app store or anywhere else, or publishing it with ads or in-app purchases,
is commercial use.

The license grants no rights to the Pen Island name or icon. A redistributed or
modified build must use a different name and icon.

Pen Island includes open-source libraries, fonts and data under their own
licenses. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

Problem sets have their own licenses, which differ per dataset.
[LeetCodeDataset](https://huggingface.co/datasets/newfacade/LeetCodeDataset) is
Apache 2.0; [KodCode-V1](https://huggingface.co/datasets/KodCode/KodCode-V1) is
CC BY-NC 4.0 (noncommercial).
