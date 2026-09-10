/**
 * Off-chord samples on a turning ingest hop so SDF capsules follow a curve,
 * not the pointer polyline.
 */

import { curveAlongHop, HOP_CURVE_STEP, type ScenePoint } from "../rasterInk";

import type { SpineDot } from "./instance";

function sceneOf(d: SpineDot): ScenePoint {
  return {
    x: d.x,
    y: d.y,
    pressure: d.p ?? 0.5,
    ...(d.slow != null ? { slowness: d.slow } : {}),
  };
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function mixDot(from: SpineDot, to: SpineDot, at: ScenePoint, t: number): SpineDot {
  const rgbA = from.rgb;
  const rgbB = to.rgb;
  const rgb =
    rgbA && rgbB
      ? ([
          lerp(rgbA[0], rgbB[0], t),
          lerp(rgbA[1], rgbB[1], t),
          lerp(rgbA[2], rgbB[2], t),
        ] as [number, number, number])
      : rgbB ?? rgbA;
  return {
    x: at.x,
    y: at.y,
    r: lerp(from.r, to.r, t),
    rgb,
    a: lerp(from.a ?? 1, to.a ?? 1, t),
    p: at.pressure,
    slow:
      from.slow != null && to.slow != null
        ? lerp(from.slow, to.slow, t)
        : (at.slowness ?? to.slow ?? from.slow),
  };
}

/**
 * Points after `from` through `to`. Collinear hops and the first sample of a
 * stroke stay a single `to`.
 */
export function seedSpineHop(
  prev: SpineDot | null,
  from: SpineDot,
  to: SpineDot,
): SpineDot[] {
  const seeds = curveAlongHop(
    prev ? sceneOf(prev) : null,
    sceneOf(from),
    sceneOf(to),
    HOP_CURVE_STEP,
  );
  const n = seeds.length;
  if (n <= 1) return [to];
  const out: SpineDot[] = [];
  for (let i = 0; i < n; i++) {
    if (i === n - 1) {
      out.push(to);
      break;
    }
    out.push(mixDot(from, to, seeds[i]!, (i + 1) / n));
  }
  return out;
}
