import { describe, expect, it } from "vitest";
import { applyViz, removeViz, type SceneApi, type VizSceneElement } from "./apply";
import { convertToExcalidrawElements } from "../canvas/convertSkeletons";
import { getCommonBounds } from "../canvas/boardScene";
import { parseVizProgram } from "./schema";
import { renderViz } from "./render";

const program = parseVizProgram({ id: "walk", viz: "array", title: "Walk", frames: [
  { label: "Start", cells: [1, 2, 3], pointers: { i: 0 } },
  { label: "Advance", cells: [100000, 2, 3], pointers: { i: 1 } },
] })!;

function scene(initial: VizSceneElement[] = []) {
  let elements = initial;
  let viewport = { x: 50, y: 1200, width: 380, height: 800 };
  const api: SceneApi = {
    getSceneElements: () => elements,
    updateScene: (next) => { elements = next.elements as VizSceneElement[]; },
    getViewportBounds: () => viewport,
  };
  return { api, elements: () => elements, pan: () => { viewport = { ...viewport, y: 2400 }; } };
}
const convert = (items: Parameters<typeof convertToExcalidrawElements>[0]) => convertToExcalidrawElements(items, { regenerateIds: false });

describe("diagram placement", () => {
  it("puts pad drawings inside the viewport and keeps them anchored after panning", () => {
    const board = scene();
    applyViz(board.api, convert, program, 0);
    const first = board.elements();
    const bounds = getCommonBounds(first);
    expect(bounds[0]).toBeGreaterThanOrEqual(50);
    expect(bounds[1]).toBeGreaterThanOrEqual(1200);
    expect(bounds[2]).toBeLessThanOrEqual(430);
    expect(first.every((el) => el.customData?.lcRegion !== "agent")).toBe(true);
    const origin = first[0]!.customData!.lcVizOrigin;
    board.pan();
    applyViz(board.api, convert, program, 1);
    expect(board.elements()[0]!.customData!.lcVizOrigin).toEqual(origin);
    expect(board.elements().map((el) => el.id).sort()).toEqual(first.map((el) => el.id).sort());
  });
  it("keeps LeetCode drawings in the live Coach lane", () => {
    const board = scene([{ id: "coach", x: 900, y: 0, width: 500, height: 4000, customData: { lcRegion: "agent", lcRegionFrame: true } }]);
    applyViz(board.api, convert, program, 0);
    const viz = board.elements().filter((el) => el.customData?.lcVizId);
    expect(viz.every((el) => el.customData?.lcRegion === "agent")).toBe(true);
    expect(getCommonBounds(viz)[0]).toBeGreaterThan(900);
    expect(getCommonBounds(viz)[2]).toBeLessThan(1400);
  });
  it("does not move a drawing when the preceding one is collapsed", () => {
    const board = scene();
    applyViz(board.api, convert, program, 0);
    const other = { ...program, id: "other" };
    applyViz(board.api, convert, other, 0);
    const placement = board.elements().find((el) => el.customData?.lcVizId === "other")!.customData!.lcVizOrigin;
    removeViz(board.api, program.id);
    applyViz(board.api, convert, other, 1);
    expect(board.elements()[0]!.customData!.lcVizOrigin).toEqual(placement);
  });
  it("leaves room for larger values across the trace and moves the same named pointer", () => {
    const frames = [0, 1].map((i) => renderViz(program, i, { x: 0, y: 0 }));
    const cell = (i: number, index: number) => frames[i]!.find((el) => el.id?.endsWith(`cell-${index}`))!;
    expect(cell(0, 0).width).toEqual(cell(1, 0).width);
    expect(cell(1, 0).x + cell(1, 0).width!).toBeLessThan(cell(1, 1).x);
    const pointers = frames.map((els) => els.find((el) => el.id?.endsWith("ptr-i"))!);
    expect(pointers[0].id).toBe(pointers[1].id);
    expect(pointers[1].x).toBeGreaterThan(pointers[0].x);
  });
});
