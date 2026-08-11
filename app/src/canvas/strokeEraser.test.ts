import { describe, expect, it } from "vitest";

import { NO_PRESSURE, type InkDrawOp, type InkEraseOp, type InkOp } from "./rasterInk";
import { eraseTouchesStroke, opsAfterStrokeErase } from "./strokeEraser";

function stroke(id: string, ...pairs: Array<[number, number]>): InkDrawOp {
  return {
    kind: "draw",
    color: id,
    baseWidth: 2,
    maxFullness: 1,
    pressureClip: 1,
    pressureSensitive: false,
    points: pairs.map(([x, y]) => ({ x, y, pressure: NO_PRESSURE })),
  };
}

function rub(radius: number, ...pairs: Array<[number, number]>): InkEraseOp {
  return {
    kind: "erase",
    radius,
    points: pairs.map(([x, y]) => ({ x, y, pressure: NO_PRESSURE })),
  };
}

describe("eraseTouchesStroke", () => {
  it("takes a stroke the rub crosses", () => {
    expect(eraseTouchesStroke(stroke("a", [0, 0], [100, 0]), rub(4, [50, 0]))).toBe(true);
  });

  it("takes a stroke the rub only grazes", () => {
    // Touching anywhere is the whole point of this mode.
    expect(eraseTouchesStroke(stroke("a", [0, 0], [100, 0]), rub(4, [100, 3]))).toBe(true);
  });

  it("leaves a stroke the rub misses", () => {
    expect(eraseTouchesStroke(stroke("a", [0, 0], [100, 0]), rub(4, [50, 60]))).toBe(false);
  });

  it("measures to the ink, not to the centreline", () => {
    // A fat nib is wider than the points it was stamped along: an eraser held
    // against the visible edge of a thick stroke has plainly touched it.
    const thin = stroke("a", [0, 0], [100, 0]);
    const fat = { ...thin, baseWidth: 20 };
    const beside = rub(1, [50, 12]);
    expect(eraseTouchesStroke(thin, beside)).toBe(false);
    expect(eraseTouchesStroke(fat, beside)).toBe(true);
  });

  it("finds a bend the endpoints do not explain", () => {
    // Bounding boxes would say yes to anything inside the L; segments do not.
    const bent = stroke("a", [0, 0], [0, 100], [100, 100]);
    expect(eraseTouchesStroke(bent, rub(3, [0, 50]))).toBe(true);
    expect(eraseTouchesStroke(bent, rub(3, [50, 40]))).toBe(false);
  });

  it("takes a dot", () => {
    expect(eraseTouchesStroke(stroke("a", [10, 10]), rub(4, [11, 11]))).toBe(true);
    expect(eraseTouchesStroke(stroke("a", [10, 10]), rub(4, [40, 40]))).toBe(false);
  });

  it("has nothing to say about an empty rub or an empty stroke", () => {
    expect(eraseTouchesStroke(stroke("a"), rub(4, [0, 0]))).toBe(false);
    expect(eraseTouchesStroke(stroke("a", [0, 0], [10, 0]), rub(4))).toBe(false);
  });
});

describe("opsAfterStrokeErase", () => {
  const near = stroke("near", [0, 0], [100, 0]);
  const far = stroke("far", [0, 500], [100, 500]);

  it("drops every stroke the rub touched and keeps the rest", () => {
    const out = opsAfterStrokeErase([near, far], rub(4, [50, 0]));
    expect(out).toEqual([far]);
  });

  it("says nothing happened when the rub touched nothing", () => {
    // `null`, not an equal copy: waving the eraser over blank paper is not an
    // edit, and an undo step for it would be one that does nothing visible.
    expect(opsAfterStrokeErase([near, far], rub(4, [50, 250]))).toBeNull();
  });

  it("leaves earlier erases where they are", () => {
    // They are part of how the page got to look this way; dropping one would
    // bring back ink the writer had already taken off.
    const earlier = rub(9, [0, 0], [10, 0]);
    const ops: InkOp[] = [near, earlier, far];
    const out = opsAfterStrokeErase(ops, rub(4, [50, 0]));
    expect(out).toEqual([earlier, far]);
  });

  it("can clear the page", () => {
    expect(opsAfterStrokeErase([near], rub(400, [50, 0]))).toEqual([]);
  });
});
