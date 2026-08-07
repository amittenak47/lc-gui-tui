/**
 * Page-bound pan: how far a painted layer has to slide to keep riding the page.
 *
 * A reading gesture deliberately leaves Excalidraw's camera alone — pushing
 * `updateScene` per sample is what capped the board at ~30fps. Everything that
 * was painted or positioned for that (now stale) camera is therefore correct
 * *relative to the page*, and wrong only by a translation. Sliding it by that
 * translation is a compositor job; repainting it is not.
 *
 * The same delta drives the ink bitmap, Excalidraw's own canvases and the
 * overlays, so it lives here rather than in three places — and so the rebase
 * rule below is a thing that can be tested rather than a magic number in a
 * pointer handler.
 */

export interface PanCamera {
  scrollX: number;
  scrollY: number;
  zoom: number;
}

export interface PanDelta {
  /** Screen px to translate by. Zero when {@link PanDelta.rebase} is set. */
  dx: number;
  dy: number;
  /** The translate cannot carry this — repaint at the live camera instead. */
  rebase: boolean;
}

/**
 * How far a bitmap may be dragged before it is repainted, as a fraction of the
 * viewport.
 *
 * The layer was painted for one screenful, so a translate reveals unpainted
 * ground at the leading edge — half a viewport is where that stops reading as
 * "ink that has not caught up yet" and starts reading as a hole. Below it, a
 * pan or a coast never touches the raster path at all.
 *
 * Overdrawn ink (see {@link INK_OVERDRAW_FRACTION}) passes {@link PanDeltaLimits}
 * so the ride can use the painted margin instead of rebasing at half a screen.
 */
export const PAN_REBASE_FRACTION = 0.5;

/**
 * Extra ink canvas margin per vertical side, as a fraction of the visible CSS
 * height. Horizontal stays flush — reading pan is vertical.
 */
export const INK_OVERDRAW_FRACTION = 0.75;

/**
 * Rebase when the ride has consumed this fraction of the overdraw margin, so
 * the next paint starts before the blank edge is on screen.
 */
export const OVERDRAW_REBASE_HEADROOM = 0.85;

/** Cap on total ink backing height in device pixels (visible + both margins). */
export const MAX_INK_CANVAS_DEVICE_PX = 6144;

/** Below this CSS height, skip overdraw — same paint box as today. */
const OVERDRAW_CSS_FLOOR_PX = 48;

/** Zoom is compared, not translated: a pinch has to go through a real repaint. */
const ZOOM_EPSILON = 1e-4;

/** Optional per-axis screen-px rebase limits (override `viewport * fraction`). */
export interface PanDeltaLimits {
  x?: number;
  y?: number;
}

/**
 * Screen delta from the camera a layer was painted at to the live one.
 *
 * Same sign and scale as the markdown slot's own transform — the content sits
 * at `(scene + scroll) * zoom`, so a scroll delta is a screen delta times zoom.
 */
export function panDelta(
  live: PanCamera,
  painted: PanCamera,
  viewport: { width: number; height: number },
  fraction: number = PAN_REBASE_FRACTION,
  limits?: PanDeltaLimits,
): PanDelta {
  const stop: PanDelta = { dx: 0, dy: 0, rebase: true };
  const zoom = live.zoom;
  if (!Number.isFinite(zoom) || zoom <= 0) return stop;
  // A zoom change rescales every stamp on the layer; no translate expresses it.
  if (!Number.isFinite(painted.zoom) || Math.abs(zoom - painted.zoom) > ZOOM_EPSILON) {
    return stop;
  }
  const dx = (live.scrollX - painted.scrollX) * zoom;
  const dy = (live.scrollY - painted.scrollY) * zoom;
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return stop;
  const limitX = limits?.x ?? Math.max(1, viewport.width) * fraction;
  const limitY = limits?.y ?? Math.max(1, viewport.height) * fraction;
  return { dx, dy, rebase: Math.abs(dx) > limitX || Math.abs(dy) > limitY };
}

/**
 * Vertical overdraw margin in CSS px for a visible ink height, or 0 to keep
 * today's exact-viewport bitmap (tiny boards / absurd DPR caps).
 */
export function overdrawMarginPx(cssH: number, dpr: number): number {
  if (!Number.isFinite(cssH) || cssH < OVERDRAW_CSS_FLOOR_PX) return 0;
  const pixelRatio = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
  const want = cssH * INK_OVERDRAW_FRACTION;
  // (cssH + 2*margin) * dpr <= MAX  →  margin <= (MAX/dpr - cssH) / 2
  const maxMargin = Math.max(0, (MAX_INK_CANVAS_DEVICE_PX / pixelRatio - cssH) / 2);
  if (maxMargin <= 0) return 0;
  return Math.min(want, maxMargin);
}

/**
 * Viewport used to paint/blit tiles into an overdrawn bitmap: shifted up by
 * `marginYPx/zoom` in scene space and taller by `2*marginYPx` in CSS px so the
 * visible screen maps to the middle band of the canvas.
 */
export function overdrawnViewport<
  T extends { scrollY: number; height: number; zoom: number },
>(viewport: T, marginYPx: number): T {
  if (!(marginYPx > 0) || !(viewport.zoom > 0)) return viewport;
  return {
    ...viewport,
    scrollY: viewport.scrollY + marginYPx / viewport.zoom,
    height: viewport.height + 2 * marginYPx,
  };
}
