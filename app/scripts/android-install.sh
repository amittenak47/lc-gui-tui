#!/usr/bin/env bash
# Renamed: this build is now called Practice. Forwards to
# android-install-practice.sh. Kept so existing shortcuts keep working; it will
# be deleted once the new name is the one in everyone's history.
exec "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/android-install-practice.sh" "$@"
