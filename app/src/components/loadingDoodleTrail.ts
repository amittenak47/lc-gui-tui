import type { ScenePoint } from "../canvas/rasterInk";

export function trailDistances(points: readonly ScenePoint[]): number[] {
  const distances = points.map(() => 0);
  for (let i = 1; i < points.length; i += 1) {
    distances[i] = distances[i - 1]! + Math.hypot(
      points[i]!.x - points[i - 1]!.x, points[i]!.y - points[i - 1]!.y,
    );
  }
  return distances;
}

/** Erase by travelled distance, so uneven pointer sampling never stalls the sweep. */
export function trailingPoints(
  points: ScenePoint[], distances: readonly number[], progress: number,
): ScenePoint[] {
  if (progress <= 0) return points;
  if (progress >= 1 || points.length === 0) return [];
  const cut = (distances[distances.length - 1] ?? 0) * progress;
  let i = 1;
  while (i < distances.length && distances[i]! <= cut) i += 1;
  if (i >= points.length) return points.slice(-1);
  const a = points[i - 1]!;
  const b = points[i]!;
  const t = (cut - distances[i - 1]!) / (distances[i]! - distances[i - 1]!);
  return [{
    ...b,
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    pressure: a.pressure + (b.pressure - a.pressure) * t,
    ...(a.slowness != null && b.slowness != null
      ? { slowness: a.slowness + (b.slowness - a.slowness) * t } : {}),
  }, ...points.slice(i)];
}
