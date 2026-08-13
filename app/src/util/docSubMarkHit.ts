/**
 * Character offset under a pointer for custom Underline (sub-mark) drags.
 *
 * Native Selection already maps the pointer to a caret. The armed path must
 * not throw that caret away. Fallback is a line-box binary search — not
 * sampling every length/24 characters (that jumps by whole words on markdown).
 */

import { anchorFromRange } from "./docAnchors";
import { scaleOf, type LocalRect } from "./docMarquee";

export type CharHit = { start: number; root: HTMLElement; scope?: string };

function caretBoxAt(text: Text, offset: number): DOMRect | null {
  const range = document.createRange();
  try {
    range.setStart(text, Math.max(0, Math.min(offset, text.data.length)));
    range.collapse(true);
  } catch {
    return null;
  }
  return range.getBoundingClientRect();
}

function lineRectsOf(text: Text): DOMRect[] {
  const full = document.createRange();
  try {
    full.selectNodeContents(text);
  } catch {
    return [];
  }
  let rects: DOMRect[] = [];
  try {
    rects = Array.from(full.getClientRects()).filter(
      (rect) => rect.width >= 0.25 || rect.height >= 0.25,
    );
  } catch {
    rects = [];
  }
  if (rects.length > 0) return rects;
  const box = full.getBoundingClientRect();
  if (box.width < 0.25 && box.height < 0.25) return [];
  return [box];
}

/**
 * Character index in a single text node closest to the pointer.
 * Binary search on the line that contains `clientY` (or the nearest line).
 */
export function charIndexAtPoint(
  text: Text,
  clientX: number,
  clientY: number,
): number | null {
  const length = text.data.length;
  if (length === 0 || !/\S/.test(text.data)) return null;

  const lines = lineRectsOf(text);
  if (lines.length === 0) return null;

  const yPad = 8;
  const onLine = lines.filter(
    (rect) => clientY >= rect.top - yPad && clientY <= rect.bottom + yPad,
  );
  const line = (onLine.length > 0 ? onLine : lines).reduce((best, rect) => {
    const dy =
      clientY < rect.top ? rect.top - clientY : clientY > rect.bottom ? clientY - rect.bottom : 0;
    const bestDy =
      clientY < best.top ? best.top - clientY : clientY > best.bottom ? clientY - best.bottom : 0;
    return dy < bestDy ? rect : best;
  });

  let lo = 0;
  let hi = length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const box = caretBoxAt(text, mid);
    if (!box) {
      hi = mid;
      continue;
    }
    if (box.top >= line.bottom - 0.5) {
      hi = mid;
      continue;
    }
    if (box.bottom <= line.top + 0.5) {
      lo = mid + 1;
      continue;
    }
    if (box.left < clientX) lo = mid + 1;
    else hi = mid;
  }
  return Math.max(0, Math.min(length, lo));
}

function bandsToClient(
  body: HTMLElement,
  bands: readonly LocalRect[],
): Array<{ left: number; top: number; right: number; bottom: number }> {
  const scale = scaleOf(body) || 1;
  const bodyBox = body.getBoundingClientRect();
  return bands.map((band) => ({
    left: bodyBox.left + band.left * scale,
    top: bodyBox.top + band.top * scale,
    right: bodyBox.left + (band.left + band.width) * scale,
    bottom: bodyBox.top + (band.top + band.height) * scale,
  }));
}

function hitsClientBands(
  rect: DOMRect,
  bands: Array<{ left: number; top: number; right: number; bottom: number }>,
): boolean {
  return bands.some(
    (band) =>
      rect.left < band.right &&
      rect.right > band.left &&
      rect.top < band.bottom &&
      rect.bottom > band.top,
  );
}

export type CharOffsetOpts = {
  body?: HTMLElement;
  bands?: readonly LocalRect[];
  scope?: string;
};

/**
 * Walk SHOW_TEXT under `root`. Optional `bands` skip nodes whose boxes miss
 * the mark. Cost is O(nodes_on_line * log(node.length)), not O(length/24).
 */
export function charOffsetAtPoint(
  root: HTMLElement,
  clientX: number,
  clientY: number,
  opts?: CharOffsetOpts,
): CharHit | null {
  const clientBands =
    opts?.body && opts.bands && opts.bands.length > 0
      ? bandsToClient(opts.body, opts.bands)
      : null;

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let best: { dist: number; node: Text; offset: number } | null = null;
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const text = node as Text;
    if (!text.data || !/\S/.test(text.data)) continue;
    const lines = lineRectsOf(text);
    if (lines.length === 0) continue;
    if (clientBands && !lines.some((rect) => hitsClientBands(rect, clientBands))) continue;

    const index = charIndexAtPoint(text, clientX, clientY);
    if (index == null) continue;
    const caret = caretBoxAt(text, index);
    if (!caret) continue;
    const cx = Math.min(Math.max(clientX, caret.left), caret.right || caret.left);
    const cy = Math.min(Math.max(clientY, caret.top), caret.bottom);
    const dist = (cx - clientX) ** 2 + (cy - clientY) ** 2;
    if (!best || dist < best.dist) best = { dist, node: text, offset: index };
  }
  if (!best) return null;
  const range = document.createRange();
  const i = Math.min(best.offset, best.node.data.length);
  try {
    if (i < best.node.data.length) {
      range.setStart(best.node, i);
      range.setEnd(best.node, i + 1);
    } else if (i > 0) {
      range.setStart(best.node, i - 1);
      range.setEnd(best.node, i);
    } else {
      return null;
    }
  } catch {
    return null;
  }
  const anchor = anchorFromRange(root, range, opts?.scope);
  if (anchor?.start == null) return null;
  const start = i < best.node.data.length ? anchor.start : anchor.end;
  return { start, root, scope: opts?.scope };
}
