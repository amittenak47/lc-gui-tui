/**
 * Cluster student content AABBs into vertical bands for agent preview / capture.
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
 * Group content boxes by Y gaps; return padded rects clipped to the frame.
 */
export function inkRegionSplit(
  frame: { x: number; y: number; width: number; height: number },
  aabbs: readonly SceneAABB[],
  gapThreshold = INK_REGION_GAP,
  padding = INK_REGION_PAD,
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

  return mergeOverlapping(rects);
}
