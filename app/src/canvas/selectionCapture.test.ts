import { expect, it } from "vitest";
import { selectionCaptureFrame } from "./selectionCapture";
it("uses pane offset and live camera for a zoomed multi-line selection", () => {
  expect(selectionCaptureFrame({ left: 120, top: 260, width: 400, height: 300 },
    { offsetLeft: 20, offsetTop: 60, scrollX: -50, scrollY: -900, zoom: 2 }))
    .toEqual({ x: 100, y: 1000, width: 200, height: 150 });
});
it("rejects an empty selection instead of exporting the whole board", () => {
  expect(() => selectionCaptureFrame({ left: 0, top: 0, width: 0, height: 0 },
    { offsetLeft: 0, offsetTop: 0, scrollX: 0, scrollY: 0, zoom: 1 })).toThrow();
});
