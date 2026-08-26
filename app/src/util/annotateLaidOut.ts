/**
 * Open-gate for annotate paper: wait until a height report is stable.
 *
 * A height of zero is only an answer for a note that can legitimately be empty.
 * A file with text or bytes that reports zero has not laid out yet — treating
 * that as settled floors the page at `MD_INK_MIN_PAGE_H` and the pan clamp
 * will not travel down it.
 */
export function annotateHeightIsSettled(
  height: number | null,
  allowZero: boolean,
): boolean {
  if (height == null || !Number.isFinite(height) || height < 0) return false;
  if (height === 0) return allowZero;
  return true;
}

/** How long one height value must hold before the page is treated as laid out. */
export const ANNOTATE_LAYOUT_SETTLE_MS = 250;

const PDF_PAGE_POLL_MS = 50;

/**
 * Wait until the session PDF page exists in the stack.
 *
 * Height-only settle fires during the first layout batch's pause, while the
 * camera is still at page 1. Jumping after reveal is the "paints 1 then
 * jumps" open. This waits for `[data-pdf-page=N]` so restoreView can land
 * before the overlay lifts.
 */
export function waitForPdfPageNode(
  page: number,
  timeoutMs = 25000,
  failed?: () => string | null,
): Promise<boolean> {
  const want = Math.floor(Number(page));
  if (!(want >= 1)) return Promise.resolve(false);
  return new Promise((resolve) => {
    const deadline = performance.now() + timeoutMs;
    const tick = () => {
      if (failed?.()) {
        resolve(false);
        return;
      }
      if (typeof document !== "undefined") {
        const node = document.querySelector(`.lc-pdf-page[data-pdf-page="${want}"]`);
        if (node) {
          resolve(true);
          return;
        }
      }
      if (performance.now() >= deadline) {
        resolve(false);
        return;
      }
      globalThis.setTimeout(tick, PDF_PAGE_POLL_MS);
    };
    tick();
  });
}

/** True once pdf.js (or an LRU blit) has pixels on the session page. */
export function waitForPdfPagePainted(
  page: number,
  timeoutMs = 20000,
  failed?: () => string | null,
): Promise<boolean> {
  const want = Math.floor(Number(page));
  if (!(want >= 1)) return Promise.resolve(false);
  return new Promise((resolve) => {
    const deadline = performance.now() + timeoutMs;
    const tick = () => {
      if (failed?.()) {
        resolve(false);
        return;
      }
      if (typeof document !== "undefined") {
        const node = document.querySelector(
          `.lc-pdf-page[data-pdf-page="${want}"][data-painted]`,
        );
        if (node) {
          resolve(true);
          return;
        }
      }
      if (performance.now() >= deadline) {
        resolve(false);
        return;
      }
      globalThis.setTimeout(tick, PDF_PAGE_POLL_MS);
    };
    tick();
  });
}

/**
 * Wait until AnnotateDocument (or the PDF / EPUB / web reader) has reported a
 * stable height. Used under the loading overlay so reveal runs on a finished page.
 *
 * Stability is elapsed time at the same height, not a tick count — a main
 * thread stuck in long tasks can miss four 50 ms polls and still have been
 * the right height the whole time. A height that is still changing resets
 * the deadline, so a document still growing keeps its budget.
 *
 * Returns false when the timeout fires without a height — callers must not
 * treat that as "document ready" or the board reveals on a stuck "Opening…".
 * `failed` aborts the wait when pdf.js (or the reader) has already given up,
 * so a broken file does not sit through the full timeout and then show
 * "pick a smaller file".
 */
export function waitForAnnotateLaidOut(
  readHeight: () => number | null,
  timeoutMs = 8000,
  allowZero = true,
  failed?: () => string | null,
): Promise<boolean> {
  return new Promise((resolve) => {
    let deadline = performance.now() + timeoutMs;
    let last: number | null = null;
    let since = 0;
    const tick = () => {
      if (failed?.()) {
        resolve(false);
        return;
      }
      const now = performance.now();
      const height = readHeight();
      if (annotateHeightIsSettled(height, allowZero)) {
        if (last != null && Math.abs(height! - last) < 1) {
          if (now - since >= ANNOTATE_LAYOUT_SETTLE_MS) {
            resolve(true);
            return;
          }
        } else {
          if (last != null) deadline = now + timeoutMs;
          last = height;
          since = now;
        }
      }
      if (now >= deadline) {
        resolve(false);
        return;
      }
      globalThis.setTimeout(tick, 50);
    };
    tick();
  });
}
