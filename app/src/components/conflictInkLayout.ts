/**
 * Where a conflict pane draws one page's handwriting.
 *
 * Strokes are stored in board scene coordinates — an absolute Y down the whole
 * stack — and bucketed by which page frame contains them. A pane lays the same
 * document out at its own width, so drawing them means two things: a scale
 * from scene units to this pane's pixels, and the scene Y the page starts at.
 *
 * Getting the second one wrong is not a small error. Without it every page's
 * ink is painted as though the book began at that page, which on page 40 of a
 * textbook is ink somewhere off the bottom of the world.
 */

import type { PageFrame } from "../canvas/inkPageIndex";
import { inkOpBounds } from "../canvas/inkTiles";
import { b64ToBytes } from "../api/nativeHttp";
import { decodeInkOps, unpackEncodedInk } from "../canvas/inkCodec";
import { inkOpsBounds, type InkOp } from "../canvas/rasterInk";
import { bytesFromMaybeGzip } from "../util/gzip";
import type { InkPageDto } from "../api/client";
import { drawPageFitBox } from "../canvas/documentRotateCamera";
import {
  linedFirstRuleScene,
  linedPaperCssGap,
} from "../util/linedPaperPref";
import {
  SCRATCH_PAGE_GUTTER,
  SCRATCH_PAGE_H,
  SCRATCH_PAGE_W,
  whiteboardMergeFrames,
  whiteboardMergeOpsForPage,
  whiteboardPageFrames,
} from "../templates/whiteboard";

/** A page's box in the pane, relative to the document element. */
export interface ConflictInkSlot {
  page: number;
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface ConflictInkPlacement {
  /** Scene units → pane pixels. */
  scale: number;
  /** Scene X at the canvas's left edge (may be left of the page). */
  originX: number;
  /** The scene Y this page starts at; the paint origin. */
  originY: number;
}

/**
 * The transform for one page's strokes.
 *
 * The board's own frame is the right answer when there is one: it is the scene
 * the strokes were actually drawn in. When there is not — the reader's frames
 * are empty, or they describe a layout this pane does not share — the pane's
 * own measurement stands in. `slot.top` is where this page sits in the pane,
 * and dividing by the scale converts that back into scene units.
 *
 * What it must never do is fall back to zero. Zero on every page draws the
 * same window of the stack onto every canvas — the top of the book repeated
 * down the pane, or nothing at all once the strokes are past it — which is
 * exactly the "every page shows the same handwriting" this is for.
 *
 * Horizontal fit matches the whiteboard: union the page with ink that sits
 * left of the frame, then width-fit that box so the first letters are not
 * clipped off the pane.
 */
/** Width-fit span the board uses: page union ink, including stroke width. */
export function conflictFitSpan(
  sceneWidth: number | undefined,
  ink?: { minX: number; maxX?: number } | null,
): { minX: number; width: number } | null {
  const pageW = sceneWidth && sceneWidth > 0 ? sceneWidth : 0;
  if (!(pageW > 0)) return null;
  const fitted = drawPageFitBox(
    { minX: 0, minY: 0, maxX: pageW, maxY: SCRATCH_PAGE_H },
    ink ?? null,
    pageW,
  );
  return { minX: fitted.minX, width: Math.max(1, fitted.maxX - fitted.minX) };
}

export function conflictInkPlacement(
  slot: ConflictInkSlot,
  frame: PageFrame | undefined,
  sceneWidth: number | undefined,
  ink?: { minX: number; maxX?: number } | null,
): ConflictInkPlacement {
  const fitted = conflictFitSpan(sceneWidth, ink);
  if (!fitted) {
    return { scale: 1, originX: 0, originY: frame?.minY ?? 0 };
  }
  const scale = slot.width / fitted.width;
  if (frame) return { scale, originX: fitted.minX, originY: frame.minY };
  return {
    scale,
    originX: fitted.minX,
    originY: scale > 0 ? slot.top / scale : 0,
  };
}

/** Scene X of every stroke, for the same width-fit the board uses. */
export function conflictInkXBounds(
  ops: readonly InkOp[],
): { minX: number; maxX: number } | null {
  const bounds = inkOpsBounds(ops);
  if (!bounds) return null;
  return { minX: bounds.minX, maxX: bounds.maxX };
}

/**
 * Strokes that overlap this page's slot, regardless of which shard stored them.
 *
 * Whiteboard ink used to live in one page-1 blob even after the writer scrolled
 * onto pad-2. Painting only `page_id === slot.page` left later pages blank.
 */
export function conflictOpsForPage(
  ops: readonly InkOp[],
  pageId: number,
  frames: readonly PageFrame[],
): InkOp[] {
  const frame = frames.find((row) => row.pageId === pageId);
  if (!frame) {
    if (pageId === 1) return [...ops];
    return [];
  }
  return ops.filter((op) => {
    const box = inkOpBounds(op);
    return box.maxY >= frame.minY && box.minY <= frame.maxY;
  });
}

/** Notebook pages that actually carry strokes, from scene Y not shard ids. */
export function inkPageIdsFromOps(
  ops: readonly InkOp[],
  frames: readonly PageFrame[],
): number[] {
  if (ops.length === 0) return [];
  if (frames.length <= 1) {
    const only = frames[0]?.pageId;
    return only != null && only >= 1 ? [only] : [1];
  }
  const ids: number[] = [];
  for (const frame of frames) {
    if (frame.pageId < 1) continue;
    if (conflictOpsForPage(ops, frame.pageId, frames).length > 0) ids.push(frame.pageId);
  }
  return ids;
}

export function inkOpsEqual(a: readonly InkOp[], b: readonly InkOp[]): boolean {
  if (a.length !== b.length) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * One saved page-1 blob still has to become one row per pad it was written on.
 *
 * Footnote marks stay per id — this only splits pad handwriting that was stored
 * as a spanning / page-1 shard.
 */
export function expandLumpedInkDiffRows(
  rows: readonly { pageId: number; hasLocal: boolean; hasServer: boolean }[],
  frames: readonly PageFrame[],
  localHits: readonly number[],
  serverHits: readonly number[],
): { pageId: number; hasLocal: boolean; hasServer: boolean }[] {
  const lumpedRow = rows.find((row) => row.pageId <= 1);
  const hits = [
    ...new Set(
      [...localHits, ...serverHits].filter((id) => Number.isInteger(id) && id >= 1),
    ),
  ];
  const span = Math.max(frames.length, hits.length > 0 ? Math.max(...hits) : 1);
  if (!lumpedRow || span <= 1 || hits.length <= 1) return rows.map((row) => ({ ...row }));
  const rest = rows.filter((row) => row.pageId > 1);
  const byId = new Map(rest.map((row) => [row.pageId, { ...row }]));
  for (const pageId of hits) {
    const prev = byId.get(pageId);
    byId.set(pageId, {
      pageId,
      hasLocal:
        Boolean(prev?.hasLocal) ||
        localHits.includes(pageId) ||
        (pageId === 1 && lumpedRow.hasLocal),
      hasServer:
        Boolean(prev?.hasServer) ||
        serverHits.includes(pageId) ||
        (pageId === 1 && lumpedRow.hasServer),
    });
  }
  return [...byId.values()].sort((a, b) => a.pageId - b.pageId);
}

/**
 * Merge-window rows for a whiteboard that is stored as one shard.
 *
 * Identical virtual pages are omitted — they are not a choice. Save still
 * writes page 1; these ids exist only for Keep / Drop.
 */
export function whiteboardInkMergeRows(
  rows: readonly { pageId: number; hasLocal: boolean; hasServer: boolean }[],
  frames: readonly PageFrame[],
  localOps: readonly InkOp[],
  serverOps: readonly InkOp[],
): { pageId: number; hasLocal: boolean; hasServer: boolean }[] {
  const lumped = rows.length > 0 && rows.every((row) => row.pageId <= 1);
  if (!lumped) {
    return expandLumpedInkDiffRows(
      rows,
      frames,
      inkPageIdsFromOps(localOps, frames),
      inkPageIdsFromOps(serverOps, frames),
    );
  }
  if (frames.length <= 1) return rows.map((row) => ({ ...row }));
  const out: { pageId: number; hasLocal: boolean; hasServer: boolean }[] = [];
  for (const frame of frames) {
    if (frame.pageId < 1) continue;
    const local = whiteboardMergeOpsForPage(localOps, frame.pageId, frames);
    const server = whiteboardMergeOpsForPage(serverOps, frame.pageId, frames);
    if (local.length === 0 && server.length === 0) continue;
    if (inkOpsEqual(local, server)) continue;
    out.push({
      pageId: frame.pageId,
      hasLocal: local.length > 0,
      hasServer: server.length > 0,
    });
  }
  return out.length > 0 ? out : rows.map((row) => ({ ...row }));
}

/** Virtual sheets covering a grown page-1 pad, for the merge list and preview. */
export function whiteboardConflictFrames(
  live: readonly PageFrame[] | undefined,
  pageCount: number,
  inkMaxY = 0,
): PageFrame[] {
  const liveMax = (live ?? []).reduce((max, frame) => Math.max(max, frame.maxY), 0);
  return whiteboardMergeFrames(Math.max(1, pageCount, live?.length ?? 0), Math.max(inkMaxY, liveMax));
}

export async function decodeConflictInkPages(
  pages: readonly InkPageDto[] | undefined,
): Promise<InkOp[]> {
  const out: InkOp[] = [];
  for (const row of pages ?? []) {
    if (!row.gz) continue;
    try {
      const encoded = unpackEncodedInk(await bytesFromMaybeGzip(b64ToBytes(row.gz)));
      if (!encoded) continue;
      const ops = decodeInkOps(encoded);
      if (ops && ops.length > 0) out.push(...ops);
    } catch {
      /* skip a bad shard */
    }
  }
  return out;
}

/** Grow the template stack so decoded ink that sits past the last frame still has a page. */
export function conflictPaperFrames(
  frames: readonly PageFrame[] | undefined,
  pageCount: number,
  inkMaxY = 0,
): PageFrame[] {
  const fromProp = (frames ?? []).filter((frame) => frame.pageId >= 1);
  let count = Math.max(1, Math.floor(pageCount) || 1, fromProp.length);
  const lastLive = fromProp.at(-1);
  if (inkMaxY > 0 && (!lastLive || inkMaxY > lastLive.maxY + 8)) {
    const pitch = SCRATCH_PAGE_H + SCRATCH_PAGE_GUTTER;
    count = Math.max(count, Math.min(32, Math.ceil(inkMaxY / pitch)));
  }
  if (fromProp.length >= count) return fromProp.slice();
  const fallback = whiteboardPageFrames(count);
  if (fromProp.length === 0) return fallback;
  const byId = new Map(fromProp.map((frame) => [frame.pageId, frame]));
  return fallback.map((frame) => byId.get(frame.pageId) ?? frame);
}

export function conflictPaperPageStyle(
  frame: PageFrame,
  sceneWidth: number | undefined,
  last: boolean,
  fitWidth?: number,
): { aspectRatio: string; marginBottom: string } {
  const pageW = sceneWidth && sceneWidth > 0 ? sceneWidth : SCRATCH_PAGE_W;
  const boxW = fitWidth && fitWidth > 0 ? fitWidth : pageW;
  const pageH = Math.max(1, frame.maxY - frame.minY);
  return {
    aspectRatio: `${boxW} / ${pageH}`,
    marginBottom: last ? "0px" : `${(SCRATCH_PAGE_GUTTER / boxW) * 100}%`,
  };
}

export function mergeConflictPageFrames(
  ...groups: Array<readonly PageFrame[] | undefined>
): PageFrame[] {
  const byId = new Map<number, PageFrame>();
  for (const group of groups) {
    for (const frame of group ?? []) {
      if (frame.pageId < 1) continue;
      const prev = byId.get(frame.pageId);
      if (!prev) {
        byId.set(frame.pageId, { ...frame });
        continue;
      }
      byId.set(frame.pageId, {
        pageId: frame.pageId,
        minY: Math.min(prev.minY, frame.minY),
        maxY: Math.max(prev.maxY, frame.maxY),
      });
    }
  }
  return [...byId.values()].sort((a, b) => a.pageId - b.pageId);
}

export function pageFramesEqual(
  a: readonly PageFrame[] | undefined,
  b: readonly PageFrame[] | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  return a.every(
    (frame, i) =>
      frame.pageId === b[i]!.pageId &&
      frame.minY === b[i]!.minY &&
      frame.maxY === b[i]!.maxY,
  );
}

/** Ruled overlay for one notebook page, same pitch/phase as the board. */
export function conflictLinedBackground(
  originY: number,
  scenePitch: number,
  zoom: number,
): { backgroundSize: string; backgroundPosition: string } | null {
  const gap = linedPaperCssGap(scenePitch, zoom);
  if (!(gap > 0)) return null;
  const firstRulePx = (linedFirstRuleScene(originY, scenePitch, true) - originY) * zoom;
  const phase = ((firstRulePx - gap + 1) % gap + gap) % gap;
  return {
    backgroundSize: `100% ${gap}px`,
    backgroundPosition: `0 ${phase}px`,
  };
}

/**
 * Which pages actually carry strokes, in order.
 *
 * Page 0 is the spanning shard — strokes whose box crosses a page gap. It
 * belongs to no single slot, so there is nowhere on one page to draw it, and
 * treating it as a page id would put it on page one.
 */
export function inkedPageIds(
  rows: readonly { page_id: number }[] | undefined,
): number[] {
  const ids = new Set<number>();
  let spanning = false;
  for (const row of rows ?? []) {
    if (row.page_id >= 1) ids.add(row.page_id);
    else if (row.page_id === 0) spanning = true;
  }
  // Spanning ink has no slot of its own. On a one-page pad (whiteboard) it
  // still has to land somewhere — page 1 is that page.
  if (spanning && ids.size === 0) ids.add(1);
  return [...ids].sort((a, b) => a - b);
}

/** True when two measured slot lists describe the same boxes. */
export function inkSlotsEqual(
  a: readonly ConflictInkSlot[],
  b: readonly ConflictInkSlot[],
): boolean {
  if (a.length !== b.length) return false;
  return a.every((slot, i) => {
    const other = b[i]!;
    return (
      slot.page === other.page &&
      Math.abs(slot.left - other.left) < 1 &&
      Math.abs(slot.top - other.top) < 1 &&
      Math.abs(slot.width - other.width) < 1 &&
      Math.abs(slot.height - other.height) < 1
    );
  });
}
