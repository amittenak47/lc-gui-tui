# Android tablet setup

Guide for installing the APK on an Android tablet and fixing PATH on Windows.

**Author device:** XPPen Magic Note Pad (MNP1095), Android 14 (API 34), NDK 29.0.13846066. If the APK misbehaves on another tablet, [open an issue](https://github.com/amittenak47/lc-gui-tui/issues).

The APK is **self-contained**: it runs the same in-process harness router as desktop (named Tauri invoke per route + coach events). There is no Host/Port/Code pairing UI, no `POST /pair`, and no PC daemon on port 7878.

---

## 1. Prerequisites (PC)

| Requirement | Notes |
| --- | --- |
| **Android SDK + NDK** | Android Studio → SDK Platform 34 + NDK. Set `ANDROID_HOME` to `%LOCALAPPDATA%\Android\Sdk`. |
| **JDK 17–23** | Point `JAVA_HOME` at a JDK 17, 21, or 23 install. **Not** Android Studio's bundled JBR if it is 25 — Gradle then fails configuring `:buildSrc` with the error `25.0.2`. The overlay picks `C:\Program Files\Java\jdk-23` (or another 17–24 JDK) and writes `org.gradle.java.home`. |
| **Rust Android targets** | `rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android` |
| **Node 20+** | For `npm install` / Tauri build |

On the tablet: **Settings → About → tap Build number 7×** → Developer options → **USB debugging** on. For no-cable installs, also turn on **Wireless debugging** (Android 11+; Magic Note Pad is 14).

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

The harness router is in-process, over named invoke, so the overlay is not for LAN daemon pairing. It lets the WebView fetch cleartext `http://` pages in Annotate mode, meaning external document URLs. Without it those fetches fail, even though coach and corpus traffic never leaves the app.

`scripts/android-overlay.mjs` re-applies two edits after every init or regen:

1. Copy `src-tauri/android-overlay/network_security_config.xml` into the generated `res/xml/`.
2. Add `android:networkSecurityConfig="@xml/network_security_config"` on `<application>` in `AndroidManifest.xml`.

`android:dev`, `android:apk:practice`, `android:apk:whiteboard`, `android-dev.cmd`, `android-install-practice.cmd`, and `android-install-whiteboard.cmd` run this automatically before every build. Idempotent, so running it twice is safe.

---

## 3. Permanent PATH on Windows (cmd)

Do not use `setx PATH`. Windows truncates PATH to 1024 characters and can break your profile.

### Add Android tools permanently, via the GUI

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

The two flavors are Practice, which is the default and has everything, and
Whiteboard-only, which drops Practice and RustPython. Options A and B build
Practice. Option C builds Whiteboard-only.

### Option A. USB dev loop, with build, install and hot reload

All npm commands below run from **`app\`** (not the repo root).

```cmd
cd <repo>\app
adb devices
npm run android:dev
```

With a specific tablet, use the cmd wrapper. Pass the USB serial only so the script can check that `adb` sees it. Tauri picks the connected device itself, and its `DEVICE` argument matches the Bluetooth name rather than the serial, so the serial is not forwarded:

```cmd
app\scripts\android-dev.cmd <your-device-serial>
```

Or with one tablet plugged in, no serial needed:

```cmd
cd <repo>\app
npm run android:dev
```

Common error: `Port 1420 is already in use`. A previous `android:dev` is still running. Ctrl+C it, or:

```cmd
netstat -ano | findstr :1420
taskkill /PID <pid> /F
```

Common error: `Opening Android Studio`, or file not found. Usually `adb` is missing from PATH, or no device is connected. Fix PATH, open a new cmd, run `adb devices`, retry.

### Option B. APK file, which is simpler

From the repo root (builds, then `adb install -r`).

On Windows, use the `.cmd` wrappers. They put Git `usr\bin` on PATH so bundled `libffi-sys` can find Unix `cp` and `make`. Do not call `npm run android:apk:practice` from a shell without those tools. Whiteboard-only has no RustPython and needs none of this.

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

**No USB cable:** wireless debugging (same Wi-Fi as the PC). Pairing is once; the connect *port* changes after a reboot.

```cmd
cd <repo>
npm run adb:pair -- 192.168.1.20:37123 123456
npm run adb:connect -- 192.168.1.20:41259
npm run android:wireless:practice
```

The pairing port is on **Pair device with pairing code**. The connect port is the **IP address & Port** line on the main Wireless debugging screen — they are not the same. After that, `npm run adb:reconnect` then `npm run android:wireless:practice`. Live PDF open log: `npm run logs:open` (pins the saved wireless serial so `adb logcat` does not fail with "more than one device/emulator").

Or copy `app-universal-debug.apk` to the tablet → open in **Files** → allow "Install unknown apps" when prompted.

**"App not installed":** old signing key still on device:

```cmd
adb uninstall dev.lc.whiteboard
adb install -r src-tauri\gen\android\app\build\outputs\apk\universal\debug\app-universal-debug.apk
```

### Option C. Whiteboard-only APK, no Practice

The default APK is the Practice build, which includes RustPython.
Whiteboard-only hides Practice in the frontend with `VITE_FEATURE_LEETCODE=0`
and omits the `leetcode` Cargo feature with `--no-default-features`, so no
RustPython. Both flags have to stay together, and the wrapper scripts set
both.

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

Both flavors write the same APK path and share the app id
`dev.lc.whiteboard`, so nothing on disk or on the device tells you which one you
have. Before switching:

```cmd
adb uninstall dev.lc.whiteboard
```

The old `android-install-pads.*` scripts and `android:apk:pads` npm targets
still work. They forward to the names above, and will be removed.

---

## 5. Running on the tablet

The APK bundles the harness inside the app process: RustPython tests, the pad library, and the coach. Problem corpora are a separate download, under Settings → Datasets → Install, from the GitHub `corpora-v1` release. On first launch Practice is an empty table until you install a set. Nothing on your PC needs to be running for the tablet to work.

### Architecture

```
Tablet APK  ──in-process──►  axum router (named invoke)  ──►  LLM URL from Settings → LLM
```

- Coach answers stream over Tauri events (`lc-coach-frame`), not a session WebSocket to a PC.
- Configure the model under Settings → LLM on the device, where `localhost` means the tablet. Paste Groq or OpenAI keys there. The APK has no `GROQ_API_KEY` or `OPENAI_API_KEY` environment.
- For a local model, run Ollama or llama.cpp on the tablet itself, or point at a URL the tablet can reach (Tailscale, LAN IP, Groq, OpenAI, etc.).

### Tablet as a second display (optional)

spacedesk mirrors the desktop window to the tablet, sending pixels only. There is no network pairing and no separate APK backend. It suits wanting the desktop harness on a bigger screen with pen input on the tablet.

---

## 6. Android bottom bar overlapping the app

The system navigation bar (gesture bar at the bottom) was overlapping the **Appearance / color palette**, pager, and zoom controls.

**Fix (in app):** mobile layout now adds `--lc-safe-bottom` (at least 48px on tablets) so bottom chrome sits above the system bar. Rebuild and reinstall the APK after pulling latest code:

```cmd
npm run android:apk:practice
adb install -r src-tauri\gen\android\app\build\outputs\apk\universal\debug\app-universal-debug.apk
```

If it still feels tight on your device, the constant lives in `app/src/styles.css` under `.lc-mobile { --lc-safe-bottom: max(..., 48px) }`. Try `56px`.

---

## 7. Quick troubleshooting

| Symptom | Fix |
| --- | --- |
| `'adb' is not recognized` | PATH is missing platform-tools. Fix it via the GUI (§3), then open a new cmd |
| `cargo` works, `adb` does not | Stale cmd window. Close every cmd and reopen |
| Tauri opens Android Studio | No device or emulator seen. Fix `adb` PATH, run `adb devices` |
| Coach offline, LLM unreachable | Settings → LLM on the tablet. Check the provider, the API key, and that the model URL is reachable from the tablet |
| `no src-tauri/gen/android` / init failed | Overlay now runs `tauri android init` itself. If that fails: SDK, NDK, JDK 17–23, then `cd app && npm run android:init` |
| `:buildSrc` fails with `25.0.2` | Android Studio JBR is JDK 25. Overlay pins Gradle to JDK 17–23 (`org.gradle.java.home`). Retry `npm run android:wireless:practice` |
| Annotate cannot load `http://` pages | Rebuild after overlay (`npm run android:overlay` then `android:apk:practice`) |
| Palette under system bar | Reinstall APK after safe-area fix (§6) |

---

## 8. Useful paths

| Item | Path |
| --- | --- |
| Debug APK | `app\src-tauri\gen\android\app\build\outputs\apk\universal\debug\app-universal-debug.apk` |
| Package id | `dev.lc.whiteboard` |
| App README | `app/README.md` |
