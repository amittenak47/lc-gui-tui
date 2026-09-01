import { createCanvas, type Canvas } from "@napi-rs/canvas";
import { describe, expect, it } from "vitest";

import {
  applyInkOp,
  INK_SLOWNESS_NEUTRAL,
  NO_PRESSURE,
  paintLiveDrawMaskRange,
  type InkDrawOp,
} from "./rasterInk";

function context(canvas: Canvas): CanvasRenderingContext2D {
  return canvas.getContext("2d") as unknown as CanvasRenderingContext2D;
}

function pixels(canvas: Canvas): Uint8ClampedArray {
  return context(canvas).getImageData(0, 0, canvas.width, canvas.height).data;
}

function longCornerStroke(): InkDrawOp {
  const xy: Array<[number, number]> = [
    [20, 140],
    [60, 140],
    [95, 140],
    [110, 125],
    [110, 80],
    [110, 35],
    [155, 35],
    [185, 60],
  ];
  return {
    kind: "draw",
    color: "#d71958",
    baseWidth: 12,
    maxFullness: 0.92,
    pressureClip: 1,
    pressureSensitive: false,
    speedInk: 0.8,
    speedBlotBlend: 0.55,
    speedFade: 0.7,
    grain: 0.65,
    points: xy.map(([x, y]) => ({
      x,
      y,
      pressure: NO_PRESSURE,
      slowness: INK_SLOWNESS_NEUTRAL,
    })),
  };
}

describe("live stroke mask pixels", () => {
  it("matches full replay at an internal corner without a transparent tear", () => {
    const op = longCornerStroke();
    const full = createCanvas(220, 180);
    applyInkOp(context(full), op, 1);

    const mask = createCanvas(220, 180);
    const maskCtx = context(mask);
    const prefix = paintLiveDrawMaskRange(maskCtx, op, 0, 3, 1, true, false);
    const tail = paintLiveDrawMaskRange(maskCtx, op, 3, op.points.length - 1, 1, false, true);
    const split = createCanvas(220, 180);
    const splitCtx = context(split);
    splitCtx.globalAlpha = Math.max(prefix.alpha, tail.alpha);
    splitCtx.drawImage(mask as unknown as CanvasImageSource, 0, 0);

    const expected = pixels(full);
    const actual = pixels(split);
    let fullInk = 0;
    let materiallyDifferent = 0;
    for (let i = 0; i < expected.length; i += 4) {
      const fullAlpha = expected[i + 3]!;
      const splitAlpha = actual[i + 3]!;
      if (fullAlpha > 8) fullInk += 1;
      if (Math.abs(fullAlpha - splitAlpha) > 24) materiallyDifferent += 1;
    }
    expect(fullInk).toBeGreaterThan(1000);
    expect(materiallyDifferent / fullInk).toBeLessThan(0.03);

    // The old sliced renderer left its paper wedge at this promotion vertex.
    for (let y = 119; y <= 131; y += 1) {
      for (let x = 104; x <= 116; x += 1) {
        const at = (y * 220 + x) * 4 + 3;
        if (expected[at]! > 32) expect(actual[at]).toBeGreaterThan(0);
      }
    }
  });
});
