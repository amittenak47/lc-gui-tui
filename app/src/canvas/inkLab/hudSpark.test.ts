import { describe, expect, it, vi } from "vitest";

import { drawFrameSpark, INK_LAB_SPARK_VSYNC_MS } from "./hudSpark";

describe("frame spark", () => {
  it("draws a vsync hairline and the sample polyline", () => {
    const calls: string[] = [];
    const ctx = {
      clearRect: () => calls.push("clear"),
      fillRect: () => calls.push("fill"),
      beginPath: () => calls.push("path"),
      moveTo: () => calls.push("move"),
      lineTo: () => calls.push("line"),
      stroke: () => calls.push("stroke"),
      fillStyle: "",
      strokeStyle: "",
      lineWidth: 0,
    };
    const canvas = {
      width: 168,
      height: 36,
      getContext: () => ctx,
    } as unknown as HTMLCanvasElement;
    drawFrameSpark(canvas, [2, INK_LAB_SPARK_VSYNC_MS, 30]);
    expect(calls).toContain("clear");
    expect(calls.filter((c) => c === "stroke").length).toBe(2);
    expect(ctx.strokeStyle).toBe("rgb(252 165 165)");
  });

  it("no-ops without a 2d context", () => {
    const canvas = {
      width: 168,
      height: 36,
      getContext: () => null,
    } as unknown as HTMLCanvasElement;
    expect(() => drawFrameSpark(canvas, [4, 8])).not.toThrow();
  });

  it("skips the polyline until there are two samples", () => {
    const stroke = vi.fn();
    const ctx = {
      clearRect: () => {},
      fillRect: () => {},
      beginPath: () => {},
      moveTo: () => {},
      lineTo: () => {},
      stroke,
      fillStyle: "",
      strokeStyle: "",
      lineWidth: 0,
    };
    const canvas = {
      width: 168,
      height: 36,
      getContext: () => ctx,
    } as unknown as HTMLCanvasElement;
    drawFrameSpark(canvas, [8]);
    expect(stroke).toHaveBeenCalledTimes(1);
  });
});
