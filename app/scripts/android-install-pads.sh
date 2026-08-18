#!/usr/bin/env bash
# Linux: pads-only debug APK (no Practice / no RustPython) and adb install -r.
#
#   ./app/scripts/android-install-pads.sh
#   ./app/scripts/android-install-pads.sh <device-serial>
#
# Windows: app/scripts/android-install-pads.cmd

set -euo pipefail
# shellcheck source=android-linux-env.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/android-linux-env.sh"
android_linux_require

serial="${1:-}"
npm run android:apk:pads
apk="$(android_linux_find_apk)"
android_linux_adb_install "$apk" "$serial"
