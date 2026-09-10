import { describe, expect, it } from "vitest";
import { transitionViz } from "./transition";
import type { PaintSceneElement } from "../canvas/paintScene";

const box: PaintSceneElement = { id: "cell", type: "rectangle", x: 0, y: 0, width: 52, height: 52, backgroundColor: "#000000" };

describe("viz presentation", () => {
  it("moves persistent cells and blends emphasis without mutating the saved frame", () => {
    const target = { ...box, x: 100, backgroundColor: "#ffffff" };
    const mid = transitionViz([box], [target], 0.5)[0]!;
    expect(mid.x).toBeGreaterThan(50);
    expect(mid.x).toBeLessThan(100);
    expect(mid.backgroundColor).toBe("#dfdfdf");
    expect(box.x).toBe(0);
    expect(target.x).toBe(100);
    expect(transitionViz([box], [target], 1)).toEqual([target]);
  });
  it("introduces new cells and removes absent cells without leaving ghosts", () => {
    const next = { ...box, id: "new" };
    expect(transitionViz([box], [next], 0)[0]?.opacity).toBe(0);
    expect(transitionViz([box], [], 0.5)).toEqual([]);
  });
  it("interpolates arrow endpoints", () => {
    const arrow = { ...box, type: "arrow", points: [[0, 0], [50, 0]] as Array<[number, number]> };
    const next = { ...arrow, points: [[0, 0], [100, 20]] as Array<[number, number]> };
    const mid = transitionViz([arrow], [next], 0.5)[0]!;
    expect(mid.points![1]![0]).toBeGreaterThan(50);
    expect(mid.points![1]![0]).toBeLessThan(100);
    expect(mid.points![1]![1]).toBeGreaterThan(0);
  });
});
