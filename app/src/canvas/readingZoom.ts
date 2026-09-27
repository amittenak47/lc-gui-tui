import type { PageFrame } from "./inkPageIndex";

/** Freeze at most two adjacent pages from the starting viewport, never the book. */
export function readingZoomSpan(
  frames: readonly PageFrame[], top: number, bottom: number, anchorY: number,
): { minY: number; maxY: number } | null {
  if (!frames.length) return null;
  let index = 0, distance = Infinity;
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i]!;
    const d = Math.max(f.minY - anchorY, anchorY - f.maxY, 0);
    if (d < distance) { index = i; distance = d; }
  }
  const selected = frames[index]!;
  const overlap = (f: PageFrame) => Math.max(0, Math.min(bottom, f.maxY) - Math.max(top, f.minY));
  const neighbours = [frames[index - 1], frames[index + 1]].filter((f): f is PageFrame => !!f && overlap(f) > 1);
  const other = neighbours.sort((a, b) => overlap(b) - overlap(a))[0];
  return { minY: Math.min(selected.minY, other?.minY ?? selected.minY),
    maxY: Math.max(selected.maxY, other?.maxY ?? selected.maxY) };
}
