# Shared Linux env + dependency checks for the tablet APK.
# Sourced by android-install.sh and android-install-pads.sh.
# Not for Windows — that path is android-install.cmd (Git usr/bin + NDK).

android_linux_require() {
  case "$(uname -s)" in
    Linux) ;;
    *)
      echo "android-install: this script is Linux-only." >&2
      echo "On Windows use app/scripts/android-install.cmd (or android-install-pads.cmd)." >&2
      echo "Do not run npm run android:apk from a Linux-shaped PATH on Windows:" >&2
      echo "libffi-sys will look for Unix cp/make and fail." >&2
      return 1
      ;;
  esac

  local app_dir
  app_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  cd "$app_dir"

  if [[ -z "${ANDROID_HOME:-}" ]]; then
    if [[ -n "${ANDROID_SDK_ROOT:-}" ]]; then
      ANDROID_HOME="$ANDROID_SDK_ROOT"
    elif [[ -d "$HOME/Android/Sdk" ]]; then
      ANDROID_HOME="$HOME/Android/Sdk"
    elif [[ -d /opt/android-sdk ]]; then
      ANDROID_HOME=/opt/android-sdk
    fi
  fi
  # `set -u` in the caller: leave unset vars empty rather than abort before
  # the missing-deps list can print.
  export ANDROID_HOME="${ANDROID_HOME:-}"
  export ANDROID_SDK_ROOT="${ANDROID_SDK_ROOT:-$ANDROID_HOME}"

  if [[ -z "${ANDROID_NDK_HOME:-}" && -n "${ANDROID_HOME}" && -d "$ANDROID_HOME/ndk" ]]; then
    # Newest installed NDK, same idea as the .cmd for /d loop.
    ANDROID_NDK_HOME="$(find "$ANDROID_HOME/ndk" -mindepth 1 -maxdepth 1 -type d | sort -V | tail -n 1 || true)"
  fi
  export ANDROID_NDK_HOME="${ANDROID_NDK_HOME:-}"

  if [[ -n "${ANDROID_HOME:-}" ]]; then
    PATH="$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$PATH"
    export PATH
  fi

  local missing=()
  [[ -n "${ANDROID_HOME:-}" && -d "$ANDROID_HOME" ]] || missing+=("ANDROID_HOME (install Android SDK; expected ~/Android/Sdk)")
  [[ -n "${ANDROID_NDK_HOME:-}" && -d "$ANDROID_NDK_HOME" ]] || missing+=("ANDROID_NDK_HOME (SDK Manager → NDK)")
  command -v java >/dev/null || missing+=("java (JDK 17+)")
  command -v adb >/dev/null || missing+=("adb (SDK platform-tools on PATH)")
  command -v cargo >/dev/null || missing+=("cargo")
  command -v rustup >/dev/null || missing+=("rustup")
  command -v npm >/dev/null || missing+=("npm")
  command -v node >/dev/null || missing+=("node")
  command -v make >/dev/null || missing+=("make (build-essential — libffi-sys builds C libffi)")
  command -v cp >/dev/null || missing+=("cp")
  command -v sh >/dev/null || missing+=("sh")

  if command -v rustup >/dev/null; then
    rustup target list --installed | grep -qx 'aarch64-linux-android' \
      || missing+=("rustup target aarch64-linux-android  (rustup target add aarch64-linux-android)")
  fi

  if ((${#missing[@]})); then
    echo "android-install: missing dependencies (tablet APK is picky — install these, then retry):" >&2
    local item
    for item in "${missing[@]}"; do
      echo "  - $item" >&2
    done
    echo "Debian/Ubuntu: sudo apt install build-essential" >&2
    echo "Then: rustup target add aarch64-linux-android" >&2
    return 1
  fi
}

android_linux_find_apk() {
  local apk="src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk"
  if [[ ! -f "$apk" ]]; then
    apk="src-tauri/gen/android/app/build/outputs/apk/arm64/debug/app-arm64-debug.apk"
  fi
  if [[ ! -f "$apk" ]]; then
    echo "APK not found under src-tauri/gen/android/app/build/outputs/apk/" >&2
    echo "Build failed, or gen/android was not generated. From app/: npm run android:init" >&2
    echo "Needs Android SDK, NDK, and JDK 17+." >&2
    return 1
  fi
  printf '%s\n' "$apk"
}

android_linux_adb_install() {
  local apk="$1"
  local serial="${2:-}"
  if [[ -n "$serial" ]]; then
    adb -s "$serial" install -r "$apk"
  else
    adb install -r "$apk"
  fi
}
