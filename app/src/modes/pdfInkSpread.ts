/**
 * Carry raster ink across PDF two-up.
 *
 * Bitmaps split by sheet half. Ink is absolute scene points with no L/R shard,
 * so a stroke written across a Kleinberg sheet would sit on the left slot after
 * spread unless each point is remapped (and a gutter-crossing stroke split).
 */

import type { PageFrame } from "../canvas/inkPageIndex";
import type { InkOp, ScenePoint } from "../canvas/rasterInk";

export type PdfInkHalf = "left" | "right";

export function pdfLayoutIsSpread(frames: readonly PageFrame[]): boolean {
  const counts = new Map<number, number>();
  for (const frame of frames) {
    if (frame.pageId < 1) continue;
    counts.set(frame.pageId, (counts.get(frame.pageId) ?? 0) + 1);
  }
  return [...counts.values()].some((n) => n >= 2);
}

function pairForPage(frames: readonly PageFrame[], pageId: number): PageFrame[] {
  return frames.filter((frame) => frame.pageId === pageId);
}

function frameAtY(frames: readonly PageFrame[], y: number): PageFrame | null {
  for (const frame of frames) {
    if (y >= frame.minY && y <= frame.maxY) return frame;
  }
  let nearest: PageFrame | null = null;
  let dist = Infinity;
  for (const frame of frames) {
    const d = y < frame.minY ? frame.minY - y : y - frame.maxY;
    if (d < dist) {
      dist = d;
      nearest = frame;
    }
  }
  return nearest;
}

export function locatePdfInkPoint(
  x: number,
  y: number,
  frames: readonly PageFrame[],
  originX: number,
  width: number,
): { pageId: number; half: PdfInkHalf; nx: number; ny: number } | null {
  if (!(width > 0) || frames.length === 0) return null;
  const hit = frameAtY(frames, y);
  if (!hit || hit.pageId < 1) return null;
  const pair = pairForPage(frames, hit.pageId);
  const slotH = Math.max(1e-9, hit.maxY - hit.minY);
  const ny = (y - hit.minY) / slotH;
  const localX = x - originX;
  if (pair.length >= 2) {
    const ordered = [...pair].sort((a, b) => a.minY - b.minY);
    const half: PdfInkHalf = hit.minY === ordered[0]!.minY ? "left" : "right";
    return {
      pageId: hit.pageId,
      half,
      nx: localX / width,
      ny,
    };
  }
  const mid = width / 2;
  const half: PdfInkHalf = localX < mid ? "left" : "right";
  const nx = half === "left" ? localX / mid : (localX - mid) / mid;
  return { pageId: hit.pageId, half, nx, ny };
}

export function placePdfInkPoint(
  located: { pageId: number; half: PdfInkHalf; nx: number; ny: number },
  frames: readonly PageFrame[],
  originX: number,
  width: number,
): { x: number; y: number } | null {
  if (!(width > 0)) return null;
  const pair = pairForPage(frames, located.pageId);
  if (pair.length === 0) return null;
  const nx = Math.min(1, Math.max(0, located.nx));
  const ny = Math.min(1, Math.max(0, located.ny));
  if (pair.length >= 2) {
    const ordered = [...pair].sort((a, b) => a.minY - b.minY);
    const slot = located.half === "right" ? ordered[1]! : ordered[0]!;
    return {
      x: originX + nx * width,
      y: slot.minY + ny * (slot.maxY - slot.minY),
    };
  }
  const slot = pair[0]!;
  const mid = width / 2;
  const x =
    located.half === "right"
      ? originX + mid + nx * mid
      : originX + nx * mid;
  return { x, y: slot.minY + ny * (slot.maxY - slot.minY) };
}

function mapPoint(
  point: ScenePoint,
  from: readonly PageFrame[],
  to: readonly PageFrame[],
  originX: number,
  width: number,
): ScenePoint {
  const located = locatePdfInkPoint(point.x, point.y, from, originX, width);
  if (!located) return point;
  const placed = placePdfInkPoint(located, to, originX, width);
  if (!placed) return point;
  return { ...point, x: placed.x, y: placed.y };
}

function halfKey(point: ScenePoint, frames: readonly PageFrame[], originX: number, width: number): string {
  const located = locatePdfInkPoint(point.x, point.y, frames, originX, width);
  if (!located) return "";
  return `${located.pageId}:${located.half}`;
}

function cloneOpWithPoints(op: InkOp, points: ScenePoint[]): InkOp {
  return { ...op, id: undefined, seq: undefined, points };
}

/**
 * Map ops from one PDF stack onto another. No-op when both layouts are the
 * same mode (one-up vs two-up). A stroke that crossed the sheet gutter becomes
 * two ops so spread-on does not draw a line down the seam.
 */
export function remapInkBetweenPdfLayouts(
  ops: readonly InkOp[],
  from: readonly PageFrame[],
  to: readonly PageFrame[],
  originX: number,
  width: number,
): InkOp[] {
  if (ops.length === 0) return [];
  if (from.length === 0 || to.length === 0) return ops.slice();
  if (pdfLayoutIsSpread(from) === pdfLayoutIsSpread(to)) return ops.slice();

  const out: InkOp[] = [];
  for (const op of ops) {
    if (op.points.length === 0) {
      out.push(op);
      continue;
    }
    let chunk: ScenePoint[] = [];
    let key = "";
    const flush = () => {
      if (chunk.length === 0) return;
      out.push(cloneOpWithPoints(op, chunk));
      chunk = [];
    };
    for (const point of op.points) {
      const mapped = mapPoint(point, from, to, originX, width);
      const nextKey = halfKey(mapped, to, originX, width);
      if (chunk.length > 0 && nextKey !== key) flush();
      key = nextKey;
      chunk.push(mapped);
    }
    flush();
  }
  return out;
}
