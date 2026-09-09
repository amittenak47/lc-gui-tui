import { describe, expect, it } from "vitest";

import {
  SCRATCH_PAGE_GUTTER,
  SCRATCH_PAGE_H,
  SCRATCH_PAGE_W,
  scratchPageOrigin,
  whiteboardMergeFrames,
  whiteboardPageFromView,
  whiteboardPageFramesFromElements,
  whiteboardPageFramesFromPad,
  whiteboardSavedCamera,
} from "./whiteboard";

describe("whiteboardSavedCamera", () => {
  it("returns the saved zoom and scroll, not a width-fit", () => {
    const saved = whiteboardSavedCamera({
      scrollX: 12,
      scrollY: -80,
      zoom: 0.4,
    });
    expect(saved).toEqual({ scrollX: 12, scrollY: -80, zoom: 0.4 });
    const widthFit = 800 / SCRATCH_PAGE_W;
    expect(saved?.zoom).not.toBeCloseTo(widthFit);
  });

  it("reads Excalidraw's { value } zoom shape", () => {
    expect(
      whiteboardSavedCamera({ scrollX: 0, scrollY: 0, zoom: { value: 0.4 } }),
    ).toEqual({ scrollX: 0, scrollY: 0, zoom: 0.4 });
  });

  it("treats a missing camera as a fresh fit", () => {
    expect(whiteboardSavedCamera(undefined)).toBeNull();
    expect(whiteboardSavedCamera({})).toBeNull();
    expect(whiteboardSavedCamera({ zoom: 0 })).toBeNull();
    expect(whiteboardSavedCamera({ zoom: -1, scrollX: 0, scrollY: 0 })).toBeNull();
  });
});

describe("whiteboardPageFromView", () => {
  it("lands on page 0 when the camera is at the origin", () => {
    expect(whiteboardPageFromView(0, 3)).toBe(0);
  });

  it("picks the page whose frame contains the view top", () => {
    const page1Top = scratchPageOrigin(1).y;
    expect(whiteboardPageFromView(-page1Top, 4)).toBe(1);
    expect(whiteboardPageFromView(-(page1Top + 10), 4)).toBe(1);
    expect(whiteboardPageFromView(-(page1Top - 1), 4)).toBe(0);
  });

  it("clamps to the notebook's last page", () => {
    const far = scratchPageOrigin(8).y;
    expect(whiteboardPageFromView(-far, 2)).toBe(1);
    expect(whiteboardPageFromView(50, 3)).toBe(0);
  });

  it("uses the same pitch as the template stack", () => {
    expect(scratchPageOrigin(2).y).toBe(2 * (SCRATCH_PAGE_H + SCRATCH_PAGE_GUTTER));
  });
});

describe("whiteboardMergeFrames", () => {
  it("stays one sheet when the ink fits on page 1", () => {
    expect(whiteboardMergeFrames(1, 400).map((frame) => frame.pageId)).toEqual([1]);
  });

  it("tiles a grown page-1 pad into template-height sheets", () => {
    const frames = whiteboardMergeFrames(1, SCRATCH_PAGE_H * 2.5);
    expect(frames.length).toBeGreaterThan(1);
    expect(frames[0]!.maxY).toBe(SCRATCH_PAGE_H + SCRATCH_PAGE_GUTTER);
    expect(frames[1]!.minY).toBe(SCRATCH_PAGE_H + SCRATCH_PAGE_GUTTER);
  });
});

describe("whiteboardPageFramesFromElements", () => {
  it("reads live grown page heights instead of the template 4200", () => {
    const frames = whiteboardPageFramesFromElements([
      {
        y: 0,
        height: 8000,
        customData: { lcScratchFrame: true, lcScratchPage: 0 },
      },
      {
        y: 8064,
        height: 4200,
        customData: { lcScratchFrame: true, lcScratchPage: 1 },
      },
    ]);
    expect(frames).toEqual([
      { pageId: 1, minY: 0, maxY: 8000 },
      { pageId: 2, minY: 8064, maxY: 12264 },
    ]);
  });

  it("reads the same frames out of a frozen pad JSON", () => {
    const frames = whiteboardPageFramesFromPad({
      board: {
        elements: [
          {
            y: 0,
            height: 8000,
            customData: { lcScratchFrame: true, lcScratchPage: 0 },
          },
          {
            y: 8064,
            height: 4200,
            customData: { lcScratchFrame: true, lcScratchPage: 1 },
          },
        ],
      },
    });
    expect(frames.map((frame) => frame.pageId)).toEqual([1, 2]);
  });
});
