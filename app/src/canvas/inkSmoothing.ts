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

import { INK_SLOWNESS_NEUTRAL, type ScenePoint } from "./rasterInk";

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
 * lag, and lag is not free — the ink may trail the hand but must not drift
 * off into its own shape.
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
 * Lag is capped in space via {@link clampLiveLag}, not by keeping tau short:
 * the nib may trail the pen but stays within about a nib of it, so tight loops
 * no longer close from over-smoothing alone.
 */
export const LIVE_SMOOTHING_MAX_TAU_MS = 90;

/** Max distance the smoothed nib may trail the pen, in nib widths. */
export const LIVE_MAX_LAG_NIBS = 1.25;

/**
 * Pull the nib back toward the pen when it has lagged farther than `maxLag`.
 * `maxLag` is in scene units (typically `nibWidth * LIVE_MAX_LAG_NIBS`).
 */
export function clampLiveLag(
  nibX: number,
  nibY: number,
  penX: number,
  penY: number,
  maxLag: number,
): { x: number; y: number } {
  if (maxLag <= 0) return { x: nibX, y: nibY };
  const dx = nibX - penX;
  const dy = nibY - penY;
  const dist = Math.hypot(dx, dy);
  if (dist <= maxLag || dist < 1e-12) return { x: nibX, y: nibY };
  const s = maxLag / dist;
  return { x: penX + dx * s, y: penY + dy * s };
}

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

/**
 * Tolerance every committed stroke is thinned at, as a fraction of nib width,
 * whatever the smoothing setting says.
 *
 * A stroke is not stored as the samples the pen gave: the move path stamps
 * along each segment at a fraction of the line width, so what lands in the op
 * is a dense chain of points a small part of a nib apart. That density is for
 * the *stamping*, and once the stroke is committed nothing needs it — the
 * committed path is drawn as a polyline, and points closer together than a
 * fifteenth of the nib cannot move a pixel of it.
 *
 * They do cost, though, every time a tile is rasterised: a zoom that crosses a
 * level replays every op that touches every visible square, and a replay is
 * linear in points. Thinning at commit is paid once and refunded on every
 * rasterisation for the life of the page.
 *
 * Deliberately far under {@link SIMPLIFY_MAX_FRACTION}. That one is a
 * *smoothing* tolerance the writer asked for and can see; this one is a storage
 * tolerance they must not be able to see, which is why it survives a smoothing
 * setting of zero.
 */
export const SIMPLIFY_STORAGE_FRACTION = 1 / 15;

/** Simplifier floor for live commits — looser than storage, still under the ink. */
export const SIMPLIFY_LIVE_FRACTION = 1 / 6;

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
    if (index > 0) out.push(blendPoint(a, b, 0.25));
    if (index < points.length - 2) out.push(blendPoint(a, b, 0.75));
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
 * A point `t` of the way along a segment, carrying everything the samples do.
 *
 * The corner cutter used to build its two new points out of x, y and pressure
 * alone, which quietly dropped `slowness` from every interior point of a
 * smoothed stroke. Slowness is what speed ink reads for width and alpha, and a
 * missing one falls back to {@link INK_SLOWNESS_NEUTRAL} — so a stroke written
 * with speed ink on was laid down with its pace and then flattened to an even
 * one the instant the pen lifted, which reads as the letter changing shape
 * under your hand. Like pressure, it is only carried when the stroke has it.
 */
function blendPoint(from: ScenePoint, to: ScenePoint, t: number): ScenePoint {
  const point: ScenePoint = {
    x: from.x + (to.x - from.x) * t,
    y: from.y + (to.y - from.y) * t,
    pressure: blendPressure(from.pressure, to.pressure, t),
  };
  if (from.slowness !== undefined || to.slowness !== undefined) {
    const a = from.slowness ?? INK_SLOWNESS_NEUTRAL;
    const b = to.slowness ?? INK_SLOWNESS_NEUTRAL;
    point.slowness = a + (b - a) * t;
  }
  return point;
}

/**
 * Smooth a committed stroke. `strength` is the settings dial (0–1); `nibWidth`
 * is the stroke's line width in scene units, which sets what counts as jitter.
 */
export function smoothInkPoints(
  points: readonly ScenePoint[],
  strength: number,
  nibWidth: number,
  minFraction?: number,
): ScenePoint[] {
  const amount = Math.max(0, Math.min(1, strength));
  if (points.length < 3) return [...points];

  const width = Math.max(nibWidth, 1e-6);
  const floorFrac = minFraction ?? SIMPLIFY_STORAGE_FRACTION;
  const tolerance = Math.max(
    width * floorFrac,
    width * SIMPLIFY_MAX_FRACTION * amount,
  );
  let out = simplifyInkPoints(points, tolerance);
  for (let pass = roundingPasses(amount); pass > 0; pass--) {
    out = roundInkCorners(out);
  }
  return out;
}
