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

/** The slice of Excalidraw's imperative API this module needs. */
export interface SceneApi {
  getSceneElements(): ReadonlyArray<VizSceneElement>;
  updateScene(scene: { elements: unknown[] }): void;
}

export interface VizSceneElement {
  id: string;
  customData?: { lcVizId?: string } | null;
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
  const origin = agentSlotOrigin(index, slotHeight);

  // Past the bottom of the lane, wrap to the top rather than drawing offscreen.
  if (!fitsInAgentLane(origin, AGENT_LANE.w - AGENT_PADDING * 2, slotHeight)) {
    return agentSlotOrigin(0, slotHeight);
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
  const origin = originForProgram(existing, program.id);
  const skeletons = renderViz(program, frameIndex, origin);
  const converted = convert(skeletons);
  api.updateScene({ elements: mergeVizElements(existing, converted, program.id) });
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
