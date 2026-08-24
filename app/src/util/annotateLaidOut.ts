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

/**
 * Wait until AnnotateDocument (or the PDF / EPUB / web reader) has reported a
 * stable height. Used under the loading overlay so reveal runs on a finished page.
 *
 * Returns false when the timeout fires without a height — callers must not
 * treat that as "document ready" or the board reveals on a stuck "Opening…".
 */
export function waitForAnnotateLaidOut(
  readHeight: () => number | null,
  timeoutMs = 8000,
  allowZero = true,
): Promise<boolean> {
  return new Promise((resolve) => {
    const start = performance.now();
    let last: number | null = null;
    let stable = 0;
    const tick = () => {
      const height = readHeight();
      if (annotateHeightIsSettled(height, allowZero)) {
        if (last != null && Math.abs(height! - last) < 1) {
          stable += 1;
          if (stable >= 3) {
            resolve(true);
            return;
          }
        } else {
          stable = 0;
        }
        last = height;
      }
      if (performance.now() - start >= timeoutMs) {
        resolve(false);
        return;
      }
      globalThis.setTimeout(tick, 50);
    };
    tick();
  });
}
