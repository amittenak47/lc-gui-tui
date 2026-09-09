import type { StrokeAabb } from "./instance";

/** Live composite clip. Full-canvas snap+SDF blits are plan-C waste. */
export const CLIP_BLIT_PAD = 8;

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
