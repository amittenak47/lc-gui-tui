/**
 * Laid-out height of the paper inside the content slot.
 *
 * The slot's own border box is the page frame, which can sit at the 1100 floor
 * while the HTML overflows it. Inner `scrollHeight` is the number the pan clamp
 * needs when the frame-grow pass missed.
 */
export const DOCUMENT_LAYER_SELECTOR =
  ".lc-md-ink-doc, .lc-pdf-doc, .lc-web-doc-wrap, .lc-epub-doc, .lc-code-doc, .lc-md-edit-host";

export function documentLayerHeight(slot: HTMLElement): number {
  let best = slot.scrollHeight;
  for (const inner of slot.querySelectorAll<HTMLElement>(DOCUMENT_LAYER_SELECTOR)) {
    best = Math.max(best, inner.scrollHeight, inner.offsetHeight);
  }
  return best;
}
