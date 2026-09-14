import { describe, expect, it } from "vitest";
import { trailDistances, trailingPoints } from "./loadingDoodleTrail";

describe("loading doodle trailing erase", () => {
  const points = [0, 1, 10, 100].map((x) => ({ x, y: 0, pressure: x / 100 }));
  const distances = trailDistances(points);
  it("sweeps from the start at constant distance despite uneven sampling", () => {
    const tail = trailingPoints(points, distances, 0.5);
    expect(tail).toEqual([{ x: 50, y: 0, pressure: 0.5 }, points[3]]);
    expect(trailingPoints(points, distances, 0)).toBe(points);
    expect(trailingPoints(points, distances, 1)).toEqual([]);
  });
  it("handles dots and repeated points without invalid coordinates", () => {
    const dots = [points[0]!, points[0]!];
    expect(trailingPoints(dots, trailDistances(dots), 0.5)).toEqual([points[0]]);
    expect(trailingPoints([], [], 0.5)).toEqual([]);
  });
});
