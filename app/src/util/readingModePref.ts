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

/**
 * How much of the view a page fills in Pages reading: the whole page, edge to
 * edge on its limiting side, or 90% of that with a margin around it. Whatever
 * is around the page — its neighbours included — is hidden either way.
 */
export type PageFitPref = "full" | "margin";

const FIT_KEY = "whiteboard.pageFit.v1";

export function isPageFitPref(value: unknown): value is PageFitPref {
  return value === "full" || value === "margin";
}

export function loadPageFit(): PageFitPref {
  try {
    const raw = localStorage.getItem(FIT_KEY);
    return isPageFitPref(raw) ? raw : "full";
  } catch {
    return "full";
  }
}

export function savePageFit(fit: PageFitPref): void {
  const next = isPageFitPref(fit) ? fit : "full";
  try {
    localStorage.setItem(FIT_KEY, next);
  } catch {
    /* storage unavailable — full page next launch */
  }
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(READING_MODE_EVENT, { detail: loadReadingMode() }));
  }
}

/** The share of the view the page takes on its limiting side. */
export function pageFitShare(fit: PageFitPref): number {
  return fit === "margin" ? 0.9 : 1;
}

/**
 * Pages reading for text, code, markdown and EPUB: one page at a time, or two
 * side by side like an open book. A reading preference, not a layout — the
 * document is the same either way — so one setting for all of them.
 */
const TEXT_SPREAD_KEY = "whiteboard.textSpread.v1";

export function loadTextSpread(): boolean {
  try {
    return localStorage.getItem(TEXT_SPREAD_KEY) === "1";
  } catch {
    return false;
  }
}

export function saveTextSpread(on: boolean): void {
  try {
    localStorage.setItem(TEXT_SPREAD_KEY, on ? "1" : "0");
  } catch {
    /* storage unavailable — single pages next launch */
  }
}
