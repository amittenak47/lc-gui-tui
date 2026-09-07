/**
 * Spine bake. Lift uses {@link bakeSpine}. Live reshape uses
 * {@link reshapeSpine} from paint so While Writing can tidy behind the nib.
 * Default: RDP + Chaikin + expandInkTurns. Optional clothoid after that,
 * even when Chaikin is off, ~3ms budget.
 */

import { INK_SMOOTHING_DEFAULT, smoothInkPoints } from "../inkSmoothing";
import { expandInkTurns, type ScenePoint } from "../rasterInk";

import type { SpineDot } from "./instance";

export const CLOTHOID_BUDGET_MS = 3;

export type BakeKind = "catmull" | "clothoid";

export type BakeResult = {
  points: SpineDot[];
  bake: BakeKind;
  bakeMs: number;
};

function toScene(d: SpineDot, pressure = 0.5): ScenePoint {
  return { x: d.x, y: d.y, pressure: d.p ?? pressure };
}

function meanRadius(spine: readonly SpineDot[]): number {
  if (spine.length === 0) return 4;
  let s = 0;
  for (const p of spine) s += p.r;
  return s / spine.length;
}

function radiiAlong(
  src: readonly SpineDot[],
  baked: readonly ScenePoint[],
): SpineDot[] {
  if (baked.length === 0) return [];
  if (src.length === 0) {
    return baked.map((p) => ({ x: p.x, y: p.y, r: 4 }));
  }
  const acc = [0];
  for (let i = 1; i < src.length; i++) {
    acc.push(
      acc[i - 1]! + Math.hypot(src[i]!.x - src[i - 1]!.x, src[i]!.y - src[i - 1]!.y),
    );
  }
  const total = acc[acc.length - 1]! || 1;
  const out: SpineDot[] = [];
  let j = 0;
  let walked = 0;
  for (let i = 0; i < baked.length; i++) {
    const p = baked[i]!;
    if (i > 0) walked += Math.hypot(p.x - baked[i - 1]!.x, p.y - baked[i - 1]!.y);
    const u = Math.min(1, walked / Math.max(total, 1e-6));
    const target = u * total;
    while (j + 1 < acc.length && acc[j + 1]! < target) j += 1;
    const a = src[Math.min(j, src.length - 1)]!;
    const b = src[Math.min(j + 1, src.length - 1)]!;
    const span = (acc[j + 1] ?? acc[j]!) - acc[j]!;
    const t = span > 1e-6 ? (target - acc[j]!) / span : 0;
    const rgbA = a.rgb;
    const rgbB = b.rgb;
    const rgb =
      rgbA && rgbB
        ? ([
            rgbA[0] + (rgbB[0] - rgbA[0]) * t,
            rgbA[1] + (rgbB[1] - rgbA[1]) * t,
            rgbA[2] + (rgbB[2] - rgbA[2]) * t,
          ] as [number, number, number])
        : rgbA ?? rgbB;
    const p0 = a.p ?? 0.5;
    const p1 = b.p ?? p0;
    const s0 = a.slow;
    const s1 = b.slow;
    out.push({
      x: p.x,
      y: p.y,
      r: a.r + (b.r - a.r) * t,
      rgb,
      a: (a.a ?? 1) + ((b.a ?? 1) - (a.a ?? 1)) * t,
      p: p0 + (p1 - p0) * t,
      slow:
        s0 != null && s1 != null
          ? s0 + (s1 - s0) * t
          : s0 ?? s1,
    });
  }
  return out;
}

export function bakeCatmull(
  points: readonly ScenePoint[],
  nibWidth: number,
  strength = INK_SMOOTHING_DEFAULT,
): ScenePoint[] {
  if (strength <= 0) return [...points];
  const smoothed = smoothInkPoints(points, strength, Math.max(nibWidth, 1e-6));
  return expandInkTurns(smoothed);
}

/** Fresnel C,S for ∫_0^t cos(u²) du and sin(u²) du. Short series, not a step loop. */
export function fresnelCS(t: number): { c: number; s: number } {
  const x = t;
  const x2 = x * x;
  let c = 0;
  let s = 0;
  let pow = x;
  let sign = 1;
  let fact = 1;
  for (let n = 0; n < 10; n++) {
    const n2 = 2 * n;
    c += sign * pow / (fact * (4 * n + 1));
    pow *= x2;
    fact *= n2 + 1;
    s += sign * pow / (fact * (4 * n + 3));
    pow *= x2;
    fact *= n2 + 2;
    sign = -sign;
  }
  return { c, s };
}

function heading(ax: number, ay: number, bx: number, by: number): number {
  return Math.atan2(by - ay, bx - ax);
}

function sampleClothoid(
  a: SpineDot,
  b: SpineDot,
  theta0: number,
  theta1: number,
): ScenePoint[] {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const chord = Math.hypot(dx, dy);
  if (chord < 1e-4) return [toScene(b)];
  let dth = theta1 - theta0;
  while (dth > Math.PI) dth -= Math.PI * 2;
  while (dth < -Math.PI) dth += Math.PI * 2;
  if (Math.abs(dth) < 0.04) return [toScene(b)];
  const n = Math.max(3, Math.min(18, Math.ceil(Math.abs(dth) / 0.18)));
  const sigma = (2 * dth) / (chord * chord);
  const scale = Math.sqrt(2 / Math.max(Math.abs(sigma), 1e-8));
  const rot = theta0;
  const cos = Math.cos(rot);
  const sin = Math.sin(rot);
  const end = fresnelCS(chord / scale);
  const endLen = Math.hypot(end.c, end.s) || 1;
  const fit = chord / (endLen * scale);
  const out: ScenePoint[] = [];
  for (let i = 1; i <= n; i++) {
    const s = (i / n) * chord;
    const fs = fresnelCS(s / scale);
    const lx = fs.c * scale * fit;
    const ly = (sigma < 0 ? -fs.s : fs.s) * scale * fit;
    const x = a.x + lx * cos - ly * sin;
    const y = a.y + lx * sin + ly * cos;
    if (i === n) {
      out.push(toScene(b));
    } else {
      out.push({ x, y, pressure: 0.5 });
    }
  }
  return out;
}

export function bakeClothoid(spine: readonly SpineDot[]): ScenePoint[] {
  if (spine.length < 2) return spine.map((p) => toScene(p));
  const out: ScenePoint[] = [toScene(spine[0]!)];
  for (let i = 1; i < spine.length; i++) {
    const prev = spine[i - 1]!;
    const cur = spine[i]!;
    const nxt = spine[i + 1];
    const th0 = heading(prev.x, prev.y, cur.x, cur.y);
    const th1 = nxt ? heading(cur.x, cur.y, nxt.x, nxt.y) : th0;
    out.push(...sampleClothoid(prev, cur, th0, th1));
  }
  return out;
}

export function bakeSpine(
  spine: readonly SpineDot[],
  opts: { clothoid?: boolean; smoothing?: number } = {},
): BakeResult {
  const t0 = performance.now();
  const strength = opts.smoothing ?? INK_SMOOTHING_DEFAULT;
  let points: SpineDot[];
  let bake: BakeKind = "catmull";
  if (strength > 0) {
    const scenes = spine.map((p) => toScene(p));
    const nib = meanRadius(spine) * 2;
    points = radiiAlong(spine, bakeCatmull(scenes, nib, strength));
  } else {
    points = spine.map((p) => ({ ...p }));
  }
  if (opts.clothoid && points.length >= 3) {
    const c0 = performance.now();
    const cloth = bakeClothoid(points);
    if (performance.now() - c0 <= CLOTHOID_BUDGET_MS) {
      points = radiiAlong(points, cloth);
      bake = "clothoid";
    }
  }
  return {
    points,
    bake,
    bakeMs: performance.now() - t0,
  };
}

/**
 * Same Chaikin as lift, for the open stroke. Endpoints stay put so the nib
 * still tracks the pen. Safe from rAF — does not write the engine spine.
 */
export function reshapeSpine(
  spine: readonly SpineDot[],
  strength: number,
): SpineDot[] {
  if (strength <= 0 || spine.length < 3) return spine.map((p) => ({ ...p }));
  const scenes = spine.map((p) => toScene(p));
  const nib = meanRadius(spine) * 2;
  return radiiAlong(spine, bakeCatmull(scenes, nib, strength));
}
