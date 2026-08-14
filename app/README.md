# Whiteboard

Practice LeetCode by *whiteboarding*: sketch an approach by hand while an agent
watches, grills you, and points at the specific test case your approach breaks
on.

The canvas runs on the tablet. The corpus, the workspaces, and the Python test
runner stay on the PC, behind `whiteboard serve`.

```
┌─ XPPen Magic Note Pad (Android 14) ─┐        ┌─ PC / Mac ────────────────────┐
│  Tauri v2 app (this directory)       │        │  whiteboard serve (axum)      │
│   • Excalidraw canvas                │  HTTP  │   • index.rs   (SQLite corpus)│
│   • ML Kit ink→text (Kotlin plugin)  │◄──────►│   • generator.rs (workspaces) │
│   • viz renderer + frame scrubber    │   WS   │   • runner.rs  (python tests) │
│   • Review / Ambient modes           │        │   • llm/       (Ollama/Groq)  │
└──────────────────────────────────────┘        └───────────────────────────────┘
        the same binary also builds as a desktop window → localhost
```

The Magic Note Pad is a standalone Android tablet, not a pen display — Drawing
Display Mode needs DP-IN and only exists on the Magic *Drawing* Pad. Hence
client/server rather than screen mirroring.

## Getting started

Start the daemon on the PC:

```bash
cargo run -- serve --port 7878
```

Then, in this directory:

```bash
npm install
```

Validate the whole loop with a mouse before touching Android:

```bash
npm run tauri dev
```

The app defaults to `http://127.0.0.1:7878`, so nothing needs pairing on desktop.

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

A tab strip above the problem table switches between the five corpora
`whiteboard` indexes. Everything under it — search, filters, paging, session
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

Settings → **Tests** picks between running every case and stopping at the first
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

## Connecting the tablet

```bash
cargo run -- serve --lan
```

That binds all interfaces and prints the three things to type into the app's
header — **Host**, **Port** and a **6-digit Code**:

```
  Pair the tablet — type these into the app's header:
    Host: 192.168.1.20
    Port: 7878
    Code: 482917
```

Tap the host name in the header, type them, and the app trades the code for the
daemon's long token (`POST /pair`) and stores it. Pairing is a once-ever step per
device: the code rotates on every `serve --lan` start, but a device that already
holds the token keeps working. Settings → Serve shows the current code without
going back to the terminal.

The QR and the full `http://host:port?token=…` URL still print underneath, and
pasting that URL into the Host field still works — a tablet with only a
front-facing camera cannot scan its own PC, which is why the code is the path.

`--lan` means anyone on your network who has the token can drive your
workspaces. Prefer loopback when you're at the desk.

## The no-APK path (browser over the LAN, or spacedesk)

Two ways to use a tablet without building an APK.

### Browser over the LAN

Vite already binds every interface on port 1420, and the daemon answers
cross-origin requests, so the tablet's browser can load the app off the PC and
talk to the daemon directly. Two terminals:

```bash
cargo run -- serve --lan    # API on 7878, prints the pairing code
cd app && npm run dev       # app on 1420, bound to 0.0.0.0
```

Open `http://<pc-ip>:1420` on the tablet, then enter Host / Port / **Code** in
the header exactly as the APK build does — the app reaches the daemon on 7878,
which is a different port from the one you loaded the page from.

For the production bundle instead of the dev server: `npm run build && npm run
preview -- --host` (preview does not bind externally on its own, and it picks
its own port — read the one it prints).

> The daemon serves the API only. It has no static file handler, so
> `http://<pc-ip>:7878` in a browser will not give you the app.

What you give up is the part that needs native code: **ML Kit handwriting
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

- No pairing, no `--lan`, no token — the daemon stays on loopback, because
  nothing crosses the network but pixels.
- Full desktop behaviour, including whatever the PC's browser or Tauri build can
  do. Still no ML Kit: recognition runs on Android, and here Android is only a
  screen.
- Latency is the mirroring link's, not the app's. Pen strokes make a round trip
  to the PC and back before they are drawn, which is exactly the ink-latency
  risk `RasterInkLayer` exists to keep small — try a page of handwriting before
  committing to this path.

Rough guide: **spacedesk** to try the thing today without a build, **browser +
pairing** for a standalone tablet that keeps working when the PC screen is off,
and the **APK** when you want the pen to feel native and handwriting to be
transcribed on-device.

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
cleartext HTTP and `whiteboard serve` speaks plain HTTP on the LAN; without this the app
looks like it simply cannot see the PC. The script is idempotent, so re-run it
after any `init`/regeneration.

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

### 4. Point it at the PC

```bash
cargo run -- serve --lan     # on the PC itself, not inside WSL
```

Then pair from the app's header with the **Host**, **Port** and **6-digit code**
the daemon prints (see *Connecting the tablet* above). Check the daemon is
reachable at all with `http://<pc-ip>:7878/health` in the tablet's browser; if
that works but the app cannot connect, the overlay step did not apply.

The mobile layout — one template region per page, compact toolbar, no stock
Excalidraw chrome — is the same in the WebView as in the browser, so anything
you validate at `http://<pc-ip>:1420` carries over.

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
| `src/api/` | Daemon client, pairing, and the ambient WebSocket loop |
| `src/canvas/` | Excalidraw wrapper, capture extractors, ink recognizers |
| `src/templates/` | Board regions and the pre-seeded problem layout |
| `src/viz/` | Viz schema, the nine renderers, applier, frame scrubber |
| `src/modes/` | Review, reveal, test results, attempt dialog, problem picker |
| `src/util/datasetKey.ts` | `dataset/task_id` keys — how per-problem state is addressed |
| `src-tauri/` | Tauri shell, HTTP proxy, ML Kit plugin |

## Tests

```bash
npm test
```

Covers what the plan asks for: every renderer against golden output, frame
stepping replacing element ids in place rather than accumulating, the
skip-if-unchanged cost control, and pairing-URL parsing.

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
