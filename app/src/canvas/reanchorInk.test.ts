import { describe, expect, it } from "vitest";

import type { LayoutElement } from "../templates/regionLayout";
import { PAGE_BREAK, REGIONS } from "../templates/regions";
import type { InkDrawOp, InkOp } from "./rasterInk";
import { reanchorInkOps } from "./reanchorInk";

function frame(region: string, y: number, height: number): LayoutElement {
  const authored = REGIONS[region as keyof typeof REGIONS];
  return {
    id: `lcregion-${region}-frame`,
    type: "rectangle",
    x: 0,
    y,
    width: authored.w,
    height,
    customData: { lcRegion: region, lcRegionFrame: true },
  };
}

/** A pen stroke, as a short run of scene points. */
function stroke(x: number, y: number): InkDrawOp {
  return {
    kind: "draw",
    color: "#000",
    baseWidth: 4,
    maxFullness: 1,
    pressureClip: 1,
    pressureSensitive: false,
    points: [
      { x, y, pressure: 0.5 },
      { x: x + 40, y: y + 10, pressure: 0.5 },
    ],
  };
}

const ys = (op: InkOp) => op.points.map((p) => p.y);

describe("reanchorInkOps", () => {
  const before = [
    frame("constraints", 0, 900),
    frame("code", 964, 2352),
    frame("approach", 3380, 2380),
  ];

  it("carries a page's ink down when the page above grows", () => {
    // The statement grew 400; code and approach shift with it.
    const after = [
      frame("constraints", 0, 1300),
      frame("code", 1364, 2352),
      frame("approach", 3780, 2380),
    ];
    const onCode = stroke(100, 1200);
    const onApproach = stroke(100, 3500);
    const onStatement = stroke(100, 200);

    const [code, approach, statement] = reanchorInkOps(before, after, [
      onCode,
      onApproach,
      onStatement,
    ]);

    expect(ys(code)).toEqual([1600, 1610]);
    expect(ys(approach)).toEqual([3900, 3910]);
    // The statement itself did not move, so neither does its ink.
    expect(ys(statement)).toEqual([200, 210]);
  });

  /** The one-time migration: the gap between pages changed. */
  it("carries ink across a change to the page break", () => {
    const oldGutter = 64;
    const stacked = [
      frame("constraints", 0, 900),
      frame("code", 900 + oldGutter, 2352),
      frame("approach", 900 + oldGutter + 2352 + oldGutter, 2380),
    ];
    const rebroken = [
      frame("constraints", 0, 900),
      frame("code", 900 + PAGE_BREAK, 2352),
      frame("approach", 900 + PAGE_BREAK + 2352 + PAGE_BREAK, 2380),
    ];
    const shift = PAGE_BREAK - oldGutter;

    const onCode = stroke(100, 1500);
    const [moved] = reanchorInkOps(stacked, rebroken, [onCode]);
    expect(ys(moved)).toEqual([1500 + shift, 1510 + shift]);
  });

  it("leaves ink alone when nothing moved", () => {
    const ops = [stroke(100, 1200), stroke(100, 3500)];
    // Same array back, not a copy — the common case allocates nothing.
    expect(reanchorInkOps(before, before, ops)).toBe(ops);
  });

  it("has nothing to do for a board with no ink", () => {
    const ops: InkOp[] = [];
    expect(reanchorInkOps(before, [frame("constraints", 0, 1300)], ops)).toBe(ops);
  });

  /** Work off the board entirely is nobody's page, and stays put. */
  it("leaves stray ink where it was drawn", () => {
    const after = [
      frame("constraints", 0, 1300),
      frame("code", 1364, 2352),
      frame("approach", 3780, 2380),
    ];
    const stray = stroke(-9000, -9000);
    const [kept] = reanchorInkOps(before, after, [stray]);
    expect(ys(kept)).toEqual([-9000, -8990]);
  });

  it("moves an erase op with the page too", () => {
    const after = [
      frame("constraints", 0, 900),
      frame("code", 964, 2352),
      frame("approach", 3780, 2380),
    ];
    const erase: InkOp = {
      kind: "erase",
      radius: 20,
      points: [{ x: 100, y: 3500, pressure: 0.5 }],
    };
    const [moved] = reanchorInkOps(before, after, [erase]);
    expect(moved.kind).toBe("erase");
    expect(ys(moved)).toEqual([3900]);
  });
});
