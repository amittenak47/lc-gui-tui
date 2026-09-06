import { describe, expect, it } from "vitest";
import { getStroke } from "perfect-freehand";

import {
  fillSplineOutline,
  splineInput,
  splineOutline,
  splineRails,
  splineStrokeOptions,
  SPLINE_STREAMLINE,
} from "./splineInk";

const opts = splineStrokeOptions(16, 0.6, true, false);

describe("splineInk", () => {
  it("builds a closed outline from pointer samples", () => {
    const samples = [
      { x: 0, y: 0, pressure: 0.5 },
      { x: 12, y: 3, pressure: 0.5 },
      { x: 28, y: 10, pressure: 0.5 },
      { x: 40, y: 8, pressure: 0.5 },
    ];
    const outline = splineOutline(samples, opts);
    expect(outline.length).toBeGreaterThan(8);
    expect(outline).toEqual(getStroke(splineInput(samples), {
      size: 16,
      thinning: 0.6,
      smoothing: 0.5,
      streamline: SPLINE_STREAMLINE,
      simulatePressure: false,
      last: true,
    }));
  });

  it("places left and right rails around the spine", () => {
    const rails = splineRails(
      [
        { x: 0, y: 0, pressure: 0.5 },
        { x: 40, y: 0, pressure: 0.5 },
      ],
      opts,
    );
    expect(rails.length).toBeGreaterThan(1);
    const mid = rails[Math.floor(rails.length / 2)]!;
    expect(Math.hypot(mid.rx - mid.lx, mid.ry - mid.ly)).toBeGreaterThan(4);
    expect(mid.u).toBeGreaterThanOrEqual(0);
    expect(mid.u).toBeLessThanOrEqual(1);
  });

  it("fills a closed outline", () => {
    const moves: string[] = [];
    const ctx = {
      beginPath() {
        moves.push("begin");
      },
      moveTo(x: number, y: number) {
        moves.push(`M${x},${y}`);
      },
      lineTo(x: number, y: number) {
        moves.push(`L${x},${y}`);
      },
      closePath() {
        moves.push("Z");
      },
      fill() {
        moves.push("fill");
      },
    } as unknown as CanvasRenderingContext2D;
    fillSplineOutline(ctx, [
      [0, 0],
      [10, 0],
      [10, 8],
    ]);
    expect(moves[0]).toBe("begin");
    expect(moves[moves.length - 1]).toBe("fill");
    expect(moves).toContain("Z");
  });
});
