/**
 * Vector smoothing for a finished pen stroke.
 *
 * A stylus samples where the nib actually was, jitter and all, and between two
 * fast samples there is nothing but a straight chord. Neither is what the hand
 * meant to draw. Smoothing runs when the pen lifts: drop the samples that carry
 * no shape, then round off what is left.
 *
 * It runs on commit rather than per sample on purpose. A causal filter can only
 * smooth by lagging the tip, and lag is the one thing a pen may not do — the
 * ink has to be under the nib. Waiting for the lift costs a barely visible
 * settle and buys a symmetric filter that adds no latency at all.
 *
 * Both passes keep the first and last point exactly where they were, so a
 * stroke never shortens or drifts off what it was written against.
 */

import type { ScenePoint } from "./rasterInk";

export const INK_SMOOTHING_DEFAULT = 0.35;

/** When the strength dial is applied: on the lift, or under the nib. */
export type InkSmoothingMode = "lift" | "live";

export const INK_SMOOTHING_MODE_DEFAULT: InkSmoothingMode = "lift";

/* ---------------------------------------------------------------- live --- */

/**
 * Live smoothing: the ink chases the pen instead of tracing it.
 *
 * This is the other way to do it, and the one Concepts uses. Each sample pulls
 * the nib a fraction of the way towards where the pen actually is, so the line
 * is smooth as it is laid down rather than tidied afterwards. What it costs is
 * lag, and lag is not free: pull hard enough and a tight loop never closes,
 * because the nib is still climbing into the bowl of the "e" when the hand has
 * already come back down the other side. That is the failure mode to design
 * against, not a bug to fix — the filter cannot both round a corner off and
 * arrive at it.
 *
 * Two choices keep it usable across the whole dial rather than the bottom half:
 *
 * The pull is a *time* constant, not a per-sample weight. A per-sample weight
 * means a 240 Hz stylus is filtered four times as hard as a 60 Hz mouse over
 * the same stretch of paper, so the dial means something different on every
 * device — and on a fast pen it means far more than the number suggests.
 * Converting through `1 - e^(-dt/tau)` makes the dial a promise about
 * milliseconds of lag, which is the thing the hand actually feels.
 *
 * And the top of the dial is 30 ms, which is about two frames. Deliberately
 * short of the range where loops start closing up: the dial should trade
 * steadiness for lag across its travel, not run off a cliff partway up.
 */
export const LIVE_SMOOTHING_MAX_TAU_MS = 30;

/**
 * Sample gaps outside this are not information about the hand.
 *
 * Under a millisecond is two coalesced samples sharing a clock tick, and past
 * a couple of frames the pen has been somewhere the app never saw — chasing
 * that slowly would leave the ink visibly behind the nib.
 */
const LIVE_SMOOTHING_MIN_DT_MS = 1;
const LIVE_SMOOTHING_MAX_DT_MS = 32;

/** Time constant, in ms, for a strength on the 0–1 dial. */
export function liveSmoothingTau(strength: number): number {
  return Math.max(0, Math.min(1, strength)) * LIVE_SMOOTHING_MAX_TAU_MS;
}

/**
 * How far to move the nib toward the pen for a sample `dtMs` after the last.
 * 1 is "straight there" — what a strength of zero and an old sample both mean.
 */
export function liveSmoothingWeight(dtMs: number, tauMs: number): number {
  if (tauMs <= 0) return 1;
  const dt = Number.isFinite(dtMs)
    ? Math.max(LIVE_SMOOTHING_MIN_DT_MS, Math.min(LIVE_SMOOTHING_MAX_DT_MS, dtMs))
    : LIVE_SMOOTHING_MAX_DT_MS;
  return 1 - Math.exp(-dt / tauMs);
}

/**
 * Hardest the simplifier may cut, as a fraction of nib width.
 *
 * Half a nib width is under the line: the smoothed path stays inside the ink
 * the raw one would have laid down, so even at full strength this reads as a
 * steadier hand and not as a different drawing.
 */
export const SIMPLIFY_MAX_FRACTION = 0.5;

/** Corner-cutting passes at full strength. */
export const MAX_ROUNDING_PASSES = 3;

function roundingPasses(strength: number): number {
  if (strength <= 0.02) return 0;
  return Math.min(MAX_ROUNDING_PASSES, Math.ceil(strength * MAX_ROUNDING_PASSES));
}

/**
 * Ramer–Douglas–Peucker, iterative so a long stroke cannot blow the stack.
 *
 * Keeps original samples, so pressure rides along untouched.
 */
export function simplifyInkPoints(
  points: readonly ScenePoint[],
  tolerance: number,
): ScenePoint[] {
  if (points.length <= 2 || tolerance <= 0) return [...points];

  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const toleranceSq = tolerance * tolerance;
  const stack: Array<[number, number]> = [[0, points.length - 1]];

  while (stack.length > 0) {
    const [first, last] = stack.pop()!;
    if (last <= first + 1) continue;
    const ax = points[first].x;
    const ay = points[first].y;
    const bx = points[last].x;
    const by = points[last].y;
    const dx = bx - ax;
    const dy = by - ay;
    const lenSq = dx * dx + dy * dy;

    let worst = -1;
    let worstDistSq = -1;
    for (let index = first + 1; index < last; index++) {
      const px = points[index].x - ax;
      const py = points[index].y - ay;
      let distSq: number;
      if (lenSq === 0) {
        distSq = px * px + py * py;
      } else {
        // Perpendicular distance to the chord, clamped to the segment so a
        // doubled-back stroke is measured against the line it doubled over.
        const t = Math.max(0, Math.min(1, (px * dx + py * dy) / lenSq));
        const ox = px - t * dx;
        const oy = py - t * dy;
        distSq = ox * ox + oy * oy;
      }
      if (distSq > worstDistSq) {
        worstDistSq = distSq;
        worst = index;
      }
    }

    if (worstDistSq > toleranceSq && worst > first) {
      keep[worst] = 1;
      stack.push([first, worst], [worst, last]);
    }
  }

  const out: ScenePoint[] = [];
  for (let index = 0; index < points.length; index++) {
    if (keep[index]) out.push(points[index]);
  }
  return out;
}

/**
 * One Chaikin corner-cutting pass.
 *
 * Each interior segment gives up its corner for two points a quarter in from
 * each end; repeated, the polyline converges on a quadratic B-spline. It cuts
 * corners rather than passing through them, which is the point — the corners
 * are where the wobble is. Cheaper than fitting a spline and it cannot
 * overshoot, so a sharp turn never grows a loop it did not have.
 */
export function roundInkCorners(points: readonly ScenePoint[]): ScenePoint[] {
  if (points.length < 3) return [...points];
  const out: ScenePoint[] = [points[0]];
  for (let index = 0; index < points.length - 1; index++) {
    const a = points[index];
    const b = points[index + 1];
    if (index > 0) {
      out.push({
        x: a.x * 0.75 + b.x * 0.25,
        y: a.y * 0.75 + b.y * 0.25,
        pressure: blendPressure(a.pressure, b.pressure, 0.25),
      });
    }
    if (index < points.length - 2) {
      out.push({
        x: a.x * 0.25 + b.x * 0.75,
        y: a.y * 0.25 + b.y * 0.75,
        pressure: blendPressure(a.pressure, b.pressure, 0.75),
      });
    }
  }
  out.push(points[points.length - 1]);
  return out;
}

/**
 * Pressure is a real number or the mouse sentinel, and the two do not mix —
 * averaging a sentinel would produce a pressure that means nothing.
 */
function blendPressure(from: number, to: number, t: number): number {
  if (from < 0 || to < 0) return t < 0.5 ? from : to;
  return from + (to - from) * t;
}

/**
 * Smooth a committed stroke. `strength` is the settings dial (0–1); `nibWidth`
 * is the stroke's line width in scene units, which sets what counts as jitter.
 */
export function smoothInkPoints(
  points: readonly ScenePoint[],
  strength: number,
  nibWidth: number,
): ScenePoint[] {
  const amount = Math.max(0, Math.min(1, strength));
  if (amount <= 0 || points.length < 3) return [...points];

  const tolerance = Math.max(nibWidth, 1e-6) * SIMPLIFY_MAX_FRACTION * amount;
  let out = simplifyInkPoints(points, tolerance);
  for (let pass = roundingPasses(amount); pass > 0; pass--) {
    out = roundInkCorners(out);
  }
  return out;
}
