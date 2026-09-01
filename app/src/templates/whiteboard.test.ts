import { describe, expect, it } from "vitest";

import {
  SCRATCH_PAGE_GUTTER,
  SCRATCH_PAGE_H,
  SCRATCH_PAGE_W,
  scratchPageOrigin,
  whiteboardPageFromView,
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
