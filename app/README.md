# Pen Island client development

**Tested on:** XPPen Magic Note Pad (MNP1095), Android 14 (API 34). APK built with Android NDK **29.0.13846066**. Bugs: [open an issue](https://github.com/amittenak47/pen-island/issues). I want compatibility reports across devices.

Pen Island supports coding practice by *whiteboarding*: sketch an approach by hand while an agent
watches, grills you, and points at the specific test case your approach breaks
on.

The Tauri window embeds the harness router; Practice includes the RustPython
judge. Local app commands use in-process invoke. Desktop also hosts the LAN Pad hub on `0.0.0.0`,
at configured `serve.port` (default `7878`), using a six-digit pairing code.
Both build flavors include the hub; no separate `lc serve` daemon is needed.

```
┌─ Desktop Tauri (this directory) ─────────────────────────┐
│  React canvas  ──invoke──►  in-process axum router        │
│                              • corpus / workspaces        │
│                              • runner.rs (RustPython)     │
│                              • llm/ (Ollama / Groq / …)   │
│  Coach  ──Tauri events──►  drive_channels (no WebSocket)  │
│  LAN Pad hub :7878 ──same router──► pads.db / pad-blobs/  │
└───────────────────────────────────────────────────────────┘
  Android APK: local in-process router + optional paired hub sync.
  Practice includes RustPython; Whiteboard-only omits it. Corpora download separately.
  Tablet-as-display: spacedesk.
```

[ARCHITECTURE.md](../ARCHITECTURE.md) covers how the layers split (canvas UI,
in-process router, LAN hub, LLM), storage, and the feature flags.

The Magic Note Pad is a standalone Android tablet, not a pen display. Drawing
Display Mode needs DP-IN and only exists on the Magic *Drawing* Pad. Hence
spacedesk (mirror the desktop window) rather than screen-mirroring a separate
PC daemon. The APK can instead sync its own library through the desktop Pad hub.

For installation and user workflows, start with the [main README](../README.md).
The `lc` CLI is maintenance-only (`index`, `datasets`, `config`); use the app for
editing solutions, running tests and asking the Agent. Corpus audits use the
separate `audit_tests` binary.

## Getting started

Start the Tauri app. The router is already inside it. Vite-only preview in a
browser is not supported.

Use Rust **1.93+**, Node **22.13+** (the current locked PDF dependency requires
it), and the platform's Tauri build prerequisites. Run these commands from
`app/`:

```bash
npm install
npm run tauri dev
```

Opens on Home, with cards for Practice, Whiteboard, Annotate, Browse and
Explore (WIP). Each opens in its own tab. Tabs can split for side-by-side work.
Home stays as the first tab rather than being somewhere you navigate back to.

### Whiteboard-only (no Practice)

Two build flavors, one flag pair. Practice is the default and has everything.
Whiteboard-only hides the Practice card with `VITE_FEATURE_LEETCODE=0` and omits
the `leetcode` Cargo feature with `--no-default-features`, so no RustPython.

Both flags have to stay together. Dropping the Cargo feature on its own leaves a
Practice card pointing at a judge that is not in the binary.

From the repo root:

```cmd
app\scripts\android-install-whiteboard.cmd
app\scripts\android-install-whiteboard.cmd <your-device-serial>
```

Linux: `./app/scripts/android-install-whiteboard.sh`. From this directory:
`npm run android:apk:whiteboard` then `adb install -r` the universal debug APK.
Release: `npm run android:apk:whiteboard:release`. Details: [`docs/ANDROID_SETUP.md`](docs/ANDROID_SETUP.md).

Both flavors share the app id `dev.lc.whiteboard`. Use `adb install -r` to
update or switch when the package, signing certificate, and version are
compatible. Different build sources can have different signing keys. If Android
rejects the update, verify an export/backup before choosing a fresh install;
normal uninstall removes the local library and settings. The wrappers select
the generated universal or arm64 output as appropriate.

The old `*-pads*` script and npm names still work. They forward to these, and
they will be removed once nobody is typing them.

Desktop window (PowerShell):

```powershell
$env:VITE_FEATURE_LEETCODE = "0"
npm run tauri -- dev -- --no-default-features
```

Linux / macOS: `VITE_FEATURE_LEETCODE=0 npm run tauri -- dev -- --no-default-features`.
LLM config is **Settings → LLM** (`localhost` is this machine). Paste Groq/OpenAI
keys there on the APK (no process env). Tests: **Settings
→ Practice → Test Cases** (hidden when Practice is off).

Windows Android Practice builds need Git for Windows and GNU make
(`winget install -e --id ezwinports.make`); the Practice wrapper configures the
no-spaces Git tools path required by RustPython. Whiteboard-only omits those
cp/make requirements. Android wrappers also need SDK, NDK and JDK **17–24**;
see [Android setup](docs/ANDROID_SETUP.md).

## Modes

**Review.** Draw, select Review in the Agent composer, then tap Send. The agent
returns a verdict, ratings, strengths, gaps, a Socratic question, and, when your
approach is wrong, a
counterexample citing one of the problem's real sample cases.

**Ambient.** Off. The agent used to glance at the board every 60 seconds,
escalating rather than repeating itself. In practice it re-asked the same
question on a board that changes slowly and blocked the pen while a local model
thought. The button stays in the composer, greyed, behind one flag:
`AMBIENT_ENABLED` in `src/modes/AgentSidePanel.tsx`. Turning it back on restores
the coach session, the escalation ladder, and the side panel; nothing else was
removed.

**Draw it.** The agent answers with a diagram instead of prose. Multi-frame
traces become *one* diagram with a scrubber, not five copies of the same array.

**Reveal.** An explicit, confirmed opt-in that produces a stepwise path from
your approach to a working one. It may use the dataset's reference solution;
the intended response is a bridge rather than a full solution. The reveal is
recorded in the local session progress file. Ordinary Ask, Review and planning use
redacted sources.

**Lazy.** The current composer action fills `solution.py` from the board and
the approach claim, leaving unearned parts as TODOs. It does not grant Reveal
consent or load the reference. This is separate from the legacy reveal-mode Lazy
API path, which requires explicit confirmation before using the reference.

Planning is under **Settings → Practice → Agent Planning**, approach commitment
under **Settings → Practice → Agent Approach**, and diagram checking under
**Settings → Personalize → UI → Agent behavior**.

## Problem sets

Home's **Practice** card opens the problem table. A tab strip
above that table switches between the five corpora `lc` indexes.
Search, filters, paging, and session Start / Reset / Select / Random all work
the same on any tab, because the dataset is one more parameter on the same
queries. Filters do reset on a switch, since a tag
from one corpus matches nothing in another's tables.

A tab whose corpus is not on this device still appears, showing `0`. Nothing
ships in the APK. Settings → Workspace → Datasets → Install downloads GitHub
`corpora-v1`. Pass/fail badges survive Remove and reinstall (`dataset/task_id`
in `session.json`). Empty tabs also name the Hugging Face repo for a desktop
`lc index --dataset …` checkout.
Pass/fail badges are per problem set: the router keys session progress on
`dataset/task_id`, so solving `two-sum` in one corpus does not mark the
identically-named problem in another.

## Test results

Practice toolbar **Run tests** and **Submit** both sync the in-app solution and
run its tests; Submit is not a judge-site submission. They open a modal over the
board, the same shell as Settings. The same run also lands in the agent thread
as an `app` turn and rides along with your next question on its own channel, so
the agent can answer *"why
did case 3 fail?"* without you pasting anything. Closing the modal loses
nothing.

Settings → Practice → **Test Cases** picks between running every case and stopping at the first
failure. Running every case is the default: it is what lets the agent choose a
real counterexample.

That section also controls automatic failure forwarding: wait for a question,
ask about the whole failing run, or ask once per failing case. The Tests card is
always added to the thread.

## Documents, attachments and recovery

Whiteboard, Annotate and Browse have their own library workflows alongside
Practice. Explore is a shipped WIP view. Split tabs can keep a source page and
notes open side by side. Document footnotes can own whiteboard, code and
Markdown attachments, with their own editing and agent context.

**Settings → Personalize → UI → Reading** selects continuous Scroll or
page-by-page Pages, with full-screen or margin page fit. Documents can be
indexed locally for agent search. **Settings → LLM → Local** configures optional
embedding model/endpoint fields; leaving the model empty uses word matching.
Search tools also support a configured SearXNG endpoint (`serve.searxng_url`),
and footnote search can open the external browser.

Annotate's **Export** shares an annotated PDF, EPUB or Markdown ZIP archive.
**Annotation backup** and Whiteboard export/import keep restorable ink/board
copies. The library's **Trash** view restores archived items, while **Restore**
offers saved 2-hour, 24-hour and 7-day snapshots when available. These exports are useful
before a fresh install as well as for sharing.

IndexedDB keeps the device's working copy. Local backend or paired hub storage
adds document/whiteboard/problem-board, agent, attachment and snapshot history.
Offline edits queue for sync; reconnecting may need a conflict choice. Python
workspaces, attempt archives, corpus indexes, session progress and test execution
remain on the device doing Practice. See the [storage split](../ARCHITECTURE.md#notebooks-vs-problems).

Android integrations provide native live web pages and page capture, gallery or
Downloads image saves, edge-gesture protection while writing, ML Kit ink
recognition, and dictation. Voice controls are under **Settings → LLM → Voice
dictation**. See [Android setup](docs/ANDROID_SETUP.md) for device/build details.

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
starts from a fresh board and a fresh session. Re-solving while looking at the
answer you already drew is not practice. The router owns the rules
([`../src/workspace/attempt.rs`](../src/workspace/attempt.rs)); the dialog only asks.

## Connecting a tablet

- **Desktop window on a tablet screen:** spacedesk (below). Router stays in-process.
- **APK:** same Tauri binary with the in-process router. From the repo root:
  `app\scripts\android-install-practice.cmd` (optional USB serial). First run generates
  `app/src-tauri/gen/android/` if missing. Practice installs its corpus separately
  on that device, and its configured model endpoint must be reachable from it.
- **Library sync:** in **Settings → Personalize → Storage → Pad hub**, enter the
  desktop app's PC URL and six-digit code on the tablet. Both flavors support
  the hub. Local commands and tests still use the tablet's embedded backend.

APK build/install → [`docs/ANDROID_SETUP.md`](docs/ANDROID_SETUP.md).

## The no-APK path (spacedesk)

**spacedesk** mirrors the PC's screen to the tablet over USB or Wi-Fi and sends
touch and stylus input back, so the tablet becomes a second display driving the
*desktop* app. Install the spacedesk driver on the PC and the viewer app on the
tablet, extend the display, then drag the Pen Island window onto it.

That means full desktop behaviour with no network pairing. Pixels cross the
link, not API calls. Pen strokes make a round trip to the PC and back before
they are drawn; try a page of handwriting before committing to this path.

Browser-only (`npm run dev`) is not supported. Use `npm run tauri dev` or
the APK.

## Android sideloading, no Play Store

See [`docs/ANDROID_SETUP.md`](docs/ANDROID_SETUP.md) for prerequisites, build
commands, and install steps. The APK uses the same in-process router as desktop;
optional LAN library pairing is in **Settings → Personalize → Storage → Pad hub**.

## Layout

| Path | What |
|---|---|
| `src/api/` | Named Tauri invoke client (`lc_run_tests`, …) and coach event transport |
| `src/canvas/` | Excalidraw wrapper, capture extractors, ink recognizers |
| `src/templates/` | Board regions and the pre-seeded problem layout |
| `src/viz/` | Viz schema with 17 kinds, renderers, applier, frame scrubber |
| `src/modes/` | Home, reading, attachments, Explore, Review, reveal, test results, attempt dialog, problem picker |
| `src/util/datasetKey.ts` | `dataset/task_id` keys, which is how per-problem state is addressed |
| `src/util/` | Persistence/migration, library and hub sync, snapshots, exports, reading and device preferences |
| `../src/workspace/attempt.rs` | Backend keep/discard/archive rules for Practice attempts |
| `src-tauri/` | Tauri shell, in-process harness router, desktop LAN listener, coach events |
| `src-tauri/plugins/` | `gallerysave`, `gestureguard`, `inkrecognition` (ML Kit), `livewebview`, `voicedictation` |

Viz kinds include arrays/grids, maps, trees, linked lists, heaps, stacks,
queues, graphs, tries, union-find, DP lists/tables, segment/call trees, composite
diagrams and bits. Paths in this table are relative to `app/`.

## Tests

```bash
npm test
```

Covers renderer golden output, frame stepping, skip-if-unchanged cost control,
persistence and migrations, hub queues/conflicts, artifacts and exports,
reading/layout behavior, agent requests/threads, and pairing helpers.

Type-check and bundle:

```bash
npm run build
```

## Notes on the design

**The model never emits coordinates.** LLMs are unreliable at coordinate
geometry and reliable at structured semantic state, so the agent emits a *viz
program*, full state per frame, and `viz/render/<kind>.ts` lays it out
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
