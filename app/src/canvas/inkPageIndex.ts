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
 * height in the DOM even when its canvas is not painted). Markdown, EPUB and
 * the whiteboard have no such stack, so they fall back to a single page-1
 * frame covering the clip.
 */

import { inkOpBounds } from "./inkTiles";
import type { InkOp, SceneBounds } from "./rasterInk";

/** Synthetic shard for strokes whose AABB crosses a page gap. */
export const SPANNING_PAGE_ID = 0;

/** Decoded LRU starts at current ± this many pages (not LAYOUT_BATCH 32). */
export const INK_LRU_RADIUS = 3;

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
 * Page filling most of a viewport band — same rule as `pageAtViewport` for
 * template regions, applied to PDF frames.
 */
export function pageIdAtViewport(
  frames: readonly PageFrame[],
  viewTop: number,
  viewBottom: number,
): number {
  if (!(viewBottom > viewTop) || frames.length === 0) return 1;
  let best = frames[0]!;
  let bestOverlap = -1;
  for (const frame of frames) {
    const overlap = Math.min(viewBottom, frame.maxY) - Math.max(viewTop, frame.minY);
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      best = frame;
    }
  }
  return best.pageId;
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
  // Zero hits: the stroke lives in a gap or off the board. Several hits: it
  // crosses a seam. Both belong on the spanning shard so mutations stay atomic.
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
  frames.sort((a, b) => a.pageId - b.pageId);
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
