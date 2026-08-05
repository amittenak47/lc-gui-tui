/**
 * Cut a page into the boxes the agent is sent.
 *
 * These are not template boxes and are never drawn. A page is one scrollable
 * surface for the person writing on it; the agent, which sees stills, needs it
 * delivered as a handful of readable crops instead of one strip the height of
 * five screens. So the split is derived from the work rather than authored
 * around it: content is clustered by the vertical gaps between it, and a
 * cluster taller than a screenful is cut again — always *between* two things
 * that were written, never through one, so no annotation is ever halved.
 */

import type { SceneAABB } from "../templates/drawPageGrowth";

export const INK_REGION_GAP = 100;
export const INK_REGION_PAD = 16;

export interface RegionRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

function mergeOverlapping(rects: RegionRect[]): RegionRect[] {
  let merged = [...rects];
  let changed = true;
  while (changed) {
    changed = false;
    const next: RegionRect[] = [];
    const used = new Set<number>();
    for (let i = 0; i < merged.length; i++) {
      if (used.has(i)) continue;
      let a = merged[i];
      for (let j = i + 1; j < merged.length; j++) {
        if (used.has(j)) continue;
        const b = merged[j];
        const overlapX = a.x < b.x + b.width && b.x < a.x + a.width;
        const overlapY = a.y < b.y + b.height && b.y < a.y + a.height;
        if (overlapX && overlapY) {
          const x = Math.min(a.x, b.x);
          const y = Math.min(a.y, b.y);
          const right = Math.max(a.x + a.width, b.x + b.width);
          const bottom = Math.max(a.y + a.height, b.y + b.height);
          a = { x, y, width: right - x, height: bottom - y };
          used.add(j);
          changed = true;
        }
      }
      next.push(a);
    }
    merged = next;
  }
  return merged;
}

/**
 * Cut one rect into bands no taller than `maxHeight`, at the gaps between the
 * boxes inside it.
 *
 * A box that is on its own taller than the limit is left whole: halving a
 * single long stroke would send the agent two pictures of nothing rather than
 * one picture of something.
 */
function splitByHeight(
  rect: RegionRect,
  aabbs: readonly SceneAABB[],
  maxHeight: number,
  padding: number,
): RegionRect[] {
  if (!(maxHeight > 0) || rect.height <= maxHeight) return [rect];

  const inside = aabbs
    .filter(
      (box) =>
        box.y + box.height > rect.y && box.y < rect.y + rect.height,
    )
    .sort((a, b) => a.y - b.y || a.x - b.x);
  if (inside.length === 0) return [rect];

  const bands: SceneAABB[][] = [];
  let band: SceneAABB[] = [];
  let bandTop = inside[0].y;
  for (const box of inside) {
    const wouldEnd = Math.max(
      ...band.map((b) => b.y + b.height),
      box.y + box.height,
    );
    if (band.length > 0 && wouldEnd - bandTop > maxHeight) {
      bands.push(band);
      band = [box];
      bandTop = box.y;
      continue;
    }
    band.push(box);
  }
  if (band.length > 0) bands.push(band);
  if (bands.length <= 1) return [rect];

  const rectBottom = rect.y + rect.height;
  return bands.map((members) => {
    const top = Math.max(rect.y, Math.min(...members.map((b) => b.y)) - padding);
    const bottom = Math.min(
      rectBottom,
      Math.max(...members.map((b) => b.y + b.height)) + padding,
    );
    return {
      x: rect.x,
      y: top,
      width: rect.width,
      height: Math.max(1, bottom - top),
    };
  });
}

/**
 * Group content boxes by Y gaps; return padded rects clipped to the frame.
 *
 * `maxHeight` is a screenful of the page in scene units. Leave it out (or pass
 * 0) to cluster by gaps alone.
 */
export function inkRegionSplit(
  frame: { x: number; y: number; width: number; height: number },
  aabbs: readonly SceneAABB[],
  gapThreshold = INK_REGION_GAP,
  padding = INK_REGION_PAD,
  maxHeight = 0,
): RegionRect[] {
  if (aabbs.length === 0) return [];

  const sorted = [...aabbs].sort((a, b) => a.y - b.y || a.x - b.x);
  const clusters: SceneAABB[] = [];
  let cluster = { ...sorted[0] };

  for (let i = 1; i < sorted.length; i++) {
    const box = sorted[i];
    const gap = box.y - (cluster.y + cluster.height);
    if (gap > gapThreshold) {
      clusters.push(cluster);
      cluster = { ...box };
    } else {
      const right = Math.max(cluster.x + cluster.width, box.x + box.width);
      const bottom = Math.max(cluster.y + cluster.height, box.y + box.height);
      cluster = {
        x: Math.min(cluster.x, box.x),
        y: Math.min(cluster.y, box.y),
        width: right - Math.min(cluster.x, box.x),
        height: bottom - Math.min(cluster.y, box.y),
      };
    }
  }
  clusters.push(cluster);

  const frameRight = frame.x + frame.width;
  const frameBottom = frame.y + frame.height;
  const rects = clusters.map((c) => {
    const x = Math.max(frame.x, c.x - padding);
    const y = Math.max(frame.y, c.y - padding);
    const right = Math.min(frameRight, c.x + c.width + padding);
    const bottom = Math.min(frameBottom, c.y + c.height + padding);
    return {
      x,
      y,
      width: Math.max(1, right - x),
      height: Math.max(1, bottom - y),
    };
  });

  return mergeOverlapping(rects).flatMap((rect) =>
    splitByHeight(rect, aabbs, maxHeight, padding),
  );
}
