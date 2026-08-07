/**
 * Scene-space raster ink — draw and erase on a canvas bitmap instead of
 * Excalidraw freedraw vectors. Erasing uses `destination-out` (true pixel erase).
 *
 * Because the pen bypasses Excalidraw entirely, neither of the coach's two ways
 * of reading the board sees it for free: `captureStrokes` only walks `freedraw`
 * elements and `exportToBlob` only draws scene elements. {@link inkStrokesFromOps}
 * and {@link paintInkAtScale} are the two bridges back — one to the ink
 * recognizer, one to the exported PNG.
 */

import type { InkStroke } from "./capture";

export const STROKE_WIDTH_MIN = 1;
export const STROKE_WIDTH_MAX = 32;
/** Eraser dial goes farther so the brush can clear large areas (4× prior max of 96). */
export const ERASER_WIDTH_MAX = 384;
export const STROKE_WIDTH_DEFAULT = 2;

/** Sentinel: mouse / touch without stylus pressure — do not modulate from 0.5. */
export const NO_PRESSURE = -1;

/* ------------------------------------------------------------------ ink --- */

/**
 * How the ink dial behaves: a nib charge that drains as you write, not a flat
 * opacity over the whole stroke.
 *
 * Flat opacity was wrong twice over. It read as a uniformly grey line rather
 * than ink, and because a stroke used to be painted as a chain of overlapping
 * round-capped segments, each overlap composited again — so a "50%" stroke came
 * out near-solid down the middle with a wide soft halo on both edges. That halo
 * is what made the thinnest nib look blunt instead of like fresh lead.
 *
 * Now every stroke starts full and fades with how far it has written, and the
 * dial sets how long the charge lasts. Lifting the pen ends the op, so the next
 * stroke starts full again — the pen goes back in the ink.
 */

/** Ink never runs dry enough to be unreadable. */
export const INK_DRY_FLOOR = 0.34;

/**
 * Lead and fall lengths for the drying curve, in nib widths.
 *
 * After `lead` nib-widths of writing the charge begins to fall; over `fall` more
 * it eases down to `1 - inkDryDepth(dial)`. Distance is in nib widths so a fat
 * marker and a fine liner dry over the same amount of *writing*.
 */
export const INK_LEAD_MIN = 90;
export const INK_LEAD_SPAN = 900;
export const INK_FALL_MIN = 260;
export const INK_FALL_SPAN = 1500;

/**
 * Floor on pressure's share of the deposit.
 *
 * Pressure used to scale alpha all the way to zero, so the light in-and-out
 * ends of a fast stroke faded to nothing and the stroke read as broken. A light
 * touch should be lighter, not absent.
 */
export const INK_PRESSURE_FLOOR = 0.45;

/**
 * Smallest width, in device pixels, a stroke is allowed to rasterise at.
 *
 * Below about a pixel the antialiaser spreads the line over two rows at partial
 * coverage and the ink turns grey and furry — the "not sharp" complaint at the
 * thinnest tip, and what makes writing wash out as you zoom away from it. Round
 * the geometry up to a hairline instead and let it stay black.
 */
export const INK_MIN_DEVICE_PX = 1.15;

function smoothstep(u: number): number {
  if (u <= 0) return 0;
  if (u >= 1) return 1;
  return u * u * (3 - 2 * u);
}

/** Tail alpha at dial 0 — linear depth from dial to `1 - depth`. */
export function inkDryDepth(dial: number): number {
  const d = Math.max(0, Math.min(1, dial));
  return (1 - INK_DRY_FLOOR) * (1 - d);
}

/** Nib-widths before the charge begins to fall. */
export function inkLeadLength(dial: number): number {
  const d = Math.max(0, Math.min(1, dial));
  return INK_LEAD_MIN + INK_LEAD_SPAN * d;
}

/** Nib-widths over which alpha eases from full to the dry tail. */
export function inkFallLength(dial: number): number {
  const d = Math.max(0, Math.min(1, dial));
  return INK_FALL_MIN + INK_FALL_SPAN * d;
}

/** Charge left after `consumed` nib-widths, for a dial at `fullness`. */
export function inkReservoirAlpha(consumed: number, fullness: number): number {
  const dial = Math.max(0, Math.min(1, fullness));
  const depth = inkDryDepth(dial);
  if (depth <= 0) return 1;
  const lead = inkLeadLength(dial);
  const fall = inkFallLength(dial);
  return 1 - depth * smoothstep((consumed - lead) / fall);
}

/** Pressure's share of the deposit — lighter, never invisible. */
export function inkPressureAlpha(pNorm: number): number {
  const p = Math.max(0, Math.min(1, pNorm));
  return INK_PRESSURE_FLOOR + (1 - INK_PRESSURE_FLOOR) * p;
}

/* --------------------------------------------------------------- speed --- */

/**
 * Speed ink: a nib that is dragging lays down more than one that is flicking.
 *
 * Real ink pools where the pen dwells and starves where it runs, and that is
 * most of what separates handwriting from a plotter trace — pressure alone
 * cannot do it, because a hand presses hardest at the *start* of a stroke and
 * writes fastest through the middle.
 *
 * The stored quantity is slowness, not speed: 0 is flat out, 1 is stopped, and
 * {@link INK_SLOWNESS_NEUTRAL} is an ordinary writing pace that comes out
 * exactly as it would with the feature off. Slowness is normalised at capture
 * time and carried on the point, so a replay, a tile re-render and a PNG export
 * all reproduce the stroke that was actually written — there are no timestamps
 * to preserve and nothing to recompute.
 */

/** Pace that leaves the nib unchanged — the midpoint of the range. */
export const INK_SLOWNESS_NEUTRAL = 0.5;

/**
 * Hand speed, in CSS pixels per millisecond, that reads as an ordinary pace.
 *
 * Measured on screen rather than in scene units, so zooming the board in does
 * not turn every stroke into a "slow" one. Comfortable handwriting runs around
 * 1–1.5 px/ms; a deliberate serif is well under that and a struck-through line
 * is several times it.
 */
export const INK_SPEED_NEUTRAL_PX_MS = 1.2;

/**
 * How far the extremes of pace may push the nib, at full strength.
 *
 * Width carries most of it. Alpha alone would be invisible at the default ink
 * dial, which never dries — and width is what the eye reads as "more ink"
 * anyway.
 */
export const INK_SPEED_WIDTH_RANGE = 0.6;
export const INK_SPEED_ALPHA_BASE = 0.8;
/** `INK_SPEED_ALPHA_BASE * (1 + RANGE) = 0.992` at full slow gain. */
export const INK_SPEED_ALPHA_RANGE = 0.24;
/** Log-span for mapping hand speed to slowness. */
export const INK_SPEED_SPAN = 3.5;

/**
 * EMA weight for hand speed.
 *
 * Speed is a difference of two noisy positions over a difference of two clocks,
 * so it is far noisier than pressure and gets filtered harder. Unfiltered, a
 * stroke's width shimmers with the sample jitter rather than with the hand.
 */
export const SPEED_SMOOTHING = 0.25;

/** Normalise a screen-space pace into the 0 (flat out) – 1 (stopped) range. */
export function inkSlowness(pxPerMs: number): number {
  if (!Number.isFinite(pxPerMs) || pxPerMs <= 0) return 1;
  const t = Math.max(
    -1,
    Math.min(1, Math.log(pxPerMs / INK_SPEED_NEUTRAL_PX_MS) / Math.log(INK_SPEED_SPAN)),
  );
  return 0.5 - 0.5 * t;
}

export function smoothSpeed(previous: number, sample: number): number {
  return previous + (sample - previous) * SPEED_SMOOTHING;
}

/** Multiplier either side of 1: above when the nib drags, below when it flicks. */
function speedGain(slowness: number, strength: number, range: number): number {
  const amount = Math.max(0, Math.min(1, strength));
  if (amount <= 0) return 1;
  const slow = Math.max(0, Math.min(1, slowness));
  return 1 + range * amount * (slow - INK_SLOWNESS_NEUTRAL) * 2;
}

export function inkSpeedWidthGain(slowness: number, strength: number): number {
  return speedGain(slowness, strength, INK_SPEED_WIDTH_RANGE);
}

export function inkSpeedAlphaGain(slowness: number, strength: number): number {
  const amount = Math.max(0, Math.min(1, strength));
  if (amount <= 0) return 1;
  return INK_SPEED_ALPHA_BASE * speedGain(slowness, amount, INK_SPEED_ALPHA_RANGE);
}

export interface ScenePoint {
  x: number;
  y: number;
  pressure: number;
  /**
   * How slowly the nib was moving here — 0 flat out, 1 stopped, absent on
   * strokes written before speed ink existed (read as
   * {@link INK_SLOWNESS_NEUTRAL}).
   */
  slowness?: number;
}

export interface ViewportTransform {
  zoom: number;
  scrollX: number;
  scrollY: number;
  offsetLeft: number;
  offsetTop: number;
  width: number;
  height: number;
}

export interface InkDrawOp {
  kind: "draw";
  color: string;
  baseWidth: number;
  /** Toolbar ink dial — ceiling for stylus-driven opacity (0–1). */
  maxFullness: number;
  /** Device pressure-clip when the stroke was drawn (0.3–1). */
  pressureClip: number;
  pressureSensitive: boolean;
  /** Speed-ink strength the stroke was written with (0–1); absent means off. */
  speedInk?: number;
  points: ScenePoint[];
}

export interface InkEraseOp {
  kind: "erase";
  radius: number;
  points: ScenePoint[];
}

export type InkOp = InkDrawOp | InkEraseOp;

export function hasStylusPressure(pressure: number): boolean {
  return Number.isFinite(pressure) && pressure >= 0 && pressure !== NO_PRESSURE;
}

/** Map raw stylus pressure through the personalise clip (30–100% → 0.3–1.0). */
export function normalizePressure(raw: number, clip: number): number {
  if (!hasStylusPressure(raw)) return 0;
  const c = Math.max(0.3, Math.min(1, clip));
  return Math.min(1, raw / c);
}

/**
 * Scene units the finest tip draws at.
 *
 * The dial used to be a flat multiple, so its bottom notch was 1.35 units —
 * nearly three device pixels on a retina panel at 1:1, which is a fineliner and
 * not fresh lead. Shift the scale down instead of scaling it, so the bottom of
 * the dial gets genuinely fine without squashing everything above it: a tip of
 * `n` is `INK_TIP_MIN + (n - 1) * INK_TIP_STEP`.
 */
export const INK_TIP_MIN = 0.9;
export const INK_TIP_STEP = 1.35;

/**
 * Scene-unit line width from tip geometry; ±one tip step when stylus pressure is
 * active, and a swell or a starve when speed ink is on.
 *
 * The two trailing arguments default to "speed ink off", so every caller that
 * only wants the nib's plain geometry — the reservoir's distance scale, the
 * smoothing tolerance, the export bounds — reads it unchanged.
 */
export function inkLineWidth(
  baseWidth: number,
  pNorm: number,
  pressureSensitive = false,
  slowness = INK_SLOWNESS_NEUTRAL,
  speedInk = 0,
): number {
  const base = Math.max(INK_TIP_MIN, INK_TIP_MIN + (baseWidth - 1) * INK_TIP_STEP);
  const center = base * inkSpeedWidthGain(slowness, speedInk);
  if (!pressureSensitive) return center;
  const p = Math.max(0, Math.min(1, pNorm));
  return Math.max(INK_TIP_MIN, center + (p - 0.5) * 2 * INK_TIP_STEP);
}

/**
 * Ink laid down at one sample: the nib's charge, dimmed by how light the touch
 * is and by how fast it is travelling. `consumed` is how far into the stroke
 * the sample sits, in nib widths.
 */
export function inkStrokeAlpha(
  maxFullness: number,
  pNorm: number,
  pressureSensitive: boolean,
  consumed = 0,
  slowness = INK_SLOWNESS_NEUTRAL,
  speedInk = 0,
): number {
  const charge = inkReservoirAlpha(consumed, maxFullness);
  const paced = charge * inkSpeedAlphaGain(slowness, speedInk);
  // A dawdling nib on a full dial would otherwise ask for more than opaque.
  const deposit = Math.min(1, paced);
  if (!pressureSensitive) return deposit;
  return deposit * inkPressureAlpha(pNorm);
}

export interface InkStrokeStyle {
  lineWidth: number;
  alpha: number;
}

/** Width + alpha for one sample along a stroke. */
export function inkStrokeStyle(
  baseWidth: number,
  maxFullness: number,
  pressure: number,
  pressureClip: number,
  pressureSensitive: boolean,
  consumed = 0,
  slowness = INK_SLOWNESS_NEUTRAL,
  speedInk = 0,
): InkStrokeStyle {
  const stylus = pressureSensitive && hasStylusPressure(pressure);
  const pNorm = stylus ? normalizePressure(pressure, pressureClip) : 0;
  return {
    lineWidth: inkLineWidth(baseWidth, pNorm, stylus, slowness, speedInk),
    alpha: inkStrokeAlpha(maxFullness, pNorm, stylus, consumed, slowness, speedInk),
  };
}

/**
 * Stamp spacing along a segment, as a fraction of the current line width.
 *
 * These used to be tiny — a stroke was a chain of round-capped segments, and
 * anything sparser than about a third of a width left the edge visibly
 * scalloped on a fast flick. A stroke is now one polyline with round joins, so
 * spacing no longer decides how the edge reads; it only sets how finely the
 * width may taper between two pointer samples. That buys back roughly three
 * quarters of the points, which every full replay, every export and every saved
 * board pays for.
 *
 * Pressure strokes still stamp denser, since their width is what moves.
 */
export const INK_STEP_FACTOR = 1.1;
export const INK_STEP_FACTOR_PRESSURE = 0.55;

/**
 * EMA weight for stylus pressure on release — rise is instant, fall is smoothed.
 *
 * Raw pressure from a stylus is noisy at a few percent per sample, and width is
 * proportional to it, so an unsmoothed stroke shimmers along its edges. A press
 * should land immediately; lifting should ease out rather than snap.
 */
export const PRESSURE_SMOOTHING = 0.4;

/** Attack time hint for RasterInkLayer (milliseconds). */
export const INK_ATTACK_MS = 12;

export function smoothPressure(previous: number, sample: number): number {
  if (sample >= previous) return sample;
  return previous + (sample - previous) * PRESSURE_SMOOTHING;
}

/** Scene-unit eraser radius from the same slider as pen width. */
export function eraserSceneRadius(strokeWidth: number): number {
  return strokeWidth * 1.75;
}

export function eraserScreenRadius(strokeWidth: number, zoom: number): number {
  return eraserSceneRadius(strokeWidth) * Math.max(0.05, zoom);
}

/** Raw pointer pressure: real 0–1 for stylus, {@link NO_PRESSURE} for mouse/touch. */
export function pointerPressure(raw: number, pointerType: string): number {
  if (pointerType === "pen") {
    return Number.isFinite(raw) && raw >= 0 ? raw : 0;
  }
  return NO_PRESSURE;
}

export function stampAlongSegment(
  from: ScenePoint,
  to: ScenePoint,
  step: number,
): ScenePoint[] {
  const dist = Math.hypot(to.x - from.x, to.y - from.y);
  if (dist < step) return [to];
  const count = Math.ceil(dist / step);
  const out: ScenePoint[] = [];
  const fromSlow = from.slowness;
  const toSlow = to.slowness;
  // Only carry slowness when the stroke has it, so a stroke written with speed
  // ink off stays byte-for-byte what it was.
  const paced = fromSlow !== undefined || toSlow !== undefined;
  const slowA = fromSlow ?? INK_SLOWNESS_NEUTRAL;
  const slowB = toSlow ?? INK_SLOWNESS_NEUTRAL;
  for (let index = 1; index <= count; index++) {
    const t = index / count;
    const point: ScenePoint = {
      x: from.x + (to.x - from.x) * t,
      y: from.y + (to.y - from.y) * t,
      pressure: from.pressure + (to.pressure - from.pressure) * t,
    };
    if (paced) point.slowness = slowA + (slowB - slowA) * t;
    out.push(point);
  }
  return out;
}

/* --------------------------------------------------------------- runs --- */

/**
 * Ink used, in nib widths, at each point of a stroke.
 *
 * Append-only and cached per op, because tile re-renders and the live tail both
 * walk the same stroke repeatedly and the reservoir needs a running total. Nib
 * widths rather than scene units so a marker and a liner drain over the same
 * amount of writing rather than the same geometric length.
 */
const consumedCache = new WeakMap<InkDrawOp, number[]>();

function nibWidth(op: InkDrawOp): number {
  return Math.max(inkLineWidth(op.baseWidth, 0, false), 1e-6);
}

function consumedFor(op: InkDrawOp): number[] {
  let acc = consumedCache.get(op);
  if (!acc) {
    acc = [0];
    consumedCache.set(op, acc);
  }
  const points = op.points;
  // Undo hands back a different array; a shortened stroke invalidates the tail.
  if (acc.length > points.length) acc.length = Math.max(1, points.length);
  const nib = nibWidth(op);
  for (let index = acc.length; index < points.length; index++) {
    const prev = points[index - 1];
    const next = points[index];
    acc.push(acc[index - 1] + Math.hypot(next.x - prev.x, next.y - prev.y) / nib);
  }
  return acc;
}

/** A stretch of a stroke that can be laid down in one canvas path. */
export interface InkStrokeRun {
  /** First polyline position, inclusive (fractional between samples). */
  start: number;
  /** Last polyline position, inclusive — the next run starts here, so nothing gaps. */
  end: number;
  lineWidth: number;
  alpha: number;
}

/**
 * Width and alpha buckets a run is allowed to span.
 *
 * Everything downstream hangs off these. Painting each segment on its own was
 * O(points) canvas submissions for a stroke that is one shape, and — worse —
 * consecutive round caps overlap, so at any alpha below 1 every overlap
 * composited again and the line came out solid in the middle with a soft halo
 * around it. Grouped into runs, a whole constant-width stroke is a single
 * `stroke()`: one coverage mask, one composite, exact alpha, crisp edges.
 *
 * The buckets are fine enough that the steps are invisible and coarse enough
 * that a pressure stroke lands in tens of runs rather than hundreds.
 */
const RUN_WIDTH_QUANTUM = 0.06;
const RUN_ALPHA_QUANTUM = 1 / 48;
/** Alpha at or above this uses the opaque round-cap fast path. */
export const RUN_OPAQUE_ALPHA = 1 - RUN_ALPHA_QUANTUM / 2;

/** Interpolate position, pressure, and slowness along a polyline at fractional `pos`. */
export function strokePointAt(points: ScenePoint[], pos: number): ScenePoint {
  const last = points.length - 1;
  if (last <= 0) return points[0];
  const index = Math.max(0, Math.min(pos, last));
  const i = Math.floor(index);
  const j = Math.min(i + 1, last);
  if (i >= last) return points[last];
  const t = index - i;
  const a = points[i];
  const b = points[j];
  const point: ScenePoint = {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    pressure: a.pressure + (b.pressure - a.pressure) * t,
  };
  if (a.slowness !== undefined || b.slowness !== undefined) {
    const slowA = a.slowness ?? INK_SLOWNESS_NEUTRAL;
    const slowB = b.slowness ?? INK_SLOWNESS_NEUTRAL;
    point.slowness = slowA + (slowB - slowA) * t;
  }
  return point;
}

/** Split a stroke into paintable runs, starting at `fromIndex`. */
export function inkStrokeRuns(op: InkDrawOp, fromIndex = 0): InkStrokeRun[] {
  const points = op.points;
  const runs: InkStrokeRun[] = [];
  if (points.length < 2) return runs;

  const consumed = consumedFor(op);
  const maxFullness = op.maxFullness ?? 1;
  const pressureClip = op.pressureClip ?? 1;
  const speedInk = op.speedInk ?? 0;
  const widthQuantum = nibWidth(op) * RUN_WIDTH_QUANTUM;

  const styleAt = (index: number) =>
    inkStrokeStyle(
      op.baseWidth,
      maxFullness,
      points[index].pressure,
      pressureClip,
      op.pressureSensitive,
      consumed[index] ?? 0,
      points[index].slowness ?? INK_SLOWNESS_NEUTRAL,
      speedInk,
    );

  let start = Math.max(0, Math.min(fromIndex, points.length - 2));
  let style = styleAt(start);
  let bucketW = Math.round(style.lineWidth / widthQuantum);
  let bucketA = Math.round(style.alpha / RUN_ALPHA_QUANTUM);
  let sumWidth = style.lineWidth;
  let sumAlpha = style.alpha;
  let count = 1;

  for (let index = start + 1; index < points.length; index++) {
    const next = styleAt(index);
    const nextW = Math.round(next.lineWidth / widthQuantum);
    const nextA = Math.round(next.alpha / RUN_ALPHA_QUANTUM);
    if (nextW !== bucketW || nextA !== bucketA) {
      const split = index - 0.5;
      runs.push({ start, end: split, lineWidth: sumWidth / count, alpha: sumAlpha / count });
      start = split;
      bucketW = nextW;
      bucketA = nextA;
      sumWidth = next.lineWidth;
      sumAlpha = next.alpha;
      count = 1;
      continue;
    }
    sumWidth += next.lineWidth;
    sumAlpha += next.alpha;
    count += 1;
  }
  if (start < points.length - 1) {
    runs.push({
      start,
      end: points.length - 1,
      lineWidth: sumWidth / count,
      alpha: sumAlpha / count,
    });
  }
  return runs;
}

/**
 * Geometric width, floored so a thin nib still rasterises as a hairline.
 *
 * `pixelScale` is device pixels per scene unit; 0 means the caller does not
 * know it and no floor is applied.
 */
function paintedWidth(lineWidth: number, pixelScale: number): number {
  if (pixelScale <= 0) return lineWidth;
  return Math.max(lineWidth, INK_MIN_DEVICE_PX / pixelScale);
}

/** Half-disc terminal cap — `outwardAngle` points out of the stroke body. */
function inkTerminalCap(
  ctx: CanvasRenderingContext2D,
  at: { x: number; y: number },
  outwardAngle: number,
  radius: number,
): void {
  ctx.beginPath();
  ctx.moveTo(at.x, at.y);
  ctx.arc(at.x, at.y, radius, outwardAngle - Math.PI / 2, outwardAngle + Math.PI / 2);
  ctx.fill();
}

function drawStrokeFrom(
  ctx: CanvasRenderingContext2D,
  op: InkDrawOp,
  fromIndex: number,
  pixelScale: number,
  capEnd = true,
): void {
  const points = op.points;
  if (points.length === 0) return;

  ctx.globalCompositeOperation = "source-over";
  ctx.strokeStyle = op.color;
  ctx.fillStyle = op.color;

  // A tap is a dot — dotting an "i" used to draw nothing at all.
  if (points.length === 1) {
    if (fromIndex > 0) return;
    const style = inkStrokeStyle(
      op.baseWidth,
      op.maxFullness ?? 1,
      points[0].pressure,
      op.pressureClip ?? 1,
      op.pressureSensitive,
      0,
      points[0].slowness ?? INK_SLOWNESS_NEUTRAL,
      op.speedInk ?? 0,
    );
    ctx.globalAlpha = style.alpha;
    ctx.beginPath();
    ctx.arc(points[0].x, points[0].y, paintedWidth(style.lineWidth, pixelScale) / 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
    return;
  }

  const start = Math.max(0, fromIndex);
  if (start >= points.length - 1) return;

  const runs = inkStrokeRuns(op, start);
  if (runs.length === 0) return;

  const opaque = runs.every((run) => run.alpha >= RUN_OPAQUE_ALPHA);

  if (opaque) {
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    for (const run of runs) {
      ctx.lineWidth = paintedWidth(run.lineWidth, pixelScale);
      ctx.globalAlpha = run.alpha;
      const iStart = Math.ceil(run.start);
      const iEnd = Math.ceil(run.end);
      ctx.beginPath();
      ctx.moveTo(points[iStart].x, points[iStart].y);
      for (let index = iStart + 1; index <= iEnd; index++) {
        ctx.lineTo(points[index].x, points[index].y);
      }
      ctx.stroke();
    }
  } else {
    ctx.lineCap = "butt";
    ctx.lineJoin = "round";
    for (let ri = 0; ri < runs.length; ri++) {
      const run = runs[ri];
      ctx.lineWidth = paintedWidth(run.lineWidth, pixelScale);
      ctx.globalAlpha = run.alpha;
      const radius = paintedWidth(run.lineWidth, pixelScale) / 2;

      const pStart = strokePointAt(points, run.start);
      const pEnd = strokePointAt(points, run.end);

      if (Math.hypot(pEnd.x - pStart.x, pEnd.y - pStart.y) < 1e-6) {
        ctx.beginPath();
        ctx.arc(pStart.x, pStart.y, radius, 0, Math.PI * 2);
        ctx.fill();
        continue;
      }

      ctx.beginPath();
      ctx.moveTo(pStart.x, pStart.y);
      for (let i = Math.floor(run.start) + 1; i < run.end; i++) {
        ctx.lineTo(points[i].x, points[i].y);
      }
      ctx.lineTo(pEnd.x, pEnd.y);
      ctx.stroke();

      if (fromIndex === 0 && ri === 0) {
        const nextIdx = Math.floor(run.start) + 1;
        const nextPt =
          nextIdx < run.end && nextIdx < points.length
            ? points[nextIdx]
            : strokePointAt(points, Math.min(run.start + 0.001, run.end));
        const headAngle = Math.atan2(pStart.y - nextPt.y, pStart.x - nextPt.x);
        inkTerminalCap(ctx, pStart, headAngle, radius);
      }

      if (capEnd && ri === runs.length - 1) {
        const prevIdx = Math.ceil(run.end) - 1;
        const prevPt =
          prevIdx > run.start && prevIdx >= 0
            ? points[prevIdx]
            : strokePointAt(points, Math.max(run.end - 0.001, run.start));
        const tailAngle = Math.atan2(pEnd.y - prevPt.y, pEnd.x - prevPt.x);
        inkTerminalCap(ctx, pEnd, tailAngle, radius);
      }
    }
  }
  ctx.globalAlpha = 1;
}

function eraseStampsFrom(
  ctx: CanvasRenderingContext2D,
  op: InkEraseOp,
  fromIndex: number,
): void {
  const start = Math.max(0, fromIndex);
  if (start >= op.points.length) return;
  ctx.globalCompositeOperation = "destination-out";
  ctx.fillStyle = "rgba(0,0,0,1)";
  ctx.globalAlpha = 1;
  // One path for the whole rub-out. Erase stamps are laid down every fraction
  // of a radius, so a single wipe is thousands of them; filling each on its own
  // was the reason a page with one erase on it replayed slowly forever after.
  ctx.beginPath();
  for (let index = start; index < op.points.length; index++) {
    const point = op.points[index];
    ctx.moveTo(point.x + op.radius, point.y);
    ctx.arc(point.x, point.y, op.radius, 0, Math.PI * 2);
  }
  ctx.fill();
}

/** Apply one committed or live op in scene space (caller sets the transform). */
export type ApplyInkOptions = { capEnd?: boolean };

export function applyInkOp(
  ctx: CanvasRenderingContext2D,
  op: InkOp,
  pixelScale = 0,
  options?: ApplyInkOptions,
): void {
  const capEnd = options?.capEnd ?? true;
  if (op.kind === "draw") drawStrokeFrom(ctx, op, 0, pixelScale, capEnd);
  else eraseStampsFrom(ctx, op, 0);
  ctx.globalCompositeOperation = "source-over";
}

/**
 * Paint only the unpainted tail of a live op. `fromIndex` is the last point
 * already covered (draw) or the first undrawn stamp index (erase). Returns the
 * next `fromIndex` for a subsequent call — O(new points), not O(all points).
 */
export function applyInkOpFrom(
  ctx: CanvasRenderingContext2D,
  op: InkOp,
  fromIndex: number,
  pixelScale = 0,
): number {
  if (op.kind === "draw") {
    drawStrokeFrom(ctx, op, fromIndex, pixelScale, false);
    ctx.globalCompositeOperation = "source-over";
    return Math.max(fromIndex, op.points.length - 1);
  }
  eraseStampsFrom(ctx, op, fromIndex);
  ctx.globalCompositeOperation = "source-over";
  return op.points.length;
}

/** Scene-space transform used by the live ink overlay and the bake buffer. */
export function setInkSceneTransform(
  ctx: CanvasRenderingContext2D,
  viewport: ViewportTransform,
  dpr: number,
): void {
  const { zoom, scrollX, scrollY } = viewport;
  ctx.setTransform(
    zoom * dpr,
    0,
    0,
    zoom * dpr,
    scrollX * zoom * dpr,
    scrollY * zoom * dpr,
  );
}

/** Repaint the full ink bitmap from committed ops + an in-progress op. */
export function paintRasterInk(
  ctx: CanvasRenderingContext2D,
  viewport: ViewportTransform,
  ops: readonly InkOp[],
  liveOp: InkOp | null,
  dpr: number,
  /**
   * Scene box to paint inside, or `null` for the whole canvas. Pen ink is
   * pixels rather than scene elements, so hiding an off-page element is not
   * enough — the tablet's one-page view clips the ink layer to the same box.
   */
  clip: SceneBounds | null = null,
): void {
  const { width, height } = viewport;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  // Canvas element origin = top-left of the overlay. Only scroll + zoom apply here;
  // offsetLeft/offsetTop are viewport coords and must NOT be added again.
  setInkSceneTransform(ctx, viewport, dpr);

  if (clip) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(clip.minX, clip.minY, clip.maxX - clip.minX, clip.maxY - clip.minY);
    ctx.clip();
  }

  const pixelScale = viewport.zoom * dpr;
  for (const op of ops) {
    applyInkOp(ctx, op, pixelScale);
  }

  if (liveOp) {
    applyInkOp(ctx, liveOp, pixelScale);
  }

  ctx.globalCompositeOperation = "source-over";
  if (clip) ctx.restore();
}

/** Axis-aligned box in scene coordinates. */
export interface SceneBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export function unionSceneBounds(
  a: SceneBounds | null,
  b: SceneBounds | null,
): SceneBounds | null {
  if (!a) return b;
  if (!b) return a;
  return {
    minX: Math.min(a.minX, b.minX),
    minY: Math.min(a.minY, b.minY),
    maxX: Math.max(a.maxX, b.maxX),
    maxY: Math.max(a.maxY, b.maxY),
  };
}

/**
 * Where the drawn ink sits, padded by the widest line it could have been
 * stroked with. Null when nothing has been drawn — the caller's cue that the
 * plain Excalidraw export is already complete.
 *
 * Erase ops do not shrink this: a stroke that was drawn and then rubbed out
 * still costs its area in the exported PNG. That is a few empty pixels, not a
 * correctness problem, and it keeps this cheap enough to call on every submit.
 */
export function inkOpsBounds(ops: readonly InkOp[]): SceneBounds | null {
  let bounds: SceneBounds | null = null;
  for (const op of ops) {
    if (op.kind !== "draw") continue;
    const maxFullness = op.maxFullness ?? 1;
    const pressureClip = op.pressureClip ?? 1;
    // Full press at a standstill — the widest this nib can ever have been.
    const style = inkStrokeStyle(
      op.baseWidth,
      maxFullness,
      1,
      pressureClip,
      op.pressureSensitive,
      0,
      1,
      op.speedInk ?? 0,
    );
    const half = style.lineWidth / 2;
    for (const point of op.points) {
      bounds = unionSceneBounds(bounds, {
        minX: point.x - half,
        minY: point.y - half,
        maxX: point.x + half,
        maxY: point.y + half,
      });
    }
  }
  return bounds;
}

/**
 * Repaint committed ops for an export of `scale` pixels per scene unit, with
 * `origin` at the canvas top-left.
 *
 * This must run on a canvas of its own: erase ops composite with
 * `destination-out`, so painting straight onto an exported board image would
 * punch holes through the board rather than through the ink.
 */
export function paintInkAtScale(
  ctx: CanvasRenderingContext2D,
  ops: readonly InkOp[],
  origin: { x: number; y: number },
  scale: number,
): void {
  ctx.setTransform(scale, 0, 0, scale, -origin.x * scale, -origin.y * scale);
  // Chronological order: a pen stroke drawn *after* an erase must survive.
  // Applying every erase after every draw punched holes through later ink.
  for (const op of ops) {
    if (op.kind === "draw") drawStrokeFrom(ctx, op, 0, scale);
    else eraseStampsFrom(ctx, op, 0);
  }
  ctx.globalCompositeOperation = "source-over";
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

/**
 * The scale Excalidraw actually rendered an export at, read back from the
 * canvas it returned rather than assumed from `appState.exportScale`.
 *
 * Null when the two axes disagree, which means the export no longer maps onto
 * `bounds` the way this code expects. Callers fall back to the ink-less export:
 * a board whose pen strokes landed in the wrong place would mislead the coach
 * more than a board with no pen strokes at all.
 */
export function exportScaleFrom(
  canvasWidth: number,
  canvasHeight: number,
  bounds: SceneBounds,
): number | null {
  const width = bounds.maxX - bounds.minX;
  const height = bounds.maxY - bounds.minY;
  if (width <= 0 || height <= 0 || canvasWidth <= 0 || canvasHeight <= 0) return null;
  const scaleX = canvasWidth / width;
  const scaleY = canvasHeight / height;
  // Canvas dimensions are whole pixels, so allow a little slack on small boards.
  if (Math.abs(scaleX - scaleY) > Math.max(scaleX * 0.02, 0.01)) return null;
  return scaleX;
}

/** Longest edge, in pixels, of a composited board export. */
export const MAX_EXPORT_EDGE = 4096;

/**
 * Shrink an export that a stray far-away stroke would otherwise blow up.
 *
 * Ink extends the exported box, and a dot left behind after panning across the
 * scene can put the two ends thousands of units apart. Browsers refuse very
 * large canvases outright, and the PNG still has to fit the daemon's body limit.
 */
export function clampExportScale(
  scale: number,
  bounds: SceneBounds,
  maxEdge = MAX_EXPORT_EDGE,
): number {
  const longEdge = Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY) * scale;
  return longEdge > maxEdge ? (scale * maxEdge) / longEdge : scale;
}

/** A run shorter than this is an eraser crumb, not a pen stroke. */
const RECOGNITION_MIN_POINTS = 2;
/**
 * Scene units between recognizer points. Drawing stamps points every fraction
 * of a line width so the bitmap looks smooth; the recognizer only needs the
 * path, and a tablet-sized board of raw stamps is a large payload for nothing.
 */
const RECOGNITION_MIN_SPACING = 1.5;

/**
 * Draw ops as recognizer strokes, in the order they were written.
 *
 * Erased pixels are dropped, and a stroke the eraser cut through comes back as
 * two strokes — feeding ML Kit ink the student has already rubbed out is how
 * `recognized_text` ends up describing a discarded first attempt. Only erases
 * that happen *after* a draw remove its points, matching {@link paintRasterInk}.
 */
export function inkStrokesFromOps(ops: readonly InkOp[]): InkStroke[] {
  const strokes: InkStroke[] = [];
  let run: Array<{ x: number; y: number }> = [];

  const endRun = () => {
    if (run.length >= RECOGNITION_MIN_POINTS) strokes.push({ points: run });
    run = [];
  };

  // One index over every erase stamp on the board, queried per draw op. It used
  // to be rebuilt from `ops.slice(i + 1)` inside the loop, which made submitting
  // a page quadratic in the number of strokes on it.
  const erasedAfter = eraseLookup(ops);

  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    if (op.kind !== "draw") continue;
    for (const point of op.points) {
      if (erasedAfter(point, i)) {
        endRun();
        continue;
      }
      const last = run[run.length - 1];
      if (last && Math.hypot(point.x - last.x, point.y - last.y) < RECOGNITION_MIN_SPACING) {
        continue;
      }
      run.push({ x: Math.round(point.x), y: Math.round(point.y) });
    }
    endRun();
  }
  return strokes;
}

/**
 * Point-in-a-later-erase-stamp test, bucketed by the widest eraser radius so a
 * long rub-out doesn't turn recognition into a quadratic scan. Cells are that
 * radius wide, so every stamp that can cover a point lives in one of the nine
 * cells around it.
 *
 * Stamps carry the index of the op they came from: only an erase *after* a
 * stroke removes its points, matching what the tiles paint.
 */
function eraseLookup(
  ops: readonly InkOp[],
): (point: ScenePoint, afterIndex: number) => boolean {
  let cell = 0;
  for (const op of ops) {
    if (op.kind === "erase") cell = Math.max(cell, op.radius);
  }
  if (cell <= 0) return () => false;

  const buckets = new Map<string, Array<{ x: number; y: number; r: number; op: number }>>();
  for (let index = 0; index < ops.length; index++) {
    const op = ops[index];
    if (op.kind !== "erase") continue;
    for (const point of op.points) {
      const key = `${Math.floor(point.x / cell)},${Math.floor(point.y / cell)}`;
      const stamp = { x: point.x, y: point.y, r: op.radius, op: index };
      const bucket = buckets.get(key);
      if (bucket) bucket.push(stamp);
      else buckets.set(key, [stamp]);
    }
  }

  return (point, afterIndex) => {
    const cx = Math.floor(point.x / cell);
    const cy = Math.floor(point.y / cell);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const bucket = buckets.get(`${cx + dx},${cy + dy}`);
        if (!bucket) continue;
        for (const stamp of bucket) {
          if (stamp.op <= afterIndex) continue;
          if (Math.hypot(point.x - stamp.x, point.y - stamp.y) <= stamp.r) return true;
        }
      }
    }
    return false;
  };
}

/** Pixel position on the ink canvas → scene coordinates. */
export function scenePointFromCanvasPixel(
  localX: number,
  localY: number,
  viewport: Pick<ViewportTransform, "zoom" | "scrollX" | "scrollY">,
): { x: number; y: number } {
  const { zoom, scrollX, scrollY } = viewport;
  return {
    x: localX / zoom - scrollX,
    y: localY / zoom - scrollY,
  };
}

export function scenePointFromPointer(
  clientX: number,
  clientY: number,
  canvasRect: DOMRect,
  viewport: Pick<ViewportTransform, "zoom" | "scrollX" | "scrollY">,
  pressure: number,
  pointerType: string,
): ScenePoint {
  const localX = clientX - canvasRect.left;
  const localY = clientY - canvasRect.top;
  return {
    ...scenePointFromCanvasPixel(localX, localY, viewport),
    pressure: pointerPressure(pressure, pointerType),
  };
}

export function isOverCanvas(
  clientX: number,
  clientY: number,
  canvas: HTMLCanvasElement | null,
): boolean {
  if (!canvas) return false;
  const rect = canvas.getBoundingClientRect();
  return (
    clientX >= rect.left &&
    clientX <= rect.right &&
    clientY >= rect.top &&
    clientY <= rect.bottom
  );
}
