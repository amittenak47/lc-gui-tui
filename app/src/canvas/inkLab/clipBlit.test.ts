import { describe, expect, it } from "vitest";

import { emptyAabb } from "./instance";
import { CLIP_BLIT_PAD, clipBlitRect, intersectPixelRects, SDF_SCISSOR_PAD } from "./clipBlit";

describe("clipBlitRect", () => {
  it("returns null for an empty box", () => {
    expect(clipBlitRect(emptyAabb(), 800, 600)).toBeNull();
  });

  it("pads and clamps to the canvas", () => {
    const clip = clipBlitRect(
      { minX: 10, minY: 20, maxX: 40, maxY: 50 },
      800,
      600,
      6,
    );
    expect(clip).toEqual({ x: 4, y: 14, w: 42, h: 42 });
  });

  it("does not extend past the canvas edge", () => {
    const clip = clipBlitRect(
      { minX: 790, minY: -4, maxX: 900, maxY: 8 },
      800,
      600,
      6,
    );
    expect(clip).toEqual({ x: 784, y: 0, w: 16, h: 14 });
  });

  it("scissors farther than the blit so a cap box cannot land in the snap", () => {
    expect(SDF_SCISSOR_PAD).toBeGreaterThan(CLIP_BLIT_PAD);
  });

  it("intersects pixel boxes", () => {
    expect(
      intersectPixelRects({ x: 0, y: 0, w: 40, h: 20 }, { x: 30, y: 10, w: 20, h: 20 }),
    ).toEqual({ x: 30, y: 10, w: 10, h: 10 });
    expect(
      intersectPixelRects({ x: 0, y: 0, w: 10, h: 10 }, { x: 20, y: 20, w: 5, h: 5 }),
    ).toBeNull();
  });
});
