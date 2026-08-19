/**
 * Link-tool stroke kinds: circle/scribble to pick a target, then a connector.
 *
 * The old gesture had to start on a 16px footnote chip. Circling a drawing or
 * an image never counted, so the tool looked dead. Classification is geometry
 * only — hit-testing lives in {@link ./linkHitTest}.
 */

export interface StrokePoint {
  x: number;
  y: number;
}

export interface StrokeBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Below this start→end span, the path is a tap that wandered. */
export const MIN_LINK_SPAN = 24;
/** How near a picked box a connector end still counts. */
export const CHIP_HIT_RADIUS = 34;
/** Loop start and end must close within this many CSS px. */
export const LOOP_CLOSE_PX = 56;
/** Smallest side of a loop/scribble box that can name a target. */
export const MIN_LOOP_SIDE = 28;
/** Path length vs box diagonal — denser than a single ring counts as a scribble. */
export const SCRIBBLE_PATH_RATIO = 2.1;
/** Thin strokes are connectors, not area selections (width/height). */
export const MAX_CONNECTOR_ASPECT = 4.5;

export function spanOf(points: readonly StrokePoint[]): number {
  if (points.length < 2) return 0;
  const first = points[0]!;
  const last = points[points.length - 1]!;
  return Math.hypot(last.x - first.x, last.y - first.y);
}

export function pathLength(points: readonly StrokePoint[]): number {
  let length = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    length += Math.hypot(b.x - a.x, b.y - a.y);
  }
  return length;
}

export function pathBox(points: readonly StrokePoint[]): StrokeBox | null {
  if (points.length === 0) return null;
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const point of points) {
    left = Math.min(left, point.x);
    top = Math.min(top, point.y);
    right = Math.max(right, point.x);
    bottom = Math.max(bottom, point.y);
  }
  if (!Number.isFinite(left)) return null;
  return {
    left,
    top,
    width: Math.max(1, right - left),
    height: Math.max(1, bottom - top),
  };
}

function boxAspect(box: StrokeBox): number {
  const a = Math.max(box.width, box.height);
  const b = Math.max(1, Math.min(box.width, box.height));
  return a / b;
}

export type StrokeKind = "tap" | "loop" | "scribble" | "connector";

/**
 * What the reader drew, as a link gesture.
 *
 * Loop: start meets end, box is area-like. Scribble: highlighter-style dense
 * paint over a compact region (Safari hide-items). Connector: open stroke
 * meant to join two already-picked targets.
 */
export function classifyStroke(points: readonly StrokePoint[]): StrokeKind {
  const box = pathBox(points);
  if (!box || points.length < 2) return "tap";
  const len = pathLength(points);
  if (len < MIN_LINK_SPAN) return "tap";
  const first = points[0]!;
  const last = points[points.length - 1]!;
  const closed = Math.hypot(last.x - first.x, last.y - first.y) <= LOOP_CLOSE_PX;
  const areaLike =
    Math.min(box.width, box.height) >= MIN_LOOP_SIDE && boxAspect(box) <= MAX_CONNECTOR_ASPECT;
  const diagonal = Math.hypot(box.width, box.height);
  const dense = len >= SCRIBBLE_PATH_RATIO * Math.max(diagonal, 1);
  if (closed && areaLike) return "loop";
  if (dense && areaLike) return "scribble";
  if (spanOf(points) >= MIN_LINK_SPAN) return "connector";
  return "tap";
}

export function boxCenter(box: StrokeBox): StrokePoint {
  return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
}

export function pointNearBox(point: StrokePoint, box: StrokeBox, pad = 36): boolean {
  return (
    point.x >= box.left - pad &&
    point.x <= box.left + box.width + pad &&
    point.y >= box.top - pad &&
    point.y <= box.top + box.height + pad
  );
}
