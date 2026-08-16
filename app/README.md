# Whiteboard

Practice LeetCode by *whiteboarding*: sketch an approach by hand while an agent
watches, grills you, and points at the specific test case your approach breaks
on.

The desktop Tauri window embeds `lc serve` on loopback and the RustPython
judge. `lc serve` as a separate process remains for the CLI/TUI. This GUI does
not pair to a remote daemon (no header Host/Port/Code, no Settings Server tab).

```
┌─ Desktop Tauri (this directory) ─────────────────────────┐
│  React canvas  ──HTTP/WS──►  in-process axum :7878        │
│                              • corpus / workspaces        │
│                              • runner.rs (RustPython)     │
│                              • llm/ (Ollama / Groq / …)   │
└───────────────────────────────────────────────────────────┘
  same binary also builds as an Android APK (loopback daemon;
  APK size is a later pass). Tablet-as-display: spacedesk.
```

How the layers split (pad UI vs in-process daemon vs LLM), flags, and the
stripped Ask-only sibling: [Where the work lives](../README.md#where-the-work-lives)
in the repo README.

The Magic Note Pad is a standalone Android tablet, not a pen display — Drawing
Display Mode needs DP-IN and only exists on the Magic *Drawing* Pad. Hence
spacedesk (mirror the desktop window) rather than screen-mirroring a separate
PC daemon.

## Getting started

The desktop GUI starts the loopback daemon itself. `lc serve` is optional
(CLI/TUI, or a leftover process the GUI will reuse on port 7878). Vite-only
preview still needs a process on 7878.

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
the socket, the escalation ladder, and the side panel; nothing else was
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

A tab whose corpus has not been downloaded still appears, showing `0`, and its
empty table says which repo to fetch and which `whiteboard index --dataset …`
to run.
Pass/fail badges are per problem set: the daemon keys session progress on
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
answer you already drew is not practice. The daemon owns the rules
(`src/attempt.rs`); the dialog only asks.

## Connecting a tablet

This GUI talks only to `http://127.0.0.1:7878`. There is no header pairing form
and no Settings **Serve** page.

- **Desktop window on a tablet screen:** spacedesk (below). Daemon stays loopback.
- **APK:** same Tauri binary starts its own loopback daemon. Corpus and LLM still
  have to exist on that device; packaging/size is later.
- **`lc serve --lan`:** still in the CLI for TUI and leftover scripts. This app
  will not consume Host / Port / Code.

Older pairing walkthrough: [`docs/ANDROID_SETUP.md`](docs/ANDROID_SETUP.md).

## The no-APK path (browser, or spacedesk)

Two ways to use a tablet without building an APK. Neither uses GUI pairing —
that UI is gone.

### Browser on the PC

`npm run dev` / `npm run preview` is not Tauri, so it does not start the
daemon. Run the desktop app (`npm run tauri dev`) or `lc serve` on loopback,
then open the Vite URL **on the same machine**. A tablet browser cannot reach
`127.0.0.1` on the PC.

> The daemon serves the API only. `http://127.0.0.1:7878` in a browser will not
> give you the app.

What you give up without the APK is native code: **ML Kit handwriting
recognition is Android-only**, so pen strokes reach the agent as the board
picture rather than as text. Pick a vision-capable review model and the agent
still reads handwriting — see *Modes* above. If your review model has no vision,
type the approach with the text tool instead.

### spacedesk

spacedesk is a different trade: it mirrors the PC's screen to the tablet over
USB or Wi-Fi and sends touch and stylus input back, so the tablet becomes a
second display driving the *desktop* app. Install the spacedesk driver on the PC
and the viewer app on the tablet, extend the display, then drag the whiteboard
window onto it.

That means:

- No pairing, no `--lan`, no token — the desktop GUI’s daemon stays on loopback,
  because nothing crosses the network but pixels.
- Full desktop behaviour, including whatever the PC's browser or Tauri build can
  do. Still no ML Kit: recognition runs on Android, and here Android is only a
  screen.
- Latency is the mirroring link's, not the app's. Pen strokes make a round trip
  to the PC and back before they are drawn, which is exactly the ink-latency
  risk `RasterInkLayer` exists to keep small — try a page of handwriting before
  committing to this path.

Rough guide: **spacedesk** to try the thing today without a build, **Tauri
desktop** for the in-process daemon + RustPython, and the **APK** when you want
the pen to feel native and handwriting to be transcribed on-device.

## Android — sideloading the APK (no Play Store)

Tested target: Android 12 and 14 tablets, installed over USB or by copying the
APK across. Nothing here needs a Google account or a store listing.

### 1. Prerequisites on the PC

- Android Studio (or the standalone command-line tools) with **SDK Platform 34**
  and the **NDK**; set `ANDROID_HOME` and `NDK_HOME`.
- **JDK 17** (`java -version`). Newer JDKs build fine, but Gradle then compiles
  Kotlin and Java against different JVM targets and every `android:apk` run
  carries a wall of `inconsistent JVM-target compatibility` warnings. Pointing
  `JAVA_HOME` at a 17 install is the quiet path; there is nothing to fix if you
  are happy to read past them.
- The Android Rust targets:

  ```bash
  rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android
  ```

- On the tablet: Settings → About → tap *Build number* seven times, then
  Developer options → **USB debugging** on.

### 2. Generate the Gradle project

```bash
npm install
npm run android:init      # tauri android init + the overlay below
```

`src-tauri/gen/android/` is generated and git-ignored, so the two edits the app
needs are scripted rather than hand-applied — `npm run android:overlay` (which
every android script runs first) copies
`src-tauri/android-overlay/network_security_config.xml` into the project's
`res/xml/` and points the manifest's `<application>` at it. Android 9+ blocks
cleartext HTTP; the overlay remains for any leftover LAN fetch. The script is
idempotent, so re-run it after any `init`/regeneration.

Nothing to do for ML Kit — the plugin in `src-tauri/plugins/inkrecognition/`
downloads its recognition model on first launch (a few MB) and is offline after
that.

### 3. Build and install

With the tablet plugged in and unlocked, the fastest loop is:

```bash
npm run android:dev       # builds, installs, and hot-reloads over USB
```

For an APK you can keep and re-install:

```bash
npm run android:apk       # debug-signed → installs as-is
adb install -r src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk
```

`npm run android:apk:release` builds the release variant instead; that one is
**unsigned** and Android will refuse it until you sign it with your own
keystore, so prefer the debug APK for personal sideloading.

No cable? Copy the APK to the tablet and open it from Files:

- **Android 12** — a per-app permission: Settings → Apps → Special app access →
  Install unknown apps → *Files* / *Chrome* → Allow.
- **Android 14** — the same prompt appears the first time you tap the APK;
  allow it for the app you are installing from.

If the installer says *App not installed*, an older build with a different
signing key is still there: `adb uninstall dev.lc.whiteboard` first.

### 4. Loopback daemon

The APK starts the same in-process daemon as desktop (`127.0.0.1:7878`, no
token). There is nothing to type into a header. Corpus, workspaces, and LLM
URL are whatever exists on that device; APK size is a later pass.

The mobile layout — one template region per page, compact toolbar, no stock
Excalidraw chrome — is the same in the WebView as in the browser.

Measure ink latency on a scene of ~200 elements early. If it's intolerable, the
fallback is a raw-canvas ink layer under Excalidraw — `Board.tsx` sits behind
`BoardHandle`, so that swap stays local to `canvas/`.

The pen already draws on that raw-canvas layer (`RasterInkLayer.tsx`) rather than
on Excalidraw, so both ways the agent reads a board go through `rasterInk.ts`:
`getInkStrokes()` feeds the ops to ML Kit on Android, and `exportPng()` repaints
them into the PNG when the selected model has vision. Neither Excalidraw's
`freedraw` capture nor its exporter knows the pen exists.

## Layout

| Path | What |
|---|---|
| `src/api/` | Daemon client (frozen loopback URL) and the ambient WebSocket loop |
| `src/canvas/` | Excalidraw wrapper, capture extractors, ink recognizers |
| `src/templates/` | Board regions and the pre-seeded problem layout |
| `src/viz/` | Viz schema, the nine renderers, applier, frame scrubber |
| `src/modes/` | Home chooser, Review, reveal, test results, attempt dialog, problem picker |
| `src/util/datasetKey.ts` | `dataset/task_id` keys — how per-problem state is addressed |
| `src-tauri/` | Tauri shell, embedded harness daemon, HTTP proxy, ML Kit plugin |

## Tests

```bash
npm test
```

Covers renderer golden output, frame stepping, skip-if-unchanged cost control,
and pairing-URL helpers (still parsed; the GUI no longer stores a LAN pair).

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

**Cited test cases are verified, not trusted.** The daemon checks the cited
index against the workspace's real cases and replaces the quoted input/expected
with the corpus's own text. A fabricated citation is dropped and reported.

**Draw survives a server that cannot tool-call.** vLLM rejects a request
carrying `tools` unless it was started with `--enable-auto-tool-choice` and a
`--tool-call-parser`, and diagrams are the one mode built entirely on tool
calls. The daemon retries in plain JSON using the same schemas, so the feature
degrades in latency rather than in existence.

**Test results are the app's voice, not the student's.** They travel on their
own `app_messages` channel and the prompt tells the model to read them as fact.
Everything else on the board is something the student claimed and the agent is
meant to question; a real test run is not.
