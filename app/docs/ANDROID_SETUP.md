# Android tablet setup — lc whiteboard coach

Guide for installing the APK on an Android tablet (e.g. XPPen Magic Note Pad), fixing PATH on Windows, pairing with the PC daemon, and connecting when your home network uses a VPN router.

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

```cmd
cd <repo>\app
npm install
npm run android:init
```

`android:init` generates `src-tauri/gen/android/` and applies the cleartext-HTTP overlay (required for `lc serve` on LAN).

### What is `android-overlay.mjs`?

`src-tauri/gen/android/` is **generated** by `tauri android init` and is not in git. Android 9+ blocks cleartext HTTP in WebViews by default, which breaks calls to `lc serve` on your LAN (`http://192.168.x.x:7878`).

`scripts/android-overlay.mjs` re-applies two edits after every init or regen:

1. Copy `src-tauri/android-overlay/network_security_config.xml` into the generated `res/xml/`.
2. Add `android:networkSecurityConfig="@xml/network_security_config"` on `<application>` in `AndroidManifest.xml`.

`android:dev`, `android:apk`, and `android-dev.mjs` run this automatically before every build. Idempotent — safe to run twice.

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
**Common error:** `Port 1420 is already in use` — stop the previous `android:dev` (Ctrl+C) or:

```cmd
netstat -ano | findstr :1420
taskkill /PID <pid> /F
```

### Option B — APK file (simpler)

```cmd
cd <repo>\app
npm run android:apk
adb install -r src-tauri\gen\android\app\build\outputs\apk\universal\debug\app-universal-debug.apk
```

**No USB cable:** copy `app-universal-debug.apk` to the tablet → open in **Files** → allow “Install unknown apps” when prompted.

**“App not installed”:** old signing key still on device:

```cmd
adb uninstall dev.lc.whiteboard
adb install -r src-tauri\gen\android\app\build\outputs\apk\universal\debug\app-universal-debug.apk
```

---

## 5. Start the backend and pair

On the PC (repo root, **not** WSL for LAN pairing):

```cmd
cd <repo>
cargo run --release -- serve --lan
```

The banner prints **Host**, **Port**, and a **6-digit Code**.

### Pair on the tablet (important)

Tap the **host name** in the app header (shows `127.0.0.1:7878` until paired). Enter **three** fields:

| Field | Example | Notes |
| --- | --- | --- |
| **Host** | `192.168.132.135` | IP only — not `/health`, not `http://` |
| **Port** | `7878` | |
| **Code** | `482917` | 6 digits from the `serve --lan` banner |

Tap the arrow to pair. The app calls `POST /pair` and stores the long token.

**Browser `/health` working does not mean pairing succeeded.** `/health` needs no token; the app must complete pairing with the code.

### Architecture (what talks to what)

```
Tablet app  ──HTTP──►  lc serve on PC (:7878)  ──►  Ollama / OpenAI / Groq on PC (127.0.0.1)
```

- The tablet **never** calls Ollama directly.
- Settings → **LLM** shows the PC's `config.toml` (`localhost:11434` for Ollama is correct — that is on the desktop).
- Settings → **Serve** shows the pairing code for tablets (read-only on tablet; edit config on PC).
- You do **not** configure a separate "app URL" for the LLM.

### "Cannot reach lc serve" but browser works

The Android WebView blocks cleartext HTTP unless the network overlay is applied. Rebuild the APK after pulling fixes:

```cmd
cd <repo>\app
npm run android:overlay
npm run android:apk
adb install -r src-tauri\gen\android\app\build\outputs\apk\universal\debug\app-universal-debug.apk
```

Sanity check in the tablet browser (optional):

```
http://<pc-ip>:7878/health
```

---

## 6. Run desktop (optional, for mouse testing)

```cmd
cd <repo>
cargo run --release -- serve --port 7878

cd <repo>\app
npm run tauri dev
```

Desktop defaults to `http://127.0.0.1:7878` — no pairing needed.

---

## 7. Android bottom bar overlapping the app

The system navigation bar (gesture bar at the bottom) was overlapping the **Appearance / color palette**, pager, and zoom controls.

**Fix (in app):** mobile layout now adds `--lc-safe-bottom` (at least 48px on tablets) so bottom chrome sits above the system bar. Rebuild and reinstall the APK after pulling latest code:

```cmd
npm run android:apk
adb install -r src-tauri\gen\android\app\build\outputs\apk\universal\debug\app-universal-debug.apk
```

If it still feels tight on your device, the constant lives in `app/src/styles.css` under `.lc-mobile { --lc-safe-bottom: max(..., 48px) }` — try `56px`.

---

## 8. VPN router (ExpressVPN Aircove) — can the tablet still reach the PC?

### Short answer

**Sometimes on plain LAN IP, often not reliably through a VPN router.** The app does not use a cloud URL by default — the tablet talks directly to `lc serve` on your PC.

### What to try first (same home network)

1. PC and tablet both on the **Aircove Wi‑Fi** (not guest network).
2. On PC, find LAN IP: `ipconfig` → e.g. `192.168.1.20`.
3. On tablet browser: `http://192.168.1.20:7878/health`
4. If that works → pair in the app with that host + port + code from `serve --lan`.

Aircove may still allow **local LAN** traffic while VPN is on (depends on Aircove / split-tunnel settings). If `/health` fails, LAN pairing will not work.

### Recommended: Tailscale (works through VPN routers)

Install **Tailscale** on PC and tablet (same tailnet). Then:

```cmd
cargo run --release -- serve --lan
```

In the app, pair to the PC’s **Tailscale IP** (e.g. `100.x.x.x`), port `7878`, plus the 6-digit code. Traffic stays on your private mesh; no port forwarding on the public internet.

This is the most reliable option when a VPN router blocks or rewrites LAN traffic.

### Other options

| Option | Pros | Cons |
| --- | --- | --- |
| **Tailscale** | Stable IPs, encrypted, no router config | Extra install on both devices |
| **Browser on LAN** | No APK rebuild | No ML Kit ink recognition; needs `npm run dev` on PC |
| **spacedesk** | No network pairing; mirrors PC screen | Pen latency; no native ink |
| **Port forward + public IP** | Works from anywhere | Security risk; dynamic IP; use token + firewall |
| **Cloudflare Tunnel + Access** | HTTPS, email/device gate | Setup heavy; `lc serve` is HTTP-only today |
| **VPS running `lc serve`** | Always-on remote host | Must sync data dir / corpora; not built-in |

### “Whitelist only my tablet”

`lc serve --lan` already requires a **pairing code** (6 digits, new each restart) and a **long token** after pair. There is no per-device MAC whitelist in the app today.

Practical equivalents:

1. **Tailscale ACLs** — only your tablet’s node can reach port 7878 on the PC.
2. **Windows Firewall** — allow inbound TCP 7878 only from the tablet’s LAN or Tailscale IP.
3. **Do not port-forward** to the public internet unless you accept the risk; the token is the only auth layer.

The APK bundles the frontend — only the **API** (`lc serve`) must be reachable. You do **not** need to host the React app remotely for the APK; you only need the daemon.

### Browser-only remote path (no APK)

If you load the UI from a URL, you need **two** reachable endpoints:

- Frontend: `http://<host>:1420` (`npm run dev` or `npm run preview -- --host`)
- API: `http://<host>:7878` (pair + token)

The daemon does **not** serve static files — `http://<host>:7878` alone will not show the app.

---

## 9. Quick troubleshooting

| Symptom | Fix |
| --- | --- |
| `'adb' is not recognized` | PATH missing platform-tools — fix via GUI (§3), **new cmd** |
| `cargo` works, `adb` does not | Old cmd window — close all cmd, reopen |
| Tauri opens Android Studio | No device/emulator seen — fix `adb` PATH, `adb devices` |
| App can’t reach PC | Try `/health` in tablet browser; check overlay ran (`npm run android:overlay`) |
| Palette under system bar | Reinstall APK after safe-area fix (§7) |

---

## 10. Useful paths

| Item | Path |
| --- | --- |
| Debug APK | `app\src-tauri\gen\android\app\build\outputs\apk\universal\debug\app-universal-debug.apk` |
| Package id | `dev.lc.whiteboard` |
| App README | `app/README.md` |
