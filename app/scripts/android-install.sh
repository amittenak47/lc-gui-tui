#!/usr/bin/env bash
# Linux: build the Practice debug APK (aarch64) and adb install -r.
#
#   ./app/scripts/android-install.sh
#   ./app/scripts/android-install.sh <device-serial>
#
# Windows: app/scripts/android-install.cmd — that wrapper puts Git usr/bin on
# PATH so libffi-sys can find cp/make. Do not use this .sh on Windows.

set -euo pipefail
# shellcheck source=android-linux-env.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/android-linux-env.sh"
android_linux_require

serial="${1:-}"
npm run android:apk
apk="$(android_linux_find_apk)"
android_linux_adb_install "$apk" "$serial"
