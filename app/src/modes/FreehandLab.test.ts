import { describe, expect, it } from "vitest";
import { getStroke } from "perfect-freehand";

import { fillFreehandOutline, freehandStrokeOptions } from "./FreehandLab";

describe("perfect-freehand lab", () => {
  it("builds an outline from a handful of pointer samples", () => {
    const outline = getStroke(
      [
        [0, 0, 0.5],
        [12, 3, 0.5],
        [28, 10, 0.5],
        [40, 8, 0.5],
      ],
      freehandStrokeOptions(true, true),
    );
    expect(outline.length).toBeGreaterThan(8);
    expect(outline[0]).toHaveLength(2);
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
    fillFreehandOutline(ctx, [
      [0, 0],
      [10, 0],
      [10, 8],
    ]);
    expect(moves[0]).toBe("begin");
    expect(moves[moves.length - 1]).toBe("fill");
    expect(moves).toContain("Z");
  });
});
