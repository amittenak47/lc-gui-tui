#!/usr/bin/env bash
# Renamed: "pads-only" is now called Whiteboard-only. Forwards to
# android-install-whiteboard.sh. Kept so existing shortcuts keep working; it
# will be deleted once the new name is the one in everyone's history.
exec "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/android-install-whiteboard.sh" "$@"
