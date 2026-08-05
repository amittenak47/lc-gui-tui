/**
 * Draw-page height growth for mobile paging.
 *
 * A draw page starts at one viewport page plus a half-page buffer. When student
 * ink approaches the bottom buffer, the frame grows in half-page steps up to
 * five pages. The header band (label + hint) is excluded from content measure
 * so agent capture boxes and growth both start below the chrome.
 */

import type { InkOp } from "../canvas/rasterInk";

/**
 * Scene height at the top of a page that is chrome rather than content.
 *
 * Zero now: the label and hint that used to sit there were template-box text
 * and are not drawn. Kept as a named constant (and as a parameter on the
 * helpers) because "content starts below the chrome" is still the rule — there
 * is simply no chrome. A page that grows one again sets this and everything
 * downstream, growth and agent capture alike, moves with it.
 */
export const DRAW_HEADER_BAND = 0;
export const DRAW_GROWTH_CAP = 5;
export const DRAW_BUFFER_FRAC = 0.5;

export function initialDrawHeight(basePageH: number): number {
  return Math.round(basePageH * (1 + DRAW_BUFFER_FRAC));
}

export function growDrawHeight({
  basePageH,
  currentH,
  contentBottomRel,
}: {
  basePageH: number;
  currentH: number;
  contentBottomRel: number;
}): number {
  const cap = basePageH * DRAW_GROWTH_CAP;
  const floor = initialDrawHeight(basePageH);
  const buffer = basePageH * DRAW_BUFFER_FRAC;
  let h = currentH;
  while (contentBottomRel > h - buffer && h < cap) {
    h += buffer;
  }
  return Math.max(floor, Math.min(cap, Math.round(h)));
}

export interface SceneAABB {
  x: number;
  y: number;
  width: number;
  height: number;
}

type MeasuringElement = {
  id?: string;
  type?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  isDeleted?: boolean;
  customData?: {
    lcRegion?: string;
    lcRegionFrame?: boolean;
    lcPinnedHeader?: boolean;
    lcVizId?: string;
  } | null;
};

function num(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function shouldExcludeFromContent(el: MeasuringElement): boolean {
  if (el.isDeleted) return true;
  if (el.customData?.lcRegionFrame) return true;
  if (el.customData?.lcPinnedHeader) return true;
  if (el.customData?.lcVizId) return true;
  /*
   * Template scaffolding is not content.
   *
   * It matters most on the statement page, which is nothing *but* scaffolding:
   * counting it would make the agent's capture boxes span the whole printed
   * problem, so a single circled word would arrive as five screenfuls of the
   * statement. What the boxes are for is the marks somebody made.
   */
  if (typeof el.id === "string" && el.id.startsWith("lcregion-")) return true;
  return false;
}

function elementInFrame(
  el: MeasuringElement,
  frame: { x: number; y: number; width: number; height: number },
  regionId?: string,
): boolean {
  if (regionId && el.customData?.lcRegion === regionId) return true;
  if (typeof el.x !== "number" || typeof el.y !== "number") return false;
  const w = num(el.width, 0);
  const h = num(el.height, 0);
  const cx = el.x + w / 2;
  const cy = el.y + h / 2;
  return (
    cx >= frame.x &&
    cy >= frame.y &&
    cx <= frame.x + frame.width &&
    cy <= frame.y + frame.height
  );
}

function elementAABB(el: MeasuringElement): SceneAABB | null {
  if (typeof el.x !== "number" || typeof el.y !== "number") return null;
  const w = num(el.width, 0);
  const h = num(el.height, 0);
  if (w <= 0 && h <= 0) return null;
  return { x: el.x, y: el.y, width: Math.max(w, 1), height: Math.max(h, 1) };
}

function inkOpAABB(
  op: InkOp,
  frame: { x: number; y: number; width: number; height: number },
  headerBottom: number,
): SceneAABB | null {
  if (op.kind !== "draw" || op.points.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const maxXf = frame.x + frame.width;
  const maxYf = frame.y + frame.height;
  for (const pt of op.points) {
    if (pt.x < frame.x || pt.y < headerBottom || pt.x > maxXf || pt.y > maxYf) continue;
    minX = Math.min(minX, pt.x);
    minY = Math.min(minY, pt.y);
    maxX = Math.max(maxX, pt.x);
    maxY = Math.max(maxY, pt.y);
  }
  if (!Number.isFinite(minX)) return null;
  return { x: minX, y: minY, width: Math.max(1, maxX - minX), height: Math.max(1, maxY - minY) };
}

/** Student ink/shapes in a draw frame, excluding template chrome. */
export function contentAABBsInFrame(
  elements: readonly MeasuringElement[],
  ops: readonly InkOp[],
  frame: { x: number; y: number; width: number; height: number; customData?: { lcRegion?: string } },
  headerBand = DRAW_HEADER_BAND,
): SceneAABB[] {
  const headerBottom = frame.y + headerBand;
  const regionId = frame.customData?.lcRegion;
  const aabbs: SceneAABB[] = [];

  for (const el of elements) {
    if (shouldExcludeFromContent(el)) continue;
    if (!elementInFrame(el, frame, regionId)) continue;
    const box = elementAABB(el);
    if (!box) continue;
    if (box.y + box.height <= headerBottom) continue;
    aabbs.push(box);
  }

  for (const op of ops) {
    const box = inkOpAABB(op, frame, headerBottom);
    if (box) aabbs.push(box);
  }

  return aabbs;
}

/** Max Y of student content relative to `frame.y` (header band is the floor). */
export function contentBottomInFrame(
  elements: readonly MeasuringElement[],
  ops: readonly InkOp[],
  frame: { x: number; y: number; width: number; height: number; customData?: { lcRegion?: string } },
  headerBand = DRAW_HEADER_BAND,
): number {
  const aabbs = contentAABBsInFrame(elements, ops, frame, headerBand);
  let bottomRel = headerBand;
  for (const box of aabbs) {
    bottomRel = Math.max(bottomRel, box.y + box.height - frame.y);
  }
  return bottomRel;
}

/** Draw regions that grow with ink (not statement/code/md). */
export function isDrawPageRegion(region: string | null | undefined): boolean {
  if (!region) return false;
  if (region === "constraints" || region === "code" || region === "agent") return false;
  if (region.startsWith("mdink")) return false;
  return true;
}
