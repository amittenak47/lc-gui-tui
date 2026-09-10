/**
 * Device-local: the floating Hub Sync pill on the board chrome.
 * Off by default — Sync lives in the tab; this is the old overlay.
 */

const KEY = "whiteboard.hubSyncWindowPill";

export const HUB_SYNC_WINDOW_PILL_EVENT = "lc-hub-sync-window-pill";

function emit(): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(HUB_SYNC_WINDOW_PILL_EVENT));
  }
}

export function loadHubSyncWindowPill(): boolean {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

export function saveHubSyncWindowPill(on: boolean): void {
  try {
    localStorage.setItem(KEY, on ? "1" : "0");
  } catch {
    /* private browsing */
  }
  emit();
}
