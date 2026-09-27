import type { ExclusionRect } from "../../util/gestureExclusion";

type Box = { left: number; top: number; width: number; height: number };

export function turnCornerSize(rect: Box): number {
  return Math.min(rect.width / 2, rect.height / 2, 120, Math.max(44, rect.width * .12));
}

/** Only the four triangular corners start a page turn. */
export function turnCornerAt(rect: Box, x: number, y: number): "left" | "right" | null {
  const dx = x - rect.left, dy = y - rect.top;
  if (dx < 0 || dy < 0 || dx > rect.width || dy > rect.height) return null;
  const vertical = Math.min(dy, rect.height - dy), size = turnCornerSize(rect);
  if (dx + vertical <= size) return "left";
  if (rect.width - dx + vertical <= size) return "right";
  return null;
}

/** Android accepts rectangles: short bands approximate each corner triangle. */
export function turnCornerExclusions(rect: Box, viewport: Box): ExclusionRect[] {
  const size = turnCornerSize(rect), bands = 6, step = size / bands;
  if (size <= 0) return [];
  const result: ExclusionRect[] = [];
  for (const right of [false, true]) for (const bottom of [false, true]) {
    for (let i = 0; i < bands; i++) {
      const width = size - i * step;
      const x = right ? rect.left + rect.width - width : rect.left;
      const y = bottom ? rect.top + rect.height - (i + 1) * step : rect.top + i * step;
      const left = Math.max(x, viewport.left), top = Math.max(y, viewport.top);
      const endX = Math.min(x + width, viewport.left + viewport.width);
      const endY = Math.min(y + step, viewport.top + viewport.height);
      if (endX > left && endY > top) result.push({ x: left, y: top, width: endX - left, height: endY - top });
    }
  }
  return result;
}
