# Android tablet setup — Whiteboard

Guide for installing the APK on an Android tablet and fixing PATH on Windows.

**Author device:** XPPen Magic Note Pad (MNP1095), Android 14 (API 34), NDK 29.0.13846066. If the APK misbehaves on another tablet, [open an issue](https://github.com/amittenak47/lc-gui-tui/issues).

The APK is **self-contained**: it runs the same in-process harness router as desktop (named Tauri invoke per route + coach events). There is no Host/Port/Code pairing UI, no `POST /pair`, and no PC daemon on port 7878.

---

## 1. Prerequisites (PC)

| Requirement | Notes |
| --- | --- |
| **Android SDK + NDK** | Android Studio → SDK Platform 34 + NDK. Set `ANDROID_HOME` to `%LOCALAPPDATA%\Android\Sdk`. |
| **JDK 17** | Point `JAVA_HOME` at a JDK 17 install (fewer Gradle warnings). |
| **Rust Android targets** | `rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android` |
| **Node 20+** | For `npm install` / Tauri build |

On the tablet: **Settings → About → tap Build number 7×** → Developer options → **USB debugging** on.

---

## 2. One-time project setup

`src-tauri/gen/android/` is **not in git**. `android:apk:practice`,
`android:apk:whiteboard`, `android:dev`, and
`app\scripts\android-install-practice.cmd` / `android-install-whiteboard.cmd` run
`tauri android init` themselves when that folder is missing (needs Android SDK,
NDK, JDK 17+). You can still generate it by hand:

```cmd
cd <repo>\app
npm install
npm run android:init
```

`android:init` generates `src-tauri/gen/android/` and applies the cleartext-HTTP overlay (see below).

### What is `android-overlay.mjs`?

`src-tauri/gen/android/` is **generated** by `tauri android init` and is not in git. Android 9+ blocks cleartext HTTP in WebViews by default.

The harness router is in-process (named invoke) — the overlay is **not** for LAN daemon pairing. It allows the WebView to fetch cleartext `http://` pages in **Annotate** mode (external document URLs). Without it, those fetches fail even though coach and corpus traffic never leaves the app.

`scripts/android-overlay.mjs` re-applies two edits after every init or regen:

1. Copy `src-tauri/android-overlay/network_security_config.xml` into the generated `res/xml/`.
2. Add `android:networkSecurityConfig="@xml/network_security_config"` on `<application>` in `AndroidManifest.xml`.

`android:dev`, `android:apk:practice`, `android:apk:whiteboard`, `android-dev.cmd`, `android-install-practice.cmd`, and `android-install-whiteboard.cmd` run this automatically before every build. Idempotent — safe to run twice.

---

## 3. Permanent PATH on Windows (cmd)

**Do not use `setx PATH`** — Windows truncates PATH to 1024 characters and can break your profile.

### Add Android tools permanently (GUI — safest)

1. **Settings → System → About → Advanced system settings**
2. **Environment Variables**
3. Under **User variables**:
   - `ANDROID_HOME` = `%LOCALAPPDATA%\Android\Sdk`
   - Edit **Path** → **New** → add:
     - `%LOCALAPPDATA%\Android\Sdk\platform-tools`
     - `%LOCALAPPDATA%\Android\Sdk\emulator`
4. Close **all** cmd windows and open a new one.

### Verify (new cmd window)

```cmd
adb version
where adb
echo %ANDROID_HOME%
cargo --version
```

Expected:

- `adb version` prints version info
- `where adb` → `...\Android\Sdk\platform-tools\adb.exe`
- `ANDROID_HOME` → `...\Android\Sdk`

### Session-only fix (if you cannot restart cmd yet)

```cmd
set PATH=%PATH%;%LOCALAPPDATA%\Android\Sdk\platform-tools;%LOCALAPPDATA%\Android\Sdk\emulator
adb version
```

This does **not** survive closing the window.

### See PATH entries (one per line)

```cmd
for %P in ("%PATH:;=";"%") do @echo %~P
```

---

## 4. Build and install the APK

The two flavors are **Practice** (default, everything) and **Whiteboard-only**
(no Practice, no RustPython). Options A and B below build Practice; Option C
builds Whiteboard-only.

### Option A — USB dev loop (build + install + hot reload)

All npm commands below run from **`app\`** (not the repo root).

```cmd
cd <repo>\app
adb devices
npm run android:dev
```

With a specific tablet, use the cmd wrapper. Pass the USB serial only so the script can verify `adb` sees it — Tauri itself auto-picks the connected device (its `DEVICE` arg matches the Bluetooth name, not the serial, so we do not forward the serial to Tauri):

```cmd
app\scripts\android-dev.cmd <your-device-serial>
```

Or with one tablet plugged in, no serial needed:

```cmd
cd <repo>\app
npm run android:dev
```

**Common error:** `Port 1420 is already in use` — a previous `android:dev` is still running. Ctrl+C it, or:

```cmd
netstat -ano | findstr :1420
taskkill /PID <pid> /F
```

**Common error:** `Opening Android Studio` / file not found — often `adb` missing from PATH, or no device connected. Fix PATH, open a **new** cmd, `adb devices`, retry.

### Option B — APK file (simpler)

From the repo root (builds, then `adb install -r`).

**Windows** (this machine): use the `.cmd` wrappers. They put Git `usr\bin` on PATH so bundled `libffi-sys` can find Unix `cp`/`make`. Do not call `npm run android:apk:practice` from a shell that lacks those tools. (Whiteboard-only has no RustPython, so it needs none of this.)

```cmd
app\scripts\android-install-practice.cmd
app\scripts\android-install-practice.cmd <your-device-serial>
```

**Linux:** do not use the `.cmd` files. The `.sh` wrappers refuse to run on Windows and fail up front if SDK/NDK/JDK/`make`/the `aarch64-linux-android` Rust target are missing:

```bash
./app/scripts/android-install-practice.sh
./app/scripts/android-install-practice.sh <device-serial>
```

Or from `app\`:

```cmd
cd <repo>\app
npm run android:apk:practice
adb install -r src-tauri\gen\android\app\build\outputs\apk\universal\debug\app-universal-debug.apk
```

**No USB cable:** copy `app-universal-debug.apk` to the tablet → open in **Files** → allow “Install unknown apps” when prompted.

**“App not installed”:** old signing key still on device:

```cmd
adb uninstall dev.lc.whiteboard
adb install -r src-tauri\gen\android\app\build\outputs\apk\universal\debug\app-universal-debug.apk
```

### Option C — Whiteboard-only APK (no Practice)

The default APK is the **Practice** build: everything, including RustPython.
**Whiteboard-only** hides Practice in the frontend (`VITE_FEATURE_LEETCODE=0`)
and omits the `leetcode` Cargo feature (`--no-default-features`, so no
RustPython). Both flags must stay together — the wrapper scripts set both.

From the repo root:

```cmd
app\scripts\android-install-whiteboard.cmd
app\scripts\android-install-whiteboard.cmd <your-device-serial>
```

Linux: `./app/scripts/android-install-whiteboard.sh`.

Or from `app\`:

```cmd
cd <repo>\app
npm run android:apk:whiteboard
adb install -r src-tauri\gen\android\app\build\outputs\apk\universal\debug\app-universal-debug.apk
```

Release: `npm run android:apk:whiteboard:release`.

**Both flavors write the same APK path and share the app id
`dev.lc.whiteboard`**, so nothing on disk or on the device tells you which one
you have. Before switching:

```cmd
adb uninstall dev.lc.whiteboard
```

The old `android-install-pads.*` scripts and `android:apk:pads` npm targets
still work — they forward to the names above — but they will be removed.

---

## 5. Running on the tablet

The APK bundles the harness — RustPython tests, pad library, and coach — inside the app process. Problem corpora are DLC (Settings → Datasets → Install from GitHub `corpora-v1`). First launch Practice is an empty table until you install a set. Nothing on your PC needs to be running for the tablet to work.

### Architecture

```
Tablet APK  ──in-process──►  axum router (named invoke)  ──►  LLM URL from Settings → LLM
```

- Coach answers stream over Tauri events (`lc-coach-frame`), not a session WebSocket to a PC.
- Configure the model under **Settings → LLM** on the device (`localhost` there means the tablet). Paste Groq/OpenAI keys there — the APK has no `GROQ_API_KEY` / `OPENAI_API_KEY` environment.
- For a local model, run Ollama or llama.cpp on the tablet itself, or point at a URL the tablet can reach (Tailscale, LAN IP, Groq, OpenAI, etc.).

### Tablet as a second display (optional)

**spacedesk** mirrors the desktop window to the tablet (pixels only). No network pairing, no separate APK backend — useful when you want the desktop harness on a bigger screen with pen input on the tablet.

---

## 6. Android bottom bar overlapping the app

The system navigation bar (gesture bar at the bottom) was overlapping the **Appearance / color palette**, pager, and zoom controls.

**Fix (in app):** mobile layout now adds `--lc-safe-bottom` (at least 48px on tablets) so bottom chrome sits above the system bar. Rebuild and reinstall the APK after pulling latest code:

```cmd
npm run android:apk:practice
adb install -r src-tauri\gen\android\app\build\outputs\apk\universal\debug\app-universal-debug.apk
```

If it still feels tight on your device, the constant lives in `app/src/styles.css` under `.lc-mobile { --lc-safe-bottom: max(..., 48px) }` — try `56px`.

---

## 7. Quick troubleshooting

| Symptom | Fix |
| --- | --- |
| `'adb' is not recognized` | PATH missing platform-tools — fix via GUI (§3), **new cmd** |
| `cargo` works, `adb` does not | Old cmd window — close all cmd, reopen |
| Tauri opens Android Studio | No device/emulator seen — fix `adb` PATH, `adb devices` |
| Coach offline / LLM unreachable | **Settings → LLM** on the tablet — check provider, API key env, and that the model URL is reachable **from the tablet** |
| `no src-tauri/gen/android` / init failed | Overlay now runs `tauri android init` itself. If that fails: SDK, NDK, JDK 17+, then `cd app && npm run android:init` |
| Annotate cannot load `http://` pages | Rebuild after overlay (`npm run android:overlay` then `android:apk:practice`) |
| Palette under system bar | Reinstall APK after safe-area fix (§6) |

---

## 8. Useful paths

| Item | Path |
| --- | --- |
| Debug APK | `app\src-tauri\gen\android\app\build\outputs\apk\universal\debug\app-universal-debug.apk` |
| Package id | `dev.lc.whiteboard` |
| App README | `app/README.md` |
