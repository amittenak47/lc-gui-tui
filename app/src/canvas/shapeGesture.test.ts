import { describe, expect, it } from "vitest";

import {
  flipElement,
  hitTestScene,
  insertLinearMid,
  isSelectableSceneElement,
  MIN_SHAPE_SPAN,
  rotateDeltaFromDrag,
  rotateElement,
  rotateAbout,
  scaleElement,
  sceneElementBounds,
  shapeSpan,
  skeletonFromDrag,
  snapAngle,
  magnetOrthogonal,
  elementsIntersectingBox,
} from "./shapeGesture";

describe("skeletonFromDrag", () => {
  it("normalises a rectangle so width and height are positive", () => {
    const sk = skeletonFromDrag("rectangle", 40, 40, 10, 20, {
      stroke: "#111",
      fill: "#eee",
      width: 2,
    });
    expect(sk.x).toBe(10);
    expect(sk.y).toBe(20);
    expect(sk.width).toBe(30);
    expect(sk.height).toBe(20);
    expect(sk.type).toBe("rectangle");
  });

  it("emits a diamond with positive box size", () => {
    const sk = skeletonFromDrag("diamond", 0, 0, 20, 16, {
      stroke: "#111",
      fill: "transparent",
      width: 2,
    });
    expect(sk.type).toBe("diamond");
    expect(sk.width).toBe(20);
    expect(sk.height).toBe(16);
  });

  it("keeps an arrow as points from the press", () => {
    const sk = skeletonFromDrag("arrow", 0, 0, 30, 10, {
      stroke: "#111",
      fill: "transparent",
      width: 2,
    });
    expect(sk.points).toEqual([
      [0, 0],
      [30, 10],
    ]);
  });

  it("treats a tiny drag as below the tap floor", () => {
    expect(shapeSpan(0, 0, 1, 1) < MIN_SHAPE_SPAN).toBe(true);
  });
});

describe("hitTestScene", () => {
  it("ignores locked viz and page frames", () => {
    const hit = hitTestScene(
      [
        {
          type: "rectangle",
          x: 0,
          y: 0,
          width: 50,
          height: 50,
          customData: { lcVizId: "a" },
          locked: true,
        },
        {
          type: "rectangle",
          x: 0,
          y: 0,
          width: 50,
          height: 50,
          customData: { lcRegionFrame: true },
        },
        { id: "stamp", type: "rectangle", x: 0, y: 0, width: 50, height: 50 },
      ],
      10,
      10,
    );
    expect(hit?.id).toBe("stamp");
  });

  it("does not select a coach diagram even if unlocked", () => {
    expect(
      isSelectableSceneElement({
        type: "rectangle",
        x: 0,
        y: 0,
        width: 10,
        height: 10,
        customData: { lcVizId: "p" },
      }),
    ).toBe(false);
  });
});

describe("transforms", () => {
  it("rotates a box around its angle field", () => {
    const next = rotateElement(
      { type: "rectangle", x: 0, y: 0, width: 10, height: 10, angle: 0 },
      Math.PI / 2,
    );
    expect(next.angle).toBeCloseTo(Math.PI / 2);
  });

  it("inserts a midpoint so an arrow can curve", () => {
    const next = insertLinearMid(
      {
        type: "arrow",
        x: 0,
        y: 0,
        points: [
          [0, 0],
          [10, 0],
        ],
      },
      0,
    );
    expect(next.points).toHaveLength(3);
    expect(next.points?.[1]).toEqual([5, 0]);
  });

  it("lets the south-east handle cross the opposite edge", () => {
    const next = scaleElement(
      { type: "rectangle", x: 0, y: 0, width: 10, height: 10 },
      "se",
      -20,
      30,
    );
    expect(next.x).toBeCloseTo(-20);
    expect(next.y).toBeCloseTo(0);
    expect(next.width).toBeCloseTo(20);
    expect(next.height).toBeCloseTo(30);
  });

  it("resizes from an edge without changing the other axis", () => {
    const next = scaleElement(
      { type: "rectangle", x: 0, y: 0, width: 10, height: 10 },
      "e",
      40,
      5,
    );
    expect(next.x).toBe(0);
    expect(next.y).toBe(0);
    expect(next.width).toBe(40);
    expect(next.height).toBe(10);
  });

  it("scales a rotated box along its own width", () => {
    const next = scaleElement(
      { type: "rectangle", x: 0, y: 0, width: 20, height: 10, angle: Math.PI / 2 },
      "e",
      10,
      25,
    );
    expect(next.width).toBeCloseTo(30);
    expect(next.height).toBeCloseTo(10);
    expect(next.angle).toBeCloseTo(Math.PI / 2);
    expect(next.x + next.width / 2).toBeCloseTo(10);
    expect(next.y + next.height / 2).toBeCloseTo(10);
  });

  it("flips an arrow's points across the vertical midline", () => {
    const next = flipElement(
      {
        type: "arrow",
        x: 0,
        y: 0,
        points: [
          [0, 0],
          [10, 0],
        ],
      },
      "h",
    );
    expect(next.points?.[0]?.[0]).toBeCloseTo(10);
    expect(next.points?.[1]?.[0]).toBeCloseTo(0);
  });

  it("remaps an arrow's world points when scaled from the south-east", () => {
    const next = scaleElement(
      {
        type: "arrow",
        x: 0,
        y: 0,
        points: [
          [0, 0],
          [10, 10],
        ],
      },
      "se",
      20,
      20,
    );
    expect(next.x).toBeCloseTo(0);
    expect(next.y).toBeCloseTo(0);
    expect(next.points?.[1]).toEqual([20, 20]);
  });

  it("grows the AABB of a rotated box", () => {
    const b = sceneElementBounds({
      type: "rectangle",
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      angle: Math.PI / 4,
    });
    expect(b.maxX - b.minX).toBeGreaterThan(10);
  });

  it("measures a rotate drag as a right angle", () => {
    expect(rotateDeltaFromDrag(0, 0, 1, 0, 0, 1)).toBeCloseTo(Math.PI / 2);
  });

  it("orbits a box around a group centre", () => {
    const next = rotateAbout(
      { type: "rectangle", x: 10, y: 0, width: 10, height: 10, angle: 0 },
      0,
      5,
      Math.PI / 2,
    );
    expect(next.x + 5).toBeCloseTo(0);
    expect(next.y + 5).toBeCloseTo(20);
    expect(next.angle).toBeCloseTo(Math.PI / 2);
  });

  it("snaps a free angle onto the nearest orthogonal", () => {
    expect(snapAngle(0.2)).toBeCloseTo(0);
    expect(snapAngle(Math.PI / 2 - 0.1)).toBeCloseTo(Math.PI / 2);
  });

  it("magnets only when close to square", () => {
    expect(magnetOrthogonal(0.02)).toBeCloseTo(0);
    expect(magnetOrthogonal(Math.PI / 6)).toBeCloseTo(Math.PI / 6);
  });

  it("selects every stamp that intersects a marquee", () => {
    const hit = elementsIntersectingBox(
      [
        { id: "in", type: "rectangle", x: 0, y: 0, width: 10, height: 10 },
        { id: "out", type: "rectangle", x: 80, y: 80, width: 10, height: 10 },
      ],
      { minX: -1, minY: -1, maxX: 5, maxY: 5 },
    );
    expect(hit.map((el) => el.id)).toEqual(["in"]);
  });
});
