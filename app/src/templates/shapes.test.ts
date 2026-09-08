/**
 * Library stamps share the viz renderers so a student Array matches the agent's.
 */

import { describe, expect, it } from "vitest";

import { DEFAULT_SHAPE_PALETTE, resolveShapeMods, SHAPES } from "./shapes";
import { renderStamp, renderViz } from "../viz/render";
import { parseVizProgram } from "../viz/schema";

const ORIGIN = { x: 40, y: 80 };

function stamp(id: string) {
  const shape = SHAPES.find((entry) => entry.id === id);
  if (!shape) throw new Error(`missing stamp ${id}`);
  return shape;
}

describe("viz-backed stamps", () => {
  it("array stamp matches a bare array renderer, not a coach-tagged diagram", () => {
    const cells = Array.from({ length: 5 }, () => "");
    const built = stamp("array").build(
      ORIGIN.x,
      ORIGIN.y,
      resolveShapeMods(stamp("array"), { length: 5 }),
      DEFAULT_SHAPE_PALETTE,
    );
    const viaStamp = renderStamp("array", ORIGIN, { cells }, DEFAULT_SHAPE_PALETTE);
    expect(built).toEqual(viaStamp);

    for (const element of built) {
      expect(element.customData?.lcVizId).toBeUndefined();
      expect(element.customData?.lcStamp).toBe(true);
      expect(element.locked).toBe(false);
    }

    const coach = renderViz(
      parseVizProgram({
        viz: "array",
        id: "nums",
        title: "nums",
        frames: [{ label: "start", cells }],
      })!,
      0,
      ORIGIN,
    );
    expect(coach.some((element) => element.customData?.lcVizId === "nums")).toBe(true);
    expect(coach.every((element) => element.locked)).toBe(true);
    // Coach header is extra; the structure slots still match.
    const stampSlots = built.map((element) => element.id?.replace(/^lcviz-stamp-array-/, ""));
    const coachSlots = coach
      .map((element) => element.id?.replace(/^lcviz-nums-/, ""))
      .filter((slot) => slot && slot !== "title");
    expect(stampSlots).toEqual(coachSlots.filter((slot) => slot !== "framelabel"));
  });

  it.each([
    ["grid", { rows: 2, cols: 3 }],
    ["linked-list", { nodes: 3 }],
    ["tree", { levels: 2 }],
    ["stack", { height: 4 }],
    ["hashmap", { rows: 3 }],
    ["queue", { slots: 4 }],
  ] as const)("%s stamp is unlocked and untagged", (id, mods) => {
    const shape = stamp(id);
    const elements = shape.build(
      ORIGIN.x,
      ORIGIN.y,
      resolveShapeMods(shape, { ...mods }),
      DEFAULT_SHAPE_PALETTE,
    );
    expect(elements.length).toBeGreaterThan(0);
    for (const element of elements) {
      expect(element.customData?.lcVizId).toBeUndefined();
      expect(element.locked).toBe(false);
    }
  });

  it("coach array still carries a title when not bare", () => {
    const program = parseVizProgram({
      viz: "array",
      id: "nums",
      title: "two-pointer",
      frames: [{ label: "start", cells: [1, 2] }],
    })!;
    const elements = renderViz(program, 0, ORIGIN);
    expect(elements.some((element) => element.text === "two-pointer")).toBe(true);
  });
});
