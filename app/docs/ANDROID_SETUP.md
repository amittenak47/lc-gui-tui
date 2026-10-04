# Pen Island Android tablet setup

Guide for installing the Pen Island APK on an Android tablet and fixing PATH on Windows.

**Author device:** XPPen Magic Note Pad (MNP1095), Android 14 (API 34), NDK 29.0.13846066. If the APK misbehaves on another tablet, [open an issue](https://github.com/amittenak47/lc-gui-tui/issues).

The APK runs its harness in-process through named Tauri invokes and coach events. It works independently of a PC. Desktop also starts a LAN hub listener on `0.0.0.0` at the configured port (default `7878`), serving the shared router for optional tablet sync. Both flavors support the hub's PC URL and six-digit code under **Settings → Personalize → Storage → Pad hub**; no separate `lc serve` daemon is needed.

---

## 1. Prerequisites (PC)

| Requirement | Notes |
| --- | --- |
| **Android SDK + NDK** | Android Studio → SDK Platform 34 + NDK. Set `ANDROID_HOME` to `%LOCALAPPDATA%\Android\Sdk`. The author device was tested with NDK `29.0.13846066`; APK CI pins `r26d`. Check this difference when a local build and CI behave differently. |
| **JDK 17–24** | Set `JAVA_HOME` to a supported JDK. The picker uses it when valid, otherwise chooses the lowest supported installation it finds, and writes `org.gradle.java.home`. It skips JDK 25, including Android Studio's JBR `25.0.2`, which fails configuring `:buildSrc`. It does not hardcode `jdk-23`. |
| **Rust 1.93+ and Android targets** | The root crate requires Rust 1.93. Install targets with `rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android`. Practice debug builds target `aarch64`; Whiteboard-only builds are not restricted to that target. |
| **Node ≥22.13.0** | Locked `pdfjs-dist` 6.2.108 declares `>=22.13.0 \|\| >=24`. Both APK workflows pin Node 22. |
| **Windows Practice: Git for Windows + GNU make** | RustPython's bundled `libffi-sys` build needs `cp`, `sh`, and `make`. Install Git for Windows in its default location and run `winget install -e --id ezwinports.make`, then open a new shell. The Practice wrappers add Git's Unix tools through a path without spaces and add WinGet's links to PATH. Whiteboard-only does not need these RustPython build tools. |

On the tablet: **Settings → About → tap Build number 7×** → Developer options → **USB debugging** on. For no-cable installs, also turn on **Wireless debugging** (Android 11+; Magic Note Pad is 14).

---

## 2. One-time project setup

`src-tauri/gen/android/` is **not in git**. `android:apk:practice`,
`android:apk:whiteboard`, `android:dev`, and
`app\scripts\android-install-practice.cmd` / `android-install-whiteboard.cmd` run
`tauri android init` themselves when that folder is missing (needs Android SDK,
NDK, JDK 17–24). You can still generate it by hand:

```cmd
cd <repo>\app
npm install
npm run android:init
```

`android:init` generates `src-tauri/gen/android/`, applies the Android overlay, and runs `icons:sync`. The npm dev and APK build scripts also apply the overlay and synchronize icons. Regenerated Android projects receive the same fixes; keep generated files out of git.

### What is `android-overlay.mjs`?

`src-tauri/gen/android/` is **generated** by `tauri android init` and is not in git. Android 9+ blocks cleartext HTTP in WebViews by default.

The overlay lets the WebView fetch cleartext `http://` document URLs in Annotate mode. App commands use the in-process harness, while model requests go to the URL configured under Settings → LLM and corpus downloads use the external GitHub release. Optional hub sync uses the desktop's LAN listener.

`scripts/android-overlay.mjs` applies five fixes after init or regeneration:

1. Copy `src-tauri/android-overlay/network_security_config.xml` into the generated `res/xml/`.
2. Add `android:networkSecurityConfig="@xml/network_security_config"` on `<application>` in `AndroidManifest.xml`.
3. Rewrite generated `BuildTask.kt` to use `ExecOperations` instead of deprecated `Project.exec`.
4. Pin `buildSrc` Kotlin compilation to JVM 17.
5. Select a JDK 17–24 and pin Gradle's `org.gradle.java.home` to it.

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

Ordinary npm dev/build/init/test commands run from **`app\`**. The root forwards `adb:pair`, `adb:connect`, `adb:reconnect`, `adb:devices`, `android:wireless:practice`, `android:wireless:whiteboard`, and `logs:android` / `logs:open` / `logs:clear`; those commands work from either directory. The examples below state their working directory and use Windows CMD syntax unless marked Bash.

```cmd
cd <repo>
adb devices
app\scripts\android-dev.cmd
```

With a specific tablet, pass its USB serial to the cmd wrapper. It checks that `adb` sees the device and sets `ANDROID_SERIAL`. It does not pass the serial as Tauri's positional `DEVICE` argument, which matches the device name rather than the USB serial:

```cmd
cd <repo>
app\scripts\android-dev.cmd <your-device-serial>
```

For a shell with the required Practice tools already on PATH, the npm dev entry point runs from `app\`:

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

On Windows, use the `.cmd` wrappers. For Practice, install Git for Windows and `winget install -e --id ezwinports.make` first (§1). The wrapper puts Git `usr\bin` on PATH through a junction without spaces and checks for `make`; bundled `libffi-sys` needs `cp`, `sh`, and `make`. Direct Practice npm builds need the same prepared PATH. Whiteboard-only has no RustPython and does not need these tools.

```cmd
app\scripts\android-install-practice.cmd
app\scripts\android-install-practice.cmd <your-device-serial>
```

**Linux:** do not use the `.cmd` files. The `.sh` wrappers refuse to run on Windows and fail up front if SDK/NDK/JDK/`make`/the `aarch64-linux-android` Rust target are missing:

```bash
./app/scripts/android-install-practice.sh
./app/scripts/android-install-practice.sh <device-serial>
```

The Windows Practice wrapper also works from `app\` and handles either generated debug APK path (universal or arm64):

```cmd
cd <repo>\app
scripts\android-install-practice.cmd
```

**No USB cable:** wireless debugging (same Wi-Fi as the PC). Pairing is once; the connect *port* changes after a reboot.

```cmd
cd <repo>
npm run adb:pair -- 192.168.1.20:37123 123456
npm run adb:connect -- 192.168.1.20:41259
npm run android:wireless:practice
```

The pairing port is on **Pair device with pairing code**. The connect port is the **IP address & Port** line on the main Wireless debugging screen — they are not the same. After that, `npm run adb:reconnect` then `npm run android:wireless:practice`. Live PDF open log: `npm run logs:open` (pins the saved wireless serial so `adb logcat` does not fail with "more than one device/emulator").

Or copy the generated APK (see §8 for both possible paths) to the tablet → open in **Files** → allow "Install unknown apps" when prompted. Generated filenames differ from the APK asset names on GitHub releases.

**Updating or switching flavors:** the installers use `adb install -r`, which keeps app data when Android accepts the update. Both flavors use package `dev.lc.whiteboard`; an in-place replacement also needs a compatible signing certificate and an acceptable version code. Read the actual adb error if installation fails: APKs built locally and in CI may use different debug keys. Prefer an APK signed compatibly with the installed app. A normal uninstall removes the local library and configuration; use it only for an explicitly chosen fresh install after exporting or backing up the data you need and verifying that backup. [Android documents the `-r` option](https://developer.android.com/tools/adb#pm).

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

Or from `app\` on Windows:

```cmd
cd <repo>\app
scripts\android-install-whiteboard.cmd
```

Release: `npm run android:apk:whiteboard:release`.

Practice debug builds target `aarch64`; Whiteboard-only builds use the default multi-architecture output. The generated filenames do not identify the flavor, and both share package `dev.lc.whiteboard`. Switch with the appropriate installer using `install -r`, subject to the package/signature/version requirements above.

The old `android-install-pads.*` scripts and `android:apk:pads` npm targets
still work. They forward to the names above, and will be removed.

---

## 5. Running on the tablet

The APK bundles the pad library and coach inside the app process; the Practice flavor also includes RustPython tests. Problem corpora are a separate download under **Settings → Workspace → Datasets → Install**, from the GitHub `corpora-v1` release. On first launch Practice is an empty table until you install a set. The tablet works independently; a desktop app needs to be running only when using its hub or a model hosted on that PC.

The five native plugins in `app/src-tauri/plugins/` provide gallery/Downloads
capture saves (`gallerysave`), writing gesture protection (`gestureguard`), ML
Kit ink recognition (`inkrecognition`), live pages and capture (`livewebview`),
and dictation (`voicedictation`). Voice settings are under **Settings → LLM →
Voice dictation**. The `lc` CLI is for maintenance only (`index`, `datasets`,
`config`); Practice editing, tests and Agent actions are in the app.

### Architecture

```
Tablet APK  ──in-process──►  axum router (named invoke)  ──►  LLM URL from Settings → LLM
           └──optional LAN sync──►  desktop app hub (default port 7878, six-digit code)
```

- Coach answers stream over Tauri events (`lc-coach-frame`), not a session WebSocket to a PC.
- Configure the model under Settings → LLM on the device, where `localhost` means the tablet. Paste Groq or OpenAI keys there. The APK has no `GROQ_API_KEY` or `OPENAI_API_KEY` environment.
- For a local model, run Ollama or llama.cpp on the tablet itself, or point at a URL the tablet can reach (Tailscale, LAN IP, Groq, OpenAI, etc.).
- Desktop starts its shared-router LAN listener on `0.0.0.0` at the configured port. To use it for sync, enter the desktop's PC URL and six-digit code in **Settings → Personalize → Storage → Pad hub** on the tablet. This works with either flavor and is separate from adb wireless debugging.

### Tablet as a second display (optional)

spacedesk mirrors the desktop window to the tablet. Use its own connection setup to operate the desktop app from the tablet; this is separate from running the APK and connecting its pad hub.

---

## 6. Android bottom bar overlapping the app

The system navigation bar (gesture bar at the bottom) was overlapping the **Appearance / color palette**, pager, and zoom controls.

The app measures CSS safe-area values, native system-bar/cutout overlap from `get_system_insets`, and the visual viewport gap in `app/src/util/safeArea.ts`. It publishes `--lc-safe-bottom` for navigation chrome and a separate `--lc-keyboard-inset` for the keyboard, updating on resize and rotation. Rebuild and update the APK from the repo root on Windows:

```cmd
cd <repo>
app\scripts\android-install-practice.cmd
```

If controls still overlap, record the device/Android version, gesture or button navigation mode, orientation, keyboard state, and a screenshot. In a WebView inspector, read the computed root values of `--lc-safe-bottom` and `--lc-keyboard-inset` alongside `window.innerHeight` and `window.visualViewport` height/offset. For a reproducible report, enable **Settings → Personalize → Diagnostics → Debug log**, save, reproduce, and use **Export log**. `npm run logs:android` captures WebView console output from the selected adb device (using the saved wireless serial when connected); `logs:open` is specifically filtered for document-open events.

---

## 7. Quick troubleshooting

| Symptom | Fix |
| --- | --- |
| `'adb' is not recognized` | PATH is missing platform-tools. Fix it via the GUI (§3), then open a new cmd |
| `cargo` works, `adb` does not | Stale cmd window. Close every cmd and reopen |
| Tauri opens Android Studio | No device or emulator seen. Fix `adb` PATH, run `adb devices` |
| Coach offline, LLM unreachable | Settings → LLM on the tablet. Check the provider, the API key, and that the model URL is reachable from the tablet |
| `no src-tauri/gen/android` / init failed | Overlay runs `tauri android init` when missing. Check SDK, NDK, JDK 17–24, Rust 1.93+, and Node ≥22.13.0 (§1); from the repo root run `cd app && npm run android:init` |
| `:buildSrc` fails with `25.0.2` | Set `JAVA_HOME` to a JDK 17–24. The overlay selects a supported JDK and pins `org.gradle.java.home`; retry `npm run android:wireless:practice` |
| Annotate cannot load `http://` pages | Rebuild after overlay (`npm run android:overlay` then `android:apk:practice`) |
| Palette under system bar | Update through the installer, then collect measured insets and diagnostics (§6) |

---

## 8. Useful paths

| Item | Path |
| --- | --- |
| Universal debug APK | `app\src-tauri\gen\android\app\build\outputs\apk\universal\debug\app-universal-debug.apk` |
| arm64 debug APK (Practice fallback) | `app\src-tauri\gen\android\app\build\outputs\apk\arm64\debug\app-arm64-debug.apk` |
| Package id | `dev.lc.whiteboard` |
| App README | `app/README.md` |
