/**
 * Laid-out height of the paper inside the content slot.
 *
 * The slot's own border box is the page frame, which can sit at the 1100 floor
 * while the HTML overflows it. Inner `scrollHeight` is the number the pan clamp
 * needs when the frame-grow pass missed.
 */

export const DOCUMENT_LAYER_SELECTOR =
  ".lc-md-ink-doc, .lc-pdf-doc, .lc-web-doc-wrap, .lc-epub-doc, .lc-code-doc, .lc-md-edit-host";

/**
 * The document layers in `slot`: they sit within a few levels of it. Looked
 * for there first — a full `querySelectorAll` walks every KaTeX glyph of a
 * long note, ~50 ms on a tablet, and the page frames ask on every turn.
 */
function documentLayers(slot: HTMLElement): HTMLElement[] {
  const found: HTMLElement[] = [];
  const visit = (el: Element, depth: number) => {
    for (const child of Array.from(el.children)) {
      if (child.matches(DOCUMENT_LAYER_SELECTOR)) found.push(child as HTMLElement);
      else if (depth < 4) visit(child, depth + 1);
    }
  };
  visit(slot, 1);
  return found.length > 0 ? found : Array.from(slot.querySelectorAll<HTMLElement>(DOCUMENT_LAYER_SELECTOR));
}

export function documentLayerHeight(slot: HTMLElement): number {
  let best = 0;
  for (const inner of documentLayers(slot)) {
    best = Math.max(best, inner.scrollHeight, inner.offsetHeight);
  }
  // The slot includes the frame's tail padding. Feeding that back into frame
  // growth adds the padding again on each ResizeObserver delivery.
  return best > 0 ? best : slot.scrollHeight;
}
