#!/usr/bin/env bash
# Linux: build the Practice debug APK (aarch64) and adb install -r.
#
#   ./app/scripts/android-install-practice.sh
#   ./app/scripts/android-install-practice.sh <device-serial>
#
# Windows: app/scripts/android-install-practice.cmd — that wrapper puts Git
# usr/bin on PATH so libffi-sys can find cp/make. Do not use this .sh there.
#
# Whiteboard-only build: android-install-whiteboard.sh. Both share package
# dev.lc.whiteboard. This wrapper uses install -r to keep data for an update
# with a compatible signing certificate and version code. For a fresh install,
# uninstall only after exporting/backing up needed data and verifying the backup.

set -euo pipefail
# shellcheck source=android-linux-env.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/android-linux-env.sh"
android_linux_require

serial="${1:-}"
npm run android:apk:practice
apk="$(android_linux_find_apk)"
android_linux_adb_install "$apk" "$serial"
