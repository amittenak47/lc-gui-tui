/**
 * Vector smoothing for a pen stroke (lift commit, or live reshape while down).
 *
 * A stylus samples where the nib actually was, jitter and all, and between two
 * fast samples there is nothing but a straight chord. Neither is what the hand
 * meant to draw. Smoothing drops the samples that carry no shape, then rounds
 * off what is left.
 *
 * **On Lift:** run once at commit. Ink stays under the nib while writing;
 * the settle is barely visible at default strength.
 *
 * **While Writing:** re-run on the open stroke's raw stamps every paint so
 * earlier bends tidy before the pen lifts. Endpoints stay fixed, so the tip
 * still tracks the pen — only the path behind it moves.
 *
 * Both passes keep the first and last point exactly where they were, so a
 * stroke never shortens or drifts off what it was written against.
 */

import { INK_SLOWNESS_NEUTRAL, NO_PRESSURE, type ScenePoint } from "./rasterInk";

export const INK_SMOOTHING_DEFAULT = 0.35;

/** When the strength dial is applied: on the lift, or under the nib. */
export type InkSmoothingMode = "lift" | "live";

export const INK_SMOOTHING_MODE_DEFAULT: InkSmoothingMode = "lift";

/* -------------------------------------------------------- tip-lag helpers --- */

/**
 * Causal tip-lag helpers (time-constant EMA + spatial clamp).
 *
 * Kept for tests and experiments. The board's **While Writing** mode does
 * not use these — it reshapes the open stroke with {@link smoothInkPoints}
 * instead, so earlier letters tidy without the ink trailing the hand.
 */
export const LIVE_SMOOTHING_MAX_TAU_MS = 55;
/** Minimum tau once smoothing is on — below this the live trail is invisible. */
export const LIVE_SMOOTHING_MIN_TAU_MS = 14;

/** Max distance the smoothed nib may trail the pen, in nib widths. */
export const LIVE_MAX_LAG_NIBS = 1.15;

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
  const s = Math.max(0, Math.min(1, strength));
  if (s <= 0) return 0;
  return (
    LIVE_SMOOTHING_MIN_TAU_MS +
    s * (LIVE_SMOOTHING_MAX_TAU_MS - LIVE_SMOOTHING_MIN_TAU_MS)
  );
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
 * This floor only applies when the writer asked for smoothing. At zero the
 * stroke stays the stamps they drew — a fifteenth of a 32-wide nib is a
 * visible reshape on lift, which is not "off".
 */
export const SIMPLIFY_STORAGE_FRACTION = 1 / 15;

/** Simplifier floor for live commits — looser than storage, still under the ink. */
export const SIMPLIFY_LIVE_FRACTION = 1 / 6;

/**
 * Storage tolerance for a pressure-sensitive stroke.
 *
 * These were stored **unthinned**, and the reason was sound: a pressure stroke
 * is painted as a chain of translucent abutting runs, geometric RDP has no idea
 * that pressure varies along a straight segment, and collapsing that segment to
 * its endpoints regroups the runs and makes the fill visibly jump. Bold nibs
 * showed it worst.
 *
 * But the whole segment is not the only thing that can go. What cannot be seen
 * is a point whose *pressure and slowness* also sit on the line between its
 * neighbours — that one contributes nothing to the fill and nothing to the
 * geometry. {@link simplifyModulatedInkPoints} drops exactly those, and this is
 * the geometric half of its tolerance: a third of the storage floor, because
 * these strokes are the ones where being wrong is visible.
 */
export const SIMPLIFY_MODULATED_FRACTION = 1 / 45;

/**
 * How far pressure may stray from the interpolated value before the point stays.
 *
 * Pressure reaches the screen only through alpha —
 * `inkPressureAlpha = 0.45 + 0.55 * p` — and alpha is bucketed at
 * `RUN_ALPHA_QUANTUM = 1/48`, so the smallest pressure difference that can
 * change a pixel is `(1/48)/0.55`. Half of that is the largest error that is
 * certainly invisible.
 */
export const PRESSURE_EPSILON = 1 / 48 / 0.55 / 2;

/**
 * The same, for slowness, which drives width through a `RUN_WIDTH_QUANTUM` of
 * 0.06 — about 1/45 of the range.
 */
export const SLOWNESS_EPSILON = 1 / 45 / 2;

/** Corner-cutting passes at full strength. */
export const MAX_ROUNDING_PASSES = 3;

/**
 * What the top of the dial is worth, and how the travel gets there.
 *
 * `CURVE` above 1 keeps the bottom of the dial gentle, so the settings most
 * writers already have barely move.
 */
export const SIMPLIFY_CEILING = 0.85;
export const SMOOTHING_CURVE = 1.4;

/** Corner-cutting passes the dial asks for — fractional, see {@link smoothInkPoints}. */
export function roundingPasses(strength: number): number {
  const dial = Math.max(0, Math.min(1, strength));
  return MAX_ROUNDING_PASSES * dial ** SMOOTHING_CURVE;
}

/**
 * A partial pass smaller than this is not worth the points it inserts.
 *
 * Below it the cut is under a thousandth of a segment, which no rasteriser can
 * express, and skipping it keeps a dial at zero returning the stroke untouched.
 */
const MIN_ROUNDING_RATIO = 1e-3;

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
 * Thin a pressure-sensitive stroke without flattening its modulation.
 *
 * The problem with using {@link simplifyInkPoints} here is that it measures
 * only geometry. A pen drawn slowly down a straight line produces a chain of
 * collinear samples whose pressure rises and falls the whole way; RDP sees a
 * straight line and keeps two points, and the stroke loses the swell that was
 * the reason for drawing it that way. That is why these strokes were stored
 * with every stamp intact.
 *
 * So the pass here keeps a point when *any* of three things about it cannot be
 * predicted from its neighbours: where it is, how hard it was pressed, or how
 * slowly it was moving. A point that fails all three tests contributes nothing
 * the renderer can express — pressure reaches the screen through an alpha
 * bucketed at 1/48, slowness through a width bucketed at 0.06 — and dropping it
 * changes no pixel.
 *
 * A single forward pass rather than RDP's recursion: the input is a stamp chain
 * where the interesting variation is local, and this way the cost is linear in
 * points on the one path that runs for every stroke on lift.
 */
export function simplifyModulatedInkPoints(
  points: readonly ScenePoint[],
  tolerance: number,
): ScenePoint[] {
  if (points.length <= 2 || tolerance <= 0) return [...points];

  const out: ScenePoint[] = [points[0]];
  // `anchor` is the last point kept. Everything between it and the candidate is
  // provisionally droppable; the moment one of them is not, the point before
  // the offender becomes the new anchor.
  let anchor = 0;
  const toleranceSq = tolerance * tolerance;

  for (let index = 1; index < points.length - 1; index += 1) {
    const next = index + 1;
    if (!spanIsPredictable(points, anchor, next, toleranceSq)) {
      out.push(points[index]);
      anchor = index;
    }
  }
  out.push(points[points.length - 1]);
  return out;
}

/** Does every point strictly between `first` and `last` lie on the line? */
function spanIsPredictable(
  points: readonly ScenePoint[],
  first: number,
  last: number,
  toleranceSq: number,
): boolean {
  const a = points[first];
  const b = points[last];
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;

  for (let index = first + 1; index < last; index += 1) {
    const point = points[index];
    const px = point.x - a.x;
    const py = point.y - a.y;
    const t = lenSq === 0 ? 0 : Math.max(0, Math.min(1, (px * dx + py * dy) / lenSq));
    const ox = px - t * dx;
    const oy = py - t * dy;
    if (ox * ox + oy * oy > toleranceSq) return false;

    /*
     * Modulation is interpolated along the *chord*, using the same `t` the
     * geometry did. Interpolating by index instead would be wrong on a stroke
     * whose samples are unevenly spaced — which is every stroke, since the
     * stamp step scales with line width.
     *
     * `NO_PRESSURE` is a sentinel, not a low reading. A span that mixes it with
     * real pressures is not interpolatable at all, so it is kept whole.
     */
    const pa = a.pressure;
    const pb = b.pressure;
    const pp = point.pressure;
    const sentinels = [pa, pb, pp].filter((value) => value === NO_PRESSURE).length;
    if (sentinels !== 0 && sentinels !== 3) return false;
    if (sentinels === 0 && Math.abs(pa + (pb - pa) * t - pp) > PRESSURE_EPSILON) {
      return false;
    }

    // Absent slowness is its own state — "speed ink was off" — and a span that
    // mixes present with absent must not be collapsed into either one.
    const sa = a.slowness;
    const sb = b.slowness;
    const sp = point.slowness;
    const absent = [sa, sb, sp].filter((value) => value === undefined).length;
    if (absent !== 0 && absent !== 3) return false;
    if (
      absent === 0 &&
      Math.abs(sa! + (sb! - sa!) * t - sp!) > SLOWNESS_EPSILON
    ) {
      return false;
    }
  }
  return true;
}

/** Chaikin's own cut: a quarter in from each end of every interior segment. */
export const CHAIKIN_RATIO = 0.25;

/**
 * One Chaikin corner-cutting pass.
 *
 * Each interior segment gives up its corner for two points `ratio` of the way
 * in from each end; repeated, the polyline converges on a quadratic B-spline.
 * It cuts corners rather than passing through them, which is the point — the
 * corners are where the wobble is. Cheaper than fitting a spline and it cannot
 * overshoot, so a sharp turn never grows a loop it did not have.
 *
 * **`ratio` is what makes the dial continuous.** A pass is otherwise an
 * all-or-nothing thing, and a strength knob that can only buy whole passes has
 * as many settings as it has passes — three, across a slider the writer reads
 * as a hundred. A shallower cut is a fraction of a pass: at
 * {@link CHAIKIN_RATIO} this is textbook Chaikin, and as the ratio goes to zero
 * the new points converge on the corner they were cutting, so the pass fades
 * out instead of switching off. See {@link smoothInkPoints}.
 */
export function roundInkCorners(
  points: readonly ScenePoint[],
  ratio: number = CHAIKIN_RATIO,
): ScenePoint[] {
  if (points.length < 3) return [...points];
  const t = Math.max(0, Math.min(0.5, ratio));
  const out: ScenePoint[] = [points[0]];
  for (let index = 0; index < points.length - 1; index++) {
    const a = points[index];
    const b = points[index + 1];
    if (index > 0) out.push(blendPoint(a, b, t));
    if (index < points.length - 2) out.push(blendPoint(a, b, 1 - t));
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
 *
 * The dial is compressed: UI 100% ≈ the old default (~0.35). Writers treat the
 * bottom quarter as the usable range; the top half used to over-round.
 */
export function smoothInkPoints(
  points: readonly ScenePoint[],
  strength: number,
  nibWidth: number,
  minFraction?: number,
): ScenePoint[] {
  const dial = Math.max(0, Math.min(1, strength));
  if (points.length < 3 || dial <= 0) return [...points];

  const width = Math.max(nibWidth, 1e-6);
  const floorFrac = minFraction ?? SIMPLIFY_STORAGE_FRACTION;
  // Thin a bit harder than Chaikin rounds, so passes cannot explode point count.
  const simplifyAmount = SIMPLIFY_CEILING * dial ** SMOOTHING_CURVE;
  const tolerance = Math.max(
    width * floorFrac,
    width * SIMPLIFY_MAX_FRACTION * simplifyAmount,
  );
  let out = simplifyInkPoints(points, tolerance);

  /*
   * Whole passes, then a fraction of one.
   *
   * The dial used to buy passes through `ceil`, and a slider whose output is an
   * integer between 0 and 3 has three settings however many percent it shows.
   * Measured across its travel it changed at 55% and at 90% and nowhere else,
   * and under the bottom quarter the simplifier was still pinned at its storage
   * floor — so most of the dial genuinely did nothing, which is exactly what it
   * felt like. Speed ink made it worse by adding width variation loud enough to
   * hide what little rounding there was.
   *
   * The fix is not a higher ceiling — three passes is already converged, and a
   * fourth would quadruple the points every stroke carries for a shape nobody
   * can see. It is that the last pass is now partial: `roundInkCorners` takes
   * the cut ratio, so 1.4 passes is one full pass and one cutting 40% as deep.
   * Continuous from end to end, same maximum, same points.
   */
  const passes = roundingPasses(dial);
  const full = Math.floor(passes);
  for (let pass = 0; pass < full; pass++) {
    out = roundInkCorners(out);
  }
  const partial = (passes - full) * CHAIKIN_RATIO;
  if (partial > MIN_ROUNDING_RATIO) out = roundInkCorners(out, partial);
  return out;
}

/** Raw samples behind the pen that stay live and are re-smoothed every paint. */
const LIVE_SMOOTH_TAIL = 160;
/** The frozen anchor only advances in steps this big. */
const LIVE_SMOOTH_STEP = 80;
/**
 * A join segment must be at least this fraction of the following step.
 *
 * Below it the segment is shorter than its neighbours and its direction is
 * noise, which is what put a corner at every span boundary.
 */
const LIVE_SMOOTH_MIN_JOIN_STEP = 1.0;
/** Context carried past each cut so neither side is smoothed against a pinned end. */
const LIVE_SMOOTH_OVERLAP = 48;

export interface LiveSmoothCache {
  /**
   * The raw buffer this prefix was taken from.
   *
   * Every stroke gets a fresh raw array and appends to it in place, so identity
   * is stable for one stroke and changes the moment another starts. Checking it
   * here means the cache invalidates itself instead of depending on twenty call
   * sites remembering to clear it.
   */
  source: readonly ScenePoint[];
  anchor: number;
  prefix: ScenePoint[];
}

/** Cumulative distance along a polyline. */
function arcLengths(points: readonly ScenePoint[]): Float64Array {
  const out = new Float64Array(points.length);
  for (let i = 1; i < points.length; i++) {
    out[i] =
      out[i - 1] +
      Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  }
  return out;
}

/** First index at or past `target` along `arc`. */
function indexAtArc(arc: Float64Array, target: number): number {
  for (let i = 0; i < arc.length; i++) if (arc[i] >= target) return i;
  return arc.length;
}

/**
 * Where in `span` the raw window's `[from, to]` stretch ended up.
 *
 * Cut by arc position rather than by nearest sample. Nearest-sample looks
 * equivalent and is not: simplification can collapse a span until both ends
 * match the same output point, and then the cut is empty or inverted and the
 * spliced path jumps. Arc position is monotonic by construction, so the two
 * cuts keep their order however hard the span was thinned.
 */
function spanCuts(
  span: readonly ScenePoint[],
  window: readonly ScenePoint[],
  from: number,
  to: number,
): { a: number; b: number } {
  const rawArc = arcLengths(window);
  const rawTotal = rawArc[rawArc.length - 1];
  const spanArc = arcLengths(span);
  const spanTotal = spanArc[spanArc.length - 1];
  if (rawTotal < 1e-9 || spanTotal < 1e-9) {
    return { a: 0, b: span.length };
  }
  const at = (i: number) => (rawArc[i] / rawTotal) * spanTotal;
  const a = indexAtArc(spanArc, at(from));
  const b = indexAtArc(spanArc, at(to));
  return { a: Math.min(a, span.length), b: Math.min(Math.max(b, a), span.length) };
}

/**
 * Live reshape that only tidies near the pen.
 *
 * Re-smoothing the whole raw buffer every paint is what this module's header
 * describes, and the path behind the pen genuinely does move -- measured at
 * full strength, settled ink shifted by better than a third of a nib width per
 * frame, all the way back to the start. Tidying a bend a moment after it was
 * drawn is the point; the finished stroke shimmering while you write is not.
 *
 * The prefix is *extended*, never rebuilt. Freezing its input alone is not
 * enough: each time the anchor advances, a longer slice re-runs the simplifier,
 * it re-picks which samples survive, and the settled path lurches. Appending
 * only the newly frozen span means a point, once written, is never touched
 * again.
 */
export function smoothLiveInkPoints(
  raw: readonly ScenePoint[],
  strength: number,
  nibWidth: number,
  cache: LiveSmoothCache | null,
): { points: ScenePoint[]; cache: LiveSmoothCache | null } {
  const dial = Math.max(0, Math.min(1, strength));
  if (dial <= 0 || raw.length <= LIVE_SMOOTH_TAIL + LIVE_SMOOTH_OVERLAP) {
    return { points: smoothInkPoints(raw, strength, nibWidth, 0), cache: null };
  }

  const anchor = Math.max(
    LIVE_SMOOTH_STEP,
    Math.floor((raw.length - LIVE_SMOOTH_TAIL) / LIVE_SMOOTH_STEP) * LIVE_SMOOTH_STEP,
  );

  let next = cache;
  if (!next || next.source !== raw || next.anchor > anchor) {
    next = { source: raw, anchor: 0, prefix: [] };
  }

  while (next.anchor < anchor) {
    const from = next.anchor;
    const to = Math.min(anchor, from + LIVE_SMOOTH_STEP);
    const lo = Math.max(0, from - LIVE_SMOOTH_OVERLAP);
    const hi = Math.min(raw.length, to + LIVE_SMOOTH_OVERLAP);
    const window = raw.slice(lo, hi);
    const span = smoothInkPoints(window, strength, nibWidth, 0);
    const { a, b } = spanCuts(span, window, from - lo, to - lo);
    let k = from === 0 ? 0 : a;
    // Same degenerate-join guard as the tail below: spans are simplified
    // independently, so the first point of one can land almost on top of the
    // last point of the previous, and that near-zero segment's direction is
    // noise. Every span boundary is a potential corner without this.
    const last = next.prefix[next.prefix.length - 1];
    while (last && k + 1 < b) {
      const gap = Math.hypot(span[k].x - last.x, span[k].y - last.y);
      const step = Math.hypot(span[k + 1].x - span[k].x, span[k + 1].y - span[k].y);
      if (gap >= step * LIVE_SMOOTH_MIN_JOIN_STEP) break;
      k++;
    }
    for (; k < b; k++) next.prefix.push(span[k]);
    next.anchor = to;
  }

  const tailLo = anchor - LIVE_SMOOTH_OVERLAP;
  const tailWindow = raw.slice(tailLo);
  const tail = smoothInkPoints(tailWindow, strength, nibWidth, 0);
  const cut = spanCuts(tail, tailWindow, anchor - tailLo, tailWindow.length - 1).a;
  /*
   * Do not start the tail on top of where the prefix ended.
   *
   * The two sides simplify the same stretch independently, so their estimates
   * of the join sit close together but not together. Emitting both leaves a
   * segment far shorter than its neighbours, and a short segment's direction
   * is noise -- which showed up as a corner at the join, sharpest at full
   * smoothing where the surviving points are furthest apart. Skipping tail
   * points that fall within half a step of the prefix's end keeps every
   * segment a real one.
   */
  const points = next.prefix.slice();
  const joinAt = points[points.length - 1];
  let start = cut;
  while (start + 1 < tail.length) {
    const gap = Math.hypot(tail[start].x - joinAt.x, tail[start].y - joinAt.y);
    const step = Math.hypot(
      tail[start + 1].x - tail[start].x,
      tail[start + 1].y - tail[start].y,
    );
    if (gap >= step * LIVE_SMOOTH_MIN_JOIN_STEP) break;
    start++;
  }
  for (let k = start; k < tail.length; k++) points.push(tail[k]);
  return { points, cache: next };
}
