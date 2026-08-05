import { describe, expect, it } from "vitest";

import {
  buildMdInkTemplate,
  mdInkPageHeight,
  mdInkPageWidthForViewport,
  MD_INK_MIN_PAGE_H,
  MD_INK_PAGE_W,
  MD_INK_PAGE_W_MIN,
  MD_INK_TAIL_PAD,
} from "./mdInk";

describe("mdInkPageHeight", () => {
  it("holds the floor until the document is taller than it", () => {
    expect(mdInkPageHeight(200)).toBe(MD_INK_MIN_PAGE_H);
  });

  it("grows past the floor with room to write under the last line", () => {
    const tall = MD_INK_MIN_PAGE_H * 2;
    expect(mdInkPageHeight(tall)).toBe(tall + MD_INK_TAIL_PAD);
  });

  it("falls back to the floor before the document has been measured", () => {
    // The frame exists for a frame or two before the renderer reports, and a
    // zero-height page would give the ink clip nothing to clip against.
    expect(mdInkPageHeight(null)).toBe(MD_INK_MIN_PAGE_H);
    expect(mdInkPageHeight(0)).toBe(MD_INK_MIN_PAGE_H);
    expect(mdInkPageHeight(Number.NaN)).toBe(MD_INK_MIN_PAGE_H);
  });
});

describe("mdInkPageWidthForViewport", () => {
  it("caps at the Obsidian measure on a wide screen", () => {
    expect(mdInkPageWidthForViewport(1200)).toBe(MD_INK_PAGE_W);
  });

  it("shrinks to the phone so width-fit stays near zoom 1", () => {
    const width = mdInkPageWidthForViewport(390);
    expect(width).toBeGreaterThanOrEqual(MD_INK_PAGE_W_MIN);
    expect(width).toBeLessThan(500);
  });
});

describe("buildMdInkTemplate", () => {
  it("is one frame the camera and the ink clip can both find", () => {
    const skeletons = buildMdInkTemplate(mdInkPageHeight(5000));
    expect(skeletons).toHaveLength(1);
    expect(skeletons[0].customData?.lcMdInkFrame).toBe(true);
    expect(skeletons[0].customData?.lcRegionFrame).toBe(true);
    expect(skeletons[0].locked).toBe(true);
    expect(skeletons[0].height).toBe(5000 + MD_INK_TAIL_PAD);
    expect(skeletons[0].width).toBe(MD_INK_PAGE_W);
  });

  it("accepts a viewport-sized width", () => {
    expect(buildMdInkTemplate(1000, false, 360)[0].width).toBe(360);
  });

  it("draws no background of its own, so the document shows through", () => {
    expect(buildMdInkTemplate(1000)[0].backgroundColor).toBe("transparent");
  });
});
