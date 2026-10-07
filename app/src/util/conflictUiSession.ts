import type { ConflictUiLifecycle } from "./conflictUiWait";

/** A deliberate close after a decision differs from an unavailable window. */
export function conflictUiSession(lifecycle?: ConflictUiLifecycle) {
  let complete = false;
  return {
    complete() { complete = true; },
    onMounted: () => { if (!complete) lifecycle?.onMounted(); },
    onUnavailable: () => { if (!complete) lifecycle?.onUnavailable(); },
  };
}
