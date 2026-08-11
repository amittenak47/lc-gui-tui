/**
 * Nested scrollers inside a document page.
 *
 * Board scroll is camera-owned: one capture-phase gatekeeper on `.lc-board`
 * takes every pointer and turns it into a page pan, which is right for prose
 * and wrong for the one kind of element in a note that has somewhere else to
 * go. A wide fenced codeblock showed an `overflow-x` scrollbar that nothing
 * could ever reach — the document layer is `pointer-events: none` so a pen
 * lands on the ink rather than the text, and anything that got past that was
 * `preventDefault`ed into a vertical pan.
 *
 * The gatekeeper asks this before it claims a gesture.
 *
 * **Not while annotating.** Ink is stored in the page's coordinates, and a box
 * that scrolls its own contents slides the words out from under marks that stay
 * put — a note drawn beside `if (x)` ends up beside something three tokens
 * along. That is the exact trade the whole document layer was built to avoid:
 * the markdown lays out at full height and rides the board camera rather than
 * scrolling itself, precisely so the ink cannot come off the words. A wide
 * codeblock is the one place an inner scroller crept back in, and it brings the
 * bug back with it, so annotate mode takes it out again: the block shows its
 * full width and the board pans to the rest of the line, the same as it does
 * for everything else on the page.
 */

/** Fractional overflow is a rounding artefact, not somewhere to scroll to. */
const OVERFLOW_SLACK_PX = 1;

/**
 * The nearest horizontally scrollable box at or above `target`, within the
 * document page — `null` if the pointer is on ordinary prose.
 *
 * Asks the DOM rather than matching on `pre`: a table or an embed in an
 * `overflow-x` box has exactly the same claim on a sideways drag, and a
 * codeblock whose lines all fit has none.
 */
export function horizontalScrollHost(
  target: EventTarget | null,
  /** Ink is on the page — see above. Nothing under it may scroll itself. */
  annotating = false,
): HTMLElement | null {
  if (annotating) return null;
  const start = target instanceof Element ? target : null;
  const doc = start?.closest(".lc-md-ink-doc, .lc-code-doc, .lc-epub-doc");
  if (!start || !doc) return null;
  const stop = doc.parentElement;
  for (let node: Element | null = start; node && node !== stop; node = node.parentElement) {
    if (!(node instanceof HTMLElement)) continue;
    if (node.scrollWidth - node.clientWidth <= OVERFLOW_SLACK_PX) continue;
    const overflowX = getComputedStyle(node).overflowX;
    if (overflowX === "auto" || overflowX === "scroll") return node;
  }
  return null;
}
