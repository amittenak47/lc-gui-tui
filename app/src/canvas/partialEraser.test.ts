import { describe, expect, it } from "vitest";

import {
  eraseFreedrawAt,
  eraseSceneAt,
  eraserSceneRadius,
  eraserScreenRadius,
  freedrawFromAbsolutePoints,
} from "./partialEraser";

function stroke(
  id: string,
  points: Array<[number, number]>,
  extras: Record<string, unknown> = {},
) {
  const pressures = points.map((_, index) => 0.2 + index * 0.05);
  return {
    id,
    type: "freedraw",
    x: 0,
    y: 0,
    points,
    pressures,
    simulatePressure: false,
    width: 100,
    height: 0,
    version: 1,
    ...extras,
  };
}

describe("eraser radius", () => {
  it("scales continuously with the slider", () => {
    expect(eraserSceneRadius(1)).toBe(1.75);
    expect(eraserSceneRadius(4)).toBe(7);
    expect(eraserSceneRadius(2)).toBeLessThan(eraserSceneRadius(6));
  });

  it("scales the on-screen preview with zoom", () => {
    const scene = eraserSceneRadius(2);
    expect(eraserScreenRadius(2, 1)).toBe(scene);
    expect(eraserScreenRadius(2, 0.5)).toBe(scene * 0.5);
    expect(eraserScreenRadius(2, 2)).toBe(scene * 2);
  });
});

describe("eraseFreedrawAt", () => {
  it("removes only the middle of a stroke and splits into two", () => {
    const element = stroke("a", [
      [0, 0],
      [10, 0],
      [20, 0],
      [30, 0],
      [40, 0],
      [50, 0],
    ]);
    const pieces = eraseFreedrawAt(element, 25, 0, 6);
    expect(pieces).toHaveLength(2);
    expect(pieces[0].id).toBe("a");
    expect(pieces[1].id).not.toBe("a");
    expect(pieces[0].points!.length).toBeGreaterThanOrEqual(2);
    expect(pieces[1].points!.length).toBeGreaterThanOrEqual(2);
  });

  it("preserves per-point pressure after a cut", () => {
    const element = stroke("a", [
      [0, 0],
      [20, 0],
      [40, 0],
    ]);
    const pieces = eraseFreedrawAt(element, 20, 0, 5);
    expect(pieces.length).toBeGreaterThanOrEqual(1);
    for (const piece of pieces) {
      expect(piece.pressures?.length).toBe(piece.points?.length);
      expect(piece.simulatePressure).toBe(false);
      for (const pressure of piece.pressures ?? []) {
        expect(pressure).toBeLessThan(0.35);
      }
    }
  });

  it("deletes a stroke fully covered by the brush", () => {
    const element = stroke("a", [
      [0, 0],
      [2, 0],
      [4, 0],
    ]);
    expect(eraseFreedrawAt(element, 2, 0, 10)).toEqual([]);
  });

  it("leaves a stroke alone when the brush misses", () => {
    const element = stroke("a", [
      [0, 0],
      [10, 0],
      [20, 0],
    ]);
    const pieces = eraseFreedrawAt(element, 0, 100, 5);
    expect(pieces).toHaveLength(1);
    expect(pieces[0]).toBe(element);
  });
});

describe("eraseSceneAt", () => {
  it("skips locked / template / coach elements", () => {
    const scene = [
      stroke("ink", [
        [0, 0],
        [20, 0],
        [40, 0],
        [60, 0],
        [80, 0],
      ]),
      stroke(
        "tmpl",
        [
          [0, 0],
          [80, 0],
        ],
        { locked: true, customData: { lcRegion: "approach" } },
      ),
    ];
    const next = eraseSceneAt(scene, 40, 0, 8)!;
    expect(next.find((el) => el.id === "tmpl")).toEqual(scene[1]);
    expect(next.some((el) => el.id === "tmpl" && el.isDeleted)).toBe(false);
    expect(next.filter((el) => el.id === "tmpl")).toHaveLength(1);
    expect(next.some((el) => el.type === "freedraw" && el.id !== "tmpl" && !el.isDeleted)).toBe(
      true,
    );
  });

  it("returns null when nothing changed", () => {
    const scene = [
      stroke("ink", [
        [0, 0],
        [10, 0],
      ]),
    ];
    expect(eraseSceneAt(scene, 100, 100, 5)).toBeNull();
  });
});

describe("freedrawFromAbsolutePoints", () => {
  it("normalizes the first point to the origin", () => {
    const rebuilt = freedrawFromAbsolutePoints(
      stroke("a", [
        [0, 0],
        [1, 0],
      ]),
      [
        { x: 50, y: 60, pressure: 0.2 },
        { x: 70, y: 60, pressure: 0.25 },
      ],
      { keepId: true },
    );
    expect(rebuilt.x).toBe(50);
    expect(rebuilt.y).toBe(60);
    expect(rebuilt.points?.[0]).toEqual([0, 0]);
    expect(rebuilt.points?.[1]).toEqual([20, 0]);
    expect(rebuilt.pressures).toEqual([0.2, 0.25]);
  });
});
