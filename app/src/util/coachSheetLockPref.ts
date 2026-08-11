/**
 * Device-local preference: lock the coach sheet against drag-to-open/close.
 *
 * Off by default. Dragging the sheet handle is how most people open the coach on
 * mobile, but it also steals gestures from the board edge — pinning the sheet
 * stops accidental opens while annotating near the bottom.
 */

const KEY = "lc.coach.sheetLock.v1";

/** Fired on the window when the preference changes. */
export const COACH_SHEET_LOCK_EVENT = "lc-coach-sheet-lock";

export function loadCoachSheetLock(): boolean {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

export function saveCoachSheetLock(locked: boolean): void {
  try {
    localStorage.setItem(KEY, locked ? "1" : "0");
  } catch {
    /* private browsing */
  }
  window.dispatchEvent(
    new CustomEvent<boolean>(COACH_SHEET_LOCK_EVENT, { detail: locked }),
  );
}
