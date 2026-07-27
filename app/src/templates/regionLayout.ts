/**
 * Keep resizable region frames stacked and aligned.
 *
 * Students can drag any dashed student-column border to change height or width.
 * Every student region shares that column width; the coach lane tracks to the
 * right. Frames are found by `customData` (not fixed ids) so layout still works
 * after Excalidraw conversion.
 *
 * Template text stores `lcRegionOx` / `lcRegionOy` relative to its frame so
 * resizing from the top/left handle cannot leave the problem statement stranded
 * above the box.
 */

import {
  REGIONS,
  REGION_GUTTER,
  STUDENT_REGION_ORDER,
  type RegionId,
} from "./regions";

export function regionFrameId(region: RegionId): string {
  return `lcregion-${region}-frame`;
}

export interface LayoutElement {
  id: string;
  type: string;
  x: number;
  y: number;
  width?: number;
  height?: number;
  customData?: {
    lcRegion?: string;
    lcRegionFrame?: boolean;
    lcRegionOx?: number;
    lcRegionOy?: number;
  } | null;
  [key: string]: unknown;
}

function num(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** Region frames on the board, keyed by region id. */
export function regionFramesOf(
  elements: readonly LayoutElement[],
): Map<RegionId, LayoutElement> {
  const frames = new Map<RegionId, LayoutElement>();
  for (const element of elements) {
    if (element.type !== "rectangle") continue;
    const meta = element.customData;
    if (!meta?.lcRegionFrame || !meta.lcRegion) continue;
    frames.set(meta.lcRegion as RegionId, element);
  }
  return frames;
}

/**
 * Shared student-column width: if one frame was resized away from the others,
 * that width wins; otherwise keep the common / constraints width.
 */
function sharedStudentWidth(frames: Map<RegionId, LayoutElement>): number {
  const widths = STUDENT_REGION_ORDER.map((region) => {
    const frame = frames.get(region);
    return frame ? num(frame.width, REGIONS[region].w) : null;
  }).filter((width): width is number => width !== null);

  if (widths.length === 0) return REGIONS.constraints.w;
  if (widths.every((width) => width === widths[0])) return widths[0];

  const counts = new Map<number, number>();
  for (const width of widths) {
    counts.set(width, (counts.get(width) ?? 0) + 1);
  }

  let majorityWidth = widths[0];
  let majorityCount = 0;
  for (const [width, count] of counts) {
    if (count > majorityCount) {
      majorityWidth = width;
      majorityCount = count;
    }
  }

  const outliers = widths.filter((width) => width !== majorityWidth);
  // One resized box → adopt its width. Messy multi-widths → prefer constraints
  // (or the majority) so the column snaps back together.
  if (new Set(outliers).size === 1 && outliers.length <= Math.ceil(widths.length / 2)) {
    return outliers[0];
  }

  const constraints = frames.get("constraints");
  return constraints ? num(constraints.width, majorityWidth) : majorityWidth;
}

/**
 * Enforce shared student width, vertical stacking, and coach-lane placement.
 * Returns a new element list when something changed, otherwise `null`.
 */
export function syncRegionLayout(elements: readonly LayoutElement[]): LayoutElement[] | null {
  const byId = new Map(elements.map((element) => [element.id, { ...element }]));
  const frames = regionFramesOf([...byId.values()]);
  const constraints = frames.get("constraints");
  if (!constraints) return null;

  const sharedWidth = sharedStudentWidth(frames);
  const oldOrigins = new Map<RegionId, { x: number; y: number }>();
  for (const region of [...STUDENT_REGION_ORDER, "agent" as RegionId]) {
    const frame = frames.get(region);
    if (frame) oldOrigins.set(region, { x: frame.x, y: frame.y });
  }

  let changed = false;
  let y = 0;

  for (const region of STUDENT_REGION_ORDER) {
    const frame = frames.get(region);
    if (!frame) continue;

    const height = Math.max(120, num(frame.height, REGIONS[region].h));
    const next = { ...frame, x: 0, y, width: sharedWidth, height };
    if (
      frame.x !== next.x ||
      frame.y !== next.y ||
      frame.width !== next.width ||
      frame.height !== next.height
    ) {
      changed = true;
    }
    byId.set(frame.id, next);
    frames.set(region, next);
    y += height + REGION_GUTTER;
  }

  const studentStackHeight = Math.max(0, y - REGION_GUTTER);
  const agent = frames.get("agent");
  if (agent) {
    const agentWidth = num(agent.width, REGIONS.agent.w);
    const agentHeight = Math.max(num(agent.height, REGIONS.agent.h), studentStackHeight);
    const next = {
      ...agent,
      x: sharedWidth + REGION_GUTTER * 2,
      y: 0,
      width: agentWidth,
      height: agentHeight,
    };
    if (
      agent.x !== next.x ||
      agent.y !== next.y ||
      agent.width !== next.width ||
      agent.height !== next.height
    ) {
      changed = true;
    }
    byId.set(agent.id, next);
    frames.set("agent", next);
  }

  const contentWidth = Math.max(200, sharedWidth - 72);

  for (const element of byId.values()) {
    if (element.customData?.lcRegionFrame) continue;
    const region = element.customData?.lcRegion as RegionId | undefined;
    if (!region) continue;

    const frame = frames.get(region);
    const oldOrigin = oldOrigins.get(region);
    if (!frame || !oldOrigin) continue;

    const meta = element.customData;
    // Prefer baked-in anchors so top/left resize cannot orphan statement text.
    const offsetX =
      typeof meta?.lcRegionOx === "number" ? meta.lcRegionOx : element.x - oldOrigin.x;
    const offsetY =
      typeof meta?.lcRegionOy === "number" ? meta.lcRegionOy : element.y - oldOrigin.y;
    const nextX = frame.x + offsetX;
    const nextY = frame.y + offsetY;
    const nextWidth =
      element.type === "text" && typeof meta?.lcRegionOx === "number"
        ? contentWidth
        : element.width;

    if (element.x !== nextX || element.y !== nextY || element.width !== nextWidth) {
      changed = true;
      byId.set(element.id, {
        ...element,
        x: nextX,
        y: nextY,
        ...(nextWidth !== undefined ? { width: nextWidth } : {}),
      });
    }
  }

  return changed ? Array.from(byId.values()) : null;
}
