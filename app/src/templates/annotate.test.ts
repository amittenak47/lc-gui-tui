import { describe, expect, it } from "vitest";

import {
  buildAnnotateTemplate,
  annotatePageHeight,
  annotatePageWidthForOpen,
  annotatePageWidthForViewport,
  MD_INK_MIN_PAGE_H,
  ANNOTATE_PAGE_W,
  ANNOTATE_PAGE_W_MIN,
  ANNOTATE_FRAME_ID,
  ANNOTATE_REGION,
  MD_INK_TAIL_PAD,
  isAnnotatePageFrame,
  stampAnnotateFrameMeta,
} from "./annotate";

describe("annotatePageHeight", () => {
  it("holds the floor until the document is taller than it", () => {
    expect(annotatePageHeight(200)).toBe(MD_INK_MIN_PAGE_H);
  });

  it("grows past the floor with room to write under the last line", () => {
    const tall = MD_INK_MIN_PAGE_H * 2;
    expect(annotatePageHeight(tall)).toBe(tall + MD_INK_TAIL_PAD);
  });

  it("falls back to the floor before the document has been measured", () => {
    // The frame exists for a frame or two before the renderer reports, and a
    // zero-height page would give the ink clip nothing to clip against.
    expect(annotatePageHeight(null)).toBe(MD_INK_MIN_PAGE_H);
    expect(annotatePageHeight(0)).toBe(MD_INK_MIN_PAGE_H);
    expect(annotatePageHeight(Number.NaN)).toBe(MD_INK_MIN_PAGE_H);
  });
});

describe("annotatePageWidthForViewport", () => {
  it("caps at the Obsidian measure on a wide screen", () => {
    expect(annotatePageWidthForViewport(1200)).toBe(ANNOTATE_PAGE_W);
  });

  it("shrinks to the phone so width-fit stays near zoom 1", () => {
    const width = annotatePageWidthForViewport(390);
    expect(width).toBeGreaterThanOrEqual(ANNOTATE_PAGE_W_MIN);
    expect(width).toBeLessThan(500);
  });
});

describe("annotatePageWidthForOpen", () => {
  it("keeps a saved frame when the viewport is wider", () => {
    expect(
      annotatePageWidthForOpen(1024, {
        elements: [{ width: 704, customData: { lcMdInkFrame: true } }],
      }),
    ).toBe(704);
  });

  it("uses stored frameWidth when the board has no md-ink frame", () => {
    expect(annotatePageWidthForOpen(1024, { elements: [], frameWidth: 704 })).toBe(704);
  });

  it("sizes a fresh open to the viewport, capped", () => {
    expect(annotatePageWidthForOpen(1024)).toBe(ANNOTATE_PAGE_W);
    expect(annotatePageWidthForOpen(1024, null)).toBe(ANNOTATE_PAGE_W);
  });

  it("prefers the saved frame over a sidecar width", () => {
    expect(
      annotatePageWidthForOpen(1024, {
        elements: [{ width: 704, customData: { lcMdInkFrame: true } }],
        frameWidth: 760,
      }),
    ).toBe(704);
  });
});

describe("buildAnnotateTemplate", () => {
  it("is one frame the camera and the ink clip can both find", () => {
    const skeletons = buildAnnotateTemplate(annotatePageHeight(5000));
    expect(skeletons).toHaveLength(1);
    expect(skeletons[0].customData?.lcMdInkFrame).toBe(true);
    expect(skeletons[0].customData?.lcRegionFrame).toBe(true);
    expect(skeletons[0].locked).toBe(true);
    expect(skeletons[0].height).toBe(5000 + MD_INK_TAIL_PAD);
    expect(skeletons[0].width).toBe(ANNOTATE_PAGE_W);
  });

  it("keeps a wide web frame instead of the markdown reading cap", () => {
    expect(buildAnnotateTemplate(1000, false, 1600)[0].width).toBe(1600);
  });

  it("draws no background of its own, so the document shows through", () => {
    expect(buildAnnotateTemplate(1000)[0].backgroundColor).toBe("transparent");
  });
});

describe("isAnnotatePageFrame", () => {
  it("recognises the seeded document rectangle by id or flags", () => {
    const [seeded] = buildAnnotateTemplate(1100);
    expect(seeded.id).toBe(ANNOTATE_FRAME_ID);
    expect(isAnnotatePageFrame(seeded)).toBe(true);
    expect(isAnnotatePageFrame({ id: ANNOTATE_FRAME_ID })).toBe(true);
    expect(
      isAnnotatePageFrame({
        id: "other",
        customData: { lcRegionFrame: true, lcRegion: ANNOTATE_REGION },
      }),
    ).toBe(true);
    expect(
      isAnnotatePageFrame({
        id: "lcregion-constraints-frame",
        customData: { lcRegionFrame: true, lcRegion: "constraints" },
      }),
    ).toBe(false);
  });

  it("puts convert-dropped flags back so fit and clamp still see a page", () => {
    const stamped = stampAnnotateFrameMeta([{ id: ANNOTATE_FRAME_ID, customData: null }]);
    expect(stamped[0].customData).toMatchObject({
      lcRegion: ANNOTATE_REGION,
      lcRegionFrame: true,
      lcMdInkFrame: true,
      lcDocumentPage: true,
    });
  });
});
