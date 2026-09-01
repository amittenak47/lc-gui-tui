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
/**
 * Below this, a drying / pooling ribbon is a hairline: use `stroke()` like
 * the pen. Width-only Speed ink already uses `stroke()` at every nib size.
 */
export const INK_RIBBON_MIN_DEVICE_PX = 2.5;

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
/** Wash at ordinary writing pace when Ink Drying is 100%. Higher = stays wetter. */
export const INK_SPEED_ALPHA_BASE = 0.78;
/** How far a flick may pull the wash below {@link INK_SPEED_ALPHA_BASE}. */
export const INK_SPEED_ALPHA_RANGE = 0.22;
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

/** Multiplier either side of 1: above when the nib drags, below when it flicks. */
function speedGain(slowness: number, strength: number, range: number): number {
  const amount = Math.max(0, Math.min(1, strength));
  if (amount <= 0) return 1;
  return 1 + range * amount * inkSpeedPaceUnit(slowness);
}

export function inkSpeedWidthGain(slowness: number, strength: number): number {
  return Math.max(
    INK_SPEED_MIN_WIDTH_GAIN,
    speedGain(slowness, strength, INK_SPEED_WIDTH_RANGE),
  );
}

export function inkSpeedAlphaGain(slowness: number, _strength: number, fade = 0): number {
  const fadeAmt = Math.max(0, Math.min(1, fade));
  if (fadeAmt <= 0) return 1;
  const unit = inkSpeedPaceUnit(slowness);
  // Standstill stays wet (pooling can darken). Wash only while the nib moves.
  const paced =
    unit >= 0
      ? INK_SPEED_ALPHA_BASE + (1 - INK_SPEED_ALPHA_BASE) * unit
      : INK_SPEED_ALPHA_BASE * speedGain(slowness, 1, INK_SPEED_ALPHA_RANGE);
  return 1 + (paced - 1) * fadeAmt;
}

/**
 * Pooling is a richer deposit of the same ink: more chroma, more coverage,
 * and lower luminance. Alpha lift alone is a no-op on an already-opaque trail,
 * so the disc has to actually paint darker RGB or the ends read as a pale halo.
 */
export const INK_BLOT_ALPHA_LIFT = 0.55;
/** Pushed ~20% on chroma so a full pool is richer; unpooled colour is unchanged. */
export const INK_BLOT_SATURATE = 0.504;
export const INK_BLOT_DARKEN = 0.31;
/** Caps read richer than the trail even before a hold grows them. */
export const INK_BLOT_END_FLOOR = 0.45;
/** How far a full pool may grow past the nib. Independent of speed ink. */
export const INK_BLOT_SIZE_RANGE = 0.55;
/** Screen pixels of travel that still counts as a hold (stylus jitter). */
export const INK_HOLD_STILL_PX = 2.25;

export function inkBlotPoolT(growT: number, blotBlend: number): number {
  return clamp01(blotBlend) * clamp01(growT);
}

/** Rest half of pace: 0 at ordinary/fast, 1 stopped. */
export function inkBlotRestPoolT(slowness: number, blotBlend: number): number {
  return clamp01(blotBlend) * Math.max(0, inkSpeedPaceUnit(slowness));
}

/**
 * Coverage + rest-pace + a floor so endpoints are a denser deposit, not a
 * paler disc hanging off the butt.
 */
export function blotDiscPoolT(
  growT: number,
  blotBlend: number,
  slowness = INK_SLOWNESS_NEUTRAL,
): number {
  const blend = clamp01(blotBlend);
  if (blend < 1e-3) return 0;
  return Math.max(
    inkBlotPoolT(growT, blend),
    inkBlotRestPoolT(slowness, blend),
    blend * INK_BLOT_END_FLOOR,
  );
}

/**
 * Pooling richness including stylus pressure. A dead stop uses the same
 * pressure scale as a moving stroke's opacity: light touch stays closer to
 * the trail colour, a firm press reaches the full saturate/darken.
 */
export function blotRichnessT(
  growT: number,
  blotBlend: number,
  slowness = INK_SLOWNESS_NEUTRAL,
  pressureAmt = 1,
): number {
  return blotDiscPoolT(growT, blotBlend, slowness) * clamp01(pressureAmt);
}

export function mixBlotAlpha(alpha: number, poolT: number): number {
  const a = Math.max(0, Math.min(1, alpha));
  const t = clamp01(poolT);
  if (t <= 0) return a;
  return a + (1 - a) * INK_BLOT_ALPHA_LIFT * t;
}

export function blotPoolRgb(
  color: string,
  poolT: number,
): { r: number; g: number; b: number } {
  const rgb = inkColorRgb(color);
  const t = clamp01(poolT);
  if (t <= 0) return rgb;
  const mean = (rgb.r + rgb.g + rgb.b) / 3;
  const k = INK_BLOT_SATURATE * t;
  const dark = 1 - INK_BLOT_DARKEN * t;
  return {
    r: Math.max(0, Math.min(255, (rgb.r + (rgb.r - mean) * k) * dark)),
    g: Math.max(0, Math.min(255, (rgb.g + (rgb.g - mean) * k) * dark)),
    b: Math.max(0, Math.min(255, (rgb.b + (rgb.b - mean) * k) * dark)),
  };
}

function rgbCss(r: number, g: number, b: number): string {
  return `rgb(${r.toFixed(2)}, ${g.toFixed(2)}, ${b.toFixed(2)})`;
}

function blotFillCss(color: string, poolT: number): string {
  const { r, g, b } = blotPoolRgb(color, poolT);
  return rgbCss(r, g, b);
}

/** Mix ink toward paper so a wash reads as fading without a second alpha blit. */
export function dryWashRgb(
  color: string,
  gain: number,
): { r: number; g: number; b: number } {
  const rgb = inkColorRgb(color);
  const g = clamp01(gain);
  if (g >= 1 - 1e-6) return rgb;
  const paper = 245;
  return {
    r: rgb.r * g + paper * (1 - g),
    g: rgb.g * g + paper * (1 - g),
    b: rgb.b * g + paper * (1 - g),
  };
}

function ribbonVertexFillCss(color: string, style: InkStrokeStyle): string {
  const washed = dryWashRgb(color, style.dryGain ?? 1);
  const washedCss = rgbCss(washed.r, washed.g, washed.b);
  const poolT = style.blotPool ?? 0;
  if (poolT < 1e-3) return washedCss;
  return blotFillCss(washedCss, poolT);
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

/** A pooling stamp left where the nib halted, then moved on. */
export interface InkBlotHalt {
  x: number;
  y: number;
  /** 0–1, same units as {@link InkDrawOp.blotTipGrow}. */
  grow: number;
  pressure?: number;
  slowness?: number;
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
   * Hold-to-pool past the nib (0–1). Stamped at draw time.
   * 0 = stay nib-sized. Absent on older strokes → paint uses device pref.
   */
  speedBlotBlend?: number;
  /**
   * How far the current tip pooled during a hold (0–1). Stamped at lift so
   * smoothing can drop extra dwell samples without losing the pool size.
   * Mid-stroke holds that you leave without lifting go in {@link blotHalts}.
   */
  blotTipGrow?: number;
  /**
   * Holds left behind when the nib pools, then moves on. Painted as a ribbon
   * width flare, not a separate disc, so the pool stays continuous with the stroke.
   */
  blotHalts?: InkBlotHalt[];
  /**
   * How much pace washes color toward paper (0–1). Stamped at draw time.
   * Absent on older speed-ink strokes → full wash ({@link INK_SPEED_ALPHA_BASE}).
   */
  speedFade?: number;
  /**
   * Nib material (0–1). Stamped at draw time. Absent → hard disc (not the
   * live Grain dial — replay must not pick up a later setting).
   */
  grain?: number;
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
): number {
  const base = Math.max(INK_TIP_FLOOR, INK_TIP_MIN + (baseWidth - 1) * INK_TIP_STEP);
  return base * inkSpeedWidthGain(slowness, speedInk);
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
  _blotBlend = 0,
): number {
  void _blotBlend;
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
  /** 0–1 halt pooling. Saturates fill. Not applied along a moving trail. */
  blotPool?: number;
  /** 1 = wet, lower = Ink Drying wash. Baked into ribbon RGB so the blit can stay opaque. */
  dryGain?: number;
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
  _blotBlend = 0,
): InkStrokeStyle {
  void _blotBlend;
  // A chisel has one width and one wetness — no reservoir, no pressure, no pace.
  if (highlight) {
    return {
      lineWidth: inkLineWidth(baseWidth, 0, false) * HIGHLIGHT_WIDTH_SCALE,
      alpha: HIGHLIGHT_ALPHA,
    };
  }
  const stylus = pressureSensitive && hasStylusPressure(pressure);
  const pNorm = stylus ? normalizePressure(pressure, pressureClip) : 0;
  const dryGain = inkSpeedAlphaGain(slowness, speedInk, fade);
  return {
    lineWidth: inkLineWidth(baseWidth, pNorm, stylus, slowness, speedInk),
    alpha: inkStrokeAlpha(
      maxFullness,
      pNorm,
      stylus,
      consumed,
      slowness,
      speedInk,
      boldness,
      0,
      0,
    ),
    ...(dryGain < 1 - 1e-3 ? { dryGain } : {}),
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
  const boldness = op.highlight ? 1 : resolveInkBoldness(op);
  const blotBlend = op.highlight ? 0 : resolveSpeedBlotBlend(op);
  const fadeAmt = resolveSpeedFade(op);
  const slowness =
    speedInk > 0 || blotBlend > 1e-3 || fadeAmt > 1e-3 ? slopedSlowness(op) : null;

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
        blotBlend,
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
/** Insert midpoints when a chord exceeds ~0.28× average half-width. */
const RIBBON_DENSIFY_HALF_FRAC = 0.28;
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
  const blotPool =
    (a.blotPool ?? 0) + ((b.blotPool ?? 0) - (a.blotPool ?? 0)) * t;
  const dryGain =
    (a.dryGain ?? 1) + ((b.dryGain ?? 1) - (a.dryGain ?? 1)) * t;
  return {
    lineWidth: a.lineWidth + (b.lineWidth - a.lineWidth) * t,
    alpha: a.alpha + (b.alpha - a.alpha) * t,
    ...(blotPool > 1e-3 ? { blotPool } : {}),
    ...(dryGain < 1 - 1e-3 ? { dryGain } : {}),
  };
}

function ribbonWashJump(a: InkStrokeStyle, b: InkStrokeStyle): number {
  return (
    Math.abs((a.dryGain ?? 1) - (b.dryGain ?? 1)) +
    Math.abs((a.blotPool ?? 0) - (b.blotPool ?? 0))
  );
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
  const mixed = lerpInkStyle(keptStyle, nextStyle, 0.5);
  const style: InkStrokeStyle = {
    ...mixed,
    lineWidth: Math.max(keptStyle.lineWidth, nextStyle.lineWidth),
    alpha: Math.max(keptStyle.alpha, nextStyle.alpha),
  };
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
    if (
      Math.hypot(cur.x - prev.x, cur.y - prev.y) < minDist &&
      ribbonWashJump(prevStyle, curStyle) < 0.03
    ) {
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
  if (
    Math.hypot(last.x - prev.x, last.y - prev.y) < minDist &&
    ribbonWashJump(prevStyle, lastStyle) < 0.03
  ) {
    const merged = mergeRibbonVertex(prev, prevStyle, last, lastStyle);
    outPts[outPts.length - 1] = { ...last, slowness: merged.point.slowness };
    outStyles[outStyles.length - 1] = merged.style;
  } else {
    outPts.push(last);
    outStyles.push(lastStyle);
  }
  return { points: outPts, styles: outStyles };
}

/**
 * Insert midpoints on long chords so thick ribbons do not show one-facet spokes.
 *
 * Colour is not densified here. `fillInkRibbonQuads` already paints a linear
 * gradient between adjacent vertex fills at draw time. Inserting wash samples
 * rebuilt the whole polyline on every 32ms dwell tick and the stroke jigged.
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
    const count = dist > maxStep ? Math.ceil(dist / maxStep) : 1;
    if (count > 1) {
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

/** Pull adjacent quads over their shared edge so aliased fills do not show paper. */
const RIBBON_QUAD_OVERLAP = 1.25;

function offsetAlong(
  a: { x: number; y: number },
  b: { x: number; y: number },
  pad: number,
): { x: number; y: number } {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return { x: 0, y: 0 };
  return { x: (dx / len) * pad, y: (dy / len) * pad };
}

function fillInkRibbonQuads(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  left: readonly { x: number; y: number }[],
  right: readonly { x: number; y: number }[],
  fills?: readonly string[],
): void {
  if (left.length < 2 || left.length !== right.length) return;
  const prevFill = ctx.fillStyle;
  // A wash must not underlay the whole ribbon in fills[0]. Mid-tile clips
  // then show the stroke-start color against the local gradient: a hard cut
  // on the tile grid. Solid ribbons still get the silhouette so shared quad
  // edges do not leave parchment hairlines.
  if (!fills) {
    ctx.beginPath();
    ctx.moveTo(left[0].x, left[0].y);
    for (let index = 1; index < left.length; index++) {
      ctx.lineTo(left[index].x, left[index].y);
    }
    for (let index = right.length - 1; index >= 0; index--) {
      ctx.lineTo(right[index].x, right[index].y);
    }
    ctx.closePath();
    ctx.fill();
  }

  const canGrad =
    typeof (ctx as CanvasRenderingContext2D).createLinearGradient === "function";
  for (let index = 0; index < left.length - 1; index++) {
    const a = fills?.[index];
    const b = fills?.[index + 1] ?? a;
    // Adjacent vertices almost always differ once RGB is unrounded. A solid
    // fill here is what turns the wash into trapezoid facets.
    if (a && b && canGrad && a !== b) {
      const g = (ctx as CanvasRenderingContext2D).createLinearGradient(
        (left[index].x + right[index].x) / 2,
        (left[index].y + right[index].y) / 2,
        (left[index + 1].x + right[index + 1].x) / 2,
        (left[index + 1].y + right[index + 1].y) / 2,
      );
      g.addColorStop(0, a);
      g.addColorStop(1, b);
      ctx.fillStyle = g;
    } else if (a) {
      ctx.fillStyle = a;
    }
    const dL = offsetAlong(left[index], left[index + 1], RIBBON_QUAD_OVERLAP);
    const dR = offsetAlong(right[index], right[index + 1], RIBBON_QUAD_OVERLAP);
    ctx.beginPath();
    ctx.moveTo(left[index].x - dL.x, left[index].y - dL.y);
    ctx.lineTo(left[index + 1].x + dL.x, left[index + 1].y + dL.y);
    ctx.lineTo(right[index + 1].x + dR.x, right[index + 1].y + dR.y);
    ctx.lineTo(right[index].x - dR.x, right[index].y - dR.y);
    ctx.closePath();
    ctx.fill();
  }
  if (fills) ctx.fillStyle = prevFill;
}

function ribbonSideBounds(
  left: readonly { x: number; y: number }[],
  right: readonly { x: number; y: number }[],
): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const absorb = (p: { x: number; y: number }) => {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  };
  for (const p of left) absorb(p);
  for (const p of right) absorb(p);
  return { minX, minY, maxX, maxY };
}

type RibbonScratch = HTMLCanvasElement | OffscreenCanvas;

let ribbonScratch: RibbonScratch | null = null;

function createRibbonScratch(width: number, height: number): RibbonScratch | null {
  const w = Math.max(1, Math.ceil(width));
  const h = Math.max(1, Math.ceil(height));
  try {
    if (typeof OffscreenCanvas !== "undefined") {
      return new OffscreenCanvas(w, h);
    }
    if (typeof document !== "undefined" && document.createElement) {
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      return canvas;
    }
  } catch {
    /* jsdom / restricted contexts */
  }
  return null;
}

function acquireRibbonScratch(width: number, height: number): RibbonScratch | null {
  const w = Math.max(1, Math.ceil(width));
  const h = Math.max(1, Math.ceil(height));
  if (
    ribbonScratch &&
    ribbonScratch.width >= w &&
    ribbonScratch.height >= h
  ) {
    return ribbonScratch;
  }
  const nextW = Math.max(w, ribbonScratch?.width ?? 0);
  const nextH = Math.max(h, ribbonScratch?.height ?? 0);
  const created = createRibbonScratch(nextW, nextH);
  if (!created) return null;
  ribbonScratch = created;
  return ribbonScratch;
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
  fills?: readonly string[],
  pixelScale = 0,
): void {
  if (left.length === 0 || left.length !== right.length) return;
  if (left.length === 1) {
    const radius = Math.hypot(left[0].x - right[0].x, left[0].y - right[0].y) / 2;
    const prevFill = ctx.fillStyle;
    if (fills?.[0]) ctx.fillStyle = fills[0];
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
    ctx.fillStyle = prevFill;
    return;
  }

  const painted = paintOpaqueRibbonThenAlpha(
    ctx,
    left,
    right,
    alpha,
    undefined,
    4,
    fills,
    pixelScale,
  );
  if (painted) return;

  ctx.globalAlpha = alpha;
  fillInkRibbonQuads(ctx, left, right, fills);
}

/**
 * Opaque ribbon (+ optional join stamps in scene space) then one alpha blit.
 * Returns false when scratch/drawImage is unavailable (tests / odd hosts).
 */
/** Cap a hi-res wash scratch so a page-sized doodle cannot allocate a 16k canvas. */
const RIBBON_SCRATCH_MAX_PX = 8192;

function paintOpaqueRibbonThenAlpha(
  ctx: CanvasRenderingContext2D,
  left: readonly { x: number; y: number }[],
  right: readonly { x: number; y: number }[],
  alpha: number,
  stampJoins?: (
    scratch: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  ) => void,
  pad = 4,
  fills?: readonly string[],
  pixelScale = 0,
): boolean {
  if (typeof ctx.drawImage !== "function") return false;
  const { minX, minY, maxX, maxY } = ribbonSideBounds(left, right);
  if (!Number.isFinite(minX) || !Number.isFinite(maxX)) return false;
  const originX = Math.floor(minX - pad);
  const originY = Math.floor(minY - pad);
  const width = Math.ceil(maxX + pad) - originX;
  const height = Math.ceil(maxY + pad) - originY;
  if (width < 1 || height < 1) return false;

  // Gradients are rasterized on this scratch. One scene pixel per unit plus a
  // nearest-neighbour blit (zoom × dpr) turns a wash into trapezoid facets.
  const wantScale = fills && fills.length > 0 ? Math.max(1, pixelScale || 1) : 1;
  const scale = Math.min(
    wantScale,
    RIBBON_SCRATCH_MAX_PX / Math.max(width, 1),
    RIBBON_SCRATCH_MAX_PX / Math.max(height, 1),
  );
  const sw = Math.max(1, Math.ceil(width * scale));
  const sh = Math.max(1, Math.ceil(height * scale));
  const sx = sw / width;
  const sy = sh / height;

  const scratch = acquireRibbonScratch(sw, sh);
  if (!scratch) return false;
  const sctx = scratch.getContext("2d");
  if (!sctx) return false;

  sctx.setTransform(1, 0, 0, 1, 0, 0);
  // Full clear: a reused larger scratch leaves neighbour pixels, and a smoothed
  // blit samples them as a faint AABB around the stroke.
  sctx.clearRect(0, 0, scratch.width, scratch.height);
  sctx.imageSmoothingEnabled = false;
  sctx.globalAlpha = 1;
  sctx.fillStyle = ctx.fillStyle;
  sctx.setTransform(sx, 0, 0, sy, -originX * sx, -originY * sy);
  fillInkRibbonQuads(sctx, left, right, fills);
  if (stampJoins) stampJoins(sctx);

  const prevAlpha = ctx.globalAlpha;
  const prevSmooth = ctx.imageSmoothingEnabled;
  const destDevice = width * Math.max(pixelScale, 1);
  ctx.imageSmoothingEnabled = sw + 1e-3 < destDevice;
  ctx.globalAlpha = alpha;
  ctx.drawImage(
    scratch as CanvasImageSource,
    0,
    0,
    sw,
    sh,
    originX,
    originY,
    width,
    height,
  );
  ctx.globalAlpha = prevAlpha;
  ctx.imageSmoothingEnabled = prevSmooth;
  return true;
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

function sampleStrokeAt(
  points: readonly ScenePoint[],
  styles: readonly InkStrokeStyle[],
  dist: number,
  pixelScale: number,
  fallbackWidth: number,
): { x: number; y: number; r: number; nx: number; ny: number } | null {
  if (points.length === 0) return null;
  const radiusAt = (index: number) =>
    paintedWidth(styles[index]?.lineWidth ?? fallbackWidth, pixelScale) / 2;
  if (points.length === 1 || dist <= 0) {
    return { x: points[0].x, y: points[0].y, r: radiusAt(0), nx: 0, ny: 1 };
  }
  let walked = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const seg = Math.hypot(b.x - a.x, b.y - a.y);
    if (seg < 1e-8) continue;
    if (walked + seg >= dist || i === points.length - 1) {
      const t = Math.max(0, Math.min(1, (dist - walked) / seg));
      const tx = (b.x - a.x) / seg;
      const ty = (b.y - a.y) / seg;
      const ra = radiusAt(i - 1);
      const rb = radiusAt(i);
      return {
        x: a.x + (b.x - a.x) * t,
        y: a.y + (b.y - a.y) * t,
        r: ra + (rb - ra) * t,
        nx: -ty,
        ny: tx,
      };
    }
    walked += seg;
  }
  const last = points[points.length - 1];
  return { x: last.x, y: last.y, r: radiusAt(points.length - 1), nx: 0, ny: 1 };
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

/** Grain is stamped. Missing means a hard disc, never the live dial. */
function resolveGrain(op: InkDrawOp): number {
  if (op.grain === undefined) return 0;
  return clamp01(op.grain);
}

function blotPressureAmt(op: InkDrawOp, point: { pressure: number }): number {
  if (!op.pressureSensitive || !hasStylusPressure(point.pressure)) return 1;
  return clamp01(point.pressure);
}

/** Variable-width ribbon when Speed ink, Ink Drying, or Ink Pooling is on. */
function usesSpeedRibbon(op: InkDrawOp): boolean {
  if (op.highlight) return false;
  return (
    (op.speedInk ?? 0) > 0 ||
    resolveSpeedBlotBlend(op) > 1e-3 ||
    resolveSpeedFade(op) > 1e-3
  );
}

/**
 * Painted nib in device pixels. Unknown scale keeps the ribbon (Infinity).
 */
function ribbonDeviceWidth(op: InkDrawOp, pixelScale: number): number {
  if (pixelScale <= 0) return Infinity;
  return paintedWidth(nibWidth(op), pixelScale) * pixelScale;
}

function isHairlineRibbon(op: InkDrawOp, pixelScale: number): boolean {
  return ribbonDeviceWidth(op, pixelScale) < INK_RIBBON_MIN_DEVICE_PX;
}

/**
 * Paint with the pen's `stroke()` instead of a filled ribbon.
 *
 * Width-only Speed ink is a min-to-nib envelope. `stroke()` is that envelope
 * in the ink colour. A ribbon is a bitmap blit that reads gray next to it.
 * Drying and pooling still need the ribbon, except when the nib is a hairline.
 */
function usesSpeedPenStroke(op: InkDrawOp, pixelScale: number): boolean {
  if (!usesSpeedRibbon(op)) return false;
  if (isHairlineRibbon(op, pixelScale)) return true;
  return resolveSpeedFade(op) <= 1e-3 && resolveSpeedBlotBlend(op) <= 1e-3;
}

function resolveSpeedFade(op: InkDrawOp): number {
  if (op.speedFade !== undefined) return clamp01(op.speedFade);
  return (op.speedInk ?? 0) > 0 ? 1 : 0;
}

function resolveInkBoldness(op: InkDrawOp): number {
  if (op.boldness !== undefined) {
    return Math.min(INK_BOLDNESS_MAX, Math.max(INK_BOLDNESS_MIN, op.boldness));
  }
  return loadInkBoldness();
}

/** Tip-down dwell starts as the nib. Blot may grow a slow pool past it. */
const GRAIN_SALT = 47;
/** 1 device-px rim pad so a disc covers the ribbon AA fringe. */
const INK_DISC_SEAL_DEVICE_PX = 1;
/** Pull the disc this fraction of its radius into the stroke so the butt does not show paper. */
const INK_DISC_SEAL_INSET_FRAC = 0.12;

/**
 * Outer radius for a speed-blot disc.
 *
 * `growT` 0 is the nib. `growT` 1 with blot on grows by
 * {@link INK_BLOT_SIZE_RANGE} × blot × pressure — independent of speed ink,
 * and much slower than the speed-ink swell (see {@link blotTicksToFull}).
 */
export function inkDiscRadii(
  tipRadius: number,
  blotBlend = 0,
  growT = 1,
  pressureAmt = 1,
): { outerR: number; innerR: number } {
  const tip = Math.max(0, tipRadius);
  const extra =
    tip *
    INK_BLOT_SIZE_RANGE *
    clamp01(blotBlend) *
    clamp01(growT) *
    clamp01(pressureAmt);
  const outerR = tip + extra;
  return { outerR, innerR: outerR };
}

/** 1 device-px radius pad so the disc rim seals to the ribbon. */
export function discSealPad(tipRadius: number, pixelScale: number): number {
  void tipRadius;
  if (pixelScale <= 0) return 0;
  return INK_DISC_SEAL_DEVICE_PX / pixelScale;
}

function inkDiscPaintRadius(
  tipRadius: number,
  blotBlend: number,
  growT: number,
  pressureAmt: number,
  pixelScale: number,
): number {
  const { outerR } = inkDiscRadii(tipRadius, blotBlend, growT, pressureAmt);
  const pad =
    clamp01(blotBlend) > 1e-3 && clamp01(growT) > 1e-3
      ? discSealPad(outerR, pixelScale)
      : 0;
  return outerR + pad;
}

/** Pull a tip disc into the stroke so paper does not show at the butt. */
function sealDiscCenter<T extends { x: number; y: number }>(
  at: T,
  toward: { x: number; y: number } | undefined,
  radius: number,
  pixelScale: number,
): T {
  const pad = Math.max(discSealPad(radius, pixelScale), radius * INK_DISC_SEAL_INSET_FRAC);
  if (pad <= 0 || !toward) return at;
  const dx = toward.x - at.x;
  const dy = toward.y - at.y;
  const dist = Math.hypot(dx, dy);
  if (dist < 1e-6) return at;
  return { ...at, x: at.x + (dx / dist) * pad, y: at.y + (dy / dist) * pad };
}

/** Samples to reach full blot pool. ~1.5–3s at a 32ms tick — slower than speed ink. */
export function blotTicksToFull(blotBlend: number): number {
  return Math.max(48, Math.round(96 - 48 * clamp01(blotBlend)));
}

function easeOutBlotT(ticks: number, blotBlend: number): number {
  if (clamp01(blotBlend) < 1e-3) return 0;
  const t = clamp01(Math.max(0, ticks) / Math.max(1, blotTicksToFull(blotBlend)));
  return 1 - (1 - t) * (1 - t);
}

/** Hold-tick growth. Independent of how many points smoothing kept. */
export function blotGrowTFromTicks(ticks: number, blotBlend: number): number {
  return easeOutBlotT(ticks, blotBlend);
}

/**
 * How far a near-stationary cluster has pooled past the nib.
 * First contact is 0 (nib-sized). Moving paths do not keep a leftover pool.
 * Runs with blot on even when speed ink is off.
 */
export function dwellBlotGrowT(
  points: readonly ScenePoint[],
  tipRadius: number,
  blotBlend: number,
): number {
  if (points.length <= 1) return 0;
  if (tipRadius < 1e-6) return 0;
  if (clamp01(blotBlend) < 1e-3) return 0;
  if (!isDiscPrimaryPath(points, tipRadius * 2)) return 0;
  return easeOutBlotT(points.length - 1, blotBlend);
}

function resolveBlotTipGrow(
  op: InkDrawOp,
  cluster: readonly ScenePoint[],
  tipRadius: number,
): number {
  const blend = resolveSpeedBlotBlend(op);
  const stamped = op.blotTipGrow !== undefined ? clamp01(op.blotTipGrow) : 0;
  return Math.max(stamped, dwellBlotGrowT(cluster, tipRadius, blend));
}

/** Nearby holds of the same pause collapse into one. Scene units. */
const BLOT_HALT_MERGE_SCENE = 0.75;

/**
 * Leave a pooling flare at `at` so a later move can zero {@link InkDrawOp.blotTipGrow}
 * without erasing the hold. Width is applied on the ribbon, not as a disc.
 */
export function stampInkBlotHalt(
  dest: { blotHalts?: InkBlotHalt[] },
  at: Pick<ScenePoint, "x" | "y"> & Partial<Pick<ScenePoint, "pressure" | "slowness">>,
  grow: number,
): void {
  const g = clamp01(grow);
  if (g < 1e-3) return;
  const list = dest.blotHalts ?? [];
  const last = list[list.length - 1];
  if (last && Math.hypot(last.x - at.x, last.y - at.y) < BLOT_HALT_MERGE_SCENE) {
    last.grow = Math.max(last.grow, g);
    if (typeof at.pressure === "number" && at.pressure > (last.pressure ?? -1)) {
      last.pressure = at.pressure;
    }
    if (at.slowness != null) last.slowness = at.slowness;
  } else {
    list.push({
      x: at.x,
      y: at.y,
      grow: g,
      ...(typeof at.pressure === "number" ? { pressure: at.pressure } : {}),
      ...(at.slowness != null ? { slowness: at.slowness } : {}),
    });
  }
  dest.blotHalts = list;
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
 * - `softFade` false (tip-down / short-path): hard disc matching the trail.
 *   `growT` only affects the wash. No radial halo.
 * - `softFade` true (ribbon joins): radial fade clamped to nib radius.
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
  pressureAmt = 1,
  dryGain = 1,
): void {
  const tipRadius = paintedWidth(lineWidth, pixelScale) / 2;
  if (tipRadius < 1e-6) return;
  const blend = clamp01(blotBlend);
  const sourceColor = color ?? String(ctx.fillStyle);
  const washed =
    dryGain < 1 - 1e-3 ? dryWashRgb(sourceColor, dryGain) : null;
  const fillColor = washed
    ? `rgb(${Math.round(washed.r)}, ${Math.round(washed.g)}, ${Math.round(washed.b)})`
    : sourceColor;

  if (!softFade || blend < 1e-3) {
    const outerR = inkDiscPaintRadius(
      tipRadius,
      softFade ? 0 : blend,
      growT,
      pressureAmt,
      pixelScale,
    );
    if (outerR < 1e-6) return;
    const slow =
      "slowness" in center && typeof (center as ScenePoint).slowness === "number"
        ? (center as ScenePoint).slowness ?? INK_SLOWNESS_NEUTRAL
        : INK_SLOWNESS_NEUTRAL;
    const poolT = softFade ? 0 : blotRichnessT(growT, blend, slow, pressureAmt);
    const prevFill = ctx.fillStyle;
    const prevSmooth = ctx.imageSmoothingEnabled;
    if (poolT > 1e-3) {
      ctx.fillStyle = blotFillCss(fillColor, poolT);
    } else if (fillColor !== String(prevFill)) {
      ctx.fillStyle = fillColor;
    }
    ctx.imageSmoothingEnabled = true;
    ctx.globalAlpha = mixBlotAlpha(alpha, poolT);
    ctx.beginPath();
    ctx.arc(center.x, center.y, outerR, 0, Math.PI * 2);
    ctx.fill();
    ctx.imageSmoothingEnabled = prevSmooth;
    ctx.fillStyle = prevFill;
    return;
  }

  const fadeRadius = tipRadius;
  const centerAlpha = alpha;
  const { r, g, b } = washed ?? inkColorRgb(fillColor);
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

/**
 * Fine paper-tooth fibres. `destination-out` at partial alpha so they read as
 * texture, not punched holes. Lengths stay short; heading stays near one
 * hashed direction so the field looks like laid paper, not a starburst.
 */
function paperFibreHeading(origin: { x: number; y: number }): number {
  return hash01(origin.x, origin.y, GRAIN_SALT + 11) * Math.PI;
}

function strokePaperFibre(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  radius: number,
  u: number,
  v: number,
  w: number,
  q: number,
  fibreHeading: number,
  minWidth = 0.2,
  lengthScale = 1,
): void {
  const ang = fibreHeading + (w - 0.5) * 0.48;
  const half = radius * (0.025 + 0.05 * q) * lengthScale;
  const dx = Math.cos(ang) * half;
  const dy = Math.sin(ang) * half;
  ctx.globalAlpha = 0.07 + 0.42 * v;
  ctx.lineWidth = Math.max(minWidth, radius * (0.008 + 0.016 * u));
  ctx.beginPath();
  ctx.moveTo(cx - dx, cy - dy);
  ctx.lineTo(cx + dx, cy + dy);
  ctx.stroke();
}

function scratchGrainInDisc(
  ctx: CanvasRenderingContext2D,
  center: { x: number; y: number },
  radius: number,
  grain: number,
): void {
  const g = clamp01(grain);
  if (g < 1e-3 || radius < 1e-6) return;
  const n = Math.round(1.4 * (10 + 28 * g));
  const fibreHeading = paperFibreHeading(center);
  const prevComp = ctx.globalCompositeOperation;
  const prevAlpha = ctx.globalAlpha;
  const prevStroke = ctx.strokeStyle;
  const prevWidth = ctx.lineWidth;
  const prevCap = ctx.lineCap;
  ctx.globalCompositeOperation = "destination-out";
  ctx.strokeStyle = "#000";
  ctx.lineCap = "butt";
  for (let i = 0; i < n; i++) {
    const u = hash01(center.x, center.y, GRAIN_SALT + i);
    const v = hash01(center.x, center.y, GRAIN_SALT + 19 + i);
    const w = hash01(center.x, center.y, GRAIN_SALT + 37 + i);
    const q = hash01(center.x, center.y, GRAIN_SALT + 53 + i);
    const rad = radius * 0.88 * Math.sqrt(u);
    const theta = v * Math.PI * 2;
    strokePaperFibre(
      ctx,
      center.x + Math.cos(theta) * rad,
      center.y + Math.sin(theta) * rad,
      radius,
      u,
      hash01(center.x, center.y, GRAIN_SALT + 71 + i),
      w,
      q,
      fibreHeading,
    );
  }
  ctx.globalCompositeOperation = prevComp;
  ctx.globalAlpha = prevAlpha;
  ctx.strokeStyle = prevStroke;
  ctx.lineWidth = prevWidth;
  ctx.lineCap = prevCap;
}

/**
 * Speed-ink / blot disc. Grain 0 is one hard circle. Grain > 0 scratches
 * fibre into that same circle without changing the fill colour.
 */
export function paintGrainDisc(
  ctx: CanvasRenderingContext2D,
  center: { x: number; y: number },
  tipRadius: number,
  grain: number,
  alpha: number,
  color?: string,
  blotBlend = 0,
  growT = 1,
  pressureAmt = 1,
): void {
  const { outerR } = inkDiscRadii(tipRadius, blotBlend, growT, pressureAmt);
  if (outerR < 1e-6) return;
  const poolT = blotRichnessT(growT, blotBlend, INK_SLOWNESS_NEUTRAL, pressureAmt);
  const prevFill = ctx.fillStyle;
  if (poolT > 1e-3) {
    ctx.fillStyle = blotFillCss(color ?? String(prevFill), poolT);
  } else if (color) {
    ctx.fillStyle = color;
  }
  ctx.globalAlpha = mixBlotAlpha(alpha, poolT);
  ctx.beginPath();
  ctx.arc(center.x, center.y, outerR, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = prevFill;
  if (clamp01(grain) > 1e-3) scratchGrainInDisc(ctx, center, outerR, grain);
  ctx.globalAlpha = 1;
}

function paintTexturedDisc(
  ctx: CanvasRenderingContext2D,
  op: InkDrawOp,
  center: ScenePoint,
  lineWidth: number,
  alpha: number,
  pixelScale: number,
  growT: number,
  dryGain = 1,
): void {
  const grain = resolveGrain(op);
  const blotBlend = resolveSpeedBlotBlend(op);
  const pressureAmt = blotPressureAmt(op, center);
  paintInkDisc(
    ctx,
    center,
    lineWidth,
    alpha,
    pixelScale,
    blotBlend,
    op.color,
    false,
    growT,
    pressureAmt,
    dryGain,
  );
  if (grain < 1e-3) return;
  const tipR = paintedWidth(lineWidth, pixelScale) / 2;
  const outerR = inkDiscPaintRadius(tipR, blotBlend, growT, pressureAmt, pixelScale);
  scratchGrainInDisc(ctx, center, outerR, grain);
}

function prefixContactCluster(
  points: readonly ScenePoint[],
  tipRadius: number,
): ScenePoint[] {
  if (points.length === 0) return [];
  const origin = points[0];
  const eps = Math.max(tipRadius * 0.25, 0.5);
  const cluster: ScenePoint[] = [];
  for (const point of points) {
    if (Math.hypot(point.x - origin.x, point.y - origin.y) > eps) break;
    cluster.push(point);
  }
  return cluster;
}

/** Width swell at a hold/endpoint from ink pooling (`growT` only — not rest-pace). */
export function inkPoolingWidthGain(
  growT: number,
  blotBlend: number,
  pressureAmt = 1,
): number {
  return 1 + INK_BLOT_SIZE_RANGE * clamp01(blotBlend) * clamp01(growT) * clamp01(pressureAmt);
}

/**
 * Hold the full pooled width under the round cap, then taper. A falloff that
 * starts shrinking immediately leaves the cap sitting on a thinner trail.
 */
function poolingEnvelope(
  nib: number,
  growT: number,
  blotBlend: number,
): { plateau: number; radius: number } {
  const plateau = (nib / 2) * inkPoolingWidthGain(growT, blotBlend, 1);
  return { plateau, radius: plateau + nib * (1.15 + INK_BLOT_SIZE_RANGE) };
}

function poolingFalloff(dist: number, radius: number, plateau: number): number {
  if (radius < 1e-6) return dist < 1e-6 ? 1 : 0;
  if (dist <= plateau) return 1;
  if (dist >= radius) return 0;
  const span = radius - plateau;
  if (span < 1e-6) return 1;
  const t = clamp01(1 - (dist - plateau) / span);
  return t * t;
}

function polylineArcLengths(points: readonly { x: number; y: number }[]): Float64Array {
  const s = new Float64Array(points.length);
  for (let i = 1; i < points.length; i++) {
    s[i] =
      s[i - 1] +
      Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  }
  return s;
}

function nearestPolylineIndex(
  points: readonly { x: number; y: number }[],
  at: { x: number; y: number },
): number {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < points.length; i++) {
    const d = Math.hypot(points[i].x - at.x, points[i].y - at.y);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/**
 * Widen + enrich ribbon vertices at holds and ends, with a falloff so the pool
 * is the stroke swelling, not a disc sitting on it.
 */
export function applyInkPoolingAtEnds(
  styles: InkStrokeStyle[],
  op: InkDrawOp,
  points: readonly ScenePoint[],
  fromIndex: number,
): InkStrokeStyle[] {
  if (op.highlight) return styles;
  const blotBlend = resolveSpeedBlotBlend(op);
  if (blotBlend < 1e-3 || styles.length === 0 || points.length === 0) return styles;

  const out = styles.map((style) => ({ ...style }));
  const strokePts = op.points;
  const nib = nibWidth(op);
  const growAt = new Float64Array(out.length);
  const richAt = new Float64Array(out.length);
  const arc = polylineArcLengths(points);

  const paintAlong = (
    at: { x: number; y: number },
    amount: number,
    target: Float64Array,
    plateau: number,
    radius: number,
  ) => {
    const g = clamp01(amount);
    if (g < 1e-6) return;
    const origin = nearestPolylineIndex(points, at);
    for (let index = 0; index < points.length; index++) {
      const dist = Math.abs(arc[index] - arc[origin]);
      const w = poolingFalloff(dist, radius, plateau) * g;
      if (w > target[index]) target[index] = w;
    }
  };

  const markGrow = (at: { x: number; y: number }, growT: number) => {
    const g = clamp01(growT);
    if (g < 1e-6) return;
    const { plateau, radius } = poolingEnvelope(nib, g, blotBlend);
    paintAlong(at, g, growAt, plateau, radius);
  };

  const lastIdx = out.length - 1;
  const tip = points[lastIdx];
  const tipR = out[lastIdx].lineWidth / 2;
  const tipStart = trailingTipClusterStart(strokePts, nib);
  const tipPts =
    tipStart < strokePts.length ? strokePts.slice(tipStart) : [strokePts[strokePts.length - 1]];
  markGrow(tip, resolveBlotTipGrow(op, tipPts, tipR));
  // Ends stay a richer deposit than the trail even without a hold. Width does not
  // grow from this floor — only blotTipGrow / halts fatten the ribbon.
  const endFloor = blotBlend * INK_BLOT_END_FLOOR;
  paintAlong(tip, endFloor, richAt, nib * 0.45, nib * 1.35);

  if (fromIndex === 0 && points.length >= 2) {
    const headR = out[0].lineWidth / 2;
    const cluster = prefixContactCluster(strokePts, headR);
    const headCluster = cluster.length > 0 ? cluster : [strokePts[0]];
    let headGrow = dwellBlotGrowT(headCluster, headR, blotBlend);
    const tipStillAtHead =
      Math.hypot(tip.x - points[0].x, tip.y - points[0].y) < Math.max(headR * 2, nib * 0.5);
    if (tipStillAtHead) {
      headGrow = Math.max(headGrow, resolveBlotTipGrow(op, headCluster, headR));
    }
    markGrow(points[0], headGrow);
    paintAlong(points[0], endFloor, richAt, nib * 0.45, nib * 1.35);
  }

  if (op.blotHalts) {
    for (const halt of op.blotHalts) {
      if (halt.grow < 1e-6) continue;
      markGrow(halt, halt.grow);
    }
  }

  for (let index = 0; index < out.length; index++) {
    const growT = growAt[index];
    const at = points[index];
    const slowness = at.slowness ?? INK_SLOWNESS_NEUTRAL;
    const pressureAmt = blotPressureAmt(op, at);
    let poolT = growT > 1e-6 ? blotRichnessT(growT, blotBlend, slowness, pressureAmt) : 0;
    if (richAt[index] > poolT) poolT = richAt[index] * clamp01(pressureAmt);
    if (poolT > 1e-6) out[index].blotPool = poolT;
    if (growT < 1e-6) continue;
    out[index].lineWidth *= inkPoolingWidthGain(growT, blotBlend, 1);
    // A hold is wet. Snapping dryGain off for every vertex in the envelope
    // left a washed trail next to a fully-wet plateau: discrete red blocks
    // when drying is also on. Lerp with growT so the falloff blends.
    const dry = out[index].dryGain ?? 1;
    const wet = dry + (1 - dry) * growT;
    if (wet < 1 - 1e-3) out[index].dryGain = wet;
    else delete out[index].dryGain;
  }

  return out;
}

/**
 * One heading-independent disc at the original contact.
 *
 * Used for a tap and for the contact cluster (jitter still inside about one
 * nib). Ink pooling may grow that same disc; Grain textures it.
 */
function paintContactDisc(
  ctx: CanvasRenderingContext2D,
  op: InkDrawOp,
  points: readonly ScenePoint[],
  pixelScale: number,
): void {
  const blotBlend = resolveSpeedBlotBlend(op);
  const grain = resolveGrain(op);
  const styles = inkStrokePointStyles(op, 0);
  const last = styles[styles.length - 1];
  if (!last) return;
  const contact = points[0];
  const radius = paintedWidth(last.lineWidth, pixelScale) / 2;
  const growT = resolveBlotTipGrow(op, points, radius);
  if (blotBlend > 1e-3 || grain > 1e-3) {
    paintTexturedDisc(
      ctx,
      op,
      contact,
      last.lineWidth,
      last.alpha,
      pixelScale,
      growT,
      growT > 1e-3 ? 1 : (last.dryGain ?? 1),
    );
  } else {
    ctx.globalAlpha = last.alpha;
    paintInkTerminalCap(ctx, contact, radius, 0, 1);
  }
  ctx.globalAlpha = 1;
}

function paintOpCap(
  ctx: CanvasRenderingContext2D,
  op: InkDrawOp,
  at: ScenePoint,
  radius: number,
  outward: number,
  origin: ScenePoint,
  salt: number,
  pressure: number,
  alpha: number,
): void {
  const prevAlpha = ctx.globalAlpha;
  ctx.globalAlpha = alpha;
  paintInkTerminalCap(
    ctx,
    at,
    radius,
    outward,
    inkCapRoundness(origin, salt, pressure, op.pressureSensitive),
  );
  ctx.globalAlpha = prevAlpha;
  const grain = resolveGrain(op);
  if (grain > 1e-3) scratchGrainInDisc(ctx, at, radius, grain);
}

function scratchGrainAlongStroke(
  ctx: CanvasRenderingContext2D,
  op: InkDrawOp,
  points: readonly ScenePoint[],
  styles: readonly InkStrokeStyle[],
  pixelScale: number,
): void {
  const grain = resolveGrain(op);
  if (grain < 1e-3 || points.length === 0) return;
  const pathLen = strokePathLength(points);
  const nib = nibWidth(op);
  if (pathLen < 1e-6) {
    const r = paintedWidth(styles[0]?.lineWidth ?? nib, pixelScale) / 2;
    scratchGrainInDisc(ctx, points[0], r, grain);
    return;
  }
  /*
   * Place fibres at a fixed spacing along the stroke, seeded by origin + index.
   * Sampling `u * pathLen` from the origin moved every fibre as the stroke
   * grew, so grain crawled to the tip and the already-written ink went smooth.
   *
   * One hairline per ~0.16 nib was too sparse to read on the ribbon (a compact
   * disc stamp packs ~50 fibres in one nib). Stamp a short across-ribbon cloud
   * at each station, thick enough to mark a scratch pixel, still dest-out.
   */
  const spacing = Math.max(nib * (0.10 + 0.05 * (1 - grain)), 0.32);
  const fibresAt = Math.max(2, Math.round(3 + 7 * grain));
  const n = Math.min(720, Math.max(1, Math.ceil(pathLen / spacing)));
  const origin = points[0];
  const fibreHeading = paperFibreHeading(origin);
  const prevComp = ctx.globalCompositeOperation;
  const prevAlpha = ctx.globalAlpha;
  const prevStroke = ctx.strokeStyle;
  const prevWidth = ctx.lineWidth;
  const prevCap = ctx.lineCap;
  ctx.globalCompositeOperation = "destination-out";
  ctx.strokeStyle = "#000";
  ctx.lineCap = "butt";
  const minWidth = Math.max(0.7, pixelScale > 0 ? 0.9 / pixelScale : 0.7);
  for (let i = 0; i < n; i++) {
    const jitter = hash01(origin.x, origin.y, GRAIN_SALT + i);
    const dist = (i + jitter * 0.35) * spacing;
    if (dist > pathLen) continue;
    const at = sampleStrokeAt(points, styles, dist, pixelScale, nib);
    if (!at || at.r < 1e-6) continue;
    for (let j = 0; j < fibresAt; j++) {
      const salt = GRAIN_SALT + i * 31 + j;
      const u = hash01(origin.x, origin.y, salt + 19);
      const v = hash01(origin.x, origin.y, salt + 37);
      const w = hash01(origin.x, origin.y, salt + 53);
      const q = hash01(origin.x, origin.y, salt + 71);
      const across = (v * 2 - 1) * at.r * 0.88;
      strokePaperFibre(
        ctx,
        at.x + at.nx * across,
        at.y + at.ny * across,
        at.r,
        u,
        hash01(origin.x, origin.y, salt + 89),
        w,
        q,
        fibreHeading,
        minWidth,
        1.55,
      );
    }
  }
  ctx.globalCompositeOperation = prevComp;
  ctx.globalAlpha = prevAlpha;
  ctx.strokeStyle = prevStroke;
  ctx.lineWidth = prevWidth;
  ctx.lineCap = prevCap;
}

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
    paintContactDisc(ctx, op, points, pixelScale);
    return;
  }

  const start = Math.max(0, Math.min(fromIndex, points.length - 2));
  if (start >= points.length - 1) return;

  const slice = points.slice(start);
  const styles = inkStrokePointStyles(op, start);
  if (slice.length < 2 || styles.length < 2) return;

  const nib = nibWidth(op);
  if (blotBlend > 1e-3 && isDiscPrimaryPath(slice, nib)) {
    const last = styles[styles.length - 1];
    if (!last) return;
    const tipR = paintedWidth(last.lineWidth, pixelScale) / 2;
    const growT = resolveBlotTipGrow(op, slice, tipR);
    const at = slice[slice.length - 1];
    const prev = slice.length > 1 ? slice[slice.length - 2] : undefined;
    paintTexturedDisc(
      ctx,
      op,
      sealDiscCenter(at, prev, tipR, pixelScale),
      last.lineWidth,
      last.alpha,
      pixelScale,
      growT,
      growT > 1e-3 ? 1 : (last.dryGain ?? 1),
    );
    ctx.globalAlpha = 1;
    return;
  }

  let ribbonPoints = slice;
  let ribbonStyles = styles;
  // Pooling needs the halted tip on the ribbon. Peeling a dwell cluster left
  // the pool as a nib-sized seal disc while Speed ink was off.
  const tipClusterAt =
    blotBlend > 1e-3 ? slice.length : trailingTipClusterStart(slice, nib);
  if (tipClusterAt < slice.length) {
    const tipPts = slice.slice(tipClusterAt);
    const tipStyles = styles.slice(tipClusterAt);
    const tipLast = tipStyles[tipStyles.length - 1];
    const tipWidth = tipLast?.lineWidth ?? 0;
    const tipAlpha = tipLast?.alpha ?? 1;
    const tipR = paintedWidth(tipWidth, pixelScale) / 2;
    ribbonPoints = slice.slice(0, tipClusterAt + 1);
    ribbonStyles = styles.slice(0, tipClusterAt + 1);
    if (ribbonPoints.length < 2) {
      const tipAt = tipPts[tipPts.length - 1];
      const tipPrev = tipPts.length > 1 ? tipPts[tipPts.length - 2] : undefined;
      paintTexturedDisc(
        ctx,
        op,
        sealDiscCenter(tipAt, tipPrev, tipR, pixelScale),
        tipWidth,
        tipAlpha,
        pixelScale,
        resolveBlotTipGrow(op, tipPts, tipR),
        tipLast?.dryGain ?? 1,
      );
      ctx.globalAlpha = 1;
      return;
    }
  }

  const coalesced = coalesceRibbonPoints(ribbonPoints, ribbonStyles, pixelScale);
  const densified = densifyRibbonPoints(coalesced.points, coalesced.styles, pixelScale);
  if (densified.points.length < 2) {
    ctx.globalAlpha = 1;
    return;
  }

  const pooledStyles = applyInkPoolingAtEnds(
    densified.styles,
    op,
    densified.points,
    fromIndex,
  );
  const prepared = densifyRibbonPoints(densified.points, pooledStyles, pixelScale);

  let maxAlpha = 0;
  let maxHalf = 0;
  for (const style of prepared.styles) {
    maxAlpha = Math.max(maxAlpha, style.alpha);
    maxHalf = Math.max(maxHalf, paintedWidth(style.lineWidth, pixelScale) / 2);
  }

  const { left, right } = ribbonSides(prepared.points, prepared.styles, pixelScale);
  const pad = Math.max(4, Math.ceil(maxHalf) + 2);
  const fadeAmt = resolveSpeedFade(op);
  const fills =
    blotBlend > 1e-3 || fadeAmt > 1e-3
      ? prepared.styles.map((style) => ribbonVertexFillCss(color, style))
      : undefined;

  const stampHardExtras = (
    scratch: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  ) => {
    const scratchCtx = scratch as CanvasRenderingContext2D;
    scratchCtx.fillStyle = color ?? String(ctx.fillStyle);
    scratchCtx.globalAlpha = 1;
    scratchGrainAlongStroke(
      scratchCtx,
      op,
      prepared.points,
      prepared.styles,
      pixelScale,
    );
    if (capHead && fromIndex === 0 && tipClusterAt >= slice.length) {
      const radius = paintedWidth(prepared.styles[0].lineWidth, pixelScale) / 2;
      const origin = points[0];
      if (fills?.[0]) scratchCtx.fillStyle = fills[0];
      const heading =
        firstStrokeOutward(prepared.points, radius) ??
        hashedHeading(origin, CAP_SALT_HEAD);
      paintOpCap(
        scratchCtx,
        op,
        prepared.points[0],
        radius,
        heading,
        origin,
        CAP_SALT_HEAD,
        origin.pressure,
        1,
      );
    }
    if (capEnd && tipClusterAt >= slice.length) {
      // Same round cap as speed ink, at the already-flared half-width. Do not
      // stamp a second pooling disc; the ribbon is the pool.
      const last = prepared.points.length - 1;
      const radius = paintedWidth(prepared.styles[last].lineWidth, pixelScale) / 2;
      const origin = points[0];
      const heading =
        segmentOutward(prepared.points[last], prepared.points[last - 1]) ??
        hashedHeading(origin, CAP_SALT_TAIL);
      if (fills?.[last]) scratchCtx.fillStyle = fills[last];
      paintOpCap(
        scratchCtx,
        op,
        prepared.points[last],
        radius,
        heading,
        origin,
        CAP_SALT_TAIL,
        prepared.points[last].pressure,
        1,
      );
    }
    if (tipClusterAt < slice.length && prepared.points.length >= 2) {
      const last = prepared.points.length - 1;
      paintInkDisc(
        scratchCtx,
        prepared.points[last],
        prepared.styles[last].lineWidth,
        1,
        pixelScale,
        0,
        color,
        false,
        1,
      );
    }
  };

  const stamped = paintOpaqueRibbonThenAlpha(
    ctx,
    left,
    right,
    maxAlpha,
    stampHardExtras,
    pad,
    fills,
    pixelScale,
  );

  if (!stamped) {
    fillInkRibbon(ctx, left, right, maxAlpha, fills, pixelScale);
    stampHardExtras(ctx);
  }

  ctx.globalAlpha = 1;
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
  const boldness = op.highlight ? 1 : resolveInkBoldness(op);
  const blotBlend = op.highlight ? 0 : resolveSpeedBlotBlend(op);
  const widthQuantum = nibWidth(op) * RUN_WIDTH_QUANTUM;
  const fadeAmt = resolveSpeedFade(op);
  // Only paid for when the stroke actually carries speed: without it every
  // point is neutral and the filter would return the constant it started with.
  const slowness =
    speedInk > 0 || blotBlend > 1e-3 || fadeAmt > 1e-3 ? slopedSlowness(op) : null;

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
      blotBlend,
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

const CAP_SALT_HEAD = 1;
const CAP_SALT_TAIL = 2;
/** Above this the cap is a circle; below it is a heading-aligned superellipse. */
const CAP_CIRCLE_ROUNDNESS = 0.82;

function hash01(x: number, y: number, salt: number): number {
  const qx = Math.round(x * 4);
  const qy = Math.round(y * 4);
  let h = 2166136261 ^ salt;
  h = Math.imul(h ^ qx, 16777619);
  h = Math.imul(h ^ qy, 16777619);
  h = Math.imul(h ^ (qx * 374761393 + qy * 668265263), 16777619);
  return (h >>> 0) / 4294967296;
}

/**
 * Endcap roundness in 0..1, seeded from the stroke origin so replay matches
 * and a moving tip does not flicker. 0 is nearly rectangular, 1 is a circle.
 * Hard stylus pressure pulls toward square.
 */
export function inkCapRoundness(
  origin: { x: number; y: number },
  salt: number,
  pressure = NO_PRESSURE,
  pressureSensitive = false,
): number {
  const u = hash01(origin.x, origin.y, salt);
  let round = 0.08 + 0.92 * u;
  if (pressureSensitive && hasStylusPressure(pressure)) {
    round *= 1 - 0.72 * clamp01(pressure);
    round = Math.max(0.06, round);
  }
  return round;
}

function capLocalToWorld(
  at: { x: number; y: number },
  outward: number,
  u: number,
  v: number,
): { x: number; y: number } {
  const c = Math.cos(outward);
  const s = Math.sin(outward);
  return { x: at.x + c * u - s * v, y: at.y + s * u + c * v };
}

function hashedHeading(origin: { x: number; y: number }, salt: number): number {
  return hash01(origin.x, origin.y, salt + 31) * Math.PI * 2;
}

function segmentOutward(
  at: { x: number; y: number },
  inner: { x: number; y: number },
): number | null {
  const dx = at.x - inner.x;
  const dy = at.y - inner.y;
  if (Math.hypot(dx, dy) < 1e-6) return null;
  return Math.atan2(dy, dx);
}

/** Outward along the first real step, not a hashed angle or a 1px jitter. */
function firstStrokeOutward(
  points: readonly { x: number; y: number }[],
  minDist: number,
): number | null {
  if (points.length < 2) return null;
  const origin = points[0];
  const min = Math.max(minDist, 1e-6);
  for (let i = 1; i < points.length; i++) {
    if (Math.hypot(points[i].x - origin.x, points[i].y - origin.y) >= min) {
      return segmentOutward(origin, points[i]);
    }
  }
  return segmentOutward(origin, points[1]);
}

/**
 * Stamp at a stroke end: circle when roundness is high, otherwise a
 * superellipse aligned to the heading — squarer at low roundness, still
 * overlapping the body so the butt does not show a paper hairline.
 */
export function paintInkTerminalCap(
  ctx: CanvasRenderingContext2D,
  at: { x: number; y: number },
  radius: number,
  outwardAngle: number,
  roundness: number,
): void {
  if (radius < 1e-6) return;
  const t = clamp01(roundness);
  if (t >= CAP_CIRCLE_ROUNDNESS) {
    ctx.beginPath();
    ctx.arc(at.x, at.y, radius, 0, Math.PI * 2);
    ctx.fill();
    return;
  }

  // n=2 is an ellipse; large n is a rectangle. Outward extent follows t so a
  // square cap does not bulge past the butt the way a circle does.
  const n = 2 + 14 * (1 - t) * (1 - t);
  const exp = 2 / n;
  const aOut = Math.max(radius * t, radius * 0.08);
  const aIn = radius;
  const samples = 32;
  ctx.beginPath();
  for (let i = 0; i < samples; i++) {
    const phi = (i / samples) * Math.PI * 2;
    const co = Math.cos(phi);
    const si = Math.sin(phi);
    const au = co >= 0 ? aOut : aIn;
    const u = au * Math.sign(co) * Math.pow(Math.abs(co), exp);
    const v = radius * Math.sign(si) * Math.pow(Math.abs(si), exp);
    const p = capLocalToWorld(at, outwardAngle, u, v);
    if (i === 0) ctx.moveTo(p.x, p.y);
    else ctx.lineTo(p.x, p.y);
  }
  ctx.closePath();
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
    );
    if (op.highlight) {
      ctx.globalAlpha = style.alpha;
      ctx.beginPath();
      ctx.arc(points[0].x, points[0].y, paintedWidth(style.lineWidth, pixelScale) / 2, 0, Math.PI * 2);
      ctx.fill();
    } else {
      paintContactDisc(ctx, op, points, pixelScale);
    }
    ctx.globalAlpha = 1;
    return;
  }

  const start = Math.max(0, fromIndex);
  if (start >= points.length - 1) return;

  const nib = nibWidth(op);
  const slice = points.slice(start);
  const blotBlend = resolveSpeedBlotBlend(op);
  // Contact cluster: one disc at the original point, including pressure-on
  // flat ink. Do not fan jitter into spokes or heading-flipped half-caps.
  if (!op.highlight && fromIndex === 0 && isDiscPrimaryPath(points, nib)) {
    paintContactDisc(ctx, op, points, pixelScale);
    return;
  }
  if (blotBlend > 1e-3 && isDiscPrimaryPath(slice, nib)) {
    const tip = points[points.length - 1];
    const styles = inkStrokePointStyles(op, start);
    const last = styles[styles.length - 1];
    if (!last) return;
    const tipR = paintedWidth(last.lineWidth, pixelScale) / 2;
    const growT = resolveBlotTipGrow(op, slice, tipR);
    const prev = slice.length > 1 ? slice[slice.length - 2] : undefined;
    paintTexturedDisc(
      ctx,
      op,
      sealDiscCenter(tip, prev, tipR, pixelScale),
      last.lineWidth,
      last.alpha,
      pixelScale,
      growT,
      growT > 1e-3 ? 1 : (last.dryGain ?? 1),
    );
    ctx.globalAlpha = 1;
    return;
  }

  const speedPenStroke = usesSpeedPenStroke(op, pixelScale);
  if (usesSpeedRibbon(op) && !speedPenStroke) {
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
      const origin = points[0];
      const heading =
        firstStrokeOutward(points, radius) ?? hashedHeading(origin, CAP_SALT_HEAD);
      paintOpCap(
        ctx,
        op,
        pStart,
        radius,
        heading,
        origin,
        CAP_SALT_HEAD,
        origin.pressure,
        run.alpha,
      );
    }

    if (capEnd && ri === runs.length - 1) {
      const origin = points[0];
      const prevIdx = Math.max(0, Math.ceil(run.end) - 1);
      const inner = points[prevIdx] ?? pStart;
      const heading =
        segmentOutward(pEnd, inner) ?? hashedHeading(origin, CAP_SALT_TAIL);
      paintOpCap(
        ctx,
        op,
        pEnd,
        radius,
        heading,
        origin,
        CAP_SALT_TAIL,
        pEnd.pressure,
        run.alpha,
      );
    }
  }
  if (!speedPenStroke && resolveGrain(op) > 1e-3) {
    scratchGrainAlongStroke(
      ctx,
      op,
      points.slice(start),
      inkStrokePointStyles(op, start),
      pixelScale,
    );
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
    const style = inkStrokeStyle(
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
