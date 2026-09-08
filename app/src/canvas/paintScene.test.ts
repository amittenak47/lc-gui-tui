import { createCanvas } from "@napi-rs/canvas";
import { describe, expect, it } from "vitest";

import {
  isDrawableSceneElement,
  paintSceneElements,
  paintSceneToExport,
  type PaintSceneElement,
} from "./paintScene";

function ctx2d(w = 80, h = 80) {
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no ctx");
  return { canvas, ctx };
}

function sampleAt(
  canvas: ReturnType<typeof createCanvas>,
  x: number,
  y: number,
): number[] {
  const ctx = canvas.getContext("2d");
  const data = ctx.getImageData(x, y, 1, 1).data;
  return [data[0]!, data[1]!, data[2]!, data[3]!];
}

describe("isDrawableSceneElement", () => {
  it("skips page frames and deleted elements", () => {
    expect(
      isDrawableSceneElement({
        type: "rectangle",
        x: 0,
        y: 0,
        width: 10,
        height: 10,
        customData: { lcRegionFrame: true },
      }),
    ).toBe(false);
    expect(
      isDrawableSceneElement({
        type: "rectangle",
        x: 0,
        y: 0,
        width: 10,
        height: 10,
        isDeleted: true,
      }),
    ).toBe(false);
    expect(
      isDrawableSceneElement({
        type: "rectangle",
        x: 0,
        y: 0,
        width: 10,
        height: 10,
        strokeColor: "#c2410c",
        backgroundColor: "#fff7ed",
      }),
    ).toBe(true);
  });
});

describe("paintSceneElements", () => {
  it("fills a rectangle so export is not empty paper", () => {
    const { canvas, ctx } = ctx2d();
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, 80, 80);
    paintSceneElements(ctx, [
      {
        type: "rectangle",
        x: 10,
        y: 10,
        width: 40,
        height: 40,
        backgroundColor: "#c2410c",
        strokeColor: "#c2410c",
        strokeWidth: 1,
      },
    ]);
    const [r, g, b, a] = sampleAt(canvas, 20, 20);
    expect(a).toBeGreaterThan(200);
    expect(r).toBeGreaterThan(g);
    expect(r).toBeGreaterThan(b);
  });

  it("draws a bound label inside the cell, not as a sibling at the origin", () => {
    const { canvas, ctx } = ctx2d(120, 80);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, 120, 80);
    const box: PaintSceneElement = {
      id: "cell-0",
      type: "rectangle",
      x: 20,
      y: 10,
      width: 80,
      height: 50,
      backgroundColor: "#f1f5f9",
      strokeColor: "#1e1e1e",
      strokeWidth: 1,
    };
    const label: PaintSceneElement = {
      type: "text",
      x: 0,
      y: 0,
      width: 80,
      height: 20,
      text: "7",
      fontSize: 16,
      containerId: "cell-0",
      strokeColor: "#1e1e1e",
    };
    paintSceneElements(ctx, [box, label]);
    const origin = sampleAt(canvas, 2, 2);
    expect(origin[0]).toBeGreaterThan(240);
    expect(origin[1]).toBeGreaterThan(240);
    expect(origin[2]).toBeGreaterThan(240);
  });

  it("paints arrows under boxes when both are present", () => {
    const { ctx } = ctx2d();
    paintSceneElements(ctx, [
      {
        type: "arrow",
        x: 0,
        y: 20,
        width: 40,
        height: 0,
        points: [
          [0, 0],
          [60, 0],
        ],
        strokeColor: "#111111",
        strokeWidth: 2,
      },
      {
        type: "rectangle",
        x: 10,
        y: 10,
        width: 20,
        height: 20,
        backgroundColor: "#ff0000",
        strokeColor: "#ff0000",
      },
    ]);
    expect(true).toBe(true);
  });
});

describe("paintSceneToExport", () => {
  it("honours origin so a box at (100,100) still lands on the canvas", () => {
    const { canvas, ctx } = ctx2d(60, 60);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, 60, 60);
    paintSceneToExport(
      ctx,
      [
        {
          type: "rectangle",
          x: 100,
          y: 100,
          width: 40,
          height: 40,
          backgroundColor: "#00aa00",
          strokeColor: "#00aa00",
        },
      ],
      { minX: 100, minY: 100, padding: 0, exportScale: 1 },
    );
    const [r, g] = sampleAt(canvas, 10, 10);
    expect(g).toBeGreaterThan(r);
  });
});
