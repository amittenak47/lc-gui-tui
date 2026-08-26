/**
 * Map a stroke's scene box onto one PDF page — or onto page 0 if it spans.
 *
 * Ink is stored in scene Y on a stacked textbook. Bitmaps already window to
 * the current page ±1; this module is the same idea for *strokes*. A stroke
 * belongs to exactly one shard: the page its AABB sits inside, or the spanning
 * shard (page 0) when it crosses a gap. Duplicating onto every overlapped page
 * would mean an erase writes two records and export would have to dedupe.
 *
 * Page frames come from the laid-out `.lc-pdf-page` divs (every page keeps its
 * height in the DOM even when its canvas is not painted). Two-up mode mounts
 * two slots with the same `data-pdf-page` and different scene Y — frames are
 * unique by Y, not by id. Markdown, EPUB and the whiteboard have no such
 * stack, so they fall back to a single page-1 frame covering the clip.
 */

import { inkOpBounds } from "./inkTiles";
import type { InkOp, SceneBounds } from "./rasterInk";
import { INK_LRU_RADIUS } from "../perfPreset";

export { INK_LRU_RADIUS };

/** Synthetic shard for strokes whose AABB crosses a page gap. */
export const SPANNING_PAGE_ID = 0;

/** How long a fast scrollbar skip waits before hydrating the new window. */
export const INK_PAGE_WINDOW_DEBOUNCE_MS = 100;

export const PDF_PAGE_SELECTOR = ".lc-pdf-page";

export interface PageFrame {
  /** 1-based PDF page number. Never 0 — that id is reserved for spanning. */
  pageId: number;
  minY: number;
  maxY: number;
}

/** Scene Y → home page. A Y in a gap belongs to the nearer neighbour. */
export function pageIndexForSceneY(y: number, frames: readonly PageFrame[]): number {
  if (frames.length === 0) return 1;
  let nearest = frames[0]!;
  let nearestDist = Infinity;
  for (const frame of frames) {
    if (y >= frame.minY && y <= frame.maxY) return frame.pageId;
    const dist =
      y < frame.minY ? frame.minY - y : y > frame.maxY ? y - frame.maxY : 0;
    if (dist < nearestDist) {
      nearestDist = dist;
      nearest = frame;
    }
  }
  return nearest.pageId;
}

/**
 * Page at the vertical center of a viewport band.
 *
 * Max-overlap picked the top sheet on a seam (equal overlap keeps the first
 * frame). Rest 2 and the filmstrip follow this id, so C must be the sheet in
 * the middle of the hole, not the one peeking under the header.
 */
export function pageIdAtViewport(
  frames: readonly PageFrame[],
  viewTop: number,
  viewBottom: number,
): number {
  if (!(viewBottom > viewTop) || frames.length === 0) return 1;
  return pageIndexForSceneY((viewTop + viewBottom) / 2, frames);
}

/**
 * Bin one committed op. Crossing two pages or sitting entirely in a gap → 0.
 */
export function pageIdForOp(op: InkOp, frames: readonly PageFrame[]): number {
  if (frames.length === 0) return 1;
  const box = inkOpBounds(op);
  const hits: PageFrame[] = [];
  for (const frame of frames) {
    if (box.maxY >= frame.minY && box.minY <= frame.maxY) hits.push(frame);
  }
  if (hits.length === 1) return hits[0]!.pageId;
  if (hits.length > 1) {
    const first = hits[0]!.pageId;
    if (hits.every((frame) => frame.pageId === first)) return first;
  }
  // Zero hits: the stroke lives in a gap or off the board. Several hits of
  // *different* pages: it crosses a seam. Both belong on the spanning shard
  // so mutations stay atomic. Two-up left|right of the same sheet share an id.
  if (frames.length === 1) return frames[0]!.pageId;
  return SPANNING_PAGE_ID;
}

export function binOpsByPage(
  ops: readonly InkOp[],
  frames: readonly PageFrame[],
): Map<number, InkOp[]> {
  const bins = new Map<number, InkOp[]>();
  for (const op of ops) {
    const pageId = pageIdForOp(op, frames);
    const list = bins.get(pageId);
    if (list) list.push(op);
    else bins.set(pageId, [op]);
  }
  return bins;
}

/** Pages the LRU should keep decoded, plus the spanning shard. */
export function lruWindow(currentPage: number, lastPage: number, radius = INK_LRU_RADIUS): number[] {
  const wanted: number[] = [SPANNING_PAGE_ID];
  const lo = Math.max(1, currentPage - radius);
  const hi = Math.max(lo, Math.min(lastPage, currentPage + radius));
  for (let page = lo; page <= hi; page += 1) wanted.push(page);
  return wanted;
}

/**
 * Read PDF page frames from the document slot without touching PdfDocument.
 *
 * Every `.lc-pdf-page` keeps its laid-out height even when the bitmap is not
 * in the paint window, so a 1500-page stack still has 1500 measurable boxes.
 */
export function pageFramesFromPdfSlot(
  slot: HTMLElement | null | undefined,
  pageBounds: SceneBounds | null | undefined,
): PageFrame[] {
  if (!slot || !pageBounds) return [];
  const pageW = pageBounds.maxX - pageBounds.minX;
  const pageH = pageBounds.maxY - pageBounds.minY;
  if (pageW <= 0 || pageH <= 0) return [];
  const slotRect = slot.getBoundingClientRect();
  if (slotRect.width < 1 || slotRect.height < 1) return [];
  const sy = slotRect.height / pageH;
  const nodes = slot.querySelectorAll<HTMLElement>(PDF_PAGE_SELECTOR);
  if (nodes.length === 0) return [];
  const frames: PageFrame[] = [];
  for (const node of nodes) {
    const raw = node.getAttribute("data-pdf-page");
    const pageId = raw ? Number.parseInt(raw, 10) : NaN;
    if (!Number.isFinite(pageId) || pageId < 1) continue;
    const r = node.getBoundingClientRect();
    frames.push({
      pageId,
      minY: pageBounds.minY + (r.top - slotRect.top) / sy,
      maxY: pageBounds.minY + (r.bottom - slotRect.top) / sy,
    });
  }
  frames.sort((a, b) => a.minY - b.minY || a.pageId - b.pageId);
  return frames;
}

/** Single-page documents (markdown, whiteboard, EPUB): everything bins to 1. */
export function fallbackPageFrames(clip: SceneBounds | null | undefined): PageFrame[] {
  if (!clip) return [{ pageId: 1, minY: -1e9, maxY: 1e9 }];
  return [{ pageId: 1, minY: clip.minY, maxY: clip.maxY }];
}

export function lastPageId(frames: readonly PageFrame[]): number {
  let last = 1;
  for (const frame of frames) {
    if (frame.pageId > last) last = frame.pageId;
  }
  return last;
}

/**
 * Scene-Y interval the camera hole covers. Shared by current-page and
 * overlap-list so rotate / pan cannot drift apart.
 */
export function cameraViewBand(
  scrollY: number,
  zoom: number,
  viewHeight: number,
): { top: number; bottom: number } | null {
  if (!(viewHeight > 0) || !(zoom > 0)) return null;
  const top = scrollY === 0 ? 0 : -scrollY;
  return { top, bottom: top + viewHeight / zoom };
}

/**
 * Which PDF page a saved camera was looking at.
 *
 * Reopen fits the column to today's viewport, then jumps here — raw scrollY
 * from another screen size would land between pages.
 */
export function pageIdFromCamera(
  frames: readonly PageFrame[],
  scrollY: number,
  zoom: number,
  viewHeight: number,
): number {
  const band = cameraViewBand(scrollY, zoom, viewHeight);
  if (!band || frames.length === 0) return 1;
  return pageIdAtViewport(frames, band.top, band.bottom);
}

/**
 * Every page whose stack frame crosses the camera hole — not the single
 * winner `pageIdAtViewport` returns, and not “C+1…C+5”.
 */
export function pageIdsIntersectingView(
  frames: readonly PageFrame[],
  scrollY: number,
  zoom: number,
  viewHeight: number,
): number[] {
  const band = cameraViewBand(scrollY, zoom, viewHeight);
  if (!band || frames.length === 0) return [];
  const ids = new Set<number>();
  for (const frame of frames) {
    if (frame.maxY >= band.top && frame.minY <= band.bottom) ids.add(frame.pageId);
  }
  return [...ids].sort((a, b) => a - b);
}

/**
 * Shift document-local frames into scene Y (page-frame `minY`).
 *
 * Layout math starts at the PDF stack origin, not the annotate frame. Ink and
 * the filmstrip both consume scene coordinates.
 */
export function offsetPageFrames(
  frames: readonly PageFrame[],
  originY: number,
): PageFrame[] {
  if (frames.length === 0) return [];
  if (originY === 0) return frames.slice();
  return frames.map((frame) => ({
    pageId: frame.pageId,
    minY: frame.minY + originY,
    maxY: frame.maxY + originY,
  }));
}

/** Excalidraw `scrollY` that puts a page's top just under the chrome inset. */
export function scrollYForPage(
  frames: readonly PageFrame[],
  pageId: number,
  zoom: number,
  insetTop = 0,
): number | null {
  if (!(zoom > 0)) return null;
  const frame = frames.find((item) => item.pageId === pageId);
  if (!frame) return null;
  return insetTop / zoom - frame.minY;
}
