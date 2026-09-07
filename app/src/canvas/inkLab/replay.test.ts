import { describe, expect, it } from "vitest";

import { isInkLabPenOp, labSpineFromDrawOp, splitInkOpsForLabReplay } from "./replay";
import type { InkDrawOp, InkOp } from "../rasterInk";

function penOp(partial: Partial<InkDrawOp> = {}): InkDrawOp {
  return {
    kind: "draw",
    color: "#112233",
    baseWidth: 2,
    maxFullness: 1,
    pressureClip: 1,
    pressureSensitive: false,
    points: [
      { x: 0, y: 0, pressure: 0.5, radius: 4 },
      { x: 10, y: 0, pressure: 0.5, radius: 4 },
    ],
    ...partial,
  };
}

describe("ink lab replay", () => {
  it("keeps stored radii for capsule replay", () => {
    const spine = labSpineFromDrawOp(penOp());
    expect(spine).toHaveLength(2);
    expect(spine[0]!.r).toBe(4);
    expect(spine[1]!.x).toBe(10);
  });

  it("splits highlighter and eraser off the lab pass", () => {
    const highlight = penOp({ highlight: true });
    const erase: InkOp = {
      kind: "erase",
      radius: 8,
      points: [{ x: 1, y: 1, pressure: 0.5 }],
    };
    const { lab, stamp } = splitInkOpsForLabReplay([penOp(), highlight, erase]);
    expect(lab).toHaveLength(1);
    expect(stamp).toHaveLength(2);
    expect(isInkLabPenOp(highlight)).toBe(false);
  });

  it("washes replay capsules from stored slowness and speedFade", () => {
    const spine = labSpineFromDrawOp(
      penOp({
        color: "#c41e3a",
        speedFade: 1,
        points: [
          { x: 0, y: 0, pressure: 0.5, radius: 4, slowness: 1 },
          { x: 10, y: 0, pressure: 0.5, radius: 4, slowness: 0 },
        ],
      }),
    );
    expect(spine[1]!.rgb![0]).toBeGreaterThan(spine[0]!.rgb![0] + 8);
  });

  it("keeps solid color when the stroke stored no fade", () => {
    const spine = labSpineFromDrawOp(
      penOp({
        color: "#c41e3a",
        points: [
          { x: 0, y: 0, pressure: 0.5, radius: 4, slowness: 0 },
          { x: 10, y: 0, pressure: 0.5, radius: 4, slowness: 0 },
        ],
      }),
    );
    expect(spine[0]!.rgb![0]).toBe(spine[1]!.rgb![0]);
  });
});
