# Whiteboard

Practice LeetCode by *whiteboarding*: sketch an approach by hand while an agent
watches, grills you, and points at the specific test case your approach breaks
on.

The desktop Tauri window embeds the harness router in-process (no TCP bind) and
the RustPython judge. There is no LAN pairing UI (no Host/Port/Code header).

```
┌─ Desktop Tauri (this directory) ─────────────────────────┐
│  React canvas  ──invoke──►  in-process axum router        │
│                              • corpus / workspaces        │
│                              • runner.rs (RustPython)     │
│                              • llm/ (Ollama / Groq / …)   │
│  Coach  ──Tauri events──►  drive_channels (no WebSocket)  │
└───────────────────────────────────────────────────────────┘
  same binary also builds as an Android APK (in-process router;
  APK size is a later pass). Tablet-as-display: spacedesk.
```

How the layers split (pad UI vs in-process router vs LLM), flags, and the
stripped Ask-only sibling: [Where the work lives](../README.md#where-the-work-lives)
in the repo README.

The Magic Note Pad is a standalone Android tablet, not a pen display — Drawing
Display Mode needs DP-IN and only exists on the Magic *Drawing* Pad. Hence
spacedesk (mirror the desktop window) rather than screen-mirroring a separate
PC daemon.

## Getting started

Start the Tauri app — the router is already inside it. Vite-only preview in a
browser is not supported.

```bash
npm install
npm run tauri dev
```

Opens on a **home chooser**: Practice, Whiteboard, or Annotate. Back from a
session returns there. Hide Practice with `VITE_FEATURE_LEETCODE=0` in `app/.env`.
LLM config is **Settings → LLM** (`localhost` is this machine). Tests: **Settings
→ Workspace → Test Cases** (hidden when Practice is off).

## Modes

**Review** — draw, tap **Submit**. The agent returns a verdict, ratings,
strengths, gaps, a Socratic question, and — when your approach is wrong — a
counterexample citing one of the problem's real sample cases.

**Ambient** — *off.* The agent used to glance at the board every 60 seconds,
escalating rather than repeating itself. In practice it re-asked the same
question on a board that changes slowly and blocked the pen while a local model
thought. The button stays in the composer, greyed, behind one flag —
`AMBIENT_ENABLED` in `src/modes/AgentSidePanel.tsx`. Turning it back on restores
the coach session, the escalation ladder, and the side panel; nothing else was
removed.

**Draw it** — the agent answers with a diagram instead of prose. Multi-frame
traces become *one* diagram with a scrubber, not five copies of the same array.

**Reveal** — an explicit, confirmed opt-in that produces a stepwise path from
your approach to a working one. It is never a solution dump, and it is logged so
`whiteboard stats` shows how often you tapped out.

## Problem sets

Landing is the home chooser; **Practice** opens the problem table. A tab strip
above that table switches between the five corpora `whiteboard` indexes. Everything under it — search, filters, paging, session
Start / Reset / Select / Random — works the same on any tab: the dataset is one
more parameter on the same queries. Filters do reset on a switch, since a tag
from one corpus matches nothing in another's tables.

A tab whose corpus is not on this device still appears, showing `0`. The
default APK ships `leetcode` and `leetcode-with-tests` (extracted + indexed on
first launch). KodCode / MS Python/Q / DeepSeek stay optional DLC. Empty tabs
still name the Hugging Face repo and `whiteboard index --dataset …` for a
desktop checkout that has not packed seed zips yet.
Pass/fail badges are per problem set: the router keys session progress on
`dataset/task_id`, so solving `two-sum` in one corpus does not mark the
identically-named problem in another.

## Test results

**Run tests** and **Submit** open a modal over the board — same shell as
Settings. The same run also lands in the agent thread as an `app` turn and rides
along with your next question on its own channel, so the agent can answer *"why
did case 3 fail?"* without you pasting anything. Closing the modal loses
nothing.

Settings → Workspace → **Test Cases** picks between running every case and stopping at the first
failure. Running every case is the default: it is what lets the agent choose a
real counterexample.

## Leaving a problem

Stepping away asks what to keep, and asks a different question depending on
whether the problem is solved:

| | layout | code | agent session |
| --- | --- | --- | --- |
| unsolved, **save** | resumes | resumes | resumes |
| unsolved, **discard** | cleared | reset to starter | cleared |
| solved, **save attempt** | archived | kept | archived |
| solved, **clear attempt** | cleared | reset to starter | archived |

Two rules are not symmetric, and both are deliberate: the agent session is
always saved once a problem is solved, and re-attempting a solved problem always
starts from a fresh board and a fresh session — re-solving while looking at the
answer you already drew is not practice. The router owns the rules
(`src/attempt.rs`); the dialog only asks.

## Connecting a tablet

- **Desktop window on a tablet screen:** spacedesk (below). Router stays in-process.
- **APK:** same Tauri binary with the in-process router. From the repo root:
  `app\scripts\android-install.cmd` (optional USB serial). First run generates
  `src-tauri/gen/android/` if missing. Corpus and LLM still have to exist on
  that device; packaging/size is later.

APK build/install → [`docs/ANDROID_SETUP.md`](docs/ANDROID_SETUP.md).

## The no-APK path (spacedesk)

**spacedesk** mirrors the PC's screen to the tablet over USB or Wi-Fi and sends
touch and stylus input back, so the tablet becomes a second display driving the
*desktop* app. Install the spacedesk driver on the PC and the viewer app on the
tablet, extend the display, then drag the whiteboard window onto it.

That means full desktop behaviour with no network pairing — pixels cross the
link, not API calls. Pen strokes make a round trip to the PC and back before
they are drawn; try a page of handwriting before committing to this path.

**Browser-only (`npm run dev`) is not supported** — use `npm run tauri dev` or
the APK.

## Android — sideloading the APK (no Play Store)

See [`docs/ANDROID_SETUP.md`](docs/ANDROID_SETUP.md) for prerequisites, build
commands, and install steps. The APK uses the same in-process router as desktop;
there is no Host/Port/Code pairing UI.

## Layout

| Path | What |
|---|---|
| `src/api/` | Router client (`lc_dispatch`) and coach event transport |
| `src/canvas/` | Excalidraw wrapper, capture extractors, ink recognizers |
| `src/templates/` | Board regions and the pre-seeded problem layout |
| `src/viz/` | Viz schema, the nine renderers, applier, frame scrubber |
| `src/modes/` | Home chooser, Review, reveal, test results, attempt dialog, problem picker |
| `src/util/datasetKey.ts` | `dataset/task_id` keys — how per-problem state is addressed |
| `src-tauri/` | Tauri shell, in-process harness router, coach events, ML Kit plugin |

## Tests

```bash
npm test
```

Covers renderer golden output, frame stepping, skip-if-unchanged cost control,
and pairing-URL helpers (legacy parse only).

Type-check and bundle:

```bash
npm run build
```

## Notes on the design

**The model never emits coordinates.** LLMs are unreliable at coordinate
geometry and reliable at structured semantic state, so the agent emits a *viz
program* — full state per frame — and `viz/render/<kind>.ts` lays it out
deterministically into a reserved agent lane on the right of the board.

**The agent never reads its own output back.** Injected diagrams are tagged and
excluded from capture; otherwise the agent starts agreeing with itself.

**Cited test cases are verified, not trusted.** The router checks the cited
index against the workspace's real cases and replaces the quoted input/expected
with the corpus's own text. A fabricated citation is dropped and reported.

**Draw survives a server that cannot tool-call.** vLLM rejects a request
carrying `tools` unless it was started with `--enable-auto-tool-choice` and a
`--tool-call-parser`, and diagrams are the one mode built entirely on tool
calls. The router retries in plain JSON using the same schemas, so the feature
degrades in latency rather than in existence.

**Test results are the app's voice, not the student's.** They travel on their
own `app_messages` channel and the prompt tells the model to read them as fact.
Everything else on the board is something the student claimed and the agent is
meant to question; a real test run is not.
