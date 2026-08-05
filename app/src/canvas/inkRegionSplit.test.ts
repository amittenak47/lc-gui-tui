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

  describe("with a screenful bound", () => {
    /** Twelve lines of continuous writing — no gap big enough to cluster on. */
    const continuous = Array.from({ length: 12 }, (_, index) => ({
      x: 100,
      y: 100 + index * 90,
      width: 400,
      height: 60,
    }));

    it("cuts a page taller than a screen into screenfuls", () => {
      const unbounded = inkRegionSplit(frame, continuous);
      expect(unbounded).toHaveLength(1);
      expect(unbounded[0].height).toBeGreaterThan(900);

      const bounded = inkRegionSplit(frame, continuous, 100, 16, 400);
      expect(bounded.length).toBeGreaterThan(1);
      for (const rect of bounded) {
        expect(rect.height).toBeLessThanOrEqual(400 + 32);
      }
    });

    it("cuts between marks, never through one", () => {
      const bounded = inkRegionSplit(frame, continuous, 100, 16, 400);
      // Every box must sit wholly inside exactly one crop, or the agent is
      // handed half a drawing and asked what it means.
      for (const box of continuous) {
        const containing = bounded.filter(
          (rect) => box.y >= rect.y && box.y + box.height <= rect.y + rect.height,
        );
        expect(containing).toHaveLength(1);
      }
    });

    it("hands the bands over in reading order", () => {
      const padding = 16;
      const bounded = inkRegionSplit(frame, continuous, 100, padding, 400);
      for (let i = 1; i < bounded.length; i += 1) {
        const previousBottom = bounded[i - 1].y + bounded[i - 1].height;
        expect(bounded[i].y).toBeGreaterThan(bounded[i - 1].y);
        // Consecutive bands may share their padding — a sliver of the line
        // above is context, not duplication — but never more than that.
        expect(previousBottom - bounded[i].y).toBeLessThanOrEqual(padding * 2);
      }
    });

    it("leaves a single oversized mark whole", () => {
      // Halving one long stroke sends two pictures of nothing.
      const bounded = inkRegionSplit(
        frame,
        [{ x: 0, y: 100, width: 900, height: 1200 }],
        100,
        16,
        400,
      );
      expect(bounded).toHaveLength(1);
      expect(bounded[0].height).toBeGreaterThan(1200);
    });

    it("does nothing when the work already fits a screen", () => {
      const short = [{ x: 100, y: 100, width: 200, height: 80 }];
      expect(inkRegionSplit(frame, short, 100, 16, 400)).toEqual(
        inkRegionSplit(frame, short, 100, 16),
      );
    });
  });
});
