/**
 * Device-local preference: lock the agent sheet against drag-to-open/close.
 *
 * Off by default. Dragging the sheet handle is how most people open the agent on
 * mobile, but it also steals gestures from the board edge — pinning the sheet
 * stops accidental opens while annotating near the bottom.
 */

const KEY = "whiteboard.agent.sheetLock.v1";
const LEGACY_KEYS = ["whiteboard.coach.sheetLock.v1"];

/** Fired on the window when the preference changes. */
export const AGENT_SHEET_LOCK_EVENT = "lc-agent-sheet-lock";

export function loadAgentSheetLock(): boolean {
  try {
    const current = localStorage.getItem(KEY);
    if (current != null) return current === "1";
    for (const old of LEGACY_KEYS) {
      const value = localStorage.getItem(old);
      if (value != null) return value === "1";
    }
  } catch {
    return false;
  }
  return false;
}

export function saveAgentSheetLock(locked: boolean): void {
  try {
    localStorage.setItem(KEY, locked ? "1" : "0");
  } catch {
    /* private browsing */
  }
  window.dispatchEvent(
    new CustomEvent<boolean>(AGENT_SHEET_LOCK_EVENT, { detail: locked }),
  );
}
