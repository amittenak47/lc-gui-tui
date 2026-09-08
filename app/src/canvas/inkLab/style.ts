/**
 * Wash, pooling, capillary. Not a fluid solver. Never in the nib rAF.
 */

import {
  blotPoolRgb,
  dryWashRgb,
  hasStylusPressure,
  inkBlotPoolT,
  INK_BLOT_SIZE_RANGE,
  inkSlowness,
  INK_SLOWNESS_NEUTRAL,
  INK_SPEED_NEUTRAL_PX_MS,
  INK_SPEED_SPAN,
  inkStrokeAlpha,
  normalizePressure,
  STROKE_WIDTH_DEFAULT,
  STROKE_WIDTH_MIN,
  type ScenePoint,
} from "../rasterInk";

import type { SpineDot } from "./instance";

export const INK_HEX = "#1a1a1a";
export const INK_RGB: [number, number, number] = [26, 26, 26];
export const TIP_GROW = 1.7;
export const LAB_NIB_CSS = 7;
/** Pad wash at a sprint: mix toward paper. Stopped writing stays full. */
const LAB_WASH_FAST = 0.65;
/**
 * Coalesced desktop hops arrive about this far apart. One Android sample per
 * rAF uses the full frame as dt, so the same flick reads as a dead stop and
 * fade never fires. Cap the window used to turn a hop into wash velocity.
 */
export const LAB_FADE_DT_CAP_MS = 8;

/** Toolbar pen. Radius is the Ink lab nib, not a zoom-scaled stamp. */
export type InkLabPen = {
  color: string;
  /** Toolbar nib width (UI units). Not `inkBaseWidthForZoom`. */
  baseWidth: number;
  /**
   * Unused for radius. Kept so older `setPen` call sites still type-check.
   * Pass 1.
   */
  overlayScale: number;
  /** Device pixels per CSS pixel of the overlay. */
  dpr: number;
  maxFullness: number;
  pressureClip: number;
  pressureSensitive: boolean;
  speedInk: number;
  speedBlotBlend: number;
  speedFade: number;
  boldness: number;
  /** Lift-bake Chaikin strength. Absent means the board default. */
  smoothing?: number;
  /** When the strength dial runs: lift commit, or reshape while down. */
  smoothingMode?: "lift" | "live";
  /** Lift-time Euler spiral. Never on the live nib. */
  clothoid?: boolean;
  /** Lift-time Laplacian relax. Never on the live nib. */
  capillary?: boolean;
};

export function labWashGain(slow: number): number {
  const s = Math.max(0, Math.min(1, slow));
  const dry = (1 - s) * (1 - s);
  return 1 - (1 - LAB_WASH_FAST) * dry;
}

export function labDotWashRgb(
  color: string,
  slow: number,
  fade: number,
): { r: number; g: number; b: number } {
  const f = Math.max(0, Math.min(1, fade));
  const gain = 1 + (labWashGain(slow) - 1) * f;
  return dryWashRgb(color, gain);
}

/** Boost hop velocity when the sample window is a whole rAF, not a coalesced dt. */
export function labFadeVel(dx: number, dy: number, dtMs: number): { vx: number; vy: number } {
  const windowMs =
    Number.isFinite(dtMs) && dtMs > 1e-3
      ? Math.min(dtMs, LAB_FADE_DT_CAP_MS)
      : LAB_FADE_DT_CAP_MS;
  return { vx: (dx * 1000) / windowMs, vy: (dy * 1000) / windowMs };
}

export function washRgb(vx: number, vy: number, dpr: number): [number, number, number] {
  const cssPxPerMs = Math.hypot(vx, vy) / 1000 / Math.max(dpr, 1e-6);
  const slow = inkSlowness(cssPxPerMs);
  const { r, g, b } = dryWashRgb(INK_HEX, labWashGain(slow));
  return [r, g, b];
}

/**
 * Slider units → pad size. Default width (2) is size 1.
 *
 * A hard `[0.45, 2.8]` cap made 1 still look like a 2–3 and froze the nib
 * from 6 through 32. Size 1 is a hairline; 6–64 keep growing.
 */
export const LAB_NIB_SIZE_AT_MIN = 0.2;

export function labNibSizeFromUiWidth(uiWidth: number): number {
  const w = Number.isFinite(uiWidth) && uiWidth > 0 ? uiWidth : STROKE_WIDTH_DEFAULT;
  const u = Math.max(STROKE_WIDTH_MIN, w);
  if (u <= STROKE_WIDTH_DEFAULT) {
    const t = (u - STROKE_WIDTH_MIN) / (STROKE_WIDTH_DEFAULT - STROKE_WIDTH_MIN);
    return LAB_NIB_SIZE_AT_MIN + t * (1 - LAB_NIB_SIZE_AT_MIN);
  }
  return u / STROKE_WIDTH_DEFAULT;
}

export function labPressureAmt(pen: InkLabPen, pressure: number): number {
  if (!pen.pressureSensitive || !hasStylusPressure(pressure)) return 0.5;
  const clip = Math.max(0.15, Math.min(1, pen.pressureClip || 1));
  return Math.max(0.15, Math.min(1, pressure / clip));
}

/**
 * Ink lab pad nib. Radius stays above the sample gate so capsules overlap
 * instead of leaving a dotted stamp trail. `size` is toolbar width vs default.
 * Pass `slow` to drive speed-ink without inventing a fake velocity.
 * Stylus pressure does not change width — only deposit, via {@link labPenDot}.
 */
export function labNibRadius(
  vx: number,
  vy: number,
  dpr: number,
  _pressure: number,
  size = 1,
  slow?: number,
): number {
  void _pressure;
  const cssPxPerMs = Math.hypot(vx, vy) / 1000 / Math.max(dpr, 1e-6);
  const sLow = slow ?? inkSlowness(cssPxPerMs);
  const s = Math.max(LAB_NIB_SIZE_AT_MIN, size);
  return Math.max(
    0.55 * dpr,
    LAB_NIB_CSS * dpr * (0.5 + 0.95 * sLow) * s,
  );
}

/** Reservoir ceiling × stylus pressure. SDF has no alpha, so this is an RGB wash. */
export function labDepositAmt(
  pen: Pick<
    InkLabPen,
    "maxFullness" | "pressureClip" | "pressureSensitive" | "boldness"
  >,
  pressure: number,
  consumed = 0,
): number {
  const stylus = pen.pressureSensitive && hasStylusPressure(pressure);
  const pNorm = stylus ? normalizePressure(pressure, pen.pressureClip) : 0;
  return inkStrokeAlpha(
    pen.maxFullness,
    pNorm,
    stylus,
    consumed,
    INK_SLOWNESS_NEUTRAL,
    0,
    pen.boldness,
    0,
    0,
  );
}

/** Mix already-washed ink toward paper (245) by a 0–1 deposit. */
export function labMixDepositRgb(
  rgb: { r: number; g: number; b: number },
  deposit: number,
): { r: number; g: number; b: number } {
  const g = Math.max(0, Math.min(1, deposit));
  if (g >= 1 - 1e-6) return rgb;
  const paper = 245;
  return {
    r: rgb.r * g + paper * (1 - g),
    g: rgb.g * g + paper * (1 - g),
    b: rgb.b * g + paper * (1 - g),
  };
}

export function labPenDot(
  pen: InkLabPen,
  vx: number,
  vy: number,
  dpr: number,
  pressure: number,
  _consumed: number,
  _growT: number,
): { r: number; rgb: [number, number, number]; a: number; slow: number } {
  const cssPxPerMs = Math.hypot(vx, vy) / 1000 / Math.max(dpr, 1e-6);
  const slow = inkSlowness(cssPxPerMs);
  const pAmt = labPressureAmt(pen, pressure);
  const size = labNibSizeFromUiWidth(pen.baseWidth);
  const speed = Math.max(0, Math.min(1, pen.speedInk));
  const fade = Math.max(0, Math.min(1, pen.speedFade));
  const blot = Math.max(0, Math.min(1, pen.speedBlotBlend));
  const widthSlow = INK_SLOWNESS_NEUTRAL + (slow - INK_SLOWNESS_NEUTRAL) * speed;
  const r = labNibRadius(vx, vy, dpr, pAmt, size, widthSlow);
  let washed = labDotWashRgb(pen.color, slow, fade);
  if (blot > 1e-3) {
    const poolT = inkBlotPoolT(_growT, blot);
    if (poolT > 1e-3) {
      washed = blotPoolRgb(
        `rgb(${washed.r}, ${washed.g}, ${washed.b})`,
        poolT,
      );
    }
  }
  washed = labMixDepositRgb(washed, labDepositAmt(pen, pressure, _consumed));
  return { r, rgb: [washed.r, washed.g, washed.b], a: 1, slow };
}

export function labPenNibOverlay(pen: InkLabPen): number {
  return Math.max(
    1e-6,
    LAB_NIB_CSS * Math.max(pen.dpr, 1) * labNibSizeFromUiWidth(pen.baseWidth),
  );
}

/** Invert {@link inkSlowness} so a preview strip can replay paced capsules. */
export function labCssSpeedFromSlowness(slow: number): number {
  if (!Number.isFinite(slow) || slow >= 1 - 1e-6) return 0;
  const t = Math.max(-1, Math.min(1, 1 - 2 * Math.max(0, Math.min(1, slow))));
  return INK_SPEED_NEUTRAL_PX_MS * INK_SPEED_SPAN ** t;
}

function densifyPreviewPoints(
  points: readonly ScenePoint[],
  mids = 2,
): ScenePoint[] {
  if (points.length < 2) return points.map((p) => ({ ...p }));
  const out: ScenePoint[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]!;
    const b = points[i + 1]!;
    out.push({ ...a });
    for (let k = 1; k <= mids; k++) {
      const t = k / (mids + 1);
      out.push({
        x: a.x + (b.x - a.x) * t,
        y: a.y + (b.y - a.y) * t,
        pressure: a.pressure + (b.pressure - a.pressure) * t,
        slowness:
          (a.slowness ?? INK_SLOWNESS_NEUTRAL) +
          ((b.slowness ?? INK_SLOWNESS_NEUTRAL) - (a.slowness ?? INK_SLOWNESS_NEUTRAL)) * t,
      });
    }
  }
  out.push({ ...points[points.length - 1]! });
  return out;
}

/** SDF spine for the preset Preview strip. Same dots the live nib would stamp. */
export function labPreviewSpine(
  pen: InkLabPen,
  points: readonly ScenePoint[],
  dpr: number,
  scaleX = 1,
  scaleY = 1,
): SpineDot[] {
  const dense = densifyPreviewPoints(points);
  const out: SpineDot[] = [];
  for (let i = 0; i < dense.length; i++) {
    const p = dense[i]!;
    const prev = dense[i - 1];
    const next = dense[i + 1];
    const from = prev ?? p;
    const to = prev ? p : (next ?? p);
    const dx = (to.x - from.x) * scaleX;
    const dy = (to.y - from.y) * scaleY;
    const len = Math.hypot(dx, dy);
    const css = labCssSpeedFromSlowness(p.slowness ?? INK_SLOWNESS_NEUTRAL);
    const vx = len > 1e-6 ? (dx / len) * css * 1000 * dpr : 0;
    const vy = len > 1e-6 ? (dy / len) * css * 1000 * dpr : 0;
    const styled = labPenDot(pen, vx, vy, dpr, p.pressure, 0, 0);
    out.push({
      x: p.x * scaleX * dpr,
      y: p.y * scaleY * dpr,
      r: styled.r,
      rgb: styled.rgb,
      a: styled.a,
      p: p.pressure,
      slow: styled.slow,
    });
  }
  labPreviewPool(pen, out);
  return out;
}

/**
 * Preview camera: size 1–8 fills the strip. Past 8 the camera steps back so
 * 9 looks like 1, 16 like 8 — same growth again.
 *
 * Every dial step eases. Crossing a band is two beats. Up a band: zoom out
 * (path and nib scale together) then morph the path back to the strip while
 * the nib stays at the wrapped size. Down a band is that pair in reverse —
 * morph the path in, then zoom in — so shrinking matches growing.
 */
export const PREVIEW_SIZE_BAND = 8;
/** Ease for a one-notch size change (same band). */
export const PREVIEW_STEP_MS = 200;
/** Zoom beat: camera scale. First when going up a band, second when going down. */
export const PREVIEW_BAND_ZOOM_MS = 280;
/** Morph beat: path fills or leaves the strip. Second when going up, first when going down. */
export const PREVIEW_BAND_MORPH_MS = 260;

export function wrapPreviewUiWidth(uiWidth: number, band = PREVIEW_SIZE_BAND): number {
  const w = Number.isFinite(uiWidth) && uiWidth > 0 ? uiWidth : STROKE_WIDTH_MIN;
  if (w <= band) return w;
  const m = w % band;
  return m === 0 ? band : m;
}

/** 1–8 → 0, 9–16 → 1, … Crossing a band is the Preview zoom. */
export function previewSizeBandIndex(uiWidth: number, band = PREVIEW_SIZE_BAND): number {
  const w = Number.isFinite(uiWidth) && uiWidth > 0 ? uiWidth : STROKE_WIDTH_MIN;
  return Math.max(0, Math.floor((w - 1) / band));
}

export function previewZoomEase(t: number): number {
  const x = Math.max(0, Math.min(1, t));
  return x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2;
}

export type PreviewCameraPose = {
  /** Wrapped UI width that sets nib / chisel radius. */
  displayWidth: number;
  /** Path scale about the strip centre. 1 fills the strip. */
  pathScale: number;
  /** Extra radius multiply. Equals pathScale during the zoom beat. */
  radiusScale: number;
};

export function previewRestPose(uiWidth: number): PreviewCameraPose {
  return {
    displayWidth: wrapPreviewUiWidth(uiWidth),
    pathScale: 1,
    radiusScale: 1,
  };
}

export function previewTransitionMs(fromUi: number, toUi: number): number {
  if (previewSizeBandIndex(fromUi) === previewSizeBandIndex(toUi)) {
    return Math.abs(wrapPreviewUiWidth(fromUi) - wrapPreviewUiWidth(toUi)) < 1e-6
      ? 0
      : PREVIEW_STEP_MS;
  }
  const fromW = wrapPreviewUiWidth(fromUi);
  const toW = wrapPreviewUiWidth(toUi);
  if (Math.abs(fromW - toW) < 1e-6) return 0;
  return PREVIEW_BAND_ZOOM_MS + PREVIEW_BAND_MORPH_MS;
}

export function samplePreviewCamera(
  fromUi: number,
  toUi: number,
  elapsedMs: number,
): PreviewCameraPose {
  const dest = previewRestPose(toUi);
  const fromW = wrapPreviewUiWidth(fromUi);
  const toW = wrapPreviewUiWidth(toUi);
  const fromBand = previewSizeBandIndex(fromUi);
  const toBand = previewSizeBandIndex(toUi);
  if (fromBand === toBand) {
    const dur = PREVIEW_STEP_MS;
    if (elapsedMs >= dur) return dest;
    if (elapsedMs <= 0) {
      return { displayWidth: fromW, pathScale: 1, radiusScale: 1 };
    }
    const u = previewZoomEase(elapsedMs / dur);
    return {
      displayWidth: fromW + (toW - fromW) * u,
      pathScale: 1,
      radiusScale: 1,
    };
  }
  if (Math.abs(fromW - toW) < 1e-6) return dest;
  if (elapsedMs <= 0) {
    return { displayWidth: fromW, pathScale: 1, radiusScale: 1 };
  }
  if (toBand > fromBand) {
    const ratio = toW / Math.max(fromW, 1e-6);
    if (elapsedMs < PREVIEW_BAND_ZOOM_MS) {
      const u = previewZoomEase(elapsedMs / PREVIEW_BAND_ZOOM_MS);
      const s = 1 + (ratio - 1) * u;
      return { displayWidth: fromW, pathScale: s, radiusScale: s };
    }
    if (elapsedMs >= PREVIEW_BAND_ZOOM_MS + PREVIEW_BAND_MORPH_MS) return dest;
    const u = previewZoomEase((elapsedMs - PREVIEW_BAND_ZOOM_MS) / PREVIEW_BAND_MORPH_MS);
    return {
      displayWidth: toW,
      pathScale: ratio + (1 - ratio) * u,
      radiusScale: 1,
    };
  }
  const ratio = fromW / Math.max(toW, 1e-6);
  if (elapsedMs < PREVIEW_BAND_MORPH_MS) {
    const u = previewZoomEase(elapsedMs / PREVIEW_BAND_MORPH_MS);
    return {
      displayWidth: fromW,
      pathScale: 1 + (ratio - 1) * u,
      radiusScale: 1,
    };
  }
  if (elapsedMs >= PREVIEW_BAND_MORPH_MS + PREVIEW_BAND_ZOOM_MS) return dest;
  const u = previewZoomEase((elapsedMs - PREVIEW_BAND_MORPH_MS) / PREVIEW_BAND_ZOOM_MS);
  const s = ratio + (1 - ratio) * u;
  return { displayWidth: toW, pathScale: s, radiusScale: s };
}

export function lerpPreviewPose(
  from: PreviewCameraPose,
  to: PreviewCameraPose,
  t: number,
): PreviewCameraPose {
  const u = previewZoomEase(t);
  return {
    displayWidth: from.displayWidth + (to.displayWidth - from.displayWidth) * u,
    pathScale: from.pathScale + (to.pathScale - from.pathScale) * u,
    radiusScale: from.radiusScale + (to.radiusScale - from.radiusScale) * u,
  };
}

export function applyPreviewPathScale<T extends { x: number; y: number }>(
  points: readonly T[],
  cx: number,
  cy: number,
  pathScale: number,
): T[] {
  if (Math.abs(pathScale - 1) < 1e-6) return points.map((p) => ({ ...p }));
  return points.map((p) => ({
    ...p,
    x: cx + (p.x - cx) * pathScale,
    y: cy + (p.y - cy) * pathScale,
  }));
}

export function applyPreviewCamera(
  points: readonly SpineDot[],
  cx: number,
  cy: number,
  pose: PreviewCameraPose,
): SpineDot[] {
  const path = applyPreviewPathScale(points, cx, cy, pose.pathScale);
  if (Math.abs(pose.radiusScale - 1) < 1e-6) return path;
  return path.map((p) => ({ ...p, r: p.r * pose.radiusScale }));
}

/** Fuse blot pools at the ends — contact and lift, not every slow wiggle. */
function labPreviewPool(pen: InkLabPen, spine: SpineDot[]): void {
  const blot = Math.max(0, Math.min(1, pen.speedBlotBlend));
  if (blot < 1e-3 || spine.length < 2) return;
  const rest = spine.map((p) => ({
    ...p,
    rgb: p.rgb
      ? ([p.rgb[0], p.rgb[1], p.rgb[2]] as [number, number, number])
      : undefined,
  }));
  const poolAt = (index: number) => {
    const base = rest[index]!;
    const grown = base.r * (1 + (TIP_GROW - 1) * blot);
    labSwellHoldPool(spine, rest, grown, blot, base.rgb ?? INK_RGB, index);
  };
  poolAt(0);
  poolAt(spine.length - 1);
}

/** Toolbar / preset snapshot → live Ink lab pen. Never scales by board zoom. */
export function labPenFromToolbar(opts: {
  color: string;
  uiWidth: number;
  dpr: number;
  pressureClip: number;
  pressureSensitive: boolean;
  blot?: number;
  speed?: number;
  fade?: number;
  smoothing?: number;
  smoothingMode?: "lift" | "live";
  clothoid?: boolean;
  capillary?: boolean;
}): InkLabPen {
  return {
    color: opts.color,
    baseWidth: opts.uiWidth,
    overlayScale: 1,
    dpr: opts.dpr,
    maxFullness: 1,
    pressureClip: opts.pressureClip,
    pressureSensitive: opts.pressureSensitive,
    speedInk: opts.speed ?? 0,
    speedBlotBlend: opts.blot ?? 0,
    speedFade: opts.fade ?? 0,
    boldness: 1,
    smoothing: opts.smoothing,
    smoothingMode: opts.smoothingMode,
    clothoid: opts.clothoid === true,
    capillary: opts.capillary === true,
  };
}

export function growTipRadius(base: number, current: number): number {
  const cap = base * TIP_GROW;
  return Math.min(cap, current + (cap - base) * 0.05);
}

/** Hold-grow knob: 0 stays nib-sized, 1 is the pad's {@link TIP_GROW}. */
export function labHoldGrow(base: number, current: number, blot: number): number {
  const t = Math.max(0, Math.min(1, blot));
  if (t < 1e-3) return base;
  const cap = base * (1 + (TIP_GROW - 1) * t);
  return Math.min(cap, current + (cap - base) * 0.05);
}

/**
 * Bleed a hold pool back along the live spine so the blot is the stroke
 * swelling, not a disc sitting on the last capsule. `rest` is the spine at
 * hold start; each tick writes from that snapshot so growth does not stack.
 */
export function labSwellHoldPool(
  spine: SpineDot[],
  rest: readonly SpineDot[],
  grownR: number,
  growT: number,
  rgb: [number, number, number],
  tipIndex = spine.length - 1,
): void {
  if (spine.length === 0 || rest.length !== spine.length) return;
  const iTip = Math.max(0, Math.min(tipIndex, spine.length - 1));
  const last = spine[iTip]!;
  last.r = Math.max(last.r, grownR);
  last.rgb = rgb;
  if (growT < 1e-3) return;
  const acc = [0];
  for (let i = 1; i < spine.length; i++) {
    const a = spine[i - 1]!;
    const b = spine[i]!;
    acc.push(acc[i - 1]! + Math.hypot(b.x - a.x, b.y - a.y));
  }
  const origin = acc[iTip]!;
  const restTip = rest[iTip]!.r;
  const plateau = grownR;
  const radius = grownR + restTip * (1.15 + INK_BLOT_SIZE_RANGE);
  const g = Math.max(0, Math.min(1, growT));
  for (let i = 0; i < spine.length; i++) {
    const base = rest[i]!;
    if (i === iTip) continue;
    const dist = Math.abs(acc[i]! - origin);
    let w = 0;
    if (dist <= plateau) w = 1;
    else if (dist < radius) {
      const span = radius - plateau;
      const t = span > 1e-6 ? 1 - (dist - plateau) / span : 1;
      w = t * t;
    }
    w *= g;
    if (w <= 0) continue;
    const nextR = base.r + (grownR - base.r) * w;
    spine[i]!.r = Math.max(spine[i]!.r, nextR);
    const from = base.rgb;
    if (from) {
      spine[i]!.rgb = [
        from[0] + (rgb[0] - from[0]) * w,
        from[1] + (rgb[1] - from[1]) * w,
        from[2] + (rgb[2] - from[2]) * w,
      ];
    }
  }
}

export function capillaryRelax(points: readonly SpineDot[], sweeps = 6): SpineDot[] {
  if (points.length < 3) return points.map((p) => ({ ...p }));
  let cur = points.map((p) => ({ ...p }));
  for (let s = 0; s < sweeps; s++) {
    const next = cur.map((p) => ({ ...p }));
    for (let i = 1; i < cur.length - 1; i++) {
      const a = cur[i - 1]!;
      const b = cur[i]!;
      const c = cur[i + 1]!;
      next[i] = {
        x: (a.x + 2 * b.x + c.x) / 4,
        y: (a.y + 2 * b.y + c.y) / 4,
        r: (a.r + b.r + c.r) / 3,
        rgb: b.rgb,
        a: b.a,
        p: b.p,
        slow: b.slow,
      };
    }
    cur = next;
  }
  return cur;
}
