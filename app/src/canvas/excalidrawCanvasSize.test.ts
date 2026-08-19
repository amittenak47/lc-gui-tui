import { describe, expect, it } from "vitest";

import { applyExcalidrawCanvasBox, canvasBufferSize } from "./excalidrawCanvasSize";

describe("canvasBufferSize", () => {
  it("multiplies CSS size by device pixel ratio", () => {
    expect(canvasBufferSize(400, 300, 2)).toEqual({ width: 800, height: 600 });
  });

  it("never writes a zero buffer", () => {
    expect(canvasBufferSize(0, 0, 1)).toEqual({ width: 1, height: 1 });
  });
});

describe("applyExcalidrawCanvasBox", () => {
  it("sets CSS pixels and the backing store", () => {
    const canvas = { style: { width: "", height: "" }, width: 1, height: 1 };
    applyExcalidrawCanvasBox(canvas, 390, 800, 2);
    expect(canvas.style.width).toBe("390px");
    expect(canvas.style.height).toBe("800px");
    expect(canvas.width).toBe(780);
    expect(canvas.height).toBe(1600);
  });
});
