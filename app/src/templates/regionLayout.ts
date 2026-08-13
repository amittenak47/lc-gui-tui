/**
 * Keep resizable region frames stacked and aligned.
 *
 * Students can drag any dashed student-column border to change height or width.
 * Every student region shares that column width; the coach lane tracks to the
 * right. Frames are found by `customData` or stable `lcregion-*-frame` ids.
 *
 * Template text stores `lcRegionOx` / `lcRegionOy` relative to its frame so
 * resizing from the top/left handle cannot leave the problem statement stranded
 * above the box. Heights never drop below the content or REGION_MIN floors.
 */

import { DRAW_HEADER_BAND } from "./drawPageGrowth";
import { regionTextWidth } from "./readingColumn";
import {
  PAGE_BREAK,
  REGIONS,
  REGION_GUTTER,
  REGION_MIN,
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
  angle?: number;
  customData?: {
    lcRegion?: string;
    lcRegionFrame?: boolean;
    lcRegionOx?: number;
    lcRegionOy?: number;
    lcFixedSize?: boolean;
    lcPinnedHeader?: boolean;
    lcReadingColumn?: boolean;
  } | null;
  [key: string]: unknown;
}

/**
 * Frames that carry their own width because they are documents.
 *
 * The statement is a reading column sized to the viewport; forcing it to the
 * shared student width is what made it four screens wide and its type
 * microscopic. Untagged boards are recognised by region so a saved board heals
 * on its first sync rather than staying wide forever.
 */
export function isReadingColumnFrame(element: LayoutElement): boolean {
  const meta = element.customData;
  if (meta?.lcReadingColumn) return true;
  return frameRegionOf(element) === "constraints";
}

const REGION_IDS = new Set<string>(Object.keys(REGIONS));

function num(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function regionFromFrameId(id: string): RegionId | null {
  const match = /^lcregion-([a-z]+)-frame$/i.exec(id);
  if (!match) return null;
  return REGION_IDS.has(match[1]) ? (match[1] as RegionId) : null;
}

function frameRegionOf(element: LayoutElement): RegionId | null {
  if (element.type !== "rectangle") return null;
  const meta = element.customData;
  if (meta?.lcRegionFrame && meta.lcRegion && REGION_IDS.has(meta.lcRegion)) {
    return meta.lcRegion as RegionId;
  }
  return regionFromFrameId(element.id);
}

/** Region frames on the board, keyed by region id. */
export function regionFramesOf(
  elements: readonly LayoutElement[],
): Map<RegionId, LayoutElement> {
  const frames = new Map<RegionId, LayoutElement>();
  for (const element of elements) {
    const region = frameRegionOf(element);
    if (region) frames.set(region, element);
  }
  return frames;
}

/**
 * Shared student-column width: if one frame was resized away from the others,
 * that width wins; otherwise keep the common / constraints width.
 */
function sharedStudentWidth(frames: Map<RegionId, LayoutElement>): number {
  const columns = STUDENT_REGION_ORDER.filter((region) => {
    const frame = frames.get(region);
    return !frame || !isReadingColumnFrame(frame);
  });
  const minColumn = Math.max(...columns.map((region) => REGION_MIN[region].minW));
  const widths = columns
    .map((region) => {
      const frame = frames.get(region);
      return frame ? num(frame.width, REGIONS[region].w) : null;
    })
    .filter((width): width is number => width !== null);

  if (widths.length === 0) return Math.max(minColumn, REGIONS.approach.w);
  if (widths.every((width) => width === widths[0])) return Math.max(minColumn, widths[0]);

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
  let picked = majorityWidth;
  if (new Set(outliers).size === 1 && outliers.length <= Math.ceil(widths.length / 2)) {
    picked = outliers[0];
  }

  return Math.max(minColumn, picked);
}

/** How tall a frame must be to keep its template content inside. */
function contentMinHeight(
  elements: readonly LayoutElement[],
  region: RegionId,
  frameOriginY: number,
): number {
  // Pinned label/hint chrome — content below still counts.
  let bottomRel = DRAW_HEADER_BAND;
  for (const element of elements) {
    if (frameRegionOf(element)) continue;
    if (element.customData?.lcPinnedHeader) continue;
    if (element.customData?.lcRegion !== region) continue;
    const meta = element.customData;
    const offsetY =
      typeof meta?.lcRegionOy === "number" ? meta.lcRegionOy : element.y - frameOriginY;
    const height =
      typeof element.height === "number" && Number.isFinite(element.height)
        ? element.height
        : element.type === "text"
          ? (() => {
              const font = Number(element.fontSize) || 28;
              const lines = Math.max(1, String(element.text ?? "").split("\n").length);
              return Math.round(font * 1.35 * lines);
            })()
          : 0;
    bottomRel = Math.max(bottomRel, offsetY + height);
  }
  // Leave a little air under the last line so it isn't flush with the border.
  return bottomRel + 56;
}

/**
 * Enforce shared student width, vertical stacking, coach-lane placement, and
 * hard minimum sizes. Returns a new element list when something changed.
 *
 * `codeContentHeight` sizes the Monaco code frame to the solution text so the
 * dock does not need an inner scrollbar.
 */
export function syncRegionLayout(
  elements: readonly LayoutElement[],
  options?: { codeContentHeight?: number; readingColumnWidth?: number },
): LayoutElement[] | null {
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

    const readingColumn = isReadingColumnFrame(frame);
    const frameWidth = readingColumn
      ? Math.max(
          REGION_MIN[region].minW,
          options?.readingColumnWidth ?? num(frame.width, REGIONS[region].w),
        )
      : sharedWidth;
    const requested = num(frame.height, REGIONS[region].h);
    const originY = oldOrigins.get(region)?.y ?? frame.y;
    const contentFloor = contentMinHeight([...byId.values()], region, originY);
    const codeFloor =
      region === "code" && options?.codeContentHeight != null
        ? options.codeContentHeight
        : null;
    // Code: fit the solution (allow a taller manual resize). Other regions keep
    // the previous max(min, content, requested) rule.
    const height =
      codeFloor != null
        ? Math.max(
            REGION_MIN[region].minH,
            contentFloor,
            codeFloor,
            requested > codeFloor ? requested : codeFloor,
          )
        : Math.max(REGION_MIN[region].minH, contentFloor, requested);
    const next = {
      ...frame,
      x: 0,
      y,
      width: frameWidth,
      height,
      // Template boxes stay upright — same rule as "no free move".
      angle: 0,
      // Ensure metadata survives Excalidraw updates that drop customData.
      customData: {
        ...(frame.customData ?? {}),
        lcRegion: region,
        lcRegionFrame: true,
      },
    };
    if (
      frame.x !== next.x ||
      frame.y !== next.y ||
      frame.width !== next.width ||
      frame.height !== next.height ||
      (typeof frame.angle === "number" && frame.angle !== 0)
    ) {
      changed = true;
    }
    byId.set(frame.id, next);
    frames.set(region, next);
    // A page break, not a gutter: this is the gap a reader scrolls through
    // between two sheets, and it is what keeps a grown page from reading as if
    // it had run into the next one. See `PAGE_BREAK`.
    y += height + PAGE_BREAK;
  }

  const agent = frames.get("agent");
  if (agent) {
    const agentWidth = Math.max(REGION_MIN.agent.minW, num(agent.width, REGIONS.agent.w));
    const agentOriginY = oldOrigins.get("agent")?.y ?? agent.y;
    const agentContent = contentMinHeight([...byId.values()], "agent", agentOriginY);
    // One sheet, same as Scratch. Stretching this to the student stack made a
    // paged Coach view zoom out to the whole column — empty postage-stamp lane.
    const agentHeight = Math.max(
      REGION_MIN.agent.minH,
      num(agent.height, REGIONS.agent.h),
      agentContent,
    );
    const next = {
      ...agent,
      x: sharedWidth + REGION_GUTTER * 2,
      y: 0,
      width: agentWidth,
      height: agentHeight,
      angle: 0,
      customData: {
        ...(agent.customData ?? {}),
        lcRegion: "agent" as const,
        lcRegionFrame: true,
      },
    };
    if (
      agent.x !== next.x ||
      agent.y !== next.y ||
      agent.width !== next.width ||
      agent.height !== next.height ||
      (typeof agent.angle === "number" && agent.angle !== 0)
    ) {
      changed = true;
    }
    byId.set(agent.id, next);
    frames.set("agent", next);
  }

  for (const element of byId.values()) {
    if (frameRegionOf(element)) continue;
    const region = element.customData?.lcRegion as RegionId | undefined;
    if (!region) continue;

    const frame = frames.get(region);
    const oldOrigin = oldOrigins.get(region);
    if (!frame || !oldOrigin) continue;

    // Text wraps to the frame it lives in, not to the widest frame on the
    // board — the statement's column is narrower than the drawing pages'.
    const contentWidth = regionTextWidth(num(frame.width, sharedWidth));

    const meta = element.customData;
    const offsetX =
      typeof meta?.lcRegionOx === "number" ? meta.lcRegionOx : element.x - oldOrigin.x;
    const offsetY =
      typeof meta?.lcRegionOy === "number" ? meta.lcRegionOy : element.y - oldOrigin.y;
    const nextX = frame.x + offsetX;
    const nextY = frame.y + offsetY;
    const nextWidth =
      element.type === "text" &&
      typeof meta?.lcRegionOx === "number" &&
      !meta?.lcFixedSize
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
