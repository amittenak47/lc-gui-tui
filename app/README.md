# lc whiteboard coach

Practice LeetCode by *whiteboarding*: sketch an approach by hand while a coach
watches, grills you, and points at the specific test case your approach breaks
on.

The canvas runs on the tablet. The corpus, the workspaces, and the Python test
runner stay on the PC, behind `lc serve`.

```
┌─ XPPen Magic Note Pad (Android 14) ─┐        ┌─ PC / Mac ────────────────────┐
│  Tauri v2 app (this directory)       │        │  lc serve (axum daemon)       │
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

**Review** — draw, tap **Submit**. The coach returns a verdict, ratings,
strengths, gaps, a Socratic question, and — when your approach is wrong — a
counterexample citing one of the problem's real sample cases.

**Ambient** — the coach glances at the board every 15 seconds. It stays silent
while nothing changes, and escalates rather than repeating itself: light
question → name the concept → point at the shape of input that breaks it → cite
a concrete case. Replies land in the side panel, never on the canvas, so they
can't disrupt writing.

**Draw it** — the coach answers with a diagram instead of prose. Multi-frame
traces become *one* diagram with a scrubber, not five copies of the same array.

**Reveal** — an explicit, confirmed opt-in that produces a stepwise path from
your approach to a working one. It is never a solution dump, and it is logged so
`lc stats` shows how often you tapped out.

## Connecting the tablet

```bash
cargo run -- serve --lan
```

That binds all interfaces, generates a pairing token once, and prints it as a QR
code. Tap the host name in the app's header and paste the URL (or scan it). The
token is stored locally, so pairing is a once-ever step.

`--lan` means anyone on your network who has the token can drive your
workspaces. Prefer loopback when you're at the desk.

## Android

```bash
npm run tauri android init
npm run tauri android dev
```

Two things to do after `init`:

1. Copy `src-tauri/android-overlay/network_security_config.xml` into
   `src-tauri/gen/android/app/src/main/res/xml/` and reference it from that
   project's `AndroidManifest.xml` `<application>` tag. Android 9+ blocks
   cleartext HTTP, and the daemon speaks plain HTTP on the LAN. The alternative
   is to route requests through `src-tauri/src/lc_client.rs`, which `reqwest`
   serves outside the WebView's policy.
2. Nothing for ML Kit — the plugin in `src-tauri/plugins/inkrecognition/`
   downloads its recognition model on first launch (a few MB) and is offline
   after that.

Measure ink latency on a scene of ~200 elements early. If it's intolerable, the
fallback is a raw-canvas ink layer under Excalidraw — `Board.tsx` sits behind
`BoardHandle`, so that swap stays local to `canvas/`.

## Layout

| Path | What |
|---|---|
| `src/api/` | Daemon client, pairing, and the ambient WebSocket loop |
| `src/canvas/` | Excalidraw wrapper, capture extractors, ink recognizers |
| `src/templates/` | Board regions and the pre-seeded problem layout |
| `src/viz/` | Viz schema, the nine renderers, applier, frame scrubber |
| `src/modes/` | Review, ambient, reveal, and problem-picker UI |
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
geometry and reliable at structured semantic state, so the coach emits a *viz
program* — full state per frame — and `viz/render/<kind>.ts` lays it out
deterministically into a reserved agent lane on the right of the board.

**The coach never reads its own output back.** Injected diagrams are tagged and
excluded from capture; otherwise the coach starts agreeing with itself.

**Cited test cases are verified, not trusted.** The daemon checks the cited
index against the workspace's real cases and replaces the quoted input/expected
with the corpus's own text. A fabricated citation is dropped and reported.
