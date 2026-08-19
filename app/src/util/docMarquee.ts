/**
 * Marquee / area selection over a document — a drag box, not a caret range.
 *
 * Why this exists: hold-then-drag used to pick words with `caretRangeFromPoint`.
 * That fails on figures, scanned plates, and empty margins, and it fights
 * nested horizontal scroll. A rubber-band rectangle always works: it becomes a
 * {@link RegionAnchor} in the page's own coordinates. Words under the band are
 * optional extras for Copy / Google / coach (`textUnder`).
 */

import {
  excerptOf,
  regionAnchorFromRect,
  SCOPE_ATTR,
  textNodesOf,
  type DocAnchor,
  type RegionAnchor,
} from "./docAnchors";

/** Rectangle in the document body's unscaled layout coordinates. */
export interface LocalRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Thinnest a swept band may be on screen (converted by scale). */
export const MIN_BAND_PX = 14;

/**
 * Block-ish nodes a marquee can "hit" for outline chrome.
 *
 * Direct children of `.lc-md-ink-doc` used to all count, so a web snapshot
 * whose HTML is one wrapper `<div>` became a single hit the size of the page.
 * Generic shells are walked; real blocks (`p`, headings, figure) stop the walk
 * so inner `img` / `tr` stay nested under the outer block.
 */
const MARQUEE_BLOCK =
  "p, h1, h2, h3, h4, h5, h6, li, blockquote, pre, figure, img, table, tr";

const MARQUEE_DESCEND = new Set([
  "DIV",
  "SPAN",
  "SECTION",
  "NAV",
  "HEADER",
  "FOOTER",
  "MAIN",
  "ARTICLE",
  "ASIDE",
  "CENTER",
  "UL",
  "OL",
]);

export const MARQUEE_HIT_SELECTOR = [
  MARQUEE_BLOCK,
  ".lc-md-ink-doc > *",
  ".lc-web-doc > *",
].join(", ");

/** Content blocks plus leaf chrome; skip page-sized generic wrappers. */
export function marqueeHitNodes(searchRoot: HTMLElement): HTMLElement[] {
  const hits: HTMLElement[] = [];
  const walk = (node: Element) => {
    if (!(node instanceof HTMLElement)) return;
    if (node.matches(MARQUEE_BLOCK)) {
      hits.push(node);
      return;
    }
    if (MARQUEE_DESCEND.has(node.tagName) && node.children.length > 0) {
      for (const child of node.children) walk(child);
      return;
    }
    hits.push(node);
  };
  for (const child of searchRoot.children) walk(child);
  return hits;
}

export function scaleOf(node: HTMLElement): number {
  const width = node.offsetWidth;
  if (width <= 0) return 1;
  const rendered = node.getBoundingClientRect().width;
  return rendered > 0 ? rendered / width : 1;
}

/** Viewport boxes treated as the same when they match within this many CSS px. */
export const HOST_COVER_SLOP_PX = 4;

/**
 * Fraction of a reference box a rect must fill to count as a page wash.
 *
 * Edge-cover against the selectable body is not enough: the body is often a
 * long document, while `getClientRects` inside `contain:paint` answers with
 * the visible paper / content-slot box. That slot-sized wash is not a line.
 */
export const SLOT_COVER_FRACTION = 0.72;

export interface ViewportBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

const COVER_SLOT_SELECTORS = [".lc-page-content-slot", ".lc-page-marks-slot"] as const;

/**
 * True when `rect` is the host/slot box (or larger), not a line or block.
 *
 * `Range.getClientRects()` inside a transformed + `contain:paint` ancestor
 * (the page content slot) can answer with that ancestor's border box. Painting
 * that as a footnote band washes the whole page and shoves Copy/Google chrome
 * to the paper's corners.
 */
export function coversViewportBox(
  rect: ViewportBox,
  box: ViewportBox,
  slop = HOST_COVER_SLOP_PX,
): boolean {
  return (
    rect.left <= box.left + slop &&
    rect.top <= box.top + slop &&
    rect.right >= box.right - slop &&
    rect.bottom >= box.bottom - slop
  );
}

export function boxArea(box: ViewportBox): number {
  return Math.max(0, box.right - box.left) * Math.max(0, box.bottom - box.top);
}

export function overlapArea(a: ViewportBox, b: ViewportBox): number {
  const width = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
  const height = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
  return width * height;
}

/** True when `rect` fills most of `box` — a page wash, not a quote. */
export function coversMostOfBox(
  rect: ViewportBox,
  box: ViewportBox,
  fraction = SLOT_COVER_FRACTION,
): boolean {
  const area = boxArea(box);
  if (area < 1) return false;
  return overlapArea(rect, box) / area >= fraction && boxArea(rect) / area >= fraction;
}

export function isCoverRect(
  rect: ViewportBox,
  box: ViewportBox,
  slop = HOST_COVER_SLOP_PX,
): boolean {
  return coversViewportBox(rect, box, slop) || coversMostOfBox(rect, box);
}

/**
 * Boxes a quote rect must not match: the body, the paper slot, the marks slot.
 *
 * Compare against the visible paper, not only the selectable body. A long
 * document's body is taller than the page; a slot-sized artifact then survives
 * an edge-cover test and paints as a whole-page wash.
 */
export function coverReferenceBoxes(host: HTMLElement): ViewportBox[] {
  const boxes: ViewportBox[] = [];
  const seen = new Set<string>();
  const push = (node: Element | null | undefined) => {
    if (!(node instanceof HTMLElement)) return;
    const box = node.getBoundingClientRect();
    if (box.width <= 1 || box.height <= 1) return;
    const key = `${Math.round(box.left)}:${Math.round(box.top)}:${Math.round(box.width)}:${Math.round(box.height)}`;
    if (seen.has(key)) return;
    seen.add(key);
    boxes.push(box);
  };
  push(host);
  for (const selector of COVER_SLOT_SELECTORS) {
    push(host.closest(selector));
  }
  push(host.closest(".lc-canvas-wrap"));
  const board = host.closest(".lc-board");
  if (board) {
    push(board);
    for (const node of board.querySelectorAll(
      ".lc-page-content-slot, .lc-page-marks-slot, .lc-doc-select-overlay",
    )) {
      push(node);
    }
  }
  push(host.parentElement?.querySelector(".lc-doc-select-overlay"));
  return boxes;
}

export function isPageCoverRect(
  rect: ViewportBox,
  host: HTMLElement,
  slop = HOST_COVER_SLOP_PX,
): boolean {
  return coverReferenceBoxes(host).some((box) => isCoverRect(rect, box, slop));
}

export function unionViewportBoxes(
  rects: readonly ViewportBox[],
): DOMRect | null {
  if (rects.length === 0) return null;
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const rect of rects) {
    left = Math.min(left, rect.left);
    top = Math.min(top, rect.top);
    right = Math.max(right, rect.right);
    bottom = Math.max(bottom, rect.bottom);
  }
  if (!Number.isFinite(left) || right <= left || bottom <= top) return null;
  return new DOMRect(left, top, right - left, bottom - top);
}

function usableClientRect(rect: DOMRect): boolean {
  return rect.width > 0.5 && rect.height > 0.5;
}

function textRectsInRange(range: Range): DOMRect[] {
  const out: DOMRect[] = [];
  const root = range.commonAncestorContainer;
  const pushPiece = (node: Node) => {
    if (node.nodeType !== Node.TEXT_NODE || !range.intersectsNode(node)) return;
    const piece = node.ownerDocument?.createRange();
    if (!piece) return;
    try {
      piece.selectNodeContents(node);
      if (node === range.startContainer) piece.setStart(node, range.startOffset);
      if (node === range.endContainer) piece.setEnd(node, range.endOffset);
      if (piece.collapsed) return;
      out.push(...Array.from(piece.getClientRects()));
    } catch {
      /* detached */
    }
  };
  if (root.nodeType === Node.TEXT_NODE) {
    pushPiece(root);
    return out;
  }
  if (root.nodeType !== Node.ELEMENT_NODE) {
    const parent = root.parentElement;
    if (!parent) return out;
    for (const node of textNodesOf(parent)) pushPiece(node);
    return out;
  }
  for (const node of textNodesOf(root)) pushPiece(node);
  return out;
}

function blockBoxForRange(range: Range, host: HTMLElement): DOMRect[] {
  let node: Node | null = range.commonAncestorContainer;
  if (node.nodeType !== Node.ELEMENT_NODE) node = node.parentElement;
  while (node && node instanceof HTMLElement && host.contains(node)) {
    const box = node.getBoundingClientRect();
    if (usableClientRect(box) && !isPageCoverRect(box, host)) return [box];
    if (node === host) break;
    node = node.parentElement;
  }
  return [];
}

/**
 * Viewport line boxes for a range, skipping the host/slot containment artifact.
 *
 * Falls back to per-glyph text rects, then the smallest block ancestor that
 * is not the page itself.
 */
export function tightClientRects(range: Range, host: HTMLElement): DOMRect[] {
  const keep = (rects: readonly DOMRect[]) =>
    rects.filter((rect) => usableClientRect(rect) && !isPageCoverRect(rect, host));
  const fromRange = keep(Array.from(range.getClientRects()));
  if (fromRange.length > 0) return fromRange;
  const fromText = keep(textRectsInRange(range));
  if (fromText.length > 0) return fromText;
  return keep(blockBoxForRange(range, host));
}

/** Viewport rects → body-local layout coordinates (undo camera scale). */
export function clientRectsToLocal(
  host: HTMLElement,
  clientRects: ArrayLike<DOMRect>,
): LocalRect[] {
  const origin = host.getBoundingClientRect();
  const scale = scaleOf(host) || 1;
  return Array.from(clientRects)
    .filter(usableClientRect)
    .map((rect) => ({
      left: (rect.left - origin.left) / scale,
      top: (rect.top - origin.top) / scale,
      width: rect.width / scale,
      height: rect.height / scale,
    }));
}

/** Line / block boxes of a range, in the document body's layout coordinates. */
export function localRects(host: HTMLElement, range: Range): LocalRect[] {
  return clientRectsToLocal(host, tightClientRects(range, host));
}

/** Drop page-wash bands; keep line / block boxes. */
export function tightLocalRects(
  host: HTMLElement,
  rects: readonly LocalRect[],
): LocalRect[] {
  return rects.filter((rect) => !localRectCoversHost(host, rect));
}

export function localRectCoversHost(
  host: HTMLElement,
  rect: LocalRect,
  slop = HOST_COVER_SLOP_PX,
): boolean {
  const origin = host.getBoundingClientRect();
  const scale = scaleOf(host) || 1;
  return isPageCoverRect(
    {
      left: origin.left + rect.left * scale,
      top: origin.top + rect.top * scale,
      right: origin.left + (rect.left + rect.width) * scale,
      bottom: origin.top + (rect.top + rect.height) * scale,
    },
    host,
    slop,
  );
}

/** Viewport point → body-local layout coordinates. */
export function viewportToLocal(
  body: HTMLElement,
  clientX: number,
  clientY: number,
): { x: number; y: number } {
  const box = body.getBoundingClientRect();
  const scale = scaleOf(body) || 1;
  return {
    x: (clientX - box.left) / scale,
    y: (clientY - box.top) / scale,
  };
}

/** Rubber band between two body-local points. Height floored in screen px. */
export function bandFromLocalPoints(
  body: HTMLElement,
  a: { x: number; y: number },
  b: { x: number; y: number },
): LocalRect {
  const scale = scaleOf(body) || 1;
  const left = Math.min(a.x, b.x);
  const top = Math.min(a.y, b.y);
  const width = Math.abs(b.x - a.x);
  const height = Math.max(Math.abs(b.y - a.y), MIN_BAND_PX / scale);
  return { left, top, width, height };
}

/** Scope root under a viewport point, or the body. */
export function scopeRootAtPoint(
  body: HTMLElement,
  clientX: number,
  clientY: number,
): { root: HTMLElement; scope?: string } {
  const found = (
    document.elementFromPoint(clientX, clientY) as Element | null
  )?.closest?.(`[${SCOPE_ATTR}]`);
  if (found instanceof HTMLElement && body.contains(found)) {
    return {
      root: found,
      scope: found.getAttribute(SCOPE_ATTR) ?? undefined,
    };
  }
  return { root: body };
}

/** Axis-aligned union of body-local rects; null when empty. */
export function unionLocalRects(rects: readonly LocalRect[]): LocalRect | null {
  if (rects.length === 0) return null;
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const rect of rects) {
    left = Math.min(left, rect.left);
    top = Math.min(top, rect.top);
    right = Math.max(right, rect.left + rect.width);
    bottom = Math.max(bottom, rect.top + rect.height);
  }
  if (!Number.isFinite(left) || right <= left || bottom <= top) return null;
  return { left, top, width: right - left, height: bottom - top };
}

/**
 * Turn a body-local band into a durable region anchor (+ optional quote text).
 *
 * `hitRects` are intersecting content blocks for confirm chrome / footnote bands.
 * When nothing block-like intersects, falls back to the marquee rect itself.
 */
export function finalizeMarquee(
  body: HTMLElement,
  rect: LocalRect,
  root: HTMLElement,
  scope: string | undefined,
): {
  anchor: RegionAnchor;
  text: string;
  excerpt: string;
  hitRects: LocalRect[];
} | null {
  const scale = scaleOf(body) || 1;
  if (rect.width * scale < MIN_BAND_PX && rect.height * scale < MIN_BAND_PX) {
    return null;
  }
  const bodyBox = body.getBoundingClientRect();
  const anchor = regionAnchorFromRect(
    root,
    {
      left: bodyBox.left + rect.left * scale,
      top: bodyBox.top + rect.top * scale,
      width: rect.width * scale,
      height: rect.height * scale,
    },
    scope,
    scale,
  );
  if (!anchor) return null;
  const text = textUnder(body, rect, scale, bodyBox);
  const hits = hitRectsUnder(body, root, rect);
  return {
    anchor,
    text,
    excerpt: excerptOf(text),
    hitRects: hits.length > 0 ? hits : [rect],
  };
}

export function textUnder(
  body: HTMLElement,
  rect: LocalRect,
  scale: number,
  bodyBox: DOMRect,
): string {
  const left = bodyBox.left + rect.left * scale;
  const top = bodyBox.top + rect.top * scale;
  const right = left + rect.width * scale;
  const bottom = top + rect.height * scale;
  const parts: string[] = [];
  let fromCode = false;
  for (const node of textNodesOf(body)) {
    if (!node.data.trim()) continue;
    const range = document.createRange();
    range.selectNodeContents(node);
    const box = range.getBoundingClientRect();
    if (box.width === 0 && box.height === 0) continue;
    const overlaps =
      box.left < right && box.right > left && box.top < bottom && box.bottom > top;
    if (!overlaps) continue;
    if (node.parentElement?.closest("pre, code")) fromCode = true;
    parts.push(node.data);
  }
  if (parts.length === 0) return "";
  // Code fences keep newlines / indentation; prose collapses whitespace.
  if (fromCode) {
    return parts
      .join("")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/[ \t]+\n/g, "\n")
      .trimEnd();
  }
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

/**
 * Layout boxes of content blocks that intersect the marquee (for live chrome).
 *
 * Prefers nodes inside `root` when scoped (one PDF page / EPUB chapter).
 */
export function hitRectsUnder(
  body: HTMLElement,
  root: HTMLElement,
  rect: LocalRect,
): LocalRect[] {
  const scale = scaleOf(body) || 1;
  const bodyBox = body.getBoundingClientRect();
  const left = bodyBox.left + rect.left * scale;
  const top = bodyBox.top + rect.top * scale;
  const right = left + rect.width * scale;
  const bottom = top + rect.height * scale;
  // Prefer the scope root (one PDF page / chapter) when the body contains it.
  const searchRoot = body.contains(root) ? root : body;
  const nodes = marqueeHitNodes(searchRoot);
  const accepted = new Set(nodes);
  const out: LocalRect[] = [];
  const seen = new Set<Element>();
  for (const node of nodes) {
    if (seen.has(node)) continue;
    // Prefer the outermost interesting block: skip if a parent is also a hit target.
    let ancestor = node.parentElement;
    let nested = false;
    while (ancestor && searchRoot.contains(ancestor)) {
      if (accepted.has(ancestor)) {
        nested = true;
        break;
      }
      ancestor = ancestor.parentElement;
    }
    if (nested) continue;
    seen.add(node);
    const box = node.getBoundingClientRect();
    if (box.width < 2 || box.height < 2) continue;
    // Page-sized wrappers used to become the "block" wash.
    if (isPageCoverRect(box, body)) continue;
    const overlaps =
      box.left < right && box.right > left && box.top < bottom && box.bottom > top;
    if (!overlaps) continue;
    out.push({
      left: (box.left - bodyBox.left) / scale,
      top: (box.top - bodyBox.top) / scale,
      width: box.width / scale,
      height: box.height / scale,
    });
  }
  return out;
}

export type MarqueeResult = {
  text: string;
  excerpt: string;
  anchor: DocAnchor;
  /** Content-block boxes under the marquee (body-local); fallback = marquee itself. */
  hitRects: LocalRect[];
};
