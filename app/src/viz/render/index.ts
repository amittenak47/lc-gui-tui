/**
 * Renderer registry: one deterministic layout function per structure.
 */

import { tagViz, type Skeleton } from "../../templates/skeleton";
import type { RenderContext, Renderer } from "../layout";
import type { VizFrame, VizKind, VizProgram } from "../schema";
import { renderGraph } from "./graph";
import { renderArray, renderQueue, renderStack } from "./linear";
import { renderLinkedList } from "./linked";
import { renderGrid, renderHashmap } from "./tabular";
import { renderHeap, renderTree } from "./tree";

export const RENDERERS: Record<VizKind, Renderer> = {
  array: renderArray,
  grid: renderGrid,
  hashmap: renderHashmap,
  tree: renderTree,
  linkedlist: renderLinkedList,
  heap: renderHeap,
  stack: renderStack,
  queue: renderQueue,
  graph: renderGraph,
};

/**
 * Render one frame of a program to tagged skeletons.
 *
 * Element ids are derived from the program id and the slot, so rendering frame
 * 1 after frame 0 yields the *same ids* — which is what lets `applyViz` replace
 * the group in place instead of accumulating a new copy per step.
 */
export function renderViz(
  program: VizProgram,
  frameIndex: number,
  origin: { x: number; y: number },
): Skeleton[] {
  const index = Math.min(Math.max(frameIndex, 0), program.frames.length - 1);
  const frame = program.frames[index];
  if (!frame) return [];

  const ctx: RenderContext = { program, frame, frameIndex: index, origin };
  const skeletons = RENDERERS[program.viz](ctx);
  return tagViz(skeletons, program.id);
}

function stampFrame(partial: Partial<VizFrame>): VizFrame {
  return {
    label: partial.label ?? "",
    cells: partial.cells ?? [],
    pointers: partial.pointers ?? {},
    highlight: partial.highlight ?? [],
    entries: partial.entries ?? [],
    note: partial.note ?? "",
  };
}

/**
 * The same layout as {@link renderViz}, without the coach header or `lcVizId`.
 *
 * Library stamps share the renderers so a student Array looks like the agent's
 * `array`. They stay unlocked and untagged — the student owns them.
 */
export function renderStamp(
  kind: VizKind,
  origin: { x: number; y: number },
  frame: Partial<VizFrame>,
  palette: { ink: string; fill: string; accent?: string },
): Skeleton[] {
  const full = stampFrame(frame);
  const program: VizProgram = {
    viz: kind,
    id: `stamp-${kind}`,
    title: "",
    frames: [full],
  };
  const ctx: RenderContext = {
    program,
    frame: full,
    frameIndex: 0,
    origin,
    bare: true,
    palette,
  };
  return RENDERERS[kind](ctx).map((skeleton) => ({
    ...skeleton,
    locked: false,
    customData: {
      ...skeleton.customData,
      lcStamp: true,
    },
  }));
}

export type { RenderContext, Renderer };
