/**
 * Pan settle: move the committed snap instead of remeshing every overlay spine.
 *
 * Overlay dots are `(scene + scroll) * zoom * dpr`. The same delta slides the
 * bitmap. Only the newly exposed strip needs a redraw — that is the Close App
 * / Wait after write-then-scroll on Exam 1.
 */

import type { PixelRect } from "./clipBlit";
import type { SpineDot } from "./instance";

const ZOOM_EPSILON = 1e-4;

export type ShiftedLabView = {
  scrollX: number;
  scrollY: number;
  zoom: number;
  width: number;
  height: number;
  marginY: number;
};

export function canShiftPaintedSnap(
  painted: ShiftedLabView,
  next: ShiftedLabView,
): boolean {
  if (!Number.isFinite(painted.zoom) || !Number.isFinite(next.zoom)) return false;
  if (Math.abs(painted.zoom - next.zoom) > ZOOM_EPSILON) return false;
  return (
    painted.width === next.width &&
    painted.height === next.height &&
    painted.marginY === next.marginY
  );
}

/** Device-pixel delta that takes a snap painted at `from` to `to`. */
export function snapShiftDevicePx(
  from: Pick<ShiftedLabView, "scrollX" | "scrollY" | "zoom">,
  to: Pick<ShiftedLabView, "scrollX" | "scrollY" | "zoom">,
  dpr: number,
): { dx: number; dy: number } {
  const pix = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
  const k = to.zoom * pix;
  return {
    dx: Math.round((to.scrollX - from.scrollX) * k),
    dy: Math.round((to.scrollY - from.scrollY) * k),
  };
}

/** A jump this large has no overlapping pixels — remesh instead of wrapping. */
export function shiftClearsSnap(
  width: number,
  height: number,
  dx: number,
  dy: number,
): boolean {
  return Math.abs(dx) >= width || Math.abs(dy) >= height;
}

export function exposedShiftRects(
  width: number,
  height: number,
  dx: number,
  dy: number,
): PixelRect[] {
  const rects: PixelRect[] = [];
  if (dy > 0) rects.push({ x: 0, y: 0, w: width, h: Math.min(dy, height) });
  if (dy < 0) {
    const h = Math.min(-dy, height);
    rects.push({ x: 0, y: height - h, w: width, h });
  }
  if (dx > 0) rects.push({ x: 0, y: 0, w: Math.min(dx, width), h: height });
  if (dx < 0) {
    const w = Math.min(-dx, width);
    rects.push({ x: width - w, y: 0, w, h: height });
  }
  return rects.filter((rect) => rect.w > 0 && rect.h > 0);
}

export function shiftSpineDots(strokes: SpineDot[][], dx: number, dy: number): void {
  if (dx === 0 && dy === 0) return;
  for (const stroke of strokes) {
    for (const dot of stroke) {
      dot.x += dx;
      dot.y += dy;
    }
  }
}

export function spineHitsRects(
  stroke: readonly SpineDot[],
  rects: readonly PixelRect[],
): boolean {
  if (stroke.length === 0 || rects.length === 0) return false;
  for (const dot of stroke) {
    const pad = (dot.r || 0) + 2;
    const minX = dot.x - pad;
    const maxX = dot.x + pad;
    const minY = dot.y - pad;
    const maxY = dot.y + pad;
    for (const rect of rects) {
      if (
        maxX >= rect.x &&
        minX <= rect.x + rect.w &&
        maxY >= rect.y &&
        minY <= rect.y + rect.h
      ) {
        return true;
      }
    }
  }
  return false;
}

function segmentHitsRects(
  a: SpineDot,
  b: SpineDot,
  rects: readonly PixelRect[],
): boolean {
  const pad = Math.max(a.r || 0, b.r || 0) + 2;
  const minX = Math.min(a.x, b.x) - pad;
  const maxX = Math.max(a.x, b.x) + pad;
  const minY = Math.min(a.y, b.y) - pad;
  const maxY = Math.max(a.y, b.y) + pad;
  return rects.some(
    (rect) =>
      maxX >= rect.x &&
      minX <= rect.x + rect.w &&
      maxY >= rect.y &&
      minY <= rect.y + rect.h,
  );
}

/**
 * Keep only contiguous capsule runs that can paint an exposed shift strip.
 * A page-covering scribble may contain thousands of dots but normally only a
 * handful touch the narrow strip. Uploading the whole spine was the remaining
 * post-scroll freeze even though the destination was scissored.
 */
export function spineRunsInRects(
  stroke: readonly SpineDot[],
  rects: readonly PixelRect[],
): SpineDot[][] {
  if (stroke.length === 0 || rects.length === 0) return [];
  if (stroke.length === 1) return spineHitsRects(stroke, rects) ? [[stroke[0]!]] : [];
  const runs: SpineDot[][] = [];
  let run: SpineDot[] | null = null;
  for (let i = 0; i + 1 < stroke.length; i += 1) {
    const a = stroke[i]!;
    const b = stroke[i + 1]!;
    if (!segmentHitsRects(a, b, rects)) {
      run = null;
      continue;
    }
    if (!run) {
      run = [a, b];
      runs.push(run);
    } else {
      run.push(b);
    }
  }
  return runs;
}
