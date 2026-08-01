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

export interface ScenePoint {
  x: number;
  y: number;
  pressure: number;
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
  pressureSensitive: boolean;
  points: ScenePoint[];
}

export interface InkEraseOp {
  kind: "erase";
  radius: number;
  points: ScenePoint[];
}

export type InkOp = InkDrawOp | InkEraseOp;

/** Scene-unit line width from toolbar setting, optionally modulated by stylus pressure. */
export function inkLineWidth(
  baseWidth: number,
  pressure: number,
  pressureSensitive = true,
): number {
  const base = baseWidth * 1.35;
  if (pressureSensitive && pressure > 0 && pressure !== 0.5) {
    return base * Math.max(0.12, pressure * 1.85);
  }
  return base;
}

/** Scene-unit eraser radius from the same slider as pen width. */
export function eraserSceneRadius(strokeWidth: number): number {
  return strokeWidth * 1.75;
}

export function eraserScreenRadius(strokeWidth: number, zoom: number): number {
  return eraserSceneRadius(strokeWidth) * Math.max(0.05, zoom);
}

function pointerPressure(raw: number): number {
  return Number.isFinite(raw) && raw > 0 ? raw : 0.5;
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
  for (let index = 1; index <= count; index++) {
    const t = index / count;
    out.push({
      x: from.x + (to.x - from.x) * t,
      y: from.y + (to.y - from.y) * t,
      pressure: from.pressure + (to.pressure - from.pressure) * t,
    });
  }
  return out;
}

function drawStroke(ctx: CanvasRenderingContext2D, op: InkDrawOp): void {
  if (op.points.length < 2) return;
  ctx.globalCompositeOperation = "source-over";
  ctx.strokeStyle = op.color;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (let index = 1; index < op.points.length; index++) {
    const prev = op.points[index - 1];
    const next = op.points[index];
    ctx.lineWidth = inkLineWidth(op.baseWidth, prev.pressure, op.pressureSensitive);
    ctx.beginPath();
    ctx.moveTo(prev.x, prev.y);
    ctx.lineTo(next.x, next.y);
    ctx.stroke();
  }
}

function eraseStamps(ctx: CanvasRenderingContext2D, op: InkEraseOp): void {
  ctx.globalCompositeOperation = "destination-out";
  ctx.fillStyle = "rgba(0,0,0,1)";
  for (const point of op.points) {
    ctx.beginPath();
    ctx.arc(point.x, point.y, op.radius, 0, Math.PI * 2);
    ctx.fill();
  }
}

/** Apply one committed or live op in scene space (caller sets the transform). */
export function applyInkOp(ctx: CanvasRenderingContext2D, op: InkOp): void {
  if (op.kind === "draw") drawStroke(ctx, op);
  else eraseStamps(ctx, op);
  ctx.globalCompositeOperation = "source-over";
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

/**
 * Key for whether a baked ink bitmap still matches the current view.
 * Scroll/zoom/size changes require a rebuild from ops.
 */
export function inkBakeKey(
  viewport: ViewportTransform,
  dpr: number,
  cssW: number,
  cssH: number,
  clip: SceneBounds | null,
): string {
  const clipPart = clip
    ? `${clip.minX},${clip.minY},${clip.maxX},${clip.maxY}`
    : "-";
  return [
    cssW,
    cssH,
    dpr,
    viewport.zoom,
    viewport.scrollX,
    viewport.scrollY,
    clipPart,
  ].join("|");
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

  for (const op of ops) {
    applyInkOp(ctx, op);
  }

  if (liveOp) {
    applyInkOp(ctx, liveOp);
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
    const half = inkLineWidth(op.baseWidth, 1, op.pressureSensitive) / 2;
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
    if (op.kind === "draw") drawStroke(ctx, op);
    else eraseStamps(ctx, op);
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

  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    if (op.kind !== "draw") continue;
    const isErased = eraseLookup(ops.slice(i + 1));
    for (const point of op.points) {
      if (isErased(point)) {
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
 * Point-in-any-erase-stamp test, bucketed by the widest eraser radius so a long
 * rub-out doesn't turn recognition into a quadratic scan. Cells are that radius
 * wide, so every stamp that can cover a point lives in one of the nine cells
 * around it.
 */
function eraseLookup(ops: readonly InkOp[]): (point: ScenePoint) => boolean {
  let cell = 0;
  for (const op of ops) {
    if (op.kind === "erase") cell = Math.max(cell, op.radius);
  }
  if (cell <= 0) return () => false;

  const buckets = new Map<string, Array<{ x: number; y: number; r: number }>>();
  for (const op of ops) {
    if (op.kind !== "erase") continue;
    for (const point of op.points) {
      const key = `${Math.floor(point.x / cell)},${Math.floor(point.y / cell)}`;
      const stamp = { x: point.x, y: point.y, r: op.radius };
      const bucket = buckets.get(key);
      if (bucket) bucket.push(stamp);
      else buckets.set(key, [stamp]);
    }
  }

  return (point) => {
    const cx = Math.floor(point.x / cell);
    const cy = Math.floor(point.y / cell);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const bucket = buckets.get(`${cx + dx},${cy + dy}`);
        if (!bucket) continue;
        for (const stamp of bucket) {
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
): ScenePoint {
  const localX = clientX - canvasRect.left;
  const localY = clientY - canvasRect.top;
  return {
    ...scenePointFromCanvasPixel(localX, localY, viewport),
    pressure: pointerPressure(pressure),
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
