/**
 * Extra highlighter end stamps. Off is an even round wash; on is the old
 * overlapping discs that multiply into darker tips.
 */

const KEY = "whiteboard.inkHighlightTips";
export const INK_HIGHLIGHT_TIPS_EVENT = "lc-ink-highlight-tips";
export const INK_HIGHLIGHT_TIPS_DEFAULT = false;

export function loadInkHighlightTips(): boolean {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw == null) return INK_HIGHLIGHT_TIPS_DEFAULT;
    return raw !== "0";
  } catch {
    return INK_HIGHLIGHT_TIPS_DEFAULT;
  }
}

export function saveInkHighlightTips(on: boolean): void {
  try {
    localStorage.setItem(KEY, on ? "1" : "0");
  } catch {
    /* private browsing */
  }
}
