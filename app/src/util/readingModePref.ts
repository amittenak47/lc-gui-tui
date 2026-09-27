/**
 * How a document moves: one long scroll, or a page at a time.
 *
 *   - **scroll** — the continuous stack every document has always been.
 *   - **pages** — the view holds one page; a sideways drag turns it like a
 *     sheet of paper. Only while the pen is put away: with a drawing tool up,
 *     the page is for writing on.
 *
 * Saved on this device. `READING_MODE_EVENT` lets an open document switch
 * without a reload.
 */

export type ReadingMode = "scroll" | "pages";

const KEY = "whiteboard.readingMode.v1";
export const READING_MODE_EVENT = "lc-reading-mode";

export function isReadingMode(value: unknown): value is ReadingMode {
  return value === "scroll" || value === "pages";
}

export function loadReadingMode(): ReadingMode {
  try {
    const raw = localStorage.getItem(KEY);
    return isReadingMode(raw) ? raw : "scroll";
  } catch {
    return "scroll";
  }
}

export function saveReadingMode(mode: ReadingMode): void {
  const next = isReadingMode(mode) ? mode : "scroll";
  try {
    localStorage.setItem(KEY, next);
  } catch {
    /* storage unavailable — stays scroll next launch */
  }
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(READING_MODE_EVENT, { detail: next }));
  }
}
