/**
 * Scene-space raster ink — draw and erase on a canvas bitmap instead of
 * Excalidraw freedraw vectors. Erasing uses `destination-out` (true pixel erase).
 */

export const STROKE_WIDTH_MIN = 1;
export const STROKE_WIDTH_MAX = 32;
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

/** Repaint the full ink bitmap from committed ops + an in-progress op. */
export function paintRasterInk(
  ctx: CanvasRenderingContext2D,
  viewport: ViewportTransform,
  ops: readonly InkOp[],
  liveOp: InkOp | null,
  dpr: number,
): void {
  const { zoom, scrollX, scrollY, width, height } = viewport;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  // Canvas element origin = top-left of the overlay. Only scroll + zoom apply here;
  // offsetLeft/offsetTop are viewport coords and must NOT be added again.
  ctx.setTransform(
    zoom * dpr,
    0,
    0,
    zoom * dpr,
    scrollX * zoom * dpr,
    scrollY * zoom * dpr,
  );

  for (const op of ops) {
    if (op.kind === "draw") drawStroke(ctx, op);
  }
  for (const op of ops) {
    if (op.kind === "erase") eraseStamps(ctx, op);
  }

  if (liveOp) {
    if (liveOp.kind === "draw") drawStroke(ctx, liveOp);
    else eraseStamps(ctx, liveOp);
  }

  ctx.globalCompositeOperation = "source-over";
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
