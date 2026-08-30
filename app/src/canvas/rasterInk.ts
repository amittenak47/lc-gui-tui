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
import {
  INK_BOLDNESS_MIN,
  INK_BOLDNESS_MAX,
  loadInkBoldness,
} from "../util/inkBoldnessPref";
import { loadInkSpeedBlotBlend } from "../util/inkSpeedPref";

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
 * Flipped-logistic drying curve, in nib-widths of continuous writing.
 *
 * Midpoint (`inkDryMid`) is where charge is halfway to the floor; scale
 * (`inkDryScale`) is the logistic width — small = cliff, large = near-flat.
 * Dial 0: drops within a word. Dial 0.5: across a sentence. Dial 1: across a
 * short paragraph — still eventually dry, never an infinite reservoir.
 */
export const INK_DRY_MID_MIN = 70;
export const INK_DRY_MID_SPAN = 3400;
export const INK_DRY_SCALE_MIN = 22;
export const INK_DRY_SCALE_SPAN = 800;

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

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function logistic(x: number): number {
  if (x >= 20) return 1;
  if (x <= -20) return 0;
  return 1 / (1 + Math.exp(-x));
}

/** Nib-widths where the charge is halfway to the floor. */
export function inkDryMid(dial: number): number {
  const d = clamp01(dial);
  // Superlinear so the top half of the dial buys paragraph length.
  return INK_DRY_MID_MIN + INK_DRY_MID_SPAN * d ** 1.8;
}

/** Logistic width — dial 0 is a cliff, dial 1 is near-flat. */
export function inkDryScale(dial: number): number {
  const d = clamp01(dial);
  return INK_DRY_SCALE_MIN + INK_DRY_SCALE_SPAN * d ** 1.5;
}

/** Charge left after `consumed` nib-widths, for a dial at `fullness`. */
export function inkReservoirAlpha(consumed: number, fullness: number): number {
  // Exactly 1 means "do not dry" — pressure-off strokes record maxFullness: 1.
  // Pressure-on at the dial's top stores 0.999 so a paragraph still fades.
  if (!(fullness < 1)) return 1;
  const c = Math.max(0, consumed);
  if (c <= 0) return 1;
  const dial = clamp01(fullness);
  const depth = 1 - INK_DRY_FLOOR;
  const mid = inkDryMid(dial);
  const scale = Math.max(1e-6, inkDryScale(dial));
  // Flipped sigmoid: full at the head, floor past the midpoint.
  return 1 - depth * logistic((c - mid) / scale);
}

/** Pressure's share of the deposit — lighter, never invisible. */
export function inkPressureAlpha(pNorm: number): number {
  const p = clamp01(pNorm);
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
export const INK_SPEED_WIDTH_RANGE = 1.35;
export const INK_SPEED_ALPHA_BASE = 0.55;
/** Headroom under opaque at full slow: BASE * (1 + RANGE) ≈ 0.94. */
export const INK_SPEED_ALPHA_RANGE = 0.5;
/** Log-span for mapping hand speed to slowness — tighter so writing hits extremes. */
export const INK_SPEED_SPAN = 2.0;

/**
 * EMA weight for hand speed.
 *
 * Speed is a difference of two noisy positions over a difference of two clocks,
 * so it is far noisier than pressure and gets filtered harder. Unfiltered, a
 * stroke's width shimmers with the sample jitter rather than with the hand.
 */
export const SPEED_SMOOTHING = 0.5;

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

/**
 * Thinnest a flick may leave the nib, as a fraction of its plain width.
 *
 * {@link INK_SPEED_WIDTH_RANGE} is 1.35, so at full strength the raw multiplier
 * runs from −0.35 to 2.35 — the fast half of that is *negative*, and a negative
 * width is not a thin line, it is whatever `paintedWidth`'s hairline floor
 * happens to be. That is half of the capsule the writer sees: fat pools where
 * the hand paused, one-pixel thread between them, and nothing in between
 * because the arithmetic went through zero. A pen that runs dry still lays down
 * a line, so the multiplier has a floor and the range compresses into it.
 */
export const INK_SPEED_MIN_WIDTH_GAIN = 0.45;

/** Pace as −1 (sprint) … 0 (ordinary) … +1 (stopped). */
export function inkSpeedPaceUnit(slowness: number): number {
  return (Math.max(0, Math.min(1, slowness)) - INK_SLOWNESS_NEUTRAL) * 2;
}

/**
 * Mid-stroke width modifier: 0 at a full stop and a sprint, ±1 when the nib
 * is a bit slow / a bit fast. Body accent is this times a 0–1 amplitude.
 */
/**
 * Rest weight: 0 at ordinary pace and at a sprint, 1 at a full stop.
 *
 * Body is the endpoint tuner, and pen-down and lift are the slowest samples on
 * the curve — so the shape it scales is rest, not a bump either side of
 * ordinary pace. Positive fattens the ends; negative cancels Speed ink's rest
 * swell so a lift does not land as a round blob.
 */
export function inkSpeedBodyShape(slowness: number): number {
  return Math.max(0, inkSpeedPaceUnit(slowness));
}

/** Multiplier either side of 1: above when the nib drags, below when it flicks. */
function speedGain(slowness: number, strength: number, range: number): number {
  const amount = Math.max(0, Math.min(1, strength));
  if (amount <= 0) return 1;
  return 1 + range * amount * inkSpeedPaceUnit(slowness);
}

export function inkSpeedWidthGain(
  slowness: number,
  strength: number,
  bodyAccent = 0,
): number {
  const amount = Math.max(0, Math.min(1, strength));
  const linear = amount * inkSpeedPaceUnit(slowness);
  // Bipolar: the dial reads -100..+100 and the negative half has to reach the
  // paint, or the left of the slider is a no-op. At 0 this term vanishes and
  // the gain is exactly the single pace curve.
  const body =
    amount > 0
      ? Math.max(-1, Math.min(1, bodyAccent)) * inkSpeedBodyShape(slowness)
      : 0;
  return Math.max(
    INK_SPEED_MIN_WIDTH_GAIN,
    1 + INK_SPEED_WIDTH_RANGE * (linear + body),
  );
}

export function inkSpeedAlphaGain(slowness: number, _strength: number, fade = 0): number {
  const fadeAmt = Math.max(0, Math.min(1, fade));
  if (fadeAmt <= 0) return 1;
  const paced = INK_SPEED_ALPHA_BASE * speedGain(slowness, 1, INK_SPEED_ALPHA_RANGE);
  return 1 + (paced - 1) * fadeAmt;
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

/** Scroll-host binding shared by draw and erase ops. */
export interface InkHostBinding {
  /**
   * Document-order index among horizontal scroll hosts in the doc scope —
   * see {@link horizontalScrollHostsIn} in `scrollHost.ts`.
   */
  hostKey: number;
  /** `scrollLeft` of that host when the stroke was written. */
  scrollLeftAtDraw: number;
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
  /**
   * Amplitude of the mid-stroke width modifier (0–1). Stamped at draw time.
   * Absent on older strokes → 0 (Speed ink line only).
   */
  speedBodyAccent?: number;
  /**
   * Rim softness / dwell growth feel for speed-ink discs (0–1).
   * 0 = hard expanding core; 1 = wider soft rim + faster growth. Absent → device pref.
   */
  speedBlotBlend?: number;
  /**
   * How much pace washes opacity toward pencil (0–1). Stamped at draw time.
   * Absent on older speed-ink strokes → full wash (today's 0.55 base).
   */
  speedFade?: number;
  /**
   * Opacity boost stamped at draw time (0–3). Absent → paint uses device pref.
   * Pen strokes only — highlighters ignore this.
   */
  boldness?: number;
  /**
   * A highlighter stroke rather than a pen one.
   *
   * A chisel, not a nib: one width the whole way, one alpha the whole way, and
   * neither pressure nor pace touches it. Real highlighters do not modulate,
   * and a translucent stroke that did would band where the passes overlapped.
   */
  highlight?: boolean;
  /** When set, the stroke tracks a nested horizontal scroller's `scrollLeft`. */
  hostKey?: number;
  scrollLeftAtDraw?: number;
  /** Stable id for the global undo log. Assigned at commit. */
  id?: number;
  /** Global composite order. Assigned at commit. */
  seq?: number;
  points: ScenePoint[];
}

export interface InkEraseOp {
  kind: "erase";
  radius: number;
  hostKey?: number;
  scrollLeftAtDraw?: number;
  /** Stable id for the global undo log. Assigned at commit. */
  id?: number;
  /** Global composite order. Assigned at commit. */
  seq?: number;
  points: ScenePoint[];
}

export type InkOp = InkDrawOp | InkEraseOp;

/** True when an op was written inside a nested horizontal scroll host. */
export function isHostBoundOp(op: InkOp): boolean {
  return (
    op.hostKey !== undefined &&
    op.scrollLeftAtDraw !== undefined &&
    Number.isFinite(op.hostKey) &&
    Number.isFinite(op.scrollLeftAtDraw)
  );
}

/** Scene-space X shift so host-bound ink stays on the tokens it was drawn over.
 *
 * `scrollLeft` is in the host's local CSS px. The page content slot is authored
 * in scene units and only camera-scaled via CSS transform, so local CSS px ≡
 * scene units — do not divide by zoom (that made Board ink lag the lab).
 */
export function hostScrollDx(op: InkOp, scrollLeftNow: number, _zoom = 1): number {
  if (!isHostBoundOp(op)) return 0;
  return -(scrollLeftNow - op.scrollLeftAtDraw!);
}

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
 * How much wider than the pen the highlighter runs, and how much it deposits.
 *
 * Wide enough to cover a line of handwriting in one pass at a mid dial, and
 * translucent enough that two passes over the same words do not turn them into
 * a block. The alpha is fixed rather than dialled: it composites `multiply`, so
 * what governs legibility is the product of the passes, and letting the ink
 * dial push it up would make a second stroke opaque.
 */
export const HIGHLIGHT_WIDTH_SCALE = 8;
export const HIGHLIGHT_ALPHA = 0.3;

/**
 * Drop the lift-off hook on a highlighter stroke.
 *
 * Multiply compositing darkens wherever the chisel retraces. A stylus lifting
 * often backtracks a millimetre; those samples look like a second pass at the
 * tip. Trim a short reverse tail. A real U-turn that travels farther than
 * ~1.25× the chisel stays.
 */
export function trimHighlightLiftHook(
  points: readonly ScenePoint[],
  chiselWidth: number,
): ScenePoint[] {
  if (points.length < 3) return points.slice();
  const maxHook = Math.max(chiselWidth * 1.25, 6);
  const hi = Math.max(1, Math.min(points.length - 2, Math.floor((points.length - 1) * 0.7)));
  const hx = points[hi]!.x - points[0]!.x;
  const hy = points[hi]!.y - points[0]!.y;
  const hLen = Math.hypot(hx, hy);
  if (hLen < 1e-6) return points.slice();
  let end = points.length - 1;
  let trimmed = 0;
  while (end >= 2) {
    const b = points[end - 1]!;
    const c = points[end]!;
    const wx = c.x - b.x;
    const wy = c.y - b.y;
    const wLen = Math.hypot(wx, wy);
    if (wLen < 1e-6) {
      end -= 1;
      continue;
    }
    const cos = (hx * wx + hy * wy) / (hLen * wLen);
    if (cos >= -0.15) break;
    if (trimmed + wLen > maxHook) break;
    trimmed += wLen;
    end -= 1;
  }
  return end + 1 === points.length ? points.slice() : points.slice(0, end + 1);
}

/**
 * Hard floor on a tip, for degenerate input only.
 *
 * {@link INK_TIP_MIN} is the *slider's* minimum and used to be the clamp as
 * well, which was fine while every stroke's base width came straight off the
 * dial — the two are the same number at setting 1. Zoom compensation (see
 * {@link inkBaseWidthForZoom}) asks for tips below that, and clamping them back
 * up is precisely the bug it exists to fix: on a page opened at 2× the thinnest
 * nib the writer can pick was twice the thickness of the same nib on the
 * scratchpad, and no setting would bring it down.
 *
 * Nothing is lost by letting it go: how thin a stroke may be *drawn* is a
 * rendering question and `paintedWidth` already answers it, flooring at
 * {@link INK_MIN_DEVICE_PX} device pixels wherever the camera happens to be.
 * This one only keeps the arithmetic away from zero.
 */
export const INK_TIP_FLOOR = 0.05;

/**
 * Scene-unit line width from tip geometry, plus swell/starve when speed ink is
 * on. Stylus pressure does **not** change width — only alpha — so a fat tip
 * stays a cylinder, not a pressure-swollen marker.
 *
 * `pNorm` / `pressureSensitive` stay in the signature so callers and older ops
 * keep compiling; they are ignored for width.
 *
 * The two trailing arguments default to "speed ink off", so every caller that
 * only wants the nib's plain geometry — the reservoir's distance scale, the
 * smoothing tolerance, the export bounds — reads it unchanged.
 */
export function inkLineWidth(
  baseWidth: number,
  _pNorm: number,
  _pressureSensitive = false,
  slowness = INK_SLOWNESS_NEUTRAL,
  speedInk = 0,
  bodyAccent = 0,
): number {
  const base = Math.max(INK_TIP_FLOOR, INK_TIP_MIN + (baseWidth - 1) * INK_TIP_STEP);
  return base * inkSpeedWidthGain(slowness, speedInk, bodyAccent);
}

/**
 * The base width to store so a stroke *looks* `uiWidth` thick at this camera.
 *
 * Ink is stored in scene units and painted at the board's zoom, which is right
 * — ink belongs to the page, so it scales when the page does. What was wrong is
 * that the *slider* was in those units too. The scratchpad and an annotated
 * document sit at different zooms by design (a document is fitted to a reading
 * column, a pad is not), so the same setting drew a visibly fatter nib on the
 * document, and at the bottom of the dial there was nowhere left to go.
 *
 * Converting at stroke start puts the dial in screen pixels and leaves
 * everything downstream alone: the op still stores scene units, old strokes
 * still mean what they meant, and zooming after the fact still scales the ink.
 * Only "how thick is the pen I am holding" stops depending on where I am
 * holding it.
 */
export function inkBaseWidthForZoom(uiWidth: number, zoom: number): number {
  const scale = Math.max(0.05, zoom);
  const tip = Math.max(INK_TIP_FLOOR, INK_TIP_MIN + (uiWidth - 1) * INK_TIP_STEP);
  return 1 + (tip / scale - INK_TIP_MIN) / INK_TIP_STEP;
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
  boldness = 1,
  fade = 0,
): number {
  const charge = inkReservoirAlpha(consumed, maxFullness);
  const paced = charge * inkSpeedAlphaGain(slowness, speedInk, fade);
  // A dawdling nib on a full dial would otherwise ask for more than opaque.
  const deposit = Math.min(1, paced * boldness);
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
  highlight = false,
  boldness = 1,
  fade = 0,
  bodyAccent = 0,
): InkStrokeStyle {
  // A chisel has one width and one wetness — no reservoir, no pressure, no pace.
  if (highlight) {
    return {
      lineWidth: inkLineWidth(baseWidth, 0, false) * HIGHLIGHT_WIDTH_SCALE,
      alpha: HIGHLIGHT_ALPHA,
    };
  }
  const stylus = pressureSensitive && hasStylusPressure(pressure);
  const pNorm = stylus ? normalizePressure(pressure, pressureClip) : 0;
  return {
    lineWidth: inkLineWidth(baseWidth, pNorm, stylus, slowness, speedInk, bodyAccent),
    alpha: inkStrokeAlpha(
      maxFullness,
      pNorm,
      stylus,
      consumed,
      slowness,
      speedInk,
      boldness,
      fade,
    ),
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
/*
 * Keyed by the *points array*, not by the op.
 *
 * A live stroke keeps one op object for its whole life: the move path pushes
 * stamps onto `points` in place, which is what makes an append-only total worth
 * having. But live reshaping (smoothing under the nib) replaces `points`
 * wholesale with a re-smoothed array on the same op — a different drawing under
 * the same key. Keyed by the op, the running total would keep the prefix it had
 * computed for the *old* geometry and only append past it, so every distance
 * downstream of the reshape would be measured against points that are no longer
 * there. Keyed by the array, an in-place push still hits the cache and a
 * reshape misses it, which is exactly the distinction that matters.
 */
const consumedCache = new WeakMap<readonly ScenePoint[], number[]>();

function nibWidth(op: InkDrawOp): number {
  return Math.max(inkLineWidth(op.baseWidth, 0, false), 1e-6);
}

function consumedFor(op: InkDrawOp): number[] {
  const points = op.points;
  let acc = consumedCache.get(points);
  if (!acc) {
    acc = [0];
    consumedCache.set(points, acc);
  }
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
const RUN_WIDTH_QUANTUM = 0.045;

/**
 * Half-width of the low-pass over a stroke's slowness, in **nib widths of
 * travel**.
 *
 * A run is painted at one constant width, so the width a stroke actually shows
 * is a staircase over the slowness track. When that track swings quickly — and
 * speed is a difference of two noisy positions over a difference of two clocks,
 * so it does — the staircase becomes a chain of beads: fat where the hand
 * paused at a letter join, thin either side. That is the "earthworm".
 *
 * Filtering harder at capture would fix the beads by making the pen sluggish,
 * because that filter also decides how fast the nib may respond at all. This
 * one runs over the committed stroke, where the whole path is known, so it can
 * be symmetric: the width ramps into and out of a change instead of stepping.
 *
 * **Why distance and not samples.** This was a five-tap box over the point
 * *index*, tuned on the assumption that five stamps span about a nib width.
 * Smoothing breaks that assumption: Chaikin does not move points, it *inserts*
 * them, roughly doubling the chain per pass — so with smoothing turned up the
 * same five taps covered an eighth of the distance they were tuned for and the
 * filter all but stopped working. Which is exactly the shape of the complaint:
 * beads that get worse when smoothing goes on, the one combination that should
 * have looked best. Measured in nib widths the window is what it says it is at
 * any point density.
 */
const SLOWNESS_WINDOW_NIBS = 0.5;

/**
 * Most the slowness track may change per nib width travelled.
 *
 * The low-pass takes the noise out; this takes the *cliff* out. A bead is a
 * width discontinuity — the hand stopped dead at a letter join and the track
 * stepped rather than ramped — and no amount of averaging forbids a step, it
 * only makes a shorter one. A slope limit forbids it outright: full swing takes
 * about three nib widths of travel, which is roughly the distance over which a
 * real nib's deposit actually changes.
 *
 * The cap is on slowness rather than on width, which is what makes it scale for
 * free: width is linear in slowness through {@link inkSpeedWidthGain}, so the
 * width slope this permits is automatically proportional to how far the writer
 * has turned speed ink up. At zero strength it constrains nothing, because
 * there is nothing to constrain.
 */
const SLOWNESS_MAX_SLOPE = 0.35;

/**
 * Slowness, low-passed along the stroke, cached per op.
 *
 * Keyed by identity like {@link consumedFor}, and for the same reason: this is
 * asked for again by every tile the stroke crosses, on every repaint.
 */
const slownessCache = new WeakMap<readonly ScenePoint[], Float32Array>();

function slopedSlowness(op: InkDrawOp): Float32Array {
  const points = op.points;
  const cached = slownessCache.get(points);
  if (cached && cached.length === points.length) return cached;

  const raw = new Float32Array(points.length);
  for (let i = 0; i < points.length; i++) {
    raw[i] = points[i].slowness ?? INK_SLOWNESS_NEUTRAL;
  }

  // Cumulative travel in nib widths — the same measure the reservoir uses, so
  // the window and the slope cap below are both in units the nib understands.
  const at = consumedFor(op);
  const out = new Float32Array(points.length);

  /*
   * Box filter over a window of *travel*, walked with two indices rather than
   * searched per point, so this stays linear over a stroke however dense it is.
   * The window is clamped at the ends rather than shortened: one that narrowed
   * toward the tip would leave the last stamps noisier than the rest, which is
   * exactly where a terminal bead shows.
   */
  let lo = 0;
  let hi = 0;
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const from = at[i] - SLOWNESS_WINDOW_NIBS;
    const to = at[i] + SLOWNESS_WINDOW_NIBS;
    while (hi < points.length && at[hi] <= to) sum += raw[hi++];
    while (lo < hi - 1 && at[lo] < from) sum -= raw[lo++];
    out[i] = sum / (hi - lo);
  }

  /*
   * Slope limit, forward then backward.
   *
   * One pass alone is causal and would ramp *into* a change while still
   * stepping out of it — a bead with one soft edge, which reads as a comma. The
   * reverse pass makes it symmetric, and taking the value nearer neutral of the
   * two keeps the pair from arguing: neither direction may push the track
   * further from an ordinary pace than the unlimited one already was.
   */
  const limit = (order: readonly number[]) => {
    for (let n = 1; n < order.length; n++) {
      const i = order[n];
      const prev = order[n - 1];
      const span = Math.abs(at[i] - at[prev]);
      const room = SLOWNESS_MAX_SLOPE * span;
      const delta = out[i] - out[prev];
      if (delta > room) out[i] = out[prev] + room;
      else if (delta < -room) out[i] = out[prev] - room;
    }
  };
  const forward = Array.from(out, (_, i) => i);
  limit(forward);
  limit(forward.slice().reverse());

  slownessCache.set(points, out);
  return out;
}
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

/**
 * Width and alpha at every polyline sample — the values ribbon paint uses.
 *
 * Unlike {@link inkStrokeRuns}, widths are not averaged into buckets; each
 * point keeps its own geometry after {@link slopedSlowness} and the speed gain
 * floor.
 */
export function inkStrokePointStyles(
  op: InkDrawOp,
  fromIndex = 0,
): InkStrokeStyle[] {
  const points = op.points;
  if (points.length === 0) return [];

  const consumed = consumedFor(op);
  const maxFullness = op.maxFullness ?? 1;
  const pressureClip = op.pressureClip ?? 1;
  const speedInk = op.speedInk ?? 0;
  const bodyAccent = resolveSpeedBodyAccent(op);
  const boldness = op.highlight ? 1 : resolveInkBoldness(op);
  const slowness = speedInk > 0 ? slopedSlowness(op) : null;

  const start = Math.max(0, Math.min(fromIndex, points.length - 1));
  const styles: InkStrokeStyle[] = [];
  for (let index = start; index < points.length; index++) {
    styles.push(
      inkStrokeStyle(
        op.baseWidth,
        maxFullness,
        points[index].pressure,
        pressureClip,
        op.pressureSensitive,
        consumed[index] ?? 0,
        slowness ? slowness[index] : (points[index].slowness ?? INK_SLOWNESS_NEUTRAL),
        speedInk,
        op.highlight === true,
        boldness,
        resolveSpeedFade(op),
        bodyAccent,
      ),
    );
  }
  return styles;
}

/** Unit tangent along the stroke at a polyline sample. */
function strokeTangentAt(points: readonly ScenePoint[], index: number): { x: number; y: number } {
  const last = points.length - 1;
  if (last <= 0) return { x: 1, y: 0 };
  let dx = 0;
  let dy = 0;
  if (index <= 0) {
    dx = points[1].x - points[0].x;
    dy = points[1].y - points[0].y;
  } else if (index >= last) {
    dx = points[last].x - points[last - 1].x;
    dy = points[last].y - points[last - 1].y;
  } else {
    dx = points[index + 1].x - points[index - 1].x;
    dy = points[index + 1].y - points[index - 1].y;
  }
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return { x: 1, y: 0 };
  return { x: dx / len, y: dy / len };
}

/** Unit normal perpendicular to the stroke at a polyline sample. */
function strokeNormalAt(points: readonly ScenePoint[], index: number): { x: number; y: number } {
  const last = points.length - 1;
  if (last <= 0) return { x: 0, y: 1 };
  let dx = 0;
  let dy = 0;
  if (index <= 0) {
    dx = points[1].x - points[0].x;
    dy = points[1].y - points[0].y;
  } else if (index >= last) {
    dx = points[last].x - points[last - 1].x;
    dy = points[last].y - points[last - 1].y;
  } else {
    dx = points[index + 1].x - points[index - 1].x;
    dy = points[index + 1].y - points[index - 1].y;
  }
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return { x: 0, y: 1 };
  return { x: -dy / len, y: dx / len };
}

/** Left and right offset polylines for a variable-width ribbon. */
export function ribbonSides(
  points: readonly ScenePoint[],
  styles: readonly InkStrokeStyle[],
  pixelScale: number,
): { left: Array<{ x: number; y: number }>; right: Array<{ x: number; y: number }> } {
  const left: Array<{ x: number; y: number }> = [];
  const right: Array<{ x: number; y: number }> = [];
  let prevNx = 0;
  let prevNy = 1;
  for (let index = 0; index < points.length; index++) {
    let { x: nx, y: ny } = strokeNormalAt(points, index);
    if (index > 0) {
      const prevT = strokeTangentAt(points, index - 1);
      const currT = strokeTangentAt(points, index);
      const reversing = prevT.x * currT.x + prevT.y * currT.y < 0;
      // Only force normal continuity for noise — not when direction reverses.
      if (!reversing && nx * prevNx + ny * prevNy < 0) {
        nx = -nx;
        ny = -ny;
      }
    }
    prevNx = nx;
    prevNy = ny;
    const half = paintedWidth(styles[index].lineWidth, pixelScale) / 2;
    const center = points[index];
    left.push({ x: center.x + nx * half, y: center.y + ny * half });
    right.push({ x: center.x - nx * half, y: center.y - ny * half });
  }
  return { left, right };
}

/** Drop consecutive samples closer than ~0.2× local half-width; keep tip and max slowness. */
const RIBBON_COALESCE_HALF_FRAC = 0.2;
/** Insert midpoints when a chord exceeds ~0.45× average half-width. */
const RIBBON_DENSIFY_HALF_FRAC = 0.45;
/** Trailing tip cluster within this × nib stays a disc, not a ribbon knot. */
const TIP_CLUSTER_NIB_FRAC = 0.35;

function lerpScenePoint(a: ScenePoint, b: ScenePoint, t: number): ScenePoint {
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

function lerpInkStyle(a: InkStrokeStyle, b: InkStrokeStyle, t: number): InkStrokeStyle {
  return {
    lineWidth: a.lineWidth + (b.lineWidth - a.lineWidth) * t,
    alpha: a.alpha + (b.alpha - a.alpha) * t,
  };
}

function mergeRibbonVertex(
  kept: ScenePoint,
  keptStyle: InkStrokeStyle,
  next: ScenePoint,
  nextStyle: InkStrokeStyle,
): { point: ScenePoint; style: InkStrokeStyle } {
  const slow = Math.max(
    kept.slowness ?? INK_SLOWNESS_NEUTRAL,
    next.slowness ?? INK_SLOWNESS_NEUTRAL,
  );
  // Stay on the first sample of a near-duplicate cluster; absorb pace/style only.
  const point: ScenePoint = { ...kept, slowness: slow };
  const style =
    nextStyle.lineWidth > keptStyle.lineWidth || nextStyle.alpha > keptStyle.alpha
      ? nextStyle
      : keptStyle;
  return { point, style };
}

/**
 * Collapse near-duplicate ribbon samples so dwell knots do not fan into shards.
 */
export function coalesceRibbonPoints(
  points: readonly ScenePoint[],
  styles: readonly InkStrokeStyle[],
  pixelScale: number,
): { points: ScenePoint[]; styles: InkStrokeStyle[] } {
  if (points.length === 0) return { points: [], styles: [] };
  if (points.length !== styles.length) {
    return { points: points.slice(), styles: styles.slice() };
  }
  if (points.length <= 2) {
    return { points: points.slice(), styles: styles.slice() };
  }

  const outPts: ScenePoint[] = [points[0]];
  const outStyles: InkStrokeStyle[] = [styles[0]];
  for (let index = 1; index < points.length - 1; index++) {
    const prev = outPts[outPts.length - 1];
    const prevStyle = outStyles[outStyles.length - 1];
    const cur = points[index];
    const curStyle = styles[index];
    const half = paintedWidth(curStyle.lineWidth, pixelScale) / 2;
    const minDist = Math.max(0.5, half * RIBBON_COALESCE_HALF_FRAC);
    if (Math.hypot(cur.x - prev.x, cur.y - prev.y) < minDist) {
      const merged = mergeRibbonVertex(prev, prevStyle, cur, curStyle);
      outPts[outPts.length - 1] = merged.point;
      outStyles[outStyles.length - 1] = merged.style;
      continue;
    }
    outPts.push(cur);
    outStyles.push(curStyle);
  }

  const last = points[points.length - 1];
  const lastStyle = styles[styles.length - 1];
  const prev = outPts[outPts.length - 1];
  const prevStyle = outStyles[outStyles.length - 1];
  const half = paintedWidth(lastStyle.lineWidth, pixelScale) / 2;
  const minDist = Math.max(0.5, half * RIBBON_COALESCE_HALF_FRAC);
  if (Math.hypot(last.x - prev.x, last.y - prev.y) < minDist) {
    const slow = Math.max(
      prev.slowness ?? INK_SLOWNESS_NEUTRAL,
      last.slowness ?? INK_SLOWNESS_NEUTRAL,
    );
    outPts[outPts.length - 1] = { ...last, slowness: slow };
    outStyles[outStyles.length - 1] =
      lastStyle.lineWidth > prevStyle.lineWidth || lastStyle.alpha > prevStyle.alpha
        ? lastStyle
        : prevStyle;
  } else {
    outPts.push(last);
    outStyles.push(lastStyle);
  }
  return { points: outPts, styles: outStyles };
}

/**
 * Insert midpoints on long chords so thick ribbons do not show one-facet spokes.
 */
export function densifyRibbonPoints(
  points: readonly ScenePoint[],
  styles: readonly InkStrokeStyle[],
  pixelScale: number,
): { points: ScenePoint[]; styles: InkStrokeStyle[] } {
  if (points.length < 2 || points.length !== styles.length) {
    return { points: points.slice(), styles: styles.slice() };
  }
  const outPts: ScenePoint[] = [points[0]];
  const outStyles: InkStrokeStyle[] = [styles[0]];
  for (let index = 1; index < points.length; index++) {
    const a = outPts[outPts.length - 1];
    const aStyle = outStyles[outStyles.length - 1];
    const b = points[index];
    const bStyle = styles[index];
    const halfA = paintedWidth(aStyle.lineWidth, pixelScale) / 2;
    const halfB = paintedWidth(bStyle.lineWidth, pixelScale) / 2;
    const maxStep = Math.max(0.75, ((halfA + halfB) / 2) * RIBBON_DENSIFY_HALF_FRAC);
    const dist = Math.hypot(b.x - a.x, b.y - a.y);
    if (dist > maxStep) {
      const count = Math.ceil(dist / maxStep);
      for (let step = 1; step < count; step++) {
        const t = step / count;
        outPts.push(lerpScenePoint(a, b, t));
        outStyles.push(lerpInkStyle(aStyle, bStyle, t));
      }
    }
    outPts.push(b);
    outStyles.push(bStyle);
  }
  return { points: outPts, styles: outStyles };
}

/**
 * Index where a trailing tip cluster begins, or `points.length` if none / no split.
 * Cluster must leave a ribbon prefix of at least 2 points.
 */
export function trailingTipClusterStart(
  points: readonly ScenePoint[],
  nib: number,
): number {
  if (points.length < 4) return points.length;
  const tip = points[points.length - 1];
  const eps = Math.max(nib * TIP_CLUSTER_NIB_FRAC, 0.5);
  let start = points.length - 1;
  for (let index = points.length - 2; index >= 0; index--) {
    if (Math.hypot(points[index].x - tip.x, points[index].y - tip.y) > eps) break;
    start = index;
  }
  const clusterLen = points.length - start;
  if (clusterLen < 2) return points.length;
  // Need ≥2 points before the cluster for a ribbon prefix (prefix = [0..start]).
  if (start < 2) return points.length;
  return start;
}

/**
 * Fill the whole ribbon as one path, not a segment at a time.
 *
 * A `fill()` per segment antialiases the edge each pair of them shares twice:
 * a boundary pixel takes coverage `a` from one and `1 - a` from the other and
 * composites to `1 - a + a²`, 0.75 at the worst pixel. Every densified point
 * therefore ruled a lighter hairline across the stroke, roughly every half
 * nib, and a ribbon cross-hatched that often reads as pencil rather than ink.
 * Painting opaque into the scratch never addressed this — that fixed alpha
 * *stacking*, a different artefact. Measured on a straight ribbon: 66 of 375
 * centre-row pixels short of full ink per-segment, 0 as one path.
 *
 * One path rasterises once, so shared edges are interior and never sampled —
 * and it is one `fill()` for the stroke instead of one per segment. Segments
 * go in as two triangles rather than a quad, each wound the same direction: a
 * nonzero fill unions same-wound subpaths, but a subpath that flipped
 * orientation would cancel against its neighbour and punch a hole, and a quad
 * that crosses itself has no orientation to normalise — its signed area is
 * zero. A triangle cannot cross itself, so it always has one.
 */
function addRibbonSubpaths(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  left: readonly { x: number; y: number }[],
  right: readonly { x: number; y: number }[],
): void {
  if (left.length < 2) return;
  for (let index = 0; index < left.length - 1; index++) {
    addWoundTriangle(ctx, left[index], left[index + 1], right[index + 1]);
    addWoundTriangle(ctx, left[index], right[index + 1], right[index]);
  }
}

/** Add one closed triangle subpath, always wound the same direction. */
function addWoundTriangle(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  a: { x: number; y: number },
  b: { x: number; y: number },
  c: { x: number; y: number },
): void {
  const twiceArea =
    (b.x - a.x) * (b.y + a.y) + (c.x - b.x) * (c.y + b.y) + (a.x - c.x) * (a.y + c.y);
  ctx.moveTo(a.x, a.y);
  // Negative, to match `ctx.arc(...)` with the default sweep: join discs and
  // caps go into this same path, and a subpath of opposite winding would
  // cancel against the ribbon under a nonzero fill and punch a hole.
  if (twiceArea <= 0) {
    ctx.lineTo(b.x, b.y);
    ctx.lineTo(c.x, c.y);
  } else {
    ctx.lineTo(c.x, c.y);
    ctx.lineTo(b.x, b.y);
  }
  ctx.closePath();
}






/**
 * Fill a variable-width ribbon as per-segment quads.
 * When a scratch canvas is available, quads paint opaque then blit once at
 * `alpha` so self-overlaps do not stack into darker glass-shard facets.
 */
export function fillInkRibbon(
  ctx: CanvasRenderingContext2D,
  left: readonly { x: number; y: number }[],
  right: readonly { x: number; y: number }[],
  alpha: number,
): void {
  if (left.length === 0 || left.length !== right.length) return;
  if (left.length === 1) {
    const radius = Math.hypot(left[0].x - right[0].x, left[0].y - right[0].y) / 2;
    ctx.globalAlpha = alpha;
    ctx.beginPath();
    ctx.arc(
      (left[0].x + right[0].x) / 2,
      (left[0].y + right[0].y) / 2,
      radius,
      0,
      Math.PI * 2,
    );
    ctx.fill();
    return;
  }

  ctx.globalAlpha = alpha;
  ctx.beginPath();
  addRibbonSubpaths(ctx, left, right);
  ctx.fill();
}




function strokePathLength(points: readonly ScenePoint[], fromIndex = 0): number {
  let len = 0;
  for (let index = Math.max(1, fromIndex); index < points.length; index++) {
    const prev = points[index - 1];
    const next = points[index];
    len += Math.hypot(next.x - prev.x, next.y - prev.y);
  }
  return len;
}

/**
 * Parse `#rgb` / `#rrggbb` / `rgb()` / `rgba()` into RGB; fall back to black.
 * Used so radial disc fades can share the stroke colour at varying alpha.
 */
export function inkColorRgb(color: string): { r: number; g: number; b: number } {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
  if (hex) {
    let h = hex[1];
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    return {
      r: Number.parseInt(h.slice(0, 2), 16),
      g: Number.parseInt(h.slice(2, 4), 16),
      b: Number.parseInt(h.slice(4, 6), 16),
    };
  }
  const rgb = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i.exec(color.trim());
  if (rgb) {
    return { r: Number(rgb[1]), g: Number(rgb[2]), b: Number(rgb[3]) };
  }
  return { r: 0, g: 0, b: 0 };
}

function resolveSpeedBlotBlend(op: InkDrawOp): number {
  if (op.speedBlotBlend !== undefined) return clamp01(op.speedBlotBlend);
  return clamp01(loadInkSpeedBlotBlend());
}

/** Variable-width ribbon when speed ink and/or blot is on. Runs are the flat pen. */
function usesSpeedRibbon(op: InkDrawOp): boolean {
  if (op.highlight) return false;
  return (op.speedInk ?? 0) > 0 || resolveSpeedBlotBlend(op) > 1e-3;
}

function resolveSpeedFade(op: InkDrawOp): number {
  if (op.speedFade !== undefined) return clamp01(op.speedFade);
  /*
   * Absent means off, not "full wash".
   *
   * This returned 1 whenever Speed ink was on, so a stroke that never asked
   * for fade was multiplied by `INK_SPEED_ALPHA_BASE` (0.55) anyway -- which is
   * why switching Speed ink on quietly turned the pen grey instead of leaving
   * it the colour the wheel says. Fade is a knob of its own; Speed ink is
   * shape only, and may not spend the alpha budget on the writer's behalf.
   */
  return 0;
}

function resolveSpeedBodyAccent(op: InkDrawOp): number {
  if ((op.speedInk ?? 0) <= 0) return 0;
  if (op.speedBodyAccent !== undefined) {
    return Math.max(-1, Math.min(1, op.speedBodyAccent));
  }
  return 0;
}

function resolveInkBoldness(op: InkDrawOp): number {
  if (op.boldness !== undefined) {
    return Math.min(INK_BOLDNESS_MAX, Math.max(INK_BOLDNESS_MIN, op.boldness));
  }
  return loadInkBoldness();
}

/** Tip-down dwell starts as this fraction of the tip radius, then grows out. */
const DWELL_BLOT_MIN_CORE_FRAC = 0.04;

/**
 * Outer/inner radii for a speed-ink disc.
 *
 * - `growT` 0 → tiny opaque core; 1 → full tip radius (capped — no overshoot).
 * - Soft fade lives only in `innerR…outerR`; core stays solid.
 * - `blotBlend` widens the rim band (0 = hard edge).
 */
export function inkDiscRadii(
  tipRadius: number,
  blotBlend: number,
  growT = 1,
): { outerR: number; innerR: number } {
  const tip = Math.max(0, tipRadius);
  const blend = clamp01(blotBlend);
  const t = clamp01(growT);
  const eased = 1 - (1 - t) * (1 - t);
  const minCore = tip * DWELL_BLOT_MIN_CORE_FRAC;
  const outerR = minCore + (tip - minCore) * eased;
  const rimFrac = blend < 1e-3 ? 0 : 0.12 + 0.38 * blend;
  const innerR = Math.max(0, outerR * (1 - rimFrac));
  return { outerR, innerR };
}

/**
 * How far a near-stationary tip cluster has grown toward full tip radius.
 * More clustered samples → higher `growT`; higher blot blend reaches full sooner.
 */
export function dwellBlotGrowT(
  points: readonly ScenePoint[],
  tipRadius: number,
  blotBlend: number,
): number {
  if (points.length === 0) return 0;
  if (tipRadius < 1e-6) return 1;
  if (points.length <= 1) return 1;
  const tip = points[points.length - 1];
  const eps = Math.max(tipRadius * 0.25, 0.5);
  let cluster = 0;
  for (let index = points.length - 1; index >= 0; index--) {
    if (Math.hypot(points[index].x - tip.x, points[index].y - tip.y) > eps) break;
    cluster++;
  }
  // ~55 dwell ticks (~1.8s at 32ms) to full; blend may shorten mildly (floor 40).
  const ticksToFull = Math.max(40, 55 - 15 * clamp01(blotBlend));
  /*
   * The pool is however far it actually spread, and no further.
   *
   * Two guards used to defeat this. `!isDiscPrimaryPath(...) return 1` fired
   * the moment the samples spread wider than the nib -- that is, the instant
   * the pen moved -- so a pool that had crept out to a third of the nib was
   * discarded and redrawn at full radius: the ink "assumes it was at the
   * maximum pooling size". And flooring at 0.85 put first contact at 97.8% of
   * full width (`1 - 0.15^2`), so a plain tap landed as a finished blot with
   * no spread to watch. Both are gone; growth is the dwell it earned.
   */
  return clamp01((cluster - 1) / Math.max(1, ticksToFull));
}

function strokeClusterExtent(points: readonly ScenePoint[]): number {
  if (points.length === 0) return 0;
  let minX = points[0].x;
  let maxX = points[0].x;
  let minY = points[0].y;
  let maxY = points[0].y;
  for (let index = 1; index < points.length; index++) {
    const p = points[index];
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  return Math.hypot(maxX - minX, maxY - minY);
}

/** Near-stationary / dwell paths paint a growing disc instead of a self-winding ribbon. */
export function isDiscPrimaryPath(
  points: readonly ScenePoint[],
  nib: number,
): boolean {
  if (points.length <= 1) return true;
  const pathLen = strokePathLength(points);
  if (pathLen < 1e-3) return true;
  if (points.length === 2 && pathLen < nib * 0.25) return true;
  // Slight pen wiggles stay disc-only (~1× nib bbox) so ribbons do not shard.
  return strokeClusterExtent(points) < nib * 1.0;
}

/**
 * Speed-ink tip / join disc.
 *
 * - `softFade` false (tip-down / short-path): hard disc; `growT` expands from a
 *   tiny core to full tip radius — no radial halo past the nib.
 * - `softFade` true (ribbon joins): radial fade clamped to nib radius;
 *   `blotBlend` softens centre contrast / gradient stops into the ribbon.
 */
export function paintInkDisc(
  ctx: CanvasRenderingContext2D,
  center: { x: number; y: number },
  lineWidth: number,
  alpha: number,
  pixelScale: number,
  blotBlend = 0,
  color?: string,
  softFade = true,
  growT = 1,
): void {
  const tipRadius = paintedWidth(lineWidth, pixelScale) / 2;
  if (tipRadius < 1e-6) return;
  const blend = clamp01(blotBlend);

  if (!softFade || blend < 1e-3) {
    const { outerR } = inkDiscRadii(tipRadius, softFade ? 0 : blend, growT);
    if (outerR < 1e-6) return;
    ctx.globalAlpha = alpha;
    ctx.beginPath();
    ctx.arc(center.x, center.y, outerR, 0, Math.PI * 2);
    ctx.fill();
    return;
  }

  const fadeRadius = tipRadius;
  const centerAlpha = alpha;
  const { r, g, b } = inkColorRgb(color ?? String(ctx.fillStyle));
  const gradient = ctx.createRadialGradient(
    center.x,
    center.y,
    0,
    center.x,
    center.y,
    fadeRadius,
  );
  gradient.addColorStop(0, `rgba(${r}, ${g}, ${b}, ${centerAlpha})`);
  gradient.addColorStop(0.55 + 0.25 * (1 - blend), `rgba(${r}, ${g}, ${b}, ${centerAlpha * 0.45})`);
  gradient.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0)`);
  ctx.globalAlpha = 1;
  const prevFill = ctx.fillStyle;
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.arc(center.x, center.y, fadeRadius, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = prevFill;
}

/** |cross(t0, t1)| above this gets a round join disc at interior samples. */
const RIBBON_CURVATURE_JOIN = 0.7;

/** Variable-width ribbon fill for speed ink — one opaque silhouette, then one alpha blit. */
function drawRibbonStrokeFrom(
  ctx: CanvasRenderingContext2D,
  op: InkDrawOp,
  fromIndex: number,
  pixelScale: number,
  capEnd: boolean,
  capHead = true,
): void {
  const points = op.points;
  if (points.length === 0) return;
  const blotBlend = resolveSpeedBlotBlend(op);
  const color = op.color;

  if (points.length === 1) {
    if (fromIndex > 0) return;
    const style = inkStrokePointStyles(op, 0)[0];
    const tipR = paintedWidth(style.lineWidth, pixelScale) / 2;
    const growT = dwellBlotGrowT(points, tipR, blotBlend);
    paintInkDisc(
      ctx,
      points[0],
      style.lineWidth,
      style.alpha,
      pixelScale,
      blotBlend,
      color,
      false,
      growT,
    );
    ctx.globalAlpha = 1;
    return;
  }

  const start = Math.max(0, Math.min(fromIndex, points.length - 2));
  if (start >= points.length - 1) return;

  const slice = points.slice(start);
  const styles = inkStrokePointStyles(op, start);
  if (slice.length < 2 || styles.length < 2) return;

  const nib = nibWidth(op);
  if (blotBlend > 1e-3 && isDiscPrimaryPath(slice, nib)) {
    let maxWidth = 0;
    let maxAlpha = 0;
    for (const style of styles) {
      maxWidth = Math.max(maxWidth, style.lineWidth);
      maxAlpha = Math.max(maxAlpha, style.alpha);
    }
    const tipR = paintedWidth(maxWidth, pixelScale) / 2;
    const growT = dwellBlotGrowT(slice, tipR, blotBlend);
    paintInkDisc(
      ctx,
      slice[slice.length - 1],
      maxWidth,
      maxAlpha,
      pixelScale,
      blotBlend,
      color,
      false,
      growT,
    );
    ctx.globalAlpha = 1;
    return;
  }

  let ribbonPoints = slice;
  let ribbonStyles = styles;
  /*
   * Discs are Speed blot's, and only Speed blot's.
   *
   * This ran unconditionally, so a Speed-ink stroke with blot Off still broke
   * its tail off into a pool at every lift and pause — graphite from a knob
   * that is supposed to be shape only. Blot Off is a solid ribbon the whole
   * way; a pause under it changes nothing.
   */
  const tipClusterAt =
    blotBlend > 1e-3 ? trailingTipClusterStart(slice, nib) : slice.length;
  if (tipClusterAt < slice.length) {
    const tipPts = slice.slice(tipClusterAt);
    const tipStyles = styles.slice(tipClusterAt);
    let tipWidth = 0;
    let tipAlpha = 0;
    for (const style of tipStyles) {
      tipWidth = Math.max(tipWidth, style.lineWidth);
      tipAlpha = Math.max(tipAlpha, style.alpha);
    }
    const tipR = paintedWidth(tipWidth, pixelScale) / 2;
    const growT = dwellBlotGrowT(tipPts, tipR, blotBlend);
    paintInkDisc(
      ctx,
      tipPts[tipPts.length - 1],
      tipWidth,
      tipAlpha,
      pixelScale,
      blotBlend,
      color,
      false,
      growT,
    );
    // Ribbon the prefix only (include the cluster start as the tip join vertex).
    ribbonPoints = slice.slice(0, tipClusterAt + 1);
    ribbonStyles = styles.slice(0, tipClusterAt + 1);
    if (ribbonPoints.length < 2) {
      ctx.globalAlpha = 1;
      return;
    }
  }

  const coalesced = coalesceRibbonPoints(ribbonPoints, ribbonStyles, pixelScale);
  const prepared = densifyRibbonPoints(coalesced.points, coalesced.styles, pixelScale);
  if (prepared.points.length < 2) {
    ctx.globalAlpha = 1;
    return;
  }

  let maxAlpha = 0;
  let maxHalf = 0;
  for (const style of prepared.styles) {
    maxAlpha = Math.max(maxAlpha, style.alpha);
    maxHalf = Math.max(maxHalf, paintedWidth(style.lineWidth, pixelScale) / 2);
  }

  const { left, right } = ribbonSides(prepared.points, prepared.styles, pixelScale);

  /*
   * Join discs and caps, added to the caller's path rather than filled.
   *
   * They used to be stamped into a scratch canvas so that, at alpha below 1,
   * a disc overlapping the ribbon would not composite twice and darken. Inside
   * one path that cannot happen: overlap is resolved by the winding rule
   * during a single rasterisation, so one fill paints the union at exactly the
   * alpha asked for.
   */
  const addHardExtras = (
    target: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  ) => {
    // Join discs are graphite too: the same round stamp, laid where the stroke
    // turns. With blot Off the ribbon's own mitre carries the corner.
    for (let i = 1; blotBlend > 1e-3 && i < prepared.points.length - 1; i++) {
      const t0 = strokeTangentAt(prepared.points, i - 1);
      const t1 = strokeTangentAt(prepared.points, i);
      const cross = Math.abs(t0.x * t1.y - t0.y * t1.x);
      if (cross > RIBBON_CURVATURE_JOIN) {
        addDiscSubpath(
          target,
          prepared.points[i],
          paintedWidth(prepared.styles[i].lineWidth, pixelScale) / 2,
        );
      }
    }
    if (capHead && fromIndex === 0 && tipClusterAt >= slice.length) {
      const radius = paintedWidth(prepared.styles[0].lineWidth, pixelScale) / 2;
      const next = prepared.points[1];
      const headAngle = Math.atan2(
        prepared.points[0].y - next.y,
        prepared.points[0].x - next.x,
      );
      addTerminalCapSubpath(target, prepared.points[0], headAngle, radius);
    }
    if (capEnd && tipClusterAt >= slice.length) {
      const last = prepared.points.length - 1;
      const half = paintedWidth(prepared.styles[last].lineWidth, pixelScale) / 2;
      /*
       * A pool that has started spreading keeps its size, and stays a circle.
       *
       * `trailingTipClusterStart` needs a few clustered samples before it will
       * call the tail a dwell. While the pen rests, arriving samples push it
       * back and forth across that threshold, so the terminal alternated
       * between the grown pool and this cap -- a half-disc at the ribbon's own
       * width. That swap, several times a second, is the flicker, and the half
       * is why it flashes a semicircle. Measuring the dwell here too means the
       * two agree on the radius, and the terminal is drawn round either way,
       * so crossing the threshold changes nothing on screen.
       */
      const dwelt = dwellBlotGrowT(prepared.points, half, blotBlend);
      const pooled = inkDiscRadii(half, blotBlend, dwelt).outerR;
      if (pooled > half + 1e-6) {
        addDiscSubpath(target, prepared.points[last], pooled);
      } else {
        const prev = prepared.points[last - 1];
        const tailAngle = Math.atan2(
          prepared.points[last].y - prev.y,
          prepared.points[last].x - prev.x,
        );
        addTerminalCapSubpath(target, prepared.points[last], tailAngle, half);
      }
    }
    if (tipClusterAt < slice.length && prepared.points.length >= 2) {
      const last = prepared.points.length - 1;
      addDiscSubpath(
        target,
        prepared.points[last],
        paintedWidth(prepared.styles[last].lineWidth, pixelScale) / 2,
      );
    }
  };

  /*
   * One path, one fill, straight onto the target at its own resolution.
   *
   * This used to paint into a scratch canvas at one pixel per *scene* unit and
   * blit it at `zoom * dpr`, which enlarged every ribbon -- four fifths of a
   * 3px nib dissolving into grey at 5x zoom -- and cost a clear, a blit and,
   * whenever the bounds grew, a fresh canvas allocation mid-stroke. The scratch
   * only ever existed to stop self-overlap stacking at alpha below 1, and a
   * single path cannot stack against itself: the rasteriser resolves overlap by
   * winding before any compositing happens. So it is both sharper and cheaper
   * than either the scratch or the per-segment fills it replaced.
   */
  ctx.globalAlpha = maxAlpha;
  ctx.beginPath();
  addRibbonSubpaths(ctx, left, right);
  addHardExtras(ctx);
  ctx.fill();

  stampBlotDiscs(ctx, prepared, pixelScale, blotBlend, maxAlpha);
  ctx.globalAlpha = 1;
}

/** Nib stamps per unit at Speed blot 0+ and at 100%, as multiples of half-width. */
const BLOT_STAMP_SPACING_SPARSE = 3.2;
const BLOT_STAMP_SPACING_DENSE = 0.6;
/** Ceiling on stamps for one paint, so a long stroke cannot stall the pen. */
const BLOT_STAMP_MAX = 400;

/**
 * Speed blot: interleaved nib stamps along the stroke, one fill each.
 *
 * This is the graphite. A pencil is not a flat ribbon, it is the same nib laid
 * down over and over, and where those stamps overlap the ink builds up denser
 * than where they do not -- the cross-hatched, grainy look. That build-up is
 * why they are stamped individually instead of joining the ribbon's path: one
 * path resolves overlap by winding and paints a single flat coverage, which is
 * right for ink and wrong for pencil. It follows that the texture only shows
 * once the stroke is not already opaque, which is why blot reads as a pencil
 * in company with Speed fade or pressure and as a slight thickening on its own.
 *
 * The dial is the stamp spacing, so 5% is a sparse trail and 100% is a
 * continuous pool. Nothing here consults Speed ink: blot is a standalone
 * texture that any pen may switch on.
 */
function stampBlotDiscs(
  ctx: CanvasRenderingContext2D,
  prepared: { points: ScenePoint[]; styles: InkStrokeStyle[] },
  pixelScale: number,
  blend: number,
  alpha: number,
): void {
  if (blend <= 1e-3) return;
  const amount = clamp01(blend);
  const points = prepared.points;
  if (points.length < 2) return;

  const spacingFrac =
    BLOT_STAMP_SPACING_SPARSE -
    (BLOT_STAMP_SPACING_SPARSE - BLOT_STAMP_SPACING_DENSE) * amount;

  ctx.globalAlpha = alpha;
  let carried = Infinity;
  let stamped = 0;
  for (let index = 0; index < points.length && stamped < BLOT_STAMP_MAX; index++) {
    if (index > 0) {
      carried += Math.hypot(
        points[index].x - points[index - 1].x,
        points[index].y - points[index - 1].y,
      );
    }
    const half = paintedWidth(prepared.styles[index].lineWidth, pixelScale) / 2;
    if (half < 1e-6) continue;
    if (carried < half * spacingFrac) continue;
    carried = 0;
    stamped++;
    ctx.beginPath();
    ctx.arc(points[index].x, points[index].y, half, 0, Math.PI * 2);
    ctx.fill();
  }
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
  const bodyAccent = resolveSpeedBodyAccent(op);
  const boldness = op.highlight ? 1 : resolveInkBoldness(op);
  const widthQuantum = nibWidth(op) * RUN_WIDTH_QUANTUM;
  // Only paid for when the stroke actually carries speed: without it every
  // point is neutral and the filter would return the constant it started with.
  const slowness = speedInk > 0 ? slopedSlowness(op) : null;

  const styleAt = (index: number) =>
    inkStrokeStyle(
      op.baseWidth,
      maxFullness,
      points[index].pressure,
      pressureClip,
      op.pressureSensitive,
      consumed[index] ?? 0,
      slowness ? slowness[index] : (points[index].slowness ?? INK_SLOWNESS_NEUTRAL),
      speedInk,
      op.highlight === true,
      boldness,
      resolveSpeedFade(op),
      bodyAccent,
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

/** Add a full disc as one subpath — no fill, same winding as the ribbon. */
function addDiscSubpath(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  center: { x: number; y: number },
  radius: number,
): void {
  if (radius < 1e-6) return;
  ctx.moveTo(center.x + radius, center.y);
  ctx.arc(center.x, center.y, radius, 0, Math.PI * 2);
  ctx.closePath();
}

/** Add a half-disc terminal cap as one subpath — no fill. */
function addTerminalCapSubpath(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  at: { x: number; y: number },
  outwardAngle: number,
  radius: number,
): void {
  if (radius < 1e-6) return;
  ctx.moveTo(at.x, at.y);
  ctx.arc(at.x, at.y, radius, outwardAngle - Math.PI / 2, outwardAngle + Math.PI / 2);
  ctx.closePath();
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
  capHead = true,
): void {
  const points = op.points;
  if (points.length === 0) return;

  ctx.globalCompositeOperation = "source-over";
  ctx.strokeStyle = op.color;
  ctx.fillStyle = op.color;
  /*
   * A highlighter multiplies; a pen paints over.
   *
   * Multiply is what makes it read as a marker rather than as a translucent
   * pen: writing already on the page stays legible through it, and two passes
   * over the same words darken toward the colour instead of stacking toward
   * opaque. It also means the op order in the tile cache does not have to be
   * disturbed — a highlight laid over existing ink looks like a highlight over
   * ink either way, which is why this is a blend mode rather than a second
   * z-band the incremental tile append would have to learn about.
   */
  if (op.highlight) ctx.globalCompositeOperation = "multiply";

  // A tap is a dot — dotting an "i" used to draw nothing at all.
  if (points.length === 1) {
    if (fromIndex > 0) return;
    const boldness = op.highlight ? 1 : resolveInkBoldness(op);
    const style = inkStrokeStyle(
      op.baseWidth,
      op.maxFullness ?? 1,
      points[0].pressure,
      op.pressureClip ?? 1,
      op.pressureSensitive,
      0,
      points[0].slowness ?? INK_SLOWNESS_NEUTRAL,
      op.speedInk ?? 0,
      op.highlight === true,
      boldness,
      resolveSpeedFade(op),
      resolveSpeedBodyAccent(op),
    );
    if (usesSpeedRibbon(op) && resolveSpeedBlotBlend(op) > 1e-3) {
      const blotBlend = resolveSpeedBlotBlend(op);
      const tipR = paintedWidth(style.lineWidth, pixelScale) / 2;
      const growT = dwellBlotGrowT(points, tipR, blotBlend);
      paintInkDisc(
        ctx,
        points[0],
        style.lineWidth,
        style.alpha,
        pixelScale,
        blotBlend,
        op.color,
        false,
        growT,
      );
    } else {
      ctx.globalAlpha = style.alpha;
      ctx.beginPath();
      ctx.arc(points[0].x, points[0].y, paintedWidth(style.lineWidth, pixelScale) / 2, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    return;
  }

  const start = Math.max(0, fromIndex);
  if (start >= points.length - 1) return;

  const nib = nibWidth(op);
  const slice = points.slice(start);
  const blotBlend = resolveSpeedBlotBlend(op);
  if (blotBlend > 1e-3 && isDiscPrimaryPath(slice, nib)) {
    const tip = points[points.length - 1];
    const styles = inkStrokePointStyles(op, start);
    let maxWidth = 0;
    let maxAlpha = 0;
    for (const style of styles) {
      maxWidth = Math.max(maxWidth, style.lineWidth);
      maxAlpha = Math.max(maxAlpha, style.alpha);
    }
    const tipR = paintedWidth(maxWidth, pixelScale) / 2;
    const growT = dwellBlotGrowT(slice, tipR, blotBlend);
    paintInkDisc(
      ctx,
      tip,
      maxWidth,
      maxAlpha,
      pixelScale,
      blotBlend,
      op.color,
      false,
      growT,
    );
    ctx.globalAlpha = 1;
    return;
  }

  if (usesSpeedRibbon(op)) {
    drawRibbonStrokeFrom(ctx, op, start, pixelScale, capEnd, capHead);
    return;
  }

  const runs = inkStrokeRuns(op, start);
  if (runs.length === 0) return;

  // Butt caps + bevel joins — round joins fan into spokes on thick curves.
  ctx.lineCap = "butt";
  ctx.lineJoin = "bevel";
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

    if (capHead && fromIndex === 0 && ri === 0) {
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
export type ApplyInkOptions = { capEnd?: boolean; capHead?: boolean };

export function applyInkOp(
  ctx: CanvasRenderingContext2D,
  op: InkOp,
  pixelScale = 0,
  options?: ApplyInkOptions,
): void {
  const capEnd = options?.capEnd ?? true;
  const capHead = options?.capHead ?? true;
  if (op.kind === "draw") drawStrokeFrom(ctx, op, 0, pixelScale, capEnd, capHead);
  else eraseStampsFrom(ctx, op, 0);
  ctx.globalCompositeOperation = "source-over";
}

/**
 * Paint one op clipped to a host and shifted for `scrollLeft` drift.
 *
 * Used by the second pass in {@link paintHostBoundOps} and for live ink
 * inside a scrolling code block.
 */
export function applyInkOpInHost(
  ctx: CanvasRenderingContext2D,
  op: InkOp,
  hostBounds: SceneBounds,
  scrollDx: number,
  pixelScale = 0,
  options?: ApplyInkOptions,
): void {
  ctx.save();
  ctx.beginPath();
  ctx.rect(
    hostBounds.minX,
    hostBounds.minY,
    hostBounds.maxX - hostBounds.minX,
    hostBounds.maxY - hostBounds.minY,
  );
  ctx.clip();
  if (scrollDx !== 0) ctx.translate(scrollDx, 0);
  applyInkOp(ctx, op, pixelScale, options);
  ctx.restore();
}

/** Map from `hostKey` to live scroll state at paint time. */
export type ScrollHostLookup = ReadonlyMap<
  number,
  { bounds: SceneBounds; scrollLeft: number }
>;

/**
 * Second paint pass for ops bound to nested horizontal scroll hosts.
 *
 * Page-bound ops are already in the tile cache; host-bound ones cannot be
 * baked there because their screen position moves when `scrollLeft` changes.
 */
export function paintHostBoundOps(
  ctx: CanvasRenderingContext2D,
  ops: readonly InkOp[],
  hosts: ScrollHostLookup,
  pixelScale: number,
  options?: ApplyInkOptions,
  /** CSS pixels per scene unit (camera zoom). Default 1 for export / tests. */
  zoom = 1,
): void {
  for (const op of ops) {
    if (!isHostBoundOp(op)) continue;
    const host = hosts.get(op.hostKey!);
    if (!host) {
      applyInkOp(ctx, op, pixelScale, options);
      continue;
    }
    applyInkOpInHost(
      ctx,
      op,
      host.bounds,
      hostScrollDx(op, host.scrollLeft, zoom),
      pixelScale,
      options,
    );
  }
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
    if (isHostBoundOp(op)) continue;
    applyInkOp(ctx, op, pixelScale);
  }

  if (liveOp && !isHostBoundOp(liveOp)) {
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
    const boldness = op.highlight ? 1 : resolveInkBoldness(op);
    const bodyAccent = resolveSpeedBodyAccent(op);
    const rest = inkStrokeStyle(
      op.baseWidth,
      maxFullness,
      1,
      pressureClip,
      op.pressureSensitive,
      0,
      1,
      op.speedInk ?? 0,
      op.highlight === true,
      boldness,
      0,
      bodyAccent,
    );
    const midSlow = inkStrokeStyle(
      op.baseWidth,
      maxFullness,
      1,
      pressureClip,
      op.pressureSensitive,
      0,
      0.75,
      op.speedInk ?? 0,
      op.highlight === true,
      boldness,
      0,
      bodyAccent,
    );
    const half = Math.max(rest.lineWidth, midSlow.lineWidth) / 2;
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
 *
 * Host-bound ops are skipped unless `hosts` is provided — then they get the
 * same clip+translate second pass as the live overlay.
 */
export function paintInkAtScale(
  ctx: CanvasRenderingContext2D,
  ops: readonly InkOp[],
  origin: { x: number; y: number },
  scale: number,
  hosts?: ScrollHostLookup | null,
  /** CSS px per scene unit for {@link hostScrollDx}; usually slot scale ≈ zoom. */
  hostZoom = 1,
): void {
  ctx.setTransform(scale, 0, 0, scale, -origin.x * scale, -origin.y * scale);
  // Chronological order: a pen stroke drawn *after* an erase must survive.
  // Applying every erase after every draw punched holes through later ink.
  for (const op of ops) {
    if (isHostBoundOp(op)) continue;
    if (op.kind === "draw") drawStrokeFrom(ctx, op, 0, scale);
    else eraseStampsFrom(ctx, op, 0);
  }
  if (hosts && hosts.size > 0) {
    paintHostBoundOps(ctx, ops, hosts, scale, undefined, hostZoom);
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
