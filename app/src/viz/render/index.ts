/**
 * Renderer registry: one deterministic layout function per structure.
 */

import { tagViz, type Skeleton } from "../../templates/skeleton";
import { caption, footer, header, headerOffset, type RenderContext, type Renderer } from "../layout";
import { compositePanel, type VizFrame, type VizKind, type VizProgram } from "../schema";
import { renderBits } from "./bits";
import { renderCallTree } from "./calltree";
import { renderDpList, renderDpTable } from "./dp";
import { renderGraph } from "./graph";
import { renderArray, renderQueue, renderStack } from "./linear";
import { renderLinkedList } from "./linked";
import { renderSegTree } from "./segtree";
import { renderGrid, renderHashmap } from "./tabular";
import { renderHeap, renderTree } from "./tree";
import { renderTrie } from "./trie";
import { renderUnionFind } from "./unionfind";

const BASE_RENDERERS: Omit<Record<VizKind, Renderer>, "composite"> = {
  array: renderArray,
  grid: renderGrid,
  hashmap: renderHashmap,
  tree: renderTree,
  linkedlist: renderLinkedList,
  heap: renderHeap,
  stack: renderStack,
  queue: renderQueue,
  graph: renderGraph,
  trie: renderTrie,
  unionfind: renderUnionFind,
  dplist: renderDpList,
  dptable: renderDpTable,
  segtree: renderSegTree,
  calltree: renderCallTree,
  bits: renderBits,
};

/**
 * Named side-by-side panels. Nested `composite` is depth-1 — skipped, not recursed.
 */
function renderComposite(ctx: RenderContext): Skeleton[] {
  const out = header(ctx);
  const top = ctx.origin.y + headerOffset(ctx) + 20;
  let cursor = ctx.origin.x;
  let bottom = top;
  const panels = ctx.frame.cells
    .map(compositePanel)
    .filter((panel): panel is NonNullable<typeof panel> => panel !== null);

  panels.forEach((panel, index) => {
    const renderer = BASE_RENDERERS[panel.viz];
    const subProgram: VizProgram = {
      viz: panel.viz,
      id: `${ctx.program.id}-p${index}`,
      title: panel.title,
      frames: [panel.frame],
    };
    const subCtx: RenderContext = {
      program: subProgram,
      frame: panel.frame,
      frameIndex: 0,
      origin: { x: cursor, y: top },
      bare: true,
      palette: ctx.palette,
    };
    if (panel.title) {
      out.push(caption(ctx, `panel-${index}-name`, cursor, top - 20, panel.title, { accent: true }));
    }
    const pieces = renderer(subCtx);
    out.push(...pieces);
    const maxX = pieces.reduce(
      (max, skeleton) => Math.max(max, (skeleton.x ?? cursor) + (skeleton.width ?? 40)),
      cursor + 80,
    );
    const maxY = pieces.reduce(
      (max, skeleton) => Math.max(max, (skeleton.y ?? top) + (skeleton.height ?? 40)),
      top,
    );
    cursor = maxX + 36;
    bottom = Math.max(bottom, maxY);
  });

  if (panels.length === 0) {
    out.push(caption(ctx, "empty", ctx.origin.x, top, "(empty composite)"));
  }
  return [...out, ...footer(ctx, bottom)];
}

export const RENDERERS: Record<VizKind, Renderer> = {
  ...BASE_RENDERERS,
  composite: renderComposite,
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
