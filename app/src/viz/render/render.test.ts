/**
 * Verification step 4: unit-test each renderer against golden output, and prove
 * frame stepping replaces element ids rather than accumulating them.
 */

import { describe, expect, it } from "vitest";

import { AGENT_CONTENT_TOP, AGENT_LANE, AGENT_PADDING } from "../../templates/regions";
import { agentSlotOrigin } from "../../templates/regions";
import { mergeVizElements, originForProgram, vizGroupIds } from "../apply";
import { CELL, cellBox, type RenderContext } from "../layout";
import { parseVizProgram, VIZ_KINDS, type VizKind, type VizProgram } from "../schema";
import { renderViz, RENDERERS } from "./index";

const ORIGIN = agentSlotOrigin(0);

function program(viz: VizKind, frames: Array<Partial<VizProgram["frames"][number]>>): VizProgram {
  return parseVizProgram({
    viz,
    id: `${viz}-demo`,
    title: `${viz} demo`,
    frames: frames.map((frame) => ({ label: "step", ...frame })),
  })!;
}

/** Sample data per kind, shaped the way the tool schema tells the model to. */
const SAMPLES: Record<VizKind, VizProgram> = {
  array: program("array", [
    { label: "i=0, j=3", cells: [2, 7, 11, 15], pointers: { i: 0, j: 3 }, highlight: [0, 3], note: "sum = 17 > 9 → move j left" },
    { label: "i=0, j=2", cells: [2, 7, 11, 15], pointers: { i: 0, j: 2 }, highlight: [0, 2] },
  ]),
  grid: program("grid", [
    { cells: [[1, 0], [0, 1]], highlight: [0, 3] },
    { cells: [[1, 1], [0, 1]], highlight: [1] },
  ]),
  hashmap: program("hashmap", [
    { entries: [["2", "0"], ["7", "1"]], highlight: [1] },
    { entries: [["2", "0"], ["7", "1"], ["11", "2"]] },
  ]),
  tree: program("tree", [
    { cells: [5, 3, 8, 1, null, 7, 9], highlight: [0] },
    { cells: [5, 3, 8, 1, null, 7, 9], highlight: [2] },
  ]),
  linkedlist: program("linkedlist", [
    { cells: [1, 2, 3], pointers: { head: 0, cur: 1 } },
    { cells: [1, 2, 3], pointers: { head: 0, cur: 2 } },
  ]),
  heap: program("heap", [
    { cells: [1, 3, 2, 7], highlight: [0] },
    { cells: [2, 3, 7], highlight: [0] },
  ]),
  stack: program("stack", [
    { cells: ["(", "["], highlight: [1] },
    { cells: ["("], highlight: [0] },
  ]),
  queue: program("queue", [
    { cells: ["a", "b", "c"] },
    { cells: ["b", "c"] },
  ]),
  graph: program("graph", [
    { cells: ["0", "1", "2"], entries: [["0", "1"], ["1", "2"]], highlight: [0] },
    { cells: ["0", "1", "2"], entries: [["0", "1"], ["1", "2"]], highlight: [2] },
  ]),
};

describe("renderer registry", () => {
  it("has a deterministic layout function for every advertised kind", () => {
    // The tool schema in src/llm/tools.rs promises the model these nine.
    expect(Object.keys(RENDERERS).sort()).toEqual([...VIZ_KINDS].sort());
  });
});

describe.each(VIZ_KINDS)("render %s", (kind) => {
  const sample = SAMPLES[kind];

  it("produces elements, all tagged as the coach's", () => {
    const elements = renderViz(sample, 0, ORIGIN);
    expect(elements.length).toBeGreaterThan(0);
    for (const element of elements) {
      expect(element.customData?.lcVizId).toBe(sample.id);
      expect(element.id).toBeTruthy();
      expect(element.locked).toBe(true);
    }
  });

  it("gives every element a unique id", () => {
    const ids = renderViz(sample, 0, ORIGIN).map((element) => element.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("is deterministic — same input, byte-identical output", () => {
    expect(renderViz(sample, 0, ORIGIN)).toEqual(renderViz(sample, 0, ORIGIN));
  });

  it("stays inside the agent lane", () => {
    for (const element of renderViz(sample, 0, ORIGIN)) {
      expect(element.x).toBeGreaterThanOrEqual(AGENT_LANE.x);
      expect(element.x).toBeLessThanOrEqual(AGENT_LANE.x + AGENT_LANE.w);
    }
  });

  it("renders an empty frame without throwing", () => {
    const empty = program(kind, [{ label: "empty" }]);
    expect(() => renderViz(empty, 0, ORIGIN)).not.toThrow();
    expect(renderViz(empty, 0, ORIGIN).length).toBeGreaterThan(0);
  });

  it("steps frames by replacing ids in place, not accumulating", () => {
    const first = renderViz(sample, 0, ORIGIN);
    const second = renderViz(sample, 1, ORIGIN);

    // The structural slots that survive between frames keep their ids...
    const firstIds = new Set(first.map((element) => element.id));
    const secondIds = new Set(second.map((element) => element.id));
    const shared = [...secondIds].filter((id) => firstIds.has(id));
    expect(shared.length).toBeGreaterThan(0);

    // ...and merging into the scene leaves one generation, not two.
    const scene = mergeVizElements([], first, sample.id) as Array<{
      id: string;
      customData?: { lcVizId?: string };
    }>;
    const stepped = mergeVizElements(scene, second, sample.id) as Array<{ id: string }>;
    expect(stepped.length).toBe(second.length);
    expect(new Set(stepped.map((element) => element.id)).size).toBe(second.length);
  });

  it("clamps an out-of-range frame index to the last frame", () => {
    expect(renderViz(sample, 99, ORIGIN)).toEqual(
      renderViz(sample, sample.frames.length - 1, ORIGIN),
    );
    expect(renderViz(sample, -5, ORIGIN)).toEqual(renderViz(sample, 0, ORIGIN));
  });
});

describe("highlighting", () => {
  it("changes the stroke of the highlighted cell only", () => {
    const [frameA, frameB] = [0, 1].map((index) => renderViz(SAMPLES.array, index, ORIGIN));
    const cellOf = (elements: typeof frameA, slot: string) =>
      elements.find((element) => element.id?.endsWith(slot));

    // Frame 0 highlights index 3; frame 1 highlights index 2.
    expect(cellOf(frameA, "cell-3")?.strokeWidth).toBe(2);
    expect(cellOf(frameB, "cell-3")?.strokeWidth).toBe(1);
    expect(cellOf(frameB, "cell-2")?.strokeWidth).toBe(2);
  });
});

describe("agent-lane slotting", () => {
  it("clears the agent title/hint with AGENT_CONTENT_TOP", () => {
    const origin = agentSlotOrigin(0);
    expect(origin.y).toBe(AGENT_LANE.y + AGENT_CONTENT_TOP);
    expect(origin.y).toBeGreaterThan(AGENT_LANE.y + AGENT_PADDING);
  });

  it("uses a live lane X when provided", () => {
    expect(agentSlotOrigin(0, undefined, 900).x).toBe(900 + AGENT_PADDING);
  });

  it("keeps a diagram in the slot it already occupies", () => {
    const scene = [{ id: "a", customData: { lcVizId: "first" } }];
    expect(originForProgram(scene, "first")).toEqual(agentSlotOrigin(0));
    // A second, different program gets the next slot down.
    expect(originForProgram(scene, "second")).toEqual(agentSlotOrigin(1));
  });

  it("lists groups in first-seen order", () => {
    const scene = [
      { id: "a", customData: { lcVizId: "x" } },
      { id: "b", customData: { lcVizId: "y" } },
      { id: "c", customData: { lcVizId: "x" } },
      { id: "d", customData: null },
    ];
    expect(vizGroupIds(scene)).toEqual(["x", "y"]);
  });

  it("wraps to the first slot rather than drawing past the lane", () => {
    const many = Array.from({ length: 40 }, (_, i) => ({
      id: `e${i}`,
      customData: { lcVizId: `group${i}` },
    }));
    expect(originForProgram(many, "brand-new")).toEqual(agentSlotOrigin(0));
  });
});

describe("cellBox value alignment", () => {
  it("places value text on the same center as the cell box", () => {
    const ctx: RenderContext = {
      program: SAMPLES.array,
      frame: SAMPLES.array.frames[0]!,
      frameIndex: 0,
      origin: { x: 0, y: 0 },
    };
    const [box, value] = cellBox(ctx, "cell-0", 40, 80, "7");
    expect(box.type).toBe("rectangle");
    expect(value.type).toBe("text");
    expect(value.x).toBe(box.x);
    expect(value.y).toBe(box.y);
    expect(value.width).toBe(box.width);
    expect(value.height).toBe(box.height);
    expect(value.textAlign).toBe("center");
    expect(value.verticalAlign).toBe("middle");
    expect(value.width).toBe(CELL);
  });
});

describe("merging", () => {
  it("leaves the student's own elements untouched", () => {
    const scene = [
      { id: "student-1" },
      { id: "coach-1", customData: { lcVizId: "nums" } },
      { id: "student-2" },
    ];
    const merged = mergeVizElements(scene, [{ id: "coach-2" }], "nums") as Array<{ id: string }>;
    expect(merged.map((element) => element.id)).toEqual(["student-1", "student-2", "coach-2"]);
  });

  it("removes a group when the replacement is empty", () => {
    const scene = [{ id: "student" }, { id: "coach", customData: { lcVizId: "nums" } }];
    const merged = mergeVizElements(scene, [], "nums") as Array<{ id: string }>;
    expect(merged.map((element) => element.id)).toEqual(["student"]);
  });

  it("does not disturb a different group", () => {
    const scene = [
      { id: "a", customData: { lcVizId: "nums" } },
      { id: "b", customData: { lcVizId: "seen" } },
    ];
    const merged = mergeVizElements(scene, [{ id: "a2" }], "nums") as Array<{ id: string }>;
    expect(merged.map((element) => element.id)).toEqual(["b", "a2"]);
  });
});
