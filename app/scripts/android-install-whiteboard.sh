#!/usr/bin/env bash
# Linux: Whiteboard-only debug APK (no Practice / no RustPython) and adb install -r.
#
#   ./app/scripts/android-install-whiteboard.sh
#   ./app/scripts/android-install-whiteboard.sh <device-serial>
#
# Windows: app/scripts/android-install-whiteboard.cmd
#
# Practice build: android-install-practice.sh. Both flavors write the same APK
# path and share the app id, so `adb uninstall dev.lc.whiteboard` before
# switching between them.

set -euo pipefail
# shellcheck source=android-linux-env.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/android-linux-env.sh"
android_linux_require

serial="${1:-}"
npm run android:apk:whiteboard
apk="$(android_linux_find_apk)"
android_linux_adb_install "$apk" "$serial"
