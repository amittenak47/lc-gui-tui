import { describe, expect, it } from "vitest";

import { baselineFromStructure, diffStructure, preferDelta } from "./boardDelta";
import type { CapturedElement } from "./capture";

function el(id: string, x: number): CapturedElement {
  return { id, type: "rectangle", x, y: 0, w: 10, h: 10 };
}

describe("boardDelta", () => {
  it("emits add, update, and delete ops", () => {
    const baseline = baselineFromStructure([el("a", 1)], new Map([["a", 1]]));
    const ops = diffStructure([el("b", 2)], baseline, new Map([["b", 1]]));
    expect(ops).toEqual([
      { op: "add", element: el("b", 2) },
      { op: "delete", id: "a" },
    ]);
  });

  it("skips unchanged elements", () => {
    const baseline = baselineFromStructure([el("a", 1)], new Map([["a", 1]]));
    expect(diffStructure([el("a", 1)], baseline, new Map([["a", 1]]))).toEqual([]);
  });

  it("prefers a delta when it is smaller than the full structure", () => {
    const structure = [el("a", 1), el("b", 2), el("c", 3)];
    const ops = [{ op: "add" as const, element: el("d", 4) }];
    expect(preferDelta(ops, structure)).toBe(true);
  });
});
