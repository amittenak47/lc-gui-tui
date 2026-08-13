/**
 * Pointer → character, for the underline tool inside a mark.
 *
 * Why this is not `window.getSelection()`: while Underline is armed the browser
 * Selection is killed on every move. On a PDF the text layer is already a glyph
 * overlay on a bitmap, so a native selection wash paints a second, larger copy
 * of the words (the "blurry duplicate"), and dragging a grip lets the browser
 * flood-select past the mark. The custom path therefore has to answer the one
 * question Selection was answering: which character is under the finger.
 *
 * Why the previous answer was wrong: it sampled every `length / 24` characters.
 * A PDF text span is a dozen characters, so the step was 1 and nobody noticed;
 * a markdown paragraph is one 400-character text node, so the step was ~17 and
 * every drag landed most of a word away — then `snapToWords` widened it into a
 * block. Character position along a line is monotonic, so it is a binary
 * search, not a scan.
 */

import { textNodesOf } from "./docAnchors";
import { scaleOf, type LocalRect } from "./docMarquee";

/** A caret: the boundary before `offset` in `node`. */
export interface CaretPoint {
  node: Text;
  offset: number;
}

export interface CaretPointOptions {
  /**
   * Mark bands in body-local layout coordinates, with the body they were
   * measured against. Text inside them wins; text outside is the last resort,
   * so a drag that leaves the mark still tracks instead of freezing.
   */
  bands?: readonly LocalRect[] | null;
  body?: HTMLElement | null;
  /** Skip the browser's own caret lookup (tests, and jsdom which has none). */
  skipNative?: boolean;
}

interface ClientBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** The browser's caret at a viewport point, across both spellings of the API. */
export function caretRangeAtPoint(clientX: number, clientY: number): Range | null {
  if (typeof document === "undefined") return null;
  if (document.caretRangeFromPoint) return document.caretRangeFromPoint(clientX, clientY);
  const pos = document.caretPositionFromPoint?.(clientX, clientY);
  if (!pos) return null;
  const range = document.createRange();
  try {
    range.setStart(pos.offsetNode, pos.offset);
  } catch {
    return null;
  }
  range.collapse(true);
  return range;
}

/** Mark bands (body-local) as viewport boxes, so glyph rects can be tested. */
export function bandClientBoxes(
  body: HTMLElement,
  bands: readonly LocalRect[],
): ClientBox[] {
  const scale = scaleOf(body) || 1;
  const box = body.getBoundingClientRect();
  return bands.map((band) => ({
    left: box.left + band.left * scale,
    top: box.top + band.top * scale,
    right: box.left + (band.left + band.width) * scale,
    bottom: box.top + (band.top + band.height) * scale,
  }));
}

function overlaps(rect: ClientBox, box: ClientBox): boolean {
  return (
    rect.left < box.right &&
    rect.right > box.left &&
    rect.top < box.bottom &&
    rect.bottom > box.top
  );
}

function usable(rect: DOMRect): boolean {
  return rect.width >= 0.25 || rect.height >= 0.25;
}

/** Squared distance from a point to a box (0 when inside). */
function distanceTo(rect: ClientBox, x: number, y: number): number {
  const cx = Math.min(Math.max(x, rect.left), rect.right);
  const cy = Math.min(Math.max(y, rect.top), rect.bottom);
  return (cx - x) ** 2 + (cy - y) ** 2;
}

function rectsOf(node: Text): DOMRect[] {
  const range = node.ownerDocument.createRange();
  range.selectNodeContents(node);
  return Array.from(range.getClientRects()).filter(usable);
}

/** Box of the single character at `index`, or null when it has no geometry. */
function charRect(node: Text, index: number): DOMRect | null {
  if (index < 0 || index >= node.data.length) return null;
  const range = node.ownerDocument.createRange();
  try {
    range.setStart(node, index);
    range.setEnd(node, index + 1);
  } catch {
    return null;
  }
  const rect = range.getBoundingClientRect();
  return usable(rect) ? rect : null;
}

/**
 * Is the character at `index` before the pointer in reading order?
 *
 * Lines first, then x within a line — the ordering a caret follows. Characters
 * with no box (a collapsed wrap space) answer "before", which keeps the search
 * moving rather than stalling on a hole.
 */
function precedesPointer(node: Text, index: number, x: number, y: number): boolean {
  const rect = charRect(node, index);
  if (!rect) return true;
  if (rect.bottom <= y) return true;
  if (rect.top >= y) return false;
  // Same line: past the midpoint counts as the next character's side.
  return x >= (rect.left + rect.right) / 2;
}

/**
 * Character index in `node` nearest a viewport point.
 *
 * `O(log length)` reads of a one-character range, so a long markdown paragraph
 * costs the same as a short PDF span.
 */
export function charOffsetInNode(node: Text, clientX: number, clientY: number): number {
  let lo = 0;
  let hi = node.data.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (precedesPointer(node, mid, clientX, clientY)) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function nearestNode(
  root: Node,
  clientX: number,
  clientY: number,
  bands: ClientBox[] | null,
): Text | null {
  let best: { node: Text; distance: number } | null = null;
  for (const node of textNodesOf(root)) {
    if (!node.data || !/\S/.test(node.data)) continue;
    const rects = rectsOf(node);
    if (rects.length === 0) continue;
    let distance = Infinity;
    for (const rect of rects) {
      if (bands && !bands.some((band) => overlaps(rect, band))) continue;
      distance = Math.min(distance, distanceTo(rect, clientX, clientY));
    }
    if (!Number.isFinite(distance)) continue;
    if (!best || distance < best.distance) best = { node, distance };
  }
  return best?.node ?? null;
}

/**
 * Caret under a viewport point, inside `root`.
 *
 * The browser's own answer is taken whenever it lands in `root` — it is the
 * same lookup that works when the tool is off, and it already knows about
 * transforms, wrapping and bidi. It is deliberately *not* filtered by the mark
 * bands: bands are body-local layout rectangles and the caret is in viewport
 * pixels, and testing one against the other is what threw away good carets.
 * Keeping the range inside the mark is the caller's clamp, not this lookup's.
 */
export function caretPointIn(
  root: HTMLElement,
  clientX: number,
  clientY: number,
  options?: CaretPointOptions,
): CaretPoint | null {
  if (!options?.skipNative) {
    const range = caretRangeAtPoint(clientX, clientY);
    const container = range?.startContainer;
    if (
      range &&
      container &&
      container.nodeType === Node.TEXT_NODE &&
      root.contains(container)
    ) {
      const node = container as Text;
      return { node, offset: Math.min(range.startOffset, node.data.length) };
    }
  }

  const bands =
    options?.bands && options.bands.length > 0 && options.body
      ? bandClientBoxes(options.body, options.bands)
      : null;

  const node =
    (bands ? nearestNode(root, clientX, clientY, bands) : null) ??
    nearestNode(root, clientX, clientY, null);
  if (!node) return null;
  return { node, offset: charOffsetInNode(node, clientX, clientY) };
}
