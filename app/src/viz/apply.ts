/**
 * Putting a viz program onto the canvas, and stepping it through time.
 *
 * The requirement this file exists to satisfy: **one diagram, scrubbed through
 * time** — not the same array copy-pasted five times. Stepping a frame replaces
 * the group's elements in place, because {@link renderViz} derives element ids
 * from `(programId, slot)` and {@link mergeVizElements} drops the previous
 * generation of that group before adding the new one.
 */

import {
  AGENT_LANE,
  AGENT_PADDING,
  AGENT_SLOT_HEIGHT,
  agentSlotOrigin,
  fitsInAgentLane,
} from "../templates/regions";
import type { Skeleton } from "../templates/skeleton";
import { renderViz } from "./render";
import type { VizProgram } from "./schema";
import { getCommonBounds } from "../canvas/boardScene";
import { convertToExcalidrawElements } from "../canvas/convertSkeletons";

/** The slice of Excalidraw's imperative API this module needs. */
export interface SceneApi {
  getSceneElements(): ReadonlyArray<VizSceneElement>;
  updateScene(scene: { elements: unknown[] }): void;
  getViewportBounds?(): { x: number; y: number; width: number; height: number; zoom?: number } | null;
}

export interface VizSceneElement {
  id: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  customData?: {
    lcVizId?: string;
    lcRegion?: string;
    lcRegionFrame?: boolean;
    lcVizOrigin?: { x: number; y: number; width: number; height?: number; scale?: number };
  } | null;
}

/** `convertToExcalidrawElements`, injected so this module stays testable. */
export type ConvertSkeletons = (skeletons: Skeleton[]) => unknown[];

/**
 * Existing elements minus the named viz group, plus the group's new elements.
 *
 * Pure, and the heart of the in-place-replacement guarantee.
 */
export function mergeVizElements<T extends VizSceneElement>(
  existing: ReadonlyArray<T>,
  replacement: ReadonlyArray<unknown>,
  vizId: string,
): unknown[] {
  const kept = existing.filter((element) => element.customData?.lcVizId !== vizId);
  return [...kept, ...replacement];
}

/** Every viz group currently on the board, in first-seen order. */
export function vizGroupIds(elements: ReadonlyArray<VizSceneElement>): string[] {
  const seen: string[] = [];
  for (const element of elements) {
    const id = element.customData?.lcVizId;
    if (id && !seen.includes(id)) seen.push(id);
  }
  return seen;
}

/** Live agent-frame X after layout sync, else the template lane. */
export function liveAgentLaneX(elements: ReadonlyArray<VizSceneElement>): number {
  const frame = elements.find(
    (element) =>
      element.customData?.lcRegion === "agent" && element.customData?.lcRegionFrame === true,
  );
  return typeof frame?.x === "number" ? frame.x : AGENT_LANE.x;
}

/**
 * Where a diagram should sit: its own slot if it is new, or the slot it already
 * occupies so stepping frames doesn't make it jump.
 */
export function originForProgram(
  elements: ReadonlyArray<VizSceneElement>,
  programId: string,
  slotHeight = AGENT_SLOT_HEIGHT,
): { x: number; y: number } {
  const groups = vizGroupIds(elements);
  const existing = groups.indexOf(programId);
  const index = existing >= 0 ? existing : groups.length;
  const laneX = liveAgentLaneX(elements);
  const origin = agentSlotOrigin(index, slotHeight, laneX);

  // Past the bottom of the lane, wrap to the top rather than drawing offscreen.
  // Callers should reclaim (remove) the oldest occupant before applying a new
  // program when the lane is full — otherwise two groups share slot 0.
  if (!fitsInAgentLane(origin, AGENT_LANE.w - AGENT_PADDING * 2, slotHeight)) {
    return agentSlotOrigin(0, slotHeight, laneX);
  }
  return origin;
}

/** Draw (or redraw) one frame of a program. */
export function applyViz(
  api: SceneApi,
  convert: ConvertSkeletons,
  program: VizProgram,
  frameIndex: number,
): void {
  const existing = api.getSceneElements();
  const lane = existing.find((el) => el.customData?.lcRegionFrame && el.customData.lcRegion === "agent");
  const viewport = !lane ? api.getViewportBounds?.() : null;
  const saved = existing.find((el) => el.customData?.lcVizId === program.id)?.customData?.lcVizOrigin;
  const fallback = originForProgram(existing, program.id);
  const zoom = viewport?.zoom && viewport.zoom > 0 ? viewport.zoom : 1;
  const padding = viewport ? Math.min(AGENT_PADDING / zoom, viewport.width * 0.1) : AGENT_PADDING;
  let origin: NonNullable<NonNullable<VizSceneElement["customData"]>["lcVizOrigin"]> = saved ?? (viewport
    ? { x: viewport.x + padding, y: viewport.y + padding, width: Math.max(1, viewport.width - padding * 2) }
    : { ...fallback, width: Math.max(120, (lane?.width ?? AGENT_LANE.w) - AGENT_PADDING * 2) });
  // Reserve the entire trace's height so growing structures never collide.
  const measure = measureProgram(program);
  const preferredScale = saved?.scale ?? (viewport ? Math.min(1 / zoom, viewport.height * 0.75 / Math.max(1, measure.height)) : 1);
  const scale = Math.min(preferredScale, origin.width / Math.max(1, measure.width));
  origin = { ...origin, height: measure.height * scale, scale };
  if (!saved) {
    const others = existing.filter((el) => el.customData?.lcVizId && el.customData.lcVizId !== program.id);
    const bottom = others.reduce((max, el) => {
      const placement = el.customData?.lcVizOrigin;
      return Math.max(max, placement ? placement.y + (placement.height ?? el.height ?? 0) : (el.y ?? 0) + (el.height ?? 0));
    }, origin.y - 28);
    if (others.length && (!viewport || bottom < viewport.y + viewport.height)) origin = { ...origin, y: Math.max(origin.y, bottom + 28) };
  }
  const skeletons = renderViz(program, frameIndex, { x: 0, y: 0 }).map((el): Skeleton => ({
    ...el,
    x: origin.x + (el.x - measure.minX) * scale,
    y: origin.y + (el.y - measure.minY) * scale,
    width: el.width === undefined ? undefined : el.width * scale,
    height: el.height === undefined ? undefined : el.height * scale,
    fontSize: el.fontSize === undefined ? undefined : el.fontSize * scale,
    strokeWidth: el.strokeWidth === undefined ? undefined : el.strokeWidth * scale,
    points: el.points?.map(([x, y]) => [x * scale, y * scale]),
    label: el.label ? { ...el.label, fontSize: (el.label.fontSize ?? 16) * scale } : undefined,
    customData: { ...el.customData, lcVizOrigin: origin, ...(!lane && viewport ? { lcRegion: undefined } : {}) },
  }));
  const converted = convert(skeletons);
  api.updateScene({ elements: mergeVizElements(existing, converted, program.id) });
}

const programMeasurements = new WeakMap<VizProgram, { minX: number; minY: number; width: number; height: number }>();
function measureProgram(program: VizProgram) {
  const cached = programMeasurements.get(program);
  if (cached) return cached;
  const all = program.frames.flatMap((_, i) => convertToExcalidrawElements(renderViz(program, i, { x: 0, y: 0 }), { regenerateIds: false }));
  const [minX, minY, maxX, maxY] = getCommonBounds(all);
  const measured = { minX, minY, width: maxX - minX, height: maxY - minY };
  programMeasurements.set(program, measured);
  return measured;
}

/** Draw (or replace) an annotation sticky in the agent lane. */
export function applyAnnotation(
  api: SceneApi,
  convert: ConvertSkeletons,
  annotation: import("../api/types").Annotation,
  render: (
    annotation: import("../api/types").Annotation,
    origin: { x: number; y: number },
  ) => Skeleton[],
): void {
  const vizId = `annotation:${annotation.region}`;
  const existing = api.getSceneElements();
  const origin = originForProgram(existing, vizId);
  const converted = convert(render(annotation, origin));
  api.updateScene({ elements: mergeVizElements(existing, converted, vizId) });
}

/** Draw highlight overlays over student elements. */
export function applyHighlight(
  api: SceneApi,
  convert: ConvertSkeletons,
  highlight: import("../api/types").Highlight,
  index: number,
  render: (
    highlight: import("../api/types").Highlight,
    elements: ReadonlyArray<VizSceneElement & { x: number; y: number; width: number; height: number }>,
    index: number,
  ) => Skeleton[],
): void {
  const vizId = `highlight:${index}`;
  const existing = api.getSceneElements() as Array<
    VizSceneElement & { x: number; y: number; width: number; height: number }
  >;
  const converted = convert(render(highlight, existing, index));
  api.updateScene({ elements: mergeVizElements(existing, converted, vizId) });
}

/** Remove one of the coach's diagrams, leaving the student's work alone. */
export function removeViz(api: SceneApi, vizId: string): void {
  const existing = api.getSceneElements();
  api.updateScene({ elements: mergeVizElements(existing, [], vizId) });
}

/** Clear the whole agent lane. */
export function clearAllViz(api: SceneApi): void {
  const existing = api.getSceneElements();
  api.updateScene({
    elements: existing.filter((element) => !element.customData?.lcVizId),
  });
}
