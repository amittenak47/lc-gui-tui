import type { StrokeAabb } from "./instance";

/** Live composite clip. Full-canvas snap+SDF blits are plan-C waste. */
export const CLIP_BLIT_PAD = 8;

export type PixelRect = { x: number; y: number; w: number; h: number };

/**
 * SDF scissor must sit outside the 2D blit. A tighter scissor left a 1px
 * rectangle in the copied pixels — the white box on each stroke cap.
 */
export const SDF_SCISSOR_PAD = CLIP_BLIT_PAD + 4;

export function clipBlitRect(
  box: StrokeAabb,
  width: number,
  height: number,
  pad = CLIP_BLIT_PAD,
): { x: number; y: number; w: number; h: number } | null {
  if (
    !Number.isFinite(box.minX) ||
    !Number.isFinite(box.minY) ||
    !Number.isFinite(box.maxX) ||
    !Number.isFinite(box.maxY)
  ) {
    return null;
  }
  const x = Math.max(0, Math.floor(box.minX) - pad);
  const y = Math.max(0, Math.floor(box.minY) - pad);
  const x1 = Math.min(width, Math.ceil(box.maxX) + pad);
  const y1 = Math.min(height, Math.ceil(box.maxY) + pad);
  const w = x1 - x;
  const h = y1 - y;
  if (w < 1 || h < 1) return null;
  return { x, y, w, h };
}

/** Overlap of two inclusive pixel boxes, or null when they miss. */
export function intersectPixelRects(a: PixelRect, b: PixelRect): PixelRect | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.w, b.x + b.w);
  const y1 = Math.min(a.y + a.h, b.y + b.h);
  const w = x1 - x;
  const h = y1 - y;
  if (w < 1 || h < 1) return null;
  return { x, y, w, h };
}
