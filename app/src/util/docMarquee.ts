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
 * Not persisted as CSS selectors — only painted while the gesture is live.
 * Persistence is always the region (and optional harvested text).
 */
export const MARQUEE_HIT_SELECTOR = [
  "p",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "li",
  "blockquote",
  "pre",
  "figure",
  "img",
  "table",
  "tr",
  ".lc-md-ink-doc > *",
].join(",");

export function scaleOf(node: HTMLElement): number {
  const width = node.offsetWidth;
  if (width <= 0) return 1;
  const rendered = node.getBoundingClientRect().width;
  return rendered > 0 ? rendered / width : 1;
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
  for (const node of textNodesOf(body)) {
    if (!node.data.trim()) continue;
    const range = document.createRange();
    range.selectNodeContents(node);
    const box = range.getBoundingClientRect();
    if (box.width === 0 && box.height === 0) continue;
    const overlaps =
      box.left < right && box.right > left && box.top < bottom && box.bottom > top;
    if (overlaps) parts.push(node.data);
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
  const nodes = searchRoot.querySelectorAll(MARQUEE_HIT_SELECTOR);
  const out: LocalRect[] = [];
  const seen = new Set<Element>();
  for (const node of nodes) {
    if (!(node instanceof HTMLElement)) continue;
    if (seen.has(node)) continue;
    // Prefer the outermost interesting block: skip if a parent is also a hit target.
    const parentHit = node.parentElement?.closest(MARQUEE_HIT_SELECTOR);
    if (parentHit && parentHit !== node && searchRoot.contains(parentHit)) {
      continue;
    }
    seen.add(node);
    const box = node.getBoundingClientRect();
    if (box.width < 2 || box.height < 2) continue;
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
