import { expect, it } from "vitest";
import { problemCanvasSnapshot } from "./problemArtifactConflict";
import { applyPageVisibility, type PageableElement } from "../canvas/pageView";
import { encodeInkOps, inkOpsFrom } from "../canvas/inkCodec";
import type { BoardBlob } from "../canvas/BoardHandle";

it("keeps every problem region visible and editable in a notebook conflict copy", () => {
  const source: BoardBlob = { v: 1, appState: { zoom: 1, scrollX: 0, scrollY: 0 }, elements: [
    { id: "problem", type: "text", text: "Problem", x: 10, y: 10, width: 200, height: 40, customData: { lcRegion: "constraints" } },
    { id: "work", type: "rectangle", x: 50, y: 9000, width: 300, height: 400, customData: { lcRegion: "walkthrough" } },
  ], inkC: encodeInkOps([{ kind: "draw", color: "#111111", baseWidth: 2, maxFullness: 0.8, pressureClip: 0.6,
    pressureSensitive: true, points: [{ x: 500, y: 10000, pressure: 0.5 }, { x: 550, y: 10010, pressure: 0.5 }] }]) };
  const before = structuredClone(source);
  const copy = problemCanvasSnapshot(source);
  expect(source).toEqual(before);
  expect(copy.board.inkPages?.pageIds).toEqual([0]);
  expect(inkOpsFrom({ ...copy.board, inkC: copy.ink.get(0)! })).toEqual(inkOpsFrom(source));
  const elements = copy.board.elements as PageableElement[];
  expect(elements[0].customData).toMatchObject({ lcRegion: "pad-0", lcRegionFrame: true });
  expect(elements[0].height).toBeGreaterThan(10010);
  const visible = applyPageVisibility(elements, "pad-0") ?? elements;
  expect(visible.filter(el => el.id === "problem" || el.id === "work").every(el => el.opacity !== 0 && !el.locked)).toBe(true);
});
