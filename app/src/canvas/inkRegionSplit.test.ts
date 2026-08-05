import { describe, expect, it } from "vitest";

import { inkRegionSplit } from "./inkRegionSplit";

const frame = { x: 0, y: 0, width: 1000, height: 3000 };

describe("inkRegionSplit", () => {
  it("returns nothing for empty input", () => {
    expect(inkRegionSplit(frame, [])).toEqual([]);
  });

  it("clusters boxes separated by a large Y gap", () => {
    const rects = inkRegionSplit(frame, [
      { x: 100, y: 200, width: 200, height: 100 },
      { x: 120, y: 280, width: 180, height: 80 },
      { x: 150, y: 900, width: 300, height: 120 },
    ]);
    expect(rects).toHaveLength(2);
    expect(rects[0].y).toBeLessThan(400);
    expect(rects[1].y).toBeGreaterThan(800);
  });

  it("merges overlapping clusters after padding", () => {
    const rects = inkRegionSplit(
      frame,
      [
        { x: 100, y: 200, width: 200, height: 100 },
        { x: 110, y: 250, width: 180, height: 90 },
      ],
      80,
      8,
    );
    expect(rects).toHaveLength(1);
  });
});
