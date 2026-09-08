/**
 * Gesture-draw and transform math for scene primitives.
 *
 * The pad no longer creates rectangles on drag. The board owns the gesture
 * and writes the same element records the painter already strokes.
 */

import type { Skeleton } from "../templates/skeleton";
import type { ToolName } from "./BoardHandle";
import { isPageFrame, type PaintSceneElement } from "./paintScene";

export const MIN_SHAPE_SPAN = 4;

export type ShapeDrawTool = Extract<
  ToolName,
  "rectangle" | "ellipse" | "diamond" | "line" | "arrow"
>;

export const SHAPE_DRAW_TOOLS: ReadonlySet<string> = new Set([
  "rectangle",
  "ellipse",
  "diamond",
  "line",
  "arrow",
]);

export function isShapeDrawTool(tool: string): tool is ShapeDrawTool {
  return SHAPE_DRAW_TOOLS.has(tool);
}

export interface ShapeInk {
  stroke: string;
  fill: string;
  width: number;
}

export interface SceneBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export function normBox(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): { x: number; y: number; width: number; height: number } {
  const x = Math.min(x0, x1);
  const y = Math.min(y0, y1);
  return { x, y, width: Math.abs(x1 - x0), height: Math.abs(y1 - y0) };
}

export function shapeSpan(x0: number, y0: number, x1: number, y1: number): number {
  return Math.hypot(x1 - x0, y1 - y0);
}

export function skeletonFromDrag(
  type: ShapeDrawTool,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  ink: ShapeInk,
): Skeleton {
  if (type === "line" || type === "arrow") {
    const dx = x1 - x0;
    const dy = y1 - y0;
    return {
      type,
      x: x0,
      y: y0,
      width: dx,
      height: dy,
      strokeColor: ink.stroke,
      backgroundColor: "transparent",
      strokeWidth: ink.width,
      fillStyle: "solid",
      roughness: 0,
      opacity: 100,
      locked: false,
      points: [
        [0, 0],
        [dx, dy],
      ],
      customData: { lcStamp: true },
    };
  }
  const box = normBox(x0, y0, x1, y1);
  return {
    type,
    x: box.x,
    y: box.y,
    width: box.width,
    height: box.height,
    strokeColor: ink.stroke,
    backgroundColor: ink.fill,
    strokeWidth: ink.width,
    fillStyle: "solid",
    roughness: 0,
    opacity: 100,
    locked: false,
    customData: { lcStamp: true },
  };
}

export function isSelectableSceneElement(element: PaintSceneElement): boolean {
  if (element.isDeleted) return false;
  if (element.locked) return false;
  if (isPageFrame(element)) return false;
  if (element.customData?.lcVizId) return false;
  const opacity = element.opacity ?? 100;
  if (opacity <= 0) return false;
  return true;
}

export function sceneElementBounds(element: PaintSceneElement): SceneBounds {
  const x = element.x;
  const y = element.y;
  const w = element.width ?? 0;
  const h = element.height ?? 0;
  if (element.points && element.points.length > 0) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const pt of element.points) {
      minX = Math.min(minX, x + pt[0]);
      minY = Math.min(minY, y + pt[1]);
      maxX = Math.max(maxX, x + pt[0]);
      maxY = Math.max(maxY, y + pt[1]);
    }
    return { minX, minY, maxX, maxY };
  }
  const angle = element.angle ?? 0;
  if (!angle) {
    return {
      minX: Math.min(x, x + w),
      minY: Math.min(y, y + h),
      maxX: Math.max(x, x + w),
      maxY: Math.max(y, y + h),
    };
  }
  const cx = x + w / 2;
  const cy = y + h / 2;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const corners: Array<[number, number]> = [
    [-w / 2, -h / 2],
    [w / 2, -h / 2],
    [w / 2, h / 2],
    [-w / 2, h / 2],
  ];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [ox, oy] of corners) {
    const px = cx + ox * cos - oy * sin;
    const py = cy + ox * sin + oy * cos;
    minX = Math.min(minX, px);
    minY = Math.min(minY, py);
    maxX = Math.max(maxX, px);
    maxY = Math.max(maxY, py);
  }
  return { minX, minY, maxX, maxY };
}

export function hitTestScene(
  elements: readonly PaintSceneElement[],
  sceneX: number,
  sceneY: number,
): PaintSceneElement | null {
  for (let i = elements.length - 1; i >= 0; i--) {
    const el = elements[i]!;
    if (!isSelectableSceneElement(el)) continue;
    const b = sceneElementBounds(el);
    const pad = 6;
    if (
      sceneX >= b.minX - pad &&
      sceneX <= b.maxX + pad &&
      sceneY >= b.minY - pad &&
      sceneY <= b.maxY + pad
    ) {
      return el;
    }
  }
  return null;
}

export function moveElement<T extends PaintSceneElement>(element: T, dx: number, dy: number): T {
  return { ...element, x: element.x + dx, y: element.y + dy };
}

export function rotateElement<T extends PaintSceneElement>(element: T, delta: number): T {
  if (element.points && element.points.length >= 2) {
    const b = sceneElementBounds(element);
    const cx = (b.minX + b.maxX) / 2;
    const cy = (b.minY + b.maxY) / 2;
    const cos = Math.cos(delta);
    const sin = Math.sin(delta);
    const world = element.points.map(([px, py]) => {
      const ax = element.x + px - cx;
      const ay = element.y + py - cy;
      return [cx + ax * cos - ay * sin, cy + ax * sin + ay * cos] as [number, number];
    });
    const origin = world[0]!;
    return {
      ...element,
      x: origin[0],
      y: origin[1],
      points: world.map(([wx, wy]) => [wx - origin[0], wy - origin[1]] as [number, number]),
      angle: 0,
    };
  }
  return { ...element, angle: (element.angle ?? 0) + delta };
}

export function rotateDeltaFromDrag(
  cx: number,
  cy: number,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
): number {
  return Math.atan2(toY - cy, toX - cx) - Math.atan2(fromY - cy, fromX - cx);
}

export function flipElement<T extends PaintSceneElement>(element: T, axis: "h" | "v"): T {
  const b = sceneElementBounds(element);
  const cx = (b.minX + b.maxX) / 2;
  const cy = (b.minY + b.maxY) / 2;
  if (element.points && element.points.length >= 2) {
    const points = element.points.map(([px, py]) => {
      const ax = element.x + px;
      const ay = element.y + py;
      return [
        axis === "h" ? 2 * cx - ax - element.x : px,
        axis === "v" ? 2 * cy - ay - element.y : py,
      ] as [number, number];
    });
    return { ...element, points };
  }
  if (axis === "h") return { ...element, angle: -((element.angle ?? 0)) };
  return { ...element, angle: Math.PI - (element.angle ?? 0) };
}

export type ScaleHandle = "nw" | "ne" | "se" | "sw";

export function resizeBounds(from: SceneBounds, handle: ScaleHandle, sceneX: number, sceneY: number): SceneBounds {
  let minX = from.minX;
  let minY = from.minY;
  let maxX = from.maxX;
  let maxY = from.maxY;
  if (handle === "nw" || handle === "sw") minX = Math.min(sceneX, maxX - MIN_SHAPE_SPAN);
  if (handle === "ne" || handle === "se") maxX = Math.max(sceneX, minX + MIN_SHAPE_SPAN);
  if (handle === "nw" || handle === "ne") minY = Math.min(sceneY, maxY - MIN_SHAPE_SPAN);
  if (handle === "sw" || handle === "se") maxY = Math.max(sceneY, minY + MIN_SHAPE_SPAN);
  return { minX, minY, maxX, maxY };
}

export function scaleAbout<T extends PaintSceneElement>(element: T, from: SceneBounds, to: SceneBounds): T {
  const fromW = Math.max(MIN_SHAPE_SPAN, from.maxX - from.minX);
  const fromH = Math.max(MIN_SHAPE_SPAN, from.maxY - from.minY);
  const sx = (to.maxX - to.minX) / fromW;
  const sy = (to.maxY - to.minY) / fromH;
  const map = (wx: number, wy: number): [number, number] => [
    to.minX + (wx - from.minX) * sx,
    to.minY + (wy - from.minY) * sy,
  ];
  if (element.points && element.points.length >= 2) {
    const world = element.points.map(([px, py]) => map(element.x + px, element.y + py));
    const origin = world[0]!;
    return {
      ...element,
      x: origin[0],
      y: origin[1],
      width: to.maxX - to.minX,
      height: to.maxY - to.minY,
      points: world.map(([wx, wy]) => [wx - origin[0], wy - origin[1]] as [number, number]),
    };
  }
  const [nx, ny] = map(element.x, element.y);
  return {
    ...element,
    x: nx,
    y: ny,
    width: (element.width ?? 0) * sx,
    height: (element.height ?? 0) * sy,
  };
}

export function scaleElement<T extends PaintSceneElement>(
  element: T,
  handle: ScaleHandle,
  sceneX: number,
  sceneY: number,
): T {
  const from = sceneElementBounds(element);
  return scaleAbout(element, from, resizeBounds(from, handle, sceneX, sceneY));
}

export function setLinearPoint<T extends PaintSceneElement>(
  element: T,
  index: number,
  sceneX: number,
  sceneY: number,
): T {
  const points = [...(element.points ?? [])];
  if (index < 0 || index >= points.length) return element;
  points[index] = [sceneX - element.x, sceneY - element.y];
  const last = points[points.length - 1];
  return {
    ...element,
    points,
    width: last ? last[0] : element.width,
    height: last ? last[1] : element.height,
  };
}

/** Insert a midpoint after `index` so an arrow can curve. */
export function insertLinearMid<T extends PaintSceneElement>(element: T, after: number): T {
  const points = [...(element.points ?? [])];
  const a = points[after];
  const b = points[after + 1];
  if (!a || !b) return element;
  const mid: [number, number] = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  points.splice(after + 1, 0, mid);
  return { ...element, points };
}

export function sceneSelectionBounds(elements: readonly PaintSceneElement[]): SceneBounds | null {
  const live = elements.filter((el) => !el.isDeleted);
  if (live.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const el of live) {
    const b = sceneElementBounds(el);
    minX = Math.min(minX, b.minX);
    minY = Math.min(minY, b.minY);
    maxX = Math.max(maxX, b.maxX);
    maxY = Math.max(maxY, b.maxY);
  }
  if (!Number.isFinite(minX)) return null;
  return { minX, minY, maxX, maxY };
}

export function expandStampGroup(
  elements: readonly PaintSceneElement[],
  selected: readonly PaintSceneElement[],
): PaintSceneElement[] {
  const ids = new Set(selected.map((el) => el.id).filter((id): id is string => Boolean(id)));
  const groups = new Set(
    selected
      .map((el) => el.customData?.lcStampGroup)
      .filter((id): id is string => Boolean(id)),
  );
  return elements.filter((el) => {
    if (el.isDeleted || !isSelectableSceneElement(el)) return false;
    if (el.id && ids.has(el.id)) return true;
    const g = el.customData?.lcStampGroup;
    return Boolean(g && groups.has(g) && el.customData?.lcStamp);
  });
}
