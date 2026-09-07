import { describe, expect, it } from "vitest";

import { canvasBitmapFromClient, canvasCssFromClient } from "./canvasPointer";

function stubCanvas(opts: {
  width: number;
  height: number;
  clientWidth: number;
  clientHeight: number;
  left: number;
  top: number;
  rectWidth: number;
  rectHeight: number;
}): HTMLCanvasElement {
  return {
    width: opts.width,
    height: opts.height,
    clientWidth: opts.clientWidth,
    clientHeight: opts.clientHeight,
    getBoundingClientRect: () =>
      ({
        left: opts.left,
        top: opts.top,
        width: opts.rectWidth,
        height: opts.rectHeight,
        right: opts.left + opts.rectWidth,
        bottom: opts.top + opts.rectHeight,
        x: opts.left,
        y: opts.top,
        toJSON: () => ({}),
      }) as DOMRect,
  } as HTMLCanvasElement;
}

describe("canvasPointer", () => {
  it("maps the visual centre onto the bitmap centre when CSS zoom shrinks the box", () => {
    const canvas = stubCanvas({
      width: 800,
      height: 176,
      clientWidth: 400,
      clientHeight: 88,
      left: 40,
      top: 20,
      rectWidth: 300,
      rectHeight: 66,
    });
    const mid = canvasBitmapFromClient(canvas, 40 + 150, 20 + 33);
    expect(mid.x).toBeCloseTo(400, 5);
    expect(mid.y).toBeCloseTo(88, 5);
    const css = canvasCssFromClient(canvas, 40 + 150, 20 + 33);
    expect(css.x).toBeCloseTo(200, 5);
    expect(css.y).toBeCloseTo(44, 5);
  });

  it("matches a 1:1 backing store without zoom", () => {
    const canvas = stubCanvas({
      width: 400,
      height: 88,
      clientWidth: 400,
      clientHeight: 88,
      left: 10,
      top: 10,
      rectWidth: 400,
      rectHeight: 88,
    });
    const p = canvasBitmapFromClient(canvas, 10 + 80, 10 + 22);
    expect(p.x).toBeCloseTo(80, 5);
    expect(p.y).toBeCloseTo(22, 5);
  });
});
