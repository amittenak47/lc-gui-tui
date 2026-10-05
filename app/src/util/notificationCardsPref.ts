/**
 * Device-local: show the stacked notification cards (top-left notices such
 * as "Linked …" or "Desktop app is offline …"). On by default. Turning it off
 * silences the cards only; in-place status (the Sync overlay, dialogs, error
 * banners) still shows.
 */

const KEY = "whiteboard.notificationCards";

export function loadNotificationCards(): boolean {
  try {
    return localStorage.getItem(KEY) !== "0";
  } catch {
    return true;
  }
}

export function saveNotificationCards(on: boolean): void {
  try {
    localStorage.setItem(KEY, on ? "1" : "0");
  } catch {
    /* private browsing */
  }
}
